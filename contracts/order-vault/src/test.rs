//! Local tests. Instead of Blend and Soroswap they use mock contracts that imitate
//! their behaviour; the authorization rules are the same as the real ones.
extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    symbol_short, vec, Address, Env, Map, Vec,
};

const U: i128 = 10_000_000; // 1 token (7 decimals)
const NOW: u64 = 1_000_000;
const DAY: u64 = 86_400;
const IMPACT: u32 = 300; // %3

/// Turns a contract error code into the generic error type the client returns.
fn ce(e: Error) -> soroban_sdk::Error {
    e.into()
}

// ---------------------------------------------------------------------------
// Mock Blend pool (b_token + b_rate accounting close to the real one)
// ---------------------------------------------------------------------------

const RESERVE_INDEX: u32 = 3;

#[contracttype]
#[derive(Clone)]
pub enum PoolKey {
    Token,
    BRate,
    BTokens(Address),
    Oracle,
}

#[contracttype]
#[derive(Clone)]
pub struct MockPoolConfig {
    pub bstop_rate: u32,
    pub max_positions: u32,
    pub oracle: Address,
    pub status: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct MockPositions {
    pub collateral: Map<u32, i128>,
    pub liabilities: Map<u32, i128>,
    pub supply: Map<u32, i128>,
}

#[contracttype]
#[derive(Clone)]
pub struct MockReserveConfig {
    pub decimals: u32,
    pub index: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct MockReserveData {
    pub b_rate: i128,
    pub d_rate: i128,
}

#[contracttype]
#[derive(Clone)]
pub struct MockReserve {
    pub asset: Address,
    pub config: MockReserveConfig,
    pub data: MockReserveData,
    pub scalar: i128,
}

#[contract]
pub struct MockPool;

fn b_rate_of(env: &Env) -> i128 {
    env.storage().instance().get(&PoolKey::BRate).unwrap_or(B_RATE_SCALE)
}

#[contractimpl]
impl MockPool {
    pub fn __constructor(env: Env, token: Address) {
        env.storage().instance().set(&PoolKey::Token, &token);
    }

    pub fn submit(env: Env, from: Address, spender: Address, to: Address, requests: Vec<Request>) {
        from.require_auth();
        if spender != from {
            spender.require_auth();
        }
        let token: Address = env.storage().instance().get(&PoolKey::Token).unwrap();
        let tc = TokenClient::new(&env, &token);
        let me = env.current_contract_address();
        let key = PoolKey::BTokens(from.clone());
        let rate = b_rate_of(&env);

        for r in requests.iter() {
            assert!(r.address == token, "unknown asset");
            let bal: i128 = env.storage().instance().get(&key).unwrap_or(0);
            if r.request_type == 0 {
                tc.transfer(&spender, &me, &r.amount);
                let minted = r.amount * B_RATE_SCALE / rate;
                env.storage().instance().set(&key, &(bal + minted));
            } else if r.request_type == 1 {
                let mut amt = r.amount;
                let mut burn = (r.amount * B_RATE_SCALE + rate - 1) / rate;
                if burn > bal {
                    burn = bal;
                    amt = bal * rate / B_RATE_SCALE;
                }
                // If the pool has no cash this transfer fails (not enough liquidity).
                tc.transfer(&me, &to, &amt);
                env.storage().instance().set(&key, &(bal - burn));
            } else {
                panic!("unsupported request");
            }
        }
    }

    pub fn get_positions(env: Env, address: Address) -> MockPositions {
        let b: i128 = env.storage().instance().get(&PoolKey::BTokens(address)).unwrap_or(0);
        let mut supply = Map::new(&env);
        if b > 0 {
            supply.set(RESERVE_INDEX, b);
        }
        MockPositions { collateral: Map::new(&env), liabilities: Map::new(&env), supply }
    }

    pub fn get_reserve(env: Env, asset: Address) -> MockReserve {
        MockReserve {
            asset,
            config: MockReserveConfig { decimals: 7, index: RESERVE_INDEX },
            data: MockReserveData { b_rate: b_rate_of(&env), d_rate: B_RATE_SCALE },
            scalar: SCALE,
        }
    }

    pub fn get_config(env: Env) -> MockPoolConfig {
        let oracle: Address = env.storage().instance().get(&PoolKey::Oracle).unwrap();
        MockPoolConfig { bstop_rate: 0, max_positions: 4, oracle, status: 0 }
    }

    pub fn set_oracle(env: Env, oracle: Address) {
        env.storage().instance().set(&PoolKey::Oracle, &oracle);
    }

    pub fn claim(_env: Env, from: Address, _reserve_token_ids: Vec<u32>, _to: Address) -> i128 {
        from.require_auth();
        0
    }

    /// Imitates interest accruing.
    pub fn set_b_rate(env: Env, rate: i128) {
        env.storage().instance().set(&PoolKey::BRate, &rate);
    }

    pub fn b_tokens(env: Env, who: Address) -> i128 {
        env.storage().instance().get(&PoolKey::BTokens(who)).unwrap_or(0)
    }

    /// Imitates borrowers taking the cash out of the pool.
    pub fn lend_out(env: Env, to: Address, amount: i128) {
        let token: Address = env.storage().instance().get(&PoolKey::Token).unwrap();
        TokenClient::new(&env, &token).transfer(&env.current_contract_address(), &to, &amount);
    }
}

// ---------------------------------------------------------------------------
// Mock Soroswap router (fixed price; optional price impact on large trades)
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub enum RouterKey {
    /// XLM given for 1 USDC (7 decimals).
    Price,
    /// (threshold, bps): on trades above the threshold the output drops by bps.
    Penalty,
}

#[contract]
pub struct MockRouter;

fn quote(env: &Env, amount_in: i128) -> i128 {
    let price: i128 = env.storage().instance().get(&RouterKey::Price).unwrap();
    let base = amount_in * price / SCALE;
    let (threshold, bps): (i128, i128) =
        env.storage().instance().get(&RouterKey::Penalty).unwrap_or((i128::MAX, 0));
    if amount_in > threshold {
        base - base * bps / 10_000
    } else {
        base
    }
}

#[contractimpl]
impl MockRouter {
    pub fn __constructor(env: Env, price: i128) {
        env.storage().instance().set(&RouterKey::Price, &price);
    }

    pub fn set_price(env: Env, price: i128) {
        env.storage().instance().set(&RouterKey::Price, &price);
    }

    pub fn set_penalty(env: Env, threshold: i128, bps: i128) {
        env.storage().instance().set(&RouterKey::Penalty, &(threshold, bps));
    }

    pub fn router_pair_for(env: Env, _token_a: Address, _token_b: Address) -> Address {
        env.current_contract_address()
    }

    pub fn router_get_amounts_out(env: Env, amount_in: i128, _path: Vec<Address>) -> Vec<i128> {
        vec![&env, amount_in, quote(&env, amount_in)]
    }

    pub fn swap_exact_tokens_for_tokens(
        env: Env,
        amount_in: i128,
        amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        deadline: u64,
    ) -> Vec<i128> {
        to.require_auth();
        assert!(env.ledger().timestamp() < deadline, "deadline");
        let out = quote(&env, amount_in);
        if out < amount_out_min {
            panic!("INSUFFICIENT_OUTPUT_AMOUNT");
        }
        let me = env.current_contract_address();
        TokenClient::new(&env, &path.get(0).unwrap()).transfer(&to, &me, &amount_in);
        TokenClient::new(&env, &path.get(1).unwrap()).transfer(&me, &to, &out);
        vec![&env, amount_in, out]
    }
}

// ---------------------------------------------------------------------------
// Mock price oracle (Blend/Reflector interface): price with 7 decimals, adjustable timestamp
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub enum OracleKey {
    Price(Address),
    Age,
    Future,
}

#[contract]
pub struct MockOracle;

#[contractimpl]
impl MockOracle {
    pub fn set_price(env: Env, asset: Address, price: i128) {
        env.storage().instance().set(&OracleKey::Price(asset), &price);
    }

    /// Imitates how many seconds ago the price was updated (stale data test).
    pub fn set_age(env: Env, age: u64) {
        env.storage().instance().set(&OracleKey::Age, &age);
    }

    /// Imitates a timestamp from the future (a broken oracle).
    pub fn set_future(env: Env, secs: u64) {
        env.storage().instance().set(&OracleKey::Future, &secs);
    }

    pub fn lastprice(env: Env, asset: OracleAsset) -> Option<PriceData> {
        let OracleAsset::Stellar(a) = asset else { return None };
        let price: Option<i128> = env.storage().instance().get(&OracleKey::Price(a));
        let age: u64 = env.storage().instance().get(&OracleKey::Age).unwrap_or(0);
        let future: u64 = env.storage().instance().get(&OracleKey::Future).unwrap_or(0);
        price.map(|p| PriceData { price: p, timestamp: env.ledger().timestamp() - age + future })
    }
}

// ---------------------------------------------------------------------------
// Mock pause contract (in place of the factory)
// ---------------------------------------------------------------------------

#[contract]
pub struct MockGuard;

#[contractimpl]
impl MockGuard {
    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&symbol_short!("p")).unwrap_or(false)
    }

    pub fn set_paused(env: Env, paused: bool) {
        env.storage().instance().set(&symbol_short!("p"), &paused);
    }

