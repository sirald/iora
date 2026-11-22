#!/usr/bin/env bash
# Iora version 8, on top of version 7 (one multi-asset vault per user):
#   - allowed token list (in the factory; vaults only accept orders between these tokens)
#   - fills through an intermediate token (for example USDC -> XLM -> BTC): less slippage on thin pairs
#   - no rounding buffer for coins that are not on Blend (0.001 BTC is no longer held back)
#   - a fill fee when BTC, EURC ... are bought; the reverse leg of a follow-up order fills in up to 20 pieces
#   1) builds the contracts and runs the tests (deploys nothing if they fail)
#   2) uploads the new vault code and deploys the factory (testnet/factory.env VAULT_V=8; allowed: USDC, XLM + testnet/pairs.env)
#   3) adds the previous factory to the "old" and "generations" lists: the keeper keeps filling it, and a user
#      with funds in a version 7 vault carries on with that vault (no migration)
#   4) republishes the site
# Usage: bash scripts/deploy-v8.sh
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Do not deploy again if version 8 is already live: every run deploys a NEW factory and users' vaults stay in the old one.
# For site changes only: bash scripts/deploy-web.sh
if grep -q '^VAULT_V=8' testnet/factory.env 2>/dev/null && [ "$REDEPLOY" != "1" ]; then
  echo "Version 8 is already deployed ($(grep -E '^FACTORY=' testnet/factory.env | cut -d= -f2-))."
  echo "To update the site:  bash scripts/deploy-web.sh"
  echo "To really deploy a new factory:  REDEPLOY=1 bash scripts/deploy-v8.sh"
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
[ -f testnet/eski-fabrikalar.env ] && PREV=$(grep -E '^OLD_FACTORIES=' testnet/eski-fabrikalar.env | cut -d= -f2-)

SECRET=""
for c in "stellar keys secret dev" "stellar keys show dev"; do
  S=$($c 2>/dev/null | grep -oE 'S[A-Z2-7]{55}' | head -1)
  [ -n "$S" ] && { SECRET="$S"; break; }
done
[ -z "$SECRET" ] && { echo "could not read the dev key (stellar keys)"; exit 1; }
[ -d keeper/node_modules/@stellar/stellar-sdk ] || (cd keeper && npm install --no-audit --no-fund > /dev/null 2>&1)

mkdir -p testnet/v7-yedek
cp testnet/factory.env testnet/v7-yedek/ 2>/dev/null
cp testnet/factory-sell.env testnet/v7-yedek/ 2>/dev/null

# One factory (the new vault code is uploaded; factory.env and factory-sell.env carry the same address)
(cd keeper && DEV_SECRET="$SECRET" node deploy.js --v8) 2>&1 | tee testnet/v8.txt
NEW_BUY=$(grep -E '^FACTORY=' testnet/factory.env | cut -d= -f2-)
if [ -z "$NEW_BUY" ] || [ "$NEW_BUY" = "$OLD_BUY" ]; then
  echo "The factory could not be deployed (testnet/v8.txt). The previous settings were restored."
  cp testnet/v7-yedek/factory.env testnet/ 2>/dev/null
  cp testnet/v7-yedek/factory-sell.env testnet/ 2>/dev/null
  exit 1
fi

# Old factories: the keeper keeps filling them and the app offers to move funds to the wallet
LIST=$(printf "%s\n" "$PREV" | tr ',' '\n'; echo "$OLD_BUY"; echo "$OLD_SELL")
LIST=$(echo "$LIST" | sed '/^$/d' | awk '!seen[$0]++' | paste -sd, -)
echo "OLD_FACTORIES=$LIST" > testnet/eski-fabrikalar.env
# Generations: a user with funds in the previous version does not have to migrate; the app keeps using that vault.
# Only versions with the same interface (4 and later) are listed, newest first.
GEN_PREV=""
[ -f testnet/nesiller.env ] && GEN_PREV=$(grep -E '^GENERATIONS=' testnet/nesiller.env | cut -d= -f2-)
[ -z "$GEN_PREV" ] && GEN_PREV="CB32H4RWA4DIA2NTE6W5IJATJUAYDAQ42HJDSFE6JWEM4W3BOZ4OEJM3:CDIEYJFASA2KTOGXBR2BQ27EDDXSZU35B5SBC4RVGQFLILNKUWWYVZ5D"
if [ -n "$OLD_BUY" ] && [ -n "$OLD_SELL" ]; then
  GENS=$(printf "%s\n" "$OLD_BUY:$OLD_SELL" $(echo "$GEN_PREV" | tr ',' ' ') | awk '!seen[$0]++' | paste -sd, -)
  echo "GENERATIONS=$GENS" > testnet/nesiller.env
  echo "Generations saved: $GENS"
fi
echo "Old factories saved: $LIST"

echo
echo "===== 3) Publish the site ====="
bash scripts/deploy-web.sh

echo
echo "DONE. Restart the keeper: Ctrl+C in the keeper terminal, then bash keeper/run.sh"
