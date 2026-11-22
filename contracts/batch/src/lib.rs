#![no_std]
//! Iora batch filler (EXPERIMENTAL, not used by the keeper or the site yet).
//!
//! A Soroban transaction carries a single contract call, so a keeper account can fill one order per ledger. This
//! contract takes a list of fills and calls `execute` on each vault in turn, so one transaction fills several
//! orders. It holds no funds, keeps no state and has no privileges: `execute` is open to anyone, and everything a
//! vault guarantees (limit, impact, recipient) is checked by the vault exactly as in a direct call.
//!
//! A fill that fails (the order was just filled or cancelled, the price moved) is undone on its own and the
//! others still go through. How many fills fit in one transaction is set by the network's per-transaction
//! resource limits, not by this contract; `MAX_FILLS` is only an upper bound on the list.

use soroban_sdk::{contract, contractimpl, contracttype, vec, Address, Env, IntoVal, Symbol, Val, Vec};

/// Upper bound on the list (the real limit is the transaction's resource budget).
pub const MAX_FILLS: u32 = 40;

/// One fill: the same arguments as the vault's `execute`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Fill {
    pub vault: Address,
    pub order_id: u32,
    pub amount: i128,
    pub via: Option<Address>,
}

#[contract]
pub struct Batch;

#[contractimpl]
impl Batch {
    /// Fills the listed orders one after another (version 8 and 9 vaults). `executor` receives the fill fees.
    /// Returns what each fill bought, in order; 0 for a fill that failed. Entries beyond `MAX_FILLS` are ignored.
    pub fn fill_many(env: Env, executor: Address, fills: Vec<Fill>) -> Vec<i128> {
        let execute = Symbol::new(&env, "execute");
        let mut out = Vec::new(&env);
        let mut n = 0u32;
        for f in fills.iter() {
            if n >= MAX_FILLS {
                break;
            }
            let args: Vec<Val> = vec![
                &env,
                executor.clone().into_val(&env),
                f.order_id.into_val(&env),
                f.amount.into_val(&env),
                f.via.into_val(&env),
            ];
            let got = match env.try_invoke_contract::<i128, soroban_sdk::Error>(&f.vault, &execute, args) {
                Ok(Ok(v)) => v,
                _ => 0,
            };
            out.push_back(got);
            n += 1;
        }
        out
    }
}

#[cfg(test)]
mod test;
