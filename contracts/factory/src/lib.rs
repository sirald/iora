//! Iora factory, version 9: deploys one multi-asset vault (`iora-vault`) per user in a single call and
//! keeps the list of vaults (keepers scan it). There is no shared pool; each vault holds its own funds.
//!
//! The factory has no access to the funds in any vault. The `guardian` can only pause new vaults and new
//! orders and edit the list of tokens that orders may use; withdrawals, cancellations and existing orders are not affected.
//!
//! The vault list is 256 chains, one per bucket (`sha256(owner)[0]`). Each vault has its own entry that points to
//! the vault created before it in the same bucket, and the bucket keeps only the newest owner and a count. No
//! entry grows with the number of vaults and no bucket can fill up, so nobody can block vault creation by
//! opening many vaults (version 8 kept each bucket as one list capped at 400). The entries a creation writes
//! depend only on the owner's address, so creations never collide however many people open a vault at once.
//! Earlier versions had separate buy and sell factories linked as siblings; this one is a single factory with one vault type.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, ContractExecutable,
    xdr::ToXdr, Address, BytesN, Env, Map, Vec,
};

/// Maximum length of the allowed token list.
pub const MAX_ALLOWED: u32 = 32;

const DAY_IN_LEDGERS: u32 = 17_280;
const BUMP_THRESHOLD: u32 = 7 * DAY_IN_LEDGERS;
const BUMP_TO: u32 = 30 * DAY_IN_LEDGERS;
/// Number of buckets the vault list is split into (first byte of the hash of the owner's address).
pub const BUCKETS: u32 = 256;
/// `heads`: maximum buckets read in one call (each bucket is one read).
const MAX_HEAD_PAGE: u32 = 64;
/// `bucket` and `extend_ttl`: maximum vault entries read in one call (each vault is one read).
const MAX_PAGE: u32 = 40;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyExists = 1,
    NotFound = 2,
    Paused = 3,
    NoPendingGuardian = 4,
    /// A fill fee cap cannot be negative.
    InvalidFee = 7,
    /// The allowed token list is full (MAX_ALLOWED).
    TooManyTokens = 9,
}

/// Settings shared by every vault. They cannot be changed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FactoryConfig {
    pub vault_wasm_hash: BytesN<32>,
    pub pool: Address,
    pub router: Address,
    /// Fill fee caps for the vaults: bought token -> maximum fee per fill (in that token's units).
    /// Taken only from output above the owner's limit. Fixed at deployment.
    pub fees: Map<Address, i128>,
}

/// A list entry: owner, vault and the owner created before it in the same bucket (None for the first).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultEntry {
    pub owner: Address,
    pub vault: Address,
    pub prev: Option<Address>,
}

/// What is stored for each owner: the vault and the link to the previous owner in the bucket.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Slot {
    pub vault: Address,
    pub prev: Option<Address>,
}

/// The newest owner in a bucket and how many vaults the bucket holds.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Head {
    pub last: Address,
    pub len: u32,
}

/// One non-empty bucket, as returned by `heads`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BucketInfo {
    pub index: u32,
    pub last: Address,
    pub len: u32,
}

#[contracttype]
#[derive(Clone)]
enum Key {
    Config,
    Guardian,
    Paused,
    PendingGuardian,
    Count,
    /// Tokens that orders may use (vaults ask this when a new order is placed).
    Allowed,
    /// The owner's vault and the link to the previous owner in the same bucket (`Slot`).
    VaultOf(Address),
    /// Bucket head: the newest owner in the bucket and the number of vaults in it (`Head`).
    Head(u32),
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
pub struct TokenAllowed {
    #[topic]
    pub token: Address,
    pub allowed: bool,
}

#[contract]
pub struct VaultFactory;

#[contractimpl]
impl VaultFactory {
    /// `tokens`: the tokens orders may use (the allowed list). The guardian can add and remove tokens later;
    /// removing one only blocks NEW orders. Existing orders, withdrawals and cancellations are not affected.
    pub fn __constructor(
        env: Env,
        guardian: Address,
        vault_wasm_hash: BytesN<32>,
        pool: Address,
        router: Address,
        fees: Map<Address, i128>,
        tokens: Vec<Address>,
    ) {
        if tokens.len() > MAX_ALLOWED {
            panic_with_error!(&env, Error::TooManyTokens);
        }
        for (_, cap) in fees.iter() {
            if cap < 0 {
                panic_with_error!(&env, Error::InvalidFee);
            }
        }
        let s = env.storage().instance();
        s.set(&Key::Config, &FactoryConfig { vault_wasm_hash, pool, router, fees });
        s.set(&Key::Guardian, &guardian);
        s.set(&Key::Paused, &false);
        s.set(&Key::Count, &0u32);
        s.set(&Key::Allowed, &tokens);
        bump_instance(&env);
    }

