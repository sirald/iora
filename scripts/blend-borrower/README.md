# Iora Blend borrower bot (testnet)

Iora vaults keep resting USDC in Iora's own Blend pool (`scripts/deploy-blend-pool.sh`, addresses in
`testnet/blend-pool.env`). A lending pool only pays interest when someone borrows, so this bot borrows: it puts XLM up
as collateral and borrows Circle USDC until the pool's USDC utilisation is inside `UTIL_TARGET ± UTIL_BAND`
(default 50–70%). Above the band it repays; when its own health factor falls below `MIN_HF` it repays down to
`TARGET_HF`. It never borrows beyond `TARGET_HF` or `MAX_DEBT`. When the oracle has no fresh price it does nothing.
The borrowed USDC stays in the bot's wallet and is used for repaying.

Separate from the keeper: own directory, own account, own key, own systemd unit. Testnet only (it checks the RPC's
network passphrase).

- `borrower.js`: one run (reads the pool, decides, sends at most one `submit`). `--dry-run` only prints; `--setup` also
  adds the Circle USDC trustline.
- `logic.js`: the decision, no network. Tests: `npm test`.
- `iora-blend-borrower.service` / `.timer`: oneshot service every 10 minutes.
- `borrower.env.example`: settings; the real file is `/etc/iora/borrower.env`.
- `status.js`: the status file (below). Tests: `npm test`.

## Status file and alarms

At the end of every run, success or failure, the bot writes a status file into its unit's `StateDirectory=` (passed
as `STATE_DIRECTORY`; `STATUS_FILE` overrides it): `/var/lib/iora/borrower/status.json` for the USDC bot,
`/var/lib/iora/borrower-multi/status.json` for the second account. A dry run and a run by hand without either write
nothing. Writing it never fails a run and never changes what the bot borrows or repays.

It holds `at`, `ok`, `error` (when it failed), `lastOkAt`, `failsInRow`, the top-up `warnings`, the health factor
`hf` after the run (estimated from what was read when it sent something; `null` without debt or with a missing
price), the effective collateral and liabilities in USD, the USDC step's utilisation, debt and collateral (`usdc`),
and per other coin its utilisation, target, supply APR, debt, supply and collateral (`coins`).

The bots check (`scripts/monitor`, Telegram) reads it: no successful run for 45 minutes, failed runs, top-up warnings,
and a health factor below 1.3 are told on Telegram. Nothing liquidates positions in Iora's own pool, so the health
factor alarm is the early warning. Install it with `scripts/monitor/README.md`.

## Install on the server (done by the operator)

Run as root on the server. The server layout is the keeper's (`scripts/server.sh`): user `iora`, code under
`/opt/iora`, secrets in `/etc/iora`.

1. Copy this directory to `/opt/iora/blend-borrower` and install its dependency:
   `cd /opt/iora/blend-borrower && npm ci --omit=dev || npm install --omit=dev; chown -R root:iora /opt/iora/blend-borrower`
2. Generate the bot's key ON THE SERVER, straight into the env file (the secret is never printed):
   ```
   umask 027
   cd /opt/iora/blend-borrower
   node -e 'const {Keypair}=require("@stellar/stellar-sdk");const k=Keypair.random();console.log("BORROWER_SECRET="+k.secret()+"\nBORROWER_ADDRESS="+k.publicKey())' > /etc/iora/borrower.env
   grep '^BLEND_POOL=' borrower.env.example >> /etc/iora/borrower.env   # check it equals POOL in testnet/blend-pool.env
   chown root:iora /etc/iora/borrower.env && chmod 640 /etc/iora/borrower.env
   grep BORROWER_ADDRESS /etc/iora/borrower.env
   ```
3. Fund the account (testnet): `curl -s "https://friendbot.stellar.org/?addr=<BORROWER_ADDRESS>" > /dev/null`
   (10,000 XLM; the default `COLLATERAL_TARGET` is 5,000 XLM).
4. First run, by hand, with the trustline:
   `cd /opt/iora/blend-borrower && set -a && . /etc/iora/borrower.env && set +a && runuser -p -u iora -- node borrower.js --setup --dry-run`
   then the same without `--dry-run`.
5. Timer:
   `cp iora-blend-borrower.service iora-blend-borrower.timer /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now iora-blend-borrower.timer`
   Logs: `journalctl -u iora-blend-borrower -n 50`. The last run: `cat /var/lib/iora/borrower/status.json`.
6. Alarms: install the bots check (`scripts/monitor/README.md`). An older unit without `StateDirectory=` writes no
   status file: copy the unit again and run `systemctl daemon-reload`.

To stop: `systemctl disable --now iora-blend-borrower.timer`. The open position stays; repay it by hand or set
`UTIL_TARGET` low and let the bot repay.

## Other coins: XLM and Iora's coins (multi.js, targets.json)

The same program can also borrow XLM and Iora's coins iBTC, iETH, iSOL, iAVAX and iXRP, so that each of them earns
interest.

**Targets.** `targets.json` gives each coin a **target supply APR**. The values were chosen from real-market rates of
2026-11-27 (see the side-session note `faiz-hedefleri.md`):

| Coin | Target supply APR |
|---|---|
| XLM | 0.01% |
| iBTC | 0.01% |
| iETH | 1% |
| iSOL | 2% |
| iAVAX | 0.85% |
| iXRP | 0.05% |

**Why an APR and not a utilisation.** Blend v2 multiplies the rate curve by `ir_mod` and moves `ir_mod` up or down
while utilisation sits above or below the curve's `util`, bounded to 0.1–10. A fixed utilisation therefore drifts the
rate. Each run the bot instead:

1. solves for the utilisation that pays the target at the current `ir_mod`, capped at `util + UTIL_OVERSHOOT` and at
   the coin's `maxBorrowApr`;
2. borrows or repays towards it, but only when the gap is bigger than `band` (default 2 points).

It settles at `util`, with the `ir_mod` that pays the target. For very small targets it settles at the `ir_mod`
floor of 0.1, below `util`.

**Each run, per coin:**

- **Lender supply.** The bot supplies the coin as a lender (Blend request 0) up to `supplyUsd`, from its wallet, so
  there is something to borrow before Iora vaults bring their own.
- **Collateral.** It keeps `collateral.targetUsd` of one coin (`iBTC`) posted. Iora's coins are minted by the issuer,
  so this collateral grows neither the USDC nor the XLM supply (that is the loop that made XLM borrowing against
  USDC/XLM collateral misbehave).
- **Limits.** `maxDebtUsd` per coin; `MULTI_TARGET_HF` for new borrows. Below `MULTI_MIN_HF` the bot repays, largest
  effective liability first. It never borrows a coin past its `max_util`. When a price is missing or stale it does
  nothing.
- **Inactive reserves.** A coin that is not an active reserve is skipped. Iora's coins become reserves after
  2026-12-04T19:58Z (`scripts/apply-blend-rates.sh`), so until then only XLM is handled.

**Run it as a second account.** Use `/etc/iora/borrower-multi.env` with `USDC_STEP=off`, and the units
`iora-blend-borrower-multi.service` / `.timer`. This keeps the USDC bot's health factor and XLM collateral as they
are. The USDC bot keeps `MULTI=off`, or runs without `targets.json`, so it behaves exactly as before.

**Inventory.** It is minted on the development machine and the issuer's key never goes to the server:
`bash scripts/blend-borrower/fund-multi.sh <ADDRESS>` mints `supplyUsd` plus 10% of each coin, and also
`collateral.targetUsd` plus 10% of the collateral coin. XLM comes from friendbot.
