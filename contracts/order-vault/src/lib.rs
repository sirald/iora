//! Getirili limit emir kasasi.
//!
//! Kullanici basina bir kasa. USDC Blend havuzunda faiz kazanir; limit alim emri
//! tetiklenince ayni islemde Blend'den cekilir ve Soroswap'ta XLM'e takas edilir.
//! Normal emirlerde fiyat kosulu oracle ile degil, takasin `amount_out_min` parametresiyle zorlanir.
//! Kosul saglanmazsa islemin tamami geri alinir.
//!
//! Surum 3 eklemeleri:
//! - Tetikli emir (`place_stop_order`): piyasa fiyati tetik seviyesine gelince calisir; en kotu fiyat
//!   yine `limit_price` ile sinirlidir. Satis kasasinda bu "zarar kes" (stop-loss) demektir.
//!   Tetik, Blend havuzunun kullandigi fiyat oracle'indan okunur (tek islem icinde oynatilamaz);
//!   Soroswap'in anlik fiyati kullanilmaz.
//! - Zincirleme emir (`place_order_then`): dolumdan cikan token, sahibin sectigi diger kasaya
//!   (or. satis kasasi) yatirilir ve orada otomatik bir emir acilir. Hedef kasa yalnizca sahibinin
//!   `set_feeder` ile izin verdigi kasadan gelen parayi kabul eder. Aktarim herhangi bir nedenle
//!   basarisiz olursa token her zamanki gibi sahibin cuzdanina gider; dolum asla bu yuzden durmaz.
//!
//! Surum 4 (ic denetim, Kasim 2026) degisiklikleri:
//! - Yuvarlama tamponu ilk emirde de uygulanir; emir en fazla `MAX_FILLS` parcada dolar ve bir dolum
//!   geride asgari dolumdan kucuk "kirinti" birakamaz.
//! - Emir suresi ve fiyat ust sinirlidir; suresi dolan emri herkes kapatabilir (rezerv sahibine acilir).
//! - Zincirleme emrin hedefi kardes fabrikada sahibin kayitli kasasi olmak zorundadir ve zincir, alis
//!   fiyatinin altinda satis emri acamaz.
//! - Tetikli emirde oracle'dan sapma bandini kullanici secer (`stop_band_bps`); limit tetikten en fazla
//!   %10 uzak olabilir.
//! - Sahibin cuzdani cikan tokeni alamiyorsa (or. trustline yok) dolum durmaz: token kasada bekler,
//!   sahibi `sweep` ile alir.
//! - `sweep` yalnizca kasanin iki tokeni icin calisir; `withdraw(WITHDRAW_ALL)` serbest bakiyenin tamamini ceker.
//!
//! Surum 5 (dolum ucreti):
//! - `execute` dolumu yapanin adresini alir ve ona, alinan token cinsinden kucuk bir ucret oder. Ucret
//!   YALNIZCA limitten iyi gelen kisimdan kesilir ve dolum basina `exec_fee` ile sinirlidir (fabrikada
//!   sabit, sonradan degistirilemez). Sahip her zaman en az kendi limitinin karsiligini alir; fiyat tam
//!   limitteyse ucret sifirdir. Boylece asgari emir tutari koymadan her dolum kendi ag masrafini oder:
//!   masrafini cikarmayan cok kucuk emir yasak degildir, fiyat limiti biraz gecene kadar bekler.
#![no_std]

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    panic_with_error, token, vec, Address, Env, IntoVal, Map, Symbol, TryFromVal, Val, Vec,
};

/// Fiyatlar 7 ondalikla tutulur (USDC ve XLM ikisi de 7 ondalikli).
pub const SCALE: i128 = 10_000_000;
/// Blend b_rate 12 ondaliklidir.
pub const B_RATE_SCALE: i128 = 1_000_000_000_000;
/// Fiyat etkisi baz puan olarak; 10_000 = kontrol kapali.
pub const BPS: u32 = 10_000;

/// Blend v2 istek tipleri.
const BLEND_SUPPLY: u32 = 0;
const BLEND_WITHDRAW: u32 = 1;

/// Takas son tarihi: islem anindan itibaren saniye. Ayni islemin icinde hesaplandigi icin kendi basina
/// bir koruma DEGILDIR (router bu parametreyi zorunlu tuttugu icin verilir). Eski bir islemin gec
/// calismasina karsi koruma, islemin kendi zaman siniri ve emrin `expiry` alanidir.
const SWAP_DEADLINE_SECS: u64 = 300;

/// Bir emir en fazla bu kadar parcada dolabilir (`min_fill * MAX_FILLS >= amount_in`). Parca sayisi
/// sinirli olunca yuvarlama kaybi da sinirli kalir ve fiyat etkisi siniri asiri bolmeyle asilamaz.
pub const MAX_FILLS: i128 = 20;
/// Emir en fazla bu kadar ileri tarihli olabilir (arayuz en fazla 365 gun sunar; bir gun, kullanicinin
/// saati ile zincir saati arasindaki fark icin paydir).
pub const MAX_ORDER_SECS: u64 = 366 * 86_400;
/// Kabul edilen en yuksek fiyat (1 alinan token icin 1 milyar yatirilan token). Tasmalara karsi sinir.
pub const MAX_PRICE: i128 = SCALE * 1_000_000_000;
/// `withdraw` icin ozel deger: serbest bakiyenin tamami (acik emir yoksa Blend'deki her sey).
pub const WITHDRAW_ALL: i128 = i128::MAX;
/// Iki token da bu ondalikta olmalidir; fiyat hesaplari buna gore yapilir.
pub const TOKEN_DECIMALS: u32 = 7;

/// TTL (yaklasik 5 sn/ledger).
const DAY_IN_LEDGERS: u32 = 17_280;
const BUMP_THRESHOLD: u32 = 7 * DAY_IN_LEDGERS;
const BUMP_TO: u32 = 30 * DAY_IN_LEDGERS;

// ---------------------------------------------------------------------------
// Dis sozlesme arayuzleri
// ---------------------------------------------------------------------------

/// Blend v2 `Request` yapisi (alan adlari Blend ile birebir ayni olmali).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Request {
    pub request_type: u32,
    pub address: Address,
    pub amount: i128,
}

