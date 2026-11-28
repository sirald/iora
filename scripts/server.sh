#!/usr/bin/env bash
# Runs the keeper on a rented Linux server (Ubuntu), 24/7, as a systemd service.
#   bash scripts/server.sh setup     first time: installs Node, swap, firewall and the service; copies code and the key
#   bash scripts/server.sh push      copies the current code and settings and restarts the keeper, with a safety net:
#                                    the keeper's tests run on the server first (SKIP_TESTS=1 skips them), the running
#                                    code is backed up, and if the new keeper completes no scan within 180 s the
#                                    backup is restored and restarted by itself
#   bash scripts/server.sh test      runs the keeper's tests on the server against the current code; installs nothing
#   bash scripts/server.sh backup    packs the running keeper code into /opt/iora/backups (the newest 5 are kept)
#   bash scripts/server.sh rollback [file]   restores the newest backup (or the given one) and restarts the keeper
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

# The code and settings as a tar.gz on stdout. $1 = 1 leaves out status.json (keeper state): it is sent only on
# setup, so a later push never overwrites the server's state.
code_tar() {
  local skip_state="$1" files=(keeper)
  for f in addr factory factory-sell old-factories markets batch filler; do
    [ -f "testnet/$f.env" ] && files+=("testnet/$f.env")
  done
  local ex=(--exclude=node_modules --exclude=keeper.log --exclude=keeper.lock)
  [ "$skip_state" = "1" ] && ex+=(--exclude=status.json)
  tar czf - "${ex[@]}" "${files[@]}"
}

copy_code() {
  code_tar "$1" | $SSH 'mkdir -p /opt/iora && tar xzf - -C /opt/iora --no-same-owner'
}

# Copies the code (as a push would) to a new staging folder on the server and runs the keeper's tests there with the
# server's Node. Sets STAGE to that folder. Returns non-zero, and removes the folder, when the copy or a test fails.
# SKIP_TESTS=1 only copies.
stage_and_test() {
  STAGE=$(code_tar 1 | $SSH 'D=$(mktemp -d /tmp/iora-push.XXXXXX) && tar xzf - -C "$D" --no-same-owner && echo "$D"')
  [ -n "$STAGE" ] || { echo "Copy to the server failed."; return 1; }
  if [ "${SKIP_TESTS:-0}" = "1" ]; then echo "      tests skipped (SKIP_TESTS=1)"; return 0; fi
  echo "      running the keeper's tests there (the server's Node)..."
  if ! $SSH "STAGE='$STAGE' bash -s" <<'REMOTE'
set -e
cd "$STAGE/keeper"
cp -a /opt/iora/keeper/node_modules . 2>/dev/null || true
cmp -s package-lock.json /opt/iora/keeper/package-lock.json || npm ci --no-audit --no-fund >/dev/null 2>&1
chown -R iora:iora "$STAGE"
R=$(runuser -u iora -- env HOME=/tmp npm test 2>&1 | grep -E "^# (pass|fail) " | tr "\n" " ")
echo "      node $(node -v): ${R:-no test summary}"
echo "$R" | grep -q "# fail 0"
REMOTE
  then
    $SSH "rm -rf '$STAGE'"
    echo "The keeper's tests did not pass on the server."
    return 1
  fi
}

# Packs the keeper code that runs now into /opt/iora/backups/keeper-<UTC time>.tgz (root only) and keeps the newest 5.
# Left out: node_modules (npm ci rebuilds it), the log and the state files. Prints only the backup's path.
backup_remote() {
  $SSH 'bash -s' <<'REMOTE'
set -e
B=/opt/iora/backups
install -d -m 700 "$B"
F="$B/keeper-$(date -u +%Y%m%d-%H%M%S).tgz"
cd /opt/iora
tar czf "$F" --exclude=keeper/node_modules --exclude=keeper/keeper.log --exclude=keeper/status.json \
  --exclude=keeper/keeper.lock $(ls -d keeper testnet 2>/dev/null)
chmod 600 "$F"
ls -1t "$B"/keeper-*.tgz | tail -n +6 | xargs -r rm -f
echo "$F"
REMOTE
}

# Restores a backup ($1 = its path on the server; empty = the newest), then reinstalls and restarts.
rollback_remote() {
  $SSH "F='${1:-}' bash -s" <<'REMOTE'
set -e
B=/opt/iora/backups
[ -n "$F" ] || F=$(ls -1t "$B"/keeper-*.tgz 2>/dev/null | head -1)
if [ -z "$F" ] || [ ! -f "$F" ]; then echo "no backup found in $B"; exit 1; fi
tar xzf "$F" -C /opt/iora --no-same-owner
echo "restored $F"
REMOTE
  install_and_restart
}

