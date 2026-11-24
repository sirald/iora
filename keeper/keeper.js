// Iora keeper bot.
//
// Scans every vault in the factories (buy: USDC -> XLM, sell: XLM -> USDC), finds the open orders and,
// when the market meets the limit,
// calls `execute`. The keeper can never choose the recipient, the amount or the limit; it only
// says "try now" and picks the fill size. A bad keeper can cause a delay at most.
//
// Usage:
//   node keeper.js            runs continuously: scans on every new ledger (~5 s) (every INTERVAL_SEC with SCAN_MODE=interval)
//   node keeper.js --once     scans once (a few rounds) and exits
//   node keeper.js --ttl      also extends the lifetime of entries (in continuous mode on idle ledgers, bit by bit)
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
// back to testnet addresses.
const TESTNET_RPCS = ["https://soroban-rpc.testnet.stellar.gateway.fm", "https://soroban-testnet.stellar.org"];
const RPC_URLS = [...new Set([cfg.RPC_URL, cfg.RPC_FALLBACK, ...(PASSPHRASE === Networks.TESTNET ? TESTNET_RPCS : [])].filter(Boolean))];
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
// scan down). They are read when an order_placed event names them, and in a rotating sweep of this many per scan.
const SWEEP_PER_SCAN = Math.max(1, Number(cfg.SWEEP_PER_SCAN || 40));
const RPC_TIMEOUT_MS = Number(cfg.RPC_TIMEOUT_MS || 12_000);
const TX_TIMEOUT_SEC = 120;
const TTL_EVERY_SEC = 24 * 3600;
const LOW_BALANCE_XLM = 100;
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
const VENUES = !!FILLER && (!!AQUA_ROUTER || !!PHOENIX_MULTIHOP) && String(cfg.VENUES || "on").toLowerCase() !== "off";
// A route through the filler is used only if it beats Soroswap alone by at least this much (it costs more network fee).
const VENUE_EDGE_BPS = BigInt(cfg.VENUE_EDGE_BPS || 5);
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
// repeated on the next one; a minute later the first server is tried again. Contract errors are real answers and are not repeated.
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

function transientRpc(e) {
  const status = e && e.response && e.response.status;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  return /fetch failed|network|timeout|timed out|aborted|ECONN|socket|EAI_AGAIN|ENOTFOUND|did not answer/i.test(String((e && e.message) || e));
}

// The SDK's getAccount reports a network error as "Account not found" too; so when the first server went down there
// was no falling back and no fill could be sent. The same read is done with getLedgerEntries (a network error is retried on the fallback).
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
          new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("the RPC did not answer")), RPC_TIMEOUT_MS))),
        ]);
        if (idx !== cur) {
          cur = idx;
          switchedAt = Date.now();
          if (Date.now() - loggedAt > 10 * 60_000) {
            loggedAt = Date.now();
            log(`switched to the fallback RPC: ${urls[idx]} (the first server is not answering; it is retried once a minute)`);
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

/** Transaction to be sent: with the current sequence number. */
async function liveTx(contractId, method, callArgs, signer = kp) {
  const account = await server.getAccount(signer.publicKey());
  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...callArgs))
    .setTimeout(TX_TIMEOUT_SEC)
    .build();
}

/** Simulation only: a free read. */
async function read(contractId, method, callArgs = []) {
  const sim = await server.simulateTransaction(readTx(contractId, method, callArgs));
  if (rpc.Api.isSimulationError(sim)) return { ok: false, error: sim.error, code: errCode(sim.error) };
  return { ok: true, value: sim.result ? scValToNative(sim.result.retval) : undefined };
}

/**
 * Signs, sends and waits for the result. The transaction is followed until its validity (TX_TIMEOUT_SEC) ends:
 * if it returns "timed out", the transaction was definitely not written to the chain and trying again is safe.
 * retry=true: the network did not accept the transaction at all (congestion, a pending transaction on the same account); it is tried on the next ledger.
 */
