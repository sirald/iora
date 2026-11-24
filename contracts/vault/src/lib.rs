//! Iora vault, version 12: ONE multi-asset vault per user.
//!
//! New in version 12 (on top of version 11): an order has no latest expiry. It used to end within a year; now the
//! owner picks any time in the future, or the far end of time for "until I cancel it". Nothing else changed.
//!
//! New in version 11 (on top of version 10): orders on a schedule ("DCA", buying or selling in equal parts).
//! - `place_dca` opens an order that sells one part of a token every `every` seconds, for as long as the vault
//!   can cover the next part (or for a fixed number of parts). Only ONE part is reserved at a time; the rest of
//!   the balance stays free, keeps earning and can be withdrawn. When the vault cannot cover the next part the
//!   plan ends by itself.
//! - The schedule is enforced here, not by the keeper: a part cannot fill before its time, and a fill is always
//!   exactly one part. Everything else is the order as before: anyone may fill it (`execute`, `take`, `cross`),
//!   the owner cancels at any time, and the price limit holds on every part.
//! - A scheduled order can also carry an oracle band (as stop orders do): a part fills only if its output is
//!   within the band of the oracle price at that moment. This protects a plan whose price limit is far away.
//!
//! New in version 10 (on top of version 9): an order can be filled WITHOUT a pool.
//! - `take`: anyone pays the bought token straight into the vault and receives the sold token. The vault checks the
//!   payment itself, so the order's limit holds exactly as in a swap.
//! - `cross`: two opposite orders in two Iora vaults fill each other in one transaction (this vault pays the other
//!   one through its `take`). Neither side pays a pool fee or moves a pool's price; each owner still receives at
//!   least what the limit promises, or nothing moves.
//!
//! New in version 8 (on top of version 7):
//! - Orders may only use tokens on the factory's ALLOWED list (phishing protection: nobody can be
//!   tricked into signing an order that "buys" a worthless or fake token out of the vault).
//! - The rounding buffer applies only to assets held on Blend; a token that waits idle in the vault (not a
//!   pool reserve) has no rounding loss, so it has no buffer (for example 0.001 BTC is not held back).
//! - A fill may route through one intermediate token (`via`), for example USDC -> XLM -> BTC. The intermediate
//!   token must be on the allowed list too; the owner still receives at least what the limit promises.
//! - The reverse leg of a follow-up order can fill in up to MAX_FILLS pieces (previously 4).
//!
//! Earlier versions used two separate vaults for buying and selling (`order-vault`, deployed twice with the
//! tokens swapped). Here one vault holds several assets and an order says "sell this token, buy that one":
//!
//! - Every deposited asset that is a reserve of the Blend pool is supplied to Blend at once and earns interest.
//!   An asset that is not a reserve waits in the vault without earning ("idle"). Balance = Blend share + idle.
//! - When an order fills, the output STAYS IN THE VAULT if the order has `keep` set (supplied to Blend if it is
//!   a reserve, so it keeps earning); otherwise it goes to the owner's wallet.
//! - "Buy, then sell" (a follow-up order) opens as a reverse order inside the same vault; there is no second
//!   vault, no sibling factory and no transfer between vaults.
//! - The fill fee (since version 5) is unchanged: whoever fills an order receives a fee only out of output above
//!   the limit, up to a fixed cap per fill that depends on the bought token. The owner always gets the limit.
//!
//! Guarantees that do not change: only the owner can withdraw; anyone can call `execute`, `take` or `cross`, but
//! the caller only chooses the order, the fill amount, where the fill comes from and the address that receives the fee; the factory
//! (guard) can only stop new orders. Withdrawals, cancellations and fills of existing orders always work.
#![no_std]

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    panic_with_error, token, vec, Address, Env, IntoVal, Map, Symbol, TryFromVal, Val, Vec,
};

/// Prices use 7 decimals (every token in the vault must have 7 decimals).
pub const SCALE: i128 = 10_000_000;
/// Blend's b_rate has 12 decimals.
pub const B_RATE_SCALE: i128 = 1_000_000_000_000;
/// Price impact in basis points; 10_000 disables the check.
pub const BPS: u32 = 10_000;

/// Blend v2 request types.
const BLEND_SUPPLY: u32 = 0;
const BLEND_WITHDRAW: u32 = 1;

/// Swap deadline (required by the router; the real protection is the order's `expiry`).
const SWAP_DEADLINE_SECS: u64 = 300;

/// An order can fill in at most this many pieces (`min_fill * MAX_FILLS >= amount_in`).
pub const MAX_FILLS: i128 = 20;
/// A follow-up order lasts at most this long, counted from the fill that opens it (about 100 years; the bound
/// keeps `now + duration` from overflowing). An ordinary order's `expiry` has no upper limit.
pub const MAX_ORDER_SECS: u64 = 100 * 366 * 86_400;
/// Highest accepted price (one billion sell tokens per bought token). A bound against overflow.
pub const MAX_PRICE: i128 = SCALE * 1_000_000_000;
/// Special value for `withdraw`: the whole free balance.
pub const WITHDRAW_ALL: i128 = i128::MAX;
/// Every token in the vault must use this many decimals; price maths depends on it.
pub const TOKEN_DECIMALS: u32 = 7;
/// Maximum number of different tokens in one vault (keeps the vault's entry bounded in size).
pub const MAX_TOKENS: u32 = 12;

/// TTL (about 5 s per ledger).
const DAY_IN_LEDGERS: u32 = 17_280;
const BUMP_THRESHOLD: u32 = 7 * DAY_IN_LEDGERS;
const BUMP_TO: u32 = 30 * DAY_IN_LEDGERS;

/// A stop order does not run if the oracle price is older than this.
pub const ORACLE_MAX_AGE_SECS: u64 = 10 * 60;
/// Stop order: the maximum deviation of a fill from the oracle price is the band the user picks (0.5% - 10%).
pub const STOP_BAND_MIN_BPS: u32 = 50;
pub const STOP_BAND_MAX_BPS: u32 = 1_000;
/// Stop order: the limit can be at most this far from the trigger (10%).
pub const STOP_MAX_GAP_BPS: i128 = 1_000;

/// Scheduled order (DCA): time between two parts (1 minute - 28 days; an order's entry lives 30 days past its last fill).
pub const DCA_MIN_EVERY: u64 = 60;
pub const DCA_MAX_EVERY: u64 = 28 * 86_400;

/// For an asset held on Blend: the buffer that cannot be placed into orders or withdrawn while an order is open (0.001 token). Blend rounds
/// the burned b_tokens up on every withdrawal; the buffer absorbs the rounding loss of partial fills. Once no
/// order is open the buffer can be withdrawn as well.
pub const ROUNDING_BUFFER: i128 = 10_000;

// ---------------------------------------------------------------------------
// External contract interfaces
// ---------------------------------------------------------------------------

/// Blend v2 `Request` struct (field names must match Blend exactly).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Request {
    pub request_type: u32,
    pub address: Address,
    pub amount: i128,
}

/// Only the fields we need are read from Blend's return structs (as a Map), not the whole struct.
#[contractclient(name = "BlendPoolClient")]
pub trait BlendPool {
    fn submit(env: Env, from: Address, spender: Address, to: Address, requests: Vec<Request>) -> Val;
    fn get_positions(env: Env, address: Address) -> Map<Symbol, Val>;
    fn get_reserve(env: Env, asset: Address) -> Map<Symbol, Val>;
    fn get_config(env: Env) -> Map<Symbol, Val>;
    fn claim(env: Env, from: Address, reserve_token_ids: Vec<u32>, to: Address) -> i128;
}

/// SEP-40 / Reflector price oracle (used by Blend pools).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OracleAsset {
    Stellar(Address),
    Other(Symbol),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

