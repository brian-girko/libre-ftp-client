// api.js — high-level JS wrapper around the wasm ftp_engine for the Chrome
// extension. Load order:
//
//   const api = await FtpApi.create({ bridgeUrl: 'ws://127.0.0.1:PORT/TOKEN' });
//   const client = await api.connect({ host, port, user, password,
//                                      secure: 'auto'|'explicit'|'none'|'implicit',
//                                      allowSelfSigned, timeout, dataTls, utf8 });
//   const entries = await client.list('/path');           // parsed entries
//   const text    = await client.downloadText('/a.txt');  // whole-file
//   const blob    = await client.downloadBlob('/a.bin');  // Binary-safe
//   await client.uploadText('/b.txt', 'hello');
//   await client.chmod('/b.txt', '644');   // SITE CHMOD (server-dependent)
//   // streaming (memory-friendly for big files):
//   const s = await client.openDownload('/big.bin');
//   for (;;) { const chunk = await s.pull(); if (chunk === null) break; /* Uint8Array */ }
//   await client.uploadStream('/big.out', ReadableStream)  // or Blob / AsyncIterable
//   await client.quit();
//
// SFTP: FtpApi.create({ bridgeUrl, protocol: 'sftp' }) swaps the engine
// handle for the SSH/SFTP one; every Client method below works unchanged
// (auth adds privateKey/passphrase, host-key trust via trustFingerprints /
// allowSelfSigned; error code 'hostkey' carries the SHA-256 fingerprint —
// pin it and reconnect to implement TOFU).
//
// Errors are re-thrown as JS objects `{ code, ftp_code?, message, fingerprint? }`.

'use strict';

import init, { FtpClient, SshClient, set_bridge_url } from './ftp_engine.js';

let ready = null;

export class FtpApi {
  /**
   * Load the wasm engine. `bridgeUrl` is the ws:// URL of the ws-to-tls
   * bridge run alongside the extension (path token included). `protocol`
   * selects 'ftp' (default) or 'sftp' for connect() calls.
   */
  static async create({ bridgeUrl, wasmUrl, protocol = 'ftp' } = {}) {
    if (!bridgeUrl) {
      throw new TypeError('FtpApi.create: bridgeUrl is required');
    }
    if (protocol !== 'ftp' && protocol !== 'sftp') {
      throw new TypeError(`FtpApi.create: unknown protocol '${protocol}'`);
    }
    if (!ready) {
      ready = init(wasmUrl || undefined);
    }
    await ready;
    set_bridge_url(bridgeUrl);
    return new FtpApi(protocol);
  }

  constructor(protocol = 'ftp') {
    this.protocol = protocol;
  }

  /** Open + login. See the class doc for option keys. */
  async connect(opts) {
    if (!opts || !opts.host) {
      throw new TypeError('connect: host is required');
    }
    if (this.protocol === 'sftp') {
      const client = await SshClient.connect(
        opts.host,
        opts.port || 22,
        {
          user: opts.user || 'anonymous',
          password: opts.password || '',
          privateKey: opts.privateKey,
          passphrase: opts.passphrase,
          allowSelfSigned: !!opts.allowSelfSigned,
          trustFingerprints: opts.trustFingerprints,
          timeout: opts.timeout || 30000
        }
      );
      return new Client(client, this);
    }
    const client = await FtpClient.connect(
      opts.host,
      opts.port || 21,
      {
        user: opts.user || 'anonymous',
        password: opts.password || 'anonymous',
        secure: opts.secure || 'auto',
        allowSelfSigned: !!opts.allowSelfSigned,
        timeout: opts.timeout || 30000,
        dataTls: opts.dataTls !== false,
        utf8: opts.utf8 !== false
      }
    );
    return new Client(client, this);
  }
}

/** Chunked transfer handle for RETR (downloads). Returned by Client.openDownload. */
class DownloadStream {
  constructor(client, id) {
    this._client = client;
    this.id = id;
    this.total = 0;
    this._done = false;
  }

