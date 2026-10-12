// FTP session engine: login flow, capability negotiation, and the full
// command surface driven over the control channel + passive data channels.
//
// Transport topology: one bridge WebSocket per FTP connection. The control
// channel stays open for the session; each transfer/listing opens its own
// passive data channel (EPSV, fallback PASV) and closes it when done.

use crate::engine_err::{EngineError, EResult};
use crate::ftp::control::{parse_reply_head, reply_text, Channel, CmdError, Control, Feats, Reply};
use crate::ftp::data::{open_passive, tls_data_with_config, DataChannel};
use crate::ftp::listing::{self, Entry, ListKind};
use crate::tls::{build_client_config, TrustPolicy};
use crate::transport::WsStream;
use rustls::ClientConfig;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SecureMode {
    /// plain FTP only
    None,
    /// require explicit TLS (AUTH TLS); fail if the server lacks it
    Explicit,
    /// try TLS, fall back to plain
    Auto,
    /// implicit TLS from the first byte (port 990 style)
    Implicit,
}

impl SecureMode {
    pub fn from_str(s: &str) -> SecureMode {
        match s.to_ascii_lowercase().as_str() {
            "none" | "plain" => SecureMode::None,
            "explicit" => SecureMode::Explicit,
            "implicit" | "tls" => SecureMode::Implicit,
            _ => SecureMode::Auto,
        }
    }
}

/// Login parameters.
#[derive(Clone)]
pub struct ConnectOpts {
    pub user: String,
    pub password: String,
    pub secure: SecureMode,
    pub allow_self_signed: bool,
    pub pinned_roots: Vec<Vec<u8>>,
    pub timeout_ms: u64,
    pub utf8: bool,
    /// FTPS data protection default: true (= PROT P) when TLS is on
    pub data_tls: bool,
}

