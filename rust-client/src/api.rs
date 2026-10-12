// Wasm-bindgen API surface consumed by the extension's JS glue (`api.js`).
//
// Errors are returned as rejected promises carrying an
// `{ code, ftp_code?, message }` object (see `engine_err::EngineError`).

use wasm_bindgen::prelude::*;

use crate::engine_err::EngineError;
use crate::ftp::control::Feats;
use crate::ftp::listing::{Entry, ListKind};
use crate::ftp::session::{ConnectOpts, FtpSession, SecureMode};

fn err_value(e: EngineError) -> JsValue {
    let text = serde_json::to_string(&e).unwrap_or_else(|_| {
        format!("{{\"code\":\"io\",\"message\":\"{}\"}}", e.message.replace('\\', "\\\\").replace('"', "\\\""))
    });
    js_sys::JSON::parse(&text).unwrap_or_else(|_| JsValue::from_str(&e.message))
}

fn ok_value<T: serde::Serialize>(v: &T) -> Result<JsValue, JsValue> {
    let text = serde_json::to_string(v).map_err(|e| JsValue::from_str(&e.to_string()))?;
    js_sys::JSON::parse(&text).map_err(|_| JsValue::from_str("json parse failed"))
}

impl From<EngineError> for JsValue {
    fn from(e: EngineError) -> Self {
        err_value(e)
    }
}

/// Read a string field from a JS options object.
fn opt_str(v: &JsValue, key: &str) -> Option<String> {
    js_sys::Reflect::get(v, &JsValue::from_str(key))
        .ok()
        .and_then(|s| s.as_string())
}

fn opt_bool(v: &JsValue, key: &str) -> Option<bool> {
    js_sys::Reflect::get(v, &JsValue::from_str(key))
        .ok()
        .and_then(|b| b.as_bool())
}

fn opt_f64(v: &JsValue, key: &str) -> Option<f64> {
    js_sys::Reflect::get(v, &JsValue::from_str(key))
        .ok()?
        .as_f64()
}

/// Parse ConnectOpts from a JS object.
fn parse_opts(v: &JsValue) -> ConnectOpts {
    let mut o = ConnectOpts::default();
    if let Some(s) = opt_str(v, "user") {
        o.user = s;
    }
    if let Some(s) = opt_str(v, "password") {
        o.password = s;
    }
    if let Some(s) = opt_str(v, "secure") {
        o.secure = SecureMode::from_str(&s);
    }
    if let Some(b) = opt_bool(v, "allowSelfSigned") {
        o.allow_self_signed = b;
    }
    if let Some(n) = opt_f64(v, "timeout") {
        if n > 1000.0 {
            o.timeout_ms = n as u64;
        }
    }
    if let Some(b) = opt_bool(v, "utf8") {
        o.utf8 = b;
    }
    if let Some(b) = opt_bool(v, "dataTls") {
        o.data_tls = b;
    }
    o
}

/// The engine handle: one `FtpClient` per FTP connection.
#[wasm_bindgen]
pub struct FtpClient {
    session: Option<FtpSession>,
}

#[wasm_bindgen]
impl FtpClient {
    /// Establish a connection and log in.
    /// `opts` accepts {user, password, secure, allowSelfSigned, timeout, utf8, dataTls}.
    #[wasm_bindgen(js_name = "connect")]
    pub async fn connect(host: String, port: u16, opts: JsValue) -> Result<FtpClient, JsValue> {
        let o = parse_opts(&opts);
        let bridge = crate::config::bridge_url().to_string();
        let session = FtpSession::connect(&bridge, &host, port, o)
            .await
            .map_err(err_value)?;
        Ok(FtpClient {
            session: Some(session),
        })
    }

    fn sess(&mut self) -> Result<&mut FtpSession, JsValue> {
        self.session
            .as_mut()
            .ok_or_else(|| JsValue::from_str("connection closed"))
    }

    /// Directory listing; `kind` is one of "auto"|"unix"|"dos"|"mlsd"|"names".
    pub async fn list(&mut self, path: String, kind: String) -> Result<JsValue, JsValue> {
        let k = match kind.as_str() {
            "unix" => ListKind::Unix,
            "dos" => ListKind::Dos,
            "mlsd" => ListKind::Mlsd,
            "names" => ListKind::Names,
            _ => ListKind::Auto,
        };
        let entries: Vec<Entry> = self.sess()?.list(&path, k).await.map_err(err_value)?;
        ok_value(&entries)
    }

