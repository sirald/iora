//! Iora mover: moves a whole vault (balances and open orders) from an old vault to the owner's vault of a newer
//! factory in ONE transaction, so the owner signs once.
//!
//! The mover has no state, no admin and never holds funds: every token goes old vault -> owner's wallet ->
//! new vault inside the same transaction. Each step is an ordinary call the owner authorizes (`cancel_order`,
//! `withdraw`, `create_vault`, `deposit`, `place_*`); when the owner is the transaction's source account one
//! signature covers them all.
//!
//! Supported old vaults:
//! - `move_vault`: the single multi-asset vault (`iora-vault`, version 8 and later), which has `cancel_order(id)` and
//!   `withdraw(token, amount)`.
//! - `move_order_vault` (added in mover 2): the earlier two-vault design (`order-vault`, every generation on testnet).
//!   Each such vault holds one coin (its config field `usdc`: the deposited token, XLM in a sell vault) and has
//!   `cancel_order(id)` and `withdraw(amount)`.
//!
//! Amounts are fixed in the call (`coins`: token -> amount, or `amount`), not read at run time. The owner's signature
//! covers the whole call tree including every argument (`deposit(token, amount)`, the token transfer under it, the
//! exchange's burn), so an amount that changed between simulation and execution (Blend interest accrues every
//! ledger) would make the signature invalid. The caller takes the amounts from the simulation; interest that
//! accrues after it stays behind as dust.
//!
//! Only what the move itself brings into the owner's wallet is moved on: the mover measures the wallet balance
//! before and after each withdrawal (and exchange) and deposits at most that difference. Tokens the owner held in
//! the wallet before stay where they are.
#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, panic_with_error, symbol_short,
    token, vec, Address, Env, Map, Symbol, TryFromVal, Val, Vec,
};

/// The old vault (iora-vault version 8 and later).
#[contractclient(name = "OldVaultClient")]
pub trait OldVault {
    fn cancel_order(env: Env, order_id: u32);
    fn withdraw(env: Env, token: Address, amount: i128);
}

/// The old two-vault design (order-vault): one coin per vault. `get_config` differs between its generations
/// (version 5 added `exec_fee`), so it is read as a plain map; only `owner` and `usdc` are used.
#[contractclient(name = "OrderVaultClient")]
pub trait OrderVault {
    fn cancel_order(env: Env, order_id: u32);
    fn withdraw(env: Env, amount: i128);
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
    /// A coin amount is not positive.
    InvalidAmount = 3,
    /// `move_order_vault`: the old vault does not belong to `owner` (or its config cannot be read).
    NotOwner = 4,
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
    /// 2. withdraws `amount` of every token in `coins` (token -> amount) to the owner's wallet;
    /// 3. if `convert` is an exchange and a token is its mock USDC, exchanges what came in 1:1 for Circle USDC
    ///    (up to the owner's remaining allowance there; any rest stays in the wallet and is not deposited);
    /// 4. uses the owner's vault of `factory`, or creates it;
    /// 5. deposits `amount` (or what actually arrived, if less) of every token into the new vault;
    /// 6. opens the orders `place` in the new vault.
    /// Returns the new vault. Any failure undoes the whole move.
    #[allow(clippy::too_many_arguments)]
    pub fn move_vault(
        env: Env,
        owner: Address,
        old_vault: Address,
        factory: Address,
        coins: Map<Address, i128>,
        cancel: Vec<u32>,
        place: Vec<PlaceCall>,
        convert: Option<Address>,
    ) -> Address {
        owner.require_auth();
        check_place(&env, &place);

        let old = OldVaultClient::new(&env, &old_vault);
        for id in cancel.iter() {
            old.cancel_order(&id);
        }

        // token -> amount to deposit (what the move brought into the wallet).
        let mut moved: Map<Address, i128> = Map::new(&env);
        let ex = convert.map(|a| ExchangeClient::new(&env, &a));
        let mock = ex.as_ref().map(|x| x.mock());
        for (coin, amount) in coins.iter() {
            if amount <= 0 {
                panic_with_error!(&env, Error::InvalidAmount);
            }
            bring(&env, &owner, &coin, amount, &ex, &mock, &mut moved, || old.withdraw(&coin, &amount));
        }

        land(&env, owner, old_vault, &factory, moved, place)
    }

