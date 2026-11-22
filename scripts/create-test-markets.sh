#!/usr/bin/env bash
# Creates Soroswap testnet pools for the USDC/BTC, USDC/EURC, USDC/XRP and USDC/XTAR markets (Soroswap's test tokens).
# Blend's wBTC could not be used for BTC: on the Blend testnet pool all of the wBTC is lent out (utilisation 95.2%),
# so none can be borrowed (checked on 17 Nov 2026). BTC is therefore Soroswap's test BTC as well.
# Deploys NO contract. These coins are not in the Blend pool, so they EARN NO INTEREST in a vault; they can only be traded.
#
# How: for each coin the dev account swaps 500 XLM into it on Soroswap's XLM/coin pool and puts it, with USDC of the
#      same value, into a new USDC/coin pool. If USDC is short it borrows from Blend (XLM as collateral).
# The pools are small (about 70 USDC each); they are for showcase orders.
# Safe to run again: existing pools are skipped.
# Usage: bash scripts/create-test-markets.sh      Output: testnet/create-test-markets.txt
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
N="--network testnet"
source testnet/addr.env
ME=$(stellar keys address dev)
SOROFACTORY=CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY
U=10000000
XLM_IN=$((500*U))
# Symbol and Soroswap testnet token address
COINS="
BTC:CB7ICEHVRIRMF3CF6SIP2C2R3Z4E7WRPATT552QSVLIXZ5RSN6KLUDAE
EURC:CBQDUWBOHS7P4TZIJ3KUPUZQOWMKJC6CQPPFEONSV3BH4X27YVEXWNOT
XRP:CDDIA6HYANLPMDKBVQRIIXY3NA6S3TMHZFJUNPMBEJGZ5JSHN3E2TAUI
XTAR:CCZGLAUBDKJSQK72QOZHVU7CUWKW45OZWYWCLL27AEK74U2OIBK6LXF2
"

q() { stellar contract invoke --source dev $N --id "$1" -- "${@:2}" 2>&1 | grep -v "^ℹ\|^⚠\|Simulat\|^$" | tail -1 | cut -c1-500; }
run() { stellar contract invoke --source dev $N --id "$1" -- "${@:2}" 2>&1 | grep -E "error|Error\(|Success|^\"|^\[|^[0-9]" | grep -v Diagnostic | cut -c1-300 | tail -3; }
num() { echo "$1" | tr -d '"' | grep -E '^[0-9]+$' || echo 0; }
last_of() { echo "$1" | tr -d '[]" ' | awk -F, '{print $NF}'; }
deadline() { echo $(( $(date +%s) + 600 )); }
touch testnet/pairs.env

