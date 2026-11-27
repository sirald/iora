#!/usr/bin/env bash
# TESTNET ONLY. Winds down Iora's retired own coins (testnet/iora-coins.retired.env): takes iora-lp's liquidity
# out of the Soroswap USDC/COIN pools (remove_liquidity, back to iora-lp) and burns the coins that come back by
# paying them to their issuer (a payment to the issuer of a classic asset destroys it). The USDC stays in iora-lp.
# Safe to run again: a pool where iora-lp has no LP tokens left and a zero coin balance are skipped.
# Signs with the stellar CLI identity "iora-lp" (keys only in the keystore).
# Usage: bash scripts/retire-iora-coins.sh
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
N="--network testnet"
source <(tr -d '\r' < testnet/blend-pool.env) || exit 1
source <(tr -d '\r' < testnet/iora-coins.retired.env) || exit 1
ROUTER=$(grep '^ROUTER=' testnet/addr.env | cut -d= -f2 | tr -d '\r')
USDC=$CIRCLE_USDC
clean() { sed -E 's/S[A-Z2-7]{55}/S***/g'; }
q() { stellar contract invoke --source dev $N --send no --id "$1" -- "${@:2}" 2>/dev/null | tail -1 | tr -d '"'; }
num() { echo "$1" | grep -oE '^-?[0-9]+' || echo 0; }
run() { local who=$1; shift; local out; out=$(stellar contract invoke --source "$who" $N --id "$1" -- "${@:2}" 2>&1 | clean)
  if echo "$out" | grep -q "error"; then echo "    ERROR $(echo "$out" | grep error | head -1 | cut -c1-200)"; return 1; fi
  echo "    tx $(echo "$out" | grep -oE 'Signing transaction: [0-9a-f]{64}' | cut -d' ' -f3)"; }
classic() { local out; out=$(stellar tx new "$@" $N 2>&1 | clean)
  if echo "$out" | grep -qi "error"; then echo "    ERROR $(echo "$out" | grep -i error | head -1 | cut -c1-200)"; return 1; fi
  echo "    tx $(echo "$out" | grep -oE 'Signing transaction: [0-9a-f]{64}' | cut -d' ' -f3)"; }
fmt() { python3 -c "print($1/1e7)"; }
echo "===== $(date -u +%FT%TZ) retire Iora's own coins; lp $LP"
echo "lp USDC before: $(fmt "$(num "$(q "$USDC" balance --id "$LP")")")"
for s in BTC ETH SOL EURC; do
  pv=${s}_PAIR; pair=${!pv}; tok=${!s}
  lp=$(num "$(q "$pair" balance --id "$LP")"); tot=$(num "$(q "$pair" total_supply)")
  echo "== $s pair $pair: iora-lp holds $lp of $tot LP tokens, reserves $(q "$pair" get_reserves)"
  if [ "$lp" -gt 0 ]; then
    run iora-lp "$ROUTER" remove_liquidity --token_a "$USDC" --token_b "$tok" --liquidity "$lp" \
      --amount_a_min 0 --amount_b_min 0 --to "$LP" --deadline $(( $(date +%s) + 600 ))
  fi
  b=$(num "$(q "$tok" balance --id "$LP")")
  if [ "$b" -gt 0 ]; then echo "  burn $(fmt "$b") $s (payment to issuer)"; classic payment --source iora-lp --destination "$ISSUER" --asset "$s:$ISSUER" --amount "$b"; fi
  echo "  after: pool reserves $(q "$pair" get_reserves), lp $s $(q "$tok" balance --id "$LP")"
done
echo "lp USDC after: $(fmt "$(num "$(q "$USDC" balance --id "$LP")")")  XLM $(fmt "$(num "$(q "$XLM" balance --id "$LP")")")"
