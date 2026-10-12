// general-view.js — master password management for the General tab.
//
// The master password is optional. When it is set, saved account passwords
// are AES-GCM encrypted (core/accounts/crypto.mjs) and chrome.storage.local
// keeps only a pbkdf2 verifier (user.master, pb1.<iter>.<salt>.<hash>); the
// plain master lives in chrome.storage.session for the current browser
// session and never touches disk. The view renders one of three states:
//   unset          set form (new + confirm, minimum 8 characters)
//   set, locked    unlock form (confirm the master once per session)
//   set, unlocked  change form (current + new + confirm) plus remove
// Changing or removing re-encrypts (or decrypts) every user.pass.* entry
// through reencryptStoredPasswords(), and both demand the current password
// first: nothing is written until verifyMaster() confirms it.

// Below the master-password form the view appends per-adapter switch
// sections for the directory panes (user.view through getView/setView):
// "local directory view" (file size, file type, last modified — the
// File System Access API exposes no permissions/owner/group) and "remote
// directory view" (adds file permissions and owner/group). every switch
// is optional; file size and last modified default to on, the rest off.
// toggling saves instantly and both panes re-render live via
// chrome.storage.onChanged.

import {hashMaster, verifyMaster} from '/core/accounts/crypto.mjs';
import {reencryptStoredPasswords} from '/core/accounts/passwords.mjs';
import {
  getVerifier, getSessionMaster, putSessionMaster, dropSessionMaster, setVerifier,
  getView, setView
} from '../../../core/accounts/storage.mjs';
import {button, field, fail, footer, note, run, say, title} from '../ui.js';

const MIN_MASTER_LEN = 8;

class GeneralView extends HTMLElement {
  connectedCallback() {
    this.form = document.createElement('form')
    this.form.onsubmit = (e) => e.preventDefault()
    this.append(this.form)
    this.refresh()
  }

  // reload the state (verifier + session master) and re-render; also called
  // by the shell every time the General tab comes forward
  async refresh() {
    this.verifier = await getVerifier()
    this.sessionMaster = this.verifier ? await getSessionMaster() : null
    this.render()
  }

  render() {
    this.form.replaceChildren()
    if (!this.verifier) {
      this.renderSet()
    }
    else if (!this.sessionMaster) {
      this.renderUnlock()
    }
    else {
      this.renderChange()
    }
    this.renderColumns()
  }

  // the per-adapter switch sections below the master-password form: pane
  // type, heading, row labels ([storage key, visible text])
  viewSections = [
    ['local', 'local directory view', [
      ['size', 'file size'],
      ['type', 'file type (eg. CSS)'],
      ['lastModified', 'last modified']
    ]],
    ['remote', 'remote directory view', [
      ['size', 'file size'],
      ['permissions', 'file permissions (eg. -rw-rw-r--)'],
      ['type', 'file type (eg. CSS)'],
      ['lastModified', 'last modified'],
      ['ownerGroup', 'owner / group']
    ]]
  ];

  async renderColumns() {
    this.form.append(
      title('directory view'),
      note('columns shown in the directory panes. permissions and ' +
        'owner/group are only available on remote (ftp) servers. size ' +
        'and last modified default to on, the rest to off.')
    )
    // each checkbox saves on toggle against a fresh getView() so fast
    // toggles and concurrent remote edits of user.view stay consistent
    for (const [type, heading, rows] of this.viewSections) {
      const view = await getView(type)
      this.form.append(title(heading))
      for (const [key, label] of rows) {
        const row = document.createElement('label')
        row.className = 'op-check'
        const input = document.createElement('input')
        input.type = 'checkbox'
        input.checked = !!view.columns[key]
        const span = document.createElement('span')
        span.textContent = label
        row.append(input, span)
        input.onchange = async () => {
          const next = await getView(type)
          next.columns[key] = input.checked
          try {
            await setView(type, next.columns)
          }
          catch (e) {
            fail(this.form, e.message || String(e))
            input.checked = !input.checked // revert the failed toggle
            return
          }
          say(this.form, 'saved — the directory panes update immediately')
        }
        this.form.append(row)
      }
    }
  }

