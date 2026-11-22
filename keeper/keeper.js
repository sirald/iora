// Iora keeper botu.
//
// Fabrikalardaki tum kasalari tarar (alim: USDC -> XLM, satis: XLM -> USDC), acik emirleri bulur,
// piyasa limiti karsiladiginda
// `execute` cagirir. Keeper hicbir zaman alici, tutar veya limit belirleyemez; yalnizca
// "simdi dene" der ve dolum miktarini secer. Kotu bir keeper en fazla gecikmeye yol acar.
//
// Kullanim:
//   node keeper.js            surekli calisir: her yeni ledger'da (~5 sn) tarar (SCAN_MODE=interval ile INTERVAL_SEC aralikla)
//   node keeper.js --once     bir kez tarar (birkac tur), cikar
//   node keeper.js --ttl      ayrica kayitlarin suresini uzatir (surekli modda bos ledger'larda, parca parca)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  Asset,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Ayarlar
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const cfg = {
  ...readEnv(path.join(root, "testnet/addr.env")),
  ...readEnv(path.join(root, "testnet/factory.env")),
  ...readEnv(path.join(root, "testnet/factory-sell.env")),
  ...readEnv(path.join(root, "testnet/eski-fabrikalar.env")),
  ...readEnv(path.join(root, "testnet/markets.env")),
  ...readEnv(path.join(root, "testnet/batch.env")),
  ...readEnv(path.join(here, ".env")),
  ...process.env,
};
const PASSPHRASE = cfg.NETWORK_PASSPHRASE || Networks.TESTNET;
// Testnet'te hizli herkese acik RPC once, Stellar'in kendi RPC'si yedek (8.11.2026 olcumu: Gateway ~0,15 sn,
// soroban-testnet.stellar.org 1,5-5 sn). Mainnet'te yalnizca RPC_URL / RPC_FALLBACK kullanilir; testnet
// adreslerine asla dusulmez.
const TESTNET_RPCS = ["https://soroban-rpc.testnet.stellar.gateway.fm", "https://soroban-testnet.stellar.org"];
const RPC_URLS = [...new Set([cfg.RPC_URL, cfg.RPC_FALLBACK, ...(PASSPHRASE === Networks.TESTNET ? TESTNET_RPCS : [])].filter(Boolean))];
if (RPC_URLS.length === 0) {
  console.error("Eksik ayar: RPC_URL");
  process.exit(1);
}
const RPC_URL = RPC_URLS[0];
const INTERVAL_SEC = Number(cfg.INTERVAL_SEC || 30);
// "ledger": Stellar her ~5 sn'de bir ledger kapatir; fiyat ancak o zaman degisir. Keeper her yeni ledger'da tarar.
// "interval": eski davranis, INTERVAL_SEC aralikla.
const SCAN_MODE = (cfg.SCAN_MODE || "ledger").toLowerCase();
const VAULT_LIST_TTL_MS = 60_000; // kasa listesi her taramada degil, dakikada bir yenilenir
// Kotuye kullanima karsi butceler (binlerce minik emirle keeper'i mesgul edip digerlerini geciktiremesin):
// - bir kasa bir turda en fazla MAX_FILLS_PER_VAULT gercek islem denemesi alir,
// - bir kasada bir turda en fazla MAX_ORDERS_PER_VAULT acik emir incelenir (fazlasi sonraki turlarda sirayla),
// - bir kasada bir turda en fazla MAX_NEW_IDS_PER_SCAN yeni emir kesfedilir,
// - MIN_FILL_UNITS altindaki dolumlar denenmez (ucret, dolumun kendisinden pahali olmasin). Birim: 7 ondalik.
const MAX_FILLS_PER_VAULT = Number(cfg.MAX_FILLS_PER_VAULT || 5);
const MAX_ORDERS_PER_VAULT = Number(cfg.MAX_ORDERS_PER_VAULT || 12);
const MAX_NEW_IDS_PER_SCAN = Number(cfg.MAX_NEW_IDS_PER_SCAN || 50);
const MIN_FILL_UNITS = BigInt(cfg.MIN_FILL_UNITS || 1_000_000); // 0,1 token
// USDC ve XLM disindaki coinlerde (or. BTC) 0,1 token cok buyuk bir tutardir; onlarda esik cok daha kucuktur.
const MIN_FILL_OTHER_UNITS = BigInt(cfg.MIN_FILL_OTHER_UNITS || 100);
const minFillFor = (token) => (!token || token === USDC || token === XLM ? MIN_FILL_UNITS : MIN_FILL_OTHER_UNITS);
// Kasalar ayni anda en fazla bu kadar paralel okunur; islemler (imza + gonderim) her zaman tek tek gider.
const SCAN_CONCURRENCY = Math.max(1, Number(cfg.SCAN_CONCURRENCY || 4));
// Vaults with no open order are not read on every scan (thousands of empty vaults would otherwise slow every
// scan down). They are read when an order_placed event names them, and in a rotating sweep of this many per scan.
const SWEEP_PER_SCAN = Math.max(1, Number(cfg.SWEEP_PER_SCAN || 40));
const RPC_TIMEOUT_MS = Number(cfg.RPC_TIMEOUT_MS || 12_000);
const TX_TIMEOUT_SEC = 120;
const TTL_EVERY_SEC = 24 * 3600;
const LOW_BALANCE_XLM = 100;
for (const k of ["FACTORY", "USDC", "XLM", "ROUTER", "KEEPER_SECRET"]) {
  if (!cfg[k]) {
    console.error(`Eksik ayar: ${k}`);
    process.exit(1);
  }
}
const { FACTORY, USDC, XLM, ROUTER } = cfg;
// Alim fabrikasi her zaman; satis fabrikasi (XLM yatirilir, USDC alinir) kuruluysa.
// Kontrat surumu yukseltilince eski fabrikalardaki acik emirler de doldurulmaya devam eder.
// Ek pazarlar (testnet/markets.env): MARKETS=SEMBOL:token:fabrika,...
const MARKET_FACTORIES = String(cfg.MARKETS || "").split(",").map((x) => x.split(":")[2]).filter(Boolean);
const FACTORIES = [...new Set([FACTORY, cfg.FACTORY_SELL, ...MARKET_FACTORIES, ...String(cfg.OLD_FACTORIES || "").split(",")].filter(Boolean).map((s) => s.trim()).filter(Boolean))];
const SYM = { [USDC]: "USDC", [XLM]: "XLM" };
const sym = (a) => SYM[a] || short(a);
const kp = Keypair.fromSecret(cfg.KEEPER_SECRET);
const server = makeServer(RPC_URLS);

// ----- worker accounts: several fills per ledger -----
// One account can have one transaction per ledger, so a single key fills about one order every 5 seconds. Worker
// accounts are extra sending accounts derived from the keeper key (nothing new to store); each sends its own
// transaction in the same ledger. The fill fee always goes to the main keeper account. The main account creates
// the workers and tops them up with XLM for network fees.
const WORKERS = Math.max(0, Math.min(50, Number(cfg.KEEPER_WORKERS ?? 9)));
// ----- batch filler: several fills in one transaction -----
// With BATCH set (testnet/batch.env), fills that are ready at the same time go out together through the batch
// contract's `fill_many`. Measured on testnet and the same on mainnet: 6 fills fit in one transaction (the limit is
// the 16384 bytes of events per transaction), so the default is 5. A fill that fails inside a batch does not stop the
// others; it is then tried alone, which gives the real reason. The network allows about 55 fills per ledger in
// total (580M instructions, about 10.4M per fill), which ten sending accounts reach.
const BATCH = (cfg.BATCH || "").trim();
const BATCH_SIZE = Math.max(1, Math.min(6, Number(cfg.BATCH_SIZE || 5)));
const BATCH_WAIT_MS = Number(cfg.BATCH_WAIT_MS || 400);
const WORKER_START_XLM = String(cfg.WORKER_START_XLM || "10");
const WORKER_MIN_XLM = Number(cfg.WORKER_MIN_XLM || 3);
const workerKey = (i) =>
  Keypair.fromRawEd25519Seed(crypto.createHash("sha256").update(kp.rawSecretKey()).update(`iora-keeper-worker-${i}`).digest());
/** Accounts that send transactions: the main key first, then the workers that are ready. */
const signers = [{ kp, chain: Promise.resolve(), queued: 0 }];

const args = process.argv.slice(2);
const ONCE = args.includes("--once");
const DO_TTL = args.includes("--ttl");

const TG_TOKEN = cfg.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT = cfg.TELEGRAM_CHAT_ID || "";

