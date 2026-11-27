#!/usr/bin/env bash
# TESTNET ONLY. Sets up Iora's own Blend v2 lending pool in which Circle's testnet USDC earns interest.
#
# Why our own Blend protocol: a pool can only lend (and so pay interest) when its backstop holds enough of the backstop
# token (BLND^4 x USDC >= 1e25 in the LP). On Blend's official testnet backstop that is ~170k BLND, which can only
# be gathered by milking the faucet. With our own backstop the BLND is ours (we issue it), so a few Circle USDC are
# enough. Every contract is a new INSTANCE of the wasm Blend already installed on testnet (same hashes as
# blend-utils/wasm_v2); only our oracle adapter (contracts/blend-oracle) is uploaded.
#
# Steps (each one is skipped when testnet/blend-pool.env already has its result, so the script can be run again):
#   1) build contracts/blend-oracle
#   2) dev: Circle USDC trustline, buy Circle USDC on Soroswap with XLM (for the backstop LP)
#   3) IBLND: classic asset issued by dev + its SAC (our "BLND")
#   4) comet IBLND/USDC 80/20 via Blend's testnet comet factory
#   5) emitter, pool factory, backstop (backstop address computed in advance from a salt: the factory needs it)
#   6) oracle adapter (Reflector testnet, USDC/XLM/ETH)
#   7) pool + reserves (Circle USDC, XLM, Blend wETH) while the pool is still in Setup (no timelock)
#   8) backstop deposit of all of dev's LP, status On Ice -> update_status -> Active
#   9) comet controller -> null address (its parameters are frozen, as Blend does)
# Writes ONLY addresses (and salts) to testnet/blend-pool.env. Signs with the stellar CLI identity "dev".
# Usage: bash scripts/deploy-blend-pool.sh        Log: testnet/deploy-blend-pool.txt (not published)
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
source "$HOME/.cargo/env" 2> /dev/null
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/iora-target}"
set -o pipefail

NET=testnet
N="--network $NET"
ENVF=testnet/blend-pool.env
LOG=testnet/deploy-blend-pool.txt
U=10000000
NULL_ADDR=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF

# Fixed testnet addresses (not ours)
CIRCLE_USDC=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
CIRCLE_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
XLM=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
WETH=CAZAQB3D7KSLSNOSQKYD2V4JP5V2Y3B4RDJZRLBFCCIXDCTE3WHSY3UE
REFLECTOR=CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63
SOROSWAP_ROUTER=CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD
COMET_FACTORY=CDX2TKELFKHP2MWISDCXWWZ73CL7F57GHYRJAWJWNOTLNJNNM7XLT4JY
# Blend wasm already installed on testnet (sha256 of blend-utils/wasm_v2 and wasm_v1)
POOL_HASH=a41fc53d6753b6c04eb15b021c55052366a4c8e0e21bc72700f461264ec1350e
BACKSTOP_HASH=c1f4502a757e25c611f5a159bc1ab0eef64085adac6c68123dca66e87faffbc2
FACTORY_HASH=31328050548831f63d2b72e37bcfd0bb7371b7907135755dbe09ed434d755ca9
EMITTER_HASH=438a5528cff17ede6fe515f095c43c5f15727af17d006971485e52462e7e7b89

# Our settings
BLND_CODE=IBLND
COMET_BLND=$((4000000*U))      # 4,000,000 IBLND
COMET_USDC=$((10*U))           # 10 Circle USDC -> (4e6)^4 x 10 = 2.56e27 >= 1e25
USDC_BUY_XLM=$((60*U))         # XLM swapped for Circle USDC when dev has less than 15 USDC
ORACLE_MAX_AGE=900
POOL_NAME=IoraCircle
BSTOP_RATE=1000000             # 10% of interest to the backstop
MAX_POSITIONS=6
# ReserveConfig of each coin (CFG_USDC, CFG_XLM, CFG_WETH): one place for this script and the rate scripts.
source scripts/blend-rates.sh

ME=$(stellar keys address dev) || { echo "no stellar identity 'dev'"; exit 1; }
touch "$ENVF"
source "$ENVF"
# Writes KEY=VALUE to the env file (addresses and salts only).
save() { sed -i "/^$1=/d" "$ENVF"; echo "$1=$2" >> "$ENVF"; eval "$1=$2"; }
# Strips anything that looks like a secret key from output.
clean() { sed -E 's/S[A-Z2-7]{55}/S***/g'; }
q() { stellar contract invoke --source dev $N --send no --id "$1" -- "${@:2}" 2>/dev/null | tail -1 | tr -d '"'; }
run() { local out; out=$(stellar contract invoke --source dev $N --id "$1" -- "${@:2}" 2>&1 | clean); local rc=$?; echo "$out" | grep -vE "^ℹ|Simulat|Signing|^$" | tail -2 | cut -c1-400; return $rc; }
cid() { grep -oE 'C[A-Z2-7]{55}' | tail -1; }
salt() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
exists() { [ -n "$1" ] && stellar contract info interface --id "$1" $N > /dev/null 2>&1; }
die() { echo "STOP: $*"; exit 1; }
num() { echo "$1" | grep -E '^-?[0-9]+$' || echo 0; }

