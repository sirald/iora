#!/usr/bin/env bash
# Batch filler TRIAL (experimental): can several orders be filled in ONE transaction, and how many fit?
# Deploys the batch contract and a SEPARATE trial factory and vault on testnet. First it checks that one bad fill
# in a batch does not stop the others. Then it places small buy orders that can fill at the current price and
# fills them through `fill_many` in one transaction, in growing batches (6, 7, 8) until the network's
# per-transaction limits refuse (measured: 6 fit, 7 are refused because their events pass the 16384 byte limit per transaction). All orders are in ONE vault, so the result is an upper bound: fills spread over
# many vaults touch more ledger entries each.
# It does NOT touch the settings the site and the keeper use, and the live keeper never sees the trial vault.
# First: bash scripts/test.sh     Usage: bash scripts/trial-batch.sh     Output: testnet/trial-batch.txt
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
N="--network testnet"
source testnet/addr.env
ME=$(stellar keys address dev)
KEEPER=$(stellar keys address keeper)
U=10000000
ALL=170141183460469231731687303715884105727
A=2000000          # each order sells 0.2 USDC
SIZES="6 7"       # fills tried in one transaction, growing until the network refuses
SLACK=40000       # deposited on top, per order: the fill fee (up to 0.003 USDC) is set aside with the order

inv() { stellar contract invoke --source "$1" $N --id "$2" -- "${@:3}" 2>&1; }
inv2() { local o; o=$(inv "$@"); if echo "$o" | grep -q "error:" && ! echo "$o" | grep -q "Error(Contract"; then sleep 6; o=$(inv "$@"); fi; echo "$o"; }
show() { grep -E "error|Error\(|OrderFilled|ExecFeePaid|VaultCreated|^\"?[A-Z0-9]+\"?$|^(true|false)$|^[0-9]+$" | grep -v "Diagnostic" | cut -c1-300 | head -4; }
last() { tail -1 | cut -c1-600; }
step() { echo; echo "===== $* ====="; }
later() { echo $(( $(date +%s) + 86400 )); }
status_of() { inv dev "$VAULT" get_order --order_id "$1" | last | grep -oE '"status":"?[A-Za-z]+' | grep -oE '[A-Za-z]+$'; }
# JSON list of fills for order ids given as arguments, 0.2 USDC each
fills() { local s="" id; for id in "$@"; do s="$s{\"vault\":\"$VAULT\",\"order_id\":$id,\"amount\":\"$A\",\"via\":null},"; done; echo "[${s%,}]"; }

