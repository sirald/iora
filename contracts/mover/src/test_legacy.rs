//! `move_order_vault` tests: old two-vault design vaults (order-vault) moved into the new single vault.
//! The old vaults run the REAL wasm deployed on testnet: the first generation (`order_vault_g1.wasm`, hash a899397a…,
//! no `exec_fee` in its config) and the last one (`order_vault_g4.wasm`, hash 1d124250…, version 5). The new
//! factory, vault and exchange are this build's wasm (run `stellar contract build` first).
extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{cost_estimate::{InvocationResourceLimits, NetworkInvocationResourceLimits}, Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, IntoVal, Map, Symbol, Val, Vec,
};

mod vault {
    soroban_sdk::contractimport!(file = "../../wasm/iora_vault.wasm");
}
mod factory {
    soroban_sdk::contractimport!(file = "../../wasm/iora_factory.wasm");
}
mod exchange {
    soroban_sdk::contractimport!(file = "../../wasm/iora_usdc_exchange.wasm");
}
mod g1 {
    soroban_sdk::contractimport!(file = "testdata/order_vault_g1.wasm");
}
mod g4 {
    soroban_sdk::contractimport!(file = "testdata/order_vault_g4.wasm");
}

const U: i128 = 10_000_000;
const NOW: u64 = 1_000_000;
const DAY: u64 = 86_400;
const B_RATE_SCALE: i128 = 1_000_000_000_000;

/// A Blend pool with no reserves, for the NEW vault: it keeps every token idle.
#[contract]
pub struct NoReservePool;

#[contractimpl]
impl NoReservePool {
    pub fn get_reserve(_env: Env, _asset: Address) -> Map<Symbol, Val> {
        panic!("not a reserve")
    }
}

// --- A Blend pool for the OLD vaults (one token per pool; b_token accounting like the order-vault tests) ---

#[contracttype]
#[derive(Clone)]
pub enum PoolKey {
    Token,
    BRate,
    BTokens(Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Request {
    pub address: Address,
    pub amount: i128,
    pub request_type: u32,
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
                env.storage().instance().set(&key, &(bal + r.amount * B_RATE_SCALE / rate));
            } else {
                let mut amt = r.amount;
                let mut burn = (r.amount * B_RATE_SCALE + rate - 1) / rate;
                if burn > bal {
                    burn = bal;
                    amt = bal * rate / B_RATE_SCALE;
                }
                tc.transfer(&me, &to, &amt);
                env.storage().instance().set(&key, &(bal - burn));
            }
        }
    }

    pub fn get_positions(env: Env, address: Address) -> MockPositions {
        let b: i128 = env.storage().instance().get(&PoolKey::BTokens(address)).unwrap_or(0);
        let mut supply = Map::new(&env);
        if b > 0 {
            supply.set(3u32, b);
        }
        MockPositions { collateral: Map::new(&env), liabilities: Map::new(&env), supply }
    }

    pub fn get_reserve(env: Env, asset: Address) -> MockReserve {
        MockReserve {
            asset,
            config: MockReserveConfig { decimals: 7, index: 3 },
            data: MockReserveData { b_rate: b_rate_of(&env), d_rate: B_RATE_SCALE },
            scalar: U,
        }
    }

    /// Imitates interest accruing (the pool must hold the extra tokens: see `S::interest`).
    pub fn set_b_rate(env: Env, rate: i128) {
        env.storage().instance().set(&PoolKey::BRate, &rate);
    }
}

/// The factory as the old vaults see it (`guard`): not paused, no sibling.
#[contract]
pub struct MockGuard;

#[contractimpl]
impl MockGuard {
    pub fn is_paused(_env: Env) -> bool {
        false
    }
    pub fn sibling(_env: Env) -> Option<Address> {
        None
    }
    pub fn vault_of(_env: Env, _owner: Address) -> Option<Address> {
        None
    }
}

struct S {
    env: Env,
    owner: Address,
    mock: TokenClient<'static>,
    usdc: TokenClient<'static>,
    xlm: TokenClient<'static>,
    guard: Address,
    new_factory: factory::Client<'static>,
    ex: exchange::Client<'static>,
    m: MoverClient<'static>,
}

