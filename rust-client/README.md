# ftp_engine — Rust FTP/FTPS + SFTP engine (wasm32)

A full-featured FTP/FTPS **and SFTP** client engine written in Rust, compiled to
`wasm32-unknown-unknown`, designed for the Chrome extension in
`../extension` and transport-tunneled through the **ws-to-tls bridge**
(`../extension/core/ws-to-tls/ws-to-tls.js`).

## Architecture

```
extension UI  ──>  out/api.js (wrapper)  ──>  out/ftp_engine.js (wasm-bindgen ES module)
                                                    │
                                        one WebSocket per FTP connection
                                                    ▼
                                ws-to-tls bridge  ──raw TCP──>  FTP / SFTP server
```

- **One bridge WebSocket per FTP connection.** The control channel is one
  WebSocket; every listing/transfer opens its own passive data connection
  (EPSV, fallback PASV) over another bridge WebSocket. Active mode
  (PORT/EPRT) is intentionally unsupported (the bridge can only dial).
- **TLS lives inside the engine.** The bridge always dials `secure:false`;
  the engine performs TLS itself with rustls (ring provider), which enables
  mid-stream `AUTH TLS` upgrades (explicit FTPS) and per-data-channel TLS
  (`PBSZ 0` + `PROT P`). Trust policies: WebPki roots, skip-verification
  (self-signed), or user-pinned DER roots. Session resumption is shared
  between control and data channels.