#[contractclient(name = "PriceOracleClient")]
pub trait PriceOracle {
    fn lastprice(env: Env, asset: OracleAsset) -> Option<PriceData>;
}

/// The factory. The vault only reads from it whether new orders are paused and whether a token is allowed.
#[contractclient(name = "GuardClient")]
pub trait Guard {
    fn is_paused(env: Env) -> bool;
    /// May orders use this token (the factory's allowed list)?
    fn is_allowed(env: Env, token: Address) -> bool;
}

#[contractclient(name = "RouterClient")]
pub trait SoroswapRouter {
    fn swap_exact_tokens_for_tokens(
        env: Env,
        amount_in: i128,
        amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        deadline: u64,
    ) -> Vec<i128>;

    fn router_pair_for(env: Env, token_a: Address, token_b: Address) -> Address;

    fn router_get_amounts_out(env: Env, amount_in: i128, path: Vec<Address>) -> Vec<i128>;
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/// Another Iora vault, as seen by `cross`: only its `take` is called.
#[contractclient(name = "PeerClient")]
pub trait Peer {
    fn take(env: Env, payer: Address, order_id: u32, fill_amount: i128, pay_amount: i128, executor: Address) -> i128;
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    InvalidAmount = 1,
    InsufficientFree = 2,
    OrderNotFound = 3,
    OrderNotOpen = 4,
    OrderExpired = 5,
    FillTooSmall = 6,
    FillTooLarge = 7,
    LimitNotMet = 8,
    InvalidPrice = 9,
    PoolShortfall = 10,
    InvalidExpiry = 11,
    BlendFormat = 12,
    ImpactTooHigh = 13,
    InvalidImpact = 14,
    Paused = 15,
    /// Stop order: the market has not reached the trigger yet.
    TriggerNotMet = 16,
    /// Invalid follow-up order settings.
    InvalidFollowUp = 18,
    /// Stop order: no current oracle price available.
    OracleUnavailable = 19,
    /// Stop order: the fill price is too far from the oracle price (the pool may have been moved).
    PriceDeviation = 20,
    /// The token sold and the token bought must differ.
    SameToken = 21,
    /// Tokens must have 7 decimals.
    BadDecimals = 23,
    /// Stop order: the deviation band is outside the allowed range.
    InvalidBand = 24,
    /// Setup: a fill fee cap cannot be negative.
    InvalidFee = 25,
    /// A vault holds at most MAX_TOKENS different tokens.
    TooManyTokens = 26,
    /// The token is not on the factory's allowed list.
    TokenNotAllowed = 27,
    /// Invalid fill route (the intermediate token is the token sold or the token bought).
    InvalidPath = 28,
    /// `forget`: the vault still holds the token or an open order still sells it.
    TokenInUse = 29,
    /// `take` / `cross`: a vault cannot pay itself.
    SelfFill = 30,
    /// Scheduled order: the next part is not due yet.
    TooEarly = 31,
    /// Scheduled order: the interval is outside the allowed range.
    InvalidSchedule = 33,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub owner: Address,
    pub pool: Address,
    pub router: Address,
    /// The contract that reports the pause state and the allowed tokens (the factory).
    pub guard: Address,
    /// Fill fee caps: bought token -> maximum fee per fill (in that token's units).
    /// Taken only from output above the limit; a token that is not listed pays no fee.
    pub fees: Map<Address, i128>,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OrderStatus {
    Open,
    Filled,
    Cancelled,
}

/// Limit order: sells the `sell` token and buys the `buy` token.
/// `limit_price`: the most `sell` token paid for 1 `buy` token (7 decimals).
/// Example: selling USDC for XLM at 0.20 USDC = 2_000_000; selling XLM for USDC at "5 XLM per USDC" = 50_000_000.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Order {
    pub sell: Address,
    pub buy: Address,
    pub amount_in: i128,
    pub filled_in: i128,
    pub filled_out: i128,
    pub limit_price: i128,
    pub min_fill: i128,
    pub max_impact_bps: u32,
    pub expiry: u64,
    pub status: OrderStatus,
    /// 0: plain limit order. >0: stop order; it does not fill until the oracle price (`sell` per 1 `buy`) reaches this value.
    pub trigger_price: i128,
    /// Maximum deviation of a fill from the oracle price (basis points). Always set on a stop order, optional on
    /// a scheduled order, 0 otherwise (0: the oracle is not consulted).
    pub stop_band_bps: u32,
    /// true: the output stays in the vault (supplied to Blend if it is a reserve); false: it goes to the owner's wallet.
    pub keep: bool,
}

/// Follow-up order: the token a fill produces is placed into a reverse order in the same vault with these settings.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FollowUp {
    /// Limit of the reverse order (in that order's unit: token sold per 1 token bought back).
    pub limit_price: i128,
    pub max_impact_bps: u32,
    /// Lifetime of the reverse order (seconds), counted from the fill.
    pub duration: u64,
}

/// Schedule of a DCA order: one part of `part` every `every` seconds. The order itself always holds exactly one
/// part (`amount_in - filled_in`); `filled_in` and `filled_out` are the plan's totals so far.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Schedule {
    /// Seconds between two parts.
    pub every: u64,
    /// Size of one part, in the sold token.
    pub part: i128,
    /// Number of parts after which the plan ends; 0: it runs for as long as the vault can cover the next part.
    pub fills: u32,
    /// Parts filled so far.
    pub done: u32,
    /// Earliest time of the next part (ledger timestamp).
    pub next: u64,
}

/// State of one asset in the vault (one read for the interface).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Position {
    pub token: Address,
    /// Total balance: share on Blend (interest included) plus the idle amount in the vault.
    pub balance: i128,
    /// The part that sits idle in the vault (not on Blend).
    pub idle: i128,
    /// Amount reserved for open orders.
    pub reserved: i128,
    /// Amount that can be withdrawn.
    pub free: i128,
    /// Principal (deposited + received from orders - withdrawn - spent).
    pub deposited: i128,
    /// Is the token a reserve of the Blend pool (does it earn interest)?
    pub pooled: bool,
}

