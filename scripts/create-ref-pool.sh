#!/usr/bin/env bash
# TESTNET ONLY. Iora's reference pool for Circle USDC / XLM at the real XLM price (Reflector, through the oracle
# adapter of testnet/blend-pool.env). Testnet's Soroswap (~0.60 USD) and Aquarius standard pools (~0.37-0.63 USD)
# are far from the real price; they stay as they are, and Iora uses this pool instead.
#
# Venue: Aquarius. Its three standard USDC/XLM pools (fee 10, 30, 100 bps) already exist and the router accepts
# no other standard fee, so this is an Aquarius *concentrated* pool (fee FEE_BPS, default 30) holding full-range
# liquidity, which prices like a constant-product pool. The filler, the keeper and the web read every Aquarius pool
# of a pair through the Aquarius router (get_pools / estimate_swap / swap with the pool index), so it needs no
# new code there. scripts/price-bot/ keeps its price at Reflector's.
#
# Steps (each skipped when already done; safe to run again):
#   1) XLM for iora-lp from friendbot "funder" accounts (iora-xNN, merged into iora-lp), up to the XLM needed
#   2) 1 AQUA (Aquarius' pool creation fee) bought on Aquarius' XLM/AQUA pool
#   3) init_concentrated_pool(iora-lp, [USDC, XLM], FEE_BPS)
#   4) router deposit: LIQ_USDC USDC + the XLM worth the same at Reflector's price; shares stay in iora-lp
# Keys only in the stellar CLI keystore (iora-lp, iora-xNN). Writes only addresses to testnet/ref-pool.env.
# Usage: bash scripts/create-ref-pool.sh          (LIQ_USDC=3000 FEE_BPS=30 BOT_XLM=8000 by default)
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
N="--network testnet"
source <(tr -d '\r' < testnet/blend-pool.env) || exit 1
AQUA_ROUTER=$(grep '^AQUA_ROUTER=' testnet/filler.env | cut -d= -f2 | tr -d '\r')
LP=$(stellar keys address iora-lp) || exit 1
USDC=$CIRCLE_USDC
AQUA=CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE
AQUA_LINE=AQUA:GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER
LIQ_USDC=${LIQ_USDC:-3000}
FEE_BPS=${FEE_BPS:-30}
BOT_XLM=${BOT_XLM:-8000}          # XLM kept in iora-lp on top of the pool's, for the price bot's inventory
U=10000000
ENVF=testnet/ref-pool.env
touch "$ENVF"; source <(tr -d '\r' < "$ENVF")
clean() { sed -E 's/S[A-Z2-7]{55}/S***/g'; }
save() { sed -i "/^$1=/d" "$ENVF"; echo "$1=$2" >> "$ENVF"; eval "$1=$2"; }
die() { echo "STOP: $*"; exit 1; }
q() { stellar contract invoke --source dev $N --send no --id "$1" -- "${@:2}" 2>/dev/null | tail -1 | tr -d '"'; }
num() { echo "$1" | grep -oE '^-?[0-9]+' || echo 0; }
fmt() { python3 -c "print($1/1e7)"; }
run() { local who=$1; shift; local out; out=$(stellar contract invoke --source "$who" $N --id "$1" -- "${@:2}" 2>&1 | clean)
  if echo "$out" | grep -q "error"; then echo "    ERROR $(echo "$out" | grep error | head -1 | cut -c1-200)"; return 1; fi
  echo "    tx $(echo "$out" | grep -oE 'Signing transaction: [0-9a-f]{64}' | cut -d' ' -f3)"; RESULT=$(echo "$out" | tail -1); }
classic() { local out; out=$(stellar tx new "$@" $N 2>&1 | clean)
  if echo "$out" | grep -qi "error"; then echo "    ERROR $(echo "$out" | grep -i error | head -1 | cut -c1-200)"; return 1; fi
  echo "    tx $(echo "$out" | grep -oE 'Signing transaction: [0-9a-f]{64}' | cut -d' ' -f3)"; }
account() { curl -s "https://horizon-testnet.stellar.org/accounts/$1"; }
has_line() { account "$1" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if any(b.get('asset_code')=='$2' for b in d.get('balances',[])) else 1)"; }
oracle() {
  stellar contract invoke --source dev $N --send no --id "$ORACLE" -- lastprice --asset "{\"Stellar\":\"$1\"}" 2>/dev/null | tail -1 |
  python3 -c 'import json,sys,time; d=json.load(sys.stdin); assert time.time()-int(d["timestamp"])<=900; print(d["price"])'; }

echo "===== $(date -u +%FT%TZ) reference pool USDC/XLM; lp $LP"
PU=$(oracle "$USDC") && PX=$(oracle "$XLM") || die "no fresh oracle price"
AU=$((LIQ_USDC * U)); AX=$(python3 -c "print($AU * $PU // $PX)")
echo "Reflector: XLM $(fmt "$PX") USD, USDC $(fmt "$PU") USD -> pool $LIQ_USDC USDC + $(fmt "$AX") XLM"

