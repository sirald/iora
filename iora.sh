#!/usr/bin/env bash
# Starts Iora in one window: the keeper in the background, the web app in the foreground.
# Ctrl+C stops both. Keeper log: keeper/keeper.log
cd "$(dirname "$0")" || exit 1

# Two keepers with the same key break each other's transactions: if one is already running, no new one is started.
if command -v flock > /dev/null && ! flock -n /tmp/iora-keeper.lock true 2> /dev/null; then
  echo "The keeper is already running (in another window). A new one was not started."
  KEEPER_PID=""
else
  # The keeper writes its own log to keeper/keeper.log; if it crashes on start, the error ends up there too.
  bash keeper/run.sh --ttl > /dev/null 2>> keeper/keeper.log &
  KEEPER_PID=$!
  sleep 2
  if kill -0 $KEEPER_PID 2>/dev/null; then
    echo "Keeper running (log: keeper/keeper.log)"
  else
    echo "WARNING: the keeper could not be started; see the end of keeper/keeper.log"
  fi
fi
trap '[ -n "$KEEPER_PID" ] && { kill -INT $KEEPER_PID 2>/dev/null; wait $KEEPER_PID 2>/dev/null; }; echo; echo "Iora stopped."; exit 0' INT TERM

bash web/dev.sh
