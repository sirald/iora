#!/usr/bin/env bash
# Checks crossing on the LIVE testnet factory (version 10 vaults): opens two opposite orders in two vaults (the dev
# wallet buys XLM with 1 USDC, the keeper wallet sells 20 XLM for USDC), both with generous limits, so the running
# keeper should fill them against each other in one transaction instead of going to the pool.
# The keeper must be STOPPED while the orders are opened (otherwise it fills the first one in the pool as soon as
# it appears):
#   bash scripts/server.sh stop
#   bash scripts/trial-cross.sh
#   bash scripts/server.sh push keeper
#   bash scripts/server.sh logs        (look for "CROSSED")
# What is left of the larger order afterwards is filled in the pool as usual.
# Each run uses about 1 USDC (dev) and 20 XLM (keeper); what the orders buy stays in the two vaults.
# Usage: bash scripts/trial-cross.sh
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
N="--network testnet"
source testnet/addr.env
source testnet/factory.env
if [ "${VAULT_V:-0}" -lt 10 ]; then echo "The live factory is version ${VAULT_V:-?}; crossing needs version 10 (bash scripts/deploy-v10.sh)."; exit 1; fi

inv() { stellar contract invoke --source "$1" $N --id "$2" -- "${@:3}" 2>&1; }
inv2() { local o; o=$(inv "$@"); if echo "$o" | grep -q "error:" && ! echo "$o" | grep -q "Error(Contract"; then sleep 6; o=$(inv "$@"); fi; echo "$o"; }
errs() { grep -E "error|Error\(" | cut -c1-220 | head -2; }
later() { echo $(( $(date +%s) + 3600 )); }

open_order() { # who, sell token, buy token, amount, limit price, minimum fill
  local WHO=$1 SELL=$2 BUY=$3 AMT=$4 LIMIT=$5 MIN=$6 ADDR VAULT
  ADDR=$(stellar keys address "$WHO")
  VAULT=$(inv "$WHO" "$FACTORY" vault_of --owner "$ADDR" | tail -1 | tr -d '"')
  if ! echo "$VAULT" | grep -qE '^C[A-Z0-9]{55}$'; then
    inv2 "$WHO" "$FACTORY" create_vault --owner "$ADDR" | errs
    VAULT=$(inv "$WHO" "$FACTORY" vault_of --owner "$ADDR" | tail -1 | tr -d '"')
  fi
  echo "$WHO vault: $VAULT (version $(inv "$WHO" "$VAULT" version | tail -1))"
  inv2 "$WHO" "$VAULT" deposit --token "$SELL" --amount $(( AMT + AMT / 20 + 500000 )) | errs
  inv2 "$WHO" "$VAULT" place_order --sell "$SELL" --buy "$BUY" --amount_in "$AMT" --limit_price "$LIMIT" --min_fill "$MIN" \
    --max_impact_bps 500 --expiry "$(later)" --keep true | errs
  echo "$WHO: $(inv "$WHO" "$VAULT" order_count | tail -1) order(s) in total in this vault"
}

echo "===== $(date) ====="
open_order dev "$USDC" "$XLM" 10000000 3000000 10000000          # buys XLM with 1 USDC, at most 0.30 USDC per XLM, in one piece
open_order keeper "$XLM" "$USDC" 200000000 200000000 20000000    # sells 20 XLM, at most 20 XLM per USDC, in pieces of 2 XLM or more
echo "===== orders are open. Now start the keeper: bash scripts/server.sh push keeper   then: bash scripts/server.sh logs ====="