    /// Sibling factory stand-in: in the tests the same mock contract stands for both factories.
    pub fn sibling(env: Env) -> Option<Address> {
        env.storage().instance().get(&symbol_short!("s"))
    }

    pub fn set_sibling(env: Env, sibling: Address) {
        env.storage().instance().set(&symbol_short!("s"), &sibling);
    }

    pub fn vault_of(env: Env, owner: Address) -> Option<Address> {
        env.storage().instance().get(&(symbol_short!("v"), owner))
    }

    pub fn set_vault(env: Env, owner: Address, vault: Address) {
        env.storage().instance().set(&(symbol_short!("v"), owner), &vault);
    }
}

// ---------------------------------------------------------------------------
// Mock token: can refuse a transfer to a given address (imitates a wallet without a trustline)
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub enum TokKey {
    Bal(Address),
    Blocked(Address),
}

#[contract]
pub struct MockToken;

#[contractimpl]
impl MockToken {
    pub fn decimals(_env: Env) -> u32 {
        7
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage().instance().get(&TokKey::Bal(id)).unwrap_or(0)
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let key = TokKey::Bal(to);
        let bal: i128 = env.storage().instance().get(&key).unwrap_or(0);
        env.storage().instance().set(&key, &(bal + amount));
    }

    pub fn set_blocked(env: Env, who: Address, blocked: bool) {
        env.storage().instance().set(&TokKey::Blocked(who), &blocked);
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let blocked: bool = env.storage().instance().get(&TokKey::Blocked(to.clone())).unwrap_or(false);
        assert!(!blocked, "recipient cannot hold this token");
        let fk = TokKey::Bal(from);
        let tk = TokKey::Bal(to);
        let fb: i128 = env.storage().instance().get(&fk).unwrap_or(0);
        assert!(fb >= amount, "balance");
        env.storage().instance().set(&fk, &(fb - amount));
        let tb: i128 = env.storage().instance().get(&tk).unwrap_or(0);
        env.storage().instance().set(&tk, &(tb + amount));
    }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

struct Setup<'a> {
    env: Env,
    owner: Address,
    outsider: Address,
    usdc: TokenClient<'a>,
    usdc_admin: StellarAssetClient<'a>,
    xlm: TokenClient<'a>,
    pool: MockPoolClient<'a>,
    router: MockRouterClient<'a>,
    guard: MockGuardClient<'a>,
    oracle: MockOracleClient<'a>,
    vault: OrderVaultClient<'a>,
}

/// XLM price 0.20 USDC (1 USDC = 5 XLM). The user has 10,000 USDC.
fn setup() -> Setup<'static> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);

    let admin = Address::generate(&env);
    let owner = Address::generate(&env);
    let outsider = Address::generate(&env);

    let usdc_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let xlm_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let pool_id = env.register(MockPool, (usdc_id.clone(),));
    let router_id = env.register(MockRouter, (5 * U,));
    let guard_id = env.register(MockGuard, ());
    // Oracle: USDC $1.00, XLM $0.20 (same as the pool price)
    let oracle_id = env.register(MockOracle, ());
    MockPoolClient::new(&env, &pool_id).set_oracle(&oracle_id);
    MockOracleClient::new(&env, &oracle_id).set_price(&usdc_id, &10_000_000);
    MockOracleClient::new(&env, &oracle_id).set_price(&xlm_id, &2_000_000);

    StellarAssetClient::new(&env, &usdc_id).mint(&owner, &(10_000 * U));
    StellarAssetClient::new(&env, &xlm_id).mint(&router_id, &(1_000_000 * U));

    let vault_id = env.register(
        OrderVault,
        (
            owner.clone(),
            usdc_id.clone(),
            xlm_id.clone(),
            pool_id.clone(),
            router_id.clone(),
            guard_id.clone(),
            0i128,
        ),
    );

    Setup {
        usdc: TokenClient::new(&env, &usdc_id),
        usdc_admin: StellarAssetClient::new(&env, &usdc_id),
        xlm: TokenClient::new(&env, &xlm_id),
        pool: MockPoolClient::new(&env, &pool_id),
        router: MockRouterClient::new(&env, &router_id),
        guard: MockGuardClient::new(&env, &guard_id),
        oracle: MockOracleClient::new(&env, &oracle_id),
        vault: OrderVaultClient::new(&env, &vault_id),
        env,
        owner,
        outsider,
    }
}

/// Deposit 10,000 USDC, place a 4,000 USDC "XLM <= 0.20" order (minimum fill 500).
fn setup_with_order() -> Setup<'static> {
    let s = setup();
    s.vault.deposit(&(10_000 * U));
    let id = s.vault.place_order(&(4_000 * U), &2_000_000, &(500 * U), &IMPACT, &(NOW + DAY));
    assert_eq!(id, 0);
    s
}

fn assert_order_untouched(s: &Setup) {
    let o = s.vault.get_order(&0);
    assert_eq!(o.filled_in, 0);
    assert_eq!(o.status, OrderStatus::Open);
    assert_eq!(s.vault.reserved(), 4_000 * U);
    assert_eq!(s.vault.balance(), 10_000 * U);
    assert_eq!(s.xlm.balance(&s.owner), 0);
    assert_eq!(s.usdc.balance(&s.vault.address), 0);
    assert_eq!(s.xlm.balance(&s.vault.address), 0);
}

// ---------------------------------------------------------------------------
// Basic flow
// ---------------------------------------------------------------------------

#[test]
fn deposit_goes_to_blend() {
    let s = setup();
    s.vault.deposit(&(10_000 * U));
    assert_eq!(s.pool.b_tokens(&s.vault.address), 10_000 * U);
    assert_eq!(s.usdc.balance(&s.pool.address), 10_000 * U);
    assert_eq!(s.usdc.balance(&s.vault.address), 0);
    assert_eq!(s.vault.balance(), 10_000 * U);
    assert_eq!(s.vault.free_balance(), 10_000 * U);
    assert_eq!(s.vault.earned(), 0);
}

#[test]
fn fills_at_limit_and_sends_xlm_to_owner() {
    let s = setup_with_order();
    assert_eq!(s.vault.free_balance(), 6_000 * U - ROUNDING_BUFFER);

    let out = s.vault.execute(&s.outsider, &0, &(4_000 * U));
    assert_eq!(out, 20_000 * U);
    assert_eq!(s.xlm.balance(&s.owner), 20_000 * U);

    let o = s.vault.get_order(&0);
    assert_eq!(o.status, OrderStatus::Filled);
    assert_eq!(o.filled_out, 20_000 * U);
    assert_eq!(s.vault.reserved(), 0);
    assert_eq!(s.vault.balance(), 6_000 * U);
    assert_eq!(s.vault.free_balance(), 6_000 * U);
    assert_eq!(s.vault.deposited(), 6_000 * U);
}

#[test]
fn better_price_gives_more_xlm() {
    let s = setup_with_order();
    s.router.set_price(&(6 * U)); // XLM 0.1667 USDC
    let out = s.vault.execute(&s.outsider, &0, &(1_000 * U));
    assert_eq!(out, 6_000 * U);
}

#[test]
fn whole_tx_reverts_when_price_is_worse() {
    let s = setup_with_order();
    s.router.set_price(&(4 * U)); // XLM 0.25 USDC: the limit is not met
    assert!(s.vault.try_execute(&s.outsider, &0, &(4_000 * U)).is_err());
    // The Blend withdrawal must be rolled back too.
    assert_eq!(s.pool.b_tokens(&s.vault.address), 10_000 * U);
    assert_order_untouched(&s);
}

#[test]
fn execute_needs_no_signature() {
    // The keeper calls without any signature. Does the vault authorizing token transfers inside Blend and
    // Soroswap on its own behalf really work?
    let s = setup_with_order();
    s.env.set_auths(&[]);
    let out = s.vault.execute(&s.outsider, &0, &(4_000 * U));
    assert_eq!(out, 20_000 * U);
    assert_eq!(s.xlm.balance(&s.owner), 20_000 * U);
}

#[test]
fn only_owner_can_move_funds_or_orders() {
    let s = setup_with_order();
    s.env.set_auths(&[]);
    assert!(s.vault.try_withdraw(&(100 * U)).is_err());
    assert!(s
        .vault
        .try_place_order(&(100 * U), &2_000_000, &(100 * U), &IMPACT, &(NOW + DAY))
        .is_err());
    assert!(s.vault.try_cancel_order(&0).is_err());
    assert!(s.vault.try_deposit(&(100 * U)).is_err());
}

// ---------------------------------------------------------------------------
// Partial fill, liquidity, reserve
// ---------------------------------------------------------------------------

#[test]
fn partial_fill_bounds() {
    let s = setup_with_order();
    assert_eq!(s.vault.try_execute(&s.outsider, &0, &(300 * U)), Err(Ok(ce(Error::FillTooSmall))));
    assert_eq!(s.vault.try_execute(&s.outsider, &0, &0), Err(Ok(ce(Error::InvalidAmount))));

    s.vault.execute(&s.outsider, &0, &(1_000 * U));
    assert_eq!(s.vault.reserved(), 3_000 * U);
    assert_eq!(s.vault.try_execute(&s.outsider, &0, &(3_500 * U)), Err(Ok(ce(Error::FillTooLarge))));

    s.vault.execute(&s.outsider, &0, &(3_000 * U));
    let o = s.vault.get_order(&0);
    assert_eq!(o.status, OrderStatus::Filled);
    assert_eq!(o.filled_out, 20_000 * U);
    assert_eq!(s.vault.try_execute(&s.outsider, &0, &(500 * U)), Err(Ok(ce(Error::OrderNotOpen))));
}