/// Blend'in donus yapilarinin tamami yerine yalnizca ihtiyac duyulan alanlar
/// okunur (Map olarak), boylece Blend yapiya alan eklese de kasa bozulmaz.
#[contractclient(name = "BlendPoolClient")]
pub trait BlendPool {
    fn submit(env: Env, from: Address, spender: Address, to: Address, requests: Vec<Request>)
        -> Val;
    fn get_positions(env: Env, address: Address) -> Map<Symbol, Val>;
    fn get_reserve(env: Env, asset: Address) -> Map<Symbol, Val>;
    fn get_config(env: Env) -> Map<Symbol, Val>;
    fn claim(env: Env, from: Address, reserve_token_ids: Vec<u32>, to: Address) -> i128;
}

/// SEP-40 / Reflector fiyat oracle'i (Blend havuzlari bunu kullanir).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OracleAsset {
    Stellar(Address),
    Other(Symbol),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

#[contractclient(name = "PriceOracleClient")]
pub trait PriceOracle {
    fn lastprice(env: Env, asset: OracleAsset) -> Option<PriceData>;
}

/// Oracle fiyati bundan eskiyse tetikli emir calismaz. Reflector 5 dakikada bir gunceller ve zaman
/// damgasi donemin basidir; 6 dakikalik eski sinir, guncelleme biraz gecikince zarar kesi calismaz
/// birakiyordu. 10 dakika iki guncelleme donemini kapsar.
pub const ORACLE_MAX_AGE_SECS: u64 = 10 * 60;
/// Tetikli emirde dolum, oracle'a gore adil miktarin en fazla `stop_band_bps` kadar altinda olabilir.
/// Bandi kullanici secer (%0,5 - %10). Bant takas ucretini ve fiyat etkisini de kapsar: dolduran kisi
/// havuzu en fazla bu banda kadar oynatabilir; dar bant daha iyi fiyat, genis bant sert dususte daha
/// yuksek dolma ihtimali demektir.
pub const STOP_BAND_MIN_BPS: u32 = 50;
pub const STOP_BAND_MAX_BPS: u32 = 1_000;
/// Tetikli emirde limit, tetikten en fazla bu kadar uzak olabilir (%10, en genis sapma bandiyla ayni).
/// Satis kasasinda bu, tetik fiyatinin en fazla ~%9 altinda bir "en kotu fiyat" demektir. Yanlislikla
/// girilen cok uzak bir limit bu korumayi anlamsiz kilmasin.
pub const STOP_MAX_GAP_BPS: i128 = 1_000;

/// Fabrika. Kasa ondan yalnizca bilgi okur: "yeni emirler durduruldu mu", kardes fabrikanin adresi
/// ve bir sahibin kayitli kasasi. Fabrikanin para hareketine yetkisi yoktur.
#[contractclient(name = "GuardClient")]
pub trait Guard {
    fn is_paused(env: Env) -> bool;
    /// Tokenlari ters olan kardes fabrika (alim <-> satis). Ayarlanmadiysa None.
    fn sibling(env: Env) -> Option<Address>;
    fn vault_of(env: Env, owner: Address) -> Option<Address>;
}

#[contractclient(name = "RouterClient")]
pub trait SoroswapRouter {
    fn swap_exact_tokens_for_tokens(
        env: Env,
        amount_in: i128,
        amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        deadline: u64,
    ) -> Vec<i128>;

    fn router_pair_for(env: Env, token_a: Address, token_b: Address) -> Address;

    fn router_get_amounts_out(env: Env, amount_in: i128, path: Vec<Address>) -> Vec<i128>;
}

// ---------------------------------------------------------------------------
// Veri tipleri
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    InvalidAmount = 1,
    InsufficientFree = 2,
    OrderNotFound = 3,
    OrderNotOpen = 4,
    OrderExpired = 5,
    FillTooSmall = 6,
    FillTooLarge = 7,
    LimitNotMet = 8,
    InvalidPrice = 9,
    PoolShortfall = 10,
    InvalidExpiry = 11,
    BlendFormat = 12,
    ImpactTooHigh = 13,
    InvalidImpact = 14,
    Paused = 15,
    /// Tetikli emir: piyasa henuz tetik seviyesine gelmedi.
    TriggerNotMet = 16,
    /// `receive_and_order`: gonderen bu kasanin izin verdigi besleyici degil.
    NotFeeder = 17,
    /// Zincirleme emir ayarlari gecersiz.
    InvalidFollowUp = 18,
    /// Tetikli emir: guncel oracle fiyati alinamadi.
    OracleUnavailable = 19,
    /// Tetikli emir: dolum fiyati oracle fiyatindan cok uzak (havuz oynatilmis olabilir).
    PriceDeviation = 20,
    /// Kurulum: yatirilan ve alinan token ayni olamaz.
    SameToken = 21,
    /// `sweep`: yalnizca kasanin iki tokeni kurtarilabilir.
    UnknownToken = 22,
    /// Kurulum: tokenlar 7 ondalikli olmali.
    BadDecimals = 23,
    /// Tetikli emir: sapma bandi izin verilen aralikta degil.
    InvalidBand = 24,
    /// Kurulum: dolum ucreti negatif olamaz.
    InvalidFee = 25,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub owner: Address,
    pub usdc: Address,
    pub xlm: Address,
    pub pool: Address,
    pub router: Address,
    /// Duraklatma bilgisini veren sozlesme (fabrika).
    pub guard: Address,
    /// Dolumu yapana dolum basina odenebilecek azami ucret (alinan token, 7 ondalik). Yalnizca
    /// limitten iyi gelen kisimdan kesilir; 0 = ucret yok.
    pub exec_fee: i128,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OrderStatus {
    Open,
    Filled,
    Cancelled,
}

/// USDC -> XLM limit alim emri.
/// `limit_price`: 1 XLM icin odenecek azami USDC (7 ondalik). 0,20 USDC = 2_000_000.
/// `max_impact_bps`: tek dolumun Soroswap havuzunda yaratabilecegi azami fiyat etkisi.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Order {
    pub amount_in: i128,
    pub filled_in: i128,
    pub filled_out: i128,
    pub limit_price: i128,
    pub min_fill: i128,
    pub max_impact_bps: u32,
    pub expiry: u64,
    pub status: OrderStatus,
    /// 0: normal limit emir. >0: tetikli emir; piyasa fiyati (yatirilan token cinsinden, 1 alinan
    /// token icin) bu degere ulasmadan dolum yapilamaz. Ornek: satis kasasinda zarar kes.
    pub trigger_price: i128,
    /// Yalnizca tetikli emir: dolumun oracle fiyatindan azami sapmasi (baz puan). Normal emirde 0.
    pub stop_band_bps: u32,
}

