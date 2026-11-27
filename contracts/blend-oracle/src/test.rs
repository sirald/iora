#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Ledger},
    vec, Address, Env, Symbol, Vec,
};

/// Stand-in for Reflector: prices by symbol, configurable decimals.
#[contract]
pub struct MockReflector;

#[contracttype]
enum MKey {
    Decimals,
    Price(Symbol),
}

#[contractimpl]
impl MockReflector {
    pub fn set_decimals(e: Env, d: u32) {
        e.storage().instance().set(&MKey::Decimals, &d);
    }
    pub fn set_price(e: Env, sym: Symbol, price: i128, timestamp: u64) {
        e.storage().instance().set(&MKey::Price(sym), &PriceData { price, timestamp });
    }
    pub fn decimals(e: Env) -> u32 {
        e.storage().instance().get(&MKey::Decimals).unwrap_or(14)
    }
    pub fn resolution(_e: Env) -> u32 {
        300
    }
    pub fn lastprice(e: Env, asset: Asset) -> Option<PriceData> {
        match asset {
            Asset::Other(s) => e.storage().instance().get(&MKey::Price(s)),
            Asset::Stellar(_) => None,
        }
    }
    pub fn price(e: Env, asset: Asset, timestamp: u64) -> Option<PriceData> {
        let p = Self::lastprice(e, asset)?;
        if p.timestamp == timestamp {
            Some(p)
        } else {
            None
        }
    }
    pub fn prices(e: Env, asset: Asset, records: u32) -> Option<Vec<PriceData>> {
        let p = Self::lastprice(e.clone(), asset)?;
        let mut v = Vec::new(&e);
        for _ in 0..records {
            v.push_back(p.clone());
        }
        Some(v)
    }
}

struct Setup<'a> {
    e: Env,
    admin: Address,
    usdc: Address,
    xlm: Address,
    refl: MockReflectorClient<'a>,
    oracle: BlendOracleClient<'a>,
}

const NOW: u64 = 1_800_000_000;

fn setup() -> Setup<'static> {
    let e = Env::default();
    e.ledger().set_timestamp(NOW);
    let admin = Address::generate(&e);
    let usdc = Address::generate(&e);
    let xlm = Address::generate(&e);
    let refl_id = e.register(MockReflector, ());
    let refl = MockReflectorClient::new(&e, &refl_id);
    let assets: Vec<(Address, Symbol)> =
        vec![&e, (usdc.clone(), symbol_short!("USDC")), (xlm.clone(), symbol_short!("XLM"))];
    let id = e.register(BlendOracle, (admin.clone(), refl_id.clone(), DEFAULT_MAX_AGE, assets));
    let oracle = BlendOracleClient::new(&e, &id);
    Setup { e, admin, usdc, xlm, refl, oracle }
}

#[test]
fn maps_and_converts_14_to_7() {
    let s = setup();
    // Reflector testnet values (14 decimals)
    s.refl.set_price(&symbol_short!("USDC"), &100_063_202_909_570, &(NOW - 100));
    s.refl.set_price(&symbol_short!("XLM"), &12_679_399_426_625, &(NOW - 100));
    let p = s.oracle.lastprice(&Asset::Stellar(s.usdc.clone())).unwrap();
    assert_eq!(p, PriceData { price: 1_0006320, timestamp: NOW - 100 });
    let p = s.oracle.lastprice(&Asset::Stellar(s.xlm.clone())).unwrap();
    assert_eq!(p.price, 1267939); // 0.1267939, rounded down
    assert_eq!(s.oracle.decimals(), 7);
    assert_eq!(s.oracle.base(), Asset::Other(symbol_short!("USD")));
    assert_eq!(s.oracle.resolution(), 300);
    assert_eq!(s.oracle.symbol(&s.usdc), Some(symbol_short!("USDC")));
    assert_eq!(
        s.oracle.assets(),
        vec![&s.e, Asset::Stellar(s.usdc.clone()), Asset::Stellar(s.xlm.clone())]
    );
}

#[test]
fn converts_other_decimals() {
    assert_eq!(convert(123_456_789, 7), Some(123_456_789));
    assert_eq!(convert(12_345, 4), Some(12_345_000)); // fewer decimals: multiplied
    assert_eq!(convert(5, 14), None); // rounds to 0
    assert_eq!(convert(-1_000_000_000_000_00, 14), None); // negative
    assert_eq!(convert(i128::MAX, 0), None); // overflow
    let s = setup();
    s.refl.set_decimals(&18);
    s.refl.set_price(&symbol_short!("USDC"), &1_000_000_000_000_000_000, &NOW);
    assert_eq!(s.oracle.lastprice(&Asset::Stellar(s.usdc.clone())).unwrap().price, 1_0000000);
}