    /// Moves an old two-vault design vault (`order-vault`, one coin) in one transaction:
    /// 1. checks that `old_vault` belongs to `owner` and reads its coin (config field `usdc`: USDC in a buy vault,
    ///    XLM in a sell vault);
    /// 2. cancels the orders `cancel` in `old_vault`;
    /// 3. withdraws `amount` of the coin to the owner's wallet;
    /// 4. if `convert` is an exchange and the coin is its mock USDC, exchanges what came in 1:1 for Circle USDC
    ///    (up to the owner's remaining allowance; any rest stays in the wallet and is not deposited);
    /// 5. uses the owner's vault of `factory`, or creates it;
    /// 6. deposits `amount` (or what actually arrived, if less) into the new vault;
    /// 7. opens the orders `place` in the new vault (the new vault's `place_*` with `sell`/`buy` arguments).
    /// Returns the new vault. Any failure undoes the whole move.
    #[allow(clippy::too_many_arguments)]
    pub fn move_order_vault(
        env: Env,
        owner: Address,
        old_vault: Address,
        factory: Address,
        amount: i128,
        cancel: Vec<u32>,
        place: Vec<PlaceCall>,
        convert: Option<Address>,
    ) -> Address {
        owner.require_auth();
        check_place(&env, &place);
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let coin = order_vault_coin(&env, &old_vault, &owner);

        let old = OrderVaultClient::new(&env, &old_vault);
        for id in cancel.iter() {
            old.cancel_order(&id);
        }

        let mut moved: Map<Address, i128> = Map::new(&env);
        let ex = convert.map(|a| ExchangeClient::new(&env, &a));
        let mock = ex.as_ref().map(|x| x.mock());
        bring(&env, &owner, &coin, amount, &ex, &mock, &mut moved, || old.withdraw(&amount));

        land(&env, owner, old_vault, &factory, moved, place)
    }

    /// Mover version: 2 = `move_order_vault` added (`move_vault` unchanged).
    pub fn version(_env: Env) -> u32 {
        2
    }
}

/// The order functions are checked before anything moves.
fn check_place(env: &Env, place: &Vec<PlaceCall>) {
    let allowed = [
        Symbol::new(env, "place_order"),
        Symbol::new(env, "place_stop_order"),
        Symbol::new(env, "place_order_then"),
        symbol_short!("place_dca"),
    ];
    for p in place.iter() {
        if !allowed.contains(&p.func) {
            panic_with_error!(env, Error::FuncNotAllowed);
        }
    }
}

/// The coin of an old order-vault, after checking that `owner` owns it. Its config is read as a map because the
/// struct changed between generations.
fn order_vault_coin(env: &Env, vault: &Address, owner: &Address) -> Address {
    let cfg: Map<Symbol, Val> = env.invoke_contract(vault, &Symbol::new(env, "get_config"), vec![env]);
    let get = |name: &str| -> Option<Address> {
        cfg.get(Symbol::new(env, name)).and_then(|v| Address::try_from_val(env, &v).ok())
    };
    match (get("owner"), get("usdc")) {
        (Some(o), Some(coin)) if o == *owner => coin,
        _ => panic_with_error!(env, Error::NotOwner),
    }
}

/// Withdraws one coin to the owner's wallet (`withdraw`), measures what came in (at most `amount`), exchanges it if it
/// is the exchange's mock USDC, and records what is to be deposited in `moved`.
#[allow(clippy::too_many_arguments)]
fn bring(
    env: &Env,
    owner: &Address,
    coin: &Address,
    amount: i128,
    ex: &Option<ExchangeClient>,
    mock: &Option<Address>,
    moved: &mut Map<Address, i128>,
    withdraw: impl FnOnce(),
) {
    let t = token::Client::new(env, coin);
    let before = t.balance(owner);
    withdraw();
    // The vault may send more than asked (asking for its whole free balance withdraws all of it from Blend,
    // interest included); only `amount` moves on, the rest stays in the wallet.
    let got = t.balance(owner) - before;
    let got = if got < amount { got } else { amount };
    if got <= 0 {
        return;
    }
    match (ex, mock) {
        (Some(x), Some(m)) if m == coin => {
            let left = x.left(owner);
            let n = if got < left { got } else { left };
            if n > 0 {
                let usdc_id = x.usdc();
                let usdc = token::Client::new(env, &usdc_id);
                let ub = usdc.balance(owner);
                x.exchange(owner, &n);
                add(moved, usdc_id, usdc.balance(owner) - ub);
            }
        }
        _ => add(moved, coin.clone(), got),
    }
}

/// Uses or creates the owner's vault of `factory`, deposits `moved`, opens the orders and publishes `Moved`.
fn land(env: &Env, owner: Address, old_vault: Address, factory: &Address, moved: Map<Address, i128>, place: Vec<PlaceCall>) -> Address {
    let f = FactoryClient::new(env, factory);
    let new_vault = match f.vault_of(&owner) {
        Some(v) => v,
        None => f.create_vault(&owner),
    };
    if new_vault == old_vault {
        panic_with_error!(env, Error::SameVault);
    }
    let nv = NewVaultClient::new(env, &new_vault);
    for (coin, amount) in moved.iter() {
        if amount > 0 {
            nv.deposit(&coin, &amount);
        }
    }
    for p in place.iter() {
        env.invoke_contract::<Val>(&new_vault, &p.func, p.args);
    }

    Moved { owner, old_vault, new_vault: new_vault.clone(), moved, orders: place.len() }.publish(env);
    new_vault
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
#[cfg(test)]
mod test_legacy;
