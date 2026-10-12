// editor-view.js — modal text editor for local and remote files.
//
// Renders into the static <dialog id="editor-dialog"> in index.html and is
// opened lazily: dir-view.editSelected() dynamic-imports this module, which
// also pulls in the vendored CodeMirror bundle (vendor/codemirror.mjs) only
// on the first edit. The pane keeps its fs + cwd ownership — the editor
// reads pane.entryPath(name), saves through pane.fs.write() and then asks
// dir-view to refresh the listing (see pane.refresh()).
//
// Both adapters work identically because the fs interface mirrors
// read(path) / write(path, text) (see local-fs.js), so remote files are
// editable as soon as remote-fs.js exposes the same two calls.
//
// Language setup is static per file (no hot swapping): the editor gets a
// fresh doc+extensions state on every open. Dirty state compares the live
// doc text against the last saved text, so undoing back to the saved text
// clears the marker again.

import {
  EditorView, EditorState, basicSetup, keymap,
  StreamLanguage, javascript, json, html, css, python, markdown, xml,
  yaml, shell, toml, properties
} from '../vendor/codemirror.mjs'

const DIALOG_ID = 'editor-dialog'

// files this big could freeze the tab while highlighting; refuse them up front
const MAX_SIZE = 1024 * 1024

// binary file kinds from the icon map must not be opened as text; any other
// extension (including none) is assumed to be editable text
const BINARY_KINDS = new Set(['image', 'audio', 'video', 'zip', 'font', 'exe', 'pdf'])
// whole-file names that look binary but are known text files
const KIND_FILENAMES = new Map([
  ['dockerfile', 'docker'],
  ['makefile', 'makefile']
])
// extension -> binary kind (subset of icons.js EXTENSIONS values)
const KIND = {
  image: 'image', jpg: 'image', jpeg: 'image', gif: 'image',
  bmp: 'image', ico: 'image', webp: 'image',
  zip: 'zip', tar: 'zip', gz: 'zip', bz2: 'zip', xz: 'zip', '7z': 'zip',
  rar: 'zip',
  mp3: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio', m4a: 'audio',
  mp4: 'video', mkv: 'video', avi: 'video', webm: 'video', mov: 'video',
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font', eot: 'font',
  exe: 'exe', dll: 'exe', bin: 'exe', iso: 'exe', dmg: 'exe',
  pdf: 'pdf'
}

class EditorViewElement extends HTMLElement {
  connectedCallback() {
    this.dialog = this.closest('dialog')
    this.buildDom()
  }

  // build the static editor chrome once: header (name, fs label, path,
  // dirty dot, status, buttons) + the CodeMirror host filling the rest
  buildDom() {
    const header = document.createElement('div')
    header.className = 'ed-header'

    const dirty = document.createElement('span')
    dirty.className = 'ed-dirty hidden' // visibility toggled by showDirty()
    dirty.textContent = '*'
    dirty.title = 'unsaved changes'

    const name = document.createElement('span')
    name.className = 'ed-name'

    const label = document.createElement('span')
    label.className = 'ed-label'

    const path = document.createElement('span')
    path.className = 'ed-path'

    const status = document.createElement('span')
    status.className = 'ed-status'

    const pos = document.createElement('span')
    pos.className = 'ed-pos'

    const save = document.createElement('button')
    save.textContent = 'Save'
    save.title = 'Ctrl+S'
    save.disabled = true
    save.onclick = () => this.save()
    this.saveButton = save

    const close = document.createElement('button')
    close.textContent = 'Close'
    close.onclick = () => this.attemptClose()

    header.append(dirty, name, label, path, status, pos, save, close)

    const host = document.createElement('div')
    host.className = 'ed-host'

    this.append(header, host)
    this.editorHost = host

    // Esc routes through the unsaved-changes confirm like the Close button
    this.dialog.addEventListener('cancel', (e) => {
      e.preventDefault()
      this.attemptClose()
    })
  }

  // open an editor for pane.entryPath(name); reads the file as text (a
  // binary extension or an oversized file shows an error in the pane
  // instead) and shows the dialog modal on top of the client
  async open(pane, name) {
    if (!this.dialog || this.view) {
      return // dom not built yet, or already editing a file
    }
    name = String(name)
    const fs = pane.fs
    const path = pane.entryPath(name)
    let text = null
    // the size gate: adapters with a stat() probe (remote-fs) let us check
    // the size without downloading the file first
    try {
      if (typeof fs.stat === 'function') {
        const meta = await fs.stat(path)
        if (meta.size !== undefined && meta.size > MAX_SIZE) {
          pane.notify('file too large to edit: ' + name + ' (' +
            meta.size + ' bytes, limit ' + MAX_SIZE + ')')
          return
        }
        text = await fs.read(path)
      }
      else {
        const file = await fs.file(path)
        if (file.size > MAX_SIZE) {
          pane.notify('file too large to edit: ' + name + ' (' +
            file.size + ' bytes, limit ' + MAX_SIZE + ')')
          return
        }
        text = await fs.read(path)
      }
    }
    catch (e) {
      pane.fail(e.message)
      return
    }
    this.pane = pane
    this.path = path
    this.name = name
    this.saved = text
    this.editing = false // set while fs.write() is in flight
    this.mount(text)
    this.showTitle()
    this.showDirty()
    this.showPos(this.view.state)
    this.dialog.showModal()
  }

