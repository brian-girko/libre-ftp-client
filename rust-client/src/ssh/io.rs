// tokio AsyncRead/AsyncWrite adapter over the bridge WebSocket, plugging
// the engine's transport into `russh::client::connect_stream`.
//
// Reads use the existing shared-state queue (fed by the WebSocket message
// handler) with proper waker registration. Writes are synchronous
// fire-and-forget (WebSockets buffer internally); flush/shutdown are no-ops
// because the underlying socket performs its own framing.

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite};

use crate::transport::WsStream;

/// wasm32-unknown-unknown has no stderr plumbing, so diagnostics must go
/// through the JS console.
#[allow(dead_code)]
pub(crate) fn ssh_log(msg: &str) {
    web_sys::console::error_1(&wasm_bindgen::JsValue::from_str(msg));
}

fn io_err(e: &crate::transport::StreamError) -> io::Error {
    io::Error::new(
        io::ErrorKind::ConnectionAborted,
        format!("SFTP stream error: {}", e.message()),
    )
}

pub struct WsIo {
    stream: WsStream,
}

impl WsIo {
    pub async fn connect(
        bridge_url: &str,
        host: &str,
        port: u16,
        timeout_ms: Option<u64>,
    ) -> Result<WsIo, String> {
        let stream = WsStream::connect(bridge_url, host, port, timeout_ms).await?;
        Ok(WsIo { stream })
    }

    /// Non-owning view for consumers (russh's session loop).
    pub fn view(&self) -> WsIo {
        WsIo {
            stream: self.stream.view(),
        }
    }

    /// Force the underlying WebSocket closed (hard disconnect).
    pub fn close(&mut self) {
        self.stream.close();
    }
}

impl AsyncRead for WsIo {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let size = buf.remaining();
        let mut scratch = vec![0u8; size];
        let r = match Pin::new(&mut self.stream).poll_read_bytes(&mut scratch, cx) {
            Poll::Ready(Ok(0)) => Poll::Ready(Ok(())),
            Poll::Ready(Ok(n)) => {
                buf.put_slice(&scratch[..n]);
                Poll::Ready(Ok(()))
            }
            Poll::Ready(Err(e)) => {
                Poll::Ready(Err(e))
            }
            Poll::Pending => Poll::Pending,
        };
        r
    }
}

impl AsyncWrite for WsIo {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.stream.try_write(buf) {
            Ok(()) => Poll::Ready(Ok(buf.len())),
            Err(e) => Poll::Ready(Err(io_err(&e))),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        // writes already hit the socket synchronously
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.get_mut().stream.close();
        Poll::Ready(Ok(()))
    }
}

// SAFETY: `web_sys::WebSocket` is !Send, but on wasm32-unknown-unknown all
// code — including all `spawn_local` futures (russh's session loop uses
// wasm-bindgen scheduling) — runs on the single JS event loop thread. The
// handle can therefore never actually cross threads; `Send` is a bound
// imposed by russh's native-oriented trait signature, not a real hazard
// here. (russh-util and russh-sftp make the same argument themselves.)
unsafe impl Send for WsIo {}