const LOG_FILE = path.join(here, "keeper.log");
const STATUS_FILE = path.join(here, "durum.json");

// ---------------------------------------------------------------------------
// Yardimcilar
// ---------------------------------------------------------------------------

const SCALE = 10_000_000n;
const BPS = 10_000n;
const DAY_IN_LEDGERS = 17_280;
const ERR = {
  3: "OrderNotFound",
  4: "OrderNotOpen",
  5: "OrderExpired",
  6: "FillTooSmall",
  7: "FillTooLarge",
  8: "LimitNotMet",
  10: "PoolShortfall",
  13: "ImpactTooHigh",
  15: "Paused",
  16: "TriggerNotMet",
  19: "OracleUnavailable",
  20: "PriceDeviation",
  22: "UnknownToken",
  23: "BadDecimals",
  24: "InvalidBand",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (a) => `${a.slice(0, 4)}..${a.slice(-4)}`;
const fmt = (v) => (Number(BigInt(v)) / 1e7).toFixed(4);
// SDK 17'de XDR alanlari ozellik, eski surumlerde fonksiyon: ikisini de oku.
const get = (o, k) => (o != null && typeof o[k] === "function" ? o[k]() : o?.[k]);

// Kayit dosyasina yazilamamasi (or. Windows klasorunde anlik EBUSY) keeper'i asla durdurmamali.
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

// ---------------------------------------------------------------------------
// RPC: ilk sunucu ag hatasi/429/5xx verir ya da RPC_TIMEOUT_MS icinde cevap vermezse ayni cagri siradakinde
// tekrarlanir; bir dakika sonra yeniden ilk sunucu denenir. Sozlesme hatalari gercek cevaptir, tekrarlanmaz.
// ---------------------------------------------------------------------------

// Node'un "fetch failed" hatasi asil sebebi (DNS, baglanti reddi, zaman asimi, sertifika...) e.cause'da tutar;
// SDK bu bilgiyi atar. Sebep mesaja eklenir ki kayitta ve Telegram uyarisinda gorunsun.
if (typeof globalThis.fetch === "function" && !globalThis.__ioraFetchCause) {
  const origFetch = globalThis.fetch;
  globalThis.__ioraFetchCause = true;
  globalThis.fetch = async (...a) => {
    try {
      return await origFetch(...a);
    } catch (e) {
      const c = e && e.cause;
      const why = c && (c.code || c.message);
      if (why && typeof e.message === "string" && !e.message.includes(String(why))) {
        try {
          e.message = `${e.message} (${why})`;
        } catch {}
      }
      throw e;
    }
  };
}

function transientRpc(e) {
  const status = e && e.response && e.response.status;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  return /fetch failed|network|timeout|timed out|aborted|ECONN|socket|EAI_AGAIN|ENOTFOUND|yanit vermedi/i.test(String((e && e.message) || e));
}

// SDK'nin getAccount'u ag hatasini da "Account not found" diye bildirir; bu yuzden ilk sunucu coktugunde yedege
// gecilemez ve hicbir dolum gonderilemezdi. Ayni okuma getLedgerEntries ile yapilir (ag hatasi yedekte denenir).
function accountKey(address) {
  return xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrPublicKey() }));
}