    /// Deploys the caller's vault. The address is derived from the owner's address (one vault per owner).
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
        // The bucket depends only on the owner's address: the same entry at simulation time and on chain.
        let bucket = salt.to_array()[0] as u32;
        let hkey = Key::Head(bucket);
        let head: Option<Head> = env.storage().persistent().get(&hkey);
        let me = env.current_contract_address();
        let vault = env.deployer().with_current_contract(salt).deploy_contract(
            ContractExecutable::Wasm(cfg.vault_wasm_hash),
            (owner.clone(), cfg.pool, cfg.router, me, cfg.fees),
        );

        let count: u32 = env.storage().instance().get(&Key::Count).unwrap_or(0);
        // The new vault becomes the head of its bucket's chain and points to the previous head.
        let (prev, len) = match head {
            Some(h) => (Some(h.last), h.len),
            None => (None, 0),
        };
        set_persistent(&env, &key, &Slot { vault: vault.clone(), prev });
        set_persistent(&env, &hkey, &Head { last: owner.clone(), len: len + 1 });
        env.storage().instance().set(&Key::Count, &(count + 1));
        bump_instance(&env);

        VaultCreated { owner, vault: vault.clone(), bucket }.publish(&env);
        vault
    }

    // ---------------- pause ----------------

    /// Vaults ask this when a new order is placed.
    pub fn is_paused(env: Env) -> bool {
        is_paused(&env)
    }

    pub fn set_paused(env: Env, paused: bool) {
        guardian(&env).require_auth();
        env.storage().instance().set(&Key::Paused, &paused);
        bump_instance(&env);
        PauseChanged { paused }.publish(&env);
    }

    // ---------------- allowed tokens ----------------

    /// Vaults ask this when a new order is placed (and when a fill routes through an intermediate token).
    pub fn is_allowed(env: Env, token: Address) -> bool {
        allowed(&env).contains(&token)
    }

    pub fn allowed_tokens(env: Env) -> Vec<Address> {
        allowed(&env)
    }

    /// The guardian adds a token to the list or removes one.
    pub fn set_allowed(env: Env, token: Address, allow: bool) {
        guardian(&env).require_auth();
        let mut list = allowed(&env);
        let at = list.first_index_of(&token);
        match (allow, at) {
            (true, None) => {
                if list.len() >= MAX_ALLOWED {
                    panic_with_error!(&env, Error::TooManyTokens);
                }
                list.push_back(token.clone());
            }
            (false, Some(i)) => {
                list.remove(i);
            }
            _ => {}
        }
        env.storage().instance().set(&Key::Allowed, &list);
        bump_instance(&env);
        TokenAllowed { token, allowed: allow }.publish(&env);
    }

    /// Changing the guardian takes two steps: the current guardian proposes, the new one accepts.
    /// A mistyped address therefore cannot lock the pause switch for good.
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

    // ---------------- reads ----------------

    pub fn get_config(env: Env) -> FactoryConfig {
        env.storage().instance().get(&Key::Config).unwrap()
    }

    pub fn get_guardian(env: Env) -> Address {
        guardian(&env)
    }

