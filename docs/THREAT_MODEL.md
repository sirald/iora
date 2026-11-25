# Threat model

Scope: the `vault` contract (one multi-asset vault per user), the `factory` contract, the `filler` contract, the Blend
v2 pool the vaults supply to, the trading venues a fill goes through, the Blend pool's price oracle (stop orders and
banded scheduled orders only) and the keeper.

This is a working document written by the project itself, not an audit. Each claim should be matched to a test or a
testnet trial; where it is not, that is said. Last updated: 25 November 2026, vault version 13, filler version 3.

## Actors and trust

| Actor | What it can do | Trust |
|---|---|---|
| Vault owner | Deposit, withdraw, place and cancel orders, claim rewards | Full (their own funds) |
| Keeper / anyone | Fill an order: `fill_via`, `cross`, `take`, `execute`; close an order whose `expiry` time has passed; extend storage TTL | Untrusted |
| Filler contract (`fill_via`) | Receives the amount being filled, trades it along the route it is given, sends the proceeds back | Untrusted: any contract can be named; the vault checks the result itself |
| Other vault (`cross`), payer (`take`) | Delivers the bought token against the sold one | Untrusted: the vault checks what arrived |
| Blend pool | Holds the principal of assets it lists | Partial: pool risk is principal risk |
| Trading venues (pools and routers) | Perform the swap | Untrusted: the vault checks the output itself |
| Guardian (factory) | Pause new vaults and new orders; edit the allowed token list; hand over the role in two steps | Partial: cannot move funds, cannot change code |
| Price oracle (the Blend pool's) | Sets the trigger and the deviation band of stop orders, and the band of a scheduled order that has one | Partial: only those orders depend on it |

## Threats

### T1. The executor redirects funds
The tokens, the amount, the limit and the destination of the output are fixed when the owner signs the order. A fill's
output can go to two places, both the owner's: the vault itself (the default, or when the owner's wallet cannot
receive the token) or the owner's wallet. The executor names an `executor` address that may receive a fee: at most the
cap for the bought token, and only out of output above the owner's minimum (for a stop order or a banded scheduled
order, above the larger of the limit and the oracle band). If the fee transfer fails the owner keeps it. This is the
same on every fill path, because all four end in the same settlement code.
Evidence: `exec_fee_comes_only_from_price_improvement`, `exec_fee_is_zero_at_the_limit`,
`exec_fee_on_stop_order_respects_oracle_band`, `filler_fill_pays_the_fee_only_from_what_beats_the_limit`,
`order_can_send_output_to_wallet`, `output_stays_in_vault_when_wallet_cannot_receive`.

### T2. The executor fills at a bad price
`amount_out_min = ceil(fill × 10^7 / limit_price)`. On every path the vault measures the balance it received and
reverts with `LimitNotMet` if it is short: after the built-in route's swap (`execute`, which also passes the minimum
to the router), after a filler's route (`fill_via`), after the other vault paid (`cross`) and after a payer paid
(`take`).
Evidence: `order_rules`, `buy_order_keeps_output_in_vault_earning`, `take_fills_an_order_without_a_pool`,
`cross_cannot_break_either_limit`, `fill_through_a_filler_contract`; testnet fills on each path.

### T3. Capturing the price improvement inside the limit
The owner never gets a worse price than the limit. But when the market is better than the limit, whoever fills the
order can keep the difference.
- With `take` nothing has to be moved at all: anyone may pay exactly what the limit asks and receive the sold token.
  An order whose limit is through the market is an offer anyone can accept at the limit.
- With `fill_via` the caller picks the filler and the route, so it can pick one that returns exactly the minimum.
- With the built-in route a caller's own contract can do "move the price, `execute`, move it back" atomically and fund
  it with a flash loan. A sandwich is possible in a single transaction.
- What is lost is only the improvement between the market and the limit. It matters most for orders placed at or
  through the market and during sudden price moves.
- `max_impact_bps` does not prevent this. It applies to the built-in route only and measures the price impact of one
  fill against the pool depth at the time of the fill, which stops a large fill from being pushed into a shallow pool.
  An attacker moves the price first, and the check then passes on the moved pool. The only hard protection is the
  limit price.