function makeServer(urls) {
  const servers = urls.map((u) => new rpc.Server(u, { allowHttp: u.startsWith("http://"), timeout: RPC_TIMEOUT_MS }));
  let cur = 0;
  let switchedAt = 0;
  let loggedAt = 0;

  async function call(name, args) {
    if (cur !== 0 && Date.now() - switchedAt > 60_000) cur = 0;
    let lastErr;
    for (let i = 0; i < servers.length; i++) {
      const idx = (cur + i) % servers.length;
      let timer;
      try {
        const res = await Promise.race([
          servers[idx][name](...args),
          new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("RPC yanit vermedi")), RPC_TIMEOUT_MS))),
        ]);
        if (idx !== cur) {
          cur = idx;
          switchedAt = Date.now();
          if (Date.now() - loggedAt > 10 * 60_000) {
            loggedAt = Date.now();
            log(`RPC yedek sunucuya gecildi: ${urls[idx]} (ilk sunucu cevap vermiyor; dakikada bir yeniden denenir)`);
          }
        }
        return res;
      } catch (e) {
        lastErr = e;
        if (!transientRpc(e)) throw e;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  async function getAccount(address) {
    const res = await call("getLedgerEntries", [accountKey(address)]);
    const entry = res && res.entries && res.entries[0];
    if (!entry || !entry.val || entry.val.type !== "account") throw new Error(`Account not found: ${address}`);
    return new Account(address, entry.val.value.seqNum.toString());
  }

  return new Proxy(
    {},
    {
      get(_, name) {
        if (name === "getAccount") return getAccount;
        const v = servers[0][name];
        if (name === "then" || typeof name === "symbol" || (v !== undefined && typeof v !== "function")) return v;
        return (...args) => call(name, args);
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Telegram bildirimleri (ayar yoksa sessizce atlanir)
// ---------------------------------------------------------------------------

const lastSent = new Map(); // konu -> zaman (ayni uyariyi tekrar tekrar gondermemek icin)

/** Gonderildiyse true; ayni konu yakin zamanda gonderildiyse false. Telegram takilirsa en fazla 8 sn bekler. */
async function notify(text, { topic = null, everySec = 0 } = {}) {
  if (topic && everySec > 0) {
    const prev = lastSent.get(topic) || 0;
    if (Date.now() / 1000 - prev < everySec) return false;
    lastSent.set(topic, Date.now() / 1000);
  }
  if (!TG_TOKEN || !TG_CHAT) return true;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text: `[Iora] ${text}`, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.error(`telegram hatasi: ${res.status}`);
  } catch (e) {
    console.error(`telegram gonderilemedi: ${e.message}`);
  }
  return true;
}

function errCode(s) {
  const m = String(s).match(/Error\(Contract, #(\d+)\)/);
  return m ? Number(m[1]) : null;
}

function errText(r) {
  if (r.code != null) return ERR[r.code] || `#${r.code}`;
  return String(r.error).split("\n")[0].slice(0, 160);
}

const u32 = (n) => nativeToScVal(n, { type: "u32" });
const i128 = (n) => nativeToScVal(BigInt(n), { type: "i128" });
const addrVec = (list) => xdr.ScVal.scvVec(list.map((a) => new Address(a).toScVal()));

function statusOf(s) {
  if (Array.isArray(s)) return String(s[0]);
  if (s && typeof s === "object" && "tag" in s) return String(s.tag);
  return String(s);
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

/**
 * Okuma (simulasyon) icin islem: hesabin sira numarasi gerekmez, bu yuzden her okumada ayrica
 * getAccount cagrilmaz (RPC cagrisi yariya iner ve "Account not found" aksakliklari okumalari durdurmaz).
 */
function readTx(contractId, method, callArgs) {
  return new TransactionBuilder(new Account(kp.publicKey(), "0"), { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...callArgs))
    .setTimeout(TX_TIMEOUT_SEC)
    .build();
}

/** Gonderilecek islem: guncel sira numarasiyla. */
async function liveTx(contractId, method, callArgs, signer = kp) {
  const account = await server.getAccount(signer.publicKey());
  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...callArgs))
    .setTimeout(TX_TIMEOUT_SEC)
    .build();
}

/** Yalnizca simulasyon: ucretsiz okuma. */
async function read(contractId, method, callArgs = []) {
  const sim = await server.simulateTransaction(readTx(contractId, method, callArgs));
  if (rpc.Api.isSimulationError(sim)) return { ok: false, error: sim.error, code: errCode(sim.error) };
  return { ok: true, value: sim.result ? scValToNative(sim.result.retval) : undefined };
}

/**
 * Imzalar, gonderir ve sonucu bekler. Islem, gecerlilik suresi (TX_TIMEOUT_SEC) bitene kadar izlenir:
 * "zaman asimi" donerse islem kesinlikle zincire yazilmamistir ve tekrar denemek guvenlidir.
 * retry=true: ag islemi hic kabul etmedi (yogunluk, ayni hesapta bekleyen islem); sonraki ledger'da denenir.
 */
async function submit(tx, signer = kp) {
  tx.sign(signer);
  let sent;
  try {
    sent = await server.sendTransaction(tx);
  } catch (e) {
    return { ok: false, retry: true, error: `gonderilemedi: ${e.message}` };
  }
  if (sent.status === "TRY_AGAIN_LATER") return { ok: false, retry: true, error: "ag islemi simdi almadi (TRY_AGAIN_LATER)" };
  if (sent.status === "ERROR") {
    let name = "";
    try {
      const res = get(get(sent, "errorResult"), "result");
      name = res.type || get(res, "switch")?.name || "";
    } catch {}
    return { ok: false, error: `gonderim hatasi ${name}`.trim() };
  }
  // PENDING veya DUPLICATE: islem kuyrukta
  const deadline = Date.now() + (TX_TIMEOUT_SEC + 15) * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    let r;
    try {
      r = await server.getTransaction(sent.hash);
    } catch {
      continue; // gecici RPC hatasi: islemi birakmadan izlemeye devam
    }
    if (r.status === "SUCCESS") {
      let fee = null;
      try {
        fee = BigInt(get(r.resultXdr, "feeCharged"));
      } catch {}
      return { ok: true, hash: sent.hash, fee, value: r.returnValue ? scValToNative(r.returnValue) : undefined };
    }
    if (r.status === "FAILED") return { ok: false, hash: sent.hash, error: "islem agda basarisiz" };
  }
  return { ok: false, hash: sent.hash, error: "zaman asimi (islemin suresi doldu, zincire yazilmadi)" };
}

/**
 * Simulasyonun kaynak tahminine pay ekler: Blend her ledger'da faiz isledigi icin islem zincire
 * yazilana kadar gereken kaynak artabilir; pay olmadan dolum "resource limit exceeded" ile reddedilir
 * ve keeper ucreti bosa oder. (Arayuzdeki padSim ile ayni.)
 */
function padSim(sim) {
  try {
    const b = sim.transactionData;
    const d = b.build();
    const r = get(d, "resources");
    const ins = Number(get(r, "instructions"));
    const rd = Number(get(r, "diskReadBytes") ?? get(r, "readBytes"));
    const wr = Number(get(r, "writeBytes"));
    if (!(ins > 0)) return sim;
    b.setResources(Math.min(Math.ceil(ins * 1.3) + 200_000, 100_000_000), Math.ceil(rd * 1.2) + 2_000, Math.ceil(wr * 1.2) + 1_000);
    const fee = BigInt(String(get(d, "resourceFee")));
    b.setResourceFee(Number((fee * 3n) / 2n + 20_000n));
  } catch (e) {
    log(`kaynak payi eklenemedi: ${e.message}`);
  }
  return sim;
}

// Ayni hesaptan ayni anda tek islem: her gonderen hesabin kendi sirasi vardir. Is, sirasi en kisa olan hesaba verilir;
// boylece birden fazla hesap varsa ayni ledger'da birden fazla islem gider.
function serialized(fn, s = signers[0]) {
  s.queued++;
  const run = () => fn(s.kp);
  const p = s.chain.then(run, run);
  s.chain = p
    .catch(() => {})
    .then(() => {
      s.queued--;
    });
  return p;
}
const freeSigner = () => signers.reduce((a, b) => (b.queued < a.queued ? b : a));

/** Simule et, basariliysa imzala ve gonder. anySigner: dolumlar icin bos olan hesap secilir; digerleri ana hesaptan gider. */
function write(contractId, method, callArgs, anySigner = false) {
  return serialized(
    async (signer) => {
      const tx = await liveTx(contractId, method, callArgs, signer);
      const sim = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) return { ok: false, error: sim.error, code: errCode(sim.error) };
      return submit(rpc.assembleTransaction(tx, padSim(sim)).build(), signer);
    },
    anySigner ? freeSigner() : signers[0],
  );
}

const pendingFills = [];
let flushTimer = null;
let batchTxs = 0;
let batchFills = 0;

/**
 * A fill for a vault whose `execute` takes (executor, order_id, amount, via). Without a batch contract it is sent
 * alone (`single`). With one, it waits a moment for other fills and goes out with them in one transaction.
 * Resolves to the same shape as `write`.
 */
function fillOrder(vault, id, amount, via, single) {
  if (!BATCH || BATCH_SIZE < 2) return single();
  return new Promise((resolve) => {
    pendingFills.push({ vault, id, amount, via, single, resolve });
    if (pendingFills.length >= BATCH_SIZE) flushFills();
    else if (!flushTimer) flushTimer = setTimeout(flushFills, BATCH_WAIT_MS);
  });
}

function flushFills() {
  clearTimeout(flushTimer);
  flushTimer = null;
  while (pendingFills.length) sendBatch(pendingFills.splice(0, BATCH_SIZE));
}

async function sendBatch(items) {
  const alone = async (it) => {
    try {
      it.resolve(await it.single());
    } catch (e) {
      it.resolve({ ok: false, error: e.message });
    }
  };
  if (items.length === 1) return alone(items[0]);
  const entry = (k, v) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v });
  // Struct fields in alphabetical order, as the contract type expects.
  const fills = items.map((it) =>
    xdr.ScVal.scvMap([
      entry("amount", i128(it.amount)),
      entry("order_id", u32(it.id)),
      entry("vault", new Address(it.vault).toScVal()),
      entry("via", it.via ? new Address(it.via).toScVal() : xdr.ScVal.scvVoid()),
    ]),
  );
  let r;
  try {
    r = await write(BATCH, "fill_many", [new Address(kp.publicKey()).toScVal(), xdr.ScVal.scvVec(fills)], true);
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  if (r.retry) {
    for (const it of items) it.resolve(r); // the network did not take it: nothing was paid, next ledger
    return;
  }
  if (!r.ok || !Array.isArray(r.value)) {
    log(`toplu dolum (${items.length} emir) olmadi: ${errText(r)}; emirler tek tek denenecek`);
    await Promise.all(items.map(alone));
    return;
  }
  const done = items.filter((_, i) => BigInt(r.value[i] ?? 0) > 0n).length;
  batchTxs++;
  batchFills += done;
  log(`TOPLU ${done}/${items.length} emir tek islemde doldu ucret=${r.fee !== null ? fmt(r.fee) : "?"} XLM tx=${r.hash}`);
  const share = r.fee !== null && done > 0 ? r.fee / BigInt(done) : null;
  await Promise.all(
    items.map((it, i) => {
      const got = BigInt(r.value[i] ?? 0);
      if (got > 0n) return it.resolve({ ok: true, hash: r.hash, fee: share, value: got });
      return alone(it); // it failed inside the batch: alone, the simulation gives the reason at no cost
    }),
  );
}

/** Creates the worker accounts that do not exist yet and tops up the ones running low. Failures only mean fewer workers. */
async function ensureWorkers() {
  for (let i = 0; i < WORKERS; i++) {
    const w = workerKey(i);
    const pub = w.publicKey();
    try {
      const bal = await read(XLM, "balance", [new Address(pub).toScVal()]);
      const have = bal.ok ? Number(BigInt(bal.value)) / 1e7 : 0;
      let exists = true;
      try {
        await server.getAccount(pub);
      } catch {
        exists = false;
      }
      if (!exists || have < WORKER_MIN_XLM) {
        const op = exists
          ? Operation.payment({ destination: pub, asset: Asset.native(), amount: WORKER_START_XLM })
          : Operation.createAccount({ destination: pub, startingBalance: WORKER_START_XLM });
        const r = await serialized(async (signer) => {
          const account = await server.getAccount(signer.publicKey());
          const tx = new TransactionBuilder(account, { fee: String(Number(BASE_FEE) * 10), networkPassphrase: PASSPHRASE })
            .addOperation(op)
            .setTimeout(TX_TIMEOUT_SEC)
            .build();
          return submit(tx, signer);
        });
        if (!r.ok) {
          log(`yardimci hesap ${i + 1} hazirlanamadi: ${r.error}`);
          continue;
        }
        log(`yardimci hesap ${i + 1} ${exists ? "takviye edildi" : "olusturuldu"}: ${short(pub)} (+${WORKER_START_XLM} XLM)`);
      }
      if (!signers.some((s) => s.kp.publicKey() === pub)) signers.push({ kp: w, chain: Promise.resolve(), queued: 0 });
    } catch (e) {
      log(`yardimci hesap ${i + 1} kontrol edilemedi: ${e.message || e}`);
    }
  }
}

/** Sinirli paralellik: en fazla n is ayni anda. */
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Kasalar ve emirler
// ---------------------------------------------------------------------------

const closed = new Set(); // "kasa:no" (dolmus/iptal/kesin suresi dolmus)
const book = new Map(); // kasa -> { next: siradaki emir no, open: acik olabilecek emir nolari, cursor: sira }

/** Fabrikanin kova sayisi; sira numarali eski fabrikalarda 0 (fonksiyon yok). Fabrika basina bir kez sorulur. */
const bucketCache = new Map();
async function bucketsOf(f) {
  if (bucketCache.has(f)) return bucketCache.get(f);
  const r = await read(f, "bucket_count");
  // Simulasyon hatasi = fonksiyon yok (eski fabrika). Ag hatasi istisna firlatir ve buraya gelmez.
  const n = r.ok ? Number(r.value) : 0;
  bucketCache.set(f, n);
  return n;
}
/** Kovali fabrikanin son okunan listesi: kasa sayisi degismedikce 16 okuma yerine tek okuma yeter. */
const bucketLists = new Map(); // fabrika -> { count, vaults }

// Version 9 factories keep each bucket as a chain (newest vault first, each entry pointing to the one before).
const optAddr = (a) => (a ? new Address(String(a)).toScVal() : xdr.ScVal.scvVoid());
const chainCache = new Map(); // factory -> true if it has `heads` (version 9)
async function isChained(f) {
  if (chainCache.has(f)) return chainCache.get(f);
  const r = await read(f, "heads", [u32(0), u32(1)]);
  chainCache.set(f, r.ok); // a simulation error means the function does not exist; network errors throw
  return r.ok;
}
const chainLists = new Map(); // factory -> { count, lens: bucket -> length, owners: Set, vaults: [] }

/** Reads only what is new: buckets whose length grew, from the newest entry down to the first one already known. */
async function listChained(f) {
  const c = await read(f, "vault_count");
  if (!c.ok) throw new Error(errText(c));
  const have = chainLists.get(f) ?? { count: -1, lens: new Map(), owners: new Set(), vaults: [] };
  if (have.count === Number(c.value)) return have.vaults;
  for (let start = 0; start < 256; start += 64) {
    const hs = await read(f, "heads", [u32(start), u32(64)]);
    if (!hs.ok) throw new Error(errText(hs));
    for (const h of hs.value) {
      const idx = Number(h.index);
      const len = Number(h.len);
      if (have.lens.get(idx) === len) continue;
      let from = null;
      walk: for (let page = 0; page < 100_000; page++) {
        const pg = await read(f, "bucket", [u32(idx), optAddr(from), u32(40)]);
        if (!pg.ok) throw new Error(errText(pg));
        if (!pg.value.length) break;
        for (const e of pg.value) {
          const owner = String(e.owner);
          if (have.owners.has(owner)) break walk;
          have.owners.add(owner);
          have.vaults.push(String(e.vault));
        }
        const prev = pg.value[pg.value.length - 1].prev;
        if (!prev) break;
        from = String(prev);
      }
      have.lens.set(idx, len);
    }
  }
  have.count = Number(c.value);
  chainLists.set(f, have);
  return have.vaults;
}

async function listVaults() {
  // Bir fabrika okunamazsa digerlerinin emirleri yine doldurulur; hepsi okunamazsa hata verilir.
  const out = [];
  const fails = [];
  for (const f of FACTORIES) {
    try {
      // Surum 6 fabrikalari kasalari kovalarda tutar (sira numarasi yok): 16'sar kova okunur.
      const buckets = await bucketsOf(f);
      if (buckets > 0 && (await isChained(f))) {
        out.push(...(await listChained(f)));
        continue;
      }
      if (buckets > 0) {
        const c = await read(f, "vault_count");
        if (!c.ok) throw new Error(errText(c));
        const have = bucketLists.get(f);
        if (have && have.count === Number(c.value)) {
          out.push(...have.vaults);
          continue;
        }
        const vaults = [];
        for (let start = 0; start < buckets; start += 16) {
          const r = await read(f, "vaults_in", [u32(start), u32(16)]);
          if (!r.ok) throw new Error(errText(r));
          vaults.push(...r.value);
        }
        bucketLists.set(f, { count: Number(c.value), vaults });
        out.push(...vaults);
        continue;
      }
      // Eski fabrikalar en fazla 50'lik sayfa dondurur (daha eskiler 100); 50 ikisinde de calisir.
      for (let start = 0; ; start += 50) {
        const r = await read(f, "vaults", [u32(start), u32(50)]);
        if (!r.ok) throw new Error(errText(r));
        out.push(...r.value);
        if (r.value.length < 50) break;
      }
    } catch (e) {
      fails.push(`${short(f)}: ${e.message || e}`);
      log(`kasa listesi okunamadi (${short(f)}): ${e.message || e}`);
    }
  }
  if (fails.length === FACTORIES.length) throw new Error(`kasa listesi okunamadi (${fails.join("; ")})`);
  return out;
}

/** Kasanin token cifti: "usdc" alani yatirilan/harcanan token, "xlm" alani alinan token. */
const pairOf = new Map();
async function pair(vault) {
  if (pairOf.has(vault)) return pairOf.get(vault);
  const r = await read(vault, "get_config");
  if (!r.ok) throw new Error(`${short(vault)} ayarlari okunamadi: ${errText(r)}`);
  // Surum 5 kasalari: `execute` dolumu yapanin adresini alir ve ona limitten iyi gelen kisimdan en fazla
  // `exec_fee` (alinan token) oder. Eski kasalarda bu alan yoktur; eski imza kullanilir.
  const fee = r.value.exec_fee;
  // Surum 7 (tek, cok varlikli kasa): tokenlar kasada degil EMIRDE yazar (sell/buy); dolum ucreti ust siniri
  // alinan tokene gore `fees` tablosundan okunur. `execute` imzasi surum 5 ile aynidir.
  const fees = r.value.fees;
  // Surum 8: `execute` dorduncu bir arguman alir (ara token, yoksa bos). Kasa surumunu `version` bildirir;
  // surum 7 kasalarinda bu fonksiyon yoktur.
  let v8 = false;
  if (fees !== undefined) {
    const ver = await read(vault, "version");
    v8 = ver.ok && Number(ver.value) >= 8;
  }
  const p =
    fees !== undefined
      ? { v7: true, v5: true, v8, fees: Object.fromEntries(Object.entries(fees).map(([k, v]) => [String(k), BigInt(v)])) }
      : { tin: String(r.value.usdc), tout: String(r.value.xlm), v5: fee !== undefined, fee: fee !== undefined ? BigInt(fee) : 0n };
  pairOf.set(vault, p);
  return p;
}

/**
 * Bu turda incelenecek acik emirler. Yeni emirler OrderNotFound gelene kadar kesfedilir (turda en fazla
 * MAX_NEW_IDS_PER_SCAN); acik emirlerden en fazla MAX_ORDERS_PER_VAULT tanesi sirayla incelenir, boylece
 * cok emirli bir kasa digerlerini bekletmez ve tum emirleri birkac turda bir mutlaka bakilir.
 */
// ----- which vaults to read on this scan -----
const seenVaults = new Set(); // read at least once since start
const dirty = new Set(); // an order_placed event named them; read on the next scan
let sweepAt = 0; // position of the rotating sweep over idle vaults
let eventLedger = 0; // last ledger whose events were read (0: start from the current ledger)
let eventLogAt = 0;
// Every event that changes a vault's order book: a new order, a fill (by anyone) and a cancellation.
const ORDER_TOPICS = ["order_placed", "order_filled", "order_cancelled"].map((n) => [xdr.ScVal.scvSymbol(n).toXDR("base64"), "*"]);
let eventsOk = false; // true while the events of every ledger since the last scan have been read

/** Marks the vaults that placed an order since the last scan. Any failure is harmless: the sweep finds them later. */
async function collectPlaced(known) {
  try {
    const latest = (await server.getLatestLedger()).sequence;
    if (!eventLedger) {
      eventLedger = latest; // the first scan reads every vault anyway
      eventsOk = false;
      return;
    }
    if (latest <= eventLedger) return;
    const filters = [{ type: "contract", topics: ORDER_TOPICS }];
    let cursor = null;
    let complete = false;
    for (let page = 0; page < 50; page++) {
      const r = await server.getEvents(cursor ? { filters, cursor, limit: 200 } : { filters, startLedger: eventLedger + 1, limit: 200 });
      const events = (r && r.events) || [];
      for (const ev of events) {
        const c = ev.contractId;
        const id = typeof c === "string" ? c : c && typeof c.contractId === "function" ? c.contractId() : String(c ?? "");
        if (known.has(id)) dirty.add(id);
      }
      if (events.length < 200) {
        complete = true;
        break;
      }
      const last = events[events.length - 1];
      cursor = r.cursor || last.pagingToken || last.id;
      if (!cursor) break;
    }
    eventLedger = latest;
    eventsOk = complete; // a flood beyond 10,000 events: fall back to reading vaults with open orders directly
  } catch (e) {
    eventLedger = 0;
    eventsOk = false;
    if (Date.now() - eventLogAt > 10 * 60_000) {
      eventLogAt = Date.now();
      log(`emir olaylari okunamadi (bos kasalar sirayla taranmaya devam eder): ${e.message || e}`);
    }
  }
}

/** The vaults to read now: new ones, ones named by an event, ones with open orders, plus a slice of the idle rest. */
async function vaultsToRead(all) {
  await collectPlaced(new Set(all));
  const now = [];
  const idle = [];
  for (const v of all) {
    const st = book.get(v);
    // While events are being read, a vault's orders are re-read only when something happened in it; the cached
    // copy is used for the price check. Without events, vaults with open orders are re-read on every scan.
    if (!seenVaults.has(v) || dirty.has(v) || (st && (st.more || (!eventsOk && st.open.length > 0)))) now.push(v);
    else idle.push(v);
  }
  const n = Math.min(SWEEP_PER_SCAN, idle.length);
  if (sweepAt >= idle.length) sweepAt = 0;
  for (let i = 0; i < n; i++) now.push(idle[(sweepAt + i) % idle.length]);
  sweepAt = idle.length ? (sweepAt + n) % idle.length : 0;
  return now;
}

async function ordersToCheck(vault) {
  const st = book.get(vault) ?? { next: 0, open: [], cursor: 0 };
  if (!st.orders) st.orders = new Map(); // id -> last read copy of every open order
  book.set(vault, st);
  const fresh = new Map();
  st.more = true; // stays true only if the loop below ends by reaching its cap (more new orders may follow)
  for (let found = 0; found < MAX_NEW_IDS_PER_SCAN; found++) {
    const r = await read(vault, "get_order", [u32(st.next)]);
    if (!r.ok) {
      if (r.code === 3) {
        st.more = false;
        break;
      }
      throw new Error(`${short(vault)} emir ${st.next} okunamadi: ${errText(r)}`);
    }
    if (statusOf(r.value.status) === "Open") {
      fresh.set(st.next, r.value);
      st.open.push(st.next);
    } else closed.add(`${vault}:${st.next}`);
    st.next++;
  }
  for (const [id, o] of fresh) st.orders.set(id, { id, ...o });
  st.open = st.open.filter((id) => !closed.has(`${vault}:${id}`));
  const n = st.open.length;
  const take = Math.min(n, MAX_ORDERS_PER_VAULT);
  const ids = [];
  for (let i = 0; i < take; i++) ids.push(st.open[(st.cursor + i) % n]);
  st.cursor = n ? (st.cursor + take) % n : 0;

  const orders = [];
  for (const id of ids) {
    let o = fresh.get(id);
    if (!o) {
      const r = await read(vault, "get_order", [u32(id)]);
      if (!r.ok) continue;
      o = r.value;
    }
    if (statusOf(o.status) !== "Open") {
      closed.add(`${vault}:${id}`);
      continue;
    }
    st.orders.set(id, { id, ...o });
    orders.push({ id, ...o });
  }
  st.open = st.open.filter((id) => !closed.has(`${vault}:${id}`));
  for (const id of st.orders.keys()) if (!st.open.includes(id)) st.orders.delete(id);
  return orders;
}

// ----- local price check -----
// Asking the network for a quote per order per scan does not scale. Instead the reserves of each Soroswap pool are
// read once per scan and the output of a swap is computed here with the pool's own formula (constant product,
// 0.3% fee). An order whose limit is clearly not met costs no network call at all. Anything close to its limit
// still goes through the network quote and the contract's own checks, so this only decides what to skip. The
// formula is compared with a real quote for each pair every 30 minutes and switched off for that pair if it differs.
const pairCache = new Map(); // "a|b" -> { pair, token0 } | { none: true, at }
const reservesNow = new Map(); // per scan: pair -> [r0, r1] | null
const localCheck = new Map(); // "tin|tout" -> { okAt } | { offUntil }
const LOCAL_RECHECK_MS = 30 * 60_000;
let localSkips = 0;

async function poolOf(a, b) {
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  const c = pairCache.get(key);
  if (c && (!c.none || Date.now() - c.at < 10 * 60_000)) return c.none ? null : c;
  let info = { none: true, at: Date.now() };
  try {
    const p = await read(ROUTER, "router_pair_for", [new Address(a).toScVal(), new Address(b).toScVal()]);
    if (p.ok && p.value) {
      const t0 = await read(String(p.value), "token_0");
      if (t0.ok && t0.value) info = { pair: String(p.value), token0: String(t0.value) };
    }
  } catch {}
  pairCache.set(key, info);
  return info.none ? null : info;
}

/** Output of swapping `amount` of `a` into `b` in their pool, or null when the pool cannot be read. */
async function hopOut(amount, a, b) {
  const info = await poolOf(a, b);
  if (!info) return null;
  let r = reservesNow.get(info.pair);
  if (r === undefined) {
    r = null;
    try {
      const got = await read(info.pair, "get_reserves");
      if (got.ok && got.value && got.value.length === 2) r = [BigInt(got.value[0]), BigInt(got.value[1])];
    } catch {}
    reservesNow.set(info.pair, r);
  }
  if (!r) return null;
  const [rin, rout] = info.token0 === a ? [r[0], r[1]] : [r[1], r[0]];
  if (rin <= 0n || rout <= 0n) return 0n;
  const x = amount * 997n;
  return (x * rout) / (rin * 1000n + x);
}

/** Best output over the same routes `bestRoute` tries, computed locally; null when no route could be computed. */
async function localBest(amount, tin, tout, vias) {
  let best = null;
  for (const via of vias) {
    let q = await hopOut(amount, tin, via || tout);
    if (q !== null && via) q = q > 0n ? await hopOut(q, via, tout) : 0n;
    if (q !== null && (best === null || q > best)) best = q;
  }
  return best;
}

async function quotePath(amount, path) {
  const r = await read(ROUTER, "router_get_amounts_out", [i128(amount), addrVec(path)]);
  if (!r.ok) return null;
  return BigInt(r.value[r.value.length - 1]);
}
const quote = (amount, tin, tout) => quotePath(amount, [tin, tout]);
const pathOf = (tin, tout, via) => (via ? [tin, via, tout] : [tin, tout]);
/**
 * Surum 8 kasalarinda dolum tek bir ara token uzerinden de yapilabilir (or. USDC -> XLM -> BTC). Verilen
 * miktar icin en cok cikis veren yolu secer: { q, via } (via null = dogrudan cift). Hicbir yol yoksa null.
 */
async function bestRoute(amount, tin, tout, vias) {
  let best = null;
  for (const via of vias) {
    const q = await quotePath(amount, pathOf(tin, tout, via));
    if (q !== null && (best === null || q > best.q)) best = { q, via };
  }
  return best;
}

const minOut = (fill, limit) => (fill * SCALE + limit - 1n) / limit;

/** Sozlesmedeki fiyat etkisi hesabinin aynisi. */
async function impactBps(fill, tin, tout, via = null) {
  const probe = fill / 100n;
  if (probe === 0n) return 0n;
  const full = await quotePath(fill, pathOf(tin, tout, via));
  const small = await quotePath(probe, pathOf(tin, tout, via));
  if (full === null || small === null) return null;
  const ideal = (small * fill) / probe;
  if (ideal <= 0n) return 0n;
  return ((ideal - full) * BPS) / ideal;
}

/**
 * Denenecek dolum miktarlari: kalanin tamami, sonra yarilarak alt sinira kadar (buyukten kucuge).
 * Kontrat (surum 4) kismi dolumun geride asgari dolumdan kucuk bir kalan birakmasini reddeder
 * (FillTooSmall); o boyutlar hic denenmez.
 */
function candidates(remaining, floor, minFill = 0n) {
  const list = [];
  for (let f = remaining; f > 0n; f /= 2n) {
    if (f === remaining) list.push(f);
    else if (f < floor) break;
    else if (remaining - f >= minFill) list.push(f);
  }
  return list;
}

const stats = { fills: 0, failures: 0, lastError: null, feesStroop: 0n };
const lastNote = new Map();
// "kasa:no" -> { n, until }: on kontrolleri gecip kontrattan surekli ret alan emir. Her ret serisinde
// bekleme ikiye katlanir (1, 2, 4 ... en fazla 60 tur); boylece takili bir emir RPC'yi ve kaydi bosa harcamaz.
const stuck = new Map();
let scanNo = 0;

function waiting(vault, o, tag, remaining, tin, reason) {
  // Her ledger'da taranirken kayit dosyasi sismesin: bekleme nedeni degismedikce tekrar yazilmaz.
  const note = `${tag} bekliyor (kalan ${fmt(remaining)} ${sym(tin)}): ${reason || "uygun dolum yok"}`;
  const key = `${vault}:${o.id}`;
  const shape = note.replace(/[\d.]+(?= <| >| USDC| XLM| bps)/g, "");
  const prev = lastNote.get(key);
  if (!prev || prev.shape !== shape || Date.now() - prev.at > 10 * 60_000) {
    lastNote.set(key, { shape, at: Date.now() });
    log(note);
  }
  return "waiting";
}

function priceNoteFor(tin, tout, fill, q, limit) {
  if (tin === USDC) return `piyasa ${(Number(fill) / Number(q)).toFixed(4)} > limit ${fmt(limit)} USDC/XLM`;
  // Satis: limit "1 USDC icin en fazla kac XLM"; kullaniciya "1 XLM icin en az kac USDC" gosterilir.
  const target = 1e7 / Number(limit);
  return `piyasa ${(Number(q) / Number(fill)).toFixed(4)} < hedef ${target.toFixed(4)} ${sym(tout)}/${sym(tin)}`;
}

async function tryOrder(vault, o, ctx = { net: 0 }) {
  const pc = await pair(vault);
  const tin = pc.v7 ? String(o.sell) : pc.tin;
  const tout = pc.v7 ? String(o.buy) : pc.tout;
  const v5 = pc.v5;
  const fee = pc.v7 ? (pc.fees[tout] ?? 0n) : pc.fee;
  // Ara token adaylari: yalnizca surum 8 ve cift XLM/USDC degilse (ikisi de fabrikanin izinli listesindedir).
  const vias = [null, ...(pc.v8 ? [XLM, USDC].filter((t) => t !== tin && t !== tout) : [])];
  const execArgs = (amount, via = null) =>
    pc.v8
      ? [new Address(kp.publicKey()).toScVal(), u32(o.id), i128(amount), via ? new Address(via).toScVal() : xdr.ScVal.scvVoid()]
      : v5
        ? [new Address(kp.publicKey()).toScVal(), u32(o.id), i128(amount)]
        : [u32(o.id), i128(amount)];
  const side = tin === USDC ? "alim" : "satis";
  const tag = `${short(vault)} #${o.id} (${side})`;
  const key = `${vault}:${o.id}`;
  const now = Math.floor(Date.now() / 1000);
  const expiry = Number(o.expiry);
  if (now > expiry) {
    // Bilgisayarin saati ileri olabilir: emir ancak 10 dakikalik paydan sonra kalici olarak kapatilir.
    if (now > expiry + 600) closed.add(key);
    return waiting(vault, o, tag, BigInt(o.amount_in) - BigInt(o.filled_in), tin, "suresi dolmus");
  }
  const remaining = BigInt(o.amount_in) - BigInt(o.filled_in);
  const held = stuck.get(key);
  if (held && scanNo < held.until) return "waiting";
  const limit = BigInt(o.limit_price);
  const minFill = BigInt(o.min_fill);
  const maxImpact = BigInt(o.max_impact_bps);
  const trigger = BigInt(o.trigger_price ?? 0);
  const sizes = candidates(remaining, minFill > minFillFor(tin) ? minFill : minFillFor(tin), minFill);
  const smallest = sizes[sizes.length - 1];

  // Local price check first: no network call for an order whose limit is clearly not met (see "local price check").
  const lk = `${tin}|${tout}`;
  const lc = localCheck.get(lk);
  const est = lc && lc.offUntil > Date.now() ? null : await localBest(smallest, tin, tout, vias);
  const trusted = !!(lc && lc.okAt && Date.now() - lc.okAt < LOCAL_RECHECK_MS);
  if (est !== null && trusted && (est * 1005n) / 1000n + 2n < minOut(smallest, limit)) {
    localSkips++;
    return waiting(vault, o, tag, remaining, tin, priceNoteFor(tin, tout, smallest, est, limit));
  }
  ctx.net++; // from here on the order costs network calls

  // Tetikli emir (zarar kes): tetigi kontrat Blend oracle'indan kontrol eder. Once tek bir simulasyonla
  // tetik sorulur; gelmediyse ("tetik yok" 16, "oracle yok" 19) fiyat sorgusu hic yapilmadan beklenir.
  if (trigger > 0n) {
    const pre = await read(vault, "execute", execArgs(smallest));
    if (!pre.ok && pre.code === 16) return waiting(vault, o, tag, remaining, tin, "tetik fiyati (oracle) henuz gelmedi");
    if (!pre.ok && pre.code === 19) return waiting(vault, o, tag, remaining, tin, "oracle fiyati alinamadi");
  }

  // En kucuk dolum bile limiti karsilamiyorsa buyukleri de karsilamaz (havuzda buyuk islem daha kotu
  // fiyat alir): beklemedeki bir emir her ledger'da tek fiyat sorgusuna mal olur.
  const rSmall = await bestRoute(smallest, tin, tout, vias);
  const qSmall = rSmall ? rSmall.q : null;
  if (qSmall === null) {
    log(`${tag} fiyat alinamadi`);
    return "error";
  }
  if (est !== null && !trusted) {
    // Compare the local formula with the real quote for this pair before relying on it.
    const diff = est > qSmall ? est - qSmall : qSmall - est;
    const tol = qSmall / 300n > 2n ? qSmall / 300n : 2n;
    if (diff <= tol) localCheck.set(lk, { okAt: Date.now() });
    else {
      localCheck.set(lk, { offUntil: Date.now() + LOCAL_RECHECK_MS });
      log(`yerel fiyat hesabi ${sym(tin)}->${sym(tout)} icin tutmadi (yerel ${est}, ag ${qSmall}); bu cift 30 dk ag uzerinden sorulacak`);
    }
  }
  if (qSmall < minOut(smallest, limit)) return waiting(vault, o, tag, remaining, tin, priceNoteFor(tin, tout, smallest, qSmall, limit));

  let note = "";
  let rejected = null; // kontratin reddettigi ilk dolum (ayni turda daha kucukler de denenir)
  for (const fill of sizes) {
    const route = fill === smallest ? rSmall : await bestRoute(fill, tin, tout, vias);
    const q = route ? route.q : null;
    const via = route ? route.via : null;
    if (q === null) {
      log(`${tag} fiyat alinamadi`);
      return "error";
    }
    if (q < minOut(fill, limit)) {
      note = note || priceNoteFor(tin, tout, fill, q, limit);
      continue;
    }
    // Dolum ucreti yalnizca limitten iyi gelen kisimdan odenir. O kisim ucretin tamamini karsilamiyorsa
    // dolum ag masrafini cikarmaz: fiyat limiti biraz daha gecene kadar beklenir. Boylece cok sayida
    // kucuk emirle keeper'in bakiyesi tuketilemez (asgari emir tutari gerekmeden).
    if (fee > 0n && q - minOut(fill, limit) < fee) {
      note = note || `limit karsilandi ama dolum ucreti (${fmt(fee)} ${sym(tout)}) henuz cikmiyor (dolum ${fmt(fill)})`;
      continue;
    }
    if (maxImpact < BPS) {
      const imp = await impactBps(fill, tin, tout, via);
      if (imp !== null && imp > maxImpact) {
        note = `fiyat etkisi ${imp} bps > ${maxImpact} bps (dolum ${fmt(fill)})`;
        continue;
      }
    }
    const single = () => write(vault, "execute", execArgs(fill, via), true);
    const r = pc.v8 ? await fillOrder(vault, o.id, fill, via, single) : await single();
    dirty.add(vault); // whatever happened, read this vault's orders again on the next scan
    if (r.ok) {
      stats.fills++;
      stuck.delete(key);
      if (r.fee !== null) stats.feesStroop += r.fee;
      log(
        `DOLDU ${tag} ${fmt(fill)} ${sym(tin)} -> ${via ? `${sym(via)} -> ` : ""}${fmt(r.value)} ${sym(tout)}` +
          ` ucret=${r.fee !== null ? fmt(r.fee) : "?"} XLM tx=${r.hash}`,
      );
      const left = remaining - fill;
      await notify(
        `${side === "alim" ? "Alim" : "Satis"} emri doldu: kasa ${short(vault)} #${o.id}\n` +
          `${fmt(fill)} ${sym(tin)} -> ${fmt(r.value)} ${sym(tout)}` +
          (left > 0n ? `\nKalan: ${fmt(left)} ${sym(tin)}` : "\nEmir tamamen doldu.") +
          `\nhttps://stellar.expert/explorer/testnet/tx/${r.hash}`,
      );
      return "filled";
    }
    if (r.retry) {
      // Ag islemi kabul etmedi: ucret odenmedi, sonraki ledger'da yeniden denenir.
      log(`${tag}: ${r.error}; sonraki ledger'da yeniden denenecek`);
      return "busy";
    }
    if (r.code === 16) return waiting(vault, o, tag, remaining, tin, "tetik fiyati (oracle) henuz gelmedi");
    if (r.code === 19) return waiting(vault, o, tag, remaining, tin, "oracle fiyati alinamadi");
    if (r.code === 4 || r.code === 5) {
      closed.add(key); // emir artik acik degil veya zincire gore suresi dolmus
      return "closed";
    }
    stats.failures++;
    stats.lastError = `${tag}: ${errText(r)}`;
    if ([8, 10, 13, 20].includes(r.code)) {
      // Kendi fiyat ve etki kontrolumuz gecti ama kontrat reddetti: fiyat bu arada oynamis olabilir,
      // daha kucuk dolum denenir.
      rejected = rejected || { fill, r };
      continue;
    }
    // Beklenmeyen hata (or. islem zincire girdi ama basarisiz oldu): ayni emir her turda yeniden
    // denenip ucret yakmasin diye o da dinlendirilir (1, 2, 4 ... en fazla 60 tur).
    const n = (held?.n || 0) + 1;
    const rest = Math.min(2 ** (n - 1), 60);
    stuck.set(key, { n, until: scanNo + rest });
    log(`${tag} dolum ${fmt(fill)} basarisiz: ${errText(r)}; ${rest} tur sonra yeniden denenecek`);
    await notify(`Dolum hatasi ${tag}: ${errText(r)}`, { topic: `err:${tag}`, everySec: 3600 });
    return "error";
  }
  if (rejected) {
    // Hicbir boyut gecmedi: emir bir sure dinlendirilir. Uzun sure boyle kalirsa (or. hata baska bir
    // kontrattan geliyor, sahibinin trustline'i yok) bir kez haber verilir.
    const n = (held?.n || 0) + 1;
    const rest = Math.min(2 ** (n - 1), 60);
    stuck.set(key, { n, until: scanNo + rest });
    log(`${tag} dolum ${fmt(rejected.fill)} kontrat reddetti: ${errText(rejected.r)}; ${rest} tur sonra yeniden denenecek`);
    if (n === 7) {
      await notify(
        `Emir ${tag} on kontrolleri geciyor ama kontrat surekli reddediyor (${errText(rejected.r)}). Kontrol edin: ` +
          String(rejected.r.error).split("\n")[0].slice(0, 200),
        { topic: `stuck:${key}`, everySec: 6 * 3600 },
      );
    }
    return "waiting";
  }
  return waiting(vault, o, tag, remaining, tin, note);
}

// ---------------------------------------------------------------------------
// TTL bakimi: uzun sure dokunulmayan kayitlarin arsive dusmemesi icin
// ---------------------------------------------------------------------------

/** Bir okuma cagrisinin simulasyonundan, dokundugu kayitlarin anahtarlarini alir. */
async function footprintOf(contractId, method, callArgs) {
  const sim = await server.simulateTransaction(readTx(contractId, method, callArgs));
  if (rpc.Api.isSimulationError(sim)) return [];
  const d = sim.transactionData;
  // SDK surumleri arasinda farkli erisim bicimleri olabildigi icin iki yol da denenir.
  if (typeof d.getReadOnly === "function") return [...d.getReadOnly(), ...d.getReadWrite()];
  const fp = get(get(d.build(), "resources"), "footprint");
  return [...get(fp, "readOnly"), ...get(fp, "readWrite")];
}

function keyId(k) {
  if (typeof k.toXDR === "function") return k.toXDR("base64");
  return JSON.stringify(k, (_, v) => (typeof v === "bigint" ? v.toString() : v));
}

/** Bir fabrikanin kayitlari: sayfa sayfa is listesi. */
async function factoryTtlJobs() {
  const jobs = [];
  for (const f of FACTORIES) {
    const buckets = await bucketsOf(f);
    if (buckets > 0 && (await isChained(f))) {
      // Version 9: one job per page of 40 along each bucket's chain (`from` is the owner the page starts at).
      for (let start = 0; start < 256; start += 64) {
        const hs = await read(f, "heads", [u32(start), u32(64)]);
        if (!hs.ok) continue;
        for (const h of hs.value) {
          let from = null;
          for (let page = 0; page < 100_000; page++) {
            jobs.push({ kind: "factory", f, chain: true, bucket: Number(h.index), from });
            const pg = await read(f, "bucket", [u32(Number(h.index)), optAddr(from), u32(40)]);
            if (!pg.ok || !pg.value.length) break;
            const prev = pg.value[pg.value.length - 1].prev;
            if (!prev) break;
            from = String(prev);
          }
        }
      }
      continue;
    }
    if (buckets > 0) {
      // Surum 6: bos olmayan her kova icin, icindeki sahip kayitlari 40'ar 40'ar.
      for (let b = 0; b < buckets; b++) {
        const list = await read(f, "bucket", [u32(b)]);
        if (!list.ok || !list.value.length) continue;
        for (let start = 0; start < list.value.length; start += 40) jobs.push({ kind: "factory", f, bucket: b, start });
      }
      continue;
    }
    const count = await read(f, "vault_count");
    if (!count.ok) continue;
    for (let start = 0; start < Number(count.value); start += 40) jobs.push({ kind: "factory", f, start });
  }
  return jobs;
}

async function runTtlJob(job) {
  if (job.kind === "factory") {
    const args = job.chain
      ? [u32(job.bucket), optAddr(job.from), u32(40)]
      : job.bucket === undefined
        ? [u32(job.start), u32(40)]
        : [u32(job.bucket), u32(job.start), u32(40)];
    const r = await write(job.f, "extend_ttl", args);
    const where = job.chain ? (job.from ? short(job.from) : "bas") : job.start;
    log(`TTL fabrika ${short(job.f)} ${job.bucket === undefined ? "" : `kova ${job.bucket} `}${where}..: ${r.ok ? "tamam" : errText(r)}`);
    return;
  }
  const v = job.vault;
  try {
    // Kasa sozlesmesi, kodu ve acik emir kayitlari (get_order'in dokundugu kayitlar).
    const seen = new Map();
    const sources = [["get_config", []]];
    for (const id of book.get(v)?.open || []) {
      if (closed.has(`${v}:${id}`)) continue;
      sources.push(["get_order", [u32(id)]]);
      // Zincirleme emir ayari varsa onun kaydi da (eski kasalarda fonksiyon yok, okuma basarisiz olur).
      const fu = await read(v, "get_follow_up", [u32(id)]);
      if (fu.ok && fu.value) sources.push(["get_follow_up", [u32(id)]]);
    }
    for (const [m, a] of sources) {
      for (const k of await footprintOf(v, m, a)) seen.set(keyId(k), k);
    }
    const keys = [...seen.values()];
    if (keys.length === 0) return;
    const r = await serialized(async () => {
      const account = await server.getAccount(kp.publicKey());
      const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
        .setSorobanData(new SorobanDataBuilder().setReadOnly(keys).build())
        .addOperation(Operation.extendFootprintTtl({ extendTo: 30 * DAY_IN_LEDGERS }))
        .setTimeout(TX_TIMEOUT_SEC)
        .build();
      return submit(await server.prepareTransaction(tx));
    });
    log(`TTL ${short(v)} (${keys.length} kayit): ${r.ok ? `tamam, ucret ${r.fee !== null ? fmt(r.fee) : "?"} XLM` : r.error}`);
  } catch (e) {
    log(`TTL ${short(v)} hatasi: ${e.message}`);
  }
}

/** --once modu (GitHub Actions): hepsini bir seferde. */
async function extendTtlAll(vaults) {
  for (const job of await factoryTtlJobs()) await runTtlJob(job);
  for (const vault of vaults) await runTtlJob({ kind: "vault", vault });
}

// ---------------------------------------------------------------------------
// Ana dongu
// ---------------------------------------------------------------------------

async function keeperBalance() {
  try {
    const r = await read(XLM, "balance", [new Address(kp.publicKey()).toScVal()]);
    return r.ok ? Number(BigInt(r.value)) / 1e7 : null;
  } catch {
    return null;
  }
}

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
  } catch {
    return {};
  }
}

