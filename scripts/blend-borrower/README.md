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
   Logs: `journalctl -u iora-blend-borrower -n 50`.

To stop: `systemctl disable --now iora-blend-borrower.timer`. The open position stays; repay it by hand or set
`UTIL_TARGET` low and let the bot repay.
