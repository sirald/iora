//! Kasa fabrikasi.
//!
//! Her kullaniciya tek cagriyla kendi `order-vault` sozlesmesini kurar ve kasalari
//! listeler (keeper bu listeyi tarar). Ortak havuz yoktur; her kasanin parasi ayridir.
//!
//! Surum 6: kasa listesi sira numarasiyla degil KOVALARLA tutulur. Eskiden her kasa `VaultAt(n)` kaydina
//! yaziliyordu; `n` ortak sayaca bagli oldugu icin, bir kullanici cuzdaninda onaylarken baskasi kasa acarsa
//! numara kayiyor ve islem zincirde reddediliyordu. Artik kaydin anahtari yalnizca sahibin adresinden
//! turetilir (`Bucket(sha256(sahip)[0])`): islem hangi kayda yazacagini bastan bilir ve ayni anda kac kisi
//! kasa acarsa acsin kimsenin islemi digerininkini dusurmez.
//!
//! Fabrikanin hicbir kasadaki paraya erisimi yoktur. Tek yetkisi `guardian`in
//! "yeni emirleri durdur" anahtaridir; cekim, iptal ve mevcut emirler etkilenmez.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    xdr::ToXdr, Address, BytesN, Env, Vec,
};

const DAY_IN_LEDGERS: u32 = 17_280;
const BUMP_THRESHOLD: u32 = 7 * DAY_IN_LEDGERS;
const BUMP_TO: u32 = 30 * DAY_IN_LEDGERS;
/// Kasa listesinin bolundugu kova sayisi (sahibin adres ozetinin ilk bayti).
pub const BUCKETS: u32 = 256;
/// Bir kovanin alabilecegi en fazla kasa (tek kaydin boyutu sinirli kalsin). Toplam 102.400 kasa.
pub const MAX_BUCKET_LEN: u32 = 400;
/// Liste sayfasi: bir cagrida okunan en fazla kova (her kova bir okuma).
const MAX_BUCKET_PAGE: u32 = 16;
/// TTL uzatma: bir cagrida dokunulan en fazla sahip kaydi.
const MAX_TTL_PAGE: u32 = 40;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyExists = 1,
    NotFound = 2,
    Paused = 3,
    NoPendingGuardian = 4,
    /// Kardes fabrika bir kez ayarlanir; sonradan degistirilemez.
    SiblingAlreadySet = 5,
    InvalidSibling = 6,
    /// Dolum ucreti negatif olamaz.
    InvalidFee = 7,
    /// Sahibin kovasi dolu (MAX_BUCKET_LEN).
    BucketFull = 8,
}

/// Tum kasalarda ayni olan, degistirilemez ayarlar.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FactoryConfig {
    pub vault_wasm_hash: BytesN<32>,
    pub usdc: Address,
    pub xlm: Address,
    pub pool: Address,
    pub router: Address,
    /// Kasalarda dolumu yapana dolum basina odenebilecek azami ucret (alinan token, 7 ondalik).
    /// Yalnizca limitten iyi gelen kisimdan kesilir. Kurulumda sabitlenir, degistirilemez.
    pub exec_fee: i128,
}

/// Listedeki kayit: sahip + kasa.
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
    /// Tokenlari ters olan kardes fabrika (alim <-> satis).
    Sibling,
    Count,
    VaultOf(Address),
    /// Kova: sahibin adres ozetine gore secilir, icinde o kovaya dusen kasalar durur.
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

    /// Kullaniciya kasasini kurar. Adres sahibin adresinden turetilir (her sahibe bir kasa).
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
        // Kova yalnizca sahibin adresine baglidir: islem hazirlanirken de zincirde de ayni kayit.
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

    // ---------------- duraklatma ----------------

    /// Kasalar `place_order` sirasinda bunu sorar.
    pub fn is_paused(env: Env) -> bool {
        is_paused(&env)
    }

    pub fn set_paused(env: Env, paused: bool) {
        guardian(&env).require_auth();
        env.storage().instance().set(&Key::Paused, &paused);
        bump_instance(&env);
        PauseChanged { paused }.publish(&env);
    }

    /// Guardian degisikligi iki adimli: mevcut guardian onerir, yeni guardian kabul eder.
    /// Yanlis yazilmis bir adres duraklatma anahtarini kalici olarak kilitleyemez.
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

    // ---------------- kardes fabrika ----------------

    /// Tokenlari ters olan kardes fabrikayi (alim <-> satis) kaydeder. Kasalar zincirleme emrin
    /// hedefini buradan dogrular: hedef, kardes fabrikada ayni sahibin kayitli kasasi olmalidir.
    /// Yalnizca BIR KEZ ayarlanir; guardian sonradan baska bir adrese ceviremez.
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

    // ---------------- okuma ----------------

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

    /// Sahibin kasasinin kaydedildigi (veya kaydedilecegi) kova.
    pub fn bucket_of(env: Env, owner: Address) -> u32 {
        env.crypto().sha256(&owner.to_xdr(&env)).to_bytes().to_array()[0] as u32
    }

    /// Bir kovadaki kayitlar (sahip + kasa).
    pub fn bucket(env: Env, index: u32) -> Vec<VaultEntry> {
        env.storage().persistent().get(&Key::Bucket(index)).unwrap_or(Vec::new(&env))
    }

    /// Keeper icin liste: `start`tan baslayarak en fazla MAX_BUCKET_PAGE = 16 kovadaki kasalar.
    /// Tum kasalar icin 0, 16, 32 ... `bucket_count()`a kadar cagrilir.
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

    /// Keeper uzun sure dokunulmayan kayitlarin suresini uzatabilir (herkes cagirabilir): kovanin
    /// kendisi ve icindeki `start..start+limit` (en fazla 40) sahibin `VaultOf` kaydi.
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
