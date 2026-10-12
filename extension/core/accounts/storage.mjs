// storage.mjs — saved ftp accounts and the master password verifier, shared
// by the options page and the client.
//
// Layout in chrome.storage.local:
//   user.master     master password verifier (pb1.<iter>.<salt>.<hash> from
//                   hashMaster()), absent when no master password is set
//   user.acc.<id>   saved account {id, name, host, port, user, protocol,
//                   secure, allowSelfSigned, created, primary?} — name/
//                   protocol/secure/allowSelfSigned/created are optional
//                   (missing protocol/secure means ftp/auto); primary marks
//                   the account that prefills the client's connect dialog
//   user.pass.<id>  saved account password — enc1. encrypted when a master is
//                   set, plain text otherwise (passwords.mjs owns that format
//                   and re-encrypts every entry on master changes)
//   user.pass.<id>.key / .pph   sftp key material of the account (private
//                   key text / key passphrase) — same formats as user.pass.
//   user.hostkey.<host>@<port>  array of SHA-256 sftp host-key fingerprints
//                   the user accepted for that server (tofu). plain
//                   metadata — a fingerprint is public; only the trust
//                   decision is made client-side in the connect flow.
//   user.view       directory-pane column switches, one set per adapter:
//                   {columns: {local: {...}, remote: {...}}} — keys
//                   missing from a stored entry fall back to the defaults
//                   in VIEW_DEFAULTS (size and lastModified on, the rest
//                   off); the remote half additionally carries permissions
//                   and ownerGroup
// chrome.storage.session holds the plain master under the same user.master
// key: written once the master has been confirmed against the verifier (set,
// change or unlock), read by the views, gone when the browser closes.

import {isEncrypted, encryptText, decryptText} from './crypto.mjs';
import {PASS_PREFIX} from './passwords.mjs';

const MASTER_KEY = 'user.master';
const ACC_PREFIX = 'user.acc.';
const HK_PREFIX = 'user.hostkey.';

// user.view — directory-pane column switches, one set per adapter:
//   columns.local  {size, type, lastModified} — the File System Access API
//                  exposes no posix metadata, so permissions/owner/group
//                  are not offered for local panes at all
//   columns.remote {size, permissions, type, lastModified, ownerGroup}
// switches missing from a stored entry fall back to VIEW_DEFAULTS (file
// size and last modified on, everything else off). older entries stored
// boolean flags straight on columns — they are folded into both panes on
// load and rewritten in the split shape by the next setView.
const VIEW_KEY = 'user.view';
const VIEW_TYPES = ['local', 'remote'];
const VIEW_DEFAULTS = {
  columns: {
    local: {
      size: true,
      type: false,
      lastModified: true
    },
    remote: {
      size: true,
      permissions: false,
      type: false,
      lastModified: true,
      ownerGroup: false
    }
  }
};

// the pb1. verifier, or null when no master password is set
async function getVerifier() {
  const got = await chrome.storage.local.get(MASTER_KEY);
  return got[MASTER_KEY] || null;
}

// write (or clear) the verifier in chrome.storage.local
async function setVerifier(verifier) {
  if (verifier) {
    await chrome.storage.local.set({[MASTER_KEY]: verifier});
  }
  else {
    await chrome.storage.local.remove(MASTER_KEY);
  }
}

// the plain master for this browser session, or null while locked
async function getSessionMaster() {
  const got = await chrome.storage.session.get(MASTER_KEY);
  return got[MASTER_KEY] || null;
}

async function putSessionMaster(master) {
  await chrome.storage.session.set({[MASTER_KEY]: master});
}

async function dropSessionMaster() {
  await chrome.storage.session.remove(MASTER_KEY);
}

