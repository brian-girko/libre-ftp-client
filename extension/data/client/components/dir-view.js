// dir-view.js — one directory pane.
//
// Each pane has a type ("local" or "remote", set via the type attribute in
// index.html and read by the type getter); only the matching connect button
// is offered and only a matching adapter can be attached:
//   dirView.attach(new LocalFS())     // waits for init(), lists the root
// The detached start view shows the connect button centered plus (local
// pane) the previously picked dirs from recent-dirs.js; picking one of
// those restores the stored handle and lets LocalFS.init() re-verify the
// read/write permission. The toolbar's Download button streams the
// selected remote file straight to disk (remote panes only), and the
// Copy-to-Other-Pane toolbar hands the selection to the transfer queue
// (fs/transfers.js) as a streaming upload or download — selected dirs
// expand recursively so a whole tree moves. Any row selects with a plain
// click (dirs included); ctrl/cmd-click adds rows to a multi-selection,
// shift-click covers a range, and a dir opens on the double click while
// plain-click only selects it. Copy and Delete run the whole set while
// the per-file tools (edit/rename/download) keep exactly one selected
// file; Perm is fine on a single dir too.
//
// Every rendered state change also fires a bubbled "pathchange" event
// (cwd + fs label) so a sibling path-view can keep its crumbs in sync.
// editSelected() opens the selected file in the editor-view dialog
// (lazily imported, keeping the CodeMirror bundle out of the initial
// page load); the editor itself reports back via refresh().

import {iconPath, parentIconPath} from '../fs/icons.js'
import {getRecentDirs, rememberDir, touchDir} from '../fs/recent-dirs.js'
import {getHostkeys, addHostkey} from '../../../core/accounts/storage.mjs'

// built-in per-pane defaults, used before (or instead of) user.view when
// the settings module/store cannot be reached; mirrors storage.mjs
const VIEW_FALLBACK = {
  local: {columns: {size: true, type: false, lastModified: true}},
  remote: {columns: {
    size: true, permissions: false, type: false,
    lastModified: true, ownerGroup: false
  }}
}

class DirView extends HTMLElement {
  get type() {
    return this.getAttribute('type') || 'local'
  }

