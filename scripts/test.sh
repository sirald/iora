#!/usr/bin/env bash
# Builds the contracts, runs the tests and writes the result to test-result.txt.
cd "$(dirname "$0")/.." || exit 1
source "$HOME/.cargo/env" 2>/dev/null
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
# Build files are kept on the Linux side (very slow in a Windows folder).
export CARGO_TARGET_DIR="$HOME/.cache/iora-target"

{
  echo "===== $(date) ====="
  # Build first: the factory tests use the vault's wasm file.
  echo "===== stellar contract build ====="
  stellar contract build 2>&1 | grep -v '^\s*Compiling ' > /tmp/gk-build.log
  grep -E "error|Wasm File|Wasm Size|Build Complete" /tmp/gk-build.log | head -30
  grep -E "^error" -A12 /tmp/gk-build.log | head -60
  mkdir -p wasm
  for W in $(grep -oE 'Wasm File: [^ ]+' /tmp/gk-build.log | cut -d' ' -f3); do
    cp "$W" wasm/ && ls -l "wasm/$(basename "$W")"
  done
  echo "===== cargo test ====="
  cargo test 2>&1 | grep -vE '^\s*(Compiling|Downloaded|Downloading) ' > /tmp/gk-test.log
  grep -E '^(error|warning: unused)' -A12 /tmp/gk-test.log | head -150
  grep -E '^test |test result' /tmp/gk-test.log
  grep -E '^---- ' -A6 /tmp/gk-test.log | head -80
  echo "===== DONE ====="
} 2>&1 | tee test-result.txt
