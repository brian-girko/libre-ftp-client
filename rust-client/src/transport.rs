// Byte stream over the ws-to-tls bridge (extension/core/ws-to-tls/ws-to-tls.js).
//
// Dial protocol (one WebSocket per stream): the client first sends a TEXT
// frame `{op:'open', host, port, secure:false}`; the bridge replies TEXT
// `{op:'ready'}` or `{op:'error'}` and then tunnels the raw TCP stream as
// BINARY frames.
//
// We always dial `secure:false` because this engine performs its own TLS
// (rustls), which enables mid-stream AUTH TLS upgrades.

use std::collections::VecDeque;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

use crate::sys::to_byte_vec;

/// Errors surfaced by a stream.
#[derive(Debug, Clone)]
pub enum StreamError {
    /// WebSocket-level or bridge-level failure (includes `{op:'error'}` messages).
    Failed(String),
    /// Idle timeout expired while waiting for data.
    Timeout { ms: u64 },
}

impl StreamError {
    pub fn message(&self) -> String {
        match self {
            StreamError::Failed(m) => m.clone(),
            StreamError::Timeout { ms } => format!("read timed out after {} ms", ms),
        }
    }
}

impl std::fmt::Display for StreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for StreamError {}

#[derive(Clone, PartialEq, Debug)]
enum Phase {
    /// Waiting for the bridge `{op:'ready'}` control frame.
    WaitingOpen,
    /// Fully usable; data flows through the queue.
    Open,
    /// Peer ended the stream (clean EOF).
    Eof,
    /// Terminated with an error.
    Failed(String),
}

struct WsState {
    phase: Phase,
    /// WebSocket reached OPEN (ready to send)
    sock_open: bool,
    queue: VecDeque<Vec<u8>>,
    waiter: Option<Waker>,
}

impl WsState {
    fn set_failed(&mut self, msg: String) {
        if !matches!(self.phase, Phase::Failed(_) | Phase::Eof) {
            self.phase = Phase::Failed(msg);
        }
        self.wake();
    }

    fn wake(&mut self) {
        if let Some(w) = self.waiter.take() {
            w.wake();
        }
    }
}

type Shared = Arc<Mutex<WsState>>;

pub(crate) fn now_ms() -> f64 {
    js_sys::Date::now()
}

// ------------------------------------------------------------------
// WsStream
// ------------------------------------------------------------------

/// Asynchronous half-duplex-safe byte stream over a bridge-tunneled TCP
/// connection. Data arrives in chunks from JS; `read` splits them to fit the
/// caller's buffer.
pub struct WsStream {
    shared: Shared,
    ws: Option<web_sys::WebSocket>,
    /// Keeps the inline event callbacks alive for the lifetime of the handle.
    #[allow(dead_code)]
    handlers: Vec<Closure<dyn FnMut(JsValue)>>,
    timeout_ms: u64,
}

/// Default idle timeout when the caller does not configure one (30 s).
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;

