#!/usr/bin/env bash
# Builds the contracts, runs the tests and writes the result to test-result.txt.
# Exit code: 0 only when the build AND every test passed; otherwise the failing step's code (IORA-05).
# It also writes wasm/BUILD-MANIFEST.txt (commit, tool versions, sha256 of every wasm this build produced) and
# checks that the vault wasm the factory tests import comes from THIS build, not from an older one left in wasm/.
cd "$(dirname "$0")/.." || exit 1
source "$HOME/.cargo/env" 2>/dev/null
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
# Build files are kept on the Linux side (very slow in a Windows folder).
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/iora-target}"
set -o pipefail

BUILD_LOG="${BUILD_LOG:-/tmp/gk-build.log}"
TEST_LOG="${TEST_LOG:-/tmp/gk-test.log}"
# wasm files the tests read from wasm/ (contractimport in contracts/factory and contracts/mover tests)
REQUIRED_WASM="${REQUIRED_WASM:-iora_vault.wasm iora_factory.wasm iora_usdc_exchange.wasm}"

sha() { if command -v sha256sum > /dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

run() {
  echo "===== $(date) ====="
  # Build first: the factory tests use the vault's wasm file.
  echo "===== stellar contract build ====="
  stellar contract build > "$BUILD_LOG" 2>&1
  local build=$?
  grep -v '^\s*Compiling ' "$BUILD_LOG" | grep -E "error|Wasm File|Wasm Size|Build Complete" | head -30
  grep -E "^error" -A12 "$BUILD_LOG" | head -60
  if [ "$build" -ne 0 ]; then
    echo "BUILD FAILED (exit $build): no tests were run"
    return "$build"
  fi

  # Copy exactly the wasm files this build reports, and record them.
  mkdir -p wasm
  local copied=() manifest="wasm/BUILD-MANIFEST.txt" tmp
  tmp=$(mktemp)
  {
    echo "built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "commit=$(git rev-parse HEAD 2> /dev/null || echo unknown)$( [ -n "$(git status --porcelain -- contracts 2> /dev/null)" ] && echo ' (contracts/ has uncommitted changes)')"
    echo "stellar=$(stellar --version 2> /dev/null | head -1)"
    echo "cargo=$(cargo --version 2> /dev/null)"
    echo "rustc=$(rustc --version 2> /dev/null)"
  } > "$tmp"
  for W in $(grep -oE 'Wasm File: [^ ]+' "$BUILD_LOG" | cut -d' ' -f3); do
    if ! cp "$W" wasm/; then
      echo "BUILD FAILED: could not copy $W"
      rm -f "$tmp"
      return 1
    fi
    copied+=("$(basename "$W")")
    echo "wasm $(basename "$W") sha256=$(sha "wasm/$(basename "$W")")" >> "$tmp"
    ls -l "wasm/$(basename "$W")"
  done
  # A wasm the tests need but this build did not produce would be an old artifact: refuse to test with it.
  for R in $REQUIRED_WASM; do
    if [[ " ${copied[*]} " != *" $R "* ]]; then
      echo "BUILD FAILED: this build did not produce $R; the tests would use an old wasm/$R"
      rm -f "$tmp"
      return 3
    fi
  done
  mv "$tmp" "$manifest"
  echo "manifest: $manifest ($(grep -c '^wasm ' "$manifest") wasm files)"

  echo "===== cargo test ====="
  cargo test > "$TEST_LOG" 2>&1
  local tests=$?
  grep -vE '^\s*(Compiling|Downloaded|Downloading) ' "$TEST_LOG" | grep -E '^(error|warning: unused)' -A12 | head -150
  grep -E '^test |test result' "$TEST_LOG"
  grep -E '^---- ' -A6 "$TEST_LOG" | head -80
  if [ "$tests" -ne 0 ]; then
    echo "TESTS FAILED (exit $tests)"
    return "$tests"
  fi
  # The wasm the tests used must still be the one this build made.
  for R in $REQUIRED_WASM; do
    if [ "$(sha "wasm/$R")" != "$(grep -E "^wasm $R " "$manifest" | sed 's/.*sha256=//')" ]; then
      echo "TESTS FAILED: wasm/$R changed during the test run"
      return 4
    fi
  done
  echo "===== DONE ====="
}

run 2>&1 | tee test-result.txt
exit "${PIPESTATUS[0]}"
