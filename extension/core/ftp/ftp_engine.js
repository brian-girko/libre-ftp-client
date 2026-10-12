/* @ts-self-types="./ftp_engine.d.ts" */

/**
 * The engine handle: one `FtpClient` per FTP connection.
 */
export class FtpClient {
    static __wrap(ptr) {
        const obj = Object.create(FtpClient.prototype);
        obj.__wbg_ptr = ptr;
        FtpClientFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FtpClientFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ftpclient_free(ptr, 0);
    }
    /**
     * Force-close without QUIT.
     * @returns {Promise<void>}
     */
    abort() {
        const ret = wasm.ftpclient_abort(this.__wbg_ptr);
        return ret;
    }
    /**
     * Go up one directory.
     * @returns {Promise<any>}
     */
    cd_up() {
        const ret = wasm.ftpclient_cd_up(this.__wbg_ptr);
        return ret;
    }
    /**
     * Change file/dir permissions via `SITE CHMOD` (server support varies).
     * `mode` is an octal string such as "644" or "4755".
     * @param {string} path
     * @param {string} mode
     * @returns {Promise<void>}
     */
    chmod(path, mode) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.ftpclient_chmod(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return ret;
    }
    /**
     * Establish a connection and log in.
     * `opts` accepts {user, password, secure, allowSelfSigned, timeout, utf8, dataTls}.
     * @param {string} host
     * @param {number} port
     * @param {any} opts
     * @returns {Promise<FtpClient>}
     */
    static connect(host, port, opts) {
        const ptr0 = passStringToWasm0(host, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ftpclient_connect(ptr0, len0, port, opts);
        return ret;
    }
    /**
     * Change directory; reply path is returned.
     * @param {string} path
     * @returns {Promise<any>}
     */
    cwd(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ftpclient_cwd(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * @returns {boolean}
     */
    data_tls_on() {
        const ret = wasm.ftpclient_data_tls_on(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {string} path
     * @returns {Promise<void>}
     */
    delete(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ftpclient_delete(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Simple whole-file download into memory.
     * @param {string} path
     * @param {number} chunk
     * @returns {Promise<Uint8Array>}
     */
    download(path, chunk) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ftpclient_download(this.__wbg_ptr, ptr0, len0, chunk);
        return ret;
    }
    /**
     * @returns {boolean}
     */
    is_connected() {
        const ret = wasm.ftpclient_is_connected(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {boolean}
     */
    is_tls() {
        const ret = wasm.ftpclient_is_tls(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Directory listing; `kind` is one of "auto"|"unix"|"dos"|"mlsd"|"names".
     * @param {string} path
     * @param {string} kind
     * @returns {Promise<any>}
     */
    list(path, kind) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(kind, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.ftpclient_list(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return ret;
    }
    /**
     * File mtime in epoch millis (None when not supported/absent).
     * @param {string} path
     * @returns {Promise<number | undefined>}
     */
    mdtm(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ftpclient_mdtm(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * @param {string} path
     * @returns {Promise<void>}
     */
    mkdir(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ftpclient_mkdir(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * MLST metadata for one path (None if unsupported).
     * @param {string} path
     * @returns {Promise<any>}
     */
    mlst(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ftpclient_mlst(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * @returns {Promise<void>}
     */
    noop() {
        const ret = wasm.ftpclient_noop(this.__wbg_ptr);
        return ret;
    }
    /**
     * Current directory (cached `PWD`).
     * @returns {Promise<any>}
     */
    pwd() {
        const ret = wasm.ftpclient_pwd(this.__wbg_ptr);
        return ret;
    }
    /**
     * Send QUIT and drop the connection.
     * @returns {Promise<void>}
     */
    quit() {
        const ret = wasm.ftpclient_quit(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {string} from
     * @param {string} to
     * @returns {Promise<void>}
     */
    rename(from, to) {
        const ptr0 = passStringToWasm0(from, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(to, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.ftpclient_rename(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return ret;
    }
    /**
     * @param {string} path
     * @returns {Promise<void>}
     */
    rmdir(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ftpclient_rmdir(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Set mtime (MFMT). Returns whether the server accepted it.
     * @param {string} path
     * @param {number} mtime
     * @returns {Promise<boolean>}
     */
    set_mtime(path, mtime) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ftpclient_set_mtime(this.__wbg_ptr, ptr0, len0, mtime);
        return ret;
    }
    /**
     * File size in bytes (None when the server lacks SIZE / the file is absent).
     * @param {string} path
     * @returns {Promise<number | undefined>}
     */
    size(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ftpclient_size(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Server status text (`STAT` without args).
     * @returns {Promise<string>}
     */
    stat() {
        const ret = wasm.ftpclient_stat(this.__wbg_ptr);
        return ret;
    }
    /**
     * `STAT <path>` listing-style metadata.
     * @param {string} path
     * @returns {Promise<string>}
     */
    stat_path(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ftpclient_stat_path(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Full session state (features, tls, cwd, transfer ids).
     * @returns {any}
     */
    state() {
        const ret = wasm.ftpclient_state(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Streaming mode — abort any in-flight transfer.
     * @param {number} id
     * @returns {Promise<void>}
     */
    streamAbort(id) {
        const ret = wasm.ftpclient_streamAbort(this.__wbg_ptr, id);
        return ret;
    }
    /**
     * Streaming mode — finish an upload and consume the final reply.
     * @param {number} id
     * @returns {Promise<number>}
     */
    streamFinish(id) {
        const ret = wasm.ftpclient_streamFinish(this.__wbg_ptr, id);
        return ret;
    }
    /**
     * Streaming mode — pull the next download chunk (`None` = done).
     * @param {number} id
     * @param {number} max_chunk
     * @returns {Promise<Uint8Array | undefined>}
     */
    streamPull(id, max_chunk) {
        const ret = wasm.ftpclient_streamPull(this.__wbg_ptr, id, max_chunk);
        return ret;
    }
    /**
     * Streaming mode — push one upload chunk (returns the total sent).
     * @param {number} id
     * @param {Uint8Array} data
     * @returns {Promise<number>}
     */
    streamPush(id, data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ftpclient_streamPush(this.__wbg_ptr, id, ptr0, len0);
        return ret;
    }
    /**
     * Streaming mode — begin a download in chunks; returns a transfer id.
     * @param {string} path
     * @param {number} offset
     * @returns {Promise<number>}
     */
    streamStartGet(path, offset) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ftpclient_streamStartGet(this.__wbg_ptr, ptr0, len0, offset);
        return ret;
    }
    /**
     * Streaming mode — begin an upload; returns a transfer id.
     * @param {string} path
     * @param {boolean} append
     * @param {number} offset
     * @returns {Promise<number>}
     */
    streamStartPut(path, append, offset) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ftpclient_streamStartPut(this.__wbg_ptr, ptr0, len0, append, offset);
        return ret;
    }
    /**
     * SYST banner.
     * @returns {Promise<string>}
     */
    syst() {
        const ret = wasm.ftpclient_syst(this.__wbg_ptr);
        return ret;
    }
    /**
     * Simple whole-file upload from memory.
     * @param {string} path
     * @param {Uint8Array} data
     * @returns {Promise<number>}
     */
    upload(path, data) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.ftpclient_upload(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return ret;
    }
}
if (Symbol.dispose) FtpClient.prototype[Symbol.dispose] = FtpClient.prototype.free;

export class SshClient {
    static __wrap(ptr) {
        const obj = Object.create(SshClient.prototype);
        obj.__wbg_ptr = ptr;
        SshClientFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SshClientFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_sshclient_free(ptr, 0);
    }
    /**
     * Force-close without protocol shutdown.
     * @returns {Promise<void>}
     */
    abort() {
        const ret = wasm.sshclient_abort(this.__wbg_ptr);
        return ret;
    }
    /**
     * Go up one directory.
     * @returns {Promise<any>}
     */
    cd_up() {
        const ret = wasm.sshclient_cd_up(this.__wbg_ptr);
        return ret;
    }
    /**
     * Change permissions via SFTP setstat. `mode` is an octal string
     * ("644") — no server-side SITE CHMOD lottery here.
     * @param {string} path
     * @param {string} mode
     * @returns {Promise<void>}
     */
    chmod(path, mode) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.sshclient_chmod(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return ret;
    }
    /**
     * Establish the SSH connection (KEX + host-key policy) and log in.
     * @param {string} host
     * @param {number} port
     * @param {any} opts
     * @returns {Promise<SshClient>}
     */
    static connect(host, port, opts) {
        const ptr0 = passStringToWasm0(host, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sshclient_connect(ptr0, len0, port, opts);
        return ret;
    }
    /**
     * Change directory (resolved + canonicalized server-side).
     * @param {string} path
     * @returns {Promise<any>}
     */
    cwd(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sshclient_cwd(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * @returns {boolean}
     */
    data_tls_on() {
        const ret = wasm.sshclient_data_tls_on(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {string} path
     * @returns {Promise<void>}
     */
    delete(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sshclient_delete(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Simple whole-file download into memory.
     * @param {string} path
     * @param {number} chunk
     * @returns {Promise<Uint8Array>}
     */
    download(path, chunk) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sshclient_download(this.__wbg_ptr, ptr0, len0, chunk);
        return ret;
    }
    /**
     * @returns {boolean}
     */
    is_connected() {
        const ret = wasm.sshclient_is_connected(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {boolean}
     */
    is_tls() {
        const ret = wasm.sshclient_is_tls(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Directory listing; `kind` is honored for API parity ("auto" etc.).
     * @param {string} path
     * @param {string} kind
     * @returns {Promise<any>}
     */
    list(path, kind) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(kind, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.sshclient_list(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return ret;
    }
    /**
     * File mtime in epoch millis (None when the server reports no time).
     * @param {string} path
     * @returns {Promise<number | undefined>}
     */
    mdtm(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sshclient_mdtm(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * @param {string} path
     * @returns {Promise<void>}
     */
    mkdir(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sshclient_mkdir(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Single-file metadata (mirrors FTP MLST for the wrapper's statFile).
     * @param {string} path
     * @returns {Promise<any>}
     */
    mlst(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sshclient_mlst(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * @returns {Promise<void>}
     */
    noop() {
        const ret = wasm.sshclient_noop(this.__wbg_ptr);
        return ret;
    }
    /**
     * Current directory (client-tracked starts at the server home path).
     * @returns {Promise<any>}
     */
    pwd() {
        const ret = wasm.sshclient_pwd(this.__wbg_ptr);
        return ret;
    }
    /**
     * Send QUIT-equivalents and drop the connection.
     * @returns {Promise<void>}
     */
    quit() {
        const ret = wasm.sshclient_quit(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {string} from
     * @param {string} to
     * @returns {Promise<void>}
     */
    rename(from, to) {
        const ptr0 = passStringToWasm0(from, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(to, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.sshclient_rename(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return ret;
    }
    /**
     * @param {string} path
     * @returns {Promise<void>}
     */
    rmdir(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sshclient_rmdir(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Set mtime (SFTP setstat). Returns false when unsupported.
     * @param {string} path
     * @param {number} mtime
     * @returns {Promise<boolean>}
     */
    set_mtime(path, mtime) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sshclient_set_mtime(this.__wbg_ptr, ptr0, len0, mtime);
        return ret;
    }
    /**
     * File size in bytes (None when the server reports no size / absent).
     * @param {string} path
     * @returns {Promise<number | undefined>}
     */
    size(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sshclient_size(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Protocol state (cwd, host, port). `feats` is FTP-specific and thus
     * absent for SFTP.
     * @returns {any}
     */
    state() {
        const ret = wasm.sshclient_state(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Streaming mode — abort any in-flight transfer.
     * @param {number} id
     * @returns {Promise<void>}
     */
    streamAbort(id) {
        const ret = wasm.sshclient_streamAbort(this.__wbg_ptr, id);
        return ret;
    }
    /**
     * Streaming mode — finish an upload and consume the final reply.
     * @param {number} id
     * @returns {Promise<number>}
     */
    streamFinish(id) {
        const ret = wasm.sshclient_streamFinish(this.__wbg_ptr, id);
        return ret;
    }
    /**
     * Streaming mode — pull the next download chunk (`None` = done).
     * @param {number} id
     * @param {number} max_chunk
     * @returns {Promise<Uint8Array | undefined>}
     */
    streamPull(id, max_chunk) {
        const ret = wasm.sshclient_streamPull(this.__wbg_ptr, id, max_chunk);
        return ret;
    }
    /**
     * Streaming mode — push one upload chunk (returns the total sent).
     * @param {number} id
     * @param {Uint8Array} data
     * @returns {Promise<number>}
     */
    streamPush(id, data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sshclient_streamPush(this.__wbg_ptr, id, ptr0, len0);
        return ret;
    }
    /**
     * Streaming mode — begin a download in chunks; returns a transfer id.
     * @param {string} path
     * @param {number} offset
     * @returns {Promise<number>}
     */
    streamStartGet(path, offset) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sshclient_streamStartGet(this.__wbg_ptr, ptr0, len0, offset);
        return ret;
    }
    /**
     * Streaming mode — begin an upload; returns a transfer id.
     * @param {string} path
     * @param {boolean} append
     * @param {number} offset
     * @returns {Promise<number>}
     */
    streamStartPut(path, append, offset) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sshclient_streamStartPut(this.__wbg_ptr, ptr0, len0, append, offset);
        return ret;
    }
    /**
     * Simple whole-file upload from memory.
     * @param {string} path
     * @param {Uint8Array} data
     * @returns {Promise<number>}
     */
    upload(path, data) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.sshclient_upload(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return ret;
    }
}
if (Symbol.dispose) SshClient.prototype[Symbol.dispose] = SshClient.prototype.free;

/**
 * @param {string} url
 */
export function set_bridge_url(url) {
    const ptr0 = passStringToWasm0(url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    wasm.set_bridge_url(ptr0, len0);
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_boolean_get_5b446f51afd21013: function(arg0) {
            const v = arg0;
            const ret = typeof(v) === 'boolean' ? v : undefined;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg___wbindgen_is_function_1f9d30630b8b1d3d: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_3c45d4f2dde4e749: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_90b56bc79aad6f6c: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_8865fb403f8fe9d8: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_number_get_2e0e7dee9f701a71: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_0380ccaa2f57f0d9: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg__wbg_cb_unref_dcc1a90847f04c41: function(arg0) {
            arg0._wbg_cb_unref();
        },
        __wbg_buffer_59994592d66a1b3d: function(arg0) {
            const ret = arg0.buffer;
            return ret;
        },
        __wbg_call_187d372bd5fdd4aa: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_clearTimeout_3629d6209dfcc46e: function(arg0) {
            const ret = clearTimeout(arg0);
            return ret;
        },
        __wbg_close_d3ed56b5763be5ae: function() { return handleError(function (arg0) {
            arg0.close();
        }, arguments); },
        __wbg_crypto_38df2bab126b63dc: function(arg0) {
            const ret = arg0.crypto;
            return ret;
        },
        __wbg_data_522f7abc70721269: function(arg0) {
            const ret = arg0.data;
            return ret;
        },
        __wbg_error_c9cf3fc2064683a9: function(arg0) {
            console.error(arg0);
        },
        __wbg_ftpclient_new: function(arg0) {
            const ret = FtpClient.__wrap(arg0);
            return ret;
        },
        __wbg_getRandomValues_c44a50d8cfdaebeb: function() { return handleError(function (arg0, arg1) {
            arg0.getRandomValues(arg1);
        }, arguments); },
        __wbg_getTime_f5a55efff2585d5d: function(arg0) {
            const ret = arg0.getTime();
            return ret;
        },
        __wbg_get_31af05bd4842a84f: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_6c896e0571ddae51: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_instanceof_ArrayBuffer_a99f175873e5d9b8: function(arg0) {
            let result;
            try {
                result = arg0 instanceof ArrayBuffer;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_DataView_4f9fea5468c31bdb: function(arg0) {
            let result;
            try {
                result = arg0 instanceof DataView;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_ErrorEvent_00c7c57424cd686a: function(arg0) {
            let result;
            try {
                result = arg0 instanceof ErrorEvent;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Uint8Array_828cef2aaacafc31: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isArray_2b41c29f43a3fb12: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_isArray_e15a2ff68ffdbef2: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_length_7f3c00c40364105e: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_d4bdea10311bd9cf: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_message_49f5412048473de5: function(arg0, arg1) {
            const ret = arg1.message;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_msCrypto_bd5a034af96bcba6: function(arg0) {
            const ret = arg0.msCrypto;
            return ret;
        },
        __wbg_new_0_72d020f0c63443d4: function() {
            const ret = new Date();
            return ret;
        },
        __wbg_new_1dbf7428bba60a42: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_new_4059fb0406225e04: function() { return handleError(function (arg0, arg1) {
            const ret = new WebSocket(getStringFromWasm0(arg0, arg1));
            return ret;
        }, arguments); },
        __wbg_new_typed_b01cb72a8af741a3: function(arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen_f05d8ca27ebfc8d0___convert__closures_____invoke___js_sys_b0f7a9544c2cd068___Function_fn_wasm_bindgen_f05d8ca27ebfc8d0___JsValue_____wasm_bindgen_f05d8ca27ebfc8d0___sys__Undefined___js_sys_b0f7a9544c2cd068___Function_fn_wasm_bindgen_f05d8ca27ebfc8d0___JsValue_____wasm_bindgen_f05d8ca27ebfc8d0___sys__Undefined_______true_(a, state0.b, arg0, arg1);
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = new Promise(cb0);
                return ret;
            } finally {
                state0.a = 0;
            }
        },
        __wbg_new_with_length_3da0ad195f6f63ba: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_node_84ea875411254db1: function(arg0) {
            const ret = arg0.node;
            return ret;
        },
        __wbg_now_aa4ccb83129e9e55: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_parse_0fc53dead14b3b42: function() { return handleError(function (arg0, arg1) {
            const ret = JSON.parse(getStringFromWasm0(arg0, arg1));
            return ret;
        }, arguments); },
        __wbg_process_44c7a14e11e9f69e: function(arg0) {
            const ret = arg0.process;
            return ret;
        },
        __wbg_prototypesetcall_bc27214492979395: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_queueMicrotask_9833f9a49df95a49: function(arg0) {
            const ret = arg0.queueMicrotask;
            return ret;
        },
        __wbg_queueMicrotask_a72f977e97f23c5f: function(arg0) {
            queueMicrotask(arg0);
        },
        __wbg_randomFillSync_6c25eac9869eb53c: function() { return handleError(function (arg0, arg1) {
            arg0.randomFillSync(arg1);
        }, arguments); },
        __wbg_require_b4edbdcf3e2a1ef0: function() { return handleError(function () {
            const ret = module.require;
            return ret;
        }, arguments); },
        __wbg_resolve_0076e10020304ede: function(arg0) {
            const ret = Promise.resolve(arg0);
            return ret;
        },
        __wbg_send_b5bdd806efe4baf6: function() { return handleError(function (arg0, arg1, arg2) {
            arg0.send(getStringFromWasm0(arg1, arg2));
        }, arguments); },
        __wbg_send_c1dad0ec2e52defb: function() { return handleError(function (arg0, arg1, arg2) {
            arg0.send(getArrayU8FromWasm0(arg1, arg2));
        }, arguments); },
        __wbg_setTimeout_56bcdccbad22fd44: function() { return handleError(function (arg0, arg1) {
            const ret = setTimeout(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_set_binaryType_21835bf0df8f70aa: function(arg0, arg1) {
            arg0.binaryType = __wbindgen_enum_BinaryType[arg1];
        },
        __wbg_set_onclose_a84370531f3d2948: function(arg0, arg1) {
            arg0.onclose = arg1;
        },
        __wbg_set_onerror_94ee307653399172: function(arg0, arg1) {
            arg0.onerror = arg1;
        },
        __wbg_set_onmessage_cb6f77d2d8e0402a: function(arg0, arg1) {
            arg0.onmessage = arg1;
        },
        __wbg_set_onopen_c914147e8a2db4b0: function(arg0, arg1) {
            arg0.onopen = arg1;
        },
        __wbg_sshclient_new: function(arg0) {
            const ret = SshClient.__wrap(arg0);
            return ret;
        },
        __wbg_static_accessor_GLOBAL_266715b9d96ba635: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_10fb7dc1ae063179: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_0b583911f537483a: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_d7f903d1508cbdc4: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_subarray_002b94d5e13d1411: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_then_e71170d78fcf8954: function(arg0, arg1) {
            const ret = arg0.then(arg1);
            return ret;
        },
        __wbg_versions_276b2795b1c6a219: function(arg0) {
            const ret = arg0.versions;
            return ret;
        },
        __wbindgen_generic_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 1790, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_f05d8ca27ebfc8d0___convert__closures_____invoke___wasm_bindgen_f05d8ca27ebfc8d0___JsValue__core_608f92abc48d28da___result__Result_____wasm_bindgen_f05d8ca27ebfc8d0___JsError___true_);
            return ret;
        },
        __wbindgen_generic_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 558, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_f05d8ca27ebfc8d0___convert__closures_____invoke___wasm_bindgen_f05d8ca27ebfc8d0___JsValue______true_);
            return ret;
        },
        __wbindgen_generic_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [], shim_idx: 655, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_f05d8ca27ebfc8d0___convert__closures_____invoke_______true_);
            return ret;
        },
        __wbindgen_generic_0000000000000004: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_generic_0000000000000005: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_generic_0000000000000006: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_generic_0000000000000007: function(arg0, arg1) {
            var v0 = getArrayU8FromWasm0(arg0, arg1).slice();
            wasm.__wbindgen_free(arg0, arg1 * 1, 1);
            // Cast intrinsic for `Vector(U8) -> Externref`.
            const ret = v0;
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./ftp_engine_bg.js": import0,
    };
}

function wasm_bindgen_f05d8ca27ebfc8d0___convert__closures_____invoke_______true_(arg0, arg1) {
    wasm.wasm_bindgen_f05d8ca27ebfc8d0___convert__closures_____invoke_______true_(arg0, arg1);
}

function wasm_bindgen_f05d8ca27ebfc8d0___convert__closures_____invoke___wasm_bindgen_f05d8ca27ebfc8d0___JsValue______true_(arg0, arg1, arg2) {
    wasm.wasm_bindgen_f05d8ca27ebfc8d0___convert__closures_____invoke___wasm_bindgen_f05d8ca27ebfc8d0___JsValue______true_(arg0, arg1, arg2);
}

function wasm_bindgen_f05d8ca27ebfc8d0___convert__closures_____invoke___wasm_bindgen_f05d8ca27ebfc8d0___JsValue__core_608f92abc48d28da___result__Result_____wasm_bindgen_f05d8ca27ebfc8d0___JsError___true_(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen_f05d8ca27ebfc8d0___convert__closures_____invoke___wasm_bindgen_f05d8ca27ebfc8d0___JsValue__core_608f92abc48d28da___result__Result_____wasm_bindgen_f05d8ca27ebfc8d0___JsError___true_(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen_f05d8ca27ebfc8d0___convert__closures_____invoke___js_sys_b0f7a9544c2cd068___Function_fn_wasm_bindgen_f05d8ca27ebfc8d0___JsValue_____wasm_bindgen_f05d8ca27ebfc8d0___sys__Undefined___js_sys_b0f7a9544c2cd068___Function_fn_wasm_bindgen_f05d8ca27ebfc8d0___JsValue_____wasm_bindgen_f05d8ca27ebfc8d0___sys__Undefined_______true_(arg0, arg1, arg2, arg3) {
    wasm.wasm_bindgen_f05d8ca27ebfc8d0___convert__closures_____invoke___js_sys_b0f7a9544c2cd068___Function_fn_wasm_bindgen_f05d8ca27ebfc8d0___JsValue_____wasm_bindgen_f05d8ca27ebfc8d0___sys__Undefined___js_sys_b0f7a9544c2cd068___Function_fn_wasm_bindgen_f05d8ca27ebfc8d0___JsValue_____wasm_bindgen_f05d8ca27ebfc8d0___sys__Undefined_______true_(arg0, arg1, arg2, arg3);
}


const __wbindgen_enum_BinaryType = ["blob", "arraybuffer"];
const FtpClientFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ftpclient_free(ptr, 1));
const SshClientFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sshclient_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => wasm.__wbindgen_destroy_closure(state.a, state.b));

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function makeMutClosure(arg0, arg1, f) {
    const state = { a: arg0, b: arg1, cnt: 1 };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            state.a = a;
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            wasm.__wbindgen_destroy_closure(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('ftp_engine_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
