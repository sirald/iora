#!/usr/bin/env bash
# Beta sign-ups. The form's function (web/api/beta.js) keeps each sign-up in a PRIVATE Vercel Blob store, one file
# per wallet, and sends it to Telegram. This script creates that store and reads it.
#
#   bash scripts/beta.sh setup    -> creates the private store and connects it to the Vercel project (once),
#                                    then publish the site: bash scripts/deploy-web.sh
#   bash scripts/beta.sh count    -> how many wallets have signed up
#   bash scripts/beta.sh list     -> every sign-up: date, wallet, X handle
#
# Free plan: 1 GB and 2,000 writes/lists a month; a sign-up uses 2. Over the quota the store pauses (no bill) and
# sign-ups keep arriving on Telegram only.
cd "$(dirname "$0")/.." || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
V="npx --yes vercel@latest"
STORE=iora-beta

$V whoami > /dev/null 2>&1 || { echo "Vercel login needed: run  bash scripts/deploy-web.sh  once, then try again."; exit 1; }
# A small linked folder of its own, so nothing here touches the published files.
D="$HOME/.cache/iora-beta"; mkdir -p "$D" && cd "$D" || exit 1
if $V project inspect iora > /dev/null 2>&1; then PROJ=iora; else PROJ=berthly; fi
$V link --yes --project "$PROJ" > /dev/null 2>&1 || { echo "Could not link the Vercel project $PROJ"; exit 1; }

names() { # pathnames of every sign-up file
  local out next=""
  while :; do
    out=$($V blob list --prefix beta/ --limit 1000 --json ${next:+--next "$next"} 2>/dev/null) || { echo "ERROR"; return 1; }
    echo "$out" | grep -oE '"pathname" *: *"beta/[^"]+"' | sed -E 's/.*"(beta\/[^"]+)"/\1/'
    next=$(echo "$out" | grep -oE '"cursor" *: *"[^"]+"' | head -1 | sed -E 's/.*: *"([^"]+)"/\1/')
    echo "$out" | grep -qE '"hasMore" *: *true' || break
    [ -z "$next" ] && break
  done
}

case "$1" in
  setup)
    if $V blob list-stores --json 2>/dev/null | grep -q "\"$STORE\""; then
      echo "The store \"$STORE\" is already connected to $PROJ."
    else
      $V blob create-store "$STORE" --access private --yes || { echo "The store could not be created."; exit 1; }
      echo "Store \"$STORE\" created (private) and connected to $PROJ."
    fi
    echo "Now publish the site so the form starts saving:  bash scripts/deploy-web.sh" ;;
  count)
    L=$(names) || { echo "Could not read the store. Has it been created?  bash scripts/beta.sh setup"; exit 1; }
    echo "Beta sign-ups: $(echo "$L" | sed '/^$/d' | wc -l | tr -d ' ') wallets" ;;
  list)
    L=$(names) || { echo "Could not read the store. Has it been created?  bash scripts/beta.sh setup"; exit 1; }
    N=0
    for P in $L; do
      J=$($V blob get "$P" --access private 2>/dev/null)
      f() { echo "$J" | grep -oE "\"$1\" *: *\"[^\"]*\"" | head -1 | sed -E 's/.*: *"(.*)"/\1/'; }
      X=$(f x); echo "$(f at | cut -c1-16)  $(f wallet)  ${X:+@$X}$(f contact)"
      N=$((N + 1))
    done
    echo "Total: $N wallets" ;;
  *)
    sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
