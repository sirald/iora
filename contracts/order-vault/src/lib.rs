//! Yield-bearing limit order vault.
//!
//! One vault per user. USDC earns interest in the Blend pool; when a limit buy order
//! triggers, it is withdrawn from Blend and swapped to XLM on Soroswap in the same transaction.
//! For normal orders the price condition is enforced by the swap's `amount_out_min`, not by an oracle.
//! If the condition is not met, the whole transaction is reverted.
//!
//! Added in version 3:
//! - Triggered order (`place_stop_order`): runs when the market price reaches the trigger level; the worst price
//!   is still capped by `limit_price`. In a sell vault this is a stop loss.
//!   The trigger is read from the price oracle the Blend pool uses (it cannot be moved within one transaction);
//!   Soroswap's spot price is not used.
//! - Follow-up order (`place_order_then`): the token that comes out of the fill is deposited into another vault
//!   the owner chose (e.g. the sell vault) and an order is opened there automatically. The target vault only accepts
//!   funds from the vault its owner allowed with `set_feeder`. If the hand-over fails for any reason, the token
//!   goes to the owner's wallet as usual; a fill never stops because of it.
//!
//! Changes in version 4 (internal review, November 2026):
//! - The rounding buffer applies to the first order too; an order fills in at most `MAX_FILLS` pieces and a fill
//!   cannot leave "dust" smaller than the minimum fill behind.
//! - Order lifetime and price are capped; anyone can close an expired order (the reserve is released to its owner).
//! - The target of a follow-up order must be the owner's registered vault in the sibling factory, and the chain
//!   cannot open a sell order below the buy price.
//! - For a triggered order the user chooses the allowed deviation from the oracle (`stop_band_bps`); the limit can
//!   be at most 10% away from the trigger.
//! - If the owner's wallet cannot receive the output token (e.g. no trustline) the fill does not stop: the token
//!   waits in the vault and the owner collects it with `sweep`.
//! - `sweep` works only for the vault's two tokens; `withdraw(WITHDRAW_ALL)` withdraws the whole free balance.
//!
//! Version 5 (fill fee):
//! - `execute` takes the filler's address and pays it a small fee in the token bought. The fee is taken
//!   ONLY from what comes in above the limit and is capped per fill by `exec_fee` (fixed in the factory,
//!   cannot be changed later). The owner always gets at least what their limit promises; exactly at the
//!   limit the fee is zero. So every fill pays for its own network cost without a minimum order amount:
//!   a very small order that does not cover it is not forbidden, it waits until the price is a little past the limit.
#![no_std]

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    panic_with_error, token, vec, Address, Env, IntoVal, Map, Symbol, TryFromVal, Val, Vec,
};

/// Prices use 7 decimals (USDC and XLM both have 7 decimals).
pub const SCALE: i128 = 10_000_000;
/// Blend's b_rate has 12 decimals.
pub const B_RATE_SCALE: i128 = 1_000_000_000_000;
/// Price impact in basis points; 10_000 = check off.
pub const BPS: u32 = 10_000;

/// Blend v2 request types.
const BLEND_SUPPLY: u32 = 0;
const BLEND_WITHDRAW: u32 = 1;

/// Swap deadline: seconds from the time of the transaction. It is computed inside the same transaction, so it is
/// NOT a protection by itself (it is passed because the router requires the parameter). Protection against an old
/// transaction running late comes from the transaction's own time bound and the order's `expiry` field.
const SWAP_DEADLINE_SECS: u64 = 300;

/// An order can fill in at most this many pieces (`min_fill * MAX_FILLS >= amount_in`). With a bounded number of
/// pieces the rounding loss is bounded too, and the price impact limit cannot be dodged by splitting too finely.
pub const MAX_FILLS: i128 = 20;
/// An order can be dated at most this far ahead (the app offers up to 365 days; one day is a margin for the
/// difference between the user's clock and the chain's).
pub const MAX_ORDER_SECS: u64 = 366 * 86_400;
/// Highest price accepted (1 billion deposited tokens for 1 token bought). A bound against overflow.
pub const MAX_PRICE: i128 = SCALE * 1_000_000_000;
/// Special value for `withdraw`: the whole free balance (everything on Blend if there is no open order).
pub const WITHDRAW_ALL: i128 = i128::MAX;
/// Both tokens must have this many decimals; the price maths assumes it.
pub const TOKEN_DECIMALS: u32 = 7;

/// TTL (about 5 s per ledger).
const DAY_IN_LEDGERS: u32 = 17_280;
const BUMP_THRESHOLD: u32 = 7 * DAY_IN_LEDGERS;
const BUMP_TO: u32 = 30 * DAY_IN_LEDGERS;

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

