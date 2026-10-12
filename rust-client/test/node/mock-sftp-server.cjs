// Minimal SFTP(S) server for engine e2e tests, on top of an in-memory virtual
// FS (same shape as mock-ftp-server.cjs). Implements the SFTP v3 op surface
// the engine exercises: REALPATH/STAT/LSTAT/FSTAT, OPEN/READ/WRITE/CLOSE,
// OPENDIR/READDIR, MKDIR/RMDIR/REMOVE/RENAME, SETSTAT/FSETSTAT.
//
// Usage (programmatic): const server = await startMockSftp({hostKeys:[pem]});
//   -> {host, port, fingerprint, close(), root()}
// Set MOCK_SFTP_TRACE=1 for ssh2 handshake diagnostics.

'use strict';

const { Server, utils } = require('ssh2');
const { OPEN_MODE, STATUS_CODE } = utils.sftp;
const fs = require('node:fs');

class Node {
  constructor(isDir) {
    this.dir = isDir;
    this.data = null;
    this.children = null;
    this.mtime = Math.floor(Date.now() / 1000);
    this.mode = null; // full POSIX bits including the file-type nibble
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

function normalize(p) {
  let parts = [];
  for (const seg of splitPath(p)) {
    if (seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}

function defaultMode(node) {
  // S_IFDIR|0755 or S_IFREG|0644, unless chmod/fixed mode overrides
  return node.mode !== null && node.mode !== undefined
    ? node.mode
    : (node.dir ? 0o040755 : 0o100644);
}

function statReply(node) {
  return {
    mode: defaultMode(node),
    uid: 0,
    gid: 0,
    size: node.dir ? 4096 : node.data.length,
    atime: node.mtime,
    mtime: node.mtime,
  };
}

// OpenSSH-style SHA256 fingerprint ("SHA256:base64-nopad") for a PEM host key
function hostFingerprint(pem) {
  const parsed = utils.parseKey(pem);
  const keyObj = Array.isArray(parsed) ? parsed[0] : parsed;
  const key = keyObj.key || keyObj;
  const blob = key.getPublicSSH();
  const digest = require('node:crypto')
    .createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  return 'SHA256:' + digest;
}

function wrapKey(pemPathOrText) {
  return fs.readFileSync(pemPathOrText); // accept path or PEM text buffers
}

function startMockSftp(options = {}) {
  const hostKeyPem = options.hostKeys
    ? options.hostKeys[0]
    : fs.readFileSync('/tmp/opencode/sftp-keys/host_ed25519');
  const hostFpr = hostFingerprint(hostKeyPem);
  const passwordMode = options.password !== null; // set to null to force pubkey-only
  const denialMode = !!options.denySetStat; // test hook: SETSTAT -> PERMISSION_DENIED
  const requirePublicKey = !!options.publicKeyOpenSSH; // accept only this key blob

  const root = newRoot();
  // seed: known file + subdir + nested file
  root.children.set('hello.txt', (() => {
    const n = new Node(false);
    n.data = Buffer.from('hello ftp world\n');
    return n;
  })());
  root.children.set('sub', (() => {
    const n = new Node(true);
    n.children = new Map();
    return n;
  })());
  root.children.get('sub').children.set('nested.txt', (() => {
    const n = new Node(false);
    n.data = Buffer.from('nested\n');
    return n;
  })());

  const trace = !!process.env.MOCK_SFTP_TRACE;
  const server = new Server({
    hostKeys: [hostKeyPem],
    debug: trace ? (m) => console.log('[ssh2dbg] ' + m) : null,
  }, (client) => {
    client.on('authentication', (ctx) => {
      if (trace) {
        console.log(`[mock-sftp] auth method=${ctx.method} user=${ctx.username}` +
          (ctx.method === 'password' ? ' pass=' + ctx.password : '') +
          (ctx.method === 'publickey' ? ' pk-present=' + !!(ctx.key && ctx.key.length) : ''));
      }
      const remaining = ['password', 'publickey'];
      if (ctx.method === 'password') {
        if (!passwordMode || ctx.username !== 'u' || ctx.password !== 'p') {
          return ctx.reject(remaining);
        }
        return ctx.accept();
      }
      if (ctx.method === 'publickey') {
        if (requirePublicKey && (!ctx.blob || Buffer.compare(ctx.blob, requirePublicKey) !== 0)) {
          return ctx.reject(['publickey']);
        }
        return ctx.accept();
      }
      ctx.reject(remaining);
    }).on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          const openFiles = new Map();
          let fdCount = 0;

          sftp.on('REALPATH', (reqid, path) => {
            sftp.name(reqid, [{
              filename: path === '.' ? '/' : normalize(path),
              longname: '',
              attrs: null,
            }]);
          });

          function statTarget(reqid, path) {
            const node = resolveNode(root, normalize(path));
            sftp.attrs(reqid, statReply(node));
          }
          sftp.on('STAT', (reqid, path) => statTarget(reqid, path));
          sftp.on('LSTAT', (reqid, path) => statTarget(reqid, path));

          sftp.on('OPEN', (reqid, filename, flags, attrs) => {
            const target = normalize(filename);
            let node = resolveNode(root, target);
            if (node && node.dir) {
              return sftp.status(reqid, STATUS_CODE.FAILURE);
            }
            if (!node) {
              const create = (flags & OPEN_MODE.CREAT) !== 0;
              const parent = lookup(root, target);
              if (!create || !parent || !parent.parent || !parent.parent.dir) {
                return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
              }
              node = new Node(false);
              node.data = Buffer.alloc(0);
              parent.parent.children.set(parent.name, node);
            }
            const write = (flags & OPEN_MODE.WRITE) !== 0;
            if (write && (flags & OPEN_MODE.TRUNC) !== 0) {
              node.data = Buffer.alloc(0);
            }
            const handle = Buffer.alloc(4);
            openFiles.set(fdCount, {
              node,
              write,
              append: (flags & OPEN_MODE.APPEND) !== 0,
            });
            handle.writeUInt32BE(fdCount++, 0, true);
            sftp.handle(reqid, handle);
          });

          sftp.on('READ', (reqid, handle, offset, length) => {
            const f = openFiles.get(handle.readUInt32BE(0, true));
            if (!f || f.write) {
              return sftp.status(reqid, STATUS_CODE.FAILURE);
            }
            if (offset >= f.node.data.length) {
              return sftp.status(reqid, STATUS_CODE.EOF);
            }
            const out = f.node.data.subarray(
              offset,
              Math.min(offset + length, f.node.data.length));
            sftp.data(reqid, out);
          });

          sftp.on('WRITE', (reqid, handle, offset, data) => {
            const f = openFiles.get(handle.readUInt32BE(0, true));
            if (!f || !f.write) {
              return sftp.status(reqid, STATUS_CODE.FAILURE);
            }
            const pos = f.append ? f.node.data.length : Number(offset);
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            if (pos + buf.length > f.node.data.length) {
              const grown = Buffer.alloc(pos + buf.length);
              f.node.data.copy(grown, 0);
              buf.copy(grown, pos);
              f.node.data = grown;
            }
            else {
              buf.copy(f.node.data, pos);
            }
            f.node.mtime = Math.floor(Date.now() / 1000);
            sftp.status(reqid, STATUS_CODE.OK);
          });

          sftp.on('CLOSE', (reqid, handle) => {
            openFiles.delete(handle.readUInt32BE(0, true));
            sftp.status(reqid, STATUS_CODE.OK);
          });

          sftp.on('OPENDIR', (reqid, path) => {
            const node = resolveNode(root, normalize(path));
            if (!node || !node.dir) {
              return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            }
            const handle = Buffer.alloc(4);
            openFiles.set(fdCount, { node, readdir: true, done: false });
            handle.writeUInt32BE(fdCount++, 0, true);
            sftp.handle(reqid, handle);
          });

          sftp.on('READDIR', (reqid, handle) => {
            const f = openFiles.get(handle.readUInt32BE(0, true));
            if (!f || !f.readdir) {
              return sftp.status(reqid, STATUS_CODE.FAILURE);
            }
            if (f.done) {
              return sftp.status(reqid, STATUS_CODE.EOF);
            }
            f.done = true;
            const names = [...f.node.children.entries()].map(([name, child]) => {
              const m = defaultMode(child);
              const pfx = child.dir ? 'drwxr-xr-x' : '-rw-r--r--';
              const size = child.dir ? 4096 : child.data.length;
              return {
                filename: name,
                longname: `${pfx}   1 root root ${size} Jan 1 2024 ${name}`,
                attrs: { mode: m, uid: 0, gid: 0, size, atime: child.mtime, mtime: child.mtime },
              };
            });
            sftp.name(reqid, names);
          });

          function applyAttrs(reqid, node, attrs) {
            if (denialMode) {
              return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
            }
            if (attrs && typeof attrs.mode === 'number') {
              // chmod stores raw permission bits; re-attach the file-type
              // nibble the way real filesystem types report STAT back
              node.mode = (attrs.mode & 0o7777) | (node.dir ? 0o040000 : 0o100000);
            }
            if (attrs && typeof attrs.mtime === 'number') {
              node.mtime = attrs.mtime;
            }
            sftp.status(reqid, STATUS_CODE.OK);
          }

          sftp.on('SETSTAT', (reqid, path, attrs) => {
            const node = resolveNode(root, normalize(path));
            if (!node) {
              return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            }
            applyAttrs(reqid, node, attrs);
          });

          sftp.on('FSETSTAT', (reqid, handle, attrs) => {
            const f = openFiles.get(handle.readUInt32BE(0, true));
            if (!f) {
              return sftp.status(reqid, STATUS_CODE.FAILURE);
            }
            applyAttrs(reqid, f.node, attrs);
          });

          sftp.on('FSTAT', (reqid, handle) => {
            const f = openFiles.get(handle.readUInt32BE(0, true));
            if (!f) {
              return sftp.status(reqid, STATUS_CODE.FAILURE);
            }
            sftp.attrs(reqid, statReply(f.node));
          });

          sftp.on('REMOVE', (reqid, path) => {
            const l = lookup(root, normalize(path));
            if (!l || !l.node || l.node.dir) {
              return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            }
            l.parent.children.delete(l.name);
            sftp.status(reqid, STATUS_CODE.OK);
          });

          sftp.on('MKDIR', (reqid, path) => {
            const l = lookup(root, normalize(path));
            if (!l || !l.parent || !l.parent.dir) {
              return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            }
            if (l.node) {
              return sftp.status(reqid, STATUS_CODE.FAILURE);
            }
            const n = new Node(true);
            n.children = new Map();
            l.parent.children.set(l.name, n);
            sftp.status(reqid, STATUS_CODE.OK);
          });

          sftp.on('RMDIR', (reqid, path) => {
            const l = lookup(root, normalize(path));
            if (!l || !l.node || !l.node.dir) {
              return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            }
            if (l.node.children.size > 0) {
              return sftp.status(reqid, STATUS_CODE.FAILURE);
            }
            l.parent.children.delete(l.name);
            sftp.status(reqid, STATUS_CODE.OK);
          });

          sftp.on('RENAME', (reqid, src, dest) => {
            const from = lookup(root, normalize(src));
            if (!from || !from.node) {
              return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            }
            const to = lookup(root, normalize(dest));
            if (to && to.node) {
              // POSIX-like: overwrite destination
              to.parent.children.delete(to.name);
            }
            if (!to || !to.parent || !to.parent.dir) {
              return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            }
            from.parent.children.delete(from.name);
            to.parent.children.set(to.name, from.node);
            sftp.status(reqid, STATUS_CODE.OK);
          });
        });
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        host: address.address,
        port: address.port,
        fingerprint: hostFpr,
        close: () =>
          new Promise((res) => {
            server.close(res);
            setTimeout(res, 50);
          }),
        root: () => root,
      });
    });
  });
}

function isDirBits(mode) {
  return (mode & 0o170000) === 0o040000;
}

module.exports = { startMockSftp, hostFingerprint };
