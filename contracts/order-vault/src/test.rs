//! Yerel testler. Blend ve Soroswap yerine davranislari taklit eden sahte
//! (mock) sozlesmeler kullanilir; yetkilendirme kurallari gercekleriyle ayni.
extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    symbol_short, vec, Address, Env, Map, Vec,
};

const U: i128 = 10_000_000; // 1 token (7 ondalik)
const NOW: u64 = 1_000_000;
const DAY: u64 = 86_400;
const IMPACT: u32 = 300; // %3

/// Sozlesme hata kodunu istemcinin dondurdugu genel hata tipine cevirir.
fn ce(e: Error) -> soroban_sdk::Error {
    e.into()
}

// ---------------------------------------------------------------------------
// Sahte Blend havuzu (b_token + b_rate muhasebesi gercegine benzer)
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
                // Havuzda nakit yoksa bu transfer basarisiz olur (likidite yetersiz).
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

    /// Faiz birikimini taklit eder.
    pub fn set_b_rate(env: Env, rate: i128) {
        env.storage().instance().set(&PoolKey::BRate, &rate);
    }

    pub fn b_tokens(env: Env, who: Address) -> i128 {
        env.storage().instance().get(&PoolKey::BTokens(who)).unwrap_or(0)
    }

    /// Borc alanlarin havuzdaki nakdi cekmesini taklit eder.
    pub fn lend_out(env: Env, to: Address, amount: i128) {
        let token: Address = env.storage().instance().get(&PoolKey::Token).unwrap();
        TokenClient::new(&env, &token).transfer(&env.current_contract_address(), &to, &amount);
    }
}

// ---------------------------------------------------------------------------
// Sahte Soroswap router (sabit fiyat; buyuk islemlerde istege bagli fiyat etkisi)
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub enum RouterKey {
    /// 1 USDC karsiligi verilen XLM (7 ondalik).
    Price,
    /// (esik, bps): esigi asan islemlerde cikis bps kadar azalir.
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
// Sahte fiyat oracle'i (Blend/Reflector arayuzu): fiyat 7 ondalik, zaman damgasi ayarlanabilir
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

    /// Fiyatin kac saniye once guncellendigini taklit eder (eski veri testi).
    pub fn set_age(env: Env, age: u64) {
        env.storage().instance().set(&OracleKey::Age, &age);
    }

    /// Gelecekten zaman damgasi (bozuk oracle) taklidi.
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
// Sahte duraklatma sozlesmesi (fabrikanin yerine)
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

    /// Kardes fabrika taklidi: testlerde ayni sahte sozlesme iki fabrikanin da yerini tutar.
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
// Sahte token: belirli bir adrese transferi reddedebilir (trustline'i olmayan cuzdan taklidi)
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
// Kurulum
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

/// XLM fiyati 0,20 USDC (1 USDC = 5 XLM). Kullanicinin 10.000 USDC'si var.
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
    // Oracle: USDC 1,00 $, XLM 0,20 $ (havuz fiyatiyla ayni)
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

/// 10.000 USDC yatir, 4.000 USDC'lik "XLM <= 0,20" emri ver (asgari dolum 500).
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
// Temel akis
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
    s.router.set_price(&(6 * U)); // XLM 0,1667 USDC
    let out = s.vault.execute(&s.outsider, &0, &(1_000 * U));
    assert_eq!(out, 6_000 * U);
}

#[test]
fn whole_tx_reverts_when_price_is_worse() {
    let s = setup_with_order();
    s.router.set_price(&(4 * U)); // XLM 0,25 USDC: limit saglanmiyor
    assert!(s.vault.try_execute(&s.outsider, &0, &(4_000 * U)).is_err());
    // Blend cekimi de geri alinmis olmali.
    assert_eq!(s.pool.b_tokens(&s.vault.address), 10_000 * U);
    assert_order_untouched(&s);
}

