// Minimal-but-real FTP(S) server for engine e2e tests. Implements the
// command surface the engine exercises: login, FEAT/AUTH TLS/PBSZ/PROT,
// TYPE/PWD/CWD/CDUP, EPSV/PASV data channels, RETR/STOR/APPE/REST,
// LIST/NLST/MLSD/MLST, SIZE/MDTM/MFMT, DELE/MKD/RMD/RNFR/RNTO, SITE CHMOD,
// ABOR, STAT,
// SYST, NOOP, QUIT. State lives in a tiny in-memory virtual FS.
//
// Usage (programmatic): const server = await startMockFtp({tls: true|false});
//   -> {host, port, close(), root()}  where root() returns the virtual FS.

'use strict';

const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');

class Node {
  constructor(isDir) {
    this.dir = isDir;
    this.data = null; // Buffer for files
    this.children = null; // Map for dirs
    this.mtime = Date.now();
    this.mode = null; // octal bits (e.g. 0o644); falls back to isDir default
  }
}

function newRoot() {
  const root = new Node(true);
  root.children = new Map();
  return root;
}

function splitPath(p) {
  return String(p || '/')
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0);
}

// Resolve (parent dir node, final name) under the virtual FS.
function lookup(root, p) {
  const parts = splitPath(p);
  let node = root;
  for (let i = 0; i < parts.length; i++) {
    if (!node.dir || !node.children) {
      return null;
    }
    const name = parts[i];
    if (i === parts.length - 1) {
      return { parent: node, name, node: node.children.get(name) || null };
    }
    const next = node.children.get(name);
    if (!next || !next.dir) {
      return null;
    }
    node = next;
  }
  return { parent: null, name: '', node };
}

function resolveNode(root, p) {
  const r = lookup(root, p);
  return r ? r.node : null;
}

function fmtStamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds())
  );
}

function nodeMode(node) {
  return node.mode !== null && node.mode !== undefined
    ? node.mode
    : (node.dir ? 0o755 : 0o644);
}

function fmtMode(node) {
  // "644" / "755" / "4755" (3-4 octal digits, no leading zero)
  return nodeMode(node).toString(8);
}

// 9-char rwx string from the low 9 octal bits, e.g. "rw-r--r--"
function permStr(node) {
  const m = nodeMode(node) & 0o777;
  const bit = (v, c) => (v ? c : '-');
  let s = '';
  for (const shift of [6, 3, 0]) {
    const t = (m >> shift) & 7;
    s += bit(t & 4, 'r') + bit(t & 2, 'w') + bit(t & 1, 'x');
  }
  return s;
}