/// Only the fields that are needed are read from Blend's return structs
/// (as a Map), so the vault keeps working if Blend adds fields.
#[contractclient(name = "BlendPoolClient")]
pub trait BlendPool {
    fn submit(env: Env, from: Address, spender: Address, to: Address, requests: Vec<Request>)
        -> Val;
    fn get_positions(env: Env, address: Address) -> Map<Symbol, Val>;
    fn get_reserve(env: Env, asset: Address) -> Map<Symbol, Val>;
    fn get_config(env: Env) -> Map<Symbol, Val>;
    fn claim(env: Env, from: Address, reserve_token_ids: Vec<u32>, to: Address) -> i128;
}

/// SEP-40 / Reflector price oracle (Blend pools use it).
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

/// A triggered order does not run if the oracle price is older than this. Reflector updates every 5 minutes and
/// the timestamp is the start of the period; the old 6-minute bound left a stop loss unable to run when an
/// update was a little late. 10 minutes covers two update periods.
pub const ORACLE_MAX_AGE_SECS: u64 = 10 * 60;
/// In a triggered order the fill may be at most `stop_band_bps` below the fair amount by the oracle.
/// The user chooses the band (0.5% - 10%). The band also covers the swap fee and price impact: whoever fills
/// can move the pool at most that far; a narrow band means a better price, a wide band a better chance of
/// filling in a sharp drop.
pub const STOP_BAND_MIN_BPS: u32 = 50;
pub const STOP_BAND_MAX_BPS: u32 = 1_000;
/// In a triggered order the limit can be at most this far from the trigger (10%, the same as the widest band).
/// In a sell vault that means a "worst price" at most about 9% below the trigger price. A limit typed far
/// away by mistake must not make this protection meaningless.
pub const STOP_MAX_GAP_BPS: i128 = 1_000;

/// Factory. The vault only reads information from it: "are new orders paused", the sibling factory's address
/// and an owner's registered vault. The factory has no authority over funds.
#[contractclient(name = "GuardClient")]
pub trait Guard {
    fn is_paused(env: Env) -> bool;
    /// The sibling factory with the tokens reversed (buy <-> sell). None if not set.
    fn sibling(env: Env) -> Option<Address>;
    fn vault_of(env: Env, owner: Address) -> Option<Address>;
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
    /// Triggered order: the market has not reached the trigger level yet.
    TriggerNotMet = 16,
    /// `receive_and_order`: the sender is not the feeder this vault allows.
    NotFeeder = 17,
    /// The follow-up order settings are invalid.
    InvalidFollowUp = 18,
    /// Triggered order: no current oracle price could be read.
    OracleUnavailable = 19,
    /// Triggered order: the fill price is too far from the oracle price (the pool may have been moved).
    PriceDeviation = 20,
    /// Setup: the deposited token and the bought token cannot be the same.
    SameToken = 21,
    /// `sweep`: only the vault's two tokens can be recovered.
    UnknownToken = 22,
    /// Setup: the tokens must have 7 decimals.
    BadDecimals = 23,
    /// Triggered order: the deviation band is outside the allowed range.
    InvalidBand = 24,
    /// Setup: the fill fee cannot be negative.
    InvalidFee = 25,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub owner: Address,
    pub usdc: Address,
    pub xlm: Address,
    pub pool: Address,
    pub router: Address,
    /// The contract that reports the pause state (the factory).
    pub guard: Address,
    /// Highest fee that may be paid to the filler per fill (in the token bought, 7 decimals). Taken only
    /// from what comes in above the limit; 0 = no fee.
    pub exec_fee: i128,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OrderStatus {
    Open,
    Filled,
    Cancelled,
}

/// USDC -> XLM limit buy order.
/// `limit_price`: the most USDC paid for 1 XLM (7 decimals). 0.20 USDC = 2_000_000.
/// `max_impact_bps`: the largest price impact a single fill may cause in the Soroswap pool.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Order {
    pub amount_in: i128,
    pub filled_in: i128,
    pub filled_out: i128,
    pub limit_price: i128,
    pub min_fill: i128,
    pub max_impact_bps: u32,
    pub expiry: u64,
    pub status: OrderStatus,
    /// 0: a normal limit order. >0: a triggered order; no fill until the market price (in the deposited token, for 1
    /// token bought) reaches this value. Example: a stop loss in a sell vault.
    pub trigger_price: i128,
    /// Triggered orders only: the fill's largest deviation from the oracle price (basis points). 0 for a normal order.
    pub stop_band_bps: u32,
}

/// Follow-up order: the token that comes out of the fill is deposited into `vault` and an order is opened there with these settings.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FollowUp {
    pub vault: Address,
    /// The limit in the target vault's own units (same meaning as the target vault's `place_order` limit).
    pub limit_price: i128,
    pub max_impact_bps: u32,
    /// Lifetime of the target order (seconds), from the moment of the hand-over.
    pub duration: u64,
}

