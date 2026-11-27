//! Iora mover: moves a whole vault (balances and open orders) from an old single vault to the owner's vault of
//! a newer factory in ONE transaction, so the owner signs once.
//!
//! The mover has no state, no admin and never holds funds: every token goes old vault -> owner's wallet ->
//! new vault inside the same transaction. Each step is an ordinary call the owner authorizes (`cancel_order`,
//! `withdraw`, `create_vault`, `deposit`, `place_*`); when the owner is the transaction's source account one
//! signature covers them all.
//!
//! Supported old vaults: the single multi-asset vault (`iora-vault`, version 8 and later), which has
//! `cancel_order(id)`, `free_balance(token)` and `withdraw(token, WITHDRAW_ALL)`. The earlier two-vault design
//! (`order-vault`) is not supported.
//!
//! Only what the move itself brings into the owner's wallet is moved on: the mover measures the wallet balance
//! before and after each withdrawal (and exchange) and deposits exactly the difference. Tokens the owner held
//! in the wallet before stay where they are.
#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, panic_with_error, symbol_short,
    token, Address, Env, Map, Symbol, Val, Vec,
};

/// `withdraw` amount meaning "the whole free balance" (iora-vault `WITHDRAW_ALL`).
pub const WITHDRAW_ALL: i128 = i128::MAX;

/// The old vault (iora-vault version 8 and later).
#[contractclient(name = "OldVaultClient")]
pub trait OldVault {
    fn cancel_order(env: Env, order_id: u32);
    fn free_balance(env: Env, token: Address) -> i128;
    fn withdraw(env: Env, token: Address, amount: i128);
}

/// The new factory.
#[contractclient(name = "FactoryClient")]
pub trait Factory {
    fn vault_of(env: Env, owner: Address) -> Option<Address>;
    fn create_vault(env: Env, owner: Address) -> Address;
}

/// The new vault.
#[contractclient(name = "NewVaultClient")]
pub trait NewVault {
    fn deposit(env: Env, token: Address, amount: i128);
}

/// The USDC exchange (`iora-usdc-exchange`).
#[contractclient(name = "ExchangeClient")]
pub trait Exchange {
    fn mock(env: Env) -> Address;
    fn usdc(env: Env) -> Address;
    fn left(env: Env, from: Address) -> i128;
    fn exchange(env: Env, from: Address, amount: i128);
}

/// One order to open in the new vault: the vault function and its arguments, exactly as the owner would call it.
/// `func` must be `place_order`, `place_stop_order`, `place_order_then` or `place_dca`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlaceCall {
    pub func: Symbol,
    pub args: Vec<Val>,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// `PlaceCall.func` is not one of the four order functions.
    FuncNotAllowed = 1,
    /// The new vault is the old vault.
    SameVault = 2,
}

/// The move finished. `moved`: token -> amount deposited into the new vault.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Moved {
    #[topic]
    pub owner: Address,
    pub old_vault: Address,
    pub new_vault: Address,
    pub moved: Map<Address, i128>,
    pub orders: u32,
}

#[contract]
pub struct Mover;

#[contractimpl]
impl Mover {
    /// Moves `owner`'s vault in one transaction:
    /// 1. cancels the orders `cancel` in `old_vault` (their reserved amounts become free);
    /// 2. withdraws the whole free balance of every token in `coins` to the owner's wallet;
    /// 3. if `convert` is an exchange and a token is its mock USDC, exchanges what came in 1:1 for Circle USDC
    ///    (up to the owner's remaining allowance there; any rest stays in the wallet and is not deposited);
    /// 4. uses the owner's vault of `factory`, or creates it;
    /// 5. deposits exactly what the move brought into the wallet;
    /// 6. opens the orders `place` in the new vault.
    /// Returns the new vault. Any failure undoes the whole move.
    #[allow(clippy::too_many_arguments)]
    pub fn move_vault(
        env: Env,
        owner: Address,
        old_vault: Address,
        factory: Address,
        coins: Vec<Address>,
        cancel: Vec<u32>,
        place: Vec<PlaceCall>,
        convert: Option<Address>,
    ) -> Address {
        owner.require_auth();
        // Check the order functions before anything moves.
        let allowed = [
            Symbol::new(&env, "place_order"),
            Symbol::new(&env, "place_stop_order"),
            Symbol::new(&env, "place_order_then"),
            symbol_short!("place_dca"),
        ];
        for p in place.iter() {
            if !allowed.contains(&p.func) {
                panic_with_error!(&env, Error::FuncNotAllowed);
            }
        }

        let old = OldVaultClient::new(&env, &old_vault);
        for id in cancel.iter() {
            old.cancel_order(&id);
        }

        // token -> amount to deposit (what the move brought into the wallet).
        let mut moved: Map<Address, i128> = Map::new(&env);
        let ex = convert.map(|a| ExchangeClient::new(&env, &a));
        let mock = ex.as_ref().map(|x| x.mock());
        for coin in coins.iter() {
            if old.free_balance(&coin) <= 0 {
                continue;
            }
            let t = token::Client::new(&env, &coin);
            let before = t.balance(&owner);
            old.withdraw(&coin, &WITHDRAW_ALL);
            let got = t.balance(&owner) - before;
            if got <= 0 {
                continue;
            }
            match (&ex, &mock) {
                (Some(x), Some(m)) if *m == coin => {
                    let left = x.left(&owner);
                    let n = if got < left { got } else { left };
                    if n > 0 {
                        let usdc_id = x.usdc();
                        let usdc = token::Client::new(&env, &usdc_id);
                        let ub = usdc.balance(&owner);
                        x.exchange(&owner, &n);
                        add(&mut moved, usdc_id, usdc.balance(&owner) - ub);
                    }
                }
                _ => add(&mut moved, coin, got),
            }
        }

        let f = FactoryClient::new(&env, &factory);
        let new_vault = match f.vault_of(&owner) {
            Some(v) => v,
            None => f.create_vault(&owner),
        };
        if new_vault == old_vault {
            panic_with_error!(&env, Error::SameVault);
        }
        let nv = NewVaultClient::new(&env, &new_vault);
        for (coin, amount) in moved.iter() {
            if amount > 0 {
                nv.deposit(&coin, &amount);
            }
        }
        for p in place.iter() {
            env.invoke_contract::<Val>(&new_vault, &p.func, p.args);
        }

        Moved { owner, old_vault, new_vault: new_vault.clone(), moved, orders: place.len() }.publish(&env);
        new_vault
    }
}

fn add(m: &mut Map<Address, i128>, token: Address, amount: i128) {
    if amount <= 0 {
        return;
    }
    let v = m.get(token.clone()).unwrap_or(0);
    m.set(token, v + amount);
}

#[cfg(test)]
mod test;