  /** Next chunk as Uint8Array, or null at end-of-file. */
  async pull(chunkSize = 262144) {
    if (this._done) {
      return null;
    }
    let chunk;
    try {
      chunk = await this._client.streamPull(this.id, chunkSize);
    }
    catch (e) {
      this._done = true;
      await this._safeAbort(this.id);
      throw e;
    }
    if (chunk === null || chunk === undefined) {
      this._done = true;
      return null;
    }
    const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    this.total += u8.length;
    return u8;
  }

  async _safeAbort(id) {
    try {
      await this._client.streamAbort(id);
    }
    catch {}
  }

  /** Abort the transfer early. */
  async abort() {
    this._done = true;
    await this._safeAbort(this.id);
  }
}

/**
 * Chunked upload handle for STOR/APPE. Ends with finish()/abort().
 * Prefer Client.uploadStream() for ReadableStream/Blob sources.
 */
class UploadStream {
  constructor(client, id) {
    this._client = client;
    this.id = id;
    this.total = 0;
    this._finished = false;
  }

  /** Push bytes (Uint8Array/ArrayBuffer) and return the running total. */
  async push(data) {
    if (this._finished) {
      throw new Error('upload already finished');
    }
    const u8 = data instanceof Uint8Array
      ? data
      : data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.total = await this._client.streamPush(this.id, u8);
    return this.total;
  }

  /** Close the data channel and consume the final server reply. */
  async finish() {
    if (this._finished) {
      return this.total;
    }
    this._finished = true;
    const total = await this._client.streamFinish(this.id);
    this.total = total;
    return total;
  }

  /** Abort the upload (data channel closed, ABOR sent). */
  async abort() {
    if (this._finished) {
      return;
    }
    this._finished = true;
    try {
      await this._client.streamAbort(this.id);
    }
    catch {}
  }
}

/** A logged-in FTP/FTPS session. */
export class Client {
  constructor(wasmClient, api) {
    this._client = wasmClient;
    this._api = api;
  }

  /** Protocol state {host, port, tls, data_tls, utf8, syst, cwd, feats}.
   */
  state() {
    return this._client.state();
  }

  is_tls() {
    return this._client.is_tls();
  }

  /** Directory listing. kind: 'auto' (default) | 'unix' | 'dos' | 'mlsd' | 'names'. */
  async list(path = '.', kind = 'auto') {
    const raw = await this._client.list(path, kind);
    return raw;
  }

  /** PWD / CWD / CDUP. */
  async pwd() {
    return (await this._client.pwd()).path;
  }

  async cwd(path) {
    return (await this._client.cwd(path)).path;
  }

  async cdUp() {
    return (await this._client.cd_up()).path;
  }

  /** SIZE / MDTM helpers. */
  async size(path) {
    return this._client.size(path);
  }

  async mtime(path) {
    return this._client.mdtm(path);
  }

  async setMtime(path, epochMillis) {
    return this._client.set_mtime(path, epochMillis);
  }

