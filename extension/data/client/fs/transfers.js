// transfers.js — the file-transfer queue behind the transfer-view panel.
//
// Every upload/download funnels through one place so large files move as
// true byte streams: the remote side is the wasm engine's streaming API
// (streamPush / streamPull in 128-256 KiB pieces; RemoteFS.openUpload /
// openDownload wrap it) and the local side is a File System Access
// writable (swap mode — the real file appears at close(), so failed or
// cancelled runs leave an existing target untouched). HTML on either end
// never holds the whole file in memory.
//
// The queue runs one transfer at a time, because the engine borrows
// FtpClient mutably per call (see api.js statFile's note on aliasing) —
// concurrent streams on one session would interleave the wasm bindings.
// Each Transfer carries live progress and a cancel(); cancelled and
// failed runs land in the "Failed transfers" tab like FileZilla, finished
// ones under "Successful transfers".
//
// callers:
//   const t = queueUpload({name, size?, localFs, localPath, remoteFs,
//                          remotePath, from?, to?, onDone?})
//   const t = queueDownload({name, size?, remoteFs, remotePath,
//                            sinkFor, from?, to?, onDone?})
//   onTransfer((item, kind) => ...)  // kind: 'add' | 'progress' | 'state'
//
// paths are pane-relative ("a/b.txt"); the fs adapters resolve them
// internally, the from/to strings are display-only (tooltip material).

'use strict';

let seq = 0

export class Transfer {
  constructor(spec) {
    this.id = ++seq
    this.name = String(spec.name)
    this.kind = spec.kind // 'upload' | 'download'
    // byte size when known (upload: the File, download: the listing fact
    // or a lazy SIZE probe); an unknown size means no percent readout
    this.size = spec.size === undefined || spec.size === null
      ? undefined : Number(spec.size) || 0
    this.from = spec.from || ''
    this.to = spec.to || ''
    // success hook (target pane refresh); failures must not surface here
    this.onDone = typeof spec.onDone === 'function' ? spec.onDone : null
    // settled hook (success OR failure); batches need it so a failed
    // member cannot hold off the "everything is done" bookkeeping forever
    this.onSettled = typeof spec.onSettled === 'function' ? spec.onSettled : null
    this.state = 'queued' // queued -> running -> done | failed
    this.transferred = 0
    this.error = null
    // runner internals, set by the queue* helpers before start
    this._run = spec._run || (async () => {})
    this._cancel = null // registered while the streams are alive
    this.cancelRequested = false
  }

  // cancel from the UI: a queued item fails right away ("cancelled" shows
  // in the Failed tab, exactly where FileZilla parks aborted transfers);
  // a running one asks the runner to tear both streams down, which makes
  // the pending stream call reject and the pump record it as failed
  cancel() {
    if (this.state !== 'queued' && this.state !== 'running') {
      return
    }
    if (this.state === 'running') {
      this.cancelRequested = true
      try {
        if (this._cancel) {
          this._cancel()
        }
      }
      catch {} // the pump still records the failure via the caught stream
      return
    }
    this.state = 'failed'
    this.error = 'cancelled'
    emit(this, 'state')
  }
}

// live transfer records in arrival order (also read by transfer-view for
// the tab counts; this module is the only writer)
export const transfers = {
  items: []
}

const listeners = new Set()

export function onTransfer(fn) {
  listeners.add(fn)
}

function emit(item, kind) {
  for (const fn of [...listeners]) {
    try {
      fn(item, kind)
    }
    catch {} // a broken row must not stall the queue
  }
}

function enqueue(t) {
  transfers.items.push(t)
  emit(t, 'add')
  pump()
  return t
}

// serialized runner: one transfer at a time, successors picked as the
// active one settles (done | failed)
let active = null

function pump() {
  if (active) {
    return
  }
  const next = transfers.items.find((t) => t.state === 'queued')
  if (!next) {
    return
  }
  active = next
  start(next)
}