#[test]
fn execute_needs_no_signature() {
    // Keeper hicbir imza vermeden cagirir. Kasanin Blend ve Soroswap icindeki
    // token transferlerini kendi adina yetkilendirmesi gercekten calisiyor mu?
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
// Kismi dolum, likidite, rezerv
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
    // 3.000 doldurmak geride 1.000 (< asgari 1.500) birakirdi: reddedilir.
    assert_eq!(s.vault.try_execute(&s.outsider, &0, &(3_000 * U)), Err(Ok(ce(Error::FillTooSmall))));
    // "Kalan - 1" dolumuyla emri kirintiyla acik birakma denemesi de reddedilir.
    assert_eq!(s.vault.try_execute(&s.outsider, &0, &(4_000 * U - 1)), Err(Ok(ce(Error::FillTooSmall))));
    assert_eq!(s.vault.get_order(&0).filled_in, 0);
    // 2.500 doldurmak geride 1.500 birakir: gecerli; kalan tek parcada biter.
    s.vault.execute(&s.outsider, &0, &(2_500 * U));
    assert_eq!(s.vault.try_execute(&s.outsider, &0, &(1_000 * U)), Err(Ok(ce(Error::FillTooSmall))));
    s.vault.execute(&s.outsider, &0, &(1_500 * U));
    assert_eq!(s.vault.get_order(&0).status, OrderStatus::Filled);
    assert_eq!(s.vault.reserved(), 0);
}

#[test]
fn low_blend_liquidity_reverts_then_partial_succeeds() {
    let s = setup_with_order();
    // Borc alanlar havuzun nakdinin 9.000'ini cekmis; 1.000 nakit kalmis.
    s.pool.lend_out(&s.outsider, &(9_000 * U));

    assert!(s.vault.try_execute(&s.outsider, &0, &(4_000 * U)).is_err());
    assert_eq!(s.pool.b_tokens(&s.vault.address), 10_000 * U);
    assert_order_untouched(&s);

    // Keeper kisa miktarla yeniden dener.
    let out = s.vault.execute(&s.outsider, &0, &(1_000 * U));
    assert_eq!(out, 5_000 * U);
    assert_eq!(s.vault.reserved(), 3_000 * U);
}

#[test]
fn reserved_balance_cannot_be_spent_twice() {
    let s = setup_with_order(); // 4.000 ayrildi, 6.000 serbest
    assert_eq!(
        s.vault.try_place_order(&(6_001 * U), &2_000_000, &(1_000 * U), &IMPACT, &(NOW + DAY)),
        Err(Ok(ce(Error::InsufficientFree)))
    );
    assert_eq!(s.vault.try_withdraw(&(6_001 * U)), Err(Ok(ce(Error::InsufficientFree))));

    s.vault.withdraw(&s.vault.free_balance());
    assert_eq!(s.usdc.balance(&s.owner), 6_000 * U - ROUNDING_BUFFER);
    assert_eq!(s.vault.free_balance(), 0);
    // Emir hala tam doldurulabilir.
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
    // Suresi gecen emri kullanici iptal edip parasini alabilir.
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
// Faiz muhasebesi
// ---------------------------------------------------------------------------

/// Havuz %5 faiz kazandirmis gibi yapar (faizi odeyecek nakit de havuza eklenir).
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
    // Anaparadan fazla, ama faiz dahil bakiyeden az.
    s.vault.place_order(&(10_400 * U), &2_000_000, &(1_000 * U), &IMPACT, &(NOW + DAY));
    assert_eq!(s.vault.free_balance(), 100 * U - ROUNDING_BUFFER);
    s.vault.execute(&s.outsider, &0, &(10_400 * U));
    assert_eq!(s.xlm.balance(&s.owner), 52_000 * U);
    assert_eq!(s.vault.deposited(), 0);
    // Blend yuvarlamasi en fazla 1 birim.
    let b = s.vault.balance();
    assert!(b >= 100 * U - 1 && b <= 100 * U);
}

#[test]
fn reserved_stays_safe_while_interest_accrues() {
    let s = setup_with_order(); // 4.000 ayrildi
    accrue_5_percent(&s);
    // Serbest = 10.500 - 4.000
    assert_eq!(s.vault.free_balance(), 6_500 * U - ROUNDING_BUFFER);
    assert_eq!(s.vault.try_withdraw(&(6_500 * U)), Err(Ok(ce(Error::InsufficientFree))));
    // Serbest bakiyenin tamamini cekmek rezervi eksik birakmamali (yuvarlama tamponu).
    s.vault.withdraw(&s.vault.free_balance());
    // Emir hala tam doldurulabilir.
    s.vault.execute(&s.outsider, &0, &(4_000 * U));
    assert_eq!(s.vault.get_order(&0).status, OrderStatus::Filled);
}

// ---------------------------------------------------------------------------
// Fiyat etkisi korumasi
// ---------------------------------------------------------------------------

