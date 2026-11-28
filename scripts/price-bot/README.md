# Iora price bot (testnet)

Testnet's own USDC/XLM pools are far from the real XLM price:
- Soroswap ~0.60 USD
- Aquarius standard pools ~0.37–0.63 USD
- Reflector (the real price) ~0.127 USD

Iora keeps its own pools at the real (Reflector) price instead, and this bot looks after all of them:

- **XLM**: the reference pool `scripts/create-ref-pool.sh`, addresses in `testnet/ref-pool.env`.
  - It is an Aquarius *concentrated* pool with a 30 bps fee and full-range liquidity, so it prices like a
    constant-product pool.
  - The router accepts only 10, 30 and 100 bps for standard pools, and all three already exist for USDC/XLM.
- **iBTC, iETH, iSOL, iAVAX, iXRP**: Iora's own coins (`scripts/create-iora-coins.sh`, addresses in
  `testnet/iora-coins.env`). Each has a Soroswap pair against Circle USDC.

The filler, the keeper and the web reach these pools through the routers: Aquarius `get_pools` / `estimate_swap` /
`swap` with the pool index, and Soroswap as any pair.

`pools.json` lists the pools. `make-pools.sh` writes it from the two address files.

Each run, for every pool:

1. Read the pool price. For XLM: `get_slot0` and its active liquidity. For a Soroswap pair: its reserves.
2. Read the oracle adapter's price of the coin and of USDC (`lastprice`). The reference is coin USD / USDC USD.
3. When the deviation is above `THRESHOLD` (default 0.5%), swap through the pool's router exactly as much as brings
   the pool back to the reference. If the pool is too expensive, the bot sells the coin; if too cheap, it buys the
   coin with USDC. The amount comes from the constant-product formulas, grossed up by the pool fee.

Limits:

- **Size:** at most `MAX_TRADE_USD` per pool and run, and never more than the bot's own inventory. `XLM_RESERVE` is
  never sold.
- **Inventory warnings:** a `WARN inventory low` line when the bot holds less than `WARN_USDC` USDC, or less than
  `WARN_COIN_USD` worth of a coin. A `WARN inventory short` line when the inventory limited a trade.
- **Stale prices:** when a price is missing or older than `MAX_PRICE_AGE`, that pool is left alone.
- **Fair-price check:** when the router's estimate is worse than "reference less fee", nothing is sent. Every swap
  moves a pool toward the reference, so it never pays worse than that.
- **Slippage:** the minimum output is the estimate less `SLIPPAGE`.
- **Errors:** an error on one pool does not stop the others. The run then ends with exit code 1.

The bot is separate from the keeper: its own directory, account, key and systemd unit. It runs on testnet only
(it checks the RPC's network passphrase).

- `price-bot.js`: one run. `--dry-run` only prints the decisions. `--setup` also adds the missing trustlines
  (Circle USDC and every coin in `pools.json`). `ONLY=XLM,iBTC` limits a run to those pools.
- `logic.js`: the decision, with no network access. Tests: `npm test`.
- `pools.json` / `make-pools.sh`: the pools.
- `fund-bot.sh`: fills the inventory (see below).
- `iora-price-bot.service` / `.timer`: a oneshot service every 2 minutes.
- `price-bot.env.example`: the settings. The real file is `/etc/iora/price-bot.env`.
- `status.js`: the status file (below). Tests: `npm test`.

## Status file and alarms

At the end of every run, success or failure, the bot writes `/var/lib/iora/price-bot/status.json` (the unit's
`StateDirectory=`, passed as `STATE_DIRECTORY`; `STATUS_FILE` overrides it). A dry run and a run by hand without
either write nothing. Writing it never fails a run and never changes a trade.

It holds `at`, `ok`, `error` (when it failed), `lastOkAt`, `failsInRow`, the run's `warnings`, per pool the
deviation from the Reflector price after the run and what the bot did (`none`, `swap`, `refused`, `skipped`,
`error`), the inventory per coin and in USD, and the deviations of the last 10 runs (`history`).

The bots check (`scripts/monitor`, Telegram) reads it: no successful run for 15 minutes, failed runs, inventory
warnings, and a pool more than 1% off the Reflector price for 3 runs in a row are told on Telegram. Install it with
`scripts/monitor/README.md`.

## Inventory

The bot trades only from its own account and does **not** mint. It holds:

- XLM from friendbot.
- USDC, for buying coins whose pool is too cheap.
- Each coin, for selling when its pool is too expensive. The coins are minted ahead of time by `fund-bot.sh`, which
  is run on the development machine: the issuer pays the coins to the bot and `iora-lp` pays the USDC.

The issuer's key stays off the server. Whoever holds that key can mint any amount, and the coins are (or soon
will be) collateral in Iora's Blend pool, up to their supply caps.