/// The target vault's interface (the same contract code).
#[contractclient(name = "FollowVaultClient")]
pub trait FollowVault {
    fn receive_and_order(env: Env, from: Address, amount: i128, limit_price: i128, max_impact_bps: u32, expiry: u64) -> u32;
    fn get_config(env: Env) -> Config;
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Config,
    /// Principal deposited (informational; interest = balance - principal).
    Deposited,
    /// Amount reserved for open orders.
    Reserved,
    NextId,
    Order(u32),
    /// Lifetime totals (for the history screen).
    Stats,
    /// Follow-up order setting (by order id).
    FollowUp(u32),
    /// The only vault that may deposit into this vault and open an order (with its owner's permission).
    Feeder,
}

/// The vault's lifetime totals. Lifetime interest = balance + withdrawn + spent - deposited.
#[contracttype]
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Stats {
    pub total_deposited: i128,
    pub total_withdrawn: i128,
    pub total_spent: i128,
    pub total_received: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposited {
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawn {
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderPlaced {
    #[topic]
    pub order_id: u32,
    pub amount_in: i128,
    pub limit_price: i128,
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
}

/// Follow-up order: the fill's output was deposited into the target vault and an order was opened there.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Forwarded {
    #[topic]
    pub order_id: u32,
    pub vault: Address,
    pub amount: i128,
    pub new_order_id: u32,
}

/// This vault received funds from another vault and opened an order.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Received {
    pub from: Address,
    pub amount: i128,
    pub order_id: u32,
}

/// Follow-up order: the target vault did not accept the funds; the output was sent to the owner's wallet.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForwardFailed {
    #[topic]
    pub order_id: u32,
    pub vault: Address,
}

/// The owner's wallet could not receive the output token (e.g. no trustline); it waits in the vault and is collected with `sweep`.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Held {
    #[topic]
    pub order_id: u32,
    pub amount: i128,
}

