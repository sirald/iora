//! Iora Blend oracle: a SEP-40 price feed for a Blend v2 pool, backed by the Reflector oracle.
//!
//! A Blend pool asks its oracle for `lastprice(Asset::Stellar(token))` and `decimals()`. Reflector on testnet
//! prices assets by SYMBOL (`Asset::Other("USDC")`), so this contract keeps a table token address -> Reflector
//! symbol and answers the pool's questions from Reflector:
//! - prices are converted from Reflector's decimals (14) to this contract's `DECIMALS` (7), rounding down;
//! - a price older than `max_age` seconds is NOT returned (`None`): the pool then refuses every action that needs
//!   a price (borrowing, withdrawing collateral while in debt, liquidations). Accounts without debt can still
//!   supply and withdraw, the pool does not read prices for them. The pool's own limit (24 hours) is too lax.
//! - an unknown token, an `Asset::Other` asset, or a zero/negative price gives `None` too.
//!
//! The admin can change the table, `max_age` and the Reflector address, hand the admin role over (two steps) and
//! upgrade the code. Everyone else can only read.
#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, panic_with_error, symbol_short, Address, BytesN,
    Env, Symbol, Vec,
};

/// Decimals of every price this contract returns (the same as Blend's own oracles).
pub const DECIMALS: u32 = 7;
/// Default `max_age`: three Reflector rounds (Reflector testnet updates every 300 seconds).
pub const DEFAULT_MAX_AGE: u64 = 900;

const DAY_LEDGERS: u32 = 17_280;
const BUMP_THRESHOLD: u32 = 30 * DAY_LEDGERS;
const BUMP_TO: u32 = 60 * DAY_LEDGERS;

/// SEP-40 asset. Same layout as Reflector's, so it is also used to call Reflector.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Asset {
    Stellar(Address),
    Other(Symbol),
}

/// SEP-40 price record. Same layout as Reflector's. `timestamp` is in seconds.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

/// The part of Reflector this contract uses.
#[contractclient(name = "ReflectorClient")]
pub trait Reflector {
    fn decimals(e: Env) -> u32;
    fn resolution(e: Env) -> u32;
    fn lastprice(e: Env, asset: Asset) -> Option<PriceData>;
    fn price(e: Env, asset: Asset, timestamp: u64) -> Option<PriceData>;
    fn prices(e: Env, asset: Asset, records: u32) -> Option<Vec<PriceData>>;
}

