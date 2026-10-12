// accounts-view.js — saved ftp/sftp accounts for the Accounts tab.
//
// The form stores the account through core/accounts/storage.mjs: the
// metadata (name, host, port, user, protocol, secure, allowSelfSigned)
// under user.acc.<id>, the password under user.pass.<id> — AES-GCM
// encrypted with the master password when one is set and unlocked for this
// session, plain text when no master exists (passwords.mjs re-encrypts on
// master changes). sftp accounts additionally carry their optional private
// key / key passphrase in the same encrypted slots (user.pass.<id>.key /
// .pph). The security select only applies to the ftp side (auto upgrades
// to TLS with AUTH); sftp is always SSH-encrypted so it hides both TLS
// fields and shows the key material instead. The list below shows every
// saved account with a primary radio (the primary account prefills the
// client's connect dialog) and a remove button.

import {
  getAccounts, getPrimaryAccount, getVerifier, getSessionMaster,
  saveAccount, setPrimary, removeAccount
} from '../../../core/accounts/storage.mjs';
import {button, fail, field, footer, note, run, say, title} from '../ui.js';

// the security choices of the FTP side, mirroring the client's connect
// dialog ('auto' upgrades to TLS when the server supports AUTH); hidden
// for sftp, which is always SSH-encrypted
const SECURITY_CHOICES = [
  ['auto', 'auto (plain, upgrade with AUTH)'],
  ['explicit', 'explicit FTPS (AUTH TLS)'],
  ['implicit', 'implicit FTPS (TLS on 990)'],
  ['none', 'plain']
]

class AccountsView extends HTMLElement {
  connectedCallback() {
    this.renderForm()
    this.list = document.createElement('div')
    this.list.className = 'op-list'
    this.append(this.list)
    this.refresh()
  }

  // rebuild the account list; also called by the shell whenever the
  // Accounts tab comes forward
  async refresh() {
    const [accounts, primary] = await Promise.all([getAccounts(), getPrimaryAccount()])
    this.list.replaceChildren()

    const heading = document.createElement('div')
    heading.className = 'op-list-title'
    heading.textContent = accounts.length
      ? `saved accounts (${accounts.length})`
      : 'no saved accounts'
    this.list.append(heading)

    if (accounts.length) {
      const hint = document.createElement('div')
      hint.className = 'op-list-hint'
      hint.textContent = 'the primary account prefills the connect dialog in the client'
      this.list.append(hint)
    }

    for (const acc of accounts) {
      this.list.append(this.row(acc, !!primary && primary.id === acc.id))
    }
  }

  // one listing row: primary radio, display label, remove button
  row(acc, isPrimary) {
    const rowEl = document.createElement('div')
    rowEl.className = 'op-row'

    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'op-primary'
    radio.checked = isPrimary
    radio.title = 'primary account'
    radio.onchange = () => this.onPrimary(acc)

    const label = document.createElement('span')
    label.className = 'op-row-label'
    label.textContent = this.label(acc)

    rowEl.append(radio, label, button('Remove', () => this.onRemove(acc)))
    return rowEl
  }

  // display label: the name when it says more than the address already does
  label(acc) {
    const proto = acc.protocol === 'sftp' ? 'sftp' : 'ftp'
    const addr = `${proto}://${acc.user}@${acc.host}:${acc.port}`
    return acc.name && acc.name !== addr ? `${acc.name} (${addr})` : addr
  }

  async onPrimary(acc) {
    await setPrimary(acc.id)
    await this.refresh()
  }

  async onRemove(acc) {
    if (!confirm(`remove the account ${this.label(acc)}?`)) {
      return
    }
    await removeAccount(acc)
    await this.refresh()
  }

  // a checkbox row in the op-check style: two-column label + checkbox with
  // its trailing description text
  check(labelText, input, text) {
    const row = document.createElement('label')
    row.className = 'op-field op-check'
    const span = document.createElement('span')
    span.className = 'op-label'
    span.textContent = labelText
    row.append(span, input, document.createTextNode(text))
    return row
  }