function unixLine(node, name) {
  const d = new Date(node.mtime);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const p = (n) => String(n).padStart(2, '0');
  const type = node.dir ? 'd' : '-';
  const mode = permStr(node);
  const size = node.dir ? 4096 : node.data.length;
  const withinSixMonths = Date.now() - node.mtime < 182 * 24 * 3600 * 1000;
  const dateStr = withinSixMonths
    ? `${months[d.getUTCMonth()]} ${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
    : `${months[d.getUTCMonth()]} ${p(d.getUTCDate())}  ${d.getUTCFullYear()}`;
  return `${type}${mode}   1 root staff ${String(size).padStart(12, ' ')} ${dateStr} ${name}`;
}

function mlsxLine(node, name) {
  const facts = [
    'type=' + (node.dir ? 'dir' : 'file'),
    'size=' + (node.dir ? 0 : node.data.length),
    'modify=' + fmtStamp(node.mtime),
    'UNIX.mode=' + nodeMode(node).toString(8).padStart(4, '0')
  ].join(';');
  return `${facts}; ${name}`;
}

function startMockFtp(options = {}) {
  const useTls = !!options.tls;
  const root = newRoot();
  // seed: a file with known bytes and a subdir
  const hello = Buffer.from('hello ftp world\n');
  root.children.set('hello.txt', (() => { const n = new Node(false); n.data = hello; return n; })());
  const sub = new Node(true);
  sub.children = new Map();
  root.children.set('sub', sub);
  sub.children.set('nested.txt', (() => { const n = new Node(false); n.data = Buffer.from('nested\n'); return n; })());

  const server = net.createServer((socket) => {
    makeSession(socket, root, useTls, options);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        host: '127.0.0.1',
        port: server.address().port,
        root: () => root,
        close: () => new Promise((res) => server.close(() => res()))
      });
    });
  });
}

function makeSession(socket, root, useTls, options) {
  const state = {
    authed: false,
    user: null,
    tls: false,
    protP: false,
    type: 'A',
    cwd: '/',
    rnfr: null,
    rest: 0,
    dataListener: null, // {mode:'epsv'|'pasv', port, promise, socket}
    closed: false,
    buffer: ''
  };

  if (useTls && (!options.key || !options.cert)) {
    throw new Error('mock TLS server requires options.key/options.cert (PEM strings)');
  }
  const tlsOpts = {
    key: options.key,
    cert: options.cert,
    rejectUnauthorized: false
  };

  const send = (s, text) => {
    const out = sessionSocket;
    try {
      out.write(text.replace(/\r?\n$/, '') + '\r\n');
    }
    catch {}
  };
  const reply = (s, code, text) => {
    if (process.env.MOCK_FTP_TRACE) console.log(`[mock] -> ${code} ${text}`);
    send(s, `${code} ${text}`);
  };

  const upsert = (s, cmd, handler) => {
    // single dispatch point; cmds arrive line-by-line
  };

  const onDataSession = (raw) => {
    state.buffer += raw.toString('utf8');
    let idx;
    while ((idx = state.buffer.indexOf('\n')) >= 0) {
      const line = state.buffer.slice(0, idx).replace(/\r$/, '');
      state.buffer = state.buffer.slice(idx + 1);
      if (line.length) {
        handleCommand(socket, line);
      }
    }
  };

  const handleCommand = async (socket, line) => {
    if (process.env.MOCK_FTP_TRACE) console.log(`[mock] <- ${line}`);
    const spaceIdx = line.indexOf(' ');
    const cmd = (spaceIdx < 0 ? line : line.slice(0, spaceIdx)).toUpperCase();
    const arg = spaceIdx < 0 ? '' : line.slice(spaceIdx + 1).trim();

    switch (cmd) {
      case 'USER':
        state.user = arg;
        state.authed = false;
        if (arg === 'failme') {
          reply(socket, 530, 'Login incorrect.');
        } else {
          reply(socket, 331, 'Password required');
        }
        return;
      case 'PASS':
        if (state.user === 'failme') {
          reply(socket, 530, 'Login incorrect.');
          return;
        }
        state.authed = (state.user || 'anonymous') !== 'wrong';
        reply(socket, state.authed ? 230 : 530, state.authed ? 'User logged in' : 'Login incorrect');
        return;
      case 'AUTH': {
        if (/TLS/i.test(arg)) {
          if (useTls) {
            reply(socket, 234, 'AUTH TLS OK');
            // upgrade mid-stream: detach the plaintext handler so encrypted
            // bytes don't leak into the command parser
            socket.removeListener('data', onDataSession);
            const tlsSocket = new tls.TLSSocket(socket, { ...tlsOpts, isServer: true });
            tlsSocket.on('error', (e) => { if (process.env.MOCK_FTP_TRACE) console.log('[mock] TLS ERROR:', e.message, e.code); });
            tlsSocket.on('secure', () => { if (process.env.MOCK_FTP_TRACE) console.log('[mock] TLS secure event'); });
            sessionSocket = tlsSocket;
            bindSession(tlsSocket);
            state.tls = true;
            return;
          }
          reply(socket, 502, 'TLS not available');
          return;
        }
        if (/SSL/i.test(arg)) {
          reply(socket, 502, 'SSL not available');
          return;
        }
        reply(socket, 504, 'Unknown AUTH type');
        return;
      }
      case 'PBSZ':
        reply(socket, 200, 'PBSZ=0');
        return;
      case 'PROT':
        state.protP = /P/i.test(arg);
        reply(socket, 200, state.protP ? 'Data protection level P' : 'Data protection level C');
        return;
      case 'SYST':
        reply(socket, 215, 'UNIX Type: L8');
        return;
      case 'FEAT': {
        const lines = ['211-Feature list:', ' UTF8', ' EPSV', ' SIZE', ' MDTM', ' MFMT', ' SITE CHMOD', ' MLST type*;size*;modify*;', ' REST STREAM'];
        if (useTls) {
          lines.splice(2, 0, ' AUTH TLS', ' PBSZ', ' PROT');
        }
        lines.push('211 End');
        for (const l of lines) {
          send(socket, l);
        }
        return;
      }
      case 'OPTS':
        reply(socket, 200, arg.toUpperCase().includes('UTF8') ? 'UTF8 mode enabled' : 'OPTS OK');
        return;
      case 'TYPE':
        state.type = arg.toUpperCase();
        reply(socket, 200, 'Type set to ' + arg);
        return;
      case 'PWD':
        reply(socket, 257, `"${state.cwd}" is the current directory`);
        return;
      case 'CWD': {
        const target = joinPath(state.cwd, arg);
        const node = resolveNode(root, target);
        if (!node || !node.dir) {
          reply(socket, 550, 'Failed to change directory.');
          return;
        }
        state.cwd = target;
        reply(socket, 250, 'Directory successfully changed.');
        return;
      }
      case 'CDUP': {
        const up = joinPath(state.cwd, '..');
        const node = resolveNode(root, up);
        if (!node || !node.dir) {
          reply(socket, 550, 'Failed to change directory.');
          return;
        }
        state.cwd = up;
        reply(socket, 250, 'Directory successfully changed.');
        return;
      }
      case 'EPSV':
      case 'PASV': {
        // prepareDataListener resolves once the socket is bound
        await prepareDataListener(cmd === 'EPSV');
        if (cmd === 'EPSV') {
          reply(socket, 229, `Entering Extended Passive Mode (|||${state.dataPort}|)`);
        } else {
          const p = state.dataPort;
          reply(socket, 227, `Entering Passive Mode (127,0,0,1,${p >> 8},${p & 255})`);
        }
        return;
      }
      case 'LIST':
      case 'NLST':
      case 'MLSD':
        serveListing(socket, cmd, arg);
        return;
      case 'MLST': {
        const target = joinPath(state.cwd, arg);
        const node = resolveNode(root, target);
        if (!node) {
          reply(socket, 550, 'No such file or directory.');
          return;
        }
        const name = target.split('/').pop();
        send(socket, '250-Listing ' + arg);
        send(socket, ' ' + mlsxLine(node, name));
        reply(socket, 250, 'End');
        return;
      }
      case 'SIZE': {
        const target = joinPath(state.cwd, arg);
        const node = resolveNode(root, target);
        if (!node || node.dir) {
          reply(socket, 550, 'Could not get file size.');
          return;
        }
        reply(socket, 213, String(node.data.length));
        return;
      }
      case 'MDTM': {
        const target = joinPath(state.cwd, arg);
        const node = resolveNode(root, target);
        if (!node) {
          reply(socket, 550, 'No such file or directory.');
          return;
        }
        reply(socket, 213, fmtStamp(node.mtime));
        return;
      }
      case 'MFMT': {
        const mIdx = arg.indexOf(' ');
        const stamp = arg.slice(0, mIdx);
        const file = arg.slice(mIdx + 1).replace(/"/g, '');
        const target = joinPath(state.cwd, file);
        const node = resolveNode(root, target);
        if (!node) {
          reply(socket, 550, 'No such file or directory.');
          return;
        }
        node.mtime = parseStamp(stamp);
        reply(socket, 213, stamp);
        return;
      }
      case 'SITE': {
        // Format: SITE CHMOD <octal-mode> <path> (highest-arg verb first).
        const words = arg.split(/\s+/).filter((w) => w.length > 0);
        const verb = (words.shift() || '').toUpperCase();
        if (verb !== 'CHMOD') {
          reply(socket, 501, 'Unsupported SITE verb: ' + verb);
          return;
        }
        const modeTok = words.shift() || '';
        const file = words.join(' ').replace(/"/g, '');
        if (!/^[0-7]{3,4}$/.test(modeTok)) {
          reply(socket, 501, 'Invalid mode: ' + modeTok);
          return;
        }
        const target = joinPath(state.cwd, file);
        const node = resolveNode(root, target);
        if (!node) {
          reply(socket, 550, 'No such file or directory.');
          return;
        }
        node.mode = parseInt(modeTok, 8);
        reply(socket, 200, 'SITE CHMOD ' + modeTok + ' command successful');
        return;
      }
      case 'RETR':
        serveRetrieve(socket, arg);
        return;
      case 'STOR':
      case 'APPE':
        serveStore(socket, cmd, arg);
        return;
      case 'REST':
        state.rest = parseInt(arg, 10) || 0;
        if (state.rest > 0) {
          reply(socket, 350, `Restarting at ${state.rest}. Send STORE or RETRIEVE to initiate transfer`);
        } else {
          reply(socket, 501, 'Invalid offset');
        }
        return;
      case 'DELE': {
        const target = joinPath(state.cwd, arg);
        const info = lookup(root, target);
        if (!info || !info.node || info.node.dir) {
          reply(socket, 550, 'No such file.');
          return;
        }
        info.parent.children.delete(info.name);
        reply(socket, 250, 'File deleted.');
        return;
      }
      case 'MKD': {
        const target = joinPath(state.cwd, arg);
        const dir = new Node(true);
        dir.children = new Map();
        const parent = resolveNode(root, dirnamePath(target));
        if (!parent || !parent.dir) {
          reply(socket, 550, 'Parent missing.');
          return;
        }
        parent.children.set(target.split('/').pop(), dir);
        reply(socket, 257, `"${target}" created`);
        return;
      }
      case 'RMD': {
        const target = joinPath(state.cwd, arg);
        const info = lookup(root, target);
        if (!info || !info.node || !info.node.dir) {
          reply(socket, 550, 'No such directory.');
          return;
        }
        info.parent.children.delete(info.name);
        reply(socket, 250, 'Directory removed.');
        return;
      }
      case 'RNFR': {
        const target = joinPath(state.cwd, arg);
        const node = resolveNode(root, target);
        if (!node) {
          reply(socket, 550, 'No such file or directory.');
          return;
        }
        state.rnfr = splitPath(target);
        reply(socket, 350, 'Ready for RNTO.');
        return;
      }
      case 'RNTO': {
        const fromParts = state.rnfr;
        if (!fromParts) {
          reply(socket, 503, 'RNFR required first.');
          return;
        }
        const target = joinPath(state.cwd, arg);
        const fromNode = resolveNode(root, fromParts.join('/'));
        const fromParent = resolveNode(root, fromParts.slice(0, -1).join('/'));
        const toParent = resolveNode(root, dirnamePath(target));
        if (!fromNode || !fromParent || !toParent) {
          reply(socket, 550, 'Rename failed.');
          return;
        }
        fromParent.children.delete(fromParts[fromParts.length - 1]);
        toParent.children.set(target.split('/').pop(), fromNode);
        state.rnfr = null;
        reply(socket, 250, 'Rename successful.');
        return;
      }
      case 'ABOR':
        reply(socket, 426, 'Connection closed; transfer aborted.');
        reply(socket, 226, 'Aborted OK');
        return;
      case 'STAT':
        if (arg) {
          const target = joinPath(state.cwd, arg);
          const node = resolveNode(root, target);
          if (!node) {
            reply(socket, 550, 'No such file or directory.');
            return;
          }
          send(socket, '211-Status of ' + arg);
          send(socket, ' ' + unixLine(node, target.split('/').pop()));
          reply(socket, 211, 'End of status');
        } else {
          send(socket, '211-FTP Server Status:');
          send(socket, ' Connected from unknown');
          reply(socket, 211, 'End of status');
        }
        return;
      case 'NOOP':
        reply(socket, 200, 'NOOP ok.');
        return;
      case 'QUIT':
        reply(socket, 221, 'Goodbye.');
        socket.end();
        return;
      case 'HELP':
        reply(socket, 214, 'Commands: ' + 'USER PASS SYST FEAT PWD CWD CDUP EPSV PASV RETR STOR APPE REST DELE MKD RMD RNFR RNTO LIST NLST MLSD MLST SIZE MDTM MFMT SITE TYPE PBSZ PROT NOOP QUIT');
        return;
      default:
        reply(socket, 502, 'Command not implemented: ' + cmd);
    }
  };

  const prepareDataListener = (epsv) => {
    // one pending data connection; the next transfer command uses it.
    // Resolves once the listening socket is bound (so the reply carries
    // the real port).
    if (state.dataListener && state.dataListener.server) {
      state.dataListener.server.close();
    }
    return new Promise((resolve) => {
      const server = net.createServer((dataSocket) => {
        if (process.env.MOCK_FTP_TRACE) console.log('[mock] data socket connected');
        state.dataSocket = dataSocket;
        if (state.protP && state.tls) {
          const tlsSock = new tls.TLSSocket(dataSocket, { ...tlsOpts, isServer: true });
          tlsSock.on('error', () => {});
          state.dataSocket = tlsSock;
        }
        if (state.dataResolve) {
          state.dataResolve();
          state.dataResolve = null;
        }
      });
      server.on('error', () => {});
      server.listen(0, '127.0.0.1', () => {
        state.dataPort = server.address().port;
        state.epsv = epsv;
        state.dataListener = { server };
        if (process.env.MOCK_FTP_TRACE) console.log(`[mock] data listener on :${state.dataPort}`);
        resolve();
      });
    });
  };

  const serveListing = async (socket, cmd, arg) => {
    const target = joinPath(state.cwd, arg || '.');
    const node = resolveNode(root, target === '' ? '/' : target);
    if (!node || !node.dir) {
      reply(socket, 550, 'Failed to open directory.');
      return;
    }
    if (!state.dataListener) {
      reply(socket, 425, "Use PORT or PASV first.");
      return;
    }
    reply(socket, 150, 'Here comes the directory listing.');
    await onceDataConnected();
    const names = Array.from(node.children.keys());
    let body = '';
    if (cmd === 'MLSD') {
      body = names.map((n) => mlsxLine(node.children.get(n), n)).join('\r\n') + '\r\n';
    } else if (cmd === 'NLST') {
      body = names.join('\r\n') + '\r\n';
    } else {
      body = 'total ' + names.length + '\r\n' + names.map((n) => unixLine(node.children.get(n), n)).join('\r\n') + '\r\n';
    }
    try {
      state.dataSocket.write(Buffer.from(body, 'utf8'), () => {
        closeDataSocket();
      });
    } catch {
      closeDataSocket();
    }
    reply(socket, 226, 'Directory send OK.');
  };

  const serveRetrieve = async (socket, arg) => {
    const target = joinPath(state.cwd, arg);
    const node = resolveNode(root, target);
    if (!node || node.dir) {
      if (state.dataListener) state.dataListener.server.close();
      reply(socket, 550, 'Failed to open file.');
      return;
    }
    if (!state.dataListener) {
      reply(socket, 425, "Use PORT or PASV first.");
      return;
    }
    reply(socket, 150, 'Opening BINARY mode data connection.');
    await onceDataConnected();
    let payload = node.data;
    if (state.rest > 0) {
      payload = payload.subarray(state.rest);
      state.rest = 0;
    }
    try {
      state.dataSocket.write(payload, () => closeDataSocket());
    } catch {
      closeDataSocket();
    }
    reply(socket, 226, 'Transfer complete.');
  };

  const serveStore = async (socket, cmd, arg) => {
    const target = joinPath(state.cwd, arg);
    if (!state.dataListener) {
      reply(socket, 425, "Use PORT or PASV first.");
      return;
    }
    reply(socket, 150, 'Ok to send data.');
    await onceDataConnected();
    const chunks = [];
    state.dataSocket.on('data', (d) => chunks.push(Buffer.from(d)));
    state.dataSocket.on('error', () => {});
    // STOR overwrites; APPE appends; REST offsets only supported for RETR here
    state.dataSocket.on('data', () => {});
    state.dataSocket.on('close', () => {
      const buffer = Buffer.concat(chunks);
      const parts = splitPath(target);
      if (parts.length >= 1) {
        const parent = parts.length >= 2
          ? resolveNode(root, parts.slice(0, -1).join('/'))
          : root;
        const name = parts[parts.length - 1];
        if (parent && parent.dir) {
          const existing = parent.children.get(name);
          if (cmd === 'APPE' && existing && !existing.dir) {
            existing.data = Buffer.concat([existing.data, buffer]);
            existing.mtime = Date.now();
          } else {
            const fileNode = existing && !existing.dir ? existing : new Node(false);
            fileNode.dir = false;
            fileNode.data = buffer;
            fileNode.mtime = Date.now();
            parent.children.set(name, fileNode);
          }
        }
      }
      reply(socket, 226, 'Transfer complete.');
    });
  };

  const onceDataConnected = () => {
    if (state.dataSocket && !state.dataSocket.destroyed) {
      return Promise.resolve();
    }
    return new Promise((res) => { state.dataResolve = res; });
  };

  const closeDataSocket = () => {
    if (state.dataSocket) {
      try { state.dataSocket.end(); } catch {}
      state.dataSocket = null;
    }
  };

  let sessionSocket = socket;
  const bindSession = (s) => {
    s.on('data', onDataSession);
  };
  bindSession(socket);
  if (process.env.MOCK_FTP_TRACE) {
    socket.on('data', (d) => console.log(`[mock] RAW data ${d.length}: ${JSON.stringify(d.toString().slice(0, 60))}`));
    socket.on('close', () => console.log('[mock] CONTROL SOCKET CLOSED'));
    socket.on('error', (e) => console.log('[mock] CONTROL ERROR', e.message));
    socket.on('end', () => console.log('[mock] CONTROL END'));
  }
  reply(socket, 220, 'mock FTP server ready');
}

function joinPath(cwd, arg) {
  if (!arg || arg === '.') {
    return cwd;
  }
  if (arg.startsWith('/')) {
    return normalizePath(arg);
  }
  // quote-stripping: server keeps the name as issued
  let cleaned = arg.replace(/"/g, '');
  return normalizePath(cwd + '/' + cleaned);
}

function normalizePath(p) {
  const parts = splitPath(p);
  const out = [];
  for (const part of parts) {
    if (part === '.') {
      continue;
    }
    if (part === '..') {
      out.pop();
    } else {
      out.push(part);
    }
  }
  return '/' + out.join('/');
}

function dirnamePath(p) {
  const parts = splitPath(p);
  return '/' + parts.slice(0, Math.max(0, parts.length - 1)).join('/');
}

function parseStamp(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  if (!m) {
    return Date.now();
  }
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

// tls material is generated at test setup (see test/node/e2e.mjs) via
// `openssl req -x509`; pass it through options.key/options.cert.

module.exports = { startMockFtp, normalizePath, splitPath, lookup, generatePems };

// Re-export a proper PEM pair generated on the fly so TLS always works.
function generatePems() {
  return null; // generated externally; see e2e.mjs
}