/// Fee paid to the filler (in the token bought; taken from what came in above the limit).
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
pub struct FeederChanged {
    pub feeder: Option<Address>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Swept {
    #[topic]
    pub token: Address,
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
pub struct OrderVault;

#[contractimpl]
impl OrderVault {
    pub fn __constructor(
        env: Env,
        owner: Address,
        usdc: Address,
        xlm: Address,
        pool: Address,
        router: Address,
        guard: Address,
        exec_fee: i128,
    ) {
        if usdc == xlm {
            panic_with_error!(&env, Error::SameToken);
        }
        if exec_fee < 0 {
            panic_with_error!(&env, Error::InvalidFee);
        }
        if token::Client::new(&env, &usdc).decimals() != TOKEN_DECIMALS
            || token::Client::new(&env, &xlm).decimals() != TOKEN_DECIMALS
        {
            panic_with_error!(&env, Error::BadDecimals);
        }
        let cfg = Config { owner, usdc, xlm, pool, router, guard, exec_fee };
        let s = env.storage().instance();
        s.set(&DataKey::Config, &cfg);
        s.set(&DataKey::Deposited, &0i128);
        s.set(&DataKey::Reserved, &0i128);
        s.set(&DataKey::NextId, &0u32);
        bump_instance(&env);
    }

    /// The user deposits USDC; the vault supplies it to Blend straight away.
    pub fn deposit(env: Env, amount: i128) {
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let cfg = config(&env);
        cfg.owner.require_auth();

        let me = env.current_contract_address();
        token::Client::new(&env, &cfg.usdc).transfer(&cfg.owner, &me, &amount);
        supply_to_pool(&env, &cfg, amount);

        set_i128(&env, DataKey::Deposited, get_i128(&env, DataKey::Deposited) + amount);
        update_stats(&env, |st| st.total_deposited += amount);
        bump_instance(&env);
        Deposited { amount }.publish(&env);
    }

    /// The user can withdraw the balance that is not reserved for orders (interest included) at any time.
    /// `amount = WITHDRAW_ALL` withdraws the whole free balance, so interest that accrues between signing and
    /// execution does not stay in the vault as dust.
    pub fn withdraw(env: Env, amount: i128) {
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let cfg = config(&env);
        cfg.owner.require_auth();

        let free = free_of(&env, &cfg);
        let amount = if amount == WITHDRAW_ALL { free } else { amount };
        if amount <= 0 || amount > free {
            panic_with_error!(&env, Error::InsufficientFree);
        }
        let usdc = token::Client::new(&env, &cfg.usdc);
        let before = usdc.balance(&cfg.owner);
        let balance = pool_balance(&env, &cfg);
        if get_i128(&env, DataKey::Reserved) == 0 && amount >= balance {
            // Withdraw everything: asking Blend for more than the balance burns all the b_tokens.
            // That way the result is the same even if interest accrues between simulation and execution
            // (no small "dust" entry is left).
            withdraw_from_pool(&env, &cfg, balance + SCALE, &cfg.owner);
        } else {
            withdraw_from_pool(&env, &cfg, amount, &cfg.owner);
        }
        let sent = usdc.balance(&cfg.owner) - before;
        reduce_principal(&env, sent);
        update_stats(&env, |st| st.total_withdrawn += sent);
        bump_instance(&env);
        Withdrawn { amount: sent }.publish(&env);
    }

    pub fn place_order(
        env: Env,
        amount_in: i128,
        limit_price: i128,
        min_fill: i128,
        max_impact_bps: u32,
        expiry: u64,
    ) -> u32 {
        let cfg = config(&env);
        cfg.owner.require_auth();
        new_order(&env, &cfg, amount_in, limit_price, min_fill, max_impact_bps, expiry, 0, 0)
    }

    /// Triggered order: runs when the market price reaches `trigger_price`, with `limit_price` as the worst
    /// price. Prices are in the same unit as `place_order` (deposited token for 1 token bought).
    /// In a sell vault (XLM -> USDC) the unit is "XLM for 1 USDC", so the price RISES as XLM falls:
    /// "sell if XLM drops below 0.15" = trigger 1/0.15, limit a little above it (room for slippage).
    /// `band_bps`: the fill's largest deviation from the oracle price at that moment (swap fee and price impact included).
    /// The trigger is NOT sticky: if the oracle price has moved back behind the trigger when filling, the order waits.
    #[allow(clippy::too_many_arguments)]
    pub fn place_stop_order(
        env: Env,
        amount_in: i128,
        trigger_price: i128,
        limit_price: i128,
        min_fill: i128,
        max_impact_bps: u32,
        expiry: u64,
        band_bps: u32,
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
        // If the oracle cannot price both tokens the order could never trigger; reject it up front.
        oracle_prices(&env, &cfg);
        new_order(&env, &cfg, amount_in, limit_price, min_fill, max_impact_bps, expiry, trigger_price, band_bps)
    }

    /// Follow-up order: a normal limit order; when it fills, the output token is deposited into `then_vault` and an
    /// order with limit `then_limit`, valid for `then_duration` seconds, is opened there. The target vault's
    /// owner must have approved this vault with `set_feeder`; otherwise the token goes to the wallet.
    #[allow(clippy::too_many_arguments)]
    pub fn place_order_then(
        env: Env,
        amount_in: i128,
        limit_price: i128,
        min_fill: i128,
        max_impact_bps: u32,
        expiry: u64,
        then_vault: Address,
        then_limit: i128,
        then_impact_bps: u32,
        then_duration: u64,
    ) -> u32 {
        let cfg = config(&env);
        cfg.owner.require_auth();
        if limit_price <= 0 || limit_price > MAX_PRICE {
            panic_with_error!(&env, Error::InvalidPrice);
        }
        if then_limit <= 0
            || then_limit > MAX_PRICE
            || then_impact_bps == 0
            || then_impact_bps > BPS
            || then_duration == 0
            || then_duration > 365 * 86_400
            || then_vault == env.current_contract_address()
        {
            panic_with_error!(&env, Error::InvalidFollowUp);
        }
        // The chain cannot open a sell order at a loss: if the product of the two limits is above 1, the sell price is
        // below the buy price (the two limits are in inverse units).
        if limit_price * then_limit > SCALE * SCALE {
            panic_with_error!(&env, Error::InvalidFollowUp);
        }
        // The target must be this owner's REGISTERED vault in the sibling factory. The target's own statement (get_config)
        // is not enough: a fake contract could say "you are my owner" and pull in the output of an order
        // signed through phishing. If the sibling factory is not set, follow-up orders cannot be
        // placed.
        let registered = match GuardClient::new(&env, &cfg.guard).try_sibling() {
            Ok(Ok(Some(f))) => {
                matches!(GuardClient::new(&env, &f).try_vault_of(&cfg.owner), Ok(Ok(Some(v))) if v == then_vault)
            }
            _ => false,
        };
        if !registered {
            panic_with_error!(&env, Error::InvalidFollowUp);
        }
        // The target must also accept the token this order buys as its deposited token.
        match FollowVaultClient::new(&env, &then_vault).try_get_config() {
            Ok(Ok(t)) if t.owner == cfg.owner && t.usdc == cfg.xlm => {}
            _ => panic_with_error!(&env, Error::InvalidFollowUp),
        }
        let id = new_order(&env, &cfg, amount_in, limit_price, min_fill, max_impact_bps, expiry, 0, 0);
        let f = FollowUp { vault: then_vault, limit_price: then_limit, max_impact_bps: then_impact_bps, duration: then_duration };
        let key = DataKey::FollowUp(id);
        env.storage().persistent().set(&key, &f);
        env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        id
    }

    /// The owner chooses the only vault that may deposit into this vault and open an order (e.g. their own buy vault).
    /// `None` removes the permission.
    pub fn set_feeder(env: Env, feeder: Option<Address>) {
        let cfg = config(&env);
        cfg.owner.require_auth();
        match &feeder {
            Some(f) => env.storage().instance().set(&DataKey::Feeder, f),
            None => env.storage().instance().remove(&DataKey::Feeder),
        }
        bump_instance(&env);
        FeederChanged { feeder }.publish(&env);
    }

    /// Called by the feeder vault: takes `amount` of the token from `from`, supplies it to Blend and opens an order
    /// with the given limit. Funds only come into the vault; the owner's funds cannot leave. As a new order it is
    /// subject to the pause rule.
    pub fn receive_and_order(
        env: Env,
        from: Address,
        amount: i128,
        limit_price: i128,
        max_impact_bps: u32,
        expiry: u64,
    ) -> u32 {
        let cfg = config(&env);
        let feeder: Option<Address> = env.storage().instance().get(&DataKey::Feeder);
        if feeder != Some(from.clone()) {
            panic_with_error!(&env, Error::NotFeeder);
        }
        from.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        if GuardClient::new(&env, &cfg.guard).is_paused() {
            panic_with_error!(&env, Error::Paused);
        }
        let me = env.current_contract_address();
        token::Client::new(&env, &cfg.usdc).transfer(&from, &me, &amount);
        supply_to_pool(&env, &cfg, amount);
        set_i128(&env, DataKey::Deposited, get_i128(&env, DataKey::Deposited) + amount);
        update_stats(&env, |st| st.total_deposited += amount);
        Deposited { amount }.publish(&env);

        // Because of Blend's b_token rounding and the buffer, the amount reserved for the order can be slightly less than `amount`.
        let room = orderable_of(&env, &cfg);
        let size = if amount < room { amount } else { room };
        if size <= 0 {
            panic_with_error!(&env, Error::InsufficientFree);
        }
        let min_fill = if size / 4 >= SCALE { size / 4 } else { size };
        let id = new_order(&env, &cfg, size, limit_price, min_fill, max_impact_bps, expiry, 0, 0);
        Received { from, amount, order_id: id }.publish(&env);
        id
    }

    /// The owner cancels an open order. ANYONE can close an expired order: it cannot be filled anyway, and
    /// closing it only releases the reserved amount back to the owner's free balance (no funds move).
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
        set_i128(&env, DataKey::Reserved, get_i128(&env, DataKey::Reserved) - remaining);
        bump_instance(&env);
        OrderCancelled { order_id, remaining }.publish(&env);
    }

    /// Anyone can call. The caller only chooses the order, the fill size and the address the fill fee goes to
    /// (`executor`); the recipient, the limit and the amount are fixed in the contract.
    /// Fill fee: if the swap came out better than the limit, at most `exec_fee` of the difference goes to
    /// `executor`. The owner always gets at least what the limit promises.
    /// Returns: the amount of XLM sent to the user (after the fee).
    pub fn execute(env: Env, executor: Address, order_id: u32, fill_amount: i128) -> i128 {
        let cfg = config(&env);
        let mut order = load_order(&env, order_id);

        if order.status != OrderStatus::Open {
            panic_with_error!(&env, Error::OrderNotOpen);
        }
        if env.ledger().timestamp() > order.expiry {
            panic_with_error!(&env, Error::OrderExpired);
        }
        let remaining = order.amount_in - order.filled_in;
        if fill_amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        if fill_amount > remaining {
            panic_with_error!(&env, Error::FillTooLarge);
        }
        // Minimum fill rule: every fill except the one that completes the order must be at least `min_fill` and
        // must not leave less than `min_fill` behind (otherwise a "remaining - 1" fill could leave the order
        // open with a meaningless crumb).
        let left = remaining - fill_amount;
        if left != 0 && (fill_amount < order.min_fill || left < order.min_fill) {
            panic_with_error!(&env, Error::FillTooSmall);
        }

        let min_out = min_out_for(fill_amount, order.limit_price);
        let me = env.current_contract_address();
        let usdc = token::Client::new(&env, &cfg.usdc);
        let xlm = token::Client::new(&env, &cfg.xlm);
        let router = RouterClient::new(&env, &cfg.router);
        let path = vec![&env, cfg.usdc.clone(), cfg.xlm.clone()];

        // 0a) Triggered order: no fill before the oracle price reaches the trigger level.
        let oracle = if order.trigger_price > 0 { Some(check_trigger(&env, &cfg, order.trigger_price)) } else { None };
        // 0b) Price impact guard: stops a large fill being pushed through a shallow pool.
        if order.max_impact_bps < BPS {
            check_impact(&env, &router, &path, fill_amount, order.max_impact_bps);
        }

        // 1) Withdraw from Blend.
        let usdc_before = usdc.balance(&me);
        withdraw_from_pool(&env, &cfg, fill_amount, &me);
        if usdc.balance(&me) - usdc_before < fill_amount {
            panic_with_error!(&env, Error::PoolShortfall);
        }

        // 2) Swap on Soroswap. If the router cannot deliver the minimum output it fails
        //    and the whole transaction (the Blend withdrawal included) is reverted.
        let pair = router.router_pair_for(&cfg.usdc, &cfg.xlm);
        let xlm_before = xlm.balance(&me);
        let deadline = env.ledger().timestamp() + SWAP_DEADLINE_SECS;
        // This authorization matches only this exact transfer (vault -> pair, this amount) and ends with this
        // call frame; it cannot be used for anything else.
        env.authorize_as_current_contract(vec![
            &env,
            transfer_auth(&env, &cfg.usdc, &me, &pair, fill_amount),
        ]);
        router.swap_exact_tokens_for_tokens(&fill_amount, &min_out, &path, &me, &deadline);

        // 3) We check it ourselves too, without trusting the router.
        let gross = xlm.balance(&me) - xlm_before;
        if gross < min_out {
            panic_with_error!(&env, Error::LimitNotMet);
        }
        // The least the owner must receive: what the limit promises (plus the oracle band for a triggered order).
        let mut floor = min_out;
        // 3b) Triggered order: the output may be below the fair amount by the oracle by at most the chosen band.
        if let Some((p_in, p_out)) = oracle {
            let fair = fill_amount * p_in / p_out;
            let band_min = fair * ((BPS - order.stop_band_bps) as i128);
            if gross * (BPS as i128) < band_min {
                panic_with_error!(&env, Error::PriceDeviation);
            }
            // Rounded up: the band condition still holds after the fee is taken.
            let band_floor = (band_min + (BPS as i128) - 1) / (BPS as i128);
            if band_floor > floor {
                floor = band_floor;
            }
        }
        // 3c) Fill fee: only from what is above `floor`, at most `exec_fee`. If the filler cannot
        //     receive the fee (e.g. no trustline) the fill does not stop; the fee stays with the owner.
        let mut fee = gross - floor;
        if fee > cfg.exec_fee {
            fee = cfg.exec_fee;
        }
        let mut out = gross;
        if fee > 0 && executor != me && matches!(xlm.try_transfer(&me, &executor, &fee), Ok(Ok(_))) {
            out = gross - fee;
            ExecFeePaid { order_id, executor, amount: fee }.publish(&env);
        }

        // 4) The output token goes to the owner; for a follow-up order it is deposited into the vault the owner chose.
        //    If the hand-over fails (no permission, pause, wrong token...) it is rolled back and the token
        //    goes to the owner's wallet as before. If the wallet cannot receive it either (e.g. no trustline) the
        //    token waits in the vault; the fill does not stop, the owner collects it with `sweep`.
        let mut delivered = false;
        if let Some(f) = env.storage().persistent().get::<DataKey, FollowUp>(&DataKey::FollowUp(order_id)) {
            env.storage().persistent().extend_ttl(&DataKey::FollowUp(order_id), BUMP_THRESHOLD, BUMP_TO);
            let expiry = env.ledger().timestamp() + f.duration;
            env.authorize_as_current_contract(vec![
                &env,
                transfer_auth(&env, &cfg.xlm, &me, &f.vault, out),
            ]);
            let target = FollowVaultClient::new(&env, &f.vault);
            if let Ok(Ok(new_id)) = target.try_receive_and_order(&me, &out, &f.limit_price, &f.max_impact_bps, &expiry) {
                delivered = true;
                Forwarded { order_id, vault: f.vault.clone(), amount: out, new_order_id: new_id }.publish(&env);
            } else {
                ForwardFailed { order_id, vault: f.vault.clone() }.publish(&env);
            }
        }
        if !delivered && !matches!(xlm.try_transfer(&me, &cfg.owner, &out), Ok(Ok(_))) {
            Held { order_id, amount: out }.publish(&env);
        }

        order.filled_in += fill_amount;
        order.filled_out += out;
        if order.filled_in == order.amount_in {
            order.status = OrderStatus::Filled;
        }
        save_order(&env, order_id, &order);
        set_i128(&env, DataKey::Reserved, get_i128(&env, DataKey::Reserved) - fill_amount);
        reduce_principal(&env, fill_amount);
        update_stats(&env, |st| {
            st.total_spent += fill_amount;
            st.total_received += out;
        });
        bump_instance(&env);

        OrderFilled { order_id, amount_in: fill_amount, amount_out: out }.publish(&env);
        out
    }

    // ---------------- read functions ----------------

    pub fn get_config(env: Env) -> Config {
        config(&env)
    }

    pub fn get_order(env: Env, order_id: u32) -> Order {
        load_order(&env, order_id)
    }

    /// Sends a token sitting in the vault (outside Blend) to the owner: fill output the wallet could not receive (`Held`)
    /// or a token sent by mistake. Works only for the vault's two tokens; the vault calls no other
    /// contract.
    pub fn sweep(env: Env, token: Address) -> i128 {
        let cfg = config(&env);
        cfg.owner.require_auth();
        if token != cfg.usdc && token != cfg.xlm {
            panic_with_error!(&env, Error::UnknownToken);
        }
        let me = env.current_contract_address();
        let t = token::Client::new(&env, &token);
        let bal = t.balance(&me);
        if bal > 0 {
            t.transfer(&me, &cfg.owner, &bal);
            Swept { token: token.clone(), amount: bal }.publish(&env);
        }
        bal
    }

    /// Claims the rewards Blend distributes (BLND) straight to the owner's wallet.
    pub fn claim_rewards(env: Env, reserve_token_ids: Vec<u32>) -> i128 {
        let cfg = config(&env);
        cfg.owner.require_auth();
        let me = env.current_contract_address();
        let amount = BlendPoolClient::new(&env, &cfg.pool).claim(&me, &reserve_token_ids, &cfg.owner);
        RewardsClaimed { amount }.publish(&env);
        amount
    }

    /// Follow-up order setting (None if there is none).
    pub fn get_follow_up(env: Env, order_id: u32) -> Option<FollowUp> {
        env.storage().persistent().get(&DataKey::FollowUp(order_id))
    }

    pub fn get_feeder(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Feeder)
    }