#[test]
fn high_impact_fill_rejected_smaller_fill_ok() {
    let s = setup_with_order(); // azami etki %3
    // 2.000 USDC'yi asan takaslar %5 daha az XLM verir (sig havuz).
    s.router.set_penalty(&(2_000 * U), &500);
    assert_eq!(s.vault.try_execute(&s.outsider, &0, &(4_000 * U)), Err(Ok(ce(Error::ImpactTooHigh))));
    assert_order_untouched(&s);

    // Keeper parcalara boler.
    s.vault.execute(&s.outsider, &0, &(2_000 * U));
    s.vault.execute(&s.outsider, &0, &(2_000 * U));
    assert_eq!(s.vault.get_order(&0).status, OrderStatus::Filled);
    assert_eq!(s.xlm.balance(&s.owner), 20_000 * U);
}

#[test]
fn impact_within_tolerance_passes() {
    let s = setup();
    s.vault.deposit(&(10_000 * U));
    // Azami etki %6, havuz etkisi %5: gecer. Limit 0,25 oldugu icin fiyat da tutar.
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
    s.router.set_penalty(&(2_000 * U), &2_000); // %20 etki
    let out = s.vault.execute(&s.outsider, &0, &(4_000 * U));
    assert_eq!(out, 16_000 * U);
}

// ---------------------------------------------------------------------------
// Duraklatma
// ---------------------------------------------------------------------------

#[test]
fn pause_blocks_only_new_orders() {
    let s = setup_with_order();
    s.guard.set_paused(&true);
    assert_eq!(
        s.vault.try_place_order(&(100 * U), &2_000_000, &(100 * U), &IMPACT, &(NOW + DAY)),
        Err(Ok(ce(Error::Paused)))
    );
    // Mevcut emir doldurulabilir, iptal ve cekim calisir.
    s.vault.execute(&s.outsider, &0, &(1_000 * U));
    s.vault.cancel_order(&0);
    s.vault.withdraw(&(9_000 * U));
    assert_eq!(s.usdc.balance(&s.owner), 9_000 * U);

    s.guard.set_paused(&false);
    s.vault.deposit(&(1_000 * U));
    s.vault.place_order(&(500 * U), &2_000_000, &(100 * U), &IMPACT, &(NOW + DAY));
}

// ---------------------------------------------------------------------------
// Surum 2: tamamini cekme, emir sayisi, omur boyu toplamlar
// ---------------------------------------------------------------------------

#[test]
fn withdraw_all_burns_every_b_token() {
    let s = setup();
    s.vault.deposit(&(10_000 * U));
    accrue_5_percent(&s);
    let free = s.vault.free_balance();
    s.vault.withdraw(&free);
    // Kirinti kalmamali; aksi halde simulasyon/uygulama arasinda kayit boyutu degisir.
    assert_eq!(s.pool.b_tokens(&s.vault.address), 0);
    assert_eq!(s.usdc.balance(&s.owner), 10_500 * U);
    assert_eq!(s.vault.balance(), 0);
    let st = s.vault.stats();
    assert_eq!(st.total_withdrawn, 10_500 * U);
}

#[test]
fn withdraw_all_pays_interest_accrued_after_quote() {
    // Kullanici bakiyeyi okuduktan sonra faiz artarsa yine hepsi cekilir.
    let s = setup();
    s.vault.deposit(&(10_000 * U));
    let quoted = s.vault.free_balance(); // 10.000
    accrue_5_percent(&s);
    s.vault.withdraw(&quoted);
    // Istenen 10.000 < guncel bakiye 10.500 -> normal cekim; 500 faiz kasada kalir.
    assert_eq!(s.usdc.balance(&s.owner), 10_000 * U);
    // Blend yakilan b_token'i yukari yuvarlar: en fazla 1 birim eksik.
    let left = s.vault.balance();
    assert!(left >= 500 * U - 1 && left <= 500 * U);
    // Ikinci "tamamini cek" kalan faizi alir ve kirinti birakmaz.
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
    accrue_5_percent(&s); // 6.000 * %5 = 300 faiz
    s.vault.withdraw(&(1_000 * U));

    let st = s.vault.stats();
    assert_eq!(st.total_deposited, 10_000 * U);
    assert_eq!(st.total_spent, 4_000 * U);
    assert_eq!(st.total_received, 20_000 * U);
    assert_eq!(st.total_withdrawn, 1_000 * U);
    // Omur boyu faiz = bakiye + cekilen + harcanan - yatirilan
    let lifetime = s.vault.balance() + st.total_withdrawn + st.total_spent - st.total_deposited;
    assert!(lifetime >= 300 * U - 1 && lifetime <= 300 * U);
}