    /// Current directory (cached `PWD`).
    pub async fn pwd(&mut self) -> Result<JsValue, JsValue> {
        let s = self.sess()?.pwd().await.map_err(err_value)?;
        ok_value(&serde_json::json!({ "path": s }))
    }

    /// Change directory; reply path is returned.
    pub async fn cwd(&mut self, path: String) -> Result<JsValue, JsValue> {
        let s = self.sess()?.cwd(&path).await.map_err(err_value)?;
        ok_value(&serde_json::json!({ "path": s }))
    }

    /// Go up one directory.
    pub async fn cd_up(&mut self) -> Result<JsValue, JsValue> {
        let s = self.sess()?.cd_up().await.map_err(err_value)?;
        ok_value(&serde_json::json!({ "path": s }))
    }

    /// SYST banner.
    pub async fn syst(&mut self) -> Result<String, JsValue> {
        self.sess()?.system().await.map_err(err_value)
    }

    /// Full session state (features, tls, cwd, transfer ids).
    pub fn state(&self) -> Result<JsValue, JsValue> {
        let session = self.session.as_ref().ok_or_else(|| JsValue::from_str("connection closed"))?;
        let text = serde_json::to_string(&SessionState::from(session))
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        js_sys::JSON::parse(&text).map_err(|_| JsValue::from_str("json parse failed"))
    }

    /// File size in bytes (None when the server lacks SIZE / the file is absent).
    pub async fn size(&mut self, path: String) -> Result<Option<f64>, JsValue> {
        let s = self.sess()?.size(&path).await.map_err(err_value)?;
        Ok(s.map(|v| v as f64))
    }

    /// File mtime in epoch millis (None when not supported/absent).
    pub async fn mdtm(&mut self, path: String) -> Result<Option<f64>, JsValue> {
        let s = self.sess()?.mdtm(&path).await.map_err(err_value)?;
        Ok(s.map(|v| v as f64))
    }

    /// Set mtime (MFMT). Returns whether the server accepted it.
    pub async fn set_mtime(&mut self, path: String, mtime: f64) -> Result<bool, JsValue> {
        self.sess()?
            .set_mtime(&path, mtime as i64)
            .await
            .map_err(err_value)
    }

    /// Change file/dir permissions via `SITE CHMOD` (server support varies).
    /// `mode` is an octal string such as "644" or "4755".
    pub async fn chmod(&mut self, path: String, mode: String) -> Result<(), JsValue> {
        let m = u32::from_str_radix(mode.trim(), 8).map_err(|_| {
            err_value(EngineError::new(
                "protocol",
                format!("invalid octal mode \"{}\"", mode.trim()),
            ))
        })?;
        self.sess()?.site_chmod(&path, m).await.map_err(err_value)
    }

    /// MLST metadata for one path (None if unsupported).
    pub async fn mlst(&mut self, path: String) -> Result<JsValue, JsValue> {
        let e = self.sess()?.mlst(&path).await.map_err(err_value)?;
        ok_value(&e)
    }

    pub async fn mkdir(&mut self, path: String) -> Result<(), JsValue> {
        self.sess()?.make_dir(&path).await.map_err(err_value)
    }

    pub async fn rmdir(&mut self, path: String) -> Result<(), JsValue> {
        self.sess()?.remove_dir(&path).await.map_err(err_value)
    }

    pub async fn delete(&mut self, path: String) -> Result<(), JsValue> {
        self.sess()?.delete_file(&path).await.map_err(err_value)
    }

    pub async fn rename(&mut self, from: String, to: String) -> Result<(), JsValue> {
        self.sess()?.rename(&from, &to).await.map_err(err_value)
    }

    /// Server status text (`STAT` without args).
    pub async fn stat(&mut self) -> Result<String, JsValue> {
        self.sess()?.stat_server().await.map_err(err_value)
    }

    /// `STAT <path>` listing-style metadata.
    pub async fn stat_path(&mut self, path: String) -> Result<String, JsValue> {
        self.sess()?.stat_path(&path).await.map_err(err_value)
    }

    pub async fn noop(&mut self) -> Result<(), JsValue> {
        self.sess()?.noop().await.map_err(err_value)
    }

