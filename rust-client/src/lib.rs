use wasm_bindgen::prelude::*;

pub mod api;
pub mod config;
pub mod engine_err;
pub mod ftp;
pub mod ssh;
pub mod sys;
pub mod tls;
pub mod transport;

#[wasm_bindgen]
pub fn set_bridge_url(url: String) {
    config::set_bridge_url(url);
}