- An order fills in at most 20 pieces (`MAX_FILLS`), so the impact limit cannot be bypassed by splitting, and a fill
  cannot leave a remainder smaller than the minimum fill.
- The project's keeper passes everything a route returns on to the owner, less the capped fee. That is the keeper's
  behaviour, not a guarantee of the contract.
Evidence: `order_rules`.
Open: plain orders have no external price reference. Options before mainnet: a bound relative to an oracle price,
restricting fills to approved keepers, or accepting and documenting the risk. To be decided with an auditor.

### T4. Routing through intermediate tokens
On the built-in route the executor may pass `via` to route a fill through one extra token (sell → via → buy). Limits:
`via` must be on the factory's allowed list and cannot be the token sold or bought; the vault authorizes exactly one
transfer, to the first pair. On a filler's route (`fill_via`) the vault does not look at the route at all: it may use
any pools and any intermediate tokens. On both, the owner's minimum output is the same on any route, so a bad route
can only reduce the improvement above the limit (see T3), never the limit itself.
Evidence: `fill_through_an_intermediate_token`, `fill_through_a_filler_contract`, testnet trial (direct and routed
fills, invalid route rejected).

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
not been touched for a long time (the vault, its open orders, their follow-up settings and their schedules), and the
factory lets anyone extend its list entries. If records are archived anyway, the app asks the owner to sign a one-time
restore. The restore path has not been exercised on a real network.

### T11. Authorization chain
Where a contract the vault calls has to move the vault's tokens (Blend, the built-in route's first pair, the other
vault in `cross`), the vault authorizes it with `authorize_as_current_contract`. The authorization applies only to
the next call and to one exact transfer. On `fill_via` the vault makes the transfer itself and authorizes nothing: the
filler acts with no rights over the vault. Soroban does not let a contract be called again while it is running, so
neither a filler nor a venue can call back into the vault in the middle of a fill.
Evidence: `buy_order_keeps_output_in_vault_earning` and the `cross` and filler tests run with real authorization
checks and no signature from the executor.

### T12. Oracle-bound orders: the oracle, and the executor moving a pool
A stop order's trigger is read from the Blend pool's oracle, not from a pool's spot price, so it cannot be moved
inside one transaction. The executor can still try to fill at a bad price. Limits:
- A fill may be below the oracle-fair amount by at most `stop_band_bps`, chosen by the owner between 0.5% and 10%. The
  band includes the swap fee and price impact. A narrow band means a better price; a wide band means a better chance
  of filling in a sharp move. In the worst case the executor captures the part of the band not used by fees. The band
  is checked on every fill path.
- `limit_price` is always the worst price and can be at most 10% beyond the trigger.
- The order does not run if the oracle price is older than 10 minutes or timestamped in the future.
Accepted limits: (a) if the price jumps past both trigger and limit in one move, the order waits; (b) the trigger does
not latch; (c) a late oracle update delays the stop; (d) a wrong oracle price can trigger the order at the wrong time,
though never below the limit. The testnet oracle returns fixed prices, so oracle-bound orders still need testing
against a production oracle; the app keeps stop loss switched off on testnet. Tokens the oracle does not price cannot
use these orders.
Evidence: `exec_fee_on_stop_order_respects_oracle_band`, `dca_without_a_price_limit_is_held_to_the_oracle_band`. The
detailed stop tests (manipulated pool price, stale oracle, band validation) exist for the earlier contract, whose stop
logic was carried over; they have not all been ported to the current vault's suite.

### T13. Follow-up orders ("buy, then sell")
On each fill the output is placed into a reverse order in the same vault. There is no second vault and no transfer
between contracts, so there is no target address to forge.
- The reverse order cannot sell below the buy price (`limit × then_limit ≤ 1`).
- Opening the reverse order never blocks the fill. If it cannot be opened (new orders paused, token removed from the
  allowed list, amount too small), the output stays in the vault as free balance.
- The reverse order can fill in up to 20 pieces.
Evidence: `buy_then_sell_inside_one_vault`, `follow_up_cannot_sell_below_buy_price`,
`pause_blocks_new_orders_but_not_fills_or_withdrawals`.

