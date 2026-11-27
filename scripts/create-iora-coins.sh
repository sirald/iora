#!/usr/bin/env bash
# TESTNET ONLY. Iora's own test coins iBTC, iETH, iSOL, iAVAX, iXRP (COIN_SYMBOLS in scripts/blend-rates.sh): classic
# assets issued by a separate account ("iora-issuer", home domain iorafi.com), priced by Reflector, tradable on
# Soroswap against Circle USDC and queued as reserves in Iora's own Blend pool.
#
# The Reflector symbol of a coin is its code without the leading "i" (refl_symbol: iBTC -> BTC). The "i" marks them
# as Iora's. On Stellar an asset is code + ISSUER, so only these issued by ISSUER (testnet/iora-coins.env) are Iora's.
# (A first set BTC, ETH, SOL, EURC was retired on 2026-11-27: testnet/iora-coins.retired.env.)
#
# Steps (each skipped when testnet/iora-coins.env already has its result; safe to run again):
#   1) issuer account (friendbot) + home domain; 2) SAC of each coin (7 decimals, as every classic asset)
#   3) "iora-lp" account (friendbot) with trustlines; Circle USDC for it bought on Soroswap with XLM from
#      friendbot "funder" accounts (chunks, price impact <= 2% each), funders merged into iora-lp afterwards
#   4) Soroswap USDC/COIN pool per coin, LIQ_USDC (1500) USDC + the coin at Reflector's price; LP tokens stay in iora-lp
#   5) oracle adapter: set_asset(coin, Reflector symbol); 6) factory: set_allowed(coin, true)
#   7) Blend: queue_set_reserve with scripts/blend-rates.sh (CFG_<SYM>); apply a week later: apply-blend-rates.sh
#   8) testnet/pairs.env PAIRS (the coins)
# Step 3 also buys EXTRA_USDC (1500) more for the price bot's inventory (scripts/price-bot/), left in iora-lp.
# Keys: only in the stellar CLI keystore (iora-issuer, iora-lp, iora-cNN). dev signs 5)-7) (oracle admin,
# factory guardian, pool admin). Writes only addresses to testnet/iora-coins.env.
# Usage: bash scripts/create-iora-coins.sh        Log: testnet/create-iora-coins.txt (not published)
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
set -o pipefail
N="--network testnet"
source <(tr -d '\r' < testnet/blend-pool.env) || exit 1
source <(tr -d '\r' < testnet/factory.env) || exit 1
ROUTER=$(grep '^ROUTER=' testnet/addr.env | cut -d= -f2 | tr -d '\r')
USDC_ISSUER=$(grep '^USDC_ISSUER=' testnet/addr.env | cut -d= -f2 | tr -d '\r')
source scripts/blend-rates.sh
SOROFACTORY=CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY
AQUA=CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE
USDC=$CIRCLE_USDC
LIQ_USDC=${LIQ_USDC:-1500}
EXTRA_USDC=${EXTRA_USDC:-1500}
HOME_DOMAIN=${HOME_DOMAIN:-iorafi.com}
U=10000000
ENVF=testnet/iora-coins.env
LOG=testnet/create-iora-coins.txt
touch "$ENVF"; source <(tr -d '\r' < "$ENVF")

clean() { sed -E 's/S[A-Z2-7]{55}/S***/g'; }
save() { sed -i "/^$1=/d" "$ENVF"; echo "$1=$2" >> "$ENVF"; eval "$1=$2"; }
die() { echo "STOP: $*"; exit 1; }
ts() { date -u +%FT%TZ; }
addr() { stellar keys address "$1"; }
q() { stellar contract invoke --source dev $N --send no --id "$1" -- "${@:2}" 2>/dev/null | tail -1 | tr -d '"'; }
num() { echo "$1" | grep -oE '^-?[0-9]+' || echo 0; }
# run WHO CONTRACT FN ARGS...: sends, prints the tx hash, returns 1 on error
run() { local who=$1; shift; local out; out=$(stellar contract invoke --source "$who" $N --id "$1" -- "${@:2}" 2>&1 | clean)
  if echo "$out" | grep -q "error"; then echo "    ERROR $(echo "$out" | grep error | head -1 | cut -c1-200)"; return 1; fi
  echo "    tx $(echo "$out" | grep -oE 'Signing transaction: [0-9a-f]{64}' | cut -d' ' -f3)"; }