#[test]
fn fill_cannot_leave_remainder_below_min_fill() {
    let s = setup();
    s.vault.deposit(&(10_000 * U));
    s.vault.place_order(&(4_000 * U), &2_000_000, &(1_500 * U), &IMPACT, &(NOW + DAY));
    // Filling 3,000 would leave 1,000 (< the minimum 1,500): rejected.
    assert_eq!(s.vault.try_execute(&s.outsider, &0, &(3_000 * U)), Err(Ok(ce(Error::FillTooSmall))));
    // Trying to leave the order open with a crumb by a "remaining - 1" fill is rejected too.
    assert_eq!(s.vault.try_execute(&s.outsider, &0, &(4_000 * U - 1)), Err(Ok(ce(Error::FillTooSmall))));
    assert_eq!(s.vault.get_order(&0).filled_in, 0);
    // Filling 2,500 leaves 1,500: valid; the rest completes in one piece.
    s.vault.execute(&s.outsider, &0, &(2_500 * U));
    assert_eq!(s.vault.try_execute(&s.outsider, &0, &(1_000 * U)), Err(Ok(ce(Error::FillTooSmall))));
    s.vault.execute(&s.outsider, &0, &(1_500 * U));
    assert_eq!(s.vault.get_order(&0).status, OrderStatus::Filled);
    assert_eq!(s.vault.reserved(), 0);
}

#[test]
fn low_blend_liquidity_reverts_then_partial_succeeds() {
    let s = setup_with_order();
    // Borrowers took 9,000 of the pool's cash; 1,000 is left.
    s.pool.lend_out(&s.outsider, &(9_000 * U));

    assert!(s.vault.try_execute(&s.outsider, &0, &(4_000 * U)).is_err());
    assert_eq!(s.pool.b_tokens(&s.vault.address), 10_000 * U);
    assert_order_untouched(&s);

    // The keeper retries with a smaller amount.
    let out = s.vault.execute(&s.outsider, &0, &(1_000 * U));
    assert_eq!(out, 5_000 * U);
    assert_eq!(s.vault.reserved(), 3_000 * U);
}

#[test]
fn reserved_balance_cannot_be_spent_twice() {
    let s = setup_with_order(); // 4,000 reserved, 6,000 free
    assert_eq!(
        s.vault.try_place_order(&(6_001 * U), &2_000_000, &(1_000 * U), &IMPACT, &(NOW + DAY)),
        Err(Ok(ce(Error::InsufficientFree)))
    );
    assert_eq!(s.vault.try_withdraw(&(6_001 * U)), Err(Ok(ce(Error::InsufficientFree))));

    s.vault.withdraw(&s.vault.free_balance());
    assert_eq!(s.usdc.balance(&s.owner), 6_000 * U - ROUNDING_BUFFER);
    assert_eq!(s.vault.free_balance(), 0);
    // The order can still be filled in full.
    s.vault.execute(&s.outsider, &0, &(4_000 * U));
}

#[test]
fn cancel_releases_reservation() {
    let s = setup_with_order();
    s.vault.cancel_order(&0);
    assert_eq!(s.vault.reserved(), 0);
    assert_eq!(s.vault.free_balance(), 10_000 * U);
    assert_eq!(s.vault.try_execute(&s.outsider, &0, &(4_000 * U)), Err(Ok(ce(Error::OrderNotOpen))));
    assert_eq!(s.vault.try_cancel_order(&0), Err(Ok(ce(Error::OrderNotOpen))));

    s.vault.withdraw(&(10_000 * U));
    assert_eq!(s.usdc.balance(&s.owner), 10_000 * U);
}

#[test]
fn expired_order_cannot_execute() {
    let s = setup_with_order();
    s.env.ledger().set_timestamp(NOW + DAY + 1);
    assert_eq!(s.vault.try_execute(&s.outsider, &0, &(4_000 * U)), Err(Ok(ce(Error::OrderExpired))));
    // The user can cancel an expired order and take the funds back.
    s.vault.cancel_order(&0);
    s.vault.withdraw(&(10_000 * U));
}

#[test]
fn invalid_orders_rejected() {
    let s = setup();
    s.vault.deposit(&(1_000 * U));
    assert_eq!(
        s.vault.try_place_order(&(100 * U), &0, &(10 * U), &IMPACT, &(NOW + DAY)),
        Err(Ok(ce(Error::InvalidPrice)))
    );
    assert_eq!(
        s.vault.try_place_order(&(100 * U), &2_000_000, &(200 * U), &IMPACT, &(NOW + DAY)),
        Err(Ok(ce(Error::InvalidAmount)))
    );
    assert_eq!(
        s.vault.try_place_order(&(100 * U), &2_000_000, &(10 * U), &IMPACT, &NOW),
        Err(Ok(ce(Error::InvalidExpiry)))
    );
    assert_eq!(
        s.vault.try_place_order(&(100 * U), &2_000_000, &(10 * U), &0, &(NOW + DAY)),
        Err(Ok(ce(Error::InvalidImpact)))
    );
    assert_eq!(
        s.vault.try_place_order(&(100 * U), &2_000_000, &(10 * U), &10_001, &(NOW + DAY)),
        Err(Ok(ce(Error::InvalidImpact)))
    );
    assert_eq!(s.vault.try_get_order(&7), Err(Ok(ce(Error::OrderNotFound))));
}

#[test]
fn min_out_rounds_up() {
    assert_eq!(min_out_for(1_000 * U, 2_000_000), 5_000 * U);
    assert_eq!(min_out_for(1, 3), 3_333_334);
}

// ---------------------------------------------------------------------------
// Interest accounting
// ---------------------------------------------------------------------------

/// Pretends the pool earned 5% interest (the cash to pay it is added to the pool too).
fn accrue_5_percent(s: &Setup) {
    s.pool.set_b_rate(&(B_RATE_SCALE * 105 / 100));
    s.usdc_admin.mint(&s.pool.address, &(500 * U));
}

#[test]
fn interest_shows_up_and_is_withdrawable() {
    let s = setup();
    s.vault.deposit(&(10_000 * U));
    accrue_5_percent(&s);

    assert_eq!(s.vault.balance(), 10_500 * U);
    assert_eq!(s.vault.earned(), 500 * U);
    assert_eq!(s.vault.deposited(), 10_000 * U);
    assert_eq!(s.vault.free_balance(), 10_500 * U);

    s.vault.withdraw(&(10_500 * U));
    assert_eq!(s.usdc.balance(&s.owner), 10_500 * U);
    assert_eq!(s.vault.balance(), 0);
    assert_eq!(s.vault.deposited(), 0);
}

#[test]
fn interest_can_fund_orders() {
    let s = setup();
    s.vault.deposit(&(10_000 * U));
    accrue_5_percent(&s);
    // More than the principal, but less than the balance with interest.
    s.vault.place_order(&(10_400 * U), &2_000_000, &(1_000 * U), &IMPACT, &(NOW + DAY));
    assert_eq!(s.vault.free_balance(), 100 * U - ROUNDING_BUFFER);
    s.vault.execute(&s.outsider, &0, &(10_400 * U));
    assert_eq!(s.xlm.balance(&s.owner), 52_000 * U);
    assert_eq!(s.vault.deposited(), 0);
    // Blend's rounding is at most 1 unit.
    let b = s.vault.balance();
    assert!(b >= 100 * U - 1 && b <= 100 * U);
}

#[test]
fn reserved_stays_safe_while_interest_accrues() {
    let s = setup_with_order(); // 4,000 reserved
    accrue_5_percent(&s);
    // Free = 10,500 - 4,000
    assert_eq!(s.vault.free_balance(), 6_500 * U - ROUNDING_BUFFER);
    assert_eq!(s.vault.try_withdraw(&(6_500 * U)), Err(Ok(ce(Error::InsufficientFree))));
    // Withdrawing the whole free balance must not leave the reserve short (rounding buffer).
    s.vault.withdraw(&s.vault.free_balance());
    // The order can still be filled in full.
    s.vault.execute(&s.outsider, &0, &(4_000 * U));
    assert_eq!(s.vault.get_order(&0).status, OrderStatus::Filled);
}

// ---------------------------------------------------------------------------
// Price impact guard
// ---------------------------------------------------------------------------

#[test]
fn high_impact_fill_rejected_smaller_fill_ok() {
    let s = setup_with_order(); // maximum impact 3%
    // Swaps above 2,000 USDC give 5% less XLM (shallow pool).
    s.router.set_penalty(&(2_000 * U), &500);
    assert_eq!(s.vault.try_execute(&s.outsider, &0, &(4_000 * U)), Err(Ok(ce(Error::ImpactTooHigh))));
    assert_order_untouched(&s);

    // The keeper splits it into pieces.
    s.vault.execute(&s.outsider, &0, &(2_000 * U));
    s.vault.execute(&s.outsider, &0, &(2_000 * U));
    assert_eq!(s.vault.get_order(&0).status, OrderStatus::Filled);
    assert_eq!(s.xlm.balance(&s.owner), 20_000 * U);
}

