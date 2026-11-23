//! Factory tests. The real vault wasm is used (run `stellar contract build` first).
extern crate std;

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env};

mod vault {
    soroban_sdk::contractimport!(file = "../../wasm/order_vault.wasm");
}

fn ce(code: u32) -> soroban_sdk::Error {
    soroban_sdk::Error::from_contract_error(code)
}

const VAULT_PAUSED: u32 = 15;
/// Fill fee the factory passes to vaults (in the token bought, maximum per fill).
const FEE: i128 = 500_000;

struct S {
    env: Env,
    factory: VaultFactoryClient<'static>,
    pool: Address,
}

fn setup() -> S {
    let env = Env::default();
    env.mock_all_auths();
    let hash = env.deployer().upload_contract_wasm(vault::WASM);
    let guardian = Address::generate(&env);
    // The vault reads the tokens' decimals when it is set up: real token contracts are needed.
    let usdc = env.register_stellar_asset_contract_v2(guardian.clone()).address();
    let xlm = env.register_stellar_asset_contract_v2(guardian.clone()).address();
    let pool = Address::generate(&env);
    let router = Address::generate(&env);
    let id = env.register(
        VaultFactory,
        (guardian, hash, usdc, xlm, pool.clone(), router, FEE),
    );
    S { factory: VaultFactoryClient::new(&env, &id), env, pool }
}

#[test]
fn create_vault_sets_up_owned_vault() {
    let s = setup();
    let owner = Address::generate(&s.env);
    let v = s.factory.create_vault(&owner);

    assert_eq!(s.factory.vault_of(&owner), Some(v.clone()));
    assert_eq!(s.factory.vault_count(), 1);
    let b = s.factory.bucket_of(&owner);
    assert!(b < 256);
    assert_eq!(s.factory.bucket(&b).get(0).unwrap(), VaultEntry { owner: owner.clone(), vault: v.clone() });

    let cfg = vault::Client::new(&s.env, &v).get_config();
    assert_eq!(cfg.owner, owner);
    assert_eq!(cfg.pool, s.pool);
    assert_eq!(cfg.guard, s.factory.address);
    assert_eq!(cfg.exec_fee, FEE);
    assert_eq!(s.factory.get_config().exec_fee, FEE);
}

#[test]
fn one_vault_per_owner_and_distinct_addresses() {
    let s = setup();
    let a = Address::generate(&s.env);
    let b = Address::generate(&s.env);
    let va = s.factory.create_vault(&a);
    let vb = s.factory.create_vault(&b);
    assert_ne!(va, vb);
    assert_eq!(s.factory.try_create_vault(&a), Err(Ok(ce(Error::AlreadyExists as u32))));
    assert_eq!(s.factory.vault_count(), 2);
}

#[test]
fn create_requires_owner_signature() {
    let s = setup();
    let owner = Address::generate(&s.env);
    s.env.set_auths(&[]);
    assert!(s.factory.try_create_vault(&owner).is_err());
}

#[test]
fn pause_stops_new_vaults_and_new_orders() {
    let s = setup();
    let owner = Address::generate(&s.env);
    let v = s.factory.create_vault(&owner);
    let vc = vault::Client::new(&s.env, &v);

    s.factory.set_paused(&true);
    assert!(s.factory.is_paused());
    let other = Address::generate(&s.env);
    assert_eq!(s.factory.try_create_vault(&other), Err(Ok(ce(Error::Paused as u32))));
    assert_eq!(
        vc.try_place_order(&100, &2_000_000, &100, &300, &1_000),
        Err(Ok(ce(VAULT_PAUSED)))
    );

    s.factory.set_paused(&false);
    // Pause lifted: the order is no longer rejected because of the pause
    // (it fails for another reason, since there is no real pool in this test).
    assert_ne!(
        vc.try_place_order(&100, &2_000_000, &100, &300, &1_000),
        Err(Ok(ce(VAULT_PAUSED)))
    );
    s.factory.create_vault(&other);
}

#[test]
fn only_guardian_controls_pause() {
    let s = setup();
    s.env.set_auths(&[]);
    assert!(s.factory.try_set_paused(&true).is_err());
    assert!(s.factory.try_propose_guardian(&Address::generate(&s.env)).is_err());
    assert!(!s.factory.is_paused());
}

#[test]
fn guardian_change_needs_acceptance() {
    let s = setup();
    let old = s.factory.get_guardian();
    let new = Address::generate(&s.env);
    assert_eq!(s.factory.try_accept_guardian(), Err(Ok(ce(Error::NoPendingGuardian as u32))));
    s.factory.propose_guardian(&new);
    // The old guardian stays in charge until the new one accepts
    assert_eq!(s.factory.get_guardian(), old);
    s.factory.accept_guardian();
    assert_eq!(s.factory.get_guardian(), new);
    assert_eq!(s.factory.try_accept_guardian(), Err(Ok(ce(Error::NoPendingGuardian as u32))));
}

#[test]
fn listing_and_ttl() {
    // The list is kept in buckets: each vault appears exactly once, in the bucket derived from its owner's address.
    let s = setup();
    let mut made = std::vec::Vec::new();
    for _ in 0..5 {
        let o = Address::generate(&s.env);
        let v = s.factory.create_vault(&o);
        made.push((o, v));
    }
    assert_eq!(s.factory.bucket_count(), 256);
    assert_eq!(s.factory.vault_count(), 5);
    let mut seen = std::vec::Vec::new();
    let mut start = 0u32;
    while start < 256 {
        for v in s.factory.vaults_in(&start, &16).iter() {
            seen.push(v);
        }
        start += 16;
    }
    assert_eq!(seen.len(), 5);
    for (o, v) in made.iter() {
        assert!(seen.contains(v));
        let b = s.factory.bucket_of(o);
        assert!(b < 256);
        assert!(s.factory.bucket(&b).iter().any(|e| e.owner == *o && e.vault == *v));
        s.factory.extend_ttl(&b, &0, &10);
    }
    assert_eq!(s.factory.vaults_in(&300, &16).len(), 0);
    assert_eq!(s.factory.bucket(&999).len(), 0);
    s.factory.extend_ttl(&999, &0, &10);
}

#[test]
fn sibling_is_set_once_by_guardian() {
    let s = setup();
    let other = Address::generate(&s.env);
    assert_eq!(s.factory.sibling(), None);
    // It cannot be its own sibling.
    assert_eq!(s.factory.try_set_sibling(&s.factory.address), Err(Ok(ce(Error::InvalidSibling as u32))));
    s.factory.set_sibling(&other);
    assert_eq!(s.factory.sibling(), Some(other.clone()));
    // It cannot be changed later.
    let third = Address::generate(&s.env);
    assert_eq!(s.factory.try_set_sibling(&third), Err(Ok(ce(Error::SiblingAlreadySet as u32))));
    assert_eq!(s.factory.sibling(), Some(other));
}

#[test]
fn only_guardian_sets_sibling() {
    let s = setup();
    s.env.set_auths(&[]);
    assert!(s.factory.try_set_sibling(&Address::generate(&s.env)).is_err());
    assert_eq!(s.factory.sibling(), None);
}
