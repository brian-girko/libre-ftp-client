// rustls driver over a `WsStream`, with mid-stream upgrade support
// (needed for explicit FTPS `AUTH TLS`) and per-data-channel TLS.
//
// The sync `rustls::ClientConnection` state machine is pumped manually:
//   - plaintext out -> `tls.writer().write()` buffers; then `write_tls`
//     produces ciphertext records that are pushed onto the bridge stream.
//   - ciphertext in -> `read_tls` + `process_new_packets`; decrypted
//     plaintext becomes available via `tls.reader().read()`.

use std::io::{Read as _, Write as _};
use std::sync::Arc;

use rustls::client::danger::{
    HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{
    ClientConfig, ClientConnection, DigitallySignedStruct, Error as TlsError, RootCertStore,
    SignatureScheme,
};
use webpki_roots as webpki_roots_crate;

use crate::transport::{StreamError, WsStream};

const TLS_BUFSZ: usize = 32 * 1024;

/// Certificate trust policy selected by the extension.
#[derive(Clone)]
pub enum TrustPolicy {
    /// Standard webpki verification with the bundled Mozilla roots.
    WebPki,
    /// Skip all verification (self-signed servers; user opted in).
    Any,
    /// Verify against user-supplied DER root certificates.
    Pinned(Vec<CertificateDer<'static>>),
}

impl std::fmt::Debug for TrustPolicy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TrustPolicy::WebPki => write!(f, "WebPki"),
            TrustPolicy::Any => write!(f, "Any"),
            TrustPolicy::Pinned(certs) => write!(f, "Pinned({} roots)", certs.len()),
        }
    }
}

const SUPPORTED_SCHEMES: &[SignatureScheme] = &[
    SignatureScheme::RSA_PKCS1_SHA256,
    SignatureScheme::RSA_PKCS1_SHA384,
    SignatureScheme::RSA_PKCS1_SHA512,
    SignatureScheme::RSA_PSS_SHA256,
    SignatureScheme::RSA_PSS_SHA384,
    SignatureScheme::RSA_PSS_SHA512,
    SignatureScheme::ECDSA_NISTP256_SHA256,
    SignatureScheme::ECDSA_NISTP384_SHA384,
    SignatureScheme::ECDSA_NISTP521_SHA512,
    SignatureScheme::ED25519,
];

/// Signature-scheme-aware verification delegation helper.
fn verify_signature(
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
) -> Result<HandshakeSignatureValid, TlsError> {
    rustls::crypto::verify_tls12_signature(
        message,
        cert,
        dss,
        &rustls::crypto::ring::default_provider().signature_verification_algorithms,
    )
}

/// A verifier that trusts anything the server presents.
#[derive(Debug)]
struct NoVerifier;

impl ServerCertVerifier for NoVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        SUPPORTED_SCHEMES.to_vec()
    }
}

fn webpki_roots() -> RootCertStore {
    let mut store = RootCertStore::empty();
    for anchor in webpki_roots_crate::TLS_SERVER_ROOTS.iter() {
        let der = CertificateDer::from(anchor.subject.as_ref().to_vec());
        let _ = store.add(der);
    }
    store
}

/// Build a shared `ClientConfig` honoring the trust policy. The same config
/// (and its resumption store) is reused by the control and data channels so
/// data-channel handshakes resume cheaply.
pub fn build_client_config(policy: &TrustPolicy) -> Result<Arc<ClientConfig>, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("tls protocol versions: {}", e))?;

    let config = match policy {
        TrustPolicy::Any => builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoVerifier))
            .with_no_client_auth(),
        TrustPolicy::WebPki => builder
            .with_root_certificates(webpki_roots())
            .with_no_client_auth(),
        TrustPolicy::Pinned(certs) => {
            let mut roots = RootCertStore::empty();
            for c in certs {
                roots
                    .add(c.clone())
                    .map_err(|e| format!("bad pinned cert: {}", e))?;
            }
            builder.with_root_certificates(roots).with_no_client_auth()
        }
    };

    let mut config = config;
    config.resumption = rustls::client::Resumption::in_memory_sessions(64);
    Ok(Arc::new(config))
}

/// TLS-protected stream: rustls driven manually over a `WsStream`.
pub struct TlsStream {
    tls: ClientConnection,
    inner: WsStream,
    down: bool,
}