main() {
echo "===== $(date -u +%FT%TZ)  network=$NET  dev=$ME ====="
[ "$NET" = testnet ] || die "testnet only"

echo "== 1) build the oracle adapter"
stellar contract build --package iora-blend-oracle --out-dir wasm > /tmp/blend-oracle-build.log 2>&1 || { tail -20 /tmp/blend-oracle-build.log; die "build failed"; }
ls -l wasm/iora_blend_oracle.wasm | awk '{print $5" bytes"}'

echo "== 2) Circle USDC for dev"
if ! curl -s "https://horizon-testnet.stellar.org/accounts/$ME" | grep -q "$CIRCLE_ISSUER"; then
  stellar tx new change-trust --source dev $N --line "USDC:$CIRCLE_ISSUER" 2>&1 | clean | tail -1
fi
HAVE=$(num "$(q $CIRCLE_USDC balance --id "$ME")")
if [ "$HAVE" -lt $((15*U)) ]; then
  OUT=$(q $SOROSWAP_ROUTER router_get_amounts_out --amount_in $USDC_BUY_XLM --path "[\"$XLM\",\"$CIRCLE_USDC\"]" | tr -d '[] ' | awk -F, '{print $NF}')
  MIN=$(( $(num "$OUT") * 97 / 100 ))
  [ "$MIN" -gt 0 ] || die "no Soroswap quote XLM->USDC"
  run $SOROSWAP_ROUTER swap_exact_tokens_for_tokens --amount_in $USDC_BUY_XLM --amount_out_min $MIN \
    --path "[\"$XLM\",\"$CIRCLE_USDC\"]" --to "$ME" --deadline $(( $(date +%s) + 600 )) || die "swap failed"
fi
echo "dev Circle USDC: $(q $CIRCLE_USDC balance --id "$ME")"

echo "== 3) $BLND_CODE (issuer dev) and its SAC"
if [ -z "$BLND" ]; then
  B=$(stellar contract id asset --asset "$BLND_CODE:$ME" $N 2>/dev/null | cid)
  exists "$B" || B=$(stellar contract asset deploy --asset "$BLND_CODE:$ME" --source dev $N 2>&1 | cid)
  exists "$B" || die "IBLND SAC"
  save BLND "$B"
fi
echo "IBLND: $BLND"

echo "== 4) comet $BLND_CODE/USDC 80/20"
if [ -z "$COMET" ]; then
  C=$(stellar contract invoke --source dev $N --id $COMET_FACTORY -- new_c_pool --salt "$(salt)" --controller "$ME" \
      --tokens "[\"$BLND\",\"$CIRCLE_USDC\"]" --weights '["8000000","2000000"]' \
      --balances "[\"$COMET_BLND\",\"$COMET_USDC\"]" --swap_fee 30000 2>&1 | clean | cid)
  exists "$C" || die "comet"
  save COMET "$C"
fi
echo "comet: $COMET  LP supply: $(q $COMET get_total_supply)  dev LP: $(q $COMET balance --id "$ME")"

echo "== 5) emitter, pool factory, backstop"
if [ -z "$EMITTER" ]; then
  E=$(stellar contract deploy --wasm-hash $EMITTER_HASH --source dev $N 2>&1 | clean | cid)
  exists "$E" || die "emitter"
  save EMITTER "$E"
fi
[ -n "$BACKSTOP_SALT" ] || save BACKSTOP_SALT "$(salt)"
BS_ADDR=$(stellar contract id wasm --salt "$BACKSTOP_SALT" --source dev $N 2>/dev/null | cid)
[ -n "$BS_ADDR" ] || die "cannot compute the backstop address"
if [ -z "$POOL_FACTORY" ]; then
  F=$(stellar contract deploy --wasm-hash $FACTORY_HASH --source dev $N -- \
      --pool_init_meta "{\"backstop\":\"$BS_ADDR\",\"blnd_id\":\"$BLND\",\"pool_hash\":\"$POOL_HASH\"}" 2>&1 | clean | cid)
  exists "$F" || die "pool factory"
  save POOL_FACTORY "$F"
fi
if [ -z "$BACKSTOP" ]; then
  B=$(stellar contract deploy --wasm-hash $BACKSTOP_HASH --salt "$BACKSTOP_SALT" --source dev $N -- \
      --backstop_token "$COMET" --emitter "$EMITTER" --blnd_token "$BLND" --usdc_token "$CIRCLE_USDC" \
      --pool_factory "$POOL_FACTORY" --drop_list '[]' 2>&1 | clean | cid)
  [ "$B" = "$BS_ADDR" ] || die "backstop deployed at '$B', expected $BS_ADDR"
  save BACKSTOP "$B"
fi
if [ "$(q $EMITTER get_backstop)" != "$BACKSTOP" ]; then
  run $EMITTER initialize --blnd_token "$BLND" --backstop "$BACKSTOP" --backstop_token "$COMET" || die "emitter initialize"
fi
echo "emitter: $EMITTER  pool factory: $POOL_FACTORY  backstop: $BACKSTOP"

echo "== 6) oracle adapter"
if [ -z "$ORACLE" ]; then
  O=$(stellar contract deploy --wasm wasm/iora_blend_oracle.wasm --source dev $N -- \
      --admin "$ME" --reflector $REFLECTOR --max_age $ORACLE_MAX_AGE \
      --assets "[[\"$CIRCLE_USDC\",\"USDC\"],[\"$XLM\",\"XLM\"],[\"$WETH\",\"ETH\"]]" 2>&1 | clean | cid)
  exists "$O" || die "oracle"
  save ORACLE "$O"
fi
for a in $CIRCLE_USDC $XLM $WETH; do echo "  $(q $ORACLE symbol --token $a): $(q $ORACLE lastprice --asset "{\"Stellar\":\"$a\"}")"; done

echo "== 7) pool and reserves"
if [ -z "$POOL" ]; then
  P=$(stellar contract invoke --source dev $N --id $POOL_FACTORY -- deploy --admin "$ME" --name "$POOL_NAME" \
      --salt "$(salt)" --oracle "$ORACLE" --backstop_take_rate $BSTOP_RATE --max_positions $MAX_POSITIONS \
      --min_collateral 0 2>&1 | clean | cid)
  exists "$P" || die "pool"
  save POOL "$P"
fi
LIST=$(q $POOL get_reserve_list)
STATUS=$(q $POOL get_config | grep -oE '"?status"?:[0-9]+' | grep -oE '[0-9]+$')
for pair in "$CIRCLE_USDC:$CFG_USDC" "$XLM:$CFG_XLM" "$WETH:$CFG_WETH"; do
  a=${pair%%:*}; cfg=${pair#*:}
  if echo "$LIST" | grep -q "$a"; then echo "  reserve $a already set"; continue; fi
  [ "$STATUS" = 6 ] || die "pool is not in Setup any more: adding $a needs the 1-week queue (queue_set_reserve, then set_reserve a week later)"
  run $POOL queue_set_reserve --asset "$a" --metadata "$cfg" || die "queue_set_reserve $a"
  run $POOL set_reserve --asset "$a" || die "set_reserve $a"
done
echo "reserves: $(q $POOL get_reserve_list)"

echo "== 8) backstop deposit and Active"
LP=$(num "$(q $COMET balance --id "$ME")")
if [ "$LP" -gt 0 ]; then
  run $BACKSTOP deposit --from "$ME" --pool_address "$POOL" --amount "$LP" || die "backstop deposit"
fi
echo "pool backstop: $(q $BACKSTOP pool_data --pool "$POOL")"
STATUS=$(q $POOL get_config | grep -oE '"?status"?:[0-9]+' | grep -oE '[0-9]+$')
if [ "$STATUS" = 6 ]; then run $POOL set_status --pool_status 3 || die "set_status 3"; fi
STATUS=$(q $POOL get_config | grep -oE '"?status"?:[0-9]+' | grep -oE '[0-9]+$')
if [ "$STATUS" != 1 ] && [ "$STATUS" != 0 ]; then run $POOL update_status || die "update_status"; fi
echo "pool config: $(q $POOL get_config)"

echo "== 9) comet controller -> null"
CTRL=$(q $COMET get_controller)
if [ "$CTRL" = "$ME" ]; then run $COMET set_controller --manager "$NULL_ADDR" || echo "  (controller change failed; harmless, retry later)"; fi
echo "comet controller: $(q $COMET get_controller)"

echo "== 10) extend the lifetime (TTL) of our contract instances and the oracle wasm (~115 days)"
# The pool, backstop and oracle extend themselves when used; the comet, IBLND and emitter are touched rarely.
for c in "$BLND" "$COMET" "$EMITTER" "$POOL_FACTORY" "$BACKSTOP" "$ORACLE" "$POOL"; do
  r=$(stellar contract extend --id "$c" --ledgers-to-extend 2000000 --durability persistent --source dev $N 2>&1 | clean | grep -oE "TTL.*|[0-9]{7,}" | tail -1)
  echo "  $c ${r:-extended}"
done
stellar contract extend --wasm wasm/iora_blend_oracle.wasm --ledgers-to-extend 2000000 --durability persistent --source dev $N > /dev/null 2>&1 && echo "  oracle wasm extended"

# Fixed addresses too, so the file is complete on its own.
save CIRCLE_USDC $CIRCLE_USDC; save XLM $XLM; save WETH $WETH; save REFLECTOR $REFLECTOR; save COMET_FACTORY $COMET_FACTORY
echo "===== DONE. Addresses: $ENVF ====="
cat "$ENVF"
}
main 2>&1 | clean | tee -a "$LOG"