classic() { local out; out=$(stellar tx new "$@" $N 2>&1 | clean)
  if echo "$out" | grep -qi "error"; then echo "    ERROR $(echo "$out" | grep -i error | head -1 | cut -c1-200)"; return 1; fi
  echo "    tx $(echo "$out" | grep -oE 'Signing transaction: [0-9a-f]{64}' | cut -d' ' -f3)"; }
account() { curl -s "https://horizon-testnet.stellar.org/accounts/$1"; }
has_line() { account "$1" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if any(b.get('asset_code')=='$2' and b.get('asset_issuer')=='$3' for b in d.get('balances',[])) else 1)"; }
xlm_of() { account "$1" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(int(float([b["balance"] for b in d["balances"] if b["asset_type"]=="native"][0])*1e7))' 2>/dev/null || echo 0; }
ident() { stellar keys address "$1" > /dev/null 2>&1 || stellar keys generate "$1" $N --fund 2>&1 | clean | tail -1 | cut -c1-70; }
refl() { q "$REFLECTOR" lastprice --asset "{\"Other\":\"$1\"}" | grep -oE 'price:[0-9]+' | cut -d: -f2; }

# Buys USDC for WHO with WHO's own XLM (Soroswap pays from `to`), chunks <= 4000 USDC, impact <= 2% each.
buy_usdc() { local who=$1 want=$2 me; me=$(addr "$who")
  local pairx; pairx=$(q $SOROFACTORY get_pair --token_a "$XLM" --token_b "$USDC")
  local start; start=$(num "$(q "$USDC" balance --id "$me")")
  while :; do
    local got=$(( $(num "$(q "$USDC" balance --id "$me")") - start )); local rem=$((want - got))
    [ $rem -le 0 ] && break
    local chunk=$(( rem < 4000*U ? rem : 4000*U ))
    local xin; xin=$(q "$ROUTER" router_get_amounts_in --amount_out $chunk --path "[\"$XLM\",\"$USDC\"]" | tr -d '[] ' | cut -d, -f1)
    local have=$(( $(xlm_of "$me") - 30*U ))
    if [ "$(num "$xin")" -gt "$have" ]; then
      [ "$have" -lt $((100*U)) ] && break
      chunk=$(q "$ROUTER" router_get_amounts_out --amount_in $have --path "[\"$XLM\",\"$USDC\"]" | tr -d '[] ' | cut -d, -f2); chunk=$((chunk * 995 / 1000))
      xin=$(q "$ROUTER" router_get_amounts_in --amount_out $chunk --path "[\"$XLM\",\"$USDC\"]" | tr -d '[] ' | cut -d, -f1)
    fi
    local res; res=$(q "$pairx" get_reserves | tr -d '[] ')
    local imp; imp=$(python3 -c "ru,rx=[int(x) for x in '$res'.split(',')[:2]]; print(round((1-($chunk/$xin)/(ru/rx))*100,3))")
    python3 -c "import sys; sys.exit(0 if $imp <= 2.0 else 1)" || { echo "  price impact $imp% > 2%: stop"; return 1; }
    echo "  $who buys $(python3 -c "print($chunk/1e7)") USDC for $(python3 -c "print($xin/1e7)") XLM (impact incl. fee $imp%)"
    run "$who" "$ROUTER" swap_tokens_for_exact_tokens --amount_out $chunk --amount_in_max $((xin * 1005 / 1000)) \
      --path "[\"$XLM\",\"$USDC\"]" --to "$me" --deadline $(( $(date +%s) + 600 )) || return 1
  done
}

main() {
echo "===== $(ts) Iora test coins: $COIN_SYMBOLS ====="

echo "== 1) issuer"
ident iora-issuer; save ISSUER "$(addr iora-issuer)"
if ! account "$ISSUER" | grep -q "\"home_domain\": \"$HOME_DOMAIN\""; then
  classic set-options --source iora-issuer --home-domain "$HOME_DOMAIN" || echo "  (home domain not set; optional)"
fi
echo "issuer $ISSUER  home_domain $(account "$ISSUER" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("home_domain"))')"

echo "== 2) SACs"
for s in $COIN_SYMBOLS; do
  if [ -z "${!s}" ]; then
    id=$(stellar contract id asset --asset "$s:$ISSUER" $N 2>/dev/null | grep -oE 'C[A-Z2-7]{55}' | tail -1)
    stellar contract info interface --id "$id" $N > /dev/null 2>&1 || \
      id=$(stellar contract asset deploy --asset "$s:$ISSUER" --source iora-issuer $N 2>&1 | clean | grep -oE 'C[A-Z2-7]{55}' | tail -1)
    [ -n "$id" ] || die "SAC $s"
    save "$s" "$id"
  fi
  echo "  $s ${!s}  decimals $(q "${!s}" decimals)  name $(q "${!s}" name)"
done

echo "== 3) liquidity account and its USDC"
ident iora-lp; save LP "$(addr iora-lp)"
for line in "USDC:$USDC_ISSUER" $(for s in $COIN_SYMBOLS; do echo "$s:$ISSUER"; done); do
  has_line "$LP" "${line%%:*}" "${line#*:}" || classic change-trust --source iora-lp --line "$line" || die "trustline $line"
done
NEED=0; for s in $COIN_SYMBOLS; do v=${s}_PAIR; [ -z "${!v}" ] && NEED=$((NEED + LIQ_USDC*U)); done
[ "$NEED" -gt 0 ] && NEED=$((NEED + EXTRA_USDC*U))   # the bot's USDC only on a run that builds pools
HAVE=$(num "$(q "$USDC" balance --id "$LP")")
i=1
while [ "$HAVE" -lt "$NEED" ]; do
  f=$(printf 'iora-c%02d' $i); i=$((i + 1)); [ $i -gt 6 ] && die "more than 5 funder accounts needed"
  stellar keys address "$f" > /dev/null 2>&1 && [ "$(xlm_of "$(addr "$f")")" = 0 ] && continue   # merged earlier
  ident "$f"; F=$(addr "$f")
  has_line "$F" USDC "$USDC_ISSUER" || classic change-trust --source "$f" --line "USDC:$USDC_ISSUER" || die "funder trustline"
  buy_usdc "$f" $((NEED - HAVE + 10*U)) || die "buying USDC"
  b=$(num "$(q "$USDC" balance --id "$F")")
  [ "$b" -gt 0 ] && { classic payment --source "$f" --destination "$LP" --asset "USDC:$USDC_ISSUER" --amount "$b" || die "USDC to lp"; }
  classic change-trust --source "$f" --line "USDC:$USDC_ISSUER" --limit 0 && classic account-merge --source "$f" --account "$LP"
  HAVE=$(num "$(q "$USDC" balance --id "$LP")")
done
echo "lp $LP  USDC $(python3 -c "print($HAVE/1e7)")  XLM $(python3 -c "print($(xlm_of "$LP")/1e7)")"

echo "== 4) Soroswap USDC/COIN pools at Reflector's price"
PU=$(refl USDC)
for s in $COIN_SYMBOLS; do
  v=${s}_PAIR; [ -n "${!v}" ] && { echo "  $s pool ${!v} exists"; continue; }
  PC=$(refl "$(refl_symbol "$s")"); [ -n "$PC" ] && [ -n "$PU" ] || die "no Reflector price for $s"
  AU=$((LIQ_USDC * U)); AC=$(python3 -c "print($AU * $PU // $PC)")
  echo "  $s: $LIQ_USDC USDC + $(python3 -c "print($AC/1e7)") $s  (Reflector $(refl_symbol "$s") $(python3 -c "print($PC/1e14)") USD, USDC $(python3 -c "print($PU/1e14)") USD)"
  bal=$(num "$(q "${!s}" balance --id "$LP")")
  [ "$bal" -lt "$AC" ] && { classic payment --source iora-issuer --destination "$LP" --asset "$s:$ISSUER" --amount $((AC - bal)) || die "mint $s"; }
  run iora-lp "$ROUTER" add_liquidity --token_a "$USDC" --token_b "${!s}" --amount_a_desired $AU --amount_b_desired "$AC" \
    --amount_a_min $((AU * 99 / 100)) --amount_b_min $((AC * 99 / 100)) --to "$LP" --deadline $(( $(date +%s) + 600 )) || die "add_liquidity $s"
  save "$v" "$(q $SOROFACTORY get_pair --token_a "$USDC" --token_b "${!s}")"
done

echo "== 5) oracle adapter $ORACLE"
for s in $COIN_SYMBOLS; do
  [ "$(q "$ORACLE" symbol --token "${!s}")" = "$(refl_symbol "$s")" ] || run dev "$ORACLE" set_asset --token "${!s}" --symbol "$(refl_symbol "$s")" || die "set_asset $s"
  echo "  $s -> $(q "$ORACLE" lastprice --asset "{\"Stellar\":\"${!s}\"}")"
done

echo "== 6) factory $FACTORY allowed list"
for s in $COIN_SYMBOLS; do
  [ "$(q "$FACTORY" is_allowed --token "${!s}")" = true ] || run dev "$FACTORY" set_allowed --token "${!s}" --allow true || die "set_allowed $s"
done
echo "  allowed: $(q "$FACTORY" allowed_tokens)"

echo "== 7) Blend reserves (queued; one-week timelock)"
LIST=$(q "$POOL" get_reserve_list)
FIRST=""
for s in $COIN_SYMBOLS; do
  echo "$LIST" | grep -q "${!s}" && { echo "  $s already a reserve"; continue; }
  cfgv=CFG_$s
  out=$(stellar contract invoke --source dev $N --id "$POOL" -- queue_set_reserve --asset "${!s}" --metadata "${!cfgv}" 2>&1 | clean)
  if echo "$out" | grep -q error; then echo "  $s not queued: $(echo "$out" | grep error | head -1 | cut -c1-160) (already queued?)"; continue; fi
  now=$(date -u +%s); [ -z "$FIRST" ] && FIRST=$now
  echo "  $s queued $(date -u -d @$now +%FT%TZ), earliest apply $(date -u -d @$((now + 604800)) +%FT%TZ), tx $(echo "$out" | grep -oE 'Signing transaction: [0-9a-f]{64}' | cut -d' ' -f3)"
done
if [ -n "$FIRST" ]; then
  save RESERVES_QUEUED_AT_UTC "$(date -u -d @$FIRST +%FT%TZ)"
  save RESERVES_UNLOCK_AT_UTC "$(date -u -d @$((FIRST + 604800 + 120)) +%FT%TZ)"
fi

echo "== 8) testnet/pairs.env"
P=""; for s in $COIN_SYMBOLS; do P="$P${P:+,}$s:${!s}"; done
echo "PAIRS=$P" > testnet/pairs.env; cat testnet/pairs.env

echo "== prices on Soroswap vs Reflector"
PU=$(refl USDC)
for s in $COIN_SYMBOLS; do
  PC=$(refl "$(refl_symbol "$s")"); ref=$(python3 -c "print($PC/$PU)")
  ten=$((10 * U)); c_in=$(python3 -c "print(int($ten * $PU // $PC))")
  o1=$(q "$ROUTER" router_get_amounts_out --amount_in $ten --path "[\"$USDC\",\"${!s}\"]" | tr -d '[] ' | cut -d, -f2)
  o2=$(q "$ROUTER" router_get_amounts_out --amount_in "$c_in" --path "[\"${!s}\",\"$USDC\"]" | tr -d '[] ' | cut -d, -f2)
  v=${s}_PAIR; R=$(q "${!v}" get_reserves | tr -d '[] ')
  python3 -c "
ref=$ref; buy=$ten/$o1; sell=$o2/$c_in
print(f'  $s  Reflector {ref:.6g} USDC  buy 10 USDC -> {buy:.6g} USDC/$s ({(buy/ref-1)*100:+.2f}%)  sell \$10 of $s -> {sell:.6g} ({(sell/ref-1)*100:+.2f}%)  reserves [$R]')"
done
echo "===== $(ts) done. Addresses: $ENVF ====="
cat "$ENVF"
}
main 2>&1 | clean | tee -a "$LOG"