/// Lifetime totals of one asset.
#[contracttype]
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Stats {
    pub total_deposited: i128,
    pub total_withdrawn: i128,
    pub total_spent: i128,
    pub total_received: i128,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Config,
    /// The tokens the vault holds (or will receive from an order).
    Tokens,
    /// Principal per token (informational; interest = balance - principal).
    Deposited(Address),
    /// Amount reserved for open orders, per token.
    Reserved(Address),
    /// Lifetime totals per token.
    Stats(Address),
    NextId,
    Order(u32),
    /// Follow-up settings (by order id).
    FollowUp(u32),
    /// Schedule of a DCA order (by order id).
    Schedule(u32),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposited {
    #[topic]
    pub token: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawn {
    #[topic]
    pub token: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderPlaced {
    #[topic]
    pub order_id: u32,
    pub sell: Address,
    pub buy: Address,
    pub amount_in: i128,
    pub limit_price: i128,
}

/// The order just placed is a scheduled one (DCA).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DcaPlaced {
    #[topic]
    pub order_id: u32,
    pub fills: u32,
    pub every: u64,
    pub part: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderCancelled {
    #[topic]
    pub order_id: u32,
    pub remaining: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderFilled {
    #[topic]
    pub order_id: u32,
    pub amount_in: i128,
    pub amount_out: i128,
    /// Did the output stay in the vault (true) or go to the owner's wallet (false)?
    pub kept: bool,
}

/// Follow-up order: the output of a fill was placed into a reverse order in the same vault.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FollowOpened {
    #[topic]
    pub order_id: u32,
    pub new_order_id: u32,
    pub amount: i128,
}

/// The owner's wallet could not receive the output (for example no trustline); it waits in the vault as part of the owner's balance.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Held {
    #[topic]
    pub order_id: u32,
    pub amount: i128,
}

/// Fee paid to whoever filled the order (in the bought token; taken from output above the limit).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecFeePaid {
    #[topic]
    pub order_id: u32,
    pub executor: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardsClaimed {
    pub amount: i128,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct Vault;

#[contractimpl]
impl Vault {
    pub fn __constructor(env: Env, owner: Address, pool: Address, router: Address, guard: Address, fees: Map<Address, i128>) {
        for (_, cap) in fees.iter() {
            if cap < 0 {
                panic_with_error!(&env, Error::InvalidFee);
            }
        }
        let cfg = Config { owner, pool, router, guard, fees };
        let s = env.storage().instance();
        s.set(&DataKey::Config, &cfg);
        s.set(&DataKey::NextId, &0u32);
        bump_instance(&env);
    }

    /// The owner deposits `token`. If it is a reserve of the Blend pool it is supplied at once; otherwise it waits in the vault.
    pub fn deposit(env: Env, token: Address, amount: i128) {
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let cfg = config(&env);
        cfg.owner.require_auth();
        touch(&env, &token);

        let me = env.current_contract_address();
        token::Client::new(&env, &token).transfer(&cfg.owner, &me, &amount);
        if reserve_of(&env, &cfg, &token).is_some() {
            supply_to_pool(&env, &cfg, &token, amount);
        }

        add_i128(&env, DataKey::Deposited(token.clone()), amount);
        update_stats(&env, &token, |st| st.total_deposited += amount);
        bump_instance(&env);
        Deposited { token, amount }.publish(&env);
    }

    /// The owner can withdraw the balance that is not reserved for orders (interest included) at any time.
    /// `amount = WITHDRAW_ALL` withdraws the whole free balance.
    pub fn withdraw(env: Env, token: Address, amount: i128) {
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let cfg = config(&env);
        cfg.owner.require_auth();

        let me = env.current_contract_address();
        let t = token::Client::new(&env, &token);
        let idle = t.balance(&me);
        let pooled = pool_part(&env, &cfg, &token);
        let reserved = get_i128(&env, DataKey::Reserved(token.clone()));
        let free = free_from(idle + pooled, reserved, pooled);
        let amount = if amount == WITHDRAW_ALL { free } else { amount };
        if amount <= 0 || amount > free {
            panic_with_error!(&env, Error::InsufficientFree);
        }

        let before = t.balance(&cfg.owner);
        let from_idle = if idle < amount { idle } else { amount };
        let need = amount - from_idle;
        if need > 0 {
            if reserved == 0 && need >= pooled {
                // Withdraw everything: asking Blend for more than the balance burns all b_tokens, so interest that accrues
                // between simulation and execution does not stay behind as dust.
                withdraw_from_pool(&env, &cfg, &token, pooled + SCALE, &cfg.owner);
            } else {
                withdraw_from_pool(&env, &cfg, &token, need, &cfg.owner);
            }
        }
        if from_idle > 0 {
            t.transfer(&me, &cfg.owner, &from_idle);
        }
        let sent = t.balance(&cfg.owner) - before;
        reduce_principal(&env, &token, sent);
        update_stats(&env, &token, |st| st.total_withdrawn += sent);
        bump_instance(&env);
        Withdrawn { token, amount: sent }.publish(&env);
    }

    /// Limit order: sells `amount_in` of the `sell` token, paying at most `limit_price` per 1 `buy`.
    #[allow(clippy::too_many_arguments)]
    pub fn place_order(
        env: Env,
        sell: Address,
        buy: Address,
        amount_in: i128,
        limit_price: i128,
        min_fill: i128,
        max_impact_bps: u32,
        expiry: u64,
        keep: bool,
    ) -> u32 {
        let cfg = config(&env);
        cfg.owner.require_auth();
        check_order(&env, &cfg, &sell, &buy, amount_in, limit_price, min_fill, max_impact_bps, expiry, MAX_FILLS);
        write_order(&env, &sell, &buy, amount_in, limit_price, min_fill, max_impact_bps, expiry, 0, 0, keep)
    }

    /// Stop order: runs once the oracle price (`sell` per 1 `buy`) reaches `trigger_price`; the worst price is
    /// `limit_price`. When selling XLM for USDC the unit is "XLM per 1 USDC", so the price RISES as XLM falls:
    /// "sell if XLM drops below 0.15" = trigger 1/0.15, limit slightly above that.
    /// `band_bps`: maximum deviation of a fill from the oracle price at that moment. The trigger does NOT latch.
    #[allow(clippy::too_many_arguments)]
    pub fn place_stop_order(
        env: Env,
        sell: Address,
        buy: Address,
        amount_in: i128,
        trigger_price: i128,
        limit_price: i128,
        min_fill: i128,
        max_impact_bps: u32,
        expiry: u64,
        band_bps: u32,
        keep: bool,
    ) -> u32 {
        let cfg = config(&env);
        cfg.owner.require_auth();
        if trigger_price <= 0 || limit_price < trigger_price || limit_price > MAX_PRICE {
            panic_with_error!(&env, Error::InvalidPrice);
        }
        if (limit_price - trigger_price) * (BPS as i128) > trigger_price * STOP_MAX_GAP_BPS {
            panic_with_error!(&env, Error::InvalidPrice);
        }
        if !(STOP_BAND_MIN_BPS..=STOP_BAND_MAX_BPS).contains(&band_bps) {
            panic_with_error!(&env, Error::InvalidBand);
        }
        check_order(&env, &cfg, &sell, &buy, amount_in, limit_price, min_fill, max_impact_bps, expiry, MAX_FILLS);
        // If the oracle cannot price both tokens the order could never trigger; reject it up front.
        oracle_prices(&env, &cfg, &sell, &buy);
        write_order(&env, &sell, &buy, amount_in, limit_price, min_fill, max_impact_bps, expiry, trigger_price, band_bps, keep)
    }

    /// Follow-up order ("buy, then sell"): a plain limit order whose output (`buy`) stays in the vault on every fill
    /// and is placed into an order in the same vault that sells `buy` back for `sell`, with limit `then_limit`, valid
    /// for `then_duration` seconds. If the reverse order cannot be opened (for example new orders are paused) the output stays free in the vault.
    #[allow(clippy::too_many_arguments)]
    pub fn place_order_then(
        env: Env,
        sell: Address,
        buy: Address,
        amount_in: i128,
        limit_price: i128,
        min_fill: i128,
        max_impact_bps: u32,
        expiry: u64,
        then_limit: i128,
        then_impact_bps: u32,
        then_duration: u64,
    ) -> u32 {
        let cfg = config(&env);
        cfg.owner.require_auth();
        check_order(&env, &cfg, &sell, &buy, amount_in, limit_price, min_fill, max_impact_bps, expiry, MAX_FILLS);
        if then_limit <= 0
            || then_limit > MAX_PRICE
            || then_impact_bps == 0
            || then_impact_bps > BPS
            || then_duration == 0
            || then_duration > MAX_ORDER_SECS
        {
            panic_with_error!(&env, Error::InvalidFollowUp);
        }
        // The chain may not open a sell order at a loss: if the product of the two limits exceeds 1, the sell price is
        // below the buy price (the two limits are in reciprocal units).
        if limit_price * then_limit > SCALE * SCALE {
            panic_with_error!(&env, Error::InvalidFollowUp);
        }
        let id = write_order(&env, &sell, &buy, amount_in, limit_price, min_fill, max_impact_bps, expiry, 0, 0, true);
        let f = FollowUp { limit_price: then_limit, max_impact_bps: then_impact_bps, duration: then_duration };
        let key = DataKey::FollowUp(id);
        env.storage().persistent().set(&key, &f);
        env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        id
    }

    /// Scheduled order ("DCA"): sells `part` of `sell` for `buy` every `every` seconds; the first part is due at
    /// once. It works for buying and for selling: the direction is simply which token is sold.
    /// `fills`: the plan ends after this many parts; 0 means it runs for as long as the vault can cover the next
    /// part. Only one part is reserved at a time: after each fill the next part is reserved if the free balance
    /// covers it, and if it does not the plan ends (the order closes as filled). Everything else in the vault
    /// stays free, keeps earning and can be withdrawn; withdrawing it is how the owner lets a plan run out.
    /// `limit_price`: the most `sell` paid per 1 `buy` on any part (a price cap when buying, a floor when
    /// selling, in the same unit as `place_order`). While the market is beyond it the plan waits; a part that
    /// was due fills as soon as the price allows, and the parts after it keep the interval.
    /// `band_bps`: if not 0, every part must also be within this distance of the oracle price at that moment
    /// (50 - 1000). Use it when the limit is far from the market; with `limit_price = MAX_PRICE` the band is
    /// the only price protection, so the two cannot both be left open.
    /// `expiry`: the plan stops then at the latest (any time in the future).
    /// Returns the order id; the order is read, cancelled and filled like any other.
    #[allow(clippy::too_many_arguments)]
    pub fn place_dca(
        env: Env,
        sell: Address,
        buy: Address,
        part: i128,
        fills: u32,
        every: u64,
        limit_price: i128,
        max_impact_bps: u32,
        band_bps: u32,
        expiry: u64,
        keep: bool,
    ) -> u32 {
        let cfg = config(&env);
        cfg.owner.require_auth();
        if !(DCA_MIN_EVERY..=DCA_MAX_EVERY).contains(&every) {
            panic_with_error!(&env, Error::InvalidSchedule);
        }
        if band_bps != 0 && !(STOP_BAND_MIN_BPS..=STOP_BAND_MAX_BPS).contains(&band_bps) {
            panic_with_error!(&env, Error::InvalidBand);
        }
        // No price protection at all is not accepted: either a real limit or an oracle band.
        if band_bps == 0 && limit_price >= MAX_PRICE {
            panic_with_error!(&env, Error::InvalidPrice);
        }
        // The order holds one part and fills whole (minimum fill = the part): the vault must cover the first part now.
        check_order(&env, &cfg, &sell, &buy, part, limit_price, part, max_impact_bps, expiry, MAX_FILLS);
        if band_bps != 0 {
            // If the oracle cannot price both tokens no part could ever fill; reject it up front.
            oracle_prices(&env, &cfg, &sell, &buy);
        }
        let id = write_order(&env, &sell, &buy, part, limit_price, part, max_impact_bps, expiry, 0, band_bps, keep);
        let key = DataKey::Schedule(id);
        let now = env.ledger().timestamp();
        env.storage().persistent().set(&key, &Schedule { every, part, fills, done: 0, next: now });
        env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        DcaPlaced { order_id: id, fills, every, part }.publish(&env);
        id
    }

    /// The owner cancels an open order. ANYONE may close an expired order: it can no longer fill, and closing it
    /// only releases the reserved amount back to the owner's free balance (no funds move).
    pub fn cancel_order(env: Env, order_id: u32) {
        let cfg = config(&env);
        let mut order = load_order(&env, order_id);
        if order.status != OrderStatus::Open {
            panic_with_error!(&env, Error::OrderNotOpen);
        }
        if env.ledger().timestamp() <= order.expiry {
            cfg.owner.require_auth();
        }
        let remaining = order.amount_in - order.filled_in;
        order.status = OrderStatus::Cancelled;
        save_order(&env, order_id, &order);
        add_i128(&env, DataKey::Reserved(order.sell.clone()), -remaining);
        bump_instance(&env);
        OrderCancelled { order_id, remaining }.publish(&env);
    }

    /// Anyone can call this. The caller only chooses the order, the fill amount, the route and the address that
    /// receives the fill fee (`executor`); the tokens, the recipient, the limit and the amount are fixed in the contract.
    /// Fill fee: if the swap did better than the limit, at most `fees[buy]` of the difference goes to
    /// `executor`. The owner always receives at least what the limit promises.
    /// `via`: route the swap through one intermediate token instead of the direct `sell -> buy` pair (for example
    /// USDC -> XLM -> BTC). It must be on the allowed list. The limit and minimum output are the same on any route.
    /// Returns the amount of `buy` left for the owner (fee deducted).
    pub fn execute(env: Env, executor: Address, order_id: u32, fill_amount: i128, via: Option<Address>) -> i128 {
        let cfg = config(&env);
        let order = open_for_fill(&env, order_id, fill_amount);

        let min_out = min_out_for(fill_amount, order.limit_price);
        let me = env.current_contract_address();
        let buy = token::Client::new(&env, &order.buy);
        let router = RouterClient::new(&env, &cfg.router);
        let (path, first_hop) = match via {
            Some(mid) => {
                if mid == order.sell || mid == order.buy {
                    panic_with_error!(&env, Error::InvalidPath);
                }
                if !matches!(GuardClient::new(&env, &cfg.guard).try_is_allowed(&mid), Ok(Ok(true))) {
                    panic_with_error!(&env, Error::TokenNotAllowed);
                }
                (vec![&env, order.sell.clone(), mid.clone(), order.buy.clone()], mid)
            }
            None => (vec![&env, order.sell.clone(), order.buy.clone()], order.buy.clone()),
        };

        // 0a) Stop order: no fill until the oracle price reaches the trigger.
        let oracle = trigger_of(&env, &cfg, &order);
        // 0b) Price impact guard: stops a large fill from being pushed into a shallow pool.
        if order.max_impact_bps < BPS {
            check_impact(&env, &router, &path, fill_amount, order.max_impact_bps);
        }

        // 1) The sold token must be on hand: idle funds are used first, the rest is withdrawn from Blend.
        hold_sold(&env, &cfg, &order.sell, fill_amount);

        // 2) Swap on Soroswap. If the router cannot deliver the minimum output it fails and everything reverts.
        //    On a multi-hop route the router transfers only to the first pair; later hops move between pairs.
        let pair = router.router_pair_for(&order.sell, &first_hop);
        let buy_before = buy.balance(&me);
        let deadline = env.ledger().timestamp() + SWAP_DEADLINE_SECS;
        // This authorization matches exactly one transfer (vault -> pair, this amount) and expires when this call
        // frame ends; it cannot be used for anything else.
        env.authorize_as_current_contract(vec![&env, transfer_auth(&env, &order.sell, &me, &pair, fill_amount)]);
        router.swap_exact_tokens_for_tokens(&fill_amount, &min_out, &path, &me, &deadline);

        // 3) We also check the result ourselves instead of trusting the router (first step of `settle`).
        let gross = buy.balance(&me) - buy_before;
        settle(&env, &cfg, order_id, order, fill_amount, gross, min_out, oracle, executor)
    }

    /// Direct fill, no pool: `payer` pays `pay_amount` of the order's bought token into the vault and receives
    /// `fill_amount` of its sold token. Anyone can be the payer (it must authorize the payment).
    /// The rules are those of `execute`: the order must be open, the fill sizes are the same, a stop order still
    /// waits for its trigger and its oracle band, and the vault counts what actually arrived, which must be at
    /// least what the limit promises for `fill_amount`. Otherwise nothing moves.
    /// The fill fee works as in `execute`: only from payment above the limit, at most `fees[buy]`, to `executor`.
    /// Returns the amount of `buy` left for the owner (fee deducted).
    pub fn take(env: Env, payer: Address, order_id: u32, fill_amount: i128, pay_amount: i128, executor: Address) -> i128 {
        payer.require_auth();
        let cfg = config(&env);
        let order = open_for_fill(&env, order_id, fill_amount);
        let me = env.current_contract_address();
        if payer == me {
            panic_with_error!(&env, Error::SelfFill);
        }
        let min_out = min_out_for(fill_amount, order.limit_price);
        if pay_amount < min_out {
            panic_with_error!(&env, Error::LimitNotMet);
        }
        let oracle = trigger_of(&env, &cfg, &order);

        // 1) The payment comes in first; the vault counts it itself.
        let sell = token::Client::new(&env, &order.sell);
        let buy = token::Client::new(&env, &order.buy);
        let buy_before = buy.balance(&me);
        buy.transfer(&payer, &me, &pay_amount);
        let gross = buy.balance(&me) - buy_before;

        // 2) The sold token leaves: idle funds first, the rest is withdrawn from Blend.
        hold_sold(&env, &cfg, &order.sell, fill_amount);
        sell.transfer(&me, &payer, &fill_amount);

        // 3) Limit check on what arrived, fee, accounting, output (same as a swap).
        settle(&env, &cfg, order_id, order, fill_amount, gross, min_out, oracle, executor)
    }

    /// Fills this vault's order against an opposite order in another Iora vault, with no pool in between: this
    /// vault pays `fill_amount` of its sold token into `other` through that vault's `take` and receives
    /// `other_fill` of the token it buys. Anyone can call this; the caller chooses the two orders, the two
    /// amounts and the address that receives the fill fees.
    /// Both limits hold: `other` accepts the payment only if it meets its own order's limit, and this vault
    /// counts what it received and requires at least what its own limit promises. If either check fails the
    /// whole transaction is undone. `other` needs no trust: this vault authorizes exactly one transfer (the
    /// payment, to `other`) and still checks the result itself.
    /// Returns the amount of `buy` left for this vault's owner (fee deducted).
    #[allow(clippy::too_many_arguments)]
    pub fn cross(
        env: Env,
        executor: Address,
        order_id: u32,
        fill_amount: i128,
        other: Address,
        other_order: u32,
        other_fill: i128,
    ) -> i128 {
        let cfg = config(&env);
        let order = open_for_fill(&env, order_id, fill_amount);
        let me = env.current_contract_address();
        if other == me {
            panic_with_error!(&env, Error::SelfFill);
        }
        let min_out = min_out_for(fill_amount, order.limit_price);
        if other_fill < min_out {
            panic_with_error!(&env, Error::LimitNotMet);
        }
        let oracle = trigger_of(&env, &cfg, &order);

        // 1) The sold token must be on hand: idle funds first, the rest is withdrawn from Blend.
        hold_sold(&env, &cfg, &order.sell, fill_amount);

        // 2) Pay the other vault's order. This authorization matches exactly one transfer (this vault -> `other`,
        //    this amount of the sold token) and expires when this call frame ends.
        let buy = token::Client::new(&env, &order.buy);
        let buy_before = buy.balance(&me);
        env.authorize_as_current_contract(vec![&env, transfer_auth(&env, &order.sell, &me, &other, fill_amount)]);
        PeerClient::new(&env, &other).take(&me, &other_order, &other_fill, &fill_amount, &executor);

        // 3) Count what arrived instead of trusting `other`; then fee, accounting and output as in a swap.
        let gross = buy.balance(&me) - buy_before;
        settle(&env, &cfg, order_id, order, fill_amount, gross, min_out, oracle, executor)
    }

    /// Sends the rewards Blend distributes (BLND) straight to the owner's wallet.
    pub fn claim_rewards(env: Env, reserve_token_ids: Vec<u32>) -> i128 {
        let cfg = config(&env);
        cfg.owner.require_auth();
        let me = env.current_contract_address();
        let amount = BlendPoolClient::new(&env, &cfg.pool).claim(&me, &reserve_token_ids, &cfg.owner);
        RewardsClaimed { amount }.publish(&env);
        amount
    }

    // ---------------- read functions ----------------

    pub fn get_config(env: Env) -> Config {
        config(&env)
    }

    pub fn get_order(env: Env, order_id: u32) -> Order {
        load_order(&env, order_id)
    }

    /// Follow-up settings (None if there are none).
    pub fn get_follow_up(env: Env, order_id: u32) -> Option<FollowUp> {
        env.storage().persistent().get(&DataKey::FollowUp(order_id))
    }

    /// Schedule of a DCA order (None for any other order).
    pub fn get_schedule(env: Env, order_id: u32) -> Option<Schedule> {
        env.storage().persistent().get(&DataKey::Schedule(order_id))
    }

    /// Number of orders placed so far (order ids are 0..order_count).
    pub fn order_count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::NextId).unwrap_or(0)
    }

    /// The tokens the vault holds (or will receive from an order).
    pub fn tokens(env: Env) -> Vec<Address> {
        token_list(&env)
    }

    /// State of one asset.
    pub fn position(env: Env, token: Address) -> Position {
        position_of(&env, &config(&env), &token)
    }

    /// State of every asset in the vault (one read for the interface).
    pub fn positions(env: Env) -> Vec<Position> {
        let cfg = config(&env);
        let mut out = Vec::new(&env);
        for t in token_list(&env).iter() {
            out.push_back(position_of(&env, &cfg, &t));
        }
        out
    }

    /// Total balance (Blend share plus idle).
    pub fn balance(env: Env, token: Address) -> i128 {
        total_of(&env, &config(&env), &token)
    }

    /// Amount that can be withdrawn.
    pub fn free_balance(env: Env, token: Address) -> i128 {
        let cfg = config(&env);
        let pooled = pool_part(&env, &cfg, &token);
        let idle = token::Client::new(&env, &token).balance(&env.current_contract_address());
        free_from(idle + pooled, get_i128(&env, DataKey::Reserved(token)), pooled)
    }

    /// Version of the vault code (keepers pick the `execute` signature from it).
    pub fn version(_env: Env) -> u32 {
        12
    }

    /// The owner takes a token off the vault's list, freeing one of its MAX_TOKENS places. Only a token the
    /// vault no longer holds (no balance, nothing reserved for an order) can be removed. If an open order later
    /// delivers that token, it goes back on the list by itself.
    pub fn forget(env: Env, token: Address) {
        let cfg = config(&env);
        cfg.owner.require_auth();
        let mut list = token_list(&env);
        let at = match list.first_index_of(&token) {
            Some(i) => i,
            None => return,
        };
        let idle = token::Client::new(&env, &token).balance(&env.current_contract_address());
        let held = idle + pool_part(&env, &cfg, &token);
        if held > 0 || get_i128(&env, DataKey::Reserved(token.clone())) > 0 {
            panic_with_error!(&env, Error::TokenInUse);
        }
        list.remove(at);
        env.storage().instance().set(&DataKey::Tokens, &list);
        bump_instance(&env);
    }

    /// Amount that can go into a new order (free balance minus the rounding buffer).
    pub fn orderable_balance(env: Env, token: Address) -> i128 {
        orderable_of(&env, &config(&env), &token)
    }

    pub fn reserved(env: Env, token: Address) -> i128 {
        get_i128(&env, DataKey::Reserved(token))
    }

    /// Principal (deposited + received from orders, less withdrawn and spent).
    pub fn deposited(env: Env, token: Address) -> i128 {
        get_i128(&env, DataKey::Deposited(token))
    }

    pub fn stats(env: Env, token: Address) -> Stats {
        env.storage().instance().get(&DataKey::Stats(token)).unwrap_or_default()
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// The checks every fill starts with: the order is open and not expired, and the fill size is allowed.
fn open_for_fill(env: &Env, order_id: u32, fill_amount: i128) -> Order {
    let order = load_order(env, order_id);
    if order.status != OrderStatus::Open {
        panic_with_error!(env, Error::OrderNotOpen);
    }
    if env.ledger().timestamp() > order.expiry {
        panic_with_error!(env, Error::OrderExpired);
    }
    let remaining = order.amount_in - order.filled_in;
    if fill_amount <= 0 {
        panic_with_error!(env, Error::InvalidAmount);
    }
    if fill_amount > remaining {
        panic_with_error!(env, Error::FillTooLarge);
    }
    // Minimum fill rule: except for the fill that completes the order, every fill must be at least `min_fill`
    // and may not leave a remainder smaller than `min_fill`.
    let left = remaining - fill_amount;
    if left != 0 && (fill_amount < order.min_fill || left < order.min_fill) {
        panic_with_error!(env, Error::FillTooSmall);
    }
    // Scheduled order: not before the part is due. (A fill is always the whole part: the order holds exactly one
    // part and that part is its minimum fill.) The schedule moves on here; if the fill fails later the whole
    // transaction is undone, this included.
    let key = DataKey::Schedule(order_id);
    if let Some(mut s) = env.storage().persistent().get::<DataKey, Schedule>(&key) {
        let now = env.ledger().timestamp();
        if now < s.next {
            panic_with_error!(env, Error::TooEarly);
        }
        s.done += 1;
        // Parts keep their interval; a part that filled late does not let the next ones bunch up.
        s.next += s.every;
        if s.next <= now {
            s.next = now + s.every;
        }
        env.storage().persistent().set(&key, &s);
        env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
    order
}

/// Stop order: no fill until the oracle price reaches the trigger. Returns the oracle prices for the band check:
/// always for a stop order, for a scheduled order only if it has a band, None for a plain order.
fn trigger_of(env: &Env, cfg: &Config, order: &Order) -> Option<(i128, i128)> {
    if order.trigger_price > 0 {
        Some(check_trigger(env, cfg, &order.sell, &order.buy, order.trigger_price))
    } else if order.stop_band_bps > 0 {
        Some(oracle_prices(env, cfg, &order.sell, &order.buy))
    } else {
        None
    }
}

/// Makes `amount` of the sold token available in the vault: idle funds are used first, the rest is withdrawn from Blend.
fn hold_sold(env: &Env, cfg: &Config, token: &Address, amount: i128) {
    let me = env.current_contract_address();
    let t = token::Client::new(env, token);
    let idle = t.balance(&me);
    if idle < amount {
        withdraw_from_pool(env, cfg, token, amount - idle, &me);
        if t.balance(&me) < amount {
            panic_with_error!(env, Error::PoolShortfall);
        }
    }
}

/// Second half of every fill, whatever delivered the bought token (a swap, a payer, another vault): checks that
/// `gross` meets the limit, pays the fill fee, updates the order and hands the output on.
/// Returns the amount of `buy` left for the owner (fee deducted).
#[allow(clippy::too_many_arguments)]
fn settle(
    env: &Env,
    cfg: &Config,
    order_id: u32,
    mut order: Order,
    fill_amount: i128,
    gross: i128,
    min_out: i128,
    oracle: Option<(i128, i128)>,
    executor: Address,
) -> i128 {
    let me = env.current_contract_address();
    let buy = token::Client::new(env, &order.buy);
    if gross < min_out {
        panic_with_error!(env, Error::LimitNotMet);
    }
    // The least the owner must receive: what the limit promises (and, for a stop order, the oracle band).
    let mut floor = min_out;
    // Stop order or banded scheduled order: the output may be below the oracle-fair amount by at most the chosen band.
    if let Some((p_in, p_out)) = oracle {
        let fair = fill_amount * p_in / p_out;
        let band_min = fair * ((BPS - order.stop_band_bps) as i128);
        if gross * (BPS as i128) < band_min {
            panic_with_error!(env, Error::PriceDeviation);
        }
        // Rounded up, so the band still holds after the fee is taken.
        let band_floor = (band_min + (BPS as i128) - 1) / (BPS as i128);
        if band_floor > floor {
            floor = band_floor;
        }
    }
    // Fill fee: only from the part above `floor`, at most `fees[buy]`. If the executor cannot receive it
    // (for example no trustline) the fill still goes through and the owner keeps the fee.
    let cap = cfg.fees.get(order.buy.clone()).unwrap_or(0);
    let mut fee = gross - floor;
    if fee > cap {
        fee = cap;
    }
    let mut out = gross;
    if fee > 0 && executor != me && matches!(buy.try_transfer(&me, &executor, &fee), Ok(Ok(_))) {
        out = gross - fee;
        ExecFeePaid { order_id, executor, amount: fee }.publish(env);
    }

    // Order accounting (the sold side).
    order.filled_in += fill_amount;
    order.filled_out += out;
    add_i128(env, DataKey::Reserved(order.sell.clone()), -fill_amount);
    reduce_principal(env, &order.sell, fill_amount);
    if order.filled_in == order.amount_in {
        order.status = OrderStatus::Filled;
        // Scheduled order: the next part is reserved now if the plan has parts left and the vault can cover it
        // (the sold token has already left the vault at this point); otherwise the plan ends here.
        if let Some(s) = env.storage().persistent().get::<DataKey, Schedule>(&DataKey::Schedule(order_id)) {
            if (s.fills == 0 || s.done < s.fills) && orderable_of(env, cfg, &order.sell) >= s.part {
                order.amount_in += s.part;
                order.status = OrderStatus::Open;
                add_i128(env, DataKey::Reserved(order.sell.clone()), s.part);
            }
        }
    }
    save_order(env, order_id, &order);
    update_stats(env, &order.sell, |st| st.total_spent += fill_amount);
    update_stats(env, &order.buy, |st| st.total_received += out);

    // The output either stays in the vault (supplied to Blend if it is a reserve) or goes to the owner's wallet.
    // If the wallet cannot receive it (for example no trustline) it waits in the vault as the owner's balance; the fill does not stop.
    let follow: Option<FollowUp> = env.storage().persistent().get(&DataKey::FollowUp(order_id));
    let mut kept = order.keep || follow.is_some();
    if !kept && !matches!(buy.try_transfer(&me, &cfg.owner, &out), Ok(Ok(_))) {
        kept = true;
        Held { order_id, amount: out }.publish(env);
    }
    if kept {
        // The owner may have taken the token off the list with `forget` while this order was open.
        ensure_listed(env, &order.buy);
        if reserve_of(env, cfg, &order.buy).is_some() {
            // If the supply fails (for example the reserve is disabled) the fill does not stop; the token waits idle in the vault.
            try_supply_to_pool(env, cfg, &order.buy, out);
        }
        add_i128(env, DataKey::Deposited(order.buy.clone()), out);
        if let Some(f) = follow {
            env.storage().persistent().extend_ttl(&DataKey::FollowUp(order_id), BUMP_THRESHOLD, BUMP_TO);
            open_follow(env, cfg, order_id, &order.buy, &order.sell, out, &f);
        }
    }
    bump_instance(env);

    OrderFilled { order_id, amount_in: fill_amount, amount_out: out, kept }.publish(env);
    out
}

/// Minimum output at the limit price (rounded up, so the user never receives less).
pub fn min_out_for(amount_in: i128, limit_price: i128) -> i128 {
    (amount_in * SCALE + limit_price - 1) / limit_price
}

/// Rules for a new order (authorization is checked by the caller). Panics on any violation.
#[allow(clippy::too_many_arguments)]
fn check_order(
    env: &Env,
    cfg: &Config,
    sell: &Address,
    buy: &Address,
    amount_in: i128,
    limit_price: i128,
    min_fill: i128,
    max_impact_bps: u32,
    expiry: u64,
    max_fills: i128,
) {
    // Pausing only stops new orders; withdrawals, cancellations and fills of existing orders always work.
    if GuardClient::new(env, &cfg.guard).is_paused() {
        panic_with_error!(env, Error::Paused);
    }
    if sell == buy {
        panic_with_error!(env, Error::SameToken);
    }
    // Only tokens on the factory's allowed list can be traded (deposits and withdrawals are not affected).
    let guard = GuardClient::new(env, &cfg.guard);
    if !guard.is_allowed(sell) || !guard.is_allowed(buy) {
        panic_with_error!(env, Error::TokenNotAllowed);
    }
    if amount_in <= 0 || min_fill <= 0 || min_fill > amount_in {
        panic_with_error!(env, Error::InvalidAmount);
    }
    // At most `max_fills` pieces: min_fill >= ceil(amount_in / max_fills).
    if min_fill < (amount_in - 1) / max_fills + 1 {
        panic_with_error!(env, Error::InvalidAmount);
    }
    if limit_price <= 0 || limit_price > MAX_PRICE {
        panic_with_error!(env, Error::InvalidPrice);
    }
    if max_impact_bps == 0 || max_impact_bps > BPS {
        panic_with_error!(env, Error::InvalidImpact);
    }
    let now = env.ledger().timestamp();
    if expiry <= now {
        panic_with_error!(env, Error::InvalidExpiry);
    }
    // The bought token joins the vault's list (decimals check and token count limit happen here).
    touch(env, buy);
    // The same balance cannot be spent by two orders; the rounding buffer cannot be placed into an order.
    if amount_in > orderable_of(env, cfg, sell) {
        panic_with_error!(env, Error::InsufficientFree);
    }
}

/// Stores the order and reserves its amount (rules must already be checked in `check_order` or by the caller).
#[allow(clippy::too_many_arguments)]
fn write_order(
    env: &Env,
    sell: &Address,
    buy: &Address,
    amount_in: i128,
    limit_price: i128,
    min_fill: i128,
    max_impact_bps: u32,
    expiry: u64,
    trigger_price: i128,
    stop_band_bps: u32,
    keep: bool,
) -> u32 {
    let id: u32 = env.storage().instance().get(&DataKey::NextId).unwrap_or(0);
    let order = Order {
        sell: sell.clone(),
        buy: buy.clone(),
        amount_in,
        filled_in: 0,
        filled_out: 0,
        limit_price,
        min_fill,
        max_impact_bps,
        expiry,
        status: OrderStatus::Open,
        trigger_price,
        stop_band_bps,
        keep,
    };
    save_order(env, id, &order);
    env.storage().instance().set(&DataKey::NextId, &(id + 1));
    add_i128(env, DataKey::Reserved(sell.clone()), amount_in);
    bump_instance(env);
    OrderPlaced { order_id: id, sell: sell.clone(), buy: buy.clone(), amount_in, limit_price }.publish(env);
    id
}

/// Reverse leg of a follow-up order: the `sell` token a fill produced (just bought) is placed into an order in the same vault.
/// It NEVER stops the fill: if it cannot be opened (new orders paused, amount too small) it is skipped silently and
/// the output stays in the vault as free balance.
fn open_follow(env: &Env, cfg: &Config, order_id: u32, sell: &Address, buy: &Address, out: i128, f: &FollowUp) {
    let guard = GuardClient::new(env, &cfg.guard);
    if !matches!(guard.try_is_paused(), Ok(Ok(false))) {
        return;
    }
    // The token may have been removed from the list since: no reverse order, the output stays free in the vault.
    if !matches!(guard.try_is_allowed(sell), Ok(Ok(true))) || !matches!(guard.try_is_allowed(buy), Ok(Ok(true))) {
        return;
    }
    // Because of Blend's b_token rounding and the buffer, the amount that can be reserved may be slightly below `out`.
    let room = orderable_of(env, cfg, sell);
    let size = if out < room { out } else { room };
    if size <= 0 {
        return;
    }
    // At most MAX_FILLS pieces (so it can fill in small pieces in a shallow pool).
    let min_fill = (size - 1) / MAX_FILLS + 1;
    let expiry = env.ledger().timestamp() + f.duration;
    let id = write_order(env, sell, buy, size, f.limit_price, min_fill, f.max_impact_bps, expiry, 0, 0, true);
    FollowOpened { order_id, new_order_id: id, amount: size }.publish(env);
}

fn config(env: &Env) -> Config {
    env.storage().instance().get(&DataKey::Config).unwrap()
}

fn get_i128(env: &Env, key: DataKey) -> i128 {
    env.storage().instance().get(&key).unwrap_or(0)
}

fn add_i128(env: &Env, key: DataKey, delta: i128) {
    let v: i128 = env.storage().instance().get(&key).unwrap_or(0);
    env.storage().instance().set(&key, &(v + delta));
}

/// Principal is reduced first; anything beyond principal is treated as paid from interest.
fn reduce_principal(env: &Env, token: &Address, amount: i128) {
    let key = DataKey::Deposited(token.clone());
    let d: i128 = env.storage().instance().get(&key).unwrap_or(0);
    env.storage().instance().set(&key, &(if amount >= d { 0 } else { d - amount }));
}

fn update_stats(env: &Env, token: &Address, f: impl FnOnce(&mut Stats)) {
    let key = DataKey::Stats(token.clone());
    let mut st: Stats = env.storage().instance().get(&key).unwrap_or_default();
    f(&mut st);
    env.storage().instance().set(&key, &st);
}

fn token_list(env: &Env) -> Vec<Address> {
    env.storage().instance().get(&DataKey::Tokens).unwrap_or(Vec::new(env))
}

/// Adds the token to the vault's list (no-op if present). A new token must have 7 decimals; a vault holds at
/// most MAX_TOKENS different tokens.
fn touch(env: &Env, token: &Address) {
    let mut list = token_list(env);
    if list.contains(token) {
        return;
    }
    if list.len() >= MAX_TOKENS {
        panic_with_error!(env, Error::TooManyTokens);
    }
    if token::Client::new(env, token).decimals() != TOKEN_DECIMALS {
        panic_with_error!(env, Error::BadDecimals);
    }
    list.push_back(token.clone());
    env.storage().instance().set(&DataKey::Tokens, &list);
}

/// Puts a token back on the list without the count limit: an order delivers a token the owner removed with
/// `forget`. Its decimals were checked when the order was placed.
fn ensure_listed(env: &Env, token: &Address) {
    let mut list = token_list(env);
    if !list.contains(token) {
        list.push_back(token.clone());
        env.storage().instance().set(&DataKey::Tokens, &list);
    }
}

/// The rounding buffer is needed only for an asset with a share on Blend (Blend rounds up on withdrawal); a token
/// that sits idle in the vault loses nothing.
fn buffer_for(pooled: i128) -> i128 {
    if pooled > 0 {
        ROUNDING_BUFFER
    } else {
        0
    }
}

fn free_from(total: i128, reserved: i128, pooled: i128) -> i128 {
    let buffer = if reserved > 0 { buffer_for(pooled) } else { 0 };
    let free = total - reserved - buffer;
    if free < 0 {
        0
    } else {
        free
    }
}

/// Amount that can go into a new order: the buffer is deducted even when no order is open (the first order leaves it too).
fn orderable_of(env: &Env, cfg: &Config, token: &Address) -> i128 {
    let pooled = pool_part(env, cfg, token);
    let idle = token::Client::new(env, token).balance(&env.current_contract_address());
    let room = idle + pooled - get_i128(env, DataKey::Reserved(token.clone())) - buffer_for(pooled);
    if room < 0 {
        0
    } else {
        room
    }
}

fn position_of(env: &Env, cfg: &Config, token: &Address) -> Position {
    let idle = token::Client::new(env, token).balance(&env.current_contract_address());
    let reserve = reserve_of(env, cfg, token);
    let pooled = match reserve {
        Some((index, b_rate)) => b_tokens_of(env, cfg, index) * b_rate / B_RATE_SCALE,
        None => 0,
    };
    let reserved = get_i128(env, DataKey::Reserved(token.clone()));
    Position {
        token: token.clone(),
        balance: idle + pooled,
        idle,
        reserved,
        free: free_from(idle + pooled, reserved, pooled),
        deposited: get_i128(env, DataKey::Deposited(token.clone())),
        pooled: reserve.is_some(),
    }
}

/// One field of a Blend struct read as a Map.
fn field<T: TryFromVal<Env, Val>>(env: &Env, m: &Map<Symbol, Val>, name: &str) -> T {
    let v = match m.get(Symbol::new(env, name)) {
        Some(v) => v,
        None => panic_with_error!(env, Error::BlendFormat),
    };
    match T::try_from_val(env, &v) {
        Ok(t) => t,
        Err(_) => panic_with_error!(env, Error::BlendFormat),
    }
}

/// Is the token a reserve of the Blend pool? Returns (reserve index, b_rate) if so, None otherwise.
fn reserve_of(env: &Env, cfg: &Config, token: &Address) -> Option<(u32, i128)> {
    match BlendPoolClient::new(env, &cfg.pool).try_get_reserve(token) {
        Ok(Ok(reserve)) => {
            let rcfg: Map<Symbol, Val> = field(env, &reserve, "config");
            let rdata: Map<Symbol, Val> = field(env, &reserve, "data");
            let index: u32 = field(env, &rcfg, "index");
            let b_rate: i128 = field(env, &rdata, "b_rate");
            Some((index, b_rate))
        }
        _ => None,
    }
}

fn b_tokens_of(env: &Env, cfg: &Config, index: u32) -> i128 {
    let positions = BlendPoolClient::new(env, &cfg.pool).get_positions(&env.current_contract_address());
    let supply: Map<u32, i128> = field(env, &positions, "supply");
    supply.get(index).unwrap_or(0)
}

/// The vault's share on Blend = b_tokens * b_rate (rounded down). 0 if the token is not a reserve.
fn pool_part(env: &Env, cfg: &Config, token: &Address) -> i128 {
    match reserve_of(env, cfg, token) {
        Some((index, b_rate)) => b_tokens_of(env, cfg, index) * b_rate / B_RATE_SCALE,
        None => 0,
    }
}

/// Total balance: share on Blend plus the idle amount in the vault.
fn total_of(env: &Env, cfg: &Config, token: &Address) -> i128 {
    pool_part(env, cfg, token) + token::Client::new(env, token).balance(&env.current_contract_address())
}

/// Price impact of a fill: compared with the unit price of a small probe amount.
fn check_impact(env: &Env, router: &RouterClient, path: &Vec<Address>, fill: i128, max_bps: u32) {
    let probe = fill / 100;
    if probe == 0 {
        return;
    }
    let full = router.router_get_amounts_out(&fill, path).last().unwrap();
    let small = router.router_get_amounts_out(&probe, path).last().unwrap();
    let ideal = small * fill / probe;
    if ideal > 0 && (ideal - full) * (BPS as i128) > ideal * (max_bps as i128) {
        panic_with_error!(env, Error::ImpactTooHigh);
    }
}

/// Is the oracle price (`sell` per 1 `buy`, 7 decimals) at the trigger? The pool's spot price is NOT used.
/// Returns (price of the sold token, price of the bought token) if it is.
fn check_trigger(env: &Env, cfg: &Config, sell: &Address, buy: &Address, trigger: i128) -> (i128, i128) {
    let (p_in, p_out) = oracle_prices(env, cfg, sell, buy);
    let market = p_out * SCALE / p_in;
    if market < trigger {
        panic_with_error!(env, Error::TriggerNotMet);
    }
    (p_in, p_out)
}

/// Current prices of the two tokens from the Blend pool's oracle.
fn oracle_prices(env: &Env, cfg: &Config, sell: &Address, buy: &Address) -> (i128, i128) {
    let pc = BlendPoolClient::new(env, &cfg.pool).get_config();
    let oracle: Address = field(env, &pc, "oracle");
    let o = PriceOracleClient::new(env, &oracle);
    (oracle_price(env, &o, sell), oracle_price(env, &o, buy))
}

fn oracle_price(env: &Env, o: &PriceOracleClient, asset: &Address) -> i128 {
    let now = env.ledger().timestamp();
    match o.try_lastprice(&OracleAsset::Stellar(asset.clone())) {
        Ok(Ok(Some(p))) if p.price > 0 && p.timestamp <= now && now - p.timestamp <= ORACLE_MAX_AGE_SECS => p.price,
        _ => panic_with_error!(env, Error::OracleUnavailable),
    }
}

fn load_order(env: &Env, id: u32) -> Order {
    let key = DataKey::Order(id);
    match env.storage().persistent().get::<DataKey, Order>(&key) {
        Some(o) => {
            env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
            o
        }
        None => panic_with_error!(env, Error::OrderNotFound),
    }
}

fn save_order(env: &Env, id: u32, order: &Order) {
    let key = DataKey::Order(id);
    env.storage().persistent().set(&key, order);
    env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
}

fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

/// The vault authorizes a token transfer on its own behalf inside a nested call.
fn transfer_auth(env: &Env, token: &Address, from: &Address, to: &Address, amount: i128) -> InvokerContractAuthEntry {
    InvokerContractAuthEntry::Contract(SubContractInvocation {
        context: ContractContext {
            contract: token.clone(),
            fn_name: Symbol::new(env, "transfer"),
            args: (from.clone(), to.clone(), amount).into_val(env),
        },
        sub_invocations: vec![env],
    })
}

fn supply_requests(env: &Env, cfg: &Config, token: &Address, amount: i128) -> Vec<Request> {
    let me = env.current_contract_address();
    env.authorize_as_current_contract(vec![env, transfer_auth(env, token, &me, &cfg.pool, amount)]);
    vec![env, Request { request_type: BLEND_SUPPLY, address: token.clone(), amount }]
}

fn supply_to_pool(env: &Env, cfg: &Config, token: &Address, amount: i128) {
    let me = env.current_contract_address();
    let reqs = supply_requests(env, cfg, token, amount);
    BlendPoolClient::new(env, &cfg.pool).submit(&me, &me, &me, &reqs);
}

/// Tries to supply; does not fail if it cannot (the token stays idle in the vault). Returns whether it succeeded.
fn try_supply_to_pool(env: &Env, cfg: &Config, token: &Address, amount: i128) -> bool {
    let me = env.current_contract_address();
    let reqs = supply_requests(env, cfg, token, amount);
    matches!(BlendPoolClient::new(env, &cfg.pool).try_submit(&me, &me, &me, &reqs), Ok(Ok(_)))
}

fn withdraw_from_pool(env: &Env, cfg: &Config, token: &Address, amount: i128, to: &Address) {
    let me = env.current_contract_address();
    let reqs = vec![env, Request { request_type: BLEND_WITHDRAW, address: token.clone(), amount }];
    BlendPoolClient::new(env, &cfg.pool).submit(&me, &me, to, &reqs);
}

#[cfg(test)]
mod test;
