# Iora

**Interest On Resting Assets: limit orders that earn while they wait, on Stellar.**

Iora is a non-custodial limit order app on Stellar (Soroban). You place a limit order as you would on an exchange. Until
the order fills, the funds behind it are supplied to a [Blend](https://blend.capital) lending pool and earn interest.
When the price reaches your limit, your vault withdraws from Blend, swaps and keeps the result, all in one atomic
transaction. Iora's keeper compares the routes it knows and takes the one that returns the most; the contract itself
guarantees only your limit.

- App (testnet): **https://iorafi.com/app.html**
- Website and docs: https://iorafi.com · https://iorafi.com/docs.html

> **Status:** testnet beta, invite-only. The contracts have not been independently audited. Do not use real funds.

## Why

A limit order leaves your money idle until the price comes to you, which can take days or weeks. Iora keeps that money
supplied to a lending pool, so it earns interest until the moment it is spent. If the price never comes, you cancel
and withdraw, interest included.

## How it works

1. **Open a vault.** The factory deploys a vault contract for your wallet. One vault per owner; only the owner can
   deposit, withdraw, place or cancel orders. There is no shared Iora contract that holds user funds.
2. **Deposit.** Any supported asset. If the lending pool has a market for it, it is supplied there at once and starts
   earning; otherwise it waits in the vault.
3. **Place an order.** "Sell this token, buy that one, at this price or better." The amount is reserved for the order
   and keeps earning. An order stays open until it fills or the owner cancels it.
4. **A keeper fills it.** Filling is open to anyone. When the limit can be met, the vault takes the fill amount out of
   Blend, has it traded, counts what came back and keeps it (or sends it to the owner's wallet, if the owner chose
   that). If less came back than the limit promises, the whole transaction reverts.

An order can be filled in four ways, and the same rules hold for each:

| Function | Where the bought token comes from |
|---|---|
| `fill_via` | A filler contract sells the amount along a route the caller gives it: one pool, several pools of several trading venues at once, or two steps through an intermediate token |
| `cross` | An opposite order in another Iora vault. The two orders pay each other; no pool is involved |
| `take` | A payer who sends the bought token straight into the vault |
| `execute` | The vault's built-in route: a swap through the router it was created with, directly or through one intermediate token |

What the contract enforces on every fill:

- **The owner's price is the floor.** The vault computes the minimum output from the limit price and checks the amount
  it actually received. Anything less reverts.
- **The caller cannot redirect funds.** Whoever fills an order chooses the order, the fill amount, where the fill comes
  from and the address that receives the fill fee. The tokens, the recipient and the limit were fixed when the owner
  signed the order.
- **A filler is trusted with nothing.** The most it ever holds is the amount being filled, inside one transaction.
- **The fill fee comes from the surplus.** The vault pays the executor at most a fixed cap per fill, and only out of
  output above the owner's limit. At exactly the limit the fee is zero. This does not cap what a filler can gain: it
  can fill exactly at the limit and keep the price improvement itself (see [Security](#security)). Passing price
  improvement on to the owner is keeper behaviour, not a contract guarantee.
- **Only allowed tokens.** Orders may only use tokens on the factory's allowed list, so nobody can be tricked into
  signing an order that buys a fake token.

Order types: limit orders in both directions, partial fills with a minimum fill size, scaled orders (several limit
orders across a price range), scheduled orders (DCA, with the schedule enforced by the vault), take profit (a buy that
opens its own sell order when it fills) and stop orders driven by the Blend pool's oracle (switched off in the app on
testnet, where the oracle price is fixed).

The app has **Markets**, **Trade** (limit, market, scaled and DCA orders, buy and sell), **Portfolio**,
**Lend & Borrow** (direct Blend positions from your wallet) and **Test funds** pages.

## Repository layout

| Path | What it is |
|---|---|
| `contracts/vault` | The vault: one multi-asset vault per owner (Rust, Soroban SDK). Version 13 |
| `contracts/factory` | The factory: deploys one vault per owner, pause switch, allowed token list, vault list (one chain per bucket, no cap) |
| `contracts/filler` | The filler: runs a route (a list of plain contract calls) for a vault's `fill_via`, or for a wallet's market swap. No owner, no settings, no storage |
| `contracts/batch` | Experimental: several `execute` fills in one transaction. Not used by the keeper or the site |
| `contracts/order-vault`, `contracts/vault-factory` | Earlier two-vault design. Still deployed on testnet and still filled by the keeper; not used for new vaults |
| `keeper/` | Node.js keeper: scans vaults, compares routes across the trading venues it knows, crosses opposite orders, fills, extends storage TTL |
| `web/` | Website, docs and app (Vite, vanilla JS, Varial wallet, formerly Freighter) |
| `web/api/` | Serverless functions for the beta sign-up form and the invite gate |
| `scripts/` | Build, test, deploy and trial scripts |
| `testnet/` | The public addresses the scripts, the keeper and the site read |
| `docs/THREAT_MODEL.md` | Threat model |

## Testnet deployment

| Contract | Address |
|---|---|
| Vault factory (vault version 14, Circle USDC) | `CBGQQWKM4TM5QFRCEJPBLSMXGRWOXUBJQUQ2FKDRBEJZYGV37MM4SB5L` |
| Filler (version 3) | `CA4QUID65J4PINAJSYTQ7O4GUO2WDKVAMDPCOOEAFOTR6GWLXYGS4A7X` |
| Blend pool (Iora's own testnet pool) | `CANUGJL73FGXXDE7BVVUCIPM2ETOO2UARG4B3Q2TJKI4FADWJAMLIKXV` |
| USDC (Circle's testnet USDC) | issuer `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`, token `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| Trading venues the keeper routes through | Aquarius router `CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD`, Soroswap router `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD` |

The factory deploys vaults from the code hash in `testnet/factory.env`. Factories of earlier versions are listed in
`testnet/generations.env` and `testnet/old-factories.env`; their vaults keep working, the keeper keeps filling them and
the app offers their owners a move to the newest vault.

Every market is a coin against USDC. On testnet USDC is Circle's test USDC, and the app's Test funds page hands out
100 of it per wallet per day (`web/api/faucet.js`). USDC and XLM are reserves of Iora's own testnet Blend pool and earn
interest. The other coins are **Iora's own testnet tokens**, named "i" + the coin they follow (iBTC, iETH, iSOL, iAVAX,
iXRP): Iora issues them, they have no value, and a bot keeps their pools at the real price of that coin from the
Reflector oracle. Until the Blend pool lists them they wait in the vault without earning; the app reads the pool's
reserve list and says "earns no interest yet" until then.

Prices in the app come from one place: Iora's reference pool when it trades the coin, else the best pool within 5% of
the Reflector price; a pool further away is never used as a price (if none is near, the Reflector price is shown and
labelled so). The price chart shows the pool's own trades and, before the pool's first trade, the coin's market price
in USD (dashed) from `web/api/history.js`, which reads Kraken's public candles (no key) and caches them for 5 minutes,
or the Reflector oracle's last ~20 hours if Kraken cannot be reached.

## Factory interface

| Function | Caller | What it does |
|---|---|---|
| `create_vault(owner)` | owner | Deploys the owner's vault; one per address. The address is derived from the owner's address |
| `vault_of(owner)` | read | The owner's vault address, if any |
| `vault_count()`, `bucket_count()`, `bucket_of(owner)` | read | Number of vaults, number of buckets (256), the bucket an owner falls in |
| `heads(start, limit)` | read | The non-empty buckets among `start..start+limit` (at most 64 per call), each with its newest owner and vault count |
| `bucket(index, from, limit)` | read | The vaults in one bucket, newest first, at most 40 per call. Each entry carries `prev`; pass it as `from` to read on. A bucket is a chain with no cap, so it cannot be filled to block new vaults |
| `extend_ttl(index, from, limit)` | anyone | Extends the storage lifetime of a bucket's head and up to 40 entries along its chain |
| `is_paused()` | read | Whether new vaults and new orders are paused |
| `is_allowed(token)`, `allowed_tokens()` | read | The tokens orders may use (at most 32) |
| `get_config()`, `get_guardian()` | read | The pool, router, vault code hash and fee caps; the guardian's address |
| `set_paused(bool)`, `set_allowed(token, bool)`, `propose_guardian(addr)` | guardian | A new guardian must call `accept_guardian` |

The factory's pool, router, vault code hash and fee caps are fixed at deployment. Vaults cannot be upgraded.

## Vault interface

| Function | Caller | What it does |
|---|---|---|
| `deposit(token, amount)` | owner | Takes `token` from the owner's wallet. Supplied to Blend at once if the pool has a reserve for it; otherwise it waits in the vault |
| `withdraw(token, amount)` | owner | Withdraws up to the free balance of `token`. The amount 2¹²⁷ − 1 withdraws everything free, including interest accrued after signing |
| `place_order(sell, buy, amount_in, limit_price, min_fill, max_impact_bps, expiry, keep)` → id | owner | Sells `amount_in` of `sell` for `buy`, paying at most `limit_price` per unit bought. `keep`: the output stays in the vault (true) or goes to the owner's wallet (false) |
| `place_stop_order(sell, buy, amount_in, trigger_price, limit_price, min_fill, max_impact_bps, expiry, band_bps, keep)` → id | owner | Fills only while the oracle price is at or past `trigger_price`; `limit_price` still caps the worst price. `band_bps` (50 to 1,000) is how far below the oracle-fair amount a fill may be |
| `place_order_then(sell, buy, amount_in, limit_price, min_fill, max_impact_bps, expiry, then_limit, then_impact_bps, then_duration)` → id | owner | A limit order whose output is placed into a reverse order in the same vault on each fill. The reverse order may not sell below the buy price. If it cannot be opened, the fill still happens |
| `place_dca(sell, buy, part, fills, every, limit_price, max_impact_bps, band_bps, expiry, keep)` → id | owner | A scheduled order: sells `part` every `every` seconds (60 seconds to 28 days), the first part at once. `fills` = 0 runs for as long as the vault covers the next part. Only one part is reserved at a time. With no price limit (`limit_price` at its maximum) an oracle band is required |
| `cancel_order(id)` | owner | Cancels and releases the unfilled amount. (After the time in `expiry`, anyone may make this call; it only frees the amount for the owner) |
| `fill_via(executor, id, fill_amount, filler, route)` → amount_out | anyone | Sends `fill_amount` of the sold token to `filler`, calls its `swap` with `route` and counts what arrived. The order's price impact setting does not apply here |
| `cross(executor, id, fill_amount, other, other_order, other_fill)` → amount_out | anyone | Fills this order against an opposite order in another vault through that vault's `take`. Both limits are checked |
| `take(payer, id, fill_amount, pay_amount, executor)` → amount_out | anyone (payer signs) | `payer` pays `pay_amount` of the bought token into the vault and receives `fill_amount` of the sold token |
| `execute(executor, id, fill_amount, via)` → amount_out | anyone | Fills through the vault's built-in route. `via` is empty for the direct pair, or one allowed token to route through. The order's price impact limit is checked on this route |
| `claim_rewards(reserve_token_ids)` → amount | owner | Sends Blend's BLND rewards to the owner's wallet |
| `forget(token)` | owner | Takes a token the vault no longer holds off its list, freeing one of its 12 places |
| `positions()`, `position(token)`, `tokens()` | read | Per token: balance (Blend share plus idle), idle part, reserved, free, principal, and whether it earns on Blend |
| `balance`, `free_balance`, `orderable_balance`, `reserved`, `deposited`, `stats` (each takes `token`); `get_order`, `get_schedule`, `get_follow_up`, `order_count`, `get_config`, `version` | read | |

In every fill function `executor` is the address that receives the fill fee.

### Filler interface

| Function | Caller | What it does |
|---|---|---|
| `swap(sell, buy, amount, to, route)` → amount_out | anyone (a vault, inside `fill_via`) | Runs `route`, then sends everything it holds of `buy`, and whatever is left of `sell`, to `to` |
| `swap_from(user, sell, buy, amount, min_out, route)` → amount_out | user | The app's market swap: takes `amount` from `user`, runs `route`, sends the result back and fails if it is below `min_out` |
| `version()` | read | 3 |

A route is a list of steps `{ contract, func, args, auths }`. Each step is a plain contract call; `auths` lists the
calls that step may make in the filler's name (for example the token transfer a pool pulls), each allowed once and for
exactly those arguments. A step addressed to the filler itself with `func = sweep` sends its balance of a token to
`to`. The filler holds funds only inside one transaction. It must never be given an allowance (`approve`): it runs
whatever route it is handed.

### Units

- Every token in a vault must use 7 decimals (1 USDC = 10,000,000). A vault holds at most 12 different tokens.
- `limit_price` is the maximum amount of the `sell` token paid for 1 unit of the `buy` token, with 7 decimals. Buying a
  coin at 0.20 USDC per coin: `2000000`. Selling a coin for USDC at `p` USDC per coin: `floor(10¹⁴ / p_units)`.
- Minimum output: `ceil(fill_amount × 10⁷ / limit_price)` units of the `buy` token.
- `max_impact_bps` is 1 to 10,000; 10,000 disables the impact check.
- `expiry` is a Unix timestamp in seconds, any time in the future. The app passes the largest value (2⁶⁴ − 1): the order
  stays open until it fills or is cancelled.
- `min_fill` must be at least one twentieth of `amount_in`, so an order fills in at most 20 pieces. A partial fill may
  not leave a remainder smaller than `min_fill`. A scheduled order always fills one whole part.
- For an asset supplied to Blend, 0.001 of it (10,000 units) cannot be placed into orders and cannot be withdrawn while
  an order selling it is open. It absorbs Blend's rounding so the last piece of an order can always be paid out. Tokens
  that are not on Blend have no such buffer.
- `trigger_price` uses the same unit as `limit_price` and is compared with the Blend pool's oracle price (SEP-40
  `lastprice`, at most 10 minutes old), never with a swap pool's spot price. `limit_price` must be at or beyond the
  trigger by at most 10%. The trigger does not latch.

### Events

| Event | Data |
|---|---|
| `deposited`, `withdrawn` (topic: token) | `amount` |
| `order_placed` (topic: id) | `sell`, `buy`, `amount_in`, `limit_price` |
| `dca_placed` (topic: id) | `fills`, `every`, `part` |
| `order_cancelled` (topic: id) | `remaining` |
| `order_filled` (topic: id) | `amount_in`, `amount_out`, `kept` |
| `exec_fee_paid` (topic: id) | `executor`, `amount` |
| `follow_opened` (topic: id) | `new_order_id`, `amount` |
| `held` (topic: id) | `amount`: the owner's wallet could not receive the output, so it stayed in the vault |
| `rewards_claimed` | `amount` |
| `vault_created` (factory; topic: owner) | `vault`, `bucket` |
| `token_allowed` (factory; topic: token) | `allowed` |
| `pause_changed`, `guardian_proposed`, `guardian_changed` (factory) | `paused`; `guardian` |

### Error codes

| Code | Name | Meaning |
|---|---|---|
| 1 | `InvalidAmount` | Amount is zero or negative, or the minimum fill is larger than the amount or smaller than a twentieth of it |
| 2 | `InsufficientFree` | Not enough free balance |
| 3 | `OrderNotFound` | No order with this id |
| 4 | `OrderNotOpen` | The order is already filled or cancelled |
| 5 | `OrderExpired` | The time given in `expiry` has passed |
| 6 | `FillTooSmall` | The fill is below the minimum fill, or would leave a remainder smaller than it |
| 7 | `FillTooLarge` | The fill is larger than the unfilled amount |
| 8 | `LimitNotMet` | Less arrived than the limit requires |
| 9 | `InvalidPrice` | The limit price is not valid |
| 10 | `PoolShortfall` | Blend returned less than requested |
| 11 | `InvalidExpiry` | `expiry` is not in the future |
| 12 | `BlendFormat` | Unexpected data format from Blend |
| 13 | `ImpactTooHigh` | `execute`: the fill would move the pool price more than allowed |
| 14 | `InvalidImpact` | The price impact limit is outside 1 to 10,000 bps |
| 15 | `Paused` | New orders are paused |
| 16 | `TriggerNotMet` | Stop order: the oracle price has not reached the trigger |
| 18 | `InvalidFollowUp` | Invalid follow-up order settings |
| 19 | `OracleUnavailable` | No oracle price, or it is older than 10 minutes |
| 20 | `PriceDeviation` | The fill would be further below the oracle price than the band allows |
| 21 | `SameToken` | The token sold and the token bought must differ |
| 23 | `BadDecimals` | Every token in the vault must use 7 decimals |
| 24 | `InvalidBand` | `band_bps` must be between 50 and 1,000 |
| 25 | `InvalidFee` | Setup: a fill fee cap cannot be negative |
| 26 | `TooManyTokens` | A vault holds at most 12 different tokens |
| 27 | `TokenNotAllowed` | The token is not on the factory's allowed list |
| 28 | `InvalidPath` | The routing token is the token sold or the token bought |
| 29 | `TokenInUse` | `forget`: the vault still holds the token, or an open order still sells it |
| 30 | `SelfFill` | `take`, `cross`, `fill_via`: a vault cannot pay or fill itself |
| 31 | `TooEarly` | Scheduled order: the next part is not due yet |
| 33 | `InvalidSchedule` | Scheduled order: the interval is outside 60 seconds to 28 days |

## Invariants

1. Whoever fills an order chooses only the order id, the fill amount, where the fill comes from (a route, a filler,
   another vault's order or a payer) and the fee recipient. The tokens, the limit, the amount and where the output
   goes are fixed when the owner signs the order.
2. The output of a fill goes to the owner's vault or the owner's wallet, never anywhere else. The executor's fee is at
   most the cap for the bought token and is taken only from output above the owner's minimum.
3. `amount_out_min = ceil(fill × 10⁷ / limit_price)`. The vault measures what it received instead of trusting the
   router, the filler, the other vault or the payer. The same minimum applies on every route.
4. A fill hands over exactly the amount being filled and nothing else. A filler or another vault acts with no
   authority over the vault beyond that one transfer.
5. If the limit is not met, the price impact limit of the built-in route is exceeded or Blend lacks cash, the whole
   transaction reverts, including the Blend withdrawal.
6. Per token: `balance = Blend share + idle`; `free = balance − reserved − buffer`. Orders and withdrawals are limited to
   `free`, so the same balance cannot back two orders.
7. Fills satisfy `min_fill ≤ fill ≤ remaining`; only the fill that completes an order may be smaller than `min_fill`.
   A scheduled order cannot fill before its part is due, and a fill is always exactly one part.
8. The owner can cancel and withdraw at any time, independently of any keeper (a withdrawal can wait if Blend is short
   on cash). No key can move a vault's funds, and vaults have no upgrade function.
9. The factory guardian can pause new vaults and new orders and edit the allowed token list. Withdrawals,
   cancellations and fills of existing orders keep working, and removing a token does not affect open orders.
10. No fill needs a signature from the owner; the vault authorizes its own transfers, one exact transfer at a time.

## Development

Requirements: Rust with the `wasm32v1-none` target, Stellar CLI, Node.js 20+.

```bash
bash scripts/test.sh               # build the contracts and run the contract tests
bash web/dev.sh                    # run the website and app locally on http://localhost:5173
bash keeper/run.sh                 # run the keeper (reads its key from the Stellar CLI key store)
```

Contract tests use mock Blend, router, oracle and venue contracts with real authorization checks. The
`scripts/trial-*.sh` scripts exercise the deployed contracts on testnet against the real Blend pool and real pools:
`trial-cross.sh` (two orders filling each other), `trial-dca.sh` (a scheduled order), `trial-venue.sh` (a fill through
the filler along another venue's pools, simulated) and `trial-batch.sh` (the experimental batch contract, in a separate
trial factory).

Secrets (keeper key, bot token, invite codes) live outside the repository and are never committed.

## Verification so far

| Question | Result |
|---|---|
| Contract tests (24 November 2026) | Vault 33 of 33, factory 10 of 10, filler 6 of 6, batch 2 of 2; the earlier design's 69 tests still pass (mock pool, router, oracle and venues) |
| Do the Blend withdrawal, the swap and the re-supply fit in one transaction? | Yes, on testnet with the real pool |
| Fills on testnet | Limit orders, scheduled orders, two orders crossed against each other and fills routed through the filler have all gone through in live transactions |
| A route the vault did not ask for, or one that returns too little | Rejected; a route step can only do what was listed for it (filler tests) |
| A token that is not on the allowed list | Order rejected with error 27; accepted after the guardian added the token |
| A token that is not on Blend | The whole balance could be placed into an order and withdrawn (no buffer) |

Not verified yet: an independent audit, behaviour with a production oracle (the testnet oracle returns fixed prices),
and more than one independent keeper.

## Roadmap

- [x] Testnet prototype: vault and factory contracts, keeper, website, docs and app
- [ ] Testnet beta, invite-only (under way): one vault per user for all of their coins; limit, scaled and scheduled
      orders; fills along the best route the keeper finds
- [ ] Open testnet: no invite; a guide for running your own keeper
- [ ] Independent security audit of the vault, factory and filler contracts, report published
- [ ] Mainnet, only after the audit
- [ ] Later: Iora's own lending pools once liquidity allows, cross-chain orders, limit orders for tokenized stocks
      (the cash behind a buy order earns while it waits; a share itself earns only if a lending pool lists it), more
      pairs, integrations

## Security

This is unaudited software running on testnet. If you find a vulnerability, please report it privately to
hello@iorafi.com with the subject "Security" instead of opening a public issue, and give us time to fix it.

Known limitations are listed in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md). The most important one: whoever fills an
order can capture the price improvement between the market and the owner's limit, beyond the capped fee, by choosing
the route or by moving a pool inside the same transaction. The owner never receives less than the limit.
