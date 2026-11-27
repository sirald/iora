// Iora keeper bot.
//
// Scans every vault in the factories, finds the open orders and fills the ones whose limit can be met: against
// an opposite order in another vault (`cross`), along the best route over the trading venues it knows
// (`fill_via`, through the filler contract), or through the vault's built-in route (`execute`).
// The keeper can never choose the recipient, the amount or the limit; it only says "try now" and picks the fill
// size and the route. A bad keeper can cause a delay at most.
//
// Usage:
//   node keeper.js            runs continuously: scans on every new ledger (~5 s) (every INTERVAL_SEC with SCAN_MODE=interval)
//   node keeper.js --once     scans once (a few rounds) and exits
//   node keeper.js --ttl      also extends the lifetime of entries (in continuous mode on idle ledgers, bit by bit)
import { AsyncLocalStorage } from "node:async_hooks";
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
  StrKey,
  contract,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  FailureGuard,
  FeeBudget,
  RpcPicker,
  Aimd,
  Ewma,
  FillStats,
  FillTimer,
  RpcUsage,
  TokenBucket,
  LoopWatch,
  WorkBudget,
  acquireLock,
  cometMaxPrice,
  crossPairs,
  forgetOrder,
  inclusionFeeFrom,
  isBadSeq,
  isNear,
  isRateLimited,
  ledgerFromSse,
  legMinOut,
  limitRatio,
  parseSse,
  pickReadServer,
  pickSequence,
  retryAfterMs,
  retryRoute,
  rpcFailReason,
  rpcList,
  rpsList,
  scaleShares,
  scanIntervalMs,
  shapeKey,
  sharesOf,
  splitMins,
  takeCandidates,
  transientRpc,
  viaPlan,
  withinFeeCap,
  xlmToStroops,
} from "./lib.js";

// ---------------------------------------------------------------------------
// Settings
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
  ...readEnv(path.join(root, "testnet/old-factories.env")),
  ...readEnv(path.join(root, "testnet/markets.env")),
  ...readEnv(path.join(root, "testnet/batch.env")),
  ...readEnv(path.join(root, "testnet/filler.env")),
  ...readEnv(path.join(here, ".env")),
  ...process.env,
};
const PASSPHRASE = cfg.NETWORK_PASSPHRASE || Networks.TESTNET;
// On testnet the fast public RPC comes first and Stellar's own RPC is the fallback (measured 8 Nov 2026: Gateway
// ~0.15 s, soroban-testnet.stellar.org 1.5-5 s). On mainnet only RPC_URL / RPC_FALLBACK are used; it never falls
// back to testnet addresses. RPC_FALLBACK may list several servers, comma separated (tried in that order).
const TESTNET_RPCS = ["https://soroban-rpc.testnet.stellar.gateway.fm", "https://soroban-testnet.stellar.org"];
const RPC_URLS = rpcList(cfg.RPC_URL, cfg.RPC_FALLBACK, PASSPHRASE === Networks.TESTNET ? TESTNET_RPCS : []);
if (RPC_URLS.length === 0) {
  console.error("Missing setting: RPC_URL");
  process.exit(1);
}
const RPC_URL = RPC_URLS[0];
const INTERVAL_SEC = Number(cfg.INTERVAL_SEC || 30);
// "ledger": Stellar closes a ledger about every 5 s; the price only changes then. The keeper scans on every new ledger.
// "interval": the old behaviour, every INTERVAL_SEC.
const SCAN_MODE = (cfg.SCAN_MODE || "ledger").toLowerCase();
const VAULT_LIST_TTL_MS = 60_000; // the vault list is refreshed once a minute, not on every scan
// Budgets against abuse (thousands of tiny orders must not keep the keeper busy and delay everyone else):
// - a vault gets at most MAX_FILLS_PER_VAULT real transaction attempts per round,
// - at most MAX_ORDERS_PER_VAULT open orders of a vault are checked per round (the rest in later rounds, in turn),
// - at most MAX_NEW_IDS_PER_SCAN new orders are discovered per vault per round,
// - fills below MIN_FILL_UNITS are not tried (the fee must not cost more than the fill). Unit: 7 decimals.
const MAX_FILLS_PER_VAULT = Number(cfg.MAX_FILLS_PER_VAULT || 5);
const MAX_ORDERS_PER_VAULT = Number(cfg.MAX_ORDERS_PER_VAULT || 12);
const MAX_NEW_IDS_PER_SCAN = Number(cfg.MAX_NEW_IDS_PER_SCAN || 50);
const MIN_FILL_UNITS = BigInt(cfg.MIN_FILL_UNITS || 1_000_000); // 0.1 token
// For coins other than USDC and XLM (e.g. BTC) 0.1 token is a very large amount; their threshold is much smaller.
const MIN_FILL_OTHER_UNITS = BigInt(cfg.MIN_FILL_OTHER_UNITS || 100);
const minFillFor = (token) => (!token || token === USDC || token === XLM ? MIN_FILL_UNITS : MIN_FILL_OTHER_UNITS);
// At most this many vaults are read in parallel; transactions (sign + send) always go one at a time per account.
const SCAN_CONCURRENCY = Math.max(1, Number(cfg.SCAN_CONCURRENCY || 4));
// Vaults with no open order are not read on every scan (thousands of empty vaults would otherwise slow every
// scan down). They are read when an order event names them, and in a slow sweep: while events can be read, each
// idle vault is read again at most every SWEEP_EVERY_SEC (a safety net for a missed event), at most SWEEP_PER_SCAN
// per scan. Without events the old rotating sweep of SWEEP_PER_SCAN vaults per scan is used.
const SWEEP_PER_SCAN = Math.max(1, Number(cfg.SWEEP_PER_SCAN || 40));
const SWEEP_EVERY_SEC = Number(cfg.SWEEP_EVERY_SEC || 300);
// ----- RPC request rate -----
// Requests per second per RPC server (token bucket; RPC_MAX_RPS is one number or a comma list in server order).
// 4/s: a scan now needs about 1 request per second on average (see keeper-tur3-rpc notes), so 4/s leaves room for
// bursts (a fill is 3-6 requests) while staying well under what public RPCs allow one IP; the gateway answered 429
// at the old ~5/s average with 1-s bursts of 20+. A request over the limit waits in line; it never counts as a failure.
const RPC_MAX_RPS = rpsList(cfg.RPC_MAX_RPS, RPC_URLS.length, 4);
const RPC_BURST = Math.max(1, Number(cfg.RPC_BURST || 8));
// An HTTP 429 halves that server's rate (AIMD) and waits (Retry-After if given); only after RPC_429_SWITCH_AFTER
// 429s in a row does the keeper move to the next server.
const RPC_429_SWITCH_AFTER = Math.max(1, Number(cfg.RPC_429_SWITCH_AFTER || 3));
// ----- fill latency -----
// Reads (simulations, account reads) go to whichever RPC server is expected to answer first (its wait for the rate
// limit + its usual answer time), so both servers' limits are used; RPC_SPREAD_READS=off keeps them on one server.
const RPC_SPREAD_READS = String(cfg.RPC_SPREAD_READS || "on").toLowerCase() !== "off";
// A new ledger is seen the moment it closes from Horizon's ledger stream (server-sent events, outside the RPC rate
// limit); if the stream is down the keeper asks the RPC as before. LEDGER_STREAM=off: RPC only.
const HORIZON_URL = String(cfg.HORIZON_URL || (PASSPHRASE === Networks.TESTNET ? "https://horizon-testnet.stellar.org" : "")).replace(/\/+$/, "");
const LEDGER_STREAM = !!HORIZON_URL && String(cfg.LEDGER_STREAM || "on").toLowerCase() !== "off";
// After sending, the result is looked up right after the next ledger closes (stream), else every TX_POLL_MS.
const TX_POLL_MS = Math.max(250, Number(cfg.TX_POLL_MS || 750));
// The shape of the best filler route (which pools, which shares, or which intermediate token) is kept this long per
// pair and fill size; a fill then needs only the quotes of its own legs instead of a full route search.
// Watchdog: when the main loop makes no progress (no stage change, no finished RPC call) for LOOP_STALL_SEC, it is
// logged with the stage it is stuck in, and the fast paths (ledger stream, spread reads, background yielding) are
// switched off for 10 minutes, so the keeper falls back to plain RPC polling and recovers by itself.
const LOOP_STALL_SEC = Math.max(5, Number(cfg.LOOP_STALL_SEC || 60));
const ROUTE_SHAPE_SEC = Number(cfg.ROUTE_SHAPE_SEC ?? 60) >= 0 && cfg.ROUTE_SHAPE_SEC !== "" ? Number(cfg.ROUTE_SHAPE_SEC ?? 60) : 60;
// ----- adaptive scan interval (SCAN_MODE=ledger) -----
// While no open order is within SCAN_NEAR_PCT percent of its limit (and none can cross, none is due), a full scan
// runs only every SCAN_IDLE_SEC; between them only the order events are read on each ledger (2 requests), and a new
// or changed order starts a full scan at once. SCAN_IDLE_SEC=0 scans every ledger as before.
const SCAN_IDLE_SEC = cfg.SCAN_IDLE_SEC === undefined || cfg.SCAN_IDLE_SEC === "" ? 30 : Math.max(0, Number(cfg.SCAN_IDLE_SEC) || 0);
const SCAN_NEAR_PCT = Number(cfg.SCAN_NEAR_PCT || 2);
// ----- crossing work limits (IORA-06) -----
// Per scan: at most CROSS_MAX_CANDIDATES orders (CROSS_PER_VAULT per vault, vaults in turn), CROSS_PER_ORDER partners
// for each, and at most CROSS_MAX_PAIRS pairs / CROSS_MAX_QUOTES price quotes / CROSS_MAX_MS in all. A pair costs up
// to 4 quotes and 1 transaction; at the 4/s RPC limit 24 quotes are ~6 s, so a crowded book cannot hold up the pool
// pass, the heartbeat or TTL upkeep. What does not fit goes on in the next scans.
const CROSS_MAX_CANDIDATES = Math.max(2, Number(cfg.CROSS_MAX_CANDIDATES || 200));
const CROSS_PER_VAULT = Math.max(1, Number(cfg.CROSS_PER_VAULT || MAX_ORDERS_PER_VAULT));
const CROSS_PER_ORDER = Math.max(1, Number(cfg.CROSS_PER_ORDER || 2));
const CROSS_MAX_PAIRS = Math.max(1, Number(cfg.CROSS_MAX_PAIRS || 10));
const CROSS_MAX_QUOTES = Math.max(4, Number(cfg.CROSS_MAX_QUOTES || 24));
const CROSS_MAX_MS = Math.max(500, Number(cfg.CROSS_MAX_MS || 4000));
// ----- slippage protection on filler routes -----
// Every leg of a filler route (fill_via) carries a minimum output: its quote less SLIPPAGE_BPS (default 50 = 0.5%),
// never below the leg's share of what the vault's limit requires. A leg that would pay less fails in simulation
// (free) and the order is tried again on the next ledger, at most ROUTE_RETRIES times in a row before the vault's
// own route is used. COMET_MAX_PRICE_FACTOR: Comet's max_price is this many times the worst average price the
// leg's minimum allows (0 = no ceiling).
const SLIPPAGE_BPS = cfg.SLIPPAGE_BPS === undefined || cfg.SLIPPAGE_BPS === "" ? 50 : Math.max(0, Math.min(5000, Number(cfg.SLIPPAGE_BPS) || 0));
const ROUTE_RETRIES = cfg.ROUTE_RETRIES === undefined || cfg.ROUTE_RETRIES === "" ? 2 : Math.max(0, Number(cfg.ROUTE_RETRIES) || 0);
const COMET_MAX_PRICE_FACTOR = cfg.COMET_MAX_PRICE_FACTOR === undefined || cfg.COMET_MAX_PRICE_FACTOR === "" ? 2 : Number(cfg.COMET_MAX_PRICE_FACTOR) || 0;
const RPC_TIMEOUT_MS = Number(cfg.RPC_TIMEOUT_MS || 12_000);
const TX_TIMEOUT_SEC = 120;
const TTL_EVERY_SEC = 24 * 3600;
const LOW_BALANCE_XLM = 100;
// After the first RPC server fails it is tried again after RPC_RETRY_BASE_SEC, doubling up to RPC_RETRY_MAX_SEC.
const RPC_RETRY_BASE_SEC = Number(cfg.RPC_RETRY_BASE_SEC || 60);
const RPC_RETRY_MAX_SEC = Number(cfg.RPC_RETRY_MAX_SEC || 1800);
// ----- fee protection -----
// An order (or a pair of crossing orders) whose transaction fails ON CHAIN (the fee is paid) FAIL_PAUSE_AFTER times
// rests for FAIL_PAUSE_HOURS. Simulation failures cost nothing and are not counted here.
const FAIL_PAUSE_AFTER = Math.max(1, Number(cfg.FAIL_PAUSE_AFTER || 3));
const FAIL_PAUSE_HOURS = Number(cfg.FAIL_PAUSE_HOURS || 6);
// Fee budgets (XLM, 0 = no limit): when one is used up no transaction is sent; the keeper keeps scanning.
const MAX_FEE_XLM_PER_HOUR = Number(cfg.MAX_FEE_XLM_PER_HOUR || 50);
const MAX_FEE_XLM_PER_ROUND = Number(cfg.MAX_FEE_XLM_PER_ROUND || 5);
// The most one transaction may cost in total (inclusion + resource fee, XLM); a dearer one is not sent.
const MAX_FEE_XLM = Number(cfg.MAX_FEE_XLM || 2);
// The inclusion fee bid: this percentile of recent Soroban inclusion fees (getFeeStats), never below BASE_FEE.
const FEE_PERCENTILE = String(cfg.FEE_PERCENTILE || "p70");
// Only one keeper per key: a lock file holding the PID (taken over if that process is gone).
const LOCK_FILE = cfg.KEEPER_LOCK_FILE || path.join(here, "keeper.lock");
for (const k of ["FACTORY", "USDC", "XLM", "ROUTER", "KEEPER_SECRET"]) {
  if (!cfg[k]) {
    console.error(`Missing setting: ${k}`);
    process.exit(1);
  }
}
const { FACTORY, USDC, XLM, ROUTER } = cfg;
// The buy factory always; the sell factory (XLM is deposited, USDC is bought) if it is deployed.
// When the contract version is upgraded, open orders in the old factories keep being filled.
// Extra markets (testnet/markets.env): MARKETS=SYMBOL:token:factory,...
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
// ----- crossing: two opposite orders in version 10 vaults fill each other, with no pool in between -----
// CROSS=off in the settings file switches it off; every order is then filled through the pool as before.
const CROSS = String(cfg.CROSS || "on").toLowerCase() !== "off";
// ----- other venues: version 13 vaults can fill through the filler contract (testnet/filler.env) -----
// FILLER: the filler contract. AQUA_ROUTER: the Aquarius router on this network. VENUES=off switches the whole
// thing off; orders then fill through Soroswap only, as before.
const FILLER = (cfg.FILLER || "").trim();
const AQUA_ROUTER = (cfg.AQUA_ROUTER || "").trim();
// PHOENIX_MULTIHOP: Phoenix's multihop contract on this network (optional).
const PHOENIX_MULTIHOP = (cfg.PHOENIX_MULTIHOP || "").trim();
// COMET_POOLS: Comet pool contracts (weighted pools), comma separated (optional; a Comet pool is one contract).
const COMET_POOLS = String(cfg.COMET_POOLS || "").split(",").map((x) => x.trim()).filter(Boolean);
const VENUES = !!FILLER && (!!AQUA_ROUTER || !!PHOENIX_MULTIHOP || COMET_POOLS.length > 0) && String(cfg.VENUES || "on").toLowerCase() !== "off";
// (VENUE_EDGE_BPS is no longer used: the router is the default path for version 13 vaults, whatever venue wins.)
const WORKER_START_XLM = String(cfg.WORKER_START_XLM || "10");
const WORKER_MIN_XLM = Number(cfg.WORKER_MIN_XLM || 3);
const workerKey = (i) =>
  Keypair.fromRawEd25519Seed(crypto.createHash("sha256").update(kp.rawSecretKey()).update(`iora-keeper-worker-${i}`).digest());
/** Accounts that send transactions: the main key first, then the workers that are ready. */
const signers = [{ kp, chain: Promise.resolve(), queued: 0 }];

const args = process.argv.slice(2);
const ONCE = args.includes("--once");
const VENUE_CHECK = args.includes("--venue-check"); // read-only check of the other venues; see venueCheck()
const DO_TTL = args.includes("--ttl");

const TG_TOKEN = cfg.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT = cfg.TELEGRAM_CHAT_ID || "";

const LOG_FILE = path.join(here, "keeper.log");
const STATUS_FILE = path.join(here, "status.json");

// ---------------------------------------------------------------------------
// Helpers
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
  30: "SelfFill",
  31: "TooEarly",
  33: "InvalidSchedule",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (a) => `${a.slice(0, 4)}..${a.slice(-4)}`;
const fmt = (v) => (Number(BigInt(v)) / 1e7).toFixed(4);
// XDR fields are properties in SDK 17 and functions in older versions: read both.
const get = (o, k) => (o != null && typeof o[k] === "function" ? o[k]() : o?.[k]);

// Failing to write the log file (e.g. a momentary EBUSY in a Windows folder) must never stop the keeper.
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

// ---------------------------------------------------------------------------
// RPC: if the first server gives a network error/429/5xx or does not answer within RPC_TIMEOUT_MS, the same call is
// repeated on the next one (RPC_URL, then each RPC_FALLBACK). The first server is tried again after a back-off that
// doubles while it keeps failing (RPC_RETRY_BASE_SEC .. RPC_RETRY_MAX_SEC). Contract errors are real answers and are not repeated.
// ---------------------------------------------------------------------------

// Node's "fetch failed" error keeps the real cause (DNS, connection refused, timeout, certificate...) in e.cause;
// the SDK drops it. The cause is added to the message so that it shows in the log and in the Telegram alert.
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

// The SDK's getAccount reports a network error as "Account not found" too; so when the first server went down there
// was no falling back and no fill could be sent. The same read is done with getLedgerEntries (a network error is retried on the fallback).
function accountKey(address) {
  return xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrPublicKey() }));
}

// Every RPC call gets its own AbortController: on timeout the HTTP request itself is cancelled (not just no longer
// awaited). The SDK has no per-call signal, so the signal reaches its HTTP client through AsyncLocalStorage and a
// request interceptor.
const rpcCallCtx = new AsyncLocalStorage();
// What a request is for, for the usage counter ("simulate:get_order" instead of just "simulateTransaction").
const rpcLabelCtx = new AsyncLocalStorage();
const rpcPicker = new RpcPicker(RPC_URLS.length, { baseMs: RPC_RETRY_BASE_SEC * 1000, maxMs: RPC_RETRY_MAX_SEC * 1000 });
const rpcUsage = new RpcUsage();
// Per server: a token bucket for the request rate, AIMD on 429s, and the count of 429s in a row.
const rpcLimits = RPC_URLS.map((u, i) => ({
  bucket: new TokenBucket(RPC_MAX_RPS[i], Math.max(RPC_BURST, 1)),
  aimd: new Aimd(RPC_MAX_RPS[i], { min: Math.min(0.5, RPC_MAX_RPS[i]), stepPerSec: RPC_MAX_RPS[i] / 120, holdMs: 30_000 }),
  in429: 0, // 429s in a row
  blockedAt: 0, // when the last 429 pause began: 429s for requests sent before it do not count as "in a row"
  saidAt: 0,
  latency: new Ewma(0.2), // usual answer time (ms)
  downUntil: 0, // a spread read failed here: not used for spread reads until then
}));
// Background work (sweep reads, balance, vault list, TTL, workers) runs under rpcLowCtx: while a fill-path request is
// in flight it waits a moment, so fills never queue behind it for the rate limit.
const rpcLowCtx = new AsyncLocalStorage();
let rpcHighInFlight = 0;
const SPREAD_METHODS = new Set(["simulateTransaction", "getLedgerEntries"]);
const SPREAD_TIMEOUT_MS = 3000;
const low = (fn) => rpcLowCtx.run(true, fn);

