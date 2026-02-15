use std::io::{Read, Write};
use std::mem;
use std::sync::{Arc, OnceLock};
use wasm_bindgen::prelude::*;

use rustls::client::Resumption;
use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection, RootCertStore};

static ROOT_STORE: OnceLock<Arc<RootCertStore>> = OnceLock::new();
static PROVIDER: OnceLock<Arc<rustls::crypto::CryptoProvider>> = OnceLock::new();

const IO_BUF_CAP: usize = 16 * 1024;
const MAX_TLS_BUF_SIZE: usize = 128 * 1024;

fn get_root_store() -> Arc<RootCertStore> {
    ROOT_STORE
        .get_or_init(|| {
            Arc::new(RootCertStore::from_iter(
                webpki_roots::TLS_SERVER_ROOTS.iter().cloned(),
            ))
        })
        .clone()
}

fn get_provider() -> Arc<rustls::crypto::CryptoProvider> {
    PROVIDER
        .get_or_init(|| Arc::new(rustls_rustcrypto::provider()))
        .clone()
}

/// TLS connection state, exposed to JS via wasm-bindgen.
/// Uses rustls with buffer-based sync IO — JS layer drives socket IO asynchronously.
#[wasm_bindgen]
pub struct TlsConnection {
    conn: ClientConnection,
    /// Ciphertext received from the network, pending rustls processing
    incoming_tls: Vec<u8>,
    /// Offset into incoming_tls for already-consumed bytes
    incoming_tls_offset: usize,
    /// Ciphertext produced by rustls, pending network send
    outgoing_tls: Vec<u8>,
    /// Decrypted plaintext, pending upper-layer read
    plaintext_out: Vec<u8>,
}

#[wasm_bindgen]
impl TlsConnection {
    /// Create a new TLS client connection.
    /// `hostname`: server hostname for SNI
    /// `alpn_protocols`: comma-separated ALPN protocol list, e.g. "h2,http/1.1"
    #[wasm_bindgen(constructor)]
    pub fn new(hostname: &str, alpn_protocols: &str) -> Result<TlsConnection, JsError> {
        let mut config = ClientConfig::builder_with_provider(get_provider())
            .with_safe_default_protocol_versions()
            .map_err(|e| JsError::new(&format!("Protocol version error: {}", e)))?
            .with_root_certificates((*get_root_store()).clone())
            .with_no_client_auth();

        config.resumption = Resumption::in_memory_sessions(256);

        // Set ALPN protocols
        if !alpn_protocols.is_empty() {
            config.alpn_protocols = alpn_protocols
                .split(',')
                .map(|p| p.trim().as_bytes().to_vec())
                .collect();
        }

        let server_name: ServerName<'static> = ServerName::try_from(hostname.to_string())
            .map_err(|e| JsError::new(&format!("Invalid hostname: {}", e)))?;

        let conn = ClientConnection::new(Arc::new(config), server_name)
            .map_err(|e| JsError::new(&format!("TLS connection error: {}", e)))?;

        Ok(TlsConnection {
            conn,
            incoming_tls: Vec::with_capacity(IO_BUF_CAP),
            incoming_tls_offset: 0,
            outgoing_tls: Vec::with_capacity(IO_BUF_CAP),
            plaintext_out: Vec::with_capacity(IO_BUF_CAP),
        })
    }

