import "./polyfill.js";
import "./style.css";
import "./skin.css";
import "./motion.css";
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Memo,
  Contract,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  StrKey,
  xdr,
} from "@stellar/stellar-sdk";
import { getAddress, getNetwork, isAllowed, isConnected, requestAccess, signTransaction } from "@stellar/freighter-api";
import { flushReads, makeServer, RPC_FALLBACK, RPC_PRIMARY, setReadPolicy } from "./rpc.js";
import { COPY_LABEL, copied } from "./motion.js";
import { makeQuote, quoteMismatch, routeProblem } from "./swap-quote.js";
import { OLD_BLEND_USDC, coinLabel, planMove, stayNewest } from "./migrate.js";
import { PART, planMove as planMoverCall, sortCoins, splitPlan } from "./mover.js";
import { bestVenue, coinStyle, reflectorPrice, testnetNote, venueLine } from "./prices.js";
import { pendingAdd, pendingDrop, pendingParse, pendingTooOld, txVerdict } from "./tx-status.js";
import { hfClass, hfText, lpMax as lpMaxOf, lpSafeMax as lpSafeMaxOf, lpTotals as lpTotalsOf } from "./lend.js";
import { StellarWalletsKit } from "swk-sdk";
import { defaultModules } from "swk-modules";

// ---------------------------------------------------------------------------
// Settings (from web/.env.local; web/dev.sh generates it)
// ---------------------------------------------------------------------------
const C = {
  rpc: import.meta.env.VITE_RPC_URL || RPC_PRIMARY,
  factory: import.meta.env.VITE_FACTORY,
  usdc: import.meta.env.VITE_USDC,
  xlm: import.meta.env.VITE_XLM,
  router: import.meta.env.VITE_ROUTER,
  usdcIssuer: import.meta.env.VITE_USDC_ISSUER,
  pool: import.meta.env.VITE_POOL || "CANUGJL73FGXXDE7BVVUCIPM2ETOO2UARG4B3Q2TJKI4FADWJAMLIKXV",
};
const PASS = Networks.TESTNET;
// The fast RPC first, the fallback if there is a problem (see rpc.js)
const server = makeServer([C.rpc, import.meta.env.VITE_RPC_FALLBACK, RPC_PRIMARY, RPC_FALLBACK]);
// Reads are shared for a few seconds by rpc.js. Some answers can be reused for much longer:
//  - a wallet's vault in a factory never changes once it exists, so it is remembered in this browser for good;
//    "no vault here" can only change in the newest factory (where a vault is opened), so for the older factories
//    it is remembered for a few hours as well (opening a vault clears these: see call());
//  - which pool trades a pair of coins, and which of the two comes first in it, is fixed when the pool is
//    created: remembered in this browser for a month, so the chart of a later visit starts without asking again;
//  - the list of pools a venue has for a pair changes rarely: remembered in this browser for half an hour;
//  - names, decimals and contract settings do not change while the page is open.
const FACTORY_LATEST = C.factory;
const FIXED_READS = new Set(["token_0", "token_1", "router_pair_for"]);
const STATIC_READS = new Set(["version", "decimals", "symbol", "name", "token_0", "token_1", "router_pair_for", "get_reserve_list", "get_pools"]);
setReadPolicy(({ contract, fn, empty }) => {
  if (fn === "vault_of") return empty ? (contract === FACTORY_LATEST ? null : { ttl: 6 * 3600_000, keep: true }) : { ttl: Infinity, keep: true };
  if (FIXED_READS.has(fn) && !empty) return { ttl: 30 * 86_400_000, keep: true };
  if (fn === "get_pools") return { ttl: 30 * 60_000, keep: true };
  if (STATIC_READS.has(fn)) return { ttl: 10 * 60_000 };
  if (fn === "get_config") return { ttl: 5 * 60_000 };
  return null;
});
const U = 10_000_000n;
// Pool guard. Iora is also a place to trade: when an order fills, funds are withdrawn from Blend, and if most of
// the pool is lent out both withdrawals and fills wait. So the limit is kept below Blend's own limit (95%).
const UTIL_WARN = Number(import.meta.env.VITE_UTIL_WARN || 0.7); // warn above this utilisation
const UTIL_STOP = Number(import.meta.env.VITE_UTIL_STOP || 0.8); // new deposits and orders stop above this utilisation
const UTIL_ENFORCE = import.meta.env.VITE_UTIL_ENFORCE === "1"; // when off (testnet) it only warns
const ORDER_SHARE = 0.25; // a single deposit or order is at most a quarter of what the pool can pay out at that moment
const POOLSTAT = {}; // symbol -> { u, avail } (filled by loadPool)
const mkSeen = new Map(); // Markets table: the price text read last, per cell

// State of the sell page. Defined at the top because showView needs it when the page opens.
const SV = { factory: import.meta.env.VITE_FACTORY_SELL || "", vault: null, bal: null, free: null, apr: null, mkt: null };
SV.home = SV.factory; // default sell market (XLM -> USDC)
SV.out = { sym: "USDC", addr: C.usdc }; // the token bought on this page

// ---------------------------------------------------------------------------
// Version 7: one multi-asset vault
// ---------------------------------------------------------------------------
// On-chain there is now ONE vault per user; orders say "sell this token, buy that one" and deposits/withdrawals
// pick a token. The rest of the app still thinks of two vaults, a "buy side" and a "sell side". The translation
// between the two happens in one place: a version 7 vault is carried in the app as a "handle"
// (`<vault address>~<token sold>~<token bought>`); when `read` and `call` see a handle they turn the old-style
// call into the new contract's call. Old vaults are carried as a plain address and work unchanged.
const V7 = Number(import.meta.env.VITE_VAULT_V || 3) >= 7;
if (V7) {
  // One factory: the buy side and the sell side use the same factory and the same vault.
  SV.factory = C.factory;
  SV.home = C.factory;
}
// Trading pairs: always "<coin> / USDC". The default coin is XLM; others come from VITE_PAIRS=SYMBOL:token,...
// (single vault only). The selected coin is fixed when the page loads; changing it reloads the page. That way
// the app's "buy side USDC, sell side coin" layout runs on the same code for every pair.
const PAIRS = V7
  ? String(import.meta.env.VITE_PAIRS || "")
      .split(",")
      .map((x) => x.trim().split(":"))
      .filter((p) => p.length === 2 && /^C[A-Z2-7]{55}$/.test(p[1]) && p[1] !== C.xlm && p[1] !== C.usdc)
      .map(([sym, token]) => ({ sym: sym.replace(/[^A-Za-z0-9]/g, "").slice(0, 12), token }))
      .filter((p) => p.sym && p.sym !== "XLM" && p.sym !== "USDC")
  : [];
const BASE = (() => {
  let want = null;
  try {
    want = localStorage.getItem("iora-base");
  } catch {}
  const p = PAIRS.find((x) => x.sym === want);
  return p ? { sym: p.sym, addr: p.token, extra: true } : { sym: "XLM", addr: C.xlm, extra: false };
})();
const BS = BASE.sym; // symbol of the traded coin
const XB = BASE.extra; // a coin other than XLM: not in the Blend pool, earns no interest in the vault, needs no reserve for network fees
const BASE_KEEP = XB ? 0n : 5n * U; // reserve left in the wallet (XLM only: network fees)
// Leaving: cancelling never needs anyone else. A withdrawal comes out of the lending pool, so it can wait while the
// pool is short of cash; a coin that is not in the pool (XB) sits in the vault itself and has no such wait.
const LEAVE_NOTE = XB ? "You can cancel and withdraw at any time." : "You can cancel at any time; a withdrawal can wait if the lending pool is short of cash.";
function setBase(sym, hash) {
  try {
    if (sym === "XLM") localStorage.removeItem("iora-base");
    else localStorage.setItem("iora-base", sym);
  } catch {}
  if (hash) location.hash = hash;
  if (sym !== BS) location.reload();
}
/** Small amounts (e.g. 0.0013 BTC) must not show as zero with two decimals. */
const nfmt = (v, d = 2) =>
  XB && v !== 0 && Math.abs(v) < 1 ? v.toLocaleString("en-US", { maximumSignificantDigits: 4 }) : v.toLocaleString("en-US", { maximumFractionDigits: d });
const H = (id, sell, buy) => `${id}~${sell}~${buy}`;
const realId = (h) => (h ? String(h).split("~")[0] : h);
const sideOf = (h) => {
  const p = String(h || "").split("~");
  return p.length === 3 ? { id: p[0], s: p[1], b: p[2] } : null;
};
// Should a filled order's output stay in the vault (earning on Blend) or go to the wallet? Default: in the vault.
const KEEP = { on: true };
try {
  KEEP.on = localStorage.getItem("iora-keep") !== "0";
} catch {}
// Fill fee cap (read from the vault's settings; 0 in old vaults without a fee). Shown in the order preview.
const feeCap = new Map(); // vault (or handle) -> units
function loadFeeCap(v) {
  if (!v || feeCap.has(v)) return;
  feeCap.set(v, 0n);
  read(v, "get_config")
    .then((r) => {
      if (r.ok && r.value && r.value.exec_fee !== undefined) feeCap.set(v, BigInt(r.value.exec_fee));
    })
    .catch(() => feeCap.delete(v));
}
const feeNote = (v, sym) => {
  const cap = feeCap.get(v) || 0n;
  return cap > 0n ? `If it fills at a better price than your limit, up to <b>${fmt(cap, 4)} ${sym}</b> of that extra goes to whoever filled it, to cover their network fee. You always get at least what your limit promises.` : "";
};
/** In order previews: where does a filled order's output go? */
const outTo = (v) => (sideOf(v) && KEEP.on ? (XB ? "stays in your vault" : "stays in your vault and keeps earning on Blend") : "goes to your wallet");
const outIn = (v) => (sideOf(v) && KEEP.on ? "in your vault, where it keeps earning" : "in your wallet");
/** Turns an old-style vault call into the version 7 contract's call. Leaves it alone if it is not a handle. */
function v7Translate(contractId, method, args) {
  const h = sideOf(contractId);
  if (!h) return { id: contractId, method, args };
  const S = addr(h.s);
  const B = addr(h.b);
  const flip = H(h.id, h.b, h.s);
  switch (method) {
    case "balance":
    case "free_balance":
    case "orderable_balance":
    case "reserved":
    case "deposited":
      return { id: h.id, method, args: [S] };
    case "stats":
      // The app computes interest as "balance + withdrawn + spent - deposited". In a single vault the amount that
      // comes in through an order (and stays in the vault) is principal too but is not in the "deposited" total; left
      // uncorrected it would look like interest. With the principal the contract keeps (`deposited`) the same formula gives the right result: interest = balance - principal.
      return {
        custom: async () => {
          const [st, dep] = await Promise.all([rawRead(h.id, "stats", [S]), rawRead(h.id, "deposited", [S])]);
          if (!st.ok) return st;
          if (!dep.ok) return dep;
          const v = st.value;
          return { ok: true, value: { ...v, total_deposited: BigInt(dep.value) + BigInt(v.total_withdrawn) + BigInt(v.total_spent) } };
        },
      };
    case "deposit":
    case "withdraw":
      return { id: h.id, method, args: [S, ...args] };
    case "place_order":
    case "place_stop_order":
    case "place_dca":
      return { id: h.id, method, args: [S, B, ...args, nativeToScVal(KEEP.on, { type: "bool" })] };
    case "place_order_then":
      // Old: (amount, limit, minimum fill, impact, lifetime, TARGET VAULT, next limit, next impact, next lifetime)
      return { id: h.id, method, args: [S, B, ...args.slice(0, 5), ...args.slice(6)] };
    case "get_order":
      // Orders of both directions sit in the same vault; an order that does not belong to this side is marked.
      return { id: h.id, method, args, map: (o) => (o && String(o.sell) === h.s && String(o.buy) === h.b ? o : { ...o, foreign: true }) };
    case "get_follow_up":
      return { id: h.id, method, args, map: (f) => (f ? { ...f, vault: flip } : f) };
    case "get_config":
      return {
        id: h.id,
        method,
        args,
        map: (c) => ({ owner: c.owner, usdc: h.s, xlm: h.b, pool: c.pool, router: c.router, guard: c.guard, exec_fee: BigInt((c.fees && c.fees[h.b]) || 0) }),
      };
    case "get_feeder":
      // A single vault has no "feeder": the other side is always the same vault.
      return { done: { ok: true, value: flip } };
    case "set_feeder":
      return { done: { ok: true, skipped: true } };
    default:
      return { id: h.id, method, args };
  }
}
// Extra markets (showcase): XLM is deposited, one of Soroswap's test coins is bought. VITE_MARKETS=SYMBOL:token:factory,...
const EXTRA_MARKETS = String((!V7 && import.meta.env.VITE_MARKETS) || "")
  .split(",")
  .map((x) => x.trim().split(":"))
  .filter((p) => p.length === 3 && /^C[A-Z2-7]{55}$/.test(p[1]) && /^C[A-Z2-7]{55}$/.test(p[2]))
  .map(([sym, token, factory]) => ({ sym: sym.replace(/[^A-Za-z0-9]/g, "").slice(0, 12), token, factory }));
// State of the trading screen (chart, depth). showView uses it when the page opens: it must be defined at the top.
// ---- Coin icons for any symbol (PAIRS can bring new coins): see prices.js coinStyle() ----
function coinI(sym, extra = "") {
  const st = coinStyle(sym);
  return `<i class="coin ${st.cls}${extra ? ` ${extra}` : ""}"${st.mark ? ` data-mark="${esc(st.mark)}" style="--coin:${st.color}"` : ""} aria-hidden="true"></i>`;
}
function paintCoin(el, sym) {
  if (!el) return;
  const st = coinStyle(sym);
  el.className = `coin ${st.cls}`;
  if (st.mark) {
    el.dataset.mark = st.mark;
    el.style.setProperty("--coin", st.color);
  } else {
    delete el.dataset.mark;
    el.style.removeProperty("--coin");
  }
}

// ---- Testnet prices and where they come from: each pool has its own price, so every price says its source ----
const REFLECTOR = (import.meta.env.VITE_REFLECTOR || "CCSZNMAXTNMIZNGDBLIZYKLOZG3LYKSIXCYC7GKWLOBLSMUPX7MKPHDF").trim();
const PX = { buy: [], sell: [], ref: null, refFor: null, refAt: 0 };
/** The Reflector oracle's price (in $) for a coin, read at most once a minute; null if it has none. */
async function refPrice(token) {
  if (PX.refFor === token && Date.now() - PX.refAt < 60_000) return PX.ref;
  const r = await read(REFLECTOR, "lastprice", [xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Stellar"), addr(token)])]).catch(() => ({ ok: false }));
  PX.ref = r.ok ? reflectorPrice(r.value) : null;
  PX.refFor = token;
  PX.refAt = Date.now();
  return PX.ref;
}
/** Writes the source of the top prices, the testnet note and the venue line under the chart. */
function paintPriceSources() {
  const b = bestVenue(PX.buy, "buy"), s = bestVenue(PX.sell, "sell");
  const set = (id, t) => {
    const el = document.getElementById(id);
    if (el) el.textContent = t;
  };
  set("m-src", b ? `Best price · ${b.venue}` : "");
  set("sv-m-src", s ? `Best price · ${s.venue}` : "");
  const note = testnetNote(BS, PX.refFor === BASE.addr ? PX.ref : null);
  for (const id of ["m-tip", "sv-m-tip"]) document.getElementById(id)?.setAttribute("data-tip", note);
  const v = document.body.dataset.view;
  const quotes = v === "sell" && PX.sell.length ? PX.sell : PX.buy;
  const line = venueLine(quotes, PX.refFor === BASE.addr ? PX.ref : null);
  const el = $("ch-venues");
  if (el) {
    el.textContent = line ? `Now, USDC per ${BS}${v === "sell" ? " (selling)" : " (buying)"}: ${line}` : "";
    el.hidden = !line;
  }
}

const TR = { key: null, quote: "USDC", pair: null, base0: true, pts: [], tf: 3600, hover: null, spot: null, res: null, lines: [], note: "", scanned: false };
// The keeper does not fill orders smaller than this (against keeping the keeper busy with dust orders)
const MIN_ORDER = 1_000_000n;
/** Warning for a limit worse than the market (audit Y-1): the contract only guarantees the limit, not the market price. */
const WORSE_BUY = (pct) =>
  `Your limit is ${pct > 0.05 ? `${pct.toFixed(1)}% above` : "at"} the market price. The order can fill right away, but only your limit is guaranteed, not the market price: whoever fills it can keep the difference. To buy at the market price now, use a Market order.`;
const WORSE_SELL = (pct) =>
  `Your price is ${pct > 0.05 ? `${pct.toFixed(1)}% below` : "at"} the market price. The order can sell right away, but only your price is guaranteed, not the market price: whoever fills it can keep the difference. To sell at the market price now, use a Market order.`;
const EXPLORER = "https://stellar.expert/explorer/testnet";

let me = null; // connected wallet address
let vault = null; // vault address
let busy = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const short = (h) => {
  const a = realId(h);
  return a ? `${a.slice(0, 5)}…${a.slice(-4)}` : "";
};

function toUnits(str) {
  // "1,000" means a thousand on screen but used to be read as 1: input with a thousands separator is not guessed, the user is asked.
  if (/^[1-9]\d{0,2}(,\d{3})+(\.\d*)?$/.test(String(str).trim()))
    throw new Error(`Please type "${str}" without a thousands separator, for example 1000 or 1.5`);
  const s = String(str).trim().replace(",", ".");
  if (!/^\d+(\.\d{0,7})?$/.test(s)) throw new Error(`Invalid number: "${str}"`);
  const [a, b = ""] = s.split(".");
  return BigInt(a) * U + BigInt((b + "0000000").slice(0, 7));
}

function fmt(v, digits = 4) {
  const n = Number(BigInt(v)) / 1e7;
  return nfmt(n, digits);
}

const u32 = (n) => nativeToScVal(n, { type: "u32" });
const u64 = (n) => nativeToScVal(BigInt(n) > 18446744073709551615n ? 18446744073709551615n : BigInt(n), { type: "u64" }); // a read-back "no expiry" may have lost precision as a Number
const i128 = (n) => nativeToScVal(BigInt(n), { type: "i128" });
const addr = (a) => new Address(realId(a)).toScVal();
const addrVec = (list) => xdr.ScVal.scvVec(list.map((a) => new Address(a).toScVal()));

const VAULT_ERRORS = {
  1: "Invalid amount",
  2: "Not enough available balance (amounts reserved for open orders are excluded)",
  3: "Order not found",
  4: "Order is not open",
  5: "This order is no longer active",
  6: "Fill is below the minimum size",
  7: "Fill exceeds the remaining amount",
  8: "Limit price not met",
  9: "Invalid limit price",
  10: "Not enough cash in the Blend pool",
  11: "The order's duration is not valid",
  12: "Could not read Blend data",
  13: "Price impact limit exceeded",
  14: "Invalid price impact limit",
  15: "New orders are temporarily paused",
  16: "The trigger price has not been reached yet",
  17: "This vault only accepts deposits from the vault you allowed",
  18: "Invalid automatic sell settings",
  19: "The price feed (oracle) is not available right now",
  20: "The pool price is too far from the oracle price right now",
  21: "Deposit and receive tokens must be different",
  22: "Only the vault's own two tokens can be collected",
  23: "Both tokens must use 7 decimals",
  24: "The stop band must be between 0.5% and 10%",
  26: "A vault can hold at most 12 different coins",
  27: "This coin is not on Iora's list of coins that can be traded",
  28: "Invalid swap route",
  29: "The vault still holds this coin, or an open order uses it",
  31: "The next part of this scheduled order is not due yet",
  33: "The time between two orders must be between 1 minute and 28 days",
  34: "An open order will receive this coin; cancel or close that order first",
};
// Contract version (testnet/factory.env VAULT_V). Version 4 signatures: the band parameter for a stop loss,
// the "withdraw everything" special value for withdraw, collecting output waiting in the vault (sweep).
const V4 = Number(import.meta.env.VITE_VAULT_V || 3) >= 4;
const I128_MAX = (1n << 127n) - 1n;
const SL_BAND_BPS = 300; // largest deviation from the oracle price for a stop loss (3%)
/** Contract rule: an order fills in at most 20 pieces (min_fill >= amount / 20, rounded up). */
const fillFloor = (amount, minFill) => {
  const lo = (amount - 1n) / 20n + 1n;
  return minFill < lo ? lo : minFill;
};
const FACTORY_ERRORS = { 1: "This wallet already has a vault", 2: "Not found", 3: "New vaults are temporarily paused" };

function explain(err, table) {
  const m = String(err).match(/Error\(Contract, #(\d+)\)/);
  if (m && table[Number(m[1])]) return table[Number(m[1])];
  if (/trustline|TrustLine/i.test(String(err))) return "No USDC trustline";
  if (/balance is not sufficient|insufficient/i.test(String(err))) return "Insufficient balance";
  return String(err).split("\n")[0].slice(0, 200);
}

function log(msg, kind = "") {
  const li = document.createElement("li");
  li.className = kind;
  li.innerHTML = `<time>${new Date().toLocaleTimeString("en-US")}</time> ${msg}`;
  $("log").prepend(li);
  // While the access gate is closed, wallet errors must show on the gate
  const gm = $("gate-msg");
  if (gm && (kind === "err" || kind === "wait") && document.documentElement.classList.contains("app-closed")) {
    gm.innerHTML = msg;
    gm.className = kind === "err" ? "gate-msg" : "gate-msg ok";
  }
  // Show the last message at the bottom of the screen too; the log box may be closed.
  const st = $("status");
  st.innerHTML = msg;
  st.className = `status show ${kind}`;
  clearTimeout(log.t);
  // "wait": the app is waiting for the user (a wallet window is open); it stays until the next message replaces it
  if (kind !== "err" && kind !== "wait") log.t = setTimeout(() => st.classList.remove("show"), 7000);
}

// ---------------------------------------------------------------------------
// Network calls
// ---------------------------------------------------------------------------
async function buildCall(contractId, method, args) {
  const account = await server.getAccount(me);
  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASS })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(180)
    .build();
}

// A read does not need the account's sequence number: getAccount is not called before every read (halves the RPC calls).
// An account that always exists (the USDC issuer) is used so that reads work without a connected wallet.
const READ_SOURCE = import.meta.env.VITE_USDC_ISSUER || "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
function readCall(contractId, method, args) {
  // A read gives the same answer whoever asks. Asked in the name of one fixed account, the same question before
  // and after the wallet connects is one question, and rpc.js shares it. The exception is the swap probe, which
  // reads what a swap would do in the wallet's own name.
  const source = method === "swap" && me ? me : READ_SOURCE;
  return new TransactionBuilder(new Account(source, "0"), { fee: BASE_FEE, networkPassphrase: PASS })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(180)
    .build();
}

/** A free read (simulation). */
async function rawRead(contractId, method, args = []) {
  const sim = await server.simulateTransaction(readCall(contractId, method, args));
  if (rpc.Api.isSimulationError(sim)) return { ok: false, error: sim.error };
  return { ok: true, value: sim.result ? scValToNative(sim.result.retval) : undefined };
}
async function read(contractId, method, args = []) {
  const t = v7Translate(contractId, method, args);
  if (t.done) return t.done;
  if (t.custom) return t.custom();
  const r = await rawRead(t.id, t.method, t.args);
  return r.ok && t.map ? { ok: true, value: t.map(r.value) } : r;
}

// If the wallet never answers (the extension hung) the page must not stay on "transaction in progress" forever.
function walletTimeout(p) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error("The wallet did not respond. Open your wallet extension, close any open window there, and try again.")), 180_000)),
  ]);
}

let atWallet = false; // a signing request is open in the wallet
// Network fees the wallet has paid (the Summary tab): read once, then again only after this page sent something.
const FEES = { who: null, at: 0, sum: null, stale: false, asking: null };
async function signAndSend(tx, label = "Transaction") {
  atWallet = true;
  try {
    return await signAndSendNow(tx, label);
  } finally {
    atWallet = false;
    FEES.stale = true;
  }
}
// Submitted transactions whose outcome is not known yet are kept in this browser (hash + what it was), so after a
// timeout or a reload they are settled from the network instead of being called failed (audit IORA-03).
const PENDING_KEY = "iora-pending-tx";
const pendingLoad = () => {
  try {
    return pendingParse(localStorage.getItem(PENDING_KEY));
  } catch {
    return [];
  }
};
const pendingSave = (list) => {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(list));
  } catch {}
};
const pendingForget = (hash) => pendingSave(pendingDrop(pendingLoad(), hash));
const txLink = (hash) => `<a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener">${short(hash)}</a>`;
const tracking = new Set(); // hashes signAndSendNow is following right now
async function signAndSendNow(tx, label) {
  let signed;
  if (useKit) {
    try {
      signed = await walletTimeout(StellarWalletsKit.signTransaction(tx.toXDR(), { networkPassphrase: PASS, address: me }));
    } catch (e) {
      throw new Error((e && e.message) || "Signature rejected");
    }
  } else {
    // Wallets such as Varial keep site permission per network: after switching to Test Net the site looks "not connected".
    // If there is no permission before signing, the connection window opens first, then the signature is requested.
    try {
      const al = await isAllowed();
      if (!al.error && !al.isAllowed) {
        const ra = await requestAccess();
        if (ra.error) throw new Error("Connect your wallet to iorafi.com first (approve the connection window).");
      }
    } catch (e) {
      if (e && /Connect your wallet/.test(e.message)) throw e;
    }
    signed = await walletTimeout(signTransaction(tx.toXDR(), { networkPassphrase: PASS, address: me }));
    if (signed.error) throw new Error(signed.error.message || "Signature rejected");
  }
  if (!signed || !signed.signedTxXdr) throw new Error("Signature rejected");
  atWallet = false; // signed: from here on the network is working, not the wallet
  const ready = TransactionBuilder.fromXDR(signed.signedTxXdr, PASS);
  const sent = await server.sendTransaction(ready);
  if (sent.status === "TRY_AGAIN_LATER") throw new Error("The network is busy and did not accept the transaction. Nothing was sent; try again in a moment.");
  if (sent.status === "ERROR") throw new Error("Could not submit the transaction");
  // The transaction is valid until its time bound (180 s): it is followed until the network shows that time has
  // passed. A read error or "not found yet" proves nothing, so without a final answer the outcome is reported as
  // unknown, never as "safe to try again"; the hash stays saved and is settled later (reconcilePending).
  const link = txLink(sent.hash);
  const at = Math.floor(Date.now() / 1000);
  const maxTime = Number((ready.timeBounds && ready.timeBounds.maxTime) || 0);
  pendingSave(pendingAdd(pendingLoad(), { hash: sent.hash, label: String(label), at, maxTime, wallet: me }));
  tracking.add(sent.hash);
  try {
    const deadline = Date.now() + Math.min(15 * 60_000, Math.max(195_000, (maxTime - at + 30) * 1000));
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      let r = null;
      try {
        r = await server.getTransaction(sent.hash);
      } catch {}
      const v = txVerdict(r, { at, maxTime });
      if (v === "pending") continue;
      pendingForget(sent.hash);
      if (v === "success") return { hash: sent.hash, value: r.returnValue ? scValToNative(r.returnValue) : undefined };
      if (v === "failed") throw new Error(`Transaction failed on-chain (${link})`);
      throw new Error(`The transaction expired without being applied (${link}). Nothing changed, so it is safe to try again.`);
    }
  } finally {
    tracking.delete(sent.hash);
  }
  throw new Error(
    `Status unknown: the network has not confirmed this transaction yet (${link}). It may still have gone through, so do not send it again yet. Iora keeps checking and will report the result here; you can also open the link.`,
  );
}

/** Settles saved transactions whose outcome was not known (after a timeout or a reload). */
let reconciling = false;
async function reconcilePending() {
  if (reconciling) return;
  reconciling = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    let settled = false;
    for (const p of pendingLoad()) {
      if (tracking.has(p.hash)) continue;
      let r = null;
      try {
        r = await server.getTransaction(p.hash);
      } catch {}
      const v = txVerdict(r, p);
      const what = esc(p.label);
      if (v === "pending") {
        if (!pendingTooOld(p, now)) continue;
        log(`${what}: the result could not be confirmed automatically. Check it yourself: ${txLink(p.hash)}`, "err");
      } else if (v === "success") log(`${what}: confirmed on-chain · ${txLink(p.hash)}`, "ok");
      else if (v === "failed") log(`${what}: failed on-chain (${txLink(p.hash)}). Nothing changed; you can try again.`, "err");
      else log(`${what}: expired without being applied (${txLink(p.hash)}). Nothing changed; it is safe to try again.`);
      pendingForget(p.hash);
      settled = true;
    }
    if (settled) {
      flushReads();
      if (me && !busy) refresh().catch((e) => console.warn("refresh after settling", e));
    }
  } finally {
    reconciling = false;
  }
}
setTimeout(() => {
  const open = pendingLoad();
  if (!open.length) return;
  log(`${open.length === 1 ? "An earlier transaction is" : `${open.length} earlier transactions are`} not confirmed yet: ${open.map((p) => `${esc(p.label)} ${txLink(p.hash)}`).join(", ")}. Checking the network…`, "wait");
  reconcilePending();
}, 2000);
setInterval(() => document.visibilityState === "visible" && pendingLoad().length && reconcilePending(), 20_000);
let pendingWarnedAt = 0;

/** Contract call: simulate, get approval, sign, send. */
/**
 * Adds a margin to the simulation's resource estimate. Blend accrues interest on every ledger, so the
 * instructions/reads needed can grow a little before the transaction is written; without a margin it is rejected
 * with "resource limit exceeded" (especially calls that touch Blend, such as withdrawing everything). The overpaid fee is refunded.
 */
function padSim(sim) {
  try {
    const b = sim.transactionData;
    const d = b.build();
    const get = (o, k) => (typeof o[k] === "function" ? o[k]() : o[k]);
    const r = get(d, "resources");
    const ins = Number(get(r, "instructions"));
    const rd = Number(get(r, "diskReadBytes") ?? get(r, "readBytes"));
    const wr = Number(get(r, "writeBytes"));
    if (!(ins > 0)) return sim;
    b.setResources(Math.min(Math.ceil(ins * 1.3) + 200_000, 100_000_000), Math.ceil(rd * 1.2) + 2_000, Math.ceil(wr * 1.2) + 1_000);
    const fee = BigInt(String(get(d, "resourceFee")));
    b.setResourceFee(Number((fee * 3n) / 2n + 20_000n));
  } catch (e) {
    console.warn("resource padding skipped", e);
  }
  return sim;
}

// Vault opening race: the factory gives each vault a sequence number (VaultAt(n)). The transaction goes out with
// write access to the number it had when prepared; if someone else opens a vault while the user approves in the
// wallet, the number shifts and the transaction is rejected on-chain. So the following numbers are added to the
// write list too: it goes through even if SPARE_VAULT_SLOTS people get in first. Unused numbers are not written; only a small extra fee margin is set aside.
const SPARE_VAULT_SLOTS = 12;
function padVaultSlots(sim) {
  try {
    // SDK versions expose XDR fields either as properties or as functions; both are read.
    const g = (o, k) => (o && typeof o[k] === "function" ? o[k]() : o?.[k]);
    const kind = (o) => (o && typeof o.type === "string" ? o.type : o && typeof o.switch === "function" ? o.switch().name : "");
    const b = sim.transactionData;
    for (const k of b.getReadWrite()) {
      if (kind(k) !== "contractData") continue;
      const cd = g(k, "contractData");
      const key = g(cd, "key");
      if (kind(key) !== "scvVec") continue;
      const v = g(key, "vec");
      if (!v || v.length !== 2 || kind(v[0]) !== "scvSymbol" || String(g(v[0], "sym")) !== "VaultAt" || kind(v[1]) !== "scvU32") continue;
      const n = Number(g(v[1], "u32"));
      const extra = [];
      for (let i = 1; i <= SPARE_VAULT_SLOTS; i++) {
        extra.push(
          xdr.LedgerKey.contractData(
            new xdr.LedgerKeyContractData({
              contract: g(cd, "contract"),
              key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("VaultAt"), xdr.ScVal.scvU32(n + i)]),
              durability: g(cd, "durability"),
            }),
          ),
        );
      }
      b.appendFootprint([], extra);
      // Fee margin for the extra write entries and the larger transaction (the network refunds what is not used).
      const fee = BigInt(String(g(b.build(), "resourceFee")));
      b.setResourceFee(Number(fee + BigInt(SPARE_VAULT_SLOTS) * 30_000n));
      return true;
    }
  } catch (e) {
    console.warn("vault slot padding skipped", e);
  }
  return false;
}

// If a new version was published, an old page left open sends no transactions: the old page uses the old contract
// addresses (e.g. funds would go to the old vault). The build id is compared with /version.json.
const BUILD_ID = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "";
let staleSeen = false;
async function staleBuild() {
  if (staleSeen) return true;
  if (!BUILD_ID || import.meta.env.DEV) return false;
  try {
    const r = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return false;
    const j = await r.json();
    if (j && typeof j.build === "string" && j.build && j.build !== BUILD_ID) {
      staleSeen = true;
      showStale();
    }
  } catch {
    return false; // if the check fails the user is not blocked
  }
  return staleSeen;
}
function showStale() {
  if (document.getElementById("stale")) return;
  const bar = document.createElement("div");
  bar.id = "stale";
  bar.className = "stale";
  bar.setAttribute("role", "alert");
  bar.innerHTML = `<span><b>Iora was updated</b><small>Reload before you continue. Your funds are not affected.</small></span><button type="button">Reload</button>`;
  bar.querySelector("button").onclick = () => location.reload();
  document.body.prepend(bar);
}
setInterval(() => document.visibilityState === "visible" && staleBuild(), 60_000);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && staleBuild());

// The transaction link we generate ourselves is kept; everything else is escaped
const safeErr = (msg) =>
  esc(msg).replace(/&lt;a href=&quot;(https:\/\/stellar\.expert\/explorer\/[a-z]+\/tx\/[0-9a-f]{64})&quot; target=&quot;_blank&quot; rel=&quot;noopener&quot;&gt;([0-9a-f.…]+)&lt;\/a&gt;/g, '<a href="$1" target="_blank" rel="noopener">$2</a>');
async function call(contractId, method, args, label, errors) {
  if (await staleBuild()) {
    log(`${label}: this page is out of date. Reload it first (button at the top).`, "err");
    return null;
  }
  // If the wallet is on the wrong network the signing request is not sent at all (the wallet would refuse anyway); a warning is shown first.
  if (me && setup.testnet === false) {
    const r = await currentNetworkOk();
    // Some wallets keep reporting the old network after it was changed. So that the user is not
    // locked out, the signing request is sent anyway on the second attempt; the wallet has the last word.
    if (!r.ok && Date.now() - netBlockedAt > 90000) {
      netBlockedAt = Date.now();
      netGuard(false, r.name);
      $("netwarn").scrollIntoView({ behavior: "smooth", block: "start" });
      log(`${label}: your wallet says it is on ${/PUBLIC|MAIN/i.test(r.name) ? "Mainnet" : esc(r.name || "another network")}. Switch it to Test Net (see the yellow box at the top). Already switched? Press the button again.`, "err");
      return null;
    }
    if (r.ok && !r.unknown) {
      mark("testnet", true);
      netGuard(true);
    }
  }
  if (busy) {
    log(
      atWallet
        ? "Your wallet is still waiting for an answer to the last request. Open the wallet window (it may be behind this one) and approve or reject it first."
        : "Another transaction is still in progress. Wait for it to finish, then try again.",
      "err",
    );
    return null;
  }
  // An earlier transaction whose outcome is unknown may still have gone through: sending the same thing again could
  // double it. The first press only warns; pressing again within two minutes sends anyway.
  const open = pendingLoad().filter((p) => !tracking.has(p.hash) && (!p.wallet || p.wallet === me));
  if (open.length && Date.now() - pendingWarnedAt > 120_000) {
    pendingWarnedAt = Date.now();
    reconcilePending();
    log(`${label}: an earlier transaction is not confirmed yet and may still go through (${open.map((p) => `${esc(p.label)} ${txLink(p.hash)}`).join(", ")}). Wait until it is settled here, or press the button again to send this anyway.`, "err");
    return null;
  }
  busy = true;
  document.body.classList.add("busy");
  try {
    const t = v7Translate(contractId, method, args);
    if (t.done) return t.done;
    let tx = await buildCall(t.id, t.method, t.args);
    let sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(explain(sim.error, errors));
    // Entries left untouched for a long time are archived by the network (audit D-3). If the simulation says "restore
    // first", the user signs a one-off restore transaction, then the real transaction is prepared again.
    if (sim.restorePreamble && sim.restorePreamble.transactionData) {
      log(`${label}: this vault has not been used for a long time, so the network archived some of its records. First approve a one-time restore, then the ${esc(label.toLowerCase())} itself.`);
      const fee = String(Number(BASE_FEE) + Number(sim.restorePreamble.minResourceFee || 0));
      const rtx = new TransactionBuilder(await server.getAccount(me), { fee, networkPassphrase: PASS })
        .setSorobanData(sim.restorePreamble.transactionData.build())
        .addOperation(Operation.restoreFootprint({}))
        .setTimeout(180)
        .build();
      await signAndSend(rtx, `${label} (restore)`);
      tx = await buildCall(t.id, t.method, t.args);
      sim = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) throw new Error(explain(sim.error, errors));
    }
    log(`${label}: waiting for wallet approval…`, "wait");
    padSim(sim);
    if (method === "create_vault") padVaultSlots(sim);
    const res = await signAndSend(rpc.assembleTransaction(tx, sim).build(), label);
    if (method === "create_vault") flushReads(true);
    log(`${label}: done · <a href="${EXPLORER}/tx/${res.hash}" target="_blank" rel="noopener">transaction</a>`, "ok");
    return res;
  } catch (e) {
    const msg = String((e && e.message) || e);
    // The transaction link we generate ourselves is kept; everything else is escaped
    const safe = safeErr(msg);
    const hint = method === "create_vault" && !/reject|declin|cancel|Connect your wallet|busy|Status unknown/i.test(msg) ? " If many people open a vault at the same moment, one attempt can fail. Press the button again." : "";
    log(`${label}: ${safe}${hint}`, "err");
    return null;
  } finally {
    busy = false;
    document.body.classList.remove("busy");
    try {
      await refresh();
    } catch (e) {
      console.warn("refresh after transaction failed", e);
    }
  }
}

// The user's setup state (wallet, network, balance...). Other places read it from here, e.g. setup.testnet.
const setup = {};
function mark(key, done) {
  setup[key] = !!done;
}

// When a number changes, count from the old value to the new one
const shown = {};
function countTo(id, value, digits) {
  const node = $(id);
  if (!node) return;
  const from = shown[id];
  shown[id] = value;
  const put = (v) => (node.textContent = v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  if (from === undefined || from === value || matchMedia("(prefers-reduced-motion: reduce)").matches) return put(value);
  const t0 = performance.now();
  node.classList.add("ticking");
  const frame = (t) => {
    const k = Math.min(1, (t - t0) / 900);
    put(from + (value - from) * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(frame);
    else node.classList.remove("ticking");
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Wallet connection
// ---------------------------------------------------------------------------
// Multi-wallet: with Stellar Wallets Kit installed, xBull, Albedo, Lobstr, Varial and others; otherwise Varial (Freighter) only.
let KIT = false;
let useKit = false;
if (StellarWalletsKit) {
  try {
    StellarWalletsKit.init({ modules: defaultModules(), network: PASS });
    KIT = true;
  } catch (e) {
    console.warn("Wallets kit could not start", e);
  }
}
if (KIT) $("connect").textContent = "Connect wallet";
const CONNECT_IDLE = $("connect").textContent;
const WAS_CONNECTED = "iora-wallet-on"; // this tab had a wallet connected (kept for the tab's lifetime)
let connecting = 0; // connections the user started that have not finished yet

// ---------------------------------------------------------------------------
// Wallet menu: clicking the address button at the top right shows the profile and "Disconnect"
// ---------------------------------------------------------------------------
const DISC_KEY = "iora-disconnected";
let walletName = "";
function setWalletButton() {
  const b = $("connect");
  b.innerHTML = `<span class="wdot" aria-hidden="true"></span>${short(me)}<span class="wcaret" aria-hidden="true">▾</span>`;
  b.disabled = false;
  b.setAttribute("aria-haspopup", "menu");
  b.setAttribute("aria-expanded", "false");
  b.title = "Wallet menu";
}
function walletMenuHtml() {
  const bal = (v, d = 2) => (v === null || v === undefined ? "—" : fmt(v, d));
  return `
    <div class="wm-head">
      <span class="wm-avatar" aria-hidden="true" style="--h:${parseInt(me.slice(1, 7), 36) % 360}"></span>
      <div>
        <b>${walletName ? esc(walletName) : "Stellar wallet"}</b>
        <span class="wm-net ${setup.testnet === false ? "bad" : ""}">${setup.testnet === false ? "Wrong network" : "Testnet"}</span>
      </div>
    </div>
    <button type="button" class="wm-addr" data-wm="copy" title="Copy address"><code>${me.slice(0, 10)}…${me.slice(-10)}</code><span>${COPY_LABEL}</span></button>
    <dl class="wm-bal">
      <div><dt>XLM</dt><dd>${bal(walletNative)}</dd></div>
      <div><dt>USDC</dt><dd>${walletUsdc === null ? "no trustline" : bal(walletUsdc)}</dd></div>
    </dl>
    <nav class="wm-links">
      <a href="${EXPLORER}/account/${me}" target="_blank" rel="noopener">View on Stellar Expert ↗</a>
      <a href="#faucet" data-wm="close">Get test funds</a>
      <a href="#vault" data-wm="close">${oneVault() ? "Buy" : "Buy vault"}</a>
      ${SV.factory ? `<a href="#sell" data-wm="close">${oneVault() ? "Sell" : "Sell vault"}</a>` : ""}
    </nav>
    <button type="button" class="wm-disc" data-wm="disconnect">Disconnect</button>`;
}
function toggleWalletMenu(force) {
  const m = $("wmenu");
  const open = force !== undefined ? force : m.hidden;
  m.hidden = !open;
  $("connect").setAttribute("aria-expanded", String(open));
  if (open) m.innerHTML = walletMenuHtml();
}
document.addEventListener("click", async (e) => {
  const m = $("wmenu");
  if (!m || m.hidden) return;
  const act = e.target.closest && e.target.closest("[data-wm]");
  if (act && act.dataset.wm === "copy") {
    try {
      await navigator.clipboard.writeText(me);
      copied(act.querySelector(":scope > span"));
    } catch {}
    return;
  }
  if (act && act.dataset.wm === "disconnect") return disconnectWallet();
  if (act || !m.contains(e.target)) toggleWalletMenu(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("wmenu") && !$("wmenu").hidden) toggleWalletMenu(false);
});
async function disconnectWallet() {
  // Wallets do not let sites remove the connection on their side; the app forgets the connection
  // and does not reconnect automatically until the user presses "Connect" again.
  try { localStorage.setItem(DISC_KEY, "1"); } catch {}
  try { sessionStorage.removeItem(WAS_CONNECTED); } catch {}
  try {
    if (useKit && StellarWalletsKit.disconnect) await StellarWalletsKit.disconnect();
  } catch {}
  location.hash = "";
  location.reload();
}

// ---------------------------------------------------------------------------
// Wrong network warning: wallets do not let sites change the network (a security rule).
// So a large warning is shown and the page continues by itself the moment the user switches to Testnet.
// ---------------------------------------------------------------------------
let netTimer = null;
let netBlockedAt = 0;
async function currentNetworkOk() {
  try {
    if (useKit) {
      const n = await StellarWalletsKit.getNetwork();
      return { ok: !n || !n.networkPassphrase || n.networkPassphrase === PASS, name: n && n.network ? String(n.network) : "another network" };
    }
    const n = await getNetwork();
    // no answer (the wallet is locked or busy): not known, so neither a warning nor "you are on Testnet now"
    if (!n || n.error || !n.network) return { ok: true, name: "", unknown: true };
    return { ok: n.network === "TESTNET", name: String(n.network) };
  } catch {
    return { ok: true, name: "", unknown: true };
  }
}
function netGuard(ok, name) {
  const box = $("netwarn");
  if (!box) return;
  box.hidden = ok;
  if (ok) {
    clearInterval(netTimer);
    netTimer = null;
    return;
  }
  const nice = /PUBLIC|MAIN/i.test(name) ? "Mainnet" : name || "another network";
  $("netwarn-name").textContent = nice;
  if (netTimer) return;
  netTimer = setInterval(async () => {
    const r = await currentNetworkOk();
    if (!r.ok || r.unknown) return;
    netGuard(true);
    mark("testnet", true);
    log("Wallet switched to Testnet. You're all set.", "ok");
    await refresh();
  }, 2000);
}

const validAddr = (a) => {
  try {
    return typeof a === "string" && StrKey.isValidEd25519PublicKey(a);
  } catch {
    return false;
  }
};

function connected(address, networkOk, name) {
  if (!validAddr(address)) return log("The wallet returned an invalid address.", "err");
  me = address;
  walletName = name || "";
  mark("freighter", true);
  mark("connect", true);
  mark("testnet", networkOk);
  walletName = walletName || "Varial";
  setWalletButton();
  document.body.classList.add("connected");
  window.dispatchEvent(new CustomEvent("iora:wallet", { detail: me }));
  log(`Wallet connected${name ? ` (${esc(name)})` : ""}: ${short(me)}`, "ok");
  try { sessionStorage.setItem(WAS_CONNECTED, "1"); } catch {}
  watchAccount();
  prewarm();
}

async function connect() {
  if (KIT) {
    try {
      const { address } = await StellarWalletsKit.authModal();
      useKit = true;
      let ok = true;
      try {
        const net = await StellarWalletsKit.getNetwork();
        ok = !net || !net.networkPassphrase || net.networkPassphrase === PASS;
        netGuard(ok, net && net.network);
      } catch {}
      let name = "";
      try {
        name = StellarWalletsKit.selectedModule.productName;
      } catch {}
      connected(address, ok, name);
      await refresh();
      if (location.hash === "#lend") loadLend();
    } catch (e) {
      if (!/closed the modal/i.test(String(e && e.message))) log(`Wallet connection failed: ${esc((e && e.message) || e)}`, "err");
    }
    return;
  }
  // The button answers at once: the wallet can take a moment to open its window.
  const btn = $("connect");
  btn.textContent = "Connecting…";
  connecting++;
  try {
    // The wallet's own script is on the page from the start; without it the library waits two seconds for an answer.
    if (!window.freighter) log("Looking for your wallet…", "wait");
    const inst = await isConnected();
    if (inst.error || !inst.isConnected) {
      log('No supported wallet found. The testnet beta works with Varial (formerly Freighter): install it from <a href="https://varialwallet.com" target="_blank" rel="noopener">varialwallet.com</a>, then reload this page. On a phone or tablet there is no wallet extension, so please use a computer (Chrome, Brave or Firefox). LOBSTR and other wallets are not supported during the testnet beta.', "err");
      return;
    }
    log("Approve the connection in your wallet. If no window opened, click the wallet's icon in your browser's toolbar.", "wait");
    const acc = await requestAccess();
    if (me) return void $("status").classList.remove("show"); // connected meanwhile (a second click, or the automatic connection)
    if (acc.error || !acc.address) {
      const why = acc.error && (acc.error.message || (typeof acc.error === "string" ? acc.error : ""));
      log(`The wallet did not connect${why ? `: ${esc(String(why).slice(0, 140))}` : "."} Press Connect to try again.`, "err");
      return;
    }
    if (!validAddr(acc.address)) return log("The wallet returned an invalid address.", "err");
    await adoptWallet(acc.address, false);
  } catch (e) {
    console.warn("connect", e);
    log(`Wallet connection failed: ${esc((e && e.message) || e)}`, "err");
  } finally {
    connecting--;
    if (!me && !connecting) btn.textContent = CONNECT_IDLE;
  }
}

// The wallet shows as connected the moment it gives an address. The network check and the first load of the
// balances follow, so a slow answer from either does not hold the button back.
async function adoptWallet(address, quiet) {
  if (me === address && document.body.classList.contains("connected")) return;
  me = address;
  mark("freighter", true);
  mark("connect", true);
  walletName = walletName || "Varial";
  setWalletButton();
  document.body.classList.add("connected");
  window.dispatchEvent(new CustomEvent("iora:wallet", { detail: me }));
  if (!quiet) log(`Wallet connected: ${short(me)}`, "ok");
  try { sessionStorage.setItem(WAS_CONNECTED, "1"); } catch {}
  watchAccount();
  getNetwork()
    .then((net) => {
      // Only a network the wallet actually names counts as wrong; an empty answer is not a reason to warn.
      if (!net || net.error || !net.network) return;
      mark("testnet", net.network === "TESTNET");
      netGuard(net.network === "TESTNET", net.network);
    })
    .catch(() => {});
  const loaded = firstLoad(); // the vault lookup queues its reads first; the wallet-level reads go right behind them
  prewarm();
  await loaded;
  if (location.hash === "#lend") loadLend();
}
/** The first load after connecting. A network error must not leave the page empty: it is tried again. */
async function firstLoad() {
  for (let i = 0; i < 3; i++) {
    try {
      await refresh();
      if (i > 0) log("Your balances are loaded.", "ok");
      return;
    } catch (e) {
      console.warn("first load failed", e);
      if (i === 0) log("Your wallet is connected. Loading your balances is taking longer than usual…", "wait");
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  log("Your wallet is connected, but the network did not answer. Check your connection and reload the page.", "err");
}
/**
 * The connected address, without opening a wallet window. The wallet library gives up after two seconds and returns
 * an empty address when the extension's background was asleep; a real "not connected" answer comes back at once.
 * Only the first case is worth asking again (by then the extension is awake).
 */
async function quietAddress() {
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    const a = await getAddress();
    if (!a.error && validAddr(a.address)) return a.address;
    if (a.error || performance.now() - t < 1800) return null;
  }
  return null;
}

// The first screen needs these whichever vault the wallet turns out to use. They are asked the moment the wallet
// is known, at the same time as the vault lookup; when the screen code asks for them a moment later it gets the
// same answers without waiting again (rpc.js shares reads).
function prewarm() {
  const warm = (p) => Promise.resolve(p).catch(() => {});
  try {
    warm(server.accountExists(me));
    warm(read(C.xlm, "balance", [addr(me)]));
    warm(read(C.usdc, "balance", [addr(me)]));
    if (XB) warm(read(BASE.addr, "balance", [addr(me)]));
    warm(read(C.router, "router_get_amounts_out", [i128(U), addrVec([C.usdc, BASE.addr])]));
    warm(aquaBest(C.usdc, BASE.addr, U));
    if (location.hash === "#sell" || location.hash === "#portfolio") warmSell();
  } catch (e) {
    console.warn("prewarm", e);
  }
}
const quietly = (p) => Promise.resolve(p).catch(() => {});
/** What the sell side opens with. Asked here, read in refreshSell: the same questions, shared by rpc.js. */
function warmSell() {
  if (!me || !SV.factory) return;
  try {
    quietly(readXlmPool());
    quietly(read(C.router, "router_get_amounts_out", [i128(U), addrVec([BASE.addr, SV.out.addr])]));
    quietly(aquaBest(BASE.addr, SV.out.addr, U));
    quietly(
      read(SV.factory, "vault_of", [addr(me)]).then((vo) => {
        if (!vo.ok || !vo.value) return;
        const sv = wrapSell(vo.value);
        for (const m of ["balance", "reserved", "free_balance", "stats"]) quietly(read(sv, m));
        quietly(readOrders(sv));
      }),
    );
  } catch (e) {
    console.warn("warm", e);
  }
}
/** What the Portfolio opens with (see renderPortfolio). */
function warmPortfolio() {
  if (!me) return;
  try {
    warmSell();
    quietly(
      homeSellVault().then((sv) => {
        for (const v of [vault, sv]) {
          if (!v) continue;
          for (const m of ["balance", "reserved", "free_balance", "stats"]) quietly(read(v, m));
          quietly(readOrders(v));
        }
        const rv = sideOf(vault) || sideOf(sv);
        if (rv && PAIRS.length) quietly(rawRead(rv.id, "positions"));
      }),
    );
  } catch (e) {
    console.warn("warm", e);
  }
}
// The pointer (or a finger, or the keyboard focus) arrives on a link a moment before the click. The page behind
// the link is asked for at that moment; at most once in a few seconds, and never while a transaction is open.
let warmedAt = 0;
function onIntent(e) {
  const a = e.target && e.target.closest ? e.target.closest('a[href="#sell"], a[href="#portfolio"], a[href="#markets"]') : null;
  if (!a || busy || Date.now() - warmedAt < 3000) return;
  const to = a.getAttribute("href").slice(1);
  if (to === document.body.dataset.view) return; // that page is open: it keeps itself up to date
  if (to !== "markets" && !me) return;
  warmedAt = Date.now();
  if (to === "sell") warmSell();
  else if (to === "portfolio") warmPortfolio();
  else paintPrices(true);
}
for (const type of ["pointerover", "touchstart", "focusin"]) document.addEventListener(type, onIntent, { passive: true });

// A button that needs a wallet opens the wallet list itself instead of only saying so
async function needWallet() {
  if (me) return true;
  try { localStorage.removeItem(DISC_KEY); } catch {}
  await connect();
  return !!me;
}

async function tryAutoConnect() {
  // If the user pressed "Disconnect", do not reconnect automatically until they connect again themselves
  try { if (localStorage.getItem(DISC_KEY)) return; } catch {}
  // A tab that was connected before the reload says so on the button while the wallet is asked again
  let before = false;
  try { before = !!sessionStorage.getItem(WAS_CONNECTED); } catch {}
  if (before && !me) $("connect").textContent = "Connecting…";
  try {
    await autoConnect();
  } finally {
    if (!me && !connecting) $("connect").textContent = CONNECT_IDLE;
  }
}
async function autoConnect() {
  // A wallet chosen in the wallet list (xBull, LOBSTR, Albedo…) is remembered by the kit; pick it up again after a reload
  if (KIT) {
    try {
      const { address } = await StellarWalletsKit.getAddress();
      if (validAddr(address)) {
        useKit = true;
        let ok = true;
        try {
          const net = await StellarWalletsKit.getNetwork();
          ok = !net || !net.networkPassphrase || net.networkPassphrase === PASS;
          netGuard(ok, net && net.network);
        } catch {}
        let name = "";
        try { name = StellarWalletsKit.selectedModule.productName; } catch {}
        connected(address, ok, name);
        await refresh();
        if (location.hash === "#lend") loadLend();
        return;
      }
    } catch {}
  }
  let inst = await isConnected();
  if (inst.error || !inst.isConnected) {
    // The wallet's script can reach the page a moment after it opens: look once more before giving up.
    await new Promise((r) => setTimeout(r, 1500));
    if (me) return;
    inst = await isConnected();
  }
  mark("freighter", !inst.error && inst.isConnected);
  if (inst.error || !inst.isConnected) return;
  const address = await quietAddress();
  if (address && !me) await adoptWallet(address, true);
}

// If the user switches to another account in the wallet the page must not stay on the old one (the signature would be requested from a different key).
let accountTimer = null;
function watchAccount() {
  if (accountTimer || useKit) return;
  accountTimer = setInterval(async () => {
    if (!me || busy) return;
    try {
      const a = await getAddress();
      if (!a.error && validAddr(a.address) && a.address !== me) {
        clearInterval(accountTimer);
        log("Your wallet switched to another account. Reloading for that account…");
        setTimeout(() => location.reload(), 1200);
      }
    } catch {}
  }, 5000);
}

// ---------------------------------------------------------------------------
// Screen refresh
// ---------------------------------------------------------------------------
let marketPrice = null; // how many USDC for 1 XLM
const LADDER = { on: false, n: 5, dist: "flat" }; // scaled buy: number of orders and how the amount is spread
let freeUnits = null; // USDC available in the vault (7 decimals)
let reservedUnits = null;
let balanceUnits = null;
let openOrders = [];
const orderTimes = {}; // order id -> { placed, ended } (seconds)
let waitEarned = 0; // estimated interest the orders earned while waiting
let supplyApr = null; // estimated yearly interest on USDC in the Blend pool (0.05 = 5%)
let walletUsdc = null; // USDC in the wallet
let walletXlm = null; // the traded coin in the wallet (XLM for the XLM pair)
let walletNative = null; // XLM in the wallet (network fees)

// turns a 7-decimal integer into plain text (for inputs, no thousands separator)
// With open orders the contract keeps a rounding margin of 100 units (0.00001) out of the free balance. If the
// first order reserves the whole balance, the next one (e.g. the last step of a scaled order) falls short by that
// much and is rejected; so "Max" for an order and scaled orders leave the margin from the start.
const ROUNDING_BUFFER = 10_000n;
function orderRoom(free, reservedNone) {
  if (free === null) return null;
  return reservedNone && free > ROUNDING_BUFFER ? free - ROUNDING_BUFFER : free;
}
const buyRoom = () => orderRoom(freeUnits, reservedUnits === 0n);
const sellRoom = () => orderRoom(SV.free, SV.bal !== null && SV.free === SV.bal);
/** If the amount is above the usable room by at most the margin (entered with Max) it is lowered to the room. */
const fitRoom = (amount, free, room) => (room !== null && free !== null && amount > room && amount <= free ? room : amount);

function toPlain(units) {
  const neg = units < 0n;
  const v = neg ? -units : units;
  const frac = String(v % U).padStart(7, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${v / U}${frac ? "." + frac : ""}`;
}

function updateTicket() {
  try {
    renderLadderPreview();
  } catch {}
  const amount = Number(String($("oamount").value).trim().replace(",", "."));
  const limit = Number(String($("olimit").value).trim().replace(",", "."));
  let out = amount > 0 && limit > 0 ? amount / limit : 0;
  const scale = LADDER.on ? buyScale() : null;
  if (LADDER.on) out = scale ? scale.reduce((a, l) => a + Number(l.amt) / Number(l.lim), 0) : 0;
  $("receive").textContent = out ? out.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "0";
  if (document.activeElement !== $("oqty")) $("oqty").value = out ? String(Number(out.toFixed(XB && out < 1 ? 7 : 2))) : "";
  ticketExtras();
  // Order summary: what will happen, in plain language
  const box = $("preview");
  if (LADDER.on) {
    box.hidden = !scale;
    if (!scale) return;
    const n = nfmt;
    const hi = Number(scale[0].lim) / 1e7, lo = Number(scale[scale.length - 1].lim) / 1e7;
    const items = [
      `Your <b>${n(amount)} USDC</b> is split into <b>${scale.length} limit orders</b>, evenly spaced from <b>${n(hi, 4)}</b> down to <b>${n(lo, 4)} USDC</b>.`,
      `Each order fills by itself when the price reaches it. If all of them fill you receive at least <b>${n(out)} ${BS}</b>, an average price of ${n(amount / out, 4)} USDC or better.`,
      supplyApr !== null
        ? `Whatever has not filled yet stays on Blend and keeps earning, about ${n((amount * supplyApr) / 365, 4)} USDC a day at the start.`
        : `Whatever has not filled yet stays on Blend and keeps earning.`,
      `Each order is placed with its own signature: <b>${scale.length} signatures</b>, about 0.02 XLM network fee each. Iora takes no fee.`,
    ];
    if (AUTO.px && !$("autosell-row").hidden) {
      const tp = Number(AUTO.px) / 1e7;
      items.push(
        tp > hi
          ? `Take profit: as each order fills, its ${BS} ${sideOf(vault) ? "stays in your vault" : "goes to your sell vault"} and a sell order opens at <b>${n(tp, 4)} USDC</b>.`
          : `<span class="bad">The take profit price must be above your highest buy price of ${n(hi, 4)} USDC.</span>`,
      );
    }
    if (marketPrice && hi >= marketPrice) items.splice(1, 0, `<span class="bad">${WORSE_BUY((hi / marketPrice - 1) * 100).replace("Your limit", "Your highest price")}</span>`);
    if (freeUnits !== null && amount > Number(freeUnits) / 1e7) items.unshift(`<span class="bad">This is more than your available ${fmt(freeUnits, 2)} USDC. Deposit more or lower the amount.</span>`);
    $("preview-list").innerHTML = items.map((t) => `<li>${t}</li>`).join("");
    return;
  }
  if (!(amount > 0 && limit > 0)) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const n = nfmt;
  const items = [];
  if (supplyApr !== null) {
    items.push(`Your <b>${n(amount)} USDC</b> stays on Blend and keeps earning, about <b>${n((amount * supplyApr) / 365, 4)} USDC a day</b> at today's estimated ${n(supplyApr * 100, 1)}% rate. Over 30 days that is about <b>${n((amount * supplyApr * 30) / 365, 4)} USDC</b>.`);
  } else {
    items.push(`Your <b>${n(amount)} USDC</b> stays on Blend and keeps earning interest while the order waits.`);
  }
  const drop = marketPrice ? (1 - limit / marketPrice) * 100 : null;
  items.push(
    drop !== null && drop <= 0
      ? `<span class="bad">${WORSE_BUY(-drop)}</span>`
      : `When ${BS} is at <b>${n(limit, 4)} USDC or less</b>${drop !== null ? ` (${n(drop, 1)}% below today)` : ""}, the keeper fills it and at least <b>${n(out)} ${BS}</b> ${outTo(vault)}.`,
  );
  items.push(`The order stays open until it fills or you cancel it. Until then the USDC keeps earning.`);
  if (feeNote(vault, BS)) items.push(feeNote(vault, BS));
  items.push(`Placing it costs a network fee of about <b>0.02 XLM</b>. Iora takes no fee.`);
  if (AUTO.px && !$("autosell-row").hidden) {
    const tp = Number(AUTO.px) / 1e7;
    items.push(
      tp > limit
        ? `Take profit: the ${BS} ${sideOf(vault) ? "stays in your vault" : "goes straight to your sell vault"} and a sell order opens at <b>${n(tp, 4)} USDC</b> (+${n((tp / limit - 1) * 100, 1)}%).${XB ? "" : " It keeps earning on Blend until it sells."}`
        : `<span class="bad">The take profit price must be above your buy price of ${n(limit, 4)} USDC.</span>`,
    );
  }
  if (freeUnits !== null && amount > Number(freeUnits) / 1e7) items.unshift(`<span class="bad">This is more than your available ${fmt(freeUnits, 2)} USDC. Deposit more or lower the amount.</span>`);
  $("preview-list").innerHTML = items.map((t) => `<li>${t}</li>`).join("");
}

// Tooltip
function tip(text) {
  return `<i class="tip" tabindex="0" data-tip="${text.replace(/"/g, "&quot;")}">i</i>`;
}

// Where the money is: available / in orders, and a plain-language summary
function renderAlloc() {
  const box = $("alloc");
  if (balanceUnits === null || freeUnits === null || reservedUnits === null || balanceUnits <= 0n) {
    box.hidden = true;
    $("plain").hidden = true;
    return;
  }
  const total = Number(balanceUnits);
  const fr = (Number(freeUnits) / total) * 100;
  const rs = (Number(reservedUnits) / total) * 100;
  box.hidden = false;
  box.innerHTML = `
    <div class="alloc-bar" role="img" aria-label="Available ${fr.toFixed(0)} percent, reserved for orders ${rs.toFixed(0)} percent">
      <span class="a-free" style="width:${fr}%"></span><span class="a-res" style="width:${rs}%"></span>
    </div>
    <div class="alloc-legend">
      <span><i class="sw a-free"></i>Available ${fmt(freeUnits, 2)} USDC (${fr.toFixed(0)}%)</span>
      <span><i class="sw a-res"></i>In open orders ${fmt(reservedUnits, 2)} USDC (${rs.toFixed(0)}%)</span>
      <span class="muted">Both parts earn interest on Blend</span>
    </div>`;
  const k = openOrders.length;
  const p = $("plain");
  p.hidden = false;
  p.innerHTML =
    `You have <b>${fmt(balanceUnits, 2)} USDC</b> earning on Blend. ` +
    (k
      ? `<b>${fmt(reservedUnits, 2)} USDC</b> of it is waiting in ${k === 1 ? "one open order" : k + " open orders"} to buy ${BS}${k === 1 ? ` at ${openOrders[0].limit.toFixed(4)} or less` : ""}. `
      : `No orders are open, so all of it is free. `) +
    `<b>${fmt(freeUnits, 2)} USDC</b> is available to withdraw or use for a new order.` +
    (waitEarned > 0 ? ` While waiting for their price, your orders have earned about <b>${waitEarned.toLocaleString("en-US", { maximumFractionDigits: 4 })} USDC</b> so far.` : "");
}

// Where the open orders sit on the price scale
function renderLadder() {
  const el = $("ladder");
  if (!openOrders.length || !marketPrice) {
    el.innerHTML = `<p class="empty">${openOrders.length ? "Waiting for the market price…" : "No open orders. Each order you place appears here as a marker below the market price."}</p>`;
    return;
  }
  const prices = [marketPrice, ...openOrders.map((o) => o.limit)];
  const lo = Math.min(...prices) * 0.9;
  const hi = Math.max(...prices) * 1.06;
  const pos = (v) => ((v - lo) / (hi - lo)) * 100;
  const rows = openOrders
    .slice()
    .sort((a, b) => b.limit - a.limit)
    .map((o) => {
      const d = (1 - o.limit / marketPrice) * 100;
      return `<div class="lrow">
        <span class="lname">#${o.id}</span>
        <div class="ltrack"><span class="lfill" style="left:${pos(o.limit)}%;width:${Math.max(0, pos(marketPrice) - pos(o.limit))}%"></span><span class="lmark" style="left:${pos(o.limit)}%"></span></div>
        <span class="linfo"><b>${o.limit.toFixed(4)}</b> ${d > 0 ? `${d.toFixed(1)}% below` : "at or above market"}<small>${o.left.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC waiting</small></span>
      </div>`;
    })
    .join("");
  el.innerHTML = `<div class="lscale"><span class="lmarket${pos(marketPrice) > 65 ? " flip" : ""}" style="--p:${(pos(marketPrice) / 100).toFixed(4)}"><em>Market ${marketPrice.toFixed(4)}</em></span>${rows}</div>
    <p class="fine">The shaded part is how far the price still has to fall. Orders fill from the top down as the price drops.</p>`;
}

// Blend pool: utilisation and estimated interest (Blend's interest model)
async function readPool() {
  try {
    const [r, pc] = await Promise.all([read(C.pool, "get_reserve", [addr(C.usdc)]), read(C.pool, "get_config")]);
    if (!r.ok) return;
    const cfg = r.value.config, d = r.value.data;
    const n7 = (v) => Number(BigInt(v)) / 1e7;
    const supplied = (Number(BigInt(d.b_supply)) * Number(BigInt(d.b_rate))) / 1e12 / 1e7;
    const borrowed = (Number(BigInt(d.d_supply)) * Number(BigInt(d.d_rate))) / 1e12 / 1e7;
    const u = supplied > 0 ? borrowed / supplied : 0;
    $("m-util").textContent = `${(u * 100).toFixed(1)}%`;
    $("m-util-bar").style.width = `${Math.min(100, u * 100)}%`;
    $("m-size").textContent = `of ${supplied.toLocaleString("en-US", { maximumFractionDigits: 0 })} USDC is borrowed`;
    let rm = Number(BigInt(d.ir_mod)) / 1e7;
    if (!(rm > 0.05 && rm < 20)) rm = Number(BigInt(d.ir_mod)) / 1e9;
    if (!(rm > 0.05 && rm < 20)) rm = 1;
    const ut = n7(cfg.util), rb = n7(cfg.r_base), r1 = n7(cfg.r_one), r2 = n7(cfg.r_two), r3 = n7(cfg.r_three);
    let ir;
    if (u <= ut) ir = rm * (rb + (u / ut) * r1);
    else if (u <= 0.95) ir = rm * (rb + r1 + ((u - ut) / (0.95 - ut)) * r2);
    else ir = rm * (rb + r1 + r2) + ((u - 0.95) / 0.05) * r3;
    const take = pc.ok && pc.value && pc.value.bstop_rate !== undefined ? n7(pc.value.bstop_rate) : 0;
    const apr = ir * u * (1 - take);
    const hadApr = supplyApr !== null;
    supplyApr = apr >= 0 && apr < 3 ? apr : null;
    if (!hadApr && supplyApr !== null && vault) renderOrders();
    $("m-apr").textContent = supplyApr !== null ? `${(supplyApr * 100).toFixed(2)}%` : "—";
    updateTicket();
  } catch (e) {
    console.warn("pool read failed", e);
  }
}

// Refreshes the wallet/buy vault screen; and the sell page too if it is open (the wallet balance comes from here).
// ---- Generations: the user stays in the vault where their funds are ----
// When a new factory is deployed the old vaults keep working. Nobody can move the funds for the user (only the
// owner can withdraw from a vault), so instead of forcing a move the app uses the generation where the user's
// funds are: factory pairs with the same call signatures are listed in VITE_GENERATIONS (buy:sell,
// newest first). A user with funds in no generation starts in the newest one.
const GEN_LATEST = { buy: C.factory, sell: SV.factory };
// VITE_STAY_NEWEST (default on): the app always uses the newest factory. Earlier vaults run on retired test coins
// (Blend's old test USDC), so they are shown only in the Portfolio's "earlier vault" note, from which the user
// withdraws or moves. VITE_STAY_NEWEST=0 brings back "use the generation where the funds are".
const STAY_NEWEST = stayNewest(import.meta.env.VITE_STAY_NEWEST);
let allowedNow = null; // { at, set }: the newest factory's allowed tokens
/** The tokens the newest factory allows (Set of addresses), or null if it could not be read. */
async function newestAllowed() {
  if (allowedNow && Date.now() - allowedNow.at < 300_000) return allowedNow.set;
  const r = await read(GEN_LATEST.buy, "allowed_tokens");
  if (!r.ok || !Array.isArray(r.value)) return null;
  allowedNow = { at: Date.now(), set: new Set(r.value.map(String)) };
  return allowedNow.set;
}

// ---- Blend's old test USDC -> Circle's test USDC, 1:1, when an earlier vault is moved ----
// The wallet pays its old test USDC back to that token's issuer (which burns it), then api/convert.js checks the
// burn and sends the same amount of Circle's test USDC. A burn that was not exchanged yet is kept in this browser
// (iora-convert-pending), so the exchange can be finished later from the Portfolio page.
const OLD_USDC_ISSUER = "GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56";
const EXCHANGE = () => ({ [OLD_BLEND_USDC]: C.usdc });
const CONVERT_KEY = "iora-convert-pending";
const convLoad = () => {
  try {
    const a = JSON.parse(localStorage.getItem(CONVERT_KEY) || "[]");
    return Array.isArray(a) ? a.filter((p) => p && /^[0-9a-f]{64}$/.test(p.hash) && typeof p.wallet === "string") : [];
  } catch {
    return [];
  }
};
const convSave = (list) => {
  try {
    localStorage.setItem(CONVERT_KEY, JSON.stringify(list));
  } catch {}
};
const convDrop = (hash) => convSave(convLoad().filter((p) => p.hash !== hash));
const CONVERT_ERRORS = {
  no_access: "the exchange is part of the beta: open the app with your invite code or an allowed wallet",
  no_trustline: "your wallet has no USDC trustline for Circle's USDC",
  wallet_cap: "this wallet reached the exchange limit",
  faucet_low: "Iora's exchange account is out of Circle USDC right now; try again later",
  tx_not_yours: "the burn was not sent from this wallet",
  tx_failed: "the burn transaction failed, so nothing was burned",
  tx_too_old: "the burn is older than one hour",
  no_burn: "that transaction does not return old test USDC to its issuer",
  not_configured: "the exchange is not set up yet",
  not_testnet: "the exchange only runs on testnet",
};
/** The wallet must hold Circle's USDC: adds the trustline if it is missing. */
async function ensureUsdcTrust() {
  flushReads();
  const b = await read(C.usdc, "balance", [addr(me)]);
  if (b.ok) return true;
  try {
    const account = await server.getAccount(me);
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASS })
      .addOperation(Operation.changeTrust({ asset: new Asset("USDC", C.usdcIssuer) }))
      .setTimeout(180)
      .build();
    log("USDC trustline (Circle's USDC): waiting for wallet approval…", "wait");
    await signAndSend(tx, "USDC trustline");
    log("USDC trustline added.", "ok");
    flushReads();
    return true;
  } catch (e) {
    log(`USDC trustline: ${safeErr(String((e && e.message) || e))}`, "err");
    return false;
  }
}
/** Asks api/convert.js to exchange a burn; retries while Horizon catches up or a payment is being settled. */
async function convertCall(hash) {
  let token = null;
  try {
    token = localStorage.getItem("iora-access");
  } catch {}
  let last = "network";
  for (let i = 0; i < 8; i++) {
    let j = {};
    try {
      const r = await fetch("/api/convert", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: me, hash, token }), cache: "no-store" });
      j = await r.json().catch(() => ({}));
    } catch {
      j = { error: "network" };
    }
    if (j.ok && /^[0-9a-f]{64}$/.test(String(j.hash))) return { ok: true, hash: j.hash, amount: toUnits(String(j.amount)) };
    last = j.error || "network";
    if (!["tx_not_found", "in_progress", "store_busy", "network", "send_failed", "send_unknown"].includes(last)) break;
    const wait = last === "in_progress" || last === "send_unknown" ? 30_000 : 4_000;
    log(`Exchanging your old test USDC: ${last === "tx_not_found" ? "waiting for the network to show the burn" : "still working"}…`, "wait");
    await new Promise((r) => setTimeout(r, wait));
  }
  return { ok: false, error: last };
}
/**
 * Exchanges `amount` (in the wallet) of Blend's old test USDC for Circle's test USDC: trustline if needed, burn
 * (signed by the user), then api/convert.js. Returns the Circle USDC received, or null; says where it stopped.
 */
async function exchangeOldUsdc(amount) {
  if (amount <= 0n) return 0n;
  if (!(await ensureUsdcTrust())) {
    log(`Stopped: your ${fmt(amount, 2)} old test USDC (Blend) is in your wallet, not exchanged yet. Add the USDC trustline on the Test funds page, then move again.`, "err");
    return null;
  }
  const account = await server.getAccount(me);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASS })
    .addOperation(Operation.payment({ destination: OLD_USDC_ISSUER, asset: new Asset("USDC", OLD_USDC_ISSUER), amount: toPlain(amount) }))
    .addMemo(Memo.text("Iora: old USDC to Circle"))
    .setTimeout(180)
    .build();
  // tx.hash() is a Uint8Array in the browser build (its toString ignores "hex"), so the hex is made by hand
  const hash = [...tx.hash()].map((b) => b.toString(16).padStart(2, "0")).join("");
  // Kept before signing: if the answer is lost after the burn, the exchange can still be finished.
  convSave([...convLoad().filter((p) => p.hash !== hash), { hash, amount: String(amount), wallet: me, at: Date.now(), burned: false }]);
  try {
    log("Return your old test USDC (Blend) to its issuer: waiting for wallet approval…", "wait");
    await signAndSend(tx, "Return old test USDC");
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/Status unknown/i.test(msg)) {
      log(`The return of your old test USDC is not confirmed yet (${safeErr(msg)}). When it is, finish the exchange from the Portfolio page.`, "err");
    } else {
      convDrop(hash);
      log(`Stopped: your ${fmt(amount, 2)} old test USDC (Blend) is in your wallet, not exchanged (${safeErr(msg)}). You can move again later.`, "err");
    }
    return null;
  }
  convSave(convLoad().map((p) => (p.hash === hash ? { ...p, burned: true } : p)));
  return finishExchange(hash, amount);
}
/** The api/convert.js step for a burn; on success the pending entry is removed. */
async function finishExchange(hash, amount) {
  const r = await convertCall(hash);
  finishExchange.lastError = r.ok ? null : r.error;
  if (!r.ok) {
    log(`Your ${fmt(amount, 2)} old test USDC was returned to its issuer, but the exchange for Circle's USDC did not finish (${esc(CONVERT_ERRORS[r.error] || r.error)}). Nothing is lost: press "Finish the exchange" on the Portfolio page to try again.`, "err");
    return null;
  }
  convDrop(hash);
  flushReads();
  log(`Exchanged ${fmt(r.amount, 2)} old test USDC (Blend) for ${fmt(r.amount, 2)} USDC (Circle) · <a href="${EXPLORER}/tx/${r.hash}" target="_blank" rel="noopener">transaction</a>`, "ok");
  return r.amount;
}
/** Portfolio: a burn that was not exchanged yet can be finished here. */
function convNote() {
  const host = $("pfolio");
  if (!host) return;
  const list = me ? convLoad().filter((p) => p.wallet === me) : [];
  let el = document.getElementById("pf-conv-note");
  if (!list.length) return void (el && el.remove());
  if (!el) {
    el = document.createElement("div");
    el.id = "pf-conv-note";
    el.className = "pf-movenote";
    host.before(el);
  }
  const sum = list.reduce((a, p) => a + BigInt(p.amount || 0), 0n);
  el.innerHTML = `<span><b>${fmt(sum, 2)} old test USDC</b> returned to its issuer and not yet exchanged for Circle's USDC.</span><button type="button" class="link" data-go>Finish the exchange</button>`;
  el.querySelector("[data-go]").onclick = async (e) => {
    e.target.disabled = true;
    for (const p of list) {
      const got = await finishExchange(p.hash, BigInt(p.amount || 0));
      // A return that never reached the network burned nothing: the coin is still in the wallet.
      if (got === null && !p.burned && Date.now() - p.at > 10 * 60_000 && finishExchange.lastError === "tx_not_found") {
        convDrop(p.hash);
        log("That return never reached the network, so nothing was burned: your old test USDC is still in your wallet. Move again from the Portfolio page.", "err");
      }
    }
    convNote();
    refresh().catch(() => {});
  };
}
/** In version 7 the vault address read from the factory is turned into a handle for its side (older generations keep the plain address). */
// Single-vault factory: the newest factory, or one in the generations list whose buy and sell address are the SAME
// (if version 7 was deployed more than once, the earlier ones are single-vault too and are spoken to the same way).
const isV7Factory = (f) => V7 && !!f && (f === GEN_LATEST.buy || GENERATIONS.some((g) => g.buy === f && g.sell === f));
const wrapBuy = (a, f = C.factory) => (!a ? null : isV7Factory(f) ? H(String(a), C.usdc, BASE.addr) : String(a));
const wrapSell = (a, f = SV.factory) => (!a ? null : isV7Factory(f) ? H(String(a), BASE.addr, C.usdc) : String(a));
const GENERATIONS = [
  GEN_LATEST,
  ...String(import.meta.env.VITE_GENERATIONS || "")
    .split(",")
    .map((p) => {
      const [buy, sell] = p.trim().split(":");
      return buy && buy !== GEN_LATEST.buy ? { buy, sell: sell || "" } : null;
    })
    .filter(Boolean),
];
let GEN = GEN_LATEST;
let genFor = null;
/** Index of the first promise that gives true, known once every promise before it has given false (-1: none). */
function firstTrue(list) {
  return new Promise((resolve, reject) => {
    const state = list.map(() => null);
    let done = false;
    const check = () => {
      if (done) return;
      for (let i = 0; i < state.length; i++) {
        if (state[i] === null) return;
        if (state[i]) return void ((done = true), resolve(i));
      }
      done = true;
      resolve(-1);
    };
    list.forEach((p, i) =>
      p.then(
        (v) => {
          state[i] = !!v;
          check();
        },
        (e) => {
          if (!done) ((done = true), reject(e));
        },
      ),
    );
    check();
  });
}
async function pickGeneration() {
  if (!me || genFor === me) return;
  const who = me;
  let pick = GEN_LATEST;
  if (GENERATIONS.length > 1 && !STAY_NEWEST) {
    try {
      // The newest generation with funds wins, so the answer is known as soon as every newer generation has said
      // "nothing here": the older ones are not waited for (firstTrue).
      let warmed = Infinity; // index of the newest generation whose vault was read ahead
      const i = await firstTrue(
        GENERATIONS.map(async (g, gi) => {
          const facs = [g.buy, g.sell].filter(Boolean);
          const vs = await Promise.all(facs.map((f) => read(f, "vault_of", [addr(who)])));
          for (const [k, r] of vs.entries()) {
            if (!(r.ok && r.value)) continue;
            const v = k === 0 && facs[0] === g.buy ? wrapBuy(r.value, g.buy) : wrapSell(r.value, g.sell);
            // The screen asks for these right after this lookup; asked now, the answers are already there by then.
            // Only for the newest generation known to have a vault (the one the screen will most likely use), so a
            // wallet with vaults in several generations does not pay for reads nobody looks at.
            if (k === 0 && facs[0] === g.buy && gi < warmed) {
              warmed = gi;
              for (const m of ["reserved", "free_balance", "stats"]) read(v, m).catch(() => {});
              vaultVersion(v).catch(() => {});
              if (location.hash === "#portfolio" && sideOf(v) && PAIRS.length) rawRead(sideOf(v).id, "positions").catch(() => {});
            }
            // A balance settles it at once. The open orders decide only for an empty vault (they are read either
            // way: the order list needs them a moment later).
            const orders = openOrdersIn(v);
            orders.catch(() => {});
            const bal = await read(v, "balance");
            if (bal.ok && BigInt(bal.value) >= LEGACY_DUST) return true;
            if ((await orders).length) return true;
          }
          return false;
        }),
      );
      if (i > 0) pick = GENERATIONS[i];
    } catch (e) {
      console.warn("generation lookup failed", e);
      return; // if it could not be read the default stays for this round and it is tried again on the next refresh
    }
  }
  if (who !== me) return;
  genFor = who;
  // A user whose funds are in an old (two-vault) generation can only trade XLM / USDC
  if (XB && !isV7Factory(pick.buy)) return setBase("XLM");
  if (pick === GEN) return;
  const onHome = SV.factory === SV.home;
  GEN = pick;
  C.factory = pick.buy;
  SV.home = pick.sell;
  if (onHome) SV.factory = pick.sell;
}

// Version 7: the "open a sell vault" box describes the single vault (the same vault is used on the buy side too).
if (V7) {
  const box = $("sv-none");
  const h = box && box.querySelector("h2");
  const p = box && box.querySelector("p");
  if (h) h.textContent = "Open your vault";
  if (p) p.textContent = `One vault holds both your USDC and your ${BS}. Open it once, deposit ${BS}, and place sell orders. Only your wallet controls it.`;
  const btn = $("sv-create");
  if (btn) btn.textContent = "Open my vault";
}
// Version 7 has no "buy vault" and "sell vault": there is one vault. The app's texts were written for two vaults
// and are spread over dozens of places; instead of adding conditions one by one, while a single vault is in use
// every text put on screen has "buy vault / sell vault" turned into "vault" (texts added later included).
const ONE_VAULT_RE = /\b(?:sell|buy) vault/i;
const oneVaultFix = (t) => t.replace(/\b(?:sell|buy) vault(s?)\b/g, "vault$1").replace(/\b(?:Sell|Buy) vault(s?)\b/g, "Vault$1");
function oneVaultText(root) {
  if (root.nodeType === 3) {
    if (ONE_VAULT_RE.test(root.nodeValue)) root.nodeValue = oneVaultFix(root.nodeValue);
    return;
  }
  if (root.nodeType !== 1) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (ONE_VAULT_RE.test(n.nodeValue)) n.nodeValue = oneVaultFix(n.nodeValue);
  }
  for (const el of [root, ...root.querySelectorAll("[data-tip],[title],[aria-label]")]) {
    for (const a of ["data-tip", "title", "aria-label"]) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v && ONE_VAULT_RE.test(v)) el.setAttribute(a, oneVaultFix(v));
    }
  }
}
/** Is the user in a single-vault factory? (If their funds are in an old two-vault generation the texts do not change.) */
const oneVault = () => V7 && isV7Factory(C.factory);
if (V7) {
  new MutationObserver((muts) => {
    if (!oneVault()) return;
    for (const m of muts) {
      if (m.type === "characterData") oneVaultText(m.target);
      else for (const n of m.addedNodes) oneVaultText(n);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true });
  if (oneVault()) oneVaultText(document.body);
}

// A coin other than XLM is selected: the fixed texts on the page are written for that coin and the Blend boxes are hidden.
if (XB) {
  document.body.classList.add("xbase");
  const fix = (t) =>
    t
      .replace(/Moves XLM from your wallet to Blend through your sell vault\. It starts earning right away\. Keep at least 5 XLM in your wallet for network fees\./, `Moves ${BS} from your wallet into your vault. ${BS} earns no interest there.`)
      .replace(", interest included", "")
      .replace(" and earns interest on Blend", "")
      .replace(" It keeps earning on Blend until it sells.", "")
      .replace("Deposit XLM, it earns interest on Blend, and it is sold", "Deposit XLM and it is sold")
      .replace(/\bXLM\b/g, BS);
  const skip = /test XLM/;
  for (const root of document.querySelectorAll('[data-view-pane="vault"], [data-view-pane="sell"], #mkt, #tstage')) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = w.nextNode(); t; t = w.nextNode()) if (t.nodeValue.includes("XLM") && !skip.test(t.nodeValue)) t.nodeValue = fix(t.nodeValue);
    for (const el of root.querySelectorAll("[data-tip],[title],[aria-label]")) {
      for (const a of ["data-tip", "title", "aria-label"]) {
        const v = el.getAttribute(a);
        if (v && v.includes("XLM")) el.setAttribute(a, fix(v));
      }
    }
    for (const c of root.querySelectorAll("i.coin.xlm")) paintCoin(c, BS);
  }
  const leave = $("sv-leave-note");
  if (leave) leave.textContent = `The keeper sells automatically when your price is met. If it is offline, orders wait. ${LEAVE_NOTE}`;
  // A stop loss looks at the Blend oracle; these coins have no oracle price
  const sl = document.querySelector('#sv-type [data-type="sl"]');
  if (sl) sl.hidden = true;
  for (const el of document.querySelectorAll('[data-view-pane="sell"] .tb-stat, [data-view-pane="sell"] .tb-earn')) {
    if (el.querySelector("#sv-util, #sv-apr")) el.hidden = true;
  }
  const warn = $("sv-warn");
  if (warn) {
    warn.innerHTML = `<b>${esc(BS)} earns no interest.</b> It is not in the Blend pool, so ${esc(BS)} waits in your vault as it is; your USDC still earns while buy orders wait. This test pool is small and its price is not a real market price, so keep orders to a few USDC.`;
    warn.hidden = false;
    const bar = document.querySelector('[data-view-pane="vault"] .pairsel');
    const sec = bar && bar.closest("section");
    if (sec) {
      const c = warn.cloneNode(true);
      c.removeAttribute("id");
      sec.after(c);
    }
  }
}

/** Version 7 look: single-vault headings and the "keep the output in the vault" option. */
function v7Chrome() {
  const on = !!(sideOf(vault) || sideOf(SV.vault));
  document.body.classList.toggle("v7", on);
  if (oneVault()) oneVaultText(document.body);
  const buyTitle = document.querySelector(".pf-vaults .vaultcard:not(.sv-only) h2");
  if (buyTitle) buyTitle.textContent = sideOf(vault) ? "USDC in your vault" : "Your buy vault";
  const sellTitle = $("sv-title");
  if (sellTitle && !document.body.classList.contains("xmarket")) sellTitle.textContent = sideOf(SV.vault) ? `${BS} in your vault` : "Your sell vault";
  for (const id of ["keep-on", "keep-on-sell"]) {
    const el = $(id);
    if (el) el.checked = KEEP.on;
  }
}
for (const id of ["keep-on", "keep-on-sell"]) {
  const el = $(id);
  if (el)
    el.onchange = () => {
      KEEP.on = el.checked;
      try {
        localStorage.setItem("iora-keep", KEEP.on ? "1" : "0");
      } catch {}
      v7Chrome();
      // Make the previews rewrite the "where it goes" sentence
      for (const f of ["olimit", "sv-px"]) $(f)?.dispatchEvent(new Event("input", { bubbles: true }));
    };
}

async function refresh() {
  await pickGeneration();
  await refreshBuy();
  if (location.hash === "#sell" || location.hash === "#portfolio") await refreshSell(); // Portfolio also shows the sell vault card
  if (vault && V3.buy === null) V3.buy = await isV3(vault);
  $("autosell-row").hidden = !(V3.buy && SV.factory);
  renderPortfolio();
  renderLegacy();
  v7Chrome();
}

// ---------------------------------------------------------------------------
// Version 3 vaults: stop loss (triggered order) and "buy, then sell automatically" (follow-up order)
// ---------------------------------------------------------------------------
const V3 = { buy: null, sell: null };
/** Is the vault version 3? (Older vaults have no get_feeder; the read fails.) */
async function isV3(v) {
  const r = await read(v, "get_feeder");
  return r.ok;
}
const AUTO = { px: 0n }; // take profit: price of the order opened in the sell vault when the buy fills (USDC, 7 decimals); 0 = off
$("tp-px").addEventListener("input", () => {
  let v = 0n;
  try {
    v = $("tp-px").value.trim() ? toUnits($("tp-px").value) : 0n;
  } catch {}
  AUTO.px = v > 0n ? v : 0n;
  updateTicket();
});
// Take profit as a percentage: "+10%" sets the take profit price 10% above the buy price and follows the buy
// price while it is being typed. Typing a take profit price by hand switches the percentage off.
let tpPct = null;
function tpBuyPrice() {
  try {
    const v = $("olimit").value.trim();
    return v ? toUnits(v) : 0n;
  } catch {
    return 0n;
  }
}
function tpNote() {
  const base = tpBuyPrice();
  const el = $("tp-gain");
  const show = base > 0n && AUTO.px > 0n;
  el.hidden = !show;
  if (!show) return;
  const pct = (Number(AUTO.px - base) / Number(base)) * 100;
  el.textContent = AUTO.px > base ? `Sells ${pct.toFixed(pct < 10 ? 2 : 1).replace(/\.?0+$/, "")}% above your buy price.` : "The take profit price must be above your buy price.";
  el.classList.toggle("bad", AUTO.px <= base);
}
function tpApply() {
  for (const b of $("tp-pct").querySelectorAll("button")) b.setAttribute("aria-pressed", String(tpPct !== null && Number(b.dataset.p) === tpPct));
  if (tpPct === null) return tpNote();
  const base = tpBuyPrice();
  if (base > 0n) {
    // rounded up to 4 decimals, so the target is never below the percentage asked for
    const px = Math.ceil((Number(base) / 1e7) * (1 + tpPct / 100) * 1e4 - 1e-9) / 1e4;
    $("tp-px").value = px.toFixed(4);
    AUTO.px = toUnits(px.toFixed(4));
    updateTicket();
  }
  tpNote();
}
$("tp-pct").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (!tpBuyPrice()) return log("Type your buy price first; the take profit is set above it.", "err");
  tpPct = Number(b.dataset.p);
  $("tp-own").value = "";
  tpApply();
});
$("tp-own").addEventListener("input", () => {
  const v = parseFloat($("tp-own").value.replace(",", "."));
  tpPct = v > 0 && v <= 1000 ? v : null;
  tpApply();
});
$("tp-px").addEventListener("input", () => {
  tpPct = null;
  $("tp-own").value = "";
  tpApply();
});
$("olimit").addEventListener("input", tpApply);
$("olimit").addEventListener("change", tpApply);
const AUTO_DAYS = 365; // older vaults: the longest their contract accepts for the sell order of a take profit
/** Take profit price -> limit of the order in the sell vault (sell vault unit: XLM for 1 USDC). */
function autoSellLimit() {
  return { px: AUTO.px, lim: sellLimit(AUTO.px) };
}
/** Is the take profit price above the buy price? (The contract requires the same.) If not, says why. */
function autoOk(buyLimit) {
  if (!AUTO.px || AUTO.px > buyLimit) return true;
  log(`The take profit price must be above your buy price (${fmt(buyLimit)} USDC). Raise it or clear the field.`, "err");
  return false;
}
/** Prepares the sell vault: opens it if missing and allows it to accept funds from the buy vault. */
async function ensureFeeder() {
  let sv = await sellVaultOf();
  if (!sv) {
    if (!(await call(SV.factory, "create_vault", [addr(me)], "Open sell vault", FACTORY_ERRORS))) return null;
    await refreshSell();
    sv = SV.vault;
    if (!sv) return null;
  }
  if (!(await isV3(sv))) {
    log("Your sell vault is on an older version that can't receive automatic sells. Use “Sell higher” after the order fills instead.", "err");
    return null;
  }
  const f = await read(sv, "get_feeder");
  if (!(f.ok && f.value && String(f.value) === vault)) {
    const res = await call(sv, "set_feeder", [addr(vault)], `Let your buy vault send ${BS} to your sell vault`, SELL_ERRORS);
    if (!res) return null;
  }
  return sv;
}
function autoRows(limit) {
  if (!AUTO.px) return [];
  const up = (Number(AUTO.px) / Number(limit) - 1) * 100;
  return [["Take profit", `sell at ≥ ${px4(Number(AUTO.px) / 1e7)} USDC from your sell vault (+${up.toFixed(1)}%${autoSpan(vault) ? `, ${autoSpan(vault)}` : ""})`]];
}

// ---- Old-version vaults: let the user take their funds to the wallet in one click ----
const OLD_FACTORIES = String(import.meta.env.VITE_OLD_FACTORIES || "").split(",").map((s) => s.trim()).filter(Boolean);
const LEGACY_DUST = 100_000n; // 0.01 token
/** Portfolio: funds in an old vault are not in the totals below; the user must not think "my money is gone". */
function pfLegacyNote(items) {
  const host = $("pfolio");
  if (!host) return;
  let el = document.getElementById("pf-legacy-note");
  if (!items.length) return void (el && el.remove());
  if (!el) {
    el = document.createElement("div");
    el.id = "pf-legacy-note";
    el.className = "pf-old";
    host.before(el);
  }
  const parts = items.filter((i) => i.b >= LEGACY_DUST).map((i) => `<b>${fmt(i.b, 2)} ${esc(i.name || i.tok)}</b>`);
  const what = parts.length ? `${parts.join(" and ")} ${parts.length > 1 ? "are" : "is"} still in your old vault${items.length > 1 ? "s" : ""}` : "You still have open orders in an old vault";
  el.innerHTML = `<span>${what}. It is safe and still earning, but it is not counted in the totals below.</span><button class="btn" type="button">Move or withdraw</button>`;
  el.querySelector("button").onclick = () => $("legacy").scrollIntoView({ behavior: "smooth", block: "start" });
}
async function renderLegacy() {
  const box = $("legacy");
  if (!OLD_FACTORIES.length || !me) return ((box.innerHTML = ""), (box.hidden = true));
  // Old factories are queried at the same time (waiting in turn makes opening slower)
  const found = await Promise.all(
    // The generation the user is using now does not count as "old"
    OLD_FACTORIES.filter((f) => f !== GEN.buy && f !== GEN.sell && !isV7Factory(f)).map(async (f) => {
      const r = await read(f, "vault_of", [addr(me)]);
      if (!(r.ok && r.value)) return null;
      const v = String(r.value);
      const [cf, bal, open] = await Promise.all([read(v, "get_config"), read(v, "balance"), openOrdersIn(v)]);
      const b = bal.ok ? BigInt(bal.value) : 0n;
      // Dust interest accrued between withdrawing and execution (below 0.01) is not shown
      if (b < LEGACY_DUST && !open.length) return null;
      const tok = cf.ok && String(cf.value.usdc) === C.xlm ? "XLM" : "USDC";
      // The coin this old vault really holds: buy vaults of that era hold Blend's old test USDC, not Circle's.
      const token = cf.ok && cf.value.usdc ? String(cf.value.usdc) : tok === "XLM" ? C.xlm : null;
      return { v, b, open: open.length, tok, token, name: tok === "XLM" ? "XLM" : token ? coinSym(token) : "old test USDC" };
    }),
  );
  const items = found.filter(Boolean);
  const allowed = await newestAllowed().catch(() => null);
  // Blend's old test USDC can be moved too: it is exchanged 1:1 for Circle's USDC on the way.
  for (const i of items) {
    i.exchange = !!(allowed && i.token === OLD_BLEND_USDC && allowed.has(C.usdc));
    i.movable = !!(allowed && i.token && (allowed.has(i.token) || i.exchange));
  }
  pfLegacyNote(items);
  if (!items.length) return ((box.innerHTML = ""), (box.hidden = true));
  const coin = (t) => `<i class="coin ${t.toLowerCase()}" aria-hidden="true"></i>`;
  box.innerHTML = `
    <div class="legacy-head">
      <span class="legacy-badge" aria-hidden="true">↻</span>
      <div>
        <h2>Move your funds to the new vault</h2>
        <p>Iora's vaults were upgraded, so this page now shows your new vault. Nothing is lost: your old vault still holds your funds, still earns, and its orders still fill. Only you can move the money out. One click does it all: you just approve each step in your wallet.</p>
      </div>
    </div>
    <div class="legacy-list">${items
      .map(
        (i) => `<div class="legacy-item" data-kind="${i.tok === "XLM" ? "sell" : "buy"}">
        <div class="legacy-what">
          <span class="legacy-label">${i.tok === "XLM" ? "Old sell vault" : "Old buy vault"} · <a href="${EXPLORER}/contract/${i.v}" target="_blank" rel="noopener">${short(i.v)}</a></span>
          <b class="legacy-amt">${coin(i.tok)}${fmt(i.b, 2)} <small>${esc(i.name)}</small></b>
          ${i.exchange ? `<span class="legacy-note">Exchanged 1:1 for Circle's test USDC on the way${i.open ? `; ${i.open} open order${i.open > 1 ? "s" : ""} placed again at the same price` : ""}</span>` : !i.movable ? `<span class="legacy-note">${esc(i.name)} is not used in the new Iora: withdraw it to your wallet${i.open ? `; the ${i.open} open order${i.open > 1 ? "s are" : " is"} cancelled` : ""}</span>` : i.open ? `<span class="legacy-note">${i.open} open order${i.open > 1 ? "s" : ""}: placed again at the same price</span>` : ""}
        </div>
        <div class="legacy-actions">
          ${i.movable ? `<button class="btn primary" data-migrate="${i.v}" data-tok="${i.tok}" data-token="${esc(i.token || "")}">Move to new ${i.tok === "XLM" ? "sell" : "buy"} vault</button>` : ""}
          <button class="${i.movable ? "link" : "btn primary"}" data-legacy="${i.v}" data-tok="${i.tok}" data-token="${esc(i.token || "")}" data-name="${esc(i.name)}">${i.movable ? "or withdraw to wallet" : "Withdraw to wallet"}</button>
        </div>
      </div>`,
      )
      .join("")}</div>`;
  syncLegacy();
  for (const b of box.querySelectorAll("[data-legacy]")) b.onclick = () => emptyLegacy(b.dataset.legacy, b.dataset.tok, b.dataset.token || null, b.dataset.name || b.dataset.tok);
  for (const b of box.querySelectorAll("[data-migrate]")) b.onclick = () => migrateLegacy(b.dataset.migrate, b.dataset.tok, b.dataset.token || null);
}

/** The old buy vault shows only on the Buy vault tab, the old sell vault only on the Sell vault tab. */
function syncLegacy() {
  const box = $("legacy");
  if (!box) return;
  const kind = document.body.classList.contains("xmarket") ? "" : { vault: "buy", sell: "sell" }[document.body.dataset.view] || "";
  let shown = 0;
  for (const it of box.querySelectorAll(".legacy-item")) {
    it.hidden = it.dataset.kind !== kind;
    if (!it.hidden) shown++;
  }
  box.hidden = shown === 0;
}

/** Old vault: cancel the orders + withdraw everything. Returns the amount that reached the wallet (null on failure). */
async function drainLegacy(v, tok, coin = null, name = tok) {
  for (const o of await openOrdersIn(v)) if (!(await call(v, "cancel_order", [u32(o.id)], `Cancel old order #${o.id}`, VAULT_ERRORS))) return null;
  // The coin the old vault holds (for buy vaults of that era: Blend's old test USDC), so the amount is measured right
  const token = coin || (tok === "XLM" ? C.xlm : C.usdc);
  const before = await read(token, "balance", [addr(me)]);
  const bal = await read(v, "balance");
  if (!bal.ok || BigInt(bal.value) <= 0n) return 0n;
  if (!(await call(v, "withdraw", [i128(BigInt(bal.value))], `Withdraw ${fmt(bal.value, 2)} ${esc(name)} from old vault`, VAULT_ERRORS))) return null;
  const after = await read(token, "balance", [addr(me)]);
  return before.ok && after.ok ? BigInt(after.value) - BigInt(before.value) : BigInt(bal.value);
}

async function emptyLegacy(v, tok, coin = null, name = tok) {
  const open = await openOrdersIn(v);
  const steps = open.length + 1;
  if (
    !(await ask({
      title: "Withdraw to your wallet",
      lede: `This ${open.length ? `cancels ${open.length} open order${open.length > 1 ? "s" : ""} and ` : ""}withdraws everything from the old vault, interest included.`,
      notes: [`You'll sign ${steps} transaction${steps > 1 ? "s" : ""}.`],
      confirm: "Withdraw",
    }))
  )
    return;
  const got = await drainLegacy(v, tok, coin, name);
  if (got !== null) log(`Moved ${fmt(got, 2)} ${esc(name)} from your old vault to your wallet.${coin && coin !== C.usdc && coin !== C.xlm ? " It is not used in the new Iora." : ""}`, "ok");
  await refresh();
}

// ---- Single vaults (version 7 and later): every coin and every pair in one place ----
const COINS = () => [{ sym: "USDC", token: C.usdc }, { sym: "XLM", token: C.xlm }, ...PAIRS];
// Retired coins (Blend's old test USDC) get a name that cannot be mistaken for the app's USDC (Circle's).
const coinSym = (t) => coinLabel(t, COINS(), short);
/** Open orders of every pair in a single vault (plain vault address), with schedule and take-profit settings. */
async function allOpenOrders(id) {
  const cnt = await rawRead(id, "order_count");
  const n = cnt.ok ? Number(cnt.value) : 0;
  const rows = await Promise.all([...Array(n).keys()].map((i) => rawRead(id, "get_order", [u32(i)])));
  const out = [];
  for (const [i, r] of rows.entries()) {
    if (!r.ok || !r.value || orderStatus(r.value) !== "Open") continue;
    const o = r.value;
    const left = BigInt(o.amount_in) - BigInt(o.filled_in);
    if (left <= 0n) continue;
    out.push({ id: i, sell: String(o.sell), buy: String(o.buy), left, limit: BigInt(o.limit_price), minFill: BigInt(o.min_fill), impact: Number(o.max_impact_bps), trigger: BigInt(o.trigger_price || 0), band: Number(o.stop_band_bps || 0), expiry: BigInt(o.expiry), keep: o.keep !== false });
  }
  return out;
}
/** Vaults of this wallet in earlier single-vault generations that still hold coins or open orders. */
async function olderVaults() {
  if (!V7 || !me) return [];
  const who = me;
  const found = await Promise.all(
    GENERATIONS.filter((g) => g !== GEN_LATEST && isV7Factory(g.buy)).map(async (g) => {
      const r = await read(g.buy, "vault_of", [addr(who)]);
      if (!(r.ok && r.value)) return null;
      const id = String(r.value);
      const [ps, orders] = await Promise.all([rawRead(id, "positions"), allOpenOrders(id)]);
      const coins = (ps.ok && Array.isArray(ps.value) ? ps.value : []).filter((p) => BigInt(p.balance) >= LEGACY_DUST).map((p) => ({ token: String(p.token), bal: BigInt(p.balance) }));
      return coins.length || orders.length ? { id, coins, orders } : null;
    }),
  );
  return found.filter(Boolean);
}
/** Portfolio: while coins or orders are still in an earlier vault, one slim line offers to move them. It can be
    closed; after that only a small link under the table remains. */
async function genNote() {
  const host = $("pfolio"), link = $("pf-move-link");
  if (!host || !link) return;
  convNote();
  let list = [];
  try {
    list = await olderVaults();
  } catch (e) {
    console.warn("older vaults", e);
  }
  let el = document.getElementById("pf-move-note");
  if (!list.length) {
    if (el) el.remove();
    link.hidden = true;
    return;
  }
  const v = list[0];
  const key = `iora-move-hide:${v.id}`;
  let closed = false;
  try {
    closed = localStorage.getItem(key) === "1";
  } catch {}
  const parts = v.coins.map((c) => `${fmt(c.bal, c.token === C.usdc || c.token === C.xlm ? 2 : 7)} ${esc(coinSym(c.token))}`);
  const what = [...parts, v.orders.length ? `${v.orders.length} open order${v.orders.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ");
  const allowed = await newestAllowed().catch(() => null);
  const plan = allowed ? planMove(v.coins, v.orders, allowed, EXCHANGE()) : null;
  const go = plan && !plan.carry.length && !plan.keep.length ? "Withdraw to your wallet" : "Move to the new vault";
  link.innerHTML = `${what} in an earlier version of your vault. <button type="button" class="link">${go}</button>`;
  link.querySelector("button").onclick = () => moveToLatest(v);
  link.hidden = !closed;
  if (closed) return void (el && el.remove());
  if (!el) {
    el = document.createElement("div");
    el.id = "pf-move-note";
    el.className = "pf-movenote";
    host.before(el);
  }
  el.innerHTML = `<span><b>${what}</b> in an earlier version of your vault.</span><button type="button" class="link" data-go>${go}</button><button type="button" class="link" data-x aria-label="Close" title="Close">✕</button>`;
  el.querySelector("[data-go]").onclick = () => moveToLatest(v);
  el.querySelector("[data-x]").onclick = () => {
    try {
      localStorage.setItem(key, "1");
    } catch {}
    el.remove();
    link.hidden = false;
  };
}
// ---- Portfolio chart: the vault's value over time. Nothing on chain keeps this, so the page notes the value each
// time the Portfolio is read (in this browser, per wallet); the line starts on the first visit and grows from there.
const PFH_MAX = 3000;
const pfhKey = () => `iora-pfhist:${me}`;
function pfhRead() {
  try {
    const a = JSON.parse(localStorage.getItem(pfhKey()) || "[]");
    return Array.isArray(a) ? a.filter((x) => Array.isArray(x) && x.length === 3 && x[0] > 0) : [];
  } catch {
    return [];
  }
}
function pfhAdd(total, earned) {
  const a = pfhRead();
  const t = Math.floor(Date.now() / 1000);
  const last = a[a.length - 1];
  const r = (x, d) => Math.round(x * d) / d;
  const row = [t, r(total, 1e4), r(earned, 1e6)];
  // a new point at most every 10 minutes, unless the value moved by more than 0.2%
  if (last && t - last[0] < 600 && Math.abs(row[1] - last[1]) <= Math.abs(last[1]) * 0.002) a[a.length - 1] = [last[0], row[1], row[2]];
  else a.push(row);
  try {
    localStorage.setItem(pfhKey(), JSON.stringify(a.slice(-PFH_MAX)));
  } catch {}
  return a;
}
let pfChart = "value", pfRange = "all";
function pfChartHtml(hist) {
  const span = { "1d": 86400, "1w": 604800, "1m": 2592000 }[pfRange];
  const now = Date.now() / 1000;
  let pts = hist.filter((x) => !span || x[0] >= now - span).map((x) => [x[0], pfChart === "value" ? x[1] : x[2]]);
  if (!pts.length && hist.length) pts = [[hist[hist.length - 1][0], pfChart === "value" ? hist[hist.length - 1][1] : hist[hist.length - 1][2]]];
  const W = 520, Hh = 172, L = 52, R = 10, T = 14, B = 22;
  let body = "";
  if (pts.length) {
    if (pts.length === 1) pts = [[pts[0][0] - 1, pts[0][1]], pts[0]];
    let lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
    if (hi - lo < Math.abs(hi) * 0.002 || hi === lo) {
      const pad = Math.max(Math.abs(hi) * 0.01, pfChart === "value" ? 0.01 : 0.000001);
      lo -= pad;
      hi += pad;
    }
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
    const X = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R), Y = (v) => T + ((hi - v) / (hi - lo)) * (Hh - T - B);
    const dp = pfChart === "value" ? 2 : 6;
    for (let k = 0; k <= 3; k++) {
      const v = lo + ((hi - lo) * k) / 3;
      body += `<line x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="g"/><text x="${L - 6}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end">${v.toLocaleString("en-US", { maximumFractionDigits: dp })}</text>`;
    }
    const d = pts.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join(" ");
    body += `<path d="${d} L${W - R} ${Hh - B} L${L} ${Hh - B} Z" class="a"/><path d="${d}" class="l"/>`;
    const day = (t) => new Date(t * 1000).toLocaleString("en-US", t1 - t0 < 2 * 86400 ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric" });
    body += `<text x="${L}" y="${Hh - 6}">${day(t0)}</text><text x="${W - R}" y="${Hh - 6}" text-anchor="end">${day(t1)}</text>`;
  }
  const tabs = [["value", "Vault value"], ["earned", "Interest earned"]].map(([k, l]) => `<button type="button" data-pfc="${k}" aria-selected="${pfChart === k}">${l}</button>`).join("");
  const ranges = [["1d", "1D"], ["1w", "1W"], ["1m", "1M"], ["all", "All"]].map(([k, l]) => `<button type="button" data-pfr="${k}" aria-pressed="${pfRange === k}">${l}</button>`).join("");
  const young = hist.length < 3;
  return `<div class="pf-chart-head"><div class="pf-tabs">${tabs}</div><div class="pf-ranges">${ranges}</div></div><svg viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none" role="img" aria-label="${pfChart === "value" ? "Vault value in USDC over time" : "Interest earned in USDC over time"}">${body}</svg>${young ? `<p class="pf-chart-note">The line starts today and grows each time you open this page (kept in this browser).</p>` : ""}`;
}
function pfChartDraw(hist) {
  const el = $("pf-chart");
  if (!el) return;
  el.innerHTML = pfChartHtml(hist);
  for (const b of el.querySelectorAll("[data-pfc]")) b.onclick = () => ((pfChart = b.dataset.pfc), pfChartDraw(hist));
  for (const b of el.querySelectorAll("[data-pfr]")) b.onclick = () => ((pfRange = b.dataset.pfr), pfChartDraw(hist));
}
// ---- One-approval move (iora-mover): coins and open orders of an earlier single vault (version 8+) move to the
// newest vault in ONE transaction; Blend's old test USDC is exchanged 1:1 for Circle's USDC on-chain
// (iora-usdc-exchange) on the way. Built as scripts/move-vault.mjs does; the planning is in mover.js. The step-by-step
// move below stays as the fallback (older vaults, no mover configured, or a move that cannot be simulated).
const MOVER = (import.meta.env.VITE_MOVER || "").trim();
const USDC_EXCHANGE = (import.meta.env.VITE_USDC_EXCHANGE || "").trim();
const MOVER_ERRORS = { 1: "The move contains a call the mover does not allow.", 2: "The earlier vault and the new vault are the same.", 3: "A coin amount is not positive." };
/** Everything the move needs from the earlier vault, read now (a failed read stops the move: nothing is guessed). */
async function readForMove(id) {
  const need = async (fn, args = []) => {
    const r = await rawRead(id, fn, args);
    if (!r.ok) throw new Error(`could not read ${fn} of the earlier vault`);
    return r.value;
  };
  const version = Number(await need("version"));
  if (!(version >= 8)) return { version };
  const balances = {};
  for (const t of (await need("tokens")) || []) {
    const b = BigInt((await need("balance", [addr(String(t))])) ?? 0);
    if (b > 0n) balances[String(t)] = b;
  }
  const n = Number(await need("order_count"));
  const orders = [];
  for (let i = 0; i < n; i++) {
    const o = await need("get_order", [u32(i)]);
    if (!o || orderStatus(o) !== "Open") continue;
    const schedule = version >= 11 ? await need("get_schedule", [u32(i)]) : null;
    const followUp = await need("get_follow_up", [u32(i)]);
    orders.push({ id: i, order: { ...o, status: ["Open"] }, schedule: schedule || null, followUp: followUp || null });
  }
  let exchange = null;
  if (balances[OLD_BLEND_USDC] && USDC_EXCHANGE) {
    const [mock, usdc, left] = await Promise.all([rawRead(USDC_EXCHANGE, "mock"), rawRead(USDC_EXCHANGE, "usdc"), rawRead(USDC_EXCHANGE, "left", [addr(me)])]);
    if (!mock.ok || !usdc.ok || !left.ok) throw new Error("could not read the USDC exchange");
    if (String(mock.value) === OLD_BLEND_USDC && String(usdc.value) === C.usdc) exchange = { mock: OLD_BLEND_USDC, usdc: C.usdc, left: BigInt(left.value) };
  }
  return { version, balances, orders, exchange };
}
const scArg = ([t, v]) => (t === "addr" ? addr(v) : t === "i128" ? i128(v) : t === "u32" ? u32(Number(v)) : t === "u64" ? u64(v) : nativeToScVal(!!v, { type: "bool" }));
/** The arguments of one move_vault call. Coin amounts are fixed: the signature covers every argument of the call tree. */
function moverArgs(oldId, part, exchange) {
  const place = part.place.map((p) =>
    // PlaceCall { func, args }: a contracttype struct is a map with its field names sorted
    xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("args"), val: xdr.ScVal.scvVec(p.args.map(scArg)) }), new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("func"), val: xdr.ScVal.scvSymbol(p.func) })]),
  );
  const coins = xdr.ScVal.scvMap(sortCoins(part.coins, (t) => StrKey.decodeContract(t)).map(([t, n]) => new xdr.ScMapEntry({ key: addr(t), val: i128(n) })));
  return [addr(me), addr(oldId), addr(GEN_LATEST.buy), coins, xdr.ScVal.scvVec(part.cancel.map((i) => u32(i))), xdr.ScVal.scvVec(place), exchange ? addr(USDC_EXCHANGE) : xdr.ScVal.scvVoid()];
}
/** Simulates one move_vault call (nothing is signed). Returns null if it would go through, else the error. */
async function simulateMove(args) {
  try {
    const sim = await server.simulateTransaction(await buildCall(MOVER, "move_vault", args));
    return rpc.Api.isSimulationError(sim) ? String(sim.error || "simulation failed").split("\n")[0].slice(0, 160) : null;
  } catch (e) {
    return String((e && e.message) || e).slice(0, 160);
  }
}
/** Parts for a plan: as few transactions as the simulation allows (4 coins + 6 orders, then smaller). */
async function partsThatSimulate(id, plan, exchange) {
  const inNew = (t) => (exchange && t === exchange.mock ? exchange.usdc : t);
  let why = null;
  for (const max of [PART, { coins: 2, orders: 3 }, { coins: 1, orders: 1 }]) {
    const parts = splitPlan(plan, max, inNew);
    why = await simulateMove(moverArgs(id, parts[0], exchange));
    if (!why) return { parts };
    if (parts[0].coins.length <= 1 && parts[0].place.length <= 1) break;
  }
  return { parts: null, why };
}

async function moveToLatest(v) {
  const fallback = (why) => {
    if (why) log(`Moving step by step instead (several approvals): ${esc(why)}.`);
    return moveStepByStep(v);
  };
  if (!MOVER || !me) return moveStepByStep(v);
  log("Preparing the move…", "wait");
  let info;
  try {
    info = await readForMove(v.id);
  } catch (e) {
    return log(`Could not read your earlier vault (${esc(String((e && e.message) || e))}). Nothing was moved; try again in a moment.`, "err");
  }
  if (!(info.version >= 8)) return fallback(`this earlier vault (version ${info.version}) predates the one-approval move`);
  if (info.balances[OLD_BLEND_USDC] && !info.exchange) return fallback("the on-chain USDC exchange is not available");
  const now = Math.floor(Date.now() / 1000);
  const withPlan = planMoverCall({ ...info, now, withOrders: true });
  const bare = planMoverCall({ ...info, now, withOrders: false });
  if (!withPlan.coins.length && !withPlan.cancel.length) return log("Your earlier vault is already empty.", "ok");
  // Both choices are simulated before asking, so the dialog can say how many approvals each takes.
  const [w, b] = [await partsThatSimulate(v.id, withPlan, info.exchange), await partsThatSimulate(v.id, bare, info.exchange)];
  if (!w.parts && !b.parts) return fallback(`the move could not be prepared (${w.why || b.why})`);
  // Circle's USDC arrives in the wallet before it is deposited, so the wallet needs its trustline (a separate approval).
  const needsUsdc = withPlan.coins.some(([t]) => t === C.usdc || t === OLD_BLEND_USDC);
  const trustOk = !needsUsdc || (flushReads(), (await read(C.usdc, "balance", [addr(me)])).ok);

  const cur = await read(GEN_LATEST.buy, "vault_of", [addr(me)]);
  const dest = cur.ok && cur.value ? String(cur.value) : null;
  const dp = (t) => (t === C.usdc || t === C.xlm || t === OLD_BLEND_USDC ? 2 : 7);
  const coinRow = withPlan.coins
    .map(([t, n]) => (t === OLD_BLEND_USDC ? `${fmt(n, 2)} old test USDC (Blend) → ${fmt(n - withPlan.mockLeftInWallet, 2)} USDC (Circle), exchanged 1:1` : `${fmt(n, dp(t))} ${esc(coinSym(t))}`))
    .join("<br>");
  const price = (p) => (p.limit >= DCA_NO_LIMIT ? "at the market (DCA)" : p.sell === C.usdc ? `≤ ${fmt(p.limit)} USDC` : `≥ ${px4(sellPrice(p.limit))} USDC`);
  const what = (p) => (p.sell === C.usdc ? `buy ${esc(coinSym(p.buy))} for ${fmt(p.amount, 2)} USDC` : `sell ${fmt(p.amount, 2)} ${esc(coinSym(p.sell))}`);
  const kind = { place_order: "", place_stop_order: " (stop)", place_order_then: " (with take profit)", place_dca: " (DCA)" };
  const nOk = (parts) => (parts ? parts.length : 0);
  const extra = trustOk ? 0 : 1;
  const approvals = (parts) => `${nOk(parts) + extra} approval${nOk(parts) + extra > 1 ? "s" : ""} in your wallet${extra ? " (one adds the USDC trustline)" : ""}`;
  const rows = [
    ["From", `Earlier vault ${short(v.id)}`],
    ["To", dest ? `Your newest vault ${short(dest)}` : "A new vault, opened in the same transaction"],
    ["Coins", coinRow || "none"],
  ];
  if (withPlan.mockLeftInWallet > 0n)
    rows.push(["Stays in your wallet", `${fmt(withPlan.mockLeftInWallet, 2)} old test USDC: above the exchange's limit of 5,000 per wallet. You can exchange it afterwards with Iora's backup exchange.`]);
  if (withPlan.cancel.length) {
    const choice = (val, label, parts, on, hint) =>
      `<label class="mv-keep"><input type="radio" name="mv-how" value="${val}"${on ? " checked" : ""}${parts ? "" : " disabled"} /> <b>${label}</b> · ${parts ? approvals(parts) : "not possible right now"}${hint ? `<br><span class="muted">${hint}</span>` : ""}</label>`;
    rows.push([
      "How",
      choice("with", "Move with orders — one approval", w.parts, !!w.parts, "Recommended. Your open orders are opened again in the new vault at their old prices.") +
        "<br>" +
        choice("without", "Move without orders", b.parts, !w.parts, "Your open orders are cancelled; only the coins move."),
    ]);
    if (withPlan.place.length) rows.push(["Opened again", withPlan.place.map((p) => `#${p.id} ${what(p)} ${price(p)}${kind[p.func]}`).join("<br>")]);
    if (withPlan.skipped.length) rows.push(["Only cancelled", withPlan.skipped.map((x) => `#${x.id}: ${esc(x.why)}`).join("<br>")]);
  }
  const notes = [
    withPlan.cancel.length ? "Pick how above; either way it is one transaction (two if the move is large)." : `${approvals(b.parts || w.parts)}.`,
    "A few stroops of interest that accrue while you approve stay in the earlier vault as dust.",
    "Everything happens in one transaction: if any part fails, nothing moves.",
  ];
  if (!(await ask({ title: "Move to your newest vault", rows, notes, confirm: "Move" }))) return;
  const how = (document.querySelector('input[name="mv-how"]:checked') || {}).value || "without";
  const plan = how === "with" && w.parts ? withPlan : bare;
  let parts = how === "with" && w.parts ? w.parts : b.parts;
  if (!parts) return fallback("the move could not be prepared");
  if (!trustOk && !(await ensureUsdcTrust())) return log("Nothing was moved: the USDC trustline is needed first. Try again.", "err");

  let newVault = null;
  for (const [k, part] of parts.entries()) {
    const args = moverArgs(v.id, part, info.exchange);
    if (k > 0) {
      const why = await simulateMove(args);
      if (why) {
        log(`Part ${k + 1} of ${parts.length} could not be prepared (${esc(why)}). The coins moved so far are in your new vault; the rest is still in your earlier vault: press Move again to finish.`, "err");
        break;
      }
    }
    const label = parts.length > 1 ? `Move to your newest vault (part ${k + 1} of ${parts.length})` : "Move to your newest vault";
    const res = await call(MOVER, "move_vault", args, label, MOVER_ERRORS);
    if (!res) {
      if (k > 0) log("The first part went through: some coins are already in your new vault. Press Move again to move the rest.", "err");
      return refresh();
    }
    newVault = res.value ? String(res.value) : newVault;
  }
  flushReads(true);
  // Old test USDC above the exchange's limit stayed in the wallet: offer the backup exchange for it.
  if (plan.mockLeftInWallet > 0n) {
    const wb = await read(OLD_BLEND_USDC, "balance", [addr(me)]);
    const extraMock = wb.ok ? (BigInt(wb.value) < plan.mockLeftInWallet ? BigInt(wb.value) : plan.mockLeftInWallet) : plan.mockLeftInWallet;
    log(`${fmt(extraMock, 2)} old test USDC stayed in your wallet (above the exchange's limit).`, "err");
    if (
      extraMock > 0n &&
      (await ask({ title: "Exchange the rest?", lede: `${fmt(extraMock, 2)} old test USDC stayed in your wallet. Iora's backup exchange can swap it 1:1 for Circle's USDC and deposit it in your new vault (a few more approvals).`, confirm: "Exchange it", back: "Not now" }))
    ) {
      const out = await exchangeOldUsdc(extraMock);
      const target = newVault || (await read(GEN_LATEST.buy, "vault_of", [addr(me)])).value;
      if (out && out > 0n && target) await call(String(target), "deposit", [addr(C.usdc), i128(out)], `Deposit ${fmt(out, 2)} USDC into your new vault`, VAULT_ERRORS);
    }
  }
  log(`Done: your coins${plan.place.length ? " and orders" : ""} are in your newest vault. Reloading…`, "ok");
  setTimeout(() => location.reload(), 2500);
}

/** Earlier single vault -> newest vault: cancel, withdraw every coin, open the new vault if needed, deposit, and
    (if the owner keeps the box ticked) place the open orders again with the same settings. Every step is signed.
    The fallback of the one-approval move above. */
async function moveStepByStep(v) {
  // Only coins the newest factory allows go into the new vault. Blend's old test USDC is exchanged 1:1 for Circle's
  // USDC on the way (and its orders are placed again in Circle's USDC). Any other coin is withdrawn to the wallet
  // only, and an order that uses one is cancelled, not placed again.
  const allowed = await newestAllowed().catch(() => null);
  if (!allowed) return log("Could not read which coins the new vault accepts. Nothing was moved; try again in a moment.", "err");
  const plan = planMove(v.coins, v.orders, allowed, EXCHANGE());
  const live = plan.keep; // these open orders can be carried; in the new vault an order has no end date
  const cur = await read(GEN_LATEST.buy, "vault_of", [addr(me)]);
  let dest = cur.ok && cur.value ? String(cur.value) : null;
  const needVault = !dest && (plan.carry.length > 0 || live.length > 0);
  const side = (o) => (o.sell === C.usdc || o.sell === OLD_BLEND_USDC ? `buy ${esc(coinSym(o.buy))}` : `sell ${esc(coinSym(o.sell))}`);
  const amt = (c) => `${fmt(c.bal, c.token === C.usdc || c.token === C.xlm ? 2 : 7)} ${esc(coinSym(c.token))}`;
  const rows = [["From", `Earlier vault ${short(v.id)}`]];
  if (plan.carry.length || live.length) rows.push(["To", dest ? `Your newest vault ${short(dest)}` : "A new vault, opened for you"]);
  if (plan.carry.length) rows.push(["Coins", `${plan.carry.map(amt).join(", ")} (interest included)`]);
  if (plan.convert.length)
    rows.push(["Exchange", "Your old test USDC is exchanged 1:1 for Circle's test USDC (the USDC Iora uses now) and deposited in your new vault."]);
  if (plan.walletOnly.length)
    rows.push(["To your wallet only", `${plan.walletOnly.map(amt).join(", ")}: not used in the new Iora, so ${plan.walletOnly.length > 1 ? "they are" : "it is"} withdrawn to your wallet, not moved`]);
  if (live.length)
    rows.push([
      "Open orders",
      `<label class="mv-keep"><input type="checkbox" id="mv-keep" checked /> Keep my ${live.length} open order${live.length > 1 ? "s" : ""}: placed again in the new vault with the same prices (${live.map(side).join(", ")})</label>`,
    ]);
  if (plan.cancelOnly.length)
    rows.push(["Cancelled only", `${plan.cancelOnly.length} open order${plan.cancelOnly.length > 1 ? "s" : ""} (${plan.cancelOnly.map(side).join(", ")}): ${plan.cancelOnly.length > 1 ? "they use" : "it uses"} a coin the new Iora does not use, so ${plan.cancelOnly.length > 1 ? "they are" : "it is"} not placed again`]);
  const base = v.orders.length + v.coins.length + plan.carry.length + plan.convert.length + (needVault ? 1 : 0);
  const notes = [
    `You'll approve about ${base}${live.length ? ` to ${base + live.length}` : ""} steps in your wallet: ${v.orders.length ? "cancel the orders, " : ""}withdraw each coin${plan.convert.length ? ", return the old test USDC to its issuer (a USDC trustline first if your wallet has none)" : ""}${needVault ? ", open the new vault" : ""}${plan.carry.length ? ", deposit" : ""}${live.length ? ", then place the orders again if you keep the box ticked" : ""}.`,
    "The coins only ever move between your own vaults and your wallet. If you stop halfway, they stay safe in your wallet and you can deposit them on this page.",
  ];
  const title = plan.carry.length || live.length ? "Move to your newest vault" : "Withdraw to your wallet";
  if (!(await ask({ title, rows, notes, confirm: "Start" }))) return;
  const keepBox = document.getElementById("mv-keep");
  const keepOrders = live.length > 0 && !!(keepBox && keepBox.checked);

  // Settings that are stored beside an order (schedule, take profit) are read before the order is cancelled
  const extra = new Map();
  if (keepOrders)
    for (const o of live) {
      const [sc, fu] = await Promise.all([rawRead(v.id, "get_schedule", [u32(o.id)]).catch(() => ({ ok: false })), rawRead(v.id, "get_follow_up", [u32(o.id)]).catch(() => ({ ok: false }))]);
      extra.set(o.id, { sc: sc.ok && sc.value ? sc.value : null, fu: fu.ok && fu.value ? fu.value : null });
    }
  for (const o of v.orders) if (!(await call(v.id, "cancel_order", [u32(o.id)], `Cancel order #${o.id} in the earlier vault`, VAULT_ERRORS))) return refresh();
  const moved = [];
  const toWallet = [];
  const carryTokens = new Set(plan.carry.map((c) => c.token));
  const exchangeTo = new Map(plan.convert.map((x) => [x.from, x.to]));
  for (const c of v.coins) {
    const sym = coinSym(c.token);
    const [free, before] = await Promise.all([rawRead(v.id, "free_balance", [addr(c.token)]), read(c.token, "balance", [addr(me)])]);
    const amt = free.ok ? BigInt(free.value) : 0n;
    if (amt <= 0n) continue;
    if (!(await call(v.id, "withdraw", [addr(c.token), i128(amt)], `Withdraw ${fmt(amt, 2)} ${sym} from the earlier vault`, VAULT_ERRORS))) return refresh();
    const after = await read(c.token, "balance", [addr(me)]);
    const got = before.ok && after.ok ? BigInt(after.value) - BigInt(before.value) : amt;
    if (!carryTokens.has(c.token)) {
      toWallet.push({ sym, got });
      log(`${fmt(got, 2)} ${esc(sym)} is not used in the new Iora, so it was withdrawn to your wallet.`, "ok");
      continue;
    }
    if (exchangeTo.has(c.token)) {
      const out = await exchangeOldUsdc(got);
      if (out === null) return refresh();
      if (out > 0n) moved.push({ token: exchangeTo.get(c.token), sym: coinSym(exchangeTo.get(c.token)), got: out, wallet: null });
      continue;
    }
    moved.push({ token: c.token, sym, got, wallet: after.ok ? BigInt(after.value) : null });
  }
  const walletText = toWallet.length ? `${toWallet.map((m) => `${fmt(m.got, 2)} ${esc(m.sym)}`).join(", ")} ${toWallet.length > 1 ? "are" : "is"} in your wallet (not used in the new Iora)` : "";
  if (!moved.length && !(keepOrders && live.length)) {
    log(`Done: ${walletText || "the earlier vault is empty"}${plan.cancelOnly.length ? `; ${plan.cancelOnly.length} order${plan.cancelOnly.length > 1 ? "s were" : " was"} cancelled` : ""}. Reloading…`, "ok");
    return void setTimeout(() => location.reload(), 2500);
  }
  if (!dest) {
    if (!(await call(GEN_LATEST.buy, "create_vault", [addr(me)], "Open your new vault", FACTORY_ERRORS))) return refresh();
    const r = await read(GEN_LATEST.buy, "vault_of", [addr(me)]);
    dest = r.ok && r.value ? String(r.value) : null;
    if (!dest) {
      log("The new vault was opened but could not be read yet. Your coins are in your wallet; reload the page and deposit them here.", "err");
      return refresh();
    }
  }
  for (const m of moved) {
    let dep = m.got;
    if (m.token === C.xlm && m.wallet !== null && m.wallet - XLM_KEEP < dep) dep = m.wallet - XLM_KEEP; // XLM: keep the reserve for network fees
    if (dep <= 0n) continue;
    if (!(await call(dest, "deposit", [addr(m.token), i128(dep)], `Deposit ${fmt(dep, 2)} ${m.sym} into your new vault`, VAULT_ERRORS))) return refresh();
  }
  let placed = 0;
  if (keepOrders) {
    const bool = (b) => nativeToScVal(!!b, { type: "bool" });
    for (const [i, o] of live.entries()) {
      const rm = await rawRead(dest, "orderable_balance", [addr(o.sell)]);
      const room = rm.ok ? BigInt(rm.value) : o.left;
      const x = extra.get(o.id) || {};
      const label = `Place order ${i + 1}/${live.length} again`;
      const S = addr(o.sell), B = addr(o.buy);
      let ok;
      if (x.sc) {
        const part = BigInt(x.sc.part) < room ? BigInt(x.sc.part) : room;
        if (part <= 0n) continue;
        const fills = Number(x.sc.fills) === 0 ? 0 : Math.max(1, Number(x.sc.fills) - Number(x.sc.done));
        ok = await call(dest, "place_dca", [S, B, i128(part), u32(fills), u64(x.sc.every), i128(o.limit), u32(o.impact), u32(o.band), u64(NO_EXPIRY), bool(o.keep)], label, VAULT_ERRORS);
      } else {
        const size = o.left < room ? o.left : room;
        if (size <= 0n) continue;
        const mf = fillFloor(size, o.minFill < size ? o.minFill : size);
        if (o.trigger > 0n) ok = await call(dest, "place_stop_order", [S, B, i128(size), i128(o.trigger), i128(o.limit), i128(mf), u32(o.impact), u64(NO_EXPIRY), u32(o.band || SL_BAND_BPS), bool(o.keep)], label, VAULT_ERRORS);
        else if (x.fu) ok = await call(dest, "place_order_then", [S, B, i128(size), i128(o.limit), i128(mf), u32(o.impact), u64(NO_EXPIRY), i128(BigInt(x.fu.limit_price)), u32(Number(x.fu.max_impact_bps)), u64(x.fu.duration)], label, VAULT_ERRORS);
        else ok = await call(dest, "place_order", [S, B, i128(size), i128(o.limit), i128(mf), u32(o.impact), u64(NO_EXPIRY), bool(o.keep)], label, VAULT_ERRORS);
      }
      if (!ok) break;
      placed++;
    }
  }
  log(`Done: your coins are in your newest vault${walletText ? `; ${walletText}` : ""}${plan.cancelOnly.length ? `; ${plan.cancelOnly.length} order${plan.cancelOnly.length > 1 ? "s" : ""} with a retired coin cancelled` : ""}${keepOrders && live.length ? `; ${placed} of ${live.length} order${live.length > 1 ? "s" : ""} placed again` : live.length ? "; the open orders were cancelled, not placed again" : ""}. Reloading…`, !keepOrders || placed === live.length ? "ok" : "err");
  setTimeout(() => location.reload(), 2500);
}

/** From the old vault to the new one: cancel + withdraw + (open a new vault if needed) + deposit. */
async function migrateLegacy(v, tok, coin = null) {
  const sell = tok === "XLM";
  const exchange = coin === OLD_BLEND_USDC;
  const factory = sell ? SV.factory : C.factory;
  if (!factory) return log("The new vault is not available yet.", "err");
  const open = await openOrdersIn(v);
  const carry = open; // every open order is placed again in the new vault, at the same price
  const bal = await read(v, "balance");
  const amt = bal.ok ? BigInt(bal.value) : 0n;
  const target = sell ? await sellVaultOf() : vault;
  const steps = open.length + 1 + (target ? 0 : 1) + 1 + carry.length;
  const rows = [
    ["From", `Old ${sell ? "sell" : "buy"} vault ${short(v)}`],
    ["Amount", `${fmt(amt, 2)} ${exchange ? "old test USDC (Blend)" : tok} (interest included)`],
    ["To", target ? `Your new ${sell ? "sell" : "buy"} vault ${short(target)}` : `A new ${sell ? "sell" : "buy"} vault, opened for you`],
  ];
  if (open.length) {
    const px = (o) => (sell ? `≥ ${px4(sellPrice(o.limit))}` : `≤ ${fmt(o.limit)}`);
    rows.push([
      "Open orders",
      `${carry.length} placed again at the same price: ${carry.map((o) => `${fmt(o.leftU, 2)} ${tok} at ${px(o)}`).join(", ")}`,
    ]);
  }
  if (exchange) rows.push(["Exchange", "Your old test USDC is exchanged 1:1 for Circle's test USDC (the USDC Iora uses now) and deposited in your new vault."]);
  const notes = [
    `You'll approve ${steps + (exchange ? 1 : 0)} steps in your wallet: ${open.length ? "cancel the old orders, " : ""}withdraw${exchange ? ", return the old test USDC to its issuer" : ""}${target ? "" : ", open the new vault"}, deposit${carry.length ? ", then place your orders again" : ""}.`,
    "The money only ever moves between your own vaults and your wallet. If you stop halfway, it stays safe in your wallet.",
  ];
  if (!(await ask({ title: `Move to your new ${sell ? "sell" : "buy"} vault`, rows, notes, confirm: "Start" }))) return;

  let got = await drainLegacy(v, tok, coin, exchange ? "old test USDC (Blend)" : tok);
  if (got === null) return refresh();
  if (exchange) {
    got = await exchangeOldUsdc(got);
    if (got === null) return refresh();
  }
  let dest = target;
  if (!dest) {
    if (!(await call(factory, "create_vault", [addr(me)], `Open new ${sell ? "sell" : "buy"} vault`, FACTORY_ERRORS))) return refresh();
    const r = await read(factory, "vault_of", [addr(me)]);
    dest = r.ok && r.value ? (sell ? wrapSell(r.value, factory) : wrapBuy(r.value, factory)) : null;
    if (!dest) {
      log("The new vault was opened but could not be read yet. Your money is in your wallet; deposit it from the vault page.", "err");
      return refresh();
    }
    if (sell) SV.vault = dest;
  }
  // for XLM, leave at least 5 XLM in the wallet for network fees
  let dep = got;
  if (sell && walletXlm !== null) {
    const w = await read(C.xlm, "balance", [addr(me)]);
    const room = w.ok ? BigInt(w.value) - XLM_KEEP : got;
    if (room < dep) dep = room;
  }
  if (dep > 0n) {
    const ok = await call(dest, "deposit", [i128(dep)], `Deposit ${fmt(dep, 2)} ${tok} into your new vault`, sell ? SELL_ERRORS : VAULT_ERRORS);
    if (!ok) return refresh();
    // Reopen the orders in the new vault with the same price and remaining amount
    let placed = 0;
    await vaultVersion(dest).catch(() => 0);
    for (const [i, o] of carry.entries()) {
      const expiry = expiryOf(dest, OLD_VAULT_DAYS);
      const room = (await roomIn(dest)) ?? o.leftU;
      const size = o.leftU < room ? o.leftU : room;
      if (size <= 0n) break;
      const mf = fillFloor(size, o.minFill < size ? o.minFill : size);
      const label = `Place order ${i + 1}/${carry.length} again`;
      const errs = sell ? SELL_ERRORS : VAULT_ERRORS;
      const r =
        o.trigger > 0n
          ? await call(dest, "place_stop_order", [i128(size), i128(o.trigger), i128(o.limit), i128(mf), u32(o.impact), u64(expiry), ...(V4 ? [u32(o.band || SL_BAND_BPS)] : [])], label, errs)
          : await call(dest, "place_order", [i128(size), i128(o.limit), i128(mf), u32(o.impact), u64(expiry)], label, errs);
      if (!r) break;
      placed++;
    }
    log(
      `Done: ${fmt(dep, 2)} ${tok} moved to your new ${sell ? "sell" : "buy"} vault and earning on Blend` +
        (carry.length ? `; ${placed} of ${carry.length} order${carry.length > 1 ? "s" : ""} placed again.` : "."),
      placed === carry.length ? "ok" : "err",
    );
  }
  await refresh();
  if (sell) await refreshSell();
}

// Portfolio summary: with both vaults, the total balance, total interest (in USDC) and open orders
let homeSell = { me: null, v: null };
/** The default (XLM -> USDC) sell vault; returned even while an extra market is open. */
async function homeSellVault() {
  if (!SV.home || !me) return null;
  if (homeSell.me === me && homeSell.v) return homeSell.v;
  const r = await read(SV.home, "vault_of", [addr(me)]);
  homeSell = { me, v: r.ok && r.value ? wrapSell(r.value, SV.home) : null };
  return homeSell.v;
}
/** Portfolio page: the two vaults' total, the part tied to orders, interest earned and open orders. Reads only while the page is open. */
let pfBusy = false;
let pfTab = "bal";
async function renderPortfolio() {
  const box = $("pfolio");
  if (!box || !me || document.body.dataset.view !== "portfolio" || pfBusy) return;
  pfBusy = true;
  try {
    const who = me;
    const sv = await homeSellVault();
    const rd = async (v) => {
      if (!v) return null;
      const [bal, res, free, st] = await Promise.all([read(v, "balance"), read(v, "reserved"), read(v, "free_balance"), read(v, "stats")]);
      if (!bal.ok) return null;
      const n = (x) => (x.ok ? Number(BigInt(x.value)) / 1e7 : 0);
      let earned = 0;
      if (st.ok && st.value) {
        const e = BigInt(bal.value) + BigInt(st.value.total_withdrawn) + BigInt(st.value.total_spent) - BigInt(st.value.total_deposited);
        earned = e > 0n ? Number(e) / 1e7 : 0;
      }
      return { bal: n(bal), res: n(res), free: n(free), earned };
    };
    // Single vault: coins other than the selected pair sit in the same vault; they are listed and added to the total
    // too. Asked together with the reads below (it used to follow them, one round later).
    const rv = sideOf(vault) || sideOf(sv);
    const positions = rv && PAIRS.length ? rawRead(rv.id, "positions") : null;
    if (positions) positions.catch(() => {}); // read below; a failure is reported there, once
    const [b, s, bo, so, xp] = await Promise.all([
      rd(vault),
      rd(sv),
      vault ? openOrdersIn(vault) : [],
      sv ? openOrdersIn(sv) : [],
      SV.apr === null ? readXlmPool() : null,
    ]);
    if (who !== me) return;
    let others = [];
    if (positions) {
      const ps = await positions;
      if (ps.ok && Array.isArray(ps.value)) {
        const known = [{ sym: "XLM", token: C.xlm }, ...PAIRS];
        others = (
          await Promise.all(
            ps.value.map(async (p) => {
              const t = String(p.token);
              const k = known.find((x) => x.token === t);
              if (!k || t === BASE.addr || BigInt(p.balance) <= 0n) return null;
              const q = await read(C.router, "router_get_amounts_out", [i128(U), addrVec([C.usdc, t])]);
              const out = q.ok ? Number(BigInt(q.value[q.value.length - 1])) : 0;
              const opx = out > 0 ? 1e7 / out : null;
              const bal = Number(BigInt(p.balance)) / 1e7, res = Number(BigInt(p.reserved)) / 1e7;
              return { sym: k.sym, bal, res, usd: opx ? bal * opx : null, resUsd: opx ? res * opx : 0 };
            }),
          )
        ).filter(Boolean);
      }
      if (who !== me) return;
    }
    if (!b && !s) {
      $("pf-orders").innerHTML = "";
      box.innerHTML = `<div class="pf-empty"><p>You have no vault yet. Open one on the Trade page with one signature, deposit, and it starts earning.</p><a class="btn primary" href="#vault">Go to Trade</a></div>`;
      return;
    }
    const px = marketPrice || (TR.key === C.usdc && TR.spot) || SV.mkt || 0;
    const n = (v, d = 2) => v.toLocaleString("en-US", { minimumFractionDigits: d === 2 ? 2 : 0, maximumFractionDigits: d });
    const pct = (a) => (a !== null && a !== undefined ? `${(a * 100).toFixed(2)}%` : "—");
    const xApr = SV.apr !== null ? SV.apr : xp ? xp.apr : null;
    const total = (b ? b.bal : 0) + (s ? s.bal * px : 0) + others.reduce((a, o) => a + (o.usd || 0), 0);
    const tied = (b ? b.res : 0) + (s ? s.res * px : 0) + others.reduce((a, o) => a + o.resUsd, 0);
    const earned = (b ? b.earned : 0) + (s ? s.earned * px : 0);
    const orders = [
      ...bo.map((o) => `<tr><td><span class="tag buy">Buy</span></td><td>${BS} / USDC</td><td class="num">≤ ${px4(Number(o.limit) / 1e7)}</td><td class="num">${n(o.left)} USDC</td><td><a href="#vault">Manage</a></td></tr>`),
      ...so.map((o) => `<tr><td><span class="tag sell">${o.trigger > 0n ? "Stop" : "Sell"}</span></td><td>${BS} / USDC</td><td class="num">${o.trigger > 0n ? `≤ ${px4(sellPrice(o.trigger))}` : `≥ ${px4(sellPrice(o.limit))}`}</td><td class="num">${n(o.left)} ${BS}</td><td><a href="#sell">Manage</a></td></tr>`),
    ];
    // Single vault: open orders of every pair, not only the selected one
    let nBuy = bo.length, nSell = so.length;
    const dcaRows = [];
    if (rv) {
      const all = await allOpenOrders(rv.id).catch(() => null);
      if (who !== me) return;
      if (all) {
        orders.length = 0;
        nBuy = nSell = 0;
        // scheduled orders (DCA) get their own tab; the schedule is stored beside the order
        if ((await vaultVersion(vault || SV.vault || sv)) >= 11) {
          const scs = await Promise.all(all.map((o) => rawRead(rv.id, "get_schedule", [u32(o.id)]).catch(() => ({ ok: false }))));
          if (who !== me) return;
          scs.forEach((r, i) => (all[i].sc = r.ok && r.value ? r.value : null));
        }
        for (const o of all) {
          if (o.sc) {
            const buying = o.sell === C.usdc;
            const coin = coinSym(buying ? o.buy : o.sell);
            const wait = Number(o.sc.next) - Date.now() / 1000;
            dcaRows.push(
              `<tr><td><span class="tag ${buying ? "buy" : "sell"}">${buying ? "Buy" : "Sell"}</span></td><td>${esc(coin)} / USDC</td><td class="num">${fmt(o.sc.part, buying || o.sell === C.xlm ? 2 : 7)} ${esc(coinSym(o.sell))}</td><td class="num">every ${dcaSpan(Number(o.sc.every))}</td><td class="num">${Number(o.sc.done)}${Number(o.sc.fills) ? ` of ${Number(o.sc.fills)}` : ""}</td><td class="num">${wait <= 0 ? "due now" : `in ${dcaSpan(wait)}`}</td><td class="num">${o.limit >= DCA_NO_LIMIT ? "any" : buying ? `≤ ${px4(Number(o.limit) / 1e7)}` : `≥ ${px4(sellPrice(o.limit))}`}</td><td class="pf-row-acts"><a href="${buying ? "#vault" : "#sell"}" data-base="${esc(coin)}" data-go="${buying ? "#vault" : "#sell"}">Manage</a></td></tr>`,
            );
            continue;
          }
          const buying = o.sell === C.usdc;
          const coin = coinSym(buying ? o.buy : o.sell);
          const any = o.limit >= DCA_NO_LIMIT;
          if (buying) nBuy++;
          else nSell++;
          orders.push(
            `<tr><td><span class="tag ${buying ? "buy" : "sell"}">${buying ? "Buy" : o.trigger > 0n ? "Stop" : "Sell"}</span></td><td>${esc(coin)} / USDC</td><td class="num">${any ? "any" : buying ? `≤ ${px4(Number(o.limit) / 1e7)}` : o.trigger > 0n ? `≤ ${px4(sellPrice(o.trigger))}` : `≥ ${px4(sellPrice(o.limit))}`}</td><td class="num">${fmt(o.left, buying || o.sell === C.xlm ? 2 : 7)} ${esc(coinSym(o.sell))}</td><td><a href="${buying ? "#vault" : "#sell"}" data-base="${esc(coin)}" data-go="${buying ? "#vault" : "#sell"}">Manage</a></td></tr>`,
          );
        }
      }
    }
    const vid = realId(vault || SV.vault || sv || "");
    const wal = (walletUsdc !== null ? Number(walletUsdc) / 1e7 : 0) + (walletXlm !== null ? (Number(walletXlm) / 1e7) * px : 0);
    box.innerHTML = `
      <div class="pf-top">
        <div class="pf-kpis">
          <section class="pf-box pf-kpi"><span>Vault value</span><b>≈ ${n(total)} <small>USDC</small></b>${vid ? `<small><a href="${EXPLORER}/contract/${vid}" target="_blank" rel="noopener">Vault ${short(vid)}</a> · <button type="button" class="link" id="pf-copy">${COPY_LABEL}</button></small>` : ""}</section>
          <section class="pf-box pf-kpi"><span>Interest earned</span><b class="pos">≈ +${n(earned, 4)} <small>USDC</small></b><small>${supplyApr !== null ? `USDC earns ${pct(supplyApr)} a year now` : "since you opened the vault"}</small></section>
        </div>
        <section class="pf-box pf-sum">
          <div class="pf-sum-head"><span>Your vault</span><span class="muted">All coins, valued in USDC</span></div>
          <dl>
            <div><dt>Total</dt><dd>≈ ${n(total)} USDC</dd></div>
            <div><dt>In open orders</dt><dd>≈ ${n(tied)} USDC</dd></div>
            <div><dt>Available</dt><dd>≈ ${n(Math.max(0, total - tied))} USDC</dd></div>
            <div><dt>Open orders</dt><dd>${nBuy + nSell} <span class="muted">(${nBuy} buy, ${nSell} sell)</span></dd></div>
            <div><dt>In your wallet</dt><dd>≈ ${n(wal)} USDC</dd></div>
          </dl>
        </section>
        <section class="pf-box pf-chart" id="pf-chart"></section>
      </div>`;
    pfChartDraw(pfhAdd(total, earned));
    const cp = $("pf-copy");
    if (cp) cp.onclick = () => navigator.clipboard && navigator.clipboard.writeText(vid).then(() => copied(cp));
    // Balances: one row per coin the vault holds (USDC always); a coin that is not held is not listed
    const balRow = (sym, bal, usd, res, apr, earnedTxt, acts) =>
      `<tr><td><span class="pf-asset">${coinI(sym)}${esc(sym)}</span></td><td class="num">${nfmt(bal, 4)}</td><td class="num">${usd === null ? "—" : `≈ ${n(usd)}`}</td><td class="num">${nfmt(res, 4)}</td><td class="num">${nfmt(Math.max(0, bal - res), 4)}</td><td class="num pos">${apr}</td><td class="num pos">${earnedTxt}</td><td class="pf-row-acts">${acts}</td></tr>`;
    const act = (label, coin, mode) => `<button type="button" class="link" data-move="${mode}" data-coin="${esc(coin)}">${label}</button>`;
    const trade = (coin) => `<a href="#vault" data-base="${esc(coin)}" data-go="#vault">Trade</a>`;
    const balRows = [
      b ? balRow("USDC", b.bal, b.bal, b.res, pct(supplyApr), `+${n(b.earned, 6)}`, act("Deposit", "USDC", "dep") + act("Withdraw", "USDC", "wd")) : "",
      s && (s.bal > 0 || s.res > 0) ? balRow(BS, s.bal, px ? s.bal * px : null, s.res, XB ? "—" : pct(xApr), XB ? "—" : `+${n(s.earned, 6)}`, act("Deposit", BS, "dep") + act("Withdraw", BS, "wd") + trade(BS)) : "",
      ...others.map((o) => balRow(o.sym, o.bal, o.usd, o.res, "—", "—", act("Deposit", o.sym, "dep") + act("Withdraw", o.sym, "wd") + trade(o.sym))),
    ].join("");
    const tab = ["orders", "dca"].includes(pfTab) ? pfTab : "bal";
    $("pf-orders").innerHTML = `
      <section class="pf-box pf-deck">
        <div class="pf-tabs" role="tablist"><button type="button" role="tab" data-pft="bal" aria-selected="${tab === "bal"}">Balances</button><button type="button" role="tab" data-pft="orders" aria-selected="${tab === "orders"}">Open orders · ${nBuy + nSell}</button><button type="button" role="tab" data-pft="dca" aria-selected="${tab === "dca"}">DCA · ${dcaRows.length}</button></div>
        <div data-pfp="bal"${tab === "bal" ? "" : " hidden"}><div class="table-wrap"><table class="pf-t"><thead><tr><th>Coin</th><th class="num">Balance</th><th class="num">Value in USDC</th><th class="num">In open orders</th><th class="num">Available</th><th class="num">Earns</th><th class="num">Interest earned</th><th></th></tr></thead><tbody>${balRows}</tbody></table></div></div>
        <div data-pfp="orders"${tab === "orders" ? "" : " hidden"}>${
          orders.length
            ? `<div class="table-wrap"><table class="pf-t"><thead><tr><th>Side</th><th>Market</th><th class="num">Price</th><th class="num">Still waiting</th><th></th></tr></thead><tbody>${orders.join("")}</tbody></table></div>`
            : `<p class="muted pf-none">No open orders. Place one on the <a href="#vault">Trade</a> page; it earns while it waits.</p>`
        }</div>
        <div data-pfp="dca"${tab === "dca" ? "" : " hidden"}>${
          dcaRows.length
            ? `<div class="table-wrap"><table class="pf-t"><thead><tr><th>Side</th><th>Market</th><th class="num">Each time</th><th class="num">How often</th><th class="num">Done</th><th class="num">Next</th><th class="num">Price</th><th></th></tr></thead><tbody>${dcaRows.join("")}</tbody></table></div>`
            : `<p class="muted pf-none">No DCA plans. Start one on the <a href="#vault">Trade</a> page, in the DCA tab of the order form.</p>`
        }</div>
      </section>
      <p class="fine">Values in USDC use the current market price${px ? ` (1 ${BS} = ${px4(px)} USDC)` : ""}.${V7 ? "" : " Showcase markets are not included."}</p>`;
    for (const t of $("pf-orders").querySelectorAll("[data-pft]")) {
      t.onclick = () => {
        pfTab = t.dataset.pft;
        for (const o of $("pf-orders").querySelectorAll("[data-pft]")) o.setAttribute("aria-selected", String(o === t));
        for (const p of $("pf-orders").querySelectorAll("[data-pfp]")) p.hidden = p.dataset.pfp !== pfTab;
      };
    }
    for (const m of $("pf-orders").querySelectorAll("[data-move]")) m.onclick = () => pickMoveCoin(m.dataset.coin, m.dataset.move);
    for (const a of $("pf-orders").querySelectorAll("a[data-base]")) {
      a.onclick = (e) => {
        e.preventDefault();
        setBase(a.dataset.base, a.dataset.go || "#vault");
      };
    }
    genNote();
  } catch (e) {
    console.warn("portfolio", e);
  } finally {
    pfBusy = false;
  }
}

async function refreshBuy() {
  if (!me) return;
  await pickGeneration();
  // Account check and the first reads at the same time: every RPC round adds to the wait.
  const [acct, xlmBal, usdcBal, q, vaultOf, baseBal] = await Promise.all([
    server.accountExists(me).catch(() => false),
    read(C.xlm, "balance", [addr(me)]),
    read(C.usdc, "balance", [addr(me)]),
    read(C.router, "router_get_amounts_out", [i128(U), addrVec([C.usdc, BASE.addr])]),
    read(C.factory, "vault_of", [addr(me)]),
    XB ? read(BASE.addr, "balance", [addr(me)]) : null,
  ]);
  // The SDK reports every case where the account cannot be read (network errors included) as "Account not found". If
  // the wallet shows XLM the account exists: it must not say "this wallet is not on testnet" by mistake.
  const exists = acct || (xlmBal.ok && BigInt(xlmBal.value) > 0n);
  if (!exists) {
    mark("funded", false);
    $("wallet").innerHTML = `<p class="warn">This wallet does not exist on testnet yet. Open <a href="#faucet">Test funds</a> and get free test XLM.</p>`;
    walletXlm = 0n;
    walletNative = 0n;
    walletUsdc = null;
    renderFaucet(false, false);
    return;
  }

  const hasTrust = usdcBal.ok;
  mark("funded", true);
  mark("trust", hasTrust);
  walletUsdc = hasTrust ? BigInt(usdcBal.value) : null;
  $("wallet-usdc").textContent = walletUsdc !== null ? fmt(walletUsdc, 2) : "—";
  $("wallet").innerHTML = `
    <dl>
      <dt>Address</dt><dd><a href="${EXPLORER}/account/${me}" target="_blank" rel="noopener">${short(me)}</a></dd>
      <dt>XLM</dt><dd>${xlmBal.ok ? fmt(xlmBal.value, 2) : "—"}</dd>
      <dt>USDC</dt><dd>${hasTrust ? fmt(usdcBal.value, 2) : "no trustline"}</dd>${XB ? `
      <dt>${BS}</dt><dd>${baseBal && baseBal.ok ? fmt(baseBal.value, 4) : "0"}</dd>` : ""}
    </dl>`;
  walletNative = xlmBal.ok ? BigInt(xlmBal.value) : 0n;
  // walletXlm = the wallet's balance of the traded coin (XLM itself for the XLM pair)
  walletXlm = XB ? (baseBal && baseBal.ok ? BigInt(baseBal.value) : 0n) : walletNative;
  renderWalletHints();
  renderFaucet(true, hasTrust);
  quoteSwap();

  // The market price shown is the best one across the venues the keeper fills on (the Soroswap pool or an
  // Aquarius pool), for a small reference trade: an order fills where the price is best, so that is the price
  // a limit should be compared with.
  // It is worked out beside the vault reads below, not before them: the vault's numbers do not wait for a price.
  const pricing = (async () => {
    let refOut = q.ok ? BigInt(q.value[q.value.length - 1]) : null;
    const quotes = [{ venue: "Soroswap", price: refOut ? Number(U) / Number(refOut) : null }];
    try {
      const aq = await aquaBest(C.usdc, BASE.addr, U);
      if (aq && aq.out > 0n) quotes.push({ venue: "Aquarius", price: Number(U) / Number(aq.out) });
      if (aq && (refOut === null || aq.out > refOut)) refOut = aq.out;
    } catch {}
    PX.buy = quotes;
    await refPrice(BASE.addr);
    paintPriceSources();
    if (refOut !== null && refOut > 0n) {
      const out = refOut;
      marketPrice = Number(U) / Number(out);
      $("market").textContent = `Market ${marketPrice.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
      $("m-price").textContent = marketPrice.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
      paintMkPrice();
      renderLadder();
      updateGauge();
    }
  })().catch((e) => console.warn("price", e));

  readPool();
  vault = vaultOf.ok && vaultOf.value ? wrapBuy(vaultOf.value) : null;
  loadFeeCap(vault);
  mark("usdc", (hasTrust && BigInt(usdcBal.value) > 0n) || !!vault);
  mark("vault", !!vault);
  if (!vault) {
    $("vault").innerHTML = "";
    $("stats").innerHTML = "";
    $("novault").hidden = false;
    document.body.classList.remove("has-vault");
    $("orders").innerHTML = "";
    await pricing;
    return;
  }
  $("novault").hidden = true;
  document.body.classList.add("has-vault");

  const [bal, res, free, st] = await Promise.all([
    read(vault, "balance"),
    read(vault, "reserved"),
    read(vault, "free_balance"),
    read(vault, "stats"),
    vaultVersion(vault).catch(() => 0), // needed before the first order: the version decides how an order is placed (see noEnd)
  ]);
  // Lifetime interest = balance + withdrawn + spent - deposited
  let earned = null;
  if (bal.ok && st.ok && st.value) {
    const v = st.value;
    earned = BigInt(bal.value) + BigInt(v.total_withdrawn) + BigInt(v.total_spent) - BigInt(v.total_deposited);
  }
  $("vault").innerHTML = `<span class="muted">Vault</span> <a href="${EXPLORER}/contract/${realId(vault)}" target="_blank" rel="noopener">${short(vault)}</a> <button class="small ghost" id="copyvault" title="Copy full address">${COPY_LABEL}</button>`;
  $("stats").innerHTML = `
    <div class="tile"><span>Balance on Blend ${tip("Everything in your vault: what you deposited plus the interest it has earned, read live from Blend.")}</span><b><i id="v-bal">—</i> <small>USDC</small></b></div>
    <div class="tile earn"><span>Interest earned ${tip("Total interest since you opened the vault, including interest on money already spent or withdrawn.")}</span><b><i id="v-int">—</i> <small>USDC</small></b></div>
    <div class="tile"><span>Reserved for orders ${tip("Set aside for your open orders. It keeps earning until an order spends it. Cancel an order to free its part.")}</span><b><i id="v-res">—</i> <small>USDC</small></b></div>
    <div class="tile main"><span>Available ${tip("What you can withdraw now or use for a new order.")}</span><b><i id="v-free">—</i> <small>USDC</small></b></div>`;
  if (res.ok) countTo("v-res", Number(BigInt(res.value)) / 1e7, 2);
  if (bal.ok) countTo("v-bal", Number(BigInt(bal.value)) / 1e7, 4);
  if (earned !== null) countTo("v-int", Number(earned > 0n ? earned : 0n) / 1e7, 6);
  if (free.ok) countTo("v-free", Number(BigInt(free.value)) / 1e7, 4);
  freeUnits = free.ok ? BigInt(free.value) : null;
  reservedUnits = res.ok ? BigInt(res.value) : null;
  balanceUnits = bal.ok ? BigInt(bal.value) : null;
  renderAlloc();
  $("avail-buy").textContent = freeUnits !== null ? fmt(freeUnits, 2) : "—";
  $("avail-wd").textContent = freeUnits !== null ? fmt(freeUnits, 2) : "—";
  mark("deposit", st.ok && st.value && BigInt(st.value.total_deposited) > 0n);

  $("copyvault").onclick = async () => {
    try {
      await navigator.clipboard.writeText(vault);
      copied($("copyvault"));
    } catch {
      log(`Vault address: ${vault}`);
    }
  };
  // Orders first; the transaction history (events) and the summary follow, the screen does not wait for them. When
  // the history arrives the "earned while waiting" column is updated without reading the orders again.
  await renderOrders();
  await pricing; // whoever called this reads the market price next
  const v0 = vault;
  renderHistory()
    .then(() => vault === v0 && paintOrders())
    .catch((e) => console.warn("history", e));
  renderSummary(st.ok ? st.value : null).catch((e) => console.warn("summary", e));
}

// Price ladder: shows the distance between the market price and the limit.
function updateGauge() {
  const g = $("gauge");
  const limit = Number(String($("olimit").value).trim().replace(",", "."));
  const p4 = (n) => n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  if (!marketPrice) {
    g.hidden = true;
    return;
  }
  g.hidden = false;
  const hasLimit = limit > 0 && Number.isFinite(limit);
  const lo = Math.min(marketPrice, hasLimit ? limit : marketPrice) * 0.82;
  const hi = Math.max(marketPrice, hasLimit ? limit : marketPrice) * 1.12;
  const pos = (v) => `${(((v - lo) / (hi - lo)) * 100).toFixed(2)}%`;
  g.style.setProperty("--market", pos(marketPrice));
  $("gauge-market-v").textContent = p4(marketPrice);
  g.classList.toggle("no-limit", !hasLimit);
  if (!hasLimit) {
    $("gauge-note").textContent = "Enter a limit to see how far the price has to move.";
    return;
  }
  g.style.setProperty("--limit", pos(limit));
  $("gauge-limit-v").textContent = p4(limit);
  const drop = (1 - limit / marketPrice) * 100;
  g.classList.toggle("now", drop <= 0);
  $("gauge-note").textContent =
    drop <= 0
      ? "Your limit is at or above the market price, so the keeper can fill it on its next scan."
      : `${BS} has to fall ${drop.toFixed(1)}% to reach your limit. Until then the USDC keeps earning on Blend.`;
}

/**
 * Network fees over the wallet's last 200 transactions, from Horizon. The list is about 0.8 MB, so it is not
 * fetched on every refresh: once per wallet, again after this page has sent a transaction, or after ten minutes.
 */
function walletFees() {
  const who = me;
  if (FEES.who === who && !FEES.stale && Date.now() - FEES.at < 600_000) return Promise.resolve(FEES.sum);
  if (FEES.asking && FEES.asking.who === who) return FEES.asking.p;
  FEES.stale = false;
  const p = fetch(`https://horizon-testnet.stellar.org/accounts/${who}/transactions?limit=200&order=desc`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (!j) throw new Error("no answer");
      const sum = j._embedded.records.reduce((a, t) => a + BigInt(t.fee_charged), 0n);
      Object.assign(FEES, { who, at: Date.now(), sum });
      return sum;
    })
    .catch(() => {
      FEES.stale = true; // not read: the next refresh asks again; meanwhile the last known total stays
      return FEES.who === who ? FEES.sum : null;
    })
    .finally(() => {
      if (FEES.asking && FEES.asking.p === p) FEES.asking = null;
    });
  FEES.asking = { who, p };
  return p;
}
async function renderSummary(st) {
  const fees = await walletFees();
  const spent = st ? BigInt(st.total_spent) : 0n;
  const got = st ? BigInt(st.total_received) : 0n;
  const avg = got > 0n ? (Number(spent) / Number(got)).toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—";
  $("summary").innerHTML = `
    <dl>
      <dt>Total deposited</dt><dd>${st ? fmt(st.total_deposited, 2) : "—"} USDC</dd>
      <dt>Total withdrawn</dt><dd>${st ? fmt(st.total_withdrawn, 2) : "—"} USDC</dd>
      <dt>Spent on orders</dt><dd>${fmt(spent, 2)} USDC</dd>
      <dt>Received</dt><dd>${fmt(got, 2)} ${BS}</dd>
      <dt>Average buy price</dt><dd>${avg} USDC/${BS}</dd>
      <dt>Network fees you paid</dt><dd>${fees !== null ? fmt(fees, 5) : "—"} XLM</dd>
      <dt>Keeper fee</dt><dd>none (testnet)</dd>
    </dl>`;
}

const EVENT_LABEL = {
  deposited: (d) => `Deposit <b>+${fmt(d.amount, 2)} USDC</b>`,
  withdrawn: (d) => `Withdrawal <b>−${fmt(d.amount, 4)} USDC</b>`,
  order_placed: (d, t) => `Order #${t} placed: ${fmt(d.amount_in, 2)} USDC, limit ${fmt(d.limit_price)}`,
  order_cancelled: (d, t) => `Order #${t} cancelled, ${fmt(d.remaining, 2)} USDC released`,
  order_filled: (d, t) =>
    `Order #${t} filled: ${fmt(d.amount_in, 2)} USDC → <b>${fmt(d.amount_out, 2)} ${BS}</b> (price ${(Number(BigInt(d.amount_in)) / Number(BigInt(d.amount_out))).toLocaleString("en-US", { maximumFractionDigits: 4 })})`,
};

async function renderHistory() {
  const events = await fetchVaultEvents();
  const items = [];
  // Version 7: events of both sides arrive together in the same vault; this list shows only this side's.
  const side = sideOf(vault);
  const own = side ? new Set((await readOrders(vault)).map((o) => o.id)) : null;
  for (const ev of events) {
    try {
      const topics = (ev.topic || []).map((t) => scValToNative(t));
      const name = String(topics[0]);
      const fn = EVENT_LABEL[name];
      if (!fn) continue;
      if (side) {
        if (name === "deposited" || name === "withdrawn") {
          if (String(topics[1]) !== side.s) continue;
        } else if (!own.has(Number(topics[1]))) continue;
      }
      const data = scValToNative(ev.value);
      const when = ev.ledgerClosedAt ? new Date(ev.ledgerClosedAt).toLocaleString("en-US") : "";
      // Order times: for estimating the interest earned while waiting
      const ts = ev.ledgerClosedAt ? Date.parse(ev.ledgerClosedAt) / 1000 : null;
      const oid = topics[1] !== undefined ? Number(topics[1]) : null;
      if (ts && oid !== null) {
        if (name === "order_placed") orderTimes[oid] = { ...(orderTimes[oid] || {}), placed: ts };
        if (name === "order_filled" || name === "order_cancelled") orderTimes[oid] = { ...(orderTimes[oid] || {}), ended: ts };
      }
      items.push(`<li><time>${when}</time> ${fn(data, topics[1])} · <a href="${EXPLORER}/tx/${ev.txHash}" target="_blank" rel="noopener">transaction</a></li>`);
    } catch {}
  }
  $("history").innerHTML = items.length
    ? `<ul class="history">${items.reverse().join("")}</ul>`
    : `<p class="muted">No activity yet. (The network keeps the last few days of events.)</p>`;
}

// A filled or cancelled order never changes again: it is not read again on every refresh (the RPC load must not
// grow with the number of orders). Open orders are read from the chain every time.
const doneOrders = new Map(); // "vault:id" -> order
const doneFollowUps = new Map(); // "vault:id" -> automatic sell setting (or null)
const orderStatus = (o) => (Array.isArray(o.status) ? o.status[0] : o.status?.tag || String(o.status));
async function readOrders(v) {
  const cnt = await read(v, "order_count");
  const n = cnt.ok ? Number(cnt.value) : 0;
  const reads = await Promise.all(
    [...Array(n).keys()].map(async (id) => {
      const k = `${v}:${id}`;
      if (doneOrders.has(k)) return { ok: true, value: doneOrders.get(k) };
      const r = await read(v, "get_order", [u32(id)]);
      if (r.ok && ["Filled", "Cancelled"].includes(orderStatus(r.value))) doneOrders.set(k, r.value);
      return r;
    }),
  );
  const rows = [];
  reads.forEach((r, id) => r.ok && !r.value.foreign && rows.push({ id, ...r.value }));
  await attachSchedules(v, rows);
  return rows;
}

// ---------------------------------------------------------------------------
// Scheduled orders (DCA), version 11 vaults
// ---------------------------------------------------------------------------
// A DCA order is an ordinary order with a schedule: it holds one part at a time, fills one part per interval and
// reserves the next part itself while the vault can cover it. `get_schedule` tells which orders are DCA.
const DCA_NO_LIMIT = U * 1_000_000_000n; // the contract's highest price: "no price limit" (the oracle band protects instead)
const DCA_BAND_BPS = 300; // without a price limit every part must be within 3% of the oracle price
const DCA_MIN_EVERY = 60;
const DCA_MAX_EVERY = 28 * 86400;
// An order stays open until it fills or its owner cancels it. Version 12 vaults have no end time at all. A vault
// of an earlier version cannot hold an order for more than a year, so there the app asks for the longest the
// contract accepts.
const OLD_VAULT_DAYS = 365;
const DCA_DAYS = OLD_VAULT_DAYS;
const NO_EXPIRY = 18446744073709551615n;
/** True for a vault whose orders have no end time. The version must have been read (vaultVersion) before this is asked. */
const noEnd = (v) => (vaultVer.get(sideOf(v)?.id) || 0) >= 12;
/** The `expiry` argument for a new order in vault `v`: none where the vault allows it, otherwise `days` from now. */
const expiryOf = (v, days) => (noEnd(v) ? NO_EXPIRY : Math.floor(Date.now() / 1000) + Math.round(days * 86400));
/** How long the sell order of a take profit lives, in seconds (counted from the fill). */
const autoSecs = (v) => (noEnd(v) ? 100 * 365 * 86400 : AUTO_DAYS * 86400);
/** Review boxes: said about the sell order of a take profit where the vault keeps it without an end time. */
const autoSpan = (v) => (noEnd(v) ? "open until you cancel" : "");
const vaultVer = new Map(); // vault address -> version (0: older than 8)
const doneSchedules = new Map(); // "vault:id" -> schedule | null, for orders that can no longer change
async function vaultVersion(v) {
  const h = sideOf(v);
  if (!h) return 0;
  if (vaultVer.has(h.id)) return vaultVer.get(h.id);
  const r = await rawRead(h.id, "version");
  const n = r.ok ? Number(r.value) : 0;
  if (r.ok) vaultVer.set(h.id, n);
  return n;
}
async function attachSchedules(v, rows) {
  if (!rows.length || (await vaultVersion(v)) < 11) return;
  await Promise.all(
    rows.map(async (o) => {
      const k = `${v}:${o.id}`;
      if (doneSchedules.has(k)) return void (o.dca = doneSchedules.get(k));
      const r = await read(v, "get_schedule", [u32(o.id)]);
      if (!r.ok) return;
      const s = r.value ? { every: Number(r.value.every), part: BigInt(r.value.part), fills: Number(r.value.fills), done: Number(r.value.done), next: Number(r.value.next) } : null;
      o.dca = s;
      if (!s || doneOrders.has(k)) doneSchedules.set(k, s);
    }),
  );
}
const dcaSpan = (sec) => {
  const f = (n, w) => `${+n.toFixed(1)} ${w}${+n.toFixed(1) === 1 ? "" : "s"}`;
  return sec < 3600 ? f(sec / 60, "minute") : sec < 86400 ? f(sec / 3600, "hour") : sec < 604800 ? f(sec / 86400, "day") : f(sec / 604800, "week");
};
/** Cells of a DCA order's row in the order lists (null for an ordinary order). */
function dcaCells(o, sym, sell, open) {
  const s = o.dca;
  if (!s) return null;
  const lim = BigInt(o.limit_price);
  const bound = lim >= DCA_NO_LIMIT ? "any price near the oracle price" : sell ? `≥ ${px4(sellPrice(lim))}` : `≤ ${fmt(lim)}`;
  const wait = s.next - Date.now() / 1000;
  const next = !open ? "" : wait <= 0 ? " · next: due now" : ` · next in ${dcaSpan(wait)}`;
  return {
    amt: `${fmt(s.part, 2)} ${esc(sym)}<span class="then-note">each time</span>`,
    lim: `<span class="tag dca">DCA</span> every ${dcaSpan(s.every)}<span class="then-note">${bound}${next}</span>`,
    prog: `${s.done}${s.fills ? ` of ${s.fills}` : ""} done`,
  };
}

let lastOrders = null; // { v, rows, fus }: the orders last read (to draw without reading again)
async function renderOrders() {
  const rows = await readOrders(vault);
  if (rows.length === 0) {
    lastOrders = null;
    openOrders = [];
    renderLadder();
    renderAlloc();
    $("orders-count").textContent = "";
    $("orders").innerHTML = `<p class="empty">No orders yet. Set a price in the order form and your first order will show up here.</p>`;
    tradeLinesSoon();
    return;
  }
  // Version 3: orders with the "buy, then sell automatically" setting
  const fus = new Map();
  if (V3.buy) {
    await Promise.all(
      rows.map(async (o) => {
        const k = `${vault}:${o.id}`;
        if (doneFollowUps.has(k)) {
          if (doneFollowUps.get(k)) fus.set(o.id, doneFollowUps.get(k));
          return;
        }
        const r = await read(vault, "get_follow_up", [u32(o.id)]);
        if (r.ok && r.value) fus.set(o.id, r.value);
        if (r.ok && doneOrders.has(k)) doneFollowUps.set(k, r.value || null);
      }),
    );
  }
  chainedOrders = fus;
  checkFills(rows);
  lastOrders = { v: vault, rows, fus };
  paintOrders();
  tradeLinesSoon();
}

function paintOrders() {
  if (!lastOrders || lastOrders.v !== vault) return;
  const { rows, fus } = lastOrders;
  let openCount = 0;
  let totalWait = 0;
  openOrders = [];
  const now = Date.now() / 1000;
  const html = [...rows]
    .reverse()
    .map((o) => {
      const status = Array.isArray(o.status) ? o.status[0] : o.status?.tag || String(o.status);
      const expired = status === "Open" && Number(o.expiry) < now;
      const label = expired ? "Ended" : { Open: "Open", Filled: "Filled", Cancelled: "Cancelled" }[status] || status;
      const filled = BigInt(o.filled_in);
      let avg = "—";
      if (filled > 0n) {
        const px = Number(filled) / Number(BigInt(o.filled_out));
        const better = (1 - px / (Number(BigInt(o.limit_price)) / 1e7)) * 100;
        avg = `${px.toLocaleString("en-US", { maximumFractionDigits: 4 })}${BigInt(o.limit_price) >= DCA_NO_LIMIT ? "" : ` <span class="muted">${better.toFixed(1)}% better</span>`}`;
      }
      const pct = Number((filled * 100n) / BigInt(o.amount_in));
      const d = dcaCells(o, "USDC", false, status === "Open" && !expired);
      if (status === "Open" && !expired) {
        openCount++;
        if (BigInt(o.limit_price) < DCA_NO_LIMIT) openOrders.push({ id: o.id, left: Number(BigInt(o.amount_in) - filled) / 1e7, limit: Number(BigInt(o.limit_price)) / 1e7, expiry: Number(o.expiry) });
      }
      // Waiting interest (estimate): at today's Blend rate, from when the order was placed until it filled or was cancelled
      const times = orderTimes[o.id] || {};
      let waitCell = `<span class="muted">—</span>`;
      if (supplyApr !== null && !times.placed && status === "Open") {
        const base0 = Number(BigInt(o.amount_in) - filled) / 1e7;
        waitCell = `<span class="earn-cell">+${((base0 * supplyApr) / 365).toLocaleString("en-US", { maximumFractionDigits: 4 })} / day</span><span class="muted">start time not found</span>`;
      }
      if (supplyApr !== null && times.placed) {
        const end = status === "Open" ? now : times.ended || now;
        const yrs = Math.max(0, end - times.placed) / (365 * 86400);
        const base = status === "Open" ? Number(BigInt(o.amount_in) - filled) / 1e7 : Number(BigInt(o.amount_in)) / 1e7;
        const est = base * supplyApr * yrs;
        totalWait += est;
        const perDay = status === "Open" ? (base * supplyApr) / 365 : 0;
        const estTxt = est > 0 && est < 0.000001 ? "< 0.000001" : est.toLocaleString("en-US", { minimumFractionDigits: 6, maximumFractionDigits: 6 });
        waitCell = `<span class="earn-cell">+${estTxt} USDC</span>${perDay ? `<span class="muted">+${perDay.toLocaleString("en-US", { maximumFractionDigits: 4 })} / day</span>` : ""}`;
      }
      return `<tr class="${status === "Open" && !expired ? "is-open" : "is-done"}">
        <td>#${o.id}</td>
        <td>${d ? d.amt : `${fmt(o.amount_in, 2)} USDC`}</td>
        <td>${d ? d.lim : `≤ ${fmt(o.limit_price)}`}${fus.has(o.id) ? `<span class="then-note">take profit ≥ ${px4(sellPrice(BigInt(fus.get(o.id).limit_price)))}</span>` : ""}</td>
        <td><div class="bar"><span style="width:${pct}%"></span></div>${d ? d.prog : `${pct}%`}<span class="muted">${fmt(o.filled_out, 2)} ${BS}</span></td>
        <td>${avg}</td>
        <td>${waitCell}</td>
        <td></td>
        <td><span class="tag ${status.toLowerCase()}${expired ? " expired" : ""}">${label}</span></td>
        <td>${status === "Open" ? `<button class="small ghost" data-cancel="${o.id}">Cancel</button>` : ""}${fus.has(o.id) ? "" : flipButton(o)}</td>
      </tr>`;
    })
    .join("");
  $("orders").innerHTML = `<table>
    <thead><tr><th>#</th><th>Amount</th><th>Limit</th><th>Filled</th><th>Avg. price</th><th>Earned waiting ${tip("Estimated interest the order's USDC earned on Blend while it waited, from when you placed it until it filled or was cancelled. Uses today's rate, so it is approximate.")}</th><th></th><th>Status</th><th></th></tr></thead>
    <tbody>${html}</tbody></table>`;
  $("orders-count").textContent = `(${openCount})`;
  waitEarned = totalWait;
  renderLadder();
  renderAlloc();
  for (const b of document.querySelectorAll("[data-cancel]")) {
    b.onclick = () => cancelOrder(Number(b.dataset.cancel));
  }
}

// ---------------------------------------------------------------------------
// User actions
// ---------------------------------------------------------------------------
async function addTrustline() {
  if (busy) return;
  busy = true;
  try {
    const account = await server.getAccount(me);
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASS })
      .addOperation(Operation.changeTrust({ asset: new Asset("USDC", C.usdcIssuer) }))
      .setTimeout(180)
      .build();
    log("USDC trustline: waiting for wallet approval…", "wait");
    const r = await signAndSend(tx, "USDC trustline");
    log(`USDC trustline added · <a href="${EXPLORER}/tx/${r.hash}" target="_blank" rel="noopener">transaction</a>`, "ok");
  } catch (e) {
    log(`Trustline: ${safeErr(e.message)}`, "err");
  } finally {
    busy = false;
    await refresh();
  }
}


function toUnitsSafe(v) {
  try {
    const n = toUnits(v);
    if (n <= 0n) throw new Error("Amount must be greater than zero");
    return n;
  } catch (e) {
    log(esc(e.message), "err");
    return null;
  }
}

async function createVault() {
  if (
    !(await ask({
      title: "Open your vault",
      lede: "A vault contract that only your wallet controls will be deployed for you.",
      rows: [["Network fee", "about 0.04 XLM, paid by your wallet"], ["Who can move funds", "Only you"]],
      confirm: "Open vault",
    }))
  )
    return;
  await call(C.factory, "create_vault", [addr(me)], "Open vault", FACTORY_ERRORS);
}

async function deposit() {
  const n = toUnitsSafe($("depamount").value);
  if (n === null) return;
  if (!poolGuard("USDC", n, "deposit")) return;
  await call(vault, "deposit", [i128(n)], `Deposit ${fmt(n, 2)} USDC`, VAULT_ERRORS);
}

async function withdraw() {
  let n;
  if ($("wdamount").value.trim() === "") {
    const f = await read(vault, "free_balance");
    if (!f.ok || BigInt(f.value) <= 0n) return log("No available balance to withdraw.", "err");
    n = BigInt(f.value);
    // Version 4: the "withdraw everything" special value also takes interest that accrued between signing and execution.
    if (V4) return void (await call(vault, "withdraw", [i128(I128_MAX)], `Withdraw all available (${fmt(n)} USDC)`, VAULT_ERRORS));
  } else {
    n = toUnitsSafe($("wdamount").value);
    if (n === null) return;
  }
  await call(vault, "withdraw", [i128(n)], `Withdraw ${fmt(n)} USDC`, VAULT_ERRORS);
}

/** Pool guard: a deposit or order is checked against what the pool can pay out at that moment and the utilisation limit. */
/**
 * Pool warning (it used to block; user decision 15 Nov 2026: do not block, like other platforms, only inform).
 * If the action is above a quarter of what the pool can pay out at that moment, or the pool is very full, the user gets a note;
 * the action always goes ahead (returns true). If the pool has no cash, withdrawals and fills wait in the contract anyway.
 */
function poolGuard(sym, units, what) {
  const p = POOLSTAT[sym];
  if (!p) return true;
  const cap = p.avail * ORDER_SHARE;
  if (Number(units) / 1e7 > cap) {
    log(`Heads up: only ${compact(p.avail)} ${sym} can be paid out of the Blend pool right now, and this ${what} is a large part of it. It may have to wait before it can be withdrawn or filled.`);
  } else if (p.u >= UTIL_STOP) {
    log(`Heads up: the ${sym} pool on Blend is ${(p.u * 100).toFixed(0)}% borrowed. Withdrawals and fills may have to wait until borrowers repay.`);
  }
  return true;
}
function paintPoolNotes() {
  for (const [id, sym] of [["pool-note", "USDC"], ["sv-pool-note", BS]]) {
    const el = $(id), p = POOLSTAT[sym];
    if (!el) continue;
    el.hidden = !(p && p.u >= UTIL_WARN);
    if (el.hidden) continue;
    const stop = p.u >= UTIL_STOP;
    el.innerHTML = `<b>${stop ? "Pool near its limit." : "Busy pool."}</b> ${(p.u * 100).toFixed(0)}% of the ${sym} on Blend is borrowed, so only ${compact(p.avail)} ${sym} can be paid out right now. ${stop && UTIL_ENFORCE ? "New deposits and orders are paused until this falls; withdrawals and open orders are not affected." : "Withdrawals and fills can wait while it is this busy."}`;
  }
}

/** Amount that can be reserved for a new order in a vault (version 4: orderable_balance; free_balance in old vaults). */
async function roomIn(v) {
  let r = V4 ? await read(v, "orderable_balance") : { ok: false };
  if (!r.ok) r = await read(v, "free_balance");
  return r.ok ? BigInt(r.value) : null;
}

function minOut(fill, limit) {
  return (fill * U + limit - 1n) / limit;
}

async function placeOrder({ single = false } = {}) {
  let amount = toUnitsSafe($("oamount").value);
  const limit = toUnitsSafe($("olimit").value);
  if (amount === null || limit === null) return;
  if (amount < MIN_ORDER) return log("The smallest order is 0.1 USDC.", "err");
  if (freeUnits !== null && amount > freeUnits && offerDeposit("dep", amount - freeUnits, "USDC")) return;
  amount = fitRoom(amount, freeUnits, buyRoom());
  if (!poolGuard("USDC", amount, "order")) return;
  let minFill = $("ominfill").value.trim() ? toUnitsSafe($("ominfill").value) : amount / 4n > 0n ? amount / 4n : amount;
  if (minFill === null) return;
  minFill = fillFloor(amount, minFill);
  const impactPct = Number(String($("oimpact").value).replace(",", "."));
  if (!(impactPct > 0 && impactPct <= 100)) return log("Price impact limit must be between 0 and 100.", "err");
  const bps = Math.max(1, Math.round(impactPct * 100));
  await vaultVersion(vault).catch(() => 0);
  const expiry = expiryOf(vault, OLD_VAULT_DAYS);
  if (!single && LADDER.on) {
    const limit2 = toUnitsSafe($("olimit2").value);
    if (limit2 === null) return;
    if (!autoOk(limit > limit2 ? limit : limit2)) return;
    if (limit2 === limit) return log("The highest and lowest price must be different.", "err");
    return placeLadder(amount, limit, limit2, bps, impactPct, expiry);
  }

  // Confirmation dialog: built from the parsed numbers.
  const lim = Number(limit) / 1e7;
  const rows = [
    ["You spend", `${fmt(amount, 2)} USDC`],
    [`Buy when 1 ${BS} is at or below`, `${fmt(limit)} USDC`],
    ["You receive at least", `${fmt(minOut(amount, limit), 2)} ${BS}`],
  ];
  if (marketPrice) rows.push(["Market price now", `${marketPrice.toLocaleString("en-US", { maximumFractionDigits: 4 })} USDC${lim < marketPrice ? ` (limit is ${((1 - lim / marketPrice) * 100).toFixed(1)}% below)` : ""}`]);
  rows.push(["Minimum fill", `${fmt(minFill, 2)} USDC per piece`]);
  rows.push(["Max price impact", `${impactPct}% per fill`]);
  if (!autoOk(limit)) return;
  rows.push(...autoRows(limit));
  const notes = [];
  if (AUTO.px)
    notes.push(
      sideOf(vault)
        ? `When it fills, the ${BS} stays in your vault${XB ? "" : ", keeps earning,"} and a sell order opens there at your take profit price.`
        : `When it fills, the ${BS} goes straight to your sell vault, keeps earning there, and a sell order opens. If that can't happen for any reason, the ${BS} comes to your wallet as usual.`,
    );
  if (supplyApr !== null) {
    const a = Number(amount) / 1e7;
    notes.push(`While it waits, your USDC keeps earning about ${((a * supplyApr) / 365).toLocaleString("en-US", { maximumFractionDigits: 4 })} USDC a day on Blend.`);
  } else notes.push("While it waits, your USDC keeps earning interest on Blend.");
  if (marketPrice && lim >= marketPrice) notes.push(`<b>Warning.</b> ${WORSE_BUY((lim / marketPrice - 1) * 100)}`);
  if (!(await ask({ title: "Review your order", rows, notes, confirm: "Place order" }))) return;
  let placed;
  if (AUTO.px) {
    const sv = await ensureFeeder();
    if (!sv) return;
    const { lim: thenLim } = autoSellLimit();
    placed = await call(
      vault,
      "place_order_then",
      [i128(amount), i128(limit), i128(minFill), u32(bps), u64(expiry), addr(sv), i128(thenLim), u32(300), u64(autoSecs(vault))],
      "Place order with automatic sell",
      VAULT_ERRORS,
    );
  } else {
    placed = await call(vault, "place_order", [i128(amount), i128(limit), i128(minFill), u32(bps), u64(expiry)], "Place order", VAULT_ERRORS);
  }
  if (placed) askNotify();
}

async function cancelOrder(id) {
  if (
    !(await ask({
      title: `Cancel order #${id}?`,
      lede: "The unfilled amount returns to your available balance right away and keeps earning on Blend.",
      confirm: "Cancel order",
      back: "Keep order",
    }))
  )
    return;
  await call(vault, "cancel_order", [u32(id)], `Cancel #${id}`, VAULT_ERRORS);
}


// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
$("connect").onclick = (e) => {
  if (me) {
    e.stopPropagation();
    toggleWalletMenu();
  } else {
    try { localStorage.removeItem(DISC_KEY); } catch {}
    connect();
  }
};
$("trust").onclick = addTrustline;
$("friendbot").onclick = fundFriendbot;
$("faucet-usdc").onclick = faucetUsdc;
$("create").onclick = createVault;
$("deposit").onclick = deposit;
$("withdraw").onclick = withdraw;
$("place").onclick = placeOrder;
$("refresh").onclick = () => {
  flushReads();
  return refresh();
};
$("status").onclick = () => $("status").classList.remove("show");
// Deposit / withdraw tabs and the order filter
for (const t of document.querySelectorAll("[data-tab]")) {
  t.onclick = () => {
    const box = t.closest("[data-tabs]");
    for (const o of box.querySelectorAll("[data-tab]")) o.setAttribute("aria-selected", String(o === t));
    for (const p of box.querySelectorAll("[data-pane]")) p.hidden = p.dataset.pane !== t.dataset.tab;
  };
}
// Order card: quick limit, lifetime choice, maximum, minimum XLM to receive
for (const c of document.querySelectorAll("#limit-chips [data-pct]")) {
  c.onclick = () => {
    if (!marketPrice) return log("Market price is not loaded yet.", "err");
    const v = marketPrice * (1 + Number(c.dataset.pct) / 100);
    $("olimit").value = v.toFixed(4);
    updateGauge();
    updateTicket();
  };
}
$("max-buy").onclick = () => {
  if (freeUnits !== null) $("oamount").value = toPlain(buyRoom());
  updateTicket();
};
$("max-wd").onclick = () => {
  $("wdamount").value = "";
  $("wdamount").focus();
};
$("max-dep").onclick = () => {
  if (walletUsdc !== null) $("depamount").value = toPlain(walletUsdc);
};

// ---------------------------------------------------------------------------
// Wallet -> vault: an order can only use what is in the vault. When the coin is still in the wallet the ticket
// shows it ("In your wallet") and an order that needs it leads to the Deposit tab with the amount filled in.
// ---------------------------------------------------------------------------
/** What the wallet can move into the vault: "dep" = USDC, "sv-dep" = the traded coin (XLM keeps a reserve for fees). */
function walletDepositable(which) {
  const bal = which === "dep" ? walletUsdc : walletXlm;
  if (bal === null || bal === undefined) return 0n;
  const v = which === "dep" ? bal : bal - BASE_KEEP;
  return v > 0n ? v : 0n;
}
/** Opens the deposit (or withdraw) box on the page you are on; with an amount, fills it in. Confirming runs the
    vault card's own deposit / withdraw, so the checks and the transaction are the same. */
const MOVE_FLAG = "iora-open-move"; // set before a reload to another coin: "dep" | "wd"
function moveLimit(which, mode) {
  if (mode === "dep") return walletDepositable(which);
  const v = which === "dep" ? freeUnits : SV.free;
  return v !== null && v !== undefined && v > 0n ? v : 0n;
}
function openMove(which, mode = "dep", amount = null) {
  const d = $("depbox");
  const sym = which === "dep" ? "USDC" : BS;
  const dep = mode === "dep";
  d.dataset.which = which;
  d.dataset.mode = mode;
  $("depbox-title").textContent = `${dep ? "Deposit" : "Withdraw"} ${sym}`;
  $("depbox-lede").textContent = dep ? "From your wallet into your vault. Orders use what is in the vault." : "From your vault back to your wallet, interest included. What open orders have set aside stays until you cancel them.";
  $("depbox-sym").textContent = sym;
  $("depbox-from").textContent = dep ? "Wallet" : "Available";
  $("depbox-wal").textContent = fmt(moveLimit(which, mode), XB && which !== "dep" ? 7 : 2);
  $("depbox-amt").placeholder = dep ? "0" : "All available";
  $("depbox-amt").value = amount !== null && amount > 0n ? toPlain(amount) : "";
  $("depbox-yes").textContent = dep ? "Deposit" : "Withdraw";
  // coin choice: USDC, the selected coin, and (single vault) the other coins, which reload the page on that coin
  const coins = V7 ? COINS() : [{ sym: "USDC" }, { sym: BS }];
  $("depbox-coins").innerHTML = coins.map((c) => `<button type="button" data-coin="${esc(c.sym)}" aria-pressed="${c.sym === sym}">${esc(c.sym)}</button>`).join("");
  for (const c of $("depbox-coins").querySelectorAll("button")) c.onclick = () => pickMoveCoin(c.dataset.coin, mode);
  d.returnValue = "";
  if (!d.open) d.showModal();
  $("depbox-amt").focus();
}
function pickMoveCoin(sym, mode) {
  if (sym === "USDC") return openMove("dep", mode);
  if (sym === BS) return openMove("sv-dep", mode);
  try {
    sessionStorage.setItem(MOVE_FLAG, mode);
  } catch {}
  setBase(sym, location.hash || "#portfolio");
}
const openDeposit = (which, amount = null) => openMove(which, "dep", amount);
$("depbox-max").onclick = () => {
  const d = $("depbox");
  const can = moveLimit(d.dataset.which, d.dataset.mode);
  if (can > 0n) $("depbox-amt").value = toPlain(can);
};
$("depbox").addEventListener("click", (e) => {
  if (e.target === $("depbox")) $("depbox").close("cancel");
});
$("depbox").addEventListener("close", () => {
  const d = $("depbox");
  if (d.returnValue !== "ok") return;
  const usdc = d.dataset.which === "dep";
  if (d.dataset.mode === "wd") {
    $(usdc ? "wdamount" : "sv-wd").value = $("depbox-amt").value; // empty: everything that is available
    $(usdc ? "withdraw" : "sv-wd-go").click();
  } else {
    $(usdc ? "depamount" : "sv-dep").value = $("depbox-amt").value;
    $(usdc ? "deposit" : "sv-dep-go").click();
  }
});
$("pf-dep").onclick = () => openMove("dep", "dep");
$("pf-wd").onclick = () => openMove("dep", "wd");
// after a reload on another coin (chosen in the box): open the box again for that coin, once the balances are read
try {
  const m = sessionStorage.getItem(MOVE_FLAG);
  if (m) {
    sessionStorage.removeItem(MOVE_FLAG);
    let tries = 0;
    const t = setInterval(() => {
      if (++tries > 40) return clearInterval(t);
      if (!me || (m === "wd" ? SV.free === null : walletXlm === null)) return;
      clearInterval(t);
      openMove("sv-dep", m);
    }, 500);
  }
} catch {}
/** The order needs `missing` more than the vault has. If the wallet holds it, go to Deposit and say so. */
function offerDeposit(which, missing, sym) {
  const can = walletDepositable(which);
  if (can <= 0n) return false;
  const amt = missing < can ? missing : can;
  openDeposit(which, amt);
  log(
    `Your ${esc(sym)} is still in your wallet. An order uses what is in your vault, so deposit ${fmt(amt, 2)} ${esc(sym)} first` +
      (amt < missing ? ` (that is all your wallet can add; lower the order to match)` : "") +
      `, then place the order again.`,
    "err",
  );
  return true;
}
function renderWalletHints() {
  for (const [which, row, out] of [["dep", "buy-walrow", "buy-wal2"], ["sv-dep", "sv-walrow", "sv-wal2"]]) {
    const can = walletDepositable(which);
    $(out).textContent = fmt(can, 2);
    $(row).style.display = me && can >= MIN_ORDER ? "" : "none";
  }
}
$("oamount").addEventListener("input", updateTicket);
$("olimit").addEventListener("input", updateTicket);

// In-app pages (#vault, #sell, #lend, #swap, #faucet)
function showView() {
  const h = location.hash.slice(1);
  const views = ["vault", "lend", "faucet", "portfolio"];
  if (SV.factory) views.push("sell"); // without a sell factory #sell falls back to the buy page
  // "#sell:BTC" = extra market (XLM -> BTC); the sell page's same interface works with that market's factory
  const xm = h.startsWith("sell:") ? EXTRA_MARKETS.find((m) => m.sym === h.slice(5)) : null;
  const v = xm ? "sell" : views.includes(h) ? h : h === "sell" ? "vault" : "markets"; // with an empty address the first page is Markets
  // On first load the rest of the file has not run yet: the market switch is left for the next step
  queueMicrotask(() => {
    if (setSellMarket(xm ? xm.sym : null) && me) refreshSell();
  });
  for (const p of document.querySelectorAll("[data-view-pane]")) p.hidden = p.dataset.viewPane !== v;
  for (const a of document.querySelectorAll("[data-view]")) {
    // The "Trade" tab shows as selected on both the buy and the sell page (data-also)
    if (a.dataset.view === v || a.dataset.also === v) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  document.body.dataset.view = v;
  syncLegacy();
  if (v === "lend" && me) loadLend();
  if (v === "portfolio") renderPortfolio();
  if (v === "markets") paintPrices();
  queueMicrotask(tradeSync); // after a market switch: the chart and depth move to that market
}
window.addEventListener("hashchange", showView);
showView();
for (const c of document.querySelectorAll("[data-filter]")) {
  c.onclick = () => {
    for (const o of document.querySelectorAll("[data-filter]")) o.setAttribute("aria-pressed", String(o === c));
    $("orders").dataset.show = c.dataset.filter;
  };
}
$("olimit").addEventListener("input", updateGauge);

if (!C.factory || !C.usdc) log("Missing settings: web/.env.local not found. Start with web/dev.sh.", "err");
tryAutoConnect();
// Buy fills are caught while the tab is in the background too (for the notification); a full refresh only while the page is visible.
async function pollBuyFills() {
  if (!vault || !openOrders.length) return;
  const ids = openOrders.map((o) => o.id);
  const reads = await Promise.all(ids.map((id) => read(vault, "get_order", [u32(id)])));
  const rows = [];
  reads.forEach((r, i) => r.ok && rows.push({ id: ids[i], ...r.value }));
  checkFills(rows);
}
setInterval(() => {
  if (!me || busy) return;
  const job = document.visibilityState === "visible" ? refresh() : pollBuyFills();
  Promise.resolve(job).catch((e) => console.warn("refresh failed", e));
}, 30000);


// ---------------------------------------------------------------------------
// Lend & Borrow: straight from the wallet to Blend, without a vault
// Blend v2: request types 2 supply collateral, 3 withdraw collateral, 4 borrow, 5 repay.
// Health: sum(collateral * price * c_factor) / sum(debt * price / l_factor). Liquidation below 1.
// ---------------------------------------------------------------------------
const LP = { reserves: [], oracle: null, pdec: 7, take: 0, mode: 2, wallet: {}, posOk: true, missing: 0 };
const LP_VERB = { 2: "Supply", 3: "Withdraw", 4: "Borrow", 5: "Repay" };
const LP_FINE = {
  2: "Supplied assets count as collateral, earn interest and can be withdrawn while your health factor stays above 1.",
  3: "You can withdraw as long as your remaining collateral still covers your debt. Asking for more than you have withdraws everything.",
  4: "Borrowed assets go straight to your wallet. Interest is added to your debt over time.",
  5: "Repaying more than you owe is safe: Blend sends the extra back in the same transaction.",
};

function blendRates(cfg, d, u) {
  const n7 = (v) => Number(BigInt(v)) / 1e7;
  const rm = Number(BigInt(d.ir_mod)) / 1e7;
  const ut = n7(cfg.util), rb = n7(cfg.r_base), r1 = n7(cfg.r_one), r2 = n7(cfg.r_two), r3 = n7(cfg.r_three);
  let ir;
  if (u <= ut) ir = rm * (rb + (ut > 0 ? u / ut : 0) * r1);
  else if (u <= 0.95) ir = rm * (rb + r1 + ((u - ut) / (0.95 - ut)) * r2);
  else ir = rm * (rb + r1 + r2) + ((u - 0.95) / 0.05) * r3;
  return { borrow: ir, supply: ir * u * (1 - LP.take) };
}

async function loadLend() {
  try {
    const [list, pc] = await Promise.all([read(C.pool, "get_reserve_list"), read(C.pool, "get_config")]);
    if (!list.ok) throw new Error("Could not read the Blend pool");
    LP.oracle = pc.ok ? pc.value.oracle : null;
    LP.take = pc.ok && pc.value.bstop_rate !== undefined ? Number(pc.value.bstop_rate) / 1e7 : 0;
    const dec = LP.oracle ? await read(LP.oracle, "decimals") : { ok: false };
    LP.pdec = dec.ok ? Number(dec.value) : 7;
    const pos = await read(C.pool, "get_positions", [addr(me)]);
    // A failed read is not "no position": the totals, health and Max are then shown as unknown (audit IORA-02).
    LP.posOk = pos.ok;
    const P = pos.ok ? pos.value : { liabilities: {}, collateral: {}, supply: {} };
    const get = (m, i) => (m && (m[i] ?? m[String(i)]) !== undefined ? BigInt(m[i] ?? m[String(i)]) : 0n);
    LP.reserves = await Promise.all(
      list.value.map(async (asset) => {
        const [r, sym, price, bal] = await Promise.all([
          read(C.pool, "get_reserve", [addr(asset)]),
          read(asset, "symbol"),
          LP.oracle ? read(LP.oracle, "lastprice", [xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Stellar"), addr(asset)])]) : { ok: false },
          read(asset, "balance", [addr(me)]),
        ]);
        if (!r.ok) return null;
        const cfg = r.value.config, d = r.value.data;
        const decs = Number(cfg.decimals ?? 7);
        const scale = 10 ** decs;
        const bRate = Number(BigInt(d.b_rate)) / 1e12, dRate = Number(BigInt(d.d_rate)) / 1e12;
        const supplied = (Number(BigInt(d.b_supply)) * bRate) / scale;
        const borrowed = (Number(BigInt(d.d_supply)) * dRate) / scale;
        const u = supplied > 0 ? borrowed / supplied : 0;
        const idx = Number(cfg.index);
        let symbol = sym.ok ? String(sym.value) : short(asset);
        if (symbol === "native") symbol = "XLM";
        symbol = symbol.replace(/[^A-Za-z0-9.\-_]/g, "").slice(0, 12) || short(asset);
        return {
          asset, symbol, decs, scale, idx, u, supplied, borrowed,
          // The pool's limit: utilisation cannot go above max_util. What can be borrowed is bounded by that, what can be
          // withdrawn by the cash in the pool (a small margin is left: interest accrues on every ledger).
          maxU: Number(cfg.max_util ?? 1e7) / 1e7,
          room: Math.max(0, supplied * (Number(cfg.max_util ?? 1e7) / 1e7) - borrowed) * 0.995,
          cash: Math.max(0, supplied - borrowed) * 0.995,
          cf: Number(cfg.c_factor) / 1e7, lf: Number(cfg.l_factor) / 1e7,
          enabled: cfg.enabled !== false,
          rates: blendRates(cfg, d, u),
          price: price.ok && price.value ? Number(BigInt(price.value.price)) / 10 ** LP.pdec : null,
          collat: (Number(get(P.collateral, idx)) * bRate) / scale,
          supplyNc: (Number(get(P.supply, idx)) * bRate) / scale,
          debt: (Number(get(P.liabilities, idx)) * dRate) / scale,
          wallet: bal.ok ? Number(BigInt(bal.value)) / scale : null,
        };
      }),
    );
    LP.missing = LP.reserves.filter((r) => !r).length;
    LP.reserves = LP.reserves.filter(Boolean);
    renderLend();
  } catch (e) {
    $("lp-markets").innerHTML = `<p class="empty">Could not load Blend markets: ${esc(e.message)}</p>`;
  }
}

// The math is in lend.js; here it is bound to the loaded pool. Incomplete data (positions or a reserve unreadable)
// makes the totals unknown instead of silently leaving a debt out.
const lpTotals = (rs, change) => lpTotalsOf(rs, change, !LP.posOk || LP.missing > 0);
const usd = (v) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v) => `${(v * 100).toFixed(2)}%`;

// ---- Pool summary: at the app's entrance, visible without a connected wallet too ----
// Summarises the Blend pool where the funds of Iora vaults sit: how much is supplied, how much is lent out, how
// much can be withdrawn / still lent right now, utilisation and rates. Read straight from the pool contract.
const compact = (v) => {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  return v.toLocaleString("en-US", { maximumFractionDigits: a >= 100 ? 0 : 2 });
};
async function loadPool() {
  const slots = [...document.querySelectorAll("[data-pool]")];
  const mk = $("mk-body");
  if (!slots.length && !mk) return;
  const assets = [["USDC", C.usdc, "Waits in buy vaults"], ["XLM", C.xlm, "Waits in sell vaults"]].filter((x) => x[1]);
  try {
    const [pc, ...rs] = await Promise.all([read(C.pool, "get_config"), ...assets.map((x) => read(C.pool, "get_reserve", [addr(x[1])]))]);
    if (pc.ok && pc.value.bstop_rate !== undefined) LP.take = Number(pc.value.bstop_rate) / 1e7;
    const cards = {};
    const full = [];
    const rowsMk = [];
    let mkX = null;
    const mkStat = {};
    rs.forEach((r, i) => {
      if (!r.ok) return;
      const cfg = r.value.config, d = r.value.data;
      const scale = 10 ** Number(cfg.decimals ?? 7);
      const supplied = (Number(BigInt(d.b_supply)) * (Number(BigInt(d.b_rate)) / 1e12)) / scale;
      const borrowed = (Number(BigInt(d.d_supply)) * (Number(BigInt(d.d_rate)) / 1e12)) / scale;
      const u = supplied > 0 ? borrowed / supplied : 0;
      const maxU = Number(cfg.max_util ?? 1e7) / 1e7;
      const rates = blendRates(cfg, d, u);
      const [sym, , where] = assets[i];
      const isBuy = sym === "USDC";
      POOLSTAT[sym] = { u, avail: Math.max(0, supplied - borrowed) };
      const busy = u >= UTIL_STOP ? `<span class="warn">Pool near limit</span>` : u >= UTIL_WARN ? `<span class="warn">Busy pool</span>` : "";
      const bar = `<div class="pool-util" role="img" aria-label="${(u * 100).toFixed(1)}% of the supplied ${sym} is borrowed; the limit is ${(maxU * 100).toFixed(0)}%"><div class="pool-util-bar"><span style="width:${Math.min(100, u * 100).toFixed(1)}%"></span><i style="left:${Math.min(100, maxU * 100).toFixed(1)}%"></i></div><div class="pool-util-legend"><span>${(u * 100).toFixed(1)}% borrowed</span><span>limit ${(maxU * 100).toFixed(0)}%</span></div></div>`;
      mkStat[sym] = { rate: pct(rates.supply), avail: `${compact(Math.max(0, supplied - borrowed))} ${sym}`, of: `of ${compact(supplied)} supplied`, bar, busy };
      if (!isBuy) mkX = { rate: pct(rates.supply), avail: `${compact(Math.max(0, supplied - borrowed))} XLM`, of: `of ${compact(supplied)} supplied`, bar };
      rowsMk.push(`<tr data-go="${isBuy ? "vault" : "sell"}">
        <td><div class="mk-pair"><i class="coin ${isBuy ? "usdc" : "xlm"}" aria-hidden="true"></i><b>${isBuy ? "USDC" : "XLM"}</b><span aria-hidden="true">→</span><i class="coin ${isBuy ? "xlm" : "usdc"}" aria-hidden="true"></i><b>${isBuy ? "XLM" : "USDC"}</b></div>
          <div class="mk-tags"><span>${isBuy ? "Buy vault" : "Sell vault"}</span><span>${isBuy ? "Limit buy" : "Limit sell"}</span><span>Earns on Blend</span>${busy}</div></td>
        <td><span class="mk-price">—</span><small>USDC per XLM</small></td>
        <td class="pos">${pct(rates.supply)}<small>a year, paid in ${sym}</small></td>
        <td>${compact(Math.max(0, supplied - borrowed))} ${sym}<small>of ${compact(supplied)} supplied</small></td>
        <td>${bar}</td>
        <td><a class="btn primary" href="#${isBuy ? "vault" : "sell"}">${isBuy ? "Buy XLM" : "Sell XLM"}</a></td>
      </tr>`);
      const cell = (k, v, cls = "") => `<div><dt>${k}</dt><dd class="${cls}">${v}</dd></div>`;
      const avail = Math.max(0, supplied - borrowed);
      // Summary row: the three most looked-at numbers and the utilisation bar
      cards[sym] = `<article class="pool-card">
        <h3>${sym}<span class="muted">${where}</span></h3>
        <dl>
          ${cell("Lenders earn", `${pct(rates.supply)}<small> a year</small>`, "pos")}
          ${cell("Available now", `${compact(avail)}<small> of ${compact(supplied)} ${sym}</small>`)}
        </dl>
        <div class="pool-util" role="img" aria-label="${(u * 100).toFixed(1)}% of the supplied ${sym} is borrowed; the limit is ${(maxU * 100).toFixed(0)}%">
          <div class="pool-util-bar"><span style="width:${Math.min(100, u * 100).toFixed(1)}%"></span><i style="left:${Math.min(100, maxU * 100).toFixed(1)}%"></i></div>
          <div class="pool-util-legend"><span>${(u * 100).toFixed(1)}% borrowed</span><span>limit ${(maxU * 100).toFixed(0)}%</span></div>
        </div>
      </article>`;
      full.push(`<tr><th scope="row">${sym}</th><td>${compact(supplied)}</td><td>${compact(borrowed)}</td><td>${compact(avail)}</td><td>${compact(Math.max(0, supplied * maxU - borrowed))}</td><td>${pct(rates.supply)}</td><td>${pct(rates.borrow)}</td></tr>`);
    });
    if (!full.length) throw new Error("no reserve data");
    // Each page shows its own asset (buy: USDC, sell: XLM)
    for (const el of slots) if (cards[el.dataset.pool]) el.innerHTML = cards[el.dataset.pool];
    const table = `<div class="table-wrap"><table><thead><tr><th scope="col">Asset</th><th scope="col">Supplied</th><th scope="col">Out on loan</th><th scope="col">Available now</th><th scope="col">Still lendable</th><th scope="col">Lenders earn</th><th scope="col">Borrowers pay</th></tr></thead><tbody>${full.join("")}</tbody></table></div>`;
    for (const el of document.querySelectorAll(".pool-full")) el.innerHTML = table;
    paintPoolNotes();
    if (mk) {
      // Extra markets: XLM is deposited (the same XLM pool), another token is bought
      if (mkX) {
        for (const m of EXTRA_MARKETS) {
          rowsMk.push(`<tr data-go="sell:${m.sym}">
            <td><div class="mk-pair"><i class="coin xlm" aria-hidden="true"></i><b>XLM</b><span aria-hidden="true">→</span>${coinI(m.sym)}<b>${esc(m.sym)}</b></div>
              <div class="mk-tags"><span class="warn">Showcase</span><span class="warn">Thin test pool</span><span>Earns on Blend</span></div></td>
            <td><span class="mk-xprice" data-tok="${m.token}">—</span><small>${esc(m.sym)} per XLM</small></td>
            <td class="pos">${mkX.rate}<small>a year, paid in XLM</small></td>
            <td>${mkX.avail}<small>${mkX.of}</small></td>
            <td>${mkX.bar}</td>
            <td><a class="btn" href="#sell:${m.sym}">Open</a></td>
          </tr>`);
        }
      }
      if (V7) {
        // Single vault: each row is a "<coin> / USDC" pair. Waiting USDC earns on Blend in every pair; the coin side only for XLM.
        rowsMk.length = 0;
        const u = mkStat.USDC, x = mkStat.XLM;
        for (const p of [{ sym: "XLM", token: C.xlm }, ...PAIRS]) {
          const main = p.sym === "XLM";
          rowsMk.push(`<tr data-base="${esc(p.sym)}">
            <td><div class="mk-pair">${coinI(p.sym)}<b>${esc(p.sym)}</b><span aria-hidden="true">/</span><i class="coin usdc" aria-hidden="true"></i><b>USDC</b></div>
              <div class="mk-tags"><span>Limit buy and sell</span>${main ? `<span>USDC and XLM earn on Blend</span>${(u && u.busy) || ""}` : `<span>USDC earns on Blend</span><span class="warn">${esc(p.sym)} earns no interest</span><span class="warn">Thin test pool</span>`}</div></td>
            <td><span class="mk-bprice" data-tok="${p.token}">—</span><small>USDC per ${esc(p.sym)}</small></td>
            <td class="pos">${u ? u.rate : "—"}<small>a year on waiting USDC${main && x ? `, ${x.rate} on XLM` : ""}</small></td>
            <td>${u ? u.avail : "—"}<small>${u ? u.of : ""}</small></td>
            <td>${u ? u.bar : ""}</td>
            <td><a class="btn primary" href="#vault">Trade</a></td>
          </tr>`);
        }
      }
      mk.innerHTML = rowsMk.join("");
      for (const tr of mk.querySelectorAll("tr[data-base]")) {
        tr.onclick = (e) => {
          e.preventDefault();
          setBase(tr.dataset.base, "#vault");
        };
      }
      paintPrices();
      for (const tr of mk.querySelectorAll("tr[data-go]")) tr.onclick = (e) => { if (!e.target.closest("a")) location.hash = tr.dataset.go; };
      paintMkPrice();
    }
  } catch (e) {
    for (const el of slots) if (!el.querySelector(".pool-card")) el.innerHTML = `<p class="muted">Could not load the pool right now. It will retry shortly.</p>`;
    if (mk && !mk.querySelector("tr[data-go]")) mk.innerHTML = `<tr><td colspan="6" class="muted">Could not load the markets right now. It will retry shortly.</td></tr>`;
    console.warn("pool overview", e);
  }
}
/** Price of the extra markets: from what selling 100 XLM brings in (to avoid rounding errors at small prices). */
async function paintExtraPrices() {
  await Promise.all(
    [...document.querySelectorAll(".mk-xprice")].map(async (el) => {
      const q = await read(C.router, "router_get_amounts_out", [i128(100n * U), addrVec([C.xlm, el.dataset.tok])]);
      if (q.ok) el.textContent = px4(Number(BigInt(q.value[q.value.length - 1])) / 1e9);
      else el.textContent = "no pool";
      mkSeen.set(`x${el.dataset.tok}`, el.textContent);
    }),
  );
}
/**
 * The price column of the Markets table. It costs a read per coin, so it is read only while that page is showing
 * (or about to: `now`); the cells show the prices read last until then.
 */
function paintPrices(now = false) {
  for (const el of document.querySelectorAll(".mk-bprice")) if (mkSeen.has(`b${el.dataset.tok}`)) el.textContent = mkSeen.get(`b${el.dataset.tok}`);
  for (const el of document.querySelectorAll(".mk-xprice")) if (mkSeen.has(`x${el.dataset.tok}`)) el.textContent = mkSeen.get(`x${el.dataset.tok}`);
  if (!now && document.body.dataset.view !== "markets") return;
  paintBasePrices().catch((e) => console.warn("market prices", e));
  paintExtraPrices().catch((e) => console.warn("market prices", e));
}

/** Price cells in the Markets table (updated as the Soroswap price arrives). */
/** Markets page: each coin's USDC price (from what 1 USDC buys; the same calculation as the price on the trading screen). */
async function paintBasePrices() {
  await Promise.all(
    [...document.querySelectorAll(".mk-bprice")].map(async (el) => {
      const q = await read(C.router, "router_get_amounts_out", [i128(U), addrVec([C.usdc, el.dataset.tok])]);
      const out = q.ok ? Number(BigInt(q.value[q.value.length - 1])) : 0;
      el.textContent = out > 0 ? px4(1e7 / out) : "no pool";
      mkSeen.set(`b${el.dataset.tok}`, el.textContent);
    }),
  );
}
function paintMkPrice() {
  if (!marketPrice) return;
  const t = marketPrice.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  for (const el of document.querySelectorAll(".mk-price")) el.textContent = t;
}
loadPool();
setInterval(() => document.visibilityState === "visible" && loadPool(), 60000);

function renderLend() {
  const t = lpTotals(LP.reserves);
  $("lp-sup").textContent = t.known ? usd(t.sup) : "Unknown";
  $("lp-bor").textContent = t.known ? usd(t.bor) : "Unknown";
  // A dollar total alone is not enough: each asset is also written in its own unit (e.g. "120.00 USDC · 850.00 XLM").
  const each = (pick) =>
    LP.reserves
      .map((r) => [r.symbol, pick(r)])
      .filter(([, v]) => v > 0)
      .map(([sym, v]) => `${v.toLocaleString("en-US", { maximumFractionDigits: v >= 100 ? 2 : 4 })} ${esc(sym)}`)
      .join(" · ");
  $("lp-sup-list").textContent = each((r) => r.collat + r.supplyNc);
  $("lp-bor-list").textContent = each((r) => r.debt);
  $("lp-used").textContent = !t.known ? "Unknown" : t.used === Infinity ? "—" : `${(t.used * 100).toFixed(1)}%`;
  $("lp-hf").textContent = hfText(t.hf);
  $("lp-hf").className = `hf ${hfClass(t.hf)}`;
  $("lp-used-bar").style.width = `${!t.known ? 0 : Math.min(100, (t.used === Infinity ? 1 : t.used) * 100)}%`;
  $("lp-used-bar").className = hfClass(t.hf);

  $("lp-markets").innerHTML = `<table>
    <thead><tr><th>Asset</th><th>Supply rate</th><th>Borrow rate</th><th>Utilization</th><th>Collateral factor</th><th>You supplied</th><th>You owe</th></tr></thead>
    <tbody>${LP.reserves
      .map(
        (r) => `<tr class="lp-row${r.asset === lpSel() ? " sel" : ""}" data-asset="${r.asset}" tabindex="0">
        <td><b>${r.symbol}</b>${r.price !== null ? `<span class="muted">$${r.price.toLocaleString("en-US", { maximumFractionDigits: 4 })}</span>` : `<span class="muted">price unavailable</span>`}</td>
        <td class="pos">${pct(r.rates.supply)}</td>
        <td>${pct(r.rates.borrow)}</td>
        <td>${(r.u * 100).toFixed(1)}%</td>
        <td>${Math.round(r.cf * 100)}%</td>
        <td>${r.collat + r.supplyNc > 0 ? `${(r.collat + r.supplyNc).toLocaleString("en-US", { maximumFractionDigits: 4 })} <small class="muted">${esc(r.symbol)}</small>${r.price !== null ? `<span class="muted lp-usd">≈ $${((r.collat + r.supplyNc) * r.price).toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>` : ""}` : "—"}</td>
        <td>${r.debt > 0 ? `${r.debt.toLocaleString("en-US", { maximumFractionDigits: 4 })} <small class="muted">${esc(r.symbol)}</small>${r.price !== null ? `<span class="muted lp-usd">≈ $${(r.debt * r.price).toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>` : ""}` : "—"}</td>
      </tr>`,
      )
      .join("")}</tbody></table>
    ${!LP.posOk ? `<p class="lp-note bad">Your positions could not be read right now, so your amounts and health factor are unknown. Reload in a moment.</p>` : ""}
    ${LP.missing > 0 ? `<p class="lp-note bad">${LP.missing} market${LP.missing > 1 ? "s" : ""} could not be read, so your totals and health factor are unknown.</p>` : ""}
    ${LP.posOk && !LP.missing && !t.known ? `<p class="lp-note bad">An oracle price is missing for an asset you supplied or owe, so your dollar totals and health factor are unknown. The amounts in each asset are still shown.</p>` : ""}
    <p class="fine">Select a row to use that asset in the action card.</p>`;
  for (const row of document.querySelectorAll(".lp-row")) {
    const pick = () => {
      $("lp-asset").value = row.dataset.asset;
      renderLend();
    };
    row.onclick = pick;
    row.onkeydown = (e) => e.key === "Enter" && pick();
  }

  const sel = $("lp-asset");
  const cur = sel.value;
  sel.innerHTML = LP.reserves.map((r) => `<option value="${r.asset}">${r.symbol}</option>`).join("");
  if (cur && LP.reserves.some((r) => r.asset === cur)) sel.value = cur;
  lpPreview();
}

// The Blend pool's most common rejection codes
const BLEND_ERRORS = {
  1205: "Blend rejected this: your health factor would be too low. Try a smaller amount.",
  1207: "Blend rejected this: too much of this asset is already out on loan, so the pool is at its limit. Try a smaller amount, another asset, or come back later.",
  1208: "Blend rejected this: your wallet already holds the maximum number of positions in this pool.",
};
function lpSel() {
  return $("lp-asset").value || (LP.reserves[0] && LP.reserves[0].asset);
}

const lpMax = (r, keep = 0) => lpMaxOf(r, LP.mode, lpTotals(LP.reserves), { keep, posOk: LP.posOk });

// What the Max button fills in. Borrowing or withdrawing up to the limit leaves the position about 5%
// from liquidation, so Max stops where the health factor is still 1.2; a larger amount can be typed by hand.
const LP_SAFE_HF = 1.2;
const lpSafeMax = (r, keep = 0) => lpSafeMaxOf(r, LP.mode, lpTotals(LP.reserves), { keep, posOk: LP.posOk }, LP_SAFE_HF);

function lpPreview() {
  const r = LP.reserves.find((x) => x.asset === lpSel());
  const verb = LP_VERB[LP.mode];
  $("lp-verb").textContent = verb;
  $("lp-go").textContent = r ? `${verb} ${r.symbol}` : verb;
  $("lp-fine").textContent = LP_FINE[LP.mode];
  $("lp-max-label").textContent = LP.mode === 2 ? "Wallet" : LP.mode === 3 ? "Can withdraw" : LP.mode === 4 ? "Can borrow" : "You owe";
  if (!r) return;
  const max = lpMax(r);
  const unknownMax = (LP.mode !== 2 && !LP.posOk) || ((LP.mode === 3 || LP.mode === 4) && !lpTotals(LP.reserves).known);
  $("lp-max-v").textContent = unknownMax ? "Unknown" : LP.mode === 5 ? r.debt.toLocaleString("en-US", { maximumFractionDigits: 4 }) : max.toLocaleString("en-US", { maximumFractionDigits: 4 });
  $("lp-rate-label").textContent = LP.mode >= 4 ? "Borrow rate" : "Supply rate";
  $("lp-rate").textContent = pct(LP.mode >= 4 ? r.rates.borrow : r.rates.supply);
  const amt = Number(String($("lp-amount").value).replace(",", ".")) || 0;
  const before = lpTotals(LP.reserves);
  const after = lpTotals(LP.reserves, { asset: r.asset, mode: LP.mode, amt });
  $("lp-hf-after").innerHTML = `${hfText(before.hf)} → <b class="hf ${hfClass(after.hf)}">${hfText(after.hf)}</b>`;
  const u = (x) => (Number.isNaN(x) ? "Unknown" : x === Infinity ? "—" : `${(x * 100).toFixed(1)}%`);
  $("lp-used-after").innerHTML = `${u(before.used)} → <b>${u(after.used)}</b>`;
  let note = "";
  if (r.price === null) note = "No oracle price for this asset; health can't be estimated.";
  else if (!before.known) note = "Some prices or positions could not be read, so health can't be estimated right now.";
  else if (amt > 0 && after.hf < 1) note = "This would put your health factor below 1. Blend will reject it.";
  else if (amt > 0 && after.hf < 1.2 && LP.mode >= 3 && LP.mode <= 4) note = "Risky: a small price move could get this position liquidated.";
  else if (LP.mode === 4 && before.col === 0) note = "Supply collateral first. You can't borrow without it.";
  else if (LP.mode === 4 && (r.room <= 0 || amt > r.room))
    note =
      r.room <= 0
        ? `No ${r.symbol} can be borrowed right now: ${(r.u * 100).toFixed(1)}% of this pool's ${r.symbol} is already out on loan and its limit is ${(r.maxU * 100).toFixed(0)}%. Pick another asset or try again later.`
        : `Only about ${r.room.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${r.symbol} is left to borrow in this pool (its limit is ${(r.maxU * 100).toFixed(0)}% in use).`;
  else if (LP.mode === 3 && amt > r.cash && r.collat > r.cash)
    note = `Only about ${r.cash.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${r.symbol} can be withdrawn right now; the rest is out on loan until borrowers repay.`;
  else if (LP.mode === 2 && r.wallet === null) note = `Your wallet can't hold ${r.symbol} yet. Add a trustline first.`;
  $("lp-note").textContent = note;
  $("lp-note").className = `lp-note${note && (!before.known || after.hf < 1.2 || r.wallet === null || (LP.mode === 4 && (amt > r.room || r.room <= 0))) ? " bad" : ""}`;
}

for (const b of document.querySelectorAll("[data-lp]")) {
  b.addEventListener("click", () => {
    LP.mode = Number(b.dataset.lp);
    $("lp-amount").value = "";
    lpPreview();
  });
}
$("lp-asset").addEventListener("change", () => {
  $("lp-amount").value = "";
  renderLend();
});
$("lp-amount").addEventListener("input", lpPreview);
$("lp-max").onclick = () => {
  const r = LP.reserves.find((x) => x.asset === lpSel());
  if (!r) return;
  // When supplying/repaying XLM a little XLM stays in the wallet for transaction fees and the account reserve: it
  // comes off the wallet budget, not off the debt, so a wallet that covers the debt still repays all of it (IORA-08).
  const m = lpSafeMax(r, r.symbol === "XLM" && (LP.mode === 2 || LP.mode === 5) ? 2 : 0);
  const d = Math.max(0, Math.min(7, Number(r.decs ?? 7)));
  $("lp-amount").value = m > 0 ? (Math.floor(m * 10 ** d) / 10 ** d).toFixed(d).replace(/\.?0+$/, "") : "";
  lpPreview();
};
$("lp-go").onclick = async () => {
  const r = LP.reserves.find((x) => x.asset === lpSel());
  if (!r) return;
  const raw = String($("lp-amount").value).trim().replace(",", ".");
  if (!/^\d+(\.\d{0,7})?$/.test(raw) || Number(raw) <= 0) return log("Enter an amount greater than zero.", "err");
  const [a, b = ""] = raw.split(".");
  if (b.length > r.decs) return log(`${r.symbol} supports at most ${r.decs} decimals.`, "err");
  const units = BigInt(a) * BigInt(r.scale) + BigInt(b.padEnd(r.decs, "0").slice(0, r.decs) || "0");
  const after = lpTotals(LP.reserves, { asset: r.asset, mode: LP.mode, amt: Number(raw) });
  if ((LP.mode === 3 || LP.mode === 4) && !after.known) return log("Some prices or positions could not be read, so this can't be checked right now. Reload and try again.", "err");
  if ((LP.mode === 3 || LP.mode === 4) && after.hf < 1) return log("That would make your health factor drop below 1. Try a smaller amount.", "err");
  if (LP.mode === 4 && Number(raw) > r.room) {
    return log(
      r.room <= 0
        ? `No ${r.symbol} can be borrowed right now: ${(r.u * 100).toFixed(1)}% of the pool's ${r.symbol} is already out on loan (limit ${(r.maxU * 100).toFixed(0)}%). Pick another asset or try again later.`
        : `Only about ${r.room.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${r.symbol} is left to borrow in this pool. Try a smaller amount.`,
      "err",
    );
  }
  const req = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("address"), val: addr(r.asset) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"), val: i128(units) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("request_type"), val: xdr.ScVal.scvU32(LP.mode) }),
  ]);
  const res = await call(C.pool, "submit", [addr(me), addr(me), addr(me), xdr.ScVal.scvVec([req])], `${LP_VERB[LP.mode]} ${raw} ${r.symbol}`, BLEND_ERRORS);
  if (res) {
    $("lp-amount").value = "";
    await loadLend();
  }
};


// The site's own confirmation dialog (instead of the browser's confirm box)
function ask({ title, lede = "", rows = [], notes = [], confirm = "Confirm", back = "Go back" }) {
  const d = $("ask");
  $("ask-title").textContent = title;
  $("ask-lede").textContent = lede;
  $("ask-lede").hidden = !lede;
  $("ask-rows").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  $("ask-rows").hidden = !rows.length;
  $("ask-notes").innerHTML = notes.map((n) => `<li>${n}</li>`).join("");
  $("ask-notes").hidden = !notes.length;
  $("ask-yes").textContent = confirm;
  $("ask-no").textContent = back;
  return new Promise((resolve) => {
    const done = () => {
      d.removeEventListener("close", done);
      resolve(d.returnValue === "ok");
    };
    d.returnValue = "";
    d.addEventListener("close", done);
    d.showModal();
    $("ask-yes").focus();
  });
}
// Close on a click outside
$("ask").addEventListener("click", (e) => {
  if (e.target === $("ask")) $("ask").close("cancel");
});

// ---------------------------------------------------------------------------
// Test funds: Friendbot, trustline state
// ---------------------------------------------------------------------------
const FAUCET = { funded: false, trust: false, asking: false };
function renderFaucet(funded, hasTrust) {
  FAUCET.funded = !!funded;
  FAUCET.trust = !!hasTrust;
  const x = walletNative !== null ? fmt(walletNative, 2) : "—";
  $("f-xlm").textContent = funded ? `${x} XLM` : "0 XLM";
  $("f-usdc").textContent = hasTrust && walletUsdc !== null ? `${fmt(walletUsdc, 2)} USDC` : hasTrust ? "0 USDC" : "No trustline";
  $("f-addr").innerHTML = me ? `<a href="${EXPLORER}/account/${me}" target="_blank" rel="noopener">${short(me)}</a>` : "—";
  const step = (id, done) => $(id).classList.toggle("done", !!done);
  step("fs-1", funded);
  step("fs-2", hasTrust);
  step("fs-3", hasTrust && walletUsdc !== null && walletUsdc > 0n);
  $("friendbot").disabled = funded;
  $("fb-note").textContent = funded ? "Done. Your wallet is funded." : "";
  $("trust").disabled = !funded || hasTrust;
  $("trust-note").textContent = hasTrust ? "Done. Your wallet can hold USDC." : !funded ? "Do step 1 first." : "";
  $("usdc-note").textContent = walletUsdc !== null && walletUsdc > 0n ? `Done. You have ${fmt(walletUsdc, 2)} USDC.` : !hasTrust ? "Do step 2 first." : "";
  $("faucet-usdc").disabled = FAUCET.asking;
}

async function fundFriendbot() {
  if (!(await needWallet())) return;
  const b = $("friendbot");
  b.disabled = true;
  log("Asking Friendbot for test XLM…");
  try {
    const r = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(me)}`);
    if (r.ok) log("10,000 test XLM received.", "ok");
    else {
      const t = await r.text();
      log(/createAccountAlreadyExist|op_already_exists|already funded/i.test(t) ? "This wallet is already funded on testnet." : "Friendbot could not fund this wallet right now. Try again in a minute.", "err");
    }
  } catch {
    log("Could not reach Friendbot. Check your connection and try again.", "err");
  }
  flushReads();
  await refresh();
}

// Test USDC from Iora's faucet (api/faucet.js): Circle's testnet USDC, once a day per wallet.
const FAUCET_ERRORS = {
  bad_address: "That wallet address is not valid.",
  no_access: "The faucet is part of the beta: open the app with your invite code or an allowed wallet first.",
  no_account: "Your wallet is not on testnet yet. Do step 1 first.",
  no_trustline: "Add the USDC trustline first (step 2).",
  trustline_full: "Your USDC trustline limit is too low for this amount. Remove the trustline and add it again.",
  trustline_unauthorized: "Your wallet is not allowed to hold this USDC.",
  wallet_limit: "This wallet already got test USDC in the last 24 hours.",
  ip_limit: "Too many requests from your network today.",
  faucet_low: "The faucet is empty right now. Sell some XLM for USDC or use Circle's faucet instead.",
  limits_unavailable: "The faucet can't check its limits right now. Try again later.",
  not_testnet: "The faucet only runs on testnet.",
  not_configured: "The faucet is not set up yet. Sell some XLM for USDC or use Circle's faucet instead.",
  network: "The faucet could not reach the network. Try again in a minute.",
  send_failed: "The network rejected the faucet payment. Try again in a minute.",
  send_unknown: "The faucet sent a payment but did not hear back. Check your USDC balance in a minute before asking again.",
};
const waitText = (s) => (s >= 3600 ? `${Math.ceil(s / 3600)} h` : `${Math.max(1, Math.ceil(s / 60))} min`);
async function faucetUsdc() {
  if (FAUCET.asking || !(await needWallet())) return;
  if (!FAUCET.trust) {
    log(FAUCET.funded ? "Add the USDC trustline first (step 2), then ask again." : "Do step 1 and step 2 first: get test XLM, then add the USDC trustline.", "err");
    $(FAUCET.funded ? "fs-2" : "fs-1").scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  let token = null;
  try {
    token = localStorage.getItem("iora-access");
  } catch {}
  FAUCET.asking = true;
  $("faucet-usdc").disabled = true;
  log("Asking the faucet for test USDC…", "wait");
  try {
    const r = await fetch("/api/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: me, token }), cache: "no-store" });
    let j = {};
    try {
      j = await r.json();
    } catch {}
    if (j.ok && /^[0-9a-f]{64}$/.test(String(j.hash))) {
      log(`${esc(String(j.amount || ""))} test USDC received · <a href="${EXPLORER}/tx/${j.hash}" target="_blank" rel="noopener">transaction</a>`, "ok");
    } else {
      const base = FAUCET_ERRORS[j.error] || "The faucet could not send USDC right now. Try again later, or sell some XLM for USDC.";
      const wait = (j.error === "wallet_limit" || j.error === "ip_limit") && Number(j.retryAfter) > 0 ? ` Try again in ${waitText(Number(j.retryAfter))}.` : "";
      log(base + wait, "err");
    }
  } catch {
    log("Could not reach the faucet. Check your connection and try again.", "err");
  } finally {
    FAUCET.asking = false;
    $("faucet-usdc").disabled = false;
  }
  flushReads();
  await refresh();
}

// ---------------------------------------------------------------------------
// Swap: XLM <-> USDC, Soroswap, with slippage protection
// ---------------------------------------------------------------------------
// q: the last quote, an immutable snapshot (swap-quote.js); req: the id of the newest quote request (older answers
// are thrown away); preparing: the Swap button is getting a fresh quote, the inputs are locked meanwhile.
const SW = { dir: "xu", slip: 1, out: null, t: null, q: null, req: 0, preparing: false };
const swPath = () => (SW.dir === "xu" ? [BASE.addr, C.usdc] : [C.usdc, BASE.addr]);
function swSyms() {
  const [a, b] = SW.dir === "xu" ? [BS, "USDC"] : ["USDC", BS];
  $("swap-sym-in").textContent = a;
  $("swap-sym-out").textContent = b;
  paintCoin($("swap-coin-in"), a);
  paintCoin($("swap-coin-out"), b);
  const bin = SW.dir === "xu" ? walletXlm : walletUsdc;
  const bout = SW.dir === "xu" ? walletUsdc : walletXlm;
  $("swap-bal-in").textContent = bin !== null ? fmt(bin, 2) : "—";
  $("swap-bal-out").textContent = bout !== null ? fmt(bout, 2) : SW.dir === "xu" ? "no trustline" : "—";
  $("swap-go").textContent = SW.dir === "xu" ? `Sell ${BS}` : `Buy ${BS}`;
  $("swap-go").classList.toggle("go-sell", SW.dir === "xu");
  $("swap-go").classList.toggle("go-buy", SW.dir !== "xu");
  $("mkt-title").textContent = SW.dir === "xu" ? `Sell ${BS} at the market price` : `Buy ${BS} at the market price`;
}
function quoteSwap() {
  clearTimeout(SW.t);
  if (SW.preparing) return; // the Swap button's own quote is in flight; the inputs are locked

  SW.t = setTimeout(doQuote, 250);
}
// ----- Market swaps go to the venue that quotes the most: Soroswap's pool or an Aquarius pool -----
const AQUA_ROUTER = (import.meta.env.VITE_AQUA_ROUTER || "").trim();
const u128 = (n) => nativeToScVal(BigInt(n), { type: "u128" });
const aquaPoolsOf = new Map(); // "a|b" -> { at, list: [Uint8Array hash] }
/** Aquarius wants a pool's tokens in address order (the raw contract ids compared as bytes). */
function aquaTokens(a, b) {
  const raw = (id) => StrKey.decodeContract(id);
  const less = (x, y) => {
    const p = raw(x), q = raw(y);
    for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return p[i] < q[i];
    return false;
  };
  return addrVec(less(a, b) ? [a, b] : [b, a]);
}
async function aquaPools(a, b) {
  if (!AQUA_ROUTER) return [];
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  const c = aquaPoolsOf.get(key);
  if (c && Date.now() - c.at < 10 * 60_000) return c.list;
  const list = [];
  try {
    const sim = await server.simulateTransaction(readCall(AQUA_ROUTER, "get_pools", [aquaTokens(a, b)]));
    if (!rpc.Api.isSimulationError(sim) && sim.result) {
      const map = sim.result.retval;
      const entries = (typeof map.map === "function" ? map.map() : map.value ?? map._value) || [];
      for (const e of entries) {
        const kn = scValToNative(typeof e.key === "function" ? e.key() : e.key);
        const hash = kn instanceof Uint8Array ? kn : Uint8Array.from(Object.values(kn));
        if (hash.length === 32) list.push(hash);
      }
    }
  } catch {}
  aquaPoolsOf.set(key, { at: Date.now(), list });
  return list;
}
/** The best Aquarius pool for this swap: { out, hash } or null. */
async function aquaBest(tin, tout, amt) {
  let best = null;
  const pools = await aquaPools(tin, tout);
  const reads = await Promise.all(
    pools.map((hash) => rawRead(AQUA_ROUTER, "estimate_swap", [aquaTokens(tin, tout), new Address(tin).toScVal(), new Address(tout).toScVal(), xdr.ScVal.scvBytes(hash), u128(amt)])),
  );
  reads.forEach((r, i) => {
    if (r.ok && r.value !== undefined) {
      const out = BigInt(r.value);
      if (!best || out > best.out) best = { out, hash: pools[i] };
    }
  });
  return best;
}

// ----- A market swap split over several pools (through the filler contract's `swap_from`) -----
// One pool moves its own price the more it is asked to swap; spreading the amount over the Soroswap pool and the
// Aquarius pools can return more than the best single pool. The filler takes exactly the amount you sign for,
// runs the swaps and sends everything back in the same transaction; with less than your minimum it all fails.
const FILLER = (import.meta.env.VITE_FILLER || "").trim();
const SPLIT_PROBE = 100_000n; // 0.01 token: the amount used to read how a pool takes its token
const symVal = (x) => xdr.ScVal.scvSymbol(x);
const structVal = (o) => xdr.ScVal.scvMap(Object.keys(o).sort().map((k) => new xdr.ScMapEntry({ key: symVal(k), val: o[k] })));
const callVal = (id, func, args, auths) => structVal({ contract: new Address(id).toScVal(), func: symVal(func), args: xdr.ScVal.scvVec(args), auths: xdr.ScVal.scvVec(auths) });
const jv = (v) => {
  try {
    return JSON.parse(JSON.stringify(v, (k, x) => (typeof x === "bigint" ? String(x) : x)));
  } catch {
    return {};
  }
};
let fillerVer;
async function fillerVersion() {
  if (!FILLER) return 0;
  if (fillerVer !== undefined) return fillerVer;
  const r = await rawRead(FILLER, "version");
  if (r.ok) fillerVer = Number(r.value);
  return r.ok ? fillerVer : 0;
}
const soroPairs = new Map();
async function soroPair(a, b) {
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  if (soroPairs.has(key)) return soroPairs.get(key);
  const r = await rawRead(C.router, "router_pair_for", [new Address(a).toScVal(), new Address(b).toScVal()]);
  const p = r.ok && r.value ? String(r.value) : null;
  if (p) soroPairs.set(key, p);
  return p;
}
const aquaArgs = (user, tin, tout, hash, amount, min) => [new Address(user).toScVal(), aquaTokens(tin, tout), new Address(tin).toScVal(), new Address(tout).toScVal(), xdr.ScVal.scvBytes(hash), u128(amount), u128(min)];
/** What an Aquarius swap does in its caller's name, read from a simulation with your own wallet as the caller. */
const aquaTemplates = new Map();
async function aquaTemplate(tin, tout, hash) {
  const key = `${tin}:${Array.from(hash).join(",")}`;
  if (aquaTemplates.has(key)) return aquaTemplates.get(key);
  let list = null;
  try {
    const sim = await server.simulateTransaction(readCall(AQUA_ROUTER, "swap", aquaArgs(me, tin, tout, hash, SPLIT_PROBE, 1n)));
    if (!rpc.Api.isSimulationError(sim) && sim.result) {
      list = [];
      const node = (inv, depth) => {
        const cf = inv.function && inv.function.contractFn;
        if (!cf || depth > 1) return null;
        const subs = [];
        for (const s of inv.subInvocations || []) {
          const n = node(s, depth + 1);
          if (!n) return null;
          subs.push(n);
        }
        return { contract: String(jv(cf.contractAddress)), func: String(jv(cf.functionName)), args: [...cf.args], subs };
      };
      for (const entry of sim.result.auth || []) {
        for (const sub of (entry.rootInvocation && entry.rootInvocation.subInvocations) || []) {
          const n = node(sub, 0);
          if (!n) {
            list = null;
            break;
          }
          list.push(n);
        }
        if (!list) break;
      }
    }
  } catch {
    list = null;
  }
  if (list) aquaTemplates.set(key, list);
  return list;
}
function templateAuths(template, amount) {
  const subst = (args) =>
    args.map((a) => {
      const j = jv(a);
      if (j.address === me) return new Address(FILLER).toScVal();
      if (j.i128 !== undefined && typeof j.i128 !== "object" && BigInt(j.i128) === SPLIT_PROBE) return i128(amount);
      if (j.u128 !== undefined && typeof j.u128 !== "object" && BigInt(j.u128) === SPLIT_PROBE) return u128(amount);
      return a;
    });
  const leaf = (n) => structVal({ contract: new Address(n.contract).toScVal(), func: symVal(n.func), args: xdr.ScVal.scvVec(subst(n.args)) });
  return template.map((n) => structVal({ contract: new Address(n.contract).toScVal(), func: symVal(n.func), args: xdr.ScVal.scvVec(subst(n.args)), subs: xdr.ScVal.scvVec(n.subs.map(leaf)) }));
}
/** The pools a split can use: { label, quote(amount), step(amount) }. */
async function splitSources(tin, tout) {
  const list = [];
  const pair = await soroPair(tin, tout);
  if (pair) {
    list.push({
      label: "Soroswap",
      venue: "Soroswap",
      quote: async (a) => {
        const r = await rawRead(C.router, "router_get_amounts_out", [i128(a), addrVec([tin, tout])]);
        return r.ok ? BigInt(r.value[r.value.length - 1]) : null;
      },
      step: (a) =>
        callVal(
          C.router,
          "swap_exact_tokens_for_tokens",
          [i128(a), i128(0), addrVec([tin, tout]), new Address(FILLER).toScVal(), u64(Math.floor(Date.now() / 1000) + 600)],
          [structVal({ contract: new Address(tin).toScVal(), func: symVal("transfer"), args: xdr.ScVal.scvVec([new Address(FILLER).toScVal(), new Address(pair).toScVal(), i128(a)]), subs: xdr.ScVal.scvVec([]) })],
        ),
    });
  }
  const hashes = await aquaPools(tin, tout);
  for (const hash of hashes) {
    const template = await aquaTemplate(tin, tout, hash);
    if (!template) continue;
    list.push({
      label: hashes.length > 1 ? `Aquarius ${Array.from(hash.slice(0, 2)).map((x) => x.toString(16).padStart(2, "0")).join("")}` : "Aquarius",
      venue: "Aquarius",
      quote: async (a) => {
        const r = await rawRead(AQUA_ROUTER, "estimate_swap", [aquaTokens(tin, tout), new Address(tin).toScVal(), new Address(tout).toScVal(), xdr.ScVal.scvBytes(hash), u128(a)]);
        return r.ok && r.value !== undefined ? BigInt(r.value) : null;
      },
      step: (a) => callVal(AQUA_ROUTER, "swap", aquaArgs(FILLER, tin, tout, hash, a, 1n), templateAuths(template, a)),
    });
  }
  return list;
}
/**
 * Spreads the amount over the pools in whatever shares pay the most (no fixed steps: 12% here, 20% there, 68% in
 * a third). Each pool is asked what it pays at a few sizes, which gives its price curve; the amount is then
 * handed out in 1% steps, each to the pool whose curve pays the most for it. Finally the chosen amounts are
 * quoted for real. Returns { out, parts, text } when at least two pools take part, otherwise null.
 */
const SPLIT_POINTS = [2n, 5n, 10n, 20n, 35n, 50n, 70n, 100n];
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
async function bestSplit(tin, tout, amount) {
  if ((await fillerVersion()) < 3 || !AQUA_ROUTER) return null;
  let sources = await splitSources(tin, tout);
  if (sources.length < 2 || amount < 100n) return null;
  const tenth = amount / 10n;
  const first = await Promise.all(sources.map((src) => src.quote(tenth)));
  const top = first.reduce((mx, q) => (q !== null && q > mx ? q : mx), 0n);
  sources = sources.filter((src, i) => first[i] !== null && first[i] > 0n && first[i] * 2n >= top);
  if (sources.length < 2) return null;
  const curves = await Promise.all(
    sources.map(async (src) => {
      const pts = [[0n, 0n]];
      for (const p of SPLIT_POINTS) {
        const x = (amount * p) / 100n;
        if (x <= pts[pts.length - 1][0]) continue;
        const q = await src.quote(x);
        if (q === null || q <= pts[pts.length - 1][1]) break;
        pts.push([x, q]);
      }
      return pts;
    }),
  );
  const taken = sources.map(() => 0n);
  const unit = amount / 100n;
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
    if (pick < 0) return null;
    taken[pick] += size;
  }
  // shares under 2% fold into the largest one; at most 4 pools take part
  const order = sources.map((_, i) => i).filter((i) => taken[i] > 0n).sort((a, b) => (taken[b] > taken[a] ? 1 : taken[b] < taken[a] ? -1 : 0));
  const keep = order.filter((i, n) => n < 4 && taken[i] * 100n >= amount * 2n);
  if (keep.length < 2) return null;
  const used = keep.reduce((a, i) => a + taken[i], 0n);
  const parts = keep.map((i, n) => ({ src: sources[i], amount: taken[i] + (n === 0 ? amount - used : 0n) }));
  const qs = await Promise.all(parts.map((p) => p.src.quote(p.amount)));
  if (qs.includes(null)) return null;
  return { out: qs.reduce((a, b) => a + b, 0n), parts, text: parts.map((p) => `${p.src.label} ${Number((p.amount * 1000n) / amount) / 10}%`).join(" + ") };
}

/** The rate line; a click turns it round ("1 XLM = 0.12 USDC" / "1 USDC = 8.1 XLM"). */
function showRate() {
  const r = SW.rate;
  if (!r) return;
  const [x, y, v] = SW.rateFlip ? [r.b, r.a, 1 / r.rate] : [r.a, r.b, r.rate];
  $("swap-rate").textContent = `1 ${x} = ${v.toLocaleString("en-US", { maximumSignificantDigits: 6 })} ${y} ⇄`;
}
$("swap-rate").onclick = () => {
  SW.rateFlip = !SW.rateFlip;
  showRate();
};
/**
 * The route button says only how many pools the best route uses; a click opens the shares by venue. Several pools
 * of one venue are added up: which pool it is does not help the reader.
 */
function showRoute(parts) {
  const more = $("swap-route-more");
  if (!parts) {
    $("swap-route").textContent = "—";
    more.hidden = true;
    $("swap-route").setAttribute("aria-expanded", "false");
    return;
  }
  const by = new Map();
  for (const p of parts) by.set(p.venue, (by.get(p.venue) || 0) + p.share);
  const n = parts.length;
  $("swap-route").textContent = n > 1 ? `Best route · ${n} pools` : "Best route · 1 pool";
  more.innerHTML = [...by.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([venue, share]) => `<div><span>${esc(venue)}</span><b>${(Math.round(share * 10) / 10).toLocaleString("en-US")}%</b><i style="--w:${Math.min(100, share).toFixed(1)}%"></i></div>`)
    .join("");
}
$("swap-route").onclick = () => {
  const more = $("swap-route-more");
  if (!more.innerHTML) return;
  more.hidden = !more.hidden;
  $("swap-route").setAttribute("aria-expanded", String(!more.hidden));
};
// The quote is asked again every 10 seconds while the Market tab is open with an amount in it.
setInterval(() => {
  const input = $("swap-in");
  if (document.hidden || busy || SW.preparing || !me || !input.offsetParent || !String(input.value).trim()) return;
  doQuote();
}, 10_000);

/** What is on screen now, in the shape quoteMismatch() compares against. */
function swCurrent() {
  const raw = String($("swap-in").value).trim().replace(",", ".");
  const [sell, buy] = swPath();
  return { sell, buy, dir: SW.dir, amount: /^\d+(\.\d{0,7})?$/.test(raw) && Number(raw) > 0 ? toUnits(raw) : null, slip: SW.slip, wallet: me, requestId: SW.req };
}
/**
 * Asks for a quote and returns it as an immutable snapshot (or null). Every call starts a new request; an answer
 * that arrives after a newer request was started is ignored (audit IORA-01).
 */
async function doQuote() {
  const id = ++SW.req;
  SW.q = null;
  swSyms();
  const raw = String($("swap-in").value).trim().replace(",", ".");
  const note = $("swap-note");
  note.textContent = "";
  note.className = "lp-note";
  SW.out = null;
  SW.venue = null;
  if (!/^\d+(\.\d{0,7})?$/.test(raw) || Number(raw) <= 0 || !me) {
    $("swap-out").textContent = "0";
    $("swap-rate").textContent = "—";
    $("swap-min").textContent = "—";
    showRoute(null);
    $("swap-impact").textContent = "";
    return null;
  }
  const amt = toUnits(raw);
  const dir = SW.dir, slip = SW.slip, wallet = me;
  const [tin, tout] = swPath();
  const [q, aq] = await Promise.all([read(C.router, "router_get_amounts_out", [i128(amt), addrVec([tin, tout])]), aquaBest(tin, tout, amt).catch(() => null)]);
  if (id !== SW.req) return null; // a newer request was started meanwhile
  const soro = q.ok ? BigInt(q.value[q.value.length - 1]) : null;
  if (soro === null && !aq) {
    $("swap-out").textContent = "0";
    note.textContent = "No quote right now. The pool may be too small for this amount.";
    note.className = "lp-note bad";
    return null;
  }
  // The venue that pays more gets the swap.
  let route = aq && (soro === null || aq.out > soro) ? { name: "Aquarius", hash: aq.hash } : { name: "Soroswap" };
  let out = route.name === "Aquarius" ? aq.out : soro;
  // A split over several pools is used only when it clearly beats the best single pool (it costs a little more network fee).
  const split = aq && soro !== null ? await bestSplit(tin, tout, amt).catch(() => null) : null;
  if (id !== SW.req) return null;
  // Where the swap goes: one pool, or several in the shares that pay the most.
  if (split && split.out * 10000n > out * 10005n) {
    route = { name: "split", parts: split.parts, text: split.text };
    showRoute(split.parts.map((p) => ({ venue: p.src.venue, share: Number((p.amount * 1000n) / amt) / 10 })));
    out = split.out;
  } else showRoute([{ venue: route.name, share: 100 }]);
  const snap = makeQuote({ sell: tin, buy: tout, dir, amount: amt, out, slip, route, wallet, requestId: id });
  SW.q = snap;
  SW.venue = snap.route;
  SW.out = out;
  const [a, b] = dir === "xu" ? [BS, "USDC"] : ["USDC", BS];
  $("swap-out").textContent = (Number(out) / 1e7).toLocaleString("en-US", { maximumFractionDigits: 4 });
  const rate = Number(out) / Number(amt);
  SW.rate = { a, b, rate };
  showRate();
  // How far this trade's price is from the price of a small trade (the cost of the size itself).
  const spot = dir === "xu" ? SV.mkt || (marketPrice ? marketPrice : null) : marketPrice ? 1 / marketPrice : null;
  const impact = spot ? (rate / spot - 1) * 100 : null;
  $("swap-impact").textContent = impact === null || !Number.isFinite(impact) ? "" : `Price impact ${impact > -0.005 ? "0.00" : impact.toFixed(2)}%`;
  $("swap-impact").classList.toggle("bad", impact !== null && impact < -3);
  const min = snap.minOut;
  $("swap-min").textContent = `${(Number(min) / 1e7).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${b}`;
  const bal = dir === "xu" ? walletXlm : walletUsdc;
  if (dir === "xu" && walletUsdc === null) {
    note.innerHTML = 'Add a USDC trustline first on <a href="#faucet">Test funds</a>.';
    note.className = "lp-note bad";
  } else if (bal !== null && amt > bal) {
    note.textContent = `That's more than your ${fmt(bal, 2)} ${a}.`;
    note.className = "lp-note bad";
  } else if (dir === "xu" && walletXlm !== null && walletXlm - amt < BASE_KEEP) {
    note.textContent = "Keep a few XLM for network fees and reserves.";
  }
  return snap;
}
$("swap-in").addEventListener("input", quoteSwap);
$("swap-flip").onclick = () => {
  SW.dir = SW.dir === "xu" ? "ux" : "xu";
  $("swap-in").value = "";
  doQuote();
};
$("swap-max").onclick = () => {
  const bal = SW.dir === "xu" ? walletXlm : walletUsdc;
  if (bal === null) return;
  const v = SW.dir === "xu" ? bal - BASE_KEEP : bal; // leave a margin for fees with XLM
  $("swap-in").value = v > 0n ? toPlain(v) : "";
  doQuote();
};
// Maximum slippage: 0.5%, 1%, or an own value from 0.01% to 50%. Whatever is chosen is kept in this browser and
// is there again the next time the page opens; nothing has to be confirmed. An invalid own value is ignored
// (the last valid choice stays in force), an emptied field goes back to 1%.
const SLIP_KEY = "iora-slip";
const slipSaved = () => {
  try {
    const v = Number(localStorage.getItem(SLIP_KEY));
    return v >= 0.01 && v <= 50 ? v : 1;
  } catch {
    return 1;
  }
};
// The owner's own value becomes a chip of its own, first in the row, and stays there (also after a reload) so it
// is one click away even after trying another choice. The box beside the chips is only for typing a new value.
const SLIP_MINE_KEY = "iora-slip-own";
function showMine(v) {
  const b = $("slip-mine");
  if (!(v >= 0.01 && v <= 50) || v === 0.5 || v === 1) return;
  b.dataset.slip = String(v);
  b.textContent = `${v}%`;
  b.hidden = false;
  try {
    localStorage.setItem(SLIP_MINE_KEY, String(v));
  } catch {}
}
try {
  showMine(Number(localStorage.getItem(SLIP_MINE_KEY)));
} catch {}
function setSlip(v, { own = false, save = true } = {}) {
  SW.slip = v;
  if (save) {
    try {
      localStorage.setItem(SLIP_KEY, String(v));
    } catch {}
  }
  if (!own) showMine(v);
  const chip = own ? null : [...document.querySelectorAll("#slip-chips [data-slip]")].find((o) => !o.hidden && Number(o.dataset.slip) === v);
  for (const o of document.querySelectorAll("#slip-chips [data-slip]")) o.setAttribute("aria-pressed", String(o === chip));
  if (!own) $("slip-own").value = "";
  $("slip-own").parentElement.classList.toggle("on", own);
  $("slip-own").parentElement.classList.remove("bad");
  doQuote();
}
for (const c of document.querySelectorAll("#slip-chips [data-slip]")) c.onclick = () => setSlip(Number(c.dataset.slip));
const slipTyped = () => {
  const raw = $("slip-own").value.trim().replace(",", ".");
  const v = /^\d*\.?\d+$/.test(raw) ? Number(raw) : NaN;
  return v >= 0.01 && v <= 50 ? Math.round(v * 100) / 100 : raw ? NaN : null;
};
$("slip-own").addEventListener("input", () => {
  const v = slipTyped();
  if (v === null) return setSlip(slipSaved(), { save: false });
  if (Number.isNaN(v)) return $("slip-own").parentElement.classList.add("bad"); // not a usable number: the last valid choice stays
  setSlip(v, { own: true });
});
// done typing (Enter or leaving the box): the value moves into its chip and the box is empty again
const slipCommit = () => {
  const v = slipTyped();
  if (v === null || Number.isNaN(v)) return;
  setSlip(v);
};
$("slip-own").addEventListener("change", slipCommit);
$("slip-own").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    slipCommit();
    $("slip-own").blur();
  }
});
if (slipSaved() !== 1) queueMicrotask(() => setSlip(slipSaved(), { save: false }));
// While the Swap button gets its fresh quote and the wallet is asked, the amount, slippage and Max controls are
// locked; a direction change (Buy/Sell navigation) still cancels the quote, and nothing is signed then.
const SW_LOCK = "#swap-in, #swap-max, #swap-flip, #slip-own, #slip-chips button, #swap-pct input, #swap-pct button, #swap-go";
function swLock(on) {
  for (const el of document.querySelectorAll(SW_LOCK)) el.disabled = on;
}
$("swap-go").onclick = async () => {
  if (SW.preparing) return;
  if (!(await needWallet())) return;
  const raw = String($("swap-in").value).trim().replace(",", ".");
  if (toUnitsSafe(raw) === null) return;
  SW.preparing = true;
  swLock(true);
  try {
    const q = await doQuote();
    if (!q) return log("No quote available for this amount.", "err");
    // Everything that is signed comes from this one snapshot, and only while it still matches the screen.
    const why = quoteMismatch(q, swCurrent());
    if (why) return log(`The trade changed while the quote was loading (${why}). Nothing was sent; check the new quote and press the button again.`, "err");
    const bad = routeProblem(q);
    if (bad) return log(`This quote can't be used (${bad}). Nothing was sent; try again.`, "err");
    const { sell: tin, buy: tout, amount: amt, minOut: min, route } = q;
    const [a, b] = q.dir === "xu" ? [BS, "USDC"] : ["USDC", BS];
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const res =
      route.name === "split"
        ? await call(
            FILLER,
            "swap_from",
            [addr(q.wallet), new Address(tin).toScVal(), new Address(tout).toScVal(), i128(amt), i128(min), xdr.ScVal.scvVec(route.parts.map((p) => p.src.step(p.amount)))],
            `Swap ${fmt(amt, 2)} ${a} to ${b} (${route.text})`,
            { 1: "The price moved more than your slippage setting allows. Nothing was swapped; try again." },
          )
        : route.name === "Aquarius"
        ? await call(
            AQUA_ROUTER,
            "swap",
            [addr(q.wallet), aquaTokens(tin, tout), new Address(tin).toScVal(), new Address(tout).toScVal(), xdr.ScVal.scvBytes(route.hash), u128(amt), u128(min)],
            `Swap ${fmt(amt, 2)} ${a} to ${b} on Aquarius`,
            {},
          )
        : await call(
            C.router,
            "swap_exact_tokens_for_tokens",
            [i128(amt), i128(min), addrVec([tin, tout]), addr(q.wallet), u64(deadline)],
            `Swap ${fmt(amt, 2)} ${a} to ${b}`,
            {},
          );
    if (res) $("swap-in").value = "";
  } finally {
    SW.preparing = false;
    swLock(false);
  }
  doQuote();
};


// ---------------------------------------------------------------------------
// Buy, then sell at a profit: puts the XLM from a filled buy into the sell vault and places a sell order above the buy price.
// Two (three without a vault) signatures: [open sell vault] -> deposit XLM -> sell order. All with the user's approval.
// ---------------------------------------------------------------------------
function flipButton(o) {
  if (!SV.factory || BigInt(o.filled_out) <= 0n) return "";
  const px = Number(BigInt(o.filled_in)) / Number(BigInt(o.filled_out));
  return ` <button class="small ghost" data-flip="${BigInt(o.filled_out)}" data-px="${px}" title="Put this ${BS} in your sell vault and sell it above what you paid">Sell higher</button>`;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest("[data-flip]");
  if (b) flipToSell(BigInt(b.dataset.flip), Number(b.dataset.px));
});

async function flipToSell(bought, buyPx) {
  if (!SV.factory || !me || busy) return;
  if (walletXlm === null) await refresh();
  const room = walletXlm !== null ? walletXlm - BASE_KEEP : bought;
  const amount = bought < room ? bought : room;
  if (amount <= 0n) return log(`Your wallet needs more than ${fmt(XLM_KEEP, 0)} ${BS} to move any into the sell vault (that much stays for network fees).`, "err");
  const sv = await sellVaultOf();
  const steps = (sv ? 0 : 1) + 2;
  let pct = 10;
  const pxAt = (p) => buyPx * (1 + p / 100);
  const rows = [
    ["Bought at", `${px4(buyPx)} USDC per ${BS}`],
    ["Move to sell vault", `${fmt(amount, 2)} ${BS}${amount < bought ? ` <span class="muted">(of ${fmt(bought, 2)}; ${fmt(XLM_KEEP, 0)} ${BS} stays for fees)</span>` : ""}`],
    [`Sell when 1 ${BS} is at`, `<div class="chips" id="flip-chips">${[5, 10, 20].map((p) => `<button type="button" data-pct="${p}" aria-pressed="${p === pct}">+${p}%</button>`).join("")}</div>`],
    ["Sell price", `<b id="flip-px"></b>`],
    ["You receive at least", `<b id="flip-out"></b>`],
  ];
  const notes = [
    `You'll sign ${steps} transactions: ${sv ? "" : "open your sell vault, "}deposit the ${BS}, then place the sell order.`,
    `${XB ? "" : `Until it sells, the ${BS} earns interest on Blend. `}${LEAVE_NOTE}`,
  ];
  const paint = () => {
    const pu = toUnits(pxAt(pct).toFixed(7));
    $("flip-px").textContent = `${px4(pxAt(pct))} USDC`;
    $("flip-out").textContent = `${fmt(minOut(amount, sellLimit(pu)), 2)} USDC`;
    for (const c of document.querySelectorAll("#flip-chips [data-pct]")) c.setAttribute("aria-pressed", String(Number(c.dataset.pct) === pct));
  };
  const answer = ask({ title: "Sell it higher", lede: `Your buy order filled. Put that ${BS} to work: it earns on Blend until it sells above what you paid.`, rows, notes, confirm: "Continue" });
  paint();
  for (const c of document.querySelectorAll("#flip-chips [data-pct]")) {
    c.onclick = (ev) => {
      ev.preventDefault();
      pct = Number(c.dataset.pct);
      paint();
    };
  }
  if (!(await answer)) return;

  if (!sv) {
    const made = await call(SV.factory, "create_vault", [addr(me)], "Open sell vault", FACTORY_ERRORS);
    if (!made) return;
  }
  await refreshSell();
  if (!SV.vault) return log("Could not find your sell vault. Open the Sell vault page and try again.", "err");
  if (!(await call(SV.vault, "deposit", [i128(amount)], `Deposit ${fmt(amount, 2)} ${BS}`, SELL_ERRORS))) return;
  const pu = toUnits(pxAt(pct).toFixed(7));
  const limit = sellLimit(pu);
  // Not all of the deposit may be tied to the order (the rounding margin stays in the vault).
  const canOrder = await roomIn(SV.vault);
  const size = canOrder !== null && canOrder < amount ? canOrder : amount;
  if (size < MIN_ORDER) return log("The deposit arrived, but it is too small to place a sell order.", "err");
  const minFill = size / 4n >= (XB ? 1000n : U) ? size / 4n : size;
  await vaultVersion(SV.vault).catch(() => 0);
  const expiry = expiryOf(SV.vault, OLD_VAULT_DAYS);
  const placed = await call(SV.vault, "place_order", [i128(size), i128(limit), i128(minFill), u32(300), u64(expiry)], "Place sell order", SELL_ERRORS);
  await refreshSell();
  await refresh();
  if (placed) {
    log(`Sell order placed: ${fmt(size, 2)} ${BS} at ${px4(pxAt(pct))} USDC or more. It earns on Blend while it waits.`, "ok");
    askNotify();
  }
}

// ---- Chat: helpers that read both vaults together ----
async function sellVaultOf() {
  if (!SV.factory || !me) return null;
  if (SV.vault) return SV.vault;
  const r = await read(SV.factory, "vault_of", [addr(me)]);
  return r.ok && r.value ? wrapSell(r.value) : null;
}
async function openOrdersIn(v) {
  const out = [];
  for (const o of await readOrders(v)) {
    if (orderStatus(o) !== "Open") continue;
    const left = BigInt(o.amount_in) - BigInt(o.filled_in);
    if (left > 0n)
      out.push({
        id: o.id,
        left: Number(left) / 1e7,
        leftU: left,
        limit: BigInt(o.limit_price),
        minFill: BigInt(o.min_fill),
        impact: Number(o.max_impact_bps),
        trigger: BigInt(o.trigger_price || 0),
        band: Number(o.stop_band_bps || 0),
        expiry: Number(o.expiry),
      });
  }
  return out;
}
// ---------------------------------------------------------------------------
// Notify when an order fills: an in-page notice + (if allowed) a browser notification
// ---------------------------------------------------------------------------
const seenFills = new Map(); // order id -> { inn, out } (the last fill seen)
let fillsPrimed = false;

function checkFills(rows) {
  for (const o of rows) {
    const inn = BigInt(o.filled_in);
    const out = BigInt(o.filled_out);
    const prev = seenFills.get(o.id);
    if (fillsPrimed && prev && inn > prev.inn) {
      const dIn = inn - prev.inn;
      const dOut = out - prev.out;
      const full = inn === BigInt(o.amount_in);
      notifyFill(o.id, dIn, dOut, full, o.keep);
    }
    seenFills.set(o.id, { inn, out });
  }
  fillsPrimed = true;
}

let chainedOrders = new Map(); // order id -> automatic sell setting (version 3)
function notifyFill(id, dIn, dOut, full, kept) {
  const price = Number(dIn) / Number(dOut);
  const title = full ? `Order #${id} filled` : `Order #${id} partly filled`;
  const chained = chainedOrders.get(id);
  const body =
    `${fmt(dIn, 2)} USDC → ${fmt(dOut, 2)} ${BS} at ${price.toLocaleString("en-US", { maximumFractionDigits: 4 })}. ` +
    (chained
      ? sideOf(vault)
        ? `The ${BS} stayed in your vault and a sell order opened at ${px4(sellPrice(BigInt(chained.limit_price)))} USDC or more.`
        : `The ${BS} went to your sell vault with a sell order at ${px4(sellPrice(BigInt(chained.limit_price)))} USDC or more (if that couldn't happen, it's in your wallet).`
      : kept
        ? `The ${BS} is in your vault${XB ? "" : ", earning on Blend"}.`
        : `The ${BS} is in your wallet.`);
  const offer = SV.factory && !chained ? ` <button type="button" class="small" data-flip="${dOut}" data-px="${price}">Sell it higher</button>` : "";
  log(`<b>${title}.</b> ${body}${offer}`, "ok");
  if (!document.hasFocus()) {
    const base = document.title.replace(/^● /, "");
    document.title = `● ${title}`;
    window.addEventListener("focus", () => (document.title = base), { once: true });
  }
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body, icon: "/favicon.svg", tag: `berthly-fill-${id}` });
    }
  } catch {}
}

// Ask for notification permission once after the first order (tied to a user action, without nagging)
function askNotify() {
  try {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().then((p) => {
        if (p === "granted") log("You'll get a notification when your order fills, as long as this page is open.", "ok");
      });
    }
  } catch {}
}
function syncNotifyBtn() {
  const b = $("notify-btn");
  if (!("Notification" in window)) return (b.hidden = true);
  const p = Notification.permission;
  b.textContent = p === "granted" ? "Fill alerts on" : p === "denied" ? "Alerts blocked in browser" : "Notify me on fills";
  b.disabled = p !== "default";
}
$("notify-btn").onclick = async () => {
  try {
    await Notification.requestPermission();
  } catch {}
  syncNotifyBtn();
};
syncNotifyBtn();

// Risk notice on the first visit (as on Morpho). Acceptance is remembered in this browser.
(function riskNotice() {
  const KEY = "berthly-risk-v1";
  let seen = false;
  try {
    seen = localStorage.getItem(KEY) === "1";
  } catch {}
  if (seen) return;
  const d = $("risk");
  $("risk-ok").addEventListener("change", (e) => ($("risk-go").disabled = !e.target.checked));
  d.addEventListener("cancel", (e) => e.preventDefault()); // Esc does not dismiss it
  d.addEventListener("close", () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {}
  });
  // If the access gate is on, the risk note is shown after the gate is passed
  const show = () => { if (!d.open) d.showModal(); };
  const cl = document.documentElement.classList;
  if (cl.contains("app-closed") || cl.contains("app-pending")) window.addEventListener("iora:open", show, { once: true });
  else show();
})();

// ---------------------------------------------------------------------------
// Scaled buy (ladder): splits the amount into equal orders, each %gap below the one before
// ---------------------------------------------------------------------------
/**
 * Scaled order (as on exchanges): the total is split into n limit orders spaced evenly between two prices.
 * Distribution: flat = equal; inc = grows away from the market (the last order is about 3 times the first);
 * dec = the reverse. fromHigh: the first order is at the upper price (buy), otherwise at the lower one (sell). The remainder goes to the last order.
 */
const SCALE_MIN = 2, SCALE_MAX = 10; // each order needs its own signature
function scaleLevels(total, a, b, n, dist, fromHigh) {
  const lo = a < b ? a : b, hi = a < b ? b : a;
  const r = n > 1 ? 3 ** (1 / (n - 1)) : 1;
  const w = [...Array(n).keys()].map((i) => (dist === "inc" ? r ** i : dist === "dec" ? r ** (n - 1 - i) : 1));
  const sum = w.reduce((x, y) => x + y, 0);
  const out = [];
  let used = 0n;
  for (let i = 0; i < n; i++) {
    const step = n > 1 ? ((hi - lo) * BigInt(i)) / BigInt(n - 1) : 0n;
    const amt = i === n - 1 ? total - used : (total * BigInt(Math.round((w[i] / sum) * 1e6))) / 1000000n;
    used += amt;
    out.push({ amt, px: fromHigh ? hi - step : lo + step });
  }
  return out;
}
const buyLevels = (amount, a, b) => scaleLevels(amount, a, b, LADDER.n, LADDER.dist, true).map((l) => ({ amt: l.amt, lim: l.px }));
/** Scaled buy orders from the form's values; null if something is missing or invalid. */
function buyScale() {
  try {
    const amount = toUnits($("oamount").value), a = toUnits($("olimit").value), b = toUnits($("olimit2").value);
    if (amount <= 0n || a <= 0n || b <= 0n || a === b) return null;
    const lv = buyLevels(amount, a, b);
    return lv.every((l) => l.amt > 0n && l.lim > 0n) ? lv : null;
  } catch {
    return null;
  }
}

function renderLadderPreview() {
  const box = $("ladder-preview");
  const lv = LADDER.on ? buyScale() : null;
  if (!lv) return (box.hidden = true);
  box.hidden = false;
  box.innerHTML = lv
    .map((l, i) => `<div><span>${i + 1}</span><b>${fmt(l.amt, 2)} USDC</b><span>at ≤ ${fmt(l.lim)}</span><span class="muted">≥ ${fmt(minOut(l.amt, l.lim), 2)} ${BS}</span></div>`)
    .join("");
}

async function placeLadder(amount, limit, limit2, bps, impactPct, expiry) {
  amount = fitRoom(amount, freeUnits, buyRoom());
  if (!poolGuard("USDC", amount, "order")) return;
  let userMinFill = null;
  if ($("ominfill").value.trim()) {
    userMinFill = toUnitsSafe($("ominfill").value);
    if (userMinFill === null) return;
  }
  const lv = buyLevels(amount, limit, limit2);
  if (lv.some((l) => l.amt < MIN_ORDER || l.lim <= 0n)) return log("Amount is too small to split into that many orders (each order needs at least 0.1).", "err");
  const rows = lv.map((l, i) => [`Order ${i + 1}`, `${fmt(l.amt, 2)} USDC at ≤ ${fmt(l.lim)} (≥ ${fmt(minOut(l.amt, l.lim), 2)} ${BS})`]);
  rows.push(["Max price impact", `${impactPct}% per fill`]);
  if (AUTO.px) rows.push(["Take profit", `each order's ${BS} is sold at ≥ ${px4(Number(AUTO.px) / 1e7)} USDC from your sell vault${autoSpan(vault) ? ` (${autoSpan(vault)})` : ""}`]);
  const notes = [`You'll sign ${lv.length} transactions, one per order. You can stop at any point; orders already placed stay open.`];
  if (supplyApr !== null) notes.push(`All ${fmt(amount, 2)} USDC keeps earning about ${((Number(amount) / 1e7) * supplyApr / 365).toLocaleString("en-US", { maximumFractionDigits: 4 })} USDC a day until each order fills.`);
  if (!(await ask({ title: `Review ${lv.length} scaled orders`, rows, notes, confirm: `Place ${lv.length} orders` }))) return;
  const sv = AUTO.px ? await ensureFeeder() : null;
  if (AUTO.px && !sv) return;
  const steps = lv.map((l, i) => {
    let minFill = l.amt / 4n > 0n ? l.amt / 4n : l.amt;
    if (userMinFill !== null) minFill = fillFloor(l.amt, userMinFill < l.amt ? userMinFill : l.amt);
    const label = `Place order ${i + 1}/${lv.length}`;
    return () =>
      sv
        ? call(vault, "place_order_then", [i128(l.amt), i128(l.lim), i128(minFill), u32(bps), u64(expiry), addr(sv), i128(autoSellLimit().lim), u32(300), u64(autoSecs(vault))], label, VAULT_ERRORS)
        : call(vault, "place_order", [i128(l.amt), i128(l.lim), i128(minFill), u32(bps), u64(expiry)], label, VAULT_ERRORS);
  });
  const done = await runSteps(steps, "orders");
  if (done) askNotify();
}

// ---------------------------------------------------------------------------
// Scaled orders: each step is a separate signature. If a step stops (wallet window closed, rejected...)
// the remaining steps are kept and can be continued with one click, without asking for approval again.
// ---------------------------------------------------------------------------
let resumeSteps = null;
async function runSteps(steps, noun) {
  let done = 0;
  for (const [i, step] of steps.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, 700)); // give the wallet time to close the previous window
    if (!(await step())) break;
    done++;
  }
  const left = steps.slice(done);
  resumeSteps = left.length ? { steps: left, noun } : null;
  if (!left.length) log(`All ${steps.length} ${noun} placed.`, "ok");
  else
    log(
      `Placed ${done} of ${steps.length} ${noun}. The wallet stopped at number ${done + 1}. <button type="button" class="small" data-resume>Place the remaining ${left.length}</button>`,
      "err",
    );
  return done;
}
document.addEventListener("click", async (e) => {
  if (!(e.target.closest && e.target.closest("[data-resume]")) || !resumeSteps) return;
  const { steps, noun } = resumeSteps;
  resumeSteps = null;
  await runSteps(steps, noun);
  if (noun === "sell orders") await refreshSell();
});

// Where a history cursor stands: the ledger it points at.
const evLedger = (c) => {
  try {
    return Number(BigInt(String(c).split("-")[0]) >> 32n);
  } catch {
    return Infinity;
  }
};
// Reads everything the network keeps (about 7 days) for these filters, oldest first. The RPC goes through about
// 10,000 ledgers per request and may return empty pages in between; one chain of 13 requests took 2-4 s on a
// first visit, so the range is read as a few chains side by side. Each chain reads on from its own cursor until
// it reaches the start of the next one (the last: the newest ledger), so nothing depends on how far one request
// gets. Returns { events, cursor: where a later read continues, h: the network's ledger range }.
const SCAN_PARTS = 4;
const SCAN_PART_MIN = 20_000; // ledgers; a shorter range is not worth splitting
async function scanAll(filters, limit, alive = () => true) {
  const h = await server.getHealth();
  const from = h.oldestLedger + 2;
  const count = Math.max(1, Math.min(SCAN_PARTS, Math.floor((h.latestLedger - from + 1) / SCAN_PART_MIN)));
  const size = Math.ceil((h.latestLedger - from + 1) / count);
  const parts = await Promise.all(
    Array.from({ length: count }, async (_, k) => {
      const end = k === count - 1 ? Infinity : from + (k + 1) * size; // this chain covers the ledgers before `end`
      const stop = Math.min(end, h.latestLedger);
      const events = [];
      const keep = (res) => {
        for (const ev of res.events || []) if (!(ev.ledger >= end)) events.push(ev);
      };
      let res = await server.getEvents({ startLedger: from + k * size, filters, limit });
      keep(res);
      let cursor = res.cursor;
      for (let page = 0; page < 40 && cursor && alive(); page++) {
        // An answer that stops at its own last event was cut short by the page size: more may sit behind it,
        // also in the newest ledger.
        const cut = (res.events || []).length > 0 && res.events[res.events.length - 1].id === cursor;
        if (evLedger(cursor) >= stop && !(cut && end === Infinity)) break;
        res = await server.getEvents({ cursor, filters, limit });
        keep(res);
        if (!res.cursor || res.cursor === cursor) break;
        cursor = res.cursor;
      }
      return { events, cursor };
    }),
  );
  return { events: parts.flatMap((p) => p.events), cursor: parts[parts.length - 1].cursor, h };
}

// Event cache per vault: after the first scan only new events are read on each refresh. A copy is kept in this
// browser too (events never change once written), so a later visit also reads only what happened since, and
// the list keeps events the network itself has dropped by then.
const eventCache = new Map(); // vault -> { events, cursor, saved }
const EV_STORE = "iora-ev1:"; // + vault address
const EV_KEEP = 400; // events kept per vault
function evLoad(id) {
  try {
    const c = JSON.parse(localStorage.getItem(EV_STORE + id) || "null");
    if (!c || typeof c.c !== "string" || !Array.isArray(c.e)) return null;
    const events = [];
    for (const [eid, at, tx, topics, value] of c.e) {
      try {
        events.push({ id: eid, ledgerClosedAt: at, txHash: tx, topic: topics.map((t) => xdr.ScVal.fromXDR(t, "base64")), value: xdr.ScVal.fromXDR(value, "base64") });
      } catch {}
    }
    return { events, cursor: c.c, saved: c.c };
  } catch {
    return null;
  }
}
function evSave(id, cache) {
  try {
    const e = [];
    for (const ev of cache.events.slice(-EV_KEEP)) {
      try {
        e.push([ev.id || "", ev.ledgerClosedAt || "", ev.txHash || "", (ev.topic || []).map((t) => t.toXDR("base64")), ev.value.toXDR("base64")]);
      } catch {}
    }
    localStorage.setItem(EV_STORE + id, JSON.stringify({ c: cache.cursor, e }));
    cache.saved = cache.cursor;
  } catch {}
}
async function fetchVaultEvents() {
  const v = vault;
  const id = realId(v);
  const filters = [{ type: "contract", contractIds: [id] }];
  const dedupe = (list) => {
    const seen = new Set();
    return list.filter((e) => {
      const k = e.id || `${e.txHash}:${e.ledger}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  let cached = eventCache.get(v);
  if (!cached) {
    cached = evLoad(id);
    if (cached) eventCache.set(v, cached);
  }
  if (cached && cached.cursor) {
    try {
      let cursor = cached.cursor;
      const had = cached.events.length;
      for (let page = 0; page < 30; page++) {
        const res = await server.getEvents({ cursor, filters, limit: 200 });
        cached.events.push(...(res.events || []));
        if (!res.cursor || res.cursor === cursor) break;
        cursor = res.cursor;
        if (res.latestLedger && evLedger(cursor) >= res.latestLedger - 1) break; // the scan has reached the newest ledger
      }
      cached.cursor = cursor;
      cached.events = dedupe(cached.events);
      // stored again when something new arrived, or when the scan has moved on by a few hours
      if (cached.events.length !== had || evLedger(cursor) - evLedger(cached.saved) > 2000) evSave(id, cached);
      return cached.events;
    } catch (e) {
      console.warn("events (incremental)", e); // if the cursor fell outside the range the network keeps, scan from the start
    }
  }
  try {
    const all = await scanAll(filters, 200);
    // what this browser already had (older than the network keeps) stays in front of what was just read
    const fresh = { events: dedupe([...(cached ? cached.events : []), ...all.events]), cursor: all.cursor, saved: null };
    eventCache.set(v, fresh);
    if (all.cursor) evSave(id, fresh);
    return fresh.events;
  } catch (e) {
    console.warn("events", e);
  }
  return cached ? cached.events : [];
}

// escaping for on-chain data that goes into innerHTML
function esc(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
// ---------------------------------------------------------------------------
// Sell vault (XLM -> USDC). The same vault contract, from a separate factory deployed with the tokens reversed:
// the vault supplies XLM to Blend (earning interest); when the order fills it swaps the XLM to USDC on Soroswap and
// sends the USDC to its owner. The contract keeps the limit as "at most how many XLM for 1 USDC" (7 decimals);
// the user is shown "at least how many USDC for 1 XLM": limit = U*U / price (rounded down,
// so the minimum USDC is never below the price the user asked for).
// The view has the same layout as the buy vault: summary tiles, action card on the right, market and orders on the left.
// ---------------------------------------------------------------------------
/** Selects the sell page's market (null = the default XLM -> USDC). Returns true if it changed. */
function setSellMarket(sym) {
  const m = EXTRA_MARKETS.find((x) => x.sym === sym);
  const factory = m ? m.factory : SV.home;
  if (SV.factory === factory) return false;
  Object.assign(SV, { factory, out: m ? { sym: m.sym, addr: m.token } : { sym: "USDC", addr: C.usdc }, vault: null, bal: null, free: null, mkt: null });
  V3.sell = null;
  heldSeen = 0n;
  document.body.classList.remove("has-svault");
  document.body.classList.toggle("xmarket", !!m);
  for (const el of document.querySelectorAll("[data-out-sym]")) el.textContent = SV.out.sym;
  for (const el of document.querySelectorAll("[data-out-coin]")) paintCoin(el, m ? m.sym : "USDC");
  $("sv-title").textContent = m ? `${BS} → ${m.sym} vault` : "Your sell vault";
  $("sv-stats").innerHTML = "";
  $("sv-chip").innerHTML = "";
  $("sv-orders").innerHTML = "";
  $("sv-px").value = "";
  $("sv-warn").hidden = !m;
  $("sv-trust").hidden = true;
  if (SVT.type === "sl") setSellType("tp");
  return true;
}

/** In an extra market: does the wallet have a trustline for the token bought; if not, a button to add it is shown. */
async function checkOutTrust() {
  const box = $("sv-trust");
  if (SV.out.sym === "USDC" || !me) return (box.hidden = true);
  const sym = SV.out.sym, token = SV.out.addr;
  const b = await read(token, "balance", [addr(me)]);
  if (SV.out.addr !== token) return; // the market changed in the meantime
  box.hidden = b.ok;
  if (b.ok) return;
  box.innerHTML = `<span>Your wallet cannot hold ${esc(sym)} yet. Without a trustline, filled orders wait in your vault until you add one.</span> <button type="button" class="small" id="sv-trust-add">Add ${esc(sym)} trustline</button>`;
  $("sv-trust-add").onclick = async () => {
    if (busy) return;
    const nm = await read(token, "name"); // Stellar asset contract: "CODE:ISSUER"
    const issuer = nm.ok ? String(nm.value).split(":")[1] : "";
    if (!/^G[A-Z2-7]{55}$/.test(issuer || "")) return log(`Could not read the issuer of ${esc(sym)}, so the trustline cannot be added from here.`, "err");
    busy = true;
    try {
      const account = await server.getAccount(me);
      const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASS }).addOperation(Operation.changeTrust({ asset: new Asset(sym, issuer) })).setTimeout(180).build();
      log(`${esc(sym)} trustline: waiting for wallet approval…`, "wait");
      const r = await signAndSend(tx, `${sym} trustline`);
      log(`${esc(sym)} trustline added · <a href="${EXPLORER}/tx/${r.hash}" target="_blank" rel="noopener">transaction</a>`, "ok");
    } catch (e) {
      log(`Trustline: ${safeErr(e.message)}`, "err");
    } finally {
      busy = false;
      await checkOutTrust();
    }
  };
}
const XLM_KEEP = 5n * U; // XLM left in the wallet for transaction fees and the minimum balance

const SELL_ERRORS = {
  ...VAULT_ERRORS,
  2: `Not enough available ${BS} in your sell vault (${BS} reserved for open sell orders is excluded)`,
  8: "Your sell price was not met",
  9: "Invalid sell price",
  10: `Not enough ${BS} cash in the Blend pool right now`,
};

/** "1 XLM for at least p USDC" (7 decimals) -> contract limit "at most how many XLM for 1 USDC". */
function sellLimit(priceUnits) {
  return priceUnits > 0n ? (U * U) / priceUnits : 0n;
}
/** From the contract limit to the user's price (for display). */
function sellPrice(limit) {
  return Number(limit) > 0 ? 1e7 / Number(limit) : 0;
}
// Small prices (e.g. 1 XLM = 0.0000388 BTC) must not show as zero with four decimals: significant digits are used.
const px4 = (v) => (v !== 0 && Math.abs(v) < 0.01 ? v.toLocaleString("en-US", { maximumSignificantDigits: 4 }) : v.toLocaleString("en-US", { maximumFractionDigits: 4 }));
/** Decimals for amounts of the token bought: as requested for USDC, 7 for other tokens (so small amounts show). */
const outDp = (d) => (SV.out.sym === "USDC" ? d : 7);
const trim7 = (units) => (Number(units) / 1e7).toFixed(7).replace(/\.?0+$/, "");

if (SV.factory) $("nav-sell").hidden = false;

/** Blend XLM reserve: estimated yearly interest and utilisation (same model as readPool). */
async function readXlmPool() {
  if (XB) return null; // this coin is not in the Blend pool
  try {
    const [r, pc] = await Promise.all([read(C.pool, "get_reserve", [addr(C.xlm)]), read(C.pool, "get_config")]);
    if (!r.ok) return null;
    const cfg = r.value.config, d = r.value.data;
    const n7 = (v) => Number(BigInt(v)) / 1e7;
    const sup = (Number(BigInt(d.b_supply)) * Number(BigInt(d.b_rate))) / 1e12 / 1e7;
    const bor = (Number(BigInt(d.d_supply)) * Number(BigInt(d.d_rate))) / 1e12 / 1e7;
    const u = sup > 0 ? bor / sup : 0;
    let rm = Number(BigInt(d.ir_mod)) / 1e7;
    if (!(rm > 0.05 && rm < 20)) rm = Number(BigInt(d.ir_mod)) / 1e9;
    if (!(rm > 0.05 && rm < 20)) rm = 1;
    const ut = n7(cfg.util), rb = n7(cfg.r_base), r1 = n7(cfg.r_one), r2 = n7(cfg.r_two), r3 = n7(cfg.r_three);
    let ir;
    if (u <= ut) ir = rm * (rb + (u / ut) * r1);
    else if (u <= 0.95) ir = rm * (rb + r1 + ((u - ut) / (0.95 - ut)) * r2);
    else ir = rm * (rb + r1 + r2) + ((u - 0.95) / 0.05) * r3;
    const take = pc.ok && pc.value && pc.value.bstop_rate !== undefined ? n7(pc.value.bstop_rate) : 0;
    const apr = ir * u * (1 - take);
    return { apr: apr >= 0 && apr < 3 ? apr : null, util: u, supplied: sup };
  } catch {
    return null;
  }
}

async function refreshSell() {
  if (!SV.factory || !me) return;
  await pickGeneration();
  warmSell(); // the vault's reads leave together with the price's below, not after them
  const [vo, pool, q] = await Promise.all([
    read(SV.factory, "vault_of", [addr(me)]),
    readXlmPool(),
    read(C.router, "router_get_amounts_out", [i128(U), addrVec([BASE.addr, SV.out.addr])]),
  ]);
  // Market: USDC received for selling 1 XLM
  let sellRef = q.ok ? BigInt(q.value[q.value.length - 1]) : null;
  const sellQuotes = [{ venue: "Soroswap", price: sellRef ? Number(sellRef) / 1e7 : null }];
  try {
    const aq = await aquaBest(BASE.addr, SV.out.addr, U); // the best venue for a seller, as on the buy side
    if (aq && aq.out > 0n) sellQuotes.push({ venue: "Aquarius", price: Number(aq.out) / 1e7 });
    if (aq && (sellRef === null || aq.out > sellRef)) sellRef = aq.out;
  } catch {}
  if (SV.out.addr === C.usdc) {
    PX.sell = sellQuotes;
    refPrice(BASE.addr).then(paintPriceSources, () => {});
  }
  if (sellRef !== null) SV.mkt = Number(sellRef) / 1e7;
  else if (marketPrice) SV.mkt = marketPrice;
  $("sv-mkt").textContent = SV.mkt ? `Market ${px4(SV.mkt)}` : "";
  $("sv-m-price").textContent = SV.mkt ? px4(SV.mkt) : "—";
  SV.apr = pool ? pool.apr : null;
  $("sv-apr").textContent = SV.apr !== null ? `${(SV.apr * 100).toFixed(2)}%` : "—";
  if (pool) {
    $("sv-util").textContent = `${(pool.util * 100).toFixed(1)}%`;
    $("sv-util-bar").style.width = `${Math.min(100, pool.util * 100)}%`;
    $("sv-size").textContent = `of ${pool.supplied.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${BS} is borrowed`;
  }
  $("sv-wallet").textContent = walletXlm !== null ? fmt(walletXlm, 2) : "—";
  renderWalletHints();
  $("sv-walletbox").innerHTML = `<dl>
      <dt>Address</dt><dd><a href="${EXPLORER}/account/${me}" target="_blank" rel="noopener">${short(me)}</a></dd>
      <dt>XLM</dt><dd>${walletNative !== null ? fmt(walletNative, 2) : "—"}</dd>${XB ? `
      <dt>${BS}</dt><dd>${walletXlm !== null ? fmt(walletXlm, 4) : "—"}</dd>` : ""}
      <dt>${SV.out.sym}</dt><dd>${walletUsdc !== null ? fmt(walletUsdc, 2) : "no trustline"}</dd>
    </dl>`;

  SV.vault = vo.ok && vo.value ? wrapSell(vo.value) : null;
  if (SV.vault) await vaultVersion(SV.vault).catch(() => 0); // as on the buy side: known before the first order is placed
  loadFeeCap(SV.vault);
  document.body.classList.toggle("has-svault", !!SV.vault);
  if (SV.vault && V3.sell === null) V3.sell = await isV3(SV.vault);
  const stopOk = V3.sell && STOP_LOSS && SV.out.sym === "USDC"; // a stop loss needs an oracle; extra-market tokens are not in the oracle
  $("sv-type").hidden = !stopOk;
  if (!stopOk && SVT.type === "sl") setSellType("tp");
  checkOutTrust();
  $("sv-none").hidden = !!SV.vault;
  if (!SV.vault) {
    $("sv-stats").innerHTML = "";
    $("sv-chip").innerHTML = "";
    return;
  }
  const [bal, res, free, st] = await Promise.all([
    read(SV.vault, "balance"),
    read(SV.vault, "reserved"),
    read(SV.vault, "free_balance"),
    read(SV.vault, "stats"),
  ]);
  let earned = null;
  if (bal.ok && st.ok && st.value) {
    const v = st.value;
    earned = BigInt(bal.value) + BigInt(v.total_withdrawn) + BigInt(v.total_spent) - BigInt(v.total_deposited);
  }
  SV.bal = bal.ok ? BigInt(bal.value) : null;
  SV.free = free.ok ? BigInt(free.value) : null;
  $("sv-chip").innerHTML = `<span class="muted">${sideOf(SV.vault) ? "Vault" : "Sell vault"}</span> <a href="${EXPLORER}/contract/${realId(SV.vault)}" target="_blank" rel="noopener">${short(SV.vault)}</a>`;
  v7Chrome();
  $("sv-stats").innerHTML = `
    <div class="tile"><span>${XB ? "Balance in your vault" : "Balance on Blend"} ${tip(XB ? `All the ${BS} in your vault. ${BS} is not in the Blend pool, so it earns no interest.` : `Everything in your sell vault: the ${BS} you deposited plus the interest it has earned, read live from Blend.`)}</span><b><i id="sv-v-bal">—</i> <small>${BS}</small></b></div>
    <div class="tile earn"${XB ? " hidden" : ""}><span>Interest earned ${tip(`Total ${BS} interest since you opened the sell vault, including interest on ${BS} already sold or withdrawn.`)}</span><b><i id="sv-v-int">—</i> <small>${BS}</small></b></div>
    <div class="tile"><span>Reserved for orders ${tip(`${BS} set aside for your open sell orders.${XB ? "" : " It keeps earning until an order sells it."}`)}</span><b><i id="sv-v-res">—</i> <small>${BS}</small></b></div>
    <div class="tile main"><span>Available ${tip(`${BS} you can withdraw now or use for a new sell order.`)}</span><b><i id="sv-v-free">—</i> <small>${BS}</small></b></div>`;
  if (bal.ok) countTo("sv-v-bal", Number(BigInt(bal.value)) / 1e7, XB ? 6 : 4);
  if (earned !== null) countTo("sv-v-int", Number(earned > 0n ? earned : 0n) / 1e7, 6);
  if (res.ok) countTo("sv-v-res", Number(BigInt(res.value)) / 1e7, XB ? 6 : 2);
  if (free.ok) countTo("sv-v-free", Number(BigInt(free.value)) / 1e7, XB ? 6 : 4);
  $("sv-free2").textContent = $("sv-avail-wd").textContent = SV.free !== null ? fmt(SV.free, 2) : "—";
  updateSellTicket();
  await renderSellOrders();
  collectHeld();
}

// Version 4: when the wallet cannot receive USDC (no trustline) the fill's output waits in the vault; the owner collects it here.
let heldSeen = 0n;
async function collectHeld() {
  if (!V4 || !SV.vault || sideOf(SV.vault)) return;
  const h = await read(SV.out.addr, "balance", [addr(SV.vault)]);
  const amt = h.ok ? BigInt(h.value) : 0n;
  if (amt <= 0n || amt === heldSeen) return;
  heldSeen = amt;
  if (SV.out.sym === "USDC" ? walletUsdc === null : !$("sv-trust").hidden) {
    return log(`Your sell vault is keeping ${fmt(amt, outDp(2))} ${SV.out.sym} from filled orders because your wallet has no ${SV.out.sym} trustline. Add the trustline, then reload this page to collect it.`, "err");
  }
  const ok = await ask({
    title: `Collect your ${SV.out.sym}`,
    rows: [["Waiting in your sell vault", `${fmt(amt, outDp(2))} ${SV.out.sym}`]],
    notes: [`A sell order filled while your wallet could not receive ${SV.out.sym}, so your vault kept it for you. Only you can collect it.`],
    confirm: "Collect to wallet",
  });
  if (ok) await svCall("sweep", [addr(SV.out.addr)], `Collect ${fmt(amt, outDp(2))} ${SV.out.sym}`);
}

// Sell order type: "tp" = sell when the price rises (take profit), "sl" = sell if the price falls (stop loss, version 3 vaults)
const SVT = { type: "tp" };
// The stop loss trigger is read from Blend's price oracle. The testnet oracle gives a fixed price, so it does
// not work there; a mainnet build turns it on with VITE_STOP_LOSS=1.
const STOP_LOSS = import.meta.env.VITE_STOP_LOSS === "1";
const SL_SLIP = 3; // largest slippage accepted after the trigger for a stop loss (%)
/** Stop loss: trigger and worst price (both in the sell vault's unit, XLM for 1 USDC). */
function stopLevels(priceUnits) {
  const worst = (priceUnits * BigInt(100 - SL_SLIP)) / 100n;
  return { trigger: sellLimit(priceUnits), limit: sellLimit(worst), worst };
}
function setSellType(t) {
  SVT.type = t;
  for (const b of document.querySelectorAll("#sv-type [data-type]")) b.setAttribute("aria-pressed", String(b.dataset.type === t));
  const sl = t === "sl";
  $("sv-px-label").textContent = sl ? "Stop price" : "Price";
  const ups = sl ? [0, -5, -10, -20] : [0, 5, 10, 20];
  document.querySelectorAll("#sv-px-chips [data-up]").forEach((c, i) => {
    c.dataset.up = String(ups[i]);
    c.textContent = ups[i] === 0 ? "Market" : `${ups[i] > 0 ? "+" : "−"}${Math.abs(ups[i])}%`;
  });
  $("sv-place").textContent = sl ? "Place stop loss" : SVL.on ? `Place ${SVL.n} sell orders` : `Sell ${BS}`;
  if (SVL.on && !sl) $("sv-px-label").textContent = "Lowest price";
  $("sv-px").value = "";
  updateSellTicket();
}
for (const b of document.querySelectorAll("#sv-type [data-type]")) b.onclick = () => setSellType(b.dataset.type);

// Scaled sell: the amount is split into orders spaced evenly between two prices (see scaleLevels)
const SVL = { on: false, n: 5, dist: "flat" };
const sellLevels = (amount, a, b) => scaleLevels(amount, a, b, SVL.n, SVL.dist, false).map((l) => ({ amt: l.amt, px: l.px, lim: sellLimit(l.px) }));
function renderSellLadder(lv) {
  const box = $("sv-ladder-preview");
  if (!lv) return (box.hidden = true);
  box.hidden = false;
  box.innerHTML = lv
    .map((l, i) => `<div><span>${i + 1}</span><b>${fmt(l.amt, 2)} ${BS}</b><span>at ≥ ${px4(Number(l.px) / 1e7)}</span><span class="muted">≥ ${fmt(minOut(l.amt, l.lim), outDp(2))} ${SV.out.sym}</span></div>`)
    .join("");
}

function updateSellTicket() {
  let amount = null, price = null;
  try { amount = $("sv-amt").value.trim() ? toUnits($("sv-amt").value) : null; } catch {}
  try { price = $("sv-px").value.trim() ? toUnits($("sv-px").value) : null; } catch {}
  const sl = SVT.type === "sl";
  const lim = price ? (sl ? stopLevels(price).limit : sellLimit(price)) : 0n;
  let out = amount && lim > 0n ? minOut(amount, lim) : null;
  let scale = null;
  if (SVL.on && !sl) {
    let price2 = null;
    try { price2 = $("sv-px2").value.trim() ? toUnits($("sv-px2").value) : null; } catch {}
    if (amount && price && price2 && price !== price2) scale = sellLevels(amount, price, price2);
    if (scale && !scale.every((l) => l.amt > 0n && l.lim > 0n)) scale = null;
    out = scale ? scale.reduce((s, l) => s + minOut(l.amt, l.lim), 0n) : null;
  }
  renderSellLadder(scale);
  $("sv-receive").textContent = out !== null ? fmt(out, outDp(4)) : "0";
  if (document.activeElement !== $("sv-val")) $("sv-val").value = out !== null && out > 0n ? String(Number((Number(out) / 1e7).toFixed(outDp(4)))) : "";
  ticketExtras();
  const p = price ? Number(price) / 1e7 : null;
  for (const c of document.querySelectorAll("#sv-px-chips [data-up]")) {
    const want = SV.mkt ? SV.mkt * (1 + Number(c.dataset.up) / 100) : null;
    c.setAttribute("aria-pressed", String(!!(want && p && Math.abs(p - want) / want < 0.002)));
  }
  const show = !!(amount && price && out !== null);
  $("sv-preview").hidden = !show;
  if (!show) return;
  const a = Number(amount) / 1e7;
  const items = [];
  if (sl) {
    const worst = (p * (100 - SL_SLIP)) / 100;
    items.push(
      SV.apr !== null
        ? `Your ${px4(a)} ${BS} stays on Blend and earns about <b>${(a * SV.apr / 365).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${BS} a day</b> while you wait.`
        : `Your ${px4(a)} ${BS} stays on Blend and keeps earning interest while you wait.`,
    );
    items.push(
      SV.mkt && p < SV.mkt
        ? `If 1 ${BS} falls to <b>${px4(p)} ${SV.out.sym}</b> (${((1 - p / SV.mkt) * 100).toFixed(1)}% below market), the keeper sells it to limit your loss.`
        : `<span class="bad">This price is at or above the market, so it would sell right away. A stop loss is usually set below the market.</span>`,
    );
    items.push(`It never sells below <b>${px4(worst)} ${SV.out.sym}</b> (${SL_SLIP}% under your stop) and you receive at least <b>${fmt(out, outDp(4))} ${SV.out.sym}</b>. If the price gaps lower than that, it waits.`);
    items.push(`The stop stays in place until it triggers or you cancel it.`);
    $("sv-preview-list").innerHTML = items.map((t) => `<li>${t}</li>`).join("");
    return;
  }
  items.push(
    XB
      ? `Your ${px4(a)} ${BS} waits in your vault. ${BS} is not in the Blend pool, so it earns no interest while it waits.`
      : SV.apr !== null
      ? `Your ${px4(a)} ${BS} stays on Blend and earns about <b>${(a * SV.apr / 365).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${BS} a day</b> while it waits.`
      : `Your ${px4(a)} ${BS} stays on Blend and keeps earning interest while it waits.`,
  );
  items.push(
    SV.mkt && p > SV.mkt
      ? `When 1 ${BS} rises to <b>${px4(p)} ${SV.out.sym}</b> (${((p / SV.mkt - 1) * 100).toFixed(1)}% above market), the keeper sells it in one transaction.`
      : `<span class="bad">${WORSE_SELL(SV.mkt ? (1 - p / SV.mkt) * 100 : 0)}</span>`,
  );
  if (scale) {
    items.length = 1; // the first item (interest) stays; the range is described instead of the single-price sentence
    items.push(`It is split into <b>${scale.length} limit orders</b>, evenly spaced from <b>${px4(Number(scale[0].px) / 1e7)}</b> up to <b>${px4(Number(scale[scale.length - 1].px) / 1e7)} ${SV.out.sym}</b>. Each one sells by itself when the price reaches it.`);
    items.push(`If all of them sell you receive at least <b>${fmt(out, outDp(4))} ${SV.out.sym}</b> ${outIn(SV.vault)}.`);
    items.push(`Each order is placed with its own signature: <b>${scale.length} signatures</b>. ${XB ? "You" : "Unsold orders keep earning; you"} can cancel any of them at any time.`);
    $("sv-preview-list").innerHTML = items.map((t) => `<li>${t}</li>`).join("");
    return;
  }
  items.push(`You receive at least <b>${fmt(out, outDp(4))} ${SV.out.sym}</b> ${outIn(SV.vault)}.`);
  if (feeNote(SV.vault, SV.out.sym)) items.push(feeNote(SV.vault, SV.out.sym));
  items.push(`The order stays open until it sells or you cancel it. ${LEAVE_NOTE}`);
  $("sv-preview-list").innerHTML = items.map((t) => `<li>${t}</li>`).join("");
}

async function renderSellOrders() {
  const rows = await readOrders(SV.vault);
  if (!rows.length) {
    sellPrimed = true;
    $("sv-count").textContent = "";
    $("sv-orders").innerHTML = `<p class="empty">No sell orders yet. Set a price in the order form and your first sell order will show up here.</p>`;
    tradeLinesSoon();
    return;
  }
  const now = Date.now() / 1000;
  let openCount = 0;
  const html = rows
    .reverse()
    .map((o) => {
      const status = Array.isArray(o.status) ? o.status[0] : o.status?.tag || String(o.status);
      const expired = status === "Open" && Number(o.expiry) < now;
      if (status === "Open" && !expired) openCount++;
      const label = expired ? "Ended" : status;
      const sold = BigInt(o.filled_in);
      const pct = Number((sold * 100n) / BigInt(o.amount_in));
      let avg = "—";
      if (sold > 0n) {
        const got = Number(BigInt(o.filled_out)) / Number(sold);
        const better = (got / sellPrice(BigInt(o.limit_price)) - 1) * 100;
        avg = `${px4(got)}${BigInt(o.limit_price) >= DCA_NO_LIMIT ? "" : ` <span class="muted">${better.toFixed(1)}% better</span>`}`;
      }
      let waitCell = `<span class="muted">—</span>`;
      if (SV.apr !== null && status === "Open" && !expired) {
        const base = Number(BigInt(o.amount_in) - sold) / 1e7;
        waitCell = `<span class="earn-cell">+${((base * SV.apr) / 365).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${BS} / day</span>`;
      }
      const d = dcaCells(o, BS, true, status === "Open" && !expired);
      return `<tr class="${status === "Open" && !expired ? "is-open" : "is-done"}">
        <td>#${o.id}</td>
        <td>${d ? d.amt : `${fmt(o.amount_in, 2)} ${BS}`}</td>
        <td>${d ? d.lim : BigInt(o.trigger_price || 0) > 0n ? `<span class="tag stop">Stop</span> ≤ ${px4(sellPrice(BigInt(o.trigger_price)))}<span class="then-note">not below ${px4(sellPrice(BigInt(o.limit_price)))}</span>` : `≥ ${px4(sellPrice(BigInt(o.limit_price)))}`}</td>
        <td><div class="bar"><span style="width:${pct}%"></span></div>${d ? d.prog : `${pct}%`}<span class="muted">${fmt(o.filled_out, outDp(2))} ${SV.out.sym}</span></td>
        <td>${avg}</td>
        <td>${waitCell}</td>
        <td></td>
        <td><span class="tag ${status.toLowerCase()}${expired ? " expired" : ""}">${esc(label)}</span></td>
        <td>${status === "Open" ? `<button class="small ghost" data-sv-cancel="${o.id}">Cancel</button>` : ""}</td>
      </tr>`;
    })
    .join("");
  checkSellFills(rows);
  $("sv-count").textContent = `(${openCount})`;
  $("sv-orders").innerHTML = `<table><thead><tr><th>#</th><th>Amount</th><th>Price</th><th>Sold</th><th>Avg. price</th><th>Earning ${tip(`Estimated ${BS} interest the unsold part earns on Blend per day, at today's rate.`)}</th><th></th><th>Status</th><th></th></tr></thead><tbody>${html}</tbody></table>`;
  for (const b of document.querySelectorAll("[data-sv-cancel]")) b.onclick = () => cancelSell(Number(b.dataset.svCancel));
  tradeLinesSoon();
}

async function svCall(method, args, label) {
  const res = await call(SV.vault, method, args, label, SELL_ERRORS);
  await refreshSell();
  renderPortfolio();
  return res;
}

$("sv-create").onclick = async () => {
  if (
    !(await ask({
      title: "Open your sell vault",
      lede: V7 ? `Your vault will be deployed for you. It holds both your USDC and your ${BS}. Only your wallet controls it.` : `A separate vault contract for selling XLM will be deployed for you. Only your wallet controls it.`,
      rows: [["Network fee", "about 0.04 XLM, paid by your wallet"], ["Who can move funds", "Only you"]],
      confirm: "Open sell vault",
    }))
  )
    return;
  await call(SV.factory, "create_vault", [addr(me)], "Open sell vault", FACTORY_ERRORS);
  await refreshSell();
};
$("sv-refresh").onclick = () => refreshSell();

$("sv-dep-max").onclick = () => {
  if (walletXlm === null) return;
  const v = walletXlm - BASE_KEEP;
  $("sv-dep").value = v > 0n ? trim7(v) : "0";
};
$("sv-wd-max").onclick = () => {
  if (SV.free !== null) $("sv-wd").value = trim7(SV.free);
};
$("sv-amt-max").onclick = () => {
  if (SV.free !== null) $("sv-amt").value = trim7(sellRoom());
  updateSellTicket();
};

$("sv-dep-go").onclick = async () => {
  const n = toUnitsSafe($("sv-dep").value);
  if (n === null) return;
  if (XB && walletXlm !== null && n > walletXlm) return log(`You have ${fmt(walletXlm, 4)} ${BS} in your wallet. Buy some with a buy order or a Market order first.`, "err");
  if (walletXlm !== null && n > walletXlm - BASE_KEEP) {
    return log(`Keep at least ${fmt(XLM_KEEP, 0)} ${BS} in your wallet for network fees. You can deposit up to ${fmt(walletXlm > XLM_KEEP ? walletXlm - XLM_KEEP : 0n, 2)} ${BS}.`, "err");
  }
  if (!poolGuard(BS, n, "deposit")) return;
  if (await svCall("deposit", [i128(n)], `Deposit ${fmt(n, 2)} ${BS}`)) $("sv-dep").value = "";
};

$("sv-wd-go").onclick = async () => {
  let n;
  if ($("sv-wd").value.trim() === "") {
    if (SV.free === null || SV.free <= 0n) return log(`No available ${BS} to withdraw.`, "err");
    n = SV.free;
    if (V4) {
      if (await svCall("withdraw", [i128(I128_MAX)], `Withdraw all available (${fmt(n, 2)} ${BS})`)) $("sv-wd").value = "";
      return;
    }
  } else {
    n = toUnitsSafe($("sv-wd").value);
    if (n === null) return;
  }
  if (await svCall("withdraw", [i128(n)], `Withdraw ${fmt(n, 2)} ${BS}`)) $("sv-wd").value = "";
};

for (const c of document.querySelectorAll("#sv-px-chips [data-up]")) {
  c.onclick = () => {
    if (!SV.mkt) return log("Market price is not loaded yet.", "err");
    $("sv-px").value = (SV.mkt * (1 + Number(c.dataset.up) / 100)).toFixed(SV.mkt < 0.01 ? 7 : 4);
    updateSellTicket();
  };
}
$("sv-amt").addEventListener("input", updateSellTicket);
$("sv-px").addEventListener("input", updateSellTicket);

// Sell order: confirmation screen and signature from the form's amount/price/lifetime (the chat uses this too)
async function placeSellOrder(impactBps = 300, { single = false } = {}) {
  let amount = toUnitsSafe($("sv-amt").value);
  const price = toUnitsSafe($("sv-px").value);
  if (amount === null || price === null) return;
  if (XB ? (amount * price) / U < MIN_ORDER : amount < MIN_ORDER) return log(XB ? "The smallest order is worth 0.1 USDC." : `The smallest order is 0.1 ${BS}.`, "err");
  if (SV.free !== null && amount > SV.free) {
    if (offerDeposit("sv-dep", amount - SV.free, BS)) return;
    return log(`You can sell up to ${fmt(SV.free, 4)} ${BS}. Deposit more ${BS} first.`, "err");
  }
  amount = fitRoom(amount, SV.free, sellRoom());
  if (!poolGuard(BS, amount, "order")) return;
  if (SVT.type === "sl") return placeStopLoss(amount, price, impactBps);
  if (!single && SVL.on) {
    const price2 = toUnitsSafe($("sv-px2").value);
    if (price2 === null) return;
    if (price2 === price) return log("The lowest and highest price must be different.", "err");
    return placeSellLadder(amount, price, price2, impactBps);
  }
  const limit = sellLimit(price);
  if (limit <= 0n) return log("Sell price is too high.", "err");
  const minFill = amount / 4n >= (XB ? 1000n : U) ? amount / 4n : amount; // pieces of at least 1 XLM, a single piece for a small order
  await vaultVersion(SV.vault).catch(() => 0);
  const expiry = expiryOf(SV.vault, OLD_VAULT_DAYS);
  const p = Number(price) / 1e7;
  const rows = [
    ["You sell", `${fmt(amount, 4)} ${BS}`],
    [`Sell when 1 ${BS} is at or above`, `${px4(p)} ${SV.out.sym}`],
    ["You receive at least", `${fmt(minOut(amount, limit), outDp(4))} ${SV.out.sym}`],
  ];
  if (SV.mkt) rows.push(["Market price now", `${px4(SV.mkt)} ${SV.out.sym}${p > SV.mkt ? ` (your price is ${((p / SV.mkt - 1) * 100).toFixed(1)}% above)` : ""}`]);
  rows.push(["Max price impact", `${impactBps / 100}% per fill`]);
  const notes = [];
  if (SV.apr !== null) notes.push(`While it waits, your ${BS} keeps earning about ${((Number(amount) / 1e7) * SV.apr / 365).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${BS} a day on Blend.`);
  if (SV.mkt && p <= SV.mkt) notes.push(`<b>Warning.</b> ${WORSE_SELL((1 - p / SV.mkt) * 100)}`);
  if (!(await ask({ title: "Review your sell order", rows, notes, confirm: "Place sell order" }))) return;
  const placed = await svCall("place_order", [i128(amount), i128(limit), i128(minFill), u32(impactBps), u64(expiry)], "Place sell order");
  if (placed) {
    $("sv-amt").value = "";
    updateSellTicket();
    askNotify();
  }
}
$("sv-place").onclick = () => placeSellOrder();

async function placeStopLoss(amount, price, impactBps) {
  const { trigger, limit, worst } = stopLevels(price);
  if (trigger <= 0n || limit <= 0n) return log("Stop price is not valid.", "err");
  const p = Number(price) / 1e7;
  const minFill = amount / 4n >= (XB ? 1000n : U) ? amount / 4n : amount;
  await vaultVersion(SV.vault).catch(() => 0);
  const expiry = expiryOf(SV.vault, OLD_VAULT_DAYS);
  const rows = [
    ["You sell", `${fmt(amount, 4)} ${BS}`],
    [`Sell if 1 ${BS} drops to`, `${px4(p)} ${SV.out.sym}`],
    ["Never sell below", `${px4(Number(worst) / 1e7)} ${SV.out.sym}`],
    ["You receive at least", `${fmt(minOut(amount, limit), outDp(4))} ${SV.out.sym}`],
  ];
  if (SV.mkt) rows.push(["Market price now", `${px4(SV.mkt)} ${SV.out.sym}${p < SV.mkt ? ` (your stop is ${((1 - p / SV.mkt) * 100).toFixed(1)}% below)` : ""}`]);
  const notes = [];
  if (SV.apr !== null) notes.push(`Until then your ${BS} keeps earning about ${((Number(amount) / 1e7) * SV.apr / 365).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${BS} a day on Blend.`);
  if (SV.mkt && p >= SV.mkt) notes.push("Your stop is at or above the market price, so it can sell on the keeper's next scan.");
  notes.push(`If the price falls straight past ${px4(Number(worst) / 1e7)} ${SV.out.sym}, the order waits instead of selling cheaper.`);
  if (!(await ask({ title: "Review your stop loss", rows, notes, confirm: "Place stop loss" }))) return;
  const placed = await svCall("place_stop_order", [i128(amount), i128(trigger), i128(limit), i128(minFill), u32(impactBps), u64(expiry), ...(V4 ? [u32(SL_BAND_BPS)] : [])], "Place stop loss");
  if (placed) {
    $("sv-amt").value = "";
    updateSellTicket();
    askNotify();
  }
}

async function placeSellLadder(amount, price, price2, impactBps) {
  amount = fitRoom(amount, SV.free, sellRoom());
  if (!poolGuard(BS, amount, "order")) return;
  const lv = sellLevels(amount, price, price2);
  if (lv.some((l) => l.amt < MIN_ORDER || l.lim <= 0n)) return log("Amount is too small to split into that many orders (each order needs at least 0.1).", "err");
  await vaultVersion(SV.vault).catch(() => 0);
  const expiry = expiryOf(SV.vault, OLD_VAULT_DAYS);
  const rows = lv.map((l, i) => [`Order ${i + 1}`, `${fmt(l.amt, 2)} ${BS} at ≥ ${px4(Number(l.px) / 1e7)} (≥ ${fmt(minOut(l.amt, l.lim), outDp(2))} ${SV.out.sym})`]);
  if (SV.mkt) rows.push(["Market price now", `${px4(SV.mkt)} ${SV.out.sym}`]);
  rows.push(["Max price impact", `${impactBps / 100}% per fill`]);
  const notes = [`You'll sign ${lv.length} transactions, one per order. You can stop at any point; orders already placed stay open.`];
  if (SV.apr !== null) notes.push(`All ${fmt(amount, 2)} ${BS} keeps earning about ${((Number(amount) / 1e7) * SV.apr / 365).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${BS} a day until each order sells.`);
  if (!(await ask({ title: `Review ${lv.length} scaled sell orders`, rows, notes, confirm: `Place ${lv.length} orders` }))) return;
  const steps = lv.map((l, i) => {
    const minFill = l.amt / 4n >= (XB ? 1000n : U) ? l.amt / 4n : l.amt;
    return () => call(SV.vault, "place_order", [i128(l.amt), i128(l.lim), i128(minFill), u32(impactBps), u64(expiry)], `Place sell order ${i + 1}/${lv.length}`, SELL_ERRORS);
  });
  const done = await runSteps(steps, "sell orders");
  await refreshSell();
  if (done) {
    $("sv-amt").value = "";
    updateSellTicket();
    askNotify();
  }
}
async function cancelSell(id) {
  if (
    !(await ask({
      title: `Cancel sell order #${id}?`,
      lede: `The unsold ${BS} returns to your available balance right away${XB ? "" : " and keeps earning on Blend"}.`,
      confirm: "Cancel order",
      back: "Keep order",
    }))
  )
    return;
  await svCall("cancel_order", [u32(id)], `Cancel sell #${id}`);
}

// Update when the Sell page opens, when the wallet connects, and regularly
window.addEventListener("hashchange", () => (location.hash === "#sell" || location.hash === "#portfolio") && me && refreshSell());
setInterval(() => {
  let job = null;
  if (me && !busy && (location.hash === "#sell" || location.hash === "#portfolio") && document.visibilityState === "visible") job = refreshSell();
  else if (me && !busy) job = pollSellFills(); // catch sell fills while on another page too
  if (job) Promise.resolve(job).catch((e) => console.warn("sell refresh failed", e));
}, 30000);

// ---- Notification when a sell order fills (same as for buys: in-page + browser notification) ----
const seenSell = new Map();
let sellPrimed = false;
function checkSellFills(rows) {
  for (const o of rows) {
    const inn = BigInt(o.filled_in);
    const out = BigInt(o.filled_out);
    const prev = seenSell.get(o.id);
    if (sellPrimed && prev && inn > prev.inn) notifySellFill(o.id, inn - prev.inn, out - prev.out, inn === BigInt(o.amount_in), o.keep);
    seenSell.set(o.id, { inn, out });
  }
  sellPrimed = true;
}
function notifySellFill(id, dIn, dOut, full, kept) {
  const price = Number(dOut) / Number(dIn);
  const title = full ? `Sell order #${id} filled` : `Sell order #${id} partly filled`;
  const body = `${fmt(dIn, 2)} ${BS} → ${fmt(dOut, outDp(2))} ${SV.out.sym} at ${px4(price)}. The ${SV.out.sym} is ${kept ? "in your vault, earning on Blend" : "in your wallet"}.`;
  log(`<b>${title}.</b> ${body}`, "ok");
  if (!document.hasFocus()) {
    const base = document.title.replace(/^● /, "");
    document.title = `● ${title}`;
    window.addEventListener("focus", () => (document.title = base), { once: true });
  }
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body, icon: "/favicon.svg", tag: `iora-sell-fill-${id}` });
    }
  } catch {}
}
async function pollSellFills() {
  if (!SV.factory) return;
  if (!SV.vault) SV.vault = await sellVaultOf();
  if (SV.vault) await renderSellOrders();
}

// ---------------------------------------------------------------------------
// Trading screen: price chart, pool depth, market selector.
// The chart uses no made-up data: the real price history is derived from the "sync" events (reserves after each
// trade) of the Soroswap pool where orders fill. The network keeps about a week of events; the points seen are
// stored in the browser, so the history grows over time in the same browser. If the pool had no trades the line stays flat.
// ---------------------------------------------------------------------------
const cssv = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();
const SYNC_TOPIC = xdr.ScVal.scvSymbol("sync").toXDR("base64");
const PX_KEEP = 6000; // most price points stored in the browser

function tradeMarket() {
  const xm = document.body.dataset.view === "sell" && document.body.classList.contains("xmarket");
  return xm ? { quote: SV.out.sym, token: SV.out.addr } : { quote: "USDC", token: C.usdc };
}
function pxCacheGet(pair) {
  try {
    const c = JSON.parse(localStorage.getItem(`iora-px:${pair}`) || "null");
    if (c && Array.isArray(c.p)) return { cursor: c.c || null, pts: c.p.filter((x) => x[0] > 0 && x[1] > 0).map(([t, p, live]) => (live ? { t, p, live: 1 } : { t, p })) };
  } catch {}
  return { cursor: null, pts: [] };
}
function pxCacheSet(pair, cursor, pts) {
  try {
    localStorage.setItem(`iora-px:${pair}`, JSON.stringify({ c: cursor, p: pts.slice(-PX_KEEP).map((x) => (x.live ? [x.t, x.p, 1] : [x.t, x.p])) }));
  } catch {}
}
function tradeNote(text) {
  TR.note = text || "";
  const el = $("ch-note");
  el.textContent = TR.note;
  el.hidden = !TR.note;
}

/** When the page or market changes: moves the chart box to the open page and loads the new market's pool if needed. */
async function tradeSync() {
  const v = document.body.dataset.view;
  if (v !== "vault" && v !== "sell") return;
  const slot = document.querySelector(`[data-view-pane="${v}"] .tslot`);
  const stage = $("tstage");
  if (slot && stage.parentElement !== slot) slot.append(stage);
  marketPaneSync(v);
  const m = tradeMarket();
  for (const sel of document.querySelectorAll(".pairsel")) sel.value = V7 ? BS : m.token === C.usdc ? "home" : m.quote;
  if (TR.key === m.token) return drawChart();
  Object.assign(TR, { key: m.token, quote: m.quote, pair: null, pts: [], res: null, spot: null, lines: [], hover: null, scanned: false });
  tradeNote("");
  drawChart();
  paintDepth();
  paintTradeBar();
  const r = await read(C.router, "router_pair_for", [addr(BASE.addr), addr(m.token)]);
  if (TR.key !== m.token) return;
  if (!r.ok || !r.value) return tradeNote("This market has no pool with a price history yet, so there is nothing to chart.");
  const pair = String(r.value);
  // The chart is the Soroswap pool's history; the price at the top is the best venue's, so the legend says which is which.
  $("ch-src").textContent = `Price history of the Soroswap ${BS} / USDC pool (the price at the top is the best pool's, so they can differ on testnet); your orders fill wherever the price is best. Drag to go back in time, scroll to zoom, double-click to reset.`;
  paintPriceSources();
  read(pair, "get_reserves").catch(() => {}); // asked now, read in tradeTick below: the live price arrives one round sooner
  const t0 = await read(pair, "token_0");
  if (TR.key !== m.token) return;
  TR.base0 = t0.ok ? String(t0.value) === BASE.addr : true;
  TR.pair = pair;
  TR.pts = pxCacheGet(pair).pts;
  drawChart();
  tradeLinesSoon();
  await tradeTick();
  await tradeHistory();
}

const resPrice = (r0, r1) => {
  const b = Number(TR.base0 ? r0 : r1), q = Number(TR.base0 ? r1 : r0);
  return b > 0 && q > 0 ? { p: q / b, base: b / 1e7, quote: q / 1e7 } : null;
};
function pushPoint(t, p) {
  const last = TR.pts[TR.pts.length - 1];
  if (last && (last.t > t || last.p === p)) return false;
  TR.pts.push({ t, p, live: 1 }); // live read: a price point, but not counted as a pool trade
  return true;
}

/** The pool's current reserves: spot price and depth. */
async function tradeTick() {
  const pair = TR.pair;
  if (!pair) return;
  const r = await read(pair, "get_reserves");
  if (TR.pair !== pair || !r.ok || !r.value) return;
  const x = resPrice(BigInt(r.value[0]), BigInt(r.value[1]));
  if (!x) return tradeNote("This pool is empty, so it has no price yet.");
  TR.res = x;
  TR.spot = x.p;
  pushPoint(Math.floor(Date.now() / 1000), x.p);
  drawChart();
  paintDepth();
  paintTradeBar();
}

/** Price points from the pool's event history. The cursor is stored: on the next open only new events are read. */
async function tradeHistory() {
  const pair = TR.pair;
  if (!pair) return;
  const cache = pxCacheGet(pair);
  const ledgerOf = (c) => {
    try {
      return Number(BigInt(String(c).split("-")[0]) >> 32n);
    } catch {
      return Infinity;
    }
  };
  const parse = (events, into) => {
    for (const ev of events || []) {
      try {
        const d = scValToNative(ev.value);
        if (!d || d.new_reserve_0 === undefined || !ev.ledgerClosedAt) continue;
        const x = resPrice(BigInt(d.new_reserve_0), BigInt(d.new_reserve_1));
        if (x) into.push({ t: Math.floor(Date.parse(ev.ledgerClosedAt) / 1000), p: x.p });
      } catch {}
    }
  };
  const scan = async (first, filters, limit) => {
    const h = await server.getHealth();
    const got = [];
    let res = await server.getEvents({ ...first(h), filters, limit });
    parse(res.events, got);
    let cursor = res.cursor;
    for (let page = 0; page < 40 && cursor && ledgerOf(cursor) < h.latestLedger; page++) {
      if (TR.pair !== pair) return null;
      res = await server.getEvents({ cursor, filters, limit });
      parse(res.events, got);
      if (!res.cursor || res.cursor === cursor) break;
      cursor = res.cursor;
    }
    return { got, cursor, h };
  };
  const strict = [{ type: "contract", contractIds: [pair], topics: [["*", SYNC_TOPIC]] }];
  const loose = [{ type: "contract", contractIds: [pair] }];
  let out = null;
  // 1) continue from the stored cursor  2) from the oldest ledger the network keeps  3) without a filter if the topic filter is not accepted
  const tries = [];
  const full = (filters, limit) => async () => {
    const all = await scanAll(filters, limit, () => TR.pair === pair);
    const got = [];
    parse(all.events, got);
    return { got, cursor: all.cursor, h: all.h, full: true };
  };
  if (cache.cursor) tries.push(() => scan(() => ({ cursor: cache.cursor }), strict, 1000));
  tries.push(full(strict, 1000));
  tries.push(full(loose, 200));
  for (const t of tries) {
    try {
      out = await t();
      break;
    } catch (e) {
      console.warn("price history", e);
    }
  }
  if (TR.pair !== pair) return;
  TR.scanned = true;
  if (out) {
    // If there was no trade in the scanned period the price did not change over it: the line starts at the beginning of the scan
    if (out.full && !out.got.length && TR.spot) {
      const t0 = Number(out.h.oldestLedgerCloseTime) || Math.floor(Date.now() / 1000) - (out.h.latestLedger - out.h.oldestLedger) * 5;
      if (!cache.pts.length || cache.pts[cache.pts.length - 1].p === TR.spot) out.got.push({ t: t0, p: TR.spot });
    }
    const first = out.got.length ? out.got[0].t : Infinity;
    const live = TR.pts.filter((x) => !cache.pts.some((c) => c.t === x.t && c.p === x.p)); // points added live in this session
    const merged = [...cache.pts.filter((x) => x.t < first), ...out.got, ...live].sort((a, b) => a.t - b.t);
    TR.pts = merged.filter((x, i) => i === 0 || x.p !== merged[i - 1].p || x.t !== merged[i - 1].t);
    pxCacheSet(pair, out.cursor || cache.cursor, TR.pts);
  }
  const distinct = new Set(TR.pts.map((x) => x.p)).size;
  tradeNote(
    !out
      ? "Could not load this pool's price history from the network right now. The line shows the live price from this moment on."
      : distinct < 2
        ? "Nobody has traded in this pool in the days the network keeps, so the price line is flat. It only moves when someone trades."
        : "",
  );
  chartFit();
  drawChart();
  paintTradeBar();
}

/** When a market first loads, the candle size is chosen so that all the history at hand fits on screen (the user can change it later). */
function chartFit() {
  if (TR.fitted === TR.pair || !TR.pts.length) return;
  TR.fitted = TR.pair;
  const box = $("ch").parentElement.getBoundingClientRect();
  const plotW = (box.width || 800) - 84;
  const span = Date.now() / 1000 - TR.pts[0].t;
  // Smallest candle size: the whole history must fit with at least 5 px per bucket; then the bucket width opens up to fill the area
  TR.tf = [900, 3600, 14400, 86400].find((tf) => plotW / (span / tf + 2) >= 6) || 86400;
  CH.cw = Math.min(12, Math.max(6, plotW / (span / TR.tf + 2)));
  CH.pan = 0;
  for (const o of document.querySelectorAll("#ch-tf [data-tf]")) o.setAttribute("aria-pressed", String(Number(o.dataset.tf) === TR.tf));
}

/** Candles for the buckets in [from, to]. Buckets before the first point are left empty (the price then is unknown). */
function candlesOf(pts, tf, from, to) {
  if (!pts.length) return [];
  from = Math.max(from, Math.floor(pts[0].t / tf) * tf);
  const out = [];
  let i = 0, prev = pts[0].p;
  while (i < pts.length && pts[i].t < from) prev = pts[i++].p;
  for (let t = from; t <= to; t += tf) {
    let h = prev, l = prev, c = prev, n = 0;
    while (i < pts.length && pts[i].t < t + tf) {
      const x = pts[i++], p = x.p;
      if (p > h) h = p;
      if (p < l) l = p;
      c = p;
      if (!x.live) n++;
    }
    out.push({ t, o: prev, h, l, c, n });
    prev = c;
  }
  return out;
}
const niceStep = (raw) => {
  const e = 10 ** Math.floor(Math.log10(raw)), f = raw / e;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * e;
};
let chartDp = 4;
const cpx = (v, extra = 0) => v.toLocaleString("en-US", { minimumFractionDigits: chartDp + extra, maximumFractionDigits: chartDp + extra });
// View: line (readable for pools with few trades) or candles; zoom (bucket width) and scrolling into the past
const CH = { mode: "line", cw: 10, pan: 0, drag: null, geo: null };
try {
  if (localStorage.getItem("iora-chart-mode") === "candle") CH.mode = "candle";
} catch {}
// Semi-transparent color for the canvas: the CSS variable's value (hex, rgb, color-mix...) is resolved by the browser and turned into rgba
const rgbCache = new Map();
function rgbOf(color) {
  if (rgbCache.has(color)) return rgbCache.get(color);
  const probe = document.createElement("i");
  probe.style.cssText = `position:absolute;visibility:hidden;color:${color}`;
  document.body.append(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  const n = (c.match(/[\d.]+/g) || []).map(Number);
  let rgb = [128, 128, 128];
  if (c.startsWith("rgb") && n.length >= 3) rgb = n.slice(0, 3);
  else if (c.startsWith("color(") && n.length >= 3) rgb = n.slice(0, 3).map((v) => Math.round(v * 255));
  rgbCache.set(color, rgb);
  return rgb;
}
const alpha = (color, a) => {
  const [r, g, b] = rgbOf(color);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
}

function drawChart() {
  const cv = $("ch");
  const box = cv.parentElement.getBoundingClientRect();
  if (!box.width || !box.height) return;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  cv.width = Math.round(box.width * dpr);
  cv.height = Math.round(box.height * dpr);
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = box.width, H = box.height;
  g.clearRect(0, 0, W, H);
  const mono = cssv("--mono") || "monospace", sans = cssv("--sans") || "sans-serif";
  const col = { line: cssv("--line"), line2: cssv("--line-2"), muted: cssv("--muted"), text: cssv("--text"), text2: cssv("--text-2"), card: cssv("--card"), up: cssv("--ok"), down: cssv("--down"), buy: cssv("--accent"), sell: cssv("--amber") };
  const now = Math.floor(Date.now() / 1000);
  const pts = TR.pts;
  $("ch-live").hidden = CH.pan === 0;
  if (!pts.length) {
    g.font = `13px ${sans}`;
    g.fillStyle = col.muted;
    g.textAlign = "center";
    g.fillText(TR.note ? "" : "Loading the pool's price history…", W / 2, H / 2);
    $("ch-ohlc").textContent = "";
    CH.geo = null;
    return;
  }
  const tf = TR.tf, cw = CH.cw, small = W < 520;
  const padT = 10, padB = 26, volH = small ? 26 : 38;
  // Window: the right edge is "now - scroll"; the width is however many buckets fit
  g.font = `11.5px ${mono}`;
  const prevDp = chartDp;
  let padR = 64;
  const maxPan = Math.max(0, now - pts[0].t - tf * 8);
  if (CH.pan > maxPan) CH.pan = maxPan;
  const endB = Math.floor((now - CH.pan) / tf) * tf; // start of the last bucket
  const build = () => {
    const count = Math.max(12, Math.floor((W - padR - 8) / cw));
    const from = endB - (count - 1) * tf, winEnd = endB + tf;
    return { count, from, winEnd, cs: candlesOf(pts, tf, from, endB) };
  };
  let win = build();
  // Scale: the prices in the window + nearby order lines
  let lo = Infinity, hi = -Infinity;
  for (const c of win.cs) {
    if (c.l < lo) lo = c.l;
    if (c.h > hi) hi = c.h;
  }
  if (!win.cs.length) lo = hi = pts[0].p;
  const mid = (lo + hi) / 2;
  for (const o of TR.lines) if (o.price > mid * 0.88 && o.price < mid * 1.12) { lo = Math.min(lo, o.price); hi = Math.max(hi, o.price); }
  if (hi - lo < mid * 0.004) { lo = mid * 0.998; hi = mid * 1.002; } // flat line: a narrow but non-zero range
  const padY = (hi - lo) * 0.12;
  lo -= padY;
  hi += padY;
  const ph = H - padT - padB - volH - 6;
  const step = niceStep((hi - lo) / Math.max(3, Math.floor(ph / 56)));
  chartDp = Math.max(2, Math.min(9, Math.ceil(-Math.log10(step)) + 1));
  const wantR = Math.ceil(g.measureText(cpx(hi, 1)).width) + 22;
  if (wantR !== padR) {
    padR = wantR;
    win = build();
  }
  void prevDp;
  const plotR = W - padR - 8; // right edge of the last bucket
  const x = (t) => plotR - ((win.winEnd - t) / tf) * cw;
  const y = (p) => padT + ((hi - p) / (hi - lo)) * ph;
  const tOfX = (px) => win.winEnd - ((plotR - px) / cw) * tf;
  CH.geo = { tOfX, plotR, padR, W };
  const up = win.cs.length ? win.cs[win.cs.length - 1].c >= win.cs[0].o : true;
  const trend = up ? col.up : col.down;

  // --- grid
  g.lineWidth = 1;
  g.textBaseline = "middle";
  g.strokeStyle = alpha(col.line2, 0.55);
  g.fillStyle = col.muted;
  g.textAlign = "left";
  g.setLineDash([2, 4]);
  // Axis labels under the label boxes (order prices, last price) are not drawn
  const pillYs = [...TR.lines.map((o) => o.price), TR.spot || pts[pts.length - 1].p].filter((v) => v > lo && v < hi).map((v) => y(v));
  for (let p = Math.ceil(lo / step) * step; p < hi; p += step) {
    const yy = Math.round(y(p)) + 0.5;
    g.beginPath();
    g.moveTo(0, yy);
    g.lineTo(W - padR, yy);
    g.stroke();
    if (!pillYs.some((v) => Math.abs(v - yy) < 17)) g.fillText(cpx(p), W - padR + 10, yy);
  }
  // time axis: aligned to local time, labels at least ~96 px apart
  const spanS = ((W - padR) / cw) * tf;
  const tStep = [900, 1800, 3600, 7200, 14400, 21600, 43200, 86400, 172800, 345600, 604800].find((s) => (s / spanS) * (W - padR) >= 96) || 604800;
  const tz = -new Date().getTimezoneOffset() * 60;
  g.textAlign = "center";
  for (let t = Math.ceil((tOfX(0) + tz) / tStep) * tStep - tz; t <= win.winEnd; t += tStep) {
    const xx = Math.round(x(t)) + 0.5;
    if (xx < 24 || xx > W - padR - 4) continue;
    g.beginPath();
    g.moveTo(xx, padT);
    g.lineTo(xx, H - padB);
    g.stroke();
    const d = new Date(t * 1000);
    const midnight = d.getHours() === 0 && d.getMinutes() === 0;
    g.fillStyle = midnight ? col.text2 : col.muted;
    g.fillText(midnight || tStep >= 86400 ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`, xx, H - padB / 2 + 1);
  }
  g.setLineDash([]);
  g.fillStyle = col.muted;

  g.save();
  g.beginPath();
  g.rect(0, 0, W - padR, H - padB);
  g.clip();
  // --- number of pool trades (bottom strip)
  const nmax = Math.max(4, ...win.cs.map((c) => c.n)); // keep the odd trade as a short bar
  for (const c of win.cs) {
    if (!c.n) continue;
    const vh = Math.max(3, (c.n / nmax) * volH), bw = Math.min(8, Math.max(2, cw - 3));
    g.fillStyle = alpha(CH.mode === "candle" ? (c.c >= c.o ? col.up : col.down) : col.text2, 0.3);
    roundRect(g, x(c.t) + (cw - bw) / 2, H - padB - vh, bw, vh, Math.min(2, bw / 2));
    g.fill();
  }
  // --- price
  if (CH.mode === "line") {
    // The AMM price is constant between two trades: a stepped line shows the truth
    const t0 = Math.max(win.cs.length ? win.cs[0].t : pts[0].t, pts[0].t);
    const tEnd = Math.min(now, win.winEnd);
    let i = 0, p = pts[0].p;
    while (i < pts.length && pts[i].t <= t0) p = pts[i++].p;
    const path = [[x(t0), y(p)]];
    for (; i < pts.length && pts[i].t <= tEnd; i++) {
      path.push([x(pts[i].t), y(p)]);
      p = pts[i].p;
      path.push([x(pts[i].t), y(p)]);
    }
    path.push([x(tEnd), y(p)]);
    const grad = g.createLinearGradient(0, padT, 0, padT + ph + volH);
    grad.addColorStop(0, alpha(trend, 0.26));
    grad.addColorStop(1, alpha(trend, 0));
    g.beginPath();
    path.forEach(([px, py], k) => (k ? g.lineTo(px, py) : g.moveTo(px, py)));
    g.lineTo(path[path.length - 1][0], H - padB);
    g.lineTo(path[0][0], H - padB);
    g.closePath();
    g.fillStyle = grad;
    g.fill();
    g.beginPath();
    path.forEach(([px, py], k) => (k ? g.lineTo(px, py) : g.moveTo(px, py)));
    g.strokeStyle = trend;
    g.lineWidth = 2;
    g.lineJoin = "round";
    g.lineCap = "round";
    g.stroke();
    g.lineWidth = 1;
    if (CH.pan === 0) {
      const [lx, ly] = path[path.length - 1];
      g.fillStyle = alpha(trend, 0.22);
      g.beginPath();
      g.arc(lx, ly, 7, 0, 7);
      g.fill();
      g.fillStyle = trend;
      g.beginPath();
      g.arc(lx, ly, 3.5, 0, 7);
      g.fill();
    }
  } else {
    const bw = Math.max(1, Math.min(cw - 2, Math.round(cw * 0.72)));
    for (const c of win.cs) {
      const flat = c.h === c.l;
      const cc = flat ? alpha(col.muted, 0.7) : c.c >= c.o ? col.up : col.down;
      const cx0 = x(c.t) + (cw - bw) / 2, m = Math.round(x(c.t) + cw / 2) + 0.5;
      g.strokeStyle = cc;
      g.fillStyle = cc;
      if (!flat) {
        g.beginPath();
        g.moveTo(m, y(c.h));
        g.lineTo(m, y(c.l));
        g.stroke();
      }
      const yo = y(c.o), yc = y(c.c), bh = Math.max(flat ? 1.5 : 2, Math.abs(yc - yo));
      roundRect(g, cx0, Math.min(yo, yc) - (Math.abs(yc - yo) < 2 ? bh / 2 : 0), bw, bh, Math.min(1.5, bw / 2));
      g.fill();
    }
  }
  g.restore();

  const pill = (yy, text, c, solid) => {
    g.font = `500 11.5px ${mono}`;
    const w = padR - 6;
    roundRect(g, W - padR + 3, yy - 10, w, 20, 5);
    g.fillStyle = solid ? c : col.card;
    g.fill();
    if (!solid) {
      g.strokeStyle = c;
      g.stroke();
    }
    g.fillStyle = solid ? col.card : c;
    g.textAlign = "left";
    g.fillText(text, W - padR + 10, yy + 0.5);
  };
  // --- open orders
  const used = [];
  for (const o of [...TR.lines].sort((a, b) => b.price - a.price)) {
    const c = o.side === "buy" ? col.buy : col.sell;
    const off = o.price >= hi ? "↑ " : o.price <= lo ? "↓ " : "";
    let yy = off ? (o.price >= hi ? padT + 11 : padT + ph - 11) : Math.round(y(o.price)) + 0.5;
    if (!off) {
      g.strokeStyle = alpha(c, 0.85);
      g.setLineDash([6, 4]);
      g.beginPath();
      g.moveTo(0, yy);
      g.lineTo(W - padR, yy);
      g.stroke();
      g.setLineDash([]);
      pill(yy, cpx(o.price), c, false);
    }
    while (used.some((u) => Math.abs(u - yy) < 22)) yy += 22; // overlapping labels shift down
    used.push(yy);
    const lab = off ? `${off}${o.text} at ${cpx(o.price)}` : o.text;
    g.font = `500 11.5px ${sans}`;
    const tw = g.measureText(lab).width + 16;
    roundRect(g, 6, yy - 10, tw, 20, 5);
    g.fillStyle = col.card;
    g.fill();
    g.strokeStyle = alpha(c, 0.7);
    g.stroke();
    g.fillStyle = c;
    g.textAlign = "left";
    g.fillText(lab, 14, yy + 0.5);
  }
  // --- last price
  const lastP = TR.spot || pts[pts.length - 1].p;
  if (lastP > lo && lastP < hi) {
    const yl = Math.round(y(lastP)) + 0.5;
    g.strokeStyle = alpha(trend, 0.8);
    g.setLineDash([2, 3]);
    g.beginPath();
    g.moveTo(0, yl);
    g.lineTo(W - padR, yl);
    g.stroke();
    g.setLineDash([]);
    pill(yl, cpx(lastP, 1), trend, true);
  }
  // --- cursor and top row
  const priceAt = (t) => {
    let p = null;
    for (const q of pts) {
      if (q.t > t) break;
      p = q.p;
    }
    return p;
  };
  const stamp = (t) => new Date(t * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  const hov = TR.hover && !CH.drag && TR.hover.x < W - padR && TR.hover.y < H - padB ? TR.hover : null;
  let head;
  if (hov) {
    const t = Math.min(tOfX(hov.x), now);
    const c = win.cs.find((k) => t >= k.t && t < k.t + tf);
    const snapX = CH.mode === "candle" && c ? Math.round(x(c.t) + cw / 2) + 0.5 : Math.round(hov.x) + 0.5;
    g.strokeStyle = alpha(col.text2, 0.6);
    g.setLineDash([4, 4]);
    g.beginPath();
    g.moveTo(snapX, padT);
    g.lineTo(snapX, H - padB);
    g.stroke();
    if (hov.y > padT && hov.y < padT + ph) {
      g.beginPath();
      g.moveTo(0, Math.round(hov.y) + 0.5);
      g.lineTo(W - padR, Math.round(hov.y) + 0.5);
      g.stroke();
      g.setLineDash([]);
      pill(hov.y, cpx(hi - ((hov.y - padT) / ph) * (hi - lo), 1), col.text2, false);
    }
    g.setLineDash([]);
    const tl = stamp(CH.mode === "candle" && c ? c.t : t);
    g.font = `500 11.5px ${mono}`;
    const tw = g.measureText(tl).width + 14;
    const tx = Math.min(Math.max(snapX - tw / 2, 2), W - padR - tw - 2);
    roundRect(g, tx, H - padB + 3, tw, 20, 5);
    g.fillStyle = col.text2;
    g.fill();
    g.fillStyle = col.card;
    g.textAlign = "left";
    g.fillText(tl, tx + 7, H - padB + 13.5);
    if (CH.mode === "line") {
      const p = priceAt(t);
      if (p !== null) {
        g.fillStyle = col.card;
        g.beginPath();
        g.arc(snapX, y(p), 5, 0, 7);
        g.fill();
        g.strokeStyle = trend;
        g.lineWidth = 2;
        g.stroke();
        g.lineWidth = 1;
      }
      head = p !== null ? { t, p } : null;
    } else head = c ? { c } : null;
  }
  const first = win.cs.length ? win.cs[0].o : lastP;
  const pctTxt = (a, b) => {
    const ch = b ? ((a - b) / b) * 100 : 0;
    return `<span class="${ch > 0 ? "pos" : ch < 0 ? "neg" : ""}">${ch >= 0 ? "+" : ""}${ch.toFixed(2)}%</span>`;
  };
  if (CH.mode === "candle") {
    const c = head && head.c ? head.c : win.cs[win.cs.length - 1];
    $("ch-ohlc").innerHTML = c
      ? `<span>${stamp(c.t)}</span><span>O <b>${cpx(c.o, 1)}</b></span><span>H <b>${cpx(c.h, 1)}</b></span><span>L <b>${cpx(c.l, 1)}</b></span><span>C <b>${cpx(c.c, 1)}</b></span>${pctTxt(c.c, c.o)}<span>${c.n} pool ${c.n === 1 ? "trade" : "trades"}</span>`
      : "";
  } else {
    const p = head ? head.p : lastP;
    $("ch-ohlc").innerHTML = `<span>${head ? stamp(head.t) : "Now"}</span><span><b>${cpx(p, 1)}</b> ${esc(TR.quote)}</span>${pctTxt(p, first)}<span>in this view</span>`;
  }
}

/** Market bar at the top: change, high and low of the last 24 hours (from the pool's real price points). */
function paintTradeBar() {
  const now = Date.now() / 1000, from = now - 86400;
  let chg = "—", hi = "—", lo = "—", cls = "";
  const pts = TR.pts;
  if (pts.length && TR.spot) {
    let before = null;
    const inside = [];
    for (const x of pts) {
      if (x.t <= from) before = x.p;
      else inside.push(x.p);
    }
    // If the price 24 hours ago is unknown (the history does not go back that far) the change is not shown
    const known = before !== null || (TR.scanned && pts[0].t > from);
    const start = before !== null ? before : pts[0].p;
    const set = [start, ...inside, TR.spot];
    if (known) {
      const c = (TR.spot / start - 1) * 100;
      chg = `${c >= 0 ? "+" : ""}${c.toFixed(2)}%`;
      cls = c > 0 ? "pos" : c < 0 ? "neg" : "";
      hi = px4(Math.max(...set));
      lo = px4(Math.min(...set));
    }
  }
  for (const el of document.querySelectorAll(".tb-chg")) {
    el.textContent = chg;
    el.className = `tb-chg ${cls}`;
  }
  for (const el of document.querySelectorAll(".tb-hi")) el.textContent = hi;
  for (const el of document.querySelectorAll(".tb-lo")) el.textContent = lo;
  // 24h volume, estimated: in a constant-product pool the quote reserve at price p is sqrt(k * p), so each price move
  // tells how much was traded. One pool only; liquidity added or removed does not move the price and is not counted.
  let vol = "—";
  if (pts.length && TR.res) {
    const k = TR.res.base * TR.res.quote;
    let prev = null, sum = 0;
    for (const x of pts) {
      if (x.t > from && prev !== null && !x.live) sum += Math.abs(Math.sqrt(k * x.p) - Math.sqrt(k * prev));
      prev = x.p;
    }
    if (TR.scanned || pts[0].t <= from) vol = `${compact(sum)} ${SV.out && SV.out.sym ? SV.out.sym : "USDC"}`;
  }
  for (const el of document.querySelectorAll(".tb-vol")) el.textContent = vol;
}

/** Pool depth: how much can be traded in a constant-product (x*y=k) pool before the price reaches each level. */
function paintDepth() {
  const el = $("dp");
  const r = TR.res;
  if (!r) return (el.innerHTML = `<tbody><tr><td class="muted">${TR.pair ? "Loading…" : "No pool for this market."}</td></tr></tbody>`);
  const k = r.base * r.quote;
  const steps = [0.5, 1, 2, 3, 5, 10, 20];
  const n = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e4 ? `${(v / 1e3).toFixed(1)}K` : v.toLocaleString("en-US", { maximumFractionDigits: v < 10 ? 4 : v < 1000 ? 2 : 0 }));
  const up = steps.map((s) => ({ s, price: r.p * (1 + s / 100), size: Math.sqrt(k * r.p * (1 + s / 100)) - r.quote }));
  const dn = steps.map((s) => ({ s, price: r.p * (1 - s / 100), size: r.quote - Math.sqrt(k * r.p * (1 - s / 100)) }));
  const max = Math.max(up[up.length - 1].size, dn[dn.length - 1].size) || 1;
  const row = (x, side) =>
    `<tr class="${side}" data-px="${x.price}" tabindex="0"><td>${px4(x.price)}</td><td>${side === "dp-a" ? "+" : "−"}${x.s}%</td><td>${n(x.size)}<span class="bar" style="width:${Math.max(2, (x.size / max) * 100).toFixed(0)}%"></span></td></tr>`;
  el.innerHTML = `<thead><tr><th>Price</th><th>Move</th><th>${esc(TR.quote)} to get there</th></tr></thead><tbody>${up.slice().reverse().map((x) => row(x, "dp-a")).join("")}<tr class="mid"><td colspan="3">${px4(r.p)}<small>pool price now</small></td></tr>${dn.map((x) => row(x, "dp-b")).join("")}</tbody>`;
  for (const tr of el.querySelectorAll("tr[data-px]")) {
    const use = () => {
      const input = $(document.body.dataset.view === "sell" ? "sv-px" : "olimit");
      const v = Number(tr.dataset.px);
      input.value = v < 0.01 ? v.toPrecision(4) : v.toFixed(4);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    };
    tr.onclick = use;
    tr.onkeydown = (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), use());
  }
}

/** Order lines on the chart: open buy and sell orders (in an extra market only that market's sell orders). */
let linesTimer = null;
function tradeLinesSoon() {
  clearTimeout(linesTimer);
  linesTimer = setTimeout(tradeLines, 250);
}
async function tradeLines() {
  const key = TR.key;
  if (!key || !me) return;
  const n = (v) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const out = [];
  try {
    const home = key === C.usdc;
    if (home && vault) for (const o of await openOrdersIn(vault)) out.push({ side: "buy", price: Number(o.limit) / 1e7, text: `Buy with ${n(o.left)} USDC` });
    const sv = home ? await homeSellVault() : SV.vault;
    if (sv) for (const o of await openOrdersIn(sv)) out.push({ side: "sell", price: sellPrice(o.trigger > 0n ? o.trigger : o.limit), text: `${o.trigger > 0n ? "Stop" : "Sell"} ${n(o.left)} ${BS}` });
  } catch (e) {
    console.warn("order lines", e);
  }
  if (TR.key !== key) return;
  TR.lines = out.filter((o) => o.price > 1e-6 && o.price < 1e6); // a DCA order without a price limit has no line
  drawChart();
}

// Market selector: XLM / USDC and the showcase markets (if any)
for (const sel of document.querySelectorAll(".pairsel")) {
  if (V7) {
    sel.innerHTML = [{ sym: "XLM" }, ...PAIRS].map((p) => `<option value="${esc(p.sym)}"${p.sym === BS ? " selected" : ""}>${esc(p.sym)} / USDC</option>`).join("");
    sel.onchange = () => setBase(sel.value);
    continue;
  }
  sel.innerHTML = `<option value="home">XLM / USDC</option>${EXTRA_MARKETS.map((m) => `<option value="${esc(m.sym)}">XLM / ${esc(m.sym)} (showcase)</option>`).join("")}`;
  sel.onchange = () => {
    location.hash = sel.value === "home" ? (document.body.dataset.view === "sell" && !document.body.classList.contains("xmarket") ? "#sell" : "#vault") : `#sell:${sel.value}`;
  };
}
for (const b of document.querySelectorAll("#ch-tf [data-tf]")) {
  b.onclick = () => {
    TR.tf = Number(b.dataset.tf);
    // When the candle size changes, return to the standard width and to "now": as many candles (history) as possible fit on screen
    CH.cw = 8;
    CH.pan = 0;
    for (const o of document.querySelectorAll("#ch-tf [data-tf]")) o.setAttribute("aria-pressed", String(o === b));
    drawChart();
  };
}
{
  const cv = $("ch");
  const at = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  cv.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    CH.drag = { x: e.clientX, pan: CH.pan, moved: false };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener("pointermove", (e) => {
    TR.hover = at(e);
    if (CH.drag) {
      const dx = e.clientX - CH.drag.x;
      if (Math.abs(dx) > 3) CH.drag.moved = true;
      if (CH.drag.moved) CH.pan = Math.max(0, CH.drag.pan + (dx / CH.cw) * TR.tf); // drag right: go back in time
      cv.style.cursor = "grabbing";
    }
    drawChart();
  });
  const end = () => {
    CH.drag = null;
    cv.style.cursor = "";
    drawChart();
  };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  cv.addEventListener("pointerleave", () => {
    if (CH.drag) return;
    TR.hover = null;
    drawChart();
  });
  // Wheel: zoom in / out (bucket width). Only over the chart, so that the page does not scroll.
  cv.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) CH.pan = Math.max(0, CH.pan - (e.deltaX / CH.cw) * TR.tf);
      else CH.cw = Math.min(24, Math.max(3, CH.cw * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      drawChart();
    },
    { passive: false },
  );
  cv.addEventListener("dblclick", () => {
    TR.fitted = null; // back to the first view: the whole history fits on screen
    chartFit();
    drawChart();
  });
  $("ch-live").onclick = () => {
    CH.pan = 0;
    drawChart();
  };
  for (const b of document.querySelectorAll("#ch-zoom [data-z]")) {
    b.onclick = () => {
      CH.cw = Math.min(24, Math.max(3, CH.cw * (b.dataset.z === "in" ? 1.3 : 1 / 1.3)));
      drawChart();
    };
  }
  const setMode = (m) => {
    CH.mode = m;
    for (const o of document.querySelectorAll("#ch-mode [data-mode]")) o.setAttribute("aria-pressed", String(o.dataset.mode === m));
    try {
      localStorage.setItem("iora-chart-mode", m);
    } catch {}
    drawChart();
  };
  for (const b of document.querySelectorAll("#ch-mode [data-mode]")) b.onclick = () => setMode(b.dataset.mode);
  setMode(CH.mode);
  new ResizeObserver(() => drawChart()).observe(cv.parentElement);
  // The canvas is repainted when the theme changes (colors are read from CSS variables)
  new MutationObserver(() => drawChart()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => drawChart());
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => drawChart()); // sizes change once the font arrives
}
setInterval(() => {
  const v = document.body.dataset.view;
  if ((v === "vault" || v === "sell") && document.visibilityState === "visible" && TR.pair) tradeTick().catch((e) => console.warn("pool tick", e));
}, 20000);

// ---------------------------------------------------------------------------
// Order type: Limit / Market / Scaled. Limit and Scaled use the same form (from the vault, filled by the keeper);
// Market is the old Swap section: from the wallet, a trade in the Soroswap pool right away (does not use the vault).
// ---------------------------------------------------------------------------
function marketPaneSync(v) {
  const slot = document.querySelector(`[data-view-pane="${v}"] [data-pane="mkt"]`);
  const node = $("mkt");
  if (slot && node.parentElement !== slot) slot.append(node);
  const dir = v === "vault" ? "ux" : "xu";
  if (SW.dir !== dir) {
    SW.dir = dir;
    $("swap-in").value = "";
  }
  // No market order in an extra market (only the XLM / USDC pool): if it stayed selected it goes back to Limit
  const xm = document.body.classList.contains("xmarket");
  const opt = document.querySelector('#tk-sell [data-otsel] option[value="market"]');
  opt.hidden = opt.disabled = xm;
  if (xm && $("tk-sell").dataset.otype === "market") document.querySelector('#tk-sell [data-ot="limit"]').click();
  doQuote();
}
function syncOrderType() {
  LADDER.on = $("tk-buy").dataset.otype === "scaled";
  SVL.on = $("tk-sell").dataset.otype === "scaled";
  $("olimit-label").textContent = LADDER.on ? "Highest price" : "Price";
  $("place").textContent = LADDER.on ? `Place ${LADDER.n} buy orders` : `Buy ${BS}`;
  $("oqty").readOnly = LADDER.on;
  $("sv-val").readOnly = SVL.on;
  if (SVL.on && SVT.type === "sl") setSellType("tp"); // a stop loss is a single order
  else {
    const sl = SVT.type === "sl";
    $("sv-px-label").textContent = SVL.on ? "Lowest price" : sl ? "Stop price" : "Price";
    $("sv-place").textContent = sl ? "Place stop loss" : SVL.on ? `Place ${SVL.n} sell orders` : `Sell ${BS}`;
  }
  updateTicket();
  updateSellTicket();
}
for (const t of document.querySelectorAll("[data-ot]")) {
  t.addEventListener("click", () => {
    t.closest(".ticket").dataset.otype = t.dataset.ot;
    t.closest(".ticket").querySelector("[data-otsel]").value = t.dataset.ot;
    syncOrderType();
    if (t.dataset.ot === "market") doQuote();
  });
}
for (const [countId, distId, st] of [["ocount", "odist", LADDER], ["sv-ocount", "sv-odist", SVL]]) {
  const input = $(countId);
  const set = (n) => {
    st.n = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(n) || SCALE_MIN));
    input.value = String(st.n);
    syncOrderType();
  };
  input.addEventListener("change", () => set(Number(input.value)));
  for (const b of input.parentElement.querySelectorAll("[data-step]")) b.onclick = () => set(st.n + Number(b.dataset.step));
  for (const c of document.querySelectorAll(`#${distId} [data-dist]`)) {
    c.onclick = () => {
      st.dist = c.dataset.dist;
      for (const o of document.querySelectorAll(`#${distId} [data-dist]`)) o.setAttribute("aria-pressed", String(o === c));
      syncOrderType();
    };
  }
}
// DCA forms (buy and sell): one part per interval, for as long as the vault covers the next part.
for (const s of [
  { p: "dca", sell: false, v: () => vault, room: () => (freeUnits !== null ? buyRoom() : null), sym: () => "USDC", dep: "dep", errs: VAULT_ERRORS, after: () => refresh() },
  { p: "sv-dca", sell: true, v: () => SV.vault, room: () => (SV.free !== null ? sellRoom() : null), sym: () => BS, dep: "sv-dep", errs: SELL_ERRORS, after: async () => { await refreshSell(); renderPortfolio(); } },
]) {
  const el = (id) => $(`${s.p}-${id}`);
  const w = s.sell ? "sale" : "buy";
  const read1 = () => {
    let part = 0n;
    try {
      part = el("part").value.trim() ? toUnits(el("part").value) : 0n;
    } catch {}
    const every = (parseInt(el("every").value, 10) || 0) * Number(el("unit").value);
    const nRaw = el("n").value.trim();
    const n = nRaw ? parseInt(nRaw, 10) : 0;
    return { part, every, n, nRaw };
  };
  const paint = () => {
    for (const u of el("part").closest(".dca").querySelectorAll("[data-dca-unit]")) u.textContent = s.sym();
    const room = s.room();
    el("av").textContent = room === null ? "" : `Available ${fmt(room, 2)} ${s.sym()}`;
    const { part, every, n } = read1();
    if (!(part > 0n) || room === null) {
      el("cover").textContent = "—";
      el("len").textContent = "—";
      return;
    }
    const fits = Number(room / part);
    const k = n > 0 ? Math.min(n, fits) : fits;
    el("cover").textContent = `${k.toLocaleString("en-US")} ${w}${k === 1 ? "" : "s"}${n > 0 && fits >= n ? "" : " at this size"}`;
    el("len").textContent = k > 1 && every > 0 ? (noEnd(s.v()) ? `about ${dcaSpan(every * (k - 1))}` : `about ${dcaSpan(Math.min(every * (k - 1), DCA_DAYS * 86400))}`) : k === 1 ? `one ${w}` : "—";
  };
  for (const id of ["part", "every", "n", "px"]) el(id).addEventListener("input", paint);
  el("unit").addEventListener("change", paint);
  for (const t of document.querySelectorAll(`[data-tab="${s.p}"]`)) t.addEventListener("click", paint);
  el("go").onclick = async () => {
    if (!(await needWallet())) return;
    const v = s.v();
    if (!v) return log(`Open your vault first: deposit ${esc(s.sym())} on the Portfolio page.`, "err");
    if ((await vaultVersion(v)) < 11)
      return log("DCA needs the newest vault, and your funds are in an earlier one. On the Portfolio page, use “Move to the new vault”: it carries your coins and open orders over, and DCA works from then on.", "err");
    const { part, every, n, nRaw } = read1();
    if (part < MIN_ORDER) return log(`Type how much to ${s.sell ? "sell" : "spend"} each time (at least ${fmt(MIN_ORDER, 1)} ${esc(s.sym())}).`, "err");
    if (!(every >= DCA_MIN_EVERY && every <= DCA_MAX_EVERY)) return log("The time between two orders must be between 1 minute and 28 days.", "err");
    if (nRaw && !(/^\d+$/.test(nRaw) && n >= 1 && n <= 1_000_000)) return log(`"Stop after" must be a whole number of ${w}s, or empty for no end.`, "err");
    let px = 0n;
    try {
      px = el("px").value.trim() ? toUnits(el("px").value) : 0n;
    } catch (e) {
      return log(esc(e.message), "err");
    }
    const limit = px > 0n ? (s.sell ? sellLimit(px) : px) : DCA_NO_LIMIT;
    if (limit <= 0n || limit > DCA_NO_LIMIT) return log("That price is out of range.", "err");
    const room = s.room();
    if (room !== null && part > room) {
      if (offerDeposit(s.dep, part - room, s.sym())) return;
      return log(`Your vault holds ${fmt(room, 2)} ${esc(s.sym())} for orders; one ${w} of ${fmt(part, 2)} needs more. Lower the amount or deposit first.`, "err");
    }
    const priceRow = px > 0n ? `${s.sell ? "at or above" : "at or below"} ${fmt(px)} USDC per ${esc(BS)}` : `any price within ${DCA_BAND_BPS / 100}% of the oracle price`;
    if (
      !(await ask({
        title: `Start DCA ${s.sell ? "sell" : "buy"}`,
        rows: [
          [s.sell ? "Sell each time" : "Spend each time", `${fmt(part, 2)} ${esc(s.sym())}`],
          ["How often", `every ${dcaSpan(every)}, the first one right away`],
          ["Until", n > 0 ? `${n} ${w}${n === 1 ? "" : "s"}, or your vault runs out` : "your vault cannot cover the next one"],
          ["Price", priceRow],
        ],
        notes: [
          `Only the next ${w} is set aside; the rest of your balance stays free${s.sell && XB ? "" : " and keeps earning"}.`,
          `You can stop the plan at any time with Cancel in the order list.`,
          ...(px > 0n ? [] : [`With no price limit, a ${w} is skipped while the pool price is more than ${DCA_BAND_BPS / 100}% away from the oracle price, and filled once it is back.`]),
        ],
        confirm: "Start",
      }))
    )
      return;
    const expiry = expiryOf(v, DCA_DAYS);
    const ok = await call(v, "place_dca", [i128(part), u32(n), u64(every), i128(limit), u32(300), u32(px > 0n ? 0 : DCA_BAND_BPS), u64(expiry)], `Start DCA ${s.sell ? "sell" : "buy"}`, s.errs);
    if (ok) el("part").value = "";
    await s.after();
    paint();
  };
}
$("olimit2").addEventListener("input", updateTicket);
$("sv-px2").addEventListener("input", updateSellTicket);
// The "get USDC" button on the Test funds page: Trade > Sell > Market
$("go-mkt-sell").addEventListener("click", () => setTimeout(() => document.querySelector('#tk-sell [data-ot="market"]').click(), 0));

// Percentage buttons under the amount boxes: what share of the available balance to trade with.
// (The old "Market / -5% / -10% / -20%" price buttons were removed; clicking the market price label fills in the price.)
{
  const pctOf = (units, p) => (units * BigInt(p)) / 100n;
  // A slider from 0 to 100 in steps of 1 lies over the line; the five dots are only marks on it.
  const wire = (boxId, inputId, max, after) => {
    const box = $(boxId), input = $(inputId);
    const range = document.createElement("input");
    range.type = "range";
    range.min = "0";
    range.max = "100";
    range.step = "1";
    range.value = "0";
    range.className = "pct-range";
    range.setAttribute("aria-label", box.getAttribute("aria-label") || "Share of your available balance to use");
    const out = document.createElement("output");
    out.className = "pct-out";
    box.removeAttribute("role");
    box.append(range, out);
    for (const b of box.querySelectorAll("[data-p]")) {
      b.tabIndex = -1;
      b.setAttribute("aria-hidden", "true");
    }
    const show = (p) => {
      range.value = String(p);
      box.style.setProperty("--p", String(p));
      out.textContent = p > 0 ? `${p}%` : "";
      range.setAttribute("aria-valuetext", `${p}%`);
      for (const b of box.querySelectorAll("[data-p]")) b.classList.toggle("on", p > 0 && Number(b.dataset.p) <= p);
    };
    range.addEventListener("input", () => {
      const m = max();
      if (m === null) return show(0);
      const p = Number(range.value);
      const v = pctOf(m, p);
      input.value = v > 0n ? trim7(v) : "";
      after(); // "after" does not fire the input event; the slider keeps its place
      show(p);
    });
    // Typing an amount by hand moves the slider to the share that amount is.
    input.addEventListener("input", () => {
      let p = 0;
      try {
        const m = max();
        const u = input.value.trim() ? toUnits(input.value) : 0n;
        if (m !== null && m > 0n) p = Math.max(0, Math.min(100, Number((u * 100n) / m)));
      } catch {}
      show(p);
    });
  };
  wire("amt-pct", "oamount", () => (freeUnits !== null ? buyRoom() : null), updateTicket);
  wire("sv-amt-pct", "sv-amt", () => (SV.free !== null ? sellRoom() : null), updateSellTicket);
  wire(
    "swap-pct",
    "swap-in",
    () => {
      const bal = SW.dir === "xu" ? walletXlm : walletUsdc;
      if (bal === null) return null;
      const m = SW.dir === "xu" ? bal - BASE_KEEP : bal; // leave a margin for fees with XLM
      return m > 0n ? m : 0n;
    },
    doQuote,
  );
  $("market").onclick = () => {
    if (!marketPrice) return;
    $("olimit").value = marketPrice.toFixed(4);
    $("olimit").dispatchEvent(new Event("input", { bubbles: true }));
  };
  $("sv-mkt").onclick = () => {
    if (!SV.mkt) return;
    $("sv-px").value = SV.mkt.toFixed(SV.mkt < 0.01 ? 7 : 4);
    $("sv-px").dispatchEvent(new Event("input", { bubbles: true }));
  };
}

// ---------------------------------------------------------------------------
// Order form (exchange layout): type picked from a dropdown, Quantity <-> Order value tied together,
// a "Max. buy / Max. sell" row, the take profit box opens with a checkbox, "+" opens the vault's deposit tab.
// ---------------------------------------------------------------------------
for (const sel of document.querySelectorAll("[data-otsel]")) {
  sel.onchange = () => sel.closest(".ticket").querySelector(`[data-ot="${sel.value}"]`).click();
}
const num = (id) => {
  const v = Number(String($(id).value).trim().replace(",", "."));
  return v > 0 ? v : 0;
};
const plain = (v, d) => String(Number(v.toFixed(d)));
// Buy: typing Quantity (XLM) sets Order value = quantity x price
$("oqty").addEventListener("input", () => {
  if (LADDER.on) return;
  const q = num("oqty"), px = num("olimit");
  $("oamount").value = q && px ? plain(q * px, 7) : "";
  updateTicket();
});
// Sell: typing Order value sets Quantity = value / price
$("sv-val").addEventListener("input", () => {
  if (SVL.on) return;
  const v = num("sv-val"), px = num("sv-px");
  $("sv-amt").value = v && px ? plain(v / px, 7) : "";
  updateSellTicket();
});
/** "Max. buy" (the XLM the available USDC buys at this price) and "Max. sell" (the value of the available XLM). */
function ticketExtras() {
  const n = nfmt;
  const bpx = num("olimit") || marketPrice || 0;
  $("max-qty").textContent = freeUnits !== null && bpx ? `${n(Number(freeUnits) / 1e7 / bpx)} ${BS}` : "—";
  const spx = num("sv-px") || SV.mkt || 0;
  $("sv-max-val").textContent = SV.free !== null && spx ? `${n((Number(SV.free) / 1e7) * spx, SV.out.sym === "USDC" ? 2 : 7)} ${SV.out.sym}` : "—";
}
for (const id of ["avail-buy", "sv-free2", "market", "sv-mkt"]) new MutationObserver(ticketExtras).observe($(id), { childList: true, characterData: true, subtree: true });
// Account box under the order form: the same figures the tickets and the vault cards show, in one place
for (const el of document.querySelectorAll("[data-mirror]")) {
  const src = $(el.dataset.mirror);
  if (!src) continue;
  const copy = () => (el.textContent = src.textContent || "—");
  copy();
  new MutationObserver(copy).observe(src, { childList: true, characterData: true, subtree: true });
}
for (const el of document.querySelectorAll("[data-bs]")) el.textContent = BS;
// Balances tab under the chart: per coin, what the vault holds, what open orders have set aside, what is free, and the wallet
function renderBalances() {
  const f = (v, d = 2) => (v === null || v === undefined ? "—" : fmt(v, d));
  const svRes = SV.bal !== null && SV.free !== null ? SV.bal - SV.free : null;
  const row = (sym, bal, res, free, wal, d) => `<tr><td>${esc(sym)}</td><td>${f(bal, d)}</td><td>${f(res, d)}</td><td>${f(free, d)}</td><td>${f(wal, d)}</td></tr>`;
  const html = `<table><thead><tr><th>Coin</th><th>In vault</th><th>In open orders</th><th>Available</th><th>In wallet</th></tr></thead><tbody>${row("USDC", balanceUnits, reservedUnits, freeUnits, walletUsdc, 2)}${row(BS, SV.bal, svRes, SV.free, walletXlm, XB ? 7 : 2)}</tbody></table>`;
  for (const el of document.querySelectorAll(".bal-table")) el.innerHTML = html;
}
renderBalances();
for (const id of ["avail-buy", "sv-free2", "wallet-usdc", "sv-wallet"]) new MutationObserver(() => setTimeout(renderBalances, 0)).observe($(id), { childList: true, characterData: true, subtree: true });
// "+" : the deposit box, on this page
for (const b of document.querySelectorAll("[data-open-dep]")) b.onclick = () => openDeposit(b.dataset.openDep);
$("buy-wal-dep").onclick = () => openDeposit("dep", walletDepositable("dep"));
$("sv-wal-dep").onclick = () => openDeposit("sv-dep", walletDepositable("sv-dep"));
// Take profit checkbox: unticking clears the price (take profit off)
$("tp-on").onchange = () => {
  const on = $("tp-on").checked;
  $("autosell-row").classList.toggle("open", on);
  if (on) return $("tp-px").focus();
  $("tp-own").value = "";
  $("tp-px").value = "";
  $("tp-px").dispatchEvent(new Event("input", { bubbles: true }));
};
ticketExtras();
// If the preview has a warning (red item) it must not stay closed: "What happens next" opens by itself.
for (const [listId, boxId] of [["preview-list", "preview"], ["sv-preview-list", "sv-preview"]]) {
  new MutationObserver(() => {
    if ($(listId).querySelector(".bad")) $(boxId).open = true;
  }).observe($(listId), { childList: true });
}
