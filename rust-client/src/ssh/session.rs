// SFTP session: SSH2 transport via russh, SFTP v3 protocol via russh-sftp.
//
// Runs entirely in wasm over the bridge WebSocket (`io::WsIo`). Key exchange,
// encryption and host-key verification are delegated to russh; this module
// owns the trust policy flow (TOFU/pinning), client-side cwd tracking (SFTP
// has no server-side CWD), permission/time edits via setstat, and chunked
// transfers mapped onto the engine's transfer-id model.

use std::collections::HashMap;
use std::sync::Arc;

use russh::client::{self, Handle};
use russh::keys::{decode_secret_key, HashAlg, PrivateKeyWithHashAlg};
use russh::SshId;
use russh_sftp::client::fs::File;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};

use crate::engine_err::{EngineError, EResult};
use crate::ftp::listing::Entry;
use crate::ssh::io::{WsIo, ssh_log};
use crate::transport::DEFAULT_TIMEOUT_MS;

// ---------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------

/// SFTP-specific error surface. Host-key rejects carry the fingerprint so
/// the caller can implement TOFU ("key unknown" -> prompt -> reconnect with
/// the fingerprint pinned).
#[derive(Debug)]
pub enum SshError {
    /// KEX delivered a host key the caller has not pinned.
    HostKey(String),
    /// Login method exhausted without success.
    Auth(String),
    /// SFTP status surfaced with FTP reply-code semantics (550 no-such-file
    /// / permission-denied, 502 unsupported) for UI parity with FTP.
    FtpStatus(u16, String),
    /// Everything else.
    Other(String),
}

impl std::fmt::Display for SshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SshError::HostKey(fp) => write!(f, "untrusted server host key ({})", fp),
            SshError::Auth(m) => write!(f, "authentication failed: {}", m),
            SshError::FtpStatus(c, m) => write!(f, "{} (ftp {})", m, c),
            SshError::Other(m) => write!(f, "{}", m),
        }
    }
}

impl std::error::Error for SshError {}

impl From<russh::Error> for SshError {
    fn from(e: russh::Error) -> Self {
        SshError::Other(e.to_string())
    }
}

impl SshError {
    fn from_sftp_client(e: russh_sftp::client::error::Error) -> SshError {
        if let russh_sftp::client::error::Error::Status(status) = &e {
            let detail = if status.error_message.is_empty() {
                status.status_code.to_string()
            }
            else {
                status.error_message.clone()
            };
            return match status.status_code {
                StatusCode::NoSuchFile => SshError::FtpStatus(550, format!("no such file: {}", detail)),
                StatusCode::PermissionDenied => {
                    SshError::FtpStatus(550, format!("permission denied: {}", detail))
                }
                StatusCode::OpUnsupported => {
                    SshError::FtpStatus(502, format!("not supported here: {}", detail))
                }
                _ => SshError::Other(detail),
            };
        }
        SshError::Other(e.to_string())
    }
}

impl From<russh_sftp::client::error::Error> for SshError {
    fn from(e: russh_sftp::client::error::Error) -> Self {
        SshError::from_sftp_client(e)
    }
}

impl From<SshError> for EngineError {
    fn from(e: SshError) -> EngineError {
        match e {
            SshError::HostKey(fp) => EngineError::hostkey(fp),
            SshError::Auth(m) => EngineError::auth(530, m),
            SshError::FtpStatus(c, m) => EngineError::from_ftp(c, m),
            SshError::Other(m) => EngineError::new("io", m),
        }
    }
}

// ---------------------------------------------------------------------
// connect options / trust policy
// ---------------------------------------------------------------------

/// How to treat an unknown server host key.
#[derive(Debug, Clone)]
pub enum KeyTrust {
    /// Accept any key (explicit opt-in, analogous to FTPS "allow self-signed").
    Any,
    /// Accept only keys listed here (full SHA-256 fingerprints, "SHA256:…",
    /// bare base64 also tolerated). Assembly of the persistent store is the
    /// caller's/extension's job: unknown keys raise error code `hostkey`
    /// with the fingerprint attached.
    Pinned(Vec<String>),
}

