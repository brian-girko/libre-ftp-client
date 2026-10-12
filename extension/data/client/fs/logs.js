// logs.js — tiny pub-sub for fs activity, kept DOM-free so the adapters
// (local-fs.js / remote-fs.js) and their wrapper (log-fs.js) can emit
// without importing any component; log-view.js subscribes on connect.

const listeners = new Set()

// one fs operation finished: {type, label, msg, error, time}
export function fsLog(type, label, msg, error = false) {
  const event = {type, label, msg, error, time: new Date()}
  for (const fn of listeners) {
    try {
      fn(event)
    }
    catch {} // a broken consumer must not kill the fs call
  }
}

export function onFSLog(fn) {
  listeners.add(fn)
}

export function offFSLog(fn) {
  listeners.delete(fn)
}