async function submit(tx, signer = kp) {
  tx.sign(signer);
  let sent;
  try {
    sent = await server.sendTransaction(tx);
  } catch (e) {
    return { ok: false, retry: true, error: `could not be sent: ${e.message}` };
  }
  if (sent.status === "TRY_AGAIN_LATER") return { ok: false, retry: true, error: "the network did not take the transaction now (TRY_AGAIN_LATER)" };
  if (sent.status === "ERROR") {
    let name = "";
    try {
      const res = get(get(sent, "errorResult"), "result");
      name = res.type || get(res, "switch")?.name || "";
    } catch {}
    return { ok: false, error: `send error ${name}`.trim() };
  }
  // PENDING or DUPLICATE: the transaction is queued
  const deadline = Date.now() + (TX_TIMEOUT_SEC + 15) * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    let r;
    try {
      r = await server.getTransaction(sent.hash);
    } catch {
      continue; // temporary RPC error: keep following the transaction
    }
    if (r.status === "SUCCESS") {
      let fee = null;
      try {
        fee = BigInt(get(r.resultXdr, "feeCharged"));
      } catch {}
      return { ok: true, hash: sent.hash, fee, value: r.returnValue ? scValToNative(r.returnValue) : undefined };
    }
    if (r.status === "FAILED") return { ok: false, hash: sent.hash, error: "the transaction failed on the network" };
  }
  return { ok: false, hash: sent.hash, error: "timed out (the transaction expired and was not written to the chain)" };
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
          const account = await server.getAccount(signer.publicKey());
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
      throw new Error(`could not read order ${st.next} of ${short(vault)}: ${errText(r)}`);
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
  // Scheduled orders must be known before the crossing pass (they are left to the pool pass).
  for (const o of orders) await scheduleOf(vault, o.id);
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
 * In version 8 vaults a fill can also go through one intermediate token (e.g. USDC -> XLM -> BTC). Picks the
 * route that gives the most output for the amount: { q, via } (via null = the direct pair). Null if there is no route.
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
  async call(user, opt, tin, tout, amount) {
    const args = await argsFor("Aquarius", AQUA_ROUTER, "swap", {
      user: addrVal(user),
      tokens: aquaTokens(tin, tout),
      token_in: addrVal(tin),
      token_out: addrVal(tout),
      pool_index: xdr.ScVal.scvBytes(opt.hash),
      in_amount: u128(amount),
      out_min: u128(1),
    });
    return args && { contract: AQUA_ROUTER, func: "swap", args };
  },
};

// ----- Phoenix: one pool per pair, reached through its multihop contract -----
const phoenixOps = (tin, tout) => xdr.ScVal.scvVec([structVal({ offer_asset: addrVal(tin), ask_asset: addrVal(tout), ask_asset_min_amount: voidVal() })]);
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
  async call(user, opt, tin, tout, amount) {
    const args = await argsFor("Phoenix", PHOENIX_MULTIHOP, "swap", {
      recipient: addrVal(user),
      operations: phoenixOps(tin, tout),
      max_spread_bps: voidVal(),
      amount: i128(amount),
      pool_type: PHOENIX_XYK(),
      deadline: voidVal(),
      max_allowed_fee_bps: voidVal(),
    });
    return args && { contract: PHOENIX_MULTIHOP, func: "swap", args };
  },
};
const venueList = () => [aquaVenue, phoenixVenue].filter((v) => v.on());

