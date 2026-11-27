#!/usr/bin/env bash
# TESTNET ONLY. Queues the USDC and XLM rate settings of scripts/blend-rates.sh in Iora's own Blend pool
# (testnet/blend-pool.env POOL). An active Blend pool applies a reserve change only a week after it is queued:
# run scripts/apply-blend-rates.sh after RATES_UNLOCK_AT_UTC (written to testnet/blend-pool.env).
# Signs with the stellar CLI identity "dev" (the pool admin). A coin that already has a queued change is skipped
# (Blend refuses a second one; cancel_set_reserve removes it).
# Usage: bash scripts/queue-blend-rates.sh
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
N="--network testnet"
source testnet/blend-pool.env || exit 1
source scripts/blend-rates.sh
clean() { sed -E 's/S[A-Z2-7]{55}/S***/g'; }
save() { sed -i "/^$1=/d" testnet/blend-pool.env; echo "$1=$2" >> testnet/blend-pool.env; }
FIRST=""
for pair in "USDC:$CIRCLE_USDC:$CFG_USDC" "XLM:$XLM:$CFG_XLM"; do
  sym=${pair%%:*}; rest=${pair#*:}; a=${rest%%:*}; cfg=${rest#*:}
  out=$(stellar contract invoke --source dev $N --id "$POOL" -- queue_set_reserve --asset "$a" --metadata "$cfg" 2>&1 | clean)
  if echo "$out" | grep -q "error"; then echo "$sym: NOT queued: $(echo "$out" | grep error | head -1 | cut -c1-200)"; continue; fi
  now=$(date -u +%s); [ -z "$FIRST" ] && FIRST=$now
  echo "$sym: queued at $(date -u -d @$now +%FT%TZ), earliest apply $(date -u -d @$((now + 604800)) +%FT%TZ)  tx $(echo "$out" | grep -oE 'Signing transaction: [0-9a-f]{64}' | cut -d' ' -f3)"
done
if [ -n "$FIRST" ]; then
  save RATES_QUEUED_AT_UTC "$(date -u -d @$FIRST +%FT%TZ)"
  # +60 s: the unlock is measured from the ledger time of the queue transaction, a little after $FIRST.
  save RATES_UNLOCK_AT_UTC "$(date -u -d @$((FIRST + 604800 + 60)) +%FT%TZ)"
  grep RATES_ testnet/blend-pool.env
fi
