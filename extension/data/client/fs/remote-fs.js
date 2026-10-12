// remote-fs.js — filesystem adapter backed by the wasm FTP engine.
//
// Built around a logged-in Client from core/ftp/api.js (FtpApi.connect);
// every call takes plain "a/b/file.txt" paths relative to the login dir
// ("" = the root) which are resolved to FTP absolute paths internally.
// The API mirrors local-fs.js so dir-view can attach either adapter
// interchangeably; editor-view additionally uses the tiny stat() probe
// (when present) for its size pre-check so remote files are not downloaded
// just to be rejected by the size gate.
//
// List entries additionally carry permissions ("drwxr-xr-x" style mode
// string, unix or MLSD listings only), owner/group (MLSD unix.* facts, or
// excavated from the raw unix LIST line when the engine did not parse
// them) — all optional; the 'names' listing kind yields none of them.

export class RemoteFS {
  // client: an api.js Client (connected + logged in); label: user-facing
  // root name, eg. "user@127.0.0.1:21"
  constructor(client, label) {
    this.client = client
    this.label0 = String(label || 'ftp')
    // set by init(): the login dir the relative paths hang off
    this.root = '/'
    // one-slot transfer cache: file(path) keeps the downloaded bytes so a
    // follow-up read(path) (the editor flow) does not re-download
    this.cache = null
  }

  // verify the session and learn the actual cwd; the engine starts the
  // session at the server's login dir, which becomes the pane's root
  async init() {
    this.root = await this.client.pwd()
    return this.root
  }

  // adapter kind; must match the dir-view pane's type attribute
  get type() {
    return 'remote'
  }

  // name of the root dir, used by dir-view as the pane title
  get label() {
    return this.label0
  }

  // "a/b" -> FTP absolute path under the login dir; "" -> the root itself
  abs(path) {
    const parts = String(path || '').split('/').filter(Boolean)
    if (!parts.length) {
      return this.root
    }
    return this.root === '/'
      ? '/' + parts.join('/')
      : this.root + '/' + parts.join('/')
  }

  // -> [{name, type: 'dir' | 'file', size, lastModified,
  //      permissions?, owner?, group?}], dirs first.
  // The engine reports entries as {name, dir, size?, mtime?, mode?}; size/
  // mtime/mode depend on which listing the server produced (mlsd beats unix
  // beats names), so they stay optional.
  async list(path = '') {
    const entries = await this.client.list(this.abs(path), 'auto')
    const items = entries.map((entry) => ({
      name: entry.name,
      type: entry.dir ? 'dir' : 'file',
      size: entry.size,
      lastModified: entry.mtime,
      permissions: entry.mode || null,
      ...this.ownerGroup(entry)
    }))
    return items.sort((a, b) => a.type === b.type
      ? a.name.localeCompare(b.name, undefined, {sensitivity: 'base'})
      : (a.type === 'dir' ? -1 : 1))
  }

  // best-effort owner/group excavation: direct owner/group fields when the
  // engine parsed them, MLSD unix.* facts next, then the classic unix LIST
  // shape ("mode nlink owner group size ...") from the raw line. Anything
  // not confidently parsed ends up null — the pane shows '-' for it.
  ownerGroup(entry) {
    if (typeof entry.owner === 'string' && entry.owner) {
      return {owner: entry.owner, group: entry.group || null}
    }
    const facts = entry.facts && typeof entry.facts === 'object' ? entry.facts : null
    if (facts) {
      const owner = facts['unix.owner'] || facts['owner']
      const group = facts['unix.group'] || facts['group']
      if (owner || group) {
        return {owner: owner || null, group: group || null}
      }
    }
    const raw = typeof entry.raw === 'string' ? entry.raw.trim() : ''
    if (entry.mode && raw) {
      const tok = raw.split(/\s+/)
      // tok[0] must be the mode (word-split modes do not round-trip)
      if (tok.length >= 4 && tok[0] === entry.mode) {
        const i = /^\d+$/.test(tok[1]) ? 2 : 1 // standard line starts with nlink
        return {owner: tok[i] || null, group: tok[i + 1] || null}
      }
    }
    return {owner: null, group: null}
  }

  single(path) {
    const parts = String(path || '').split('/').filter(Boolean)
    return parts[parts.length - 1] || 'file'
  }

  // the File for a path (downloaded into memory); used by dir-view to
  // download files and by editor-view's fallback size check
  async file(path) {
    if (this.cache && this.cache.path === path) {
      return this.cache.file
    }
    const bytes = await this.client.download(this.abs(path))
    const mtime = await this.client.mtime(this.abs(path))
    const file = new File([bytes], this.single(path),
      mtime ? {lastModified: mtime} : {})
    this.cache = {path, file}
    return file
  }

  // the file's text (UTF-8); served from the file() cache when fresh
  async read(path) {
    let bytes
    if (this.cache && this.cache.path === path) {
      bytes = await this.cache.file.arrayBuffer()
    }
    else {
      bytes = await this.client.download(this.abs(path))
    }
    return new TextDecoder().decode(bytes)
  }