{
echo "===== $(date) ====="
for W in iora_vault iora_factory iora_batch; do
  [ -f "wasm/$W.wasm" ] || { echo "wasm/$W.wasm is missing: run bash scripts/test.sh first"; echo "===== DONE ====="; exit 1; }
done

step "1) Deploy the batch contract"
DEP=$(stellar contract deploy --wasm wasm/iora_batch.wasm --source dev $N 2>&1)
BATCH=$(echo "$DEP" | grep -oE '^C[A-Z0-9]{55}$' | tail -1)
[ -z "$BATCH" ] && { echo "$DEP" | cut -c1-400 | tail -15; echo "BATCH DEPLOYMENT FAILED"; echo "===== DONE ====="; exit 1; }
echo "BATCH=$BATCH" | tee testnet/trial-batch.env

step "2) Trial factory and vault (separate from the live ones)"
HASH=$(stellar contract upload --wasm wasm/iora_vault.wasm --source dev $N 2>&1 | grep -oE '^[0-9a-f]{64}$' | tail -1)
[ -z "$HASH" ] && { echo "VAULT UPLOAD FAILED"; echo "===== DONE ====="; exit 1; }
FEES="{\"$XLM\":\"200000\",\"$USDC\":\"30000\"}"
DEP=$(stellar contract deploy --wasm wasm/iora_factory.wasm --source dev $N -- \
  --guardian "$ME" --vault_wasm_hash "$HASH" --pool "$POOL" --router "$ROUTER" --fees "$FEES" \
  --tokens "[\"$USDC\",\"$XLM\"]" 2>&1)
FACTORY=$(echo "$DEP" | grep -oE '^C[A-Z0-9]{55}$' | tail -1)
[ -z "$FACTORY" ] && { echo "$DEP" | cut -c1-400 | tail -15; echo "FACTORY DEPLOYMENT FAILED"; echo "===== DONE ====="; exit 1; }
echo "TRIAL_FACTORY=$FACTORY" | tee -a testnet/trial-batch.env
inv2 dev "$FACTORY" create_vault --owner "$ME" | show
VAULT=$(inv dev "$FACTORY" vault_of --owner "$ME" | tail -1 | tr -d '"')
echo "TRIAL_VAULT=$VAULT" | tee -a testnet/trial-batch.env
echo "vault version: $(inv dev "$VAULT" version | tail -1)"

place() { # place $1 orders
  local i
  for i in $(seq 1 "$1"); do
    inv2 dev "$VAULT" place_order --sell "$USDC" --buy "$XLM" --amount_in $A --limit_price 3000000 --min_fill $A \
      --max_impact_bps 500 --expiry "$(later)" --keep true | grep -E "error|Error\(" | cut -c1-200 | head -1
  done
}
count() { inv dev "$VAULT" order_count | tail -1 | tr -d '"'; }

step "3) Network limits right now (per transaction and per ledger)"
stellar network settings $N 2>&1 | grep -iE "instructions|entries|tx_count|txCount|size_bytes|SizeBytes|read_bytes|write_bytes|ReadBytes|WriteBytes" | head -40

step "4) A bad fill must not stop the others: a missing order (id 7777) and one real order in one batch"
inv2 dev "$VAULT" deposit --token "$USDC" --amount $((A + SLACK)) | show
place 1
MIX="[{\"vault\":\"$VAULT\",\"order_id\":7777,\"amount\":\"$A\",\"via\":null},{\"vault\":\"$VAULT\",\"order_id\":0,\"amount\":\"$A\",\"via\":null}]"
OUT=$(stellar contract invoke --source keeper $N --id "$BATCH" -- fill_many --executor "$KEEPER" --fills "$MIX" 2>&1)
echo "$OUT" | grep -E "error|Error\(" | cut -c1-300 | head -3
echo "returned (expected: 0 for the missing order, then an amount): $(echo "$OUT" | last)"
echo "order 0 status (should be Filled): $(status_of 0)"

step "5) How many fills fit in one transaction? Growing batches: $SIZES"
FIT=0
for K in $SIZES; do
  FIRST=$(count)
  DEPO=$(inv2 dev "$VAULT" deposit --token "$USDC" --amount $((K * (A + SLACK))))
  if echo "$DEPO" | grep -qE "error|Error\("; then echo "$K: deposit failed (not enough USDC in the dev wallet?) $(echo "$DEPO" | grep -E "error|Error\(" | head -1 | cut -c1-160)"; break; fi
  place "$K"
  NOW=$(count)
  [ "$((NOW - FIRST))" -ne "$K" ] && { echo "$K: only $((NOW - FIRST)) orders could be placed, stopping"; break; }
  if [ -z "$MEASURED" ]; then
    MEASURED=1
    echo "--- what a fill costs (simulation only) ---"
    node keeper/measure-fill.js "$BATCH" "$VAULT" "$KEEPER" "$A" "$(seq -s, "$FIRST" $((NOW - 1)))" 2>&1 | cut -c1-320
    echo "---"
  fi
  T0=$(date +%s)
  OUT=$(stellar contract invoke --source keeper $N --id "$BATCH" -- fill_many --executor "$KEEPER" --fills "$(fills $(seq "$FIRST" $((NOW - 1))))" 2>&1)
  if echo "$OUT" | grep -qE "error|Error\("; then
    echo "$K fills in one transaction: REFUSED"
    echo "$OUT" | grep -iE "error|Error\(|exceed|limit|budget" | cut -c1-260 | head -5
    break
  fi
  DONE_N=$(echo "$OUT" | last | grep -oE '"[1-9][0-9]*"' | wc -l)
  echo "$K fills in one transaction: OK ($DONE_N of $K bought something, $(( $(date +%s) - T0 )) s)   last order status: $(status_of $((NOW - 1)))"
  FIT=$K
done
echo "FILLS_PER_TRANSACTION=$FIT" | tee -a testnet/trial-batch.env

step "6) Clean up: cancel what is still open, withdraw everything"
TOTAL=$(count)
for i in $(seq "${FIRST:-0}" $((TOTAL - 1))); do   # only the last batch can still be open
  [ "$(status_of "$i")" = "Open" ] && inv2 dev "$VAULT" cancel_order --order_id "$i" | show
done
for T in "$USDC" "$XLM"; do inv2 dev "$VAULT" withdraw --token "$T" --amount $ALL | show; done
echo "positions (all should be 0): $(inv dev "$VAULT" positions | last)"

echo "===== DONE ====="
} 2>&1 | tee testnet/trial-batch.txt
