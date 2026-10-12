/* tslint:disable */
/* eslint-disable */

/**
 * The engine handle: one `FtpClient` per FTP connection.
 */
export class FtpClient {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Force-close without QUIT.
     */
    abort(): Promise<void>;
    /**
     * Go up one directory.
     */
    cd_up(): Promise<any>;
    /**
     * Change file/dir permissions via `SITE CHMOD` (server support varies).
     * `mode` is an octal string such as "644" or "4755".
     */
    chmod(path: string, mode: string): Promise<void>;
    /**
     * Establish a connection and log in.
     * `opts` accepts {user, password, secure, allowSelfSigned, timeout, utf8, dataTls}.
     */
    static connect(host: string, port: number, opts: any): Promise<FtpClient>;
    /**
     * Change directory; reply path is returned.
     */
    cwd(path: string): Promise<any>;
    data_tls_on(): boolean;
    delete(path: string): Promise<void>;
    /**
     * Simple whole-file download into memory.
     */
    download(path: string, chunk: number): Promise<Uint8Array>;
    is_connected(): boolean;
    is_tls(): boolean;
    /**
     * Directory listing; `kind` is one of "auto"|"unix"|"dos"|"mlsd"|"names".
     */
    list(path: string, kind: string): Promise<any>;
    /**
     * File mtime in epoch millis (None when not supported/absent).
     */
    mdtm(path: string): Promise<number | undefined>;
    mkdir(path: string): Promise<void>;
    /**
     * MLST metadata for one path (None if unsupported).
     */
    mlst(path: string): Promise<any>;
    noop(): Promise<void>;
    /**
     * Current directory (cached `PWD`).
     */
    pwd(): Promise<any>;
    /**
     * Send QUIT and drop the connection.
     */
    quit(): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    /**
     * Set mtime (MFMT). Returns whether the server accepted it.
     */
    set_mtime(path: string, mtime: number): Promise<boolean>;
    /**
     * File size in bytes (None when the server lacks SIZE / the file is absent).
     */
    size(path: string): Promise<number | undefined>;
    /**
     * Server status text (`STAT` without args).
     */
    stat(): Promise<string>;
    /**
     * `STAT <path>` listing-style metadata.
     */
    stat_path(path: string): Promise<string>;
    /**
     * Full session state (features, tls, cwd, transfer ids).
     */
    state(): any;
    /**
     * Streaming mode — abort any in-flight transfer.
     */
    streamAbort(id: number): Promise<void>;
    /**
     * Streaming mode — finish an upload and consume the final reply.
     */
    streamFinish(id: number): Promise<number>;
    /**
     * Streaming mode — pull the next download chunk (`None` = done).
     */
    streamPull(id: number, max_chunk: number): Promise<Uint8Array | undefined>;
    /**
     * Streaming mode — push one upload chunk (returns the total sent).
     */
    streamPush(id: number, data: Uint8Array): Promise<number>;
    /**
     * Streaming mode — begin a download in chunks; returns a transfer id.
     */
    streamStartGet(path: string, offset: number): Promise<number>;
    /**
     * Streaming mode — begin an upload; returns a transfer id.
     */
    streamStartPut(path: string, append: boolean, offset: number): Promise<number>;
    /**
     * SYST banner.
     */
    syst(): Promise<string>;
    /**
     * Simple whole-file upload from memory.
     */
    upload(path: string, data: Uint8Array): Promise<number>;
}

export class SshClient {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Force-close without protocol shutdown.
     */
    abort(): Promise<void>;
    /**
     * Go up one directory.
     */
    cd_up(): Promise<any>;
    /**
     * Change permissions via SFTP setstat. `mode` is an octal string
     * ("644") — no server-side SITE CHMOD lottery here.
     */
    chmod(path: string, mode: string): Promise<void>;
    /**
     * Establish the SSH connection (KEX + host-key policy) and log in.
     */
    static connect(host: string, port: number, opts: any): Promise<SshClient>;
    /**
     * Change directory (resolved + canonicalized server-side).
     */
    cwd(path: string): Promise<any>;
    data_tls_on(): boolean;
    delete(path: string): Promise<void>;
    /**
     * Simple whole-file download into memory.
     */
    download(path: string, chunk: number): Promise<Uint8Array>;
    is_connected(): boolean;
    is_tls(): boolean;
    /**
     * Directory listing; `kind` is honored for API parity ("auto" etc.).
     */
    list(path: string, kind: string): Promise<any>;
    /**
     * File mtime in epoch millis (None when the server reports no time).
     */
    mdtm(path: string): Promise<number | undefined>;
    mkdir(path: string): Promise<void>;
    /**
     * Single-file metadata (mirrors FTP MLST for the wrapper's statFile).
     */
    mlst(path: string): Promise<any>;
    noop(): Promise<void>;
    /**
     * Current directory (client-tracked starts at the server home path).
     */
    pwd(): Promise<any>;
    /**
     * Send QUIT-equivalents and drop the connection.
     */
    quit(): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    /**
     * Set mtime (SFTP setstat). Returns false when unsupported.
     */
    set_mtime(path: string, mtime: number): Promise<boolean>;
    /**
     * File size in bytes (None when the server reports no size / absent).
     */
    size(path: string): Promise<number | undefined>;
    /**
     * Protocol state (cwd, host, port). `feats` is FTP-specific and thus
     * absent for SFTP.
     */
    state(): any;
    /**
     * Streaming mode — abort any in-flight transfer.
     */
    streamAbort(id: number): Promise<void>;
    /**
     * Streaming mode — finish an upload and consume the final reply.
     */
    streamFinish(id: number): Promise<number>;
    /**
     * Streaming mode — pull the next download chunk (`None` = done).
     */
    streamPull(id: number, max_chunk: number): Promise<Uint8Array | undefined>;
    /**
     * Streaming mode — push one upload chunk (returns the total sent).
     */
    streamPush(id: number, data: Uint8Array): Promise<number>;
    /**
     * Streaming mode — begin a download in chunks; returns a transfer id.
     */
    streamStartGet(path: string, offset: number): Promise<number>;
    /**
     * Streaming mode — begin an upload; returns a transfer id.
     */
    streamStartPut(path: string, append: boolean, offset: number): Promise<number>;
    /**
     * Simple whole-file upload from memory.
     */
    upload(path: string, data: Uint8Array): Promise<number>;
}

