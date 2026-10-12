// e2e.mjs — engine end-to-end tests under node:
//   1. generate a self-signed cert (openssl)
//   2. start the ws-to-tls bridge programmatically (mode 2)
//   3. start the mock FTP server (plain + TLS)
//   4. drive the compiled wasm engine (node glue) through a full command
//      matrix and assert outcomes.
//
// Run: node test/node/e2e.mjs  (after ./build.sh)

'use strict';

import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const mocks = require(path.join(here, 'mock-ftp-server.cjs'));
const { startWsBridge } = require(path.join(
  root, '..', 'extension', 'core', 'ws-to-tls', 'ws-to-tls.js'));

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

function genPems() {
  const dir = '/tmp/opencode/ftps-mock';
  execSync(`mkdir -p ${dir}`);
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=mock.ftp.local ` +
    `-keyout ${dir}/key.pem -out ${dir}/cert.pem -days 2 2>/dev/null`);
  return {
    key: readFileSync(`${dir}/key.pem`, 'utf8'),
    cert: readFileSync(`${dir}/cert.pem`, 'utf8')
  };
}

// ---------- run ----------
const pems = genPems();

const bridge = await startWsBridge({ token: 'ftps-e2e', allowSelfSigned: true });
console.log(`bridge on ${bridge.url}`);

const plainServer = await mocks.startMockFtp({ tls: false });
const tlsServer = await mocks.startMockFtp({ tls: true, ...pems });

const engine = await import(path.join(here, 'ftp_engine.js'));
engine.set_bridge_url(bridge.url);

try {
  // ---------------- plain FTP ----------------
  const client = await engine.FtpClient.connect(
    plainServer.host, plainServer.port,
    { user: 'u', password: 'p', secure: 'auto' });

  check('state: connected', client.is_connected());
  check('state: tls (none expected, server lacks AUTH TLS)', !client.is_tls());

  const st = await client.pwd();
  check('pwd -> /', st.path === '/', st);

  const entries = await client.list('/', 'auto');
  check('list / -> >=2 entries', Array.isArray(entries) && entries.length >= 2, entries);
  const names = entries.map((e) => e.name);
  check('list contains hello.txt', names.includes('hello.txt'), names);
  const helloEntry = entries.find((e) => e.name === 'hello.txt');
  check('hello.txt is a file', !helloEntry.dir);
  check('hello.txt size = 16', helloEntry.size === 16, helloEntry);

  const bytes = await client.download('/hello.txt');
  check('download bytes', new TextDecoder().decode(bytes) === 'hello ftp world\n',
    Array.from(bytes.slice(0, 8)));

  const sub = await client.list('/sub', 'auto');
  check('sub has nested.txt', sub.some((e) => e.name === 'nested.txt'), sub);

  // upload roundtrip
  const payload = 'upload-roundtrip-' + 'x'.repeat(50);
  const sentTotal = await client.upload('/uploaded.txt', new TextEncoder().encode(payload));
  check('upload total', sentTotal === payload.length, sentTotal);
  const fetched = await client.download('/uploaded.txt');
  check('upload roundtrip content', Buffer.from(fetched).toString() === payload);

  // append
  const idAp = await client.streamStartPut('/uploaded.txt', true, 0);
  await client.streamPush(idAp, new TextEncoder().encode('-more'));
  const apTotal = await client.streamFinish(idAp);
  const appended = await client.download('/uploaded.txt');
  check('appe works', Buffer.from(appended).toString() === payload + '-more', apTotal);

  // rename + delete + mkdir/rmdir
  await client.rename('/uploaded.txt', '/renamed.txt');
  const listing = await client.list('/', 'auto');
  check('rename visible', listing.some((e) => e.name === 'renamed.txt'), listing);

  await client.mkdir('/newdir');
  const withNew = await client.list('/', 'auto');
  check('mkdir visible', withNew.some((e) => e.name === 'newdir'), withNew);
  await client.rmdir('/newdir');
  const withoutNew = await client.list('/', 'auto');
  check('rmdir visible', !withoutNew.some((e) => e.name === 'newdir'), withoutNew);

  // size + mdtm
  const size = await client.size('/hello.txt');
  check('size(hello)', size === 16, size);
  const mtime = await client.mdtm('/hello.txt');
  check('mdtm(hello) numeric', typeof mtime === 'number' && mtime > 0, mtime);

  // SITE CHMOD (permission editing, FileZilla-style)
  await client.chmod('/hello.txt', '640');
  const chmodUnix = await client.list('/', 'unix');
  const chmodEntry = chmodUnix.find((e) => e.name === 'hello.txt');
  check('chmod listed mode -rw-r-----', chmodEntry && chmodEntry.mode === '-rw-r-----', chmodEntry);
  const chmodMlsd = await client.list('/', 'mlsd');
  check('chmod mlsd mode 640', chmodMlsd.find((e) => e.name === 'hello.txt').mode === '640', chmodMlsd);
  await client.chmod('/sub', '700');
  const afterDirChmod = await client.list('/', 'unix');
  check('chmod dir listed mode drwx------',
    afterDirChmod.find((e) => e.name === 'sub').mode === 'drwx------', afterDirChmod);
  await client.chmod('/hello.txt', '644'); // octal string form on the raw glue
  const backMode = (await client.list('/', 'unix')).find((e) => e.name === 'hello.txt');
  check('chmod restores -rw-r--r--', backMode && backMode.mode === '-rw-r--r--', backMode);
  let chmodMissing = '';
  try {
    await client.chmod('/nope.txt', '644');
  } catch (e) {
    chmodMissing = e.ftp_code;
  }
  check('chmod missing target rejected', chmodMissing === 550, chmodMissing);
  let chmodBadMode = '';
  try {
    await client.chmod('/hello.txt', '999');
  } catch (e) {
    chmodBadMode = e.code;
  }
  check('chmod invalid octal rejected', chmodBadMode === 'protocol', chmodBadMode);

  // MLST metadata
  const meta = await client.mlst('/hello.txt');
  check('mlst(hello) present', meta && meta.name && meta.size === 16, meta);

  // stream download chunks
  const dl = await client.streamStartGet('/hello.txt', 0);
  let got = [];
  let chunkCount = 0;
  for (;;) {
    const c = await client.streamPull(dl, 8);
    if (c === null || c === undefined) break;
    got.push(Buffer.from(c));
    chunkCount++;
  }
  const streamJoined = Buffer.concat(got).toString();
  check('streamed content', streamJoined === 'hello ftp world\n', streamJoined);
  check('chunk count > 1 (small chunk size)', chunkCount > 1, chunkCount);

  // SYST/NOOP/STAT
  const syst = await client.syst();
  check('syst UNIX', /UNIX/i.test(syst), syst);
  await client.noop();
  const stat = await client.stat();
  check('stat text', /Status/i.test(stat), stat);

  await client.quit();

  // ---------------- FTPS ----------------
  const sec = await engine.FtpClient.connect(
    tlsServer.host, tlsServer.port,
    { user: 'u', password: 'p', secure: 'auto', allowSelfSigned: true });
  check('ftps: control is TLS', sec.is_tls());
  check('ftps: data TLS on', sec.data_tls_on());
  const secList = await sec.list('/', 'auto');
  check('ftps: list works over TLS', secList.some((e) => e.name === 'hello.txt'), secList);
  const secBytes = await sec.download('/hello.txt');
  check('ftps: download over TLS', Buffer.from(secBytes).toString() === 'hello ftp world\n');
  await sec.quit();

  // ---------------- wrong credentials ----------------
  let authFailed = false;
  try {
    await engine.FtpClient.connect(plainServer.host, plainServer.port,
      { user: 'wrong', password: 'x', secure: 'none' });
  } catch (e) {
    authFailed = true;
  }
  check('wrong user rejected', authFailed);

  console.log(failures === 0 ? 'ALL PASS' : `${failures} failures`);
  await plainServer.close().catch(() => {});
  await tlsServer.close().catch(() => {});
  await bridge.close().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
} finally {
  await plainServer.close();
  await tlsServer.close();
  await bridge.close();
}