impl WsStream {
    /// Dial `host:port` through the bridge WebSocket at `bridge_url`.
    pub async fn connect(
        bridge_url: &str,
        host: &str,
        port: u16,
        timeout_ms: Option<u64>,
    ) -> Result<WsStream, String> {
        let ws = web_sys::WebSocket::new(bridge_url)
            .map_err(|_| format!("cannot open bridge websocket at {}", bridge_url))?;
        ws.set_binary_type(web_sys::BinaryType::Arraybuffer);

        let shared: Shared = Arc::new(Mutex::new(WsState {
            phase: Phase::WaitingOpen,
            sock_open: false,
            queue: VecDeque::new(),
            waiter: None,
        }));

        let sh_msg = shared.clone();
        let on_msg = Closure::<dyn FnMut(JsValue)>::new(move |ev: JsValue| {
            let ev: web_sys::MessageEvent = ev.unchecked_into();
            let data = ev.data();
            // Control frames are TEXT; tunnel data is always binary.
            if let Some(text) = data.as_string() {
                let op = serde_json::from_str::<serde_json::Value>(&text)
                    .ok()
                    .and_then(|v| v.get("op").and_then(|o| o.as_str()).map(str::to_string));
                let mut st = sh_msg.lock().unwrap();
                match st.phase.clone() {
                    Phase::WaitingOpen => match op.as_deref() {
                        Some("ready") => {
                            st.phase = Phase::Open;
                            st.wake();
                        }
                        _ => st.set_failed(format!("bridge dial error: {}", text)),
                    },
                    Phase::Open => {
                        st.set_failed(format!("bridge error frame: {}", text));
                    }
                    _ => {}
                }
            } else {
                let bytes = to_byte_vec(&data);
                let mut st = sh_msg.lock().unwrap();
                match st.phase.clone() {
                    Phase::Open => {
                        st.queue.push_back(bytes);
                        st.wake();
                    }
                    Phase::WaitingOpen => {
                        st.set_failed("bridge sent binary data before dial handshake".to_string())
                    }
                    _ => {}
                }
            }
        });
        ws.set_onmessage(Some(on_msg.as_ref().unchecked_ref()));

        let sh_open = shared.clone();
        let on_open = Closure::<dyn FnMut(JsValue)>::new(move |_ev: JsValue| {
            let mut st = sh_open.lock().unwrap();
            st.sock_open = true;
            st.wake();
        });
        ws.set_onopen(Some(on_open.as_ref().unchecked_ref()));

        let sh_err = shared.clone();
        let on_err = Closure::<dyn FnMut(JsValue)>::new(move |ev: JsValue| {
            let msg = match ev.dyn_into::<web_sys::ErrorEvent>() {
                Ok(ee) => format!("bridge websocket error: {}", ee.message()),
                Err(_) => "bridge websocket error".to_string(),
            };
            sh_err.lock().unwrap().set_failed(msg);
        });
        ws.set_onerror(Some(on_err.as_ref().unchecked_ref()));

        let sh_close = shared.clone();
        let on_close = Closure::<dyn FnMut(JsValue)>::new(move |_ev: JsValue| {
            let mut st = sh_close.lock().unwrap();
            match st.phase.clone() {
                Phase::WaitingOpen => st.set_failed("bridge closed during dial".to_string()),
                Phase::Open => {
                    st.phase = Phase::Eof;
                    st.wake();
                }
                _ => {}
            }
        });
        ws.set_onclose(Some(on_close.as_ref().unchecked_ref()));

        let handlers = vec![on_msg, on_err, on_close, on_open];

        // wait for the WebSocket itself to reach OPEN, then fire the dial
        {
            let deadline = now_ms() + 15_000.0;
            loop {
                if self_wait_socket(shared.clone(), deadline).await.is_err() {
                    return Err("bridge websocket never reached OPEN".to_string());
                }
                if shared.lock().unwrap().sock_open {
                    break;
                }
            }
        }

        // fire the dial request
        ws.send_with_str(
            &serde_json::json!({"op": "open", "host": host, "port": port, "secure": false})
                .to_string(),
        )
        .map_err(|_| "bridge send failed (dial request)")?;

        // wait for `{op:'ready'}` (or error/timeout)
        Waiter {
            shared: shared.clone(),
            kind: WaitKind::Open,
            timeout_ms: 15_000,
            deadline: now_ms() + 15_000.0,
        }
        .await
        .map_err(|e| e.message())?;

        let st = shared.lock().unwrap();
        if st.phase != Phase::Open {
            return Err("bridge dial did not complete".to_string());
        }
        drop(st);

        Ok(WsStream {
            shared,
            ws: Some(ws),
            handlers,
            timeout_ms: timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS),
        })
    }

    pub fn set_timeout(&mut self, timeout_ms: u64) {
        self.timeout_ms = timeout_ms;
    }

    pub fn timeout_ms(&self) -> u64 {
        self.timeout_ms
    }

    /// Read up to `buf.len()` bytes into `buf`; `Ok(0)` means clean EOF.
    /// A `Timeout` error is returned when nothing arrives within the timeout.
    pub async fn read(&mut self, buf: &mut [u8]) -> Result<usize, StreamError> {
        if buf.is_empty() {
            return Ok(0);
        }
        loop {
            let ready = {
                let mut st = self.shared.lock().unwrap();
                match st.phase.clone() {
                    Phase::Open => {
                        if let Some(mut chunk) = st.queue.pop_front() {
                            let n = chunk.len().min(buf.len());
                            if chunk.len() > buf.len() {
                                let rest = chunk.split_off(n);
                                st.queue.push_front(rest);
                            }
                            buf[..n].copy_from_slice(&chunk[..n]);
                            return Ok(n);
                        }
                        false
                    }
                    Phase::Eof => return Ok(0),
                    Phase::Failed(e) => return Err(StreamError::Failed(e)),
                    Phase::WaitingOpen => {
                        return Err(StreamError::Failed("stream not dialed".to_string()))
                    }
                }
            };
            if ready {
                continue;
            }
            Waiter {
                shared: self.shared.clone(),
                kind: WaitKind::Data,
                timeout_ms: self.timeout_ms,
                deadline: now_ms() + self.timeout_ms as f64,
            }
            .await?;
        }
    }

    /// Write all bytes to the underlying WebSocket.
    pub async fn write_all(&mut self, data: &[u8]) -> Result<(), StreamError> {
        match self.ws.as_ref() {
            Some(ws) if matches!(self.shared.lock().unwrap().phase, Phase::Open) => ws
                .send_with_u8_array(data)
                .map_err(|_| StreamError::Failed("bridge websocket send failed".to_string())),
            Some(_) => Err(StreamError::Failed("stream not ready".to_string())),
            None => Err(StreamError::Failed("stream already closed".to_string())),
        }
    }

    /// Close the underlying WebSocket.
    pub fn close(&mut self) {
        if let Some(ws) = self.ws.take() {
            // Detach callbacks first: JS may still fire events (close/pending
            // message) after the Rust closures are dropped, and invoking a
            // dropped closure panics ("closure invoked after being dropped").
            ws.set_onmessage(None);
            ws.set_onerror(None);
            ws.set_onclose(None);
            ws.set_onopen(None);
            let _ = ws.close();
        }
        {
            let mut st = self.shared.lock().unwrap();
            if st.phase == Phase::Open {
                st.phase = Phase::Eof;
            }
            st.wake();
        }
    }

    /// Current failure message, if the stream has failed.
    pub fn failure(&self) -> Option<String> {
        let st = self.shared.lock().unwrap();
        match &st.phase {
            Phase::Failed(e) => Some(e.clone()),
            _ => None,
        }
    }

    /// Bytes currently buffered in the receive queue.
    pub fn pending_bytes(&self) -> usize {
        self.shared.lock().unwrap().queue.iter().map(Vec::len).sum()
    }

    // ------------------------------------------------------------------
    // Poll-mode access for the SFTP (russh) transport adapter. russh drives
    // its session through tokio's AsyncRead/AsyncWrite; we bridge that to the
    // shared-state machinery: data already lands in the queue from the
    // WebSocket callbacks, and writes are synchronous fire-and-forget in JS
    // (the browser/Node socket buffers them).
    // ------------------------------------------------------------------

    /// Non-owning view: shares state AND socket but carries no event
    /// handlers, so the view's Drop cannot double-close the socket. Passing
    /// this to another consumer lets it read/write while we keep ownership
    /// of the lifecycle.
    pub(crate) fn view(&self) -> WsStream {
        WsStream {
            shared: self.shared.clone(),
            ws: self.ws.clone(),
            handlers: Vec::new(),
            timeout_ms: self.timeout_ms,
        }
    }

    /// Synchronous best-effort write.
    pub(crate) fn try_write(&mut self, data: &[u8]) -> Result<(), StreamError> {
        let phase = self.shared.lock().unwrap().phase.clone();
        match (&phase, self.ws.as_ref()) {
            (Phase::Open, Some(ws)) => ws.send_with_u8_array(data).map_err(|_| {
                StreamError::Failed("bridge websocket send failed".to_string())
            }),
            (Phase::Open, None) => Err(StreamError::Failed("bridge websocket missing".to_string())),
            (Phase::Eof, _) => Ok(()),
            (Phase::Failed(e), _) => Err(StreamError::Failed(e.clone())),
            _ => Err(StreamError::Failed("stream not ready".to_string())),
        }
    }

    /// Poll-based read: `Ok(n)` with n > 0 yields data, `Ok(0)` is EOF,
    /// `Err` propagates stream failure. Registers the poll waker.
    pub(crate) fn poll_read_bytes(&mut self, buf: &mut [u8], cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        if buf.is_empty() {
            return Poll::Ready(Ok(0));
        }
        let mut st = self.shared.lock().unwrap();
        match st.phase.clone() {
            Phase::Open => {
                if let Some(mut chunk) = st.queue.pop_front() {
                    let n = chunk.len().min(buf.len());
                    if chunk.len() > buf.len() {
                        let rest = chunk.split_off(n);
                        st.queue.push_front(rest);
                    }
                    buf[..n].copy_from_slice(&chunk[..n]);
                    Poll::Ready(Ok(n))
                } else {
                    st.waiter = Some(cx.waker().clone());
                    Poll::Pending
                }
            }
            Phase::Eof => Poll::Ready(Ok(0)),
            Phase::Failed(e) => Poll::Ready(Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionAborted,
                format!("stream failed: {}", e),
            ))),
            Phase::WaitingOpen => Poll::Ready(Err(std::io::Error::new(
                std::io::ErrorKind::NotConnected,
                "stream not dialed",
            ))),
        }
    }
}