# Waits up to 180 s for a scan completed by the restarted keeper (the first scan lists every vault: about 50 s on
# testnet): status.json must show a new pid and a last_scan after the restart (both saved by install_and_restart).
# Returns 0 when seen.
wait_first_scan() {
  $SSH 'bash -s' <<'REMOTE'
START=$(cat /run/iora-keeper-restart-at 2>/dev/null || echo 0)
OLDPID=$(cat /run/iora-keeper-old-pid 2>/dev/null || echo 0)
for i in $(seq 1 36); do
  sleep 5
  set -- $(node -e 'try { const s = JSON.parse(require("fs").readFileSync("/opt/iora/keeper/status.json", "utf8"));
    const v = s.last_scan, t = typeof v === "number" ? v : Date.parse(v || "");
    console.log((Number.isFinite(t) ? Math.floor(t / 1000) : 0) + " " + (s.pid || 0)); } catch { console.log("0 0"); }')
  if [ "$1" -gt "$START" ] && [ "$2" != "$OLDPID" ]; then echo "first scan $(( $1 - START )) s after the restart (pid $2)"; exit 0; fi
done
echo "no completed scan within 180 s of the restart"
exit 1
REMOTE
}

install_and_restart() {
  $SSH 'bash -s' <<'REMOTE'
set -e
cd /opt/iora/keeper && { npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev --no-audit --no-fund >/dev/null; }
chown -R iora:iora /opt/iora/keeper /opt/iora/testnet
[ -f /opt/iora/keeper/.env ] && chmod 600 /opt/iora/keeper/.env
# for wait_first_scan: the pid in status.json before the restart, and the restart time
node -e 'try { console.log(JSON.parse(require("fs").readFileSync("status.json", "utf8")).pid || 0); } catch { console.log(0); }' > /run/iora-keeper-old-pid
date +%s > /run/iora-keeper-restart-at
systemctl restart iora-keeper
# Deployment check (IORA-04): the service must run with --ttl. Only checked and reported, never changed here.
if systemctl cat iora-keeper 2>/dev/null | grep -E '^ExecStart=.*keeper\.js' | grep -q -- '--ttl'; then
  echo "service check: TTL upkeep is on (--ttl)"
else
  echo 'WARNING service check: iora-keeper runs WITHOUT --ttl: quiet vaults and orders are not extended and can be archived.'
  echo '  Fix: add --ttl to the ExecStart line of /etc/systemd/system/iora-keeper.service, then: systemctl daemon-reload && systemctl restart iora-keeper'
fi
REMOTE
}

status() {
  $SSH 'printf "%-12s %s\n" iora-keeper "$(systemctl is-active iora-keeper 2>/dev/null)"
        systemctl cat iora-keeper 2>/dev/null | grep -E "^ExecStart=" | sed "s/^/service     /"
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
# --ttl: the keeper also extends the lifetime of quiet vault and order entries (without it they get archived).
unit iora-keeper "Iora keeper"      /opt/iora/keeper      /etc/iora/keeper.env "keeper.js --ttl"
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
  echo "[1/4] Copying the code to a staging folder on the server..."
  stage_and_test || { echo "Push stopped. Nothing was changed."; exit 1; }
  echo "[2/4] Backing up the code that runs now..."
  BACKUP=$(backup_remote)
  echo "      $BACKUP"
  echo "[3/4] Installing the new code and restarting..."
  $SSH "STAGE='$STAGE' bash -s" <<'REMOTE'
set -e
cd "$STAGE"
tar czf - --exclude=keeper/node_modules --exclude=keeper/status.json --exclude=keeper/keeper.lock --exclude=keeper/keeper.log * \
  | tar xzf - -C /opt/iora --no-same-owner
cd / && rm -rf "$STAGE"
REMOTE
  install_and_restart
  echo "[4/4] Waiting for the first scan of the new keeper (up to 180 s)..."
  if ! wait_first_scan; then
    echo "ROLLING BACK to $BACKUP ..."
    rollback_remote "$BACKUP"
    wait_first_scan || echo "WARNING: the restored keeper has not completed a scan either. Check: bash scripts/server.sh status"
    echo "===== PUSH FAILED: the old code runs again ====="
    exit 2
  fi
  status
  echo "===== DONE ====="
  ;;
test)
  echo "Copying the code to a staging folder on the server and testing it there (nothing is installed)..."
  stage_and_test || exit 1
  $SSH "rm -rf '$STAGE'"
  echo "===== TESTS PASSED ON THE SERVER ====="
  ;;
backup)
  echo "Backing up the code that runs now..."
  backup_remote
  ;;
rollback)
  rollback_remote "${2:-}"
  wait_first_scan || echo "WARNING: no completed scan yet. Check: bash scripts/server.sh status"
  status
  ;;
status) status ;;
logs)   $SSH 'journalctl -u iora-keeper -f -n 20 -o short-iso' ;;
stop)   $SSH 'systemctl stop iora-keeper; systemctl is-active iora-keeper || true' ;;
venues) # read-only check of the other venues (Aquarius), run on the server with the keeper's settings; nothing is sent
        $SSH "cd /opt/iora/keeper && set -a && . /etc/iora/keeper.env && set +a && runuser -p -u iora -- node keeper.js --venue-check ${2:-} ${3:-} 2>&1 | grep -v 'keeper started' | cut -c1-400" ;;
*)      sed -n '2,/^# The server address/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