    /// Simple whole-file download into memory.
    pub async fn download(&mut self, path: String, chunk: f64) -> Result<Vec<u8>, JsValue> {
        let id = self
            .sess()?
            .start_download(&path, 0)
            .await
            .map_err(err_value)?;
        let chunk_size = if chunk.is_finite() && chunk > 1024.0 {
            chunk as usize
        } else {
            64 * 1024
        };
        let mut out = Vec::new();
        loop {
            let next = {
                let session = self.sess()?;
                match session.pull_download(id, chunk_size).await {
                    Ok(v) => v,
                    Err(e) => {
                        let session = self.sess()?;
                        let _ = session.drop_transfer(id);
                        return Err(err_value(e));
                    }
                }
            };
            match next {
                Some(bytes) => out.extend_from_slice(&bytes),
                None => break,
            }
        }
        let session = self.sess()?;
        session.drop_transfer(id);
        Ok(out)
    }

    /// Simple whole-file upload from memory.
    pub async fn upload(&mut self, path: String, data: &[u8]) -> Result<f64, JsValue> {
        let session = self.sess()?;
        let id = session
            .start_upload(&path, false, 0)
            .await
            .map_err(err_value)?;
        let chunk_size = 128 * 1024;
        let mut sent = 0u64;
        while sent < data.len() as u64 {
            let end = std::cmp::min(sent + chunk_size as u64, data.len() as u64) as usize;
            let slice = &data[sent as usize..end];
            let session = self.sess()?;
            match session.push_upload(id, slice).await {
                Ok(t) => sent = t,
                Err(e) => {
                    let session = self.sess()?;
                    let _ = session.drop_transfer(id);
                    return Err(err_value(e));
                }
            }
        }
        let session = self.sess()?;
        let total = session.finish_upload(id).await.map_err(err_value)?;
        Ok(total as f64)
    }

    /// Streaming mode — begin a download in chunks; returns a transfer id.
    #[wasm_bindgen(js_name = "streamStartGet")]
    pub async fn stream_start_get(&mut self, path: String, offset: f64) -> Result<u32, JsValue> {
        let session = self.sess()?;
        session
            .start_download(&path, if offset > 0.0 { offset as u64 } else { 0 })
            .await
            .map_err(err_value)
    }

    /// Streaming mode — begin an upload; returns a transfer id.
    #[wasm_bindgen(js_name = "streamStartPut")]
    pub async fn stream_start_put(
        &mut self,
        path: String,
        append: bool,
        offset: f64,
    ) -> Result<u32, JsValue> {
        let session = self.sess()?;
        session
            .start_upload(&path, append, if offset > 0.0 { offset as u64 } else { 0 })
            .await
            .map_err(err_value)
    }

    /// Streaming mode — pull the next download chunk (`None` = done).
    #[wasm_bindgen(js_name = "streamPull")]
    pub async fn stream_pull(&mut self, id: u32, max_chunk: f64) -> Result<Option<Vec<u8>>, JsValue> {
        let session = self.sess()?;
        session
            .pull_download(id, if max_chunk > 0.0 { max_chunk as usize } else { 64 * 1024 })
            .await
            .map_err(err_value)
    }

    /// Streaming mode — push one upload chunk (returns the total sent).
    #[wasm_bindgen(js_name = "streamPush")]
    pub async fn stream_push(&mut self, id: u32, data: &[u8]) -> Result<f64, JsValue> {
        let session = self.sess()?;
        session.push_upload(id, data).await.map_err(err_value).map(|t| t as f64)
    }

    /// Streaming mode — finish an upload and consume the final reply.
    #[wasm_bindgen(js_name = "streamFinish")]
    pub async fn stream_finish(&mut self, id: u32) -> Result<f64, JsValue> {
        let session = self.sess()?;
        let total = session.finish_upload(id).await.map_err(err_value)?;
        Ok(total as f64)
    }

    /// Streaming mode — abort any in-flight transfer.
    #[wasm_bindgen(js_name = "streamAbort")]
    pub async fn stream_abort(&mut self, id: u32) -> Result<(), JsValue> {
        let session = self.sess()?;
        session.abort_transfer(id).await.map_err(err_value)
    }

    /// Send QUIT and drop the connection.
    pub async fn quit(&mut self) -> Result<(), JsValue> {
        if let Some(session) = self.session.as_mut() {
            let _ = session.quit().await;
        }
        self.session = None;
        Ok(())
    }

