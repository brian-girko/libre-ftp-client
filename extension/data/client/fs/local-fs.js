// local-fs.js — filesystem adapter backed by the File System Access API.
//
// init() opens showDirectoryPicker() (unless a root handle was preset, eg.
// one restored from recent-dirs.js), verifies read/write permission and the
// picked handle becomes the root and default listing target. Every other
// call takes plain "a/b/file.txt" paths relative to that root ("" = the
// root itself). The API mirrors remote-fs.js so dir-view can attach either
// adapter interchangeably.
//
// List entries carry {name, type, size?, lastModified?} — size/lastModified
// for files only (dirs have none of them through this API), and NEVER
// permissions or owner/group: the File System Access API does not expose
// posix metadata, so the dir-view columns stay empty in local panes.

export class LocalFS {
  // root may be preset (eg. a stored handle from recent-dirs.js); init()
  // then skips the picker
  constructor(root = null) {
    this.root = root
  }

  // opens the directory picker when no root was preset (requires a user
  // gesture, eg. a click), then verifies read/write access. rejects with
  // an AbortError when the user cancels the picker.
  async init() {
    if (!this.root) {
      this.root = await showDirectoryPicker({mode: 'readwrite'})
    }
    await this.verify()
    return this.root
  }

  // verify read+write permission. a handle restored from indexeddb usually
  // comes back as 'prompt' on a new session and needs one requestPermission
  // (the click that led here provides the required user gesture).
  async verify() {
    const opts = {mode: 'readwrite'}
    let state = await this.root.queryPermission(opts)
    if (state === 'prompt') {
      state = await this.root.requestPermission(opts)
    }
    if (state !== 'granted') {
      throw new Error('no read/write permission for ' + this.root.name)
    }
  }

  // adapter kind; must match the dir-view pane's type attribute
  get type() {
    return 'local'
  }

  // name of the root dir, used by dir-view as the pane title
  get label() {
    return this.root ? this.root.name : ''
  }

  // "a/b" -> ["a", "b"], "" -> []
  static parts(path) {
    return String(path || '').split('/').filter(Boolean)
  }

  // walk the path segments from the root and return the deepest dir
  async dir(path) {
    if (!this.root) {
      throw new Error('not initialized')
    }
    let dir = this.root
    for (const part of LocalFS.parts(path)) {
      dir = await dir.getDirectoryHandle(part)
    }
    return dir
  }

