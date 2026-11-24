//! Iora filler: sells a token across any number of trading venues in one transaction.
//!
//! A vault (version 13, `fill_via`) sends the token an order sells to this contract and calls `swap`. The
//! contract runs the route it was given, one call after another (a Soroswap pool, an Aquarius pool, a Phoenix
//! pool, several of them for parts of the amount, or one after another through an intermediate token), and
//! sends everything it then holds of the bought token back to the vault.
//!
//! It knows no venue: a route is a list of plain contract calls, built off-chain by whoever fills the order.
//! That is safe because this contract is never trusted with anything:
//! - it holds funds only inside one transaction (what the vault just sent), and pays all of it out at the end;
//! - the vault counts what came back and requires at least what the order's limit promises, otherwise the
//!   whole transaction is undone, the route's calls included. A bad or hostile route can only fail.
//! - it has no owner, no settings and no storage.
#![no_std]

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractimpl, contracttype, token, vec, Address, Env, Symbol, Val, Vec,
};

/// A call made in this contract's name one level below an `Auth` (a pool pulling the token it was asked to swap).
#[contracttype]
#[derive(Clone)]
pub struct SubAuth {
    pub contract: Address,
    pub func: Symbol,
    pub args: Vec<Val>,
}

/// A call this contract allows to be made in its name inside a route step: the token transfer a venue pulls from
/// its caller, or a pool's own swap function when a router calls the pool for its caller. `subs` lists what that
/// call may in turn do in this contract's name (for a pool's swap: the token transfer).
#[contracttype]
#[derive(Clone)]
pub struct Auth {
    pub contract: Address,
    pub func: Symbol,
    pub args: Vec<Val>,
    pub subs: Vec<SubAuth>,
}

/// One step of a route: call `func` on `contract` with `args`. `auths` lists the calls that step makes in this
/// contract's name; each is allowed exactly once, for exactly those arguments, during this step.
#[contracttype]
#[derive(Clone)]
pub struct Call {
    pub contract: Address,
    pub func: Symbol,
    pub args: Vec<Val>,
    pub auths: Vec<Auth>,
}

#[contract]
pub struct Filler;

#[contractimpl]
impl Filler {
    /// Runs `route`, then sends this contract's whole balance of `buy` to `to`, and whatever is left of `sell`
    /// as well. Anyone can call it; it only ever moves what it holds at that moment.
    /// `amount` is what the caller sent in; it is informational (the balances decide what is paid out).
    /// Returns the amount of `buy` sent to `to`.
    pub fn swap(env: Env, sell: Address, buy: Address, amount: i128, to: Address, route: Vec<Call>) -> i128 {
        let _ = amount;
        let me = env.current_contract_address();
        for call in route.iter() {
            let mut allowed: Vec<InvokerContractAuthEntry> = Vec::new(&env);
            for a in call.auths.iter() {
                let mut below: Vec<InvokerContractAuthEntry> = Vec::new(&env);
                for b in a.subs.iter() {
                    below.push_back(InvokerContractAuthEntry::Contract(SubContractInvocation {
                        context: ContractContext { contract: b.contract.clone(), fn_name: b.func.clone(), args: b.args.clone() },
                        sub_invocations: vec![&env],
                    }));
                }
                allowed.push_back(InvokerContractAuthEntry::Contract(SubContractInvocation {
                    context: ContractContext { contract: a.contract.clone(), fn_name: a.func.clone(), args: a.args.clone() },
                    sub_invocations: below,
                }));
            }
            // Valid for this step only; anything not listed here cannot be done in this contract's name.
            env.authorize_as_current_contract(allowed);
            let _: Val = env.invoke_contract(&call.contract, &call.func, call.args.clone());
        }
        let b = token::Client::new(&env, &buy);
        let out = b.balance(&me);
        if out > 0 {
            b.transfer(&me, &to, &out);
        }
        let s = token::Client::new(&env, &sell);
        let left = s.balance(&me);
        if left > 0 {
            s.transfer(&me, &to, &left);
        }
        out
    }
}

#[cfg(test)]
mod test;
