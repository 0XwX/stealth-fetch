/* tslint:disable */
/* eslint-disable */

/**
 * TLS connection state, exposed to JS via wasm-bindgen.
 * Uses rustls with buffer-based sync IO — JS layer drives socket IO asynchronously.
 */
export class TlsConnection {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Feed ciphertext received from the network into the TLS engine.
     * Returns true if rustls has outgoing data to send (call `flush_outgoing_tls`).
     */
    feed_ciphertext(data: Uint8Array): boolean;
    /**
     * Flush ciphertext produced by rustls (to be sent over the network).
     * Returns the ciphertext bytes as a Vec<u8> (becomes Uint8Array in JS).
     */
    flush_outgoing_tls(): Uint8Array;
    /**
     * Whether the TLS handshake is still in progress.
     */
    is_handshaking(): boolean;
    /**
     * Get the negotiated ALPN protocol (e.g. "h2" or "http/1.1").
     * Returns null if no ALPN was negotiated.
     */
    negotiated_alpn(): string | undefined;
    /**
     * Create a new TLS client connection.
     * `hostname`: server hostname for SNI
     * `alpn_protocols`: comma-separated ALPN protocol list, e.g. "h2,http/1.1"
     */
    constructor(hostname: string, alpn_protocols: string);
    /**
     * Send a TLS close_notify alert.
     */
    send_close_notify(): void;
    /**
     * Take decrypted plaintext data (for the upper layer to consume).
     */
    take_plaintext(): Uint8Array;
    /**
     * Whether rustls needs more data from the network.
     */
    wants_read(): boolean;
    /**
     * Whether rustls has data to write to the network.
     */
    wants_write(): boolean;
    /**
     * Write plaintext data (from the upper layer) into the TLS engine for encryption.
     * Returns true if rustls has outgoing data to send.
     */
    write_plaintext(data: Uint8Array): boolean;
}

/**
 * Get the library version string (for verification).
 */
export function wasm_tls_version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_tlsconnection_free: (a: number, b: number) => void;
    readonly tlsconnection_feed_ciphertext: (a: number, b: number, c: number, d: number) => void;
    readonly tlsconnection_flush_outgoing_tls: (a: number, b: number) => void;
    readonly tlsconnection_is_handshaking: (a: number) => number;
    readonly tlsconnection_negotiated_alpn: (a: number, b: number) => void;
    readonly tlsconnection_new: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly tlsconnection_send_close_notify: (a: number) => void;
    readonly tlsconnection_take_plaintext: (a: number, b: number) => void;
    readonly tlsconnection_wants_read: (a: number) => number;
    readonly tlsconnection_wants_write: (a: number) => number;
    readonly tlsconnection_write_plaintext: (a: number, b: number, c: number, d: number) => void;
    readonly wasm_tls_version: (a: number) => void;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export4: (a: number, b: number, c: number, d: number) => number;
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