### T14. An order's `expiry` time
Every order carries an `expiry` time chosen by its owner, with no upper limit; the app passes the largest value, so
the orders it places stay open until they fill or are cancelled. An order placed with an earlier time (through another
tool) cannot fill after that time, but its amount stays reserved until it is closed. Anyone can close it then; that
only releases the amount to the owner's free balance. Before that time only the owner can cancel. Price is capped at
10^9, and a follow-up order's duration at about 100 years, both against overflow.
Evidence: `only_owner_moves_funds`, `order_rules`, `an_order_can_stay_open_for_as_long_as_the_owner_wants`.

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
- If no keeper runs, orders do not fill. Funds stay safe and withdrawable, and anyone can fill. Today one keeper runs,
  operated by the project. This is a liveness risk, not a safety risk.
- A hostile user can open many vaults and small orders to make keepers spend fees. The keeper's defences: a free
  simulation of price and impact before every fill, a per-vault limit per scan, exponential back-off for orders that
  are rejected or fail on chain, a minimum fill size, and no fill until the surplus covers the fee.
- Fee caps are per bought token and are copied into each vault when it is created. A token added to the allowed list
  later has no fee cap in existing vaults, so fills that buy it pay the executor nothing.
- The keeper sends fills from several accounts derived from its key so that more than one fill fits in a ledger. The
  fee always goes to the main account; a worker account holds only XLM for network fees.

### T18. Factory and deployment
- The factory's settings (vault code hash, pool, router, fee caps) cannot be changed, and vaults cannot be upgraded. A
  mistake is fixed by deploying a new factory; existing vaults keep working and are not migrated. Owners move by
  themselves: the app withdraws from the old vault and deposits into the new one with their signatures. Until they do,
  an old vault keeps the rules of its own version, and the keeper keeps filling the old factories.
- Opening a vault writes only entries derived from the owner's address, so vault creations do not contend with each
  other. Since version 9 a bucket of the vault list is a chain with no cap. In version 8 (still served for vaults
  opened there) a bucket holds at most 400 vaults, so a bucket could be filled on purpose to stop owners who fall into
  it from opening a vault; new vaults are no longer opened there.
- Empty vaults cost the keeper nothing per scan: it reads a vault when an order event names it, when it has an open
  order, and otherwise in a slow rotating sweep.
- A vault holds at most 12 tokens, each with 7 decimals. The owner can take a token the vault no longer holds off the
  list (`forget`).
- The guardian is a single key today. Before mainnet it should be a multisig account.
- The code hash running on chain should be checked against the audited build at release time. Not automated yet.
Evidence: `create_vault_sets_up_owned_vault`, `one_vault_per_owner_and_distinct_addresses`, `listing_and_ttl`,
`many_vaults_in_one_bucket_form_a_chain`, `only_guardian_controls_pause`, `guardian_change_needs_acceptance`,
`create_requires_owner_signature`.

### T19. A hostile filler or route (`fill_via`)
Any address can be named as the filler. The vault sends it exactly the amount being filled, calls its `swap` and then
counts its own balance of the bought token.
- The most a filler can take is the amount of that one fill, and only by returning less than the minimum, which
  undoes the whole transaction. It has no rights over anything else in the vault (T11).
- The order must be open and the fill size allowed, a scheduled order must be due, and a stop order's trigger and band
  are checked, exactly as on the other paths. A vault cannot name itself.
- Whatever a filler sends back of the sold token stays in the vault as the owner's balance.
- The order's price impact setting is not applied on this path; the limit (and the band, where an order has one) is
  the protection. See T3 for what that leaves open.
Evidence: `fill_through_a_filler_contract`, `filler_fill_pays_the_fee_only_from_what_beats_the_limit`.

### T20. The filler contract itself
The project's filler has no owner, no settings and no storage. It runs the route it is given, one plain contract call
after another, and then sends everything it holds of the two tokens to the address the caller named.
- Its `swap` can be called by anyone and pays out whatever it holds, so it must hold nothing between transactions. It
  does not: a vault's `fill_via` and a wallet's `swap_from` both put funds in and take them out in one transaction.
- It runs arbitrary calls, so it must never be given a standing right such as a token allowance: anyone could spend it
  through a route. The app never asks for one. For a market swap the wallet signs `swap_from`, which covers the exact
  amount taken, the route and the minimum returned.
- A route step can act in the filler's name only for the calls listed with that step, each once and for exactly those
  arguments.