    /// Principal deposited (minus what was withdrawn and spent).
    pub fn deposited(env: Env) -> i128 {
        get_i128(&env, DataKey::Deposited)
    }

    /// Number of orders placed so far (order ids are 0..order_count).
    pub fn order_count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::NextId).unwrap_or(0)
    }

    pub fn stats(env: Env) -> Stats {
        env.storage().instance().get(&DataKey::Stats).unwrap_or_default()
    }

    pub fn reserved(env: Env) -> i128 {
        get_i128(&env, DataKey::Reserved)
    }

    /// Current balance on Blend (principal + interest).
    pub fn balance(env: Env) -> i128 {
        pool_balance(&env, &config(&env))
    }

    /// Interest earned (balance - principal). Can be negative if the pool took a loss.
    pub fn earned(env: Env) -> i128 {
        pool_balance(&env, &config(&env)) - get_i128(&env, DataKey::Deposited)
    }

    /// Amount that can be withdrawn.
    pub fn free_balance(env: Env) -> i128 {
        free_of(&env, &config(&env))
    }

    /// Amount that can be reserved for a new order (free balance minus the rounding buffer).
    pub fn orderable_balance(env: Env) -> i128 {
        orderable_of(&env, &config(&env))
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Minimum XLM output at the limit price (rounded up, the user never gets less).
pub fn min_out_for(amount_in: i128, limit_price: i128) -> i128 {
    (amount_in * SCALE + limit_price - 1) / limit_price
}

/// Every order type is opened here (authorization is checked by the caller).
#[allow(clippy::too_many_arguments)]
fn new_order(
    env: &Env,
    cfg: &Config,
    amount_in: i128,
    limit_price: i128,
    min_fill: i128,
    max_impact_bps: u32,
    expiry: u64,
    trigger_price: i128,
    stop_band_bps: u32,
) -> u32 {
    // The pause only stops new orders; withdrawals, cancellations and fills of existing
    // orders always work.
    if GuardClient::new(env, &cfg.guard).is_paused() {
        panic_with_error!(env, Error::Paused);
    }
    if amount_in <= 0 || min_fill <= 0 || min_fill > amount_in {
        panic_with_error!(env, Error::InvalidAmount);
    }
    // At most MAX_FILLS pieces: min_fill >= ceil(amount_in / MAX_FILLS).
    if min_fill < (amount_in - 1) / MAX_FILLS + 1 {
        panic_with_error!(env, Error::InvalidAmount);
    }
    if limit_price <= 0 || limit_price > MAX_PRICE {
        panic_with_error!(env, Error::InvalidPrice);
    }
    if max_impact_bps == 0 || max_impact_bps > BPS {
        panic_with_error!(env, Error::InvalidImpact);
    }
    let now = env.ledger().timestamp();
    if expiry <= now || expiry - now > MAX_ORDER_SECS {
        panic_with_error!(env, Error::InvalidExpiry);
    }
    // The same balance cannot be spent by two orders; the rounding buffer cannot be reserved for an order.
    if amount_in > orderable_of(env, cfg) {
        panic_with_error!(env, Error::InsufficientFree);
    }

    let id: u32 = env.storage().instance().get(&DataKey::NextId).unwrap_or(0);
    let order = Order {
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
    };
    save_order(env, id, &order);
    env.storage().instance().set(&DataKey::NextId, &(id + 1));
    set_i128(env, DataKey::Reserved, get_i128(env, DataKey::Reserved) + amount_in);
    bump_instance(env);
    OrderPlaced { order_id: id, amount_in, limit_price }.publish(env);
    id
}

fn config(env: &Env) -> Config {
    env.storage().instance().get(&DataKey::Config).unwrap()
}

fn get_i128(env: &Env, key: DataKey) -> i128 {
    env.storage().instance().get(&key).unwrap_or(0)
}

fn set_i128(env: &Env, key: DataKey, value: i128) {
    env.storage().instance().set(&key, &value);
}

/// Principal goes down first; anything beyond the principal counts as paid from interest.
fn reduce_principal(env: &Env, amount: i128) {
    let d = get_i128(env, DataKey::Deposited);
    set_i128(env, DataKey::Deposited, if amount >= d { 0 } else { d - amount });
}

/// A buffer that cannot be reserved for orders or withdrawn while orders are open (0.001 token). Blend rounds the
/// b_tokens burned up on every withdrawal: each fill takes up to `ceil(b_rate / 1e12)` units more from the
/// reserve. An order fills in at most MAX_FILLS pieces, so this buffer covers the rounding loss of hundreds of
/// orders open at once; without it the last piece could wait with a "pool shortfall" error.
/// Once no order is open the buffer can be withdrawn too (it is the user's money, it just cannot be tied to an order).
pub const ROUNDING_BUFFER: i128 = 10_000;

fn update_stats(env: &Env, f: impl FnOnce(&mut Stats)) {
    let mut st: Stats = env.storage().instance().get(&DataKey::Stats).unwrap_or_default();
    f(&mut st);
    env.storage().instance().set(&DataKey::Stats, &st);
}

fn free_of(env: &Env, cfg: &Config) -> i128 {
    let reserved = get_i128(env, DataKey::Reserved);
    let buffer = if reserved > 0 { ROUNDING_BUFFER } else { 0 };
    let free = pool_balance(env, cfg) - reserved - buffer;
    if free < 0 {
        0
    } else {
        free
    }
}

/// Amount that can be reserved for a new order: the buffer is deducted even with no open order (the first order leaves a buffer too).
fn orderable_of(env: &Env, cfg: &Config) -> i128 {
    let room = pool_balance(env, cfg) - get_i128(env, DataKey::Reserved) - ROUNDING_BUFFER;
    if room < 0 {
        0
    } else {
        room
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

/// The vault's USDC balance on Blend = b_token * b_rate (rounded down).
fn pool_balance(env: &Env, cfg: &Config) -> i128 {
    let pool = BlendPoolClient::new(env, &cfg.pool);
    let reserve = pool.get_reserve(&cfg.usdc);
    let rcfg: Map<Symbol, Val> = field(env, &reserve, "config");
    let rdata: Map<Symbol, Val> = field(env, &reserve, "data");
    let index: u32 = field(env, &rcfg, "index");
    let b_rate: i128 = field(env, &rdata, "b_rate");

    let positions = pool.get_positions(&env.current_contract_address());
    let supply: Map<u32, i128> = field(env, &positions, "supply");
    let b_tokens = supply.get(index).unwrap_or(0);
    b_tokens * b_rate / B_RATE_SCALE
}

/// Price impact of a fill: compared with the unit price of a small probe amount.
/// Both quotes include the swap fee, so the measured difference comes from pool depth alone.
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

/// Is the market price (deposited token for 1 token bought, 7 decimals) at the trigger level?
/// The price is read from the Blend pool's oracle. The pool's spot price is NOT used: it can be moved by
/// buying and selling within the same transaction, and the trigger could be set off falsely.
/// Trigger check; if it passes, returns (price of the deposited token, price of the bought token).
fn check_trigger(env: &Env, cfg: &Config, trigger: i128) -> (i128, i128) {
    let (p_in, p_out) = oracle_prices(env, cfg);
    // Both prices come from the same oracle (same decimals); the ratio has no unit.
    let market = p_out * SCALE / p_in;
    if market < trigger {
        panic_with_error!(env, Error::TriggerNotMet);
    }
    (p_in, p_out)
}

/// Current prices of the two tokens from the Blend pool's oracle.
fn oracle_prices(env: &Env, cfg: &Config) -> (i128, i128) {
    let pc = BlendPoolClient::new(env, &cfg.pool).get_config();
    let oracle: Address = field(env, &pc, "oracle");
    let o = PriceOracleClient::new(env, &oracle);
    (oracle_price(env, &o, &cfg.usdc), oracle_price(env, &o, &cfg.xlm))
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

/// The vault authorizing a token transfer on its own behalf in a sub-call.
fn transfer_auth(
    env: &Env,
    token: &Address,
    from: &Address,
    to: &Address,
    amount: i128,
) -> InvokerContractAuthEntry {
    InvokerContractAuthEntry::Contract(SubContractInvocation {
        context: ContractContext {
            contract: token.clone(),
            fn_name: Symbol::new(env, "transfer"),
            args: (from.clone(), to.clone(), amount).into_val(env),
        },
        sub_invocations: vec![env],
    })
}

fn supply_to_pool(env: &Env, cfg: &Config, amount: i128) {
    let me = env.current_contract_address();
    env.authorize_as_current_contract(vec![
        env,
        transfer_auth(env, &cfg.usdc, &me, &cfg.pool, amount),
    ]);
    let reqs = vec![
        env,
        Request { request_type: BLEND_SUPPLY, address: cfg.usdc.clone(), amount },
    ];
    BlendPoolClient::new(env, &cfg.pool).submit(&me, &me, &me, &reqs);
}

fn withdraw_from_pool(env: &Env, cfg: &Config, amount: i128, to: &Address) {
    let me = env.current_contract_address();
    let reqs = vec![
        env,
        Request { request_type: BLEND_WITHDRAW, address: cfg.usdc.clone(), amount },
    ];
    BlendPoolClient::new(env, &cfg.pool).submit(&me, &me, to, &reqs);
}

#[cfg(test)]
mod test;