    /// Force-close without QUIT.
    #[wasm_bindgen(js_name = "abort")]
    pub async fn close_never(&mut self) -> Result<(), JsValue> {
        if let Some(session) = self.session.as_mut() {
            session.hard_close().await;
        }
        self.session = None;
        Ok(())
    }

    pub fn is_connected(&self) -> bool {
        self.session.is_some()
    }

    pub fn is_tls(&self) -> bool {
        self.session.as_ref().map(|s| s.is_tls()).unwrap_or(false)
    }

    pub fn data_tls_on(&self) -> bool {
        self.session.as_ref().map(|s| s.data_tls_on()).unwrap_or(false)
    }
}

#[derive(serde::Serialize)]
struct SessionState {
    host: String,
    port: u16,
    tls: bool,
    /// data-channel protection
    data_tls: bool,
    utf8: bool,
    syst: String,
    cwd: Option<String>,
    feats: FeatsState,
}

#[derive(serde::Serialize)]
struct FeatsState {
    utf8: bool,
    epsv: bool,
    size: bool,
    mdtm: bool,
    mfmt: bool,
    mlsd: bool,
    mlst: bool,
    rest: bool,
    auth_tls: bool,
}

impl From<&FtpSession> for SessionState {
    fn from(s: &FtpSession) -> Self {
        let f = &s.feats;
        SessionState {
            host: s.host.clone(),
            port: s.port,
            tls: s.is_tls(),
            data_tls: s.data_tls_on(),
            utf8: s.utf8,
            syst: s.syst.clone(),
            cwd: s.cached_cwd(),
            feats: FeatsState {
                utf8: f.utf8,
                epsv: f.epsv,
                size: f.size,
                mdtm: f.mdtm,
                mfmt: f.mfmt,
                mlsd: f.mlsd,
                mlst: f.mlsx,
                rest: f.rest_stream,
                auth_tls: f.auth_tls,
            },
        }
    }
}

// Silence unused warnings for types referenced only in serde paths.
#[allow(dead_code)]
fn _type_anchor(_: &Feats) {}

// ---------------------------------------------------------------------
// SFTP (SSH file transfer) — mirror of the FtpClient surface, backed by
// the russh/russh-sftp session. Options accept
// {user, password, privateKey, passphrase, allowSelfSigned,
//  trustFingerprints, timeout}.
// ---------------------------------------------------------------------

/// Parse `SshConnectOpts` from a JS object.
fn parse_ssh_opts(v: &JsValue) -> crate::ssh::session::SshConnectOpts {
    use crate::ssh::session::{KeyTrust, SshConnectOpts};
    let mut o = SshConnectOpts::default();
    if let Some(s) = opt_str(v, "user") {
        o.user = s;
    }
    if let Some(s) = opt_str(v, "password") {
        o.password = s;
    }
    if let Some(s) = opt_str(v, "privateKey") {
        o.private_key = Some(s);
    }
    if let Some(s) = opt_str(v, "passphrase") {
        o.passphrase = Some(s);
    }
    if opt_bool(v, "allowSelfSigned").unwrap_or(false) {
        o.trust = KeyTrust::Any;
    }
    else if let Some(fps) = js_sys::Reflect::get(v, &JsValue::from_str("trustFingerprints")).ok() {
        if fps.is_array() {
            if let Ok(refa) = fps.dyn_into::<js_sys::Array>() {
                let list: Vec<String> = (0..refa.length())
                    .filter_map(|i| refa.get(i).as_string())
                    .collect();
                o.trust = KeyTrust::Pinned(list);
            }
        }
    }
    if let Some(n) = opt_f64(v, "timeout") {
        if n > 1000.0 {
            o.timeout_ms = n as u64;
        }
    }
    o
}

#[wasm_bindgen]
pub struct SshClient {
    session: Option<crate::ssh::session::SshSession>,
}

#[wasm_bindgen]
impl SshClient {
    /// Establish the SSH connection (KEX + host-key policy) and log in.
    #[wasm_bindgen(js_name = "connect")]
    pub async fn connect(host: String, port: u16, opts: JsValue) -> Result<SshClient, JsValue> {
        let o = parse_ssh_opts(&opts);
        let session =
            crate::ssh::session::SshSession::connect(crate::config::bridge_url(), &host, port, o)
                .await
                .map_err(err_value)?;
        Ok(SshClient {
            session: Some(session),
        })
    }

    fn sess(&mut self) -> Result<&mut crate::ssh::session::SshSession, JsValue> {
        self.session
            .as_mut()
            .ok_or_else(|| JsValue::from_str("connection closed"))
    }

