// toolbar-view.js — top bar holding the (single) tools row.
//
// There are no per-pane tools anymore: this one tools row acts on the
// *active* pane. A mousedown anywhere inside a .pane marks it active
// (extra CSS outline marks it visually); the first pane is active on
// load. Button wiring and state tracking follow the pane's bubbled
// events — "pathchange" (the fs label is empty exactly while the pane
// is detached) and "selectionchange" (a file row is selected) — stored
// per pane and applied for the active pane. Buttons:
// New File / New Dir create an empty entry in the active pane's
// current dir (the two share one combo-view visual button,
// "New File | Dir"); Rename moves the selected file to a new name
// (incl. extension); Delete removes the selected file (with a confirm
// dialog); Refresh re-lists the active pane's current directory; Perm
// is remote-only (SITE CHMOD); Download streams the selected remote
// file to disk through the save picker; Copy switches its label with
// the pane type — "Copy to Server" (active pane local) or "Copy to
// Local Directory" (active pane remote) — and hands the selection to
// the transfer queue (fs/transfers.js) toward the other pane's cwd.
// Selection granularity: Copy/Delete act on the pane's whole selection
// set (multi rows incl. dirs); Edit/Rename/Download need exactly one
// selected file (a lone dir primary greys them out); Perm takes any
// single selected entry. The right-edge pair — the "Change Local Dir"
// caption plus <select> — lists the remembered local dirs (recent-dirs.js) and opens the chosen
// one in the local pane no matter which pane is active; a dropped or
// picked dir joins the list via the dirremembered event.

import './combo-view.js'
import {getRecentDirs} from '../fs/recent-dirs.js'

class ToolbarView extends HTMLElement {
  connectedCallback() {
    this.perPane = new Map() // dir-view -> {connected, selectedName, count}
    this.activePane = null
    this.panes = [...document.querySelectorAll('.pane')] // [<div class=pane>]
    this.lastLocalLabel = null // the dir chooser resyncs on label changes
    for (const pane of this.panes) {
      const dv = pane.querySelector('dir-view')
      pane.dirView = dv // sibling(): the <dir-view> of the active pane
      dv.addEventListener('pathchange', (e) => {
        const st = this.state(e.target)
        // the fs label is empty exactly while the pane is detached
        st.connected = e.detail.label !== ''
        if (dv.type === 'local' &&
            e.detail.label !== this.lastLocalLabel) {
          this.lastLocalLabel = e.detail.label
          this.syncDirs()
        }
        this.sync()
      })
      dv.addEventListener('selectionchange', (e) => {
        const st = this.state(e.target)
        st.selectedName = e.detail.name || null
        // count rides the event; a custom producer without one still
        // yields a sensible 1/0 from the name
        st.selectedCount = e.detail.count !== undefined
          ? e.detail.count
          : (e.detail.name ? 1 : 0)
        // what the primary is: file-only tools (edit/rename/download) grey
        // out on a dir primary even when it is the lone selection
        st.isDir = !!e.detail.isDir
        this.sync()
      })
      // a dir remembered/touched in any open path (Open Directory button,
      // a recents row, a dropped dir) refreshes the chooser right away —
      // eventing beats the pathchange-triggered resync here, which runs
      // while rememberDir() itself is still writing the new entry
      dv.addEventListener('dirremembered', () => this.syncDirs())
    }
    // click (catch: also when it lands on rows that stop propagation)
    document.addEventListener('mousedown', (e) => {
      const pane = typeof e.target.closest === 'function'
        ? e.target.closest('.pane') : null
      if (pane && pane !== this.activePane) {
        this.setActive(pane)
      }
    }, true)
    this.render()
    this.setActive(this.panes[0])
  }

  state(dirView) {
    let st = this.perPane.get(dirView)
    if (!st) {
      st = {connected: false, selectedName: null, selectedCount: 0, isDir: false}
      this.perPane.set(dirView, st)
    }
    return st
  }

  // the pane these tools act on: the <dir-view> of the active pane's div
  sibling() {
    return this.activePane && this.activePane.dirView
  }