fn token(env: &Env) -> TokenClient<'static> {
    let issuer = Address::generate(env);
    TokenClient::new(env, &env.register_stellar_asset_contract_v2(issuer).address())
}

fn mint(t: &TokenClient, to: &Address, n: i128) {
    StellarAssetClient::new(&t.env, &t.address).mint(to, &n);
}

/// New factory (Circle USDC and XLM), the exchange with 10,000 Circle USDC, and the mover. The owner's wallet
/// holds 10,000 of each token.
fn setup() -> S {
    let env = Env::default();
    // See the `move_vault` tests: the test client's own authorization read trips the enforced limits for a call tree
    // this large, so they are off and every move checks its measured resources against mainnet (`check_limits`).
    env.cost_estimate().disable_resource_limits();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);
    let owner = Address::generate(&env);
    let guardian = Address::generate(&env);
    let (mock, usdc, xlm) = (token(&env), token(&env), token(&env));
    let pool = env.register(NoReservePool, ());
    let hash = env.deployer().upload_contract_wasm(vault::WASM);
    let fees: Map<Address, i128> = Map::new(&env);
    let new_factory = factory::Client::new(
        &env,
        &env.register(
            factory::WASM,
            (guardian.clone(), hash, pool, Address::generate(&env), fees, vec![&env, usdc.address.clone(), xlm.address.clone()]),
        ),
    );
    let ex = exchange::Client::new(&env, &env.register(exchange::WASM, (guardian, mock.address.clone(), usdc.address.clone())));
    mint(&usdc, &ex.address, 10_000 * U);
    for t in [&mock, &usdc, &xlm] {
        mint(t, &owner, 10_000 * U);
    }
    let guard = env.register(MockGuard, ());
    let m = MoverClient::new(&env, &env.register(Mover, ()));
    S { env, owner, mock, usdc, xlm, guard, new_factory, ex, m }
}

/// An old vault of the last generation (version 5): deposits `coin`, buys `other`.
fn old_g4(s: &S, owner: &Address, coin: &Address, other: &Address) -> (g4::Client<'static>, Address) {
    let pool = s.env.register(MockPool, (coin.clone(),));
    let v = s.env.register(g4::WASM, (owner.clone(), coin.clone(), other.clone(), pool.clone(), Address::generate(&s.env), s.guard.clone(), 30_000i128));
    (g4::Client::new(&s.env, &v), pool)
}

/// An old vault of the first generation (no `exec_fee` in its config).
fn old_g1(s: &S, coin: &Address, other: &Address) -> g1::Client<'static> {
    let pool = s.env.register(MockPool, (coin.clone(),));
    let v = s.env.register(g1::WASM, (s.owner.clone(), coin.clone(), other.clone(), pool, Address::generate(&s.env), s.guard.clone()));
    g1::Client::new(&s.env, &v)
}

/// New vault `place_order`: sell, buy, amount, limit, min fill = amount, impact 3%, expiry a day away, keep.
fn order(s: &S, sell: &Address, buy: &Address, amount: i128, limit: i128) -> PlaceCall {
    PlaceCall {
        func: Symbol::new(&s.env, "place_order"),
        args: (sell.clone(), buy.clone(), amount, limit, amount, 300u32, NOW + DAY, true).into_val(&s.env),
    }
}

fn wallet(s: &S) -> [i128; 3] {
    [s.mock.balance(&s.owner), s.usdc.balance(&s.owner), s.xlm.balance(&s.owner)]
}

fn check_limits(s: &S) {
    let r = s.env.cost_estimate().resources();
    let l = InvocationResourceLimits::mainnet();
    assert!(r.instructions <= l.instructions, "instructions {} > {}", r.instructions, l.instructions);
    assert!(r.mem_bytes <= l.mem_bytes, "memory {} > {}", r.mem_bytes, l.mem_bytes);
    assert!(r.write_entries <= l.write_entries, "write entries {} > {}", r.write_entries, l.write_entries);
    assert!(r.write_bytes <= l.write_bytes, "write bytes {} > {}", r.write_bytes, l.write_bytes);
}

