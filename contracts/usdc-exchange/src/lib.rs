//! Iora USDC exchange (testnet only): swaps Blend's old test USDC ("mock USDC") 1:1 for Circle's testnet USDC.
//!
//! - `exchange(from, amount)`: burns `amount` of mock USDC from `from` and sends the same amount of Circle USDC
//!   from this contract's own balance to `from`. `from` must authorize it (it signs the burn).
//! - Each wallet can exchange at most `cap` in total (default 5,000 USDC); the admin can change the cap.
//! - The admin funds the contract with Circle USDC by an ordinary transfer and can take it back with `withdraw`.
//!
//! The contract never holds mock USDC (it is burned) and holds no funds of any user.
#![no_std]

use soroban_sdk::{contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token, Address, Env};

/// Default per-wallet total: 5,000 USDC (7 decimals).
pub const DEFAULT_CAP: i128 = 5_000 * 10_000_000;

const DAY_IN_LEDGERS: u32 = 17_280;
const BUMP_THRESHOLD: u32 = 7 * DAY_IN_LEDGERS;
const BUMP_TO: u32 = 30 * DAY_IN_LEDGERS;
/// A wallet's running total is kept for about a year (it only has to outlive the migration period).
const USED_BUMP_TO: u32 = 365 * DAY_IN_LEDGERS;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    InvalidAmount = 1,
    /// The wallet's total would exceed the cap.
    CapExceeded = 2,
    /// The contract does not hold enough Circle USDC.
    NotEnoughUsdc = 3,
    /// Mock USDC and Circle USDC must be different tokens.
    SameToken = 4,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Mock,
    Usdc,
    Cap,
    /// Total exchanged so far by one wallet.
    Used(Address),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Exchanged {
    #[topic]
    pub from: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapChanged {
    pub cap: i128,
}

#[contract]
pub struct UsdcExchange;

#[contractimpl]
impl UsdcExchange {
    pub fn __constructor(env: Env, admin: Address, mock: Address, usdc: Address) {
        if mock == usdc {
            panic_with_error!(&env, Error::SameToken);
        }
        let s = env.storage().instance();
        s.set(&DataKey::Admin, &admin);
        s.set(&DataKey::Mock, &mock);
        s.set(&DataKey::Usdc, &usdc);
        s.set(&DataKey::Cap, &DEFAULT_CAP);
        bump(&env);
    }

    /// Burns `amount` of mock USDC from `from` and sends `amount` of Circle USDC to `from`.
    /// `from` needs a Circle USDC trustline (a classic account) to receive it.
    pub fn exchange(env: Env, from: Address, amount: i128) {
        from.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let key = DataKey::Used(from.clone());
        let used: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if used + amount > cap_of(&env) {
            panic_with_error!(&env, Error::CapExceeded);
        }
        let me = env.current_contract_address();
        let usdc = token::Client::new(&env, &get(&env, DataKey::Usdc));
        if usdc.balance(&me) < amount {
            panic_with_error!(&env, Error::NotEnoughUsdc);
        }
        token::Client::new(&env, &get(&env, DataKey::Mock)).burn(&from, &amount);
        usdc.transfer(&me, &from, &amount);
        env.storage().persistent().set(&key, &(used + amount));
        env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, USED_BUMP_TO);
        bump(&env);
        Exchanged { from, amount }.publish(&env);
    }

    /// Admin: the per-wallet total (0 stops all exchanges).
    pub fn set_cap(env: Env, cap: i128) {
        admin(&env).require_auth();
        if cap < 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        env.storage().instance().set(&DataKey::Cap, &cap);
        bump(&env);
        CapChanged { cap }.publish(&env);
    }

    /// Admin: takes `amount` of the contract's Circle USDC back to the admin's wallet.
    pub fn withdraw(env: Env, amount: i128) {
        let admin = admin(&env);
        admin.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let me = env.current_contract_address();
        token::Client::new(&env, &get(&env, DataKey::Usdc)).transfer(&me, &admin, &amount);
        bump(&env);
    }

    // ---------------- read functions ----------------

    /// Circle USDC the contract holds (what can still be exchanged in total).
    pub fn balance(env: Env) -> i128 {
        token::Client::new(&env, &get(&env, DataKey::Usdc)).balance(&env.current_contract_address())
    }

    /// Total exchanged so far by `from`.
    pub fn used(env: Env, from: Address) -> i128 {
        env.storage().persistent().get(&DataKey::Used(from)).unwrap_or(0)
    }

    /// What `from` can still exchange: the smaller of its remaining cap and the contract's balance.
    pub fn left(env: Env, from: Address) -> i128 {
        let used: i128 = env.storage().persistent().get(&DataKey::Used(from)).unwrap_or(0);
        let room = cap_of(&env) - used;
        let bal = token::Client::new(&env, &get(&env, DataKey::Usdc)).balance(&env.current_contract_address());
        let n = if room < bal { room } else { bal };
        if n < 0 {
            0
        } else {
            n
        }
    }

    pub fn cap(env: Env) -> i128 {
        cap_of(&env)
    }

    pub fn mock(env: Env) -> Address {
        get(&env, DataKey::Mock)
    }

    pub fn usdc(env: Env) -> Address {
        get(&env, DataKey::Usdc)
    }

    pub fn admin(env: Env) -> Address {
        admin(&env)
    }
}

fn get(env: &Env, key: DataKey) -> Address {
    env.storage().instance().get(&key).unwrap()
}

fn admin(env: &Env) -> Address {
    get(env, DataKey::Admin)
}

fn cap_of(env: &Env) -> i128 {
    env.storage().instance().get(&DataKey::Cap).unwrap_or(DEFAULT_CAP)
}

fn bump(env: &Env) {
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

#[cfg(test)]
mod test;
