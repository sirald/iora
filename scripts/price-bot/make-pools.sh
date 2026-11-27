#!/usr/bin/env bash
# Writes scripts/price-bot/pools.json, the list of pools the price bot keeps at the real price, from the published
# address files: testnet/ref-pool.env (the XLM reference pool on Aquarius) and testnet/iora-coins.env (Iora's coins
# and their Soroswap USDC pairs). Run it after either file changes and copy pools.json to the server with the bot.
# Usage: bash scripts/price-bot/make-pools.sh
cd "$(dirname "$0")/../.." || exit 1
source <(tr -d '\r' < testnet/blend-pool.env) || exit 1
source <(tr -d '\r' < testnet/ref-pool.env) || exit 1
source <(tr -d '\r' < testnet/iora-coins.env) || exit 1
source scripts/blend-rates.sh
SOROSWAP_ROUTER=$(grep '^ROUTER=' testnet/addr.env | cut -d= -f2 | tr -d '\r')
USDC_ISSUER=$(grep '^USDC_ISSUER=' testnet/addr.env | cut -d= -f2 | tr -d '\r')
OUT=scripts/price-bot/pools.json
{
  echo "{"
  echo "  \"note\": \"made by scripts/price-bot/make-pools.sh from testnet/ref-pool.env and testnet/iora-coins.env\","
  echo "  \"usdc\": \"$CIRCLE_USDC\", \"usdcIssuer\": \"$USDC_ISSUER\", \"oracle\": \"$ORACLE\","
  echo "  \"pools\": ["
  echo -n "    {\"name\": \"XLM\", \"venue\": \"aquarius\", \"router\": \"$AQUA_ROUTER\", \"pool\": \"$REF_POOL\", \"poolIndex\": \"$REF_POOL_INDEX\", \"token\": \"$XLM\", \"native\": true}"
  for s in $COIN_SYMBOLS; do
    pv=${s}_PAIR
    [ -n "${!s}" ] && [ -n "${!pv}" ] || { echo "skip $s: no coin or pair in testnet/iora-coins.env" >&2; continue; }
    echo ","
    echo -n "    {\"name\": \"$s\", \"venue\": \"soroswap\", \"router\": \"$SOROSWAP_ROUTER\", \"pool\": \"${!pv}\", \"token\": \"${!s}\", \"code\": \"$s\", \"issuer\": \"$ISSUER\"}"
  done
  echo
  echo "  ]"
  echo "}"
} > "$OUT"
cat "$OUT"