  /**
   * Change permissions via SITE CHMOD (server-dependent: most Unix FTP
   * servers implement it, some do not). `mode` is an octal string
   * ("644", "4755") or an integer of octal bits (0o644 = 493).
   */
  async chmod(path, mode) {
    if (typeof mode === 'number') {
      if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
        throw new TypeError('chmod: mode must be an integer 0..0o7777 or an octal string');
      }
      return this._client.chmod(path, mode.toString(8));
    }
    return this._client.chmod(path, String(mode || '').trim());
  }

  /** Single-file metadata: MLST, falls back to SIZE+MDTM. */
  async statFile(path) {
    const mlst = await this._client.mlst(path);
    if (mlst) {
      return mlst;
    }
    const [size, mtime] = await (async () => {
      // the engine borrows FtpClient mutably per call: queued/concurrent
      // engine futures would alias, so size and mdtm run strictly serial
      const size = await this._client.size(path);
      const mtime = await this._client.mdtm(path);
      return [size, mtime];
    })();
    return {
      name: path,
      dir: false,
      size: size === null || size === undefined ? undefined : size,
      mtime: mtime === null || mtime === undefined ? undefined : mtime
    };
  }

  /** File management. */
  async mkdir(path) {
    return this._client.mkdir(path);
  }

  async rmdir(path) {
    return this._client.rmdir(path);
  }

  async delete(path) {
    return this._client.delete(path);
  }

  async rename(from, to) {
    return this._client.rename(from, to);
  }

  /** STAT (server status text). */
  async stat() {
    return this._client.stat();
  }

  /** Keepalive ping. */
  async noop() {
    return this._client.noop();
  }

  /** Download a whole file as bytes. */
  async download(path) {
    return this._client.download(path, 262144);
  }

  /** Download a whole file as text (UTF-8). */
  async downloadText(path) {
    const bytes = await this.download(path);
    return new TextDecoder().decode(bytes);
  }

  /** Download as a Blob (Binary-safe, ready for the File System Access API). */
  async downloadBlob(path) {
    const bytes = await this.download(path);
    return new Blob([bytes]);
  }

  /** Chunked download handle; loop `pull()` until null. */
  async openDownload(path, offset = 0) {
    const id = await this._client.streamStartGet(path, offset);
    return new DownloadStream(this._client, id);
  }

  /**
   * Chunked upload handle for push()/finish()/abort() callers (the
   * transfer queue streams the local File in chunks). Mirrors openDownload.
   */
  async openUpload(path, {append = false, offset = 0} = {}) {
    const id = await this._client.streamStartPut(path, !!append, offset || 0);
    return new UploadStream(this._client, id);
  }

  /** Download to a ReadableStream (works with the Streams API). */
  downloadToStream(path, offset = 0) {
    const self = this;
    return new ReadableStream({
      async start(controller) {
        let handle = null;
        try {
          handle = await self.openDownload(path, offset);
          for (;;) {
            const chunk = await handle.pull();
            if (chunk === null) {
              break;
            }
            controller.enqueue(chunk);
          }
          controller.close();
        }
        catch (e) {
          try {
            if (handle) {
              await handle.abort();
            }
          }
          catch {}
          controller.error(e);
        }
      }
    });
  }

  /** Upload a whole file (string/bytes). */
  async upload(path, data) {
    if (typeof data === 'string') {
      data = new TextEncoder().encode(data);
    }
    return this._client.upload(path, data);
  }

  async uploadText(path, text) {
    return this.upload(path, text);
  }

  /**
   * Upload from a Blob, ReadableStream or AsyncIterable of chunks
   * (Uint8Array/ArrayBuffer). Consumed in 128 KiB pieces.
   */
  async uploadStream(path, source, { append = false, offset = 0 } = {}) {
    const id = await this._client.streamStartPut(path, append, offset);
    const handle = new UploadStream(this._client, id);
    const pushSource = async () => {
      let src = source;
      // Blob -> web stream
      if (typeof Blob !== 'undefined' && src instanceof Blob) {
        src = src.stream();
      }
      // ReadableStream with an explicit reader
      if (src && typeof src.getReader === 'function') {
        const reader = src.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          await handle.push(value);
        }
        return;
      }
      // AsyncIterable
      if (src && typeof src[Symbol.asyncIterator] === 'function') {
        for await (const chunk of src) {
          await handle.push(chunk);
        }
        return;
      }
      // plain bytes
      if (src && (src instanceof Uint8Array || src instanceof ArrayBuffer)) {
        await handle.push(src);
        return;
      }
      throw new TypeError('uploadStream: unsupported source');
    };
    try {
      await pushSource();
      return await handle.finish();
    }
    catch (e) {
      await handle.abort();
      throw e;
    }
  }

  /** Abort any in-flight transfer. */
  async abortTransfer(id) {
    return this._client.streamAbort(id);
  }

  /** QUIT + drop. */
  async quit() {
    await this._client.quit();
  }

  /** Hard close of the socket. */
  async close() {
    await this._client.abort();
  }
}
