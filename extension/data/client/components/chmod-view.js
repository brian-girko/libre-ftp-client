// chmod-view.js — chmod dialog for the remote pane.
//
// Renders into the static <dialog id="chmod-dialog"> in index.html and is
// opened lazily by dir-view (like connect-view): openChmod(name, octal)
// shows FileZilla-style permission sections — owner/group/public, each
// read/write/execute plus its special bit (setuid/setgid/sticky) — next to
// the raw "chmod" octal text field. checkboxes and the field stay in sync
// in both directions; OK resolves the octal string exactly as typed (3 or
// 4 digits), Cancel/Esc resolves null. sending SITE CHMOD stays in
// dir-view.
//
// LIST mode strings (-rwSrwSrwt) encode the special bits in the x
// positions, so the preview mirrors those glyphs and dir-view's octalFrom
// can prefill a suid/sgid/sticky run.

// section specs: [key, title, row labels (read/write/execute, special)]
const GROUPS = [
  ['own', 'owner permissions', 'read', 'write', 'execute', 'set uid (suid)'],
  ['grp', 'group permissions', 'read', 'write', 'execute', 'set gid (sgid)'],
  ['pub', 'public permissions', 'read', 'write', 'execute', 'sticky bit']
]
// the special bits live in the leading octal digit: suid=4, sgid=2, sticky=1
const SPEC_BITS = {own: 4, grp: 2, pub: 1}

class ChmodView extends HTMLElement {
  connectedCallback() {
    this.dialog = this.closest('dialog')
    this.buildDom()
  }

  buildDom() {
    this.target = document.createElement('div')
    this.target.className = 'ch-target'

    // three equal permission boxes in a row; each holds read/write/execute
    // plus the section's special bit. checked state is kept in the inputs
    // themselves and composed into digits on change.
    this.sectionBox = {} // key -> {4: cb, 2: cb, 1: cb}
    this.specialBox = {} // key -> suid/sgid/sticky checkbox
    const groupsRow = document.createElement('div')
    groupsRow.className = 'ch-groups'
    for (const [key, title, read, write, exec, special] of GROUPS) {
      const box = document.createElement('div')
      box.className = 'ch-group'
      const head = document.createElement('div')
      head.className = 'ch-group-title'
      head.textContent = title
      box.appendChild(head)
      const section = {}
      for (const [bit, label] of [[4, read], [2, write], [1, exec]]) {
        box.appendChild(this.check(label, (cb) => {
          section[bit] = cb
        }))
      }
      box.appendChild(this.check(special, (cb) => {
        this.specialBox[key] = cb
      }))
      this.sectionBox[key] = section
      groupsRow.appendChild(box)
    }

    this.octInput = document.createElement('input')
    this.octInput.type = 'text'
    this.octInput.className = 'ch-oct'
    this.octInput.spellcheck = false
    this.octInput.oninput = () => this.fromField()

    const octRow = document.createElement('label')
    octRow.className = 'cn-field ch-chmod'
    const octLabel = document.createElement('span')
    octLabel.className = 'cn-label'
    octLabel.textContent = 'chmod'
    octRow.append(octLabel, this.octInput)

    this.preview = document.createElement('div')
    this.preview.className = 'ch-preview'

    this.okButton = document.createElement('button')
    this.okButton.textContent = 'OK'
    this.okButton.type = 'submit'

    const cancel = document.createElement('button')
    cancel.textContent = 'Cancel'
    cancel.type = 'button'
    cancel.onclick = () => this.resolve(null)

    const footer = document.createElement('div')
    footer.className = 'cn-footer'
    footer.append(cancel, this.okButton)

    this.status = document.createElement('div')
    this.status.className = 'cn-status'

    this.form = document.createElement('form')
    this.form.setAttribute('method', 'dialog')

    const title = document.createElement('div')
    title.className = 'cn-title'
    title.textContent = 'change file permissions'
    this.form.append(title, this.target, groupsRow, octRow,
      this.preview, this.status, footer)
    this.form.onsubmit = () => this.onOk()

    // Esc routes through resolve(null) like the Cancel button
    this.dialog.addEventListener('cancel', (e) => {
      e.preventDefault()
      this.resolve(null)
    })

    this.append(this.form)
  }

  // one labelled checkbox row; register() captures the input by the caller
  check(label, register) {
    const row = document.createElement('label')
    row.className = 'ch-check'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.onchange = () => this.fromChecks()
    const span = document.createElement('span')
    span.textContent = label
    row.append(input, span)
    register(input)
    return row
  }

