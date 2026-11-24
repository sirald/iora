#![cfg(test)]

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    IntoVal,
};

/// A stand-in trading venue: takes `amount` of `tin` from `user` and pays twice as much `tout`.
#[contract]
pub struct Venue;

#[contractimpl]
impl Venue {
    pub fn swap(env: Env, user: Address, tin: Address, tout: Address, amount: i128) -> i128 {
        user.require_auth();
        let me = env.current_contract_address();
        token::Client::new(&env, &tin).transfer(&user, &me, &amount);
        token::Client::new(&env, &tout).transfer(&me, &user, &(amount * 2));
        amount * 2
    }
}

/// A stand-in router: asks its caller's permission and then has a pool (a `Venue`) do the swap for that caller.
/// The pool asks the caller's permission again and pulls the token: two levels below the route step.
#[contract]
pub struct Hub;

#[contractimpl]
impl Hub {
    pub fn swap(env: Env, user: Address, pool: Address, tin: Address, tout: Address, amount: i128) -> i128 {
        user.require_auth();
        VenueClient::new(&env, &pool).swap(&user, &tin, &tout, &amount)
    }
}

struct S {
    env: Env,
    a: Address,
    b: Address,
    v1: Address,
    v2: Address,
    fid: Address,
    vault: Address,
}

fn setup() -> S {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let vault = Address::generate(&env);
    let a = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let b = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let v1 = env.register(Venue, ());
    let v2 = env.register(Venue, ());
    let fid = env.register(Filler, ());
    // What a vault would have sent in, and the venues' stock of the bought token.
    StellarAssetClient::new(&env, &a).mint(&fid, &1_000);
    StellarAssetClient::new(&env, &b).mint(&v1, &10_000);
    StellarAssetClient::new(&env, &b).mint(&v2, &10_000);
    // From here on real authorization checks apply: nobody signs anything.
    env.set_auths(&[]);
    S { env, a, b, v1, v2, fid, vault }
}

fn step(s: &S, venue: &Address, amount: i128, with_auth: bool) -> Call {
    let mut auths: Vec<Auth> = Vec::new(&s.env);
    if with_auth {
        auths.push_back(Auth {
            contract: s.a.clone(),
            func: Symbol::new(&s.env, "transfer"),
            args: (s.fid.clone(), venue.clone(), amount).into_val(&s.env),
            subs: Vec::new(&s.env),
        });
    }
    Call {
        contract: venue.clone(),
        func: Symbol::new(&s.env, "swap"),
        args: (s.fid.clone(), s.a.clone(), s.b.clone(), amount).into_val(&s.env),
        auths,
    }
}

#[test]
fn routes_through_two_venues_and_pays_everything_out() {
    let s = setup();
    let f = FillerClient::new(&s.env, &s.fid);
    let route = vec![&s.env, step(&s, &s.v1, 600, true), step(&s, &s.v2, 300, true)];
    let out = f.swap(&s.a, &s.b, &1_000, &s.vault, &route);
    assert_eq!(out, 1_800);
    let a = TokenClient::new(&s.env, &s.a);
    let b = TokenClient::new(&s.env, &s.b);
    // Everything bought went to the vault, and so did the 100 the route did not use.
    assert_eq!(b.balance(&s.vault), 1_800);
    assert_eq!(a.balance(&s.vault), 100);
    assert_eq!(a.balance(&s.fid), 0);
    assert_eq!(b.balance(&s.fid), 0);
}

#[test]
fn a_step_can_only_do_what_was_listed_for_it() {
    let s = setup();
    let f = FillerClient::new(&s.env, &s.fid);
    // The venue pulls the token from the filler; without that transfer listed, the step fails.
    assert!(f.try_swap(&s.a, &s.b, &1_000, &s.vault, &vec![&s.env, step(&s, &s.v1, 600, false)]).is_err());
    // An authorization for one step does not carry over to the next.
    let mut first = step(&s, &s.v1, 600, true);
    first.auths.push_back(Auth {
        contract: s.a.clone(),
        func: Symbol::new(&s.env, "transfer"),
        args: (s.fid.clone(), s.v2.clone(), 300i128).into_val(&s.env),
        subs: Vec::new(&s.env),
    });
    assert!(f.try_swap(&s.a, &s.b, &1_000, &s.vault, &vec![&s.env, first, step(&s, &s.v2, 300, false)]).is_err());
    // Nothing moved.
    assert_eq!(TokenClient::new(&s.env, &s.a).balance(&s.fid), 1_000);
    assert_eq!(TokenClient::new(&s.env, &s.b).balance(&s.vault), 0);
}

#[test]
fn an_empty_route_just_returns_what_it_holds() {
    let s = setup();
    let f = FillerClient::new(&s.env, &s.fid);
    assert_eq!(f.swap(&s.a, &s.b, &1_000, &s.vault, &Vec::new(&s.env)), 0);
    assert_eq!(TokenClient::new(&s.env, &s.a).balance(&s.vault), 1_000);
}

#[test]
fn a_router_that_calls_a_pool_for_its_caller() {
    let s = setup();
    let hub = s.env.register(Hub, ());
    let f = FillerClient::new(&s.env, &s.fid);
    let pool_swap = |with_transfer: bool| {
        let mut subs: Vec<SubAuth> = Vec::new(&s.env);
        if with_transfer {
            subs.push_back(SubAuth {
                contract: s.a.clone(),
                func: Symbol::new(&s.env, "transfer"),
                args: (s.fid.clone(), s.v1.clone(), 1_000i128).into_val(&s.env),
            });
        }
        Call {
            contract: hub.clone(),
            func: Symbol::new(&s.env, "swap"),
            args: (s.fid.clone(), s.v1.clone(), s.a.clone(), s.b.clone(), 1_000i128).into_val(&s.env),
            auths: vec![
                &s.env,
                Auth {
                    contract: s.v1.clone(),
                    func: Symbol::new(&s.env, "swap"),
                    args: (s.fid.clone(), s.a.clone(), s.b.clone(), 1_000i128).into_val(&s.env),
                    subs,
                },
            ],
        }
    };
    // The pool's swap is allowed, but not the transfer inside it: refused.
    assert!(f.try_swap(&s.a, &s.b, &1_000, &s.vault, &vec![&s.env, pool_swap(false)]).is_err());
    // With the transfer listed under the pool's swap it goes through.
    assert_eq!(f.swap(&s.a, &s.b, &1_000, &s.vault, &vec![&s.env, pool_swap(true)]), 2_000);
    assert_eq!(TokenClient::new(&s.env, &s.b).balance(&s.vault), 2_000);
}
