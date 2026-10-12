// wrapper test — loads out/api.js (the extension-facing module) and verifies
// the high-level contract end-to-end against the mock FTP server + bridge.

'use strict';

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const mocksFtp = require(path.join(here, 'mock-ftp-server.cjs'));
const mocksSftp = require(path.join(here, 'mock-sftp-server.cjs'));
const { startWsBridge } = require(path.join(
  root, '..', 'extension', 'core', 'ws-to-tls', 'ws-to-tls.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`ok - ${name}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`);
  }
}

const bridge = await startWsBridge({ token: 'wrapper' });
const server = await mocksFtp.startMockFtp({ tls: false });

const { FtpApi } = await import(path.join(root, 'out', 'api.js'));
// node can't fetch(file://); hand the wasm over as a data: URL
const wasmBytes = require('node:fs').readFileSync(path.join(root, 'out', 'ftp_engine_bg.wasm'));
const wasmUrl = 'data:application/wasm;base64,' + wasmBytes.toString('base64');
const api = await FtpApi.create({ bridgeUrl: bridge.url, wasmUrl });

const client = await api.connect({
  host: server.host,
  port: server.port,
  user: 'u',
  password: 'p',
  secure: 'auto'
});

const state = await client.state();
check('wrapper state', state && state.host === server.host && typeof state.feats === 'object', state);

const entries = await client.list('/');
check('wrapper list', entries.length >= 2);

const text = await client.downloadText('/hello.txt');
check('wrapper downloadText', text === 'hello ftp world\n');

const upTotal = await client.uploadText('/wrap.txt', 'wrapped');
check('wrapper uploadText', upTotal === 7);

// uploadStream from an async generator
async function* gen() {
  yield new TextEncoder().encode('str');
  yield new TextEncoder().encode('eamed');
}
const st = await client.uploadStream('/gen.txt', gen());
check('wrapper uploadStream', st === 8, st);
const streamedBack = await client.downloadText('/gen.txt');
check('wrapper stream roundtrip', streamedBack === 'streamed', streamedBack);

// downloadToStream
const rs = client.downloadToStream('/wrap.txt');
const chunks = [];
const reader = rs.getReader();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  chunks.push(Buffer.from(value));
}
check('wrapper downloadToStream', Buffer.concat(chunks).toString() === 'wrapped');

// high-level stat helper
const meta = await client.statFile('/hello.txt');
check('wrapper statFile size', meta.size === 16, meta);

// chmod (SITE CHMOD): string and numeric octal forms
await client.chmod('/hello.txt', '640');
let wrapMode = (await client.list('/', 'mlsd')).find((e) => e.name === 'hello.txt').mode;
check('wrapper chmod string octal', wrapMode === '640', wrapMode);
await client.chmod('/hello.txt', 0o644);
wrapMode = (await client.list('/', 'mlsd')).find((e) => e.name === 'hello.txt').mode;
check('wrapper chmod numeric octal', wrapMode === '644', wrapMode);
let wrapChmodErr = '';
try {
  await client.chmod('/hello.txt', '999');
} catch (e) {
  wrapChmodErr = e.code;
}
check('wrapper chmod invalid octal rejected', wrapChmodErr === 'protocol', wrapChmodErr);

// --------------- SFTP protocol contract (same Client surface) ---------------
const { readFile } = await import('node:fs/promises');
const sftpServer = await mocksSftp.startMockSftp({ hostKeys: [await readFile('/tmp/opencode/sftp-keys/host_ed25519')] });
const sftpApi = await FtpApi.create({ bridgeUrl: bridge.url, wasmUrl, protocol: 'sftp' });
let sftpHostErr = null;
try {
  // TOFU: unpinned host key -> typed 'hostkey' error with fingerprint field
  await sftpApi.connect({ host: sftpServer.host, port: sftpServer.port, user: 'u', password: 'p' });
} catch (e) {
  sftpHostErr = e;
}
check('sftp wrapper hostkey error',
  sftpHostErr && sftpHostErr.code === 'hostkey' && !!sftpHostErr.fingerprint, sftpHostErr);
const sftp = await sftpApi.connect({
  host: sftpServer.host, port: sftpServer.port, user: 'u', password: 'p',
  trustFingerprints: sftpHostErr ? [sftpHostErr.fingerprint] : undefined
});
check('sftp wrapper state', (await sftp.state()).protocol === 'sftp', await sftp.state());

const sftpEntries = await sftp.list('/');
check('sftp wrapper list', sftpEntries.length === 2 && sftpEntries.some((e) => e.name === 'hello.txt'), sftpEntries);

const sftpText = await sftp.downloadText('/hello.txt');
check('sftp wrapper downloadText', sftpText === 'hello ftp world\n', sftpText);

const sftpStat = await sftp.statFile('/hello.txt');
check('sftp wrapper statFile', sftpStat.size === 16 && !sftpStat.dir, sftpStat);

await sftp.chmod('/hello.txt', '640');
const wrapModeS = (await sftp.list('/')).find((e) => e.name === 'hello.txt');
check('sftp wrapper chmod', wrapModeS.mode === '640', wrapModeS);
await sftp.chmod('/hello.txt', 0o644);

const sftpUp = await sftp.uploadText('/wrap-sftp.txt', 'wrapped-sftp');
check('sftp wrapper uploadText', sftpUp === 12, sftpUp);
const sftpBack = await sftp.downloadText('/wrap-sftp.txt');
check('sftp wrapper upload roundtrip', sftpBack === 'wrapped-sftp', sftpBack);

// TOFU flow verified above; the pinned reconnect succeeded.

await sftp.quit();
await sftpServer.close();

await client.quit();
console.log(failures === 0 ? 'WRAPPER ALL PASS' : `${failures} wrapper failures`);
await bridge.close().catch(() => {});
process.exit(failures === 0 ? 0 : 1);