    /// Protocol state (cwd, host, port). `feats` is FTP-specific and thus
    /// absent for SFTP.
    pub fn state(&self) -> Result<JsValue, JsValue> {
        let session = self.session.as_ref().ok_or_else(|| JsValue::from_str("connection closed"))?;
        ok_value(&session.state_json())
    }

    /// Directory listing; `kind` is honored for API parity ("auto" etc.).
    pub async fn list(&mut self, path: String, kind: String) -> Result<JsValue, JsValue> {
        let entries = self.sess()?.list(&path, kind).await.map_err(err_value)?;
        ok_value(&entries)
    }

    /// Current directory (client-tracked starts at the server home path).
    pub async fn pwd(&mut self) -> Result<JsValue, JsValue> {
        let s = self.sess()?.pwd();
        ok_value(&serde_json::json!({ "path": s }))
    }

    /// Change directory (resolved + canonicalized server-side).
    pub async fn cwd(&mut self, path: String) -> Result<JsValue, JsValue> {
        let s = self.sess()?.cwd(&path).await.map_err(err_value)?;
        ok_value(&serde_json::json!({ "path": s }))
    }

    /// Go up one directory.
    pub async fn cd_up(&mut self) -> Result<JsValue, JsValue> {
        let s = self.sess()?.cd_up().await.map_err(err_value)?;
        ok_value(&serde_json::json!({ "path": s }))
    }

    /// File size in bytes (None when the server reports no size / absent).
    pub async fn size(&mut self, path: String) -> Result<Option<f64>, JsValue> {
        let s = self.sess()?.size(&path).await.map_err(err_value)?;
        Ok(s.map(|v| v as f64))
    }

    /// File mtime in epoch millis (None when the server reports no time).
    pub async fn mdtm(&mut self, path: String) -> Result<Option<f64>, JsValue> {
        let s = self.sess()?.mdtm(&path).await.map_err(err_value)?;
        Ok(s.map(|v| v as f64))
    }

    /// Single-file metadata (mirrors FTP MLST for the wrapper's statFile).
    pub async fn mlst(&mut self, path: String) -> Result<JsValue, JsValue> {
        match self.sess()?.mlst(path).await.map_err(err_value)? {
            Some(e) => ok_value(&e),
            None => Ok(JsValue::NULL),
        }
    }

    /// Set mtime (SFTP setstat). Returns false when unsupported.
    pub async fn set_mtime(&mut self, path: String, mtime: f64) -> Result<bool, JsValue> {
        self.sess()?
            .set_mtime(&path, mtime as i64)
            .await
            .map_err(err_value)
    }

    /// Change permissions via SFTP setstat. `mode` is an octal string
    /// ("644") — no server-side SITE CHMOD lottery here.
    pub async fn chmod(&mut self, path: String, mode: String) -> Result<(), JsValue> {
        self.sess()?.chmod(&path, mode).await.map_err(err_value)
    }

    pub async fn mkdir(&mut self, path: String) -> Result<(), JsValue> {
        self.sess()?.mkdir(&path).await.map_err(err_value)
    }

    pub async fn rmdir(&mut self, path: String) -> Result<(), JsValue> {
        self.sess()?.rmdir(&path).await.map_err(err_value)
    }

    pub async fn delete(&mut self, path: String) -> Result<(), JsValue> {
        self.sess()?.delete(&path).await.map_err(err_value)
    }

    pub async fn rename(&mut self, from: String, to: String) -> Result<(), JsValue> {
        self.sess()?.rename(&from, &to).await.map_err(err_value)
    }

    pub async fn noop(&mut self) -> Result<(), JsValue> {
        self.sess()?.noop().await.map_err(err_value)
    }

    /// Simple whole-file download into memory.
    pub async fn download(&mut self, path: String, chunk: f64) -> Result<Vec<u8>, JsValue> {
        let id = self
            .sess()?
            .start_download(&path, 0)
            .await
            .map_err(err_value)?;
        let chunk_size = if chunk.is_finite() && chunk > 1024.0 {
            chunk as usize
        }
        else {
            64 * 1024
        };
        let mut out = Vec::new();
        loop {
            let next = {
                let session = self.sess()?;
                match session.pull_download(id, chunk_size).await {
                    Ok(v) => v,
                    Err(e) => {
                        let session = self.sess()?;
                        let _ = session.drop_transfer(id);
                        return Err(err_value(e));
                    }
                }
            };
            match next {
                Some(bytes) => out.extend_from_slice(&bytes),
                None => break,
            }
        }
        let session = self.sess()?;
        session.drop_transfer(id);
        Ok(out)
    }