  // no master yet: create one (the feature is optional, so this is default)
  renderSet() {
    this.newInput = document.createElement('input')
    this.newInput.type = 'password'
    this.confirmInput = document.createElement('input')
    this.confirmInput.type = 'password'

    this.form.append(
      title('master password (optional)'),
      note('encrypt the passwords of saved ftp accounts with a master ' +
        `password. only a hash is stored. at least ${MIN_MASTER_LEN} characters.`),
      field('new password', this.newInput),
      field('confirm', this.confirmInput),
      footer(button('Set master password', () => this.onSet()))
    )
  }

  // master exists but this browser session has not confirmed it yet
  renderUnlock() {
    this.unlockInput = document.createElement('input')
    this.unlockInput.type = 'password'

    this.form.append(
      title('master password'),
      note('a master password is set. enter it once per browser session so ' +
        'saved account passwords can be encrypted and decrypted.'),
      field('password', this.unlockInput),
      footer(button('Unlock', () => this.onUnlock()))
    )
  }

  // master exists and is confirmed for this session: change or remove it
  renderChange() {
    this.currentInput = document.createElement('input')
    this.currentInput.type = 'password'
    this.newInput = document.createElement('input')
    this.newInput.type = 'password'
    this.confirmInput = document.createElement('input')
    this.confirmInput.type = 'password'

    this.form.append(
      title('master password'),
      note('changing the master password decrypts every saved password with ' +
        'the current one and re-encrypts it with the new one; removing ' +
        'stores them as plain text again. both need the current password.'),
      field('current password', this.currentInput),
      field('new password', this.newInput),
      field('confirm', this.confirmInput),
      footer(
        button('Remove master password', () => this.onRemove()),
        button('Change master password', () => this.onChange())
      )
    )
  }

  // the new password half of the set/change forms, or null with a message
  validNewMaster() {
    const pass = this.newInput.value
    if (pass.length < MIN_MASTER_LEN) {
      fail(this.form, `the master password needs at least ${MIN_MASTER_LEN} characters`)
      return null
    }
    if (pass !== this.confirmInput.value) {
      fail(this.form, 'the new passwords do not match')
      return null
    }
    return pass
  }

  async onSet() {
    const pass = this.validNewMaster()
    if (!pass) return
    await run(this.form, async () => {
      await setVerifier(await hashMaster(pass))
      await reencryptStoredPasswords(null, pass)
      await putSessionMaster(pass)
      await this.refresh()
      say(this.form, 'master password set — saved account passwords are now encrypted')
    })
  }

  async onUnlock() {
    const pass = this.unlockInput.value
    if (!pass) {
      fail(this.form, 'enter the master password to unlock')
      return
    }
    await run(this.form, async () => {
      if (!(await verifyMaster(pass, this.verifier))) {
        throw new Error('wrong master password')
      }
      await putSessionMaster(pass)
      await this.refresh()
      say(this.form, 'master password unlocked for this browser session')
    })
  }

  async onChange() {
    const pass = this.validNewMaster()
    if (!pass) return
    await run(this.form, async () => {
      const current = this.currentInput.value
      // gate the whole change on the current password: no write until it
      // verifies against the stored verifier
      if (!(await verifyMaster(current, this.verifier))) {
        throw new Error('wrong current master password')
      }
      // verifier first, re-encryption second: reencryptStoredPasswords()
      // leaves values that already decrypt with the target master alone, so
      // an interrupted run is finished by simply retrying
      await setVerifier(await hashMaster(pass))
      await reencryptStoredPasswords(current, pass)
      await putSessionMaster(pass)
      await this.refresh()
      say(this.form, 'master password changed — saved passwords re-encrypted')
    })
  }

  async onRemove() {
    await run(this.form, async () => {
      const current = this.currentInput.value
      if (!(await verifyMaster(current, this.verifier))) {
        throw new Error('wrong current master password')
      }
      await reencryptStoredPasswords(current, null)
      await setVerifier(null)
      await dropSessionMaster()
      await this.refresh()
      say(this.form, 'master password removed — saved passwords are plain text again')
    })
  }
}

customElements.define('general-view', GeneralView)