// ---------------------------------------------------------------------------
// Surum 3: tetikli emir (stop) ve zincirleme emir (alim -> satis kasasi)
// ---------------------------------------------------------------------------

#[test]
fn stop_order_waits_for_trigger_then_fills() {
    let s = setup();
    s.vault.deposit(&(10_000 * U));
    // "XLM 0,25'e cikarsa al, en fazla 0,26 ode" (kirilim alimi). Piyasa 0,20.
    let id = s.vault.place_stop_order(&(1_000 * U), &2_500_000, &2_600_000, &(100 * U), &IMPACT, &(NOW + DAY), &300);
    assert_eq!(s.vault.get_order(&id).trigger_price, 2_500_000);
    assert_eq!(s.vault.get_order(&id).stop_band_bps, 300);
    // Fiyat 0,20 limitten iyi ama tetik gelmedi: dolum yok.
    assert_eq!(s.vault.try_execute(&s.outsider, &id, &(1_000 * U)), Err(Ok(ce(Error::TriggerNotMet))));
    assert_eq!(s.vault.get_order(&id).filled_in, 0);
    // XLM 0,25: tetik geldi (oracle), limit (0,26) de tutuyor.
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
    // XLM 0,2857: tetik gecildi ama limit 0,26'dan pahali -> islem tamamen geri alinir.
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
    // Limit tetikten kotu olamaz (aksi halde emir hic dolamaz).
    assert_eq!(
        s.vault.try_place_stop_order(&(100 * U), &2_500_000, &2_400_000, &(10 * U), &IMPACT, &(NOW + DAY), &300),
        Err(Ok(ce(Error::InvalidPrice)))
    );
    // Limit tetikten en fazla %10 uzak olabilir (2,75 sinirda gecerli, 2,76 degil).
    assert_eq!(
        s.vault.try_place_stop_order(&(100 * U), &2_500_000, &2_760_000, &(10 * U), &IMPACT, &(NOW + DAY), &300),
        Err(Ok(ce(Error::InvalidPrice)))
    );
    // Sapma bandi %0,5 - %10 arasinda olmali.
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
    // Normal emirlerin tetigi ve bandi yoktur.
    let id = s.vault.place_order(&(100 * U), &2_000_000, &(10 * U), &IMPACT, &(NOW + DAY));
    assert_eq!(s.vault.get_order(&id).trigger_price, 0);
    assert_eq!(s.vault.get_order(&id).stop_band_bps, 0);
}

/// Ayni kontrat, tokenlar ters: XLM yatirilir, USDC alinir (satis kasasi).
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
    // Kardes fabrika kaydi: sahibin satis kasasi budur (zincirleme emrin hedef dogrulamasi).
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
    // Sahte router yon ayirt etmez: satis testinde fiyat "1 XLM = 0,20 USDC".
    s.router.set_price(&2_000_000);
    sv.deposit(&(1_000 * U));
    // "XLM 0,15'e duserse sat, en az 0,14 al": birimler 1 USDC icin XLM.
    let trigger = 10_000_000 * SCALE / 1_500_000; // 6,6666666 XLM / USDC (asagi yuvarlanir)
    let limit = 10_000_000 * SCALE / 1_400_000; // 7,1428571
    let id = sv.place_stop_order(&(900 * U), &trigger, &limit, &(100 * U), &IMPACT, &(NOW + DAY), &300);
    // XLM hala 0,20: zarar kes calismaz.
    assert_eq!(sv.try_execute(&s.outsider, &id, &(900 * U)), Err(Ok(ce(Error::TriggerNotMet))));
    // XLM 0,15'e dustu: satilir.
    s.router.set_price(&1_500_000);
    s.oracle.set_price(&s.xlm.address, &1_500_000);
    let before = s.usdc.balance(&s.owner); // kurulumdaki 10.000 USDC
    let out = sv.execute(&s.outsider, &id, &(900 * U));
    assert_eq!(out, 135 * U);
    assert_eq!(s.usdc.balance(&s.owner) - before, 135 * U);
}

