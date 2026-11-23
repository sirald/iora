//! Vault factory.
//!
//! Deploys each user's own `order-vault` contract in one call and lists the vaults
//! (the keeper scans this list). There is no shared pool; every vault holds its own funds.
//!
//! Version 6: the vault list is kept in BUCKETS, not by sequence number. Each vault used to be written to a
//! `VaultAt(n)` entry; `n` came from a shared counter, so if someone else opened a vault while a user was approving
//! in their wallet, the number shifted and the transaction was rejected on-chain. The entry key is now derived only
//! from the owner's address (`Bucket(sha256(owner)[0])`): the transaction knows up front which entry it writes, and
//! however many people open a vault at once, nobody's transaction knocks out another's.
//!
//! The factory has no access to the funds in any vault. Its only power is the `guardian`'s
//! "stop new orders" switch; withdrawals, cancellations and existing orders are not affected.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    xdr::ToXdr, Address, BytesN, Env, Vec,
};

const DAY_IN_LEDGERS: u32 = 17_280;
const BUMP_THRESHOLD: u32 = 7 * DAY_IN_LEDGERS;
const BUMP_TO: u32 = 30 * DAY_IN_LEDGERS;
/// Number of buckets the vault list is split into (first byte of the owner's address hash).
pub const BUCKETS: u32 = 256;
/// Most vaults one bucket can hold (keeps a single entry small). 102,400 vaults in total.
pub const MAX_BUCKET_LEN: u32 = 400;
/// List page: most buckets read in one call (each bucket is one read).
const MAX_BUCKET_PAGE: u32 = 16;
/// TTL extension: most owner entries touched in one call.
const MAX_TTL_PAGE: u32 = 40;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyExists = 1,
    NotFound = 2,
    Paused = 3,
    NoPendingGuardian = 4,
    /// The sibling factory is set once; it cannot be changed later.
    SiblingAlreadySet = 5,
    InvalidSibling = 6,
    /// The fill fee cannot be negative.
    InvalidFee = 7,
    /// The owner's bucket is full (MAX_BUCKET_LEN).
    BucketFull = 8,
}

/// Settings that are the same in every vault and cannot be changed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FactoryConfig {
    pub vault_wasm_hash: BytesN<32>,
    pub usdc: Address,
    pub xlm: Address,
    pub pool: Address,
    pub router: Address,
    /// Highest fee a vault may pay the filler per fill (in the token bought, 7 decimals).
    /// Taken only from what comes in above the limit. Fixed at deployment, cannot be changed.
    pub exec_fee: i128,
}

/// List entry: owner + vault.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultEntry {
    pub owner: Address,
    pub vault: Address,
}

