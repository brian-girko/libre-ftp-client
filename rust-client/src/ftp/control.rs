// FTP control channel: reply parsing (single/multi-line), command dispatch,
// and the FEAT capability matrix.

use crate::tls::{TrustPolicy, TlsStream};
use crate::transport::WsStream;

pub const CRLF: &str = "\r\n";

/// A parsed FTP reply.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub code: u16,
    pub lines: Vec<String>,
}

impl Reply {
    pub fn is_positive(&self) -> bool {
        (200..300).contains(&self.code)
    }

    pub fn is_error(&self) -> bool {
        self.code >= 400
    }

    pub fn text(&self) -> String {
        self.lines.join("\n")
    }
}

/// Server capabilities discovered via FEAT.
#[derive(Debug, Clone, Default)]
pub struct Feats {
    pub utf8: bool,
    pub epsv: bool,
    pub pasv: bool,
    pub size: bool,
    pub mdtm: bool,
    pub mfmt: bool,
    pub rest_stream: bool,
    pub auth_tls: bool,
    pub auth_ssl: bool,
    pub pbsz: bool,
    pub prot: bool,
    pub mlsx: bool,
    pub mlsd: bool,
    pub tvfs: bool,
    pub stou: bool,
    pub site: bool,
    pub cmds: Vec<String>,
}

/// Parse a raw FEAT response body (lines between the 211 header and its
/// terminator).
pub fn parse_feat_lines(reply: &Reply) -> Feats {
    let mut feats = Feats::default();
    let body = &reply.lines[1..reply.lines.len().saturating_sub(1)];
    for line in body {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        let up = l.to_ascii_uppercase();
        if up.starts_with("UTF8") || up.starts_with("8-BIT-STRING") {
            feats.utf8 = true;
        }
        if let Some(rest) = strip_word(l, "EPSV") {
            if rest.is_empty() || rest.contains("OK") || rest.is_ascii() {
                feats.epsv = true;
            }
        }
        if l.starts_with("PASV") {
            feats.pasv = true;
        }
        if let Some(rest) = strip_word(l, "SIZE") {
            let _ = rest;
            feats.size = true;
        }
        if l.starts_with("MDTM") {
            feats.mdtm = true;
        }
        if l.starts_with("MFMT") {
            feats.mfmt = true;
        }
        if let Some(rest) = strip_word(l, "REST") {
            if rest.to_ascii_uppercase().contains("STREAM") {
                feats.rest_stream = true;
            }
        }
        if l.starts_with("AUTH") {
            let rest = l[4..].trim().to_ascii_uppercase();
            if rest.contains("TLS") {
                feats.auth_tls = true;
            }
            if rest.contains("SSL") {
                feats.auth_ssl = true;
            }
        }
        if l.starts_with("PBSZ") {
            feats.pbsz = true;
        }
        if l.starts_with("PROT") {
            feats.prot = true;
        }
        if l.starts_with("MLST") {
            feats.mlsx = true;
        }
        if l.starts_with("MLSD") {
            feats.mlsd = true;
        }
        if up.starts_with("TVFS") {
            feats.tvfs = true;
        }
        if l.starts_with("STOU") {
            feats.stou = true;
        }
        if l.starts_with("SITE") {
            feats.site = true;
        }
        feats.cmds.push(l.to_string());
    }
    feats
}

fn strip_word<'a>(line: &'a str, word: &str) -> Option<&'a str> {
    if !line.starts_with(word) {
        return None;
    }
    Some(line[word.len()..].trim())
}

/// Errors from the control channel / command engine.
#[derive(Debug, Clone)]
pub enum CmdError {
    Io(String),
    Ftp(u16, String),
    Protocol(String),
    Timeout(u64),
}

impl CmdError {
    pub fn code(&self) -> u16 {
        match self {
            CmdError::Ftp(c, _) => *c,
            _ => 500,
        }
    }

    pub fn message(&self) -> String {
        match self {
            CmdError::Io(e) => e.clone(),
            CmdError::Ftp(c, m) => format!("{} {}", c, m),
            CmdError::Protocol(e) => e.clone(),
            CmdError::Timeout(ms) => format!("command timed out after {} ms", ms),
        }
    }
}

impl std::fmt::Display for CmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for CmdError {}

impl From<crate::transport::StreamError> for CmdError {
    fn from(e: crate::transport::StreamError) -> Self {
        match e {
            crate::transport::StreamError::Failed(m) => CmdError::Io(m),
            crate::transport::StreamError::Timeout { ms } => CmdError::Timeout(ms),
        }
    }
}

/// A live FTP control transport (plaintext or TLS).
pub enum Channel {
    Plain(WsStream),
    Tls(TlsStream),
}

impl Channel {
    pub async fn read(&mut self, buf: &mut [u8]) -> Result<usize, CmdError> {
        match self {
            Channel::Plain(s) => Ok(s.read(buf).await?),
            Channel::Tls(s) => Ok(s.read(buf).await.map_err(|e| CmdError::Io(e.message()))?),
        }
    }

    pub async fn write_all(&mut self, data: &[u8]) -> Result<(), CmdError> {
        match self {
            Channel::Plain(s) => Ok(s.write_all(data).await?),
            Channel::Tls(s) => Ok(s.write_all(data).await.map_err(|e| CmdError::Io(e.message()))?),
        }
    }
}


/// Buffered FTP control channel.
pub struct Control {
    channel: Option<Channel>,
    rxbuf: Vec<u8>,
    rxpos: usize,
    utf8: bool,
    pub host: String,
    pub port: u16,
    pub feats: Option<Feats>,
    pub trust: TrustPolicy,
    pub closed: bool,
}