#[test]
fn impact_within_tolerance_passes() {
    let s = setup();
    s.vault.deposit(&(10_000 * U));
    // Maximum impact 6%, pool impact 5%: passes. The limit is 0.25, so the price holds too.
    s.vault.place_order(&(4_000 * U), &2_500_000, &(500 * U), &600, &(NOW + DAY));
    s.router.set_penalty(&(2_000 * U), &500);
    let out = s.vault.execute(&s.outsider, &0, &(4_000 * U));
    assert_eq!(out, 19_000 * U);
}

#[test]
fn impact_check_can_be_disabled() {
    let s = setup();
    s.vault.deposit(&(10_000 * U));
    s.vault.place_order(&(4_000 * U), &2_500_000, &(500 * U), &BPS, &(NOW + DAY));
    s.router.set_penalty(&(2_000 * U), &2_000); // 20% impact
    let out = s.vault.execute(&s.outsider, &0, &(4_000 * U));
    assert_eq!(out, 16_000 * U);
}

// ---------------------------------------------------------------------------
// Pause
// ---------------------------------------------------------------------------

#[test]
fn pause_blocks_only_new_orders() {
    let s = setup_with_order();
    s.guard.set_paused(&true);
    assert_eq!(
        s.vault.try_place_order(&(100 * U), &2_000_000, &(100 * U), &IMPACT, &(NOW + DAY)),
        Err(Ok(ce(Error::Paused)))
    );
    // The existing order can be filled; cancelling and withdrawing work.
    s.vault.execute(&s.outsider, &0, &(1_000 * U));
    s.vault.cancel_order(&0);
    s.vault.withdraw(&(9_000 * U));
    assert_eq!(s.usdc.balance(&s.owner), 9_000 * U);

    s.guard.set_paused(&false);
    s.vault.deposit(&(1_000 * U));
    s.vault.place_order(&(500 * U), &2_000_000, &(100 * U), &IMPACT, &(NOW + DAY));
}

// ---------------------------------------------------------------------------
// Version 2: withdraw everything, order count, lifetime totals
// ---------------------------------------------------------------------------

#[test]
fn withdraw_all_burns_every_b_token() {
    let s = setup();
    s.vault.deposit(&(10_000 * U));
    accrue_5_percent(&s);
    let free = s.vault.free_balance();
    s.vault.withdraw(&free);
    // No dust may be left; otherwise the entry size differs between simulation and execution.
    assert_eq!(s.pool.b_tokens(&s.vault.address), 0);
    assert_eq!(s.usdc.balance(&s.owner), 10_500 * U);
    assert_eq!(s.vault.balance(), 0);
    let st = s.vault.stats();
    assert_eq!(st.total_withdrawn, 10_500 * U);
}

#[test]
fn withdraw_all_pays_interest_accrued_after_quote() {
    // If interest accrues after the user read the balance, everything is still withdrawn.
    let s = setup();
    s.vault.deposit(&(10_000 * U));
    let quoted = s.vault.free_balance(); // 10.000
    accrue_5_percent(&s);
    s.vault.withdraw(&quoted);
    // Requested 10,000 < current balance 10,500 -> a normal withdrawal; 500 of interest stays in the vault.
    assert_eq!(s.usdc.balance(&s.owner), 10_000 * U);
    // Blend rounds the b_tokens burned up: at most 1 unit short.
    let left = s.vault.balance();
    assert!(left >= 500 * U - 1 && left <= 500 * U);
    // A second "withdraw everything" takes the remaining interest and leaves no dust.
    s.vault.withdraw(&s.vault.free_balance());
    assert_eq!(s.pool.b_tokens(&s.vault.address), 0);
    let got = s.usdc.balance(&s.owner);
    assert!(got >= 10_500 * U - 1 && got <= 10_500 * U);
}

#[test]
fn partial_withdraw_with_open_order_keeps_reserve() {
    let s = setup_with_order();
    s.vault.withdraw(&(1_000 * U));
    assert_eq!(s.vault.balance(), 9_000 * U);
    s.vault.execute(&s.outsider, &0, &(4_000 * U));
    assert_eq!(s.vault.get_order(&0).status, OrderStatus::Filled);
}

#[test]
fn order_count_and_lifetime_stats() {
    let s = setup();
    assert_eq!(s.vault.order_count(), 0);
    s.vault.deposit(&(10_000 * U));
    s.vault.place_order(&(4_000 * U), &2_000_000, &(500 * U), &IMPACT, &(NOW + DAY));
    s.vault.place_order(&(1_000 * U), &1_000_000, &(500 * U), &IMPACT, &(NOW + DAY));
    assert_eq!(s.vault.order_count(), 2);

    s.vault.execute(&s.outsider, &0, &(4_000 * U));
    s.vault.cancel_order(&1);
    accrue_5_percent(&s); // 6,000 * 5% = 300 interest
    s.vault.withdraw(&(1_000 * U));

    let st = s.vault.stats();
    assert_eq!(st.total_deposited, 10_000 * U);
    assert_eq!(st.total_spent, 4_000 * U);
    assert_eq!(st.total_received, 20_000 * U);
    assert_eq!(st.total_withdrawn, 1_000 * U);
    // Lifetime interest = balance + withdrawn + spent - deposited
    let lifetime = s.vault.balance() + st.total_withdrawn + st.total_spent - st.total_deposited;
    assert!(lifetime >= 300 * U - 1 && lifetime <= 300 * U);
}

// ---------------------------------------------------------------------------
// Version 3: triggered order (stop) and follow-up order (buy -> sell vault)
// ---------------------------------------------------------------------------

#[test]
fn stop_order_waits_for_trigger_then_fills() {
    let s = setup();
    s.vault.deposit(&(10_000 * U));
    // "Buy if XLM rises to 0.25, pay 0.26 at most" (breakout buy). Market at 0.20.
    let id = s.vault.place_stop_order(&(1_000 * U), &2_500_000, &2_600_000, &(100 * U), &IMPACT, &(NOW + DAY), &300);
    assert_eq!(s.vault.get_order(&id).trigger_price, 2_500_000);
    assert_eq!(s.vault.get_order(&id).stop_band_bps, 300);
    // The price 0.20 is better than the limit but the trigger has not come: no fill.
    assert_eq!(s.vault.try_execute(&s.outsider, &id, &(1_000 * U)), Err(Ok(ce(Error::TriggerNotMet))));
    assert_eq!(s.vault.get_order(&id).filled_in, 0);
    // XLM 0.25: the trigger came (oracle), and the limit (0.26) holds too.
    s.router.set_price(&(4 * U));
    s.oracle.set_price(&s.xlm.address, &2_500_000);
    let out = s.vault.execute(&s.outsider, &id, &(1_000 * U));
    assert_eq!(out, 4_000 * U);
    assert_eq!(s.xlm.balance(&s.owner), 4_000 * U);
    assert_eq!(s.vault.get_order(&id).status, OrderStatus::Filled);
}

#[test]
fn stop_order_still_respects_limit() {
    let s = setup();
    s.vault.deposit(&(10_000 * U));
    let id = s.vault.place_stop_order(&(1_000 * U), &2_500_000, &2_600_000, &(100 * U), &IMPACT, &(NOW + DAY), &300);
    // XLM 0.2857: past the trigger but dearer than the 0.26 limit -> the whole transaction is reverted.
    s.router.set_price(&(35 * U / 10));
    s.oracle.set_price(&s.xlm.address, &2_857_142);
    assert!(s.vault.try_execute(&s.outsider, &id, &(1_000 * U)).is_err());
    assert_eq!(s.vault.get_order(&id).filled_in, 0);
    assert_eq!(s.vault.balance(), 10_000 * U);
    assert_eq!(s.xlm.balance(&s.owner), 0);
}

#[test]
fn stop_order_validation() {
    let s = setup();
    s.vault.deposit(&(1_000 * U));
    assert_eq!(
        s.vault.try_place_stop_order(&(100 * U), &0, &2_000_000, &(10 * U), &IMPACT, &(NOW + DAY), &300),
        Err(Ok(ce(Error::InvalidPrice)))
    );
    // The limit cannot be worse than the trigger (otherwise the order could never fill).
    assert_eq!(
        s.vault.try_place_stop_order(&(100 * U), &2_500_000, &2_400_000, &(10 * U), &IMPACT, &(NOW + DAY), &300),
        Err(Ok(ce(Error::InvalidPrice)))
    );
    // The limit can be at most 10% away from the trigger (2.75 is valid at the edge, 2.76 is not).
    assert_eq!(
        s.vault.try_place_stop_order(&(100 * U), &2_500_000, &2_760_000, &(10 * U), &IMPACT, &(NOW + DAY), &300),
        Err(Ok(ce(Error::InvalidPrice)))
    );
    // The deviation band must be between 0.5% and 10%.
    assert_eq!(
        s.vault.try_place_stop_order(&(100 * U), &2_500_000, &2_600_000, &(10 * U), &IMPACT, &(NOW + DAY), &49),
        Err(Ok(ce(Error::InvalidBand)))
    );
    assert_eq!(
        s.vault.try_place_stop_order(&(100 * U), &2_500_000, &2_600_000, &(10 * U), &IMPACT, &(NOW + DAY), &1_001),
        Err(Ok(ce(Error::InvalidBand)))
    );
    assert_eq!(s.vault.order_count(), 0);
    s.vault.place_stop_order(&(100 * U), &2_500_000, &2_750_000, &(10 * U), &IMPACT, &(NOW + DAY), &300);
    // Normal orders have no trigger and no band.
    let id = s.vault.place_order(&(100 * U), &2_000_000, &(10 * U), &IMPACT, &(NOW + DAY));
    assert_eq!(s.vault.get_order(&id).trigger_price, 0);
    assert_eq!(s.vault.get_order(&id).stop_band_bps, 0);
}

