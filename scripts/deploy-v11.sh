#!/usr/bin/env bash
# Iora version 11, on top of version 10 (same vault constructor, same factory code):
#   - scheduled orders ("DCA"): `place_dca` sells one part of a token per interval, buying or selling, for as
#     long as the vault can cover the next part (or for a fixed number of parts). The vault enforces the
#     schedule; only one part is reserved at a time. Ordinary orders, `execute`, `take` and `cross` are unchanged.
#   1) builds the contracts and runs the tests (deploys nothing if they fail)
#   2) uploads the new vault code and deploys the factory (testnet/factory.env VAULT_V=11; allowed: USDC, XLM + testnet/pairs.env)
#   3) adds the previous factory to the "old" and "generations" lists: the keeper keeps filling it, and a user
#      with funds in a version 10 vault carries on with that vault (no migration; scheduled orders need a new vault)
#   4) republishes the site
# Usage: bash scripts/deploy-v11.sh
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Do not deploy again if version 11 is already live: every run deploys a NEW factory and users' vaults stay in the old one.
# For site changes only: bash scripts/deploy-web.sh
if grep -q '^VAULT_V=11' testnet/factory.env 2>/dev/null && [ "$REDEPLOY" != "1" ]; then
  echo "Version 11 is already deployed ($(grep -E '^FACTORY=' testnet/factory.env | cut -d= -f2-))."
  echo "To update the site:  bash scripts/deploy-web.sh"
  echo "To really deploy a new factory:  REDEPLOY=1 bash scripts/deploy-v11.sh"
  exit 0
fi

echo "===== 1) Build and tests (can take a few minutes) ====="
bash scripts/test.sh > /dev/null 2>&1
grep -E "test result|Wasm Size|^error" test-result.txt
if grep -qE "FAILED|^error|panicked" test-result.txt || [ "$(grep -c 'test result: ok' test-result.txt)" -lt 2 ]; then
  echo
  echo "TESTS FAILED, nothing was deployed. See test-result.txt:"
  echo "  cat test-result.txt"
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
[ -d keeper/node_modules/@stellar/stellar-sdk ] || (cd keeper && npm install --no-audit --no-fund > /dev/null 2>&1)

mkdir -p testnet/v10-backup
cp testnet/factory.env testnet/v10-backup/ 2>/dev/null
cp testnet/factory-sell.env testnet/v10-backup/ 2>/dev/null

# One factory (the new vault code is uploaded; factory.env and factory-sell.env carry the same address)
(cd keeper && DEV_SECRET="$SECRET" node deploy.js --v11) 2>&1 | tee testnet/v11.txt
NEW_BUY=$(grep -E '^FACTORY=' testnet/factory.env | cut -d= -f2-)
if [ -z "$NEW_BUY" ] || [ "$NEW_BUY" = "$OLD_BUY" ]; then
  echo "The factory could not be deployed (testnet/v11.txt). The previous settings were restored."
  cp testnet/v10-backup/factory.env testnet/ 2>/dev/null
  cp testnet/v10-backup/factory-sell.env testnet/ 2>/dev/null
  exit 1
fi

# Old factories: the keeper keeps filling them and the app offers to move funds to the wallet
LIST=$(printf "%s\n" "$PREV" | tr ',' '\n'; echo "$OLD_BUY"; echo "$OLD_SELL")
LIST=$(echo "$LIST" | sed '/^$/d' | awk '!seen[$0]++' | paste -sd, -)
echo "OLD_FACTORIES=$LIST" > testnet/old-factories.env
# Generations: a user with funds in the previous version does not have to migrate; the app keeps using that vault.
# Only versions with the same interface (4 and later) are listed, newest first.
GEN_PREV=""
[ -f testnet/generations.env ] && GEN_PREV=$(grep -E '^GENERATIONS=' testnet/generations.env | cut -d= -f2-)
[ -z "$GEN_PREV" ] && GEN_PREV="CB32H4RWA4DIA2NTE6W5IJATJUAYDAQ42HJDSFE6JWEM4W3BOZ4OEJM3:CDIEYJFASA2KTOGXBR2BQ27EDDXSZU35B5SBC4RVGQFLILNKUWWYVZ5D"
if [ -n "$OLD_BUY" ] && [ -n "$OLD_SELL" ]; then
  GENS=$(printf "%s\n" "$OLD_BUY:$OLD_SELL" $(echo "$GEN_PREV" | tr ',' ' ') | awk '!seen[$0]++' | paste -sd, -)
  echo "GENERATIONS=$GENS" > testnet/generations.env
  echo "Generations saved: $GENS"
fi
echo "Old factories saved: $LIST"

echo
echo "===== 3) Publish the site ====="
bash scripts/deploy-web.sh

echo
echo "DONE. Send the new settings to the keeper on the server:  bash scripts/server.sh push keeper"
