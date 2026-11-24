#!/usr/bin/env bash
# Checks the other venues (Aquarius through the filler contract) on the LIVE testnet factory (version 13 vaults)
# WITHOUT trading: the dev wallet opens one small buy order whose limit is far below the market (1 USDC for XLM at
# no more than 0.01 USDC), so nothing fills it. The keeper on the server then SIMULATES filling it through the
# filler, once all on Aquarius and once split with Soroswap. "ROUTE WORKS" means the route ran end to end.
# Each run locks 1 USDC of the dev wallet in the dev vault (cancel the order in the app, or leave it).
# Usage: bash scripts/trial-venue.sh
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
N="--network testnet"
source testnet/addr.env
source testnet/factory.env
if [ "${VAULT_V:-0}" -lt 13 ]; then echo "The live factory is version ${VAULT_V:-?}; this needs version 13 (bash scripts/deploy-v13.sh)."; exit 1; fi

inv() { stellar contract invoke --source "$1" $N --id "$2" -- "${@:3}" 2>&1; }
inv2() { local o; o=$(inv "$@"); if echo "$o" | grep -q "error:" && ! echo "$o" | grep -q "Error(Contract"; then sleep 6; o=$(inv "$@"); fi; echo "$o"; }
errs() { grep -E "error|Error\(" | cut -c1-220 | head -2; }

echo "===== $(date) ====="
ADDR=$(stellar keys address dev)
VAULT=$(inv dev "$FACTORY" vault_of --owner "$ADDR" | tail -1 | tr -d '"')
if ! echo "$VAULT" | grep -qE '^C[A-Z0-9]{55}$'; then
  inv2 dev "$FACTORY" create_vault --owner "$ADDR" | errs
  VAULT=$(inv dev "$FACTORY" vault_of --owner "$ADDR" | tail -1 | tr -d '"')
fi
echo "dev vault: $VAULT (version $(inv dev "$VAULT" version | tail -1))"
# One trial order is enough: a later run uses the newest order of the dev vault instead of opening another.
COUNT=$(inv dev "$VAULT" order_count | tail -1 | tr -dc '0-9')
# The newest order that is still open and has something left (a filled or cancelled one cannot be simulated).
ID=""
if [ -z "$NEW" ]; then
  for (( i = ${COUNT:-0} - 1; i >= 0; i-- )); do
    O=$(inv dev "$VAULT" get_order --order_id "$i" | tail -1)
    AIN=$(echo "$O" | grep -oE '"amount_in":"?[0-9]+' | grep -oE '[0-9]+$')
    FIN=$(echo "$O" | grep -oE '"filled_in":"?[0-9]+' | grep -oE '[0-9]+$')
    if echo "$O" | grep -q '"status":"Open"' && [ -n "$AIN" ] && [ "${AIN:-0}" != "${FIN:-0}" ]; then ID=$i; break; fi
  done
fi
if [ -n "$ID" ]; then
  echo "using the open order #$ID (NEW=1 bash scripts/trial-venue.sh opens a fresh one)"
else
  inv2 dev "$VAULT" deposit --token "$USDC" --amount 11000000 | errs
  OUT=$(inv2 dev "$VAULT" place_order --sell "$USDC" --buy "$XLM" --amount_in 10000000 --limit_price 100000 --min_fill 10000000 \
    --max_impact_bps 500 --expiry "$(( $(date +%s) + 86400 ))" --keep true)
  echo "$OUT" | errs
  ID=$(echo "$OUT" | tail -1 | tr -dc '0-9')
  echo "order #$ID opened (it cannot fill: the limit is far below the market)"
fi
echo "===== simulating on the server ====="
bash scripts/server.sh venues "$VAULT" "$ID"
echo "===== DONE ====="