/** A spread read failed on server `idx`: leave it out of spread reads for 30 s, doubling up to 10 min; said once in 10 min. */
function spreadFailed(idx, lim, e, tookMs) {
  lim.spreadFails = (lim.spreadFails || 0) + 1;
  const outMs = Math.min(30_000 * 2 ** (lim.spreadFails - 1), 600_000);
  lim.downUntil = Date.now() + outMs;
  lim.latency.add(Math.max(tookMs, SPREAD_TIMEOUT_MS));
  if (Date.now() - (lim.spreadSaidAt || 0) > 10 * 60_000) {
    lim.spreadSaidAt = Date.now();
    log(`RPC: a read sent to ${RPC_URLS[idx]} to spread the load failed (${rpcFailReason(e)}); it gets no spread reads for ${Math.round(outMs / 1000)} s`);
  }
}

/** Waits for this server's turn under its rate limit (time spent here never counts towards the RPC timeout). */
async function rpcTurn(lim) {
  // Background work yields to the fill path only when this server is actually congested (a wait for its rate limit)
  // and a fill-path request is in flight; at most 1 s, and never while the watchdog has the fast paths off.
  // (Before: up to 3 s for EVERY background request whenever any fill-path request was in flight anywhere.)
  if (rpcLowCtx.getStore() && !loopWatch.safe()) {
    for (let i = 0; i < 10 && rpcHighInFlight > 0 && lim.bucket.peek() > 0; i++) await sleep(100);
  }
  for (let i = 0; i < 5; i++) {
    const now = Date.now();
    lim.bucket.setRate(lim.aimd.rate(now), now);
    const wait = lim.bucket.take(now);
    if (wait <= 0) return;
    rpcUsage.waited(wait);
    await sleep(wait);
    if (Date.now() >= lim.bucket.at) return; // no 429 pause began while waiting
  }
}

function makeServer(urls) {
  const servers = urls.map((u) => {
    const s = new rpc.Server(u, { allowHttp: u.startsWith("http://"), timeout: RPC_TIMEOUT_MS });
    s.httpClient.interceptors.request.use((config) => {
      const signal = rpcCallCtx.getStore();
      if (signal) config.signal = signal;
      return config;
    });
    return s;
  });

  async function call(name, args) {
    let lastErr;
    const label = rpcLabelCtx.getStore() || name;
    const high = !rpcLowCtx.getStore();
    if (high) rpcHighInFlight++;
    try {
      let order = rpcPicker.order();
      let spreadIdx = -1;
      if (RPC_SPREAD_READS && !loopWatch.safe() && SPREAD_METHODS.has(name) && urls.length > 1) {
        // the server expected to answer first; the current one if it is as good
        const now = Date.now();
        const cur = rpcPicker.cur;
        spreadIdx = pickReadServer(
          urls.map((_, i) => ({
            usable: i === cur || (now >= rpcLimits[i].downUntil && (i !== 0 || now >= rpcPicker.retryAt)),
            waitMs: rpcLimits[i].bucket.peek(now),
            latencyMs: rpcLimits[i].latency.value,
          })),
          3000, // a server not measured yet counts as slow (it may be: soroban-testnet.stellar.org answers in 1.5-5 s)
        );
        // only when the current server is really busy: otherwise it keeps every read
        if (spreadIdx !== cur && rpcLimits[cur].bucket.peek(now) < 250) spreadIdx = -1;
        if (spreadIdx >= 0 && spreadIdx !== order[0]) order = [spreadIdx, ...order.filter((i) => i !== spreadIdx)];
      }
      for (const idx of order) {
        const r = await callOn(idx, name, args, label, idx === spreadIdx && idx !== rpcPicker.cur);
        if (r.ok) return r.value;
        lastErr = r.error;
        if (!r.next) throw r.error;
      }
      throw lastErr;
    } finally {
      if (high) rpcHighInFlight--;
    }
  }

  /**
   * One server: waits for its rate limit, sends, and on HTTP 429 slows down and waits on the SAME server (Retry-After
   * when given). Returns { ok, value } or { ok: false, error, next } (next: try the next server).
   */
  async function callOn(idx, name, args, label, spread = false) {
    const lim = rpcLimits[idx];
    let tries429 = 0;
    for (;;) {
      await rpcTurn(lim);
      const sentAt = Date.now();
      rpcUsage.count(urls[idx], label, sentAt);
      const ac = new AbortController();
      let timer;
      // A read spread to another server gives up early: it is only worth it while that server is quick.
      const timeoutMs = spread ? Math.min(RPC_TIMEOUT_MS, SPREAD_TIMEOUT_MS) : RPC_TIMEOUT_MS;
      try {
        const res = await Promise.race([
          rpcCallCtx.run(ac.signal, () => servers[idx][name](...args)),
          new Promise((_, rej) => {
            timer = setTimeout(() => {
              const e = new Error(`the RPC did not answer within ${timeoutMs} ms`);
              ac.abort(e);
              rej(e);
            }, timeoutMs);
          }),
        ]);
        lim.in429 = 0;
        lim.latency.add(Date.now() - sentAt);
        if (!rpcLowCtx.getStore()) loopWatch.progress(); // background (TTL) requests do not count as main-loop progress
        if (spread) {
          // a read sent to another server to use its capacity: the current server stays the current one
          rpcPicker.consecutiveErrors = 0;
          lim.spreadFails = 0;
          return { ok: true, value: res };
        }
        const moved = rpcPicker.success(idx);
        if (moved === "primary") log(`RPC: back on the first server ${urls[0]}`);
        else if (moved === "switched") {
          const wait = Math.max(0, Math.round((rpcPicker.retryAt - Date.now()) / 1000));
          log(`RPC: switched to ${urls[idx]} (${rpcPicker.lastError || "the previous server failed"}); the first server is tried again in ${wait} s`);
        }
        return { ok: true, value: res };
      } catch (e) {
        // A spread read that fails in any way (timeout, 429, error) goes back to the current server at once, and
        // this server is left out of spread reads for a while, longer each time. Its failed answer time counts in its
        // answer-time average, so it is not picked again as if it were fast. (068fd53 kept a hanging server's
        // average unset - "unknown" = 1 s - and logged nothing: every 30 s a new wave of reads went to it and waited
        // the full 12 s timeout.)
        if (spread) {
          spreadFailed(idx, lim, e, Date.now() - sentAt);
          return { ok: false, error: e, next: true };
        }
        if (isRateLimited(e)) {
          // Too many requests: slow this server down and wait; this is not a reason to leave it.
          const now = Date.now();
          rpcUsage.rateLimited(now);
          if (sentAt >= lim.blockedAt) lim.in429++; // 429s of requests already in flight count once
          const rate = lim.aimd.cut(now);
          const ra = retryAfterMs(e, now);
          const pause = ra ?? Math.min(1000 * 2 ** (lim.in429 - 1), 10_000);
          lim.blockedAt = now;
          lim.bucket.drain(now + pause);
          if (now - lim.saidAt > 60_000) {
            lim.saidAt = now;
            log(
              `RPC: ${urls[idx]} answered HTTP 429 (too many requests): rate lowered to ${rate.toFixed(2)}/s, ` +
                `waiting ${Math.round(pause / 1000)} s${ra !== null ? " (Retry-After)" : ""}; ${lim.in429}/${RPC_429_SWITCH_AFTER} in a row`,
            );
          }
          // Same server after the pause, but not for ever: a request that was already in flight when the pause began
          // does not raise "in a row", so without this cap it could retry on a busy server indefinitely.
          tries429++;
          if (lim.in429 < RPC_429_SWITCH_AFTER && tries429 < 6) continue;
          lim.in429 = 0;
          rpcPicker.failure(idx, `${urls[idx]} HTTP 429 ${RPC_429_SWITCH_AFTER} times in a row`);
          return { ok: false, error: e, next: true };
        }
        if (!transientRpc(e)) return { ok: false, error: e, next: false };
        rpcPicker.failure(idx, `${urls[idx]} ${rpcFailReason(e)}`);
        return { ok: false, error: e, next: true };
      } finally {
        clearTimeout(timer);
        ac.abort(); // nothing may stay in flight after the call is over
      }
    }
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
// Telegram notifications (skipped silently when not configured)
// ---------------------------------------------------------------------------

const lastSent = new Map(); // topic -> time (so that the same alert is not sent again and again)

/** True if it was sent; false if the same topic was sent recently. Waits at most 8 s if Telegram hangs. */
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
    if (!res.ok) console.error(`telegram error: ${res.status}`);
  } catch (e) {
    console.error(`telegram message could not be sent: ${e.message}`);
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
 * Transaction for a read (simulation): the account's sequence number is not needed, so getAccount is not called
 * on every read (halves the RPC calls, and "Account not found" hiccups do not stop reads).
 */
function readTx(contractId, method, callArgs) {
  return new TransactionBuilder(new Account(kp.publicKey(), "0"), { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...callArgs))
    .setTimeout(TX_TIMEOUT_SEC)
    .build();
}

// ----- fee protection and sequence numbers -----
const failGuard = new FailureGuard({ threshold: FAIL_PAUSE_AFTER, pauseMs: FAIL_PAUSE_HOURS * 3600_000 });
const feeBudget = new FeeBudget({ perHour: xlmToStroops(MAX_FEE_XLM_PER_HOUR), perRound: xlmToStroops(MAX_FEE_XLM_PER_ROUND) });
const MAX_FEE_STROOPS = xlmToStroops(MAX_FEE_XLM);
// TTL upkeep pays rent (a vault's code entry alone can cost a few XLM for 30 days), so it has its own, higher cap.
const MAX_TTL_FEE_XLM = Number(cfg.MAX_TTL_FEE_XLM || 10);
const MAX_TTL_FEE_STROOPS = xlmToStroops(MAX_TTL_FEE_XLM);
let feeStatsCache = { at: 0, fee: Number(BASE_FEE) };

/** The inclusion fee to bid now (stroops): from getFeeStats, kept for 30 s; BASE_FEE when the stats cannot be read. */
async function inclusionFee() {
  if (Date.now() - feeStatsCache.at < 30_000) return feeStatsCache.fee;
  let fee = Number(BASE_FEE);
  try {
    fee = inclusionFeeFrom(await server.getFeeStats(), { base: Number(BASE_FEE), percentile: FEE_PERCENTILE, max: MAX_FEE_STROOPS });
  } catch {}
  feeStatsCache = { at: Date.now(), fee };
  return fee;
}

let budgetSaidAt = 0;
/** A fee budget is used up: said in the log at most every 10 minutes, on Telegram at most once an hour. */
function budgetHit(why) {
  if (Date.now() - budgetSaidAt < 10 * 60_000) return;
  budgetSaidAt = Date.now();
  const spent = fmt(BigInt(feeBudget.spentLastHour()));
  log(
    `WARNING ${why} used up (${spent} XLM in the last hour; MAX_FEE_XLM_PER_HOUR=${MAX_FEE_XLM_PER_HOUR}, ` +
      `MAX_FEE_XLM_PER_ROUND=${MAX_FEE_XLM_PER_ROUND}): no transaction is sent, scanning goes on`,
  );
  notify(`Fee budget used up (${why}, ${spent} XLM in the last hour). No transactions are sent until it frees up.`, { topic: "budget", everySec: 3600 });
}

// The last sequence number each sending account used on chain (a transaction that SUCCEEDED or FAILED uses it up).
// A lagging fallback RPC can report an older one; building on that would only give txBadSeq.
const usedSeq = new Map();
async function accountFor(signer) {
  const pub = signer.publicKey();
  // The sequence this account last used on chain is known exactly (set on SUCCESS/FAILED, cleared on txBadSeq):
  // no account read is needed for the next transaction (one request less on the fill path).
  if (usedSeq.has(pub)) return new Account(pub, String(usedSeq.get(pub)));
  const acc = await server.getAccount(pub);
  return new Account(pub, pickSequence(acc.sequenceNumber(), usedSeq.get(pub)).toString());
}

/** Transaction to be sent: with the current sequence number and the current inclusion fee. */
async function liveTx(contractId, method, callArgs, signer = kp) {
  const account = await accountFor(signer);
  return new TransactionBuilder(account, { fee: String(await inclusionFee()), networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...callArgs))
    .setTimeout(TX_TIMEOUT_SEC)
    .build();
}

/** Simulation only: a free read. */
// The same read within one scan is asked of the network once (the chain only changes from ledger to ledger). The
// memo is emptied at the start of every scan and after every transaction of ours that went through; a read that
// throws (network error) is not kept.
const readMemo = new Map();
let readMemoHits = 0;
async function read(contractId, method, callArgs = []) {
  const key = `${contractId}|${method}|${callArgs.map((a) => a.toXDR("base64")).join(",")}`;
  const hit = readMemo.get(key);
  if (hit) {
    readMemoHits++;
    return hit;
  }
  const p = rpcLabelCtx.run(`simulate:${method}`, async () => {
    const sim = await server.simulateTransaction(readTx(contractId, method, callArgs));
    if (rpc.Api.isSimulationError(sim)) return { ok: false, error: sim.error, code: errCode(sim.error) };
    return { ok: true, value: sim.result ? scValToNative(sim.result.retval) : undefined };
  });
  readMemo.set(key, p);
  p.catch(() => readMemo.delete(key));
  return p;
}

/** The final result of a transaction found on chain, or null if it is not (yet) there. */
function chainResult(r, hash, maxFee) {
  if (!r || (r.status !== "SUCCESS" && r.status !== "FAILED")) return null;
  let fee = null;
  try {
    fee = BigInt(get(r.resultXdr, "feeCharged"));
  } catch {}
  const charged = fee !== null ? Number(fee) : maxFee;
  const ledger = Number(r.ledger) || null;
  if (r.status === "SUCCESS") return { ok: true, hash, fee, charged, ledger, value: r.returnValue ? scValToNative(r.returnValue) : undefined };
  let why = "";
  try {
    why = get(get(r.resultXdr, "result"), "switch")?.name || "";
  } catch {}
  return { ok: false, onchain: true, hash, fee, charged, ledger, error: `the transaction failed on the network${why ? ` (${why})` : ""}` };
}

async function lookupTx(hash, maxFee) {
  try {
    return chainResult(await server.getTransaction(hash), hash, maxFee);
  } catch {
    return null;
  }
}

/**
 * Sends a signed transaction and follows it until its validity (TX_TIMEOUT_SEC) ends. If sending throws, the
 * request may still have reached the network: the hash is looked up first, and only then is the SAME signed
 * transaction sent once more (same hash, so it can never be applied twice).
 */
async function sendAndFollow(tx, hash, maxFee) {
  let sent;
  for (let attempt = 0; ; attempt++) {
    try {
      sent = await server.sendTransaction(tx);
      break;
    } catch (e) {
      await sleep(2000);
      const seen = await lookupTx(hash, maxFee);
      if (seen) return seen;
      if (attempt >= 1) return { ok: false, retry: true, hash, charged: 0, error: `could not be sent: ${e.message}` };
    }
  }
  if (sent.status === "TRY_AGAIN_LATER") return { ok: false, retry: true, charged: 0, error: "the network did not take the transaction now (TRY_AGAIN_LATER)" };
  if (sent.status === "ERROR") {
    let name = "";
    try {
      const res = get(get(sent, "errorResult"), "result");
      name = res.type || get(res, "switch")?.name || "";
    } catch {}
    // A rejected transaction is not charged. A bad sequence number is ours to fix, not the order's fault.
    if (isBadSeq(name)) return { ok: false, retry: true, badSeq: true, charged: 0, error: `send error ${name}` };
    return { ok: false, charged: 0, error: `send error ${name}`.trim() };
  }
  // PENDING or DUPLICATE: the transaction is queued. It can only be written when the next ledger closes: the result
  // is looked up right after that (ledger stream), or every TX_POLL_MS without the stream.
  fillTraceCtx.getStore()?.mark("sent");
  const deadline = Date.now() + (TX_TIMEOUT_SEC + 15) * 1000;
  let seenLedger = ledgerWatch.seq;
  while (Date.now() < deadline) {
    if (ledgerStreamUp()) {
      await nextLedgerAfter(seenLedger, 7000);
      seenLedger = ledgerWatch.seq;
      await sleep(150); // the RPC needs a moment to take in the ledger Horizon just announced
    } else await sleep(TX_POLL_MS);
    // With the stream: up to 3 looks 400 ms apart (the RPC may be a moment behind Horizon), then the next ledger.
    const looks = ledgerStreamUp() ? 3 : 1;
    for (let k = 0; k < looks; k++) {
      if (k) await sleep(400);
      let r;
      try {
        r = await server.getTransaction(sent.hash);
      } catch {
        continue; // temporary RPC error: keep following the transaction
      }
      const done = chainResult(r, sent.hash, maxFee);
      if (done) return done;
    }
  }
  return { ok: false, hash: sent.hash, charged: 0, error: "timed out (the transaction expired and was not written to the chain)" };
}

/**
 * Checks the fee cap and the fee budget, signs, sends and waits for the result.
 * retry=true: nothing was paid and the order is not to blame (congestion, a pending transaction on the same account,
 * a bad sequence number, the fee cap or the budget); it is tried again on a later ledger.
 * onchain=true: the transaction got on chain and FAILED there: its fee was paid.
 */
async function submit(tx, signer = kp, { ttl = false } = {}) {
  const maxFee = Number(tx.fee);
  if (!withinFeeCap(maxFee, ttl ? MAX_TTL_FEE_STROOPS : MAX_FEE_STROOPS)) {
    const capName = ttl ? `MAX_TTL_FEE_XLM=${MAX_TTL_FEE_XLM}` : `MAX_FEE_XLM=${MAX_FEE_XLM}`;
    return {
      ok: false,
      retry: true,
      feeCap: true,
      error: `the transaction would cost up to ${fmt(BigInt(maxFee))} XLM, above ${capName}; not sent`,
    };
  }
  const why = feeBudget.blockReason(maxFee);
  if (why) {
    budgetHit(why);
    return { ok: false, retry: true, budget: true, error: `${why} used up; not sent` };
  }
  tx.sign(signer);
  const hash = tx.hash().toString("hex");
  const held = feeBudget.reserve(maxFee);
  const res = await sendAndFollow(tx, hash, maxFee);
  const timer = fillTraceCtx.getStore();
  if (timer && res.ok) {
    timer.mark("included");
    timer.includedLedger = res.ledger || null;
  }
  feeBudget.settle(held, res.charged ?? 0);
  if (res.ok || res.onchain) usedSeq.set(signer.publicKey(), tx.sequence);
  if (res.badSeq) usedSeq.delete(signer.publicKey()); // the known sequence was wrong: the next transaction reads it again
  if (res.ok || res.onchain) readMemo.clear(); // our own transaction changed the chain: no stale reads after it
  return res;
}

/**
 * Adds a margin to the simulation's resource estimate: Blend accrues interest on every ledger, so the resources
 * needed can grow before the transaction is written; without a margin the fill is rejected with "resource limit
 * exceeded" and the keeper pays the fee for nothing. (Same as padSim in the app.)
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
    log(`could not add the resource margin: ${e.message}`);
  }
  return sim;
}

// One transaction at a time per account: every sending account has its own queue. A job goes to the account with the
// shortest queue, so with more than one account several transactions go out in the same ledger.
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

/** Simulate and, if it succeeds, sign and send. anySigner: fills pick a free account; everything else goes from the main account. */
function write(contractId, method, callArgs, anySigner = false) {
  return serialized(
    async (signer) => {
      for (let attempt = 0; ; attempt++) {
        const why = feeBudget.blockReason(0);
        if (why) {
          budgetHit(why);
          return { ok: false, retry: true, budget: true, error: `${why} used up; not sent` };
        }
        const tx = await liveTx(contractId, method, callArgs, signer);
        const sim = await server.simulateTransaction(tx);
        fillTraceCtx.getStore()?.mark("sim");
        if (rpc.Api.isSimulationError(sim)) return { ok: false, error: sim.error, code: errCode(sim.error) };
        const r = await submit(rpc.assembleTransaction(tx, padSim(sim)).build(), signer);
        if (r.badSeq && attempt === 0) {
          // The sequence number was stale (e.g. a lagging fallback RPC): read it again and send once more.
          usedSeq.delete(signer.publicKey());
          log(`${short(signer.publicKey())}: ${r.error}; the sequence number is read again and the transaction rebuilt`);
          continue;
        }
        return r;
      }
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
let batchOffUntil = 0; // after a batch failed ON CHAIN, fills go out one by one for a while
function fillOrder(vault, id, amount, via, single) {
  if (!BATCH || BATCH_SIZE < 2 || Date.now() < batchOffUntil) return single();
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
  if (r.onchain) {
    // The batch got on chain and failed (its fee is paid). The orders are NOT sent again one by one right away:
    // each gets an on-chain failure, and batching is off for 10 minutes so the next tries go alone and show the
    // real reason through their own (free) simulation first.
    batchOffUntil = Date.now() + 10 * 60_000;
    log(`batch fill (${items.length} orders) failed on chain: ${errText(r)} tx=${r.hash}; batching is off for 10 minutes`);
    for (const it of items) it.resolve({ ...r, batch: true });
    return;
  }
  if (!r.ok || !Array.isArray(r.value)) {
    log(`batch fill (${items.length} orders) did not go through: ${errText(r)}; the orders will be tried one by one`);
    await Promise.all(items.map(alone));
    return;
  }
  const done = items.filter((_, i) => BigInt(r.value[i] ?? 0) > 0n).length;
  batchTxs++;
  batchFills += done;
  log(`BATCH ${done}/${items.length} orders filled in one transaction fee=${r.fee !== null ? fmt(r.fee) : "?"} XLM tx=${r.hash}`);
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
          const account = await accountFor(signer);
          const tx = new TransactionBuilder(account, { fee: String(Number(BASE_FEE) * 10), networkPassphrase: PASSPHRASE })
            .addOperation(op)
            .setTimeout(TX_TIMEOUT_SEC)
            .build();
          return submit(tx, signer);
        });
        if (!r.ok) {
          log(`worker account ${i + 1} could not be prepared: ${r.error}`);
          continue;
        }
        log(`worker account ${i + 1} ${exists ? "topped up" : "created"}: ${short(pub)} (+${WORKER_START_XLM} XLM)`);
      }
      if (!signers.some((s) => s.kp.publicKey() === pub)) signers.push({ kp: w, chain: Promise.resolve(), queued: 0 });
    } catch (e) {
      log(`worker account ${i + 1} could not be checked: ${e.message || e}`);
    }
  }
}

