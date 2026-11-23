#!/usr/bin/env bash
# Checks the keeper's batch filler on the LIVE testnet factory: opens small orders that can fill right away in two
# vaults (the dev wallet's and the keeper wallet's), so the running keeper finds several fills at the same moment
# and should send them in one transaction. The keeper must be STOPPED while the orders are opened (otherwise it
# fills each one as it appears):
#   bash scripts/server.sh stop
#   bash scripts/trial-keeper-batch.sh
#   bash scripts/server.sh push
#   bash scripts/server.sh logs        (look for "BATCH")
# Each run uses about 0.6 USDC (dev) and 6 XLM (keeper); what the orders buy stays in the two vaults.
# Usage: bash scripts/trial-keeper-batch.sh
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
N="--network testnet"
source testnet/addr.env
source testnet/factory.env
PER=3   # orders per vault

inv() { stellar contract invoke --source "$1" $N --id "$2" -- "${@:3}" 2>&1; }
inv2() { local o; o=$(inv "$@"); if echo "$o" | grep -q "error:" && ! echo "$o" | grep -q "Error(Contract"; then sleep 6; o=$(inv "$@"); fi; echo "$o"; }
errs() { grep -E "error|Error\(" | cut -c1-220 | head -2; }
later() { echo $(( $(date +%s) + 3600 )); }

open_orders() { # who, sell token, buy token, amount per order, limit price
  local WHO=$1 SELL=$2 BUY=$3 AMT=$4 LIMIT=$5 ADDR VAULT i
  ADDR=$(stellar keys address "$WHO")
  VAULT=$(inv "$WHO" "$FACTORY" vault_of --owner "$ADDR" | tail -1 | tr -d '"')
  if ! echo "$VAULT" | grep -qE '^C[A-Z0-9]{55}$'; then
    inv2 "$WHO" "$FACTORY" create_vault --owner "$ADDR" | errs
    VAULT=$(inv "$WHO" "$FACTORY" vault_of --owner "$ADDR" | tail -1 | tr -d '"')
  fi
  echo "$WHO vault: $VAULT"
  inv2 "$WHO" "$VAULT" deposit --token "$SELL" --amount $(( PER * AMT + PER * AMT / 20 + 500000 )) | errs
  for i in $(seq 1 $PER); do
    inv2 "$WHO" "$VAULT" place_order --sell "$SELL" --buy "$BUY" --amount_in "$AMT" --limit_price "$LIMIT" --min_fill "$AMT" \
      --max_impact_bps 500 --expiry "$(later)" --keep true | errs
  done
  echo "$WHO: $(inv "$WHO" "$VAULT" order_count | tail -1) orders in total in this vault"
}

echo "===== $(date) ====="
# The two vaults are prepared one after the other, the orders of each are placed close together.
open_orders dev "$USDC" "$XLM" 2000000 3000000          # 0.2 USDC each, at most 0.30 USDC per XLM
open_orders keeper "$XLM" "$USDC" 20000000 200000000    # 2 XLM each, at most 20 XLM per USDC
echo "===== orders are open. Now start the keeper: bash scripts/server.sh push   then: bash scripts/server.sh logs ====="