/// Zincirleme emir: dolumdan cikan token `vault` kasasina yatirilir ve orada bu ayarlarla emir acilir.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FollowUp {
    pub vault: Address,
    /// Hedef kasanin kendi birimlerinde limit (hedef kasanin `place_order` limitiyle ayni anlam).
    pub limit_price: i128,
    pub max_impact_bps: u32,
    /// Hedef emrin gecerlilik suresi (saniye), aktarim anindan itibaren.
    pub duration: u64,
}

/// Hedef kasanin arayuzu (ayni kontrat kodu).
#[contractclient(name = "FollowVaultClient")]
pub trait FollowVault {
    fn receive_and_order(env: Env, from: Address, amount: i128, limit_price: i128, max_impact_bps: u32, expiry: u64) -> u32;
    fn get_config(env: Env) -> Config;
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Config,
    /// Yatirilan anapara (bilgi amacli; faiz = bakiye - anapara).
    Deposited,
    /// Acik emirlere ayrilmis tutar.
    Reserved,
    NextId,
    Order(u32),
    /// Omur boyu toplamlar (gecmis ekrani icin).
    Stats,
    /// Zincirleme emir ayari (emir numarasina gore).
    FollowUp(u32),
    /// Bu kasaya para yatirip emir acabilecek tek kasa (sahibinin izniyle).
    Feeder,
}