/// Alim kasasi 4.000 USDC'lik "XLM <= 0,20" emri; dolunca XLM satis kasasina gidip
/// "XLM >= 0,25" satis emri olarak acilir.
fn chained_setup() -> (Setup<'static>, OrderVaultClient<'static>, MockPoolClient<'static>) {
    let s = setup();
    let (sv, xpool) = sell_vault(&s);
    s.vault.deposit(&(10_000 * U));
    let sell_limit = 10_000_000 * SCALE / 2_500_000; // 4 XLM / USDC = 0,25 USDC / XLM
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
    // Keeper imzasiz cagirir: kasalar arasi aktarim yetkileri gercekten calismali.
    s.env.set_auths(&[]);
    let out = s.vault.execute(&s.outsider, &0, &(4_000 * U));
    assert_eq!(out, 20_000 * U);
    // XLM cuzdana degil satis kasasina gitti ve Blend'de faiz kazaniyor.
    assert_eq!(s.xlm.balance(&s.owner), 0);
    assert_eq!(s.xlm.balance(&s.vault.address), 0);
    assert_eq!(xpool.b_tokens(&sv.address), 20_000 * U);
    assert_eq!(sv.balance(), 20_000 * U);
    // Satis emri otomatik acildi; yuvarlama tamponu emre baglanmaz.
    let o = sv.get_order(&0);
    assert_eq!(o.amount_in, 20_000 * U - ROUNDING_BUFFER);
    assert_eq!(o.limit_price, 40_000_000);
    assert_eq!(o.expiry, NOW + 7 * DAY);
    assert_eq!(o.status, OrderStatus::Open);
    assert_eq!(sv.reserved(), 20_000 * U - ROUNDING_BUFFER);
    assert_eq!(sv.stats().total_deposited, 20_000 * U);
    // Alim emri normal sekilde kapandi.
    assert_eq!(s.vault.get_order(&0).status, OrderStatus::Filled);
    assert_eq!(s.vault.get_order(&0).filled_out, 20_000 * U);
}

#[test]
fn chained_order_falls_back_to_wallet_without_permission() {
    let (s, sv, xpool) = chained_setup();
    // Satis kasasi bu alim kasasina izin vermedi: XLM her zamanki gibi cuzdana gider.
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
    // Yeni emirler durduruldu: satis emri acilamaz, ama alim yine dolar ve XLM cuzdana gider.
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
    // Izin verilen kimse yok.
    assert_eq!(
        sv.try_receive_and_order(&s.outsider, &(100 * U), &40_000_000, &IMPACT, &(NOW + DAY)),
        Err(Ok(ce(Error::NotFeeder)))
    );
    // Izin alim kasasina verildi; baskasi yine giremez.
    sv.set_feeder(&Some(s.vault.address.clone()));
    assert_eq!(
        sv.try_receive_and_order(&s.outsider, &(100 * U), &40_000_000, &IMPACT, &(NOW + DAY)),
        Err(Ok(ce(Error::NotFeeder)))
    );
    // Izni yalnizca sahip verebilir.
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
    // Kendine zincirleme yasak.
    assert_eq!(bad(40_000_000, IMPACT, DAY, &s.vault.address), Err(Ok(ce(Error::InvalidFollowUp))));
    // Hata durumunda emir de olusmamali.
    assert_eq!(s.vault.order_count(), 0);
    assert_eq!(s.vault.reserved(), 0);
}

#[test]
fn chain_target_must_be_own_matching_vault() {
    // Bagimsiz inceleme: zincirin hedefi baskasinin kasasi olamaz (cikti ona giderdi) ve hedef bu
    // emrin aldigi tokeni (XLM) kabul eden kasa olmali.
    let s = setup();
    s.vault.deposit(&(1_000 * U));
    let env = &s.env;
    let place = |target: &Address| {
        s.vault.try_place_order_then(&(100 * U), &2_000_000, &(10 * U), &IMPACT, &(NOW + DAY), target, &40_000_000, &IMPACT, &DAY)
    };
    // Baskasinin (outsider) satis kasasi
    let xpool = env.register(MockPool, (s.xlm.address.clone(),));
    let foreign = env.register(
        OrderVault,
        (s.outsider.clone(), s.xlm.address.clone(), s.usdc.address.clone(), xpool, s.router.address.clone(), s.guard.address.clone(), 0i128),
    );
    assert_eq!(place(&foreign), Err(Ok(ce(Error::InvalidFollowUp))));
    // Sahibin baska bir alim kasasi: XLM degil USDC kabul eder
    let upool = env.register(MockPool, (s.usdc.address.clone(),));
    let other_buy = env.register(
        OrderVault,
        (s.owner.clone(), s.usdc.address.clone(), s.xlm.address.clone(), upool, s.router.address.clone(), s.guard.address.clone(), 0i128),
    );
    assert_eq!(place(&other_buy), Err(Ok(ce(Error::InvalidFollowUp))));
    assert_eq!(s.vault.order_count(), 0);
    // Sahibin kendi satis kasasi: kabul
    let (sv, _) = sell_vault(&s);
    assert!(place(&sv.address).is_ok());
    assert_eq!(s.vault.get_follow_up(&0).unwrap().vault, sv.address);
}

