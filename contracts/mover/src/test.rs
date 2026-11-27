//! Mover tests with the real vault, factory and exchange wasm (run `stellar contract build` first).
//! Blend is replaced by a pool that has no reserves, so every token waits idle in the vaults.
extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{
        cost_estimate::{InvocationResourceLimits, NetworkInvocationResourceLimits},
        Address as _, Ledger,
    },
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

const U: i128 = 10_000_000;
const NOW: u64 = 1_000_000;
const DAY: u64 = 86_400;

/// A Blend pool with no reserves: `get_reserve` fails, so the vault keeps every token idle.
#[contract]
pub struct NoReservePool;

#[contractimpl]
impl NoReservePool {
    pub fn get_reserve(_env: Env, _asset: Address) -> Map<Symbol, Val> {
        panic!("not a reserve")
    }
}

struct S {
    env: Env,
    owner: Address,
    mock: TokenClient<'static>,
    usdc: TokenClient<'static>,
    xlm: TokenClient<'static>,
    btc: TokenClient<'static>,
    old_factory: factory::Client<'static>,
    new_factory: factory::Client<'static>,
    old: vault::Client<'static>,
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

/// Old factory (mock USDC, XLM, BTC) with the owner's old vault, new factory (Circle USDC, XLM, BTC), the exchange
/// with 10,000 Circle USDC, and the mover. The owner's wallet holds 10,000 of each token.
fn setup() -> S {
    let env = Env::default();
    // The test client reads the recorded authorizations after every call; for a call tree as large as a move
    // that read alone (test-only, not metered on the network) trips the enforced limits. They are switched off
    // here and every move checks its measured resources against the mainnet limits itself (`check_limits`).
    env.cost_estimate().disable_resource_limits();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);
    let owner = Address::generate(&env);
    let guardian = Address::generate(&env);
    let (mock, usdc, xlm, btc) = (token(&env), token(&env), token(&env), token(&env));
    let pool = env.register(NoReservePool, ());
    let router = Address::generate(&env);
    let hash = env.deployer().upload_contract_wasm(vault::WASM);
    let fees: Map<Address, i128> = Map::new(&env);
    let old_factory = factory::Client::new(
        &env,
        &env.register(
            factory::WASM,
            (guardian.clone(), hash.clone(), pool.clone(), router.clone(), fees.clone(), vec![&env, mock.address.clone(), xlm.address.clone(), btc.address.clone()]),
        ),
    );
    let new_factory = factory::Client::new(
        &env,
        &env.register(factory::WASM, (guardian.clone(), hash, pool, router, fees, vec![&env, usdc.address.clone(), xlm.address.clone(), btc.address.clone()])),
    );
    let ex = exchange::Client::new(&env, &env.register(exchange::WASM, (guardian, mock.address.clone(), usdc.address.clone())));
    mint(&usdc, &ex.address, 10_000 * U);
    for t in [&mock, &usdc, &xlm, &btc] {
        mint(t, &owner, 10_000 * U);
    }
    let old = vault::Client::new(&env, &old_factory.create_vault(&owner));
    let m = MoverClient::new(&env, &env.register(Mover, ()));
    S { env, owner, mock, usdc, xlm, btc, old_factory, new_factory, old, ex, m }
}

/// `place_order` arguments: sell, buy, amount, limit, min fill = amount, impact 3%, expiry a day away, keep.
fn order(s: &S, sell: &Address, buy: &Address, amount: i128, limit: i128) -> PlaceCall {
    PlaceCall {
        func: Symbol::new(&s.env, "place_order"),
        args: (sell.clone(), buy.clone(), amount, limit, amount, 300u32, NOW + DAY, true).into_val(&s.env),
    }
}

fn dca(s: &S, sell: &Address, buy: &Address, part: i128) -> PlaceCall {
    PlaceCall {
        func: symbol_short!("place_dca"),
        args: (sell.clone(), buy.clone(), part, 0u32, DAY, 2_100_000i128, 300u32, 0u32, NOW + 30 * DAY, true).into_val(&s.env),
    }
}

fn wallet(s: &S) -> [i128; 4] {
    [s.mock.balance(&s.owner), s.usdc.balance(&s.owner), s.xlm.balance(&s.owner), s.btc.balance(&s.owner)]
}

