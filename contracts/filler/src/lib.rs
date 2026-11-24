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
    contract, contracterror, contractimpl, contracttype, panic_with_error, token, vec, Address, Env, Symbol, TryFromVal, Val,
    Vec,
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

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// `swap_from`: the route returned less than the caller's minimum.
    TooLittle = 1,
    /// `swap_from`: the amount must be positive.
    InvalidAmount = 2,
}

#[contract]
pub struct Filler;

#[contractimpl]
impl Filler {
    /// 2: routes may contain the `sweep` instruction. 3: `swap_from` (a swap straight from a wallet).
    pub fn version(_env: Env) -> u32 {
        3
    }

    /// A swap for a wallet (the Market tab): takes `amount` of `sell` from `user`, runs `route`, and sends
    /// everything it then holds of `buy` (and whatever is left of `sell`) back to `user`. Fails, undoing all of
    /// it, if less than `min_out` of `buy` came out. Only `user` can start it: it is `user`'s signature that
    /// lets `amount` be taken, and nothing more than `amount`.
    /// Returns the amount of `buy` sent to `user`.
    pub fn swap_from(env: Env, user: Address, sell: Address, buy: Address, amount: i128, min_out: i128, route: Vec<Call>) -> i128 {
        user.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let me = env.current_contract_address();
        token::Client::new(&env, &sell).transfer(&user, &me, &amount);
        let out = Self::swap(env.clone(), sell, buy, amount, user, route);
        if out < min_out {
            panic_with_error!(&env, Error::TooLittle);
        }
        out
    }

    /// Runs `route`, then sends this contract's whole balance of `buy` to `to`, and whatever is left of `sell`
    /// as well. Anyone can call it; it only ever moves what it holds at that moment.
    /// `amount` is what the caller sent in; it is informational (the balances decide what is paid out).
    /// Returns the amount of `buy` sent to `to`.
    pub fn swap(env: Env, sell: Address, buy: Address, amount: i128, to: Address, route: Vec<Call>) -> i128 {
        let _ = amount;
        let me = env.current_contract_address();
        for call in route.iter() {
            // A step addressed to this contract itself is not a call but an instruction: `sweep(token)` sends
            // this contract's whole balance of `token` to `to`. A route through an intermediate token ends
            // with it, so that a little more of that token than planned (the first swap paid better than
            // quoted) goes to the vault instead of staying here.
            if call.contract == me {
                if call.func == Symbol::new(&env, "sweep") {
                    if let Some(v) = call.args.get(0) {
                        if let Ok(t) = Address::try_from_val(&env, &v) {
                            let c = token::Client::new(&env, &t);
                            let b = c.balance(&me);
                            if b > 0 {
                                c.transfer(&me, &to, &b);
                            }
                        }
                    }
                }
                continue;
            }
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