/// Same contract, tokens reversed: XLM is deposited, USDC is bought (sell vault).
fn sell_vault(s: &Setup) -> (OrderVaultClient<'static>, MockPoolClient<'static>) {
    let env = &s.env;
    let xpool = env.register(MockPool, (s.xlm.address.clone(),));
    MockPoolClient::new(env, &xpool).set_oracle(&s.oracle.address);
    let id = env.register(
        OrderVault,
        (
            s.owner.clone(),
            s.xlm.address.clone(),
            s.usdc.address.clone(),
            xpool.clone(),
            s.router.address.clone(),
            s.guard.address.clone(),
            0i128,
        ),
    );
    // Sibling factory entry: this is the owner's sell vault (target check of the follow-up order).
    s.guard.set_sibling(&s.guard.address);
    s.guard.set_vault(&s.owner, &id);
    (OrderVaultClient::new(env, &id), MockPoolClient::new(env, &xpool))
}

#[test]
fn sell_side_stop_loss() {
    let s = setup();
    let (sv, _) = sell_vault(&s);
    StellarAssetClient::new(&s.env, &s.xlm.address).mint(&s.owner, &(1_000 * U));
    s.usdc_admin.mint(&s.router.address, &(1_000_000 * U));
    // The mock router does not tell directions apart: in the sell test the price is "1 XLM = 0.20 USDC".
    s.router.set_price(&2_000_000);
    sv.deposit(&(1_000 * U));
    // "Sell if XLM drops to 0.15, take 0.14 at least": the units are XLM for 1 USDC.
    let trigger = 10_000_000 * SCALE / 1_500_000; // 6.6666666 XLM / USDC (rounded down)
    let limit = 10_000_000 * SCALE / 1_400_000; // 7,1428571
    let id = sv.place_stop_order(&(900 * U), &trigger, &limit, &(100 * U), &IMPACT, &(NOW + DAY), &300);
    // XLM still at 0.20: the stop loss does not run.
    assert_eq!(sv.try_execute(&s.outsider, &id, &(900 * U)), Err(Ok(ce(Error::TriggerNotMet))));
    // XLM dropped to 0.15: it is sold.
    s.router.set_price(&1_500_000);
    s.oracle.set_price(&s.xlm.address, &1_500_000);
    let before = s.usdc.balance(&s.owner); // the 10,000 USDC from setup
    let out = sv.execute(&s.outsider, &id, &(900 * U));
    assert_eq!(out, 135 * U);
    assert_eq!(s.usdc.balance(&s.owner) - before, 135 * U);
}

/// The buy vault has a 4,000 USDC "XLM <= 0.20" order; when it fills, the XLM goes to the sell vault and
/// opens as an "XLM >= 0.25" sell order.
fn chained_setup() -> (Setup<'static>, OrderVaultClient<'static>, MockPoolClient<'static>) {
    let s = setup();
    let (sv, xpool) = sell_vault(&s);
    s.vault.deposit(&(10_000 * U));
    let sell_limit = 10_000_000 * SCALE / 2_500_000; // 4 XLM / USDC = 0.25 USDC / XLM
    let id = s.vault.place_order_then(
        &(4_000 * U),
        &2_000_000,
        &(500 * U),
        &IMPACT,
        &(NOW + DAY),
        &sv.address,
        &sell_limit,
        &IMPACT,
        &(7 * DAY),
    );
    assert_eq!(id, 0);
    assert_eq!(s.vault.get_follow_up(&0).unwrap().vault, sv.address);
    (s, sv, xpool)
}

#[test]
fn chained_order_moves_output_to_sell_vault() {
    let (s, sv, xpool) = chained_setup();
    sv.set_feeder(&Some(s.vault.address.clone()));
    // The keeper calls without a signature: the vault-to-vault transfer authorizations must really work.
    s.env.set_auths(&[]);
    let out = s.vault.execute(&s.outsider, &0, &(4_000 * U));
    assert_eq!(out, 20_000 * U);
    // The XLM went to the sell vault, not the wallet, and is earning on Blend.
    assert_eq!(s.xlm.balance(&s.owner), 0);
    assert_eq!(s.xlm.balance(&s.vault.address), 0);
    assert_eq!(xpool.b_tokens(&sv.address), 20_000 * U);
    assert_eq!(sv.balance(), 20_000 * U);
    // The sell order opened automatically; the rounding buffer is not tied to the order.
    let o = sv.get_order(&0);
    assert_eq!(o.amount_in, 20_000 * U - ROUNDING_BUFFER);
    assert_eq!(o.limit_price, 40_000_000);
    assert_eq!(o.expiry, NOW + 7 * DAY);
    assert_eq!(o.status, OrderStatus::Open);
    assert_eq!(sv.reserved(), 20_000 * U - ROUNDING_BUFFER);
    assert_eq!(sv.stats().total_deposited, 20_000 * U);
    // The buy order closed normally.
    assert_eq!(s.vault.get_order(&0).status, OrderStatus::Filled);
    assert_eq!(s.vault.get_order(&0).filled_out, 20_000 * U);
}

#[test]
fn chained_order_falls_back_to_wallet_without_permission() {
    let (s, sv, xpool) = chained_setup();
    // The sell vault did not allow this buy vault: the XLM goes to the wallet as usual.
    let out = s.vault.execute(&s.outsider, &0, &(4_000 * U));
    assert_eq!(s.xlm.balance(&s.owner), out);
    assert_eq!(xpool.b_tokens(&sv.address), 0);
    assert_eq!(sv.order_count(), 0);
    assert_eq!(s.vault.get_order(&0).status, OrderStatus::Filled);
}

#[test]
fn chained_order_falls_back_when_paused() {
    let (s, sv, _) = chained_setup();
    sv.set_feeder(&Some(s.vault.address.clone()));
    // New orders are paused: the sell order cannot open, but the buy still fills and the XLM goes to the wallet.
    s.guard.set_paused(&true);
    let out = s.vault.execute(&s.outsider, &0, &(4_000 * U));
    assert_eq!(s.xlm.balance(&s.owner), out);
    assert_eq!(sv.order_count(), 0);
    assert_eq!(sv.balance(), 0);
}

#[test]
fn receive_and_order_only_from_feeder() {
    let s = setup();
    let (sv, _) = sell_vault(&s);
    StellarAssetClient::new(&s.env, &s.xlm.address).mint(&s.outsider, &(100 * U));
    // Nobody is allowed.
    assert_eq!(
        sv.try_receive_and_order(&s.outsider, &(100 * U), &40_000_000, &IMPACT, &(NOW + DAY)),
        Err(Ok(ce(Error::NotFeeder)))
    );
    // Permission was given to the buy vault; nobody else can get in.
    sv.set_feeder(&Some(s.vault.address.clone()));
    assert_eq!(
        sv.try_receive_and_order(&s.outsider, &(100 * U), &40_000_000, &IMPACT, &(NOW + DAY)),
        Err(Ok(ce(Error::NotFeeder)))
    );
    // Only the owner can give the permission.
    s.env.set_auths(&[]);
    assert!(sv.try_set_feeder(&Some(s.outsider.clone())).is_err());
}

#[test]
fn place_order_then_validation() {
    let s = setup();
    let (sv, _) = sell_vault(&s);
    s.vault.deposit(&(1_000 * U));
    let bad = |limit: i128, impact: u32, dur: u64, target: &Address| {
        s.vault.try_place_order_then(&(100 * U), &2_000_000, &(10 * U), &IMPACT, &(NOW + DAY), target, &limit, &impact, &dur)
    };
    assert_eq!(bad(0, IMPACT, DAY, &sv.address), Err(Ok(ce(Error::InvalidFollowUp))));
    assert_eq!(bad(40_000_000, 0, DAY, &sv.address), Err(Ok(ce(Error::InvalidFollowUp))));
    assert_eq!(bad(40_000_000, IMPACT, 0, &sv.address), Err(Ok(ce(Error::InvalidFollowUp))));
    assert_eq!(bad(40_000_000, IMPACT, 400 * DAY, &sv.address), Err(Ok(ce(Error::InvalidFollowUp))));
    // Chaining to itself is forbidden.
    assert_eq!(bad(40_000_000, IMPACT, DAY, &s.vault.address), Err(Ok(ce(Error::InvalidFollowUp))));
    // On an error no order may be created either.
    assert_eq!(s.vault.order_count(), 0);
    assert_eq!(s.vault.reserved(), 0);
}

