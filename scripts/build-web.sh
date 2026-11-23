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
VITE_VAULT_V=${VAULT_V:-3}
VITE_MARKETS=${MARKETS:-}
VITE_PAIRS=${PAIRS:-}
# Pool guard: above this utilisation new deposits and orders stop. 0 on testnet (warn only), because the
# test pool sits at 88-95% utilisation; set to 1 on mainnet (UTIL_ENFORCE=1 in testnet/addr.env).
VITE_UTIL_ENFORCE=${UTIL_ENFORCE:-0}
VITE_USDC=$USDC
VITE_XLM=$XLM
VITE_ROUTER=$ROUTER
VITE_POOL=$POOL
VITE_USDC_ISSUER=GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56
EOF

# 2) Dependencies and build
if [ ! -d node_modules/vite ]; then
  npm install --no-audit --no-fund @stellar/stellar-sdk@latest @stellar/freighter-api@latest buffer@latest > /tmp/gk-web-npm.log 2>&1 \
    && npm install --no-audit --no-fund -D vite@latest >> /tmp/gk-web-npm.log 2>&1 \
    || { tail -20 /tmp/gk-web-npm.log; echo "npm install failed"; exit 1; }
fi
# Multi-wallet support (Stellar Wallets Kit, from JSR). If it cannot be installed the site builds with Freighter only.
if [ ! -d node_modules/@creit-tech/stellar-wallets-kit ]; then
  npx --yes jsr add @creit-tech/stellar-wallets-kit >> /tmp/gk-web-npm.log 2>&1 \
    && echo "Multi-wallet support installed." \
    || echo "Note: the multi-wallet library could not be installed; continuing with Freighter only."
fi
echo "Building..."
if ! npx vite build > /tmp/gk-build-web.log 2>&1; then
  echo "Build failed; retrying with multi-wallet support off..."
  BERTHLY_NO_KIT=1 npx vite build > /tmp/gk-build-web.log 2>&1 || { tail -30 /tmp/gk-build-web.log; echo "BUILD FAILED"; exit 1; }
fi
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
