#!/usr/bin/env bash
# Pins ed25519-dalek 3.x, which is incompatible with soroban-env-host 23, to 2.x, then runs the tests.
cd "$(dirname "$0")/.." || exit 1
source "$HOME/.cargo/env" 2>/dev/null
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$HOME/.cache/iora-target"

{
  echo "===== latest soroban-sdk ====="
  cargo search soroban-sdk --limit 1 2>&1 | head -2
  echo "===== what pulls in ed25519-dalek 3 ====="
  cargo tree -i ed25519-dalek@3.0.0 -e normal,build,dev --target all 2>&1 | head -15
  echo "===== pinning ====="
  cargo update -p ed25519-dalek@3.0.0 --precise 2.2.0 2>&1 | tail -5
  cargo tree -i ed25519-dalek -e normal,build,dev --target all 2>&1 | head -5
} 2>&1 | tee deps.txt

bash scripts/test.sh