// ---------------------------------------------------------------------------
// Guvenlik incelemesi sonrasi: tetik oracle'dan okunur, kasada kalan token kurtarilir
// ---------------------------------------------------------------------------

#[test]
fn stop_trigger_ignores_manipulated_pool_price() {
    // Saldiri: ayni islemde havuzu satarak fiyati dusur, zarar kesi tetikle, geri al.
    let s = setup();
    let (sv, _) = sell_vault(&s);
    StellarAssetClient::new(&s.env, &s.xlm.address).mint(&s.owner, &(1_000 * U));
    s.usdc_admin.mint(&s.router.address, &(1_000_000 * U));
    s.router.set_price(&2_000_000);
    sv.deposit(&(1_000 * U));
    let trigger = 10_000_000 * SCALE / 1_500_000;
    let limit = 10_000_000 * SCALE / 1_400_000;
    let id = sv.place_stop_order(&(900 * U), &trigger, &limit, &(100 * U), &IMPACT, &(NOW + DAY), &300);
    // Havuz fiyati 0,145'e itildi ama gercek fiyat (oracle) hala 0,20: dolum yok.
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
    // Oracle 20 dakikadir guncellenmemis: tetikli emir calismaz.
    s.oracle.set_age(&(20 * 60));
    assert_eq!(s.vault.try_execute(&s.outsider, &id, &(1_000 * U)), Err(Ok(ce(Error::OracleUnavailable))));
    s.oracle.set_age(&60);
    s.vault.execute(&s.outsider, &id, &(1_000 * U));
    // Normal limit emirleri oracle'a hic bakmaz.
    s.oracle.set_age(&(99 * 60));
    let id2 = s.vault.place_order(&(1_000 * U), &2_600_000, &(100 * U), &IMPACT, &(NOW + DAY));
    s.vault.execute(&s.outsider, &id2, &(1_000 * U));
}

#[test]
fn owner_can_sweep_stray_tokens_and_claim() {
    let s = setup();
    s.vault.deposit(&(1_000 * U));
    // Yanlislikla kasaya gonderilen XLM
    StellarAssetClient::new(&s.env, &s.xlm.address).mint(&s.vault.address, &(7 * U));
    assert_eq!(s.vault.sweep(&s.xlm.address), 7 * U);
    assert_eq!(s.xlm.balance(&s.owner), 7 * U);
    assert_eq!(s.xlm.balance(&s.vault.address), 0);
    // Blend'deki para sweep ile cekilemez (yalnizca kasada duran token).
    assert_eq!(s.vault.sweep(&s.usdc.address), 0);
    assert_eq!(s.vault.balance(), 1_000 * U);
    s.vault.claim_rewards(&vec![&s.env, 1u32]);
    // Yalnizca sahip
    s.env.set_auths(&[]);
    assert!(s.vault.try_sweep(&s.xlm.address).is_err());
    assert!(s.vault.try_claim_rewards(&vec![&s.env, 1u32]).is_err());
}

// ---------------------------------------------------------------------------
// Ikinci inceleme sonrasi
// ---------------------------------------------------------------------------

#[test]
fn stop_fill_must_be_close_to_oracle_price() {
    // Zarar kes tetiklendi (oracle 0,15) ama havuz 0,143'e itilmis: limit (0,14) izin verse de
    // oracle'a gore %3'ten fazla kotu oldugu icin dolum reddedilir.
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
    // Havuz oracle'a yakin (0,148, %1,3 asagi): dolum gecer.
    s.router.set_price(&1_480_000);
    let out = sv.execute(&s.outsider, &id, &(900 * U));
    assert_eq!(out, 900 * 1_480_000);
}