  // the OTHER pane's dir-view — comparisons must stay at the div level:
  // sibling() hands back the dir-view inside the pane div, so a dir-view
  // here would never exclude the active pane's div (which made Copy to
  // Server silently self-transfer = no-op on the first pane)
  otherPane() {
    const other = this.panes.find((candidate) =>
      candidate !== this.activePane && candidate.dirView)
    return other ? other.dirView : null
  }

  setActive(paneDiv) {
    for (const pane of this.panes) {
      pane.classList.toggle('active', pane === paneDiv)
      pane.active = pane === paneDiv
    }
    this.activePane = paneDiv
    this.sync()
  }

  render() {
    this.textContent = ''
    const newFile = document.createElement('button')
    newFile.textContent = 'File'
    newFile.title = 'new empty file in the current directory'
    newFile.onclick = () => {
      const pane = this.sibling()
      if (pane) {
        pane.createFile()
      }
    }
    const newDir = document.createElement('button')
    newDir.textContent = 'Dir'
    newDir.title = 'new dir in the current directory'
    newDir.onclick = () => {
      const pane = this.sibling()
      if (pane) {
        pane.createDir()
      }
    }
    const edit = document.createElement('button')
    edit.textContent = 'Edit'
    edit.onclick = () => {
      const pane = this.sibling()
      if (pane) {
        pane.editSelected()
      }
    }
    const rename = document.createElement('button')
    rename.textContent = 'Rename'
    rename.onclick = () => {
      const pane = this.sibling()
      if (pane) {
        pane.renameSelected()
      }
    }
    const download = document.createElement('button')
    download.textContent = 'Download'
    download.onclick = () => {
      const pane = this.sibling()
      if (pane) {
        pane.downloadSelected()
      }
    }
    // the label flips with the active pane's type: copy local -> server,
    // or server -> local (sync() keeps the text and the disabled state in
    // step with whatever pane is active)
    const copy = document.createElement('button')
    copy.textContent = 'Copy to Server'
    copy.onclick = () => {
      const pane = this.sibling()
      const other = this.otherPane()
      if (pane && other) {
        pane.transferSelected(other)
      }
    }
    const perm = document.createElement('button')
    perm.textContent = 'Perm'
    perm.title = 'change permissions (SITE CHMOD) on the selected entry'
    perm.onclick = () => {
      const pane = this.sibling()
      if (pane) {
        pane.chmodSelected()
      }
    }
    const del = document.createElement('button')
    del.textContent = 'Delete'
    del.onclick = () => {
      const pane = this.sibling()
      if (pane) {
        pane.deleteSelected()
      }
    }
    const refresh = document.createElement('button')
    refresh.textContent = 'Refresh'
    refresh.title = "re-list the active pane's current directory"
    refresh.onclick = () => {
      const pane = this.sibling()
      if (pane) {
        pane.refresh()
      }
    }
    // the two create buttons live inside one visual combo button labeled
    // "New" with the segments "File | Dir"; the buttons stay independent
    // light-children, so sync()'s disabled state and handlers keep working
    const combo = document.createElement('combo-view')
    combo.setAttribute('label', 'New')
    combo.append(newFile, newDir)
    this.appendChild(combo)
    this.appendChild(edit)
    this.appendChild(rename)
    this.appendChild(download)
    this.appendChild(copy)
    this.appendChild(del)
    this.appendChild(refresh)
    this.appendChild(perm)
    // the local-dir chooser at the right edge: a caption + the select that
    // lists the remembered handles; picking one opens it in the LOCAL pane
    // regardless of which pane is active (syncDirs() keeps the options and
    // the active marking fresh)
    const dirsWrap = document.createElement('label')
    dirsWrap.className = 'tb-dirs-wrap'
    const dirsCaption = document.createElement('span')
    dirsCaption.className = 'tb-dirs-caption'
    dirsCaption.textContent = 'Change Local Dir'
    const dirs = document.createElement('select')
    dirs.className = 'tb-dirs'
    dirs.title = 'open a remembered local directory in the local pane'
    dirs.onchange = () => {
      const local = this.panes.map((pane) => pane.dirView)
        .find((dv) => dv.type === 'local')
      const dir = (this.dirCache || []).find((entry) =>
        entry.id !== undefined && String(entry.id) === dirs.value)
      if (local && dir) {
        // openRecent() attaches + re-verifies the permission just like
        // the recents rows do; the dirremembered event then re-syncs
        local.openRecent(dir)
      }
    }
    dirsWrap.append(dirsCaption, dirs)
    this.appendChild(dirsWrap)
    this.dirSelect = dirs
    this.dirsWrap = dirsWrap
    this.newFileButton = newFile
    this.newDirButton = newDir
    this.editButton = edit
    this.renameButton = rename
    this.downloadButton = download
    this.copyButton = copy
    this.deleteButton = del
    this.refreshButton = refresh
    this.permButton = perm
    this.sync()
    this.syncDirs()
  }

