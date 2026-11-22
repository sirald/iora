//! Factory tests. They use the real vault wasm (run `stellar contract build` first).
extern crate std;

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env, Map};

mod vault {
    soroban_sdk::contractimport!(file = "../../wasm/iora_vault.wasm");
}

fn ce(code: u32) -> soroban_sdk::Error {
    soroban_sdk::Error::from_contract_error(code)
}

const VAULT_PAUSED: u32 = 15;
const VAULT_TOKEN_NOT_ALLOWED: u32 = 27;
/// Fill fee cap the factory passes to its vaults (when XLM is bought, per fill).
const FEE: i128 = 200_000;

struct S {
    env: Env,
    factory: VaultFactoryClient<'static>,
    pool: Address,
    router: Address,
    usdc: Address,
    xlm: Address,
}

fn setup() -> S {
    let env = Env::default();
    env.mock_all_auths();
    let hash = env.deployer().upload_contract_wasm(vault::WASM);
    let guardian = Address::generate(&env);
    let usdc = Address::generate(&env);
    let xlm = Address::generate(&env);
    let pool = Address::generate(&env);
    let router = Address::generate(&env);
    let mut fees: Map<Address, i128> = Map::new(&env);
    fees.set(xlm.clone(), FEE);
    let tokens = soroban_sdk::vec![&env, usdc.clone(), xlm.clone()];
    let id = env.register(VaultFactory, (guardian, hash, pool.clone(), router.clone(), fees, tokens));
    S { factory: VaultFactoryClient::new(&env, &id), env, pool, router, usdc, xlm }
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
    assert_eq!(
        s.factory.bucket(&b, &None, &10).get(0).unwrap(),
        VaultEntry { owner: owner.clone(), vault: v.clone(), prev: None }
    );

    // The vault belongs to this owner, uses the factory's pool and router, and asks the factory about pausing.
    let cfg = vault::Client::new(&s.env, &v).get_config();
    assert_eq!(cfg.owner, owner);
    assert_eq!(cfg.pool, s.pool);
    assert_eq!(cfg.router, s.router);
    assert_eq!(cfg.guard, s.factory.address);
    assert_eq!(cfg.fees.get(s.xlm.clone()), Some(FEE));
    assert_eq!(cfg.fees.get(s.usdc.clone()), None);
    assert_eq!(s.factory.get_config().fees.get(s.xlm.clone()), Some(FEE));
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
        vc.try_place_order(&s.usdc, &s.xlm, &100, &2_000_000, &100, &300, &1_000, &true),
        Err(Ok(ce(VAULT_PAUSED)))
    );

    s.factory.set_paused(&false);
    // Pause lifted: the order is no longer rejected because of the pause
    // (it fails for another reason, because this test has no real tokens or pool).
    assert_ne!(
        vc.try_place_order(&s.usdc, &s.xlm, &100, &2_000_000, &100, &300, &1_000, &true),
        Err(Ok(ce(VAULT_PAUSED)))
    );
    s.factory.create_vault(&other);
}