    /// Simple whole-file upload from memory.
    pub async fn upload(&mut self, path: String, data: &[u8]) -> Result<f64, JsValue> {
        let session = self.sess()?;
        let id = session
            .start_upload(&path, false, 0)
            .await
            .map_err(err_value)?;
        let chunk_size = 128 * 1024;
        let mut sent = 0u64;
        while sent < data.len() as u64 {
            let end = std::cmp::min(sent + chunk_size as u64, data.len() as u64) as usize;
            let slice = &data[sent as usize..end];
            let session = self.sess()?;
            match session.push_upload(id, slice).await {
                Ok(t) => sent = t,
                Err(e) => {
                    let session = self.sess()?;
                    let _ = session.drop_transfer(id);
                    return Err(err_value(e));
                }
            }
        }
        let session = self.sess()?;
        let total = session.finish_upload(id).await.map_err(err_value)?;
        Ok(total as f64)
    }

    /// Streaming mode — begin a download in chunks; returns a transfer id.
    #[wasm_bindgen(js_name = "streamStartGet")]
    pub async fn stream_start_get(&mut self, path: String, offset: f64) -> Result<u32, JsValue> {
        self.sess()?
            .start_download(&path, if offset > 0.0 { offset as u64 } else { 0 })
            .await
            .map_err(err_value)
    }

    /// Streaming mode — begin an upload; returns a transfer id.
    #[wasm_bindgen(js_name = "streamStartPut")]
    pub async fn stream_start_put(
        &mut self,
        path: String,
        append: bool,
        offset: f64,
    ) -> Result<u32, JsValue> {
        self.sess()?
            .start_upload(&path, append, if offset > 0.0 { offset as u64 } else { 0 })
            .await
            .map_err(err_value)
    }

    /// Streaming mode — pull the next download chunk (`None` = done).
    #[wasm_bindgen(js_name = "streamPull")]
    pub async fn stream_pull(&mut self, id: u32, max_chunk: f64) -> Result<Option<Vec<u8>>, JsValue> {
        self.sess()?
            .pull_download(id, if max_chunk > 0.0 { max_chunk as usize } else { 64 * 1024 })
            .await
            .map_err(err_value)
    }

    /// Streaming mode — push one upload chunk (returns the total sent).
    #[wasm_bindgen(js_name = "streamPush")]
    pub async fn stream_push(&mut self, id: u32, data: &[u8]) -> Result<f64, JsValue> {
        self.sess()?
            .push_upload(id, data)
            .await
            .map_err(err_value)
            .map(|t| t as f64)
    }

    /// Streaming mode — finish an upload and consume the final reply.
    #[wasm_bindgen(js_name = "streamFinish")]
    pub async fn stream_finish(&mut self, id: u32) -> Result<f64, JsValue> {
        self.sess()?
            .finish_upload(id)
            .await
            .map_err(err_value)
            .map(|t| t as f64)
    }

    /// Streaming mode — abort any in-flight transfer.
    #[wasm_bindgen(js_name = "streamAbort")]
    pub async fn stream_abort(&mut self, id: u32) -> Result<(), JsValue> {
        self.sess()?.abort_transfer(id).await.map_err(err_value)
    }

    /// Send QUIT-equivalents and drop the connection.
    pub async fn quit(&mut self) -> Result<(), JsValue> {
        if let Some(session) = self.session.as_mut() {
            let _ = session.quit().await;
        }
        self.session = None;
        Ok(())
    }

    /// Force-close without protocol shutdown.
    #[wasm_bindgen(js_name = "abort")]
    pub async fn close_never(&mut self) -> Result<(), JsValue> {
        if let Some(session) = self.session.as_mut() {
            session.hard_close().await;
        }
        self.session = None;
        Ok(())
    }

    pub fn is_connected(&self) -> bool {
        self.session.is_some()
    }

    pub fn is_tls(&self) -> bool {
        self.session.as_ref().map(|s| s.is_tls()).unwrap_or(false)
    }

    pub fn data_tls_on(&self) -> bool {
        self.session.as_ref().map(|s| s.data_tls_on()).unwrap_or(false)
    }
}