  renderForm() {
    this.nameInput = document.createElement('input')
    this.nameInput.type = 'text'
    this.nameInput.placeholder = 'my server (optional)'
    this.hostInput = document.createElement('input')
    this.hostInput.type = 'text'
    this.hostInput.placeholder = 'ftp.example.com'
    this.portInput = document.createElement('input')
    this.portInput.type = 'number'
    this.portInput.min = '1'
    this.portInput.max = '65535'
    this.portInput.value = '21'
    this.protocolInput = document.createElement('select')
    for (const [value, text] of [['ftp', 'FTP'], ['sftp', 'SFTP (SSH)']]) {
      const o = document.createElement('option')
      o.value = value
      o.textContent = text
      this.protocolInput.appendChild(o)
    }
    this.protocolInput.onchange = () => this.updateProtocol()
    this.userInput = document.createElement('input')
    this.userInput.type = 'text'
    this.userInput.placeholder = 'anonymous'
    this.passInput = document.createElement('input')
    this.passInput.type = 'password'
    this.secureInput = document.createElement('select')
    for (const [value, text] of SECURITY_CHOICES) {
      const o = document.createElement('option')
      o.value = value
      o.textContent = text
      this.secureInput.appendChild(o)
    }
    this.secureInput.value = 'auto'
    this.selfSignedInput = document.createElement('input')
    this.selfSignedInput.type = 'checkbox'
    this.keyInput = document.createElement('textarea')
    this.keyInput.rows = 3
    this.keyInput.placeholder = 'optional: openssh private key'
    this.keyPassInput = document.createElement('input')
    this.keyPassInput.type = 'password'

    // protocol-dependent fields; updateProtocol() flips hidden on both
    this.secureField = field('security', this.secureInput)
    this.selfSignedField = this.check('self-signed', this.selfSignedInput,
      'allow self-signed certificates')
    this.keyField = field('private key', this.keyInput)
    this.keyPassField = field('key passphrase', this.keyPassInput)

    this.form = document.createElement('form')
    this.form.onsubmit = (e) => e.preventDefault()
    this.form.append(
      title('add ftp/sftp account'),
      note('the password and sftp key material are stored encrypted once a ' +
        'master password is set on the General tab (and unlocked); without ' +
        'one they are plain text.'),
      field('name', this.nameInput),
      field('url', this.hostInput),
      field('port', this.portInput),
      field('protocol', this.protocolInput),
      field('username', this.userInput),
      field('password', this.passInput),
      this.secureField,
      this.selfSignedField,
      this.keyField,
      this.keyPassField,
      footer(button('Save account', () => this.onSave()))
    )
    this.updateProtocol()
    this.append(this.form)
  }

  // FTP shows the TLS options, SFTP the key material (always SSH-encrypted);
  // the port swaps between the two defaults when it still sits on one of them
  updateProtocol() {
    const sftp = this.protocolInput.value === 'sftp'
    this.secureField.hidden = sftp
    this.selfSignedField.hidden = sftp
    this.keyField.hidden = !sftp
    this.keyPassField.hidden = !sftp
    this.hostInput.placeholder = sftp ? 'shell.example.com' : 'ftp.example.com'
    const port = parseInt(this.portInput.value, 10)
    if (port === 21 && sftp) {
      this.portInput.value = '22'
    }
    if (port === 22 && !sftp) {
      this.portInput.value = '21'
    }
  }

  async onSave() {
    // validate before touching storage; an empty password is allowed
    // (anonymous logins and password-only sftp accounts)
    const name = this.nameInput.value.trim()
    const host = this.hostInput.value.trim()
    const port = parseInt(this.portInput.value, 10)
    const protocol = this.protocolInput.value
    const sftp = protocol === 'sftp'
    const password = this.passInput.value
    if (!host) {
      fail(this.form, 'the url is required')
      return
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      fail(this.form, 'the port must be a number between 1 and 65535')
      return
    }
    if (!this.userInput.value.trim()) {
      fail(this.form, 'the username is required')
      return
    }

    await run(this.form, async () => {
      // encrypting needs the master; a set-but-locked master cannot be used,
      // and silently storing plain text would defeat it
      const verifier = await getVerifier()
      let master = null
      if (verifier) {
        master = await getSessionMaster()
        if (!master) {
          throw new Error('master password is set but locked — unlock it on the General tab first')
        }
      }

      const accounts = await getAccounts()
      if (accounts.some((a) => a.host === host && a.port === port && a.user === this.userInput.value.trim()) &&
          !confirm(`an account for ${this.userInput.value.trim()}@${host}:${port} already exists — save a duplicate?`)) {
        return
      }

      const acc = await saveAccount({
        name,
        host,
        port,
        user: this.userInput.value.trim(),
        protocol,
        // sftp is always SSH-encrypted — no TLS metadata at all; the ftp
        // side carries the security choice and the self-signed flag
        ...(sftp ? {} : {
          secure: this.secureInput.value,
          allowSelfSigned: this.selfSignedInput.checked
        }),
        // never reach the metadata: storage.mjs moves them to the encrypted
        // secret slots beside the password
        privateKey: sftp ? this.keyInput.value.trim() : '',
        passphrase: sftp ? this.keyPassInput.value : ''
      }, password, master)
      this.nameInput.value = ''
      this.hostInput.value = ''
      this.userInput.value = ''
      this.passInput.value = ''
      this.keyInput.value = ''
      this.keyPassInput.value = ''
      this.secureInput.value = 'auto'
      this.selfSignedInput.checked = false
      this.protocolInput.value = 'ftp'
      this.updateProtocol()
      this.portInput.value = '21'
      await this.refresh()
      say(this.form, `account ${this.label(acc)} saved` + (master
        ? ' (secrets encrypted)'
        : ' (secrets in plain text — set a master password on the General tab to encrypt them)'))
    })
  }
}

customElements.define('accounts-view', AccountsView)
