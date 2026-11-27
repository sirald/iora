#!/usr/bin/env bash
# Builds the website and app. With no argument it also publishes to Cloudflare Pages (https://iora.pages.dev).
#   bash scripts/build-web.sh --build-only     build only (used by deploy-web.sh)
cd "$(dirname "$0")/../web" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
PROJECT="iora"

# 1) Settings (public addresses only)
source ../testnet/addr.env || { echo "testnet/addr.env not found"; exit 1; }
source ../testnet/factory.env || { echo "testnet/factory.env not found"; exit 1; }
# Sell factory of the earlier two-vault design, if present
[ -f ../testnet/factory-sell.env ] && source ../testnet/factory-sell.env
# Factories of earlier contract versions (the app offers to move funds out of an old vault)
[ -f ../testnet/old-factories.env ] && source ../testnet/old-factories.env
# Earlier factory generations that use the same interface (buy:sell): a user with funds there stays there
[ -f ../testnet/generations.env ] && source ../testnet/generations.env
# Extra showcase markets of the earlier design
[ -f ../testnet/markets.env ] && source ../testnet/markets.env
# Other coins that trade against USDC (BTC, EURC ...): set up by scripts/create-test-markets.sh
[ -f ../testnet/pairs.env ] && source ../testnet/pairs.env
# Other trading venues (the Aquarius router): the Market tab swaps where the quote is best
[ -f ../testnet/filler.env ] && source ../testnet/filler.env
# The one-approval vault move (iora-mover) and the testnet USDC exchange (old Blend test USDC -> Circle USDC)
[ -f ../testnet/mover.env ] && source ../testnet/mover.env
# Iora's reference pool (kept at the real price): the chart and "Best price" use it when the file is there.
# The file says POOL and VENUE; it is read in a subshell so the Blend pool's POOL above is not overwritten.
REF_POOL=""; REF_VENUE=""
if [ -f ../testnet/ref-pool.env ]; then
  REF_POOL=$( unset POOL REF_POOL; . ../testnet/ref-pool.env >/dev/null 2>&1; echo "${REF_POOL:-${POOL:-}}" )
  REF_VENUE=$( unset VENUE; . ../testnet/ref-pool.env >/dev/null 2>&1; echo "${VENUE:-}" )
fi
for v in FACTORY USDC XLM ROUTER POOL; do
  [ -n "${!v}" ] || { echo "Missing setting: $v (testnet/*.env). The site was not built."; exit 1; }
done
cat > .env.local <<EOF
VITE_RPC_URL=https://soroban-rpc.testnet.stellar.gateway.fm
VITE_RPC_FALLBACK=https://soroban-testnet.stellar.org
VITE_FACTORY=$FACTORY
VITE_FACTORY_SELL=${FACTORY_SELL:-}
VITE_OLD_FACTORIES=${OLD_FACTORIES:-}
VITE_GENERATIONS=${GENERATIONS:-}
VITE_STAY_NEWEST=${STAY_NEWEST:-1}
VITE_VAULT_V=${VAULT_V:-3}
VITE_MARKETS=${MARKETS:-}
VITE_PAIRS=${PAIRS:-}
# Pool guard: above this utilisation new deposits and orders stop. 0 on testnet (warn only), because the
# Iora's own testnet pool is kept at 50-70% utilisation by the borrower bot, so it is on (UTIL_ENFORCE in testnet/addr.env).
VITE_UTIL_ENFORCE=${UTIL_ENFORCE:-0}
VITE_USDC=$USDC
VITE_XLM=$XLM
VITE_ROUTER=$ROUTER
VITE_AQUA_ROUTER=${AQUA_ROUTER:-}
VITE_FILLER=${FILLER:-}
VITE_MOVER=${MOVER:-}
VITE_USDC_EXCHANGE=${USDC_EXCHANGE:-}
VITE_REF_POOL=${REF_POOL}
VITE_REF_VENUE=${REF_VENUE}
VITE_POOL=$POOL
VITE_USDC_ISSUER=${USDC_ISSUER:-GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5}
EOF