/// Kasanin omur boyu toplamlari. Omur boyu faiz = bakiye + cekilen + harcanan - yatirilan.
#[contracttype]
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Stats {
    pub total_deposited: i128,
    pub total_withdrawn: i128,
    pub total_spent: i128,
    pub total_received: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposited {
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawn {
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderPlaced {
    #[topic]
    pub order_id: u32,
    pub amount_in: i128,
    pub limit_price: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderCancelled {
    #[topic]
    pub order_id: u32,
    pub remaining: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderFilled {
    #[topic]
    pub order_id: u32,
    pub amount_in: i128,
    pub amount_out: i128,
}

/// Zincirleme emir: dolum ciktisi hedef kasaya yatirildi ve orada emir acildi.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Forwarded {
    #[topic]
    pub order_id: u32,
    pub vault: Address,
    pub amount: i128,
    pub new_order_id: u32,
}

/// Bu kasa baska bir kasadan para alip emir acti.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Received {
    pub from: Address,
    pub amount: i128,
    pub order_id: u32,
}

/// Zincirleme emir: hedef kasa parayi kabul etmedi; cikti sahibin cuzdanina yonlendirildi.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForwardFailed {
    #[topic]
    pub order_id: u32,
    pub vault: Address,
}

/// Sahibin cuzdani cikan tokeni alamadi (or. trustline yok); token kasada bekliyor, `sweep` ile alinir.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Held {
    #[topic]
    pub order_id: u32,
    pub amount: i128,
}

/// Dolumu yapana odenen ucret (alinan token cinsinden; limitten iyi gelen kisimdan kesildi).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecFeePaid {
    #[topic]
    pub order_id: u32,
    pub executor: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeederChanged {
    pub feeder: Option<Address>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Swept {
    #[topic]
    pub token: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardsClaimed {
    pub amount: i128,
}

// ---------------------------------------------------------------------------
// Sozlesme
// ---------------------------------------------------------------------------

#[contract]
pub struct OrderVault;

#[contractimpl]
impl OrderVault {
    pub fn __constructor(
        env: Env,
        owner: Address,
        usdc: Address,
        xlm: Address,
        pool: Address,
        router: Address,
        guard: Address,
        exec_fee: i128,
    ) {
        if usdc == xlm {
            panic_with_error!(&env, Error::SameToken);
        }
        if exec_fee < 0 {
            panic_with_error!(&env, Error::InvalidFee);
        }
        if token::Client::new(&env, &usdc).decimals() != TOKEN_DECIMALS
            || token::Client::new(&env, &xlm).decimals() != TOKEN_DECIMALS
        {
            panic_with_error!(&env, Error::BadDecimals);
        }
        let cfg = Config { owner, usdc, xlm, pool, router, guard, exec_fee };
        let s = env.storage().instance();
        s.set(&DataKey::Config, &cfg);
        s.set(&DataKey::Deposited, &0i128);
        s.set(&DataKey::Reserved, &0i128);
        s.set(&DataKey::NextId, &0u32);
        bump_instance(&env);
    }

    /// Kullanici USDC yatirir; kasa hemen Blend'e yatirir.
    pub fn deposit(env: Env, amount: i128) {
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let cfg = config(&env);
        cfg.owner.require_auth();

        let me = env.current_contract_address();
        token::Client::new(&env, &cfg.usdc).transfer(&cfg.owner, &me, &amount);
        supply_to_pool(&env, &cfg, amount);

        set_i128(&env, DataKey::Deposited, get_i128(&env, DataKey::Deposited) + amount);
        update_stats(&env, |st| st.total_deposited += amount);
        bump_instance(&env);
        Deposited { amount }.publish(&env);
    }

    /// Kullanici emirlere ayrilmamis bakiyesini (faiz dahil) her an cekebilir.
    /// `amount = WITHDRAW_ALL` serbest bakiyenin tamamini ceker; boylece imza ile islem arasinda biriken
    /// faiz kasada kirinti olarak kalmaz.
    pub fn withdraw(env: Env, amount: i128) {
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let cfg = config(&env);
        cfg.owner.require_auth();

        let free = free_of(&env, &cfg);
        let amount = if amount == WITHDRAW_ALL { free } else { amount };
        if amount <= 0 || amount > free {
            panic_with_error!(&env, Error::InsufficientFree);
        }
        let usdc = token::Client::new(&env, &cfg.usdc);
        let before = usdc.balance(&cfg.owner);
        let balance = pool_balance(&env, &cfg);
        if get_i128(&env, DataKey::Reserved) == 0 && amount >= balance {
            // Tamamini cek: Blend bakiyeden fazla istenince tum b_token'lari yakar.
            // Boylece simulasyon ile uygulama arasinda faiz artsa da sonuc ayni kalir
            // (kucuk tutarli "kirinti" kaydi olusmaz).
            withdraw_from_pool(&env, &cfg, balance + SCALE, &cfg.owner);
        } else {
            withdraw_from_pool(&env, &cfg, amount, &cfg.owner);
        }
        let sent = usdc.balance(&cfg.owner) - before;
        reduce_principal(&env, sent);
        update_stats(&env, |st| st.total_withdrawn += sent);
        bump_instance(&env);
        Withdrawn { amount: sent }.publish(&env);
    }

    pub fn place_order(
        env: Env,
        amount_in: i128,
        limit_price: i128,
        min_fill: i128,
        max_impact_bps: u32,
        expiry: u64,
    ) -> u32 {
        let cfg = config(&env);
        cfg.owner.require_auth();
        new_order(&env, &cfg, amount_in, limit_price, min_fill, max_impact_bps, expiry, 0, 0)
    }

    /// Tetikli emir: piyasa fiyati `trigger_price` seviyesine gelince calisir, en kotu fiyat
    /// `limit_price`. Fiyatlar `place_order` ile ayni birimde (1 alinan token icin yatirilan token).
    /// Satis kasasinda (XLM -> USDC) birim "1 USDC icin XLM" oldugundan, XLM dustukce fiyat YUKSELIR:
    /// "XLM 0,15'in altina inerse sat" = tetik 1/0,15, limit biraz daha yukarisi (kayma payi).
    /// `band_bps`: dolumun o anki oracle fiyatindan azami sapmasi (takas ucreti ve fiyat etkisi dahil).
    /// Tetik kalici DEGILDIR: dolum aninda oracle fiyati tetigin gerisine donmusse emir bekler.
    #[allow(clippy::too_many_arguments)]
    pub fn place_stop_order(
        env: Env,
        amount_in: i128,
        trigger_price: i128,
        limit_price: i128,
        min_fill: i128,
        max_impact_bps: u32,
        expiry: u64,
        band_bps: u32,
    ) -> u32 {
        let cfg = config(&env);
        cfg.owner.require_auth();
        if trigger_price <= 0 || limit_price < trigger_price || limit_price > MAX_PRICE {
            panic_with_error!(&env, Error::InvalidPrice);
        }
        if (limit_price - trigger_price) * (BPS as i128) > trigger_price * STOP_MAX_GAP_BPS {
            panic_with_error!(&env, Error::InvalidPrice);
        }
        if !(STOP_BAND_MIN_BPS..=STOP_BAND_MAX_BPS).contains(&band_bps) {
            panic_with_error!(&env, Error::InvalidBand);
        }
        // Oracle iki tokeni de fiyatlayamiyorsa emir hic tetiklenemez; bastan reddet.
        oracle_prices(&env, &cfg);
        new_order(&env, &cfg, amount_in, limit_price, min_fill, max_impact_bps, expiry, trigger_price, band_bps)
    }

    /// Zincirleme emir: normal limit emir; dolunca cikan token `then_vault` kasasina yatirilir ve
    /// orada `then_limit` limitli, `then_duration` saniye gecerli bir emir acilir. Hedef kasanin
    /// sahibi bu kasayi `set_feeder` ile onaylamis olmalidir; aksi halde token cuzdana gider.
    #[allow(clippy::too_many_arguments)]
    pub fn place_order_then(
        env: Env,
        amount_in: i128,
        limit_price: i128,
        min_fill: i128,
        max_impact_bps: u32,
        expiry: u64,
        then_vault: Address,
        then_limit: i128,
        then_impact_bps: u32,
        then_duration: u64,
    ) -> u32 {
        let cfg = config(&env);
        cfg.owner.require_auth();
        if limit_price <= 0 || limit_price > MAX_PRICE {
            panic_with_error!(&env, Error::InvalidPrice);
        }
        if then_limit <= 0
            || then_limit > MAX_PRICE
            || then_impact_bps == 0
            || then_impact_bps > BPS
            || then_duration == 0
            || then_duration > 365 * 86_400
            || then_vault == env.current_contract_address()
        {
            panic_with_error!(&env, Error::InvalidFollowUp);
        }
        // Zincir zararina satis emri acamaz: iki limitin carpimi 1'i gecerse satis fiyati alis fiyatinin
        // altindadir (iki limit birbirinin tersi birimdedir).
        if limit_price * then_limit > SCALE * SCALE {
            panic_with_error!(&env, Error::InvalidFollowUp);
        }
        // Hedef, kardes fabrikada bu sahibin KAYITLI kasasi olmali. Hedefin kendi beyani (get_config)
        // tek basina yeterli degildir: sahte bir sozlesme "sahibim sensin" diyebilir ve oltalama ile
        // imzalatilan bir emrin ciktisini kendine cekebilirdi. Kardes fabrika ayarlanmadiysa zincirleme
        // emir verilemez.
        let registered = match GuardClient::new(&env, &cfg.guard).try_sibling() {
            Ok(Ok(Some(f))) => {
                matches!(GuardClient::new(&env, &f).try_vault_of(&cfg.owner), Ok(Ok(Some(v))) if v == then_vault)
            }
            _ => false,
        };
        if !registered {
            panic_with_error!(&env, Error::InvalidFollowUp);
        }
        // Ayrica hedef bu emrin aldigi tokeni yatirilan token olarak kabul etmeli.
        match FollowVaultClient::new(&env, &then_vault).try_get_config() {
            Ok(Ok(t)) if t.owner == cfg.owner && t.usdc == cfg.xlm => {}
            _ => panic_with_error!(&env, Error::InvalidFollowUp),
        }
        let id = new_order(&env, &cfg, amount_in, limit_price, min_fill, max_impact_bps, expiry, 0, 0);
        let f = FollowUp { vault: then_vault, limit_price: then_limit, max_impact_bps: then_impact_bps, duration: then_duration };
        let key = DataKey::FollowUp(id);
        env.storage().persistent().set(&key, &f);
        env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        id
    }

    /// Sahip, bu kasaya para yatirip emir acabilecek tek kasayi secer (or. kendi alim kasasi).
    /// `None` izni kaldirir.
    pub fn set_feeder(env: Env, feeder: Option<Address>) {
        let cfg = config(&env);
        cfg.owner.require_auth();
        match &feeder {
            Some(f) => env.storage().instance().set(&DataKey::Feeder, f),
            None => env.storage().instance().remove(&DataKey::Feeder),
        }
        bump_instance(&env);
        FeederChanged { feeder }.publish(&env);
    }

    /// Besleyici kasa cagirir: `amount` tokeni `from`dan alir, Blend'e yatirir ve verilen limitle
    /// emir acar. Para yalnizca kasaya girer; sahibin parasi disari cikamaz. Yeni emir oldugu icin
    /// duraklatma kuralina tabidir.
    pub fn receive_and_order(
        env: Env,
        from: Address,
        amount: i128,
        limit_price: i128,
        max_impact_bps: u32,
        expiry: u64,
    ) -> u32 {
        let cfg = config(&env);
        let feeder: Option<Address> = env.storage().instance().get(&DataKey::Feeder);
        if feeder != Some(from.clone()) {
            panic_with_error!(&env, Error::NotFeeder);
        }
        from.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        if GuardClient::new(&env, &cfg.guard).is_paused() {
            panic_with_error!(&env, Error::Paused);
        }
        let me = env.current_contract_address();
        token::Client::new(&env, &cfg.usdc).transfer(&from, &me, &amount);
        supply_to_pool(&env, &cfg, amount);
        set_i128(&env, DataKey::Deposited, get_i128(&env, DataKey::Deposited) + amount);
        update_stats(&env, |st| st.total_deposited += amount);
        Deposited { amount }.publish(&env);

        // Blend b_token yuvarlamasi ve tampon yuzunden emre ayrilabilen tutar `amount`tan biraz az olabilir.
        let room = orderable_of(&env, &cfg);
        let size = if amount < room { amount } else { room };
        if size <= 0 {
            panic_with_error!(&env, Error::InsufficientFree);
        }
        let min_fill = if size / 4 >= SCALE { size / 4 } else { size };
        let id = new_order(&env, &cfg, size, limit_price, min_fill, max_impact_bps, expiry, 0, 0);
        Received { from, amount, order_id: id }.publish(&env);
        id
    }

    /// Sahip acik emrini iptal eder. Suresi dolmus emri HERKES kapatabilir: emir zaten doldurulamaz,
    /// kapatmak yalnizca ayrilan tutari sahibinin serbest bakiyesine geri acar (para yerinden oynamaz).
    pub fn cancel_order(env: Env, order_id: u32) {
        let cfg = config(&env);
        let mut order = load_order(&env, order_id);
        if order.status != OrderStatus::Open {
            panic_with_error!(&env, Error::OrderNotOpen);
        }
        if env.ledger().timestamp() <= order.expiry {
            cfg.owner.require_auth();
        }
        let remaining = order.amount_in - order.filled_in;
        order.status = OrderStatus::Cancelled;
        save_order(&env, order_id, &order);
        set_i128(&env, DataKey::Reserved, get_i128(&env, DataKey::Reserved) - remaining);
        bump_instance(&env);
        OrderCancelled { order_id, remaining }.publish(&env);
    }

    /// Herkes cagirabilir. Cagiran yalnizca emri, dolum miktarini ve dolum ucretinin gidecegi adresi
    /// (`executor`) secer; alici, limit ve tutar sozlesmede sabittir.
    /// Dolum ucreti: takas limitten iyi sonuc verdiyse aradaki farkin en fazla `exec_fee` kadari
    /// `executor`a gider. Sahip her durumda en az limitinin karsiligini alir.
    /// Doner: kullaniciya gonderilen XLM miktari (ucret dusulmus).
    pub fn execute(env: Env, executor: Address, order_id: u32, fill_amount: i128) -> i128 {
        let cfg = config(&env);
        let mut order = load_order(&env, order_id);

        if order.status != OrderStatus::Open {
            panic_with_error!(&env, Error::OrderNotOpen);
        }
        if env.ledger().timestamp() > order.expiry {
            panic_with_error!(&env, Error::OrderExpired);
        }
        let remaining = order.amount_in - order.filled_in;
        if fill_amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        if fill_amount > remaining {
            panic_with_error!(&env, Error::FillTooLarge);
        }
        // Asgari dolum kurali: emrin tamamini bitiren dolum disinda her dolum en az `min_fill` olmali
        // ve geride `min_fill`den kucuk bir kalan birakmamali (yoksa "kalan - 1" dolumuyla emir
        // doldurulmasi anlamsiz bir kirintiyla acik birakilabilirdi).
        let left = remaining - fill_amount;
        if left != 0 && (fill_amount < order.min_fill || left < order.min_fill) {
            panic_with_error!(&env, Error::FillTooSmall);
        }

        let min_out = min_out_for(fill_amount, order.limit_price);
        let me = env.current_contract_address();
        let usdc = token::Client::new(&env, &cfg.usdc);
        let xlm = token::Client::new(&env, &cfg.xlm);
        let router = RouterClient::new(&env, &cfg.router);
        let path = vec![&env, cfg.usdc.clone(), cfg.xlm.clone()];

        // 0a) Tetikli emir: oracle fiyati tetik seviyesine gelmeden dolum yok.
        let oracle = if order.trigger_price > 0 { Some(check_trigger(&env, &cfg, order.trigger_price)) } else { None };
        // 0b) Fiyat etkisi korumasi: buyuk dolumu sig havuza basmayi engeller.
        if order.max_impact_bps < BPS {
            check_impact(&env, &router, &path, fill_amount, order.max_impact_bps);
        }

        // 1) Blend'den cek.
        let usdc_before = usdc.balance(&me);
        withdraw_from_pool(&env, &cfg, fill_amount, &me);
        if usdc.balance(&me) - usdc_before < fill_amount {
            panic_with_error!(&env, Error::PoolShortfall);
        }

        // 2) Soroswap'ta takas et. Router asgari cikisi saglayamazsa hata verir
        //    ve tum islem (Blend cekimi dahil) geri alinir.
        let pair = router.router_pair_for(&cfg.usdc, &cfg.xlm);
        let xlm_before = xlm.balance(&me);
        let deadline = env.ledger().timestamp() + SWAP_DEADLINE_SECS;
        // Bu yetki yalnizca birebir ayni transfere (kasa -> cift, bu miktar) uyar ve bu cagri
        // cercevesi bitince gecersiz olur; baska bir islem icin kullanilamaz.
        env.authorize_as_current_contract(vec![
            &env,
            transfer_auth(&env, &cfg.usdc, &me, &pair, fill_amount),
        ]);
        router.swap_exact_tokens_for_tokens(&fill_amount, &min_out, &path, &me, &deadline);

        // 3) Router'a guvenmeden kendimiz de kontrol ederiz.
        let gross = xlm.balance(&me) - xlm_before;
        if gross < min_out {
            panic_with_error!(&env, Error::LimitNotMet);
        }
        // Sahibin almasi gereken en az miktar: limitin karsiligi (tetikli emirde ayrica oracle bandi).
        let mut floor = min_out;
        // 3b) Tetikli emir: cikan miktar oracle'a gore adil miktardan en fazla secilen bant kadar az olabilir.
        if let Some((p_in, p_out)) = oracle {
            let fair = fill_amount * p_in / p_out;
            let band_min = fair * ((BPS - order.stop_band_bps) as i128);
            if gross * (BPS as i128) < band_min {
                panic_with_error!(&env, Error::PriceDeviation);
            }
            // Yukari yuvarlanir: ucret dusuldukten sonra da bant kosulu saglanir.
            let band_floor = (band_min + (BPS as i128) - 1) / (BPS as i128);
            if band_floor > floor {
                floor = band_floor;
            }
        }
        // 3c) Dolum ucreti: yalnizca `floor`un ustunde kalan kisimdan, en fazla `exec_fee`. Dolumu yapan
        //     ucreti alamiyorsa (or. trustline yok) dolum durmaz; ucret sahibinde kalir.
        let mut fee = gross - floor;
        if fee > cfg.exec_fee {
            fee = cfg.exec_fee;
        }
        let mut out = gross;
        if fee > 0 && executor != me && matches!(xlm.try_transfer(&me, &executor, &fee), Ok(Ok(_))) {
            out = gross - fee;
            ExecFeePaid { order_id, executor, amount: fee }.publish(&env);
        }

        // 4) Cikan token sahibine gider; zincirleme emirde sahibin sectigi kasaya yatirilir.
        //    Aktarim basarisiz olursa (izin yok, duraklatma, yanlis token...) geri alinir ve
        //    token yine sahibin cuzdanina gider. Cuzdan da alamiyorsa (or. trustline yok) token
        //    kasada bekler; dolum bu yuzden durmaz, sahibi `sweep` ile alir.
        let mut delivered = false;
        if let Some(f) = env.storage().persistent().get::<DataKey, FollowUp>(&DataKey::FollowUp(order_id)) {
            env.storage().persistent().extend_ttl(&DataKey::FollowUp(order_id), BUMP_THRESHOLD, BUMP_TO);
            let expiry = env.ledger().timestamp() + f.duration;
            env.authorize_as_current_contract(vec![
                &env,
                transfer_auth(&env, &cfg.xlm, &me, &f.vault, out),
            ]);
            let target = FollowVaultClient::new(&env, &f.vault);
            if let Ok(Ok(new_id)) = target.try_receive_and_order(&me, &out, &f.limit_price, &f.max_impact_bps, &expiry) {
                delivered = true;
                Forwarded { order_id, vault: f.vault.clone(), amount: out, new_order_id: new_id }.publish(&env);
            } else {
                ForwardFailed { order_id, vault: f.vault.clone() }.publish(&env);
            }
        }
        if !delivered && !matches!(xlm.try_transfer(&me, &cfg.owner, &out), Ok(Ok(_))) {
            Held { order_id, amount: out }.publish(&env);
        }

        order.filled_in += fill_amount;
        order.filled_out += out;
        if order.filled_in == order.amount_in {
            order.status = OrderStatus::Filled;
        }
        save_order(&env, order_id, &order);
        set_i128(&env, DataKey::Reserved, get_i128(&env, DataKey::Reserved) - fill_amount);
        reduce_principal(&env, fill_amount);
        update_stats(&env, |st| {
            st.total_spent += fill_amount;
            st.total_received += out;
        });
        bump_instance(&env);

        OrderFilled { order_id, amount_in: fill_amount, amount_out: out }.publish(&env);
        out
    }

    // ---------------- okuma fonksiyonlari ----------------

    pub fn get_config(env: Env) -> Config {
        config(&env)
    }

    pub fn get_order(env: Env, order_id: u32) -> Order {
        load_order(&env, order_id)
    }

    /// Kasada (Blend disinda) duran tokeni sahibine gonderir: cuzdanin alamadigi dolum ciktisi (`Held`)
    /// veya yanlislikla gonderilen token. Yalnizca kasanin iki tokeni icin calisir; kasa baska hicbir
    /// sozlesmeyi cagirmaz.
    pub fn sweep(env: Env, token: Address) -> i128 {
        let cfg = config(&env);
        cfg.owner.require_auth();
        if token != cfg.usdc && token != cfg.xlm {
            panic_with_error!(&env, Error::UnknownToken);
        }
        let me = env.current_contract_address();
        let t = token::Client::new(&env, &token);
        let bal = t.balance(&me);
        if bal > 0 {
            t.transfer(&me, &cfg.owner, &bal);
            Swept { token: token.clone(), amount: bal }.publish(&env);
        }
        bal
    }

    /// Blend'in dagittigi odulleri (BLND) dogrudan sahibin cuzdanina alir.
    pub fn claim_rewards(env: Env, reserve_token_ids: Vec<u32>) -> i128 {
        let cfg = config(&env);
        cfg.owner.require_auth();
        let me = env.current_contract_address();
        let amount = BlendPoolClient::new(&env, &cfg.pool).claim(&me, &reserve_token_ids, &cfg.owner);
        RewardsClaimed { amount }.publish(&env);
        amount
    }

    /// Zincirleme emir ayari (yoksa None).
    pub fn get_follow_up(env: Env, order_id: u32) -> Option<FollowUp> {
        env.storage().persistent().get(&DataKey::FollowUp(order_id))
    }

    pub fn get_feeder(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Feeder)
    }

    /// Yatirilan anapara (cekilen ve harcanan dusulmus).
    pub fn deposited(env: Env) -> i128 {
        get_i128(&env, DataKey::Deposited)
    }

    /// Bugune kadar verilen emir sayisi (emir numaralari 0..order_count).
    pub fn order_count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::NextId).unwrap_or(0)
    }

    pub fn stats(env: Env) -> Stats {
        env.storage().instance().get(&DataKey::Stats).unwrap_or_default()
    }

    pub fn reserved(env: Env) -> i128 {
        get_i128(&env, DataKey::Reserved)
    }

    /// Blend'deki guncel bakiye (anapara + faiz).
    pub fn balance(env: Env) -> i128 {
        pool_balance(&env, &config(&env))
    }

    /// Kazanilan faiz (bakiye - anapara). Havuz zarari varsa negatif olabilir.
    pub fn earned(env: Env) -> i128 {
        pool_balance(&env, &config(&env)) - get_i128(&env, DataKey::Deposited)
    }

    /// Cekilebilir tutar.
    pub fn free_balance(env: Env) -> i128 {
        free_of(&env, &config(&env))
    }

    /// Yeni emre ayrilabilir tutar (serbest bakiye eksi yuvarlama tamponu).
    pub fn orderable_balance(env: Env) -> i128 {
        orderable_of(&env, &config(&env))
    }
}

