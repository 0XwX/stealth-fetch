#!/usr/bin/env bash
# Copy WASM artifacts to dist/ after tsup build.
# tsup's DTS pass can remove manually copied .d.ts files,
# so this runs as a separate post-build step.
set -euo pipefail

DEST=dist/socket/wasm-pkg
SRC=src/socket/wasm-pkg

mkdir -p "$DEST"
cp "$SRC/wasm_tls_bg.wasm" "$DEST/"
cp "$SRC/wasm_tls.js" "$DEST/"
cp "$SRC/wasm_tls.d.ts" "$DEST/"
cp "$SRC/wasm_tls_bg.wasm.d.ts" "$DEST/"

echo "Copied WASM artifacts to $DEST"