    pub fn vault_of(env: Env, owner: Address) -> Option<Address> {
        env.storage().persistent().get::<Key, Slot>(&Key::VaultOf(owner)).map(|s| s.vault)
    }

    pub fn vault_count(env: Env) -> u32 {
        env.storage().instance().get(&Key::Count).unwrap_or(0)
    }

    pub fn bucket_count(_env: Env) -> u32 {
        BUCKETS
    }

    /// The bucket the owner's vault is (or would be) recorded in.
    pub fn bucket_of(env: Env, owner: Address) -> u32 {
        env.crypto().sha256(&owner.to_xdr(&env)).to_bytes().to_array()[0] as u32
    }

    /// The non-empty buckets among `start..start+limit` (at most 64 per call), each with its newest owner and
    /// its vault count. Four calls (0, 64, 128, 192) cover every bucket; a keeper compares the counts with what
    /// it has and reads only the buckets that grew.
    pub fn heads(env: Env, start: u32, limit: u32) -> Vec<BucketInfo> {
        let limit = if limit > MAX_HEAD_PAGE { MAX_HEAD_PAGE } else { limit };
        let end = if start.saturating_add(limit) > BUCKETS { BUCKETS } else { start + limit };
        let mut out = Vec::new(&env);
        let mut i = start;
        while i < end {
            if let Some(h) = env.storage().persistent().get::<Key, Head>(&Key::Head(i)) {
                out.push_back(BucketInfo { index: i, last: h.last, len: h.len });
            }
            i += 1;
        }
        out
    }

    /// The vaults in one bucket, newest first, at most 40 per call. Start with `from = None`; to read on, pass
    /// the `prev` of the last entry returned (the list has ended when that `prev` is None).
    pub fn bucket(env: Env, index: u32, from: Option<Address>, limit: u32) -> Vec<VaultEntry> {
        let limit = if limit > MAX_PAGE { MAX_PAGE } else { limit };
        let mut out = Vec::new(&env);
        let mut cur: Option<Address> = match from {
            Some(owner) => Some(owner),
            None => env.storage().persistent().get::<Key, Head>(&Key::Head(index)).map(|h| h.last),
        };
        let mut n = 0u32;
        while n < limit {
            let owner = match cur {
                Some(o) => o,
                None => break,
            };
            let slot: Slot = match env.storage().persistent().get(&Key::VaultOf(owner.clone())) {
                Some(s) => s,
                None => break,
            };
            cur = slot.prev.clone();
            out.push_back(VaultEntry { owner, vault: slot.vault, prev: slot.prev });
            n += 1;
        }
        out
    }

    /// Keepers extend the lifetime of entries that have not been touched for a long time (anyone may call): the
    /// bucket's head and at most 40 vault entries, walked the same way as `bucket` (`from = None` starts at the newest).
    pub fn extend_ttl(env: Env, index: u32, from: Option<Address>, limit: u32) {
        bump_instance(&env);
        let hk = Key::Head(index);
        let head: Option<Head> = env.storage().persistent().get(&hk);
        if head.is_some() {
            env.storage().persistent().extend_ttl(&hk, BUMP_THRESHOLD, BUMP_TO);
        }
        let limit = if limit > MAX_PAGE { MAX_PAGE } else { limit };
        let mut cur: Option<Address> = match from {
            Some(owner) => Some(owner),
            None => head.map(|h| h.last),
        };
        let mut n = 0u32;
        while n < limit {
            let owner = match cur {
                Some(o) => o,
                None => break,
            };
            let k = Key::VaultOf(owner);
            let slot: Slot = match env.storage().persistent().get(&k) {
                Some(s) => s,
                None => break,
            };
            env.storage().persistent().extend_ttl(&k, BUMP_THRESHOLD, BUMP_TO);
            cur = slot.prev;
            n += 1;
        }
    }
}

fn is_paused(env: &Env) -> bool {
    env.storage().instance().get(&Key::Paused).unwrap_or(false)
}

fn allowed(env: &Env) -> Vec<Address> {
    env.storage().instance().get(&Key::Allowed).unwrap_or(Vec::new(env))
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