let lastTtl = 0; // son tam TTL turunun bittigi an (ms); yeniden baslatmada durum.json'dan okunur
let vaultCache = { at: 0, list: [] };
async function scan() {
  scanNo++;
  if (Date.now() - vaultCache.at > VAULT_LIST_TTL_MS || SCAN_MODE !== "ledger") vaultCache = { at: Date.now(), list: await listVaults() };
  const vaults = vaultCache.list;
  let open = 0;
  let filled = 0;
  // 1) Refresh the order book of the vaults that need it (new, changed, or the rotating sweep).
  await pool(await vaultsToRead(vaults), SCAN_CONCURRENCY, async (v) => {
    try {
      await ordersToCheck(v);
    } catch (e) {
      log(`HATA ${e.message}`);
      return;
    }
    seenVaults.add(v);
    dirty.delete(v);
  });
  // 2) Check every open order against this scan's prices, from the cached copies. Fills run in parallel, one per
  //    sending account at a time.
  reservesNow.clear();
  const active = vaults.filter((v) => (book.get(v)?.open.length ?? 0) > 0);
  // With the batch filler each sending account carries BATCH_SIZE fills, so that many vaults are checked at once.
  const lanes = Math.min(Math.max(SCAN_CONCURRENCY, signers.length * (BATCH ? BATCH_SIZE : 1)), 40);
  await pool(active, lanes, async (v) => {
    const st = book.get(v);
    const cached = st.open.map((id) => st.orders?.get(id)).filter(Boolean);
    // Start one further each scan, so that when only some orders can be checked over the network (the cap
    // below) every order gets its turn.
    st.turn = cached.length ? ((st.turn || 0) + 1) % cached.length : 0;
    const orders = [...cached.slice(st.turn), ...cached.slice(0, st.turn)];
    const ctx = { net: 0 };
    let tries = 0;
    // With the batch filler a vault's orders are checked a few at a time, so that several of them can go out in
    // the same transaction; without it, one after the other. The caps are checked before each group.
    const width = BATCH ? BATCH_SIZE : 1;
    const one = async (o) => {
      if (closed.has(`${v}:${o.id}`)) {
        dirty.add(v); // the cached copy is out of date: read the vault again on the next scan
        return;
      }
      if (BigInt(o.amount_in) < minFillFor(o.sell ? String(o.sell) : null)) return; // toz emirler (buyuk emrin son kucuk parcasi degil)
      try {
        const res = await tryOrder(v, o, ctx);
        if (res === "filled") filled++;
        if (res === "filled" || res === "error" || res === "busy") tries++; // yalnizca gercek islem denemeleri sayilir
      } catch (e) {
        stats.failures++;
        stats.lastError = e.message;
        log(`HATA ${short(v)} #${o.id}: ${e.message}`);
      }
    };
    for (let i = 0; i < orders.length; i += width) {
      if (ctx.net >= MAX_ORDERS_PER_VAULT) break; // network-checked orders per vault per scan
      if (tries >= MAX_FILLS_PER_VAULT) {
        log(`${short(v)}: bu turda ${MAX_FILLS_PER_VAULT} islem denendi, kalanlar sonraki tura`);
        break;
      }
      await Promise.all(orders.slice(i, i + width).map(one));
    }
  });
  for (const v of vaults) open += book.get(v)?.open.length ?? 0; // every vault, including the ones not read this scan
  const balance = await keeperBalance();
  if (balance !== null && balance < LOW_BALANCE_XLM) {
    const sent = await notify(`Keeper bakiyesi dusuk: ${balance.toFixed(2)} XLM. Islem ucretleri icin XLM ekleyin.`, {
      topic: "low-balance",
      everySec: 6 * 3600,
    });
    if (sent) log(`UYARI keeper bakiyesi dusuk: ${balance} XLM`);
  }
  try {
    fs.writeFileSync(
      STATUS_FILE,
      JSON.stringify(
        {
          son_tarama: new Date().toISOString(),
          kasa_sayisi: vaults.length,
          acik_emir: open,
          bu_turda_dolum: filled,
          toplam_dolum: stats.fills,
          toplam_basarisiz: stats.failures,
          toplam_ucret_xlm: fmt(stats.feesStroop),
          son_hata: stats.lastError,
          keeper_bakiyesi_xlm: balance,
          gonderen_hesap: signers.length,
          toplu_dolum: BATCH ? `${batchFills} emir / ${batchTxs} islem` : "kapali",
          yerel_hesapla_gecilen: localSkips,
          son_ttl: lastTtl ? new Date(lastTtl).toISOString() : null,
        },
        null,
        2,
      ),
    );
  } catch {}
  return { vaults, filled, open };
}