export function set_bridge_url(url: string): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_ftpclient_free: (a: number, b: number) => void;
    readonly __wbg_sshclient_free: (a: number, b: number) => void;
    readonly ftpclient_abort: (a: number) => any;
    readonly ftpclient_cd_up: (a: number) => any;
    readonly ftpclient_chmod: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly ftpclient_connect: (a: number, b: number, c: number, d: any) => any;
    readonly ftpclient_cwd: (a: number, b: number, c: number) => any;
    readonly ftpclient_data_tls_on: (a: number) => number;
    readonly ftpclient_delete: (a: number, b: number, c: number) => any;
    readonly ftpclient_download: (a: number, b: number, c: number, d: number) => any;
    readonly ftpclient_is_connected: (a: number) => number;
    readonly ftpclient_is_tls: (a: number) => number;
    readonly ftpclient_list: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly ftpclient_mdtm: (a: number, b: number, c: number) => any;
    readonly ftpclient_mkdir: (a: number, b: number, c: number) => any;
    readonly ftpclient_mlst: (a: number, b: number, c: number) => any;
    readonly ftpclient_noop: (a: number) => any;
    readonly ftpclient_pwd: (a: number) => any;
    readonly ftpclient_quit: (a: number) => any;
    readonly ftpclient_rename: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly ftpclient_rmdir: (a: number, b: number, c: number) => any;
    readonly ftpclient_set_mtime: (a: number, b: number, c: number, d: number) => any;
    readonly ftpclient_size: (a: number, b: number, c: number) => any;
    readonly ftpclient_stat: (a: number) => any;
    readonly ftpclient_stat_path: (a: number, b: number, c: number) => any;
    readonly ftpclient_state: (a: number) => [number, number, number];
    readonly ftpclient_streamAbort: (a: number, b: number) => any;
    readonly ftpclient_streamFinish: (a: number, b: number) => any;
    readonly ftpclient_streamPull: (a: number, b: number, c: number) => any;
    readonly ftpclient_streamPush: (a: number, b: number, c: number, d: number) => any;
    readonly ftpclient_streamStartGet: (a: number, b: number, c: number, d: number) => any;
    readonly ftpclient_streamStartPut: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly ftpclient_syst: (a: number) => any;
    readonly ftpclient_upload: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly set_bridge_url: (a: number, b: number) => void;
    readonly sshclient_abort: (a: number) => any;
    readonly sshclient_cd_up: (a: number) => any;
    readonly sshclient_chmod: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly sshclient_connect: (a: number, b: number, c: number, d: any) => any;
    readonly sshclient_cwd: (a: number, b: number, c: number) => any;
    readonly sshclient_data_tls_on: (a: number) => number;
    readonly sshclient_delete: (a: number, b: number, c: number) => any;
    readonly sshclient_download: (a: number, b: number, c: number, d: number) => any;
    readonly sshclient_is_connected: (a: number) => number;
    readonly sshclient_is_tls: (a: number) => number;
    readonly sshclient_list: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly sshclient_mdtm: (a: number, b: number, c: number) => any;
    readonly sshclient_mkdir: (a: number, b: number, c: number) => any;
    readonly sshclient_mlst: (a: number, b: number, c: number) => any;
    readonly sshclient_noop: (a: number) => any;
    readonly sshclient_pwd: (a: number) => any;
    readonly sshclient_quit: (a: number) => any;
    readonly sshclient_rename: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly sshclient_rmdir: (a: number, b: number, c: number) => any;
    readonly sshclient_set_mtime: (a: number, b: number, c: number, d: number) => any;
    readonly sshclient_size: (a: number, b: number, c: number) => any;
    readonly sshclient_state: (a: number) => [number, number, number];
    readonly sshclient_streamAbort: (a: number, b: number) => any;
    readonly sshclient_streamFinish: (a: number, b: number) => any;
    readonly sshclient_streamPull: (a: number, b: number, c: number) => any;
    readonly sshclient_streamPush: (a: number, b: number, c: number, d: number) => any;
    readonly sshclient_streamStartGet: (a: number, b: number, c: number, d: number) => any;
    readonly sshclient_streamStartPut: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly sshclient_upload: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly wasm_bindgen_f05d8ca27ebfc8d0___convert__closures_____invoke___js_sys_b0f7a9544c2cd068___Function_fn_wasm_bindgen_f05d8ca27ebfc8d0___JsValue_____wasm_bindgen_f05d8ca27ebfc8d0___sys__Undefined___js_sys_b0f7a9544c2cd068___Function_fn_wasm_bindgen_f05d8ca27ebfc8d0___JsValue_____wasm_bindgen_f05d8ca27ebfc8d0___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_f05d8ca27ebfc8d0___convert__closures_____invoke___wasm_bindgen_f05d8ca27ebfc8d0___JsValue__core_608f92abc48d28da___result__Result_____wasm_bindgen_f05d8ca27ebfc8d0___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_f05d8ca27ebfc8d0___convert__closures_____invoke___wasm_bindgen_f05d8ca27ebfc8d0___JsValue______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_f05d8ca27ebfc8d0___convert__closures_____invoke_______true_: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
