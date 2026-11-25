#!/usr/bin/env bash
# Checks scheduled orders (DCA) on the LIVE testnet factory (version 11 vaults): the dev wallet opens a plan that
# buys XLM with 1 USDC every 60 seconds, 3 times, paying at most 0.30 USDC per XLM. The running keeper should fill
# the first part at once and the next two a minute apart; after the third the order closes as filled.
# The keeper must be running with the new settings first:
#   bash scripts/server.sh push keeper
#   bash scripts/trial-dca.sh
#   bash scripts/server.sh logs        (look for three "FILLED" lines of the same order, about a minute apart)
# Each run uses about 3 USDC of the dev wallet; the XLM it buys stays in the dev vault.
# Usage: bash scripts/trial-dca.sh
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
N="--network testnet"
source testnet/addr.env
source testnet/factory.env
if [ "${VAULT_V:-0}" -lt 11 ]; then echo "The live factory is version ${VAULT_V:-?}; DCA needs version 11 or later (bash scripts/deploy-v13.sh)."; exit 1; fi

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
inv2 dev "$VAULT" deposit --token "$USDC" --amount 35000000 | errs
OUT=$(inv2 dev "$VAULT" place_dca --sell "$USDC" --buy "$XLM" --part 10000000 --fills 3 --every 60 --limit_price 3000000 \
  --max_impact_bps 500 --band_bps 0 --expiry "$(( $(date +%s) + 3600 ))" --keep true)
echo "$OUT" | errs
ID=$(echo "$OUT" | tail -1 | tr -dc '0-9')
echo "plan opened: order #$ID"
echo "schedule: $(inv dev "$VAULT" get_schedule --order_id "$ID" | tail -1)"
echo "===== now watch the keeper: bash scripts/server.sh logs   (three FILLED lines for #$ID, about a minute apart) ====="
echo "to look again later:  stellar contract invoke --source dev $N --id $VAULT -- get_schedule --order_id $ID"
