#!/usr/bin/env bash
# Build the wasm FTP engine and generate the ES-module glue in ./out.
#
# Outputs:
#   out/ftp_engine.js        wasm-bindgen ES-module glue (target web)
#   out/ftp_engine_bg.wasm   the engine
#   out/ftp_engine.d.ts      type declarations
#   out/api.js               high-level wrapper used by the extension
#
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$PATH"

TARGET=wasm32-unknown-unknown
[ -f ~/.cargo/env ] && . ~/.cargo/env

rustup target add "$TARGET" >/dev/null

cargo build --release --target "$TARGET"

rm -rf out
mkdir -p out
wasm-bindgen --out-dir out --target web --typescript target/"$TARGET"/release/ftp_engine.wasm

# the wrapper is maintained in-repo; copy it into the build output
cp wrapper/api.js out/api.js

strip -o out/ftp_engine_bg.wasm 2>/dev/null || true

# node glue for the e2e harness
mkdir -p test/node
wasm-bindgen --out-dir test/node --target nodejs target/"$TARGET"/release/ftp_engine.wasm

echo "build done:"
ls -la out