fn print_cost(s: &S, what: &str) {
    let r = s.env.cost_estimate().resources();
    std::println!(
        "COST legacy {what}: instructions={} mem_bytes={} read_entries={} write_entries={} write_bytes={} events={}",
        r.instructions,
        r.mem_bytes,
        r.memory_read_entries + r.disk_read_entries,
        r.write_entries,
        r.write_bytes,
        r.contract_events_size_bytes
    );
}

fn none(s: &S) -> Vec<PlaceCall> {
    Vec::new(&s.env)
}

#[test]
fn xlm_sell_vault_with_orders_moves_into_a_new_vault() {
    let s = setup();
    // Old sell vault (version 5): 1,000 XLM, two open orders selling XLM for (mock) USDC.
    let (old, _) = old_g4(&s, &s.owner, &s.xlm.address, &s.mock.address);
    old.deposit(&(1_000 * U));
    let o1 = old.place_order(&(300 * U), &(5 * U), &(300 * U), &300, &(NOW + DAY));
    let o2 = old.place_order(&(200 * U), &(6 * U), &(20 * U), &300, &(NOW + DAY));
    let before = wallet(&s);
    assert_eq!(s.new_factory.vault_of(&s.owner), None);

    // The orders sell XLM for Circle USDC in the new vault.
    let place = vec![&s.env, order(&s, &s.xlm.address, &s.usdc.address, 300 * U, 5 * U), order(&s, &s.xlm.address, &s.usdc.address, 200 * U, 6 * U)];
    let nv = s.m.move_order_vault(&s.owner, &old.address, &s.new_factory.address, &(1_000 * U), &vec![&s.env, o1, o2], &place, &Some(s.ex.address.clone()));
    print_cost(&s, "XLM vault, 2 cancels + 2 orders + new vault");
    check_limits(&s);

    assert_eq!(s.new_factory.vault_of(&s.owner), Some(nv.clone()));
    let v = vault::Client::new(&s.env, &nv);
    assert_eq!(v.balance(&s.xlm.address), 1_000 * U);
    assert_eq!(v.order_count(), 2);
    assert_eq!(v.reserved(&s.xlm.address), 500 * U);
    assert_eq!(v.get_order(&0).buy, s.usdc.address);
    // The old vault is empty, its orders cancelled; the wallet is as before (XLM was not exchanged: not mock).
    assert_eq!(old.balance(), 0);
    assert_eq!(old.get_order(&o1).status, g4::OrderStatus::Cancelled);
    assert_eq!(old.get_order(&o2).status, g4::OrderStatus::Cancelled);
    assert_eq!(wallet(&s), before);
    assert_eq!(s.ex.used(&s.owner), 0);
}

#[test]
fn first_generation_mock_usdc_vault_is_exchanged_into_an_existing_vault() {
    let s = setup();
    // The owner already has a new vault holding 50 Circle USDC.
    let nv = s.new_factory.create_vault(&s.owner);
    let v = vault::Client::new(&s.env, &nv);
    v.deposit(&s.usdc.address, &(50 * U));
    // Old buy vault of the first generation: 500 mock USDC, one open order buying XLM.
    let old = old_g1(&s, &s.mock.address, &s.xlm.address);
    old.deposit(&(500 * U));
    let o = old.place_order(&(400 * U), &2_000_000, &(100 * U), &300, &(NOW + DAY));
    let before = wallet(&s);

    let place = vec![&s.env, order(&s, &s.usdc.address, &s.xlm.address, 400 * U, 2_000_000)];
    let got = s.m.move_order_vault(&s.owner, &old.address, &s.new_factory.address, &(500 * U), &vec![&s.env, o], &place, &Some(s.ex.address.clone()));
    print_cost(&s, "G1 mock USDC vault, exchange, 1 cancel + 1 order, existing vault");
    check_limits(&s);

    assert_eq!(got, nv);
    assert_eq!(v.balance(&s.usdc.address), 550 * U);
    assert_eq!(v.balance(&s.mock.address), 0);
    assert_eq!(v.reserved(&s.usdc.address), 400 * U);
    assert_eq!(old.balance(), 0);
    assert_eq!(old.get_order(&o).status, g1::OrderStatus::Cancelled);
    assert_eq!(wallet(&s), before);
    assert_eq!(s.ex.used(&s.owner), 500 * U);
}

