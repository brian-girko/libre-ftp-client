// connect-view.js — connect form for the remote pane.
//
// Renders into the static <dialog id="connect-dialog"> in index.html and is
// opened lazily by dir-view (like editor-view): openConnect() shows protocol
// (FTP / SFTP), host, port, user, password and — for FTP — the TLS mode
// selector plus an allow-self-signed flag; for SFTP it offers the optional
// private key / key passphrase fields instead (SFTP is always SSH-encrypted,
// so there is no TLS selector). The form validates its input and resolves
// the plain opts object (or null on cancel/empty). Any error translation
// (native client missing, bridge not startable, login refused) stays in
// dir-view so the pane reports it like every other fs error. Untrusted sftp
// host keys and rejected ftps certificates are handled there too (TOFU
// prompts via prompt-view on the dir-view side).
//
// Saved accounts: the picker at the top of the form lists every saved
// account (primary preselected) and fills the whole form on change; manual
// entry clears the choice. When a master password is set, open() asks for
// it once through prompt-view (unlocking the session) before account
// details decrypt. Save stores the current form as an account — a
// picker-chosen account is overwritten as-is, manual entry asks for the
// name (and falls back to the host/port/user duplicate ask) — so accounts
// can be edited and added without leaving the client.

import {verifyMaster} from '../../../core/accounts/crypto.mjs'
import {
  getVerifier, getSessionMaster, putSessionMaster,
  getAccounts, getPrimaryAccount, getAccountPassword, getAccountSftpSecrets,
  saveAccount
} from '../../../core/accounts/storage.mjs'

// the page-wide prompt dialog (prompt-view in index.html)
const promptView = () => document.querySelector('prompt-view')

// the account label shaped like the options page list: the name when it says
// more than the address already does
const accLabel = (acc) => {
  const proto = acc.protocol === 'sftp' ? 'sftp' : 'ftp'
  const addr = `${proto}://${acc.user}@${acc.host}:${acc.port}`
  return acc.name && acc.name !== addr ? `${acc.name} (${addr})` : addr
}

class ConnectView extends HTMLElement {
  connectedCallback() {
    this.dialog = this.closest('dialog')
    this.buildDom()
  }

  buildDom() {
    const legend = document.createElement('div')
    legend.className = 'cn-title'
    legend.textContent = 'connect to server'

    // names the prefilled saved account, empty (and hidden) otherwise
    this.accountLine = document.createElement('div')
    this.accountLine.className = 'cn-account'

    // one-line feedback (save result, skipped unlock)
    this.status = document.createElement('div')
    this.status.className = 'cn-status'

    const mkField = (text) => {
      const l = document.createElement('label')
      l.className = 'cn-field'
      const span = document.createElement('span')
      span.className = 'cn-label'
      span.textContent = text
      l.append(span)
      return l
    }
    const field = (text, input) => {
      const l = mkField(text)
      input.className = 'cn-input'
      l.append(input)
      return l
    }

    this.protocolInput = document.createElement('select')
    for (const [value, text] of [
      ['ftp', 'FTP'],
      ['sftp', 'SFTP (SSH)']
    ]) {
      const o = document.createElement('option')
      o.value = value
      o.textContent = text
      this.protocolInput.appendChild(o)
    }
    this.protocolInput.onchange = () => this.updateProtocol()

    // the saved-accounts picker: filled on open() from storage, choosing one
    // fills the whole form; hidden when nothing is saved
    this.accInput = document.createElement('select')
    this.accInput.onchange = () => this.onAccChange()

    this.hostInput = document.createElement('input')
    this.hostInput.type = 'text'
    this.hostInput.required = true
    this.hostInput.placeholder = '127.0.0.1'

    this.portInput = document.createElement('input')
    this.portInput.type = 'number'
    this.portInput.min = '1'
    this.portInput.max = '65535'
    this.portInput.value = '21'

    this.userInput = document.createElement('input')
    this.userInput.type = 'text'
    this.userInput.value = 'anonymous'

    this.passInput = document.createElement('input')
    this.passInput.type = 'password'

    this.secureInput = document.createElement('select')
    for (const [value, text] of [
      ['auto', 'auto (plain, upgrade with AUTH)'],
      ['explicit', 'explicit FTPS (AUTH TLS)'],
      ['implicit', 'implicit FTPS (TLS on 990)'],
      ['none', 'plain']
    ]) {
      const o = document.createElement('option')
      o.value = value
      o.textContent = text
      this.secureInput.appendChild(o)
    }
    this.secureInput.value = 'auto'

    // sftp-only key auth: the private key (openssh text) and its decrypting
    // passphrase; both optional — password-only sftp accounts leave them
    // untouched
    this.keyInput = document.createElement('textarea')
    this.keyInput.rows = 3
    this.keyInput.placeholder = 'optional: openssh private key'

    this.keyPassInput = document.createElement('input')
    this.keyPassInput.type = 'password'

    this.selfSignedInput = document.createElement('input')
    this.selfSignedInput.type = 'checkbox'

    this.connectButton = document.createElement('button')
    this.connectButton.textContent = 'Connect'
    this.connectButton.type = 'submit'

    this.saveButton = document.createElement('button')
    this.saveButton.textContent = 'Save'
    this.saveButton.type = 'button'
    this.saveButton.onclick = () => this.onSave()

    const cancel = document.createElement('button')
    cancel.textContent = 'Cancel'
    cancel.type = 'button'
    cancel.onclick = () => this.resolve(null)

    const footer = document.createElement('div')
    footer.className = 'cn-footer'
    footer.append(cancel, this.saveButton, this.connectButton)

    this.form = document.createElement('form')
    this.form.setAttribute('method', 'dialog')
    const selfSignedField = mkField('')
    selfSignedField.append(this.selfSignedInput,
      document.createTextNode(' allow self-signed certificates'))
    selfSignedField.classList.add('cn-check')
    // keep the protocol-dependent fields so updateProtocol() can show or
    // hide them: FTP carries the TLS options, SFTP the key material
    this.accField = field('saved account', this.accInput)
    this.secureField = field('security', this.secureInput)
    this.selfSignedField = selfSignedField
    this.keyField = field('private key', this.keyInput)
    this.keyPassField = field('key passphrase', this.keyPassInput)
    this.form.append(legend, this.accountLine, this.accField,
      field('protocol', this.protocolInput),
      field('host', this.hostInput), field('port', this.portInput),
      field('user', this.userInput), field('password', this.passInput),
      this.secureField, selfSignedField, this.keyField, this.keyPassField,
      this.status, footer)
    this.form.onsubmit = () => this.resolve(this.collect())
    this.updateProtocol()

    // Esc routes through resolve(null) like the Cancel button
    this.dialog.addEventListener('cancel', (e) => {
      e.preventDefault()
      this.resolve(null)
    })

    this.append(this.form)
  }

