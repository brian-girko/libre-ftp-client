// Passive-mode FTP data channels: EPSV/PASV dial, per-channel TLS (PROT P),
// and STREAMing of RETR/STOR/APPE with chunk-level backpressure.

use std::sync::Arc;

use rustls::ClientConfig;

use crate::ftp::control::{CmdError, Control};
use crate::tls::{TrustPolicy, TlsStream};
use crate::transport::WsStream;

/// Parse EPSV reply `(|||port|)` (or `(|host|port|)` variants).
pub fn parse_epsv(reply_text: &str) -> Option<u16> {
    let start = reply_text.find('(')?;
    let end = reply_text.rfind(')')?;
    if end <= start {
        return None;
    }
    let inner = &reply_text[start + 1..end];
    let parts: Vec<&str> = inner
        .split('|')
        .map(|s| s.trim())
        .filter(|p| !p.is_empty())
        .collect();
    if let Some(last) = parts.last() {
        if let Ok(port) = last.parse::<u16>() {
            if (1..=65535).contains(&port) {
                return Some(port);
            }
        }
    }
    let _ = inner;
    None
}

/// Parse PASV reply `(h1,h2,h3,h4,p1,p2)` (sometimes without parens).
/// Works on reply text that includes the numeric code prefix, e.g.
/// `227 Entering Passive Mode (127,0,0,1,158,65)`.
pub fn parse_pasv(reply_text: &str) -> Option<(String, u16)> {
    // Prefer the paren-delimited tuple per RFC 959
    let start = reply_text.find('(')?;
    let end = reply_text.rfind(')')?;
    if end <= start {
        return None;
    }
    let inner = &reply_text[start + 1..end];
    let nums: Vec<&str> = inner
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
        .collect();
    if nums.len() != 6 {
        return None;
    }
    let o: Vec<u32> = nums
        .iter()
        .filter_map(|s| s.parse::<u32>().ok())
        .collect();
    if o.len() != 6 {
        return None;
    }
    let ip = format!("{}.{}.{}.{}", o[0], o[1], o[2], o[3]);
    let port = ((o[4] << 8) | o[5]) as u16;
    if !(1..=65535).contains(&port) {
        return None;
    }
    Some((ip, port))
}

/// A passive data channel, optionally TLS protected (PROT P).
pub struct DataChannel {
    raw: Option<WsStream>,
    tls: Option<TlsStream>,
    pub tls_on: bool,
}

/// Negotiate a data connection in passive mode (EPSV, fallback PASV).
pub async fn open_passive(
    control: &mut Control,
    bridge_url: &str,
    timeout: u64,
) -> Result<(DataChannel, (String, u16)), CmdError> {
    let mut data_port: Option<u16> = None;
    let mut data_host: Option<String> = None;

    if control.feats.as_ref().map(|f| f.epsv).unwrap_or(false) {
        let reply = control.command("EPSV").await.map_err(|e| e)?;
        if reply.code == 229 {
            if let Some(port) = parse_epsv(&reply.text()) {
                data_port = Some(port);
                data_host = Some(control.host.clone());
            }
        }
    }
    if data_port.is_none() {
        // classic PASV
        let reply = control.command("PASV").await?;
        if reply.code != 227 {
            return Err(CmdError::Ftp(reply.code, reply.text()));
        }
        let (ip, port) = parse_pasv(&reply.text())
            .ok_or_else(|| CmdError::Protocol(format!("bad PASV reply: {}", reply.text())))?;
        // Some servers advertise a NAT-unroutable address (127.0.0.1) or 0.0.0.0;
        // fall back to the control host in those cases.
        let host = if ip == "0.0.0.0" || ip == "127.0.0.1" {
            control.host.clone()
        } else {
            ip
        };
        data_port = Some(port);
        data_host = Some(host);
    }
    if let (Some(host), Some(port)) = (data_host, data_port) {
        let stream = WsStream::connect(bridge_url, &host, port, Some(timeout))
            .await
            .map_err(CmdError::Io)?;
        let raw = stream;
        return Ok((
            DataChannel {
                raw: Some(raw),
                tls: None,
                tls_on: false,
            },
            (host, port),
        ));
    }
    Err(CmdError::Protocol("no passive data channel possible".to_string()))
}

/// Upgrade a data channel to TLS (for PROT P on FTPS servers).
/// Upgrade a data channel to TLS with a pre-built shared config (session
/// resumption stays consistent with the control channel).
pub async fn tls_data_with_config(
    channel: DataChannel,
    config: Arc<ClientConfig>,
    host: &str,
) -> Result<DataChannel, CmdError> {
    let DataChannel { raw, tls: _, tls_on: _ } = channel;
    let tls = match raw {
        Some(raw) => {
            TlsStream::connect(raw, config, host)
                .await
                .map_err(CmdError::Io)?
        }
        None => return Err(CmdError::Io("data channel closed".to_string())),
    };
    Ok(DataChannel {
        raw: None,
        tls: Some(tls),
        tls_on: true,
    })
}

pub async fn tls_data(
    channel: DataChannel,
    trust_policy: TrustPolicy,
    host: &str,
) -> Result<DataChannel, CmdError> {
    let config = crate::tls::build_client_config(&trust_policy).map_err(CmdError::Protocol)?;
    tls_data_with_config(channel, config, host).await
}

impl DataChannel {
    pub async fn read(&mut self, buf: &mut [u8]) -> Result<usize, CmdError> {
        if let Some(t) = self.tls.as_mut() {
            Ok(t.read(buf).await.map_err(|e| CmdError::Io(e.message()))?)
        } else if let Some(s) = self.raw.as_mut() {
            Ok(s.read(buf).await?)
        } else {
            Err(CmdError::Io("data channel closed".to_string()))
        }
    }

    pub async fn write_all(&mut self, data: &[u8]) -> Result<(), CmdError> {
        if let Some(t) = self.tls.as_mut() {
            Ok(t.write_all(data).await.map_err(|e| CmdError::Io(e.message()))?)
        } else if let Some(s) = self.raw.as_mut() {
            Ok(s.write_all(data).await?)
        } else {
            Err(CmdError::Io("data channel closed".to_string()))
        }
    }

    pub async fn close(&mut self) {
        if let Some(t) = self.tls.as_mut() {
            t.close().await;
        }
        if let Some(s) = self.raw.as_mut() {
            s.close();
        }
        self.tls = None;
        self.raw = None;
    }
}