  // rebuild the dir chooser from the remembered handles; the option whose
  // handle is the same directory as the currently open local root (handle
  // identity fails across structure-cloned caches, so isSameEntry probes)
  // becomes the selected one, the placeholder wins when detached/unknown
  async syncDirs() {
    const dirs = this.dirSelect
    if (!dirs) {
      return
    }
    let recents = []
    try {
      recents = await getRecentDirs()
    }
    catch {} // a broken indexeddb must not take the toolbar down
    this.dirCache = recents
    // the whole chooser module only earns its place once a dir exists
    this.dirsWrap.hidden = !recents.length
    const local = this.panes.map((pane) => pane.dirView)
      .find((dv) => dv.type === 'local')
    const open = local && local.fs ? local.fs.root : null
    dirs.textContent = ''
    // the placeholder: never selectable; while a dir is open it hides so
    // the dropdown lists REAL dirs only
    const ghost = document.createElement('option')
    ghost.value = ''
    ghost.textContent = 'local directories'
    ghost.disabled = true
    dirs.appendChild(ghost)
    let matchedId = ''
    for (const dir of recents) {
      const opt = document.createElement('option')
      opt.value = String(dir.id)
      opt.textContent = dir.name || 'dir #' + dir.id
      dirs.appendChild(opt)
      if (open) {
        let same = false
        try {
          same = await open.isSameEntry(dir.handle)
        }
        catch {} // corrupt handle: never the same dir
        if (same) {
          matchedId = String(dir.id)
        }
      }
    }
    ghost.hidden = !!matchedId
    dirs.disabled = !recents.length
    dirs.value = matchedId ? matchedId : '' // '' selects the disabled ghost
  }

  // apply the current button states from the active pane
  sync() {
    const pane = this.sibling()
    const st = pane ? this.state(pane)
      : {connected: false, selectedName: null, selectedCount: 0, isDir: false}
    // SITE CHMOD only exists for a remote fs (and is chosen by the user
    // there): the button stays dark when the active pane is local
    const remote = pane ? pane.type === 'remote' : false
    // the Copy target is the other pane; it must be attached too (its own
    // state tracks connect/detach via pathchange)
    const other = this.otherPane()
    const otherSt = other
      ? this.state(other)
      : {connected: false, selectedName: null, selectedCount: 0, isDir: false}
    // one = exactly a single selected entry (Perm takes dirs too);
    // oneFile = a single selected *file*: what the file-only tools need;
    // some = anything selected: batch tools (Copy/Delete) act on the set
    const one = st.connected && st.selectedName && st.selectedCount === 1
    const oneFile = one && !st.isDir
    const some = st.connected && st.selectedCount > 0
    this.newFileButton.disabled = !st.connected
    this.newDirButton.disabled = !st.connected
    this.editButton.disabled = !oneFile
    this.renameButton.disabled = !oneFile
    // download only makes sense from a remote pane (the local pane already
    // owns the file); save-picker flow lives in dir-view.downloadSelected
    this.downloadButton.disabled = !oneFile || !remote
    this.copyButton.textContent = remote
      ? 'Copy to Local Directory'
      : 'Copy to Server'
    this.copyButton.title = remote
      ? "stream the selected files into the local pane's current directory"
      : "stream the selected files into the remote pane's current directory"
    this.copyButton.disabled = !some || !otherSt.connected
    this.deleteButton.disabled = !some
    this.refreshButton.disabled = !st.connected
    this.permButton.disabled = !one || !remote
  }
}

customElements.define('toolbar-view', ToolbarView)