// ---------------------------------------------------------------------------
// Yardimcilar
// ---------------------------------------------------------------------------

/// Limit fiyattan asgari XLM cikisi (yukari yuvarlanir, kullanici asla eksik almaz).
pub fn min_out_for(amount_in: i128, limit_price: i128) -> i128 {
    (amount_in * SCALE + limit_price - 1) / limit_price
}

/// Tum emir turleri buradan acilir (yetki kontrolu cagiranda).
#[allow(clippy::too_many_arguments)]
fn new_order(
    env: &Env,
    cfg: &Config,
    amount_in: i128,
    limit_price: i128,
    min_fill: i128,
    max_impact_bps: u32,
    expiry: u64,
    trigger_price: i128,
    stop_band_bps: u32,
) -> u32 {
    // Duraklatma yalnizca yeni emirleri durdurur; cekim, iptal ve mevcut emirlerin
    // doldurulmasi her zaman calisir.
    if GuardClient::new(env, &cfg.guard).is_paused() {
        panic_with_error!(env, Error::Paused);
    }
    if amount_in <= 0 || min_fill <= 0 || min_fill > amount_in {
        panic_with_error!(env, Error::InvalidAmount);
    }
    // En fazla MAX_FILLS parca: min_fill >= ceil(amount_in / MAX_FILLS).
    if min_fill < (amount_in - 1) / MAX_FILLS + 1 {
        panic_with_error!(env, Error::InvalidAmount);
    }
    if limit_price <= 0 || limit_price > MAX_PRICE {
        panic_with_error!(env, Error::InvalidPrice);
    }
    if max_impact_bps == 0 || max_impact_bps > BPS {
        panic_with_error!(env, Error::InvalidImpact);
    }
    let now = env.ledger().timestamp();
    if expiry <= now || expiry - now > MAX_ORDER_SECS {
        panic_with_error!(env, Error::InvalidExpiry);
    }
    // Ayni bakiye iki emirde harcanamaz; yuvarlama tamponu emre ayrilamaz.
    if amount_in > orderable_of(env, cfg) {
        panic_with_error!(env, Error::InsufficientFree);
    }

    let id: u32 = env.storage().instance().get(&DataKey::NextId).unwrap_or(0);
    let order = Order {
        amount_in,
        filled_in: 0,
        filled_out: 0,
        limit_price,
        min_fill,
        max_impact_bps,
        expiry,
        status: OrderStatus::Open,
        trigger_price,
        stop_band_bps,
    };
    save_order(env, id, &order);
    env.storage().instance().set(&DataKey::NextId, &(id + 1));
    set_i128(env, DataKey::Reserved, get_i128(env, DataKey::Reserved) + amount_in);
    bump_instance(env);
    OrderPlaced { order_id: id, amount_in, limit_price }.publish(env);
    id
}

