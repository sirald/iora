extern crate std;

use super::*;
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

const U: i128 = 10_000_000;

struct S {
    env: Env,
    admin: Address,
    mock: TokenClient<'static>,
    usdc: TokenClient<'static>,
    x: UsdcExchangeClient<'static>,
}

fn setup() -> S {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let issuer = Address::generate(&env);
    let mock_id = env.register_stellar_asset_contract_v2(issuer.clone()).address();
    let usdc_id = env.register_stellar_asset_contract_v2(issuer).address();
    let id = env.register(UsdcExchange, (admin.clone(), mock_id.clone(), usdc_id.clone()));
    StellarAssetClient::new(&env, &usdc_id).mint(&id, &(10_000 * U));
    S { mock: TokenClient::new(&env, &mock_id), usdc: TokenClient::new(&env, &usdc_id), x: UsdcExchangeClient::new(&env, &id), env, admin }
}

fn ce(e: Error) -> soroban_sdk::Error {
    e.into()
}

#[test]
fn exchanges_one_to_one_and_burns_the_mock() {
    let s = setup();
    let user = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &s.mock.address).mint(&user, &(300 * U));
    let supply_before = s.mock.balance(&user);
    s.x.exchange(&user, &(200 * U));
    assert_eq!(s.mock.balance(&user), supply_before - 200 * U);
    assert_eq!(s.usdc.balance(&user), 200 * U);
    assert_eq!(s.x.balance(), 9_800 * U);
    assert_eq!(s.x.used(&user), 200 * U);
    assert_eq!(s.x.left(&user), DEFAULT_CAP - 200 * U);
    // The mock USDC was burned, not kept.
    assert_eq!(s.mock.balance(&s.x.address), 0);
    assert_eq!(s.x.try_exchange(&user, &0), Err(Ok(ce(Error::InvalidAmount))));
}

#[test]
fn the_cap_is_per_wallet_and_admin_controlled() {
    let s = setup();
    let a = Address::generate(&s.env);
    let b = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &s.mock.address).mint(&a, &(6_000 * U));
    StellarAssetClient::new(&s.env, &s.mock.address).mint(&b, &(100 * U));
    assert_eq!(s.x.cap(), 5_000 * U);
    s.x.exchange(&a, &(4_000 * U));
    // 4,000 + 1,001 > 5,000: refused, nothing moves.
    assert_eq!(s.x.try_exchange(&a, &(1_001 * U)), Err(Ok(ce(Error::CapExceeded))));
    assert_eq!(s.mock.balance(&a), 2_000 * U);
    s.x.exchange(&a, &(1_000 * U));
    assert_eq!(s.x.left(&a), 0);
    // Another wallet has its own total.
    s.x.exchange(&b, &(100 * U));

    // The admin lowers the cap: nobody can exceed it.
    s.x.set_cap(&(50 * U));
    assert_eq!(s.x.cap(), 50 * U);
    let c = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &s.mock.address).mint(&c, &(100 * U));
    assert_eq!(s.x.try_exchange(&c, &(51 * U)), Err(Ok(ce(Error::CapExceeded))));
    s.x.exchange(&c, &(50 * U));
    assert_eq!(s.x.try_set_cap(&-1), Err(Ok(ce(Error::InvalidAmount))));

    // Only the admin sets the cap.
    s.env.set_auths(&[]);
    assert!(s.x.try_set_cap(&(1_000 * U)).is_err());
}

#[test]
fn it_cannot_pay_out_more_than_it_holds_and_the_admin_withdraws() {
    let s = setup();
    let user = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &s.mock.address).mint(&user, &(5_000 * U));
    s.x.withdraw(&(9_900 * U));
    assert_eq!(s.usdc.balance(&s.admin), 9_900 * U);
    assert_eq!(s.x.balance(), 100 * U);
    assert_eq!(s.x.left(&user), 100 * U);
    assert_eq!(s.x.try_exchange(&user, &(101 * U)), Err(Ok(ce(Error::NotEnoughUsdc))));
    assert_eq!(s.mock.balance(&user), 5_000 * U);
    // Only the admin withdraws.
    s.env.set_auths(&[]);
    assert!(s.x.try_withdraw(&U).is_err());
}

#[test]
fn exchange_needs_the_wallets_signature() {
    let s = setup();
    let user = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &s.mock.address).mint(&user, &(100 * U));
    s.env.set_auths(&[]);
    assert!(s.x.try_exchange(&user, &(10 * U)).is_err());
    assert_eq!(s.mock.balance(&user), 100 * U);
}
