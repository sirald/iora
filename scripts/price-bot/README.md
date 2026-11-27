# Iora price bot (testnet)

Testnet's Soroswap (~0.60 USD) and Aquarius standard (~0.37–0.63 USD) USDC/XLM pools are far from the real XLM
price (Reflector, ~0.127 USD). Iora has its own reference pool instead (`scripts/create-ref-pool.sh`, addresses in
`testnet/ref-pool.env`). It is an Aquarius *concentrated* pool (fee 30 bps) with full-range liquidity, which prices
like a constant-product pool. The router accepts only fees of 10, 30 and 100 bps for standard pools, and all three
already exist for USDC/XLM. The filler, keeper and web reach the pool through the Aquarius router
(`get_pools` / `estimate_swap` / `swap` with the pool index).

This bot keeps that pool at Reflector's price. Each run does the following:

1. It reads the pool price (`get_slot0`) and its active liquidity.
2. It reads the oracle adapter's XLM and USDC prices (`lastprice`). The reference is XLM USD / USDC USD.
3. When the deviation is above `THRESHOLD` (default 0.5%), it swaps through the Aquarius router exactly as much as
   brings the pool back to the reference. If the pool is too expensive it sells XLM; if too cheap it buys XLM.
   The amount comes from the v3 formulas and is grossed up by the pool fee.

Limits:
- **Trade size:** at most `MAX_TRADE_USD` per run, and never more than the bot's own USDC / XLM inventory.
  `XLM_RESERVE` is never sold.
- **Inventory warning:** a `WARN inventory low` line when the bot holds less than `WARN_USDC` / `WARN_XLM`.
  A `WARN inventory short` line when the inventory limited a trade.
- **Missing or stale price:** if an oracle price is missing or older than `MAX_PRICE_AGE`, nothing is done.
- **Fair-price check:** if the router's estimate is worse than "reference less fee", nothing is sent. Every swap
  moves the pool toward the reference, so it never pays worse than that.
- **Slippage:** the minimum output is the estimate less `SLIPPAGE`.

Separate from the keeper: own directory, own account, own key, own systemd unit. Testnet only (it checks the RPC's
network passphrase).

- `price-bot.js`: one run. `--dry-run` only prints the decision; `--setup` also adds the Circle USDC trustline.
- `logic.js`: the decision, with no network access. Run its tests with `npm test`.
- `iora-price-bot.service` / `.timer`: a oneshot service that runs every 2 minutes.
- `price-bot.env.example`: the settings. The real file is `/etc/iora/price-bot.env`.

## Inventory

The bot trades only from its own account. The suggested start is **1000 USDC + 8000 XLM** (~2000 USD). For scale, on
the 3000 USDC pool:
- A 1% correction is about 15 USDC.
- A 10% correction is about 145 USDC.

The money comes from `iora-lp`, which also holds the pool's shares. That account's keys are in the stellar CLI
keystore on the development machine, not on the server.

**Arbitrage:** anyone can buy XLM in this pool at ~0.127 and sell it in the far-off Soroswap pool (~0.60). The bot
then sells XLM back into the pool, so such arbitrage drains its XLM. Each run is capped by `MAX_TRADE_USD`, and the
`WARN` lines show when the inventory runs low. Refill it from `iora-lp`, or stop the timer.

## Install on the server (done by the operator)

Run these steps as root on the server. The server layout is the keeper's (`scripts/server.sh`): user `iora`, code
under `/opt/iora`, secrets in `/etc/iora`.

1. Copy this directory to `/opt/iora/price-bot` (without `node_modules`) and install its dependency:
   `cd /opt/iora/price-bot && (npm ci --omit=dev || npm install --omit=dev) && chown -R root:iora /opt/iora/price-bot`
2. Generate the bot's key ON THE SERVER, straight into the env file. The secret is never printed:
   ```
   umask 027
   cd /opt/iora/price-bot
   node -e 'import("@stellar/stellar-sdk").then(({Keypair})=>{const k=Keypair.random();console.log("PRICE_BOT_SECRET="+k.secret()+"\nPRICE_BOT_ADDRESS="+k.publicKey())})' > /etc/iora/price-bot.env
   grep -E '^REF_POOL(_INDEX)?=' price-bot.env.example >> /etc/iora/price-bot.env   # check: equal to testnet/ref-pool.env
   chown root:iora /etc/iora/price-bot.env && chmod 640 /etc/iora/price-bot.env
   grep PRICE_BOT_ADDRESS /etc/iora/price-bot.env
   ```
3. Fund the account with friendbot, which gives 10,000 XLM:
   `curl -s "https://friendbot.stellar.org/?addr=<PRICE_BOT_ADDRESS>" > /dev/null`
4. Add the trustline and check the decision:
   `cd /opt/iora/price-bot && set -a && . /etc/iora/price-bot.env && set +a && runuser -p -u iora -- node price-bot.js --setup --dry-run`
   Without `--dry-run` this adds the trustline. Do that before step 5.
5. On the development machine (iora-lp's keystore), send the USDC inventory:
   ```
   stellar tx new payment --source iora-lp --network testnet --destination <PRICE_BOT_ADDRESS> \
     --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --amount 10000000000   # 1000 USDC
   ```
   Friendbot's 10,000 XLM already covers the XLM side.
6. Run the bot once by hand (the same command as step 4 without `--dry-run`), then enable the timer:
   `cp iora-price-bot.service iora-price-bot.timer /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now iora-price-bot.timer`
   Logs: `journalctl -u iora-price-bot -n 50`. Inventory warnings: `journalctl -u iora-price-bot | grep WARN`.

To stop: `systemctl disable --now iora-price-bot.timer`. The inventory stays in the bot's account.