// every saved account, sorted by display label (name, falling back to
// user@host:port); each entry carries its full storage key so the caller can
// remove it together with its password
async function getAccounts() {
  const all = await chrome.storage.local.get(null);
  const accounts = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(ACC_PREFIX) && value && typeof value === 'object') {
      accounts.push({...value, key});
    }
  }
  const label = (a) => a.name || `${a.user}@${a.host}:${a.port}`;
  accounts.sort((a, b) =>
    label(a).localeCompare(label(b)) ||
    String(a.host).localeCompare(String(b.host)) ||
    (a.port - b.port) ||
    String(a.user).localeCompare(String(b.user)));
  return accounts;
}

// the account marked primary, falling back to the earliest created one
// (accounts saved before the flag existed) and then to the first in list
// order; null when nothing is saved
async function getPrimaryAccount() {
  const accounts = await getAccounts();
  if (!accounts.length) {
    return null;
  }
  return accounts.find((a) => a.primary) ||
    [...accounts].sort((a, b) => (a.created || 0) - (b.created || 0))[0];
}

// insert or update an account. data carries the metadata ({name, host, port,
// user, protocol, secure, allowSelfSigned}) plus — for sftp — the optional
// privateKey/passphrase, which never touch the metadata: they are stored
// under the suffixed keys beside the password and encrypted with the master
// exactly the same way. a missing id creates one, and the first account ever
// saved becomes the primary one. overwriting keeps the old created timestamp
// and primary flag. returns the stored account (without the internal storage
// key).
async function saveAccount(data, password, master, id) {
  const accounts = await getAccounts();
  let primary = false;
  let created = Date.now();
  if (id) {
    const old = accounts.find((a) => a.id === id);
    if (old) {
      primary = !!old.primary;
      if (old.created) {
        created = old.created;
      }
    }
  }
  else {
    id = crypto.randomUUID();
    primary = !accounts.length;
  }
  const {privateKey = '', passphrase = '', ...meta} = data || {};
  const acc = {...meta, id, created, primary};
  // secrets follow the password format: enc1. encrypted when a master is
  // given (passwords.mjs re-encrypts them on master changes), plain text
  // when none is set
  const secret = (value) => master ?
    encryptText(String(value ?? ''), master) : String(value ?? '');
  await chrome.storage.local.set({
    [ACC_PREFIX + id]: acc,
    [PASS_PREFIX + id]: master ? await encryptText(String(password ?? ''), master) : String(password ?? ''),
    [PASS_PREFIX + id + '.key']: await secret(privateKey),
    [PASS_PREFIX + id + '.pph']: await secret(passphrase)
  });
  return acc;
}

// mark exactly one account primary (a null id clears the marker everywhere
// and the fallback in getPrimaryAccount() takes over)
async function setPrimary(id) {
  const writes = {};
  for (const {key, ...acc} of await getAccounts()) {
    const want = acc.id === id;
    if (!!acc.primary !== want) {
      if (want) {
        acc.primary = true;
      }
      else {
        delete acc.primary;
      }
      writes[key] = acc;
    }
  }
  if (Object.keys(writes).length) {
    await chrome.storage.local.set(writes);
  }
}

// the stored password for an account: plain text comes back as is, encrypted
// values are decrypted with the master — and come back as '' when no master
// is given (locked) or the value cannot be decrypted
async function getAccountPassword(acc, master) {
  const got = await chrome.storage.local.get(PASS_PREFIX + acc.id);
  const stored = got[PASS_PREFIX + acc.id];
  return unlockSecret(stored, master);
}

// sftp key material of an account ({privateKey, passphrase}), stored under
// the suffixed keys and unlocked like the password above ('' when absent,
// locked or undecryptable)
async function getAccountSftpSecrets(acc, master) {
  const sfx = PASS_PREFIX + acc.id;
  const got = await chrome.storage.local.get([sfx + '.key', sfx + '.pph']);
  return {
    privateKey: await unlockSecret(got[sfx + '.key'], master),
    passphrase: await unlockSecret(got[sfx + '.pph'], master)
  };
}