async function main() {
  log(`keeper basladi: ${kp.publicKey()} fabrikalar=${FACTORIES.map(short).join(",")} rpc=${RPC_URLS.join(" | ")}`);
  if (ONCE) {
    let last;
    for (let round = 1; round <= 4; round++) {
      last = await scan();
      log(`tur ${round}: ${last.vaults.length} kasa, ${last.open} acik emir, ${last.filled} dolum`);
      if (last.filled === 0) break;
    }
    if (DO_TTL && last) await extendTtlAll(last.vaults);
    return;
  }
  if (WORKERS > 0) {
    await ensureWorkers();
    log(`gonderen hesap sayisi: ${signers.length} (ana hesap + ${signers.length - 1} yardimci)`);
    log(BATCH ? `toplu dolum acik: islem basina en cok ${BATCH_SIZE} emir, sozlesme ${short(BATCH)}` : "toplu dolum kapali (testnet/batch.env yok)");
  }
  let workersAt = Date.now();
  const prevTtl = Date.parse(readStatus().son_ttl || "");
  if (Number.isFinite(prevTtl)) lastTtl = prevTtl;
  let ttlJobs = [];
  let failedScans = 0;
  await notify(
    `Basladi. ${FACTORIES.length > 1 ? "Alim ve satis fabrikalari" : "Alim fabrikasi"}, ` +
      (SCAN_MODE === "ledger" ? "her yeni ledger'da (~5 sn) tarama." : `tarama araligi ${INTERVAL_SEC} sn.`),
  );
  let lastLedger = 0;
  for (;;) {
    try {
      const s = await scan();
      // Worker balances are checked once an hour.
      if (WORKERS > 0 && Date.now() - workersAt > 3600_000) {
        workersAt = Date.now();
        await ensureWorkers();
      }
      // TTL bakimi taramayi bekletmesin: gunde bir is listesi hazirlanir ve dolum olmayan
      // turlarda birer birer yapilir.
      if (DO_TTL && s.filled === 0) {
        if (ttlJobs.length === 0 && Date.now() - lastTtl > TTL_EVERY_SEC * 1000) {
          ttlJobs = [...(await factoryTtlJobs()), ...s.vaults.map((vault) => ({ kind: "vault", vault }))];
          if (ttlJobs.length === 0) lastTtl = Date.now();
        } else if (ttlJobs.length > 0) {
          await runTtlJob(ttlJobs.shift());
          if (ttlJobs.length === 0) lastTtl = Date.now();
        }
      }
      failedScans = 0;
    } catch (e) {
      stats.lastError = e.message;
      failedScans++;
      log(`HATA tarama: ${e.message}`);
      if (failedScans >= 3) {
        await notify(`Ust uste ${failedScans} tarama basarisiz: ${e.message}`, { topic: "scan", everySec: 3600 });
      }
    }
    if (SCAN_MODE !== "ledger") {
      await sleep(INTERVAL_SEC * 1000);
      continue;
    }
    // Yeni ledger gelene kadar saniyede bir bak (en fazla INTERVAL_SEC bekle)
    const t0 = Date.now();
    for (;;) {
      await sleep(1000);
      try {
        const l = await server.getLatestLedger();
        if (l.sequence > lastLedger) {
          lastLedger = l.sequence;
          break;
        }
      } catch {}
      if (Date.now() - t0 > INTERVAL_SEC * 1000) break;
    }
  }
}

// Ctrl+C ile durdurulunca bir kez haber ver (sinyal hem pencereden hem iora.sh'den gelebilir).
let stopping = false;
async function stop(sig) {
  if (stopping) return;
  stopping = true;
  log(`keeper durduruldu (${sig})`);
  await notify("Durduruldu (Ctrl+C). Emirler artik otomatik doldurulmuyor.");
  process.exit(0);
}
process.on("SIGINT", () => stop("Ctrl+C"));
process.on("SIGTERM", () => stop("SIGTERM"));
// Beklenmeyen bir hata keeper'i sessizce durdurmasin: kaydedilir, tarama devam eder.
process.on("unhandledRejection", (e) => log(`HATA (yakalanmamis): ${(e && e.message) || e}`));

main().catch(async (e) => {
  log(`KRITIK HATA: ${e.stack || e.message}`);
  await notify(`KRITIK HATA, keeper durdu: ${e.message}`);
  process.exit(1);
});
