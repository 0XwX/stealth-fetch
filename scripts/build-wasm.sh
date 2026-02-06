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
wasm-pack build "$CRATE_DIR" --target web --release --out-dir "$OUTPUT_DIR" --out-name wasm_tls

# Clean up wasm-pack generated files we don't need
rm -f "$OUTPUT_DIR/.gitignore"

# Report size
WASM_FILE="$OUTPUT_DIR/wasm_tls_bg.wasm"
if [ -f "$WASM_FILE" ]; then
  RAW_SIZE=$(wc -c < "$WASM_FILE" | tr -d ' ')
  echo "WASM binary size: ${RAW_SIZE} bytes ($(echo "scale=1; $RAW_SIZE / 1024" | bc)KB)"
fi

echo "WASM build complete -> $OUTPUT_DIR"