#[derive(Debug, Clone)]
pub struct SshConnectOpts {
    pub user: String,
    pub password: String,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
    pub trust: KeyTrust,
    pub timeout_ms: u64,
}

impl Default for SshConnectOpts {
    fn default() -> Self {
        SshConnectOpts {
            user: "anonymous".to_string(),
            password: String::new(),
            private_key: None,
            passphrase: None,
            trust: KeyTrust::Pinned(Vec::new()),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        }
    }
}

fn normalize_fp(s: &str) -> String {
    let t = s.trim().strip_prefix("SHA256:").unwrap_or_else(|| {
        s.trim().strip_prefix("sha256:").unwrap_or(s.trim())
    });
    t.to_lowercase()
}

// ---------------------------------------------------------------------
// russh Handler: host key policy + passive callbacks
// ---------------------------------------------------------------------

struct SshHandler {
    trust: KeyTrust,
}

impl client::Handler for SshHandler {
    type Error = SshError;

    async fn disconnected(
        &mut self,
        reason: client::DisconnectReason<Self::Error>,
    ) -> Result<(), SshError> {
        match reason {
            client::DisconnectReason::ReceivedDisconnect(info) => {
                ssh_log(&format!(
                    "[ssh] server disconnect: {} {:?}",
                    info.message, info.reason_code
                ));
                Ok(())
            }
            client::DisconnectReason::Error(e) => {
                Err(e)
            }
        }
    }

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, SshError> {
        let fp = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        match &self.trust {
            KeyTrust::Any => Ok(true),
            KeyTrust::Pinned(list) => {
                if list.iter().any(|s| normalize_fp(s) == normalize_fp(&fp)) {
                    Ok(true)
                }
                else {
                    Err(SshError::HostKey(fp))
                }
            }
        }
    }
}

// ---------------------------------------------------------------------
// transfer records
// ---------------------------------------------------------------------

struct SshXfer {
    file: Option<File>,
    done: bool,
    error: Option<EngineError>,
    total: u64,
}

const SFTP_RESUME_UNSUPPORTED: &str = "SFTP resume from offset is not supported";

// ---------------------------------------------------------------------
// session
// ---------------------------------------------------------------------

/// A connected, authenticated SFTP session.
pub struct SshSession {
    /// Owner-side stream handle (owns the WebSocket; dropping/closing it
    /// tears the whole transport down. russh's session loop holds its own
    /// non-owning view).
    io: WsIo,
    host: String,
    port: u16,
    handle: Option<Handle<SshHandler>>,
    sftp: SftpSession,
    cwd: String,
    xfers: HashMap<u32, SshXfer>,
    next_id: u32,
    closed: bool,
}

fn engine_from_ssh(e: SshError) -> EngineError {
    e.into()
}

fn russh_engine(e: russh::Error) -> EngineError {
    SshError::from(e).into()
}

fn engine_sftp(e: russh_sftp::client::error::Error) -> EngineError {
    SshError::from(e).into()
}