/**
 * The fill fee is paid in the coin an order buys, to the keeper's main account. For USDC that account needs a
 * trustline; without one every fill that pays its fee in USDC fails (the token contract refuses the transfer,
 * error 13), so sell orders would wait forever. Checked at start: a transfer of the smallest unit to the keeper
 * is simulated from a pool that holds USDC. If the trustline is missing the keeper adds it itself (its own
 * account, 0.5 XLM reserve); USDC_ISSUER in testnet/addr.env overrides the testnet issuer.
 */
const USDC_ISSUER = (cfg.USDC_ISSUER || (PASSPHRASE === Networks.TESTNET ? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" : "")).trim();
async function ensureFeeTrustline() {
  try {
    const holder = await poolOf(USDC, XLM);
    if (!holder) return;
    const probe = () => read(USDC, "transfer", [new Address(holder.pair).toScVal(), new Address(kp.publicKey()).toScVal(), i128(1)]);
    const r = await probe();
    if (r.ok || r.code !== 13) return; // fine, or something this check cannot judge
    if (!USDC_ISSUER) return log("WARNING: the keeper's account has no USDC trustline, so fills that pay their fee in USDC will fail. Add one (USDC_ISSUER is not set, so the keeper cannot do it itself).");
    log("the keeper's account has no USDC trustline (fills that pay their fee in USDC would fail); adding it");
    const sent = await serialized(async (signer) => {
      const account = await accountFor(signer);
      const tx = new TransactionBuilder(account, { fee: String(Number(BASE_FEE) * 10), networkPassphrase: PASSPHRASE })
        .addOperation(Operation.changeTrust({ asset: new Asset("USDC", USDC_ISSUER) }))
        .setTimeout(TX_TIMEOUT_SEC)
        .build();
      return submit(tx, signer);
    });
    if (!sent.ok) return log(`WARNING: the USDC trustline could not be added: ${sent.error}. Fills that pay their fee in USDC will fail until it exists.`);
    const again = await probe();
    log(again.ok ? "USDC trustline added: the keeper can now receive fill fees in USDC" : `WARNING: the trustline was added but USDC still cannot be received (${errText(again)}); check that USDC_ISSUER is the issuer of ${short(USDC)}`);
  } catch (e) {
    log(`the USDC trustline could not be checked: ${e.message || e}`);
  }
}

/** Bounded parallelism: at most n jobs at a time. */
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Vaults and orders
// ---------------------------------------------------------------------------

const closed = new Set(); // "vault:id" (filled/cancelled/definitely expired)
const book = new Map(); // vault -> { next: next order id, open: ids of orders that may be open, cursor: position }

/** The factory's bucket count; 0 in old factories that list by sequence number (no such function). Asked once per factory. */
const bucketCache = new Map();
async function bucketsOf(f) {
  if (bucketCache.has(f)) return bucketCache.get(f);
  const r = await read(f, "bucket_count");
  // A simulation error means the function does not exist (old factory). A network error throws and never gets here.
  const n = r.ok ? Number(r.value) : 0;
  bucketCache.set(f, n);
  return n;
}
/** The last list read from a bucketed factory: while the vault count is unchanged, one read is enough instead of 16. */
const bucketLists = new Map(); // factory -> { count, vaults }

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
  const prev = chainLists.get(f);
  if (prev && prev.count === Number(c.value)) return prev.vaults;
  // The walk below works on a copy: if a read fails half way, the next scan starts again from the last complete
  // list (a half-read bucket would otherwise look finished and the vaults deeper in it would never be listed).
  const have = prev
    ? { count: prev.count, lens: new Map(prev.lens), owners: new Set(prev.owners), vaults: [...prev.vaults] }
    : { count: -1, lens: new Map(), owners: new Set(), vaults: [] };
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
  // If one factory cannot be read, the others' orders are still filled; if none can be read, it is an error.
  const out = [];
  const fails = [];
  for (const f of FACTORIES) {
    try {
      // Version 6 factories keep vaults in buckets (no sequence number): buckets are read 16 at a time.
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
      // Old factories return pages of at most 50 (older ones 100); 50 works with both.
      for (let start = 0; ; start += 50) {
        const r = await read(f, "vaults", [u32(start), u32(50)]);
        if (!r.ok) throw new Error(errText(r));
        out.push(...r.value);
        if (r.value.length < 50) break;
      }
    } catch (e) {
      fails.push(`${short(f)}: ${e.message || e}`);
      log(`could not read the vault list (${short(f)}): ${e.message || e}`);
    }
  }
  if (fails.length === FACTORIES.length) throw new Error(`could not read the vault list (${fails.join("; ")})`);
  return out;
}

/** The vault's token pair: the "usdc" field is the token deposited/spent, the "xlm" field is the token bought. */
const pairOf = new Map();
async function pair(vault) {
  if (pairOf.has(vault)) return pairOf.get(vault);
  const r = await read(vault, "get_config");
  if (!r.ok) throw new Error(`could not read the settings of ${short(vault)}: ${errText(r)}`);
  // Version 5 vaults: `execute` takes the filler's address and pays it at most `exec_fee` (in the token bought) out of
  // what comes in above the limit. Older vaults do not have this field; the old signature is used.
  const fee = r.value.exec_fee;
  // Version 7 (one multi-asset vault): the tokens are in the ORDER, not in the vault (sell/buy); the fill fee cap is
  // read from the `fees` table by the token bought. The `execute` signature is the same as in version 5.
  const fees = r.value.fees;
  // Version 8: `execute` takes a fourth argument (the intermediate token, or none). `version` reports the vault
  // version; version 7 vaults do not have this function.
  // Version 10: the vault also has `take` and `cross` (fills without a pool).
  // Version 11: scheduled orders (DCA); `get_schedule` tells which orders fill in timed parts.
  // Version 13: `fill_via` (a fill through the filler contract, any venue).
  let v8 = false;
  let v10 = false;
  let v11 = false;
  let v13 = false;
  if (fees !== undefined) {
    const ver = await read(vault, "version");
    v8 = ver.ok && Number(ver.value) >= 8;
    v10 = ver.ok && Number(ver.value) >= 10;
    v11 = ver.ok && Number(ver.value) >= 11;
    v13 = ver.ok && Number(ver.value) >= 13;
  }
  const p =
    fees !== undefined
      ? { v7: true, v5: true, v8, v10, v11, v13, fees: Object.fromEntries(Object.entries(fees).map(([k, v]) => [String(k), BigInt(v)])) }
      : { tin: String(r.value.usdc), tout: String(r.value.xlm), v5: fee !== undefined, fee: fee !== undefined ? BigInt(fee) : 0n };
  pairOf.set(vault, p);
  return p;
}

// ----- scheduled orders (DCA, version 11 vaults) -----
// The contract enforces the schedule (a part cannot fill early; the order always holds exactly one part, and
// reserves the next one itself after a fill while the vault can cover it); the keeper only needs to know when
// the next part is due. "vault:id" -> schedule, or null for an
// ordinary order. A schedule changes only when a part fills, so it is read again after every fill attempt.
const schedules = new Map();
// The keeper's clock against the ledger's: a part is tried a few seconds after it falls due.
const DCA_CLOCK_MARGIN_SEC = 6;

async function scheduleOf(vault, id, refresh = false) {
  const key = `${vault}:${id}`;
  if (!refresh && schedules.has(key)) return schedules.get(key);
  const pc = await pair(vault);
  if (!pc.v11) {
    schedules.set(key, null);
    return null;
  }
  const r = await read(vault, "get_schedule", [u32(id)]);
  if (!r.ok) return schedules.get(key) ?? null; // not cached on a failed read: asked again next time
  const v = r.value;
  const sch = v ? { every: Number(v.every), part: BigInt(v.part), fills: Number(v.fills), done: Number(v.done), next: Number(v.next) } : null;
  schedules.set(key, sch);
  return sch;
}

/**
 * Open orders to check in this round. New orders are discovered until OrderNotFound comes back (at most
 * MAX_NEW_IDS_PER_SCAN per round); at most MAX_ORDERS_PER_VAULT open orders are checked in turn, so that
 * a vault with many orders does not hold up the others and every order is looked at within a few rounds.
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

// The latest ledger, shared by the wait for the next ledger and the event reader (one request instead of two).
let latestCache = { seq: 0, at: 0 };
async function latestLedger(maxAgeMs = 0) {
  if (latestCache.seq && Date.now() - latestCache.at <= maxAgeMs) return latestCache.seq;
  // The raw answer: only the sequence is needed. SDK 17's getLatestLedger also decodes the whole ledger's header and
  // close meta from XDR on every call (and fails if the RPC leaves them out).
  const raw = typeof server._getLatestLedger === "function" ? await server._getLatestLedger() : await server.getLatestLedger();
  const seq = Number(raw && raw.sequence);
  if (!Number.isInteger(seq) || seq <= 0) throw new Error("the RPC gave no latest ledger");
  latestCache = { seq, at: Date.now() };
  return seq;
}

/** Marks the vaults that placed an order since the last scan. Any failure is harmless: the sweep finds them later. */
// When an order event names a vault: the ledger it is in and when the keeper read it (for the fill timing).
const eventSeen = new Map(); // vault -> { ledger, at }
async function collectPlaced(known, want = 0) {
  try {
    const latest = await latestLedger(2500);
    if (!eventLedger) {
      eventLedger = latest; // the first scan reads every vault anyway
      eventsOk = false;
      return;
    }
    if (latest <= eventLedger) return;
    const filters = [{ type: "contract", topics: ORDER_TOPICS }];
    let cursor = null;
    let complete = false;
    let rpcLatest = 0; // the last ledger the RPC itself has taken in (Horizon can announce a ledger a moment earlier)
    for (let page = 0; page < 50; page++) {
      let r;
      try {
        r = await server.getEvents(cursor ? { filters, cursor, limit: 200 } : { filters, startLedger: eventLedger + 1, limit: 200 });
      } catch (e) {
        // The ledger stream announced a ledger the RPC has not taken in yet: not an error, try again shortly.
        if (!cursor && /start ?ledger|ledger range|must be (between|less)/i.test(String((e && e.message) || e))) return;
        throw e;
      }
      rpcLatest = Math.max(rpcLatest, Number(r && r.latestLedger) || 0);
      const events = (r && r.events) || [];
      for (const ev of events) {
        const c = ev.contractId;
        const id = typeof c === "string" ? c : c && typeof c.contractId === "function" ? c.contractId() : String(c ?? "");
        if (known.has(id)) {
          dirty.add(id);
          if (!eventSeen.has(id)) eventSeen.set(id, { ledger: Number(ev.ledger) || null, at: Date.now() });
        }
      }
      if (events.length < 200) {
        complete = true;
        break;
      }
      const last = events[events.length - 1];
      cursor = r.cursor || last.pagingToken || last.id;
      if (!cursor) break;
    }
    // Up to the ledger the RPC had when it answered (never past it: those events would be skipped for good).
    eventLedger = rpcLatest > 0 ? Math.max(eventLedger, Math.min(latest, rpcLatest)) : latest;
    eventsOk = complete; // a flood beyond 10,000 events: fall back to reading vaults with open orders directly
    if (want && eventLedger < want) return "behind";
  } catch (e) {
    eventLedger = 0;
    eventsOk = false;
    if (Date.now() - eventLogAt > 10 * 60_000) {
      eventLogAt = Date.now();
      log(`could not read order events (empty vaults keep being scanned in turn): ${e.message || e}`);
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
  if (eventsOk) {
    // Events tell us about every change: an untouched vault is only re-read as a safety net, every SWEEP_EVERY_SEC
    // (oldest first). Before, every idle vault was read on every ledger (15 of the 17 vaults, ~3 requests/s).
    const due = idle.filter((v) => Date.now() - (vaultReadAt.get(v) || 0) >= SWEEP_EVERY_SEC * 1000);
    due.sort((a, b) => (vaultReadAt.get(a) || 0) - (vaultReadAt.get(b) || 0));
    now.push(...due.slice(0, SWEEP_PER_SCAN));
    return now;
  }
  const n = Math.min(SWEEP_PER_SCAN, idle.length);
  if (sweepAt >= idle.length) sweepAt = 0;
  for (let i = 0; i < n; i++) now.push(idle[(sweepAt + i) % idle.length]);
  sweepAt = idle.length ? (sweepAt + n) % idle.length : 0;
  return now;
}
const vaultReadAt = new Map(); // vault -> when its orders were last read

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
      throw new Error(`could not read order ${st.next} of ${short(vault)}: ${errText(r)}`);
    }
    if (statusOf(r.value.status) === "Open") {
      fresh.set(st.next, r.value);
      st.open.push(st.next);
    } // an order found already closed is never tracked: nothing to remember about it
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
  // Scheduled orders must be known before the crossing pass (they are left to the pool pass).
  for (const o of orders) await scheduleOf(vault, o.id);
  st.open = st.open.filter((id) => !closed.has(`${vault}:${id}`));
  for (const id of st.orders.keys()) if (!st.open.includes(id)) st.orders.delete(id);
  // Every closed order of this vault has now left its book: forget everything kept about it (closed, stuck,
  // notes, schedule, failure count), so a long run does not keep growing in memory.
  for (const k of [...closed]) if (k.startsWith(`${vault}:`)) forgetClosed(k);
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
 * In version 8 vaults a fill can also go through one intermediate token (e.g. USDC -> XLM -> BTC). Picks the
 * route that gives the most output for the amount: { q, via } (via null = the direct pair). Null if there is no route.
 */
async function bestRoute(amount, tin, tout, vias) {
  let best = null;
  const qs = await Promise.all(vias.map((via) => quotePath(amount, pathOf(tin, tout, via)))); // in parallel
  vias.forEach((via, i) => {
    const q = qs[i];
    if (q !== null && (best === null || q > best.q)) best = { q, via };
  });
  return best;
}

const minOut = (fill, limit) => (fill * SCALE + limit - 1n) / limit;

// ---------------------------------------------------------------------------
// Other venues (version 13 vaults): Aquarius pools beside Soroswap, alone or splitting one fill between the two
// ---------------------------------------------------------------------------
// The vault hands the fill amount to the filler contract, which runs a list of plain contract calls (the route)
// and sends the proceeds back; the vault checks the limit on what arrived. So a wrong route can only fail in
// simulation (no fee is paid), and everything here is best effort: on any doubt the order fills through
// Soroswap as before.
const addrVal = (a) => new Address(a).toScVal();
const u128 = (n) => nativeToScVal(BigInt(n), { type: "u128" });
const u64v = (n) => nativeToScVal(BigInt(n), { type: "u64" });
const symVal = (x) => xdr.ScVal.scvSymbol(x);
/** A contract struct as an ScVal map (keys must be in alphabetical order). */
// (nativeToScVal would make the keys strings, which a contract struct does not accept: they must be symbols.)
const structVal = (o) =>
  xdr.ScVal.scvMap(Object.keys(o).sort().map((k) => new xdr.ScMapEntry({ key: symVal(k), val: o[k] })));
const xget = (o, n) => (typeof o[n] === "function" ? o[n]() : o[n]); // XDR fields: functions or properties, by SDK version

const voidVal = () => xdr.ScVal.scvVoid();
/** An XDR value in its JSON form ({"address": "C..."}, {"i128": "5"}, {"u32": 1}); this SDK prints XDR that way. */
const jv = (v) => {
  try {
    return JSON.parse(JSON.stringify(v, (k, x) => (typeof x === "bigint" ? String(x) : x)));
  } catch {
    return {};
  }
};
const venueState = { said: new Set(), auth: new Map(), offUntil: 0, lastEntry: "", inputs: new Map() };
function venueSay(key, text) {
  if (venueState.said.has(key)) return;
  venueState.said.add(key);
  log(`venues: ${text}`);
}
/** The argument names of a function of a deployed contract, in order (read once), or null. */
async function inputsOf(contractId, func) {
  const key = `${contractId}.${func}`;
  if (venueState.inputs.has(key)) return venueState.inputs.get(key);
  let names = null;
  try {
    const client = await contract.Client.from({ contractId, rpcUrl: RPC_URL, networkPassphrase: PASSPHRASE });
    const f = client.spec.funcs().find((x) => String(xget(x, "name")) === func);
    names = f ? (xget(f, "inputs") || []).map((i) => String(xget(i, "name"))) : null;
  } catch {}
  venueState.inputs.set(key, names);
  return names;
}
/** Arguments by name, in the order the contract lists them; null if it wants one we do not know. */
async function argsFor(venue, contractId, func, known) {
  const names = await inputsOf(contractId, func);
  if (!names) {
    venueSay(`spec:${contractId}.${func}`, `${venue}: the function ${func} could not be read from ${short(contractId)}; ${venue} is not used`);
    return null;
  }
  const args = [];
  for (const n of names) {
    if (!(n in known)) {
      venueSay(`arg:${contractId}.${func}.${n}`, `${venue}: ${func} takes an argument this keeper does not know ("${n}"); ${venue} is not used`);
      return null;
    }
    args.push(known[n]);
  }
  return args;
}

// ----- Aquarius: a router with several pools per pair -----
const aquaPoolCache = new Map();
/** Aquarius wants a pool's tokens in address order (the raw contract ids compared as bytes). */
function aquaTokens(a, b) {
  const sorted = [a, b].sort((x, y) => Buffer.compare(StrKey.decodeContract(x), StrKey.decodeContract(y)));
  return xdr.ScVal.scvVec(sorted.map(addrVal));
}
const aquaVenue = {
  name: "Aquarius",
  on: () => !!AQUA_ROUTER,
  /** The pools of a pair: [{ id, hash }] (read again every 10 minutes). */
  async options(a, b) {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const c = aquaPoolCache.get(key);
    if (c && Date.now() - c.at < 10 * 60_000) return c.list;
    const list = [];
    try {
      const sim = await server.simulateTransaction(readTx(AQUA_ROUTER, "get_pools", [aquaTokens(a, b)]));
      if (!rpc.Api.isSimulationError(sim) && sim.result) {
        const map = sim.result.retval;
        const entries = (typeof map.map === "function" ? map.map() : map.value ?? map._value) || [];
        for (const e of entries) {
          const kn = scValToNative(xget(e, "key"));
          const hash = Buffer.from(kn instanceof Uint8Array ? kn : Object.values(kn));
          if (hash.length === 32) list.push({ id: hash.toString("hex"), hash });
        }
      }
    } catch {}
    aquaPoolCache.set(key, { at: Date.now(), list });
    return list;
  },
  async quote(opt, tin, tout, amount) {
    const r = await read(AQUA_ROUTER, "estimate_swap", [aquaTokens(tin, tout), addrVal(tin), addrVal(tout), xdr.ScVal.scvBytes(opt.hash), u128(amount)]);
    return r.ok && r.value !== undefined ? BigInt(r.value) : null;
  },
  async call(user, opt, tin, tout, amount, lim = null) {
    const args = await argsFor("Aquarius", AQUA_ROUTER, "swap", {
      user: addrVal(user),
      tokens: aquaTokens(tin, tout),
      token_in: addrVal(tin),
      token_out: addrVal(tout),
      pool_index: xdr.ScVal.scvBytes(opt.hash),
      in_amount: u128(amount),
      out_min: u128(lim && lim.min > 0n ? lim.min : 1n),
    });
    return args && { contract: AQUA_ROUTER, func: "swap", args };
  },
};

// ----- Phoenix: one pool per pair, reached through its multihop contract -----
const phoenixOps = (tin, tout, min = 0n) =>
  xdr.ScVal.scvVec([structVal({ offer_asset: addrVal(tin), ask_asset: addrVal(tout), ask_asset_min_amount: min > 0n ? i128(min) : voidVal() })]);
const PHOENIX_XYK = () => u32(0); // PoolType::Xyk
const phoenixHas = new Map();
const phoenixVenue = {
  name: "Phoenix",
  on: () => !!PHOENIX_MULTIHOP,
  /** One entry if Phoenix has a pool for the pair (asked again every 10 minutes), none otherwise. */
  async options(a, b) {
    const key = `${a}|${b}`;
    const c = phoenixHas.get(key);
    if (c && Date.now() - c.at < 10 * 60_000) return c.list;
    const q = await this.quote(null, a, b, VENUE_PROBE);
    const list = q !== null && q > 0n ? [{ id: "pool" }] : [];
    phoenixHas.set(key, { at: Date.now(), list });
    return list;
  },
  async quote(opt, tin, tout, amount) {
    const args = await argsFor("Phoenix", PHOENIX_MULTIHOP, "simulate_swap", { operations: phoenixOps(tin, tout), amount: i128(amount), pool_type: PHOENIX_XYK() });
    if (!args) return null;
    const r = await read(PHOENIX_MULTIHOP, "simulate_swap", args);
    return r.ok && r.value && r.value.ask_amount !== undefined ? BigInt(r.value.ask_amount) : null;
  },
  async call(user, opt, tin, tout, amount, lim = null) {
    const args = await argsFor("Phoenix", PHOENIX_MULTIHOP, "swap", {
      recipient: addrVal(user),
      operations: phoenixOps(tin, tout, lim ? lim.min : 0n),
      max_spread_bps: voidVal(),
      amount: i128(amount),
      pool_type: PHOENIX_XYK(),
      deadline: voidVal(),
      max_allowed_fee_bps: voidVal(),
    });
    return args && { contract: PHOENIX_MULTIHOP, func: "swap", args };
  },
};
// ----- Comet: weighted pools, each its own contract; a pool has no quote function -----
// A quote is a simulation of the swap itself, with the Soroswap pool of the pair standing in as the seller (it
// holds both tokens; a simulation needs no signature). If that cannot be simulated the pool is simply not used.
const I128_MAX = 170141183460469231731687303715884105727n;
const cometHas = new Map();
const cometVenue = {
  name: "Comet",
  on: () => COMET_POOLS.length > 0,
  /** The configured pools that can swap this pair right now (asked again every 10 minutes). */
  async options(a, b) {
    const key = `${a}|${b}`;
    const c = cometHas.get(key);
    if (c && Date.now() - c.at < 10 * 60_000) return c.list;
    const list = [];
    for (const pool of COMET_POOLS) {
      const q = await this.quote({ id: pool, pool }, a, b, VENUE_PROBE);
      if (q !== null && q > 0n) list.push({ id: pool, pool });
    }
    cometHas.set(key, { at: Date.now(), list });
    return list;
  },
  async quote(opt, tin, tout, amount) {
    const holder = await poolOf(tin, tout);
    if (!holder) return null;
    const c = await this.call(holder.pair, opt, tin, tout, amount);
    if (!c) return null;
    const r = await read(c.contract, c.func, c.args);
    const out = r.ok && r.value ? (Array.isArray(r.value) ? r.value[0] : r.value) : null;
    try {
      return out === null || out === undefined ? null : BigInt(out);
    } catch {
      return null;
    }
  },
  async call(user, opt, tin, tout, amount, lim = null) {
    const min = lim && lim.min > 0n ? lim.min : 0n;
    const args = await argsFor("Comet", opt.pool, "swap_exact_amount_in", {
      token_in: addrVal(tin),
      token_amount_in: i128(amount),
      token_out: addrVal(tout),
      min_amount_out: i128(min),
      max_price: i128(lim ? cometMaxPrice(amount, min, COMET_MAX_PRICE_FACTOR) : I128_MAX),
      user: addrVal(user),
    });
    return args && { contract: opt.pool, func: "swap_exact_amount_in", args };
  },
};
const venueList = () => [aquaVenue, phoenixVenue, cometVenue].filter((v) => v.on());

// ----- what a venue does in its caller's name -----
const VENUE_PROBE = 100_000n; // 0.01 token
// The minimum output the template is learned with. Where a venue's swap passes the caller's minimum on to a pool
// that checks the caller's signature (Aquarius, Phoenix), the minimum is part of the authorized call: the real
// leg's minimum then takes its place in venueAuths, exactly like the real amount takes the probe's place.
const VENUE_MIN_PROBE = 11n;
/** One authorized call as { contract, func, args (ScVal[]), subs }, two levels deep at most (null if deeper). */
function authNode(inv, depth) {
  const cf = inv.function && inv.function.contractFn;
  if (!cf) return null;
  const subs = [];
  for (const sub of inv.subInvocations || []) {
    if (depth >= 1) return null;
    const n = authNode(sub, depth + 1);
    if (!n) return null;
    subs.push(n);
  }
  return { contract: String(jv(cf.contractAddress)), func: String(jv(cf.functionName)), args: [...cf.args], subs };
}
/** Read from a simulation with the keeper as the caller and a small amount. */
async function venueLearn(venue, opt, tin, tout) {
  const c = await venue.call(kp.publicKey(), opt, tin, tout, VENUE_PROBE, { min: VENUE_MIN_PROBE });
  if (!c) return null;
  const sim = await server.simulateTransaction(readTx(c.contract, c.func, c.args));
  if (rpc.Api.isSimulationError(sim) || !sim.result) return null; // typically: the keeper holds none of the token
  const list = [];
  for (const entry of sim.result.auth || []) {
    venueState.lastEntry = JSON.stringify(jv(entry.rootInvocation && entry.rootInvocation.subInvocations)).slice(0, 1600);
    for (const sub of (entry.rootInvocation && entry.rootInvocation.subInvocations) || []) {
      const n = authNode(sub, 0);
      if (!n) return null;
      list.push(n);
    }
  }
  return list;
}
/** The same template for the opposite direction in the same pool: the two tokens and the two pool indexes change places. */
function venueMirror(list, tin, tout) {
  const flip = (id) => (id === tin ? tout : id === tout ? tin : id);
  const flipArgs = (args) => {
    const u32s = args.map((a, i) => (jv(a).u32 !== undefined ? i : -1)).filter((i) => i >= 0);
    const out = args.map((a) => {
      const j = jv(a);
      return typeof j.address === "string" && (j.address === tin || j.address === tout) ? addrVal(flip(j.address)) : a;
    });
    if (u32s.length === 2) [out[u32s[0]], out[u32s[1]]] = [out[u32s[1]], out[u32s[0]]];
    return out;
  };
  const node = (n) => ({ contract: flip(n.contract), func: n.func, args: flipArgs(n.args), subs: n.subs.map(node) });
  return list.map(node);
}
/**
 * The calls a venue's swap makes in its caller's name, as a template (the keeper's address stands for "the
 * caller", the probe amount for "the amount"). Read from a simulation; if the keeper holds none of the sold
 * token, the opposite direction is read instead and mirrored. null when neither works (tried again in 30 minutes).
 */
async function venueTemplate(venue, opt, tin, tout) {
  const key = `${venue.name}:${tin}:${tout}:${opt.id}`;
  const c = venueState.auth.get(key);
  if (c && (c.list ? Date.now() - c.at < 6 * 3600_000 : Date.now() - c.at < 30 * 60_000)) return c.list;
  let list = null;
  try {
    list = await venueLearn(venue, opt, tin, tout);
    if (!list) {
      const other = await venueLearn(venue, opt, tout, tin);
      if (other) {
        list = venueMirror(other, tin, tout);
        list.mirrored = true;
      }
    }
  } catch (e) {
    venueSay(`learn:${key}`, `could not read how ${venue.name} takes ${sym(tin)}: ${e.message}`);
  }
  if (!list) venueSay(`none:${key}`, `how ${venue.name} takes ${sym(tin)} could not be read in either direction; it is not used for that for now`);
  venueState.auth.set(key, { at: Date.now(), list });
  return list;
}
/** The template with the filler as caller, the real amount and the leg's minimum, as `Auth` values for the filler. */
function venueAuths(template, amount, min = 0n) {
  const me = kp.publicKey();
  const subst = (args) =>
    args.map((a) => {
      const j = jv(a);
      if (j.address === me) return addrVal(FILLER);
      if (j.i128 !== undefined && typeof j.i128 !== "object" && BigInt(j.i128) === VENUE_PROBE) return i128(amount);
      if (j.u128 !== undefined && typeof j.u128 !== "object" && BigInt(j.u128) === VENUE_PROBE) return u128(amount);
      if (j.i128 !== undefined && typeof j.i128 !== "object" && BigInt(j.i128) === VENUE_MIN_PROBE) return i128(min > 0n ? min : 1n);
      if (j.u128 !== undefined && typeof j.u128 !== "object" && BigInt(j.u128) === VENUE_MIN_PROBE) return u128(min > 0n ? min : 1n);
      return a;
    });
  const leaf = (n) => structVal({ contract: addrVal(n.contract), func: symVal(n.func), args: xdr.ScVal.scvVec(subst(n.args)) });
  return template.map((n) =>
    structVal({ contract: addrVal(n.contract), func: symVal(n.func), args: xdr.ScVal.scvVec(subst(n.args)), subs: xdr.ScVal.scvVec(n.subs.map(leaf)) }),
  );
}
/** One step of a filler route as an ScVal (`Call` in contracts/filler). */
const callVal = (contractId, func, args, auths) =>
  structVal({ contract: addrVal(contractId), func: symVal(func), args: xdr.ScVal.scvVec(args), auths: xdr.ScVal.scvVec(auths) });

let fillerVersion; // 1: plain routes; 2: routes may end with the `sweep` instruction (needed for an intermediate token)
async function fillerV() {
  if (fillerVersion !== undefined) return fillerVersion;
  const r = await read(FILLER, "version");
  fillerVersion = r.ok ? Number(r.value) : 1;
  return fillerVersion;
}
/** The Soroswap pool of a pair as a route step for the filler; `min`: the leg's minimum output (amount_out_min). */
function soroStep(tin, tout, pair, amount, min = 0n) {
  const deadline = Math.floor(Date.now() / 1000) + 300;
  return callVal(
    ROUTER,
    "swap_exact_tokens_for_tokens",
    [i128(amount), i128(min > 0n ? min : 0n), xdr.ScVal.scvVec([addrVal(tin), addrVal(tout)]), addrVal(FILLER), u64v(deadline)],
    [structVal({ contract: addrVal(tin), func: symVal("transfer"), args: xdr.ScVal.scvVec([addrVal(FILLER), addrVal(pair), i128(amount)]), subs: xdr.ScVal.scvVec([]) })],
  );
}
/**
 * What the best pool of the other venues would pay for `amount` at its near-spot rate (the rate for a small
 * reference trade, kept for 20 seconds per pair). It ignores price impact, so it is an upper bound: good for
 * deciding that an order is NOT worth a route search. null when no venue quotes the pair.
 */
const VENUE_REF = 100_000_000n; // 10 tokens
const venueSpot = new Map();
async function venueEst(amount, tin, tout) {
  if (!VENUES || Date.now() < venueState.offUntil) return null;
  const key = `${tin}|${tout}`;
  let c = venueSpot.get(key);
  if (!c || Date.now() - c.at > 20_000) {
    let best = null;
    try {
      for (const venue of venueList()) {
        for (const opt of await venue.options(tin, tout)) {
          const q = await venue.quote(opt, tin, tout, VENUE_REF);
          if (q !== null && (best === null || q > best)) best = q;
        }
      }
    } catch {}
    c = { at: Date.now(), q: best };
    venueSpot.set(key, c);
  }
  return c.q === null ? null : (amount * c.q) / VENUE_REF;
}
/**
 * Every pool that can swap `tin` for `tout` through the filler: the Soroswap pool and each pool of the other
 * venues whose way of taking the token is known. Each is { label, soroswap, quote(amount), step(amount) }.
 * `only`: a venue name; then only that venue's pools and the Soroswap pool.
 */
async function sourcesFor(tin, tout, only = null) {
  const list = [];
  const soro = await poolOf(tin, tout);
  if (soro) list.push({ label: "Soroswap", soroswap: true, quote: (a) => quotePath(a, [tin, tout]), step: async (a, min = 0n) => soroStep(tin, tout, soro.pair, a, min) });
  for (const venue of venueList()) {
    if (only && venue.name !== only) continue;
    const opts = await venue.options(tin, tout);
    for (const opt of opts) {
      list.push({
        label: opts.length > 1 ? `${venue.name} ${String(opt.id).slice(0, 4)}` : venue.name,
        soroswap: false,
        quote: (a) => venue.quote(opt, tin, tout, a),
        // How the pool takes its token is read only for a pool that is actually used (many pools are empty or tiny).
        step: async (a, min = 0n) => {
          const template = await venueTemplate(venue, opt, tin, tout);
          const c = template ? await venue.call(FILLER, opt, tin, tout, a, { min }) : null;
          return c ? callVal(c.contract, c.func, c.args, venueAuths(template, a, min)) : null;
        },
      });
    }
  }
  return list;
}
/**
 * Spreads `amount` over the pools in whatever shares pay the most (12% here, 20% there, 68% in a third: no
 * fixed steps). Each pool is asked what it pays at a few sizes, which gives its price curve; the amount is then
 * handed out in 1% steps, each to the pool whose curve pays the most for it on top of what that pool already
 * took. That part is arithmetic, not network calls. Finally the chosen amounts are quoted for real.
 * Returns { q, parts: [{ src, amount }] } or null.
 */
const SPREAD_POINTS = [2n, 5n, 10n, 20n, 35n, 50n, 70n, 100n]; // percent of the amount at which each pool is asked
const SPREAD_MIN_SHARE = 2n; // a pool that would get less than this share is not worth its own step
const SPREAD_MAX_LEGS = 4;
function curveAt(pts, x) {
  // Between two samples the curve of a pool is taken as a*x/(b+x), the shape of a constant-product pool, fitted
  // through those two samples (exact for such pools, close for others); a straight line where that does not fit.
  const X = Number(x);
  const last = pts[pts.length - 1];
  if (X >= Number(last[0])) return Number(last[1]);
  let i = 1;
  while (i < pts.length - 1 && X > Number(pts[i][0])) i++;
  const lo = i === 1 ? (pts.length > 2 ? pts[1] : null) : pts[i - 1];
  const hi = i === 1 ? (pts.length > 2 ? pts[2] : null) : pts[i];
  if (lo && hi) {
    const [x0, q0, x1, q1] = [Number(lo[0]), Number(lo[1]), Number(hi[0]), Number(hi[1])];
    const den = q0 * x1 - q1 * x0;
    if (den > 0 && q1 > q0) {
      const b = (x0 * x1 * (q1 - q0)) / den;
      const a = (q0 * (b + x0)) / x0;
      if (b > 0 && a > 0) return (a * X) / (b + X);
    }
  }
  const [xa, qa, xb, qb] = [Number(pts[i - 1][0]), Number(pts[i - 1][1]), Number(pts[i][0]), Number(pts[i][1])];
  return qa + ((qb - qa) * (X - xa)) / (xb - xa);
}
async function spread(sources, amount) {
  if (!sources.length || amount <= 0n) return null;
  // Pools that pay less than half of the best one for a tenth of the amount are left out (empty and tiny pools).
  const tenth = amount / 10n > 0n ? amount / 10n : amount;
  const first = await Promise.all(sources.map((src) => src.quote(tenth)));
  const top = first.reduce((m, q) => (q !== null && q > m ? q : m), 0n);
  sources = sources.filter((src, i) => first[i] !== null && first[i] > 0n && first[i] * 2n >= top);
  if (!sources.length) return null;
  if (sources.length === 1) {
    const q = await sources[0].quote(amount);
    return q !== null && q > 0n ? { q, parts: [{ src: sources[0], amount, q }] } : null;
  }
  // each pool's curve: (0, 0) and what it pays at the sample sizes, as far as it can quote
  const curves = await Promise.all(
    sources.map(async (src) => {
      const pts = [[0n, 0n]];
      for (const p of SPREAD_POINTS) {
        const x = (amount * p) / 100n;
        if (x <= pts[pts.length - 1][0]) continue;
        const q = await src.quote(x);
        if (q === null || q <= pts[pts.length - 1][1]) break; // cannot take more than this
        pts.push([x, q]);
      }
      return pts;
    }),
  );
  const taken = sources.map(() => 0n);
  const unit = amount / 100n;
  if (unit > 0n) {
    for (let s = 0; s < 100; s++) {
      const size = s === 99 ? amount - unit * 99n : unit;
      let pick = -1;
      let gain = -1;
      curves.forEach((pts, i) => {
        if (pts.length < 2 || taken[i] + size > pts[pts.length - 1][0]) return;
        const g = curveAt(pts, taken[i] + size) - curveAt(pts, taken[i]);
        if (g > gain) {
          gain = g;
          pick = i;
        }
      });
      if (pick < 0) break;
      taken[pick] += size;
    }
  }
  // small shares fold into the largest one, and at most SPREAD_MAX_LEGS pools take part
  let order = sources.map((_, i) => i).filter((i) => taken[i] > 0n).sort((a, b) => (taken[b] > taken[a] ? 1 : taken[b] < taken[a] ? -1 : 0));
  const keep = order.filter((i, n) => n < SPREAD_MAX_LEGS && taken[i] * 100n >= amount * SPREAD_MIN_SHARE);
  let split = null;
  if (keep.length) {
    const used = keep.reduce((a, i) => a + taken[i], 0n);
    const parts = keep.map((i, n) => ({ src: sources[i], amount: taken[i] + (n === 0 ? amount - used : 0n) }));
    const qs = await Promise.all(parts.map((p) => p.src.quote(p.amount)));
    if (!qs.includes(null)) split = { q: qs.reduce((a, b) => a + b, 0n), parts: parts.map((p, i) => ({ ...p, q: qs[i] })) };
  }
  // the curve is an estimate between samples: the best single pool is kept if it turns out to pay as much
  let single = null;
  curves.forEach((pts, i) => {
    const last = pts[pts.length - 1];
    if (last[0] === amount && (!single || last[1] > single.q)) single = { q: last[1], parts: [{ src: sources[i], amount, q: last[1] }] };
  });
  if (split && single) return split.q > single.q ? split : single;
  return split || single;
}
/** The single pool that pays the most for the whole amount: { src, q } or null. */
async function bestSingle(sources, amount) {
  let best = null;
  const qs = await Promise.all(sources.map((src) => src.quote(amount)));
  qs.forEach((q, i) => {
    if (q !== null && q > 0n && (!best || q > best.q)) best = { src: sources[i], q };
  });
  return best;
}
const partsText = (parts, total) =>
  parts.length === 1 ? parts[0].src.label : parts.map((p) => `${p.src.label} ${Number((p.amount * 100n) / total)}%`).join(" + ");

/**
 * The best way to sell `fill` of `tin` for `tout` through the filler that involves another venue:
 * - direct: the amount spread over the Soroswap pool and the other venues' pools of the pair;
 * - through an intermediate token (XLM or USDC): the best pool for each of the two legs, which may be on
 *   different venues (needs a filler that knows `sweep`).
 * Every pool is an equal candidate: the Soroswap pool is one source among the others, not the default.
 * `only` (a venue name) and `forceShare` (percent on that venue, the rest on Soroswap) are for the check command.
 * Returns { q, route (ScVal), text } or null.
 */
// Every leg gets a minimum output (SLIPPAGE_BPS below its own quote, never below its share of `need`, what the
// vault's limit requires for `fill`; 0 = no floor). A route whose quotes cannot cover `need` is not built.
async function venueRoute(fill, tin, tout, forceShare = null, only = null, need = 0n) {
  if (!VENUES || Date.now() < venueState.offUntil) return null;
  // A route of the same shape found in the last ROUTE_SHAPE_SEC: only its legs are quoted again (a few requests
  // instead of a full search). Not for the check command (forceShare / only).
  if (forceShare === null && !only && ROUTE_SHAPE_SEC > 0) {
    const fast = await preparedRoute(fill, tin, tout, need);
    if (fast) return fast;
  }
  try {
    const sources = await sourcesFor(tin, tout, only);
    const others = sources.filter((s) => !s.soroswap);
    let best = null; // { q, steps: [async () => ScVal | null], text }
    if (forceShare !== null) {
      // the check command: the venue's best pool takes exactly this share, Soroswap the rest
      const top = await bestSingle(others, fill);
      const soro = sources.find((s) => s.soroswap);
      if (!top || (forceShare < 100n && !soro)) return null;
      const a = (fill * forceShare) / 100n;
      const parts = forceShare >= 100n ? [{ src: top.src, amount: fill }] : [{ src: top.src, amount: a }, { src: soro, amount: fill - a }];
      const qs = await Promise.all(parts.map((p) => p.src.quote(p.amount)));
      if (qs.includes(null)) return null;
      const mins = splitMins(qs, need, SLIPPAGE_BPS);
      if (!mins) return null;
      best = { q: qs.reduce((x, y) => x + y, 0n), steps: parts.map((p, i) => () => p.src.step(p.amount, mins[i])), text: partsText(parts, fill) };
    } else {
      if (sources.length) {
        const sp = await spread(sources, fill);
        const mins = sp ? splitMins(sp.parts.map((p) => p.q), need, SLIPPAGE_BPS) : null;
        if (sp && mins) {
          best = { q: sp.q, steps: sp.parts.map((p, i) => () => p.src.step(p.amount, mins[i])), text: partsText(sp.parts, fill) };
          best.shape = { kind: "split", labels: sp.parts.map((p) => p.src.label), shares: sharesOf(sp.parts.map((p) => p.amount), fill) };
        }
      }
      // through an intermediate token, each leg in its best pool
      if ((await fillerV()) >= 2) {
        for (const mid of [XLM, USDC]) {
          if (mid === tin || mid === tout) continue;
          const [s1, s2] = await Promise.all([sourcesFor(tin, mid), sourcesFor(mid, tout)]);
          const leg1 = await bestSingle(s1, fill);
          if (!leg1) continue;
          // Leg 2 sells leg 1's minimum (see viaPlan): any leg-1 result within the tolerance pays for it, and
          // what leg 1 brings above it goes to the vault by the sweep step. Leg 2 is quoted for that amount.
          const plan = viaPlan(leg1.q, SLIPPAGE_BPS);
          if (plan.in2 <= 0n) continue;
          const leg2 = await bestSingle(s2, plan.in2);
          if (!leg2) continue;
          const min2 = splitMins([leg2.q], need, SLIPPAGE_BPS);
          if (!min2) continue;
          if (!best || leg2.q > best.q) {
            best = {
              q: leg2.q,
              steps: [() => leg1.src.step(fill, plan.min1), () => leg2.src.step(plan.in2, min2[0]), async () => callVal(FILLER, "sweep", [addrVal(mid)], [])],
              text: `${leg1.src.label} to ${sym(mid)}, then ${leg2.src.label}`,
              shape: { kind: "via", mid, l1: leg1.src.label, l2: leg2.src.label },
            };
          }
        }
      }
    }
    if (!best) return null;
    const steps = [];
    for (const make of best.steps) {
      const v = await make();
      if (!v) return null;
      steps.push(v);
    }
    if (best.shape && forceShare === null && !only) routeShapes.set(shapeKey(tin, tout, fill), { ...best.shape, at: Date.now() });
    return { q: best.q, route: xdr.ScVal.scvVec(steps), text: best.text };
  } catch (e) {
    venueState.offUntil = Date.now() + 10 * 60_000;
    log(`venues: ${e.message}; other venues are skipped for 10 minutes`);
    return null;
  }
}

// pair + fill size class -> the shape of the last best route: { kind: "split", labels, shares } | { kind: "via", mid, l1, l2 }
const routeShapes = new Map();
/**
 * The last best route's shape for this pair and fill size, rebuilt for `fill` with fresh quotes of its own legs
 * only (each leg's minimum from its own fresh quote, as in a full search). null when there is none, it is too old,
 * or a leg cannot be quoted/built now: then the full search runs.
 */
async function preparedRoute(fill, tin, tout, need) {
  const key = shapeKey(tin, tout, fill);
  const sh = routeShapes.get(key);
  if (!sh || Date.now() - sh.at > ROUTE_SHAPE_SEC * 1000) return null;
  try {
    if (sh.kind === "split") {
      const sources = await sourcesFor(tin, tout);
      const srcs = sh.labels.map((l) => sources.find((x) => x.label === l));
      if (srcs.includes(undefined)) return null;
      const amounts = scaleShares(sh.shares, fill);
      const qs = await Promise.all(srcs.map((src, i) => src.quote(amounts[i])));
      if (qs.some((q) => q === null || q <= 0n)) return null;
      const mins = splitMins(qs, need, SLIPPAGE_BPS);
      if (!mins) return null;
      const steps = await Promise.all(srcs.map((src, i) => src.step(amounts[i], mins[i])));
      if (steps.includes(null)) return null;
      const parts = srcs.map((src, i) => ({ src, amount: amounts[i] }));
      return { q: qs.reduce((a, b) => a + b, 0n), route: xdr.ScVal.scvVec(steps), text: `${partsText(parts, fill)} (prepared)` };
    }
    if (sh.kind === "via") {
      const [s1, s2] = await Promise.all([sourcesFor(tin, sh.mid), sourcesFor(sh.mid, tout)]);
      const a = s1.find((x) => x.label === sh.l1);
      const b = s2.find((x) => x.label === sh.l2);
      if (!a || !b) return null;
      const q1 = await a.quote(fill);
      if (q1 === null || q1 <= 0n) return null;
      const plan = viaPlan(q1, SLIPPAGE_BPS);
      const q2 = plan.in2 > 0n ? await b.quote(plan.in2) : null;
      if (q2 === null || q2 <= 0n) return null;
      const min2 = splitMins([q2], need, SLIPPAGE_BPS);
      if (!min2) return null;
      const steps = await Promise.all([a.step(fill, plan.min1), b.step(plan.in2, min2[0])]);
      if (steps.includes(null)) return null;
      steps.push(callVal(FILLER, "sweep", [addrVal(sh.mid)], []));
      return { q: q2, route: xdr.ScVal.scvVec(steps), text: `${sh.l1} to ${sym(sh.mid)}, then ${sh.l2} (prepared)` };
    }
  } catch {}
  return null;
}

/** Same as the contract's price impact calculation. */
async function impactBps(fill, tin, tout, via = null) {
  const probe = fill / 100n;
  if (probe === 0n) return 0n;
  const [full, small] = await Promise.all([quotePath(fill, pathOf(tin, tout, via)), quotePath(probe, pathOf(tin, tout, via))]);
  if (full === null || small === null) return null;
  const ideal = (small * fill) / probe;
  if (ideal <= 0n) return 0n;
  return ((ideal - full) * BPS) / ideal;
}

/**
 * Fill sizes to try: everything that is left, then halved down to the floor (largest first).
 * The contract (version 4) rejects a partial fill that would leave less than the minimum fill behind
 * (FillTooSmall); those sizes are never tried.
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
// Per scan: which orders were checked and which are known to be far from filling (see SCAN_IDLE_SEC). An order
// not marked far counts as near, so anything unsure keeps the keeper scanning on every ledger.
const proximity = { checked: new Set(), far: new Set(), near: false };
/** Marks the order far when the output it would get now is more than SCAN_NEAR_PCT below what its limit needs. */
function noteDistance(key, q, need) {
  if (!isNear(limitRatio(q, need), SCAN_NEAR_PCT)) proximity.far.add(key);
}
const lastNote = new Map();
// "vault:id" -> { n, until }: an order that passes the pre-checks but keeps being rejected by the contract. The wait
// doubles with each run of rejections (1, 2, 4 ... at most 60 rounds), so a stuck order does not waste RPC calls and log space.
const stuck = new Map();
// "vault:id" -> filler routes in a row that failed in simulation (see ROUTE_RETRIES)
const routeMiss = new Map();
let scanNo = 0;
stats.onchainFailures = 0;
stats.failedFeesStroop = 0n;

/** Forgets everything kept about a closed order (memory stays flat on a long run). */
function forgetClosed(key) {
  forgetOrder(key, [closed, stuck, lastNote, schedules, failGuard.map, routeMiss]);
}

/**
 * A transaction that FAILED ON CHAIN (its fee was paid). After FAIL_PAUSE_AFTER such failures the order (or the
 * crossing pair) rests for FAIL_PAUSE_HOURS: said in the log and on Telegram.
 */
async function onchainFail(key, tag, r) {
  stats.failures++;
  stats.onchainFailures++;
  stats.lastError = `${tag}: ${errText(r)}`;
  if (r.charged) stats.failedFeesStroop += BigInt(r.charged);
  const g = failGuard.record(key);
  const paid = r.charged ? `${fmt(BigInt(r.charged))} XLM` : "?";
  if (!g.paused) {
    log(`${tag} failed ON CHAIN (${g.n}/${FAIL_PAUSE_AFTER}, fee paid ${paid}): ${errText(r)} tx=${r.hash || "?"}`);
    return;
  }
  const until = new Date(g.until).toISOString();
  log(`${tag} failed ON CHAIN ${FAIL_PAUSE_AFTER} times (last fee ${paid}, tx=${r.hash || "?"}): paused until ${until}`);
  await notify(`Order ${tag} failed on chain ${FAIL_PAUSE_AFTER} times (${errText(r)}); it is paused until ${until}. Please check.`, {
    topic: `pause:${key}`,
    everySec: 3600,
  });
}

/** The order (or crossing pair) rests for a while: 1, 2, 4 ... at most 60 rounds. */
function restKey(key) {
  const n = (stuck.get(key)?.n || 0) + 1;
  const rounds = Math.min(2 ** (n - 1), 60);
  stuck.set(key, { n, until: scanNo + rounds });
  return rounds;
}

function waiting(vault, o, tag, remaining, tin, reason) {
  // The log file must not bloat when scanning on every ledger: it is written again only when the reason for waiting changes.
  const note = `${tag} waiting (${fmt(remaining)} ${sym(tin)} left): ${reason || "no suitable fill"}`;
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
  if (q === null || q <= 0n) return `no pool can quote ${fmt(fill)} ${sym(tin)} right now`;
  if (tin === USDC) return `market ${(Number(fill) / Number(q)).toFixed(4)} > limit ${fmt(limit)} USDC/XLM`;
  // Sell: the limit is "at most how many XLM for 1 USDC"; the user is shown "at least how many USDC for 1 XLM".
  const target = 1e7 / Number(limit);
  return `market ${(Number(q) / Number(fill)).toFixed(4)} < target ${target.toFixed(4)} ${sym(tout)}/${sym(tin)}`;
}

async function tryOrder(vault, o, ctx = { net: 0 }) {
  const pc = await pair(vault);
  const tin = pc.v7 ? String(o.sell) : pc.tin;
  const tout = pc.v7 ? String(o.buy) : pc.tout;
  const v5 = pc.v5;
  const fee = pc.v7 ? (pc.fees[tout] ?? 0n) : pc.fee;
  // Intermediate token candidates: only in version 8 and when the pair is not XLM/USDC (both are on the factory's allowed list).
  const vias = [null, ...(pc.v8 ? [XLM, USDC].filter((t) => t !== tin && t !== tout) : [])];
  const execArgs = (amount, via = null) =>
    pc.v8
      ? [new Address(kp.publicKey()).toScVal(), u32(o.id), i128(amount), via ? new Address(via).toScVal() : xdr.ScVal.scvVoid()]
      : v5
        ? [new Address(kp.publicKey()).toScVal(), u32(o.id), i128(amount)]
        : [u32(o.id), i128(amount)];
  const side = tin === USDC ? "buy" : "sell";
  const tag = `${short(vault)} #${o.id} (${side})`;
  const key = `${vault}:${o.id}`;
  const now = Math.floor(Date.now() / 1000);
  const expiry = Number(o.expiry);
  if (now > expiry) {
    // The computer's clock may be fast: an order is closed for good only after a 10-minute margin.
    if (now > expiry + 600) closed.add(key);
    proximity.far.add(key);
    return waiting(vault, o, tag, BigInt(o.amount_in) - BigInt(o.filled_in), tin, "expired");
  }
  const remaining = BigInt(o.amount_in) - BigInt(o.filled_in);
  const held = stuck.get(key);
  if (held && scanNo < held.until) return "waiting";
  const pausedTill = failGuard.pausedUntil(key);
  if (pausedTill) proximity.far.add(key);
  if (pausedTill) return waiting(vault, o, tag, remaining, tin, `paused after ${FAIL_PAUSE_AFTER} on-chain failures, until ${new Date(pausedTill).toISOString()}`);
  const limit = BigInt(o.limit_price);
  const minFill = BigInt(o.min_fill);
  const maxImpact = BigInt(o.max_impact_bps);
  const trigger = BigInt(o.trigger_price ?? 0);
  // Scheduled order (DCA): nothing to do until the next part is due, and then exactly one part is filled.
  let sch = await scheduleOf(vault, o.id);
  if (sch && now >= sch.next + DCA_CLOCK_MARGIN_SEC) sch = await scheduleOf(vault, o.id, true); // someone else may have filled it
  // A part due later than the idle interval does not need every-ledger scans; one due sooner does.
  if (sch && sch.next + DCA_CLOCK_MARGIN_SEC - now > SCAN_IDLE_SEC) proximity.far.add(key);
  if (sch && now < sch.next + DCA_CLOCK_MARGIN_SEC) return waiting(vault, o, tag, remaining, tin, "scheduled order: the next part is not due yet");
  const part = remaining; // a scheduled order always holds exactly one part
  if (sch && part < minFillFor(tin)) return waiting(vault, o, tag, remaining, tin, "scheduled order: one part is below the smallest fill the keeper sends");
  const sizes = sch ? [part] : candidates(remaining, minFill > minFillFor(tin) ? minFill : minFillFor(tin), minFill);
  const smallest = sizes[sizes.length - 1];

  // Local price check first: no network call for an order whose limit is clearly not met (see "local price check").
  const lk = `${tin}|${tout}`;
  const lc = localCheck.get(lk);
  const est = lc && lc.offUntil > Date.now() ? null : await localBest(smallest, tin, tout, vias);
  const trusted = !!(lc && lc.okAt && Date.now() - lc.okAt < LOCAL_RECHECK_MS);
  // With other venues in play the Soroswap price alone does not rule an order out: on a real market another
  // venue can pay far more (Soroswap's pool may be the shallow one). The best venue's near-spot rate, kept for
  // 20 seconds per pair, is asked before the order is put aside.
  const useVenues = VENUES && pc.v13;
  if (est !== null && trusted && (est * 1005n) / 1000n + 2n < minOut(smallest, limit)) {
    const top = useVenues ? await venueEst(smallest, tin, tout) : null;
    if (top === null || (top * 1005n) / 1000n + 2n < minOut(smallest, limit)) {
      localSkips++;
      noteDistance(key, top !== null && top > est ? top : est, minOut(smallest, limit));
      return waiting(vault, o, tag, remaining, tin, priceNoteFor(tin, tout, smallest, top !== null && top > est ? top : est, limit));
    }
  }
  ctx.net++; // from here on the order costs network calls

  // Triggered order (stop loss): the contract checks the trigger against the Blend oracle. The trigger is asked first
  // with a single simulation; if it has not come ("no trigger" 16, "no oracle" 19), it waits without any price query.
  if (trigger > 0n) {
    const pre = await read(vault, "execute", execArgs(smallest));
    // The oracle price changes every few minutes, not every ledger: a stop order waiting for it counts as far.
    if (!pre.ok && (pre.code === 16 || pre.code === 19)) proximity.far.add(key);
    if (!pre.ok && pre.code === 16) return waiting(vault, o, tag, remaining, tin, "the trigger price (oracle) has not been reached yet");
    if (!pre.ok && pre.code === 19) return waiting(vault, o, tag, remaining, tin, "no oracle price available");
  }

  // If even the smallest fill does not meet the limit, larger ones will not either (a larger trade gets a worse price
  // in the pool): a waiting order costs one price query per ledger.
  const rSmall = await bestRoute(smallest, tin, tout, vias);
  // Without a Soroswap quote the order can still fill elsewhere when other venues are in play.
  const qSmall = rSmall ? rSmall.q : useVenues ? 0n : null;
  if (qSmall === null) {
    log(`${tag} no price available`);
    return "error";
  }
  if (rSmall && est !== null && !trusted) {
    // Compare the local formula with the real quote for this pair before relying on it.
    const diff = est > qSmall ? est - qSmall : qSmall - est;
    const tol = qSmall / 300n > 2n ? qSmall / 300n : 2n;
    if (diff <= tol) localCheck.set(lk, { okAt: Date.now() });
    else {
      localCheck.set(lk, { offUntil: Date.now() + LOCAL_RECHECK_MS });
      log(`the local price estimate was off for ${sym(tin)}->${sym(tout)} (local ${est}, network ${qSmall}); this pair is quoted over the network for 30 min`);
    }
  }
  if (qSmall < minOut(smallest, limit)) {
    // Soroswap alone does not reach the limit; another venue might. The cheap near-spot estimate is asked first,
    // so that an order waiting far from its limit does not cost a full route search on every ledger.
    const top = useVenues ? await venueEst(smallest, tin, tout) : null;
    const alt = top !== null && (top * 1005n) / 1000n + 2n >= minOut(smallest, limit) ? await venueRoute(smallest, tin, tout, null, null, minOut(smallest, limit)) : null;
    if (!alt || alt.q < minOut(smallest, limit)) noteDistance(key, alt && alt.q > qSmall ? alt.q : qSmall, minOut(smallest, limit));
    if (!alt || alt.q < minOut(smallest, limit)) return waiting(vault, o, tag, remaining, tin, priceNoteFor(tin, tout, smallest, alt && alt.q > qSmall ? alt.q : qSmall, limit));
  }

  let note = "";
  let rejected = null; // the first fill the contract rejected (smaller ones are tried in the same round)
  for (const fill of sizes) {
    const route = fill === smallest ? rSmall : await bestRoute(fill, tin, tout, vias);
    const qSoro = route ? route.q : useVenues ? 0n : null;
    const via = route ? route.via : null;
    if (qSoro === null) {
      log(`${tag} no price available`);
      return "error";
    }
    // Version 13 vaults fill through our own router (the filler contract): the best route over every pool of
    // every venue, with no venue preferred. The vault's built-in single-venue route (`execute`) is only the
    // fallback: when the router has no route, when its route is refused, or when that built-in route pays more.
    let alt = useVenues ? await venueRoute(fill, tin, tout, null, null, minOut(fill, limit)) : null;
    if (alt && alt.q < qSoro) alt = null;
    let q = alt ? alt.q : qSoro;
    if (q < minOut(fill, limit)) {
      note = note || priceNoteFor(tin, tout, fill, q, limit);
      continue;
    }
    // The fill fee is paid only out of what comes in above the limit. If that part does not cover the whole fee, the
    // fill does not pay for its network cost: it waits until the price is a little further past the limit. That way
    // the keeper's balance cannot be drained with many small orders (without needing a minimum order amount).
    if (fee > 0n && q - minOut(fill, limit) < fee) {
      note = note || `the limit is met but the fill fee (${fmt(fee)} ${sym(tout)}) is not covered yet (fill ${fmt(fill)})`;
      continue;
    }
    if (alt) {
      fillTraceCtx.getStore()?.mark("quote");
      const ra = await write(vault, "fill_via", [new Address(kp.publicKey()).toScVal(), u32(o.id), i128(fill), addrVal(FILLER), alt.route], true);
      if (ra.ok) {
        dirty.add(vault);
        if (sch) schedules.delete(key);
        stats.fills++;
        stuck.delete(key);
        failGuard.clear(key);
        routeMiss.delete(key);
        if (ra.fee !== null) stats.feesStroop += ra.fee;
        log(`FILLED ${tag} ${fmt(fill)} ${sym(tin)} -> ${fmt(ra.value)} ${sym(tout)} via ${alt.text} (built-in route: ${qSoro > 0n ? fmt(qSoro) : "none"}) fee=${ra.fee !== null ? fmt(ra.fee) : "?"} XLM tx=${ra.hash}`);
        const left = remaining - fill;
        await notify(
          `${side === "buy" ? "Buy" : "Sell"} order filled: vault ${short(vault)} #${o.id}\n` +
            `${fmt(fill)} ${sym(tin)} -> ${fmt(ra.value)} ${sym(tout)} (${alt.text})` +
            (left > 0n ? `\nLeft: ${fmt(left)} ${sym(tin)}` : "\nThe order is completely filled.") +
            `\nhttps://stellar.expert/explorer/testnet/tx/${ra.hash}`,
        );
        return "filled";
      }
      if (ra.feeCap || ra.budget) return waiting(vault, o, tag, remaining, tin, ra.error);
      if (ra.retry) {
        log(`${tag}: ${ra.error}; it will be tried again on the next ledger`);
        return "busy";
      }
      if (ra.onchain) {
        // The fee is paid already: no second transaction through the built-in route in the same round.
        await onchainFail(key, tag, ra);
        const rounds = restKey(key);
        log(`${tag} the ${alt.text} fill is tried again in ${rounds} round(s) at the earliest`);
        return "error";
      }
      if (ra.code === 4 || ra.code === 5) {
        closed.add(key); // the order is no longer open, or has expired according to the chain
        return "closed";
      }
      if (ra.code === 16) return waiting(vault, o, tag, remaining, tin, "the trigger price (oracle) has not been reached yet");
      if (ra.code === 19) return waiting(vault, o, tag, remaining, tin, "no oracle price available");
      if (ra.code === 31) return waiting(vault, o, tag, remaining, tin, "scheduled order: the next part is not due yet");
      // It failed in simulation (free). Most often a leg's price moved past its minimum (SLIPPAGE_BPS) between the
      // quote and the simulation: the order waits for the next ledger, with no penalty, ROUTE_RETRIES times in a
      // row; only then the vault's built-in route is used, so a venue that is broken for good cannot hold it up.
      const misses = routeMiss.get(key) || 0;
      if (retryRoute(misses, ROUTE_RETRIES)) {
        routeMiss.set(key, misses + 1);
        return waiting(
          vault,
          o,
          tag,
          remaining,
          tin,
          `${alt.text} route did not go through in simulation (${errText(ra)}); a leg may have moved more than ${SLIPPAGE_BPS} bps; tried again on the next ledger`,
        );
      }
      routeMiss.delete(key);
      // The router's route did not work out (the price moved, or it was refused): the vault's built-in route.
      const why = `${alt.text} route refused (${errText(ra)})`;
      if (!lastNote.has(`venue:${key}`) || Date.now() - lastNote.get(`venue:${key}`).at > 10 * 60_000) {
        lastNote.set(`venue:${key}`, { at: Date.now() });
        log(`${tag} ${why}; trying the vault's built-in route`);
      }
      alt = null;
      q = qSoro;
      if (q < minOut(fill, limit)) {
        note = note || priceNoteFor(tin, tout, fill, q, limit);
        continue;
      }
      if (fee > 0n && q - minOut(fill, limit) < fee) {
        note = note || `the limit is met but the fill fee (${fmt(fee)} ${sym(tout)}) is not covered yet (fill ${fmt(fill)})`;
        continue;
      }
    }
    if (maxImpact < BPS) {
      const imp = await impactBps(fill, tin, tout, via);
      if (imp !== null && imp > maxImpact) {
        note = `price impact ${imp} bps > ${maxImpact} bps (fill ${fmt(fill)})`;
        continue;
      }
    }
    fillTraceCtx.getStore()?.mark("quote");
    const single = () => write(vault, "execute", execArgs(fill, via), true);
    const r = pc.v8 ? await fillOrder(vault, o.id, fill, via, single) : await single();
    dirty.add(vault); // whatever happened, read this vault's orders again on the next scan
    if (sch) schedules.delete(key); // the schedule moves when a part fills: read it again
    if (r.ok) {
      stats.fills++;
      stuck.delete(key);
      failGuard.clear(key);
      if (r.fee !== null) stats.feesStroop += r.fee;
      log(
        `FILLED ${tag} ${fmt(fill)} ${sym(tin)} -> ${via ? `${sym(via)} -> ` : ""}${fmt(r.value)} ${sym(tout)}` +
          ` fee=${r.fee !== null ? fmt(r.fee) : "?"} XLM tx=${r.hash}`,
      );
      const left = remaining - fill;
      await notify(
        `${side === "buy" ? "Buy" : "Sell"} order filled: vault ${short(vault)} #${o.id}\n` +
          `${fmt(fill)} ${sym(tin)} -> ${fmt(r.value)} ${sym(tout)}` +
          (left > 0n ? `\nLeft: ${fmt(left)} ${sym(tin)}` : "\nThe order is completely filled.") +
          `\nhttps://stellar.expert/explorer/testnet/tx/${r.hash}`,
      );
      return "filled";
    }
    // Above the per-transaction fee cap or out of fee budget: nothing was sent, the order just waits.
    if (r.feeCap || r.budget) return waiting(vault, o, tag, remaining, tin, r.error);
    if (r.retry) {
      // The network did not accept the transaction: no fee was paid, it is tried again on the next ledger.
      log(`${tag}: ${r.error}; it will be tried again on the next ledger`);
      return "busy";
    }
    if (r.code === 16) return waiting(vault, o, tag, remaining, tin, "the trigger price (oracle) has not been reached yet");
    if (r.code === 19) return waiting(vault, o, tag, remaining, tin, "no oracle price available");
    if (r.code === 31) return waiting(vault, o, tag, remaining, tin, "scheduled order: the next part is not due yet");
    if (r.code === 4 || r.code === 5) {
      closed.add(key); // the order is no longer open, or has expired according to the chain
      return "closed";
    }
    if (r.onchain) {
      // The transaction got on chain and failed there (fee paid): counted towards the long pause and rested.
      await onchainFail(key, tag, r);
      const rounds = restKey(key);
      log(`${tag} fill ${fmt(fill)} is tried again in ${rounds} round(s) at the earliest`);
      return "error";
    }
    stats.failures++;
    stats.lastError = `${tag}: ${errText(r)}`;
    if ([8, 10, 13, 20].includes(r.code)) {
      // Our own price and impact checks passed but the contract rejected: the price may have moved in the meantime,
      // a smaller fill is tried.
      rejected = rejected || { fill, r };
      continue;
    }
    // Unexpected error (e.g. a send error): this order is rested too, so that it is not retried every round
    // (1, 2, 4 ... at most 60 rounds).
    const rounds = restKey(key);
    log(`${tag} fill ${fmt(fill)} failed: ${errText(r)}; it will be tried again in ${rounds} round(s)`);
    await notify(`Fill error ${tag}: ${errText(r)}`, { topic: `err:${tag}`, everySec: 3600 });
    return "error";
  }
  if (rejected) {
    // No size went through: the order is rested for a while. If it stays that way for long (e.g. the error comes from
    // another contract, the owner has no trustline) a notice is sent once.
    const rounds = restKey(key);
    const n = stuck.get(key).n;
    log(`${tag} fill ${fmt(rejected.fill)} rejected by the contract: ${errText(rejected.r)}; it will be tried again in ${rounds} round(s)`);
    if (n === 7) {
      await notify(
        `Order ${tag} passes the pre-checks but the contract keeps rejecting it (${errText(rejected.r)}). Please check: ` +
          String(rejected.r.error).split("\n")[0].slice(0, 200),
        { topic: `stuck:${key}`, everySec: 6 * 3600 },
      );
    }
    return "waiting";
  }
  return waiting(vault, o, tag, remaining, tin, note);
}

// ---------------------------------------------------------------------------
// Crossing (version 10 vaults): an order that sells X for Y and an order in another vault that sells Y for X fill
// each other in one transaction (`cross`). No pool fee and no price impact for either side. The contract only
// guarantees the two limits; the price inside the overlap is chosen here:
//  - the pool's own middle price for these amounts (the average of what each side would get there), kept inside
//    the overlap of the two limits; without a pool quote, the middle of the two limits;
//  - a cross is sent only if each side receives at least what the pool would give it now. Otherwise the orders are
//    left to the pool pass, which follows the best pool price.
// Stop orders are not crossed (they wait for their oracle trigger and band; the pool pass handles them).
// ---------------------------------------------------------------------------

const crossedNow = new Set(); // "vault:id" filled by a cross in this scan; the pool pass leaves them alone
let crossFills = 0;

/** A fill size the contract accepts for this order: all that is left, or a piece that respects the minimum fill on both sides. */
function fillAllowed(x, fill) {
  if (fill <= 0n || fill > x.remaining) return false;
  if (fill === x.remaining) return true;
  return fill >= x.minFill && x.remaining - fill >= x.minFill && fill >= minFillFor(x.tin);
}

/**
 * Amounts for crossing `a` (sells X for Y) with `b` (sells Y for X) at price `p` (X per 1 Y, 7 decimals):
 * { x: what a pays, y: what b pays }, the largest the two orders allow. Null if no amounts satisfy both limits and
 * both minimum-fill rules.
 */
function crossAmounts(a, b, p) {
  if (p <= 0n) return null;
  let x;
  let y;
  if ((a.remaining * SCALE) / p < b.remaining) {
    // a is the smaller side: it fills completely
    x = a.remaining;
    y = (x * SCALE + p - 1n) / p;
    if (y > b.remaining) y = b.remaining;
  } else {
    // b is the smaller side: it fills completely
    y = b.remaining;
    x = (y * p) / SCALE;
    if (x > a.remaining) x = a.remaining;
  }
  const ok = (x, y) => x > 0n && y > 0n && y >= minOut(x, a.limit) && x >= minOut(y, b.limit) && fillAllowed(a, x) && fillAllowed(b, y);
  if (ok(x, y)) return { x, y };
  // Nearly equal orders: the piece left over on the larger side would be below its minimum fill. Both fill
  // completely instead, if both limits still hold at those amounts.
  if (ok(a.remaining, b.remaining)) return { x: a.remaining, y: b.remaining };
  return null;
}

async function tryCross(a, b, budget = null) {
  const lo = (SCALE * SCALE + b.limit - 1n) / b.limit; // the least X per Y that b accepts
  const hi = a.limit; // the most X per Y that a pays
  if (lo > hi) return "no";
  let amt = crossAmounts(a, b, (lo + hi) / 2n);
  if (!amt) return "no";
  // What would the pool give each side for these amounts?
  let qa = await quote(amt.x, a.tin, a.tout);
  let qb = await quote(amt.y, b.tin, b.tout);
  if (budget) budget.quote(2);
  if (qa !== null && qb !== null && qa > 0n && qb > 0n) {
    let mid = ((amt.x * SCALE) / qa + (qb * SCALE) / amt.y) / 2n; // the pool's middle price for these amounts
    if (mid < lo) mid = lo;
    if (mid > hi) mid = hi;
    const again = crossAmounts(a, b, mid);
    if (again && (again.x !== amt.x || again.y !== amt.y)) {
      amt = again;
      qa = await quote(amt.x, a.tin, a.tout);
      qb = await quote(amt.y, b.tin, b.tout);
      if (budget) budget.quote(2);
    }
    // Each side must do at least as well as in the pool; if not, the pool pass fills it at the better price.
    if ((qa !== null && amt.y < qa) || (qb !== null && amt.x < qb)) return "pool";
  }
  // Same rule as a pool fill: the transaction must earn at least one whole fill fee, paid only out of what a side
  // receives above its limit. Otherwise many tiny crosses could drain the keeper's balance.
  const capA = a.fees[a.tout] ?? 0n;
  const capB = b.fees[b.tout] ?? 0n;
  const overA = amt.y - minOut(amt.x, a.limit);
  const overB = amt.x - minOut(amt.y, b.limit);
  if ((capA > 0n || capB > 0n) && !((capA > 0n && overA >= capA) || (capB > 0n && overB >= capB))) return "fee";

  const tag = `${short(a.vault)} #${a.o.id} x ${short(b.vault)} #${b.o.id}`;
  const args = [
    new Address(kp.publicKey()).toScVal(),
    u32(a.o.id),
    i128(amt.x),
    new Address(b.vault).toScVal(),
    u32(b.o.id),
    i128(amt.y),
  ];
  const r = await write(a.vault, "cross", args, true);
  dirty.add(a.vault); // whatever happened, read both vaults' orders again on the next scan
  dirty.add(b.vault);
  if (r.ok) {
    stats.fills += 2;
    crossFills++;
    if (r.fee !== null) stats.feesStroop += r.fee;
    crossedNow.add(a.key);
    crossedNow.add(b.key);
    stuck.delete(`x:${a.key}|${b.key}`);
    failGuard.clear(crossKey(a, b));
    log(
      `CROSSED ${tag}: ${fmt(amt.x)} ${sym(a.tin)} <-> ${fmt(amt.y)} ${sym(a.tout)}` +
        (qa !== null ? ` (the pool would give ${fmt(qa)} ${sym(a.tout)}${qb !== null ? ` / ${fmt(qb)} ${sym(a.tin)}` : ""})` : "") +
        ` fee=${r.fee !== null ? fmt(r.fee) : "?"} XLM tx=${r.hash}`,
    );
    await notify(
      `Two orders filled each other, no pool: ${tag}\n${fmt(amt.x)} ${sym(a.tin)} <-> ${fmt(amt.y)} ${sym(a.tout)}` +
        `\nhttps://stellar.expert/explorer/testnet/tx/${r.hash}`,
    );
    return "crossed";
  }
  if (r.feeCap || r.budget) return "busy"; // nothing was sent; said once by the budget notice / tried next ledger
  if (r.retry) {
    log(`cross ${tag}: ${r.error}; it will be tried again on the next ledger`);
    return "busy";
  }
  if (r.code === 4 || r.code === 5) return "no"; // one of the two orders is no longer open; both vaults are read again
  const k = `x:${a.key}|${b.key}`;
  if (r.onchain) {
    // Failed on chain (fee paid): counted towards the long pause of this pair.
    await onchainFail(crossKey(a, b), `cross ${tag}`, r);
  } else {
    stats.failures++;
    stats.lastError = `cross ${tag}: ${errText(r)}`;
  }
  // Rested like a stuck order (1, 2, 4 ... at most 60 rounds), so a pair the contract keeps rejecting does not burn fees.
  const rounds = restKey(k);
  log(`cross ${tag} rejected: ${errText(r)}; this pair is tried again in ${rounds} round(s)`);
  return "error";
}

/** The failure-guard key of a crossing pair (same for both orders of the pair, in either order). */
const crossKey = (a, b) => (a.key < b.key ? `x:${a.key}|${b.key}` : `x:${b.key}|${a.key}`);

/** Looks for opposite orders that can fill each other and sends the crosses. Returns how many crosses went through. */
// The work is bounded (IORA-06): at most CROSS_MAX_CANDIDATES orders (CROSS_PER_VAULT per vault, vaults in turn),
// CROSS_PER_ORDER partners per order, and per scan at most CROSS_MAX_PAIRS pairs, CROSS_MAX_QUOTES price quotes and
// CROSS_MAX_MS. Where it stops, the next scan goes on (rotating vault cursor and order offset), so the pool pass,
// the heartbeat and TTL upkeep always get their turn.
const crossState = { cursor: 0, offset: 0, lastCut: 0 };
async function crossPass(vaults) {
  crossedNow.clear();
  if (!CROSS) return 0;
  const now = Math.floor(Date.now() / 1000);
  const groups = [];
  for (const v of vaults) {
    const st = book.get(v);
    if (!st || !st.open.length || !st.orders) continue;
    let pc;
    try {
      pc = await pair(v);
    } catch {
      continue;
    }
    if (!pc.v10) continue;
    const mine = [];
    // each vault's orders in turn, so a vault with more than CROSS_PER_VAULT orders is covered over several scans
    const ids = st.open.length ? [...st.open.slice((st.crossTurn || 0) % st.open.length), ...st.open.slice(0, (st.crossTurn || 0) % st.open.length)] : [];
    st.crossTurn = ((st.crossTurn || 0) + CROSS_PER_VAULT) % Math.max(1, st.open.length);
    for (const id of ids) {
      const o = st.orders.get(id);
      const key = `${v}:${id}`;
      if (!o || closed.has(key)) continue;
      if (failGuard.pausedUntil(key)) continue; // paused after on-chain failures
      if (BigInt(o.trigger_price ?? 0) > 0n) continue; // stop orders are left to the pool pass
      if (pc.v11 && schedules.get(key) !== null) continue; // scheduled orders (or not known yet) are left to the pool pass
      if (now > Number(o.expiry)) continue;
      const remaining = BigInt(o.amount_in) - BigInt(o.filled_in);
      if (remaining <= 0n) continue;
      mine.push({ vault: v, o, key, tin: String(o.sell), tout: String(o.buy), remaining, limit: BigInt(o.limit_price), minFill: BigInt(o.min_fill), fees: pc.fees });
    }
    if (mine.length) groups.push([v, mine]);
  }
  const { list, nextCursor } = takeCandidates(groups, crossState.cursor, { max: CROSS_MAX_CANDIDATES, perVault: CROSS_PER_VAULT });
  crossState.cursor = nextCursor;
  if (list.length < 2) return 0;
  const used = new Set();
  const skipA = new Set(); // the network did not take a cross for this order: its other partners wait for the next ledger
  const budget = new WorkBudget({ pairs: CROSS_MAX_PAIRS, quotes: CROSS_MAX_QUOTES, ms: CROSS_MAX_MS });
  let done = 0;
  let lastIndex = null;
  let cut = false;
  for (const { a, b, index } of crossPairs(list, { offset: crossState.offset, perOrder: CROSS_PER_ORDER, scale: SCALE, isUsed: (k) => used.has(k) })) {
    proximity.near = true; // two orders could fill each other: keep scanning on every ledger
    if (skipA.has(a.key)) continue;
    const held = stuck.get(`x:${a.key}|${b.key}`) || stuck.get(`x:${b.key}|${a.key}`);
    if (held && scanNo < held.until) continue;
    if (failGuard.pausedUntil(crossKey(a, b))) continue;
    if (!budget.canStart(4)) {
      cut = true;
      break;
    }
    budget.pair();
    lastIndex = index;
    let res;
    try {
      res = await tryCross(a, b, budget);
    } catch (e) {
      log(`ERROR cross ${short(a.vault)} #${a.o.id} x ${short(b.vault)} #${b.o.id}: ${e.message}`);
      continue;
    }
    if (res === "crossed") {
      used.add(a.key);
      used.add(b.key);
      done++;
    }
    if (res === "busy") skipA.add(a.key);
  }
  // The next scan starts after the last order that got a try (all orders get their turn over several scans).
  crossState.offset = lastIndex === null ? 0 : (lastIndex + 1) % list.length;
  if (cut && Date.now() - crossState.lastCut > 10 * 60_000) {
    crossState.lastCut = Date.now();
    log(
      `crossing: work limit reached (${budget.pairs} pairs, ${budget.quotes} quotes, ${Date.now() - budget.start} ms; ` +
        `${list.length} candidates); the rest goes on in the next scans`,
    );
  }
  crossStats = { candidates: list.length, pairs: budget.pairs, quotes: budget.quotes, cut };
  return done;
}
let crossStats = null;

// ---------------------------------------------------------------------------
// TTL upkeep: so that entries left untouched for a long time are not archived
// ---------------------------------------------------------------------------

/** Takes the keys of the entries a read call touches, from its simulation. */
async function footprintOf(contractId, method, callArgs) {
  const sim = await server.simulateTransaction(readTx(contractId, method, callArgs));
  if (rpc.Api.isSimulationError(sim)) return [];
  const d = sim.transactionData;
  // Access differs between SDK versions, so both ways are tried.
  if (typeof d.getReadOnly === "function") return [...d.getReadOnly(), ...d.getReadWrite()];
  const fp = get(get(d.build(), "resources"), "footprint");
  return [...get(fp, "readOnly"), ...get(fp, "readWrite")];
}

function keyId(k) {
  if (typeof k.toXDR === "function") return k.toXDR("base64");
  return JSON.stringify(k, (_, v) => (typeof v === "bigint" ? v.toString() : v));
}

/** One factory's entries: a job list, page by page. */
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
      // Version 6: for every non-empty bucket, the owner entries in it, 40 at a time.
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

// TTL upkeep record for status.json and alerts (IORA-04): jobs done and failed, in the current round and in all.
const ttlStats = { ok: 0, failed: 0, roundFailed: 0, lastError: null, lastFailAt: 0 };
let ttlJobs = []; // the current round's jobs (continuous mode), one done per scan
const ttlJobsLeft = () => ttlJobs.length;

/** Runs one TTL job; returns true if the entries were extended. A failure is counted, logged and alerted. */
async function runTtlJob(job) {
  let ok = false;
  let why = "";
  try {
    const r = await ttlJob(job);
    ok = r.ok;
    why = r.error || "";
  } catch (e) {
    why = e.message || String(e);
  }
  if (ok) ttlStats.ok++;
  else {
    ttlStats.failed++;
    ttlStats.roundFailed++;
    ttlStats.lastError = `${job.kind === "factory" ? `factory ${short(job.f)}` : `vault ${short(job.vault)}`}: ${why}`.slice(0, 300);
    ttlStats.lastFailAt = Date.now();
    await notify(`TTL extension failed (${ttlStats.lastError}). Entries left unextended can be archived.`, { topic: "ttl-fail", everySec: 6 * 3600 });
  }
  return ok;
}

async function ttlJob(job) {
  if (job.kind === "factory") {
    const args = job.chain
      ? [u32(job.bucket), optAddr(job.from), u32(40)]
      : job.bucket === undefined
        ? [u32(job.start), u32(40)]
        : [u32(job.bucket), u32(job.start), u32(40)];
    const r = await write(job.f, "extend_ttl", args);
    const where = job.chain ? (job.from ? short(job.from) : "head") : job.start;
    log(`TTL factory ${short(job.f)} ${job.bucket === undefined ? "" : `bucket ${job.bucket} `}${where}..: ${r.ok ? "ok" : errText(r)}`);
    return { ok: !!r.ok, error: r.ok ? "" : errText(r) };
  }
  const v = job.vault;
  try {
    // The vault contract, its code and its open order entries (the entries get_order touches).
    const seen = new Map();
    const sources = [["get_config", []]];
    for (const id of book.get(v)?.open || []) {
      if (closed.has(`${v}:${id}`)) continue;
      sources.push(["get_order", [u32(id)]]);
      // If there is a follow-up order setting, its entry too (older vaults have no such function; the read fails).
      const fu = await read(v, "get_follow_up", [u32(id)]);
      if (fu.ok && fu.value) sources.push(["get_follow_up", [u32(id)]]);
      // A scheduled order (DCA) keeps its schedule in an entry of its own. The contract extends it on every fill,
      // but a plan that waits a long time for its price would otherwise let it run out.
      if (schedules.get(`${v}:${id}`)) sources.push(["get_schedule", [u32(id)]]);
    }
    for (const [m, a] of sources) {
      for (const k of await footprintOf(v, m, a)) seen.set(keyId(k), k);
    }
    const keys = [...seen.values()];
    if (keys.length === 0) return { ok: false, error: "no entries found (the simulation of get_config failed)" };
    const r = await serialized(async () => {
      const account = await accountFor(kp);
      const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
        .setSorobanData(new SorobanDataBuilder().setReadOnly(keys).build())
        .addOperation(Operation.extendFootprintTtl({ extendTo: 30 * DAY_IN_LEDGERS }))
        .setTimeout(TX_TIMEOUT_SEC)
        .build();
      return submit(await server.prepareTransaction(tx), kp, { ttl: true });
    });
    log(`TTL ${short(v)} (${keys.length} entries): ${r.ok ? `ok, fee ${r.fee !== null ? fmt(r.fee) : "?"} XLM` : r.error}`);
    return { ok: !!r.ok, error: r.ok ? "" : r.error };
  } catch (e) {
    log(`TTL ${short(v)} error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/** --once mode (GitHub Actions): everything in one go. */
async function extendTtlAll(vaults) {
  ttlStats.roundFailed = 0;
  for (const job of await factoryTtlJobs()) await runTtlJob(job);
  for (const vault of vaults) await runTtlJob({ kind: "vault", vault });
  if (ttlStats.roundFailed === 0) lastTtl = Date.now();
  log(`TTL round done: ${ttlStats.roundFailed} failed`);
  return ttlStats.roundFailed === 0;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

// The keeper's own balance only matters for the low-balance alert: read once a minute, not on every scan.
let balanceCache = { at: 0, value: null };
async function keeperBalance() {
  if (balanceCache.value !== null && Date.now() - balanceCache.at < 60_000) return balanceCache.value;
  try {
    const r = await read(XLM, "balance", [new Address(kp.publicKey()).toScVal()]);
    const value = r.ok ? Number(BigInt(r.value)) / 1e7 : null;
    balanceCache = { at: Date.now(), value };
    return value;
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

let lastTtl = 0; // when the last full TTL round finished (ms); read from status.json on restart
let vaultCache = { at: 0, list: [] };
async function scan() {
  scanNo++;
  // The vault list is refreshed once a minute, but not in a scan that has a new or changed order to act on.
  const t0 = Date.now();
  if (!vaultCache.list.length || ((Date.now() - vaultCache.at > VAULT_LIST_TTL_MS || SCAN_MODE !== "ledger") && dirty.size === 0)) {
    loopWatch.stage("scan: vault list");
    // The first list is read at normal priority: nothing else runs yet, and it is the longest read of all.
    vaultCache = { at: Date.now(), list: scanNo === 1 ? await listVaults() : await low(() => listVaults()) };
    if (scanNo === 1) log(`first scan: ${vaultCache.list.length} vaults listed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  const vaults = vaultCache.list;
  let open = 0;
  let filled = 0;
  readMemo.clear(); // reads are shared within a scan, never across scans
  scanLedger = { seq: lastLedger || latestCache.seq || 0, at: ledgerSeenAt || Date.now() };
  proximity.checked.clear();
  proximity.far.clear();
  proximity.near = false;
  // 1) Refresh the order book of the vaults that need it (new, changed, or the slow sweep).
  loopWatch.stage("scan: order events");
  const toRead = await vaultsToRead(vaults);
  loopWatch.stage(`scan: reading ${toRead.length} vaults`);
  const urgent = new Set(dirty); // vaults an event named: their reads go first, at fill-path priority
  await pool(toRead, SCAN_CONCURRENCY, async (v) => {
    try {
      if (urgent.has(v) || !seenVaults.has(v)) await ordersToCheck(v);
      else await low(() => ordersToCheck(v)); // the slow sweep
      if (urgent.has(v)) orderReadAt.set(v, Date.now());
    } catch (e) {
      log(`ERROR ${e.message}`);
      return;
    }
    seenVaults.add(v);
    vaultReadAt.set(v, Date.now());
    dirty.delete(v);
  });
  // The fee budget: a new round starts; if the hourly budget is used up, this round only scans (no transactions).
  feeBudget.startRound();
  const budgetBlock = feeBudget.blockReason(0);
  if (budgetBlock) budgetHit(budgetBlock);
  loopWatch.stage("scan: crossing");
  // 2) Opposite orders that can fill each other are crossed first (version 10 vaults), with no pool in between.
  try {
    if (!budgetBlock) filled += 2 * (await crossPass(vaults));
  } catch (e) {
    log(`ERROR crossing: ${e.message}`);
  }
  // 3) Check every open order against this scan's prices, from the cached copies. Fills run in parallel, one per
  //    sending account at a time.
  reservesNow.clear();
  loopWatch.stage("scan: checking orders");
  // Vaults an event named come first: a new order is looked at before the waiting ones.
  const active = budgetBlock ? [] : vaults.filter((v) => (book.get(v)?.open.length ?? 0) > 0).sort((a, b) => Number(urgent.has(b)) - Number(urgent.has(a)));
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
      if (crossedNow.has(`${v}:${o.id}`)) return; // just filled by a cross; its cached copy is stale until the next scan
      if (BigInt(o.amount_in) < minFillFor(o.sell ? String(o.sell) : null)) return; // dust orders (not the last small piece of a larger order)
      proximity.checked.add(`${v}:${o.id}`);
      try {
        // Fill timing: from the moment the keeper saw the ledger that made this fill possible (the one with the
        // order event, or the one this scan runs for).
        const ev = eventSeen.get(v);
        const t0Ledger = ev && ev.ledger ? ev.ledger : scanLedger.seq;
        const timer = new FillTimer(ledgerSeenTime(t0Ledger) ?? scanLedger.at, t0Ledger);
        if (ev) timer.mark("event", ev.at);
        if (orderReadAt.has(v)) timer.mark("order", orderReadAt.get(v));
        const res = await fillTraceCtx.run(timer, () => tryOrder(v, o, ctx));
        if (res === "filled") noteFillTiming(timer);
        if (res === "filled") filled++;
        if (res === "filled" || res === "error" || res === "busy") tries++; // only real transaction attempts are counted
      } catch (e) {
        stats.failures++;
        stats.lastError = e.message;
        log(`ERROR ${short(v)} #${o.id}: ${e.message}`);
      }
    };
    for (let i = 0; i < orders.length; i += width) {
      if (ctx.net >= MAX_ORDERS_PER_VAULT || tries >= MAX_FILLS_PER_VAULT) proximity.near = true; // orders left unchecked
      if (ctx.net >= MAX_ORDERS_PER_VAULT) break; // network-checked orders per vault per scan
      if (tries >= MAX_FILLS_PER_VAULT) {
        log(`${short(v)}: ${MAX_FILLS_PER_VAULT} transactions tried in this round, the rest in the next one`);
        break;
      }
      await Promise.all(orders.slice(i, i + width).map(one));
    }
  });
  for (const v of vaults) open += book.get(v)?.open.length ?? 0; // every vault, including the ones not read this scan
  loopWatch.stage("scan: balance");
  const balance = await low(() => keeperBalance());
  if (balance !== null && balance < LOW_BALANCE_XLM) {
    const sent = await notify(`The keeper balance is low: ${balance.toFixed(2)} XLM. Add XLM for transaction fees.`, {
      topic: "low-balance",
      everySec: 6 * 3600,
    });
    if (sent) log(`WARNING the keeper balance is low: ${balance} XLM`);
  }
  for (const v of urgent) {
    eventSeen.delete(v);
    orderReadAt.delete(v);
  }
  // Is any order near enough to its limit to keep scanning on every ledger? (see SCAN_IDLE_SEC)
  if (filled > 0 || [...proximity.checked].some((k) => !proximity.far.has(k))) proximity.near = true;
  lastScanInfo = { at: new Date().toISOString(), vaults: vaults.length, open, filled, balance };
  if (scanNo === 1) log(`first scan done in ${((Date.now() - t0) / 1000).toFixed(1)} s (${vaults.length} vaults, ${open} open orders)`);
  writeStatus();
  return { vaults, filled, open };
}

let lastScanInfo = null; // the last scan that completed
let failedScansInRow = 0;
/**
 * status.json, written after every scan attempt, failed ones too: `heartbeat` is the time of that write, so an
 * outside check (keeper/monitor/) can tell a stuck or dead keeper from a quiet one. `last_scan` is the last scan
 * that completed.
 */
function writeStatus() {
  const s = lastScanInfo || {};
  const now = Date.now();
  const usageNow = rpcUsage.lastMinute(now);
  try {
    fs.writeFileSync(
      STATUS_FILE,
      JSON.stringify(
        {
          heartbeat: new Date(now).toISOString(),
          pid: process.pid,
          last_scan: s.at || null,
          failed_scans_in_row: failedScansInRow,
          vaults: s.vaults ?? null,
          open_orders: s.open ?? null,
          fills_this_round: s.filled ?? null,
          total_fills: stats.fills,
          total_failures: stats.failures,
          onchain_failures: stats.onchainFailures,
          paused_orders: failGuard.pausedCount(now),
          total_fees_xlm: fmt(stats.feesStroop),
          failed_fees_xlm: fmt(stats.failedFeesStroop),
          fees_last_hour_xlm: fmt(BigInt(feeBudget.spentLastHour(now))),
          fee_budget_per_hour_xlm: MAX_FEE_XLM_PER_HOUR || "off",
          inclusion_fee_stroops: feeStatsCache.fee,
          last_error: stats.lastError,
          rpc_current: RPC_URLS[rpcPicker.cur],
          rpc_consecutive_errors: rpcPicker.consecutiveErrors,
          rpc_last_error: rpcPicker.lastError,
          rpc_primary_retry_at: rpcPicker.cur !== 0 && rpcPicker.retryAt ? new Date(rpcPicker.retryAt).toISOString() : null,
          // the last complete minute: total and per server, the 5 busiest methods, 429s, time waited for the limit
          rpc_requests_per_min: usageNow ? { total: usageNow.total, ...usageNow.per_server } : null,
          rpc_top_methods: usageNow ? usageNow.top_methods : null,
          rpc_429_last_min: usageNow ? usageNow.rate_limited : null,
          rpc_rate_wait_sec_last_min: usageNow ? Math.round(usageNow.waited_ms / 100) / 10 : null,
          rpc_rate_per_sec: Object.fromEntries(RPC_URLS.map((u, i) => [u, `${rpcLimits[i].aimd.rate(now).toFixed(2)}/${RPC_MAX_RPS[i]}`])),
          scan_interval: idleMode ? `${SCAN_IDLE_SEC} s` : "every ledger",
          // fill latency: from the moment the trigger ledger was seen to the moment the fill was seen on chain, over the
          // last 20 fills; ledgers: how many ledgers after the trigger one the fill was written (1 = the next one)
          fill_latency: fillStats.summary(),
          last_fill_timing: lastFillTiming,
          ledger_stream: LEDGER_STREAM ? (ledgerStreamUp() ? "up" : "down (asking the RPC)") : "off",
          loop_stage: loopWatch.stageName,
          loop_stalls: loopWatch.stalls,
          fast_paths: loopWatch.safe() ? `off until ${new Date(loopWatch.safeUntil).toISOString()} (watchdog)` : "on",
          keeper_balance_xlm: s.balance ?? null,
          sending_accounts: signers.length,
          batch_fills: BATCH ? `${batchFills} orders / ${batchTxs} transactions` : "off",
          crosses: CROSS ? crossFills : "off",
          skipped_by_local_estimate: localSkips,
          last_ttl: lastTtl ? new Date(lastTtl).toISOString() : null,
          // TTL upkeep (IORA-04): off when the keeper runs without --ttl; the age of the last full round without failures
          ttl_enabled: DO_TTL,
          last_ttl_age_h: lastTtl ? Math.round((now - lastTtl) / 360_000) / 10 : null,
          ttl_jobs_left: ttlJobsLeft(),
          ttl_ok_total: ttlStats.ok,
          ttl_failed_total: ttlStats.failed,
          ttl_failed_this_round: ttlStats.roundFailed,
          ttl_last_error: ttlStats.lastError,
        },
        null,
        2,
      ),
    );
  } catch {}
}

/**
 * `node keeper.js --venue-check [VAULT ORDER_ID]`: simulation only, nothing is signed or sent.
 * Shows whether the other venues are usable here: the Aquarius pools of USDC/XLM, how its router's swap is called,
 * whether the keeper could learn what a swap does in its caller's name, and quotes beside Soroswap. With a vault
 * and an open order it also simulates filling that order through the filler, all on Aquarius and split 50/50.
 * There "LimitNotMet" is a GOOD answer for an order whose limit is far from the market: the route ran and
 * delivered, only the price was not enough.
 */
async function venueCheck() {
  const say = (t) => console.log(t);
  say(`filler        ${FILLER || "(not set: testnet/filler.env)"}`);
  say(`Aquarius      ${AQUA_ROUTER || "(not set)"}`);
  say(`Phoenix       ${PHOENIX_MULTIHOP || "(not set)"}`);
  say(`Comet pools   ${COMET_POOLS.length ? COMET_POOLS.map(short).join(", ") : "(not set)"}`);
  say(`venues        ${VENUES ? "on" : "OFF"}`);
  if (!VENUES) return;
  const show = (x) => `${short(x.contract)}.${x.func}${x.subs && x.subs.length ? ` > ${x.subs.map(show).join(", ")}` : ""}`;
  for (const [tin, tout, amount] of [[USDC, XLM, 100_000_000n], [XLM, USDC, 500_000_000n]]) {
    say(`\n${sym(tin)} -> ${sym(tout)}, ${fmt(amount)} ${sym(tin)}`);
    say(`  Soroswap quote: ${(await quotePath(amount, [tin, tout])) ?? "failed"}`);
    for (const venue of venueList()) {
      const opts = await venue.options(tin, tout);
      say(`  ${venue.name}: ${opts.length} pool(s)`);
      for (const opt of opts) {
        const q = await venue.quote(opt, tin, tout, amount);
        say(`    ${String(opt.id).slice(0, 12)}  quote ${q ?? "none (no pool for this pair, or it cannot be read)"}`);
        if (q === null) continue;
        const t = await venueTemplate(venue, opt, tin, tout);
        say(`      in its caller's name: ${t ? `${t.mirrored ? "(read from the opposite direction and mirrored) " : "(read from a simulation) "}${t.map(show).join("; ") || "nothing"}` : "UNKNOWN"}`);
      }
    }
    const r = await venueRoute(amount, tin, tout);
    say(`  best route with another venue: ${r ? `${r.text} -> ${fmt(r.q)} ${sym(tout)}` : "none"}`);
  }
  const i = args.indexOf("--venue-check");
  const vault = args[i + 1];
  const id = Number(args[i + 2]);
  if (!vault || !Number.isInteger(id)) return say("\n(no vault and order given: the fill itself was not simulated)");
  const o = await read(vault, "get_order", [u32(id)]);
  if (!o.ok) return say(`\norder #${id} of ${short(vault)} cannot be read: ${errText(o)}`);
  const left = BigInt(o.value.amount_in) - BigInt(o.value.filled_in);
  const tin = String(o.value.sell);
  const tout = String(o.value.buy);
  say(`\norder #${id} of ${short(vault)}: ${fmt(left)} ${sym(tin)} left, sells for ${sym(tout)}`);
  const tries = [["the route the keeper would pick", null, null]];
  for (const venue of venueList()) tries.push([`all on ${venue.name}`, 100n, venue.name], [`half ${venue.name}, half Soroswap`, 50n, venue.name]);
  {
    for (const [label, share, only] of tries) {
      const r = await venueRoute(left, tin, tout, share, only);
      if (!r) {
        say(`  ${label}: no route (no pool for this pair there, or it could not be read)`);
        continue;
      }
      const sim = await server.simulateTransaction(readTx(vault, "fill_via", [new Address(kp.publicKey()).toScVal(), u32(id), i128(left), addrVal(FILLER), r.route]));
      if (!rpc.Api.isSimulationError(sim)) {
        say(`  ${label} (${r.text}): ROUTE WORKS, the fill would give ${fmt(BigInt(scValToNative(sim.result.retval)))} ${sym(tout)}`);
        continue;
      }
      const code = errCode(sim.error);
      if (code === 8) say(`  ${label} (${r.text}, quote ${fmt(r.q)}): ROUTE WORKS (the swap ran; only the order's limit is not met, as expected for a far limit)`);
      else say(`  ${label} (${r.text}): FAILED: ${ERR[code] || ""} ${String(sim.error).replace(/\s+/g, " ").slice(0, 900)}`);
    }
  }
}

async function main() {
  if (VENUE_CHECK) {
    await venueCheck();
    process.exit(0);
  }
  // Only one keeper per key and folder: a second one would collide on sequence numbers and waste fees.
  const lock = acquireLock(LOCK_FILE);
  if (!lock.ok) {
    const who = lock.pid ? `PID ${lock.pid}` : "another process";
    console.error(`The keeper is already running (${who}, lock file ${LOCK_FILE}); this one is not started.`);
    log(`not started: the keeper is already running (${who}, lock file ${LOCK_FILE})`);
    process.exit(3);
  }
  process.on("exit", lock.release); // also on Ctrl+C / SIGTERM / fatal errors (they all end in process.exit)
  log(`keeper started: ${kp.publicKey()} factories=${FACTORIES.map(short).join(",")} rpc=${RPC_URLS.join(" | ")}`);
  log(
    `fill latency: ledger stream ${LEDGER_STREAM ? HORIZON_URL : "off"}, reads spread over the RPC servers ${RPC_SPREAD_READS ? "on" : "off"}, ` +
      `result looked up ${LEDGER_STREAM ? "after each ledger" : `every ${TX_POLL_MS} ms`}, prepared route shapes ${ROUTE_SHAPE_SEC} s; ` +
      `each fill logs "fill timing: ..."`,
  );
  log(
    `filler routes: every leg has a minimum output ${SLIPPAGE_BPS} bps below its quote (never below the vault's limit), ` +
      `${ROUTE_RETRIES} free retries on a moved price, Comet max_price ${COMET_MAX_PRICE_FACTOR > 0 ? `${COMET_MAX_PRICE_FACTOR}x the worst allowed price` : "off"}`,
  );
  log(
    `RPC rate limit: ${RPC_URLS.map((u, i) => `${RPC_MAX_RPS[i]}/s`).join(", ")} (burst ${RPC_BURST}); a 429 halves the rate and waits, ` +
      `${RPC_429_SWITCH_AFTER} in a row move to the next server. Scan: every ledger near a limit (${SCAN_NEAR_PCT}%), ` +
      `else every ${SCAN_IDLE_SEC} s; idle vaults re-read every ${SWEEP_EVERY_SEC} s`,
  );
  log(
    `fee protection: MAX_FEE_XLM=${MAX_FEE_XLM} per transaction (TTL upkeep: MAX_TTL_FEE_XLM=${MAX_TTL_FEE_XLM}), MAX_FEE_XLM_PER_HOUR=${MAX_FEE_XLM_PER_HOUR}, ` +
      `MAX_FEE_XLM_PER_ROUND=${MAX_FEE_XLM_PER_ROUND}, pause after ${FAIL_PAUSE_AFTER} on-chain failures for ${FAIL_PAUSE_HOURS} h, inclusion fee ${FEE_PERCENTILE}`,
  );
  if (!TG_TOKEN || !TG_CHAT) {
    log("WARNING Telegram is not set (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID): no alerts will be sent. Watch status.json (heartbeat) from outside.");
  }
  if (ONCE) {
    let last;
    for (let round = 1; round <= 4; round++) {
      last = await scan();
      log(`round ${round}: ${last.vaults.length} vaults, ${last.open} open orders, ${last.filled} fills`);
      if (last.filled === 0) break;
    }
    if (DO_TTL && last && !(await extendTtlAll(last.vaults))) process.exitCode = 2; // the day's TTL is not done
    writeStatus();
    return;
  }
  if (LEDGER_STREAM && SCAN_MODE === "ledger") ledgerStreamLoop(); // runs for good in the background
  if (!DO_TTL) {
    log("WARNING TTL upkeep is OFF (started without --ttl): quiet vaults and orders are not extended and can be archived. Start with: node keeper.js --ttl");
  }
  await ensureFeeTrustline();
  if (WORKERS > 0) {
    await ensureWorkers();
    log(`sending accounts: ${signers.length} (main account + ${signers.length - 1} workers)`);
    log(BATCH ? `batch fills on: at most ${BATCH_SIZE} orders per transaction, contract ${short(BATCH)}` : "batch fills off (no testnet/batch.env)");
  }
  let workersAt = Date.now();
  const prevStatus = readStatus();
  const prevTtl = Date.parse(prevStatus.last_ttl || prevStatus.son_ttl || ""); // son_ttl: older status.json files
  if (Number.isFinite(prevTtl)) lastTtl = prevTtl;
  ttlJobs = [];
  let saidResetAt = Date.now();
  await notify(
    `Started. ${FACTORIES.length > 1 ? "Several factories" : "One factory"}, ` +
      (SCAN_MODE === "ledger" ? "scanning on every new ledger (~5 s)." : `scanning every ${INTERVAL_SEC} s.`),
  );
  startWatchdog();
  for (;;) {
    try {
      lastScanStart = Date.now();
      loopWatch.stage("scan");
      const s = await scan();
      loopWatch.stage("after scan");
      // Worker balances are checked once an hour.
      if (WORKERS > 0 && Date.now() - workersAt > 3600_000) {
        workersAt = Date.now();
        await low(() => ensureWorkers());
      }
      // TTL upkeep must not hold up scanning: a job list is prepared once a day and worked through
      // one job at a time in rounds without a fill.
      // With the adaptive interval a job runs every SCAN_IDLE_SEC while idle (a round of ~25 jobs takes ~15 min)
      // and on every ledger without a fill while an order is near its limit; all its requests go through the RPC
      // rate limit like any other. If fills keep every round busy for a day, TTL runs anyway (overdue).
      const ttlOverdue = Date.now() - lastTtl > 2 * TTL_EVERY_SEC * 1000;
      if (DO_TTL && (s.filled === 0 || ttlOverdue)) {
        if (ttlJobs.length === 0 && !ttlBusy && Date.now() - lastTtl > TTL_EVERY_SEC * 1000) {
          ttlJobs = [...(await low(() => factoryTtlJobs())), ...s.vaults.map((vault) => ({ kind: "vault", vault }))];
          ttlStats.roundFailed = 0;
          if (ttlJobs.length === 0) lastTtl = Date.now();
        } else if (ttlJobs.length > 0 && !ttlBusy) {
          // In the background (one job at a time, main account): a TTL job waits ~5-10 s for its transaction, and the
          // next scan (a new order) must not wait for it. Its requests are background priority.
          ttlBusy = true;
          const job = ttlJobs.shift();
          const last = ttlJobs.length === 0;
          low(() => runTtlJob(job))
            .catch(() => {})
            .finally(() => {
              ttlBusy = false;
              if (last && ttlJobs.length === 0) {
                // A round with failures is tried again in an hour instead of a day.
                lastTtl = ttlStats.roundFailed === 0 ? Date.now() : Date.now() - TTL_EVERY_SEC * 1000 + 3600_000;
                log(`TTL round done: ${ttlStats.roundFailed} failed${ttlStats.roundFailed ? "; the round is repeated in 1 hour" : ""}`);
              }
            });
        }
      }
      failedScansInRow = 0;
    } catch (e) {
      stats.lastError = e.message;
      failedScansInRow++;
      log(`ERROR scan: ${e.message}`);
      writeStatus(); // the heartbeat moves on even when scans fail; failed_scans_in_row shows it
      if (failedScansInRow >= 3) {
        await notify(`${failedScansInRow} scans failed in a row: ${e.message}`, { topic: "scan", everySec: 3600 });
      }
    }
    // One-time venue notes are said again once a day (and the set cannot grow without end).
    if (Date.now() - saidResetAt > 24 * 3600_000) {
      saidResetAt = Date.now();
      venueState.said.clear();
    }
    if (Date.now() - usageLogAt >= 10 * 60_000) {
      usageLogAt = Date.now();
      logRpcUsage();
    }
    if (SCAN_MODE !== "ledger") {
      await sleep(INTERVAL_SEC * 1000);
      continue;
    }
    // Every ledger while an order is near its limit; otherwise a full scan every SCAN_IDLE_SEC and, on each ledger
    // in between, only the order events (a new or changed order starts a full scan at once).
    const scanOk = failedScansInRow === 0;
    const idleMs = scanIntervalMs({ near: !scanOk || proximity.near, eventsOk, idleMs: SCAN_IDLE_SEC * 1000 });
    if ((idleMs > 0) !== idleMode) {
      idleMode = idleMs > 0;
      log(
        idleMode
          ? `scan interval: ${SCAN_IDLE_SEC} s (no open order within ${SCAN_NEAR_PCT}% of its limit); order events are still read on every ledger`
          : `scan interval: every ledger (an order is within ${SCAN_NEAR_PCT}% of its limit, can cross, or is due)`,
      );
    }
    const scanStarted = lastScanStart;
    for (;;) {
      loopWatch.stage("waiting for the next ledger");
      await waitNextLedger(INTERVAL_SEC * 1000);
      loopWatch.stage(`reading the events of ledger ${lastLedger}`);
      await readEventsFor(lastLedger); // this ledger's new orders, as soon as the RPC has them
      if (idleMs === 0 || Date.now() - scanStarted >= idleMs) break;
      if (dirty.size > 0 || !eventsOk) break; // something happened in a vault (or events failed): full scan now
    }
  }
}

let usageLogAt = Date.now();
let idleMode = false;
let lastScanStart = 0;
let lastLedger = 0;
let ledgerSeenAt = 0;
// Time between ledgers (Stellar: ~5 s). Used to know when the next one is due (RPC polling, waiting for events).
const LEDGER_MS = Math.max(1000, Number(cfg.LEDGER_SEC || 5) * 1000);
let ttlBusy = false; // a TTL job is running in the background

// ----- seeing a ledger close -----
// ledgerWatch: the newest ledger the keeper knows of, from Horizon's stream or from the RPC, and who waits for one.
const ledgerWatch = { seq: 0, at: 0, waiters: new Set(), streamAt: 0, connected: false, failures: 0, saidAt: 0, since: 0 };
const ledgerSeen = new Map(); // ledger -> when the keeper saw it (the last 60), for the fill timing
function onLedger(seq, fromStream) {
  if (!(seq > ledgerWatch.seq)) return;
  const now = Date.now();
  ledgerWatch.seq = seq;
  ledgerWatch.at = now;
  if (fromStream) ledgerWatch.streamAt = now;
  ledgerSeen.set(seq, now);
  if (ledgerSeen.size > 60) ledgerSeen.delete(ledgerSeen.keys().next().value);
  if (seq > latestCache.seq) latestCache = { seq, at: now };
  for (const w of [...ledgerWatch.waiters]) w(false);
}
const ledgerSeenTime = (seq) => (seq ? (ledgerSeen.get(seq) ?? null) : null);
const ledgerStreamUp = () => LEDGER_STREAM && !loopWatch.safe() && ledgerWatch.connected && Date.now() - ledgerWatch.streamAt < 15_000;
/** Resolves true as soon as a ledger after `seq` is known, false after maxMs. */
function nextLedgerAfter(seq, maxMs) {
  return new Promise((resolve) => {
    if (ledgerWatch.seq > seq) return resolve(true);
    let timer;
    const f = (kick = false) => {
      if (!kick && ledgerWatch.seq <= seq) return;
      clearTimeout(timer);
      ledgerWatch.waiters.delete(f);
      resolve(!kick);
    };
    timer = setTimeout(() => {
      ledgerWatch.waiters.delete(f);
      resolve(false);
    }, maxMs);
    ledgerWatch.waiters.add(f);
  });
}

/**
 * Horizon's ledger stream (server-sent events, /ledgers?cursor=now): each closed ledger arrives about a second after
 * it closes, with no request of ours and outside the RPC rate limit. Runs for good; reconnects with a back-off; while
 * it is down, waitNextLedger asks the RPC as before.
 */
async function ledgerStreamLoop() {
  for (;;) {
    const ac = new AbortController();
    let watchdog;
    let connectedAt = 0;
    try {
      const res = await fetch(`${HORIZON_URL}/ledgers?cursor=now`, { headers: { accept: "text/event-stream" }, signal: ac.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      connectedAt = Date.now();
      ledgerWatch.connected = true;
      ledgerWatch.streamAt = connectedAt;
      if (ledgerWatch.failures || !ledgerWatch.since) log(`ledger stream: connected to ${HORIZON_URL}`);
      ledgerWatch.since = ledgerWatch.since || connectedAt;
      ledgerWatch.failures = 0;
      const arm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => ac.abort(new Error("no data for 20 s")), 20_000);
      };
      arm();
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body) {
        arm();
        buf += dec.decode(chunk, { stream: true });
        const { events, rest } = parseSse(buf);
        buf = rest.length > 1_000_000 ? "" : rest;
        for (const ev of events) {
          const l = ledgerFromSse(ev);
          if (l) onLedger(l.sequence, true);
        }
      }
      throw new Error("the stream ended");
    } catch (e) {
      ledgerWatch.connected = false;
      // a stream that ran for a while and was closed by Horizon is reopened at once
      ledgerWatch.failures = connectedAt && Date.now() - connectedAt > 60_000 ? 0 : ledgerWatch.failures + 1;
      if (ledgerWatch.failures > 0 && Date.now() - ledgerWatch.saidAt > 10 * 60_000) {
        ledgerWatch.saidAt = Date.now();
        log(`ledger stream: ${(e && e.message) || e}; new ledgers are asked of the RPC until it is back (reconnecting)`);
      }
    } finally {
      clearTimeout(watchdog);
      ac.abort();
    }
    await sleep(ledgerWatch.failures ? Math.min(60_000, 1000 * 2 ** Math.min(6, ledgerWatch.failures)) : 250);
  }
}

