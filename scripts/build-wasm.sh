#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CRATE_DIR="$PROJECT_ROOT/crates/wasm-tls"
OUTPUT_DIR="$PROJECT_ROOT/src/socket/wasm-pkg"

echo "Building WASM TLS engine..."

# Check wasm-pack is installed
if ! command -v wasm-pack &>/dev/null; then
  echo "Error: wasm-pack not found. Install with: cargo install wasm-pack"
  exit 1
fi

# Build with wasm-pack (--target web for CF Workers compatibility)
# wasm-opt is disabled in Cargo.toml — we run it manually below with --enable-bulk-memory
wasm-pack build "$CRATE_DIR" --target web --release --out-dir "$OUTPUT_DIR" --out-name wasm_tls

# Clean up wasm-pack generated files we don't need
rm -f "$OUTPUT_DIR/.gitignore"

WASM_FILE="$OUTPUT_DIR/wasm_tls_bg.wasm"

# Run wasm-opt manually (Rust 1.78+ emits bulk-memory ops that require the flag)
if command -v wasm-opt &>/dev/null && [ -f "$WASM_FILE" ]; then
  PRE_OPT=$(wc -c < "$WASM_FILE" | tr -d ' ')
  echo "Running wasm-opt -Oz (pre: ${PRE_OPT} bytes)..."
  wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals "$WASM_FILE" -o "$WASM_FILE.opt"
  mv "$WASM_FILE.opt" "$WASM_FILE"
  POST_OPT=$(wc -c < "$WASM_FILE" | tr -d ' ')
  echo "wasm-opt: ${PRE_OPT} -> ${POST_OPT} bytes (saved $(( PRE_OPT - POST_OPT )) bytes)"
else
  echo "wasm-opt not found, skipping post-optimization"
fi

# Report final size
if [ -f "$WASM_FILE" ]; then
  RAW_SIZE=$(wc -c < "$WASM_FILE" | tr -d ' ')
  GZIP_SIZE=$(gzip -c "$WASM_FILE" | wc -c | tr -d ' ')
  echo "WASM binary: ${RAW_SIZE} bytes ($(echo "scale=1; $RAW_SIZE / 1024" | bc)KB raw, $(echo "scale=1; $GZIP_SIZE / 1024" | bc)KB gzip)"
fi

echo "WASM build complete -> $OUTPUT_DIR"