  // edit an existing file (binary-safe upload; replaces the remote content)
  async write(path, text) {
    if (this.cache && this.cache.path === path) {
      this.cache = null
    }
    await this.client.upload(this.abs(path), text)
  }

  // single-file metadata for probes: {size?, lastModified?}; throws like
  // every other call when the path is missing
  async stat(path) {
    const meta = await this.client.statFile(this.abs(path))
    return {
      name: meta.name,
      size: meta.size,
      lastModified: meta.mtime
    }
  }

  // create an empty text file; refuses to clobber an existing one. The
  // probing stat needs MLST/SIZE/MDTM support — a server without any of
  // them treats clobber-protection as best effort (the create itself wins).
  async create(path) {
    let asserted = false
    try {
      await this.stat(path)
      asserted = true
    }
    catch {
      asserted = false // missing is the good case here
    }
    if (asserted) {
      throw new Error('file exists: ' + path)
    }
    await this.client.upload(this.abs(path), new TextEncoder().encode(''))
  }

  // delete a file; a dir needs an empty directory (mirror of local-fs,
  // which removeEntry()s a dir only when it is empty)
  async remove(path) {
    if (this.cache && this.cache.path === path) {
      this.cache = null
    }
    await this.client.delete(this.abs(path))
  }

  // create a dir; a server-side "already exists" error surfaces as-is
  async mkdir(path) {
    await this.client.mkdir(this.abs(path))
  }

  // mkdirp over the wire: every level gets one MKD; "already exists"
  // replies are swallowed (the next level rides on the existing dir).
  // decide "already exists" with a real listing of the parent dir, since
  // stat()/exists() may find nothing on servers without MLST/SIZE
  async ensureDir(path) {
    const parts = String(path || '').split('/').filter(Boolean)
    let walk = ''
    for (const [i, part] of parts.entries()) {
      walk = walk ? walk + '/' + part : part
      try {
        await this.client.mkdir(this.abs(walk))
      }
      catch (e) {
        const parent = parts.slice(0, i)
        let has = false
        try {
          has = (await this.client.list(this.abs(parent.join('/')), 'auto'))
            .some((entry) => entry.name === part && entry.dir)
        }
        catch {} // an unlistable parent makes the swallow unverifiable
        if (!has) {
          throw e
        }
      }
    }
  }

  // delete a file; a dir needs an empty directory — {recursive: true}
  // walks the tree depth-first (files first, dirs bottom-up like the
  // engine's rmdir requirement) instead
  async remove(path, {recursive = false} = {}) {
    if (this.cache && this.cache.path === path) {
      this.cache = null
    }
    if (!recursive) {
      await this.client.delete(this.abs(path))
      return
    }
    await this.rrm(this.abs(path), path, 0)
  }

  // depth-first tree eater for remove({recursive}): clears every child
  // (files via delete, subdirs via this same walk) then rmdirs the now
  // empty dir itself
  async rrm(absPath, rel, depth) {
    if (depth > 20) {
      throw new Error('directory tree too deep: ' + (rel || absPath))
    }
    let entries
    try {
      entries = await this.client.list(absPath, 'auto')
    }
    catch {
      // unlistable (or already gone): the plain delete is all that remains
      await this.client.delete(absPath)
      return
    }
    for (const entry of entries) {
      const childAbs = absPath.replace(/\/+$/, '') + '/' + entry.name
      if (entry.dir) {
        await this.rrm(childAbs, rel + '/' + entry.name, depth + 1)
      }
      else {
        await this.client.delete(childAbs)
      }
    }
    await this.client.rmdir(absPath)
  }

  // bulk helpers beyond the local-fs surface (rename within the fs)
  async rename(from, to) {
    return this.client.rename(this.abs(from), this.abs(to))
  }

  // does the path exist? (best effort — the transfer flow's FileZilla-style
  // overwrite ask treats a probe failure as "absent" and just proceeds)
  async exists(path) {
    try {
      await this.stat(path)
      return true
    }
    catch {
      return false
    }
  }

  // streaming downloads for the transfer queue: open a chunked RETR handle
  // (api.js openDownload) and loop pull() until null. the chunks come off
  // the engine's streaming buffers, so no point of the transfer holds the
  // whole file in memory
  async openDownload(path, offset = 0) {
    return this.client.openDownload(this.abs(path), offset)
  }

  // streaming uploads for the transfer queue: open a chunked STOR/APPE
  // handle; push() pieces then finish() consumes the final server reply
  async openUpload(path, {append = false, offset = 0} = {}) {
    return this.client.openUpload(this.abs(path), {append, offset})
  }

  // SITE CHMOD on a file/dir; mode is an octal string such as "644".
  // server-dependent: many quit in with a 500 "unknown SITE command".
  async chmod(path, mode) {
    await this.client.chmod(this.abs(path), String(mode).trim())
  }

  // QUIT the control connection; the pane should detach() afterwards
  async close() {
    if (this.cache) {
      this.cache = null
    }
    await this.client.quit()
  }
}
