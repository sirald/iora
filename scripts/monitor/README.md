# Iora bots check (testnet)

The keeper has its own heartbeat check (`keeper/monitor/check-heartbeat.sh`). Before this check, the other testnet
bots and stocks failed silently: when the price bot stops, Iora's pools drift away from the real price; when a
borrower stops, the Blend pool's APRs fall; when the faucet runs dry, "Get test USDC" fails. Nobody heard about it.

`check-bots.js` runs every 5 minutes (`iora-bots-check.timer`) and tells the same Telegram chat as the keeper
heartbeat (`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` from `/etc/iora/heartbeat.env`). It reads and simulates only:
it sends no transaction and needs no key.

## What it checks

Each bot writes a status file at the end of every run, success or failure (the bots' `status.js`), into its
systemd `StateDirectory=`:

| Bot | Units | Status file |
|---|---|---|
| `price-bot` | `iora-price-bot.service` / `.timer` | `/var/lib/iora/price-bot/status.json` |
| `borrower` (USDC) | `iora-blend-borrower.service` / `.timer` | `/var/lib/iora/borrower/status.json` |
| `borrower-multi` (other coins) | `iora-blend-borrower-multi.service` / `.timer` | `/var/lib/iora/borrower-multi/status.json` |

| Rule | Kind | Default (setting) |
|---|---|---|
| A bot's timer is not installed or not active | alarm | |
| A bot's service is in failed state: `FAILED_RUNS` failed runs in a row, or a failure the bot could not record (start-up error, crash, timeout) | alarm | 2 (`FAILED_RUNS`) |
| No successful run for too long | alarm | price bot 15 min, borrowers 45 min (`PRICE_BOT_MAX_AGE_MIN`, `BORROWER_MAX_AGE_MIN`) |
| No status file (told only when it stays missing for the age limit, so a fresh install is quiet) | alarm | |
| A pool more than `MAX_POOL_DEV` off the Reflector price, or not checked at all (no fresh oracle price), in each of the last `POOL_DEV_RUNS` runs. One bad run is normal | alarm | 1%, 3 runs |
| A borrower's health factor below `MIN_HF`. Nothing liquidates positions in Iora's own pool, so this is the early warning | alarm | 1.3 (`MIN_HF`) |
| The price bot's inventory warnings (`inventory low`, `inventory short`) | stock | the bot's `WARN_USDC` / `WARN_COIN_USD` |
| A borrower's top-up warnings (wallet too small to repay, collateral short) | stock | |
| The faucet `GDWNSK...SY47`: Circle USDC or XLM left (Horizon), the account gone (testnet reset) | stock | 2000 USDC, 50 XLM (`FAUCET_MIN_USDC`, `FAUCET_MIN_XLM`) |
| The USDC exchange `CARNY3...AKTT`: its Circle USDC (a read-only simulation of the USDC token's `balance`) | stock | 500 USDC (`EXCHANGE_MIN_USDC`) |
| A timer that runs but is not enabled (it would not come back after a reboot) | soft | |
| The check itself cannot read Horizon, the RPC or systemd for `SOFT_DELAY_MIN` | soft | 10 min |

- **Repeats:** the same alarm at most once an hour (`ALARM_REPEAT_MIN`), a stock or soft warning at most every
  12 hours (`STOCK_REPEAT_H`). Each problem has its own key, so a new problem is told at once even while another
  one repeats.
- **Cleared:** one `OK (was: ...)` line when a problem that was told clears. An alarm that comes back is told again
  at once. A stock or soft warning that flaps around its limit is told at most once per 12 hours.
- **Not checked is not cleared:** when Horizon cannot be read, or a price-bot run failed before it looked at every
  pool, the earlier state is kept: no false "OK".
- **Exit code:** 0 nothing wrong (or only soft notices), 1 an alarm or a stock warning is active (the unit then also
  shows in `systemctl --failed`), 2 the check itself failed (also told on Telegram, at most once an hour).
- **Without Telegram settings** the messages only go to the journal.

A message looks like this:

```
[Iora bots] ALARM on iora-server
ALARM price bot: pool XLM is +2.31% off the Reflector price, more than 1.00% for 3 runs in a row; the bot says: inventory short: XLM pool wanted more USDC than the 3.1000000 available
LOW price bot: inventory low: 3.1000 USDC (warn below 200); top up with scripts/price-bot/fund-bot.sh
OK (was: USDC borrower: no recent successful run)
```

## Files

- `check-bots.js`: the command (one check).
- `rules.js`: the rules (no network). `alerts.js`: what is told and when (no network). `monitor.js`: the reading
  (systemd, status files, Horizon, RPC) and the sending.
- `iora-bots-check.service` / `.timer`: a oneshot service every 5 minutes, as user `iora`, state in
  `/var/lib/iora/monitor/state.json`.
- `monitor.env.example`: every setting with its default. The real file is `/etc/iora/monitor.env` (optional).
- Tests: `npm test` (no network, no systemd; runs on Node 20 and later).

`@stellar/stellar-sdk` is needed only for the USDC exchange check. Without `node_modules` the check still runs and
says once every 12 hours that the exchange is not checked.

## Install on the server (done by the operator)

Run as root on the server. The layout is the keeper's (`scripts/server.sh`): user `iora`, code under `/opt/iora`,
secrets in `/etc/iora`. Testnet only.

1. From the development machine, at the root of this repository, copy the three directories without
   `node_modules` (this updates the two bots' code as well):
   ```
   . ./server.env
   tar czf - --exclude=node_modules -C scripts monitor price-bot blend-borrower | ssh "$IORA_SERVER" 'tar xzf - -C /opt/iora --no-same-owner'
   ```
2. On the server: the bots' units with `StateDirectory=` (the bots' code reads `STATE_DIRECTORY` and writes the
   status file there):
   ```
   chown -R root:iora /opt/iora/price-bot /opt/iora/blend-borrower /opt/iora/monitor
   cp /opt/iora/price-bot/iora-price-bot.service /etc/systemd/system/
   cp /opt/iora/blend-borrower/iora-blend-borrower.service /etc/systemd/system/
   # only if the multi-coin borrower is installed:
   cp /opt/iora/blend-borrower/iora-blend-borrower-multi.service /etc/systemd/system/
   systemctl daemon-reload
   ```
3. The state directories. systemd creates them itself on each bot's next run; creating them now does no harm
   (systemd keeps owner and mode right). `/var/lib/iora` must stay readable for `iora` (mode 755):
   ```
   install -d -m 755 /var/lib/iora
   install -d -o iora -g iora -m 755 /var/lib/iora/price-bot /var/lib/iora/borrower /var/lib/iora/borrower-multi /var/lib/iora/monitor
   ```
4. Wait for the bots' next runs (price bot within 2 minutes, borrowers within 10), then check that the status files
   are there and fresh:
   ```
   ls -l /var/lib/iora/*/status.json
   head -c 600 /var/lib/iora/price-bot/status.json; echo
   ```
5. The check: its dependency (for the exchange check), the optional settings and the units. If the multi-coin
   borrower is not installed, put `BOTS=price-bot,borrower` in `/etc/iora/monitor.env`.
   ```
   cd /opt/iora/monitor && (npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund) && chown -R root:iora /opt/iora/monitor
   [ -f /etc/iora/monitor.env ] || install -m 640 -o root -g iora /opt/iora/monitor/monitor.env.example /etc/iora/monitor.env
   grep -c '^TELEGRAM_' /etc/iora/heartbeat.env    # 2: the chat is set
   cp /opt/iora/monitor/iora-bots-check.service /opt/iora/monitor/iora-bots-check.timer /etc/systemd/system/
   systemctl daemon-reload
   ```
6. One check by hand, then the timer:
   ```
   systemctl start iora-bots-check.service; journalctl -u iora-bots-check -n 20 --no-pager
   systemctl enable --now iora-bots-check.timer
   systemctl list-timers 'iora-*' --no-pager
   ```
   `systemctl start` reports a failure when the check found an alarm (exit 1): read the journal lines.
7. Optional, to see a message arrive: add `FAUCET_MIN_USDC=1000000` to `/etc/iora/monitor.env` and run
   `systemctl start iora-bots-check.service` (a `LOW faucet` message). Remove the line and run it again (an
   `OK (was: faucet: Circle USDC low)` message).

- Logs: `journalctl -u iora-bots-check -n 50`. What was told: `cat /var/lib/iora/monitor/state.json`.
- A bot stopped on purpose: take it out of `BOTS` in `/etc/iora/monitor.env`, otherwise its timer alarms every hour.
- To stop the check: `systemctl disable --now iora-bots-check.timer`.