  // -> [{name, type: 'dir' | 'file', size?, lastModified?}], dirs first;
  // file metadata comes from the handle's File (dirs have no metadata here)
  async list(path = '') {
    const dir = await this.dir(path)
    const items = []
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file') {
        const file = await handle.getFile()
        items.push({
          name,
          type: 'file',
          size: file.size,
          lastModified: file.lastModified
        })
      }
      else {
        items.push({name, type: 'dir'})
      }
    }
    return items.sort((a, b) => a.type === b.type
      ? a.name.localeCompare(b.name, undefined, {sensitivity: 'base'})
      : (a.type === 'dir' ? -1 : 1))
  }

  // the File for a path; used by dir-view to download files
  async file(path) {
    const parts = LocalFS.parts(path)
    const dir = await this.dir(parts.slice(0, -1).join('/'))
    const handle = await dir.getFileHandle(parts[parts.length - 1])
    return handle.getFile()
  }

  async read(path) {
    return (await this.file(path)).text()
  }

  // edit an existing file (the handle is created implicitly when absent)
  async write(path, text) {
    const parts = LocalFS.parts(path)
    const dir = await this.dir(parts.slice(0, -1).join('/'))
    const handle = await dir.getFileHandle(parts[parts.length - 1], {create: true})
    const writable = await handle.createWritable()
    await writable.write(text)
    await writable.close()
  }

  // create an empty file; refuses to clobber an existing one
  async create(path) {
    const parts = LocalFS.parts(path)
    const dir = await this.dir(parts.slice(0, -1).join('/'))
    const name = parts[parts.length - 1]
    try {
      await dir.getFileHandle(name)
    }
    catch (e) {
      if (e.name === 'NotFoundError') {
        await dir.getFileHandle(name, {create: true})
        return
      }
      throw e
    }
    throw new Error('file exists: ' + path)
  }

  // delete a file (or a dir: plain removeEntry expects it empty,
  // {recursive: true} takes the whole tree); a missing entry throws
  // NotFoundError
  async remove(path, {recursive = false} = {}) {
    const parts = LocalFS.parts(path)
    const dir = await this.dir(parts.slice(0, -1).join('/'))
    await dir.removeEntry(parts[parts.length - 1], {recursive})
  }

  // mkdirp: create the dir, silently keep an existing one (mkdir() itself
  // refuses to clobber; the transfer flow's dir skeleton wants tolerate)
  async ensureDir(path) {
    if (!this.root) {
      throw new Error('not initialized')
    }
    let dir = this.root
    for (const part of LocalFS.parts(path)) {
      dir = await dir.getDirectoryHandle(part, {create: true})
    }
  }

  // create a dir; refuses to clobber an existing one
  async mkdir(path) {
    const parts = LocalFS.parts(path)
    const dir = await this.dir(parts.slice(0, -1).join('/'))
    const name = parts[parts.length - 1]
    try {
      await dir.getDirectoryHandle(name)
    }
    catch (e) {
      if (e.name === 'NotFoundError') {
        await dir.getDirectoryHandle(name, {create: true})
        return
      }
      throw e
    }
    throw new Error('dir exists: ' + path)
  }

  // change posix permissions — happens to be unsupported: the File System
  // Access API exposes no chmod, so dir-view keeps this button remote-only
  async chmod() {
    throw new Error('permissions are not supported for local files')
  }

  // open a streaming writable at path (the handle is created implicitly).
  // the transfer queue pumps remote chunks straight into it: writes land
  // in a swap file and the real file materializes only on close(), so a
  // failed or cancelled transfer leaves any existing file untouched
  async sink(path) {
    const parts = LocalFS.parts(path)
    const dir = await this.dir(parts.slice(0, -1).join('/'))
    const handle = await dir.getFileHandle(parts[parts.length - 1], {create: true})
    return handle.createWritable()
  }

  // does an entry exist at path? (the transfer flow's overwrite ask; best
  // effort and never noisy about it: everything unreadable — a file miss,
  // a missing parent dir — comes back as false and the transfer proceeds
  // on its own; a name that exists as a *dir* rethrows so the transfer
  // reports it)
  async exists(path) {
    const parts = LocalFS.parts(path)
    try {
      const dir = await this.dir(parts.slice(0, -1).join('/'))
      await dir.getFileHandle(parts[parts.length - 1])
      return true
    }
    catch (e) {
      if (e.name === 'NotFoundError') {
        return false
      }
      throw e
    }
  }

  // rename a file within its dir, incl. extension changes; refuses to
  // clobber an existing target and rejects subdirs-only names. Uses the
  // File System Access move() call, which may not be implemented in some
  // browsers — falls back to read + rewrite + remove on the same fs.
  async rename(path, newName) {
    const parts = LocalFS.parts(path)
    const name = parts[parts.length - 1]
    newName = String(newName)
    if (!newName) {
      throw new Error('empty name')
    }
    if (newName.includes('/')) {
      throw new Error('rename target must stay inside the dir')
    }
    if (newName === name) {
      throw new Error('same name: ' + newName)
    }
    const dir = await this.dir(parts.slice(0, -1).join('/'))
    // target pre-check, mirroring create(): a broken move() that starts
    // writing would otherwise clobber the target before failing
    try {
      await dir.getFileHandle(newName)
      throw new Error('file exists: ' + newName)
    }
    catch (e) {
      if (e.name !== 'NotFoundError') {
        throw e
      }
    }
    const handle = await dir.getFileHandle(name)
    if (handle.move) {
      await handle.move(newName)
      return
    }
    // fallback: copy the bytes under the new name, then drop the old one
    const file = await handle.getFile()
    const writable = await dir.getFileHandle(newName, {create: true})
      .then((target) => target.createWritable())
    try {
      await writable.write(file)
      await writable.close()
    }
    catch (e) {
      try {
        await writable.abort()
      }
      catch {} // the failed write must not mask the original error
      throw e
    }
    try {
      await dir.removeEntry(name)
    }
    catch (e) {
      throw new Error('copied to ' + newName +
        ' but could not remove the old file: ' + e.message)
    }
  }
}