/**
 * Waits for the next ledger. With the stream: until Horizon announces it (no requests). Without: it sleeps until the
 * next ledger is due (~5 s after the last one was seen), then asks the RPC once a second (at most maxMs in all).
 */
async function waitNextLedger(maxMs) {
  const t0 = Date.now();
  if (ledgerStreamUp()) {
    await nextLedgerAfter(lastLedger, maxMs);
    if (ledgerWatch.seq > lastLedger) {
      lastLedger = ledgerWatch.seq;
      ledgerSeenAt = ledgerWatch.at;
      return;
    }
    if (ledgerStreamUp()) return; // no ledger within maxMs (the network is slow): scan anyway, as before
  }
  const due = ledgerSeenAt ? ledgerSeenAt + LEDGER_MS : t0 + 1000;
  await sleep(Math.max(250, Math.min(due - t0, maxMs)));
  for (;;) {
    try {
      const seq = await latestLedger(0);
      if (seq > lastLedger) {
        onLedger(seq, false);
        lastLedger = seq;
        ledgerSeenAt = ledgerSeenTime(seq) ?? Date.now();
        return;
      }
    } catch {}
    if (Date.now() - t0 > maxMs) return;
    if (ledgerStreamUp() && ledgerWatch.seq > lastLedger) continue; // the stream came back meanwhile
    await sleep(1000);
  }
}