#[test]
fn chain_target_must_be_own_matching_vault() {
    // Independent review: the chain's target cannot be someone else's vault (the output would go to them) and the
    // target must be a vault that accepts the token this order buys (XLM).
    let s = setup();
    s.vault.deposit(&(1_000 * U));
    let env = &s.env;
    let place = |target: &Address| {
        s.vault.try_place_order_then(&(100 * U), &2_000_000, &(10 * U), &IMPACT, &(NOW + DAY), target, &40_000_000, &IMPACT, &DAY)
    };
    // Someone else's (outsider) sell vault
    let xpool = env.register(MockPool, (s.xlm.address.clone(),));
    let foreign = env.register(
        OrderVault,
        (s.outsider.clone(), s.xlm.address.clone(), s.usdc.address.clone(), xpool, s.router.address.clone(), s.guard.address.clone(), 0i128),
    );
    assert_eq!(place(&foreign), Err(Ok(ce(Error::InvalidFollowUp))));
    // Another buy vault of the owner: accepts USDC, not XLM
    let upool = env.register(MockPool, (s.usdc.address.clone(),));
    let other_buy = env.register(
        OrderVault,
        (s.owner.clone(), s.usdc.address.clone(), s.xlm.address.clone(), upool, s.router.address.clone(), s.guard.address.clone(), 0i128),
    );
    assert_eq!(place(&other_buy), Err(Ok(ce(Error::InvalidFollowUp))));
    assert_eq!(s.vault.order_count(), 0);
    // The owner's own sell vault: accepted
    let (sv, _) = sell_vault(&s);
    assert!(place(&sv.address).is_ok());
    assert_eq!(s.vault.get_follow_up(&0).unwrap().vault, sv.address);
}

// ---------------------------------------------------------------------------
// After the security review: the trigger is read from the oracle, a token left in the vault is recovered
// ---------------------------------------------------------------------------

#[test]
fn stop_trigger_ignores_manipulated_pool_price() {
    // Attack: push the price down by selling into the pool in the same transaction, set off the stop loss, buy back.
    let s = setup();
    let (sv, _) = sell_vault(&s);
    StellarAssetClient::new(&s.env, &s.xlm.address).mint(&s.owner, &(1_000 * U));
    s.usdc_admin.mint(&s.router.address, &(1_000_000 * U));
    s.router.set_price(&2_000_000);
    sv.deposit(&(1_000 * U));
    let trigger = 10_000_000 * SCALE / 1_500_000;
    let limit = 10_000_000 * SCALE / 1_400_000;
    let id = sv.place_stop_order(&(900 * U), &trigger, &limit, &(100 * U), &IMPACT, &(NOW + DAY), &300);
    // The pool price was pushed to 0.145 but the real price (oracle) is still 0.20: no fill.
    s.router.set_price(&1_450_000);
    assert_eq!(sv.try_execute(&s.outsider, &id, &(900 * U)), Err(Ok(ce(Error::TriggerNotMet))));
    assert_eq!(sv.get_order(&id).filled_in, 0);
    assert_eq!(sv.balance(), 1_000 * U);
}

#[test]
fn stop_trigger_needs_fresh_oracle_price() {
    let s = setup();
    s.vault.deposit(&(10_000 * U));
    let id = s.vault.place_stop_order(&(1_000 * U), &2_500_000, &2_600_000, &(100 * U), &IMPACT, &(NOW + DAY), &300);
    s.router.set_price(&(4 * U));
    s.oracle.set_price(&s.xlm.address, &2_500_000);
    // The oracle has not updated for 20 minutes: the triggered order does not run.
    s.oracle.set_age(&(20 * 60));
    assert_eq!(s.vault.try_execute(&s.outsider, &id, &(1_000 * U)), Err(Ok(ce(Error::OracleUnavailable))));
    s.oracle.set_age(&60);
    s.vault.execute(&s.outsider, &id, &(1_000 * U));
    // Normal limit orders never look at the oracle.
    s.oracle.set_age(&(99 * 60));
    let id2 = s.vault.place_order(&(1_000 * U), &2_600_000, &(100 * U), &IMPACT, &(NOW + DAY));
    s.vault.execute(&s.outsider, &id2, &(1_000 * U));
}

#[test]
fn owner_can_sweep_stray_tokens_and_claim() {
    let s = setup();
    s.vault.deposit(&(1_000 * U));
    // XLM sent to the vault by mistake
    StellarAssetClient::new(&s.env, &s.xlm.address).mint(&s.vault.address, &(7 * U));
    assert_eq!(s.vault.sweep(&s.xlm.address), 7 * U);
    assert_eq!(s.xlm.balance(&s.owner), 7 * U);
    assert_eq!(s.xlm.balance(&s.vault.address), 0);
    // Funds on Blend cannot be taken with sweep (only a token sitting in the vault).
    assert_eq!(s.vault.sweep(&s.usdc.address), 0);
    assert_eq!(s.vault.balance(), 1_000 * U);
    s.vault.claim_rewards(&vec![&s.env, 1u32]);
    // Owner only
    s.env.set_auths(&[]);
    assert!(s.vault.try_sweep(&s.xlm.address).is_err());
    assert!(s.vault.try_claim_rewards(&vec![&s.env, 1u32]).is_err());
}

// ---------------------------------------------------------------------------
// After the second review
// ---------------------------------------------------------------------------

#[test]
fn stop_fill_must_be_close_to_oracle_price() {
    // The stop loss triggered (oracle 0.15) but the pool was pushed to 0.143: even though the limit (0.14) allows it,
    // the fill is rejected because it is more than 3% worse than the oracle.
    let s = setup();
    let (sv, _) = sell_vault(&s);
    StellarAssetClient::new(&s.env, &s.xlm.address).mint(&s.owner, &(1_000 * U));
    s.usdc_admin.mint(&s.router.address, &(1_000_000 * U));
    sv.deposit(&(1_000 * U));
    let trigger = 10_000_000 * SCALE / 1_500_000;
    let limit = 10_000_000 * SCALE / 1_400_000;
    let id = sv.place_stop_order(&(900 * U), &trigger, &limit, &(100 * U), &IMPACT, &(NOW + DAY), &300);
    s.oracle.set_price(&s.xlm.address, &1_500_000);
    s.router.set_price(&1_430_000);
    assert_eq!(sv.try_execute(&s.outsider, &id, &(900 * U)), Err(Ok(ce(Error::PriceDeviation))));
    assert_eq!(sv.balance(), 1_000 * U);
    // The pool is close to the oracle (0.148, 1.3% below): the fill passes.
    s.router.set_price(&1_480_000);
    let out = sv.execute(&s.outsider, &id, &(900 * U));
    assert_eq!(out, 900 * 1_480_000);
}

#[test]
fn stop_order_needs_oracle_prices_when_placed() {
    let s = setup();
    s.vault.deposit(&(1_000 * U));
    // The oracle gives no XLM price: the order could never trigger, so it is rejected up front.
    s.oracle.set_price(&s.xlm.address, &0);
    assert_eq!(
        s.vault.try_place_stop_order(&(100 * U), &2_500_000, &2_600_000, &(10 * U), &IMPACT, &(NOW + DAY), &300),
        Err(Ok(ce(Error::OracleUnavailable)))
    );
    // A timestamp from the future is invalid too.
    s.oracle.set_price(&s.xlm.address, &2_000_000);
    s.oracle.set_future(&600);
    assert_eq!(
        s.vault.try_place_stop_order(&(100 * U), &2_500_000, &2_600_000, &(10 * U), &IMPACT, &(NOW + DAY), &300),
        Err(Ok(ce(Error::OracleUnavailable)))
    );
    // A normal order does not depend on the oracle.
    s.vault.place_order(&(100 * U), &2_000_000, &(10 * U), &IMPACT, &(NOW + DAY));
}

#[test]
#[should_panic]
fn vault_rejects_same_token_twice() {
    let s = setup();
    s.env.register(
        OrderVault,
        (
            s.owner.clone(),
            s.usdc.address.clone(),
            s.usdc.address.clone(),
            s.pool.address.clone(),
            s.router.address.clone(),
            s.guard.address.clone(),
            0i128,
        ),
    );
}

// ---------------------------------------------------------------------------
// After the internal review (November 2026): one test per finding
// ---------------------------------------------------------------------------

#[test]
fn first_order_leaves_rounding_buffer() {
    // Finding 5: the buffer is left on the first order too; the whole balance cannot be tied to an order.
    let s = setup();
    s.vault.deposit(&(1_000 * U));
    assert_eq!(s.vault.free_balance(), 1_000 * U);
    assert_eq!(s.vault.orderable_balance(), 1_000 * U - ROUNDING_BUFFER);
    assert_eq!(
        s.vault.try_place_order(&(1_000 * U), &2_000_000, &(250 * U), &IMPACT, &(NOW + DAY)),
        Err(Ok(ce(Error::InsufficientFree)))
    );
    let all = s.vault.orderable_balance();
    s.vault.place_order(&all, &2_000_000, &(100 * U), &IMPACT, &(NOW + DAY));
    assert_eq!(s.vault.orderable_balance(), 0);
    assert_eq!(s.vault.free_balance(), 0);
    // Even with rounding as interest accrues (b_rate above 1) the order fills completely in four pieces.
    s.pool.set_b_rate(&(B_RATE_SCALE * 1_337 / 1_000));
    s.usdc_admin.mint(&s.pool.address, &(337 * U));
    for _ in 0..3 {
        s.vault.execute(&s.outsider, &0, &(250 * U));
    }
    let o = s.vault.get_order(&0);
    s.vault.execute(&s.outsider, &0, &(o.amount_in - o.filled_in));
    assert_eq!(s.vault.get_order(&0).status, OrderStatus::Filled);
    assert_eq!(s.vault.reserved(), 0);
}