#[test]
fn stop_order_needs_oracle_prices_when_placed() {
    let s = setup();
    s.vault.deposit(&(1_000 * U));
    // Oracle XLM fiyati vermiyor: emir hic tetiklenemeyecegi icin bastan reddedilir.
    s.oracle.set_price(&s.xlm.address, &0);
    assert_eq!(
        s.vault.try_place_stop_order(&(100 * U), &2_500_000, &2_600_000, &(10 * U), &IMPACT, &(NOW + DAY), &300),
        Err(Ok(ce(Error::OracleUnavailable)))
    );
    // Gelecekten zaman damgasi da gecersiz.
    s.oracle.set_price(&s.xlm.address, &2_000_000);
    s.oracle.set_future(&600);
    assert_eq!(
        s.vault.try_place_stop_order(&(100 * U), &2_500_000, &2_600_000, &(10 * U), &IMPACT, &(NOW + DAY), &300),
        Err(Ok(ce(Error::OracleUnavailable)))
    );
    // Normal emir oracle'dan bagimsiz.
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
// Ic denetim (Kasim 2026) sonrasi: her bulgu icin bir test
// ---------------------------------------------------------------------------

#[test]
fn first_order_leaves_rounding_buffer() {
    // Bulgu 5: tampon ilk emirde de birakilir; bakiyenin tamami emre baglanamaz.
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
    // Faiz biriktikce yuvarlama (b_rate 1'den buyuk) olsa da emir dort parcada tam dolar.
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
    // Bulgu 4 ve 5: min_fill, tutarin MAX_FILLS'te birinden kucuk olamaz.
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
    // Bulgu 7.
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
    // Bulgu 7: suresi dolan emir rezervi tutmaya devam etmesin diye herkes kapatabilir.
    let s = setup_with_order();
    s.env.set_auths(&[]);
    // Suresi dolmadan yalnizca sahip iptal edebilir.
    assert!(s.vault.try_cancel_order(&0).is_err());
    s.env.ledger().set_timestamp(NOW + DAY + 1);
    s.vault.cancel_order(&0);
    assert_eq!(s.vault.get_order(&0).status, OrderStatus::Cancelled);
    assert_eq!(s.vault.reserved(), 0);
    // Para yerinden oynamadi: hepsi hala kasada ve sahibinin.
    assert_eq!(s.vault.balance(), 10_000 * U);
    assert_eq!(s.vault.free_balance(), 10_000 * U);
    assert_eq!(s.usdc.balance(&s.outsider), 0);
}

#[test]
fn chain_cannot_sell_below_buy_price() {
    // Bulgu 8: 0,20'den al, 0,1667'den sat (limit 6 XLM/USDC) zincirde kabul edilmez.
    let s = setup();
    let (sv, _) = sell_vault(&s);
    s.vault.deposit(&(1_000 * U));
    let place = |then_limit: i128| {
        s.vault.try_place_order_then(&(100 * U), &2_000_000, &(25 * U), &IMPACT, &(NOW + DAY), &sv.address, &then_limit, &IMPACT, &DAY)
    };
    assert_eq!(place(60_000_000), Err(Ok(ce(Error::InvalidFollowUp))));
    assert_eq!(place(MAX_PRICE + 1), Err(Ok(ce(Error::InvalidFollowUp))));
    assert_eq!(s.vault.order_count(), 0);
    // Alis fiyatindan satis (5 XLM/USDC) sinirdir: kabul.
    assert!(place(50_000_000).is_ok());
}

#[test]
fn chain_target_must_be_registered_in_sibling_factory() {
    // Bulgu 3: hedefin kendi beyani yetmez. Sahibi ve tokenlari dogru gorunen ama kardes fabrikada
    // kayitli olmayan bir kasa hedef olamaz.
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
    // Kardes fabrika hic ayarlanmamis.
    assert_eq!(place(&unregistered), Err(Ok(ce(Error::InvalidFollowUp))));
    // Kardes fabrika var ama sahibin kayitli kasasi baska bir adres.
    let (sv, _) = sell_vault(&s);
    assert_eq!(place(&unregistered), Err(Ok(ce(Error::InvalidFollowUp))));
    assert_eq!(s.vault.order_count(), 0);
    assert!(place(&sv.address).is_ok());
}

#[test]
fn stop_band_is_chosen_by_the_user() {
    // Bulgu 1: bant %1 secildiyse, oracle'dan %1,3 kotu dolum reddedilir (%3 bantta gecerdi).
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
    // Oracle'dan %0,67 kotu: bant icinde.
    s.router.set_price(&1_490_000);
    let out = sv.execute(&s.outsider, &id, &(900 * U));
    assert_eq!(out, 900 * 1_490_000);
}

#[test]
fn withdraw_all_sentinel_takes_everything_free() {
    // Bulgu 12: ozel deger, imza ile islem arasinda biriken faizi de ceker.
    let s = setup();
    s.vault.deposit(&(10_000 * U));
    accrue_5_percent(&s);
    s.vault.withdraw(&WITHDRAW_ALL);
    assert_eq!(s.pool.b_tokens(&s.vault.address), 0);
    assert_eq!(s.usdc.balance(&s.owner), 10_500 * U);
    assert_eq!(s.vault.deposited(), 0);
    // Cekilecek bir sey kalmadiysa hata.
    assert_eq!(s.vault.try_withdraw(&WITHDRAW_ALL), Err(Ok(ce(Error::InsufficientFree))));
}

#[test]
fn withdraw_all_sentinel_never_touches_reserved() {
    let s = setup_with_order(); // 4.000 ayrildi
    s.vault.withdraw(&WITHDRAW_ALL);
    assert_eq!(s.usdc.balance(&s.owner), 6_000 * U - ROUNDING_BUFFER);
    assert_eq!(s.vault.reserved(), 4_000 * U);
    s.vault.execute(&s.outsider, &0, &(4_000 * U));
    assert_eq!(s.vault.get_order(&0).status, OrderStatus::Filled);
}

#[test]
fn sweep_only_works_for_the_two_vault_tokens() {
    // Bulgu 10: kasa, sahibi istese bile rastgele bir sozlesmeyi cagirmaz.
    let s = setup();
    let other = s.env.register(MockToken, ());
    MockTokenClient::new(&s.env, &other).mint(&s.vault.address, &(5 * U));
    assert_eq!(s.vault.try_sweep(&other), Err(Ok(ce(Error::UnknownToken))));
}

#[test]
fn output_waits_in_vault_when_wallet_cannot_receive() {
    // Bulgu 9: sahibin cuzdani cikan tokeni alamiyorsa (trustline yok) dolum durmaz; token kasada
    // bekler ve sahibi sonradan `sweep` ile alir.
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
    // Bekleyen token sonraki dolumun olcumunu bozmaz.
    let out2 = v.execute(&s.outsider, &0, &(200 * U));
    assert_eq!(out2, 1_000 * U);
    assert_eq!(v.get_order(&0).status, OrderStatus::Filled);
    assert_eq!(v.get_order(&0).filled_out, 2_000 * U);
    assert_eq!(v.reserved(), 0);
    assert_eq!(t.balance(&vid), 2_000 * U);

    // Yalnizca sahip alabilir.
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
    // MockPool bir token degildir (decimals yok): kurulum reddedilmeli.
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
// Surum 5: dolum ucreti (dolumu yapana, yalnizca limitten iyi gelen kisimdan)
// ---------------------------------------------------------------------------

const FEE: i128 = U / 10; // dolum basina en fazla 0,1 token

/// Dolum ucretli alim kasasi (ayni sahte havuz ve router); 10.000 USDC yatirilmis.
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
    // Limit 0,25; piyasa 0,20: sahip en az 16.000 XLM almali, takas 20.000 veriyor.
    // Dolumu yapan yalnizca sabit ucreti alir; iyilesmenin geri kalani sahibindir.
    let s = setup();
    let v = fee_vault(&s);
    let filler = Address::generate(&s.env);
    assert_eq!(v.get_config().exec_fee, FEE);
    v.place_order(&(4_000 * U), &2_500_000, &(500 * U), &IMPACT, &(NOW + DAY));
    // Gercek yetki denetimi acik: dolumu yapan hicbir imza vermez, ucreti kasa kendi adina gonderir.
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
    // Limit 0,20; piyasa 0,20: iyilesme yok, ucret yok. Sahip limitinin tam karsiligini alir.
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
    // Iyilesme ucretten kucuk (4.000 birim): dolumu yapan yalnizca o kadarini alir,
    // sahip yine limitinin tam karsiligini (20.000 XLM) alir.
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
    // Dolumu yapanin adresi tokeni alamiyorsa (or. trustline yok) dolum durmaz; ucret sahibinde kalir.
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
    // Zarar kes: oracle 0,15, havuz 0,148, bant %3. Sahip oracle'a gore en az 130,95 USDC almali;
    // takas 133,2 veriyor. Ucret ust siniri 5 USDC olsa da dolumu yapan yalnizca aradaki 2,25'i alir.
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