# 2) Dependencies and build
if [ ! -d node_modules/vite ]; then
  npm install --no-audit --no-fund @stellar/stellar-sdk@latest @stellar/freighter-api@latest buffer@latest > /tmp/gk-web-npm.log 2>&1 \
    && npm install --no-audit --no-fund -D vite@latest >> /tmp/gk-web-npm.log 2>&1 \
    || { tail -20 /tmp/gk-web-npm.log; echo "npm install failed"; exit 1; }
fi
# Multi-wallet support (Stellar Wallets Kit 2.7.1, from JSR; 2.8.0 brought a base-x advisory, so it stays pinned).
# On by default (IORA_KIT=0 turns it off). REQUIRE_KIT=1: stop instead of building without it.
export IORA_KIT="${IORA_KIT:-1}"
if [ "$IORA_KIT" = "1" ] && [ ! -d node_modules/@creit-tech/stellar-wallets-kit ]; then
  npx --yes jsr add @creit-tech/stellar-wallets-kit@2.7.1 >> /tmp/gk-web-npm.log 2>&1 \
    && echo "Multi-wallet support installed." \
    || echo "WARNING: the multi-wallet library (Stellar Wallets Kit) could not be installed."
fi
kit_off_loud() {
  echo
  echo "=========================================================================="
  echo " WARNING: building WITHOUT multi-wallet support (Varial/Freighter only)."
  echo " Reason: $1"
  echo "=========================================================================="
  echo
  if [ "${REQUIRE_KIT:-0}" = "1" ]; then echo "REQUIRE_KIT=1: stopping."; exit 1; fi
}
if [ "$IORA_KIT" = "1" ] && [ ! -d node_modules/@creit-tech/stellar-wallets-kit ]; then
  kit_off_loud "the library is not installed (see /tmp/gk-web-npm.log)"
  export IORA_KIT=0
fi
echo "Building..."
if ! npx vite build > /tmp/gk-build-web.log 2>&1; then
  if [ "$IORA_KIT" = "1" ]; then
    tail -15 /tmp/gk-build-web.log
    kit_off_loud "the build with it failed (log above; on WSL this was a missing rolldown native binding)"
    export IORA_KIT=0
    npx vite build > /tmp/gk-build-web.log 2>&1 || { tail -30 /tmp/gk-build-web.log; echo "BUILD FAILED"; exit 1; }
  else
    tail -30 /tmp/gk-build-web.log; echo "BUILD FAILED"; exit 1
  fi
fi
echo "Multi-wallet support: $([ "$IORA_KIT" = "1" ] && echo ON || echo off)"
echo "Build done: $(du -sh dist | cut -f1)"
[ "$1" = "--build-only" ] && exit 0

# 3) Cloudflare login
if ! npx --yes wrangler@latest whoami 2>/dev/null | grep -qi "associated with the email\|account id"; then
  echo
  echo "Cloudflare login: a link will appear below. Open it in a browser and choose 'Allow'."
  echo
  npx --yes wrangler@latest login || { echo "Cloudflare login failed"; exit 1; }
fi

# 4) Project (create if missing) and publish
npx --yes wrangler@latest pages project create "$PROJECT" --production-branch main > /dev/null 2>&1 || true
echo "Publishing..."
OUT=$(npx --yes wrangler@latest pages deploy dist --project-name "$PROJECT" --branch main --commit-dirty=true 2>&1)
echo "$OUT" | tail -4
# "https://<hash>.<name>.pages.dev" -> permanent address "https://<name>.pages.dev"
URL=$(echo "$OUT" | grep -oE 'https://[a-z0-9]+\.[a-z0-9-]+\.pages\.dev' | tail -1 | sed -E 's#https://[a-z0-9]+\.#https://#')

echo
echo "Site: ${URL:-https://$PROJECT.pages.dev}"
echo "Run the same command again to update."
