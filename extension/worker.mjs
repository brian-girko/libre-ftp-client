'use strict';

// worker.mjs — service worker: click-to-open plus the bridge lifecycle.
//
// The client tab cannot reach com.add0n.node itself (native messaging is
// service-worker-only), so it asks for the ws-to-tls bridge over
// chrome.runtime messaging: {cmd:'ftp-bridge'} -> {ok, url} with the
// ws://127.0.0.1:port/token endpoint for FtpApi.create(). The bridge is a
// singleton: it boots once per worker life and detaches the native port only
// when it dies, so the next request resurrects it. An open native-messaging
// port keeps this worker alive, so the sandbox keeps running while the
// client tab holds its session.

import {startWsTlsBridge} from './core/native/ws-bridge-client.mjs';

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({
    url: chrome.runtime.getURL('data/client/index.html')
  });
});

let bridge = null; // {url, detach, alive} once booted

// Boot (or return) the embedded bridge. onEvent clears the singleton when
// the sandbox stops, so the next ask starts a fresh one.
async function ensureBridge() {
  if (bridge && bridge.alive) {
    return bridge.url;
  }
  const handle = await startWsTlsBridge((e) => {
    if (e.kind === 'down') {
      bridge = null;
    }
  });
  bridge = {...handle, alive: true};
  return bridge.url;
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if ((msg || {}).cmd !== 'ftp-bridge') {
    return;
  }
  ensureBridge()
    .then((url) => respond({ok: true, url}))
    .catch((e) => {
      bridge = null;
      respond({ok: false, error: e.message || String(e)});
    });
  return true; // async response
});