- A market swap is as good as the minimum the app puts into it. The wallet's signing window shows the call, not what
  it means; this is website risk (T23), not something the filler can check.
Evidence (filler suite): `routes_through_two_venues_and_pays_everything_out`,
`a_step_can_only_do_what_was_listed_for_it`, `an_empty_route_just_returns_what_it_holds`,
`a_router_that_calls_a_pool_for_its_caller`, `a_route_through_an_intermediate_token_sweeps_what_is_left_of_it`,
`a_wallet_swaps_through_the_filler_with_a_minimum`.

### T21. Fills without a pool (`take`, `cross`)
- `take`: the payer signs for the payment, the vault counts what arrived and only then releases the sold token. The
  payment must cover what the limit promises for the amount taken.
- `cross`: the vault authorizes one transfer (the amount being filled, to the other contract), calls that contract's
  `take` and counts what it received. The other contract does not have to be an Iora vault; if it is not, it is in the
  position of a filler (T19): it can keep at most the amount of that fill, and only if the transaction succeeds, which
  requires this vault's minimum to have arrived.
- When two orders overlap, the contract accepts any price inside the overlap. The project's keeper uses the pool's
  middle price and crosses only if both owners do at least as well as in a pool; that is the keeper's policy. A
  different caller could instead take each order at its own limit and keep the overlap (T3).
- Stop orders and scheduled orders keep their trigger, band and schedule on these paths.
Evidence: `take_fills_an_order_without_a_pool`, `two_vaults_cross_without_a_pool`,
`cross_shares_the_overlap_and_pays_the_fee_from_it`, `cross_cannot_break_either_limit`.

### T22. Scheduled orders (DCA)
- The schedule is enforced by the vault: a part cannot fill before it is due (`TooEarly`), a fill is always exactly
  one part, and a part that fills late does not bring the following parts forward.
- Only one part is reserved at a time. The next one is reserved at the moment a part fills, if the free balance
  covers it; if not, the plan ends. An owner who withdraws the rest therefore ends the plan, and a later deposit does
  not restart it.
- A plan needs price protection: either a limit price or an oracle band (0.5% to 10%). With only a band, a part
  depends on the oracle as a stop order does (T12).
- If no keeper fills a part in its interval, that part is simply late; missed parts do not add up.
Evidence: `dca_buys_one_part_at_a_time_until_the_vault_runs_out`, `dca_with_a_fixed_number_of_parts_and_a_late_fill`,
`dca_sell_waits_while_the_price_is_below_the_floor`, `dca_without_a_price_limit_is_held_to_the_oracle_band`,
`dca_rules`; testnet trial (`scripts/trial-dca.sh`).

### T23. Website, access gate and RPC servers
- The contracts cannot protect an owner who signs a bad order. A compromised or imitated website could build one (a
  limit far from the market, a market swap with no minimum). The wallet's signing window is the last check.
- The invite gate of the testnet app is an entry gate, not a security boundary: the contracts are public and can be
  called without the site.
- The site reads through public RPC servers and remembers some answers in the browser for a short time. A wrong or
  stale answer can show a wrong balance or price; it cannot move funds, because every transaction is simulated again
  and signed in the wallet.
- If the site or the RPC servers are down, an owner can still cancel and withdraw with any Soroban tool.

## Known gaps

- No independent audit. The contracts have only been reviewed by the project itself.
- No external price reference for plain limit orders, and the caller chooses the route (T3, T19).
- The filler and routed fills are the newest part (version 13). They have run on testnet pools only.
- Oracle-bound orders are untested against a production oracle, and the current vault's suite does not repeat all the
  stop tests of the earlier contract (T12).
- The Blend liquidity shortfall path is tested for the earlier contract only (T7).
- The archive restore path is untested on a real network (T10).
- Blend limits the number of positions per account. The vault has only been exercised with two pool reserves.
- One keeper, one guardian key (T17, T18).

## Decisions to take before an audit

Protocol fee (on interest or on fills) and its caps, treasury address, keeper reward level, minimum order size, launch
limits, how the guardian role is held, and whether fills should be bound to a price reference or to approved fillers
(T3, T19). These change how funds flow, so they should be settled and in the code before an audit starts.
