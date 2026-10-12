// log-fs.js — wraps an fs adapter (LocalFS or RemoteFS) so every call
// logs one line to log-view.js: "VERB path ✓ (12 ms)" or with the error
// message on failure. The adapter object is mutated in place (the wrapped
// methods are own properties shadowing the prototype ones) and returned —
// identity stays intact, so dir-view's `this.fs === fs` checks keep
// working and non-logged surface (type, label getters) is untouched.

import {fsLog} from './logs.js'

// name -> log verb
const VERB = {
  init: 'INIT',
  list: 'LIST',
  file: 'FILE',
  read: 'READ',
  write: 'WRITE',
  create: 'CREATE',
  remove: 'DELETE',
  mkdir: 'MKDIR',
  rename: 'RENAME',
  chmod: 'CHMOD',
  stat: 'STAT',
  close: 'QUIT'
}
// exists is deliberately unwrapped: it is the transfer flow's internal
// collision probe, where "not there" is the good answer — a probe miss
// would flood the log with misleading FAILED lines (one per leaf).
// streaming transfer handles (sink/openDownload/openUpload) are called
// once per transfer and run to the end of it, so wrapping them would print
// one misleading multi-second line — they stay out of the log surface.

// short result summary appended on success when present
function summarize(result) {
  if (Array.isArray(result)) {
    return `${result.length} entries`
  }
  if (result instanceof File) {
    return `${result.size} B`
  }
  return ''
}

// the log line for one call: verb + paths (+ result summary / error)
function line(name, args, result, error) {
  const on = (s) => s === undefined ? '' : String(s)
  let text = VERB[name] || name
  if (name === 'rename') {
    text += ' ' + on(args[0]) + ' -> ' + on(args[1])
  }
  else if (args.length > 0) {
    text += ' ' + on(args[0])
  }
  if (error) {
    text += ' FAILED: ' + result.message
  }
  else {
    const info = summarize(result)
    if (info) {
      text += ' (' + info + ')'
    }
  }
  return text
}

async function run(fs, name, fn, args) {
  const t0 = performance.now()
  try {
    const result = await fn(...args)
    fsLog(fs.type, fs.label,
      line(name, args, result, false) + ' ✓ ' +
      Math.round(performance.now() - t0) + ' ms')
    return result
  }
  catch (e) {
    fsLog(fs.type, fs.label, line(name, args, e, true) +
      ' (' + Math.round(performance.now() - t0) + ' ms)', true)
    throw e
  }
}

export function loggedFS(fs) {
  for (const name of Object.keys(VERB)) {
    const fn = fs[name]
    if (typeof fn === 'function') {
      fs[name] = (...args) => run(fs, name, fn.bind(fs), args)
    }
  }
  return fs
}