#[contracttype]
#[derive(Clone)]
enum Key {
    Config,
    Guardian,
    Paused,
    PendingGuardian,
    /// The sibling factory with the tokens reversed (buy <-> sell).
    Sibling,
    Count,
    VaultOf(Address),
    /// Bucket: chosen by the owner's address hash; holds the vaults that fall into it.
    Bucket(u32),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultCreated {
    #[topic]
    pub owner: Address,
    pub vault: Address,
    pub bucket: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PauseChanged {
    pub paused: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GuardianChanged {
    pub guardian: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GuardianProposed {
    pub guardian: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SiblingSet {
    pub sibling: Address,
}

#[contract]
pub struct VaultFactory;

#[contractimpl]
impl VaultFactory {
    pub fn __constructor(
        env: Env,
        guardian: Address,
        vault_wasm_hash: BytesN<32>,
        usdc: Address,
        xlm: Address,
        pool: Address,
        router: Address,
        exec_fee: i128,
    ) {
        if exec_fee < 0 {
            panic_with_error!(&env, Error::InvalidFee);
        }
        let s = env.storage().instance();
        s.set(&Key::Config, &FactoryConfig { vault_wasm_hash, usdc, xlm, pool, router, exec_fee });
        s.set(&Key::Guardian, &guardian);
        s.set(&Key::Paused, &false);
        s.set(&Key::Count, &0u32);
        bump_instance(&env);
    }

    /// Deploys the user's vault. The address is derived from the owner's address (one vault per owner).
    pub fn create_vault(env: Env, owner: Address) -> Address {
        owner.require_auth();
        if is_paused(&env) {
            panic_with_error!(&env, Error::Paused);
        }
        let key = Key::VaultOf(owner.clone());
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, Error::AlreadyExists);
        }

        let cfg: FactoryConfig = env.storage().instance().get(&Key::Config).unwrap();
        let salt: BytesN<32> = env.crypto().sha256(&owner.clone().to_xdr(&env)).to_bytes();
        // The bucket depends only on the owner's address: the same entry when the transaction is prepared and on-chain.
        let bucket = salt.to_array()[0] as u32;
        let bkey = Key::Bucket(bucket);
        let mut list: Vec<VaultEntry> = env.storage().persistent().get(&bkey).unwrap_or(Vec::new(&env));
        if list.len() >= MAX_BUCKET_LEN {
            panic_with_error!(&env, Error::BucketFull);
        }
        let me = env.current_contract_address();
        let vault = env.deployer().with_current_contract(salt).deploy_v2(
            cfg.vault_wasm_hash,
            (owner.clone(), cfg.usdc, cfg.xlm, cfg.pool, cfg.router, me, cfg.exec_fee),
        );

        let count: u32 = env.storage().instance().get(&Key::Count).unwrap_or(0);
        set_persistent(&env, &key, &vault);
        list.push_back(VaultEntry { owner: owner.clone(), vault: vault.clone() });
        set_persistent(&env, &bkey, &list);
        env.storage().instance().set(&Key::Count, &(count + 1));
        bump_instance(&env);

        VaultCreated { owner, vault: vault.clone(), bucket }.publish(&env);
        vault
    }

    // ---------------- pause ----------------

    /// Vaults ask this during `place_order`.
    pub fn is_paused(env: Env) -> bool {
        is_paused(&env)
    }

    pub fn set_paused(env: Env, paused: bool) {
        guardian(&env).require_auth();
        env.storage().instance().set(&Key::Paused, &paused);
        bump_instance(&env);
        PauseChanged { paused }.publish(&env);
    }

    /// Changing the guardian takes two steps: the current guardian proposes, the new guardian accepts.
    /// A mistyped address cannot lock the pause switch for good.
    pub fn propose_guardian(env: Env, new_guardian: Address) {
        guardian(&env).require_auth();
        env.storage().instance().set(&Key::PendingGuardian, &new_guardian);
        bump_instance(&env);
        GuardianProposed { guardian: new_guardian }.publish(&env);
    }

    pub fn accept_guardian(env: Env) {
        let pending: Address = match env.storage().instance().get(&Key::PendingGuardian) {
            Some(p) => p,
            None => panic_with_error!(&env, Error::NoPendingGuardian),
        };
        pending.require_auth();
        env.storage().instance().set(&Key::Guardian, &pending);
        env.storage().instance().remove(&Key::PendingGuardian);
        bump_instance(&env);
        GuardianChanged { guardian: pending }.publish(&env);
    }

    // ---------------- sibling factory ----------------

    /// Records the sibling factory with the tokens reversed (buy <-> sell). Vaults check the target of a
    /// follow-up order here: the target must be the same owner's registered vault in the sibling factory.
    /// Set only ONCE; the guardian cannot point it to another address later.
    pub fn set_sibling(env: Env, sibling: Address) {
        guardian(&env).require_auth();
        if env.storage().instance().has(&Key::Sibling) {
            panic_with_error!(&env, Error::SiblingAlreadySet);
        }
        if sibling == env.current_contract_address() {
            panic_with_error!(&env, Error::InvalidSibling);
        }
        env.storage().instance().set(&Key::Sibling, &sibling);
        bump_instance(&env);
        SiblingSet { sibling }.publish(&env);
    }

    pub fn sibling(env: Env) -> Option<Address> {
        env.storage().instance().get(&Key::Sibling)
    }

    // ---------------- reads ----------------

    pub fn get_config(env: Env) -> FactoryConfig {
        env.storage().instance().get(&Key::Config).unwrap()
    }

    pub fn get_guardian(env: Env) -> Address {
        guardian(&env)
    }

    pub fn vault_of(env: Env, owner: Address) -> Option<Address> {
        env.storage().persistent().get(&Key::VaultOf(owner))
    }

    pub fn vault_count(env: Env) -> u32 {
        env.storage().instance().get(&Key::Count).unwrap_or(0)
    }

    pub fn bucket_count(_env: Env) -> u32 {
        BUCKETS
    }

    /// The bucket where the owner's vault is (or will be) recorded.
    pub fn bucket_of(env: Env, owner: Address) -> u32 {
        env.crypto().sha256(&owner.to_xdr(&env)).to_bytes().to_array()[0] as u32
    }

    /// The entries in one bucket (owner + vault).
    pub fn bucket(env: Env, index: u32) -> Vec<VaultEntry> {
        env.storage().persistent().get(&Key::Bucket(index)).unwrap_or(Vec::new(&env))
    }

    /// List for the keeper: the vaults in at most MAX_BUCKET_PAGE = 16 buckets, starting from `start`.
    /// For all vaults, call with 0, 16, 32 ... up to `bucket_count()`.
    pub fn vaults_in(env: Env, start: u32, limit: u32) -> Vec<Address> {
        let limit = if limit > MAX_BUCKET_PAGE { MAX_BUCKET_PAGE } else { limit };
        let end = if start.saturating_add(limit) > BUCKETS { BUCKETS } else { start + limit };
        let mut out = Vec::new(&env);
        let mut i = start;
        while i < end {
            if let Some(list) = env.storage().persistent().get::<Key, Vec<VaultEntry>>(&Key::Bucket(i)) {
                for e in list.iter() {
                    out.push_back(e.vault);
                }
            }
            i += 1;
        }
        out
    }

    /// The keeper can extend the lifetime of entries left untouched for a long time (anyone can call): the bucket
    /// itself and the `VaultOf` entries of the owners in `start..start+limit` (at most 40).
    pub fn extend_ttl(env: Env, bucket: u32, start: u32, limit: u32) {
        bump_instance(&env);
        let k = Key::Bucket(bucket);
        if let Some(list) = env.storage().persistent().get::<Key, Vec<VaultEntry>>(&k) {
            env.storage().persistent().extend_ttl(&k, BUMP_THRESHOLD, BUMP_TO);
            let limit = if limit > MAX_TTL_PAGE { MAX_TTL_PAGE } else { limit };
            let end = if start.saturating_add(limit) > list.len() { list.len() } else { start + limit };
            let mut i = start;
            while i < end {
                let e = list.get_unchecked(i);
                let k2 = Key::VaultOf(e.owner);
                if env.storage().persistent().has(&k2) {
                    env.storage().persistent().extend_ttl(&k2, BUMP_THRESHOLD, BUMP_TO);
                }
                i += 1;
            }
        }
    }
}

fn is_paused(env: &Env) -> bool {
    env.storage().instance().get(&Key::Paused).unwrap_or(false)
}

fn guardian(env: &Env) -> Address {
    env.storage().instance().get(&Key::Guardian).unwrap()
}

fn set_persistent<V: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &Key, value: &V) {
    env.storage().persistent().set(key, value);
    env.storage().persistent().extend_ttl(key, BUMP_THRESHOLD, BUMP_TO);
}

fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

#[cfg(test)]
mod test;