impl SshSession {
    /// Dial via the bridge, run the SSH handshake (host-key policy applied
    /// inside russh's `check_server_key`), authenticate (publickey first,
    /// then password), open the SFTP subsystem and obtain the home dir.
    pub async fn connect(
        bridge_url: &str,
        host: &str,
        port: u16,
        opts: SshConnectOpts,
    ) -> EResult<SshSession> {
        let io = WsIo::connect(bridge_url, host, port, Some(opts.timeout_ms))
            .await
            .map_err(EngineError::io)?;

        let mut config = client::Config::default();
        config.client_id = SshId::Standard("SSH-2.0-ftp_engine".to_owned());
        config.inactivity_timeout = None; // no timers exist in this runtime
        config.keepalive_interval = None;

        let handler = SshHandler {
            trust: opts.trust.clone(),
        };

        // non-owning view for the russh session loop (same socket)
        let sio = io.view();
        let mut handle: Handle<SshHandler> = client::connect_stream(Arc::new(config), sio, handler)
            .await
            .map_err(|e| {
                engine_from_ssh(e)
            })?;

        // ---- authentication ------------------------------------------------
        let user = opts.user.clone();
        let mut authed = handle
            .authenticate_none(&user)
            .await
            .map(|res| res.success())
            .map_err(russh_engine)
            .unwrap_or(false);
        if !authed {
            if let Some(pem) = opts.private_key.as_deref() {
                let key = decode_secret_key(pem, opts.passphrase.as_deref())
                    .map_err(|e| EngineError::auth(530, format!("invalid private key: {}", e)))?;
                let res = handle
                    .authenticate_publickey(
                        &user,
                        PrivateKeyWithHashAlg::new(Arc::new(key), Some(HashAlg::Sha256)),
                    )
                    .await
                    .map(|res| res.success())
                    .map_err(russh_engine)
                    .unwrap_or(false);
                authed = res;
            }
            if !authed {
                let res = handle
                    .authenticate_password(&user, opts.password.as_str())
                    .await
                    .map(|res| res.success())
                    .map_err(russh_engine);
                match res {
                    Ok(true) => {}
                    Ok(false) => {
                        return Err(EngineError::auth(530, "authentication failed"));
                    }
                    Err(e) => return Err(engine_from_ssh(SshError::Other(e.to_string()))),
                }
            }
        }

        // ---- SFTP channel ------------------------------------------------
        let channel = handle.channel_open_session().await.map_err(russh_engine)?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(russh_engine)?;
        let sftp = SftpSession::new(channel.into_stream())
            .await
            .map_err(engine_sftp)?;

        // home directory; falls back to "/" when realpath is unsupported
        let home = sftp.canonicalize(".").await.unwrap_or_else(|_| "/".to_string());

        Ok(SshSession {
            io,
            host: host.to_string(),
            port,
            handle: Some(handle),
            sftp,
            cwd: home.clone(),
            xfers: HashMap::new(),
            next_id: 1,
            closed: false,
        })
    }

    fn ensure_open(&self) -> EResult<()> {
        if self.closed {
            Err(EngineError::io("connection closed"))
        }
        else {
            Ok(())
        }
    }

    /// Engine state surface for the JS wrapper.
    pub fn state_json(&self) -> serde_json::Value {
        serde_json::json!({
            "protocol": "sftp",
            "host": self.host,
            "port": self.port,
            "tls": false,
            "data_tls": false,
            "cwd": self.cwd,
        })
    }

    pub fn is_tls(&self) -> bool {
        false
    }

    pub fn data_tls_on(&self) -> bool {
        false
    }

    pub fn cached_cwd(&self) -> Option<String> {
        if self.closed {
            None
        }
        else {
            Some(self.cwd.clone())
        }
    }

    /// Current remote directory absolute path (client-tracked).
    pub fn pwd(&self) -> String {
        self.cwd.clone()
    }

    /// Absolute paths pass through; relative paths resolve against the
    /// tracked cwd (`..` segments are collapsed lexically).
    pub fn resolve(&self, path: &str) -> String {
        if path.is_empty() {
            return self.cwd.clone();
        }
        if path.starts_with('/') {
            return normalize_path(path);
        }
        normalize_path(&format!("{}/{}", self.cwd, path))
    }

    pub async fn cwd(&mut self, path: &str) -> EResult<String> {
        self.ensure_open()?;
        let target = self.resolve(path);
        let real = self
            .sftp
            .canonicalize(&target)
            .await
            .map_err(engine_sftp)?;
        let md = self.sftp.metadata(&real).await.map_err(engine_sftp)?;
        if !md.file_type().is_dir() {
            return Err(EngineError::new(
                "protocol",
                format!("{}: not a directory", target),
            ));
        }
        self.cwd = real;
        Ok(self.cwd.clone())
    }

    pub async fn cd_up(&mut self) -> EResult<String> {
        self.cwd("..").await
    }

    pub async fn mkdir(&mut self, path: &str) -> EResult<()> {
        self.ensure_open()?;
        let target = self.resolve(path);
        self.sftp.create_dir(&target).await.map_err(engine_sftp)
    }

