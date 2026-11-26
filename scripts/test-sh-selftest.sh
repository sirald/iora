#!/usr/bin/env bash
# Checks scripts/test.sh's exit codes without a real compiler (IORA-05): a copy runs in a temporary folder with
# stub `stellar` and `cargo` commands. Nothing is built, deployed or sent anywhere.
#   bash scripts/test-sh-selftest.sh      exit 0 = every case behaved
set -u
SRC="$(cd "$(dirname "$0")" && pwd)/test.sh"
fails=0

case_run() { # name, expected exit, STUB_BUILD, STUB_TEST, STUB_WASM, stale wasm present (1/0)
  local name="$1" want="$2" dir
  dir=$(mktemp -d)
  mkdir -p "$dir/scripts" "$dir/wasm"
  tr -d '\r' < "$SRC" > "$dir/scripts/test.sh"
  [ "$6" = "1" ] && echo stale > "$dir/wasm/iora_vault.wasm"
  (
    cd "$dir" || exit 99
    export STUB_BUILD="$3" STUB_TEST="$4" STUB_WASM="$5" HOME="$dir" BUILD_LOG="$dir/build.log" TEST_LOG="$dir/test.log"
    stellar() {
      [ "${1:-}" = "--version" ] && { echo "stellar stub"; return 0; }
      mkdir -p target
      for w in $STUB_WASM; do echo "fresh $w" > "target/$w"; echo "Wasm File: $PWD/target/$w"; done
      [ "$STUB_BUILD" = 0 ] || echo "error: stub build failure"
      return "$STUB_BUILD"
    }
    cargo() {
      [ "${1:-}" = "--version" ] && { echo "cargo stub"; return 0; }
      if [ "$STUB_TEST" = 0 ]; then echo "test result: ok. 1 passed"; else echo "test result: FAILED. 1 failed"; fi
      return "$STUB_TEST"
    }
    git() { [ "${1:-}" = "rev-parse" ] && echo stubcommit; return 0; }
    export -f stellar cargo git
    bash scripts/test.sh > /dev/null 2>&1
  )
  local got=$?
  local done_line=0
  grep -q "===== DONE =====" "$dir/test-result.txt" 2> /dev/null && done_line=1
  local ok=1
  [ "$got" = "$want" ] || ok=0
  # DONE only on success, and a success must leave a manifest naming the fresh vault wasm
  if [ "$want" = 0 ]; then
    [ "$done_line" = 1 ] && grep -q '^wasm iora_vault.wasm sha256=' "$dir/wasm/BUILD-MANIFEST.txt" 2> /dev/null || ok=0
    grep -q fresh "$dir/wasm/iora_vault.wasm" || ok=0
  else
    [ "$done_line" = 0 ] || ok=0
  fi
  if [ "$ok" = 1 ]; then echo "ok   $name (exit $got)"; else echo "FAIL $name (exit $got, wanted $want, DONE=$done_line)"; fails=$((fails + 1)); fi
  rm -rf "$dir"
}

case_run "build fails"                     41 41 0  "iora_vault.wasm" 0
case_run "tests fail"                      42 0  42 "iora_vault.wasm" 0
case_run "build makes no vault wasm (old)" 3  0  0  "iora_factory.wasm" 1
case_run "everything passes"               0  0  0  "iora_vault.wasm iora_factory.wasm" 1
[ "$fails" = 0 ] && echo "test.sh self-test: all cases passed" || echo "test.sh self-test: $fails case(s) failed"
exit "$fails"
