#!/usr/bin/env bash
# Shows what a wallet holds in its Iora vault and in the wallet itself. READ-ONLY: it sends no transactions.
# Usage: bash scripts/inspect-vault.sh G...WALLET_ADDRESS      Output: testnet/inspect-vault.txt
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
N="--network testnet"
source testnet/addr.env
source testnet/factory.env
[ -f testnet/nesiller.env ] && source testnet/nesiller.env
[ -f testnet/pairs.env ] && source testnet/pairs.env
WHO="$1"
[[ "$WHO" =~ ^G[A-Z2-7]{55}$ ]] || { echo "Usage: bash scripts/inspect-vault.sh G...WALLET_ADDRESS"; exit 1; }
q() { stellar contract invoke --source dev $N --id "$1" -- "${@:2}" 2>&1 | grep -v "^ℹ\|^⚠\|^📔\|Simulat\|^$" | tail -1; }
u() { python3 -c "import sys; v=sys.argv[1].strip('\"'); print('%.7f' % (int(v)/1e7) if v.lstrip('-').isdigit() else v[:80])" "$1"; }
declare -A SYM=( ["$USDC"]=USDC ["$XLM"]=XLM )
for P in $(echo "$PAIRS" | tr ',' ' '); do SYM["${P##*:}"]="${P%%:*}"; done
{
echo "===== $(date) ====="
echo "wallet: $WHO"
PX=$(q "$ROUTER" router_get_amounts_out --amount_in 10000000 --path "[\"$XLM\",\"$USDC\"]" | tr -d '[]"' | awk -F, '{print $NF}')
echo "price: 1 XLM = $(u "$PX") USDC"
echo
echo "--- In the wallet"
for T in "${!SYM[@]}"; do echo "${SYM[$T]}: $(u "$(q "$T" balance --id "$WHO")")"; done
# Factories: the current one plus earlier single-vault generations (buy and sell address are the same)
FACS="$FACTORY"
for G in $(echo "$GENERATIONS" | tr ',' ' '); do [ "${G%%:*}" = "${G##*:}" ] && FACS="$FACS ${G%%:*}"; done
for F in $FACS; do
  V=$(q "$F" vault_of --owner "$WHO" | tr -d '"')
  echo
  echo "--- Factory $F"
  if [[ ! "$V" =~ ^C[A-Z2-7]{55}$ ]]; then echo "no vault"; continue; fi
  echo "vault: $V   version: $(q "$V" version | grep -E '^[0-9]+$' || echo 7)   orders: $(q "$V" order_count)"
  q "$V" positions | python3 -c "
import sys,json
sym=dict(x.split('=') for x in sys.argv[1].split(',')); px=int(sys.argv[2] or 0)/1e7
tot=0
for p in json.load(sys.stdin):
    s=sym.get(p['token'],p['token'][:6]); b=int(p['balance'])/1e7
    if b==0 and int(p['reserved'])==0: continue
    usd=b if s=='USDC' else b*px if s=='XLM' else None
    if usd: tot+=usd
    print('%-5s balance %.7f   in orders %.7f   free %.7f   %s%s' % (s,b,int(p['reserved'])/1e7,int(p['free'])/1e7,'on Blend' if p['pooled'] else 'idle in the vault', ('   ~ %.2f USDC' % usd) if usd is not None else ''))
print('USDC + XLM total value: ~ %.2f USDC' % tot)
" "$(for T in "${!SYM[@]}"; do printf "%s=%s," "$T" "${SYM[$T]}"; done | sed 's/,$//')" "$PX" 2>&1 | tail -12
done
echo "===== DONE ====="
} 2>&1 | tee testnet/inspect-vault.txt