/// The measured resources of the last call are within the mainnet per-transaction limits.
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
        "COST {what}: instructions={} mem_bytes={} read_entries={} write_entries={} write_bytes={}",
        r.instructions, r.mem_bytes, r.memory_read_entries + r.disk_read_entries, r.write_entries, r.write_bytes
    );
}

#[test]
fn moves_balances_and_orders_into_a_new_vault_in_one_call() {
    let s = setup();
    // The old vault: 1,000 mock USDC, 500 XLM, 2 BTC, and two open orders.
    s.old.deposit(&s.mock.address, &(1_000 * U));
    s.old.deposit(&s.xlm.address, &(500 * U));
    s.old.deposit(&s.btc.address, &(2 * U));
    let o1 = s.old.place_order(&s.mock.address, &s.xlm.address, &(300 * U), &2_000_000, &(300 * U), &300, &(NOW + DAY), &true);
    let o2 = s.old.place_order(&s.xlm.address, &s.mock.address, &(100 * U), &(5 * U), &(100 * U), &300, &(NOW + DAY), &true);
    let before = wallet(&s);
    assert_eq!(s.new_factory.vault_of(&s.owner), None);

    // Three coins, two cancelled orders, three new orders (one of them scheduled), mock USDC converted.
    let place = vec![
        &s.env,
        order(&s, &s.usdc.address, &s.xlm.address, 300 * U, 2_000_000),
        order(&s, &s.xlm.address, &s.usdc.address, 100 * U, 5 * U),
        dca(&s, &s.usdc.address, &s.xlm.address, 100 * U),
    ];
    let coins = vec![&s.env, s.mock.address.clone(), s.xlm.address.clone(), s.btc.address.clone()];
    let nv = s.m.move_vault(&s.owner, &s.old.address, &s.new_factory.address, &coins, &vec![&s.env, o1, o2], &place, &Some(s.ex.address.clone()));
    print_cost(&s, "3 coins + 2 cancels + 3 orders + new vault + exchange");
    check_limits(&s);

    // A new vault was created for the owner and holds everything; mock USDC became Circle USDC.
    assert_eq!(s.new_factory.vault_of(&s.owner), Some(nv.clone()));
    let v = vault::Client::new(&s.env, &nv);
    assert_eq!(v.balance(&s.usdc.address), 1_000 * U);
    assert_eq!(v.balance(&s.xlm.address), 500 * U);
    assert_eq!(v.balance(&s.btc.address), 2 * U);
    assert_eq!(v.balance(&s.mock.address), 0);
    // The three orders are open in the new vault.
    assert_eq!(v.order_count(), 3);
    assert_eq!(v.get_order(&0).sell, s.usdc.address);
    assert_eq!(v.get_order(&0).amount_in, 300 * U);
    assert_eq!(v.get_order(&1).sell, s.xlm.address);
    assert!(v.get_schedule(&2).is_some());
    assert_eq!(v.reserved(&s.usdc.address), 400 * U);
    assert_eq!(v.reserved(&s.xlm.address), 100 * U);

    // The old vault is empty and its orders are cancelled.
    assert_eq!(s.old.balance(&s.mock.address), 0);
    assert_eq!(s.old.balance(&s.xlm.address), 0);
    assert_eq!(s.old.balance(&s.btc.address), 0);
    assert_eq!(s.old.get_order(&o1).status, vault::OrderStatus::Cancelled);
    assert_eq!(s.old.get_order(&o2).status, vault::OrderStatus::Cancelled);

    // The wallet is exactly as before: what the move brought in went on to the new vault.
    assert_eq!(wallet(&s), before);
    assert_eq!(s.ex.used(&s.owner), 1_000 * U);
    assert_eq!(s.ex.balance(), 9_000 * U);
}

#[test]
fn moves_into_an_existing_vault_without_orders() {
    let s = setup();
    s.old.deposit(&s.xlm.address, &(700 * U));
    // The owner already has a vault in the new factory, with some XLM in it.
    let nv = s.new_factory.create_vault(&s.owner);
    let v = vault::Client::new(&s.env, &nv);
    v.deposit(&s.xlm.address, &(50 * U));
    let count = s.new_factory.vault_count();
    let before = wallet(&s);

    // A token the old vault does not hold is skipped.
    let coins = vec![&s.env, s.xlm.address.clone(), s.btc.address.clone()];
    let got = s.m.move_vault(&s.owner, &s.old.address, &s.new_factory.address, &coins, &Vec::new(&s.env), &Vec::new(&s.env), &None);
    print_cost(&s, "1 coin, existing vault, no orders");
    assert_eq!(got, nv);
    assert_eq!(s.new_factory.vault_count(), count);
    assert_eq!(v.balance(&s.xlm.address), 750 * U);
    assert_eq!(v.order_count(), 0);
    assert_eq!(s.old.balance(&s.xlm.address), 0);
    assert_eq!(wallet(&s), before);
}