    pub async fn rmdir(&mut self, path: &str) -> EResult<()> {
        self.ensure_open()?;
        let target = self.resolve(path);
        self.sftp.remove_dir(&target).await.map_err(engine_sftp)
    }

    pub async fn delete(&mut self, path: &str) -> EResult<()> {
        self.ensure_open()?;
        let target = self.resolve(path);
        self.sftp.remove_file(&target).await.map_err(engine_sftp)
    }

    pub async fn rename(&mut self, from: &str, to: &str) -> EResult<()> {
        self.ensure_open()?;
        let f = self.resolve(from);
        let t = self.resolve(to);
        self.sftp.rename(&f, &t).await.map_err(engine_sftp)
    }

    pub async fn size(&mut self, path: &str) -> EResult<Option<u64>> {
        self.ensure_open()?;
        let target = self.resolve(path);
        match self.sftp.metadata(&target).await {
            Ok(m) => Ok(m.size),
            Err(e) => {
                let we = engine_from_ssh(SshError::from(e));
                if we.code == "io" {
                    Ok(None)
                }
                else {
                    Err(we)
                }
            }
        }
    }

    pub async fn mdtm(&mut self, path: &str) -> EResult<Option<i64>> {
        self.ensure_open()?;
        let target = self.resolve(path);
        match self.sftp.metadata(&target).await {
            Ok(m) => Ok(m.mtime.map(|s| s as i64 * 1000)),
            Err(e) => {
                let we = engine_from_ssh(SshError::from(e));
                if we.code == "io" {
                    Ok(None)
                }
                else {
                    Err(we)
                }
            }
        }
    }

    /// Permissions via SFTP setstat — no server-side algorithm lottery.
    pub async fn chmod(&mut self, path: &str, mode: String) -> EResult<()> {
        self.ensure_open()?;
        let trimmed = mode.trim();
        let raw = u32::from_str_radix(trimmed, 8).map_err(|_| {
            EngineError::new("protocol", format!("invalid octal mode \"{}\"", trimmed))
        })?;
        let target = self.resolve(path);
        let attrs = FileAttributes {
            permissions: Some(raw),
            ..FileAttributes::default()
        };
        self.sftp.set_metadata(&target, attrs).await.map_err(engine_sftp)
    }

    /// Set mtime. SFTP v3 always encodes the (atime, mtime) pair together,
    /// so stamp both with the requested value.
    pub async fn set_mtime(&mut self, path: &str, mtime_ms: i64) -> EResult<bool> {
        self.ensure_open()?;
        if mtime_ms < 0 {
            return Ok(false);
        }
        let secs = mtime_ms / 1000;
        let attrs = FileAttributes {
            atime: Some(secs as u32),
            mtime: Some(secs as u32),
            ..FileAttributes::default()
        };
        let target = self.resolve(path);
        self.sftp.set_metadata(&target, attrs).await.map_err(engine_sftp)?;
        Ok(true)
    }

    pub async fn noop(&mut self) -> EResult<()> {
        self.ensure_open()
    }