#[test]
fn order_cannot_be_split_into_too_many_fills() {
    // Findings 4 and 5: min_fill cannot be smaller than one MAX_FILLS-th of the amount.
    let s = setup();
    s.vault.deposit(&(10_000 * U));
    assert_eq!(
        s.vault.try_place_order(&(2_000 * U), &2_000_000, &(100 * U - 1), &IMPACT, &(NOW + DAY)),
        Err(Ok(ce(Error::InvalidAmount)))
    );
    assert_eq!(
        s.vault.try_place_order(&(2_000 * U), &2_000_000, &1, &IMPACT, &(NOW + DAY)),
        Err(Ok(ce(Error::InvalidAmount)))
    );
    s.vault.place_order(&(2_000 * U), &2_000_000, &(100 * U), &IMPACT, &(NOW + DAY));
}

#[test]
fn expiry_and_price_have_upper_bounds() {
    // Finding 7.
    let s = setup();
    s.vault.deposit(&(1_000 * U));
    assert_eq!(
        s.vault.try_place_order(&(100 * U), &2_000_000, &(100 * U), &IMPACT, &(NOW + MAX_ORDER_SECS + 1)),
        Err(Ok(ce(Error::InvalidExpiry)))
    );
    assert_eq!(
        s.vault.try_place_order(&(100 * U), &(MAX_PRICE + 1), &(100 * U), &IMPACT, &(NOW + DAY)),
        Err(Ok(ce(Error::InvalidPrice)))
    );
    s.vault.place_order(&(100 * U), &MAX_PRICE, &(100 * U), &IMPACT, &(NOW + MAX_ORDER_SECS));
}

#[test]
fn anyone_can_close_an_expired_order() {
    // Finding 7: anyone can close an expired order so that it does not keep holding the reserve.
    let s = setup_with_order();
    s.env.set_auths(&[]);
    // Before it expires only the owner can cancel.
    assert!(s.vault.try_cancel_order(&0).is_err());
    s.env.ledger().set_timestamp(NOW + DAY + 1);
    s.vault.cancel_order(&0);
    assert_eq!(s.vault.get_order(&0).status, OrderStatus::Cancelled);
    assert_eq!(s.vault.reserved(), 0);
    // No funds moved: everything is still in the vault and belongs to its owner.
    assert_eq!(s.vault.balance(), 10_000 * U);
    assert_eq!(s.vault.free_balance(), 10_000 * U);
    assert_eq!(s.usdc.balance(&s.outsider), 0);
}

#[test]
fn chain_cannot_sell_below_buy_price() {
    // Finding 8: buying at 0.20 and selling at 0.1667 (limit 6 XLM/USDC) is not accepted in a chain.
    let s = setup();
    let (sv, _) = sell_vault(&s);
    s.vault.deposit(&(1_000 * U));
    let place = |then_limit: i128| {
        s.vault.try_place_order_then(&(100 * U), &2_000_000, &(25 * U), &IMPACT, &(NOW + DAY), &sv.address, &then_limit, &IMPACT, &DAY)
    };
    assert_eq!(place(60_000_000), Err(Ok(ce(Error::InvalidFollowUp))));
    assert_eq!(place(MAX_PRICE + 1), Err(Ok(ce(Error::InvalidFollowUp))));
    assert_eq!(s.vault.order_count(), 0);
    // Selling at the buy price (5 XLM/USDC) is the edge: accepted.
    assert!(place(50_000_000).is_ok());
}

#[test]
fn chain_target_must_be_registered_in_sibling_factory() {
    // Finding 3: the target's own statement is not enough. A vault whose owner and tokens look right but that is not
    // registered in the sibling factory cannot be the target.
    let s = setup();
    s.vault.deposit(&(1_000 * U));
    let env = &s.env;
    let place = |target: &Address| {
        s.vault.try_place_order_then(&(100 * U), &2_000_000, &(25 * U), &IMPACT, &(NOW + DAY), target, &40_000_000, &IMPACT, &DAY)
    };
    let xpool = env.register(MockPool, (s.xlm.address.clone(),));
    let unregistered = env.register(
        OrderVault,
        (s.owner.clone(), s.xlm.address.clone(), s.usdc.address.clone(), xpool, s.router.address.clone(), s.guard.address.clone(), 0i128),
    );
    // The sibling factory was never set.
    assert_eq!(place(&unregistered), Err(Ok(ce(Error::InvalidFollowUp))));
    // There is a sibling factory, but the owner's registered vault is a different address.
    let (sv, _) = sell_vault(&s);
    assert_eq!(place(&unregistered), Err(Ok(ce(Error::InvalidFollowUp))));
    assert_eq!(s.vault.order_count(), 0);
    assert!(place(&sv.address).is_ok());
}

#[test]
fn stop_band_is_chosen_by_the_user() {
    // Finding 1: with a 1% band, a fill 1.3% worse than the oracle is rejected (it would pass with a 3% band).
    let s = setup();
    let (sv, _) = sell_vault(&s);
    StellarAssetClient::new(&s.env, &s.xlm.address).mint(&s.owner, &(1_000 * U));
    s.usdc_admin.mint(&s.router.address, &(1_000_000 * U));
    sv.deposit(&(1_000 * U));
    let trigger = 10_000_000 * SCALE / 1_500_000;
    let limit = 10_000_000 * SCALE / 1_400_000;
    let id = sv.place_stop_order(&(900 * U), &trigger, &limit, &(300 * U), &IMPACT, &(NOW + DAY), &100);
    s.oracle.set_price(&s.xlm.address, &1_500_000);
    s.router.set_price(&1_480_000);
    assert_eq!(sv.try_execute(&s.outsider, &id, &(900 * U)), Err(Ok(ce(Error::PriceDeviation))));
    assert_eq!(sv.get_order(&id).filled_in, 0);
    // 0.67% worse than the oracle: inside the band.
    s.router.set_price(&1_490_000);
    let out = sv.execute(&s.outsider, &id, &(900 * U));
    assert_eq!(out, 900 * 1_490_000);
}

#[test]
fn withdraw_all_sentinel_takes_everything_free() {
    // Finding 12: the special value also withdraws interest that accrued between signing and execution.
    let s = setup();
    s.vault.deposit(&(10_000 * U));
    accrue_5_percent(&s);
    s.vault.withdraw(&WITHDRAW_ALL);
    assert_eq!(s.pool.b_tokens(&s.vault.address), 0);
    assert_eq!(s.usdc.balance(&s.owner), 10_500 * U);
    assert_eq!(s.vault.deposited(), 0);
    // An error if nothing is left to withdraw.
    assert_eq!(s.vault.try_withdraw(&WITHDRAW_ALL), Err(Ok(ce(Error::InsufficientFree))));
}

#[test]
fn withdraw_all_sentinel_never_touches_reserved() {
    let s = setup_with_order(); // 4,000 reserved
    s.vault.withdraw(&WITHDRAW_ALL);
    assert_eq!(s.usdc.balance(&s.owner), 6_000 * U - ROUNDING_BUFFER);
    assert_eq!(s.vault.reserved(), 4_000 * U);
    s.vault.execute(&s.outsider, &0, &(4_000 * U));
    assert_eq!(s.vault.get_order(&0).status, OrderStatus::Filled);
}

#[test]
fn sweep_only_works_for_the_two_vault_tokens() {
    // Finding 10: the vault does not call an arbitrary contract even if its owner asks.
    let s = setup();
    let other = s.env.register(MockToken, ());
    MockTokenClient::new(&s.env, &other).mint(&s.vault.address, &(5 * U));
    assert_eq!(s.vault.try_sweep(&other), Err(Ok(ce(Error::UnknownToken))));
}

#[test]
fn output_waits_in_vault_when_wallet_cannot_receive() {
    // Finding 9: if the owner's wallet cannot receive the output token (no trustline) the fill does not stop; the
    // token waits in the vault and the owner collects it later with `sweep`.
    let s = setup();
    let env = &s.env;
    let tok = env.register(MockToken, ());
    let t = MockTokenClient::new(env, &tok);
    t.mint(&s.router.address, &(1_000_000 * U));
    let vid = env.register(
        OrderVault,
        (s.owner.clone(), s.usdc.address.clone(), tok.clone(), s.pool.address.clone(), s.router.address.clone(), s.guard.address.clone(), 0i128),
    );
    let v = OrderVaultClient::new(env, &vid);
    v.deposit(&(1_000 * U));
    v.place_order(&(400 * U), &2_000_000, &(200 * U), &IMPACT, &(NOW + DAY));
    t.set_blocked(&s.owner, &true);

    let out = v.execute(&s.outsider, &0, &(200 * U));
    assert_eq!(out, 1_000 * U);
    assert_eq!(t.balance(&s.owner), 0);
    assert_eq!(t.balance(&vid), 1_000 * U);
    // The waiting token does not distort the next fill's measurement.
    let out2 = v.execute(&s.outsider, &0, &(200 * U));
    assert_eq!(out2, 1_000 * U);
    assert_eq!(v.get_order(&0).status, OrderStatus::Filled);
    assert_eq!(v.get_order(&0).filled_out, 2_000 * U);
    assert_eq!(v.reserved(), 0);
    assert_eq!(t.balance(&vid), 2_000 * U);

    // Only the owner can collect it.
    env.set_auths(&[]);
    assert!(v.try_sweep(&tok).is_err());
    env.mock_all_auths();
    t.set_blocked(&s.owner, &false);
    assert_eq!(v.sweep(&tok), 2_000 * U);
    assert_eq!(t.balance(&s.owner), 2_000 * U);
    assert_eq!(t.balance(&vid), 0);
}