#[test]
fn allowed_tokens_are_guardian_controlled() {
    let s = setup();
    assert!(s.factory.is_allowed(&s.usdc));
    assert!(s.factory.is_allowed(&s.xlm));
    let btc = Address::generate(&s.env);
    assert!(!s.factory.is_allowed(&btc));

    // An order with a token that is not on the list is rejected (the vault asks the factory).
    let owner = Address::generate(&s.env);
    let vc = vault::Client::new(&s.env, &s.factory.create_vault(&owner));
    assert_eq!(
        vc.try_place_order(&s.usdc, &btc, &100, &2_000_000, &100, &300, &1_000, &true),
        Err(Ok(ce(VAULT_TOKEN_NOT_ALLOWED)))
    );

    s.factory.set_allowed(&btc, &true);
    s.factory.set_allowed(&btc, &true); // adding it a second time does not grow the list
    assert!(s.factory.is_allowed(&btc));
    assert_eq!(s.factory.allowed_tokens().len(), 3);
    assert_ne!(
        vc.try_place_order(&s.usdc, &btc, &100, &2_000_000, &100, &300, &1_000, &true),
        Err(Ok(ce(VAULT_TOKEN_NOT_ALLOWED)))
    );

    s.factory.set_allowed(&btc, &false);
    assert!(!s.factory.is_allowed(&btc));
    assert_eq!(s.factory.allowed_tokens().len(), 2);

    // Only the guardian can change the list.
    s.env.set_auths(&[]);
    assert!(s.factory.try_set_allowed(&btc, &true).is_err());
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

/// Reads every vault through `heads` and `bucket`, `page` entries per call.
fn all_vaults(s: &S, page: u32) -> std::vec::Vec<(Address, Address)> {
    let mut seen = std::vec::Vec::new();
    let mut start = 0u32;
    while start < 256 {
        for h in s.factory.heads(&start, &64).iter() {
            let mut from: Option<Address> = None;
            let mut in_bucket = 0u32;
            loop {
                let list = s.factory.bucket(&h.index, &from, &page);
                if list.is_empty() {
                    break;
                }
                let mut next = None;
                for e in list.iter() {
                    next = e.prev.clone();
                    seen.push((e.owner, e.vault));
                    in_bucket += 1;
                }
                if next.is_none() {
                    break;
                }
                from = next;
            }
            assert_eq!(in_bucket, h.len);
        }
        start += 64;
    }
    seen
}

#[test]
fn listing_and_ttl() {
    // The list is kept as one chain per bucket: every vault appears exactly once, in the bucket derived from its owner's address.
    let s = setup();
    let mut made = std::vec::Vec::new();
    for _ in 0..5 {
        let o = Address::generate(&s.env);
        let v = s.factory.create_vault(&o);
        made.push((o, v));
    }
    assert_eq!(s.factory.bucket_count(), 256);
    assert_eq!(s.factory.vault_count(), 5);
    let seen = all_vaults(&s, 40);
    assert_eq!(seen.len(), 5);
    for (o, v) in made.iter() {
        assert!(seen.contains(&(o.clone(), v.clone())));
        let b = s.factory.bucket_of(o);
        assert!(s.factory.bucket(&b, &None, &40).iter().any(|e| e.owner == *o && e.vault == *v));
        s.factory.extend_ttl(&b, &None, &10);
    }
    assert_eq!(s.factory.heads(&300, &64).len(), 0);
    assert_eq!(s.factory.bucket(&7, &None, &0).len(), 0);
}

#[test]
fn many_vaults_in_one_bucket_form_a_chain() {
    // Version 8 kept a bucket as one list capped at 400, so a bucket could be filled on purpose. Here a bucket is
    // a chain with no cap: owners that land in the same bucket are each created, listed once (newest first) and
    // reachable page by page.
    let s = setup();
    let first = Address::generate(&s.env);
    let b = s.factory.bucket_of(&first);
    let mut owners = std::vec![first];
    while owners.len() < 12 {
        let o = Address::generate(&s.env);
        if s.factory.bucket_of(&o) == b {
            owners.push(o);
        }
    }
    let mut vaults = std::vec::Vec::new();
    for o in owners.iter() {
        vaults.push(s.factory.create_vault(o));
    }
    assert_eq!(s.factory.vault_count(), 12);
    let heads = s.factory.heads(&b, &1);
    assert_eq!(heads.len(), 1);
    let head = heads.get(0).unwrap();
    assert_eq!(head.index, b);
    assert_eq!(head.len, 12);
    assert_eq!(head.last, owners[11]);

    // Pages of 5: 5 + 5 + 2, newest first, each page continuing from the previous page's last `prev`.
    let p1 = s.factory.bucket(&b, &None, &5);
    assert_eq!(p1.len(), 5);
    assert_eq!(p1.get(0).unwrap().owner, owners[11]);
    assert_eq!(p1.get(0).unwrap().vault, vaults[11]);
    let p2 = s.factory.bucket(&b, &p1.get(4).unwrap().prev, &5);
    assert_eq!(p2.len(), 5);
    assert_eq!(p2.get(0).unwrap().owner, owners[6]);
    let p3 = s.factory.bucket(&b, &p2.get(4).unwrap().prev, &5);
    assert_eq!(p3.len(), 2);
    assert_eq!(p3.get(1).unwrap().owner, owners[0]);
    assert_eq!(p3.get(1).unwrap().prev, None);

    let seen = all_vaults(&s, 5);
    assert_eq!(seen.len(), 12);
    for (o, v) in owners.iter().zip(vaults.iter()) {
        assert!(seen.contains(&(o.clone(), v.clone())));
        assert_eq!(s.factory.vault_of(o), Some(v.clone()));
    }
    // A page asks for at most 40 entries however large the limit.
    assert_eq!(s.factory.bucket(&b, &None, &1_000).len(), 12);
    s.factory.extend_ttl(&b, &None, &40);
    s.factory.extend_ttl(&b, &p1.get(4).unwrap().prev, &40);
}

#[test]
#[should_panic]
fn negative_fee_is_rejected() {
    let env = Env::default();
    let a = Address::generate(&env);
    let hash = env.deployer().upload_contract_wasm(vault::WASM);
    let mut fees: Map<Address, i128> = Map::new(&env);
    fees.set(a.clone(), -1);
    let tokens: soroban_sdk::Vec<Address> = soroban_sdk::Vec::new(&env);
    env.register(VaultFactory, (a.clone(), hash, a.clone(), a, fees, tokens));
}
