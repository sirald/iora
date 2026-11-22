# Threat model

Scope: the `vault` contract (one multi-asset vault per user), the `factory` contract, the Blend v2 pool the vaults
supply to, the Soroswap router, the Blend pool's price oracle (stop orders only) and the keeper.

This is a working document written by the project itself, not an audit. Each claim should be matched to a test or a
testnet trial; where it is not, that is said. Last updated: 22 November 2026, contract version 9.

## Actors and trust

| Actor | What it can do | Trust |
|---|---|---|
| Vault owner | Deposit, withdraw, place and cancel orders, claim rewards | Full (their own funds) |
| Keeper / anyone | `execute(executor, order_id, fill_amount, via)`; close an expired order with `cancel_order`; extend storage TTL | Untrusted |
| Blend pool | Holds the principal of assets it lists | Partial: pool risk is principal risk |
| Soroswap router and pairs | Perform the swap | Untrusted: the vault checks the output itself |
| Guardian (factory) | Pause new vaults and new orders; edit the allowed token list; hand over the role in two steps | Partial: cannot move funds, cannot change code |
| Price oracle (the Blend pool's) | Sets the trigger and the deviation band of stop orders | Partial: only stop orders depend on it |

## Threats

### T1. The executor redirects funds
The tokens, the amount, the limit and the destination of the output are fixed when the owner signs the order. A fill's
output can go to two places, both the owner's: the vault itself (the default, or when the owner's wallet cannot
receive the token) or the owner's wallet. The executor names an `executor` address that may receive a fee: at most the
cap for the bought token, and only out of output above the owner's minimum (for a stop order, above the larger of the
limit and the oracle band). If the fee transfer fails the owner keeps it.
Evidence: `exec_fee_comes_only_from_price_improvement`, `exec_fee_is_zero_at_the_limit`,
`exec_fee_on_stop_order_respects_oracle_band`, `order_can_send_output_to_wallet`,
`output_stays_in_vault_when_wallet_cannot_receive`.

### T2. The executor fills at a bad price
`amount_out_min = ceil(fill × 10^7 / limit_price)` is passed to the router, and the vault also measures the balance it
received and reverts with `LimitNotMet` if it is short.
Evidence: `order_rules`, `buy_order_keeps_output_in_vault_earning`, testnet trial (`scripts/trial-v8.sh`).

### T3. Capturing the price improvement inside the limit (sandwich)
The owner never gets a worse price than the limit. But when the market is better than the limit, someone can move the
pool price up to the limit and fill the order at that moment, keeping the difference.
- A Soroban transaction contains one contract call, but that call can be the attacker's own contract, which can do
  "move the price, `execute`, move it back" atomically and fund it with a flash loan. A sandwich is possible in a
  single transaction.
- What is lost is only the improvement between the market and the limit. It matters most for orders placed at or
  through the market and during sudden price moves.
- `max_impact_bps` does not prevent this. It measures the price impact of one fill against the pool depth at the time
  of the fill, which stops a large fill from being pushed into a shallow pool. An attacker moves the price first, and
  the check then passes on the moved pool. The only hard protection against a sandwich is the limit price.
- An order fills in at most 20 pieces (`MAX_FILLS`), so the impact limit cannot be bypassed by splitting, and a fill
  cannot leave a remainder smaller than the minimum fill.
Evidence: `order_rules`.
Open: plain orders have no external price reference. Options before mainnet: a bound relative to an oracle price,
restricting `execute` to approved keepers, or accepting and documenting the risk. To be decided with an auditor.

### T4. Routing through an intermediate token
The executor may pass `via` to route a fill through one extra token (sell → via → buy). The executor picks the route,
so it can pick a bad one. Limits: the owner's minimum output is the same on any route; `via` must be on the factory's
allowed list and cannot be the token sold or bought; the vault authorizes exactly one transfer, to the first pair.
A bad route can therefore only reduce the improvement above the limit (see T3), never the limit itself.
Evidence: `fill_through_an_intermediate_token`, testnet trial (direct and routed fills, invalid route rejected).