    fn new_xfer_id(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    // ------------------------------------------------------------
    // listings
    // ------------------------------------------------------------

    /// Directory listing. `kind` is accepted for API parity with the FTP
    /// client but SFTP is protocol-driven; anything other than the defaults
    /// (or 'names') still yields full metadata entries.
    pub async fn list(&mut self, path: &str, kind: String) -> EResult<Vec<Entry>> {
        self.ensure_open()?;
        match kind.as_str() {
            "auto" | "mlsd" | "unix" | "dos" | "names" | "" => {}
            other => {
                return Err(EngineError::new(
                    "protocol",
                    format!("unknown listing kind '{}'", other),
                ));
            }
        }
        let target = self.resolve(path);
        let rd = self.sftp.read_dir(&target).await.map_err(engine_sftp)?;
        Ok(rd
            .map(|e| {
                let md = e.metadata();
                let name = e.file_name();
                Entry {
                    raw: name.clone(),
                    name,
                    dir: e.file_type().is_dir(),
                    size: md.size,
                    mtime: md.mtime.map(|s| s as i64 * 1000),
                    mode: md.permissions.map(|p| format!("{:o}", p & 0o7777)),
                    link: None,
                }
            })
            .collect())
    }

    /// Single-path metadata (used by the wrapper's statFile fallback).
    pub async fn mlst(&mut self, path: String) -> EResult<Option<Entry>> {
        self.ensure_open()?;
        let target = self.resolve(&path);
        match self.sftp.metadata(&target).await {
            Ok(m) => Ok(Some(Entry {
                raw: String::new(),
                name: target,
                dir: m.file_type().is_dir(),
                size: m.size,
                mtime: m.mtime.map(|s| s as i64 * 1000),
                mode: m.permissions.map(|p| format!("{:o}", p & 0o7777)),
                link: None,
            })),
            Err(e) => {
                let we = engine_from_ssh(SshError::from(e));
                if we.code == "io" {
                    Ok(None)
                }
                else {
                    Err(we)
                }
            }
        }
    }

    // ------------------------------------------------------------
    // chunked transfers
    // ------------------------------------------------------------

    /// Begin a download; returns the transfer id.
    pub async fn start_download(&mut self, path: &str, offset: u64) -> EResult<u32> {
        self.ensure_open()?;
        if offset > 0 {
            return Err(EngineError::new(
                "protocol",
                SFTP_RESUME_UNSUPPORTED.to_string(),
            ));
        }
        let target = self.resolve(path);
        let f = self.sftp.open(&target).await.map_err(engine_sftp)?;
        let id = self.new_xfer_id();
        self.xfers.insert(
            id,
            SshXfer {
                file: Some(f),
                done: false,
                error: None,
                total: 0,
            },
        );
        Ok(id)
    }

    /// Pull the next chunk; `None` when the file is fully transferred.
    pub async fn pull_download(&mut self, id: u32, max_chunk: usize) -> EResult<Option<Vec<u8>>> {
        let chunk_size = if max_chunk > 0 { max_chunk } else { 64 * 1024 };
        let (file, err) = {
            let xf = self.xfers.get_mut(&id).ok_or_else(|| {
                EngineError::new("protocol", format!("unknown transfer id {}", id))
            })?;
            if xf.done {
                return Ok(None);
            }
            if let Some(e) = &xf.error {
                (None, Some(e.clone()))
            }
            else {
                (xf.file.take(), None)
            }
        };
        if let Some(e) = err {
            return Err(e);
        }
        let file = file.ok_or_else(|| {
            EngineError::new("protocol", format!("transfer {} is finished", id))
        })?;
        let mut buf = vec![0u8; chunk_size];
        let mut file = file;
        let n = match tokio::io::AsyncReadExt::read(&mut file, &mut buf).await {
            Ok(n) => n,
            Err(e) => {
                self.xfers.remove(&id);
                return Err(EngineError::io(format!("sftp read failed: {}", e)));
            }
        };
        if n == 0 {
            // EOF — close the handle and finish the transfer
            let _ = file.close().await;
            self.xfers.get_mut(&id).unwrap().done = true;
            return Ok(None);
        }
        buf.truncate(n);
        if let Some(xf) = self.xfers.get_mut(&id) {
            xf.total += n as u64;
            xf.file = Some(file);
        }
        Ok(Some(buf))
    }

    /// Begin an upload; returns the transfer id.
    pub async fn start_upload(&mut self, path: &str, append: bool, offset: u64) -> EResult<u32> {
        self.ensure_open()?;
        if offset > 0 {
            return Err(EngineError::new(
                "protocol",
                SFTP_RESUME_UNSUPPORTED.to_string(),
            ));
        }
        let target = self.resolve(path);
        let flags = if append {
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::APPEND
        }
        else {
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE
        };
        let f = self
            .sftp
            .open_with_flags(&target, flags)
            .await
            .map_err(engine_sftp)?;
        let id = self.new_xfer_id();
        self.xfers.insert(
            id,
            SshXfer {
                file: Some(f),
                done: false,
                error: None,
                total: 0,
            },
        );
        Ok(id)
    }

    /// Push one upload chunk; returns the running total.
    pub async fn push_upload(&mut self, id: u32, data: &[u8]) -> EResult<u64> {
        let (mut file, existing_err) = {
            let xf = self.xfers.get_mut(&id).ok_or_else(|| {
                EngineError::new("protocol", format!("unknown transfer id {}", id))
            })?;
            if xf.done {
                return Err(EngineError::new(
                    "protocol",
                    format!("transfer {} is finished", id),
                ));
            }
            (xf.file.take(), xf.error.clone())
        };
        let mut failure = existing_err;
        if failure.is_none() && file.is_some() {
            let f = file.as_mut().unwrap();
            match tokio::io::AsyncWriteExt::write_all(f, data).await {
                Ok(()) => {
                    if let Some(xf) = self.xfers.get_mut(&id) {
                        xf.total += data.len() as u64;
                    }
                }
                Err(e) => {
                    let _ = tokio::io::AsyncWriteExt::shutdown(f).await;
                    failure = Some(EngineError::io(format!("sftp write failed: {}", e)));
                }
            }
        }
        if let Some(xf) = self.xfers.get_mut(&id) {
            if failure.is_none() {
                xf.file = file;
            }
        }
        if let Some(e) = failure {
            self.xfers.remove(&id);
            return Err(e);
        }
        let xf = self.xfers.get(&id).ok_or_else(|| {
            EngineError::new("protocol", format!("transfer {} is finished", id))
        })?;
        Ok(xf.total)
    }

    /// Finish an upload and consume the close reply; returns the total sent.
    pub async fn finish_upload(&mut self, id: u32) -> EResult<u64> {
        let xf = self.xfers.get_mut(&id).ok_or_else(|| {
            EngineError::new("protocol", format!("unknown transfer id {}", id))
        })?;
        let total = xf.total;
        if let Some(e) = &xf.error {
            return Err(e.clone());
        }
        if let Some(f) = xf.file.take() {
            f.close()
                .await
                .map_err(|e| EngineError::io(format!("sftp close failed: {}", e)))?;
        }
        self.xfers.remove(&id);
        Ok(total)
    }

    /// Abort a transfer in flight.
    pub async fn abort_transfer(&mut self, id: u32) -> EResult<()> {
        let xf = self.xfers.get_mut(&id).ok_or_else(|| {
            EngineError::new("protocol", format!("unknown transfer id {}", id))
        })?;
        if let Some(f) = xf.file.take() {
            let _ = f.close().await;
        }
        xf.done = true;
        self.xfers.remove(&id);
        Ok(())
    }

    /// Drop a finished transfer record (also closes any lingering handle).
    pub fn drop_transfer(&mut self, id: u32) {
        self.xfers.remove(&id);
    }

    // ------------------------------------------------------------
    // close
    // ------------------------------------------------------------

    /// QUIT politely: close the SFTP subsystem, then the SSH session, then
    /// the WebSocket.
    pub async fn quit(&mut self) -> EResult<()> {
        self.ensure_open()?;
        self.closed = true;
        let ids: Vec<u32> = self.xfers.keys().copied().collect();
        for id in ids {
            if let Some(xf) = self.xfers.get_mut(&id) {
                if let Some(f) = xf.file.take() {
                    let _ = f.close().await;
                }
            }
        }
        self.xfers.clear();
        let _ = self.sftp.close().await; // best effort
        if let Some(h) = self.handle.take() {
            let _ = h
                .disconnect(russh::Disconnect::ByApplication, "", "logout")
                .await;
        }
        self.io.close();
        Ok(())
    }

    /// Hard close (no protocol shutdown).
    pub async fn hard_close(&mut self) {
        self.closed = true;
        self.xfers.clear();
        self.handle = None;
        self.io.close();
    }
}

// path helpers -----------------------------------------------------------

/// Lexical POSIX normalization: collapses `.`, `..`, double slashes.
pub fn normalize_path(p: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => continue,
            ".." => {
                let _ = parts.pop();
            }
            other => parts.push(other),
        }
    }
    if parts.is_empty() {
        "/".to_string()
    }
    else {
        format!("/{}", parts.join("/"))
    }
}