    /// Feed ciphertext received from the network into the TLS engine.
    /// Returns true if rustls has outgoing data to send (call `flush_outgoing_tls`).
    pub fn feed_ciphertext(&mut self, data: &[u8]) -> Result<bool, JsError> {
        if self.incoming_tls.len() + data.len() > MAX_TLS_BUF_SIZE {
            self.compact_incoming_tls();
            if self.incoming_tls.len() + data.len() > MAX_TLS_BUF_SIZE {
                return Err(JsError::new("Incoming TLS buffer exceeded maximum size"));
            }
        }
        self.incoming_tls.extend_from_slice(data);

        // Let rustls read TLS records from our buffer (&[u8] implements Read)
        let mut reader = &self.incoming_tls[self.incoming_tls_offset..];
        let bytes_read = self
            .conn
            .read_tls(&mut reader)
            .map_err(|e| JsError::new(&format!("read_tls error: {}", e)))?;

        // Advance offset for processed bytes
        self.incoming_tls_offset += bytes_read;

        // Compact buffer occasionally to avoid unbounded growth
        if self.incoming_tls_offset > 0 {
            if self.incoming_tls_offset >= self.incoming_tls.len() {
                self.incoming_tls.clear();
                self.incoming_tls_offset = 0;
            } else if self.incoming_tls_offset >= IO_BUF_CAP
                && self.incoming_tls_offset >= self.incoming_tls.len() / 2
            {
                self.compact_incoming_tls();
            }
        }

        // Process the TLS records

        let io_state = self
            .conn
            .process_new_packets()
            .map_err(|e| JsError::new(&format!("TLS error: {}", e)))?;

        // Extract any decrypted plaintext (write directly into plaintext_out, no temp Vec)
        let pt_bytes = io_state.plaintext_bytes_to_read();
        if pt_bytes > 0 {
            let start = self.plaintext_out.len();
            self.plaintext_out.resize(start + pt_bytes, 0);
            let n = self
                .conn
                .reader()
                .read(&mut self.plaintext_out[start..])
                .map_err(|e| JsError::new(&format!("plaintext read error: {}", e)))?;
            self.plaintext_out.truncate(start + n);
        }

        Ok(self.conn.wants_write())
    }

    /// Write plaintext data (from the upper layer) into the TLS engine for encryption.
    /// Returns true if rustls has outgoing data to send.
    pub fn write_plaintext(&mut self, data: &[u8]) -> Result<bool, JsError> {
        self.conn
            .writer()
            .write_all(data)
            .map_err(|e| JsError::new(&format!("write error: {}", e)))?;
        Ok(self.conn.wants_write())
    }

    /// Flush ciphertext produced by rustls (to be sent over the network).
    /// Returns the ciphertext bytes as a Vec<u8> (becomes Uint8Array in JS).
    pub fn flush_outgoing_tls(&mut self) -> Result<Vec<u8>, JsError> {
        self.outgoing_tls.clear();
        self.conn
            .write_tls(&mut self.outgoing_tls)
            .map_err(|e| JsError::new(&format!("write_tls error: {}", e)))?;
        Ok(mem::replace(
            &mut self.outgoing_tls,
            Vec::with_capacity(IO_BUF_CAP),
        ))
    }

    /// Take decrypted plaintext data (for the upper layer to consume).
    pub fn take_plaintext(&mut self) -> Vec<u8> {
        mem::replace(&mut self.plaintext_out, Vec::with_capacity(IO_BUF_CAP))
    }

    /// Whether the TLS handshake is still in progress.
    pub fn is_handshaking(&self) -> bool {
        self.conn.is_handshaking()
    }

    /// Get the negotiated ALPN protocol (e.g. "h2" or "http/1.1").
    /// Returns null if no ALPN was negotiated.
    pub fn negotiated_alpn(&self) -> Option<String> {
        self.conn
            .alpn_protocol()
            .map(|p| String::from_utf8_lossy(p).to_string())
    }

    /// Whether rustls needs more data from the network.
    pub fn wants_read(&self) -> bool {
        self.conn.wants_read()
    }

    /// Whether rustls has data to write to the network.
    pub fn wants_write(&self) -> bool {
        self.conn.wants_write()
    }

    /// Send a TLS close_notify alert.
    pub fn send_close_notify(&mut self) {
        self.conn.send_close_notify();
    }
}

/// Get the library version string (for verification).
#[wasm_bindgen]
pub fn wasm_tls_version() -> String {
    "wasm-tls v0.1.0 (rustls + rustls-rustcrypto)".to_string()
}

impl TlsConnection {
    fn compact_incoming_tls(&mut self) {
        if self.incoming_tls_offset > 0 {
            let remaining = self.incoming_tls.len() - self.incoming_tls_offset;
            self.incoming_tls.copy_within(self.incoming_tls_offset.., 0);
            self.incoming_tls.truncate(remaining);
            self.incoming_tls_offset = 0;
        }
    }
}