// ----- what a venue does in its caller's name -----
const VENUE_PROBE = 100_000n; // 0.01 token
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
  const c = await venue.call(kp.publicKey(), opt, tin, tout, VENUE_PROBE);
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
  const key = `${venue.name}:${tin}:${opt.id}`;
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
/** The template with the filler as caller and the real amount, as `Auth` values for the filler contract. */
function venueAuths(template, amount) {
  const me = kp.publicKey();
  const subst = (args) =>
    args.map((a) => {
      const j = jv(a);
      if (j.address === me) return addrVal(FILLER);
      if (j.i128 !== undefined && typeof j.i128 !== "object" && BigInt(j.i128) === VENUE_PROBE) return i128(amount);
      if (j.u128 !== undefined && typeof j.u128 !== "object" && BigInt(j.u128) === VENUE_PROBE) return u128(amount);
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

/**
 * The best way to sell `fill` of `tin` for `tout` that involves another venue: the whole fill in the venue pool
 * that quotes the most, or a split between that pool and the direct Soroswap pool (25, 50 or 75% on the venue).
 * `only` (a venue name) and `forceShare` are for the check command. Returns { q, route (ScVal), text } or null.
 */
async function venueRoute(fill, tin, tout, forceShare = null, only = null) {
  if (!VENUES || Date.now() < venueState.offUntil) return null;
  try {
    // the venue pool that gives the most for the whole fill
    let best = null;
    for (const venue of venueList()) {
      if (only && venue.name !== only) continue;
      for (const opt of await venue.options(tin, tout)) {
        const q = await venue.quote(opt, tin, tout, fill);
        if (q !== null && q > 0n && (!best || q > best.q)) best = { venue, opt, q };
      }
    }
    if (!best) return null;
    const { venue, opt } = best;
    const template = await venueTemplate(venue, opt, tin, tout);
    if (!template) return null;
    let pick = { q: best.q, venueAmt: fill, soroAmt: 0n };
    const soroPool = await poolOf(tin, tout);
    if (forceShare !== null && forceShare < 100n) pick = { q: 0n, venueAmt: fill, soroAmt: 0n }; // a check asks for exactly this split
    if (soroPool && forceShare !== 100n) {
      for (const share of forceShare !== null ? [forceShare] : [75n, 50n, 25n]) {
        const a = (fill * share) / 100n;
        const b = fill - a;
        const [qa, qb] = await Promise.all([venue.quote(opt, tin, tout, a), quotePath(b, [tin, tout])]);
        if (qa !== null && qb !== null && qa + qb > pick.q) pick = { q: qa + qb, venueAmt: a, soroAmt: b };
      }
    }
    const steps = [];
    const c = await venue.call(FILLER, opt, tin, tout, pick.venueAmt);
    if (!c) return null;
    steps.push(callVal(c.contract, c.func, c.args, venueAuths(template, pick.venueAmt)));
    if (pick.soroAmt > 0n) {
      const deadline = Math.floor(Date.now() / 1000) + 300;
      steps.push(
        callVal(
          ROUTER,
          "swap_exact_tokens_for_tokens",
          [i128(pick.soroAmt), i128(0), xdr.ScVal.scvVec([addrVal(tin), addrVal(tout)]), addrVal(FILLER), u64v(deadline)],
          [structVal({ contract: addrVal(tin), func: symVal("transfer"), args: xdr.ScVal.scvVec([addrVal(FILLER), addrVal(soroPool.pair), i128(pick.soroAmt)]), subs: xdr.ScVal.scvVec([]) })],
        ),
      );
    }
    const text = pick.soroAmt > 0n ? `${venue.name} ${fmt(pick.venueAmt)} + Soroswap ${fmt(pick.soroAmt)}` : venue.name;
    return { q: pick.q, route: xdr.ScVal.scvVec(steps), text };
  } catch (e) {
    venueState.offUntil = Date.now() + 10 * 60_000;
    log(`venues: ${e.message}; other venues are skipped for 10 minutes`);
    return null;
  }
}

/** Same as the contract's price impact calculation. */
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
const lastNote = new Map();
// "vault:id" -> { n, until }: an order that passes the pre-checks but keeps being rejected by the contract. The wait
// doubles with each run of rejections (1, 2, 4 ... at most 60 rounds), so a stuck order does not waste RPC calls and log space.
const stuck = new Map();
let scanNo = 0;

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
    return waiting(vault, o, tag, BigInt(o.amount_in) - BigInt(o.filled_in), tin, "expired");
  }
  const remaining = BigInt(o.amount_in) - BigInt(o.filled_in);
  const held = stuck.get(key);
  if (held && scanNo < held.until) return "waiting";
  const limit = BigInt(o.limit_price);
  const minFill = BigInt(o.min_fill);
  const maxImpact = BigInt(o.max_impact_bps);
  const trigger = BigInt(o.trigger_price ?? 0);
  // Scheduled order (DCA): nothing to do until the next part is due, and then exactly one part is filled.
  let sch = await scheduleOf(vault, o.id);
  if (sch && now >= sch.next + DCA_CLOCK_MARGIN_SEC) sch = await scheduleOf(vault, o.id, true); // someone else may have filled it
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
  // With other venues in play a Soroswap price a little short of the limit does not rule the order out.
  const slack = VENUES && pc.v13 ? 1030n : 1005n;
  if (est !== null && trusted && (est * slack) / 1000n + 2n < minOut(smallest, limit)) {
    localSkips++;
    return waiting(vault, o, tag, remaining, tin, priceNoteFor(tin, tout, smallest, est, limit));
  }
  ctx.net++; // from here on the order costs network calls

  // Triggered order (stop loss): the contract checks the trigger against the Blend oracle. The trigger is asked first
  // with a single simulation; if it has not come ("no trigger" 16, "no oracle" 19), it waits without any price query.
  if (trigger > 0n) {
    const pre = await read(vault, "execute", execArgs(smallest));
    if (!pre.ok && pre.code === 16) return waiting(vault, o, tag, remaining, tin, "the trigger price (oracle) has not been reached yet");
    if (!pre.ok && pre.code === 19) return waiting(vault, o, tag, remaining, tin, "no oracle price available");
  }

  // If even the smallest fill does not meet the limit, larger ones will not either (a larger trade gets a worse price
  // in the pool): a waiting order costs one price query per ledger.
  const rSmall = await bestRoute(smallest, tin, tout, vias);
  const qSmall = rSmall ? rSmall.q : null;
  if (qSmall === null) {
    log(`${tag} no price available`);
    return "error";
  }
  if (est !== null && !trusted) {
    // Compare the local formula with the real quote for this pair before relying on it.
    const diff = est > qSmall ? est - qSmall : qSmall - est;
    const tol = qSmall / 300n > 2n ? qSmall / 300n : 2n;
    if (diff <= tol) localCheck.set(lk, { okAt: Date.now() });
    else {
      localCheck.set(lk, { offUntil: Date.now() + LOCAL_RECHECK_MS });
      log(`the local price estimate was off for ${sym(tin)}->${sym(tout)} (local ${est}, network ${qSmall}); this pair is quoted over the network for 30 min`);
    }
  }
  const useVenues = VENUES && pc.v13;
  if (qSmall < minOut(smallest, limit)) {
    // Soroswap alone does not reach the limit; another venue might.
    const alt = useVenues ? await venueRoute(smallest, tin, tout) : null;
    if (!alt || alt.q < minOut(smallest, limit)) return waiting(vault, o, tag, remaining, tin, priceNoteFor(tin, tout, smallest, alt && alt.q > qSmall ? alt.q : qSmall, limit));
  }

  let note = "";
  let rejected = null; // the first fill the contract rejected (smaller ones are tried in the same round)
  for (const fill of sizes) {
    const route = fill === smallest ? rSmall : await bestRoute(fill, tin, tout, vias);
    const qSoro = route ? route.q : null;
    const via = route ? route.via : null;
    if (qSoro === null) {
      log(`${tag} no price available`);
      return "error";
    }
    // Another venue (or a split) is taken only if it clearly beats Soroswap alone.
    let alt = useVenues ? await venueRoute(fill, tin, tout) : null;
    if (alt && alt.q * BPS < qSoro * (BPS + VENUE_EDGE_BPS)) alt = null;
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
      const ra = await write(vault, "fill_via", [new Address(kp.publicKey()).toScVal(), u32(o.id), i128(fill), addrVal(FILLER), alt.route], true);
      if (ra.ok) {
        dirty.add(vault);
        if (sch) schedules.delete(key);
        stats.fills++;
        stuck.delete(key);
        if (ra.fee !== null) stats.feesStroop += ra.fee;
        log(`FILLED ${tag} ${fmt(fill)} ${sym(tin)} -> ${fmt(ra.value)} ${sym(tout)} via ${alt.text} (Soroswap alone: ${fmt(qSoro)}) fee=${ra.fee !== null ? fmt(ra.fee) : "?"} XLM tx=${ra.hash}`);
        const left = remaining - fill;
        await notify(
          `${side === "buy" ? "Buy" : "Sell"} order filled: vault ${short(vault)} #${o.id}\n` +
            `${fmt(fill)} ${sym(tin)} -> ${fmt(ra.value)} ${sym(tout)} (${alt.text})` +
            (left > 0n ? `\nLeft: ${fmt(left)} ${sym(tin)}` : "\nThe order is completely filled.") +
            `\nhttps://stellar.expert/explorer/testnet/tx/${ra.hash}`,
        );
        return "filled";
      }
      if (ra.retry) {
        log(`${tag}: ${ra.error}; it will be tried again on the next ledger`);
        return "busy";
      }
      // The other venue did not work out (the price moved, or the route was refused): Soroswap alone, as before.
      const why = `${alt.text} route refused (${errText(ra)})`;
      if (!lastNote.has(`venue:${key}`) || Date.now() - lastNote.get(`venue:${key}`).at > 10 * 60_000) {
        lastNote.set(`venue:${key}`, { at: Date.now() });
        log(`${tag} ${why}; trying Soroswap alone`);
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
    const single = () => write(vault, "execute", execArgs(fill, via), true);
    const r = pc.v8 ? await fillOrder(vault, o.id, fill, via, single) : await single();
    dirty.add(vault); // whatever happened, read this vault's orders again on the next scan
    if (sch) schedules.delete(key); // the schedule moves when a part fills: read it again
    if (r.ok) {
      stats.fills++;
      stuck.delete(key);
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
    stats.failures++;
    stats.lastError = `${tag}: ${errText(r)}`;
    if ([8, 10, 13, 20].includes(r.code)) {
      // Our own price and impact checks passed but the contract rejected: the price may have moved in the meantime,
      // a smaller fill is tried.
      rejected = rejected || { fill, r };
      continue;
    }
    // Unexpected error (e.g. the transaction got on-chain but failed): this order is rested too, so that it is not
    // retried every round burning fees (1, 2, 4 ... at most 60 rounds).
    const n = (held?.n || 0) + 1;
    const rest = Math.min(2 ** (n - 1), 60);
    stuck.set(key, { n, until: scanNo + rest });
    log(`${tag} fill ${fmt(fill)} failed: ${errText(r)}; it will be tried again in ${rest} round(s)`);
    await notify(`Fill error ${tag}: ${errText(r)}`, { topic: `err:${tag}`, everySec: 3600 });
    return "error";
  }
  if (rejected) {
    // No size went through: the order is rested for a while. If it stays that way for long (e.g. the error comes from
    // another contract, the owner has no trustline) a notice is sent once.
    const n = (held?.n || 0) + 1;
    const rest = Math.min(2 ** (n - 1), 60);
    stuck.set(key, { n, until: scanNo + rest });
    log(`${tag} fill ${fmt(rejected.fill)} rejected by the contract: ${errText(rejected.r)}; it will be tried again in ${rest} round(s)`);
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

async function tryCross(a, b) {
  const lo = (SCALE * SCALE + b.limit - 1n) / b.limit; // the least X per Y that b accepts
  const hi = a.limit; // the most X per Y that a pays
  if (lo > hi) return "no";
  let amt = crossAmounts(a, b, (lo + hi) / 2n);
  if (!amt) return "no";
  // What would the pool give each side for these amounts?
  let qa = await quote(amt.x, a.tin, a.tout);
  let qb = await quote(amt.y, b.tin, b.tout);
  if (qa !== null && qb !== null && qa > 0n && qb > 0n) {
    let mid = ((amt.x * SCALE) / qa + (qb * SCALE) / amt.y) / 2n; // the pool's middle price for these amounts
    if (mid < lo) mid = lo;
    if (mid > hi) mid = hi;
    const again = crossAmounts(a, b, mid);
    if (again && (again.x !== amt.x || again.y !== amt.y)) {
      amt = again;
      qa = await quote(amt.x, a.tin, a.tout);
      qb = await quote(amt.y, b.tin, b.tout);
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
  if (r.retry) {
    log(`cross ${tag}: ${r.error}; it will be tried again on the next ledger`);
    return "busy";
  }
  if (r.code === 4 || r.code === 5) return "no"; // one of the two orders is no longer open; both vaults are read again
  stats.failures++;
  stats.lastError = `cross ${tag}: ${errText(r)}`;
  // Rested like a stuck order (1, 2, 4 ... at most 60 rounds), so a pair the contract keeps rejecting does not burn fees.
  const k = `x:${a.key}|${b.key}`;
  const n = (stuck.get(k)?.n || 0) + 1;
  const rest = Math.min(2 ** (n - 1), 60);
  stuck.set(k, { n, until: scanNo + rest });
  log(`cross ${tag} rejected: ${errText(r)}; this pair is tried again in ${rest} round(s)`);
  return "error";
}

/** Looks for opposite orders that can fill each other and sends the crosses. Returns how many crosses went through. */
async function crossPass(vaults) {
  crossedNow.clear();
  if (!CROSS) return 0;
  const now = Math.floor(Date.now() / 1000);
  const list = [];
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
    for (const id of st.open) {
      const o = st.orders.get(id);
      const key = `${v}:${id}`;
      if (!o || closed.has(key)) continue;
      if (BigInt(o.trigger_price ?? 0) > 0n) continue; // stop orders are left to the pool pass
      if (pc.v11 && schedules.get(key) !== null) continue; // scheduled orders (or not known yet) are left to the pool pass
      if (now > Number(o.expiry)) continue;
      const remaining = BigInt(o.amount_in) - BigInt(o.filled_in);
      if (remaining <= 0n) continue;
      list.push({ vault: v, o, key, tin: String(o.sell), tout: String(o.buy), remaining, limit: BigInt(o.limit_price), minFill: BigInt(o.min_fill), fees: pc.fees });
    }
  }
  if (list.length < 2) return 0;
  const used = new Set();
  const tried = new Set();
  let done = 0;
  for (const a of list) {
    if (used.has(a.key)) continue;
    // Opposite orders in other vaults whose limit overlaps a's (a.limit * b.limit >= 1 in 7-decimal units), the most generous first.
    const opposite = list
      .filter((b) => !used.has(b.key) && b.vault !== a.vault && b.tin === a.tout && b.tout === a.tin && a.limit * b.limit >= SCALE * SCALE)
      .sort((p, q) => (q.limit > p.limit ? 1 : q.limit < p.limit ? -1 : 0));
    for (const b of opposite) {
      const pk = a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`;
      if (tried.has(pk)) continue;
      tried.add(pk);
      const held = stuck.get(`x:${a.key}|${b.key}`) || stuck.get(`x:${b.key}|${a.key}`);
      if (held && scanNo < held.until) continue;
      let res;
      try {
        res = await tryCross(a, b);
      } catch (e) {
        log(`ERROR cross ${short(a.vault)} #${a.o.id} x ${short(b.vault)} #${b.o.id}: ${e.message}`);
        continue;
      }
      if (res === "crossed") {
        used.add(a.key);
        used.add(b.key);
        done++;
        break;
      }
      if (res === "busy") break;
    }
  }
  return done;
}

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

async function runTtlJob(job) {
  if (job.kind === "factory") {
    const args = job.chain
      ? [u32(job.bucket), optAddr(job.from), u32(40)]
      : job.bucket === undefined
        ? [u32(job.start), u32(40)]
        : [u32(job.bucket), u32(job.start), u32(40)];
    const r = await write(job.f, "extend_ttl", args);
    const where = job.chain ? (job.from ? short(job.from) : "head") : job.start;
    log(`TTL factory ${short(job.f)} ${job.bucket === undefined ? "" : `bucket ${job.bucket} `}${where}..: ${r.ok ? "ok" : errText(r)}`);
    return;
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
    log(`TTL ${short(v)} (${keys.length} entries): ${r.ok ? `ok, fee ${r.fee !== null ? fmt(r.fee) : "?"} XLM` : r.error}`);
  } catch (e) {
    log(`TTL ${short(v)} error: ${e.message}`);
  }
}

/** --once mode (GitHub Actions): everything in one go. */
async function extendTtlAll(vaults) {
  for (const job of await factoryTtlJobs()) await runTtlJob(job);
  for (const vault of vaults) await runTtlJob({ kind: "vault", vault });
}

// ---------------------------------------------------------------------------
// Main loop
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

let lastTtl = 0; // when the last full TTL round finished (ms); read from status.json on restart
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
      log(`ERROR ${e.message}`);
      return;
    }
    seenVaults.add(v);
    dirty.delete(v);
  });
  // 2) Opposite orders that can fill each other are crossed first (version 10 vaults), with no pool in between.
  try {
    filled += 2 * (await crossPass(vaults));
  } catch (e) {
    log(`ERROR crossing: ${e.message}`);
  }
  // 3) Check every open order against this scan's prices, from the cached copies. Fills run in parallel, one per
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
      if (crossedNow.has(`${v}:${o.id}`)) return; // just filled by a cross; its cached copy is stale until the next scan
      if (BigInt(o.amount_in) < minFillFor(o.sell ? String(o.sell) : null)) return; // dust orders (not the last small piece of a larger order)
      try {
        const res = await tryOrder(v, o, ctx);
        if (res === "filled") filled++;
        if (res === "filled" || res === "error" || res === "busy") tries++; // only real transaction attempts are counted
      } catch (e) {
        stats.failures++;
        stats.lastError = e.message;
        log(`ERROR ${short(v)} #${o.id}: ${e.message}`);
      }
    };
    for (let i = 0; i < orders.length; i += width) {
      if (ctx.net >= MAX_ORDERS_PER_VAULT) break; // network-checked orders per vault per scan
      if (tries >= MAX_FILLS_PER_VAULT) {
        log(`${short(v)}: ${MAX_FILLS_PER_VAULT} transactions tried in this round, the rest in the next one`);
        break;
      }
      await Promise.all(orders.slice(i, i + width).map(one));
    }
  });
  for (const v of vaults) open += book.get(v)?.open.length ?? 0; // every vault, including the ones not read this scan
  const balance = await keeperBalance();
  if (balance !== null && balance < LOW_BALANCE_XLM) {
    const sent = await notify(`The keeper balance is low: ${balance.toFixed(2)} XLM. Add XLM for transaction fees.`, {
      topic: "low-balance",
      everySec: 6 * 3600,
    });
    if (sent) log(`WARNING the keeper balance is low: ${balance} XLM`);
  }
  try {
    fs.writeFileSync(
      STATUS_FILE,
      JSON.stringify(
        {
          last_scan: new Date().toISOString(),
          vaults: vaults.length,
          open_orders: open,
          fills_this_round: filled,
          total_fills: stats.fills,
          total_failures: stats.failures,
          total_fees_xlm: fmt(stats.feesStroop),
          last_error: stats.lastError,
          keeper_balance_xlm: balance,
          sending_accounts: signers.length,
          batch_fills: BATCH ? `${batchFills} orders / ${batchTxs} transactions` : "off",
          crosses: CROSS ? crossFills : "off",
          skipped_by_local_estimate: localSkips,
          last_ttl: lastTtl ? new Date(lastTtl).toISOString() : null,
        },
        null,
        2,
      ),
    );
  } catch {}
  return { vaults, filled, open };
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
  for (const venue of venueList()) {
    for (const [label, share] of [[`all on ${venue.name}`, 100n], [`half ${venue.name}, half Soroswap`, 50n]]) {
      const r = await venueRoute(left, tin, tout, share, venue.name);
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
  log(`keeper started: ${kp.publicKey()} factories=${FACTORIES.map(short).join(",")} rpc=${RPC_URLS.join(" | ")}`);
  if (ONCE) {
    let last;
    for (let round = 1; round <= 4; round++) {
      last = await scan();
      log(`round ${round}: ${last.vaults.length} vaults, ${last.open} open orders, ${last.filled} fills`);
      if (last.filled === 0) break;
    }
    if (DO_TTL && last) await extendTtlAll(last.vaults);
    return;
  }
  if (WORKERS > 0) {
    await ensureWorkers();
    log(`sending accounts: ${signers.length} (main account + ${signers.length - 1} workers)`);
    log(BATCH ? `batch fills on: at most ${BATCH_SIZE} orders per transaction, contract ${short(BATCH)}` : "batch fills off (no testnet/batch.env)");
  }
  let workersAt = Date.now();
  const prevTtl = Date.parse(readStatus().last_ttl || "");
  if (Number.isFinite(prevTtl)) lastTtl = prevTtl;
  let ttlJobs = [];
  let failedScans = 0;
  await notify(
    `Started. ${FACTORIES.length > 1 ? "Several factories" : "One factory"}, ` +
      (SCAN_MODE === "ledger" ? "scanning on every new ledger (~5 s)." : `scanning every ${INTERVAL_SEC} s.`),
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
      // TTL upkeep must not hold up scanning: a job list is prepared once a day and worked through
      // one job at a time in rounds without a fill.
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
      log(`ERROR scan: ${e.message}`);
      if (failedScans >= 3) {
        await notify(`${failedScans} scans failed in a row: ${e.message}`, { topic: "scan", everySec: 3600 });
      }
    }
    if (SCAN_MODE !== "ledger") {
      await sleep(INTERVAL_SEC * 1000);
      continue;
    }
    // Look once a second until a new ledger arrives (wait INTERVAL_SEC at most)
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

// Say so once when stopped with Ctrl+C (the signal can come from both the window and iora.sh).
let stopping = false;
async function stop(sig) {
  if (stopping) return;
  stopping = true;
  log(`keeper stopped (${sig})`);
  await notify("Stopped (Ctrl+C). Orders are no longer filled automatically.");
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