  // mount a fresh CodeMirror view for the current file; extensions are
  // rebuilt per open, so the language is fixed for the lifetime of the view
  mount(text) {
    this.editorHost.textContent = ''
    this.view = new EditorView({
      state: EditorState.create({
        doc: text,
        extensions: [
          basicSetup,
          this.keymap(), // Mod-S / Cmd-S -> save()
          this.listener(), // dirty tracking on every doc change
          languageFor(this.name),
          EditorView.theme({
            '&': {fontSize: '13px'},
            '.cm-content': {fontFamily: 'inherit'},
            '.cm-gutters': {backgroundColor: 'inherit'}
          })
        ]
      }),
      parent: this.editorHost
    })
  }

  showTitle() {
    this.querySelector('.ed-name').textContent = this.name
    this.querySelector('.ed-label').textContent = this.pane.fs.label
    this.querySelector('.ed-path').textContent = this.path
  }

  // the * next to the filename and the Save button both follow this.dirty
  showDirty() {
    this.querySelector('.ed-dirty')
      .classList.toggle('hidden', !this.dirty)
    this.saveButton.disabled = !this.dirty || this.editing
  }

  // status line left of the buttons; failures repaint it red
  status(message, isError) {
    const status = this.querySelector('.ed-status')
    status.classList.toggle('ed-error', Boolean(isError))
    status.textContent = message
  }

  // write the current doc through the pane's fs, keep the dialog open on
  // errors, then ask dir-view to reload the listing (size/mtime changed)
  async save() {
    if (!this.view || !this.dirty || this.editing) {
      return
    }
    const text = this.view.state.doc.toString()
    this.editing = true
    this.status('saving...', false)
    this.showDirty()
    try {
      await this.pane.fs.write(this.path, text)
      this.saved = text // became clean only on a real, confirmed write
      this.dirty = false // the listener only runs on doc changes
      this.editing = false
      this.status('saved ' + new Date().toLocaleTimeString(), false)
      this.showDirty()
      await this.pane.refresh()
    }
    catch (e) {
      this.editing = false
      this.status('save failed: ' + e.message, true)
      this.showDirty()
    }
  }

  // Close button and the Esc key (dialog 'cancel' event) route through
  // the unsaved-changes confirm; returns whether the dialog was closed
  attemptClose() {
    if (this.dirty &&
      !confirm('discard unsaved changes in ' + this.name + '?')) {
      return false
    }
    this.close()
    return true
  }

  close() {
    this.view.destroy() // release listeners/DOM; next open() mounts fresh
    this.view = null
    this.dirty = false
    this.editing = false
    this.pane = null
    this.path = null
    this.name = null
    this.saved = null
    this.status('', false)
    this.dialog.close()
  }

  // single keybinding next to basicSetup (which owns history/search/etc.);
  // consumed even on a clean doc so the browser's save dialog never opens
  keymap() {
    return keymap.of([{
      key: 'Mod-s',
      preventDefault: true,
      run: () => {
        this.save()
        return true
      }
    }])
  }

  // flip dirty state on every doc change; comparing against this.saved
  // also clears the marker when undo walks back to the saved text
  listener() {
    return EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        this.dirty = update.state.doc.toString() !== this.saved
        this.showDirty()
      }
      if (update.selectionSet || update.docChanged) {
        this.showPos(update.state)
      }
    })
  }

  showPos(state) {
    const pos = this.querySelector('.ed-pos')
    if (!pos) {
      return
    }
    const line = state.doc.lineAt(state.selection.main.head)
    pos.textContent = 'Ln ' + line.number + ', Col ' +
      (state.selection.main.head - line.from + 1)
  }
}

// extension -> language for a filename; plain text ([]) when no curated
// parser covers it
function languageFor(name) {
  const lower = String(name).toLowerCase()
  const dot = lower.lastIndexOf('.')
  const ext = dot > 0 ? lower.slice(dot + 1) : ''
  switch (ext) {
    case 'js': case 'mjs': case 'cjs':
      return javascript()
    case 'jsx':
      return javascript({jsx: true})
    case 'ts':
      return javascript({typescript: true})
    case 'tsx':
      return javascript({jsx: true, typescript: true})
    case 'json': case 'jsonc': case 'json5':
      return json()
    case 'html': case 'htm': case 'xhtml':
      return html()
    case 'css': case 'scss': case 'sass': case 'less':
      return css()
    case 'py':
      return python()
    case 'md': case 'markdown': case 'rst':
      return markdown()
    case 'xml':
      return xml()
    case 'yml': case 'yaml':
      return StreamLanguage.define(yaml)
    case 'sh': case 'bash': case 'zsh':
      return StreamLanguage.define(shell)
    case 'toml':
      return StreamLanguage.define(toml)
    case 'ini': case 'cfg': case 'conf': case 'env':
      return StreamLanguage.define(properties)
    default:
      return []
  }
}

// true when the file looks editable as text: false for the binary kinds
// the icon map uses (images, archives, fonts, executables, pdf) and true
// for everything else, including extension-less files like Dockerfile
export function isEditable(name) {
  name = String(name)
  if (KIND_FILENAMES.has(name.toLowerCase())) {
    return true
  }
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  const kind = KIND[ext]
  return !kind || !BINARY_KINDS.has(kind)
}

customElements.define('editor-view', EditorViewElement)

// open the single editor dialog for a pane + filename; keeps the dialog
// element (index.html) and the CodeMirror wiring out of dir-view itself
export async function openEditor(pane, name) {
  const el = document.querySelector('#' + DIALOG_ID + ' editor-view')
  if (!el || el.view) {
    return // missing in index.html, or already editing a file
  }
  await el.open(pane, name)
}
