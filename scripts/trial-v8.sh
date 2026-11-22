#!/usr/bin/env bash
# Version 8 TRIAL: deploys the vault and factory SEPARATELY on testnet and exercises the new features against the real
# Blend pool and Soroswap: the allowed token list, fills through an intermediate token (USDC -> XLM -> BTC), no rounding
# buffer for a coin that is not on Blend, and the minimum fill of a follow-up order.
# It does NOT touch the settings the site and the keeper use (testnet/factory.env and so on).
# First: bash scripts/test.sh     Usage: bash scripts/trial-v8.sh     Output: testnet/trial-v8.txt
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
N="--network testnet"
source testnet/addr.env
ME=$(stellar keys address dev)
KEEPER=$(stellar keys address keeper)
U=10000000
BTC=CB7ICEHVRIRMF3CF6SIP2C2R3Z4E7WRPATT552QSVLIXZ5RSN6KLUDAE
EURC=CBQDUWBOHS7P4TZIJ3KUPUZQOWMKJC6CQPPFEONSV3BH4X27YVEXWNOT
ALL=170141183460469231731687303715884105727

inv() { stellar contract invoke --source "$1" $N --id "$2" -- "${@:3}" 2>&1; }
inv2() { local o; o=$(inv "$@"); if echo "$o" | grep -q "error:" && ! echo "$o" | grep -q "Error(Contract"; then sleep 6; o=$(inv "$@"); fi; echo "$o"; }
show() { grep -E "error|Error\(|OrderFilled|FollowOpened|Held|ExecFeePaid|VaultCreated|TokenAllowed|^\"?[A-Z0-9]+\"?$|^(true|false)$|^[0-9]+$" | grep -v "Diagnostic" | cut -c1-400 | head -6; }
last() { tail -1 | cut -c1-900; }
num() { tail -1 | tr -d '"'; }
step() { echo; echo "===== $* ====="; }
later() { echo $(( $(date +%s) + 86400 )); }