#[test]
fn first_generation_xlm_vault_without_orders() {
    let s = setup();
    let old = old_g1(&s, &s.xlm.address, &s.mock.address);
    old.deposit(&(1_191 * U));
    let before = wallet(&s);
    let nv = s.m.move_order_vault(&s.owner, &old.address, &s.new_factory.address, &(1_191 * U), &Vec::new(&s.env), &none(&s), &None);
    print_cost(&s, "G1 XLM vault, no orders, new vault");
    check_limits(&s);
    assert_eq!(vault::Client::new(&s.env, &nv).balance(&s.xlm.address), 1_191 * U);
    assert_eq!(old.balance(), 0);
    assert_eq!(wallet(&s), before);
}

#[test]
fn interest_after_the_simulation_stays_behind_and_the_wallet_is_untouched() {
    let s = setup();
    let (old, pool) = old_g4(&s, &s.owner, &s.xlm.address, &s.mock.address);
    old.deposit(&(1_000 * U));
    // Interest accrues between the simulation (balance 1,000) and execution: +1%.
    MockPoolClient::new(&s.env, &pool).set_b_rate(&(B_RATE_SCALE * 101 / 100));
    mint(&s.xlm, &pool, 10 * U);
    assert_eq!(old.balance(), 1_010 * U);
    let before = wallet(&s);
    let nv = s.m.move_order_vault(&s.owner, &old.address, &s.new_factory.address, &(1_000 * U), &Vec::new(&s.env), &none(&s), &None);
    // Exactly the signed amount moved; the interest stays in the old vault (the owner can move it later).
    assert_eq!(vault::Client::new(&s.env, &nv).balance(&s.xlm.address), 1_000 * U);
    assert!(old.balance() >= 10 * U - 1);
    assert_eq!(wallet(&s), before);
}

#[test]
fn mock_usdc_without_an_exchange_moves_as_is() {
    let s = setup();
    let old = old_g1(&s, &s.mock.address, &s.xlm.address);
    old.deposit(&(100 * U));
    // The new vault takes any token as a deposit (only orders need an allowed token): mock USDC moves unchanged.
    let nv = s.m.move_order_vault(&s.owner, &old.address, &s.new_factory.address, &(100 * U), &Vec::new(&s.env), &none(&s), &None);
    let v = vault::Client::new(&s.env, &nv);
    assert_eq!(v.balance(&s.mock.address), 100 * U);
    assert_eq!(v.balance(&s.usdc.address), 0);
    assert_eq!(s.ex.used(&s.owner), 0);
}

#[test]
fn exchange_cap_leaves_the_rest_in_the_wallet() {
    let s = setup();
    s.ex.set_cap(&(60 * U));
    let old = old_g1(&s, &s.mock.address, &s.xlm.address);
    old.deposit(&(100 * U));
    let before = wallet(&s);
    let nv = s.m.move_order_vault(&s.owner, &old.address, &s.new_factory.address, &(100 * U), &Vec::new(&s.env), &none(&s), &Some(s.ex.address.clone()));
    assert_eq!(vault::Client::new(&s.env, &nv).balance(&s.usdc.address), 60 * U);
    // 40 mock USDC above the cap stay in the wallet.
    assert_eq!(wallet(&s), [before[0] + 40 * U, before[1], before[2]]);
}

#[test]
fn a_failing_order_undoes_the_whole_move() {
    let s = setup();
    let (old, _) = old_g4(&s, &s.owner, &s.xlm.address, &s.mock.address);
    old.deposit(&(100 * U));
    let o = old.place_order(&(90 * U), &(5 * U), &(90 * U), &300, &(NOW + DAY));
    // The new order asks for more than arrives.
    let place = vec![&s.env, order(&s, &s.xlm.address, &s.usdc.address, 500 * U, 5 * U)];
    assert!(s.m.try_move_order_vault(&s.owner, &old.address, &s.new_factory.address, &(100 * U), &vec![&s.env, o], &place, &None).is_err());
    assert_eq!(old.balance(), 100 * U);
    assert_eq!(old.get_order(&o).status, g4::OrderStatus::Open);
    assert_eq!(s.new_factory.vault_of(&s.owner), None);
}