### T5. Spending the same balance twice
Per token, `reserved ≤ balance`. Placing an order and withdrawing are both limited to
`free = balance − reserved − buffer`. An order that sells one token never ties up another.
Evidence: `reserves_are_tracked_per_token`, `only_owner_moves_funds`.

### T6. Rounding leaves a reservation short
Blend rounds the burned b_tokens up on every withdrawal, so each fill can reduce the reserve by slightly more than the
fill. For an asset with a share on Blend, 10,000 units (0.001 token) can never be placed into an order and cannot be
withdrawn while an order is open; with at most 20 fills per order this covers the rounding of many concurrent orders.
If the buffer is ever exceeded, the last piece waits with `PoolShortfall` until interest accrues or the owner cancels
and replaces the order. No funds are lost. Tokens that are not on Blend sit in the vault as plain balances, lose
nothing to rounding and have no buffer.
Evidence: `reserves_are_tracked_per_token`, `non_reserve_token_waits_idle_and_can_be_traded`.

### T7. Blend lacks liquidity, or utilisation is pushed up on purpose
If the withdrawal fails the transaction reverts and the order waits; a keeper can retry with a smaller fill. The owner
may be unable to withdraw their own funds for a while. This is part of pool risk.
Evidence: covered in the earlier contract's suite (`low_blend_liquidity_reverts_then_partial_succeeds`); not repeated
for the current vault.

### T8. Loss in the Blend pool (oracle failure, bad debt)
Principal risk. Every vault supplies to the same pool, so a loss there affects every depositor. Iora does not control
the pool, its oracle or its backstop and cannot make up such a loss. Interest can be negative; the free balance never
goes below zero. Choosing the pool is a trust decision and the app must state the risk.

### T9. Blend changes its interface
The vault reads only the fields it needs from Blend's return structs (`config.index`, `data.b_rate`, the supply
position). If a field is missing it stops with `BlendFormat` instead of computing a wrong number.

### T10. Storage expires (TTL)
Every call extends the vault instance and the records it touches by about 30 days. The keeper extends vaults that have
not been touched for a long time, and the factory lets anyone extend its list entries. If records are archived anyway,
the app asks the owner to sign a one-time restore. The restore path has not been exercised on a real network.

### T11. Authorization chain
The vault authorizes its own token transfers inside Blend and Soroswap with `authorize_as_current_contract`. The
authorization applies only to the next call and to one exact transfer.
Evidence: `buy_order_keeps_output_in_vault_earning` runs with real authorization checks and no signature from the executor.

### T12. Stop orders: the oracle, and the executor moving the pool
The trigger is read from the Blend pool's oracle, not from Soroswap's spot price, so it cannot be moved inside one
transaction. The executor can still try to move the pool and fill at a bad price. Limits:
- A fill may be below the oracle-fair amount by at most `stop_band_bps`, chosen by the owner between 0.5% and 10%. The
  band includes the swap fee and price impact. A narrow band means a better price; a wide band means a better chance
  of filling in a sharp move. In the worst case the executor captures the part of the band not used by fees.
- `limit_price` is always the worst price and can be at most 10% beyond the trigger.
- The order does not run if the oracle price is older than 10 minutes or timestamped in the future.
Accepted limits: (a) if the price jumps past both trigger and limit in one move, the order waits; (b) the trigger does
not latch; (c) a late oracle update delays the stop; (d) a wrong oracle price can trigger the order at the wrong time,
though never below the limit. The testnet oracle returns fixed prices, so stop orders still need testing against a
production oracle. Tokens the oracle does not price cannot use stop orders.
Evidence: `exec_fee_on_stop_order_respects_oracle_band`. The detailed stop tests (manipulated pool price, stale
oracle, band validation) exist for the earlier contract, whose stop logic was carried over; they have not all been
ported to the current vault's suite.

### T13. Follow-up orders ("buy, then sell")
On each fill the output is placed into a reverse order in the same vault. There is no second vault and no transfer
between contracts, so there is no target address to forge.
- The reverse order cannot sell below the buy price (`limit × then_limit ≤ 1`).
- Opening the reverse order never blocks the fill. If it cannot be opened (new orders paused, token removed from the
  allowed list, amount too small), the output stays in the vault as free balance.