#[test]
#[should_panic]
fn vault_rejects_address_that_is_not_a_7_decimal_token() {
    // MockPool is not a token (no decimals): setup must be rejected.
    let s = setup();
    s.env.register(
        OrderVault,
        (
            s.owner.clone(),
            s.usdc.address.clone(),
            s.pool.address.clone(),
            s.pool.address.clone(),
            s.router.address.clone(),
            s.guard.address.clone(),
            0i128,
        ),
    );
}

// ---------------------------------------------------------------------------
// Version 5: fill fee (to the filler, only from what comes in above the limit)
// ---------------------------------------------------------------------------

const FEE: i128 = U / 10; // at most 0.1 token per fill

/// Buy vault with a fill fee (same mock pool and router); 10,000 USDC deposited.
fn fee_vault(s: &Setup) -> OrderVaultClient<'static> {
    let env = &s.env;
    let id = env.register(
        OrderVault,
        (s.owner.clone(), s.usdc.address.clone(), s.xlm.address.clone(), s.pool.address.clone(), s.router.address.clone(), s.guard.address.clone(), FEE),
    );
    let v = OrderVaultClient::new(env, &id);
    v.deposit(&(10_000 * U));
    v
}

#[test]
fn exec_fee_is_paid_from_price_improvement() {
    // Limit 0.25; market 0.20: the owner must get at least 16,000 XLM, the swap gives 20,000.
    // The filler only gets the fixed fee; the rest of the improvement belongs to the owner.
    let s = setup();
    let v = fee_vault(&s);
    let filler = Address::generate(&s.env);
    assert_eq!(v.get_config().exec_fee, FEE);
    v.place_order(&(4_000 * U), &2_500_000, &(500 * U), &IMPACT, &(NOW + DAY));
    // Real authorization checks are on: the filler signs nothing, the vault sends the fee on its own behalf.
    s.env.set_auths(&[]);
    let out = v.execute(&filler, &0, &(4_000 * U));
    assert_eq!(out, 20_000 * U - FEE);
    assert_eq!(s.xlm.balance(&filler), FEE);
    assert_eq!(s.xlm.balance(&s.owner), 20_000 * U - FEE);
    assert_eq!(s.xlm.balance(&v.address), 0);
    assert_eq!(v.get_order(&0).filled_out, 20_000 * U - FEE);
    assert_eq!(v.stats().total_received, 20_000 * U - FEE);
}

#[test]
fn exec_fee_is_zero_when_fill_is_exactly_at_limit() {
    // Limit 0.20; market 0.20: no improvement, no fee. The owner gets exactly what the limit promises.
    let s = setup();
    let v = fee_vault(&s);
    let filler = Address::generate(&s.env);
    v.place_order(&(4_000 * U), &2_000_000, &(500 * U), &IMPACT, &(NOW + DAY));
    let out = v.execute(&filler, &0, &(4_000 * U));
    assert_eq!(out, 20_000 * U);
    assert_eq!(s.xlm.balance(&filler), 0);
    assert_eq!(s.xlm.balance(&s.owner), 20_000 * U);
}

#[test]
fn exec_fee_never_cuts_below_the_limit() {
    // The improvement is smaller than the fee (4,000 units): the filler only gets that much,
    // the owner still gets exactly what the limit promises (20,000 XLM).
    let s = setup();
    let v = fee_vault(&s);
    let filler = Address::generate(&s.env);
    v.place_order(&(4_000 * U), &2_000_000, &(500 * U), &IMPACT, &(NOW + DAY));
    s.router.set_price(&(5 * U + 1));
    let out = v.execute(&filler, &0, &(4_000 * U));
    assert_eq!(out, 20_000 * U);
    assert_eq!(s.xlm.balance(&filler), 4_000);
    assert_eq!(s.xlm.balance(&s.owner), 20_000 * U);
}

#[test]
fn exec_fee_is_charged_per_fill() {
    let s = setup();
    let v = fee_vault(&s);
    let filler = Address::generate(&s.env);
    v.place_order(&(4_000 * U), &2_500_000, &(500 * U), &IMPACT, &(NOW + DAY));
    assert_eq!(v.execute(&filler, &0, &(2_000 * U)), 10_000 * U - FEE);
    assert_eq!(v.execute(&filler, &0, &(2_000 * U)), 10_000 * U - FEE);
    assert_eq!(s.xlm.balance(&filler), 2 * FEE);
    assert_eq!(s.xlm.balance(&s.owner), 20_000 * U - 2 * FEE);
    assert_eq!(v.get_order(&0).status, OrderStatus::Filled);
    assert_eq!(v.get_order(&0).filled_out, 20_000 * U - 2 * FEE);
    assert_eq!(v.reserved(), 0);
}

#[test]
fn fill_goes_through_when_executor_cannot_receive_fee() {
    // If the filler's address cannot receive the token (e.g. no trustline) the fill does not stop; the fee stays with the owner.
    let s = setup();
    let env = &s.env;
    let tok = env.register(MockToken, ());
    let t = MockTokenClient::new(env, &tok);
    t.mint(&s.router.address, &(1_000_000 * U));
    let vid = env.register(
        OrderVault,
        (s.owner.clone(), s.usdc.address.clone(), tok.clone(), s.pool.address.clone(), s.router.address.clone(), s.guard.address.clone(), FEE),
    );
    let v = OrderVaultClient::new(env, &vid);
    v.deposit(&(1_000 * U));
    v.place_order(&(400 * U), &2_500_000, &(200 * U), &IMPACT, &(NOW + DAY));
    let filler = Address::generate(env);
    t.set_blocked(&filler, &true);

    let out = v.execute(&filler, &0, &(200 * U));
    assert_eq!(out, 1_000 * U);
    assert_eq!(t.balance(&filler), 0);
    assert_eq!(t.balance(&s.owner), 1_000 * U);

    t.set_blocked(&filler, &false);
    let out2 = v.execute(&filler, &0, &(200 * U));
    assert_eq!(out2, 1_000 * U - FEE);
    assert_eq!(t.balance(&filler), FEE);
    assert_eq!(t.balance(&s.owner), 2_000 * U - FEE);
    assert_eq!(t.balance(&vid), 0);
}

#[test]
fn exec_fee_on_stop_order_respects_oracle_band() {
    // Stop loss: oracle 0.15, pool 0.148, band 3%. By the oracle the owner must get at least 130.95 USDC;
    // the swap gives 133.2. Although the fee cap is 5 USDC the filler only gets the 2.25 in between.
    let s = setup();
    let env = &s.env;
    let xpool = env.register(MockPool, (s.xlm.address.clone(),));
    MockPoolClient::new(env, &xpool).set_oracle(&s.oracle.address);
    let id = env.register(
        OrderVault,
        (s.owner.clone(), s.xlm.address.clone(), s.usdc.address.clone(), xpool, s.router.address.clone(), s.guard.address.clone(), 5 * U),
    );
    let sv = OrderVaultClient::new(env, &id);
    StellarAssetClient::new(env, &s.xlm.address).mint(&s.owner, &(1_000 * U));
    s.usdc_admin.mint(&s.router.address, &(1_000_000 * U));
    sv.deposit(&(1_000 * U));
    let trigger = 10_000_000 * SCALE / 1_500_000;
    let limit = 10_000_000 * SCALE / 1_400_000;
    let oid = sv.place_stop_order(&(900 * U), &trigger, &limit, &(100 * U), &IMPACT, &(NOW + DAY), &300);
    s.oracle.set_price(&s.xlm.address, &1_500_000);
    s.router.set_price(&1_480_000);
    let filler = Address::generate(env);
    let before = s.usdc.balance(&s.owner);
    let out = sv.execute(&filler, &oid, &(900 * U));
    assert_eq!(out, 1_309_500_000);
    assert_eq!(s.usdc.balance(&s.owner) - before, 1_309_500_000);
    assert_eq!(s.usdc.balance(&filler), 900 * 1_480_000 - 1_309_500_000);
}

#[test]
#[should_panic]
fn vault_rejects_negative_exec_fee() {
    let s = setup();
    s.env.register(
        OrderVault,
        (s.owner.clone(), s.usdc.address.clone(), s.xlm.address.clone(), s.pool.address.clone(), s.router.address.clone(), s.guard.address.clone(), -1i128),
    );
}