Suggested start: **500 USD of each coin + 1500 USDC + friendbot's 10,000 XLM**. For scale:

- A 2% correction on a 1500 USDC pair is about 15 USD.
- A 2% correction on the 3000 USDC XLM pool is about 30 USD.

Top up with `fund-bot.sh` when the WARN lines appear (the bots check, `scripts/monitor`, also tells them on Telegram,
at most every 12 hours). The script only tops up to the given amounts, so running it again is safe.

**Arbitrage:** anyone can buy XLM in the reference pool at ~0.127 and sell it in the far-off Soroswap XLM pool
(~0.60). The bot then sells XLM back into its pool, so that arbitrage drains its XLM. Each run is capped by
`MAX_TRADE_USD`, and the WARN lines show when the inventory runs low. Refill it, or stop the timer.

## Install on the server (done by the operator)

Run as root on the server. The server layout is the keeper's (`scripts/server.sh`): user `iora`, code under
`/opt/iora`, secrets in `/etc/iora`.

1. Copy this directory to `/opt/iora/price-bot` (without `node_modules`) and install its dependency:
   `cd /opt/iora/price-bot && (npm ci --omit=dev || npm install --omit=dev) && chown -R root:iora /opt/iora/price-bot`
2. Generate the bot's key ON THE SERVER, straight into the env file. The secret is never printed:
   ```
   umask 027
   cd /opt/iora/price-bot
   node -e 'import("@stellar/stellar-sdk").then(({Keypair})=>{const k=Keypair.random();console.log("PRICE_BOT_SECRET="+k.secret()+"\nPRICE_BOT_ADDRESS="+k.publicKey())})' > /etc/iora/price-bot.env
   chown root:iora /etc/iora/price-bot.env && chmod 640 /etc/iora/price-bot.env
   grep PRICE_BOT_ADDRESS /etc/iora/price-bot.env
   ```
3. Fund the account (testnet): `curl -s "https://friendbot.stellar.org/?addr=<PRICE_BOT_ADDRESS>" > /dev/null`.
4. Add the trustlines (USDC + the five coins) and look at the decisions:
   `cd /opt/iora/price-bot && set -a && . /etc/iora/price-bot.env && set +a && runuser -p -u iora -- node price-bot.js --setup --dry-run`
   Then run the same command without `--dry-run`. It adds the trustlines and may already trade with the XLM it has.
5. On the development machine, fill the inventory:
   `bash scripts/price-bot/fund-bot.sh <PRICE_BOT_ADDRESS> 500 1500`
6. Enable the timer:
   `cp iora-price-bot.service iora-price-bot.timer /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now iora-price-bot.timer`
   - Logs: `journalctl -u iora-price-bot -n 50`
   - Warnings only: `journalctl -u iora-price-bot | grep WARN`
   - The last run: `cat /var/lib/iora/price-bot/status.json`
7. Alarms: install the bots check (`scripts/monitor/README.md`). An older unit without `StateDirectory=` writes no
   status file: copy the unit again and run `systemctl daemon-reload`.

When a pool is added or moves, run `make-pools.sh`, copy `pools.json` to `/opt/iora/price-bot/`, and then run
step 4 again for any new trustline.

To stop: `systemctl disable --now iora-price-bot.timer`. The inventory stays in the bot's account.
