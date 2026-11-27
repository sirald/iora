#!/usr/bin/env bash
# TESTNET ONLY, read-only. Market view of Iora's own Blend pool (testnet/blend-pool.env): for every reserve the
# amount supplied and borrowed, utilisation, borrow APR and supply APR (Blend v2 rate model with the current
# ir_mod; supply APR = borrow APR x utilisation x (1 - backstop take rate)), plus the oracle price.
# Extra arguments: G... accounts whose Circle USDC and XLM balances are shown (for example the site's faucet).
# Usage: bash scripts/blend-market-check.sh [G... ...]
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
N="--network testnet"
source <(tr -d '\r' < testnet/blend-pool.env) || exit 1
q() { stellar contract invoke --source dev $N --send no --id "$1" -- "${@:2}" 2>/dev/null | tail -1; }
CFG=$(q "$POOL" get_config)
echo "pool $POOL  $(date -u +%FT%TZ)  $(echo "$CFG" | python3 -c 'import json,sys; c=json.load(sys.stdin); print("status", c["status"], " backstop take", c["bstop_rate"]/1e7)')"
printf '%-5s %14s %14s %7s %9s %9s %8s %10s\n' coin supplied borrowed util borrowAPR supplyAPR ir_mod price
for a in $(echo "$(q "$POOL" get_reserve_list)" | tr -d '[]" ' | tr ',' ' '); do
  R=$(q "$POOL" get_reserve --asset "$a")
  P=$(q "$ORACLE" lastprice --asset "{\"Stellar\":\"$a\"}")
  S=$(q "$ORACLE" symbol --token "$a" | tr -d '"')
  python3 - "$R" "$P" "$S" "$CFG" <<'PY'
import json, sys
r = json.loads(sys.argv[1]); c = r["config"]; d = r["data"]; sym = sys.argv[3]; cfg = json.loads(sys.argv[4])
try: price = int(json.loads(sys.argv[2])["price"]) / 1e7
except Exception: price = float("nan")
sc = 10 ** c["decimals"]
sup = int(d["b_supply"]) * int(d["b_rate"]) / 1e12 / sc
bor = int(d["d_supply"]) * int(d["d_rate"]) / 1e12 / sc
u = bor / sup if sup > 0 else 0.0
t = c["util"] / 1e7; irm = int(d["ir_mod"]) / 1e7
rb, r1, r2, r3 = (c[k] / 1e7 for k in ("r_base", "r_one", "r_two", "r_three"))
if u <= t: base = rb + r1 * (u / t if t else 0)
elif u <= 0.95: base = rb + r1 + r2 * (u - t) / (0.95 - t)
else: base = None
borrow = base * irm if base is not None else (rb + r1 + r2) * irm + r3 * (u - 0.95) / 0.05
supply = borrow * u * (1 - cfg["bstop_rate"] / 1e7)
print(f"{sym:<5} {sup:14.4f} {bor:14.4f} {u*100:6.2f}% {borrow*100:8.3f}% {supply*100:8.3f}% {irm:8.4f} {price:10.4f}")
PY
done
for acct in "$@"; do
  echo "$acct: $(q "$CIRCLE_USDC" balance --id "$acct" | tr -d '"' | awk '{printf "%.4f USDC", $1/1e7}')  $(q "$XLM" balance --id "$acct" | tr -d '"' | awk '{printf "%.4f XLM", $1/1e7}')"
done