fn config(env: &Env) -> Config {
    env.storage().instance().get(&DataKey::Config).unwrap()
}

fn get_i128(env: &Env, key: DataKey) -> i128 {
    env.storage().instance().get(&key).unwrap_or(0)
}

fn set_i128(env: &Env, key: DataKey, value: i128) {
    env.storage().instance().set(&key, &value);
}

/// Anapara once duser; anaparadan fazlasi faizden karsilanmis sayilir.
fn reduce_principal(env: &Env, amount: i128) {
    let d = get_i128(env, DataKey::Deposited);
    set_i128(env, DataKey::Deposited, if amount >= d { 0 } else { d - amount });
}

/// Emirlere ayrilamayan ve acik emir varken cekilemeyen tampon (0,001 token). Blend her cekimde
/// yakilan b_token'i yukari yuvarlar: her dolum rezervden en fazla `ceil(b_rate / 1e12)` birim fazla
/// eksiltir. Bir emir en fazla MAX_FILLS parcada doldugu icin bu tampon, ayni anda acik yuzlerce
/// emrin yuvarlama kaybini karsilar; tampon olmasa son parca "havuzda eksik" hatasiyla bekleyebilirdi.
/// Acik emir kalmayinca tampon da cekilebilir (kullanicinin parasidir, yalnizca emre baglanamaz).
pub const ROUNDING_BUFFER: i128 = 10_000;