{
echo "===== $(date) ====="
[ -f wasm/iora_vault.wasm ] && [ -f wasm/iora_factory.wasm ] || { echo "no wasm: run bash scripts/test.sh first"; echo "===== DONE ====="; exit 1; }

step "1) Upload the vault wasm"
HASH=$(stellar contract upload --wasm wasm/iora_vault.wasm --source dev $N 2>&1 | tee /tmp/gk8-up.log | grep -oE '^[0-9a-f]{64}$' | tail -1)
[ -z "$HASH" ] && { tail -15 /tmp/gk8-up.log; echo "UPLOAD FAILED"; echo "===== DONE ====="; exit 1; }
echo "wasm hash: $HASH"

step "2) Trial factory (allowed: USDC, XLM, BTC; EURC is left OFF the list on purpose)"
FEES="{\"$XLM\":\"200000\",\"$USDC\":\"30000\"}"
DEP=$(stellar contract deploy --wasm wasm/iora_factory.wasm --source dev $N -- \
  --guardian "$ME" --vault_wasm_hash "$HASH" --pool "$POOL" --router "$ROUTER" --fees "$FEES" \
  --tokens "[\"$USDC\",\"$XLM\",\"$BTC\"]" 2>&1)
FACTORY=$(echo "$DEP" | grep -oE '^C[A-Z0-9]{55}$' | tail -1)
[ -z "$FACTORY" ] && { echo "$DEP" | grep -v '^\s*$' | cut -c1-500 | tail -30; echo "FACTORY DEPLOYMENT FAILED"; echo "===== DONE ====="; exit 1; }
echo "FACTORY8=$FACTORY" | tee testnet/trial-v8.env
echo "allowed tokens: $(inv dev "$FACTORY" allowed_tokens | last)"

step "3) Open a vault, deposit 8 USDC"
inv2 dev "$FACTORY" create_vault --owner "$ME" | show
VAULT=$(inv dev "$FACTORY" vault_of --owner "$ME" | tail -1 | tr -d '"')
echo "VAULT8=$VAULT" | tee -a testnet/trial-v8.env
echo "version (should be 8): $(inv dev "$VAULT" version | tail -1)"
inv2 dev "$VAULT" deposit --token "$USDC" --amount $((8*U)) | show

step "4) Prices: how much BTC (units) for 2 USDC"
echo "direct USDC->BTC:       $(inv dev "$ROUTER" router_get_amounts_out --amount_in $((2*U)) --path "[\"$USDC\",\"$BTC\"]" | last)"
echo "through XLM:            $(inv dev "$ROUTER" router_get_amounts_out --amount_in $((2*U)) --path "[\"$USDC\",\"$XLM\",\"$BTC\"]" | last)"

step "5) BUY BTC THROUGH AN INTERMEDIATE TOKEN (USDC -> XLM -> BTC): 2 USDC, limit 1 BTC = at most 8,000 USDC"
inv2 dev "$VAULT" place_order --sell "$USDC" --buy "$BTC" --amount_in $((2*U)) --limit_price $((8000*U)) --min_fill $((2*U)) \
  --max_impact_bps 500 --expiry "$(later)" --keep true | show
inv2 keeper "$VAULT" execute --executor "$KEEPER" --order_id 0 --fill_amount $((2*U)) --via "\"$XLM\"" | show
echo "order 0: $(inv dev "$VAULT" get_order --order_id 0 | last)"

step "6) BUY BTC DIRECTLY (USDC -> BTC): 2 USDC"
inv2 dev "$VAULT" place_order --sell "$USDC" --buy "$BTC" --amount_in $((2*U)) --limit_price $((8000*U)) --min_fill $((2*U)) \
  --max_impact_bps 1000 --expiry "$(later)" --keep true | show
inv2 keeper "$VAULT" execute --executor "$KEEPER" --order_id 1 --fill_amount $((2*U)) | show
echo "order 1: $(inv dev "$VAULT" get_order --order_id 1 | last)"

step "7) NO BUFFER: ALL of the BTC in the vault must be available for an order"
BAL=$(inv dev "$VAULT" balance --token "$BTC" | num)
ORD=$(inv dev "$VAULT" orderable_balance --token "$BTC" | num)
echo "BTC balance: $BAL   orderable: $ORD   (should be equal)"
# Limit: at most 0.001 BTC per USDC (1 BTC = at least 1,000 USDC)
inv2 dev "$VAULT" place_order --sell "$BTC" --buy "$USDC" --amount_in "$BAL" --limit_price 10000 --min_fill "$BAL" \
  --max_impact_bps 1000 --expiry "$(later)" --keep true | show
echo "free BTC while the order is open (should be 0, all of it is in the order): $(inv dev "$VAULT" free_balance --token "$BTC" | num)"
inv2 keeper "$VAULT" execute --executor "$KEEPER" --order_id 2 --fill_amount "$BAL" --via "\"$XLM\"" | show
echo "order 2: $(inv dev "$VAULT" get_order --order_id 2 | last)"
echo "BTC left (should be 0): $(inv dev "$VAULT" balance --token "$BTC" | num)"

step "8) TOKEN NOT ALLOWED: an order to buy EURC with USDC must be REJECTED (Error(Contract, #27))"
inv dev "$VAULT" place_order --sell "$USDC" --buy "$EURC" --amount_in $((1*U)) --limit_price $((5*U)) --min_fill $((1*U)) \
  --max_impact_bps 300 --expiry "$(later)" --keep true | grep -oE "Error\(Contract, #[0-9]+\)" | head -1
echo "Adding EURC to the list (guardian = dev)"
inv2 dev "$FACTORY" set_allowed --token "$EURC" --allow true | show
echo "it should be accepted now (order id 3):"
inv2 dev "$VAULT" place_order --sell "$USDC" --buy "$EURC" --amount_in $((1*U)) --limit_price $((5*U)) --min_fill $((1*U)) \
  --max_impact_bps 300 --expiry "$(later)" --keep true | show
inv2 dev "$VAULT" cancel_order --order_id 3 | show

step "9) BUY, THEN SELL: the reverse order's minimum fill should be 1/20 of its amount"
inv2 dev "$VAULT" place_order_then --sell "$USDC" --buy "$XLM" --amount_in $((2*U)) --limit_price 3000000 --min_fill $((1*U)) \
  --max_impact_bps 300 --expiry "$(later)" --then_limit $((3*U)) --then_impact_bps 300 --then_duration 86400 | show
inv2 keeper "$VAULT" execute --executor "$KEEPER" --order_id 4 --fill_amount $((2*U)) | show
echo "reverse order 5: $(inv dev "$VAULT" get_order --order_id 5 | last)"
inv2 dev "$VAULT" cancel_order --order_id 5 | show

step "10) Withdraw everything"
for T in "$USDC" "$XLM"; do inv2 dev "$VAULT" withdraw --token "$T" --amount $ALL | show; done
echo "positions (all should be 0): $(inv dev "$VAULT" positions | last)"

echo "===== DONE ====="
} 2>&1 | tee testnet/trial-v8.txt