/**
 * Reads the order events of ledger `seq` as soon as the RPC has it (it can be a moment behind Horizon): a few tries,
 * 250 ms apart, about 2 s at most. A new order is then handled in the scan that follows at once.
 */
async function readEventsFor(seq) {
  const known = new Set(vaultCache.list);
  // At most ~30% of a ledger (1.5 s on Stellar): if the RPC is further behind than that, waiting would only delay the
  // scan; that ledger's events are read with the next one.
  const tries = Math.max(1, Math.min(8, Math.floor((LEDGER_MS * 0.3) / 250)));
  for (let i = 0; i < tries && !loopWatch.safe(); i++) {
    await collectPlaced(known, seq);
    if (!eventsOk || eventLedger >= seq) return;
    await sleep(250);
  }
}

// ----- watchdog -----
const loopWatch = new LoopWatch({ stallMs: LOOP_STALL_SEC * 1000 });
let watchdogTimer = null;
/** Checks every 5 s that the main loop moves; see LOOP_STALL_SEC. */
function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    const st = loopWatch.check();
    if (!st) return;
    const servers = RPC_URLS.map((u, i) => `${u.replace(/^https?:\/\//, "")} wait ${rpcLimits[i].bucket.peek()} ms`).join(", ");
    log(
      `WATCHDOG the main loop has not moved for ${Math.round(st.stalledMs / 1000)} s (stage: ${st.stage}); RPC in flight: ${rpcHighInFlight} fill-path; ` +
        `${servers}; ledger stream ${ledgerWatch.connected ? "connected" : "down"}; last RPC error: ${rpcPicker.lastError || "-"}. ` +
        `Ledger stream, spread reads and background yielding are off for 10 minutes (plain RPC polling).`,
    );
    for (const w of [...ledgerWatch.waiters]) w(true); // whoever waits for a ledger stops waiting
    writeStatus();
    notify(`Watchdog: the main loop was stuck for ${Math.round(st.stalledMs / 1000)} s at "${st.stage}"; fast paths off for 10 min.`, {
      topic: "watchdog",
      everySec: 3600,
    });
  }, 5000);
  watchdogTimer.unref?.();
}