fn update_stats(env: &Env, f: impl FnOnce(&mut Stats)) {
    let mut st: Stats = env.storage().instance().get(&DataKey::Stats).unwrap_or_default();
    f(&mut st);
    env.storage().instance().set(&DataKey::Stats, &st);
}

fn free_of(env: &Env, cfg: &Config) -> i128 {
    let reserved = get_i128(env, DataKey::Reserved);
    let buffer = if reserved > 0 { ROUNDING_BUFFER } else { 0 };
    let free = pool_balance(env, cfg) - reserved - buffer;
    if free < 0 {
        0
    } else {
        free
    }
}

/// Yeni emre ayrilabilir tutar: tampon, acik emir olmasa da dusulur (ilk emir de tampon birakir).
fn orderable_of(env: &Env, cfg: &Config) -> i128 {
    let room = pool_balance(env, cfg) - get_i128(env, DataKey::Reserved) - ROUNDING_BUFFER;
    if room < 0 {
        0
    } else {
        room
    }
}

/// Map olarak okunan Blend yapisindan bir alan.
fn field<T: TryFromVal<Env, Val>>(env: &Env, m: &Map<Symbol, Val>, name: &str) -> T {
    let v = match m.get(Symbol::new(env, name)) {
        Some(v) => v,
        None => panic_with_error!(env, Error::BlendFormat),
    };
    match T::try_from_val(env, &v) {
        Ok(t) => t,
        Err(_) => panic_with_error!(env, Error::BlendFormat),
    }
}