- The reverse order can fill in up to 20 pieces.
Evidence: `buy_then_sell_inside_one_vault`, `follow_up_cannot_sell_below_buy_price`,
`pause_blocks_new_orders_but_not_fills_or_withdrawals`.

### T14. An expired order keeps its reservation
An expired order cannot fill, but its amount stays reserved until it is closed. Anyone can close an expired order; that
only releases the amount to the owner's free balance. Order lifetime is capped at 366 days and price at 10^9.
Evidence: `only_owner_moves_funds`, `order_rules`.

### T15. The owner's wallet cannot receive the output
If the owner asked for the output in their wallet and the wallet cannot receive it (no trustline), the fill still goes
through and the token waits in the vault as part of the owner's balance (`Held` event). A withdrawal has no such
fallback: if the wallet cannot receive, the withdrawal reverts and the funds stay where they were.
Evidence: `output_stays_in_vault_when_wallet_cannot_receive`.

### T16. Phishing with a fake token
A vault can hold and trade several tokens, so an attacker could try to get an owner to sign an order that buys a
worthless token, then create a pool for it and fill the order "at the limit". Orders are therefore restricted to
tokens on the factory's allowed list. Deposits and withdrawals are not restricted, so funds can always leave.
Residual risk: the guardian can add a token to the list. Adding a malicious token would still require the owner to
sign an order for it. Removing a token blocks new orders only; open orders keep filling and can be cancelled.
Evidence: `orders_only_between_allowed_tokens`, `allowed_tokens_are_guardian_controlled`, testnet trial.

### T17. Keeper: single point, cost and abuse
- If no keeper runs, orders do not fill. Funds stay safe and withdrawable, and anyone can call `execute`. Today one
  keeper runs, operated by the project. This is a liveness risk, not a safety risk.
- A hostile user can open many vaults and small orders to make keepers spend fees. The keeper's defences: a free
  simulation of price and impact before every fill, a per-vault limit per scan, exponential back-off for orders that
  are rejected or fail on chain, and a minimum fill size.
- Fee caps are per bought token and are copied into each vault when it is created. A token added to the allowed list
  later has no fee cap in existing vaults, so fills that buy it pay the executor nothing.

### T18. Factory and deployment
- The factory's settings (vault code hash, pool, router, fee caps) cannot be changed, and vaults cannot be upgraded. A
  mistake is fixed by deploying a new factory; existing vaults keep working and are not migrated.
- Opening a vault writes only entries derived from the owner's address, so vault creations do not contend with each
  other. In version 9 (the current factory) a bucket is a chain with no cap. In version 8 (the previous factory, still
  served for vaults opened there) a bucket holds at most 400 vaults, so a bucket could be filled on purpose to stop
  owners who fall into it from opening a vault; new vaults are no longer opened there.
- Empty vaults cost the keeper nothing per scan: it reads a vault when an `order_placed` event names it, when it has
  an open order, and otherwise in a slow rotating sweep.
- A vault holds at most 12 tokens, each with 7 decimals. In version 9 the owner can take a token the vault no longer
  holds off the list (`forget`).
- The guardian is a single key today. Before mainnet it should be a multisig account.
- The wasm hash running on chain should be checked against the audited build at release time. Not automated yet.
Evidence: `create_vault_sets_up_owned_vault`, `one_vault_per_owner_and_distinct_addresses`, `listing_and_ttl`,
`only_guardian_controls_pause`, `guardian_change_needs_acceptance`, `create_requires_owner_signature`.

## Known gaps

- No independent audit. The contracts have only been reviewed by the project itself.
- No external price reference for plain limit orders (T3).
- Stop orders are untested against a production oracle, and the current vault's suite does not repeat all the stop
  tests of the earlier contract (T12).
- The Blend liquidity shortfall path is tested for the earlier contract only (T7).
- The archive restore path is untested on a real network (T10).
- Blend limits the number of positions per account. The vault has only been exercised with two pool reserves.
- One keeper, one guardian key (T17, T18).

## Decisions to take before an audit

Protocol fee (on interest or on fills) and its caps, treasury address, keeper reward level, minimum order size, launch
limits, and how the guardian role is held. These change how funds flow, so they should be settled and in the code
before an audit starts.