#[contracttype]
#[derive(Clone)]
enum Key {
    Admin,
    PendingAdmin,
    Reflector,
    MaxAge,
    /// Every token in the table, in the order it was added (for `assets()`).
    Tokens,
    /// token address -> Reflector symbol
    Symbol(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum OracleError {
    /// `max_age` must be > 0.
    BadMaxAge = 1,
    /// `accept_admin` without a pending admin.
    NoPendingAdmin = 2,
    /// `remove_asset` for a token that is not in the table.
    UnknownAsset = 3,
}

#[contract]
pub struct BlendOracle;

fn bump_instance(e: &Env) {
    e.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

fn admin(e: &Env) -> Address {
    e.storage().instance().get(&Key::Admin).unwrap()
}

fn require_admin(e: &Env) {
    admin(e).require_auth();
    bump_instance(e);
}

fn reflector(e: &Env) -> ReflectorClient<'_> {
    let id: Address = e.storage().instance().get(&Key::Reflector).unwrap();
    ReflectorClient::new(e, &id)
}

fn tokens(e: &Env) -> Vec<Address> {
    e.storage().instance().get(&Key::Tokens).unwrap_or(Vec::new(e))
}

/// The Reflector symbol of `asset`, or `None` (not a Stellar asset, or not in the table).
fn symbol_of(e: &Env, asset: &Asset) -> Option<Symbol> {
    let token = match asset {
        Asset::Stellar(a) => a.clone(),
        Asset::Other(_) => return None,
    };
    let key = Key::Symbol(token);
    let sym: Option<Symbol> = e.storage().persistent().get(&key);
    if sym.is_some() {
        e.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
    sym
}

/// Converts `price` from `from` decimals to `DECIMALS`, rounding down. `None` when the result is <= 0 or overflows.
pub fn convert(price: i128, from: u32) -> Option<i128> {
    let out = if from >= DECIMALS {
        price.checked_div(10i128.checked_pow(from - DECIMALS)?)?
    } else {
        price.checked_mul(10i128.checked_pow(DECIMALS - from)?)?
    };
    if out > 0 {
        Some(out)
    } else {
        None
    }
}

fn convert_record(p: PriceData, from: u32) -> Option<PriceData> {
    Some(PriceData { price: convert(p.price, from)?, timestamp: p.timestamp })
}

fn put_asset(e: &Env, token: Address, sym: Symbol) {
    let key = Key::Symbol(token.clone());
    e.storage().persistent().set(&key, &sym);
    e.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    let mut list = tokens(e);
    if !list.contains(&token) {
        list.push_back(token);
        e.storage().instance().set(&Key::Tokens, &list);
    }
}

/// The table changed: `token` now maps to `symbol`.
#[contractevent]
pub struct AssetSet {
    #[topic]
    pub token: Address,
    pub symbol: Symbol,
}

/// `token` was removed from the table.
#[contractevent]
pub struct AssetRemoved {
    #[topic]
    pub token: Address,
}

/// `max_age`, the Reflector address or the admin changed.
#[contractevent]
pub struct ConfigChanged {
    #[topic]
    pub what: Symbol,
    pub max_age: u64,
    pub address: Option<Address>,
}

#[contractimpl]
impl BlendOracle {
    /// `assets`: (token address, Reflector symbol) pairs for the initial table.
    pub fn __constructor(e: Env, admin: Address, reflector: Address, max_age: u64, assets: Vec<(Address, Symbol)>) {
        if max_age == 0 {
            panic_with_error!(&e, OracleError::BadMaxAge);
        }
        e.storage().instance().set(&Key::Admin, &admin);
        e.storage().instance().set(&Key::Reflector, &reflector);
        e.storage().instance().set(&Key::MaxAge, &max_age);
        for (token, sym) in assets.iter() {
            put_asset(&e, token, sym);
        }
        bump_instance(&e);
    }

    // ---------- admin ----------

    /// Adds `token` to the table, or changes its symbol.
    pub fn set_asset(e: Env, token: Address, symbol: Symbol) {
        require_admin(&e);
        put_asset(&e, token.clone(), symbol.clone());
        AssetSet { token, symbol }.publish(&e);
    }

    pub fn remove_asset(e: Env, token: Address) {
        require_admin(&e);
        let key = Key::Symbol(token.clone());
        if !e.storage().persistent().has(&key) {
            panic_with_error!(&e, OracleError::UnknownAsset);
        }
        e.storage().persistent().remove(&key);
        let mut list = tokens(&e);
        if let Some(i) = list.first_index_of(&token) {
            list.remove(i);
        }
        e.storage().instance().set(&Key::Tokens, &list);
        AssetRemoved { token }.publish(&e);
    }

    pub fn set_max_age(e: Env, max_age: u64) {
        require_admin(&e);
        if max_age == 0 {
            panic_with_error!(&e, OracleError::BadMaxAge);
        }
        e.storage().instance().set(&Key::MaxAge, &max_age);
        ConfigChanged { what: symbol_short!("max_age"), max_age, address: None }.publish(&e);
    }

    pub fn set_reflector(e: Env, reflector: Address) {
        require_admin(&e);
        e.storage().instance().set(&Key::Reflector, &reflector);
        ConfigChanged { what: symbol_short!("reflector"), max_age: Self::max_age(e.clone()), address: Some(reflector) }.publish(&e);
    }

    /// First step of an admin change; the new admin must call `accept_admin`.
    pub fn propose_admin(e: Env, new_admin: Address) {
        require_admin(&e);
        e.storage().instance().set(&Key::PendingAdmin, &new_admin);
    }

    pub fn accept_admin(e: Env) {
        let pending: Address = match e.storage().instance().get(&Key::PendingAdmin) {
            Some(a) => a,
            None => panic_with_error!(&e, OracleError::NoPendingAdmin),
        };
        pending.require_auth();
        e.storage().instance().set(&Key::Admin, &pending);
        e.storage().instance().remove(&Key::PendingAdmin);
        bump_instance(&e);
        ConfigChanged { what: symbol_short!("admin"), max_age: Self::max_age(e.clone()), address: Some(pending) }.publish(&e);
    }

    pub fn upgrade(e: Env, wasm_hash: BytesN<32>) {
        require_admin(&e);
        e.deployer().update_current_contract(soroban_sdk::ContractExecutable::Wasm(wasm_hash));
    }

    // ---------- reads (not SEP-40) ----------

    pub fn admin(e: Env) -> Address {
        admin(&e)
    }

    pub fn reflector(e: Env) -> Address {
        e.storage().instance().get(&Key::Reflector).unwrap()
    }

    pub fn max_age(e: Env) -> u64 {
        e.storage().instance().get(&Key::MaxAge).unwrap()
    }

    /// The Reflector symbol of `token`, if it is in the table.
    pub fn symbol(e: Env, token: Address) -> Option<Symbol> {
        symbol_of(&e, &Asset::Stellar(token))
    }

    // ---------- SEP-40 ----------

    pub fn base(_e: Env) -> Asset {
        Asset::Other(symbol_short!("USD"))
    }

    pub fn assets(e: Env) -> Vec<Asset> {
        let mut out = Vec::new(&e);
        for t in tokens(&e).iter() {
            out.push_back(Asset::Stellar(t));
        }
        out
    }

    pub fn decimals(_e: Env) -> u32 {
        DECIMALS
    }

    pub fn resolution(e: Env) -> u32 {
        reflector(&e).resolution()
    }

    /// The latest price, or `None` when it is older than `max_age` seconds (see the module comment).
    pub fn lastprice(e: Env, asset: Asset) -> Option<PriceData> {
        bump_instance(&e);
        let sym = symbol_of(&e, &asset)?;
        let r = reflector(&e);
        let p = r.lastprice(&Asset::Other(sym))?;
        let max_age = Self::max_age(e.clone());
        let now = e.ledger().timestamp();
        // A timestamp in the future (clock skew) counts as fresh.
        if now > p.timestamp && now - p.timestamp > max_age {
            return None;
        }
        convert_record(p, r.decimals())
    }

    /// The price at `timestamp` (Reflector's history), converted. No freshness check.
    pub fn price(e: Env, asset: Asset, timestamp: u64) -> Option<PriceData> {
        let sym = symbol_of(&e, &asset)?;
        let r = reflector(&e);
        convert_record(r.price(&Asset::Other(sym), &timestamp)?, r.decimals())
    }

    /// The last `records` prices (Reflector's history), converted; records that convert to <= 0 are dropped.
    pub fn prices(e: Env, asset: Asset, records: u32) -> Option<Vec<PriceData>> {
        let sym = symbol_of(&e, &asset)?;
        let r = reflector(&e);
        let d = r.decimals();
        let mut out = Vec::new(&e);
        for p in r.prices(&Asset::Other(sym), &records)?.iter() {
            if let Some(c) = convert_record(p, d) {
                out.push_back(c);
            }
        }
        Some(out)
    }
}

#[cfg(test)]
mod test;