{
echo "===== $(date) ====="
echo "dev: $ME   USDC: $(q "$USDC" balance --id "$ME")   XLM: $(q "$XLM" balance --id "$ME")"

# USDC: the four pools need about 300 USDC. If there is less, borrow from Blend.
HAVE=$(num "$(q "$USDC" balance --id "$ME")")
if [ "$HAVE" -lt $((400*U)) ]; then
  echo
  echo "===== Borrow USDC: 3,000 XLM collateral, 600 USDC debt ====="
  run "$POOL" submit --from "$ME" --spender "$ME" --to "$ME" \
    --requests "[{\"request_type\":2,\"address\":\"$XLM\",\"amount\":\"$((3000*U))\"},{\"request_type\":4,\"address\":\"$USDC\",\"amount\":\"$((600*U))\"}]"
  sleep 3
  echo "dev USDC: $(q "$USDC" balance --id "$ME")"
fi

for C in $COINS; do
  SYM=${C%%:*}; TOK=${C##*:}
  echo
  echo "===== $SYM $TOK ====="
  echo "name: $(q "$TOK" name)   decimals: $(q "$TOK" decimals)"
  if [ "$(q "$TOK" decimals)" != "7" ]; then echo "Not 7 decimals; a vault does not accept this token. Skipped."; continue; fi
  if [ "$(q "$SOROFACTORY" pair_exists --token_a "$USDC" --token_b "$TOK")" = "true" ]; then
    PAIR=$(q "$SOROFACTORY" get_pair --token_a "$USDC" --token_b "$TOK" | tr -d '"')
    echo "USDC/$SYM pool already exists: $PAIR  reserves: $(q "$PAIR" get_reserves)"
    grep -q ":$TOK" testnet/pairs.env || echo "$SYM:$TOK" >> testnet/pairs.list
    continue
  fi
  if [ "$(q "$SOROFACTORY" pair_exists --token_a "$XLM" --token_b "$TOK")" != "true" ]; then
    echo "No XLM/$SYM pool; this coin cannot be obtained. Skipped."; continue
  fi
  XP=$(q "$SOROFACTORY" get_pair --token_a "$XLM" --token_b "$TOK" | tr -d '"')
  echo "XLM/$SYM pool: $XP  reserves: $(q "$XP" get_reserves)"

  # 1) 500 XLM -> coin
  B0=$(num "$(q "$TOK" balance --id "$ME")")
  run "$ROUTER" swap_exact_tokens_for_tokens --amount_in "$XLM_IN" --amount_out_min 0 --path "[\"$XLM\",\"$TOK\"]" --to "$ME" --deadline "$(deadline)"
  sleep 3
  B1=$(num "$(q "$TOK" balance --id "$ME")")
  GOT=$(( B1 - B0 ))
  echo "$SYM received (units): $GOT"
  if [ "$GOT" -le 0 ]; then echo "Could not obtain $SYM (a trustline may be needed, or the pool is empty). Skipped."; continue; fi

  # 2) What 500 XLM is worth in USDC (at the USDC/XLM pool's price)
  NEED=$(last_of "$(q "$ROUTER" router_get_amounts_out --amount_in "$XLM_IN" --path "[\"$XLM\",\"$USDC\"]")")
  NEED=$(num "$NEED")
  echo "matching USDC (units): $NEED"
  if [ "$NEED" -le 0 ]; then echo "Could not work out the matching USDC. Skipped."; continue; fi
  HAVE=$(num "$(q "$USDC" balance --id "$ME")")
  if [ "$HAVE" -lt "$NEED" ]; then
    echo "Not enough USDC ($HAVE): borrowing 300 USDC from Blend (2,000 XLM collateral)"
    run "$POOL" submit --from "$ME" --spender "$ME" --to "$ME" \
      --requests "[{\"request_type\":2,\"address\":\"$XLM\",\"amount\":\"$((2000*U))\"},{\"request_type\":4,\"address\":\"$USDC\",\"amount\":\"$((300*U))\"}]"
    sleep 3
  fi

  # 3) Create the pool
  run "$ROUTER" add_liquidity --token_a "$USDC" --token_b "$TOK" --amount_a_desired "$NEED" --amount_b_desired "$GOT" \
    --amount_a_min 0 --amount_b_min 0 --to "$ME" --deadline "$(deadline)"
  sleep 3
  if [ "$(q "$SOROFACTORY" pair_exists --token_a "$USDC" --token_b "$TOK")" = "true" ]; then
    PAIR=$(q "$SOROFACTORY" get_pair --token_a "$USDC" --token_b "$TOK" | tr -d '"')
    echo "CREATED: USDC/$SYM  $PAIR  reserves: $(q "$PAIR" get_reserves)"
    echo "$SYM:$TOK" >> testnet/pairs.list
  else
    echo "USDC/$SYM pool could NOT be created."
  fi
done

# pairs.env: what was there before plus what this script created, without duplicates
OLD=$(grep -E '^PAIRS=' testnet/pairs.env 2>/dev/null | cut -d= -f2-)
ALL=$( (echo "$OLD" | tr ',' '\n'; cat testnet/pairs.list 2>/dev/null) | grep -E '^[A-Za-z0-9]+:C[A-Z0-9]{55}$' | awk '!s[$0]++' | paste -sd, -)
rm -f testnet/pairs.list
[ -n "$ALL" ] && echo "PAIRS=$ALL" > testnet/pairs.env
echo
echo "testnet/pairs.env: $(cat testnet/pairs.env)"
echo "===== DONE ====="
} 2>&1 | tee testnet/create-test-markets.txt
