# Iora

**Interest On Resting Assets: limit orders that earn while they wait, on Stellar.**

Iora is a non-custodial limit order app on Stellar (Soroban). You place a limit order as you would on an exchange. Until
the order fills, the funds behind it are supplied to a [Blend](https://blend.capital) lending pool and earn interest.
When the price reaches your limit, your vault withdraws from Blend, swaps on [Soroswap](https://soroswap.finance) and
keeps the result, all in one atomic transaction.

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
3. **Place a limit order.** "Sell this token, buy that one, at this price or better." The amount is reserved for the
   order and keeps earning.
4. **A keeper fills it.** Anyone can call `execute`. When the limit can be met, the vault withdraws the fill amount from
   Blend, swaps it on Soroswap and keeps the output in the vault (or sends it to the owner's wallet, if the owner chose
   that). If the price does not hold, the whole transaction reverts.

What the contract enforces on every fill:

- **The owner's price is the floor.** The vault computes the minimum output from the limit price and checks the amount
  it actually received. Anything less reverts.
- **The caller cannot redirect funds.** Whoever fills an order only chooses the order, the fill amount, an optional
  routing token and the address that receives the fill fee.
- **The fill fee comes from the surplus.** The executor receives at most a fixed cap per fill, and only out of output
  above the owner's limit. At exactly the limit the fee is zero.
- **Only allowed tokens.** Orders may only use tokens on the factory's allowed list, so nobody can be tricked into
  signing an order that buys a fake token.

Other features: partial fills with a minimum fill size, a price impact limit per fill, stop orders driven by the Blend
pool's oracle, and follow-up orders ("buy, then sell") that open a reverse order inside the same vault on each fill.

The app has **Markets**, **Trade** (limit, market and scaled orders, buy and sell), **Portfolio**, **Lend & Borrow**
(direct Blend positions from your wallet) and **Test funds** pages.

## Repository layout

| Path | What it is |
|---|---|
| `contracts/vault` | The vault: one multi-asset vault per owner (Rust, Soroban SDK) |
| `contracts/factory` | The factory: deploys one vault per owner, pause switch, allowed token list, vault list (one chain per bucket, no cap) |
| `contracts/order-vault`, `contracts/vault-factory` | Earlier two-vault design. Still deployed on testnet and still filled by the keeper; not used for new vaults |
| `keeper/` | Node.js keeper: scans vaults, quotes Soroswap routes, fills orders, extends storage TTL |
| `web/` | Website, docs and app (Vite, vanilla JS, Varial wallet, formerly Freighter) |
| `web/api/` | Serverless functions for the beta sign-up form and the invite gate |
| `scripts/` | Build, test, deploy and measurement scripts |
| `docs/THREAT_MODEL.md` | Threat model |

The keeper's and the web app's code comments, the keeper's log messages and the earlier contracts' comments are in
Turkish. The current contracts, their tests, the scripts, this README and the threat model are in English.

## Testnet deployment

| Contract | Address |
|---|---|
| Vault factory (version 9) | `CAJCXP5WEK5MNRT2BITI5YD57RILKWFNTFQGUFZSZRLCGHMQXPN6RCR5` |
| Previous factory (version 8, still served) | `CDD3XLA3MXDT626AZZKLTLFLQV3XJSYFOZLEQ56B23AQLWNN4JYAKBQ2` |
| Blend pool | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` |
| Soroswap router | `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD` |

Markets on testnet: XLM, BTC, EURC, XRP and XTAR, each against USDC. USDC and XLM are reserves of the testnet Blend
pool and earn interest. BTC, EURC, XRP and XTAR are Soroswap test tokens: the pool does not list them, so they wait in
the vault without earning, and their swap pools are small.

The deployed wasm was built before the source comments were translated to English. Doc comments are part of a Soroban
contract's metadata, so a fresh build of this source has a different wasm hash from the deployed one; the code is the
same.

## Factory interface

| Function | Caller | What it does |
|---|---|---|
| `create_vault(owner)` | owner | Deploys the owner's vault; one per address |
| `vault_of(owner)` | read | The owner's vault address, if any |
| `vault_count()`, `bucket_count()`, `bucket_of(owner)` | read | Number of vaults, number of buckets (256), the bucket an owner falls in |
| `heads(start, limit)` | read | The non-empty buckets among `start..start+limit` (at most 64 per call), each with its newest owner and vault count |
| `bucket(index, from, limit)` | read | The vaults in one bucket, newest first, at most 40 per call. Each entry carries `prev`; pass it as `from` to read on. A bucket is a chain with no cap, so it cannot be filled to block new vaults (version 9; version 8 used `bucket(index)` and `vaults_in`) |
| `extend_ttl(index, from, limit)` | anyone | Extends the storage lifetime of a bucket's head and up to 40 entries along its chain |
| `is_paused()` | read | Whether new vaults and new orders are paused |
| `is_allowed(token)`, `allowed_tokens()` | read | The tokens orders may use |
| `set_paused(bool)`, `set_allowed(token, bool)`, `propose_guardian(addr)` | guardian | A new guardian must call `accept_guardian` |

The factory's pool, router, vault wasm hash and fee caps are fixed at deployment. Vaults cannot be upgraded.

## Vault interface

| Function | Caller | What it does |
|---|---|---|
| `deposit(token, amount)` | owner | Takes `token` from the owner's wallet. Supplied to Blend at once if the pool has a reserve for it; otherwise it waits in the vault |
| `withdraw(token, amount)` | owner | Withdraws up to the free balance of `token`. The amount 2¹²⁷ − 1 withdraws everything free, including interest accrued after signing |
| `place_order(sell, buy, amount_in, limit_price, min_fill, max_impact_bps, expiry, keep)` → id | owner | Sells `amount_in` of `sell` for `buy`, paying at most `limit_price` per unit bought. `keep`: the output stays in the vault (true) or goes to the owner's wallet (false) |
| `place_stop_order(sell, buy, amount_in, trigger_price, limit_price, min_fill, max_impact_bps, expiry, band_bps, keep)` → id | owner | Fills only while the oracle price is at or past `trigger_price`; `limit_price` still caps the worst price. `band_bps` (50 to 1,000) is how far below the oracle-fair amount a fill may be |
| `place_order_then(sell, buy, amount_in, limit_price, min_fill, max_impact_bps, expiry, then_limit, then_impact_bps, then_duration)` → id | owner | A limit order whose output is placed into a reverse order in the same vault on each fill. The reverse order may not sell below the buy price. If it cannot be opened, the fill still happens |
| `cancel_order(id)` | owner | Cancels and releases the unfilled amount. Anyone may close an order that has expired; that only releases the amount to the owner's free balance |
| `execute(executor, id, fill_amount, via)` → amount_out | anyone | Fills an order or part of it. `via` is empty for the direct pair, or one allowed token to route through (for example USDC → XLM → BTC). `executor` receives the fill fee |
| `claim_rewards(reserve_token_ids)` → amount | owner | Sends Blend's BLND rewards to the owner's wallet |
| `forget(token)` | owner | Takes a token the vault no longer holds off its list, freeing one of its 12 places (version 9) |
| `positions()`, `position(token)`, `tokens()` | read | Per token: balance (Blend share plus idle), idle part, reserved, free, principal, and whether it earns on Blend |
| `balance`, `free_balance`, `orderable_balance`, `reserved`, `deposited`, `stats` (each takes `token`); `get_order`, `order_count`, `get_config`, `get_follow_up`, `version` | read | |

### Units

- Every token in a vault must use 7 decimals (1 USDC = 10,000,000). A vault holds at most 12 different tokens.
- `limit_price` is the maximum amount of the `sell` token paid for 1 unit of the `buy` token, with 7 decimals. Buying a
  coin at 0.20 USDC per coin: `2000000`. Selling a coin for USDC at `p` USDC per coin: `floor(10¹⁴ / p_units)`.
- Minimum output: `ceil(fill_amount × 10⁷ / limit_price)` units of the `buy` token.
- `max_impact_bps` is 1 to 10,000; 10,000 disables the impact check.
- `expiry` is a Unix timestamp in seconds, in the future and at most 366 days ahead.
- `min_fill` must be at least one twentieth of `amount_in`, so an order fills in at most 20 pieces. A partial fill may
  not leave a remainder smaller than `min_fill`.
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
| `order_cancelled` (topic: id) | `remaining` |
| `order_filled` (topic: id) | `amount_in`, `amount_out`, `kept` |
| `exec_fee_paid` (topic: id) | `executor`, `amount` |
| `follow_opened` (topic: id) | `new_order_id`, `amount` |
| `held` (topic: id) | `amount`: the owner's wallet could not receive the output, so it stayed in the vault |
| `rewards_claimed` | `amount` |
| `vault_created` (factory; topic: owner) | `vault`, `bucket` |
| `token_allowed` (factory; topic: token) | `allowed` |

### Error codes

| Code | Name | Meaning |
|---|---|---|
| 1 | `InvalidAmount` | Amount is zero or negative, or the minimum fill is larger than the amount |
| 2 | `InsufficientFree` | Not enough free balance |
| 3 | `OrderNotFound` | No order with this id |
| 4 | `OrderNotOpen` | The order is already filled or cancelled |
| 5 | `OrderExpired` | The order's lifetime has passed |
| 6 | `FillTooSmall` | The fill is below the minimum fill, or would leave a remainder smaller than it |
| 7 | `FillTooLarge` | The fill is larger than the unfilled amount |
| 8 | `LimitNotMet` | The swap returned less than the limit requires |
| 9 | `InvalidPrice` | The limit price is not valid |
| 10 | `PoolShortfall` | Blend returned less than requested |
| 11 | `InvalidExpiry` | The expiry is not valid |
| 12 | `BlendFormat` | Unexpected data format from Blend |
| 13 | `ImpactTooHigh` | The fill would move the pool price more than allowed |
| 14 | `InvalidImpact` | The price impact limit is outside 1 to 10,000 bps |
| 15 | `Paused` | New orders are paused |
| 16 | `TriggerNotMet` | Stop order: the oracle price has not reached the trigger |
| 18 | `InvalidFollowUp` | Invalid follow-up order settings |
| 19 | `OracleUnavailable` | Stop order: no oracle price, or it is older than 10 minutes |
| 20 | `PriceDeviation` | Stop order: the fill would be further below the oracle price than the band allows |
| 21 | `SameToken` | The token sold and the token bought must differ |
| 23 | `BadDecimals` | Every token in the vault must use 7 decimals |
| 24 | `InvalidBand` | Stop order: `band_bps` must be between 50 and 1,000 |
| 25 | `InvalidFee` | Setup: a fill fee cap cannot be negative |
| 26 | `TooManyTokens` | A vault holds at most 12 different tokens |
| 27 | `TokenNotAllowed` | The token is not on the factory's allowed list |
| 28 | `InvalidPath` | The routing token is the token sold or the token bought |
| 29 | `TokenInUse` | `forget`: the vault still holds the token, or an open order still sells it (version 9) |

## Invariants

1. Whoever calls `execute` chooses only the order id, the fill amount, an optional routing token and the fee recipient.
   The tokens, the limit, the amount and where the output goes are fixed when the owner signs the order.
2. The output of a fill goes to the owner's vault or the owner's wallet, never anywhere else. The executor's fee is at
   most the cap for the bought token and is taken only from output above the owner's minimum.
3. `amount_out_min = ceil(fill × 10⁷ / limit_price)`. The vault measures what it received instead of trusting the
   router. The same minimum applies on a direct route and on a routed one.
4. If the limit is not met, the price impact limit is exceeded or Blend lacks cash, the whole transaction reverts,
   including the Blend withdrawal.
5. Per token: `balance = Blend share + idle`; `free = balance − reserved − buffer`. Orders and withdrawals are limited to
   `free`, so the same balance cannot back two orders.
6. Fills satisfy `min_fill ≤ fill ≤ remaining`; only the fill that completes an order may be smaller than `min_fill`.
7. The owner can cancel and withdraw at any time, independently of any keeper (a withdrawal can wait if Blend is short
   on cash). No key can move a vault's funds, and vaults have no upgrade function.
8. The factory guardian can pause new vaults and new orders and edit the allowed token list. Withdrawals,
   cancellations and fills of existing orders keep working, and removing a token does not affect open orders.
9. `execute` needs no signature from the owner; the vault authorizes its own transfers inside Blend and Soroswap.

## Development

Requirements: Rust with the `wasm32v1-none` target, Stellar CLI, Node.js 20+.

```bash
bash scripts/test.sh               # build the contracts and run the contract tests
bash web/dev.sh                    # run the website and app locally on http://localhost:5173
bash keeper/run.sh                 # run the keeper (reads its key from the Stellar CLI key store)
```

Contract tests use mock Blend, Soroswap and oracle contracts with real authorization checks. `scripts/trial-v8.sh`
deploys a separate trial factory on testnet and exercises the vault against the real Blend pool and Soroswap pools.

Secrets (keeper key, bot token, invite codes) live outside the repository and are never committed.

## Verification so far

| Question | Result |
|---|---|
| Contract tests | Vault 20 of 20, factory 9 of 9 (mock pool, router and oracle) |
| Do the Blend withdrawal, the swap and the re-supply fit in one transaction? | Yes, on testnet with the real pool |
| Direct fill and routed fill (USDC → XLM → BTC) on real pools | Both filled; an invalid route was rejected with error 28 |
| A token that is not on the allowed list | Order rejected with error 27; accepted after the guardian added the token |
| A token that is not on Blend | The whole balance could be placed into an order and withdrawn (no buffer) |
| End to end with a real wallet | Open vault, deposit two assets; balances confirmed on chain |

Not verified yet: an independent audit, behaviour with a production oracle (the testnet oracle returns fixed prices),
and more than one independent keeper.

## Roadmap

- [x] Testnet prototype: vault and factory contracts, keeper, website, docs and app
- [ ] Testnet beta, invite-only (under way): single multi-asset vault, five markets against USDC, routed fills
- [ ] Open testnet: no invite; a guide for running your own keeper
- [ ] Independent security audit, report published
- [ ] Mainnet, only after the audit
- [ ] Later: Iora's own lending pools once liquidity allows, cross-chain orders, more pairs, integrations

## Security

This is unaudited software running on testnet. If you find a vulnerability, please report it privately to
hello@iorafi.com with the subject "Security" instead of opening a public issue, and give us time to fix it.

Known limitations are listed in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md). The most important one: whoever fills an
order can capture the price improvement between the market and the owner's limit, beyond the capped fee, by moving the
pool inside the same transaction. The owner never receives less than the limit.
