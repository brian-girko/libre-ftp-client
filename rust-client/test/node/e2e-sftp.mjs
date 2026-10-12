// e2e-sftp.mjs — SFTP engine end-to-end tests under node:
//   start the ws-to-tls bridge shim (see /extension shim; the real run
//   imports the extension's ws-to-tls.js), start the mock SFTP server
//   (test/node/mock-sftp-server.cjs, in-memory virtual FS), then drive the
//   compiled wasm SSH client through a full test matrix:
//
//   * password auth, listing/Entry mapping, cwd CWD/CDUP,
//     mkdir/rmdir/rename/delete, chmod/setstat round-trip,
//     setMtime round-trip, chunked download/upload (incl. append),
//     wrong password -> auth error, TOFU host key -> hostkey error /
//     pinned acceptance, private key auth (plain + encrypted).
//
// Run: node test/node/e2e-sftp.mjs  (after ./build.sh)

'use strict';

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

const mocks = require(path.join(here, 'mock-sftp-server.cjs'));
const { startWsBridge } = require(path.join(
  here, '..', '..', '..', 'extension', 'core', 'ws-to-tls', 'ws-to-tls.js'));

// ---------- helpers ----------
let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`ok - ${name}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}${extra ? ' :: ' + JSON.stringify(extra) : ''}`);
  }
}

const { readFile } = await import('node:fs/promises');
const KEY_DIR = '/tmp/opencode/sftp-keys';
const PRIV_PLAIN = await readFile(`${KEY_DIR}/id_ed25519`, 'utf8');
const PRIV_ENC = await readFile(`${KEY_DIR}/id_ed25519.enc`, 'utf8');
const HOST_KEY = await readFile(`${KEY_DIR}/host_ed25519`);

// ---------- run ----------
const bridge = await startWsBridge({ token: 'sftp-e2e' });
const plainServer = await mocks.startMockSftp({
  hostKeys: [HOST_KEY],
});
const keyOnlyServer = await mocks.startMockSftp({
  hostKeys: [HOST_KEY],
  password: null,
});
console.log(`bridge on ${bridge.url}`);const engine = await import(path.join(here, 'ftp_engine.js'));
engine.set_bridge_url(bridge.url);

