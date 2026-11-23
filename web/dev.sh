#!/usr/bin/env bash
# Starts the website and app locally: http://localhost:5173  (Ctrl+C to stop)
cd "$(dirname "$0")" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Settings: generated from the public addresses in the testnet files (no secrets).
source ../testnet/addr.env
source ../testnet/factory.env
# Sell factory of the earlier two-vault design, if present
[ -f ../testnet/factory-sell.env ] && source ../testnet/factory-sell.env
# Factories of earlier contract versions (the app offers to move funds out of an old vault)
[ -f ../testnet/old-factories.env ] && source ../testnet/old-factories.env
# Earlier factory generations and extra markets (same settings as the published site)
[ -f ../testnet/generations.env ] && source ../testnet/generations.env
[ -f ../testnet/markets.env ] && source ../testnet/markets.env
# Other coins that trade against USDC (BTC, EURC ...): set up by scripts/create-test-markets.sh
[ -f ../testnet/pairs.env ] && source ../testnet/pairs.env
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
VITE_USDC=$USDC
VITE_XLM=$XLM
VITE_ROUTER=$ROUTER
VITE_POOL=$POOL
VITE_USDC_ISSUER=GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56
EOF

if [ ! -d node_modules/vite ]; then
  echo "Installing dependencies (1-2 minutes the first time)..."
  npm install --no-audit --no-fund @stellar/stellar-sdk@latest @stellar/freighter-api@latest buffer@latest > /tmp/gk-web-npm.log 2>&1 \
    && npm install --no-audit --no-fund -D vite@latest >> /tmp/gk-web-npm.log 2>&1 \
    || { tail -20 /tmp/gk-web-npm.log; echo "npm install failed"; exit 1; }
fi

if [ ! -d node_modules/@creit-tech/stellar-wallets-kit ]; then
  npx --yes jsr add @creit-tech/stellar-wallets-kit >> /tmp/gk-web-npm.log 2>&1 || echo "Note: the multi-wallet library could not be installed (Freighter only)."
fi

echo
echo "Landing page: http://localhost:5173   App: http://localhost:5173/app.html"
echo "Press Ctrl+C in this window to stop."
echo
exec npx vite
