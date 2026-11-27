#!/usr/bin/env bash
# TESTNET ONLY. Fills (or tops up) the inventory of the borrower account that runs the other coins (USDC_STEP=off,
# targets.json), from the development machine whose stellar CLI keystore holds "iora-issuer":
#   for each of Iora's coins in targets.json: supplyUsd (the lender supply) + MARGIN, and for the collateral coin also
#   collateral.targetUsd, all at the oracle price, minted by paying them from the issuer. Only what is missing is sent.
# The issuer's key never goes to the server. XLM comes from friendbot (10,000 XLM) when the account is created.
# The account must exist and have its trustlines first (node borrower.js --setup on the server).
# Usage: bash scripts/blend-borrower/fund-multi.sh G...ACCOUNT [MARGIN_PCT=10]
cd "$(dirname "$0")/../.." || exit 1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
N="--network testnet"
ACC=$1; MARGIN=${2:-10}
[[ "$ACC" =~ ^G[A-Z2-7]{55}$ ]] || { echo "usage: $0 G...ACCOUNT [MARGIN_PCT]"; exit 1; }
source <(tr -d '\r' < testnet/blend-pool.env) || exit 1
source <(tr -d '\r' < testnet/iora-coins.env) || exit 1
clean() { sed -E 's/S[A-Z2-7]{55}/S***/g'; }
q() { stellar contract invoke --source dev $N --send no --id "$1" -- "${@:2}" 2>/dev/null | tail -1 | tr -d '"'; }
num() { echo "$1" | grep -oE '^-?[0-9]+' || echo 0; }
# name usd: for every coin with an issuer in targets.json
python3 - scripts/blend-borrower/targets.json "$MARGIN" > /tmp/fund-multi.txt <<'PY'
import json, sys
t = json.load(open(sys.argv[1])); m = 1 + float(sys.argv[2]) / 100
col = t.get("collateral") or {}
for k, c in t["coins"].items():
    if not c.get("issuer"): continue
    usd = c.get("supplyUsd", 0) * m + (col.get("targetUsd", 0) * m if col.get("coin") == k else 0)
    print(k, c["code"], c["token"], round(usd, 2))
PY
echo "account $ACC (margin $MARGIN%)"
while read -r k code token usd; do
  P=$(q "$ORACLE" lastprice --asset "{\"Stellar\":\"$token\"}" | grep -oE 'price:[0-9]+' | cut -d: -f2)
  [ -n "$P" ] || { echo "  $k: no oracle price, skipped"; continue; }
  want=$(python3 -c "print(int($usd * 1e7 * 1e7 // $P))"); have=$(num "$(q "$token" balance --id "$ACC")")
  if [ "$have" -lt "$want" ]; then
    echo "  $k: holds $(python3 -c "print($have/1e7)"), wants $(python3 -c "print($want/1e7)") (~$usd USD): mint $(python3 -c "print(($want-$have)/1e7)")"
    out=$(stellar tx new payment --source iora-issuer --destination "$ACC" --asset "$code:$ISSUER" --amount $((want - have)) $N 2>&1 | clean)
    echo "$out" | grep -qi error && echo "    ERROR $(echo "$out" | grep -i error | head -1 | cut -c1-200)" || \
      echo "    tx $(echo "$out" | grep -oE 'Signing transaction: [0-9a-f]{64}' | cut -d' ' -f3)"
  else echo "  $k: holds $(python3 -c "print($have/1e7)") (enough)"; fi
done < /tmp/fund-multi.txt
