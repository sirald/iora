//! Local tests. Blend and Soroswap are replaced by mock contracts that imitate their behaviour;
//! authorization rules are the same as the real ones. The mock pool holds several reserves.
extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, Map, Vec,
};

const U: i128 = 10_000_000; // 1 token (7 decimals)
const NOW: u64 = 1_000_000;
const DAY: u64 = 86_400;
const IMPACT: u32 = 300; // 3%
const FEE: i128 = U / 10; // at most 0.1 token per fill

/// Converts a contract error code into the generic error type the client returns.
fn ce(e: Error) -> soroban_sdk::Error {
    e.into()
}

// ---------------------------------------------------------------------------
// Mock Blend pool: several reserves, b_tokens and b_rate per reserve
// ---------------------------------------------------------------------------

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

fn reserves(env: &Env) -> Vec<Address> {
    env.storage().instance().get(&symbol_short!("res")).unwrap_or(Vec::new(env))
}

fn index_of(env: &Env, token: &Address) -> Option<u32> {
    reserves(env).first_index_of(token)
}

fn rate_of(env: &Env, token: &Address) -> i128 {
    env.storage().instance().get(&(symbol_short!("rate"), token.clone())).unwrap_or(B_RATE_SCALE)
}

fn bt_of(env: &Env, token: &Address, who: &Address) -> i128 {
    env.storage().instance().get(&(symbol_short!("bt"), token.clone(), who.clone())).unwrap_or(0)
}

#[contractimpl]
impl MockPool {
    pub fn add_reserve(env: Env, token: Address) {
        let mut r = reserves(&env);
        r.push_back(token);
        env.storage().instance().set(&symbol_short!("res"), &r);
    }

    pub fn submit(env: Env, from: Address, spender: Address, to: Address, requests: Vec<Request>) {
        from.require_auth();
        if spender != from {
            spender.require_auth();
        }
        let me = env.current_contract_address();
        for r in requests.iter() {
            assert!(index_of(&env, &r.address).is_some(), "unknown asset");
            let tc = TokenClient::new(&env, &r.address);
            let rate = rate_of(&env, &r.address);
            let key = (symbol_short!("bt"), r.address.clone(), from.clone());
            let bal = bt_of(&env, &r.address, &from);
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
                // With no cash in the pool this transfer fails (not enough liquidity).
                tc.transfer(&me, &to, &amt);
                env.storage().instance().set(&key, &(bal - burn));
            } else {
                panic!("unsupported request");
            }
        }
    }

    pub fn get_positions(env: Env, address: Address) -> MockPositions {
        let mut supply = Map::new(&env);
        let mut i = 0u32;
        for t in reserves(&env).iter() {
            let b = bt_of(&env, &t, &address);
            if b > 0 {
                supply.set(i, b);
            }
            i += 1;
        }
        MockPositions { collateral: Map::new(&env), liabilities: Map::new(&env), supply }
    }

    /// Like the real Blend: fails for an asset that is not a reserve.
    pub fn get_reserve(env: Env, asset: Address) -> MockReserve {
        let index = index_of(&env, &asset).expect("not a reserve");
        let b_rate = rate_of(&env, &asset);
        MockReserve {
            asset,
            config: MockReserveConfig { decimals: 7, index },
            data: MockReserveData { b_rate, d_rate: B_RATE_SCALE },
            scalar: SCALE,
        }
    }

    pub fn get_config(env: Env) -> MockPoolConfig {
        let oracle: Address = env.storage().instance().get(&symbol_short!("oracle")).unwrap();
        MockPoolConfig { bstop_rate: 0, max_positions: 4, oracle, status: 0 }
    }

    pub fn set_oracle(env: Env, oracle: Address) {
        env.storage().instance().set(&symbol_short!("oracle"), &oracle);
    }

    pub fn claim(_env: Env, from: Address, _reserve_token_ids: Vec<u32>, _to: Address) -> i128 {
        from.require_auth();
        0
    }

    /// Imitates interest accruing.
    pub fn set_b_rate(env: Env, token: Address, rate: i128) {
        env.storage().instance().set(&(symbol_short!("rate"), token), &rate);
    }

    pub fn b_tokens(env: Env, token: Address, who: Address) -> i128 {
        bt_of(&env, &token, &who)
    }
}

// ---------------------------------------------------------------------------
// Mock Soroswap router: a fixed price per pair (output token per 1 input token, 7 decimals)
// ---------------------------------------------------------------------------

#[contract]
pub struct MockRouter;

fn quote(env: &Env, path: &Vec<Address>, amount_in: i128) -> i128 {
    // Multi-hop route: each hop at its own pair's price.
    let mut amount = amount_in;
    let mut i = 0;
    while i + 1 < path.len() {
        let a = path.get(i).unwrap();
        let b = path.get(i + 1).unwrap();
        let price: i128 = env.storage().instance().get(&(symbol_short!("px"), a, b)).expect("no pair");
        amount = amount * price / SCALE;
        i += 1;
    }
    amount
}

