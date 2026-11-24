#!/usr/bin/env bash
# Deploys a new copy of the filler contract (contracts/filler) on testnet and points the keeper at it
# (testnet/filler.env). The filler has no owner, no settings and no storage and is not tied to the vaults, so a
# new copy can replace the old one at any time; no vault or factory changes.
#   1) builds the contracts and runs the tests (deploys nothing if they fail)
#   2) deploys wasm/iora_filler.wasm and rewrites testnet/filler.env (the Aquarius router address is kept)
# Afterwards: bash scripts/server.sh push keeper
# Usage: bash scripts/deploy-filler.sh
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

echo "===== 1) Build and test ====="
bash scripts/test.sh > /dev/null 2>&1
grep -E "^test result|^error" test-result.txt | head -12
if grep -qE "FAILED|^error|failed;" test-result.txt && ! grep -q " 0 failed" test-result.txt; then echo "The tests did not pass: nothing was deployed."; exit 1; fi
if grep -E "^test result" test-result.txt | grep -qv " 0 failed"; then echo "The tests did not pass: nothing was deployed."; exit 1; fi
if grep -qE "^error" test-result.txt; then echo "The build has errors: nothing was deployed (see test-result.txt)."; exit 1; fi
[ -f wasm/iora_filler.wasm ] || { echo "wasm/iora_filler.wasm is missing: nothing was deployed."; exit 1; }

echo "===== 2) Deploy the filler ====="
[ -f testnet/filler.env ] && source testnet/filler.env
DEP=$(stellar contract deploy --wasm wasm/iora_filler.wasm --source dev --network testnet 2>&1)
NEW=$(echo "$DEP" | grep -oE '^C[A-Z0-9]{55}$' | tail -1)
if [ -z "$NEW" ]; then echo "$DEP" | cut -c1-300 | tail -6; echo "The filler could NOT be deployed; the old one stays in use."; exit 1; fi
# Phoenix: no usable deployment on testnet (the address in Soroswap's aggregator repository has no readable multihop); set PHOENIX_MULTIHOP in testnet/filler.env on a network that has one.
printf 'FILLER=%s\nAQUA_ROUTER=%s\nPHOENIX_MULTIHOP=%s\n' "$NEW" "${AQUA_ROUTER:-CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD}" "${PHOENIX_MULTIHOP:-}" > testnet/filler.env
echo "Filler deployed: $NEW (was: ${FILLER:-none})"
echo "DONE. Send it to the keeper: bash scripts/server.sh push keeper"