async function start(t) {
  t.state = 'running'
  emit(t, 'state')
  try {
    await t._run()
    t.state = 'done'
    t.transferred = t.size !== undefined ? t.size : t.transferred
    if (t.onDone) {
      try {
        t.onDone()
      }
      catch {} // a stale target pane must not fail a finished transfer
    }
  }
  catch (e) {
    t.state = 'failed'
    // a cancelled run's stream errors read as "user cancelled", not as
    // whatever the engine shouted while being torn down
    t.error = t.cancelRequested ? 'cancelled' : (e && e.message || String(e))
  }
  if (t.onSettled) {
    try {
      t.onSettled(t.state === 'done')
    }
    catch {} // the queue outcome itself is unaffected
  }
  active = null
  emit(t, 'state')
  pump()
}

// ---- upload: a local File streamed OUT to a remote path -----------------
// the source is the handle's Blob stream (read incrementally off disk),
// chunks go up through streamPush, and progress lands after every push
export function queueUpload(spec) {
  const t = new Transfer({...spec, kind: 'upload'})
  let stream = null
  let cancelled = false
  t._cancel = () => {
    cancelled = true
    if (stream) {
      stream.abort().catch(() => {})
    }
  }
  t._run = async () => {
    const file = await spec.localFs.file(spec.localPath)
    if (t.size === undefined) {
      t.size = file.size // the handle always knows its own size
    }
    const sink = await spec.remoteFs.openUpload(spec.remotePath)
    stream = sink
    if (cancelled) {
      throw new Error('cancelled')
    }
    const reader = file.stream().getReader()
    try {
      for (;;) {
        const {done, value} = await reader.read()
        if (done) {
          break
        }
        t.transferred = await sink.push(value) // running total from the engine
        if (cancelled) {
          throw new Error('cancelled')
        }
        emit(t, 'progress')
      }
      if (cancelled) {
        throw new Error('cancelled')
      }
      await sink.finish() // close the data channel, consume the final reply
    }
    catch (e) {
      try {
        await sink.abort()
      }
      catch {} // a failed upload must not mask the original error
      throw e
    }
  }
  return enqueue(t)
}

// ---- download: a remote path streamed into a writable -------------------
// sinkFor() hands back the FileSystemWritableFileStream (a local pane's
// destination or a save-picked file); size is filled in lazily so a
// missing listing fact still gives percentages, and the engine side is
// driven one 256 KiB pull per await to keep real backpressure
export function queueDownload(spec) {
  const t = new Transfer({...spec, kind: 'download'})
  let source = null
  let sink = null
  let cancelled = false
  t._cancel = () => {
    cancelled = true
    if (source) {
      source.abort().catch(() => {})
    }
    if (sink) {
      sink.abort().catch(() => {})
    }
  }
  t._run = async () => {
    if (t.size === undefined) {
      try {
        const meta = await spec.remoteFs.stat(spec.remotePath)
        if (meta && meta.size !== undefined) {
          t.size = meta.size
          emit(t, 'progress')
        }
      }
      catch {} // unknown size just means no percent readout
    }
    sink = await spec.sinkFor()
    if (cancelled) {
      throw new Error('cancelled')
    }
    source = await spec.remoteFs.openDownload(spec.remotePath)
    try {
      for (;;) {
        const chunk = await source.pull() // up to 256 KiB from the engine
        if (chunk === null) {
          break
        }
        await sink.write(chunk) // one at a time = free backpressure
        t.transferred = source.total
        if (cancelled) {
          throw new Error('cancelled')
        }
        emit(t, 'progress')
      }
      if (cancelled) {
        throw new Error('cancelled')
      }
      await sink.close() // swap mode: only now does the target file exist
    }
    catch (e) {
      try {
        await source.abort()
      }
      catch {}
      try {
        await sink.abort()
      }
      catch {}
      throw e
    }
  }
  return enqueue(t)
}

// byte counter for the queue panel ("1.2 MB / 45.6 MB" style, 1024 base)
export function fmtBytes(n) {
  if (n === undefined || n === null) {
    return '?'
  }
  if (n < 1024) {
    return n + ' B'
  }
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return (v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ' + units[u]
}
