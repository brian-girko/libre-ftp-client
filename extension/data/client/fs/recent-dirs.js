// recent-dirs.js — remembers previously picked local dirs in indexeddb.
//
// FileSystemDirectoryHandle is structured-cloneable, so the handles survive
// a reload in indexeddb. Permission does not survive the session though:
// on the next start the stored handle must be re-verified via
// queryPermission/requestPermission — LocalFS.init() does that.

const DB_NAME = 'libre-ftp'
const STORE = 'recent-dirs'
const MAX = 10 // keep the most recently used dirs only

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, {keyPath: 'id', autoIncrement: true})
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// run(store) must issue exactly one request; resolves with its result
function request(db, mode, run) {
  return new Promise((resolve, reject) => {
    let out
    const tx = db.transaction(STORE, mode)
    try {
      out = run(tx.objectStore(STORE))
    }
    catch (e) {
      reject(e)
      return
    }
    tx.oncomplete = () => resolve(out.result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'))
  })
}

// -> stored dirs, most recently used first
export async function getRecentDirs() {
  const db = await openDb()
  try {
    const entries = await request(db, 'readonly', (store) => store.getAll())
    return entries.sort((a, b) => b.used - a.used)
  }
  finally {
    db.close()
  }
}

// store a freshly picked root; picking the same dir again (isSameEntry)
// only bumps its timestamp instead of duplicating the entry
export async function rememberDir(handle) {
  const db = await openDb()
  try {
    const entries = await request(db, 'readonly', (store) => store.getAll())
    for (const entry of entries) {
      let same = false
      try {
        same = await handle.isSameEntry(entry.handle)
      }
      catch {} // corrupt/stale stored handle: treat as a different dir
      if (same) {
        entry.used = Date.now()
        await request(db, 'readwrite', (store) => store.put(entry))
        return entry.id
      }
    }
    const id = await request(db, 'readwrite', (store) => store.add({
      handle,
      name: handle.name,
      used: Date.now()
    }))
    // cap the list: evict the oldest entries beyond MAX
    const stale = entries
      .concat([{id, used: Date.now()}])
      .sort((a, b) => b.used - a.used)
      .slice(MAX)
    for (const entry of stale) {
      await request(db, 'readwrite', (store) => store.delete(entry.id))
    }
    return id
  }
  finally {
    db.close()
  }
}

// bump the timestamp after a successful open (recents list ordering)
export async function touchDir(id) {
  const db = await openDb()
  try {
    const entry = await request(db, 'readonly', (store) => store.get(id))
    if (entry) {
      entry.used = Date.now()
      await request(db, 'readwrite', (store) => store.put(entry))
    }
  }
  finally {
    db.close()
  }
}

// drop one entry (used by a future remove affordance in the ui)
export async function forgetDir(id) {
  const db = await openDb()
  try {
    await request(db, 'readwrite', (store) => store.delete(id))
  }
  finally {
    db.close()
  }
}