// shared unlock logic for the plain/enc1. password slots (getAccountPassword
// and getAccountSftpSecrets)
async function unlockSecret(stored, master) {
  if (typeof stored !== 'string' || !stored) {
    return '';
  }
  if (!isEncrypted(stored)) {
    return stored;
  }
  if (!master) {
    return '';
  }
  try {
    return await decryptText(stored, master);
  }
  catch {
    return '';
  }
}

// normalize a raw stored user.view into the split two-pane shape. an entry
// from before the split holds booleans straight on columns — its flags are
// folded into BOTH panes (permissions/ownerGroup only reach remote, the
// keys local never gets). returns null when nothing usable is stored.
function splitStoredView(v) {
  const cols = v && typeof v === 'object' && v.columns &&
    typeof v.columns === 'object' ? v.columns : null;
  if (cols) {
    const both = VIEW_TYPES.every((t) =>
      cols[t] && typeof cols[t] === 'object');
    if (both) {
      return {columns: {...cols}};
    }
    if (typeof cols.size === 'boolean') { // legacy flat shape
      const folded = {};
      for (const t of VIEW_TYPES) {
        folded[t] = {};
        for (const key of Object.keys(VIEW_DEFAULTS.columns[t])) {
          if (typeof cols[key] === 'boolean') {
            folded[t][key] = cols[key];
          }
        }
      }
      return {columns: folded};
    }
  }
  return null;
}

// the column switches of one pane type ('local' | 'remote'), defaults
// filled in for keys missing from the stored entry
async function getView(type) {
  const got = await chrome.storage.local.get(VIEW_KEY);
  const stored = splitStoredView(got[VIEW_KEY]);
  const parts = stored ? stored.columns[type] : {};
  return {columns: {...VIEW_DEFAULTS.columns[type], ...parts}};
}

// replace the stored column switches of one pane type ('local' | 'remote');
// the other pane's half survives. a legacy flat entry is rewritten here in
// the split shape together with this write.
async function setView(type, columns) {
  const got = await chrome.storage.local.get(VIEW_KEY);
  const stored = splitStoredView(got[VIEW_KEY]);
  const fresh = {columns: {}};
  for (const t of VIEW_TYPES) {
    fresh.columns[t] = stored
      ? stored.columns[t]
      : {...VIEW_DEFAULTS.columns[t]};
  }
  fresh.columns[type] = columns;
  await chrome.storage.local.set({[VIEW_KEY]: fresh});
}

// the host-key fingerprints trusted for host:port (tofu); [] when nothing
// was accepted yet or the entry is unusable
async function getHostkeys(host, port) {
  const key = HK_PREFIX + host + '@' + port;
  const got = await chrome.storage.local.get(key);
  const list = got[key];
  return Array.isArray(list) ?
    list.filter((v) => typeof v === 'string' && v) : [];
}

// remember one more accepted fingerprint for host:port; appending (never
// replacing) keeps servers alive that offer several host-key algorithms
async function addHostkey(host, port, fingerprint) {
  const fp = String(fingerprint || '').trim();
  if (!fp) {
    return getHostkeys(host, port);
  }
  const known = await getHostkeys(host, port);
  if (known.includes(fp)) {
    return known;
  }
  known.push(fp);
  await chrome.storage.local.set({[HK_PREFIX + host + '@' + port]: known});
  return known;
}

// drop an account together with its password and sftp key material
async function removeAccount(acc) {
  const sfx = PASS_PREFIX + acc.id;
  await chrome.storage.local.remove([
    acc.key || ACC_PREFIX + acc.id,
    sfx, sfx + '.key', sfx + '.pph'
  ]);
}

export {
  MASTER_KEY,
  ACC_PREFIX,
  PASS_PREFIX,
  VIEW_KEY,
  VIEW_TYPES,
  VIEW_DEFAULTS,
  getView,
  setView,
  getVerifier,
  setVerifier,
  getSessionMaster,
  putSessionMaster,
  dropSessionMaster,
  getAccounts,
  getPrimaryAccount,
  saveAccount,
  setPrimary,
  getAccountPassword,
  getAccountSftpSecrets,
  getHostkeys,
  addHostkey,
  removeAccount
};
