#!/usr/bin/env bash
# TESTNET ONLY. Fills (or tops up) the price bot's inventory from the development machine, where the stellar CLI
# keystore holds "iora-issuer" and "iora-lp":
#   - each of Iora's coins (testnet/iora-coins.env) up to COIN_USD worth at Reflector's price, minted by paying it
#     from the issuer (the issuer's key never goes to the server);
#   - Circle USDC from iora-lp up to USDC.
# The bot's account must exist and have its trustlines first (node price-bot.js --setup on the server).
# XLM comes from friendbot when the account is created (10,000 XLM).
# Usage: bash scripts/price-bot/fund-bot.sh G...BOT [COIN_USD=500] [USDC=1500]
cd "$(dirname "$0")/../.." || exit 1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
N="--network testnet"
BOT=$1; COIN_USD=${2:-500}; WANT_USDC=${3:-1500}
[[ "$BOT" =~ ^G[A-Z2-7]{55}$ ]] || { echo "usage: $0 G...BOT [COIN_USD] [USDC]"; exit 1; }
source <(tr -d '\r' < testnet/blend-pool.env) || exit 1
source <(tr -d '\r' < testnet/iora-coins.env) || exit 1
source scripts/blend-rates.sh
USDC_ISSUER=$(grep '^USDC_ISSUER=' testnet/addr.env | cut -d= -f2 | tr -d '\r')
clean() { sed -E 's/S[A-Z2-7]{55}/S***/g'; }
q() { stellar contract invoke --source dev $N --send no --id "$1" -- "${@:2}" 2>/dev/null | tail -1 | tr -d '"'; }
num() { echo "$1" | grep -oE '^-?[0-9]+' || echo 0; }
pay() { local out; out=$(stellar tx new payment "$@" $N 2>&1 | clean)
  if echo "$out" | grep -qi error; then echo "    ERROR $(echo "$out" | grep -i error | head -1 | cut -c1-200)"; return 1; fi
  echo "    tx $(echo "$out" | grep -oE 'Signing transaction: [0-9a-f]{64}' | cut -d' ' -f3)"; }
echo "bot $BOT: each coin up to $COIN_USD USD, USDC up to $WANT_USDC"
for s in $COIN_SYMBOLS; do
  [ -n "${!s}" ] || continue
  P=$(q "$ORACLE" lastprice --asset "{\"Stellar\":\"${!s}\"}" | grep -oE 'price:[0-9]+' | cut -d: -f2)
  [ -n "$P" ] || { echo "  $s: no oracle price, skipped"; continue; }
  want=$(python3 -c "print(int($COIN_USD * 1e7 * 1e7 // $P))"); have=$(num "$(q "${!s}" balance --id "$BOT")")
  if [ "$have" -lt "$want" ]; then
    echo "  $s: has $(python3 -c "print($have/1e7)"), mint $(python3 -c "print(($want-$have)/1e7)")"
    pay --source iora-issuer --destination "$BOT" --asset "$s:$ISSUER" --amount $((want - have))
  else echo "  $s: has $(python3 -c "print($have/1e7)") (enough)"; fi
done
have=$(num "$(q "$CIRCLE_USDC" balance --id "$BOT")"); want=$((WANT_USDC * 10000000))
if [ "$have" -lt "$want" ]; then
  echo "  USDC: has $(python3 -c "print($have/1e7)"), send $(python3 -c "print(($want-$have)/1e7)") from iora-lp"
  pay --source iora-lp --destination "$BOT" --asset "USDC:$USDC_ISSUER" --amount $((want - have))
else echo "  USDC: has $(python3 -c "print($have/1e7)") (enough)"; fi