/// Kasanin Blend'deki USDC bakiyesi = b_token * b_rate (asagi yuvarlanir).
fn pool_balance(env: &Env, cfg: &Config) -> i128 {
    let pool = BlendPoolClient::new(env, &cfg.pool);
    let reserve = pool.get_reserve(&cfg.usdc);
    let rcfg: Map<Symbol, Val> = field(env, &reserve, "config");
    let rdata: Map<Symbol, Val> = field(env, &reserve, "data");
    let index: u32 = field(env, &rcfg, "index");
    let b_rate: i128 = field(env, &rdata, "b_rate");

    let positions = pool.get_positions(&env.current_contract_address());
    let supply: Map<u32, i128> = field(env, &positions, "supply");
    let b_tokens = supply.get(index).unwrap_or(0);
    b_tokens * b_rate / B_RATE_SCALE
}

/// Dolumun fiyat etkisi: kucuk bir deneme miktarinin birim fiyatiyla karsilastirilir.
/// Iki teklif de takas ucretini icerdigi icin olculen fark yalnizca havuz derinliginden gelir.
fn check_impact(env: &Env, router: &RouterClient, path: &Vec<Address>, fill: i128, max_bps: u32) {
    let probe = fill / 100;
    if probe == 0 {
        return;
    }
    let full = router.router_get_amounts_out(&fill, path).last().unwrap();
    let small = router.router_get_amounts_out(&probe, path).last().unwrap();
    let ideal = small * fill / probe;
    if ideal > 0 && (ideal - full) * (BPS as i128) > ideal * (max_bps as i128) {
        panic_with_error!(env, Error::ImpactTooHigh);
    }
}

/// Piyasa fiyati (1 alinan token icin yatirilan token, 7 ondalik) tetik seviyesinde mi?
/// Fiyat Blend havuzunun oracle'indan okunur. Havuzun anlik fiyati KULLANILMAZ: o, ayni islem
/// icinde al-sat yapilarak oynatilabilir ve tetik sahte sekilde calistirilabilir.
/// Tetik kontrolu; gecerse (yatirilan token fiyati, alinan token fiyati) dondurur.
fn check_trigger(env: &Env, cfg: &Config, trigger: i128) -> (i128, i128) {
    let (p_in, p_out) = oracle_prices(env, cfg);
    // Iki fiyat da ayni oracle'dan (ayni ondalik), oran birimsizdir.
    let market = p_out * SCALE / p_in;
    if market < trigger {
        panic_with_error!(env, Error::TriggerNotMet);
    }
    (p_in, p_out)
}

/// Blend havuzunun oracle'indan iki tokenin guncel fiyati.
fn oracle_prices(env: &Env, cfg: &Config) -> (i128, i128) {
    let pc = BlendPoolClient::new(env, &cfg.pool).get_config();
    let oracle: Address = field(env, &pc, "oracle");
    let o = PriceOracleClient::new(env, &oracle);
    (oracle_price(env, &o, &cfg.usdc), oracle_price(env, &o, &cfg.xlm))
}

fn oracle_price(env: &Env, o: &PriceOracleClient, asset: &Address) -> i128 {
    let now = env.ledger().timestamp();
    match o.try_lastprice(&OracleAsset::Stellar(asset.clone())) {
        Ok(Ok(Some(p))) if p.price > 0 && p.timestamp <= now && now - p.timestamp <= ORACLE_MAX_AGE_SECS => p.price,
        _ => panic_with_error!(env, Error::OracleUnavailable),
    }
}

fn load_order(env: &Env, id: u32) -> Order {
    let key = DataKey::Order(id);
    match env.storage().persistent().get::<DataKey, Order>(&key) {
        Some(o) => {
            env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
            o
        }
        None => panic_with_error!(env, Error::OrderNotFound),
    }
}

fn save_order(env: &Env, id: u32, order: &Order) {
    let key = DataKey::Order(id);
    env.storage().persistent().set(&key, order);
    env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
}

fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

/// Kasanin bir alt cagrida token transferini kendi adina yetkilendirmesi.
fn transfer_auth(
    env: &Env,
    token: &Address,
    from: &Address,
    to: &Address,
    amount: i128,
) -> InvokerContractAuthEntry {
    InvokerContractAuthEntry::Contract(SubContractInvocation {
        context: ContractContext {
            contract: token.clone(),
            fn_name: Symbol::new(env, "transfer"),
            args: (from.clone(), to.clone(), amount).into_val(env),
        },
        sub_invocations: vec![env],
    })
}

fn supply_to_pool(env: &Env, cfg: &Config, amount: i128) {
    let me = env.current_contract_address();
    env.authorize_as_current_contract(vec![
        env,
        transfer_auth(env, &cfg.usdc, &me, &cfg.pool, amount),
    ]);
    let reqs = vec![
        env,
        Request { request_type: BLEND_SUPPLY, address: cfg.usdc.clone(), amount },
    ];
    BlendPoolClient::new(env, &cfg.pool).submit(&me, &me, &me, &reqs);
}

fn withdraw_from_pool(env: &Env, cfg: &Config, amount: i128, to: &Address) {
    let me = env.current_contract_address();
    let reqs = vec![
        env,
        Request { request_type: BLEND_WITHDRAW, address: cfg.usdc.clone(), amount },
    ];
    BlendPoolClient::new(env, &cfg.pool).submit(&me, &me, to, &reqs);
}

#[cfg(test)]
mod test;