impl Control {
    pub fn new(channel: Channel, host: String, port: u16, trust: TrustPolicy) -> Control {
        Control {
            channel: Some(channel),
            rxbuf: Vec::with_capacity(8192),
            rxpos: 0,
            utf8: false,
            host,
            port,
            feats: None,
            trust,
            closed: false,
        }
    }

    pub fn is_tls(&self) -> bool {
        matches!(self.channel.as_ref(), Some(Channel::Tls(_)))
    }

    pub fn set_utf8(&mut self, on: bool) {
        self.utf8 = on;
    }

    pub fn utf8(&self) -> bool {
        self.utf8
    }

    /// Take the channel out (for mid-stream TLS upgrade). The Control object
    /// remains alive for state (buffer/host/port); it is temporarily empty.
    pub fn take_channel(&mut self) -> Option<Channel> {
        self.channel.take()
    }

    pub fn put_channel(&mut self, channel: Channel) {
        self.channel = Some(channel);
    }

    fn channel_mut(&mut self) -> Result<&mut Channel, CmdError> {
        self.channel.as_mut().ok_or_else(|| {
            CmdError::Io("control channel is being upgraded (TLS handshake in progress)".to_string())
        })
    }

    /// Send a command line (`cmd` without CRLF). Rejects embedded CRLF.
    pub async fn send_line(&mut self, cmd: &str) -> Result<(), CmdError> {
        if cmd.contains('\r') || cmd.contains('\n') {
            return Err(CmdError::Protocol("command inline contains CRLF".to_string()));
        }
        let mut bytes = Vec::with_capacity(cmd.len() + 2);
        bytes.extend_from_slice(cmd.as_bytes());
        bytes.extend_from_slice(b"\r\n");
        self.channel_mut()?.write_all(&bytes).await
    }

    /// Read a single CRLF/LF-terminated line; `Ok(None)` = clean EOF.
    async fn read_line(&mut self) -> Result<Option<String>, CmdError> {
        loop {
            if let Some(rel) = find_line_end(&self.rxbuf[self.rxpos..]) {
                let line_end = self.rxpos + rel;
                let line = String::from_utf8_lossy(&self.rxbuf[self.rxpos..line_end])
                    .trim_end_matches('\r')
                    .to_string();
                // advance past the '\n'
                self.rxpos = line_end + 1;
                return Ok(Some(line));
            }
            if self.rxpos > 0 {
                self.rxbuf.drain(..self.rxpos);
                self.rxpos = 0;
            }
            if self.rxbuf.len() > 256 * 1024 {
                return Err(CmdError::Protocol("control reply too long".to_string()));
            }
            let mut buf = [0u8; 8192];
            let n = self.channel_mut()?.read(&mut buf).await?;
            if n == 0 {
                if self.rxbuf.is_empty() {
                    return Ok(None);
                }
                let ret = String::from_utf8_lossy(&self.rxbuf).into_owned();
                self.rxbuf.clear();
                self.rxpos = 0;
                return Ok(Some(ret));
            }
            self.rxbuf.extend_from_slice(&buf[..n]);
        }
    }

    /// Read one complete FTP reply (handles multi-line `NNN-` continuation
    /// terminated by `NNN `).
    pub async fn read_reply(&mut self) -> Result<Reply, CmdError> {
        let mut lines: Vec<String> = Vec::new();
        let first = match self.read_line().await? {
            Some(l) => l,
            None => return Err(CmdError::Io("control channel closed by peer".to_string())),
        };
        let (code, mut conts) = parse_reply_head(&first)?;
        lines.push(first);
        while conts {
            let l = self
                .read_line()
                .await?
                .ok_or_else(|| CmdError::Protocol("reply truncated by EOF".to_string()))?;
            let _ = parse_reply_head(&l);
            match parse_reply_head(&l) {
                Ok((c, false)) if c == code => {
                    conts = false;
                    lines.push(l);
                }
                _ => lines.push(l),
            }
            if lines.len() > 4096 {
                return Err(CmdError::Protocol("reply too long (4096+ lines)".to_string()));
            }
        }
        Ok(Reply { code, lines })
    }

    /// Send a command and await its final reply.
    pub async fn command(&mut self, cmd: &str) -> Result<Reply, CmdError> {
        self.send_line(cmd).await?;
        self.read_reply().await
    }

    pub async fn close(&mut self) {
        self.closed = true;
        if let Some(ch) = self.channel.as_mut() {
            match ch {
                Channel::Plain(s) => s.close(),
                Channel::Tls(s) => s.close().await,
            }
        }
        self.channel = None;
    }
}

/// Index of the next `\n` in `buf`, or None.
fn find_line_end(buf: &[u8]) -> Option<usize> {
    buf.iter().position(|c| *c == b'\n')
}

/// Parse a reply header: 3-digit code + optional continuation flag.
/// `250-x` => (250, true); `250 x...|x` => (250, false); `250` => (250,false).
pub fn parse_reply_head(line: &str) -> Result<(u16, bool), CmdError> {
    let bytes = line.as_bytes();
    if bytes.len() < 3 {
        return Err(CmdError::Protocol(format!("short reply: {:?}", line)));
    }
    let mut code = 0u16;
    for b in bytes.iter().take(3) {
        if !b.is_ascii_digit() {
            return Err(CmdError::Protocol(format!("bad reply code: {:?}", line)));
        }
        code = code * 10 + (b - b'0') as u16;
    }
    match bytes.get(3) {
        Some(b'-') => Ok((code, true)),
        _ => Ok((code, false)),
    }
}

/// Human-readable multi-line text of a reply (CRLF-joined).
pub fn reply_text(code: u16, lines: &[String]) -> String {
    let _ = code;
    lines.join("\n")
}
