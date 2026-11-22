#!/usr/bin/env bash
# Runs the keeper. The secret key is read from the Stellar CLI and never written anywhere.
#   bash keeper/run.sh            runs continuously (Ctrl+C to stop)
#   bash keeper/run.sh --once     scans once
cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

if [ ! -d node_modules/@stellar/stellar-sdk ]; then
  echo "Installing dependencies..."
  # Installs the versions in the lock file (@latest could break the keeper on an SDK update).
  { [ -f package-lock.json ] && npm ci --no-audit --no-fund > /dev/null 2>&1; } \
    || npm install --no-audit --no-fund > /dev/null 2>&1 \
    || { echo "npm install failed"; exit 1; }
fi

# Never start a second keeper with the same key (the lock is held until the keeper exits).
if command -v flock > /dev/null; then
  exec 9> /tmp/iora-keeper.lock
  flock -n 9 || { echo "The keeper is already running; a second one was not started."; exit 1; }
fi

SECRET=""
for c in "stellar keys secret keeper" "stellar keys show keeper"; do
  S=$($c 2>/dev/null | grep -oE 'S[A-Z2-7]{55}' | head -1)
  [ -n "$S" ] && { SECRET="$S"; break; }
done
[ -z "$SECRET" ] && { echo "could not read the keeper secret key"; exit 1; }

KEEPER_SECRET="$SECRET" exec node keeper.js "$@"