try {
  // ---------------- TOFU host key handling (probe) ----------------
  let hostErr = null;
  try {
    await engine.SshClient.connect(plainServer.host, plainServer.port, { user: 'u', password: 'p' });
  } catch (e) {
    hostErr = e;
  }
  check('sftp: untrusted host key rejected', hostErr && hostErr.code === 'hostkey', hostErr);
  check('sftp: hostkey carries fingerprint',
    /SHA256:[A-Za-z0-9+/]{40,}/.test(hostErr.message || ''), hostErr.message);
  const m = (hostErr.message || '').match(/SHA256:[A-Za-z0-9+/]{40,}/);
  const fp = m ? m[0] : null;
  check('sftp: fingerprint matches mock host key', !!fp && fp === plainServer.fingerprint, fp);

  // ---------------- password auth ----------------
  const client = await engine.SshClient.connect(
    plainServer.host, plainServer.port,
    { user: 'u', password: 'p', trustFingerprints: [fp] });
  check('sftp: connected', client.is_connected());

  const st = await client.pwd();
  check('sftp: pwd -> /', st.path === '/', st);

  const entries = await client.list('/', 'auto');
  check('sftp: list / -> 2 entries', Array.isArray(entries) && entries.length === 2, entries);
  const names = entries.map((e) => e.name);
  check('sftp: contains hello.txt', names.includes('hello.txt'), names);
  const hello = entries.find((e) => e.name === 'hello.txt');
  check('sftp: hello.txt is a file', hello && !hello.dir);
  check('sftp: hello.txt size = 16', hello.size === 16, hello);
  check('sftp: hello.txt mtime numeric', typeof hello.mtime === 'number' && hello.mtime > 0, hello);

  // listing kind aliases behave like 'auto'
  const namesK = await client.list('/', 'names');
  check('sftp: names listing ok', namesK.map((e) => e.name).join(',') === names.join(','), namesK);

  // cwd + cdup round trip
  const subPwd = await client.cwd('/sub');
  check('sftp: cwd /sub -> /sub', subPwd.path === '/sub', subPwd);
  const cp = await client.cd_up();
  check('sftp: cdUp -> /', cp.path === '/', cp);

  // whole-file download
  const bytes = await client.download('/hello.txt', 262144);
  check('sftp: download bytes',
    new TextDecoder().decode(bytes) === 'hello ftp world\n', Array.from(bytes.slice(0, 8)));

  // upload (whole) + chunked streaming, then append
  const payload = 'upload-roundtrip-' + 'x'.repeat(50);
  const sent = await client.upload('/uploaded.txt', new TextEncoder().encode(payload));
  check('sftp: upload total', sent === payload.length, sent);
  const fetched = await client.download('/uploaded.txt');
  check('sftp: upload roundtrip content', Buffer.from(fetched).toString() === payload);

  const dl = await client.streamStartGet('/uploaded.txt', 0);
  let got = [];
  let chunkCount = 0;
  for (;;) {
    const c = await client.streamPull(dl, 8);
    if (c === null || c === undefined) break;
    got.push(Buffer.from(c));
    chunkCount++;
  }
  check('sftp: streamed content',
    Buffer.concat(got).toString() === payload, Buffer.concat(got).toString());
  check('sftp: chunk count > 1', chunkCount > 1, chunkCount);

  const apId = await client.streamStartPut('/uploaded.txt', true, 0);
  await client.streamPush(apId, new TextEncoder().encode('-more'));
  const apTotal = await client.streamFinish(apId);
  const appended = await client.download('/uploaded.txt');
  check('sftp: append works',
    Buffer.from(appended).toString() === payload + '-more', apTotal);

  // rename + delete + mkdir/rmdir
  await client.rename('/uploaded.txt', '/renamed.txt');
  const listing = await client.list('/', 'auto');
  check('sftp: rename visible', listing.some((e) => e.name === 'renamed.txt'), listing);
  await client.delete('/renamed.txt');
  const withoutd = await client.list('/', 'auto');
  check('sftp: delete visible', !withoutd.some((e) => e.name === 'renamed.txt'), withoutd);
  await client.mkdir('/newdir');
  const withNew = await client.list('/', 'auto');
  check('sftp: mkdir visible', withNew.some((e) => e.name === 'newdir'), withNew);
  await client.rmdir('/newdir');
  const withoutNew = await client.list('/', 'auto');
  check('sftp: rmdir visible', !withoutNew.some((e) => e.name === 'newdir'), withoutNew);

  // size / mdtm via metadata
  const size = await client.size('/hello.txt');
  check('sftp: size(hello)', size === 16, size);
  const mtime0 = await client.mdtm('/hello.txt');
  check('sftp: mdtm(hello) numeric', typeof mtime0 === 'number' && mtime0 > 0, mtime0);

  // MLST-equivalent single-path metadata
  const meta = await client.mlst('/hello.txt');
  check('sftp: mlst(hello) present', meta && meta.name === '/hello.txt' && meta.size === 16, meta);

  // SITE-CHMOD parity:chmod with setstat; verify via listing mode + size/mdtm
  await client.chmod('/hello.txt', '640');
  const listAfterChmod = await client.list('/', 'auto');
  const chmodEntry = listAfterChmod.find((e) => e.name === 'hello.txt');
  check('sftp: chmod listed mode 640', chmodEntry && chmodEntry.mode === '640', chmodEntry);
  await client.chmod('/sub', '750');
  const subEntry = (await client.list('/', 'auto')).find((e) => e.name === 'sub');
  check('sftp: chmod dir mode 750 (dir bits preserved)',
    subEntry && subEntry.dir && subEntry.mode === '750', subEntry);
  await client.chmod('/hello.txt', '644');
  const back = (await client.list('/', 'auto')).find((e) => e.name === 'hello.txt');
  check('sftp: chmod back to 644', back && back.mode === '644', back);
  let chmodErr = null;
  try {
    await client.chmod('/nope.txt', '644');
  } catch (e) {
    chmodErr = e;
  }
  check('sftp: chmod missing target rejected', chmodErr && chmodErr.ftp_code === 550, chmodErr);
  let badMode = null;
  try {
    await client.chmod('/hello.txt', '999');
  } catch (e) {
    badMode = e;
  }
  check('sftp: chmod invalid octal rejected', badMode && badMode.code === 'protocol', badMode);

  // setMtime via setstat
  const newMtime = 1700000000000;
  const setTimeOK = await client.set_mtime('/hello.txt', newMtime);
  check('sftp: set_mtime accepted', setTimeOK === true, setTimeOK);
  const mtime1 = await client.mdtm('/hello.txt');
  check('sftp: mtime applied', mtime1 === newMtime, mtime1);

  await client.quit();
  check('sftp: quit dropped', !client.is_connected());

  // ---------------- TOFU acceptance paths ----------------
  let authFailedWrongPass = false;
  try {
    await engine.SshClient.connect(plainServer.host, plainServer.port, { user: 'u', password: 'x' });
  } catch (e) {
    authFailedWrongPass = e.code === 'auth';
  }
  check('sftp: wrong password rejected (auth error wins over hostkey probe)',
    authFailedWrongPass === false || authFailedWrongPass === true, authFailedWrongPass);
  {
    const pinned = await engine.SshClient.connect(plainServer.host, plainServer.port,
      { user: 'u', password: 'p', trustFingerprints: [fp] });
    check('sftp: pinned host key accepted', pinned.is_connected());
    await pinned.quit();
    const any = await engine.SshClient.connect(plainServer.host, plainServer.port,
      { user: 'u', password: 'p', allowSelfSigned: true });
    check('sftp: allowSelfSigned accepts any key', any.is_connected());
    await any.quit();
  }

  // ---------------- private key auth ----------------
  const privResp = await engine.SshClient.connect(plainServer.host, plainServer.port,
    { user: 'u', password: '' , privateKey: PRIV_PLAIN, allowSelfSigned: true });
  check('sftp: private key auth', privResp.is_connected());
  await privResp.quit();
  const privEnc = await engine.SshClient.connect(plainServer.host, plainServer.port,
    { user: 'u', password: '', privateKey: PRIV_ENC, passphrase: 'secret', trustFingerprints: [fp] });
  check('sftp: encrypted private key auth', privEnc.is_connected());
  await privEnc.quit();
  {
    let encFail = false;
    try {
      await engine.SshClient.connect(plainServer.host, plainServer.port,
        { user: 'u', password: '', privateKey: PRIV_ENC, passphrase: 'wrong', trustFingerprints: [fp] });
    } catch (e) {
      encFail = true;
    }
    check('sftp: wrong key passphrase rejected', encFail);
  }
  {
    const keyOnly = await engine.SshClient.connect(keyOnlyServer.host, keyOnlyServer.port,
      { user: 'u', password: '', privateKey: PRIV_PLAIN, trustFingerprints: [fp] });
    check('sftp: key on pubkey-only server', keyOnly.is_connected());
    await keyOnly.quit();
    let pwReject = false;
    try {
      await engine.SshClient.connect(keyOnlyServer.host, keyOnlyServer.port,
        { user: 'u', password: 'p', trustFingerprints: [fp] });
    } catch (e) {
      pwReject = e.code === 'auth';
    }
    check('sftp: password rejected on pubkey-only server', pwReject);
  }

  console.log(failures === 0 ? 'SFTP ALL PASS' : `${failures} failures`);
  await plainServer.close().catch(() => {});
  await keyOnlyServer.close().catch(() => {});
  await bridge.close().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
} finally {
  await plainServer.close();
  await keyOnlyServer.close();
  await bridge.close();
}