  // '755' -> '0755'; 3 or 4 octal digits accepted, anything else null
  norm(text) {
    const m = String(text || '').trim()
    if (!/^[0-7]{3,4}$/.test(m)) {
      return null
    }
    return m.length === 3 ? '0' + m : m
  }

  // stored form is 4 digits; shown as 3 digits while the special bit is 0
  show(m4) {
    return m4[0] === '0' ? m4.slice(1) : m4
  }

  // compose the 4-digit mode from the checkbox state
  collectChecks() {
    let spec = 0
    let tris = ''
    for (const [key] of GROUPS) {
      let tri = 0
      for (const bit of [4, 2, 1]) {
        if (this.sectionBox[key][bit].checked) {
          tri += bit
        }
      }
      if (this.specialBox[key].checked) {
        spec += SPEC_BITS[key]
      }
      tris += tri
    }
    return String(spec) + tris
  }

  // compose the whole -rwxr-xr-x style string for the preview line; the
  // special bits replace x with s/S (own/grp) and t/T (pub)
  modeString(m4) {
    const spec = parseInt(m4[0], 8)
    let out = '-'
    for (let g = 0; g < 3; g++) {
      const d = parseInt(m4[g + 1], 8)
      let x = (d & 1) ? 'x' : '-'
      if (g === 0 && (spec & 4)) {
        x = (d & 1) ? 's' : 'S'
      }
      if (g === 1 && (spec & 2)) {
        x = (d & 1) ? 's' : 'S'
      }
      if (g === 2 && (spec & 1)) {
        x = (d & 1) ? 't' : 'T'
      }
      out += (d & 4 ? 'r' : '-') + (d & 2 ? 'w' : '-') + x
    }
    return out
  }

  // checkbox change -> rewrite the octal field + preview; the field is
  // authoritative only while it parses
  fromChecks() {
    const m4 = this.collectChecks()
    this.octInput.value = this.show(m4)
    this.preview.textContent = this.modeString(m4)
    this.fail('')
  }

  // octal field edit -> reflect in the checkboxes when parseable
  fromField() {
    const m4 = this.norm(this.octInput.value)
    if (m4 === null) {
      this.preview.textContent = ''
      this.octInput.classList.add('ch-bad')
      return
    }
    this.octInput.classList.remove('ch-bad')
    for (const [key] of GROUPS) {
      const i = key === 'own' ? 1 : key === 'grp' ? 2 : 3
      const tri = parseInt(m4[i], 8)
      this.sectionBox[key][4].checked = !!(tri & 4)
      this.sectionBox[key][2].checked = !!(tri & 2)
      this.sectionBox[key][1].checked = !!(tri & 1)
      this.specialBox[key].checked = !!(parseInt(m4[0], 8) & SPEC_BITS[key])
    }
    this.preview.textContent = this.modeString(m4)
  }

  // OK: the field must parse, else the error line says so and the dialog
  // stays open (the form would otherwise close via method=dialog)
  onOk() {
    const m4 = this.norm(this.octInput.value)
    if (m4 === null) {
      this.fail('mode must be 3 or 4 octal digits (000-777)')
      return false
    }
    this.resolve(String(this.octInput.value).trim())
    return false
  }

  fail(msg) {
    if (msg) {
      this.status.classList.add('cn-error')
    }
    else {
      this.status.classList.remove('cn-error')
    }
    this.status.textContent = msg
  }

  // resolve with the octal string (or null)
  resolve(value) {
    const fn = this.onDone
    this.onDone = null
    if (fn) {
      fn(value)
    }
    this.dialog.close()
  }

  // show the dialog and wait; octal prefills both the field and the boxes
  open(name, octal) {
    this.target.textContent = name
    const m4 = this.norm(octal) || '0644'
    this.octInput.value = this.show(m4)
    this.status.textContent = ''
    this.status.classList.remove('cn-error')
    this.octInput.classList.remove('ch-bad')
    this.fromField() // checks + preview follow the prefill
    return new Promise((resolve) => {
      this.onDone = resolve
      this.dialog.showModal()
      this.octInput.focus()
      this.octInput.select()
    })
  }
}

customElements.define('chmod-view', ChmodView)

// open the single chmod dialog; keeps the dialog element (index.html) and
// the form out of dir-view itself. resolves the octal string or null.
export function openChmod(name, octal) {
  const el = document.querySelector('#chmod-dialog chmod-view')
  if (!el) {
    return Promise.resolve(null)
  }
  return el.open(name, octal)
}