// ----- fill timing -----
const fillTraceCtx = new AsyncLocalStorage(); // the FillTimer of the fill being worked on
const orderReadAt = new Map(); // vault -> when its orders were read in this scan (vaults an event named)
const fillStats = new FillStats(20);
let lastFillTiming = null;
let scanLedger = { seq: 0, at: Date.now() };
function noteFillTiming(timer) {
  const line = timer.line();
  lastFillTiming = `${new Date().toISOString()} ${line}`;
  log(line);
  if (timer.marks.included !== undefined) fillStats.add(timer.marks.included, timer.ledgersLater());
}

/** One log line every 10 minutes: requests in the last minute per server, the busiest methods, 429s and waits. */
function logRpcUsage() {
  const u = rpcUsage.lastMinute();
  if (!u) return;
  const servers = Object.entries(u.per_server)
    .map(([url, n]) => `${url.replace(/^https?:\/\//, "")}=${n}`)
    .join(" ");
  const top = u.top_methods.map(([m, n]) => `${m}=${n}`).join(" ");
  const rates = RPC_URLS.map((url, i) => `${rpcLimits[i].aimd.rate().toFixed(1)}/${RPC_MAX_RPS[i]}`).join(" ");
  log(
    `RPC usage, last minute: ${u.total} requests (${servers || "none"}); top: ${top || "-"}; 429s: ${u.rate_limited}; ` +
      `waited for the rate limit: ${(u.waited_ms / 1000).toFixed(1)} s; rate now/max per server: ${rates}; ` +
      `reads served from the scan memo since start: ${readMemoHits}; scan interval: ${idleMode ? `${SCAN_IDLE_SEC} s` : "every ledger"}`,
  );
}

// Say so once when stopped with Ctrl+C (the signal can come from both the window and iora.sh).
let stopping = false;
async function stop(sig) {
  if (stopping) return;
  stopping = true;
  log(`keeper stopped (${sig})`);
  await notify(`Stopped (${sig}). Orders are not filled until it starts again.`);
  process.exit(0);
}
process.on("SIGINT", () => stop("Ctrl+C"));
process.on("SIGTERM", () => stop("SIGTERM"));
// An unexpected error must not stop the keeper silently: it is logged and scanning continues.
process.on("unhandledRejection", (e) => log(`ERROR (unhandled): ${(e && e.message) || e}`));

main().catch(async (e) => {
  log(`FATAL ERROR: ${e.stack || e.message}`);
  await notify(`FATAL ERROR, the keeper stopped: ${e.message}`);
  process.exit(1);
});
