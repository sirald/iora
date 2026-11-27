#!/usr/bin/env bash
# TESTNET ONLY. Checks Iora's own Blend pool (testnet/blend-pool.env) after scripts/deploy-blend-pool.sh.
#   bash scripts/verify-blend-pool.sh           read-only: oracle prices and their age, pool status, backstop, reserves
#   bash scripts/verify-blend-pool.sh --trial   also a small real test with a separate account (stellar identity
#       "blendtest", created and funded by friendbot if missing): Circle USDC trustline, buy USDC on Soroswap with
#       XLM, supply USDC, put XLM up as collateral, borrow USDC. The positions are left open (they show interest).
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
N="--network testnet"
source testnet/blend-pool.env || exit 1
SOROSWAP_ROUTER=CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD
CIRCLE_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
U=10000000
clean() { sed -E 's/S[A-Z2-7]{55}/S***/g'; }
q() { stellar contract invoke --source dev $N --send no --id "$1" -- "${@:2}" 2>/dev/null | tail -1 | tr -d '"'; }
run() { local who=$1; shift; stellar contract invoke --source "$who" $N --id "$1" -- "${@:2}" 2>&1 | clean | grep -vE "^ℹ|Simulat|Signing|^$|Event:" | tail -2 | cut -c1-400; }
num() { echo "$1" | grep -oE '^-?[0-9]+' || echo 0; }
FAIL=0
check() { if [ "$1" = ok ]; then echo "  OK   $2"; else echo "  FAIL $2"; FAIL=1; fi; }

echo "===== read-only checks $(date -u +%FT%TZ) ====="
NOW=$(date +%s)
for a in "$CIRCLE_USDC:USDC" "$XLM:XLM" "$WETH:ETH"; do
  t=${a%%:*}; s=${a#*:}
  P=$(q "$ORACLE" lastprice --asset "{\"Stellar\":\"$t\"}")
  price=$(echo "$P" | grep -oE 'price:[0-9]+' | cut -d: -f2); ts=$(echo "$P" | grep -oE 'timestamp:[0-9]+' | cut -d: -f2)
  if [ -n "$price" ] && [ $((NOW - ts)) -le 900 ]; then
    check ok "oracle $s = $(awk "BEGIN{printf \"%.4f\", $price/1e7}") USD, $((NOW - ts)) s old"
  else check fail "oracle $s: '$P'"; fi
done
CFG=$(q "$POOL" get_config); ST=$(echo "$CFG" | grep -oE 'status:[0-9]+' | cut -d: -f2)
[ "$ST" = 1 ] || [ "$ST" = 0 ] && check ok "pool status $ST (Active)" || check fail "pool status '$ST' ($CFG)"
echo "$CFG" | grep -q "$ORACLE" && check ok "pool oracle = our adapter" || check fail "pool oracle"
BD=$(q "$BACKSTOP" pool_data --pool "$POOL")
bl=$(echo "$BD" | grep -oE 'blnd:[0-9]+' | cut -d: -f2); us=$(echo "$BD" | grep -oE 'usdc:[0-9]+' | cut -d: -f2)
TH=$(awk "BEGIN{b=int($bl/1e7); u=int($us/1e7); printf \"%.1f\", (b^4*u)/1e25}")
awk "BEGIN{exit !($TH >= 1)}" && check ok "backstop: $((bl/U)) IBLND + $((us/U)) USDC = ${TH}x threshold" || check fail "backstop below threshold ($BD)"
echo "  reserves:"
for t in $CIRCLE_USDC $XLM $WETH; do
  R=$(q "$POOL" get_reserve --asset "$t")
  b=$(echo "$R" | grep -oE 'b_supply:[0-9]+' | cut -d: -f2); d=$(echo "$R" | grep -oE 'd_supply:[0-9]+' | cut -d: -f2)
  br=$(echo "$R" | grep -oE 'b_rate:[0-9]+' | cut -d: -f2); dr=$(echo "$R" | grep -oE 'd_rate:[0-9]+' | cut -d: -f2)
  echo "    $(q "$ORACLE" symbol --token "$t")  supplied $(awk "BEGIN{printf \"%.4f\", $b*$br/1e19}")  borrowed $(awk "BEGIN{printf \"%.4f\", $d*$dr/1e19}")  (b_rate $br, d_rate $dr)"
done

if [ "$1" = "--trial" ]; then
  echo "===== trial with account 'blendtest' ====="
  stellar keys address blendtest > /dev/null 2>&1 || stellar keys generate blendtest $N --fund 2>&1 | clean | tail -1
  T=$(stellar keys address blendtest); echo "  account $T"
  curl -s "https://friendbot.stellar.org/?addr=$T" > /dev/null  # no-op if already funded
  curl -s "https://horizon-testnet.stellar.org/accounts/$T" | grep -q "$CIRCLE_ISSUER" || \
    stellar tx new change-trust --source blendtest $N --line "USDC:$CIRCLE_ISSUER" 2>&1 | clean | tail -1
  if [ "$(num "$(q "$CIRCLE_USDC" balance --id "$T")")" -lt $((20*U)) ]; then
    run blendtest "$SOROSWAP_ROUTER" swap_exact_tokens_for_tokens --amount_in $((100*U)) --amount_out_min 1 \
      --path "[\"$XLM\",\"$CIRCLE_USDC\"]" --to "$T" --deadline $((NOW + 600))
  fi
  echo "  USDC balance: $(q "$CIRCLE_USDC" balance --id "$T")"
  echo "  -- supply 20 USDC (request 0), 2000 XLM collateral (2), borrow 8 USDC (4)"
  run blendtest "$POOL" submit --from "$T" --spender "$T" --to "$T" --requests \
    "[{\"request_type\":0,\"address\":\"$CIRCLE_USDC\",\"amount\":\"$((20*U))\"},{\"request_type\":2,\"address\":\"$XLM\",\"amount\":\"$((2000*U))\"},{\"request_type\":4,\"address\":\"$CIRCLE_USDC\",\"amount\":\"$((8*U))\"}]"
  POS=$(q "$POOL" get_positions --address "$T"); echo "  positions: $POS"
  echo "$POS" | grep -qE 'liabilities:\{[0-9]+:[1-9]' && check ok "borrow worked" || check fail "no liability recorded"
  echo "  USDC balance after: $(q "$CIRCLE_USDC" balance --id "$T")"
fi
[ $FAIL = 0 ] && echo "ALL OK" || echo "SOME CHECKS FAILED"
exit $FAIL