impl Clone for WsStream {
    fn clone(&self) -> Self {
        WsStream {
            shared: self.shared.clone(),
            ws: self.ws.clone(),
            handlers: Vec::new(),
            timeout_ms: self.timeout_ms,
        }
    }
}

impl Drop for WsStream {
    fn drop(&mut self) {
        // Only the owning (handler-carrying) instance closes the socket;
        // clones are read-only views used while another handle is active.
        if self.handlers.is_empty() {
            return;
        }
        self.close();
    }
}

// Wait until the WebSocket open flag flips (or deadline).
async fn self_wait_socket(shared: Shared, deadline: f64) -> Result<(), StreamError> {
    loop {
        if shared.lock().unwrap().sock_open {
            return Ok(());
        }
        let waiter = SocketWaiter {
            shared: shared.clone(),
            deadline,
        };
        match waiter.await {
            Ok(()) => return Ok(()),
            Err(StreamError::Failed(msg)) if msg.contains("OPEN") => {
                // keep waiting; the waker-based loop continues
                continue;
            }
            Err(e) => return Err(e),
        }
    }
}

struct SocketWaiter {
    shared: Shared,
    deadline: f64,
}

impl Future for SocketWaiter {
    type Output = Result<(), StreamError>;
    fn poll(self: Pin<&mut Self>, ctx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut st = self.shared.lock().unwrap();
        if st.sock_open {
            return Poll::Ready(Ok(()));
        }
        if now_ms() >= self.deadline {
            return Poll::Ready(Err(StreamError::Failed(
                "bridge websocket never reached OPEN".to_string(),
            )));
        }
        st.waiter = Some(ctx.waker().clone());
        Poll::Pending
    }
}