echo "== 1) XLM"
NEED=$(( AX + BOT_XLM*U + 100*U ))
[ -n "$REF_POOL" ] && NEED=$(( BOT_XLM*U ))
i=1
while [ "$(num "$(q "$XLM" balance --id "$LP")")" -lt "$NEED" ]; do
  f=$(printf 'iora-x%02d' $i); i=$((i + 1)); [ $i -gt 5 ] && die "more than 4 funder accounts needed"
  stellar keys address "$f" > /dev/null 2>&1 && continue     # used (and merged) before
  stellar keys generate "$f" $N --fund 2>&1 | clean | tail -1 | cut -c1-80
  echo "  $f -> merge into iora-lp"; classic account-merge --source "$f" --account "$LP" || die "merge $f"
done
echo "  lp XLM $(fmt "$(num "$(q "$XLM" balance --id "$LP")")")  USDC $(fmt "$(num "$(q "$USDC" balance --id "$LP")")")"

echo "== 2) AQUA for the pool creation fee"
FEEAMT=$(num "$(q "$AQUA_ROUTER" get_conc_pool_payment_amount)")
if [ -z "$REF_POOL" ] && [ "$(num "$(q "$AQUA" balance --id "$LP")")" -lt "$FEEAMT" ]; then
  has_line "$LP" AQUA || classic change-trust --source iora-lp --line "$AQUA_LINE" || die "AQUA trustline"
  T="[\"$XLM\",\"$AQUA\"]"
  XIN=$((20*U)); IDX=""; OUT=0
  for ix in $(stellar contract invoke --source dev $N --send no --id "$AQUA_ROUTER" -- get_pools --tokens "$T" 2>/dev/null | tail -1 |
      python3 -c 'import json,sys; print(" ".join(json.load(sys.stdin)))'); do
    o=$(num "$(q "$AQUA_ROUTER" estimate_swap --tokens "$T" --token_in "$XLM" --token_out "$AQUA" --pool_index "$ix" --in_amount $XIN)")
    [ "$o" -gt "$OUT" ] && { OUT=$o; IDX=$ix; }
  done
  echo "  20 XLM -> $(fmt "$OUT") AQUA"; [ "$OUT" -ge "$FEEAMT" ] || die "20 XLM buys too little AQUA"
  run iora-lp "$AQUA_ROUTER" swap --user "$LP" --tokens "$T" --token_in "$XLM" --token_out "$AQUA" --pool_index "$IDX" \
    --in_amount $XIN --out_min "$FEEAMT" || die "AQUA swap"
fi

echo "== 3) concentrated pool, fee $FEE_BPS bps"
T="[\"$USDC\",\"$XLM\"]"
if [ -z "$REF_POOL" ]; then
  run iora-lp "$AQUA_ROUTER" init_concentrated_pool --user "$LP" --tokens "$T" --fee "$FEE_BPS" || die "init pool"
  echo "  result $RESULT"
  save REF_POOL_INDEX "$(echo "$RESULT" | grep -oE '[0-9a-f]{64}')"; save REF_POOL "$(echo "$RESULT" | grep -oE 'C[A-Z2-7]{55}')"
  save VENUE aquarius-concentrated; save FEE_BPS "$FEE_BPS"; save AQUA_ROUTER "$AQUA_ROUTER"; save LP "$LP"
  save TOKENS "$USDC,$XLM"; save CREATED_AT_UTC "$(date -u +%FT%TZ)"
fi
echo "  pool $REF_POOL index $REF_POOL_INDEX  info $(q "$REF_POOL" get_info)"

echo "== 4) liquidity"
if [ "$(num "$(q "$REF_POOL" get_total_shares)")" = 0 ]; then
  run iora-lp "$AQUA_ROUTER" deposit --user "$LP" --tokens "$T" --pool_index "$REF_POOL_INDEX" \
    --desired_amounts "[\"$AU\",\"$AX\"]" --min_shares 1 || die "deposit"
  echo "  result $RESULT"
fi
R=$(q "$REF_POOL" get_reserves | tr -d '[] '); RU=${R%%,*}; RX=${R#*,}
python3 -c "ru,rx=$RU,$RX; print(f'  reserves {ru/1e7:.4f} USDC + {rx/1e7:.4f} XLM -> {ru/rx:.6f} USDC/XLM; Reflector {$PX/$PU:.6f}')"; echo "  slot0 $(q "$REF_POOL" get_slot0)  tick bounds $(q "$REF_POOL" get_tick_bounds)"
echo "  lp shares $(q "$REF_POOL" get_user_shares --user "$LP")"
echo "===== done. $ENVF:"; cat "$ENVF"