#[contractimpl]
impl MockRouter {
    pub fn set_price(env: Env, token_in: Address, token_out: Address, price: i128) {
        env.storage().instance().set(&(symbol_short!("px"), token_in, token_out), &price);
    }

    pub fn router_pair_for(env: Env, _token_a: Address, _token_b: Address) -> Address {
        env.current_contract_address()
    }

    pub fn router_get_amounts_out(env: Env, amount_in: i128, path: Vec<Address>) -> Vec<i128> {
        vec![&env, amount_in, quote(&env, &path, amount_in)]
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
        let out = quote(&env, &path, amount_in);
        if out < amount_out_min {
            panic!("INSUFFICIENT_OUTPUT_AMOUNT");
        }
        let me = env.current_contract_address();
        TokenClient::new(&env, &path.get(0).unwrap()).transfer(&to, &me, &amount_in);
        TokenClient::new(&env, &path.last().unwrap()).transfer(&me, &to, &out);
        vec![&env, amount_in, out]
    }
}

// ---------------------------------------------------------------------------
// Mock price oracle (Blend/Reflector interface)
// ---------------------------------------------------------------------------

#[contract]
pub struct MockOracle;

#[contractimpl]
impl MockOracle {
    pub fn set_price(env: Env, asset: Address, price: i128) {
        env.storage().instance().set(&(symbol_short!("op"), asset), &price);
    }

    pub fn lastprice(env: Env, asset: OracleAsset) -> Option<PriceData> {
        let OracleAsset::Stellar(a) = asset else { return None };
        let price: Option<i128> = env.storage().instance().get(&(symbol_short!("op"), a));
        price.map(|p| PriceData { price: p, timestamp: env.ledger().timestamp() })
    }
}

// ---------------------------------------------------------------------------
// Mock guard contract (stands in for the factory)
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

    /// Default: every token is allowed. `set_denied` blocks them one by one.
    pub fn is_allowed(env: Env, token: Address) -> bool {
        !env.storage().instance().get(&(symbol_short!("deny"), token)).unwrap_or(false)
    }

    pub fn set_denied(env: Env, token: Address, denied: bool) {
        env.storage().instance().set(&(symbol_short!("deny"), token), &denied);
    }
}

// ---------------------------------------------------------------------------
// Mock token: can refuse transfers to a given address (imitates a wallet without a trustline)
// ---------------------------------------------------------------------------

#[contract]
pub struct MockToken;

#[contractimpl]
impl MockToken {
    pub fn decimals(_env: Env) -> u32 {
        7
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage().instance().get(&(symbol_short!("bal"), id)).unwrap_or(0)
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let key = (symbol_short!("bal"), to);
        let bal: i128 = env.storage().instance().get(&key).unwrap_or(0);
        env.storage().instance().set(&key, &(bal + amount));
    }