impl TlsStream {
    /// Wrap `inner` (a plaintext bridge stream) and run the handshake.
    pub async fn connect(
        inner: WsStream,
        config: Arc<ClientConfig>,
        server_name: &str,
    ) -> Result<TlsStream, String> {
        let name = ServerName::try_from(server_name.to_string())
            .map_err(|e| format!("invalid server name '{}': {}", server_name, e))?;
        let tls = ClientConnection::new(config, name)
            .map_err(|e| format!("tls setup failed: {}", e))?;
        let mut stream = TlsStream {
            tls,
            inner,
            down: false,
        };
        stream.run_handshake().await?;
        Ok(stream)
    }

    /// Drive the handshake to completion without consuming plaintext.
    async fn run_handshake(&mut self) -> Result<(), String> {
        let mut wire = vec![0u8; TLS_BUFSZ];
        loop {
            // push pending ciphertext onto the bridge stream
            self.flush_records().await?;
            if !self.tls.is_handshaking() {
                return Ok(());
            }
            // pull more ciphertext
            let got = self
                .inner
                .read(&mut wire)
                .await
                .map_err(|e| format!("tls: wire read failed: {}", e.message()))?;
            if got == 0 {
                return Err("tls: connection closed during handshake".to_string());
            }
            let mut cursor = std::io::Cursor::new(&wire[..got]);
            self.tls
                .read_tls(&mut cursor)
                .map_err(|e| format!("tls: record read: {}", e))?;
            self.tls
                .process_new_packets()
                .map_err(|e| format!("tls: {}", e))?;
        }
    }

    /// Move ciphertext from rustls's write buffer onto the wire.
    async fn flush_records(&mut self) -> Result<(), String> {
        let mut buf = vec![0u8; TLS_BUFSZ];
        loop {
            let n = self
                .tls
                .write_tls(&mut std::io::Cursor::new(&mut buf[..]))
                .map_err(|e| format!("tls: record write: {}", e))?;
            if n == 0 {
                return Ok(());
            }
            self.inner
                .write_all(&buf[..n])
                .await
                .map_err(|e| format!("tls: wire write failed: {}", e.message()))?;
        }
    }

    /// Read decrypted plaintext into `buf`; `Ok(0)` = clean EOF.
    pub async fn read(&mut self, buf: &mut [u8]) -> Result<usize, StreamError> {
        if buf.is_empty() {
            return Ok(0);
        }
        loop {
            {
                let read_res = self
                    .tls
                    .reader()
                    .read(buf);
                match read_res {
                    Ok(0) => {}
                    Ok(n) => return Ok(n),
                    // rustls signals "no plaintext available yet" with
                    // WouldBlock; fetch more ciphertext and retry.
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(e) => {
                        return Err(StreamError::Failed(format!("tls read: {}", e)))
                    }
                }
            }
            if self.down {
                return Ok(0);
            }
            // fetch more ciphertext from the wire
            let mut wire = vec![0u8; TLS_BUFSZ];
            let got = self.inner.read(&mut wire).await?;
            if got == 0 {
                // peer closed; drain any remaining buffered plaintext once
                let n = self.tls.reader().read(buf).unwrap_or(0);
                self.down = true;
                if n > 0 {
                    return Ok(n);
                }
                return Ok(0);
            }
            let mut cursor = std::io::Cursor::new(&wire[..got]);
            self.tls
                .read_tls(&mut cursor)
                .map_err(|e| StreamError::Failed(format!("tls input: {}", e)))?;
            self.tls
                .process_new_packets()
                .map_err(|e| StreamError::Failed(format!("tls: {}", e)))?;
        }
    }

    /// Write plaintext; rustls encrypts and pushes records onto the wire.
    pub async fn write_all(&mut self, data: &[u8]) -> Result<(), StreamError> {
        self.tls
            .writer()
            .write_all(data)
            .map_err(|e| StreamError::Failed(format!("tls write: {}", e)))?;
        self.flush_records()
            .await
            .map_err(|e| StreamError::Failed(e))
    }

    /// Send close_notify and shut the underlying stream.
    pub async fn close(&mut self) {
        if !self.down {
            let _ = self.tls.send_close_notify();
            let _ = self.flush_records().await;
            self.down = true;
        }
        self.inner.close();
    }

    /// Underlying wire failure (if any).
    pub fn inner_failure(&self) -> Option<String> {
        self.inner.failure()
    }
}

impl Drop for TlsStream {
    fn drop(&mut self) {
        self.inner.close();
    }
}
