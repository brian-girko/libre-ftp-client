// Engine-level configuration: the ws-to-tls bridge URL the JS host supplies
// before dialing (host paths / tokens must already be embedded in the URL).

use std::sync::RwLock;

static BRIDGE_URL: RwLock<Option<String>> = RwLock::new(None);

pub fn set_bridge_url(url: String) {
    *BRIDGE_URL.write().unwrap() = Some(url);
}

pub(crate) fn bridge_url() -> &'static str {
    // NOTE: returns a leaked static so callers can hold it across awaits.
    let guard = BRIDGE_URL.read().unwrap();
    match &*guard {
        Some(url) => Box::leak(url.clone().into_boxed_str()),
        None => "",
    }
}
