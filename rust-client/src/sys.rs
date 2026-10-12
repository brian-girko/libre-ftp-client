// Small JS bridge conveniences shared by the transport and TLS layers.

use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

/// Copy a JS `ArrayBuffer` / `Uint8Array` / typed array into a `Vec<u8>`.
pub(crate) fn to_byte_vec(value: &JsValue) -> Vec<u8> {
    if let Some(ab) = value.dyn_ref::<js_sys::ArrayBuffer>() {
        let view = js_sys::Uint8Array::new(ab);
        return view.to_vec();
    }
    if let Some(u8a) = value.dyn_ref::<js_sys::Uint8Array>() {
        return u8a.to_vec();
    }
    if let Some(view) = value.dyn_ref::<js_sys::DataView>() {
        let u8a = js_sys::Uint8Array::new(&view.buffer());
        return u8a.to_vec();
    }
    Vec::new()
}

