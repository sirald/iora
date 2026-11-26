#!/usr/bin/env bash
# Iora version 14, on top of version 13 (same vault constructor, same factory code, same filler):
#   - `forget` refuses a token that an open order buys (error 34, TokenAwaited), so a vault's token list can no longer
#     grow past MAX_TOKENS when that order fills (audit finding IORA-09). New read: `awaited(token)`.
#   1) builds the contracts and runs the tests (deploys nothing if they fail)
#   2) uploads the new vault code and deploys a new factory (testnet/factory.env VAULT_V=14)
#   3) adds the previous factory to the "old" and "generations" lists: the keeper keeps filling it, and a user
#      with funds in a version 13 vault carries on with that vault (no migration)
#   4) republishes the site
# The filler contract did not change: testnet/filler.env is kept as it is.
# Usage (in WSL): bash scripts/deploy-v14.sh
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Do not deploy again if version 14 is already live: every run deploys a NEW factory and users' vaults stay in the old one.
if grep -q '^VAULT_V=14' testnet/factory.env 2>/dev/null && [ "$REDEPLOY" != "1" ]; then
  echo "Version 14 is already deployed ($(grep -E '^FACTORY=' testnet/factory.env | cut -d= -f2-))."
  echo "To update the site:  bash scripts/deploy-web.sh"
  echo "To really deploy a new factory:  REDEPLOY=1 bash scripts/deploy-v14.sh"
  exit 0
fi

echo "===== 1) Build and tests (can take a few minutes) ====="
bash scripts/test.sh > /dev/null 2>&1
TEST_STATUS=$?
grep -E "test result|Wasm Size|FAILED|^error" test-result.txt
if [ "$TEST_STATUS" -ne 0 ] || grep -qE "FAILED|^error|panicked" test-result.txt || [ "$(grep -c 'test result: ok' test-result.txt)" -lt 2 ]; then
  echo
  echo "TESTS FAILED (exit $TEST_STATUS), nothing was deployed. See test-result.txt"
  exit 1
fi
echo "All tests passed."

echo
echo "===== 2) Testnet deployment ====="
source testnet/factory.env || { echo "testnet/factory.env not found"; exit 1; }
OLD_BUY="$FACTORY"
OLD_SELL=""
[ -f testnet/factory-sell.env ] && OLD_SELL=$(grep -E '^FACTORY_SELL=' testnet/factory-sell.env | cut -d= -f2-)
PREV=""
[ -f testnet/old-factories.env ] && PREV=$(grep -E '^OLD_FACTORIES=' testnet/old-factories.env | cut -d= -f2-)

SECRET=""
for c in "stellar keys secret dev" "stellar keys show dev"; do
  S=$($c 2>/dev/null | grep -oE 'S[A-Z2-7]{55}' | head -1)
  [ -n "$S" ] && { SECRET="$S"; break; }
done
[ -z "$SECRET" ] && { echo "could not read the dev key (stellar keys)"; exit 1; }
[ -d keeper/node_modules/@stellar/stellar-sdk ] || (cd keeper && npm ci --no-audit --no-fund > /dev/null 2>&1)

mkdir -p testnet/v13-backup
cp testnet/factory.env testnet/factory-sell.env testnet/old-factories.env testnet/generations.env testnet/v13-backup/ 2>/dev/null

(cd keeper && DEV_SECRET="$SECRET" node deploy.js --v14) 2>&1 | grep -vE 'S[A-Z2-7]{55}' | tee testnet/v14.txt
unset SECRET S
NEW_BUY=$(grep -E '^FACTORY=' testnet/factory.env | cut -d= -f2-)
if [ -z "$NEW_BUY" ] || [ "$NEW_BUY" = "$OLD_BUY" ] || ! grep -q '^VAULT_V=14' testnet/factory.env; then
  echo "The factory could not be deployed (testnet/v14.txt). The previous settings were restored."
  cp testnet/v13-backup/factory.env testnet/v13-backup/factory-sell.env testnet/ 2>/dev/null
  exit 1
fi

# Old factories: the keeper keeps filling them and the app offers to move funds to the wallet
LIST=$(printf "%s\n" "$PREV" | tr ',' '\n'; echo "$OLD_BUY"; echo "$OLD_SELL")
LIST=$(echo "$LIST" | sed '/^$/d' | awk '!seen[$0]++' | paste -sd, -)
echo "OLD_FACTORIES=$LIST" > testnet/old-factories.env
# Generations: a user with funds in the previous version does not have to migrate; the app keeps using that vault.
GEN_PREV=""
[ -f testnet/generations.env ] && GEN_PREV=$(grep -E '^GENERATIONS=' testnet/generations.env | cut -d= -f2-)
if [ -n "$OLD_BUY" ] && [ -n "$OLD_SELL" ]; then
  GENS=$(printf "%s\n" "$OLD_BUY:$OLD_SELL" $(echo "$GEN_PREV" | tr ',' ' ') | sed '/^$/d' | awk '!seen[$0]++' | paste -sd, -)
  echo "GENERATIONS=$GENS" > testnet/generations.env
  echo "Generations saved: $GENS"
fi
echo "Old factories saved: $LIST"

echo
echo "===== 3) Publish the site ====="
bash scripts/deploy-web.sh

echo
echo "DONE. Send the new settings to the keeper on the server (testnet/*.env)."