#[test]
fn mock_usdc_moves_as_is_without_an_exchange() {
    let s = setup();
    s.old.deposit(&s.mock.address, &(100 * U));
    let coins = vec![&s.env, s.mock.address.clone()];
    let nv = s.m.move_vault(&s.owner, &s.old.address, &s.new_factory.address, &coins, &Vec::new(&s.env), &Vec::new(&s.env), &None);
    let v = vault::Client::new(&s.env, &nv);
    assert_eq!(v.balance(&s.mock.address), 100 * U);
    assert_eq!(v.balance(&s.usdc.address), 0);
    assert_eq!(s.ex.used(&s.owner), 0);
}

#[test]
fn conversion_stops_at_the_cap_and_the_rest_stays_in_the_wallet() {
    let s = setup();
    s.old.deposit(&s.mock.address, &(1_000 * U));
    s.ex.set_cap(&(400 * U));
    let before = wallet(&s);
    let coins = vec![&s.env, s.mock.address.clone()];
    let nv = s.m.move_vault(&s.owner, &s.old.address, &s.new_factory.address, &coins, &Vec::new(&s.env), &Vec::new(&s.env), &Some(s.ex.address.clone()));
    let v = vault::Client::new(&s.env, &nv);
    // 400 were exchanged and deposited; the other 600 mock USDC are in the owner's wallet, not in the new vault.
    assert_eq!(v.balance(&s.usdc.address), 400 * U);
    assert_eq!(v.balance(&s.mock.address), 0);
    assert_eq!(s.mock.balance(&s.owner), before[0] + 600 * U);
    assert_eq!(s.usdc.balance(&s.owner), before[1]);
    assert_eq!(s.ex.left(&s.owner), 0);
}

#[test]
fn only_the_four_order_functions_can_be_called() {
    let s = setup();
    s.old.deposit(&s.xlm.address, &(100 * U));
    let coins = vec![&s.env, s.xlm.address.clone()];
    for f in ["withdraw", "deposit", "cancel_order", "forget", "claim_rewards"] {
        let bad = PlaceCall { func: Symbol::new(&s.env, f), args: (s.xlm.address.clone(), 1i128).into_val(&s.env) };
        let r = s.m.try_move_vault(&s.owner, &s.old.address, &s.new_factory.address, &coins, &Vec::new(&s.env), &vec![&s.env, bad], &None);
        assert_eq!(r, Err(Ok(soroban_sdk::Error::from(Error::FuncNotAllowed))));
    }
    // Nothing moved.
    assert_eq!(s.old.balance(&s.xlm.address), 100 * U);
    assert_eq!(s.new_factory.vault_of(&s.owner), None);
}

#[test]
fn a_failing_order_undoes_the_whole_move() {
    let s = setup();
    s.old.deposit(&s.xlm.address, &(100 * U));
    let coins = vec![&s.env, s.xlm.address.clone()];
    // More than was moved: the new vault refuses the order, and the whole move is undone.
    let place = vec![&s.env, order(&s, &s.xlm.address, &s.usdc.address, 200 * U, 5 * U)];
    assert!(s.m.try_move_vault(&s.owner, &s.old.address, &s.new_factory.address, &coins, &Vec::new(&s.env), &place, &None).is_err());
    assert_eq!(s.old.balance(&s.xlm.address), 100 * U);
    assert_eq!(s.new_factory.vault_of(&s.owner), None);
}

