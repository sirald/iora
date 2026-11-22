#!/usr/bin/env bash
# Sets up Telegram notifications. The bot token is written only to keeper/.env on this machine.
cd "$(dirname "$0")/.." || exit 1
ENVF="keeper/.env"

echo "Paste the Telegram bot token and press Enter (it is not shown on screen):"
read -rs TOKEN
echo
TOKEN=$(echo "$TOKEN" | tr -d '[:space:]')
if ! [[ "$TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]]; then
  echo "That does not look like a bot token (format: 123456789:ABC...). Try again."; exit 1
fi

ME=$(curl -fsS "https://api.telegram.org/bot$TOKEN/getMe") || { echo "The token is not valid, or Telegram could not be reached."; exit 1; }
BOT=$(echo "$ME" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['username'])")
echo "Bot found: @$BOT"
echo
echo "Now open a chat with @$BOT in Telegram and send it any message."
echo "Waiting for your message (up to 3 minutes)..."

CHAT=""
for i in $(seq 1 36); do
  CHAT=$(curl -fsS "https://api.telegram.org/bot$TOKEN/getUpdates" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ids = [u['message']['chat']['id'] for u in d.get('result', []) if 'message' in u]
print(ids[-1] if ids else '')
")
  [ -n "$CHAT" ] && break
  sleep 5
done
[ -z "$CHAT" ] && { echo "No message arrived. Message the bot, then run this script again."; exit 1; }

# Keep the other settings and replace the Telegram lines.
touch "$ENVF"
grep -vE '^TELEGRAM_(BOT_TOKEN|CHAT_ID)=' "$ENVF" > "$ENVF.tmp" 2>/dev/null
{ cat "$ENVF.tmp"; echo "TELEGRAM_BOT_TOKEN=$TOKEN"; echo "TELEGRAM_CHAT_ID=$CHAT"; } > "$ENVF"
rm -f "$ENVF.tmp"
chmod 600 "$ENVF"

curl -fsS -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \
  -d chat_id="$CHAT" -d text="[Iora] Notifications are set up. I will write here when an order fills, when something fails and when the balance runs low." > /dev/null \
  && echo "DONE: a test message was sent to Telegram. The settings were saved to keeper/.env." \
  || echo "The settings were saved, but the test message could not be sent."