- **SFTP rides russh, ssh is in-engine too.** The SSH2 transport comes from
  [`russh`](https://crates.io/crates/russh) 0.52 (pure Rust, explicitly
  wasm32-aware: its session loop runs on `wasm_bindgen_futures::spawn_local`,
  no tokio reactor) connected through `client::connect_stream` over a small
  `AsyncRead`/`AsyncWrite` adapter around the bridge WebSocket; the SFTP
  protocol is [`russh-sftp`](https://crates.io/crates/russh-sftp) 2.4. One
  TCP connection carries everything (no data-channel dance at all).
  Authentication: password and private keys (OpenSSH encrypted keys and
  PuTTY PPK included). Host keys implement TOFU: unknown keys fail with
  error code `hostkey` carrying the OpenSSH-style SHA-256 fingerprint; the
  caller pins it via `trustFingerprints` (or `allowSelfSigned` accepts any).
- **Pure protocol code is target-independent** (listing parsers, reply
  parser, date math) and unit-tested on the host (`cargo test`).

## Supported commands

Session: `USER PASS ACCT SYST FEAT OPTS UTF8 NOOP QUIT STAT`
Navigation: `PWD CWD CDUP`
Transfer: `TYPE I/A STRU F MODE S RETR STOR APPE STOU* REST ABOR`
Listing: `LIST NLST MLSD MLST` (Unix/ DOS / MLSD parsers, UTF-8 with latin-1 fallback)
Files: `SIZE MDTM MFMT DELE MKD RMD RNFR RNTO SITE CHMOD*`
FTPS: `AUTH TLS AUTH SSL PBSZ PROT`

SFTP (via russh/russh-sftp; SFTP v3 over one SSH channel):
`INIT OPEN READ WRITE CLOSE OPENDIR READDIR STAT LSTAT FSTAT
SETSTAT FSETSTAT REMOVE MKDIR RMDIR RENAME REALPATH`
(`chmod`/`setMtime` map to SETSTAT — no server-side support lottery).

`*` STOU is advertised when present in FEAT; unique-name responses are
returned unparsed. `SITE CHMOD` is attempted unconditionally (FileZilla-style)
because most Unix FTP servers implement it without advertising it in FEAT;
non-positive replies surface the server's ftp_code so callers can tell
"not implemented here" (500/504) from "permission denied" (550).

## Build

```sh
./build.sh
# → out/ftp_engine.js         wasm-bindgen ES-module glue (target web)
#   out/ftp_engine_bg.wasm    the engine (release, opt-level=s)
#   out/ftp_engine.d.ts       type declarations
#   out/api.js                high-level wrapper used by the extension
# → test/node/ftp_engine.js   node glue for the e2e harness (regenerated)
```

Toolchain: `rustup` (stable) + `wasm32-unknown-unknown` target,
`wasm-bindgen-cli`, and `clang`/`lld` (ring's wasm build).

## Tests

```sh
cargo test                    # parser/reply/date unit tests (host)
node test/node/e2e.mjs        # engine e2e: plain FTP + FTPS matrix
node test/node/e2e-sftp.mjs   # engine e2e: SFTP matrix (auth/key/TOFU/chmod/transfers)
node test/node/wrapper.mjs    # out/api.js contract test (FTP + SFTP)
```

The e2e harness starts the real bridge (programmatic mode), a mock FTP(S)
server (`test/node/mock-ftp-server.cjs`, in-memory virtual FS) and a mock
SFTP server (`test/node/mock-sftp-server.cjs`, `ssh2` npm package + in-memory
virtual FS), then drives the compiled wasm in node.

## JS API (out/api.js)

```js
import { FtpApi } from './out/api.js';

const api = await FtpApi.create({ bridgeUrl: 'ws://127.0.0.1:PORT/TOKEN' });
const client = await api.connect({
  host, port,
  user, password,
  secure: 'auto' | 'explicit' | 'none' | 'implicit',
  allowSelfSigned: false,
  timeout: 30000,
  dataTls: true,     // PROT P when FTPS
  utf8: true
});

/** SFTP (protocol: 'sftp' in create()):
const api = await FtpApi.create({ bridgeUrl, protocol: 'sftp' });
const client = await api.connect({
  host, port?,                    // port defaults to 22
  user, password?,                // or
  privateKey: opensshKeyText,     // PEM (OpenSSH encrypted keys included)
  passphrase,
  trustFingerprints: ['SHA256:…'],// TOFU pin list (see below)
  allowSelfSigned: false,         // accept ANY host key (explicit opt-in)
  timeout: 30000
});
await client.chmod(p, '644');      // always works (SFTP setstat)
*/
await client.list(path, kind?)        // kind: 'auto'|'unix'|'dos'|'mlsd'|'names'
await client.pwd() / cwd(p) / cdUp()
await client.size(p) / mtime(p) / setMtime(p, epochMs) / statFile(p)
await client.mkdir(p) / rmdir(p) / delete(p) / rename(a, b)
await client.stat() / noop() / state()

// whole-file helpers
await client.download(p) / downloadText(p) / downloadBlob(p)
await client.uploadText(p, str) / upload(p, bytes)

// streaming (large files)
const s = await client.openDownload(p, offset?);
for (;;) { const chunk = await s.pull(); if (chunk === null) break; }  // Uint8Array
await client.uploadStream(p, blobOrStreamOrIterable, { append, offset });
const rs = client.downloadToStream(p);   // ReadableStream

await client.abortTransfer(id);
await client.quit();
```

Errors reject with `{ code, ftp_code?, message, fingerprint? }` where `code`
is one of `io | ftp | protocol | timeout | auth | tls | aborted | unsupported
| hostkey`. `hostkey` rejections carry the server key's OpenSSH-style
SHA-256 fingerprint; persist it (after asking the user, FileZilla-style) and
pass it back in `trustFingerprints` on reconnect to implement TOFU.

### Wiring the bridge

`FtpApi.create({ bridgeUrl })` stores the bridge URL inside the engine
(`set_bridge_url`); every FTP dial opens a WebSocket to it and sends
`{op:'open', host, port, secure:false}` per the bridge protocol.

## Engine-internal layout

```
src/
├── api.rs           wasm-bindgen surface (FtpClient + SshClient)
├── config.rs        bridge URL storage
├── engine_err.rs    error taxonomy (incl. 'hostkey' + fingerprint)
├── sys.rs           JS ArrayBuffer helpers
├── tls.rs           rustls driver (mid-stream upgrade, trust policies)
├── transport.rs     WsStream over the bridge dial protocol (+ poll-mode
│                    read/write for the russh adapter)
├── ftp/
│   ├── control.rs   reply parser (multi-line), FEAT matrix, Channel
│   ├── data.rs      EPSV/PASV negotiation, data-channel TLS
│   ├── listing.rs   Unix / DOS / MLSD parsers + date math (pure)
│   └── session.rs   login flow + full command surface + transfers
└── ssh/
    ├── io.rs        WsIo: tokio AsyncRead/AsyncWrite over WsStream
    └── session.rs   russh handshake/auth + russh-sftp session, TOFU trust,
                     cwd tracking, chunked transfers on the engine's ids
```

## Notes / limits

- Passive mode only (PORT/EPRT would require a `listen` op in the bridge).
- `SystemTime::now()` panics on wasm; the engine uses `js_sys::Date::now()`
  everywhere (rustls-pki-types' `web` feature covers TLS time).
- Listing lines that cannot be parsed are skipped, not fatal.
- SFTP: client-side cwd tracking, no RESUME-from-offset yet (both directions
  reject non-zero offsets), no keepalive timer (server-side idle timeouts may
  eventually drop long idle sessions).