#[test]
fn the_owner_must_sign_and_old_and_new_must_differ() {
    let s = setup();
    s.old.deposit(&s.xlm.address, &(100 * U));
    let coins = vec![&s.env, s.xlm.address.clone()];
    // The old factory as the "new" one: it returns the old vault.
    assert_eq!(
        s.m.try_move_vault(&s.owner, &s.old.address, &s.old_factory.address, &coins, &Vec::new(&s.env), &Vec::new(&s.env), &None),
        Err(Ok(soroban_sdk::Error::from(Error::SameVault)))
    );
    s.env.set_auths(&[]);
    assert!(s.m.try_move_vault(&s.owner, &s.old.address, &s.new_factory.address, &coins, &Vec::new(&s.env), &Vec::new(&s.env), &None).is_err());
    assert_eq!(s.old.balance(&s.xlm.address), 100 * U);
}

/// One signature covers the whole move: the only authorization recorded is the owner's, for `move_vault`.
#[test]
fn one_authorization_covers_the_whole_move() {
    let s = setup();
    s.old.deposit(&s.mock.address, &(100 * U));
    let o = s.old.place_order(&s.mock.address, &s.xlm.address, &(50 * U), &2_000_000, &(50 * U), &300, &(NOW + DAY), &true);
    let coins = vec![&s.env, s.mock.address.clone()];
    let place = vec![&s.env, order(&s, &s.usdc.address, &s.xlm.address, 50 * U, 2_000_000)];
    s.m.move_vault(&s.owner, &s.old.address, &s.new_factory.address, &coins, &vec![&s.env, o], &place, &Some(s.ex.address.clone()));
    let auths = s.env.auths();
    assert_eq!(auths.len(), 1);
    let (who, inv) = &auths[0];
    assert_eq!(who, &s.owner);
    assert_eq!(inv.function, soroban_sdk::testutils::AuthorizedFunction::Contract((
        s.m.address.clone(),
        Symbol::new(&s.env, "move_vault"),
        (
            s.owner.clone(),
            s.old.address.clone(),
            s.new_factory.address.clone(),
            coins.clone(),
            vec![&s.env, o],
            place.clone(),
            Some(s.ex.address.clone()),
        )
            .into_val(&s.env),
    )));
}

/// Resource use as the move grows (mock pool: no Blend calls; see the report for real Blend numbers).
#[test]
fn resource_use_by_size() {
    for (coins_n, orders_n, convert) in [(1usize, 0usize, false), (1, 1, false), (1, 1, true), (2, 2, false), (3, 3, false), (3, 3, true), (6, 6, false)] {
        let s = setup();
        let mut coins = Vec::new(&s.env);
        let mut cancel = Vec::new(&s.env);
        let mut place = Vec::new(&s.env);
        // Mock USDC first, so that `convert` exchanges it.
        let mut toks = std::vec![s.mock.address.clone(), s.xlm.address.clone(), s.btc.address.clone()];
        while toks.len() < coins_n {
            let t = token(&s.env);
            s.old_factory.set_allowed(&t.address, &true);
            s.new_factory.set_allowed(&t.address, &true);
            mint(&t, &s.owner, 10_000 * U);
            toks.push(t.address.clone());
        }
        for t in toks.iter().take(coins_n) {
            s.old.deposit(t, &(1_000 * U));
            coins.push_back(t.clone());
        }
        // Orders sell the moved coins and buy XLM (BTC when XLM is the coin sold).
        let in_new = |t: &Address| if convert && *t == s.mock.address { s.usdc.address.clone() } else { t.clone() };
        for i in 0..orders_n {
            let sell = toks[i % coins_n].clone();
            let buy = if sell == s.xlm.address { s.btc.address.clone() } else { s.xlm.address.clone() };
            cancel.push_back(s.old.place_order(&sell, &buy, &(50 * U), &2_000_000, &(50 * U), &300, &(NOW + DAY), &true));
            place.push_back(order(&s, &in_new(&sell), &buy, 50 * U, 2_000_000));
        }
        if !convert {
            // Mock USDC is moved as-is, so the new factory must allow it for the orders on it.
            s.new_factory.set_allowed(&s.mock.address, &true);
        }
        let ex = if convert { Some(s.ex.address.clone()) } else { None };
        s.m.move_vault(&s.owner, &s.old.address, &s.new_factory.address, &coins, &cancel, &place, &ex);
        if coins_n <= 3 {
            check_limits(&s);
        }
        print_cost(&s, &std::format!("{coins_n} coins + {orders_n} cancels + {orders_n} orders + new vault, exchange={convert}"));
        if coins_n == 3 && convert {
            std::println!("MAINNET LIMITS {:?}", InvocationResourceLimits::mainnet());
        }
    }
}