  // show/hide the protocol-dependent fields: FTP needs the TLS options,
  // SFTP the key material (always SSH-encrypted). the port swaps between
  // the two defaults when it still sits on one of them.
  updateProtocol() {
    const sftp = this.protocolInput.value === 'sftp'
    this.secureField.hidden = sftp
    this.selfSignedField.hidden = sftp
    this.keyField.hidden = !sftp
    this.keyPassField.hidden = !sftp
    this.hostInput.placeholder = sftp ? 'shell.example.com' : '127.0.0.1'
    const port = parseInt(this.portInput.value, 10)
    if (port === 21 && sftp) {
      this.portInput.value = '22'
    }
    if (port === 22 && !sftp) {
      this.portInput.value = '21'
    }
  }

  // plain connection options fed into api.connect(); an empty host
  // (hitting Enter before filling anything) resolves null. the sftp-only
  // key fields are only carried for sftp accounts so they never leak into
  // a plain ftp connect or its saved record.
  collect() {
    const host = this.hostInput.value.trim()
    if (!host) {
      return null
    }
    const opts = {
      host,
      port: parseInt(this.portInput.value, 10) ||
        (this.protocolInput.value === 'sftp' ? 22 : 21),
      user: this.userInput.value.trim() || 'anonymous',
      password: this.passInput.value,
      secure: this.secureInput.value,
      allowSelfSigned: this.selfSignedInput.checked
    }
    if (this.protocolInput.value === 'sftp') {
      opts.protocol = 'sftp'
      opts.privateKey = this.keyInput.value.trim()
      opts.passphrase = this.keyPassInput.value
    }
    // the picked saved account (null on manual entry) — onSave() uses it to
    // overwrite that exact account instead of guessing by host/port/user
    if (this.currentAcc) {
      opts.accountId = this.currentAcc.id
    }
    return opts
  }

  // the master for this session, asked for once per use through prompt-view:
  //   string  unlocked master
  //   null    no master set — saved passwords are plain text
  //   false   master set but the user cancelled unlocking
  async ensureMaster() {
    const verifier = await getVerifier()
    if (!verifier) {
      return null
    }
    let master = await getSessionMaster()
    while (!master) {
      let pass = null
      try {
        pass = await promptView().ask('master password', {
          password: true,
          placeholder: 'needed to open saved accounts'
        })
      }
      catch {
        return false // prompt cancelled: stay locked
      }
      if (await verifyMaster(pass, verifier)) {
        master = pass
        await putSessionMaster(pass)
      }
    }
    return master
  }

  // fill every field from one saved account (acc null = the manual option:
  // keep whatever is typed, drop the no-longer-guaranteed secrets and the
  // caption); the password and sftp key material are decrypted with the
  // master ('' when that fails or is locked)
  async applyAccount(master, acc) {
    this.currentAcc = acc || null
    if (!acc) {
      this.passInput.value = ''
      this.keyInput.value = ''
      this.keyPassInput.value = ''
      this.accountLine.textContent = ''
      return
    }
    this.protocolInput.value = acc.protocol === 'sftp' ? 'sftp' : 'ftp'
    this.updateProtocol()
    this.hostInput.value = acc.host
    this.portInput.value = acc.port
    this.userInput.value = acc.user
    this.passInput.value = await getAccountPassword(acc, master)
    if (acc.secure) {
      this.secureInput.value = acc.secure
    }
    this.selfSignedInput.checked = !!acc.allowSelfSigned
    if (acc.protocol === 'sftp') {
      const {privateKey, passphrase} = await getAccountSftpSecrets(acc, master)
      this.keyInput.value = privateKey
      this.keyPassInput.value = passphrase
    }
    this.accountLine.textContent = acc.name ? 'saved account: ' + acc.name : ''
  }

