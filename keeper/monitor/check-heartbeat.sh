#!/usr/bin/env bash
# Outside check for the Iora keeper: alarms when status.json's heartbeat is too old, when the keeper's
# systemd service is not active, or when RPC / scans keep failing. Runs nothing on the network except
# the Telegram alert itself. PREPARED ONLY: install it by hand (see iora-keeper-heartbeat.timer).
#
#   keeper/monitor/check-heartbeat.sh [path/to/status.json]
#
# Settings (environment; with systemd put them in the EnvironmentFile named in the .service file):
#   MAX_AGE_SEC        heartbeat older than this = alarm (default 120; the keeper writes it every ~5 s)
#   SERVICE            systemd unit to check (default iora-keeper.service; empty = skip the check)
#   MAX_RPC_ERRORS     rpc_consecutive_errors at or above this = alarm (default 20)
#   MAX_FAILED_SCANS   failed_scans_in_row at or above this = alarm (default 10)
#   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID   where alarms go; without them the alarm only goes to stderr
#   STATE_FILE         remembers the last alarm so the same one is sent at most once an hour
#                      (default /tmp/iora-keeper-heartbeat.state)
# Exit code: 0 healthy, 1 alarm.
set -u
STATUS="${1:-$(dirname "$0")/../status.json}"
MAX_AGE_SEC="${MAX_AGE_SEC:-120}"
SERVICE="${SERVICE-iora-keeper.service}"
MAX_RPC_ERRORS="${MAX_RPC_ERRORS:-20}"
MAX_FAILED_SCANS="${MAX_FAILED_SCANS:-10}"
STATE_FILE="${STATE_FILE:-/tmp/iora-keeper-heartbeat.state}"

problems=()

if [ -n "$SERVICE" ] && command -v systemctl > /dev/null; then
  systemctl is-active --quiet "$SERVICE" || problems+=("service $SERVICE is not active")
fi

if [ ! -f "$STATUS" ]; then
  problems+=("status file missing: $STATUS")
else
  # node is on the keeper machine anyway; it reads the JSON safely (no jq needed).
  read -r AGE RPC_ERR FAILED RPC_CUR < <(node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const hb = Date.parse(s.heartbeat || s.last_scan || "");
    const age = Number.isFinite(hb) ? Math.round((Date.now() - hb) / 1000) : -1;
    console.log(age, s.rpc_consecutive_errors ?? 0, s.failed_scans_in_row ?? 0, s.rpc_current || "-");
  ' "$STATUS" 2> /dev/null || echo "-1 0 0 -")
  if [ "$AGE" -lt 0 ]; then
    problems+=("status.json has no readable heartbeat")
  elif [ "$AGE" -gt "$MAX_AGE_SEC" ]; then
    problems+=("heartbeat is ${AGE}s old (limit ${MAX_AGE_SEC}s)")
  fi
  [ "$RPC_ERR" -ge "$MAX_RPC_ERRORS" ] && problems+=("${RPC_ERR} RPC errors in a row (now on ${RPC_CUR})")
  [ "$FAILED" -ge "$MAX_FAILED_SCANS" ] && problems+=("${FAILED} scans failed in a row")
fi

if [ ${#problems[@]} -eq 0 ]; then
  rm -f "$STATE_FILE"
  exit 0
fi

msg="[Iora keeper] ALARM on $(hostname): $(IFS='; '; echo "${problems[*]}")"
echo "$msg" >&2

# The same alarm at most once an hour.
key=$(printf '%s' "${problems[*]}" | sed -E 's/[0-9]+//g')
now=$(date +%s)
if [ -f "$STATE_FILE" ]; then
  read -r last_at last_key < "$STATE_FILE" || true
  if [ "${last_key:-}" = "$(printf '%s' "$key" | md5sum | cut -c1-12)" ] && [ $((now - ${last_at:-0})) -lt 3600 ]; then
    exit 1
  fi
fi
echo "$now $(printf '%s' "$key" | md5sum | cut -c1-12)" > "$STATE_FILE"

if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  curl -s -m 10 -o /dev/null "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" --data-urlencode "text=${msg}" || echo "telegram alert could not be sent" >&2
fi
exit 1
