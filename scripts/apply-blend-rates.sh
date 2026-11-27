#!/usr/bin/env bash
# TESTNET ONLY. Applies the USDC and XLM rate settings queued by scripts/queue-blend-rates.sh (Blend's
# `set_reserve`), at the earliest one week after queueing (RATES_UNLOCK_AT_UTC in testnet/blend-pool.env).
# Before that the pool refuses (error 1203 InitNotUnlocked) and nothing is sent. Signs with the stellar CLI
# identity "dev" (anyone may call set_reserve once unlocked; dev is used for the fee).
# Usage: bash scripts/apply-blend-rates.sh
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
N="--network testnet"
source <(tr -d '\r' < testnet/blend-pool.env) || exit 1
clean() { sed -E 's/S[A-Z2-7]{55}/S***/g'; }
cfgof() { stellar contract invoke --source dev $N --send no --id "$POOL" -- get_reserve --asset "$1" 2>/dev/null | tail -1 |
  python3 -c 'import json,sys; c=json.load(sys.stdin)["config"]; print({k:c[k] for k in ("util","max_util","r_base","r_one","r_two","r_three","reactivity","c_factor","l_factor")})'; }
echo "USDC/XLM rates queued: ${RATES_QUEUED_AT_UTC:-?}  earliest apply: ${RATES_UNLOCK_AT_UTC:-?}  now: $(date -u +%FT%TZ)"
LIST="USDC:$CIRCLE_USDC XLM:$XLM"
# Iora's own coins (scripts/create-iora-coins.sh): new reserves, queued separately.
if [ -f testnet/iora-coins.env ]; then
  source <(tr -d '\r' < testnet/iora-coins.env)
  source scripts/blend-rates.sh
  echo "coin reserves ($COIN_SYMBOLS) queued: ${RESERVES_QUEUED_AT_UTC:-?}  earliest apply: ${RESERVES_UNLOCK_AT_UTC:-?}"
  for s in $COIN_SYMBOLS; do [ -n "${!s}" ] && LIST="$LIST $s:${!s}"; done
fi
RC=0
for pair in $LIST; do
  sym=${pair%%:*}; a=${pair#*:}
  sim=$(stellar contract invoke --source dev $N --send no --id "$POOL" -- set_reserve --asset "$a" 2>&1 | clean)
  if echo "$sim" | grep -q "#1203"; then echo "$sym: not unlocked yet (wait until the time above)"; RC=1; continue; fi
  # Nothing queued for this coin (for example applied on an earlier run): show what is in force.
  if echo "$sim" | grep -q "error"; then echo "$sym: nothing to apply ($(echo "$sim" | grep -oE 'Error\([A-Za-z]+, #[0-9]+\)' | head -1)); in force: $(cfgof "$a" 2>/dev/null || echo 'not a reserve')"; continue; fi
  out=$(stellar contract invoke --source dev $N --id "$POOL" -- set_reserve --asset "$a" 2>&1 | clean)
  if echo "$out" | grep -q "error"; then echo "$sym: FAILED: $(echo "$out" | grep error | head -1 | cut -c1-200)"; RC=1; continue; fi
  echo "$sym: applied, tx $(echo "$out" | grep -oE 'Signing transaction: [0-9a-f]{64}' | cut -d' ' -f3)"
  echo "  now: $(cfgof "$a")"
done
exit $RC
