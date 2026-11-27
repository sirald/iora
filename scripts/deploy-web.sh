#!/usr/bin/env bash
# Publishes the landing page, the app and the beta form function to Vercel.
# Beta sign-ups go to the Telegram bot in keeper/.env; the token is stored in Vercel as a secret environment variable.
cd "$(dirname "$0")/.." || exit 1
ROOT=$(pwd)
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
V="npx --yes vercel@latest"

bash scripts/build-web.sh --build-only || exit 1

rm -rf /tmp/iora && cp -r web/dist /tmp/iora && cp -r web/api /tmp/iora/api && cp web/vercel.json /tmp/iora/ 2>/dev/null
# The beta and faucet functions keep their records in a private Vercel Blob store; the faucet also signs a payment
# with the Stellar SDK. Vercel installs these dependencies for the functions.
printf '{\n  "private": true,\n  "dependencies": { "@vercel/blob": "^2.9.0", "@stellar/stellar-sdk": "^17.4.0" }\n}\n' > /tmp/iora/package.json

if ! $V whoami > /dev/null 2>&1; then
  echo
  echo "Vercel login: open the link below in a browser and approve."
  echo
  $V login || { echo "Vercel login failed"; exit 1; }
fi

cd /tmp/iora || exit 1
# Use the Vercel project named "iora" if it exists, otherwise the older "berthly" project
# (so an empty new project is never created by accident; the domain and settings live in the existing one).
if $V project inspect iora > /dev/null 2>&1; then PROJ=iora; else PROJ=berthly; fi
echo "Vercel project: $PROJ"
$V link --yes --project "$PROJ" > /dev/null 2>&1

# Pass the Telegram settings to Vercel as secret environment variables.
TG_TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ROOT/keeper/.env" 2>/dev/null | cut -d= -f2-)
TG_CHAT=$(grep -E '^TELEGRAM_CHAT_ID=' "$ROOT/keeper/.env" 2>/dev/null | cut -d= -f2-)
if [ -n "$TG_TOKEN" ] && [ -n "$TG_CHAT" ]; then
  for KEY in TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID; do
    [ "$KEY" = TELEGRAM_BOT_TOKEN ] && VAL="$TG_TOKEN" || VAL="$TG_CHAT"
    $V env rm "$KEY" production --yes > /dev/null 2>&1
    printf "%s" "$VAL" | $V env add "$KEY" production > /dev/null 2>&1 \
      && echo "$KEY set" || echo "WARNING: $KEY could not be set (the beta form may not work)"
  done
else
  echo "WARNING: no Telegram settings in keeper/.env; the beta form will not work (scripts/setup-telegram.sh)."
fi

# Testnet access list (invite codes, allowed wallets) -> Vercel secret environment variables
[ -f "$ROOT/access.env" ] || (cd "$ROOT" && bash scripts/access.sh list > /dev/null)
for KEY in IORA_ACCESS_CODES IORA_ALLOWED_WALLETS IORA_ACCESS_SECRET; do
  VAL=$(grep -E "^$KEY=" "$ROOT/access.env" | head -1 | cut -d= -f2- | tr -d '\r')
  $V env rm "$KEY" production --yes > /dev/null 2>&1
  [ -n "$VAL" ] && { printf "%s" "$VAL" | $V env add "$KEY" production > /dev/null 2>&1 || echo "WARNING: $KEY could not be set"; }
done
echo "Testnet access list updated ($(grep -E '^IORA_ACCESS_CODES=' "$ROOT/access.env" | cut -d= -f2- | tr ',' '\n' | sed '/^$/d' | wc -l | tr -d ' ') codes, $(grep -E '^IORA_ALLOWED_WALLETS=' "$ROOT/access.env" | cut -d= -f2- | tr ',' '\n' | sed '/^$/d' | wc -l | tr -d ' ') wallets)."

echo "Publishing..."
# A failed publish must not look like a successful one: stop and show what Vercel said.
if ! OUT=$($V deploy --prod --yes 2>&1); then
  echo "$OUT" | tail -15
  echo
  echo "PUBLISH FAILED: the site was not updated. Run the same command again; if it fails again, the lines above say why."
  exit 1
fi
echo "$OUT" | grep -E "Production|Aliased|Error" | tail -4
URL="https://iorafi.com"

echo
echo "Landing page: $URL"
echo "App:          $URL/app.html"
