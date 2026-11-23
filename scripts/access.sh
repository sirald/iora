#!/usr/bin/env bash
# Manages who can enter the testnet app. The list lives in access.env on this machine
# (never committed) and goes to Vercel as secret environment variables on every publish.
#
#   bash scripts/access.sh new               -> creates a random invite code and adds it
#   bash scripts/access.sh code BETA2026     -> adds a specific invite code
#   bash scripts/access.sh wallet GABC...    -> adds a wallet address to the allowed list
#   bash scripts/access.sh remove CODE|GABC  -> removes a code or a wallet
#   bash scripts/access.sh list              -> shows the current codes and wallets
#   bash scripts/access.sh reset             -> invalidates every access ticket issued so far
#                                               (owners of removed codes or wallets are locked out at once)
# After add, remove or reset the site is republished (a change only takes effect after a publish).
cd "$(dirname "$0")/.." || exit 1
F=access.env
[ -f "$F" ] || printf 'IORA_ACCESS_CODES=\nIORA_ALLOWED_WALLETS=\nIORA_ACCESS_SECRET=%s\n' "$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)" > "$F"

get() { grep -E "^$1=" "$F" | head -1 | cut -d= -f2- | tr -d '\r'; }
put() { local k=$1 v=$2; grep -vE "^$k=" "$F" > "$F.tmp"; echo "$k=$v" >> "$F.tmp"; mv "$F.tmp" "$F"; }
addto() { local k=$1 x=$2 cur; cur=$(get "$k"); if echo ",$cur," | grep -qi ",$x,"; then echo "Already on the list: $x"; return 1; fi; put "$k" "${cur:+$cur,}$x"; }
delfrom() { local k=$1 x=$2 cur new; cur=$(get "$k"); new=$(echo "$cur" | tr ',' '\n' | grep -viFx "$x" | paste -sd, -); [ "$new" = "$cur" ] && return 1; put "$k" "$new"; }

case "$1" in
  new)
    C="IORA-$(head -c 64 /dev/urandom | base64 | tr -dc 'A-HJ-NP-Z2-9' | head -c 6)"
    addto IORA_ACCESS_CODES "$C" && echo "New invite code: $C" ;;
  code)
    [ -z "$2" ] && { echo "Usage: bash scripts/access.sh code YOURCODE"; exit 1; }
    echo "$2" | grep -qE '^[A-Za-z0-9_-]{4,64}$' || { echo "A code must be 4-64 characters (letters, digits, - or _)."; exit 1; }
    addto IORA_ACCESS_CODES "$2" && echo "Invite code added: $2" ;;
  wallet)
    A=$(echo "$2" | tr 'a-z' 'A-Z')
    echo "$A" | grep -qE '^G[A-Z2-7]{55}$' || { echo "Not a valid Stellar address (56 characters starting with G)."; exit 1; }
    addto IORA_ALLOWED_WALLETS "$A" && echo "Wallet added: ${A:0:6}...${A: -4}" ;;
  remove)
    [ -z "$2" ] && { echo "Usage: bash scripts/access.sh remove CODE_or_ADDRESS"; exit 1; }
    if delfrom IORA_ACCESS_CODES "$2" || delfrom IORA_ALLOWED_WALLETS "$(echo "$2" | tr 'a-z' 'A-Z')"; then echo "Removed: $2"; else echo "Not on the list: $2"; exit 1; fi ;;
  reset)
    put IORA_ACCESS_SECRET "$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)"
    echo "Access secret renewed: everyone has to enter a code or connect an allowed wallet again." ;;
  list|"")
    echo "Invite codes:"; get IORA_ACCESS_CODES | tr ',' '\n' | sed '/^$/d; s/^/  /'
    echo "Allowed wallets:"; get IORA_ALLOWED_WALLETS | tr ',' '\n' | sed '/^$/d; s/^/  /'
    exit 0 ;;
  *) sed -n 2,12p "$0"; exit 1 ;;
esac || exit 1

echo "Republishing the site (the change takes effect after the publish)..."
bash scripts/deploy-web.sh
