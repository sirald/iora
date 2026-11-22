#!/usr/bin/env bash
# Runs the keeper on a rented Linux server (Ubuntu), 24/7, as a systemd service.
#   bash scripts/server.sh setup     first time: installs Node, swap, firewall and the service; copies code and the key
#   bash scripts/server.sh push      copies the current code and settings and restarts the keeper
#   bash scripts/server.sh status    shows whether it is running and its last log lines
#   bash scripts/server.sh logs      follows the log live (Ctrl+C to leave; the keeper keeps running)
#   bash scripts/server.sh stop      stops the keeper
# The server address is read from server.env in the project root (not committed):
#   IORA_SERVER=root@1.2.3.4
# The keeper key never passes through the terminal output: it is piped from the Stellar CLI straight to a
# root-only file on the server. (The Discord bot is a separate project with its own server.sh.)
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

[ -f server.env ] && . ./server.env
HOST="${IORA_SERVER:-}"
[ -z "$HOST" ] && { echo "server.env is missing. Create it with one line: IORA_SERVER=root@<server ip>"; exit 1; }
SSH="ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 $HOST"
CMD="${1:-}"

copy_code() {
  # durum.json (keeper state) is sent only on setup so a later push never overwrites the server's state.
  local skip_state="$1" files=(keeper)
  for f in addr factory factory-sell eski-fabrikalar markets; do
    [ -f "testnet/$f.env" ] && files+=("testnet/$f.env")
  done
  local ex=(--exclude=node_modules --exclude=keeper.log)
  [ "$skip_state" = "1" ] && ex+=(--exclude=durum.json)
  tar czf - "${ex[@]}" "${files[@]}" | $SSH 'mkdir -p /opt/iora && tar xzf - -C /opt/iora --no-same-owner'
}

install_and_restart() {
  $SSH 'bash -s' <<'REMOTE'
set -e
cd /opt/iora/keeper && { npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev --no-audit --no-fund >/dev/null; }
chown -R iora:iora /opt/iora/keeper /opt/iora/testnet
[ -f /opt/iora/keeper/.env ] && chmod 600 /opt/iora/keeper/.env
systemctl restart iora-keeper
REMOTE
}

status() {
  $SSH 'printf "%-12s %s\n" iora-keeper "$(systemctl is-active iora-keeper 2>/dev/null)"
        journalctl -u iora-keeper -n 12 --no-pager -o cat 2>/dev/null | cut -c1-200
        echo "--- memory"; free -m | sed -n 2,3p'
}

case "$CMD" in
setup)
  # The same key must never run in two places: transactions would collide.
  if command -v flock > /dev/null; then
    exec 9> /tmp/iora-keeper.lock
    flock -n 9 || { echo "The keeper is still running on this computer. Stop it first (Ctrl+C in its window), then run this again."; exit 1; }
    exec 9>&-
  fi
  SECRET=""
  for c in "stellar keys secret keeper" "stellar keys show keeper"; do
    S=$($c 2>/dev/null | grep -oE 'S[A-Z2-7]{55}' | head -1 || true)
    [ -n "$S" ] && { SECRET="$S"; break; }
  done
  [ -z "$SECRET" ] && { echo "could not read the keeper secret key from the Stellar CLI"; exit 1; }

  echo "[1/4] Preparing the server (Node, swap, firewall, service)..."
  $SSH 'bash -s' <<'REMOTE'
set -e
export DEBIAN_FRONTEND=noninteractive
if ! swapon --show | grep -q .; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
apt-get update -qq
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
apt-get install -y -qq ufw unattended-upgrades >/dev/null
ufw allow OpenSSH >/dev/null && ufw --force enable >/dev/null
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' > /etc/ssh/sshd_config.d/10-iora.conf
systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
id iora >/dev/null 2>&1 || useradd --system --home /opt/iora --shell /usr/sbin/nologin iora
mkdir -p /opt/iora /etc/iora && chmod 750 /etc/iora && chown root:iora /etc/iora
unit() {
cat > /etc/systemd/system/$1.service <<UNIT
[Unit]
Description=$2
After=network-online.target
Wants=network-online.target

[Service]
User=iora
WorkingDirectory=$3
EnvironmentFile=$4
ExecStart=/usr/bin/node $5
Restart=always
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$3

[Install]
WantedBy=multi-user.target
UNIT
}
unit iora-keeper "Iora keeper"      /opt/iora/keeper      /etc/iora/keeper.env keeper.js
systemctl daemon-reload
systemctl enable -q iora-keeper
echo "node $(node -v)"
REMOTE

  echo "[2/4] Copying the code..."
  copy_code 0

  echo "[3/4] Copying the secrets (not shown)..."
  printf 'KEEPER_SECRET=%s\n' "$SECRET" | $SSH 'umask 027; cat > /etc/iora/keeper.env; chown root:iora /etc/iora/keeper.env; chmod 640 /etc/iora/keeper.env'
  unset SECRET S

  echo "[4/4] Installing dependencies and starting..."
  install_and_restart
  sleep 8
  status
  echo "===== DONE ====="
  echo "The keeper now runs on the server. Do not start it on this computer again (same key in two places collides)."
  ;;
push)
  echo "Copying the code..."
  copy_code 1
  install_and_restart
  sleep 8
  status
  echo "===== DONE ====="
  ;;
status) status ;;
logs)   $SSH 'journalctl -u iora-keeper -f -n 20 -o short-iso' ;;
stop)   $SSH 'systemctl stop iora-keeper; systemctl is-active iora-keeper || true' ;;
*)      sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
