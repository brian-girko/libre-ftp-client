// Unified error type surfaced to JS.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct EngineError {
    /// stable machine code: 'io' | 'ftp' | 'protocol' | 'timeout' | 'auth' |
    /// 'tls' | 'aborted' | 'unsupported' | 'hostkey'
    pub code: String,
    /// FTP reply code when applicable
    pub ftp_code: Option<u16>,
    pub message: String,
    /// host key fingerprint (SHA256:...) for `hostkey` rejections
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
}

impl EngineError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        EngineError {
            code: code.to_string(),
            ftp_code: None,
            message: message.into(),
            fingerprint: None,
        }
    }

    pub fn with_ftp(mut self, code: u16) -> Self {
        self.ftp_code = Some(code);
        self
    }

    pub fn with_fingerprint(mut self, fp: String) -> Self {
        self.message = format!("{} (SHA256 fingerprint: {})", self.message, fp);
        self.fingerprint = Some(fp);
        self
    }

    pub fn io(m: impl Into<String>) -> Self {
        Self::new("io", m)
    }

    pub fn protocol(m: impl Into<String>) -> Self {
        Self::new("protocol", m)
    }

    pub fn timeout(ms: u64) -> Self {
        Self::new("timeout", format!("timed out after {} ms", ms))
    }

    pub fn unsupported(m: impl Into<String>) -> Self {
        Self::new("unsupported", m)
    }

    pub fn aborted() -> Self {
        Self::new("aborted", "operation aborted")
    }

    pub fn auth(code: u16, m: impl Into<String>) -> Self {
        Self::new("auth", m).with_ftp(code)
    }

    pub fn tls(m: impl Into<String>) -> Self {
        Self::new("tls", m)
    }

    /// Unknown/unpinned server host key (SFTP). Carries the SHA-256
    /// fingerprint so callers can prompt the user and pin it later.
    pub fn hostkey(fp: impl Into<String>) -> Self {
        Self::new("hostkey", format!("untrusted server host key")).with_fingerprint(fp.into())
    }

    pub fn from_ftp(code: u16, message: impl Into<String>) -> Self {
        let msg: String = message.into();
        let kind = if code == 530 || code == 431 || code == 331 || code == 332 || code == 350 {
            "auth"
        } else {
            "ftp"
        };
        Self::new(kind, msg).with_ftp(code)
    }
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for EngineError {}

impl From<crate::transport::StreamError> for EngineError {
    fn from(e: crate::transport::StreamError) -> Self {
        match e {
            crate::transport::StreamError::Failed(m) => EngineError::io(m),
            crate::transport::StreamError::Timeout { ms } => EngineError::timeout(ms),
        }
    }
}

impl From<crate::ftp::control::CmdError> for EngineError {
    fn from(e: crate::ftp::control::CmdError) -> Self {
        match e {
            crate::ftp::control::CmdError::Io(m) => EngineError::io(m),
            crate::ftp::control::CmdError::Ftp(c, m) => EngineError::from_ftp(c, m),
            crate::ftp::control::CmdError::Protocol(m) => EngineError::protocol(m),
            crate::ftp::control::CmdError::Timeout(ms) => EngineError::timeout(ms),
        }
    }
}

impl From<String> for EngineError {
    fn from(e: String) -> Self {
        EngineError::io(e)
    }
}

impl From<&str> for EngineError {
    fn from(e: &str) -> Self {
        EngineError::io(e.to_string())
    }
}

pub type EResult<T> = Result<T, EngineError>;
