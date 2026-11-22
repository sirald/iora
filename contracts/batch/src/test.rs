//! Batch filler tests, against a stand-in vault with the same `execute` signature.
extern crate std;

use super::*;
use soroban_sdk::{contract, contracterror, contractimpl, panic_with_error, testutils::Address as _, vec, Address, Env};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum MockError {
    OrderNotOpen = 4,
}

#[contract]
pub struct MockVault;

#[contractimpl]
impl MockVault {
    /// Order 99 is "closed" and fails. Others record the call and return twice the amount (three times through a route).
    pub fn execute(env: Env, _executor: Address, order_id: u32, fill_amount: i128, via: Option<Address>) -> i128 {
        let n: u32 = env.storage().instance().get(&order_id).unwrap_or(0);
        env.storage().instance().set(&order_id, &(n + 1));
        if order_id == 99 {
            panic_with_error!(&env, MockError::OrderNotOpen);
        }
        if via.is_some() {
            fill_amount * 3
        } else {
            fill_amount * 2
        }
    }

    pub fn calls(env: Env, order_id: u32) -> u32 {
        env.storage().instance().get(&order_id).unwrap_or(0)
    }
}

#[test]
fn fills_every_order_and_a_failure_does_not_stop_the_rest() {
    let env = Env::default();
    let batch = BatchClient::new(&env, &env.register(Batch, ()));
    let v1 = env.register(MockVault, ());
    let v2 = env.register(MockVault, ());
    let executor = Address::generate(&env);
    let via = Address::generate(&env);

    let out = batch.fill_many(
        &executor,
        &vec![
            &env,
            Fill { vault: v1.clone(), order_id: 0, amount: 10, via: None },
            Fill { vault: v2.clone(), order_id: 99, amount: 10, via: None },
            Fill { vault: v2.clone(), order_id: 1, amount: 7, via: Some(via) },
            Fill { vault: v1.clone(), order_id: 0, amount: 5, via: None },
        ],
    );
    assert_eq!(out, vec![&env, 20i128, 0, 21, 10]);
    let c1 = MockVaultClient::new(&env, &v1);
    let c2 = MockVaultClient::new(&env, &v2);
    assert_eq!(c1.calls(&0), 2);
    assert_eq!(c2.calls(&1), 1);
    // The failed fill was undone: what it wrote before failing is gone.
    assert_eq!(c2.calls(&99), 0);
}

#[test]
fn the_list_is_capped() {
    let env = Env::default();
    let batch = BatchClient::new(&env, &env.register(Batch, ()));
    let v = env.register(MockVault, ());
    let executor = Address::generate(&env);
    let mut fills = vec![&env];
    for i in 0..(MAX_FILLS + 3) {
        fills.push_back(Fill { vault: v.clone(), order_id: i, amount: 1, via: None });
    }
    assert_eq!(batch.fill_many(&executor, &fills).len(), MAX_FILLS);
    assert_eq!(MockVaultClient::new(&env, &v).calls(&MAX_FILLS), 0);
    // An empty list is fine.
    assert_eq!(batch.fill_many(&executor, &vec![&env]).len(), 0);
}