  // the saved-accounts picker changed: fill the form from the picked
  // account, or switch it over to manual entry
  onAccChange() {
    const acc = (this.accounts || [])
      .find((a) => a.id === this.accInput.value) || null
    this.applyAccount(this._master, acc)
  }

  // fill the saved-accounts select and pick the default account (primary as
  // old — the earliest created one acts as fallback). without saved accounts
  // the select stays hidden and the form simply starts manual.
  async loadAccounts(master) {
    this.accounts = await getAccounts()
    this.currentAcc = null
    this.accField.hidden = !this.accounts.length
    this.accInput.replaceChildren()
    const manual = document.createElement('option')
    manual.value = ''
    manual.textContent = '— manual —'
    this.accInput.appendChild(manual)
    for (const acc of this.accounts) {
      const o = document.createElement('option')
      o.value = acc.id
      o.textContent = accLabel(acc)
      this.accInput.appendChild(o)
    }
    const primary = await getPrimaryAccount()
    if (this.accounts.length && primary) {
      this.accInput.value = primary.id
      await this.applyAccount(master, primary)
    }
  }

  // store the form as an account; the dialog stays open so the user can
  // connect right after. the name comes from prompt-view, a duplicate
  // host/port/user can be overwritten or saved alongside.
  async onSave() {
    const opts = this.collect()
    if (!opts) {
      this.fail('the url is required to save an account')
      return
    }
    const master = await this.ensureMaster()
    if (master === false) {
      this.fail('master password not unlocked — account not saved')
      return
    }
    const fallback = opts.user + '@' + opts.host + ':' + opts.port
    const current = this.currentAcc
    let name = ''
    try {
      name = await promptView().ask('name for this account', {
        placeholder: (current && current.name) || fallback
      })
    }
    catch {
      return // name prompt cancelled: no save
    }
    // a picker-chosen account is overwritten as-is; manual entry falls back
    // to the host/port/user duplicate ask (overwrite or save alongside)
    let id = null
    if (current) {
      id = current.id
    }
    else {
      const dupe = (await getAccounts()).find((a) =>
        a.host === opts.host && a.port === opts.port && a.user === opts.user)
      if (dupe) {
        let choice = null
        try {
          choice = await promptView().askChoice(`an account for ${fallback} already exists`, [
            {value: 'overwrite', label: `overwrite "${dupe.name || fallback}"`},
            {value: 'new', label: 'save as new'}
          ])
        }
        catch {
          return // cancelled: no save
        }
        if (choice === 'overwrite') {
          id = dupe.id
        }
      }
    }
    const acc = await saveAccount({
      name: name.trim() || fallback,
      host: opts.host,
      port: opts.port,
      user: opts.user,
      protocol: opts.protocol || 'ftp',
      secure: opts.secure,
      allowSelfSigned: opts.allowSelfSigned,
      privateKey: opts.privateKey || '',
      passphrase: opts.passphrase || ''
    }, opts.password, master, id)
    this.accountLine.textContent = 'saved account: ' + acc.name
    this.status.classList.remove('cn-error')
    this.status.textContent = 'saved as "' + acc.name + '"' +
      (master ? '' : ' (password plain — set a master password in the options to encrypt it)')
  }

  fail(msg) {
    this.status.classList.add('cn-error')
    this.status.textContent = msg
  }

  // resolve with the connection options (or null)
  resolve(value) {
    const fn = this.onDone
    this.onDone = null
    if (fn) {
      fn(value)
    }
    this.dialog.close()
  }

  // show the form and wait; resolves with opts or null on cancel. when a
  // master password is set the user is asked for it first (once), then the
  // primary saved account prefills the form.
  async open() {
    this.passInput.value = ''
    this.keyInput.value = ''
    this.keyPassInput.value = ''
    this.selfSignedInput.checked = false
    this.secureInput.value = 'auto'
    this.protocolInput.value = 'ftp'
    this.updateProtocol()
    this.accountLine.textContent = ''
    this.accField.hidden = true // loadAccounts() shows it when accounts exist
    this.status.textContent = ''
    this.status.classList.remove('cn-error')
    const master = await this.ensureMaster()
    this._master = master
    if (master === false) {
      this.fail('master password not unlocked — starting without a saved account')
    }
    else {
      await this.loadAccounts(master)
    }
    return new Promise((resolve) => {
      this.onDone = resolve
      this.dialog.showModal()
      this.accField.hidden ? this.hostInput : this.accInput.focus()
    })
  }
}

customElements.define('connect-view', ConnectView)

// open the single connect dialog; keeps the dialog element (index.html)
// and the form out of dir-view itself
export function openConnect() {
  const el = document.querySelector('#connect-dialog connect-view')
  if (!el) {
    return Promise.resolve(null)
  }
  return el.open()
}
