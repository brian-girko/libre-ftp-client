//! SSH/SFTP over the ws-to-tls bridge.
//!
//! Built on `russh` (SSH2 transport; explicitly wasm32-aware — its session
//! loop runs on `wasm_bindgen_futures::spawn_local`, no tokio reactor) and
//! `russh-sftp` (SFTP v3 protocol client). russh's `connect_stream` entry
//! point lets us hand it the bridge WebSocket adapter from `io::WsIo`
//! instead of a real socket, keeping the crypto entirely inside the engine
//! (same principle as rustls-vs-TLS in the FTP path).

pub mod io;
pub mod session;