impl PartialEq for WaitKind {
    fn eq(&self, other: &Self) -> bool {
        matches!(
            (self, other),
            (WaitKind::Open, WaitKind::Open) | (WaitKind::Data, WaitKind::Data)
        )
    }
}


#[derive(Clone, Copy)]
enum WaitKind {
    /// Waiting on the dial handshake.
    Open,
    /// Waiting on stream data / EOF / failure (open phase assumed).
    Data,
}

struct Waiter {
    shared: Shared,
    kind: WaitKind,
    timeout_ms: u64,
    deadline: f64,
}

impl Future for Waiter {
    type Output = Result<(), StreamError>;

    fn poll(self: Pin<&mut Self>, ctx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut st = self.shared.lock().unwrap();
        // Deadline check runs first so already-expired waiters fail fast.
        if now_ms() >= self.deadline {
            return Poll::Ready(Err(StreamError::Timeout {
                ms: self.timeout_ms,
            }));
        }
        match (&st.phase, self.kind) {
            (Phase::Open, WaitKind::Open) | (Phase::Eof, WaitKind::Open) => {
                Poll::Ready(Ok(()))
            }
            (Phase::Failed(e), _) => {
                let e = e.clone();
                Poll::Ready(Err(StreamError::Failed(e)))
            }
            (Phase::Open, WaitKind::Data) if !st.queue.is_empty() => Poll::Ready(Ok(())),
            (Phase::Eof, WaitKind::Data) => Poll::Ready(Ok(())),
            (Phase::WaitingOpen, WaitKind::Open) | (Phase::Open, WaitKind::Data) => {
                st.waiter = Some(ctx.waker().clone());
                Poll::Pending
            }
            (Phase::WaitingOpen, WaitKind::Data) => {
                let e = "stream not dialed".to_string();
                Poll::Ready(Err(StreamError::Failed(e)))
            }
        }
    }
}