#[test]
fn checks_owner_amount_and_order_functions() {
    let s = setup();
    // Someone else's old vault: NotOwner, before anything moves.
    let other = Address::generate(&s.env);
    mint(&s.xlm, &other, 100 * U);
    let (theirs, _) = old_g4(&s, &other, &s.xlm.address, &s.mock.address);
    theirs.deposit(&(100 * U));
    assert_eq!(
        s.m.try_move_order_vault(&s.owner, &theirs.address, &s.new_factory.address, &(100 * U), &Vec::new(&s.env), &none(&s), &None),
        Err(Ok(soroban_sdk::Error::from(Error::NotOwner)))
    );
    // Not an order vault at all (a token has no `get_config`): fails too.
    assert!(s.m.try_move_order_vault(&s.owner, &s.xlm.address, &s.new_factory.address, &(100 * U), &Vec::new(&s.env), &none(&s), &None).is_err());
    let (old, _) = old_g4(&s, &s.owner, &s.xlm.address, &s.mock.address);
    old.deposit(&(100 * U));
    assert_eq!(
        s.m.try_move_order_vault(&s.owner, &old.address, &s.new_factory.address, &0, &Vec::new(&s.env), &none(&s), &None),
        Err(Ok(soroban_sdk::Error::from(Error::InvalidAmount)))
    );
    let bad = PlaceCall { func: Symbol::new(&s.env, "withdraw"), args: (s.xlm.address.clone(), 1i128).into_val(&s.env) };
    assert_eq!(
        s.m.try_move_order_vault(&s.owner, &old.address, &s.new_factory.address, &(100 * U), &Vec::new(&s.env), &vec![&s.env, bad], &None),
        Err(Ok(soroban_sdk::Error::from(Error::FuncNotAllowed)))
    );
    assert_eq!(s.m.version(), 2);
}

#[test]
fn one_authorization_covers_the_whole_move() {
    let s = setup();
    let (old, _) = old_g4(&s, &s.owner, &s.xlm.address, &s.mock.address);
    old.deposit(&(100 * U));
    let o = old.place_order(&(50 * U), &(5 * U), &(50 * U), &300, &(NOW + DAY));
    let place = vec![&s.env, order(&s, &s.xlm.address, &s.usdc.address, 50 * U, 5 * U)];
    s.m.move_order_vault(&s.owner, &old.address, &s.new_factory.address, &(100 * U), &vec![&s.env, o], &place, &None);
    // Exactly one authorization: the owner's, rooted at the mover; every vault call is a sub-invocation of it.
    let auths = s.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, s.owner);
    match &auths[0].1.function {
        soroban_sdk::testutils::AuthorizedFunction::Contract((c, f, _)) => {
            assert_eq!(*c, s.m.address);
            assert_eq!(*f, Symbol::new(&s.env, "move_order_vault"));
        }
        _ => panic!("not a contract call"),
    }
}

/// Resource use by the number of orders (mock pools; see the report for real Blend numbers).
#[test]
fn resource_use_by_orders() {
    for (n, convert) in [(0u32, false), (1, false), (3, false), (6, false), (3, true), (10, false)] {
        let s = setup();
        let coin = if convert { s.mock.address.clone() } else { s.xlm.address.clone() };
        let other = if convert { s.xlm.address.clone() } else { s.mock.address.clone() };
        let (old, _) = old_g4(&s, &s.owner, &coin, &other);
        old.deposit(&(1_000 * U));
        let sell = if convert { s.usdc.address.clone() } else { s.xlm.address.clone() };
        let buy = if convert { s.xlm.address.clone() } else { s.usdc.address.clone() };
        let mut cancel = Vec::new(&s.env);
        let mut place = Vec::new(&s.env);
        for _ in 0..n {
            cancel.push_back(old.place_order(&(50 * U), &2_000_000, &(50 * U), &300, &(NOW + DAY)));
            place.push_back(order(&s, &sell, &buy, 50 * U, 2_000_000));
        }
        let ex = if convert { Some(s.ex.address.clone()) } else { None };
        s.m.move_order_vault(&s.owner, &old.address, &s.new_factory.address, &(1_000 * U), &cancel, &place, &ex);
        print_cost(&s, &std::format!("{n} cancels + {n} orders + new vault, exchange={convert}"));
        if n <= 6 {
            check_limits(&s);
        }
    }
}