    pub fn set_blocked(env: Env, who: Address, blocked: bool) {
        env.storage().instance().set(&(symbol_short!("blk"), who), &blocked);
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let blocked: bool = env.storage().instance().get(&(symbol_short!("blk"), to.clone())).unwrap_or(false);
        assert!(!blocked, "recipient cannot hold this token");
        let fk = (symbol_short!("bal"), from);
        let tk = (symbol_short!("bal"), to);
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

struct S {
    env: Env,
    owner: Address,
    filler: Address,
    usdc: TokenClient<'static>,
    xlm: TokenClient<'static>,
    pool: MockPoolClient<'static>,
    router: MockRouterClient<'static>,
    oracle: MockOracleClient<'static>,
    guard: MockGuardClient<'static>,
    v: VaultClient<'static>,
}

/// USDC and XLM are reserves of the pool. Price: 1 USDC = 5 XLM (XLM = 0.20 USDC). The owner's wallet holds
/// 10,000 of each. `fee_xlm` / `fee_usdc`: fill fee cap when that token is bought (0 = none).
fn setup_with(fee_xlm: i128, fee_usdc: i128) -> S {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);
    let admin = Address::generate(&env);
    let owner = Address::generate(&env);
    let filler = Address::generate(&env);

    let usdc_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let xlm_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let usdc = TokenClient::new(&env, &usdc_id);
    let xlm = TokenClient::new(&env, &xlm_id);
    let usdc_admin = StellarAssetClient::new(&env, &usdc_id);
    let xlm_admin = StellarAssetClient::new(&env, &xlm_id);

    let pool_id = env.register(MockPool, ());
    let pool = MockPoolClient::new(&env, &pool_id);
    pool.add_reserve(&usdc_id);
    pool.add_reserve(&xlm_id);
    let oracle_id = env.register(MockOracle, ());
    let oracle = MockOracleClient::new(&env, &oracle_id);
    pool.set_oracle(&oracle_id);

    let router_id = env.register(MockRouter, ());
    let router = MockRouterClient::new(&env, &router_id);
    router.set_price(&usdc_id, &xlm_id, &(5 * U));
    router.set_price(&xlm_id, &usdc_id, &2_000_000);

    let guard_id = env.register(MockGuard, ());
    let guard = MockGuardClient::new(&env, &guard_id);

    let mut fees: Map<Address, i128> = Map::new(&env);
    if fee_xlm > 0 {
        fees.set(xlm_id.clone(), fee_xlm);
    }
    if fee_usdc > 0 {
        fees.set(usdc_id.clone(), fee_usdc);
    }
    let vid = env.register(Vault, (owner.clone(), pool_id.clone(), router_id.clone(), guard_id.clone(), fees));
    let v = VaultClient::new(&env, &vid);

    usdc_admin.mint(&owner, &(10_000 * U));
    xlm_admin.mint(&owner, &(10_000 * U));
    usdc_admin.mint(&router_id, &(1_000_000 * U));
    xlm_admin.mint(&router_id, &(1_000_000 * U));
    // Some extra cash so the pool can pay interest.
    usdc_admin.mint(&pool_id, &(1_000 * U));

    S { env, owner, filler, usdc, xlm, pool, router, oracle, guard, v }
}

fn setup() -> S {
    setup_with(0, 0)
}

// ---------------------------------------------------------------------------
// Deposits and withdrawals
// ---------------------------------------------------------------------------

#[test]
fn deposit_and_withdraw_per_token() {
    let s = setup();
    s.v.deposit(&s.usdc.address, &(1_000 * U));
    s.v.deposit(&s.xlm.address, &(500 * U));

    // A reserve token goes to Blend at once; nothing stays idle in the vault.
    assert_eq!(s.v.balance(&s.usdc.address), 1_000 * U);
    assert_eq!(s.pool.b_tokens(&s.usdc.address, &s.v.address), 1_000 * U);
    assert_eq!(s.usdc.balance(&s.v.address), 0);
    assert_eq!(s.v.balance(&s.xlm.address), 500 * U);
    assert_eq!(s.v.tokens().len(), 2);

    let p = s.v.position(&s.usdc.address);
    assert!(p.pooled);
    assert_eq!(p.balance, 1_000 * U);
    assert_eq!(p.idle, 0);
    assert_eq!(p.reserved, 0);
    assert_eq!(p.free, 1_000 * U);
    assert_eq!(p.deposited, 1_000 * U);
    assert_eq!(s.v.positions().len(), 2);

    s.v.withdraw(&s.usdc.address, &(400 * U));
    assert_eq!(s.usdc.balance(&s.owner), 10_000 * U - 600 * U);
    assert_eq!(s.v.balance(&s.usdc.address), 600 * U);
    // The XLM side is not affected.
    assert_eq!(s.v.balance(&s.xlm.address), 500 * U);

    s.v.withdraw(&s.usdc.address, &WITHDRAW_ALL);
    assert_eq!(s.usdc.balance(&s.owner), 10_000 * U);
    assert_eq!(s.v.balance(&s.usdc.address), 0);
    let st = s.v.stats(&s.usdc.address);
    assert_eq!(st.total_deposited, 1_000 * U);
    assert_eq!(st.total_withdrawn, 1_000 * U);
}

#[test]
fn interest_is_withdrawable() {
    let s = setup();
    s.v.deposit(&s.usdc.address, &(1_000 * U));
    // 10% interest accrued.
    s.pool.set_b_rate(&s.usdc.address, &(B_RATE_SCALE * 11 / 10));
    assert_eq!(s.v.balance(&s.usdc.address), 1_100 * U);
    assert_eq!(s.v.deposited(&s.usdc.address), 1_000 * U);
    s.v.withdraw(&s.usdc.address, &WITHDRAW_ALL);
    assert_eq!(s.usdc.balance(&s.owner), 10_000 * U + 100 * U);
    assert_eq!(s.pool.b_tokens(&s.usdc.address, &s.v.address), 0);
}

#[test]
fn only_owner_moves_funds() {
    let s = setup();
    s.v.deposit(&s.usdc.address, &(1_000 * U));
    let id = s.v.place_order(&s.usdc.address, &s.xlm.address, &(400 * U), &2_000_000, &(400 * U), &IMPACT, &(NOW + DAY), &true);
    s.env.set_auths(&[]);
    assert!(s.v.try_withdraw(&s.usdc.address, &(100 * U)).is_err());
    assert!(s.v.try_deposit(&s.usdc.address, &(100 * U)).is_err());
    assert!(s.v.try_place_order(&s.usdc.address, &s.xlm.address, &(100 * U), &2_000_000, &(100 * U), &IMPACT, &(NOW + DAY), &true).is_err());
    // Only the owner can cancel an order that has not expired.
    assert!(s.v.try_cancel_order(&id).is_err());
    // Once it has expired anyone can close it; no funds move.
    s.env.ledger().set_timestamp(NOW + DAY + 1);
    s.v.cancel_order(&id);
    assert_eq!(s.v.reserved(&s.usdc.address), 0);
    assert_eq!(s.v.balance(&s.usdc.address), 1_000 * U);
    assert_eq!(s.v.get_order(&id).status, OrderStatus::Cancelled);
}

// ---------------------------------------------------------------------------
// Orders: both directions from the same vault
// ---------------------------------------------------------------------------

#[test]
fn buy_order_keeps_output_in_vault_earning() {
    let s = setup();
    s.v.deposit(&s.usdc.address, &(1_000 * U));
    // 400 USDC at no more than 0.20 USDC per XLM: at least 2,000 XLM.
    let id = s.v.place_order(&s.usdc.address, &s.xlm.address, &(400 * U), &2_000_000, &(400 * U), &IMPACT, &(NOW + DAY), &true);
    assert_eq!(s.v.reserved(&s.usdc.address), 400 * U);

    // Real authorization checks are on: the executor signs nothing.
    s.env.set_auths(&[]);
    let out = s.v.execute(&s.filler, &id, &(400 * U), &None);
    assert_eq!(out, 2_000 * U);

    // The output did not go to the wallet; it is in the vault, on Blend.
    assert_eq!(s.xlm.balance(&s.owner), 10_000 * U);
    assert_eq!(s.v.balance(&s.xlm.address), 2_000 * U);
    assert_eq!(s.pool.b_tokens(&s.xlm.address, &s.v.address), 2_000 * U);
    assert_eq!(s.xlm.balance(&s.v.address), 0);
    assert_eq!(s.v.deposited(&s.xlm.address), 2_000 * U);

    assert_eq!(s.v.balance(&s.usdc.address), 600 * U);
    assert_eq!(s.v.deposited(&s.usdc.address), 600 * U);
    assert_eq!(s.v.reserved(&s.usdc.address), 0);
    let o = s.v.get_order(&id);
    assert_eq!(o.status, OrderStatus::Filled);
    assert_eq!(o.filled_out, 2_000 * U);
    assert_eq!(s.v.stats(&s.usdc.address).total_spent, 400 * U);
    assert_eq!(s.v.stats(&s.xlm.address).total_received, 2_000 * U);
}

#[test]
fn order_can_send_output_to_wallet() {
    let s = setup();
    s.v.deposit(&s.usdc.address, &(1_000 * U));
    let id = s.v.place_order(&s.usdc.address, &s.xlm.address, &(400 * U), &2_000_000, &(400 * U), &IMPACT, &(NOW + DAY), &false);
    let out = s.v.execute(&s.filler, &id, &(400 * U), &None);
    assert_eq!(out, 2_000 * U);
    assert_eq!(s.xlm.balance(&s.owner), 10_000 * U + 2_000 * U);
    assert_eq!(s.v.balance(&s.xlm.address), 0);
    assert_eq!(s.v.deposited(&s.xlm.address), 0);
}

#[test]
fn sell_order_from_the_same_vault() {
    let s = setup();
    s.v.deposit(&s.xlm.address, &(1_000 * U));
    // Sell 500 XLM, paying at most 5 XLM per USDC (XLM = 0.20 USDC): at least 100 USDC.
    let id = s.v.place_order(&s.xlm.address, &s.usdc.address, &(500 * U), &(5 * U), &(500 * U), &IMPACT, &(NOW + DAY), &true);
    let out = s.v.execute(&s.filler, &id, &(500 * U), &None);
    assert_eq!(out, 100 * U);
    assert_eq!(s.v.balance(&s.usdc.address), 100 * U);
    assert_eq!(s.pool.b_tokens(&s.usdc.address, &s.v.address), 100 * U);
    assert_eq!(s.v.balance(&s.xlm.address), 500 * U);
}

#[test]
fn reserves_are_tracked_per_token() {
    let s = setup();
    s.v.deposit(&s.usdc.address, &(1_000 * U));
    s.v.deposit(&s.xlm.address, &(1_000 * U));
    let a = s.v.place_order(&s.usdc.address, &s.xlm.address, &(900 * U), &2_000_000, &(900 * U), &IMPACT, &(NOW + DAY), &true);

    // A USDC order does not tie up the XLM balance.
    assert_eq!(s.v.free_balance(&s.xlm.address), 1_000 * U);
    assert_eq!(s.v.free_balance(&s.usdc.address), 100 * U - ROUNDING_BUFFER);
    // The same USDC cannot be spent by two orders.
    assert_eq!(
        s.v.try_place_order(&s.usdc.address, &s.xlm.address, &(200 * U), &2_000_000, &(200 * U), &IMPACT, &(NOW + DAY), &true),
        Err(Ok(ce(Error::InsufficientFree)))
    );
    // An order can still be placed on the XLM side.
    s.v.place_order(&s.xlm.address, &s.usdc.address, &(900 * U), &(5 * U), &(900 * U), &IMPACT, &(NOW + DAY), &true);
    assert_eq!(s.v.reserved(&s.xlm.address), 900 * U);
    // The reserved amount cannot be withdrawn.
    assert_eq!(s.v.try_withdraw(&s.usdc.address, &(200 * U)), Err(Ok(ce(Error::InsufficientFree))));

    s.v.cancel_order(&a);
    assert_eq!(s.v.reserved(&s.usdc.address), 0);
    assert_eq!(s.v.free_balance(&s.usdc.address), 1_000 * U);
}

#[test]
fn order_rules() {
    let s = setup();
    s.v.deposit(&s.usdc.address, &(1_000 * U));
    assert_eq!(
        s.v.try_place_order(&s.usdc.address, &s.usdc.address, &(100 * U), &2_000_000, &(100 * U), &IMPACT, &(NOW + DAY), &true),
        Err(Ok(ce(Error::SameToken)))
    );
    assert_eq!(
        s.v.try_place_order(&s.usdc.address, &s.xlm.address, &(100 * U), &0, &(100 * U), &IMPACT, &(NOW + DAY), &true),
        Err(Ok(ce(Error::InvalidPrice)))
    );
    // At most 20 pieces.
    assert_eq!(
        s.v.try_place_order(&s.usdc.address, &s.xlm.address, &(100 * U), &2_000_000, &U, &IMPACT, &(NOW + DAY), &true),
        Err(Ok(ce(Error::InvalidAmount)))
    );
    let id = s.v.place_order(&s.usdc.address, &s.xlm.address, &(400 * U), &2_000_000, &(100 * U), &IMPACT, &(NOW + DAY), &true);
    // Partial fill: it may not leave a remainder below the minimum fill.
    assert_eq!(s.v.try_execute(&s.filler, &id, &(350 * U), &None), Err(Ok(ce(Error::FillTooSmall))));
    assert_eq!(s.v.try_execute(&s.filler, &id, &(500 * U), &None), Err(Ok(ce(Error::FillTooLarge))));
    assert_eq!(s.v.execute(&s.filler, &id, &(200 * U), &None), 1_000 * U);
    assert_eq!(s.v.execute(&s.filler, &id, &(200 * U), &None), 1_000 * U);
    assert_eq!(s.v.try_execute(&s.filler, &id, &(100 * U), &None), Err(Ok(ce(Error::OrderNotOpen))));
    // No fill if the limit is not met: XLM got more expensive (1 USDC = 4 XLM).
    let id2 = s.v.place_order(&s.usdc.address, &s.xlm.address, &(400 * U), &2_000_000, &(400 * U), &IMPACT, &(NOW + DAY), &true);
    s.router.set_price(&s.usdc.address, &s.xlm.address, &(4 * U));
    assert!(s.v.try_execute(&s.filler, &id2, &(400 * U), &None).is_err());
    assert_eq!(s.v.balance(&s.usdc.address), 600 * U);
}

// ---------------------------------------------------------------------------
// Follow-up order: buy, then sell in the same vault
// ---------------------------------------------------------------------------

#[test]
fn buy_then_sell_inside_one_vault() {
    let s = setup();
    s.v.deposit(&s.usdc.address, &(1_000 * U));
    // Buy at 0.20; sell the XLM bought at 0.25 (4 XLM per USDC).
    let id = s.v.place_order_then(
        &s.usdc.address,
        &s.xlm.address,
        &(400 * U),
        &2_000_000,
        &(400 * U),
        &IMPACT,
        &(NOW + DAY),
        &(4 * U),
        &IMPACT,
        &DAY,
    );
    assert_eq!(s.v.execute(&s.filler, &id, &(400 * U), &None), 2_000 * U);

    // The reverse order opened in the same vault; all the XLM except the buffer is reserved for it.
    assert_eq!(s.v.order_count(), 2);
    let size = 2_000 * U - ROUNDING_BUFFER;
    let o = s.v.get_order(&1);
    assert_eq!(o.sell, s.xlm.address);
    assert_eq!(o.buy, s.usdc.address);
    assert_eq!(o.amount_in, size);
    assert_eq!(o.limit_price, 4 * U);
    assert_eq!(o.min_fill, (size - 1) / MAX_FILLS + 1);
    assert_eq!(o.expiry, NOW + DAY);
    assert!(o.keep);
    assert_eq!(o.status, OrderStatus::Open);
    assert_eq!(s.v.reserved(&s.xlm.address), size);
    assert_eq!(s.v.balance(&s.xlm.address), 2_000 * U);

    // XLM rose to 0.25: the reverse order fills and the USDC returns to the vault.
    s.router.set_price(&s.xlm.address, &s.usdc.address, &2_500_000);
    let back = s.v.execute(&s.filler, &1, &size, &None);
    assert_eq!(back, 500 * U - 2_500);
    assert_eq!(s.v.balance(&s.usdc.address), 600 * U + 500 * U - 2_500);
    assert_eq!(s.v.balance(&s.xlm.address), ROUNDING_BUFFER);
    assert_eq!(s.v.reserved(&s.xlm.address), 0);
    assert_eq!(s.xlm.balance(&s.owner), 10_000 * U);
}

#[test]
fn follow_up_cannot_sell_below_buy_price() {
    let s = setup();
    s.v.deposit(&s.usdc.address, &(1_000 * U));
    // Buying at 0.20 and selling at 0.1667 (6 XLM per USDC) is a loss: rejected.
    assert_eq!(
        s.v.try_place_order_then(
            &s.usdc.address,
            &s.xlm.address,
            &(400 * U),
            &2_000_000,
            &(400 * U),
            &IMPACT,
            &(NOW + DAY),
            &(6 * U),
            &IMPACT,
            &DAY
        ),
        Err(Ok(ce(Error::InvalidFollowUp)))
    );
}

#[test]
fn pause_blocks_new_orders_but_not_fills_or_withdrawals() {
    let s = setup();
    s.v.deposit(&s.usdc.address, &(1_000 * U));
    let id = s.v.place_order_then(
        &s.usdc.address,
        &s.xlm.address,
        &(400 * U),
        &2_000_000,
        &(400 * U),
        &IMPACT,
        &(NOW + DAY),
        &(4 * U),
        &IMPACT,
        &DAY,
    );
    s.guard.set_paused(&true);
    assert_eq!(
        s.v.try_place_order(&s.usdc.address, &s.xlm.address, &(100 * U), &2_000_000, &(100 * U), &IMPACT, &(NOW + DAY), &true),
        Err(Ok(ce(Error::Paused)))
    );
    // The existing order fills; the reverse order does not open, but the output stays free in the vault.
    assert_eq!(s.v.execute(&s.filler, &id, &(400 * U), &None), 2_000 * U);
    assert_eq!(s.v.order_count(), 1);
    assert_eq!(s.v.reserved(&s.xlm.address), 0);
    assert_eq!(s.v.free_balance(&s.xlm.address), 2_000 * U);
    s.v.withdraw(&s.xlm.address, &WITHDRAW_ALL);
    assert_eq!(s.xlm.balance(&s.owner), 10_000 * U + 2_000 * U);
    s.v.withdraw(&s.usdc.address, &WITHDRAW_ALL);
    assert_eq!(s.usdc.balance(&s.owner), 10_000 * U - 400 * U);
}

// ---------------------------------------------------------------------------
// Fill fee
// ---------------------------------------------------------------------------

#[test]
fn exec_fee_comes_only_from_price_improvement() {
    let s = setup_with(FEE, 0);
    s.v.deposit(&s.usdc.address, &(1_000 * U));
    // Limit 0.25, market 0.20: the owner must get at least 1,600 XLM, the swap returns 2,000.
    let a = s.v.place_order(&s.usdc.address, &s.xlm.address, &(400 * U), &2_500_000, &(400 * U), &IMPACT, &(NOW + DAY), &true);
    s.env.set_auths(&[]);
    assert_eq!(s.v.execute(&s.filler, &a, &(400 * U), &None), 2_000 * U - FEE);
    assert_eq!(s.xlm.balance(&s.filler), FEE);
    assert_eq!(s.v.balance(&s.xlm.address), 2_000 * U - FEE);
    assert_eq!(s.v.get_order(&a).filled_out, 2_000 * U - FEE);
}

#[test]
fn exec_fee_is_zero_at_the_limit() {
    let s = setup_with(FEE, 0);
    s.v.deposit(&s.usdc.address, &(1_000 * U));
    // Limit 0.20, market 0.20: no improvement, no fee.
    let a = s.v.place_order(&s.usdc.address, &s.xlm.address, &(400 * U), &2_000_000, &(400 * U), &IMPACT, &(NOW + DAY), &true);
    assert_eq!(s.v.execute(&s.filler, &a, &(400 * U), &None), 2_000 * U);
    assert_eq!(s.xlm.balance(&s.filler), 0);
    assert_eq!(s.v.balance(&s.xlm.address), 2_000 * U);
}

#[test]
fn exec_fee_on_stop_order_respects_oracle_band() {
    // Stop loss: oracle 0.15, pool 0.148, band 3%. Against the oracle the owner must get at least 130.95 USDC; the swap
    // returns 133.2. Even with a 5 USDC fee cap the executor only gets the 2.25 in between.
    let s = setup_with(0, 5 * U);
    s.v.deposit(&s.xlm.address, &(1_000 * U));
    s.oracle.set_price(&s.usdc.address, &10_000_000);
    s.oracle.set_price(&s.xlm.address, &2_000_000);
    let trigger = 10_000_000 * SCALE / 1_500_000;
    let limit = 10_000_000 * SCALE / 1_400_000;
    let id = s.v.place_stop_order(&s.xlm.address, &s.usdc.address, &(900 * U), &trigger, &limit, &(100 * U), &IMPACT, &(NOW + DAY), &300, &false);
    // The price has not reached the trigger yet.
    assert_eq!(s.v.try_execute(&s.filler, &id, &(900 * U), &None), Err(Ok(ce(Error::TriggerNotMet))));
    s.oracle.set_price(&s.xlm.address, &1_500_000);
    s.router.set_price(&s.xlm.address, &s.usdc.address, &1_480_000);
    let before = s.usdc.balance(&s.owner);
    let out = s.v.execute(&s.filler, &id, &(900 * U), &None);
    assert_eq!(out, 1_309_500_000);
    assert_eq!(s.usdc.balance(&s.owner) - before, 1_309_500_000);
    assert_eq!(s.usdc.balance(&s.filler), 900 * 1_480_000 - 1_309_500_000);
}

// ---------------------------------------------------------------------------
// A token that is not a reserve, and output the wallet cannot receive
// ---------------------------------------------------------------------------

#[test]
fn non_reserve_token_waits_idle_and_can_be_traded() {
    let s = setup();
    let admin = Address::generate(&s.env);
    let btc_id = s.env.register_stellar_asset_contract_v2(admin).address();
    let btc = TokenClient::new(&s.env, &btc_id);
    StellarAssetClient::new(&s.env, &btc_id).mint(&s.owner, &(10 * U));
    // 1 BTC = 50,000 USDC.
    s.router.set_price(&btc_id, &s.usdc.address, &(50_000 * U));

    s.v.deposit(&btc_id, &(2 * U));
    let p = s.v.position(&btc_id);
    assert!(!p.pooled);
    assert_eq!(p.idle, 2 * U);
    assert_eq!(p.balance, 2 * U);
    assert_eq!(btc.balance(&s.v.address), 2 * U);
    // A token that is not on Blend has no rounding buffer: all of it can go into an order.
    assert_eq!(s.v.orderable_balance(&btc_id), 2 * U);

    // Sell 1 BTC, paying at most 0.00002 BTC per USDC: at least 50,000 USDC.
    let id = s.v.place_order(&btc_id, &s.usdc.address, &U, &200, &U, &IMPACT, &(NOW + DAY), &true);
    assert_eq!(s.v.execute(&s.filler, &id, &U, &None), 50_000 * U);
    // The USDC bought is a reserve, so it was supplied to Blend.
    assert_eq!(s.v.balance(&s.usdc.address), 50_000 * U);
    assert_eq!(s.pool.b_tokens(&s.usdc.address, &s.v.address), 50_000 * U);
    assert_eq!(s.v.balance(&btc_id), U);

    // No buffer is held back while an order is open either: with half of the remaining 1 BTC in an order, the other half can be withdrawn.
    let half = U / 2;
    let open = s.v.place_order(&btc_id, &s.usdc.address, &half, &200, &half, &IMPACT, &(NOW + DAY), &true);
    assert_eq!(s.v.free_balance(&btc_id), half);
    assert_eq!(s.v.position(&btc_id).free, half);
    s.v.cancel_order(&open);

    s.v.withdraw(&btc_id, &WITHDRAW_ALL);
    assert_eq!(btc.balance(&s.owner), 9 * U);
    assert_eq!(s.v.balance(&btc_id), 0);
}

#[test]
fn output_stays_in_vault_when_wallet_cannot_receive() {
    let s = setup();
    let tok_id = s.env.register(MockToken, ());
    let tok = MockTokenClient::new(&s.env, &tok_id);
    tok.mint(&s.router.address, &(1_000_000 * U));
    s.router.set_price(&s.usdc.address, &tok_id, &(5 * U));
    s.v.deposit(&s.usdc.address, &(1_000 * U));
    // The output was meant for the wallet, but the wallet cannot receive this token (no trustline).
    let id = s.v.place_order(&s.usdc.address, &tok_id, &(400 * U), &2_000_000, &(400 * U), &IMPACT, &(NOW + DAY), &false);
    tok.set_blocked(&s.owner, &true);
    assert_eq!(s.v.execute(&s.filler, &id, &(400 * U), &None), 2_000 * U);
    // The fill did not stop; the token waits in the vault as part of the owner's balance.
    assert_eq!(tok.balance(&s.owner), 0);
    assert_eq!(s.v.balance(&tok_id), 2_000 * U);
    assert_eq!(s.v.position(&tok_id).idle, 2_000 * U);

    tok.set_blocked(&s.owner, &false);
    s.v.withdraw(&tok_id, &WITHDRAW_ALL);
    assert_eq!(tok.balance(&s.owner), 2_000 * U);
}

#[test]
#[should_panic]
fn negative_fee_is_rejected() {
    let env = Env::default();
    let a = Address::generate(&env);
    let mut fees: Map<Address, i128> = Map::new(&env);
    fees.set(a.clone(), -1);
    env.register(Vault, (a.clone(), a.clone(), a.clone(), a, fees));
}

// ---------------------------------------------------------------------------
// Version 8: allowed tokens and fills through an intermediate token
// ---------------------------------------------------------------------------

#[test]
fn orders_only_between_allowed_tokens() {
    let s = setup();
    let admin = Address::generate(&s.env);
    let fake = s.env.register_stellar_asset_contract_v2(admin).address();
    StellarAssetClient::new(&s.env, &fake).mint(&s.owner, &(10 * U));
    s.guard.set_denied(&fake, &true);
    s.v.deposit(&s.usdc.address, &(1_000 * U));

    // A token that is not on the list cannot be bought ...
    assert_eq!(
        s.v.try_place_order(&s.usdc.address, &fake, &(100 * U), &2_000_000, &(100 * U), &IMPACT, &(NOW + DAY), &true),
        Err(Ok(ce(Error::TokenNotAllowed)))
    );
    // ... or sold; but it can be deposited and can always be withdrawn.
    s.v.deposit(&fake, &(5 * U));
    assert_eq!(
        s.v.try_place_order(&fake, &s.usdc.address, &U, &2_000_000, &U, &IMPACT, &(NOW + DAY), &true),
        Err(Ok(ce(Error::TokenNotAllowed)))
    );
    s.v.withdraw(&fake, &WITHDRAW_ALL);
    assert_eq!(TokenClient::new(&s.env, &fake).balance(&s.owner), 10 * U);

    // If a token is removed from the list later, an open order keeps filling and can still be cancelled.
    let id = s.v.place_order(&s.usdc.address, &s.xlm.address, &(100 * U), &2_000_000, &(100 * U), &IMPACT, &(NOW + DAY), &true);
    s.guard.set_denied(&s.xlm.address, &true);
    assert_eq!(s.v.execute(&s.filler, &id, &(100 * U), &None), 500 * U);
}

#[test]
fn fill_through_an_intermediate_token() {
    let s = setup();
    let admin = Address::generate(&s.env);
    let btc_id = s.env.register_stellar_asset_contract_v2(admin).address();
    StellarAssetClient::new(&s.env, &btc_id).mint(&s.router.address, &(100 * U));
    // There is no USDC/BTC pair; the route is USDC -> XLM -> BTC. 1 XLM = 0.000004 BTC (1 BTC = 250,000 XLM = 50,000 USDC).
    s.router.set_price(&s.xlm.address, &btc_id, &40);
    s.v.deposit(&s.usdc.address, &(1_000 * U));
    // Buy BTC with 100 USDC at no more than 50,000 USDC per BTC: at least 0.002 BTC.
    let id = s.v.place_order(&s.usdc.address, &btc_id, &(100 * U), &(50_000 * U), &(100 * U), &IMPACT, &(NOW + DAY), &true);

    // The intermediate token cannot be the token sold or bought, and it must be on the allowed list.
    assert_eq!(
        s.v.try_execute(&s.filler, &id, &(100 * U), &Some(s.usdc.address.clone())),
        Err(Ok(ce(Error::InvalidPath)))
    );
    s.guard.set_denied(&s.xlm.address, &true);
    assert_eq!(
        s.v.try_execute(&s.filler, &id, &(100 * U), &Some(s.xlm.address.clone())),
        Err(Ok(ce(Error::TokenNotAllowed)))
    );
    s.guard.set_denied(&s.xlm.address, &false);

    let out = s.v.execute(&s.filler, &id, &(100 * U), &Some(s.xlm.address.clone()));
    assert_eq!(out, 20_000);
    assert_eq!(s.v.balance(&btc_id), 20_000);
    assert_eq!(s.v.balance(&s.usdc.address), 900 * U);
    // The intermediate token does not stay in the vault.
    assert_eq!(s.v.balance(&s.xlm.address), 0);
    assert_eq!(s.v.get_order(&id).status, OrderStatus::Filled);
}

#[test]
fn version_is_reported() {
    let s = setup();
    assert_eq!(s.v.version(), 9);
}

#[test]
fn forget_frees_a_place_on_the_token_list() {
    let s = setup();
    let admin = Address::generate(&s.env);
    let btc_id = s.env.register_stellar_asset_contract_v2(admin).address();
    let btc_admin = StellarAssetClient::new(&s.env, &btc_id);
    btc_admin.mint(&s.owner, &(10 * U));
    btc_admin.mint(&s.router.address, &(100 * U));
    // 1 USDC = 0.00002 BTC (1 BTC = 50,000 USDC).
    s.router.set_price(&s.usdc.address, &btc_id, &200);

    s.v.deposit(&btc_id, &U);
    assert!(s.v.tokens().contains(&btc_id));
    // While the vault holds the token it stays on the list.
    assert_eq!(s.v.try_forget(&btc_id), Err(Ok(ce(Error::TokenInUse))));
    s.v.withdraw(&btc_id, &WITHDRAW_ALL);
    s.v.forget(&btc_id);
    assert!(!s.v.tokens().contains(&btc_id));
    // Removing a token that is not on the list does nothing.
    s.v.forget(&btc_id);

    // A token reserved for an open order cannot be removed either.
    s.v.deposit(&s.usdc.address, &(100 * U));
    let id = s.v.place_order(&s.usdc.address, &btc_id, &(50 * U), &(50_000 * U), &(50 * U), &IMPACT, &(NOW + DAY), &true);
    assert_eq!(s.v.try_forget(&s.usdc.address), Err(Ok(ce(Error::TokenInUse))));

    // The order put BTC back on the list (it will receive it). The owner removes it again while the order is open;
    // the fill still goes through and the token returns to the list with its balance.
    assert!(s.v.tokens().contains(&btc_id));
    s.v.forget(&btc_id);
    assert!(!s.v.tokens().contains(&btc_id));
    let got = s.v.execute(&s.filler, &id, &(50 * U), &None);
    assert!(got > 0);
    assert!(s.v.tokens().contains(&btc_id));
    assert_eq!(s.v.balance(&btc_id), got);

    // Only the owner can remove a token.
    s.env.set_auths(&[]);
    assert!(s.v.try_forget(&btc_id).is_err());
}