impl Default for ConnectOpts {
    fn default() -> Self {
        ConnectOpts {
            user: "anonymous".to_string(),
            password: "anonymous".to_string(),
            secure: SecureMode::Auto,
            allow_self_signed: false,
            pinned_roots: Vec::new(),
            timeout_ms: crate::transport::DEFAULT_TIMEOUT_MS,
            utf8: true,
            data_tls: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum XferDir {
    Get,
    Put,
}

/// One active (or finished) data transfer.
struct Xfer {
    dir: XferDir,
    data: DataChannel,
    done: bool,
    error: Option<EngineError>,
    total: u64,
}

/// A connected, logged-in FTP session.
pub struct FtpSession {
    control: Control,
    bridge_url: String,
    pub host: String,
    pub port: u16,
    timeout_ms: u64,
    tls_config: Option<Arc<ClientConfig>>,
    tls_host: String,
    prot_p: bool,
    pub(crate) utf8: bool,
    pub feats: Feats,
    pub syst: String,
    pub binary_on: bool,
    cwd: Option<String>,
    xfers: HashMap<u32, Xfer>,
    next_id: u32,
    closing: bool,
}

impl FtpSession {
    // ------------------------------------------------------------
    // connect / login
    // ------------------------------------------------------------

    /// Dial, negotiate TLS (when requested), login, and initialize TYPE/FEAT.
    pub async fn connect(
        bridge_url: &str,
        host: &str,
        port: u16,
        opts: ConnectOpts,
    ) -> EResult<FtpSession> {
        let control_ws = WsStream::connect(bridge_url, host, port, Some(opts.timeout_ms))
            .await
            .map_err(EngineError::io)?;

        // trust policy construction
        let trust = if opts.allow_self_signed {
            TrustPolicy::Any
        } else if opts.pinned_roots.is_empty() {
            TrustPolicy::WebPki
        } else {
            let certs: Vec<_> = opts
                .pinned_roots
                .iter()
                .map(|der| rustls::pki_types::CertificateDer::from(der.clone()))
                .collect();
            TrustPolicy::Pinned(certs)
        };

        // implicit TLS: upgrade before any bytes are exchanged
        let mut tls_config = None::<Arc<ClientConfig>>;
        let channel = if matches!(opts.secure, SecureMode::Implicit) {
            let cfg = build_client_config(&trust).map_err(EngineError::tls)?;
            let tls = crate::tls::TlsStream::connect(control_ws, cfg.clone(), host)
                .await
                .map_err(EngineError::tls)?;
            tls_config = Some(cfg);
            Channel::Tls(tls)
        } else {
            Channel::Plain(control_ws)
        };

        let mut control = Control::new(channel, host.to_string(), port, trust.clone());

        // greeting: `220 …`
        let greet = control.read_reply().await?;
        if greet.code != 220 {
            let _ = control.close().await;
            return Err(EngineError::protocol(format!("bad greeting: {}", greet.text())));
        }

        // capability probe (plain first; refreshed post-TLS)
        let mut feats = Feats::default();
        if let Ok(reply) = control.command("FEAT").await {
            if reply.is_positive() {
                feats = crate::ftp::control::parse_feat_lines(&reply);
            }
        }

        // explicit TLS upgrade when requested and supported
        let want_tls = match opts.secure {
            SecureMode::Explicit => true,
            SecureMode::Auto => feats.auth_tls,
            _ => false,
        };
        if want_tls && !feats.auth_tls {
            let _ = control.close().await;
            return Err(EngineError::tls("server does not advertise AUTH TLS"));
        }
        if want_tls {
            let auth_cmd = if feats.auth_tls { "AUTH TLS" } else { "AUTH SSL" };
            match control.command(auth_cmd).await {
                Ok(reply) if reply.code == 234 || reply.code == 220 => {
                    // swap the plaintext channel for TLS mid-stream
                    let plain = control
                        .take_channel()
                        .and_then(|ch| match ch {
                            Channel::Plain(ws) => Some(ws),
                            _ => None,
                        })
                        .ok_or_else(|| {
                            EngineError::tls("control channel missing during upgrade")
                        })?;
                    let cfg = build_client_config(&trust).map_err(EngineError::tls)?;
                    tls_config = Some(cfg.clone());
                    let tls = crate::tls::TlsStream::connect(plain, cfg, host)
                        .await
                        .map_err(EngineError::tls)?;
                    control.put_channel(Channel::Tls(tls));
                    control.set_utf8(false);
                    // fresh capability set inside the secure channel
                    let mut feats2 = Feats::default();
                    if let Ok(reply) = control.command("FEAT").await {
                        if reply.is_positive() {
                            feats2 = crate::ftp::control::parse_feat_lines(&reply);
                        }
                    }
                    feats = feats2;
                    // protect data connections when possible
                    let pbsz_ok = control
                        .command("PBSZ 0")
                        .await
                        .map(|r| r.is_positive())
                        .unwrap_or(false);
                    if pbsz_ok {
                        let prot_cmd = if opts.data_tls { "PROT P" } else { "PROT C" };
                        let prot_p = control
                            .command(prot_cmd)
                            .await
                            .map(|r| r.is_positive())
                            .unwrap_or(false);
                        let _ = prot_p;
                    }
                }
                Ok(reply) => {
                    let _ = control.close().await;
                    return Err(EngineError::tls(format!(
                        "server refused TLS: {}",
                        reply.text()
                    )));
                }
                Err(e) => {
                    let _ = control.close().await;
                    return Err(EngineError::tls(format!("AUTH TLS failed: {}", e.message())));
                }
            }
        }

        // UTF-8 negotiation
        if opts.utf8 && feats.utf8 {
            let r = control.command("OPTS UTF8 ON").await;
            let on = matches!(r, Ok(rep) if rep.is_positive());
            control.set_utf8(on);
        }
        control.feats = Some(feats.clone());

        // login
        let user_cmd = format!("USER {}", opts.user);
        let resp = control.command(&user_cmd).await?;
        match resp.code {
            230 | 202 => {}
            331 | 332 => {
                let pass_cmd = format!("PASS {}", opts.password);
                let pr = control.command(&pass_cmd).await?;
                if !pr.is_positive() {
                    let _ = control.close().await;
                    return Err(EngineError::auth(pr.code, format!("login failed: {}", pr.text())));
                }
                if resp.code == 332 {
                    let ar = control.command("ACCT ").await?;
                    if !ar.is_positive() {
                        let _ = control.close().await;
                        return Err(EngineError::auth(
                            ar.code,
                            format!("ACCT failed: {}" , ar.text()),
                        ));
                    }
                }
            }
            c => {
                let _ = control.close().await;
                return Err(EngineError::auth(c, format!("login failed: {}", resp.text())));
            }
        }

        // binary transfer designation
        let mut binary_on = false;
        if let Ok(r) = control.command("TYPE I").await {
            binary_on = r.is_positive();
        }

        // server type banner (once, FYI only)
        let syst = match control.command("SYST").await {
            Ok(r) if r.is_positive() => r.text(),
            _ => String::new(),
        };

        let mut session = FtpSession {
            control,
            bridge_url: bridge_url.to_string(),
            host: host.to_string(),
            port,
            timeout_ms: opts.timeout_ms,
            tls_config,
            tls_host: host.to_string(),
            prot_p: opts.data_tls,
            utf8: opts.utf8,
            binary_on,
            cwd: None,
            xfers: HashMap::new(),
            next_id: 1,
            closing: false,
            feats: Feats::default(),
            syst: String::new(),
        };
        session.feats = feats;
        session.syst = syst;
        // resolve initial cwd
        session.cwd = session.pwd().await.ok();
        Ok(session)
    }

    fn data_tls_needed(&self) -> bool {
        self.control.is_tls() && self.prot_p && self.tls_config.is_some()
    }

    /// Open a passive data connection; upgrades to TLS when the control
    /// channel is secure and PROT P was accepted.
    async fn open_data(&mut self) -> EResult<DataChannel> {
        let bridge = self.bridge_url.clone();
        let timeout = self.timeout_ms;
        let (data, _addr) = open_passive(&mut self.control, &bridge, timeout)
            .await
            .map_err(EngineError::from)?;
        if self.data_tls_needed() {
            let cfg = self
                .tls_config
                .clone()
                .ok_or_else(|| EngineError::tls("TLS active but config missing"))?;
            let host = self.tls_host.clone();
            let data = tls_data_with_config(data, cfg, &host)
                .await
                .map_err(EngineError::from)?;
            return Ok(data);
        }
        Ok(data)
    }

    // ------------------------------------------------------------
    // navigation / metadata
    // ------------------------------------------------------------

    /// Current remote directory (`PWD`).
    pub async fn pwd(&mut self) -> EResult<String> {
        let r = self.control.command("PWD").await?;
        if !r.is_positive() {
            return Err(EngineError::from_ftp(r.code, r.text()));
        }
        // `257 "/path" is current directory.`
        let text = r.text();
        if let Some(s) = text.find('"') {
            let rest = &text[s + 1..];
            let close = rest.find('"').unwrap_or(rest.len());
            Ok(rest[..close].to_string())
        } else {
            let mut w = text.split_whitespace();
            w.next();
            Ok(w.next().unwrap_or("/").to_string())
        }
    }

    /// Change directory; returns the new pwd.
    pub async fn cwd(&mut self, path: &str) -> EResult<String> {
        let cmd = if path.is_empty() || path == "." {
            "CWD .".to_string()
        } else {
            format!("CWD {}", quote_path(path))
        };
        let r = self.control.command(&cmd).await?;
        if !r.is_positive() {
            return Err(EngineError::from_ftp(r.code, r.text()));
        }
        self.cwd = None;
        self.pwd().await
    }

    pub async fn cd_up(&mut self) -> EResult<String> {
        let r = self.control.command("CDUP").await?;
        if !r.is_positive() {
            return Err(EngineError::from_ftp(r.code, r.text()));
        }
        self.cwd = None;
        self.pwd().await
    }

    pub fn cached_cwd(&self) -> Option<String> {
        self.cwd.clone()
    }

    pub async fn system(&mut self) -> EResult<String> {
        let r = self.control.command("SYST").await?;
        if !r.is_positive() {
            return Err(EngineError::from_ftp(r.code, r.text()));
        }
        self.syst = r.text();
        Ok(self.syst.clone())
    }

    pub fn features(&self) -> &Feats {
        &self.feats
    }

    pub fn is_tls(&self) -> bool {
        self.control.is_tls()
    }

    pub fn data_tls_on(&self) -> bool {
        self.data_tls_needed()
    }

    /// File size via `SIZE`. `Ok(None)` when unsupported/absent.
    pub async fn size(&mut self, path: &str) -> EResult<Option<u64>> {
        if !self.feats.size {
            return Ok(None);
        }
        let r = self
            .control
            .command(&format!("SIZE {}", quote_path(path)))
            .await?;
        if r.code == 213 {
            let n = r
                .text()
                .split_whitespace()
                .nth(1)
                .and_then(|s| s.parse::<u64>().ok());
            return Ok(n);
        }
        Ok(None)
    }

    /// File mtime via `MDTM` -> epoch millis (UTC).
    pub async fn mdtm(&mut self, path: &str) -> EResult<Option<i64>> {
        if !self.feats.mdtm {
            return Ok(None);
        }
        let r = self
            .control
            .command(&format!("MDTM {}", quote_path(path)))
            .await?;
        if r.code == 213 {
            return Ok(listing::parse_mdtm_reply(&r));
        }
        Ok(None)
    }

    /// Set mtime when the server supports MFMT; returns whether it worked.
    pub async fn set_mtime(&mut self, path: &str, mtime_ms: i64) -> EResult<bool> {
        if !self.feats.mfmt {
            return Ok(false);
        }
        let stamp = listing::format_mfmt(mtime_ms);
        let r = self
            .control
            .command(&format!("MFMT {} {}", stamp, quote_path(path)))
            .await?;
        Ok(r.is_positive())
    }

    /// Change file/dir permissions via `SITE CHMOD` (server-dependent: most
    /// Unix FTP servers implement it, some do not). `mode` is an octal
    /// bitmask, e.g. `0o644`; up to `0o7777` keeps setuid/sticky bits valid.
    pub async fn site_chmod(&mut self, path: &str, mode: u32) -> EResult<()> {
        if mode > 0o7777 {
            return Err(EngineError::new(
                "protocol",
                format!("chmod mode {:o} out of range (max 07777)", mode),
            ));
        }
        // FileZilla-style wire format: `SITE CHMOD 644 /path`. Quote the path
        // only when whitespace would leave the server-side word split
        // ambiguous (quote_path escapes embedded quotes).
        let target = if path.contains(' ') || path.contains('\t') {
            quote_path(path)
        } else {
            path.to_string()
        };
        let r = self
            .control
            .command(&format!("SITE CHMOD {:o} {}", mode, target))
            .await?;
        if !r.is_positive() {
            return Err(EngineError::from_ftp(r.code, r.text()));
        }
        Ok(())
    }

    // ------------------------------------------------------------
    // listings
    // ------------------------------------------------------------

    /// Directory listing (MLSD, then LIST fallback, forced kinds when asked).
    pub async fn list(&mut self, path: &str, kind: ListKind) -> EResult<Vec<Entry>> {
        let now_ms = crate::transport::now_ms() as i64;
        let target = if path.is_empty() { "." } else { path };
        match kind {
            ListKind::Mlsd => self.list_mlsd(target).await,
            ListKind::Auto => {
                if self.feats.mlsd {
                    if let Ok(entries) = self.list_mlsd(target).await {
                        if !entries.is_empty() {
                            return Ok(entries);
                        }
                    }
                }
                let body = self.fetch_list_text(&format!("LIST {}", quote_path(target))).await?;
                Ok(listing::parse_listing(&body, ListKind::Auto, now_ms))
            }
            ListKind::Unix => {
                let body = self.fetch_list_text(&format!("LIST {}", quote_path(target))).await?;
                Ok(listing::parse_listing(&body, ListKind::Unix, now_ms))
            }
            ListKind::Dos => {
                let body = self.fetch_list_text(&format!("LIST {}", quote_path(target))).await?;
                Ok(listing::parse_listing(&body, ListKind::Dos, now_ms))
            }
            ListKind::Names => {
                let body = self.fetch_list_text(&format!("NLST {}", quote_path(target))).await?;
                Ok(listing::parse_listing(&body, ListKind::Names, now_ms))
            }
        }
    }

    async fn list_mlsd(&mut self, path: &str) -> EResult<Vec<Entry>> {
        let body = self
            .fetch_list_text(&format!("MLSD {}", quote_path(path)))
            .await?;
        let now_ms = crate::transport::now_ms() as i64;
        Ok(listing::parse_listing(&body, ListKind::Mlsd, now_ms))
    }

    /// Run a listing command over a fresh passive data channel; returns text.
    async fn fetch_list_text(&mut self, cmd: &str) -> EResult<String> {
        // negotiate the passive data channel first (this sends EPSV/PASV on
        // the control channel), then fire the command and stream the body.
        let data = self.open_data().await?;
        match self.command_expect_1xx(cmd).await {
            Ok(_prelim) => {
                let mut data = data;
                let mut body = String::new();
                let mut buf = [0u8; 16384];
                loop {
                    match data.read(&mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            body.push_str(&String::from_utf8_lossy(&buf[..n]));
                            if body.len() > 32 * 1024 * 1024 {
                                data.close().await;
                                let _ = self.control.read_reply().await;
                                return Err(EngineError::protocol("listing exceeds 32 MB"));
                            }
                        }
                        Err(e) => {
                            data.close().await;
                            let _ = self.control.read_reply().await;
                            return Err(e.into());
                        }
                    }
                }
                data.close().await;
                match self.control.read_reply().await {
                    Ok(f) if f.is_positive() => Ok(body),
                    Ok(f) => Err(EngineError::from_ftp(f.code, f.text())),
                    Err(e) => Err(e.into()),
                }
            }
            Err(e) => {
                let mut data = data;
                data.close().await;
                Err(e)
            }
        }
    }

    /// Send a transfer command expecting a 1xx preliminary reply.
    async fn command_expect_1xx(&mut self, cmd: &str) -> EResult<Reply> {
        let r = self.control.command(cmd).await?;
        if (200..300).contains(&r.code) {
            return Err(EngineError::protocol(format!(
                "transfer command got immediate reply: {}",
                r.text()
            )));
        }
        if r.code >= 300 {
            return Err(EngineError::from_ftp(r.code, r.text()));
        }
        Ok(r)
    }

    // ------------------------------------------------------------
    // transfers
    // ------------------------------------------------------------

    /// Begin a download; returns the transfer id to pull chunks from.
    pub async fn start_download(&mut self, path: &str, offset: u64) -> EResult<u32> {
        let data = self.open_data().await?;
        if offset > 0 {
            let r = self.control.command(&format!("REST {}", offset)).await?;
            if !(r.is_positive() || r.code == 350) {
                let mut d = data;
                d.close().await;
                return Err(EngineError::from_ftp(r.code, r.text()));
            }
        }
        match self
            .command_expect_1xx(&format!("RETR {}", quote_path(path)))
            .await
        {
            Ok(_) => {
                let id = self.alloc_id();
                self.xfers.insert(
                    id,
                    Xfer {
                        dir: XferDir::Get,
                        data,
                        done: false,
                        error: None,
                        total: offset,
                    },
                );
                Ok(id)
            }
            Err(e) => {
                let mut d = data;
                d.close().await;
                Err(e)
            }
        }
    }

    /// Begin an upload (STOR) or append (APPE); returns the transfer id.
    pub async fn start_upload(&mut self, path: &str, append: bool, offset: u64) -> EResult<u32> {
        let data = self.open_data().await?;
        if offset > 0 {
            let r = self.control.command(&format!("REST {}", offset)).await?;
            if !(r.is_positive() || r.code == 350) {
                let mut d = data;
                d.close().await;
                return Err(EngineError::from_ftp(r.code, r.text()));
            }
        }
        let cmd = if append { "APPE" } else { "STOR" };
        match self
            .command_expect_1xx(&format!("{} {}", cmd, quote_path(path)))
            .await
        {
            Ok(_) => {
                let id = self.alloc_id();
                self.xfers.insert(
                    id,
                    Xfer {
                        dir: XferDir::Put,
                        data,
                        done: false,
                        error: None,
                        total: offset,
                    },
                );
                Ok(id)
            }
            Err(e) => {
                let mut d = data;
                d.close().await;
                Err(e)
            }
        }
    }

    /// Pull the next chunk of a download. `Ok(None)` = complete; errors are
    /// sticky.
    pub async fn pull_download(&mut self, id: u32, max_chunk: usize) -> EResult<Option<Vec<u8>>> {
        {
            let x = self
                .xfers
                .get(&id)
                .ok_or_else(|| EngineError::protocol("unknown transfer id"))?;
            if x.dir != XferDir::Get {
                return Err(EngineError::protocol("not a download"));
            }
            if let Some(e) = &x.error {
                return Err(e.clone());
            }
            if x.done {
                return Ok(None);
            }
        }
        let max_chunk = max_chunk.clamp(1, 4 * 1024 * 1024);
        let mut buf = vec![0u8; max_chunk];
        let n = {
            let x = self
                .xfers
                .get_mut(&id)
                .ok_or_else(|| EngineError::protocol("unknown transfer id"))?;
            match x.data.read(&mut buf).await {
                Ok(n) => n,
                Err(e) => {
                    let x = self.xfers.get_mut(&id).unwrap();
                    x.error = Some(e.into());
                    x.done = true;
                    return Err(x.error.clone().unwrap());
                }
            }
        };
        if n == 0 {
            // transfer complete; consume the 226/250
            self.finalize_data(id).await?;
            return Ok(None);
        }
        {
            let x = self.xfers.get_mut(&id).unwrap();
            x.total += n as u64;
        }
        buf.truncate(n);
        Ok(Some(buf))
    }

    /// Push one chunk of an upload.
    pub async fn push_upload(&mut self, id: u32, chunk: &[u8]) -> EResult<u64> {
        let sent = {
            let x = self
                .xfers
                .get_mut(&id)
                .ok_or_else(|| EngineError::protocol("unknown transfer id"))?;
            if x.dir != XferDir::Put {
                return Err(EngineError::protocol("not an upload"));
            }
            if x.done {
                return Err(EngineError::protocol("transfer already finished"));
            }
            if let Some(e) = &x.error {
                return Err(e.clone());
            }
            let n = chunk.len();
            match x.data.write_all(chunk).await {
                Ok(()) => n,
                Err(e) => {
                    x.error = Some(EngineError::io(e.message()));
                    x.done = true;
                    return Err(x.error.clone().unwrap());
                }
            }
        };
        let x = self.xfers.get_mut(&id).unwrap();
        x.total += sent as u64;
        Ok(x.total)
    }

    /// Close an upload data stream and consume the final server reply.
    /// Returns the number of bytes sent for this transfer.
    pub async fn finish_upload(&mut self, id: u32) -> EResult<u64> {
        let early_err = {
            let x = self
                .xfers
                .get(&id)
                .ok_or_else(|| EngineError::protocol("unknown transfer id"))?;
            x.error.clone()
        };
        if let Some(e) = early_err {
            let mut x = self.xfers.remove(&id).unwrap();
            x.data.close().await;
            let r = self.control.read_reply().await;
            let _ = r;
            return Err(e);
        }
        {
            let x = self.xfers.get_mut(&id).unwrap();
            x.data.close().await;
        }
        let r = self.control.read_reply().await;
        let total = self.xfers.remove(&id).map(|x| x.total).unwrap_or(0);
        match r {
            Ok(rep) if rep.is_positive() => Ok(total),
            Ok(rep) => Err(EngineError::from_ftp(rep.code, rep.text())),
            Err(e) => Err(e.into()),
        }
    }

    /// Mark a download finished and consume the final server reply.
    async fn finalize_data(&mut self, id: u32) -> EResult<()> {
        if let Some(x) = self.xfers.get_mut(&id) {
            x.data.close().await;
        }
        let result = match self.control.read_reply().await {
            Ok(rep) if rep.is_positive() => Ok(()),
            Ok(rep) => Err(EngineError::from_ftp(rep.code, rep.text())),
            Err(e) => Err(e.into()),
        };
        if let Some(x) = self.xfers.get_mut(&id) {
            if let Err(e) = &result {
                x.error = Some(e.clone());
            }
            x.done = true;
        }
        result
    }

    /// Abort an in-flight transfer (close the data channel, send ABOR).
    pub async fn abort_transfer(&mut self, id: u32) -> EResult<()> {
        if let Some(mut x) = self.xfers.remove(&id) {
            x.data.close().await;
        }
        let _ = self.control.send_line("ABOR").await;
        // servers send "426 …" then "226 …", or just a single reply
        for _ in 0..2 {
            match self.control.read_reply().await {
                Ok(r) => {
                    if r.code / 100 != 4 && !r.code.to_string().starts_with("4") {
                        break;
                    }
                    if r.code == 226 || r.code == 225 {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        Ok(())
    }

    /// Drop a finished transfer record.
    pub fn drop_transfer(&mut self, id: u32) {
        self.xfers.remove(&id);
    }

    // ------------------------------------------------------------
    // file management
    // ------------------------------------------------------------

    pub async fn delete_file(&mut self, path: &str) -> EResult<()> {
        let r = self
            .control
            .command(&format!("DELE {}", quote_path(path)))
            .await?;
        if !r.is_positive() {
            return Err(EngineError::from_ftp(r.code, r.text()));
        }
        Ok(())
    }

    pub async fn make_dir(&mut self, path: &str) -> EResult<()> {
        let r = self
            .control
            .command(&format!("MKD {}", quote_path(path)))
            .await?;
        if !r.is_positive() {
            return Err(EngineError::from_ftp(r.code, r.text()));
        }
        Ok(())
    }

    pub async fn remove_dir(&mut self, path: &str) -> EResult<()> {
        let r = self
            .control
            .command(&format!("RMD {}", quote_path(path)))
            .await?;
        if !r.is_positive() {
            return Err(EngineError::from_ftp(r.code, r.text()));
        }
        Ok(())
    }

    pub async fn rename(&mut self, from: &str, to: &str) -> EResult<()> {
        let r = self
            .control
            .command(&format!("RNFR {}", quote_path(from)))
            .await?;
        if r.code != 350 {
            return Err(EngineError::from_ftp(r.code, r.text()));
        }
        let r = self
            .control
            .command(&format!("RNTO {}", quote_path(to)))
            .await?;
        if !r.is_positive() {
            return Err(EngineError::from_ftp(r.code, r.text()));
        }
        Ok(())
    }

    /// Overall server status text (`STAT` with no args).
    pub async fn stat_server(&mut self) -> EResult<String> {
        let r = self.control.command("STAT").await?;
        Ok(reply_text(r.code, &r.lines))
    }

    /// `STAT <path>` — metadata over the control channel (when supported).
    pub async fn stat_path(&mut self, path: &str) -> EResult<String> {
        let r = self
            .control
            .command(&format!("STAT {}", quote_path(path)))
            .await?;
        Ok(reply_text(r.code, &r.lines))
    }

    /// `MLST <path>` — machine-readable metadata for one path.
    pub async fn mlst(&mut self, path: &str) -> EResult<Option<Entry>> {
        if !self.feats.mlsx {
            return Ok(None);
        }
        let r = self
            .control
            .command(&format!("MLST {}", quote_path(path)))
            .await?;
        if !r.is_positive() {
            return Err(EngineError::from_ftp(r.code, r.text()));
        }
        for line in &r.lines {
            if line.contains(';') {
                if let Some(e) = listing::parse_mlsx_line(line) {
                    return Ok(Some(e));
                }
            }
        }
        Ok(None)
    }

    pub async fn noop(&mut self) -> EResult<()> {
        let r = self.control.command("NOOP").await?;
        if !r.is_positive() {
            return Err(EngineError::from_ftp(r.code, r.text()));
        }
        Ok(())
    }

    /// Send QUIT and close the control channel.
    pub async fn quit(&mut self) -> EResult<()> {
        let _ = self.control.command("QUIT").await;
        self.closing = true;
        self.control.close().await;
        Ok(())
    }

    /// Force-close without QUIT.
    pub async fn hard_close(&mut self) {
        self.closing = true;
        self.control.close().await;
    }

    // ------------------------------------------------------------

    fn alloc_id(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }
}

#[allow(dead_code)]
fn unused_marker() {}

/// Quote a path for a command argument (double embedded quotes on some
/// servers; plain quoting works for the common case).
fn quote_path(path: &str) -> String {
    let esc = path.replace('"', "\"\"");
    format!("\"{}\"", esc)
}

/// Keep the unused helper reachable for tests.
#[allow(dead_code)]
fn test_parse_reply_head(line: &str) -> Result<(u16, bool), CmdError> {
    parse_reply_head(line)
}