#[test]
fn stale_price_is_none() {
    let s = setup();
    s.refl.set_price(&symbol_short!("USDC"), &100_000_000_000_000, &(NOW - DEFAULT_MAX_AGE));
    assert!(s.oracle.lastprice(&Asset::Stellar(s.usdc.clone())).is_some()); // exactly max_age: still fresh
    s.refl.set_price(&symbol_short!("USDC"), &100_000_000_000_000, &(NOW - DEFAULT_MAX_AGE - 1));
    assert!(s.oracle.lastprice(&Asset::Stellar(s.usdc.clone())).is_none());
    // a timestamp in the future counts as fresh
    s.refl.set_price(&symbol_short!("USDC"), &100_000_000_000_000, &(NOW + 60));
    assert!(s.oracle.lastprice(&Asset::Stellar(s.usdc.clone())).is_some());
    // the admin can widen the window
    s.e.mock_all_auths();
    s.refl.set_price(&symbol_short!("USDC"), &100_000_000_000_000, &(NOW - 2000));
    assert!(s.oracle.lastprice(&Asset::Stellar(s.usdc.clone())).is_none());
    s.oracle.set_max_age(&3600);
    assert_eq!(s.oracle.max_age(), 3600);
    assert!(s.oracle.lastprice(&Asset::Stellar(s.usdc.clone())).is_some());
    // history reads are not freshness-checked
    assert!(s.oracle.price(&Asset::Stellar(s.usdc.clone()), &(NOW - 2000)).is_some());
}

#[test]
fn unknown_and_other_assets_are_none() {
    let s = setup();
    s.refl.set_price(&symbol_short!("USDC"), &100_000_000_000_000, &NOW);
    let stranger = Address::generate(&s.e);
    assert!(s.oracle.lastprice(&Asset::Stellar(stranger.clone())).is_none());
    assert!(s.oracle.lastprice(&Asset::Other(symbol_short!("USDC"))).is_none());
    assert!(s.oracle.prices(&Asset::Stellar(stranger), &3).is_none());
    // mapped, but Reflector has no price for the symbol
    assert!(s.oracle.lastprice(&Asset::Stellar(s.xlm.clone())).is_none());
    // zero price
    s.refl.set_price(&symbol_short!("XLM"), &0, &NOW);
    assert!(s.oracle.lastprice(&Asset::Stellar(s.xlm.clone())).is_none());
}

#[test]
fn admin_edits_table() {
    let s = setup();
    s.e.mock_all_auths();
    let weth = Address::generate(&s.e);
    s.refl.set_price(&symbol_short!("ETH"), &168_462_420_776_804_117, &NOW);
    assert!(s.oracle.lastprice(&Asset::Stellar(weth.clone())).is_none());
    s.oracle.set_asset(&weth, &symbol_short!("ETH"));
    assert_eq!(s.oracle.lastprice(&Asset::Stellar(weth.clone())).unwrap().price, 1684_6242077);
    assert_eq!(s.oracle.assets().len(), 3);
    // re-pointing a token keeps one entry
    s.oracle.set_asset(&weth, &symbol_short!("USDC"));
    assert_eq!(s.oracle.assets().len(), 3);
    s.oracle.remove_asset(&weth);
    assert!(s.oracle.lastprice(&Asset::Stellar(weth.clone())).is_none());
    assert_eq!(s.oracle.assets().len(), 2);
    assert!(s.oracle.try_remove_asset(&weth).is_err());
    assert!(s.oracle.try_set_max_age(&0).is_err());
    // prices() converts every record
    let v = s.oracle.prices(&Asset::Stellar(s.usdc.clone()), &2);
    assert!(v.is_none()); // no USDC price yet
    s.refl.set_price(&symbol_short!("USDC"), &100_000_000_000_000, &NOW);
    let v = s.oracle.prices(&Asset::Stellar(s.usdc.clone()), &2).unwrap();
    assert_eq!(v.len(), 2);
    assert_eq!(v.get(0).unwrap().price, 1_0000000);
}

#[test]
fn only_admin_can_change() {
    let s = setup();
    let weth = Address::generate(&s.e);
    // no auths mocked: every admin call fails
    assert!(s.oracle.try_set_asset(&weth, &symbol_short!("ETH")).is_err());
    assert!(s.oracle.try_remove_asset(&s.usdc).is_err());
    assert!(s.oracle.try_set_max_age(&60).is_err());
    assert!(s.oracle.try_set_reflector(&weth).is_err());
    assert!(s.oracle.try_propose_admin(&weth).is_err());
    assert_eq!(s.oracle.admin(), s.admin);
}

#[test]
fn admin_handover_two_steps() {
    let s = setup();
    s.e.mock_all_auths();
    let next = Address::generate(&s.e);
    assert!(s.oracle.try_accept_admin().is_err()); // nothing proposed
    s.oracle.propose_admin(&next);
    assert_eq!(s.oracle.admin(), s.admin);
    s.oracle.accept_admin();
    let auths = s.e.auths();
    assert_eq!(auths.last().unwrap().0, next);
    assert_eq!(s.oracle.admin(), next);
    let r2 = Address::generate(&s.e);
    s.oracle.set_reflector(&r2);
    assert_eq!(s.oracle.reflector(), r2);
}