  connectedCallback() {
    this.cwd = '' // path relative to the fs root; "" is the root
    this.fs = null
    this.loadSeq = 0 // bumped per navigation; stale listings are dropped
    this.selected = null // primary selection (the last clicked file row)
    this.selectedSet = new Set() // full multi-selection (file names)
    this.anchor = null // shift-range start: the last non-modifier row
    this.entryMap = new Map() // name -> last listing entry (chmod prefill)
    // start from this pane's built-in defaults; loadView() overrides
    this.view = VIEW_FALLBACK[this.type]
    this.loadView() // template rebuilt inside loadView() once settings land
    // live column switch: the options page checkbox re-renders both panes
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes['user.view']) {
        this.loadView().then(() => {
          if (this.fs) {
            this.loadSeq++ // refresh counts as a new listing generation
            this.load().catch(() => {}) // redraw with the new columns
          }
        })
      }
    })
    this.render()
    // local panes accept dropped directories as an alternate to the Open
    // Directory button: the drop hands back a FileSystemDirectoryHandle
    // (getAsFileSystemHandle must be called inside the drop task, before
    // any await, while the drag still owns its data) and it flows through
    // the same LocalFS().attach() path as every other open — permission
    // verification included
    if (this.type === 'local') {
      this.addEventListener('dragover', (e) => {
        e.preventDefault()
        this.classList.add('dv-drop')
      })
      this.addEventListener('dragleave', () => {
        this.classList.remove('dv-drop')
      })
      this.addEventListener('drop', (e) => {
        e.preventDefault()
        this.classList.remove('dv-drop')
        this.openDropped(e)
      })
    }
  }

  // load the column switches for this pane's type (user.view, defaults
  // filled in when the settings module/store cannot be reached) and
  // rebuild the grid template
  async loadView() {
    try {
      const mod = await import('../../../core/accounts/storage.mjs')
      this.view = await mod.getView(this.type)
    }
    catch {
      // keep this pane's built-in defaults (module/store unreachable)
      this.view = VIEW_FALLBACK[this.type]
    }
    this.applyColumns()
  }

  // build the pane-level grid template from the enabled columns: Filename
  // is the only 1fr column, every other column carries a min-width and may
  // grow with its content. disabled columns drop their track entirely (no
  // dead gap). shared by the rows through subgrid, so header and listing
  // stay perfectly aligned.
  applyColumns() {
    const c = this.view.columns
    this.style.gridTemplateColumns = [
      '16px', // icon track: fixed, shared by rows AND the header slot
      'minmax(0,1fr)', // Filename: flexes, shrinks under pressure
      c.size ? 'minmax(9ch,auto)' : null, // Filesize
      c.type ? 'minmax(9ch,auto)' : null, // Filetype
      c.lastModified ? 'minmax(17ch,auto)' : null, // Last Modified
      c.permissions ? 'minmax(11ch,auto)' : null, // Permissions
      c.ownerGroup ? 'minmax(15ch,auto)' : null // Owner/Group
    ].filter(Boolean).join(' ')
  }

  // wire up an fs adapter (LocalFS today, RemoteFS later) and list its root
  async attach(fs, startPath = '') {
    if (fs.type !== this.type) {
      this.showError('cannot attach a ' + (fs.type || 'unknown') +
        ' fs to a ' + this.type + ' pane')
      return
    }
    this.fs = fs
    this.cwd = ''
    await this.loadView() // fresh columns before the first listing
    this.connecting()
    try {
      await fs.init()
    }
    catch (e) {
      this.fs = null
      this.showError(e.name === 'AbortError' ? 'cancelled' : e.message)
      return
    }
    await this.goto(startPath)
  }

  detach() {
    this.fs = null
    this.cwd = ''
    this.render()
  }

  // detail payload for path-change notifications
  pathDetail() {
    return {path: this.cwd, label: this.fs ? this.fs.label : ''}
  }

  // publish cwd + root label; path-view listens to keep its crumbs in sync.
  // every content change goes through one of connecting/showError/render/
  // load, each of which emits once, so the bar can never go stale
  emitPath() {
    this.dispatchEvent(new CustomEvent('pathchange', {
      bubbles: true,
      detail: this.pathDetail()
    }))
  }

  // publish the selection; toolbar-view enables Copy/Delete on the whole
  // set (count) and the per-file tools on the primary (name, isDir gates
  // the file-only ones)
  emitSelection() {
    const entry = this.entryMap.get(this.selected)
    this.dispatchEvent(new CustomEvent('selectionchange', {
      bubbles: true,
      detail: {
        name: this.selected,
        count: this.selectedSet.size,
        isDir: !!entry && entry.type === 'dir'
      }
    }))
  }

  // toolbar Refresh: re-list the current directory in place
  refresh() {
    if (this.fs) {
      this.load()
    }
  }

  // drop the selection (if any) and tell the tools bar
  clearSelection() {
    if (this.selected || this.selectedSet.size || this.anchor) {
      this.selected = null
      this.selectedSet.clear()
      this.anchor = null
      this.emitSelection()
    }
  }

  // click on a file row: plain click selects just that one (clicking the
  // only selected one again clears everything), Ctrl/Cmd+click toggles the
  // row into the multi-selection, Shift+click covers the range from the
  // last non-modifier click. Copy/Delete act on the whole set; the
  // per-file tools stay on the primary (this.selected)
  toggleSelect(name, e = null) {
    if (e && e.shiftKey && this.anchor) {
      this.selectRange(name)
      return
    }
    if (e && (e.ctrlKey || e.metaKey)) {
      this.anchor = name
      if (this.selectedSet.has(name)) {
        this.selectedSet.delete(name)
        if (this.selected === name) {
          const rest = [...this.selectedSet]
          this.selected = rest.length ? rest[rest.length - 1] : null
        }
      }
      else {
        this.selectedSet.add(name)
        this.selected = name
      }
    }
    else {
      this.anchor = name
      const solo = this.selectedSet.size === 1 && this.selectedSet.has(name)
      this.selectedSet.clear()
      this.selected = solo ? null : name
      if (!solo) {
        this.selectedSet.add(name)
      }
    }
    this.paintSelection()
    this.emitSelection()
  }

  // Shift+click: select every row (files and dirs alike) between the
  // anchor and the clicked one (listing order), replacing whatever was
  // selected
  selectRange(toName) {
    const names = [...this.querySelectorAll('.dv-row[data-name]')]
      .map((row) => row.dataset.name)
    const a = names.indexOf(this.anchor)
    const b = names.indexOf(toName)
    if (a < 0 || b < 0) {
      return // the anchor died with a re-list: no sensible range left
    }
    const [from, to] = a <= b ? [a, b] : [b, a]
    this.selectedSet.clear()
    for (let i = from; i <= to; i++) {
      this.selectedSet.add(names[i])
    }
    if (!this.selectedSet.has(this.selected)) {
      this.selected = toName
    }
    this.paintSelection()
    this.emitSelection()
  }

  // highlight every selected row (the whole set, not just the primary)
  paintSelection() {
    for (const row of this.querySelectorAll('.dv-row')) {
      row.classList.toggle('dv-selected', this.selectedSet.has(row.dataset.name))
    }
  }

  // the target of actions that take exactly one entry of any kind (perm):
  // the primary name, refused while multiple rows are selected
  soloEntry() {
    if (!this.selected) {
      return null
    }
    if (this.selectedSet.size > 1) {
      this.notify('select exactly one entry for this action')
      return null
    }
    return this.selected
  }

  // the same, file-only (edit/rename/download): a single selected dir is
  // refused with its own note
  soloSelected() {
    const name = this.soloEntry()
    if (!name) {
      return null
    }
    const entry = this.entryMap.get(name)
    if (entry && entry.type === 'dir') {
      this.notify('select a file for this action')
      return null
    }
    return name
  }

  async goto(path) {
    const seq = ++this.loadSeq
    const prev = this.cwd
    this.cwd = path
    this.connecting()
    try {
      await this.load()
    }
    catch (e) {
      if (seq !== this.loadSeq) {
        return // a newer navigation owns the pane now
      }
      // back out to the last good dir so the pane never goes dead
      this.cwd = prev
      try {
        if (await this.load()) {
          this.notify(e.message)
        }
      }
      catch {
        this.showError(e.message)
      }
    }
  }

  connecting() {
    this.textContent = ''
    this.emitPath() // optimistic: crumbs show the pending path while loading
    this.clearSelection()
    const div = document.createElement('div')
    div.className = 'dv-message'
    div.textContent = 'connecting...'
    this.appendChild(div)
  }

  showError(message) {
    this.textContent = ''
    this.emitPath() // keep the bar on the rolled-back (last good) path
    this.clearSelection()
    const div = document.createElement('div')
    div.className = 'dv-message dv-error'
    div.textContent = message
    this.appendChild(div)
    // detached: let the user retry from the connect view
    if (!this.fs) {
      this.appendConnect()
    }
  }

  // error while staying connected: report it without tearing down the listing
  notify(message) {
    let div = this.querySelector('.dv-error')
    if (!div) {
      div = document.createElement('div')
      div.className = 'dv-message dv-error'
      this.insertBefore(div, this.querySelector('.dv-row'))
    }
    div.textContent = message
  }

  // FileZilla-style last modified stamp: YYYY-MM-DD HH:MM (local time),
  // empty when the fs supplied no mtime
  fmtTime(ms) {
    if (ms === undefined || ms === null) {
      return ''
    }
    const d = new Date(ms)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
      ` ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  // type label like "CSS" (uppercase extension); hidden files without a
  // dot show "FILE", dirs show "DIR" (local + remote are the same
  // name-based guess — there is no real MIME/nlink type column here)
  fmtType(entry, isDir) {
    if (isDir) {
      return 'DIR'
    }
    const name = entry.name || ''
    const dot = name.lastIndexOf('.')
    return dot > 0 ? name.slice(dot + 1).toUpperCase() : 'FILE'
  }

  // "user/group", '-' for unavailable parts (local panes show "—")
  fmtOwner(entry) {
    if (entry.owner === undefined && entry.group === undefined) {
      return null
    }
    return (entry.owner || '-') + '/' + (entry.group || '-')
  }

  // one listing row: icon + name (flexing) + the optional metadata columns
  // enabled in this.view.columns; entry null renders the bare row (the ".."
  // entry never carries metadata)
  entryRow(iconUrl, label, isDir, entry = null) {
    const row = document.createElement('div')
    row.className = 'dv-row'
    if (isDir) {
      row.classList.add('dv-dir')
    }
    else {
      row.classList.add('dv-file')
    }
    const icon = document.createElement('img')
    icon.className = 'dv-icon'
    icon.src = iconUrl
    icon.alt = ''
    const name = document.createElement('span')
    name.className = 'dv-name' + (isDir ? ' dv-dir-name' : '')
    name.textContent = label
    row.appendChild(icon)
    row.appendChild(name)
    if (entry) {
      const cols = this.view.columns
      const cell = (cls, text) => {
        const span = document.createElement('span')
        span.className = 'dv-cell ' + cls
        span.textContent = text
        row.appendChild(span)
      }
      if (cols.size) {
        // dirs have no size from either adapter, but the cell must still
        // occupy its subgrid track or every later column shifts left
        const size = isDir ? '' : entry.size === undefined ? '?' : entry.size
        cell('dv-size', size + (size === '' ? '' : 'B'))
      }
      if (cols.type) {
        cell('dv-type', this.fmtType(entry, isDir))
      }
      if (cols.lastModified) {
        cell('dv-time', this.fmtTime(entry.lastModified))
      }
      if (cols.permissions) {
        cell('dv-perm', entry.permissions || '-')
      }
      if (cols.ownerGroup) {
        cell('dv-owner', this.fmtOwner(entry) || '-')
      }
    }
    return row
  }

  // sticky listing header, spelt out to match entryRow()'s column order
  headRow() {
    const head = document.createElement('div')
    head.className = 'dv-head'
    const cell = (cls, label) => {
      const span = document.createElement('span')
      span.className = 'dv-cell ' + cls
      span.textContent = label
      head.appendChild(span)
    }
    // empty first cell: data rows put the 16px icon there, so the header
    // consumes the same track to keep every column aligned
    cell('dv-icon-head', '')
    cell('dv-name', 'Filename')
    const cols = this.view.columns
    if (cols.size) {
      cell('dv-size', 'Filesize')
    }
    if (cols.type) {
      cell('dv-type', 'Filetype')
    }
    if (cols.lastModified) {
      cell('dv-time', 'Last Modified')
    }
    if (cols.permissions) {
      cell('dv-perm', 'Permissions')
    }
    if (cols.ownerGroup) {
      cell('dv-owner', 'Owner/Group')
    }
    return head
  }

  // list this.cwd and render; resolves false when a newer navigation
  // superseded this one while the fs.list() was in flight
  async load() {
    const seq = this.loadSeq
    const entries = await this.fs.list(this.cwd)
    if (seq !== this.loadSeq) {
      return false
    }
    this.render()
    this.clearSelection()
    // sticky column headers; entryRow() hands out the same cell classes so
    // the subgrid keeps every column dead-aligned
    this.appendChild(this.headRow())
    // rows are striped by hand: the error divs make nth-child unreliable
    let stripe = 0
    const mark = (row) => {
      if (stripe++ % 2 === 0) {
        row.classList.add('dv-odd')
      }
    }
    // browser cannot go above the picked root
    if (this.cwd !== '') {
      const up = this.entryRow(parentIconPath(), '..', true)
      up.classList.add('dv-up')
      mark(up)
      up.onclick = () => {
        const parts = this.cwd.split('/')
        this.goto(parts.slice(0, -1).join('/'))
      }
      this.appendChild(up)
    }
    // file rows get a live entry map so chmodSelected() can prefill
    // the current permissions (name -> entry of the newest listing)
    this.entryMap = new Map(entries.map((entry) => [entry.name, entry]))
    for (const entry of entries) {
      const isDir = entry.type === 'dir'
      const row = this.entryRow(iconPath(entry.name, entry.type),
        isDir ? entry.name + '/' : entry.name, isDir, entry)
      // every entry selects on a plain click (dirs included — Copy/Delete
      // take whole sets); a dir opens only on the double click
      row.dataset.name = entry.name
      row.title = isDir
        ? 'click to select, double-click to open, ctrl-click for multiple,' +
          ' shift-click for a range'
        : 'click to select, ctrl-click for multiple, shift-click for a range'
      row.onclick = (e) => this.toggleSelect(entry.name, e)
      if (isDir) {
        row.ondblclick = () => this.goto(this.entryPath(entry.name))
      }
      mark(row)
      this.appendChild(row)
    }
    this.emitPath()
    return true
  }

  entryPath(name) {
    return this.cwd ? this.cwd + '/' + name : name
  }

  // refresh the listing after an out-of-band write (editor-view calls this
  // on save so sizes and mtimes stay truthful); loadSeq++ makes this its
  // own listing generation
  async refresh() {
    this.loadSeq++
    try {
      await this.load()
    }
    catch (e) {
      this.fail(e.message)
    }
  }

  // open the selected file in the editor dialog; refuses binary files in
  // the pane (via notify) and shows read errors like any other load
  async editSelected() {
    if (!this.fs) {
      return
    }
    const name = this.soloSelected()
    if (!name) {
      return
    }
    const mod = await import('./editor-view.js')
    if (!mod.isEditable(name)) {
      this.notify('cannot edit a binary file: ' + name)
      return
    }
    await mod.openEditor(this, name)
  }

  // report an error: keep the listing when still connected, fall back to
  // the start view when detached
  fail(message) {
    if (!this.fs) {
      this.showError(message)
      return
    }
    this.load()
      .then((ok) => {
        if (ok) {
          this.notify(message)
        }
      })
      .catch(() => this.showError(message))
  }

  // toolbar Download (remote panes): stream the selected file to a
  // save-picked file. the picker is called before any await so the click's
  // user gesture still counts; the queue then pumps the engine's download
  // chunks straight into the writable, tracked + cancellable in the
  // transfer queue with a real progress bar (no blob-URL springboard).
  // per-file on purpose: each download needs its own save picker
  async downloadSelected() {
    if (!this.fs || this.type !== 'remote') {
      return
    }
    const name = this.soloSelected()
    if (!name) {
      return
    }
    const entry = this.entryMap.get(name) || {}
    let handle = null
    try {
      handle = await showSaveFilePicker({suggestedName: name})
    }
    catch (e) {
      if (e.name !== 'AbortError') { // picker cancelled = silent no-op
        this.fail(e.message)
      }
      return
    }
    const {queueDownload} = await import('../fs/transfers.js')
    queueDownload({
      name,
      size: entry.size,
      remoteFs: this.fs,
      remotePath: this.entryPath(name),
      sinkFor: () => handle.createWritable(),
      from: this.fs.label + '/' + this.entryPath(name),
      to: handle.name
    })
  }

  // flatten the current selection for transferSelected(): plain file
  // selections ride as {relPath, size} leaves as they are; a selected dir
  // walks (fs.list, depth-first so parents always precede their children)
  // into the skeleton dirs + the leaf files below them. unreadable
  // entries report once and vanish — a broken subtree must not stall the
  // whole batch
  async expandSelection() {
    const problems = []
    const dirs = [] // relative dir paths, parents before children
    const leaves = [] // {relPath, size?}
    const visit = async (rel, depth) => {
      if (depth > 20) {
        problems.push(rel + ' (tree too deep)')
        return
      }
      let entries
      try {
        entries = await this.fs.list(this.entryPath(rel))
      }
      catch (e) {
        problems.push(rel + ' (' + (e.message || e) + ')')
        return
      }
      for (const entry of entries) {
        if (entry.type !== 'dir') {
          leaves.push({relPath: rel + '/' + entry.name, size: entry.size})
        }
        else {
          const sub = rel + '/' + entry.name
          dirs.push(sub)
          await visit(sub, depth + 1)
        }
      }
    }
    for (const name of this.selectedSet) {
      const entry = this.entryMap.get(name)
      if (entry && entry.type === 'dir') {
        dirs.push(name)
        await visit(name, 1)
      }
      else {
        leaves.push({relPath: name, size: entry ? entry.size : undefined})
      }
    }
    if (problems.length) {
      this.notify('unreadable, skipped: ' + problems.join(', '))
    }
    return {dirs, leaves}
  }

  // toolbar Copy to <other pane>: hand the selection to the transfer queue
  // as a batch of streamed pane-to-pane transfers into the target's current
  // directory. uploads stream the local handle's File OUT in chunks;
  // downloads stream engine chunks INTO the target dir's new writable.
  // selected dirs expand recursively (expandSelection) into per-file
  // transfers, with the dir skeleton created on the target first.
  // FileZilla-style overwrite ask — one confirm lumping every colliding
  // target, declined names skipped; the target listing refreshes once,
  // after the last file of the batch lands
  async transferSelected(target) {
    if (!this.fs || !target || !target.fs || this.type === target.type) {
      return
    }
    const walk = await this.expandSelection()
    if (!walk.leaves.length) {
      return
    }
    const targetPath = (name) => target.cwd ? target.cwd + '/' + name : name
    // the probe is best effort: a server without SIZE/MLST (or an unreadable
    // local dir) just proceeds and lets the transfer itself report errors
    const collisions = []
    for (const leaf of walk.leaves) {
      try {
        if (await target.fs.exists(targetPath(leaf.relPath))) {
          collisions.push(leaf)
        }
      }
      catch {} // unusable probe: start anyway (the transfer reports failures)
    }
    let leaves = walk.leaves
    if (collisions.length && !confirm('overwrite ' + collisions.length +
        ' file(s) on ' + target.fs.label + '? ' +
        collisions.slice(0, 3).map((leaf) => leaf.relPath).join(', ') +
        (collisions.length > 3 ? ', ...' : ''))) {
      leaves = leaves.filter((leaf) => !collisions.includes(leaf))
    }
    if (!leaves.length) {
      return
    }
    const mod = await import('../fs/transfers.js')
    // target dirs first (parent-first order from the walk): a leaf inside
    // a fresh dir needs the skeleton up before its stream opens; a dir
    // that cannot be created drops its whole subtree
    const skipped = []
    for (const dir of walk.dirs) {
      try {
        await target.fs.ensureDir(targetPath(dir))
      }
      catch {
        skipped.push(dir + '/')
        leaves = leaves.filter((leaf) => !leaf.relPath.startsWith(dir + '/'))
      }
    }
    if (!leaves.length) {
      if (skipped.length) {
        this.notify('cannot create on ' + target.fs.label + ': ' +
          skipped.join(', '))
      }
      return
    }
    // the target listing refreshes once, when the whole batch has settled —
    // onSettled counts failures too, so one bad file cannot hold off the
    // refresh forever (its members simply stay missing from the listing)
    let remaining = leaves.length
    const settled = () => {
      if (--remaining === 0) {
        target.refresh()
      }
    }
    for (const leaf of leaves) {
      const name = leaf.relPath.slice(leaf.relPath.lastIndexOf('/') + 1)
      const from = this.fs.label + '/' + this.entryPath(leaf.relPath)
      const to = target.fs.label + '/' + targetPath(leaf.relPath)
      if (this.type === 'local') {
        mod.queueUpload({
          name,
          size: leaf.size,
          localFs: this.fs,
          localPath: this.entryPath(leaf.relPath),
          remoteFs: target.fs,
          remotePath: targetPath(leaf.relPath),
          from,
          to,
          onSettled: settled
        })
      }
      else {
        mod.queueDownload({
          name,
          size: leaf.size,
          remoteFs: this.fs,
          remotePath: this.entryPath(leaf.relPath),
          sinkFor: () => target.fs.sink(targetPath(leaf.relPath)),
          from,
          to,
          onSettled: settled
        })
      }
    }
    if (skipped.length) {
      this.notify('cannot create on ' + target.fs.label + ': ' +
        skipped.join(', '))
    }
  }

  // prompt for a name, run make(path), then refresh the listing
  async createEntry(make, noun) {
    const name = prompt('new ' + noun + ' name')
    if (!name) {
      return
    }
    try {
      await make(this.entryPath(name))
      this.loadSeq++ // refresh counts as a new listing generation
      await this.load()
    }
    catch (e) {
      this.fail(e.message)
    }
  }

  createFile() {
    this.createEntry((path) => this.fs.create(path), 'file')
  }

  createDir() {
    this.createEntry((path) => this.fs.mkdir(path), 'dir')
  }

  // rename the selected file (name and/or extension); the fs adapter
  // refuses same-name/collision/nested paths, fail() reports the error
  async renameSelected() {
    if (!this.fs) {
      return
    }
    const name = this.soloSelected()
    if (!name) {
      return
    }
    // prompt prefills the current name so a single edit (say, swapping the
    // extension) is quick
    const newName = prompt('rename ' + name + ' to', name)
    if (!newName || newName === name) {
      return
    }
    try {
      await this.fs.rename(this.entryPath(name), newName)
      this.loadSeq++ // refresh counts as a new listing generation
      await this.load()
    }
    catch (e) {
      this.fail(e.message)
    }
  }

  // change the permissions of the selected entry via SITE CHMOD (remote
  // panes only — LocalFS.chmod refuses). opens the FileZilla-style chmod
  // dialog (checkbox sections + octal field) prefilled with the current
  // permissions when the listing supplied them; null result = cancelled.
  async chmodSelected() {
    if (!this.fs || this.type !== 'remote') {
      return
    }
    const name = this.soloEntry()
    if (!name) {
      return
    }
    const entry = this.entryMap.get(name) || {}
    const current = this.octalFrom(entry.permissions)
    try {
      const mod = await import('./chmod-view.js')
      const mode = await mod.openChmod(this.entryPath(name), current)
      if (!mode) {
        return
      }
      await this.fs.chmod(this.entryPath(name), mode)
      this.loadSeq++ // refresh counts as a new listing generation
      await this.load()
    }
    catch (e) {
      this.fail(e.message || String(e))
    }
  }

  // LIST mode string -> octal digits, eg. "-rw-rw-r--" -> "664" and
  // "-rwSrwSrwt" -> "4744": the 9 trailing chars form the rwx triples, and
  // an s/S/t/T in an x position raises the special digit bit (suid=4,
  // sgid=2, sticky=1) in addition to exec when lowercase. a plain 3-digit
  // mode is returned so SITE CHMOD stays un-surprising for normal files.
  octalFrom(mode) {
    const m = String(mode || '').slice(-9)
    if (m.length !== 9) {
      return ''
    }
    let spec = 0
    let out = ''
    for (let g = 0; g < 3; g++) {
      const tri = m.slice(g * 3, g * 3 + 3)
      const x = tri[2]
      if (tri[0] !== '-') out += 4
      if (tri[1] !== '-') out += 2
      if (x === 'x' || x === 's' || x === 't') out += 1
      if ((g === 0 || g === 1) && x === 's') spec += g === 0 ? 4 : 2
      if (g === 2 && x === 't') spec += 1
    }
    return spec ? String(spec) + out : out
  }

  // delete every selected entry in one confirm (multi-selection; dirs go
  // down recursively), then refresh the listing once; individual failures
  // never mask the rest — they surface in the pane's error row at the end
  async deleteSelected() {
    if (!this.fs || !this.selectedSet.size) {
      return
    }
    const names = [...this.selectedSet]
    const label = names.length === 1
      ? this.entryPath(names[0])
      : names.length + ' entries (' + names.slice(0, 3).join(', ') +
        (names.length > 3 ? ', ...' : '') + ')'
    if (!confirm('delete ' + label + '?')) {
      return
    }
    const failed = []
    for (const name of names) {
      const entry = this.entryMap.get(name)
      try {
        await this.fs.remove(this.entryPath(name),
          {recursive: !!entry && entry.type === 'dir'})
      }
      catch {
        failed.push(name)
      }
    }
    this.loadSeq++ // refresh counts as a new listing generation
    try {
      await this.load()
    }
    catch (e) {
      this.fail(e.message)
      return
    }
    if (failed.length) {
      this.notify('could not delete: ' + failed.join(', '))
    }
  }

  render() {
    this.textContent = ''
    if (!this.fs) {
      this.appendConnect()
      this.emitPath()
      return
    }
    // connected: the path bar above the pane shows label + cwd; load()
    // appends the listing rows
  }

  // only the button matching the pane type is offered, centered in the pane;
  // the local pane additionally lists the previously picked dirs
  appendConnect() {
    const box = document.createElement('div')
    box.className = 'dv-start'
    if (this.type === 'remote') {
      const remote = document.createElement('button')
      remote.textContent = 'Remote...'
      remote.onclick = () => this.remoteConnect()
      box.appendChild(remote)
    }
    else {
      const open = document.createElement('button')
      open.textContent = 'Open Directory'
      open.onclick = () => this.openLocal()
      box.appendChild(open)
      const recents = document.createElement('div')
      recents.className = 'dv-recents'
      box.appendChild(recents)
      this.loadRecents(recents)
    }
    this.appendChild(box)
  }

  // remote connect flow: ask the service worker for the ws-to-tls bridge
  // url (native client side), then dial + login through the wasm engine
  // (with the interactive host-key / tls trust prompts of connectTofu)
  // and attach the RemoteFS adapter. every failure lands in the pane like a
  // normal fs error so the user can retry from the connect view.
  async remoteConnect() {
    this.connecting()
    try {
      const form = await import('./connect-view.js')
      const opts = await form.openConnect()
      if (!opts) {
        this.render()
        this.emitPath()
        return
      }
      const resp = await chrome.runtime.sendMessage({cmd: 'ftp-bridge'})
      if (!resp || !resp.ok) {
        throw new Error(resp ? resp.error : 'bridge request failed')
      }
      const {FtpApi} = await import('../../../core/ftp/api.js')
      // the protocol picks the wasm engine handle: FtpClient for FTP/SFTP
      // (the wasm one distinguishes the TLS modes via opts.secure) and
      // SshClient for SFTP
      const api = await FtpApi.create({
        bridgeUrl: resp.url,
        protocol: opts.protocol === 'sftp' ? 'sftp' : 'ftp'
      })
      const client = await this.connectTofu(api, opts)
      const {RemoteFS} = await import('../fs/remote-fs.js')
      const {loggedFS} = await import('../fs/log-fs.js')
      this.attach(loggedFS(new RemoteFS(client,
        opts.user + '@' + opts.host + ':' + opts.port)))
    }
    catch (e) {
      this.fs = null
      // a declined trust prompt backtracks as quietly as a cancelled dialog
      if (e && e.name === 'AbortError') {
        this.render()
        this.emitPath()
        return
      }
      this.showError(e.message || String(e))
    }
  }

  // the connect() call wrapped in the interactive trust prompts:
  //   sftp  — TOFU against user.hostkey.<host>@<port>: stored fingerprints
  //           ride into connect() as trustFingerprints; an unknown (code
  //           'hostkey', fingerprint present) or changed key is offered for
  //           trust-once / trust-and-remember, a never-continue on decline
  //   ftps  — a self-signed certificate error gets one explicit
  //           allow-self-signed retry (no persistence)
  async connectTofu(api, opts) {
    const promptView = async () => {
      await import('./prompt-view.js') // the page-wide prompt dialog
      return document.querySelector('prompt-view')
    }
    let allowSelfSigned = !!opts.allowSelfSigned
    for (;;) {
      const known = await this.safeHostkeys(opts.host, opts.port)
      try {
        return await api.connect({
          host: opts.host,
          port: opts.port,
          user: opts.user,
          password: opts.password,
          secure: opts.secure,
          allowSelfSigned,
          privateKey: opts.privateKey,
          passphrase: opts.passphrase,
          trustFingerprints: known
        })
      }
      catch (e) {
        // sftp host key: the error carries {code:'hostkey', fingerprint}
        if (e && e.code === 'hostkey' && e.fingerprint) {
          const fp = String(e.fingerprint)
          if (known.includes(fp)) {
            throw e // pinned but still failing — nothing to decide here
          }
          const changed = known.length > 0
          const verdict = await this.askHostkey(
            await promptView(), opts.host, fp, changed)
          if (verdict === 'remember') {
            await this.safeAddHostkey(opts.host, opts.port, fp)
            continue // trusted now — retry the connect
          }
          if (verdict === 'once') {
            continue // trusted for this connect only
          }
          return this.aborted() // declined: backtrack to the start view
        }
        // ftps certificate: one explicit allow-self-signed retry
        if (!allowSelfSigned && opts.protocol !== 'sftp' &&
            this.tlsFailureLook(e)) {
          if (await this.askAllowSelfSigned(await promptView(), opts.host)) {
            allowSelfSigned = true
            continue
          }
          return this.aborted() // declined: backtrack to the start view
        }
        throw e
      }
    }
  }

  // ask what to do with an untrusted sftp host key; changed (an older
  // fingerprint is stored for this host) gets the mitm warning up front.
  // every outcome is an explicit user choice — nothing auto-continues.
  async askHostkey(promptView, host, fp, changed) {
    const message = (changed
      ? 'host key changed for ' + host + ' — possible man-in-the-middle.'
      : 'unknown host key of ' + host + ':') + ' ' + fp
    const choices = [
      {value: 'remember',
        label: changed ? 'add anyway, remember' : 'trust and remember'},
      {value: 'once', label: 'trust once'},
      {value: 'abort', label: 'cancel'}
    ]
    try {
      return await promptView.askChoice(message, choices)
    }
    catch {
      return 'abort' // prompt cancelled = declined
    }
  }

  // ask whether to retry a failed ftps handshake allowing self-signed
  async askAllowSelfSigned(promptView, host) {
    try {
      return (await promptView.askChoice(
        'the tls certificate of ' + host + ' could not be verified — ' +
        'retry allowing self-signed certificates?',
        [{value: 'ok', label: 'allow self-signed'}])) === 'ok'
    }
    catch {
      return false // prompt cancelled = declined
    }
  }

  // does the error look like a tls/certificate problem (best effort: code
  // plus message wording — the engine has no dedicated ftps error code)?
  tlsFailureLook(e) {
    const text = String((e && e.code ? e.code : '') + ' ' +
      ((e && e.message) || String(e))).toLowerCase()
    return /tls|ssl|certificat/.test(text)
  }

  // storage must not break the connect: an unreachable store means no TOFU
  // memory, never a hard failure
  async safeHostkeys(host, port) {
    try {
      return await getHostkeys(host, port)
    }
    catch {
      return []
    }
  }

  async safeAddHostkey(host, port, fp) {
    try {
      await addHostkey(host, port, fp)
    }
    catch {} // not remembering loses the pin, the trust-once keeps working
  }

  // throw the "user declined a trust prompt" shape: attach() and
  // remoteConnect() both show 'cancelled' for AbortError
  aborted() {
    const e = new Error('cancelled')
    e.name = 'AbortError'
    throw e
  }

  // pick a fresh dir via the picker, then remember it (best effort)
  async openLocal() {
    const {LocalFS} = await import('../fs/local-fs.js')
    const {loggedFS} = await import('../fs/log-fs.js')
    const fs = loggedFS(new LocalFS())
    await this.attach(fs)
    if (this.fs === fs) { // attach() clears fs on failure
      try {
        await rememberDir(fs.root)
        this.remembered()
      }
      catch {} // a full/blocked indexeddb must not break the listing
    }
  }

  // the recents store changed (a dir remembered or bumped): the chooser
  // in the toolbar re-syncs from this event, since it fires after the
  // store write while pathchange fires before it
  remembered() {
    this.dispatchEvent(new CustomEvent('dirremembered', {bubbles: true}))
  }

  // fill the recents box asynchronously; silently skipped when the pane
  // got attached while loading or the store is empty/broken
  async loadRecents(box) {
    let dirs
    try {
      dirs = await getRecentDirs()
    }
    catch {
      return
    }
    if (!dirs.length || this.fs) {
      return
    }
    const title = document.createElement('div')
    title.className = 'dv-recents-title'
    title.textContent = 'recent directories'
    box.appendChild(title)
    for (const dir of dirs) {
      if (this.fs) {
        return // attached while we were loading
      }
      box.appendChild(await this.recentRow(dir))
    }
  }

  // one clickable recent entry; shows a hint when the handle needs
  // re-approval (the usual 'prompt' on a new session) or was denied
  async recentRow(dir) {
    const row = document.createElement('div')
    row.className = 'dv-recent'
    const icon = document.createElement('img')
    icon.className = 'dv-icon'
    icon.src = iconPath(dir.name, 'dir')
    icon.alt = ''
    const name = document.createElement('span')
    name.className = 'dv-name'
    name.textContent = dir.name
    row.appendChild(icon)
    row.appendChild(name)
    let state = 'prompt'
    try {
      state = await dir.handle.queryPermission({mode: 'readwrite'})
    }
    catch {} // treat a broken handle as needing approval
    if (state !== 'granted') {
      row.classList.add('dv-pending')
      const hint = document.createElement('span')
      hint.className = 'dv-recent-hint' + (state === 'denied' ? ' dv-denied' : '')
      hint.textContent = state === 'denied' ? 'access denied' : 'needs approval'
      row.appendChild(hint)
    }
    row.onclick = () => this.openRecent(dir)
    return row
  }

  // open a stored dir: no picker, LocalFS.init() verifies the permission
  // (requesting it right here inside the click when needed)
  async openRecent(dir) {
    const {LocalFS} = await import('../fs/local-fs.js')
    const {loggedFS} = await import('../fs/log-fs.js')
    const fs = loggedFS(new LocalFS(dir.handle))
    await this.attach(fs)
    if (this.fs === fs) { // attach() clears fs on failure
      try {
        await touchDir(dir.id)
        this.remembered()
      }
      catch {}
    }
  }

  // open a directory dragged in from the OS: the first dir handle among
  // the drop items wins (plain files are ignored — transfers have their
  // own affordances). permission lives in LocalFS.init()/verify() like
  // every other open path, and the dir joins the recents store so it
  // shows up in the path chooser (marked active) right afterwards
  async openDropped(e) {
    const items = e.dataTransfer ? [...e.dataTransfer.items] : []
    // collect the getAsFileSystemHandle() promises synchronously: once
    // the drop task ends the drag data is gone and they resolve null
    const probes = items.map((item) =>
      typeof item.getAsFileSystemHandle === 'function'
        ? item.getAsFileSystemHandle()
        : null)
    const handles = (await Promise.allSettled(probes))
      .map((r) => r.status === 'fulfilled' ? r.value : null)
      .filter(Boolean)
    const dir = handles.find((handle) => handle.kind === 'directory')
    if (!dir) {
      return
    }
    const {LocalFS} = await import('../fs/local-fs.js')
    const {loggedFS} = await import('../fs/log-fs.js')
    const fs = loggedFS(new LocalFS(dir))
    await this.attach(fs)
    if (this.fs === fs) { // attach() clears fs on failure
      try {
        await rememberDir(fs.root)
        this.remembered() // the fresh dir belongs in the chooser right away
      }
      catch {} // a full/blocked indexeddb must not break the listing
    }
  }
}

customElements.define('dir-view', DirView)