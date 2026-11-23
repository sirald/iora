import "./polyfill.js";
import "./style.css";
import "./skin.css";
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
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
import { makeServer, RPC_FALLBACK, RPC_PRIMARY } from "./rpc.js";
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
  pool: import.meta.env.VITE_POOL || "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF",
};
const PASS = Networks.TESTNET;
// The fast RPC first, the fallback if there is a problem (see rpc.js)
const server = makeServer([C.rpc, import.meta.env.VITE_RPC_FALLBACK, RPC_PRIMARY, RPC_FALLBACK]);
const U = 10_000_000n;
// Pool guard. Iora is also a place to trade: when an order fills, funds are withdrawn from Blend, and if most of
// the pool is lent out both withdrawals and fills wait. So the limit is kept below Blend's own limit (95%).
const UTIL_WARN = Number(import.meta.env.VITE_UTIL_WARN || 0.7); // warn above this utilisation
const UTIL_STOP = Number(import.meta.env.VITE_UTIL_STOP || 0.8); // new deposits and orders stop above this utilisation
const UTIL_ENFORCE = import.meta.env.VITE_UTIL_ENFORCE === "1"; // when off (testnet) it only warns
const ORDER_SHARE = 0.25; // a single deposit or order is at most a quarter of what the pool can pay out at that moment
const POOLSTAT = {}; // symbol -> { u, avail } (filled by loadPool)

// State of the sell page. Defined at the top because showView needs it when the page opens.
const SV = { factory: import.meta.env.VITE_FACTORY_SELL || "", vault: null, bal: null, free: null, apr: null, mkt: null, days: 365 };
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
const u64 = (n) => nativeToScVal(BigInt(n), { type: "u64" });
const i128 = (n) => nativeToScVal(BigInt(n), { type: "i128" });
const addr = (a) => new Address(realId(a)).toScVal();
const addrVec = (list) => xdr.ScVal.scvVec(list.map((a) => new Address(a).toScVal()));

const VAULT_ERRORS = {
  1: "Invalid amount",
  2: "Not enough available balance (amounts reserved for open orders are excluded)",
  3: "Order not found",
  4: "Order is not open",
  5: "Order has expired",
  6: "Fill is below the minimum size",
  7: "Fill exceeds the remaining amount",
  8: "Limit price not met",
  9: "Invalid limit price",
  10: "Not enough cash in the Blend pool",
  11: "Invalid expiry",
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
  if (gm && kind === "err" && document.documentElement.classList.contains("app-closed")) {
    gm.innerHTML = msg;
    gm.className = "gate-msg";
  }
  // Show the last message at the bottom of the screen too; the log box may be closed.
  const st = $("status");
  st.innerHTML = msg;
  st.className = `status show ${kind}`;
  clearTimeout(log.t);
  if (kind !== "err") log.t = setTimeout(() => st.classList.remove("show"), 7000);
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
const READ_SOURCE = import.meta.env.VITE_USDC_ISSUER || "GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56";
function readCall(contractId, method, args) {
  return new TransactionBuilder(new Account(me || READ_SOURCE, "0"), { fee: BASE_FEE, networkPassphrase: PASS })
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

async function signAndSend(tx) {
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
  const ready = TransactionBuilder.fromXDR(signed.signedTxXdr, PASS);
  const sent = await server.sendTransaction(ready);
  if (sent.status === "TRY_AGAIN_LATER") throw new Error("The network is busy and did not accept the transaction. Nothing was sent; try again in a moment.");
  if (sent.status === "ERROR") throw new Error("Could not submit the transaction");
  // The transaction is valid for 180 s: it is followed until that time is up. A temporary RPC error does not stop
  // the tracking, so a user who sees "timed out" and tries again does not place the same order twice.
  const link = `<a href="${EXPLORER}/tx/${sent.hash}" target="_blank" rel="noopener">${short(sent.hash)}</a>`;
  const deadline = Date.now() + 195_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    let r;
    try {
      r = await server.getTransaction(sent.hash);
    } catch {
      continue;
    }
    if (r.status === "SUCCESS") return { hash: sent.hash, value: r.returnValue ? scValToNative(r.returnValue) : undefined };
    if (r.status === "FAILED") throw new Error(`Transaction failed on-chain (${link})`);
  }
  throw new Error(`Not confirmed in time; it expired without being applied, so it is safe to try again (${link})`);
}

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
  bar.innerHTML = `<span><b>Iora was updated.</b> Reload this page before you do anything else. Your funds are not affected.</span><button class="btn primary" type="button">Reload</button>`;
  bar.querySelector("button").onclick = () => location.reload();
  document.body.prepend(bar);
}
setInterval(() => document.visibilityState === "visible" && staleBuild(), 60_000);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && staleBuild());

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
    if (r.ok) {
      mark("testnet", true);
      netGuard(true);
    }
  }
  if (busy) {
    log("Another transaction is still in progress. Wait for it to finish, then try again.", "err");
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
      await signAndSend(rtx);
      tx = await buildCall(t.id, t.method, t.args);
      sim = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) throw new Error(explain(sim.error, errors));
    }
    log(`${label}: waiting for wallet approval…`);
    padSim(sim);
    if (method === "create_vault") padVaultSlots(sim);
    const res = await signAndSend(rpc.assembleTransaction(tx, sim).build());
    log(`${label}: done · <a href="${EXPLORER}/tx/${res.hash}" target="_blank" rel="noopener">transaction</a>`, "ok");
    return res;
  } catch (e) {
    const msg = String((e && e.message) || e);
    // The transaction link we generate ourselves is kept; everything else is escaped
    const safe = esc(msg).replace(/&lt;a href=&quot;(https:\/\/stellar\.expert\/explorer\/[a-z]+\/tx\/[0-9a-f]{64})&quot; target=&quot;_blank&quot; rel=&quot;noopener&quot;&gt;([0-9a-f.…]+)&lt;\/a&gt;/g, '<a href="$1" target="_blank" rel="noopener">$2</a>');
    const hint = method === "create_vault" && !/reject|declin|cancel|Connect your wallet|busy/i.test(msg) ? " If many people open a vault at the same moment, one attempt can fail. Press the button again." : "";
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
    <button type="button" class="wm-addr" data-wm="copy" title="Copy address"><code>${me.slice(0, 10)}…${me.slice(-10)}</code><span>Copy</span></button>
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
      act.querySelector("span").textContent = "Copied";
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
    return { ok: n.network === "TESTNET", name: n.network ? String(n.network) : "another network" };
  } catch {
    return { ok: true, name: "" };
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
    if (!r.ok) return;
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
  watchAccount();
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
  const inst = await isConnected();
  if (inst.error || !inst.isConnected) {
    log('No supported wallet found. The testnet beta works with Varial (formerly Freighter): install it from <a href="https://varialwallet.com" target="_blank" rel="noopener">varialwallet.com</a>, then reload this page. On a phone or tablet there is no wallet extension, so please use a computer (Chrome, Brave or Firefox). LOBSTR and other wallets are not supported during the testnet beta.', "err");
    return;
  }
  const acc = await requestAccess();
  if (acc.error || !acc.address) {
    log("Wallet connection rejected.", "err");
    return;
  }
  if (!validAddr(acc.address)) return log("The wallet returned an invalid address.", "err");
  me = acc.address;
  const net = await getNetwork();
  mark("connect", true);
  mark("testnet", net.network === "TESTNET");
  netGuard(net.network === "TESTNET", net.network);
  walletName = walletName || "Varial";
  setWalletButton();
  document.body.classList.add("connected");
  window.dispatchEvent(new CustomEvent("iora:wallet", { detail: me }));
  log(`Wallet connected: ${short(me)}`, "ok");
  watchAccount();
  await refresh();
  if (location.hash === "#lend") loadLend();
}

async function tryAutoConnect() {
  // If the user pressed "Disconnect", do not reconnect automatically until they connect again themselves
  try { if (localStorage.getItem(DISC_KEY)) return; } catch {}
  const inst = await isConnected();
  mark("freighter", !inst.error && inst.isConnected);
  if (inst.error || !inst.isConnected) return;
  const a = await getAddress();
  if (!a.error && validAddr(a.address)) {
    me = a.address;
    mark("connect", true);
    const net = await getNetwork();
    mark("testnet", net.network === "TESTNET");
    netGuard(net.network === "TESTNET", net.network);
    walletName = "Varial";
    setWalletButton();
    document.body.classList.add("connected");
    window.dispatchEvent(new CustomEvent("iora:wallet", { detail: me }));
    watchAccount();
    await refresh();
    if (location.hash === "#lend") loadLend();
  }
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
let supplyApr = null; // estimated yearly interest on Blend USDC (0.05 = 5%)
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
  const days = Number($("odays").value) || 365;
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
  items.push(`The order stays open until it fills or you cancel it (it ends by itself after a year). Until then the USDC keeps earning.`);
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

function syncDays() {
  const d = String($("odays").value);
  for (const c of document.querySelectorAll("#days-chips [data-days]")) c.setAttribute("aria-pressed", String(c.dataset.days === d));
}

// Refreshes the wallet/buy vault screen; and the sell page too if it is open (the wallet balance comes from here).
// ---- Generations: the user stays in the vault where their funds are ----
// When a new factory is deployed the old vaults keep working. Nobody can move the funds for the user (only the
// owner can withdraw from a vault), so instead of forcing a move the app uses the generation where the user's
// funds are: factory pairs with the same call signatures are listed in VITE_GENERATIONS (buy:sell,
// newest first). A user with funds in no generation starts in the newest one.
const GEN_LATEST = { buy: C.factory, sell: SV.factory };
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
async function pickGeneration() {
  if (!me || genFor === me) return;
  const who = me;
  let pick = GEN_LATEST;
  if (GENERATIONS.length > 1) {
    try {
      const funded = await Promise.all(
        GENERATIONS.map(async (g) => {
          const facs = [g.buy, g.sell].filter(Boolean);
          const vs = await Promise.all(facs.map((f) => read(f, "vault_of", [addr(who)])));
          for (const [k, r] of vs.entries()) {
            if (!(r.ok && r.value)) continue;
            const v = k === 0 && facs[0] === g.buy ? wrapBuy(r.value, g.buy) : wrapSell(r.value, g.sell);
            const [bal, open] = await Promise.all([read(v, "balance"), openOrdersIn(v)]);
            if ((bal.ok && BigInt(bal.value) >= LEGACY_DUST) || open.length) return true;
          }
          return false;
        }),
      );
      const i = funded.indexOf(true);
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
    for (const c of root.querySelectorAll("i.coin.xlm")) c.className = "coin other";
  }
  // A stop loss looks at the Blend oracle; these coins have no oracle price
  const sl = document.querySelector('#sv-type [data-type="sl"]');
  if (sl) sl.hidden = true;
  for (const el of document.querySelectorAll('[data-view-pane="sell"] .tb-stat, [data-view-pane="sell"] .tb-earn')) {
    if (el.querySelector("#sv-util, #sv-apr")) el.hidden = true;
  }
  const warn = $("sv-warn");
  if (warn) {
    warn.innerHTML = `<b>${esc(BS)} earns no interest.</b> It is not in the Blend pool, so ${esc(BS)} waits in your vault as it is; your USDC still earns while buy orders wait. This Soroswap test pool is small and its price is not a real market price, so keep orders to a few USDC.`;
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
const AUTO_DAYS = 30;
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
  return [["Take profit", `sell at ≥ ${px4(Number(AUTO.px) / 1e7)} USDC from your sell vault (+${up.toFixed(1)}%, ${AUTO_DAYS} days)`]];
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
  const parts = items.filter((i) => i.b >= LEGACY_DUST).map((i) => `<b>${fmt(i.b, 2)} ${i.tok}</b>`);
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
    OLD_FACTORIES.filter((f) => f !== GEN.buy && f !== GEN.sell).map(async (f) => {
      const r = await read(f, "vault_of", [addr(me)]);
      if (!(r.ok && r.value)) return null;
      const v = String(r.value);
      const [cf, bal, open] = await Promise.all([read(v, "get_config"), read(v, "balance"), openOrdersIn(v)]);
      const b = bal.ok ? BigInt(bal.value) : 0n;
      // Dust interest accrued between withdrawing and execution (below 0.01) is not shown
      if (b < LEGACY_DUST && !open.length) return null;
      const tok = cf.ok && String(cf.value.usdc) === C.xlm ? "XLM" : "USDC";
      return { v, b, open: open.length, tok };
    }),
  );
  const items = found.filter(Boolean);
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
          <b class="legacy-amt">${coin(i.tok)}${fmt(i.b, 2)} <small>${i.tok}</small></b>
          ${i.open ? `<span class="legacy-note">${i.open} open order${i.open > 1 ? "s" : ""}: moved with the same price and expiry</span>` : ""}
        </div>
        <div class="legacy-actions">
          <button class="btn primary" data-migrate="${i.v}" data-tok="${i.tok}">Move to new ${i.tok === "XLM" ? "sell" : "buy"} vault</button>
          <button class="link" data-legacy="${i.v}" data-tok="${i.tok}">or withdraw to wallet</button>
        </div>
      </div>`,
      )
      .join("")}</div>`;
  syncLegacy();
  for (const b of box.querySelectorAll("[data-legacy]")) b.onclick = () => emptyLegacy(b.dataset.legacy, b.dataset.tok);
  for (const b of box.querySelectorAll("[data-migrate]")) b.onclick = () => migrateLegacy(b.dataset.migrate, b.dataset.tok);
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
async function drainLegacy(v, tok) {
  for (const o of await openOrdersIn(v)) if (!(await call(v, "cancel_order", [u32(o.id)], `Cancel old order #${o.id}`, VAULT_ERRORS))) return null;
  const token = tok === "XLM" ? C.xlm : C.usdc;
  const before = await read(token, "balance", [addr(me)]);
  const bal = await read(v, "balance");
  if (!bal.ok || BigInt(bal.value) <= 0n) return 0n;
  if (!(await call(v, "withdraw", [i128(BigInt(bal.value))], `Withdraw ${fmt(bal.value, 2)} ${tok} from old vault`, VAULT_ERRORS))) return null;
  const after = await read(token, "balance", [addr(me)]);
  return before.ok && after.ok ? BigInt(after.value) - BigInt(before.value) : BigInt(bal.value);
}

async function emptyLegacy(v, tok) {
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
  const got = await drainLegacy(v, tok);
  if (got !== null) log(`Moved ${fmt(got, 2)} ${tok} from your old vault to your wallet.`, "ok");
  await refresh();
}

/** From the old vault to the new one: cancel + withdraw + (open a new vault if needed) + deposit. */
async function migrateLegacy(v, tok) {
  const sell = tok === "XLM";
  const factory = sell ? SV.factory : C.factory;
  if (!factory) return log("The new vault is not available yet.", "err");
  const open = await openOrdersIn(v);
  const nowS = Math.floor(Date.now() / 1000);
  const carry = open.filter((o) => o.expiry > nowS + 120); // expired orders are not moved
  const bal = await read(v, "balance");
  const amt = bal.ok ? BigInt(bal.value) : 0n;
  const target = sell ? await sellVaultOf() : vault;
  const steps = open.length + 1 + (target ? 0 : 1) + 1 + carry.length;
  const rows = [
    ["From", `Old ${sell ? "sell" : "buy"} vault ${short(v)}`],
    ["Amount", `${fmt(amt, 2)} ${tok} (interest included)`],
    ["To", target ? `Your new ${sell ? "sell" : "buy"} vault ${short(target)}` : `A new ${sell ? "sell" : "buy"} vault, opened for you`],
  ];
  if (open.length) {
    const px = (o) => (sell ? `≥ ${px4(sellPrice(o.limit))}` : `≤ ${fmt(o.limit)}`);
    rows.push([
      "Open orders",
      carry.length
        ? `${carry.length} moved with the same price and expiry: ${carry.map((o) => `${fmt(o.leftU, 2)} ${tok} at ${px(o)}`).join(", ")}` +
          (open.length > carry.length ? ` (${open.length - carry.length} expired order${open.length - carry.length > 1 ? "s are" : " is"} only cancelled)` : "")
        : `${open.length} expired order${open.length > 1 ? "s" : ""} will be cancelled`,
    ]);
  }
  const notes = [
    `You'll approve ${steps} steps in your wallet: ${open.length ? "cancel the old orders, " : ""}withdraw${target ? "" : ", open the new vault"}, deposit${carry.length ? ", then place your orders again" : ""}.`,
    "The money only ever moves between your own vaults and your wallet. If you stop halfway, it stays safe in your wallet.",
  ];
  if (!(await ask({ title: `Move to your new ${sell ? "sell" : "buy"} vault`, rows, notes, confirm: "Start" }))) return;

  const got = await drainLegacy(v, tok);
  if (got === null) return refresh();
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
    // Reopen the orders in the new vault with the same price, remaining amount and end date
    let placed = 0;
    for (const [i, o] of carry.entries()) {
      const room = (await roomIn(dest)) ?? o.leftU;
      const size = o.leftU < room ? o.leftU : room;
      if (size <= 0n) break;
      const mf = fillFloor(size, o.minFill < size ? o.minFill : size);
      const label = `Place order ${i + 1}/${carry.length} again`;
      const errs = sell ? SELL_ERRORS : VAULT_ERRORS;
      const r =
        o.trigger > 0n
          ? await call(dest, "place_stop_order", [i128(size), i128(o.trigger), i128(o.limit), i128(mf), u32(o.impact), u64(o.expiry), ...(V4 ? [u32(o.band || SL_BAND_BPS)] : [])], label, errs)
          : await call(dest, "place_order", [i128(size), i128(o.limit), i128(mf), u32(o.impact), u64(o.expiry)], label, errs);
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
    const [b, s, bo, so, xp] = await Promise.all([
      rd(vault),
      rd(sv),
      vault ? openOrdersIn(vault) : [],
      sv ? openOrdersIn(sv) : [],
      SV.apr === null ? readXlmPool() : null,
    ]);
    if (who !== me) return;
    // Single vault: coins other than the selected pair sit in the same vault; they are listed and added to the total too.
    let others = [];
    const rv = sideOf(vault) || sideOf(sv);
    if (rv && PAIRS.length) {
      const ps = await rawRead(rv.id, "positions");
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
    const row = (sym, coin, r, apr, href, usd) =>
      r
        ? `<tr><td><span class="pf-asset"><i class="coin ${coin}" aria-hidden="true"></i>${sym}</span></td><td class="num">${n(r.bal, 4)}</td><td class="num">${usd === null ? "—" : `≈ ${n(usd)}`}</td><td class="num">${n(r.res)}</td><td class="num">${n(r.free, 4)}</td><td class="num pos">${pct(apr)}</td><td class="num pos">+${n(r.earned, 6)}</td><td><a href="${href}">Trade</a></td></tr>`
        : "";
    const orders = [
      ...bo.map((o) => `<tr><td><span class="tag buy">Buy</span></td><td>${BS} / USDC</td><td class="num">≤ ${px4(Number(o.limit) / 1e7)}</td><td class="num">${n(o.left)} USDC</td><td><a href="#vault">Manage</a></td></tr>`),
      ...so.map((o) => `<tr><td><span class="tag sell">${o.trigger > 0n ? "Stop" : "Sell"}</span></td><td>${BS} / USDC</td><td class="num">${o.trigger > 0n ? `≤ ${px4(sellPrice(o.trigger))}` : `≥ ${px4(sellPrice(o.limit))}`}</td><td class="num">${n(o.left)} ${BS}</td><td><a href="#sell">Manage</a></td></tr>`),
    ];
    box.innerHTML = `
      <div class="pf-kpis">
        <div class="pf-kpi"><span>${sideOf(vault) || sideOf(SV.vault) ? "Total in your vault" : "Total in vaults"}</span><b>≈ ${n(total)} <small>USDC</small></b><small>${sideOf(vault) || sideOf(SV.vault) ? `your USDC plus your ${others.length ? "coins" : BS}, valued in USDC` : "all of it earning on Blend"}</small></div>
        <div class="pf-kpi"><span>Tied to open orders</span><b>≈ ${n(tied)} <small>USDC</small></b><small>${total > 0 ? Math.round((tied / total) * 100) : 0}% of your ${sideOf(vault) || sideOf(SV.vault) ? "vault" : "vaults"}</small></div>
        <div class="pf-kpi"><span>Interest earned</span><b class="pos">≈ +${n(earned, 4)} <small>USDC</small></b><small>since you opened ${sideOf(vault) || sideOf(SV.vault) ? "the vault" : "the vaults"}</small></div>
        <div class="pf-kpi"><span>Open orders</span><b>${bo.length + so.length}</b><small>${bo.length} buy, ${so.length} sell</small></div>
      </div>${!b ? `<p class="fine">No buy vault yet. <a href="#vault">Open one</a> on the Trade page to place buy orders.</p>` : ""}${!s && SV.home ? `<p class="fine">No sell vault yet. <a href="#sell">Open one</a> on the Sell side of the Trade page to place sell orders.</p>` : ""}`;
    $("pf-orders").innerHTML = `
      <section class="pf-card"><h2>Open orders</h2>${
        orders.length
          ? `<div class="table-wrap"><table class="pf-t"><thead><tr><th>Side</th><th>Market</th><th class="num">Price</th><th class="num">Still waiting</th><th></th></tr></thead><tbody>${orders.join("")}</tbody></table></div>`
          : `<p class="muted">No open orders. Place one on the <a href="#vault">Trade</a> page; it earns while it waits.</p>`
      }</section>
      ${
        others.length
          ? `<section class="pf-card"><h2>Other coins in your vault</h2><div class="table-wrap"><table class="pf-t"><thead><tr><th>Coin</th><th class="num">Balance</th><th class="num">Value in USDC</th><th class="num">In open orders</th><th></th></tr></thead><tbody>${others
              .map((o) => `<tr><td><span class="pf-asset"><i class="coin ${o.sym === "XLM" ? "xlm" : "other"}" aria-hidden="true"></i>${esc(o.sym)}</span></td><td class="num">${nfmt(o.bal, 4)}</td><td class="num">${o.usd === null ? "—" : `≈ ${n(o.usd)}`}</td><td class="num">${nfmt(o.res, 4)}</td><td><a href="#vault" data-base="${esc(o.sym)}">Trade ${esc(o.sym)} / USDC</a></td></tr>`)
              .join("")}</tbody></table></div></section>`
          : ""
      }
      <p class="fine">Values in USDC use the current Soroswap price${px ? ` (1 ${BS} = ${px4(px)} USDC)` : ""}.${V7 ? (PAIRS.length ? ` Open orders are listed for ${BS} / USDC; pick another pair to see its orders.` : "") : " Showcase markets are not included."}</p>`;
    for (const a of $("pf-orders").querySelectorAll("a[data-base]")) {
      a.onclick = (e) => {
        e.preventDefault();
        setBase(a.dataset.base, "#vault");
      };
    }
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
    server.getAccount(me).then(() => true, () => false),
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

  if (q.ok) {
    const out = BigInt(q.value[q.value.length - 1]);
    marketPrice = Number(U) / Number(out);
    $("market").textContent = `Market ${marketPrice.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
    $("m-price").textContent = marketPrice.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
    paintMkPrice();
    renderLadder();
    updateGauge();
  }

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
    return;
  }
  $("novault").hidden = true;
  document.body.classList.add("has-vault");

  const [bal, res, free, st] = await Promise.all([
    read(vault, "balance"),
    read(vault, "reserved"),
    read(vault, "free_balance"),
    read(vault, "stats"),
  ]);
  // Lifetime interest = balance + withdrawn + spent - deposited
  let earned = null;
  if (bal.ok && st.ok && st.value) {
    const v = st.value;
    earned = BigInt(bal.value) + BigInt(v.total_withdrawn) + BigInt(v.total_spent) - BigInt(v.total_deposited);
  }
  $("vault").innerHTML = `<span class="muted">Vault</span> <a href="${EXPLORER}/contract/${realId(vault)}" target="_blank" rel="noopener">${short(vault)}</a> <button class="small ghost" id="copyvault" title="Copy full address">Copy</button>`;
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
      log("Vault address copied.", "ok");
    } catch {
      log(`Vault address: ${vault}`);
    }
  };
  // Orders first; the transaction history (events) and the summary follow, the screen does not wait for them. When
  // the history arrives the "earned while waiting" column is updated without reading the orders again.
  await renderOrders();
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

async function renderSummary(st) {
  let fees = null;
  try {
    const r = await fetch(`https://horizon-testnet.stellar.org/accounts/${me}/transactions?limit=200&order=desc`);
    if (r.ok) {
      const j = await r.json();
      fees = j._embedded.records.reduce((sum, t) => sum + BigInt(t.fee_charged), 0n);
    }
  } catch {}
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
  return rows;
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
      const label = expired ? "Expired" : { Open: "Open", Filled: "Filled", Cancelled: "Cancelled" }[status] || status;
      const filled = BigInt(o.filled_in);
      let avg = "—";
      if (filled > 0n) {
        const px = Number(filled) / Number(BigInt(o.filled_out));
        const better = (1 - px / (Number(BigInt(o.limit_price)) / 1e7)) * 100;
        avg = `${px.toLocaleString("en-US", { maximumFractionDigits: 4 })} <span class="muted">${better.toFixed(1)}% better</span>`;
      }
      const pct = Number((filled * 100n) / BigInt(o.amount_in));
      if (status === "Open" && !expired) {
        openCount++;
        openOrders.push({ id: o.id, left: Number(BigInt(o.amount_in) - filled) / 1e7, limit: Number(BigInt(o.limit_price)) / 1e7, expiry: Number(o.expiry) });
      }
      const left = Number(o.expiry) - now;
      const exp =
        status !== "Open" ? "—" : expired ? "Ended" : left > 86400 ? `in ${Math.floor(left / 86400)} d` : left > 3600 ? `in ${Math.floor(left / 3600)} h` : "< 1 h";
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
        <td>${fmt(o.amount_in, 2)} USDC</td>
        <td>≤ ${fmt(o.limit_price)}${fus.has(o.id) ? `<span class="then-note">take profit ≥ ${px4(sellPrice(BigInt(fus.get(o.id).limit_price)))}</span>` : ""}</td>
        <td><div class="bar"><span style="width:${pct}%"></span></div>${pct}%<span class="muted">${fmt(o.filled_out, 2)} ${BS}</span></td>
        <td>${avg}</td>
        <td>${waitCell}</td>
        <td>${exp}</td>
        <td><span class="tag ${status.toLowerCase()}${expired ? " expired" : ""}">${label}</span></td>
        <td>${status === "Open" ? `<button class="small ghost" data-cancel="${o.id}">Cancel</button>` : ""}${fus.has(o.id) ? "" : flipButton(o)}</td>
      </tr>`;
    })
    .join("");
  $("orders").innerHTML = `<table>
    <thead><tr><th>#</th><th>Amount</th><th>Limit</th><th>Filled</th><th>Avg. price</th><th>Earned waiting ${tip("Estimated interest the order's USDC earned on Blend while it waited, from when you placed it until it filled or was cancelled. Uses today's rate, so it is approximate.")}</th><th>Expires</th><th>Status</th><th></th></tr></thead>
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
    log("USDC trustline: waiting for wallet approval…");
    const r = await signAndSend(tx);
    log(`USDC trustline added · <a href="${EXPLORER}/tx/${r.hash}" target="_blank" rel="noopener">transaction</a>`, "ok");
  } catch (e) {
    log(`Trustline: ${esc(e.message)}`, "err");
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
  const days = Number($("odays").value);
  if (!(days > 0 && days <= 365)) return log("Duration must be 1 to 365 days.", "err");
  const expiry = Math.floor(Date.now() / 1000) + Math.round(days * 86400);
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
  rows.push(["Expires", new Date(expiry * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })]);
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
      [i128(amount), i128(limit), i128(minFill), u32(bps), u64(expiry), addr(sv), i128(thenLim), u32(300), u64(AUTO_DAYS * 86400)],
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
$("create").onclick = createVault;
$("deposit").onclick = deposit;
$("withdraw").onclick = withdraw;
$("place").onclick = placeOrder;
$("refresh").onclick = refresh;
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
for (const c of document.querySelectorAll("#days-chips [data-days]")) {
  c.onclick = () => {
    $("odays").value = c.dataset.days;
    syncDays();
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
/** Opens the vault's Deposit tab on the Portfolio page; with an amount, fills it in. */
function openDeposit(which, amount = null) {
  location.hash = "portfolio"; // the vault cards (balance, deposit, withdraw) are on the Portfolio page
  setTimeout(() => {
    const tab = document.querySelector(`.vtabs [data-tab="${which}"]`);
    if (!tab) return;
    tab.click();
    tab.closest(".overview").scrollIntoView({ block: "center", behavior: "smooth" });
    const input = $(which === "dep" ? "depamount" : "sv-dep");
    if (amount !== null && amount > 0n) input.value = toPlain(amount);
    input.focus({ preventScroll: true });
  }, 60);
}
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
const LP = { reserves: [], oracle: null, pdec: 7, take: 0, mode: 2, wallet: {} };
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
    LP.reserves = LP.reserves.filter(Boolean);
    renderLend();
  } catch (e) {
    $("lp-markets").innerHTML = `<p class="empty">Could not load Blend markets: ${esc(e.message)}</p>`;
  }
}

function lpTotals(rs, change) {
  let col = 0, liab = 0, sup = 0, bor = 0;
  for (const r of rs) {
    if (r.price === null) continue;
    let c = r.collat, d = r.debt;
    if (change && change.asset === r.asset) {
      if (change.mode === 2) c += change.amt;
      if (change.mode === 3) c = Math.max(0, c - change.amt);
      if (change.mode === 4) d += change.amt;
      if (change.mode === 5) d = Math.max(0, d - change.amt);
    }
    col += c * r.price * r.cf;
    liab += (d * r.price) / r.lf;
    sup += (c + r.supplyNc) * r.price;
    bor += d * r.price;
  }
  return { col, liab, sup, bor, hf: liab > 0 ? col / liab : Infinity, used: col > 0 ? liab / col : liab > 0 ? Infinity : 0 };
}

const hfText = (h) => (h === Infinity ? "No debt" : h.toFixed(2));
const hfClass = (h) => (h === Infinity || h >= 1.5 ? "good" : h >= 1.1 ? "warn" : "bad");
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
            <td><div class="mk-pair"><i class="coin xlm" aria-hidden="true"></i><b>XLM</b><span aria-hidden="true">→</span><i class="coin other" aria-hidden="true"></i><b>${esc(m.sym)}</b></div>
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
            <td><div class="mk-pair"><i class="coin ${main ? "xlm" : "other"}" aria-hidden="true"></i><b>${esc(p.sym)}</b><span aria-hidden="true">/</span><i class="coin usdc" aria-hidden="true"></i><b>USDC</b></div>
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
      paintBasePrices();
      paintExtraPrices();
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
    }),
  );
}

/** Price cells in the Markets table (updated as the Soroswap price arrives). */
/** Markets page: each coin's USDC price (from what 1 USDC buys; the same calculation as the price on the trading screen). */
async function paintBasePrices() {
  await Promise.all(
    [...document.querySelectorAll(".mk-bprice")].map(async (el) => {
      const q = await read(C.router, "router_get_amounts_out", [i128(U), addrVec([C.usdc, el.dataset.tok])]);
      const out = q.ok ? Number(BigInt(q.value[q.value.length - 1])) : 0;
      el.textContent = out > 0 ? px4(1e7 / out) : "no pool";
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
  $("lp-sup").textContent = usd(t.sup);
  $("lp-bor").textContent = usd(t.bor);
  // A dollar total alone is not enough: each asset is also written in its own unit (e.g. "120.00 USDC · 850.00 XLM").
  const each = (pick) =>
    LP.reserves
      .map((r) => [r.symbol, pick(r)])
      .filter(([, v]) => v > 0)
      .map(([sym, v]) => `${v.toLocaleString("en-US", { maximumFractionDigits: v >= 100 ? 2 : 4 })} ${esc(sym)}`)
      .join(" · ");
  $("lp-sup-list").textContent = each((r) => r.collat + r.supplyNc);
  $("lp-bor-list").textContent = each((r) => r.debt);
  $("lp-used").textContent = t.used === Infinity ? "—" : `${(t.used * 100).toFixed(1)}%`;
  $("lp-hf").textContent = hfText(t.hf);
  $("lp-hf").className = `hf ${hfClass(t.hf)}`;
  $("lp-used-bar").style.width = `${Math.min(100, (t.used === Infinity ? 1 : t.used) * 100)}%`;
  $("lp-used-bar").className = hfClass(t.hf);

  $("lp-markets").innerHTML = `<table>
    <thead><tr><th>Asset</th><th>Supply rate</th><th>Borrow rate</th><th>Utilization</th><th>Collateral factor</th><th>You supplied</th><th>You owe</th></tr></thead>
    <tbody>${LP.reserves
      .map(
        (r) => `<tr class="lp-row${r.asset === lpSel() ? " sel" : ""}" data-asset="${r.asset}" tabindex="0">
        <td><b>${r.symbol}</b>${r.price !== null ? `<span class="muted">$${r.price.toLocaleString("en-US", { maximumFractionDigits: 4 })}</span>` : ""}</td>
        <td class="pos">${pct(r.rates.supply)}</td>
        <td>${pct(r.rates.borrow)}</td>
        <td>${(r.u * 100).toFixed(1)}%</td>
        <td>${Math.round(r.cf * 100)}%</td>
        <td>${r.collat + r.supplyNc > 0 ? `${(r.collat + r.supplyNc).toLocaleString("en-US", { maximumFractionDigits: 4 })} <small class="muted">${esc(r.symbol)}</small>${r.price !== null ? `<span class="muted lp-usd">≈ $${((r.collat + r.supplyNc) * r.price).toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>` : ""}` : "—"}</td>
        <td>${r.debt > 0 ? `${r.debt.toLocaleString("en-US", { maximumFractionDigits: 4 })} <small class="muted">${esc(r.symbol)}</small>${r.price !== null ? `<span class="muted lp-usd">≈ $${(r.debt * r.price).toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>` : ""}` : "—"}</td>
      </tr>`,
      )
      .join("")}</tbody></table>
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

function lpMax(r) {
  const t = lpTotals(LP.reserves);
  if (LP.mode === 2) return r.wallet ?? 0;
  if (LP.mode === 3) {
    if (t.liab === 0 || !r.price) return Math.min(r.collat, r.cash);
    const spare = (t.col - t.liab * 1.05) / (r.price * r.cf);
    return Math.max(0, Math.min(r.collat, spare, r.cash));
  }
  if (LP.mode === 4) {
    if (!r.price) return 0;
    return Math.max(0, Math.min(((t.col - t.liab) * r.lf * 0.95) / r.price, r.room));
  }
  return Math.min(r.debt * 1.001 + 1e-7, r.wallet ?? 0);
}

// What the Max button fills in. Borrowing or withdrawing up to the limit leaves the position about 5%
// from liquidation, so Max stops where the health factor is still 1.2; a larger amount can be typed by hand.
const LP_SAFE_HF = 1.2;
function lpSafeMax(r) {
  const max = lpMax(r);
  if ((LP.mode !== 3 && LP.mode !== 4) || !r.price) return max;
  const t = lpTotals(LP.reserves);
  if (LP.mode === 4) return Math.max(0, Math.min(max, ((t.col / LP_SAFE_HF - t.liab) * r.lf) / r.price));
  if (t.liab === 0) return max;
  return Math.max(0, Math.min(max, (t.col - t.liab * LP_SAFE_HF) / (r.price * r.cf)));
}

function lpPreview() {
  const r = LP.reserves.find((x) => x.asset === lpSel());
  const verb = LP_VERB[LP.mode];
  $("lp-verb").textContent = verb;
  $("lp-go").textContent = r ? `${verb} ${r.symbol}` : verb;
  $("lp-fine").textContent = LP_FINE[LP.mode];
  $("lp-max-label").textContent = LP.mode === 2 ? "Wallet" : LP.mode === 3 ? "Can withdraw" : LP.mode === 4 ? "Can borrow" : "You owe";
  if (!r) return;
  const max = lpMax(r);
  $("lp-max-v").textContent = LP.mode === 5 ? r.debt.toLocaleString("en-US", { maximumFractionDigits: 4 }) : max.toLocaleString("en-US", { maximumFractionDigits: 4 });
  $("lp-rate-label").textContent = LP.mode >= 4 ? "Borrow rate" : "Supply rate";
  $("lp-rate").textContent = pct(LP.mode >= 4 ? r.rates.borrow : r.rates.supply);
  const amt = Number(String($("lp-amount").value).replace(",", ".")) || 0;
  const before = lpTotals(LP.reserves);
  const after = lpTotals(LP.reserves, { asset: r.asset, mode: LP.mode, amt });
  $("lp-hf-after").innerHTML = `${hfText(before.hf)} → <b class="hf ${hfClass(after.hf)}">${hfText(after.hf)}</b>`;
  const u = (x) => (x === Infinity ? "—" : `${(x * 100).toFixed(1)}%`);
  $("lp-used-after").innerHTML = `${u(before.used)} → <b>${u(after.used)}</b>`;
  let note = "";
  if (r.price === null) note = "No oracle price for this asset; health can't be estimated.";
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
  $("lp-note").className = `lp-note${note && (after.hf < 1.2 || r.wallet === null || (LP.mode === 4 && (amt > r.room || r.room <= 0))) ? " bad" : ""}`;
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
  let m = lpSafeMax(r);
  // When supplying/repaying XLM a little XLM stays in the wallet for transaction fees and the account reserve.
  if (r.symbol === "XLM" && (LP.mode === 2 || LP.mode === 5)) m = Math.max(0, m - 2);
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
function renderFaucet(funded, hasTrust) {
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
}

async function fundFriendbot() {
  if (!me) return log("Connect your wallet first.", "err");
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
  await refresh();
}

// ---------------------------------------------------------------------------
// Swap: XLM <-> USDC, Soroswap, with slippage protection
// ---------------------------------------------------------------------------
const SW = { dir: "xu", slip: 1, out: null, t: null };
const swPath = () => (SW.dir === "xu" ? [BASE.addr, C.usdc] : [C.usdc, BASE.addr]);
function swSyms() {
  const [a, b] = SW.dir === "xu" ? [BS, "USDC"] : ["USDC", BS];
  $("swap-sym-in").textContent = a;
  $("swap-sym-out").textContent = b;
  $("swap-coin-in").className = `coin ${a.toLowerCase()}`;
  $("swap-coin-out").className = `coin ${b.toLowerCase()}`;
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
  SW.t = setTimeout(doQuote, 250);
}
async function doQuote() {
  swSyms();
  const raw = String($("swap-in").value).trim().replace(",", ".");
  const note = $("swap-note");
  note.textContent = "";
  note.className = "lp-note";
  SW.out = null;
  if (!/^\d+(\.\d{0,7})?$/.test(raw) || Number(raw) <= 0 || !me) {
    $("swap-out").textContent = "0";
    $("swap-rate").textContent = "—";
    $("swap-min").textContent = "—";
    return;
  }
  const amt = toUnits(raw);
  const q = await read(C.router, "router_get_amounts_out", [i128(amt), addrVec(swPath())]);
  if (!q.ok) {
    $("swap-out").textContent = "0";
    note.textContent = "No quote right now. The pool may be too small for this amount.";
    note.className = "lp-note bad";
    return;
  }
  const out = BigInt(q.value[q.value.length - 1]);
  SW.out = out;
  const [a, b] = SW.dir === "xu" ? [BS, "USDC"] : ["USDC", BS];
  $("swap-out").textContent = (Number(out) / 1e7).toLocaleString("en-US", { maximumFractionDigits: 4 });
  const rate = Number(out) / Number(amt);
  $("swap-rate").textContent = `1 ${a} ≈ ${rate.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${b}`;
  const min = (out * BigInt(Math.round((100 - SW.slip) * 100))) / 10000n;
  $("swap-min").textContent = `${(Number(min) / 1e7).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${b}`;
  const bal = SW.dir === "xu" ? walletXlm : walletUsdc;
  if (SW.dir === "xu" && walletUsdc === null) {
    note.innerHTML = 'Add a USDC trustline first on <a href="#faucet">Test funds</a>.';
    note.className = "lp-note bad";
  } else if (bal !== null && amt > bal) {
    note.textContent = `That's more than your ${fmt(bal, 2)} ${a}.`;
    note.className = "lp-note bad";
  } else if (SW.dir === "xu" && walletXlm !== null && walletXlm - amt < BASE_KEEP) {
    note.textContent = "Keep a few XLM for network fees and reserves.";
  }
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
for (const c of document.querySelectorAll("#slip-chips [data-slip]")) {
  c.onclick = () => {
    SW.slip = Number(c.dataset.slip);
    for (const o of document.querySelectorAll("#slip-chips [data-slip]")) o.setAttribute("aria-pressed", String(o === c));
    doQuote();
  };
}
$("swap-go").onclick = async () => {
  if (!me) return log("Connect your wallet first.", "err");
  const raw = String($("swap-in").value).trim().replace(",", ".");
  const amt = toUnitsSafe(raw);
  if (amt === null) return;
  await doQuote();
  if (SW.out === null) return log("No quote available for this amount.", "err");
  const min = (SW.out * BigInt(Math.round((100 - SW.slip) * 100))) / 10000n;
  const [a, b] = SW.dir === "xu" ? [BS, "USDC"] : ["USDC", BS];
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const res = await call(
    C.router,
    "swap_exact_tokens_for_tokens",
    [i128(amt), i128(min), addrVec(swPath()), addr(me), u64(deadline)],
    `Swap ${fmt(amt, 2)} ${a} to ${b}`,
    {},
  );
  if (res) {
    $("swap-in").value = "";
    doQuote();
  }
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
    ["Expires", "in 30 days"],
  ];
  const notes = [
    `You'll sign ${steps} transactions: ${sv ? "" : "open your sell vault, "}deposit the ${BS}, then place the sell order.`,
    `Until it sells, the ${BS} earns interest on Blend. You can cancel and withdraw at any time.`,
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
  const expiry = Math.floor(Date.now() / 1000) + 30 * 86400;
  const placed = await call(SV.vault, "place_order", [i128(size), i128(limit), i128(minFill), u32(300), u64(expiry)], "Place sell order", SELL_ERRORS);
  await refreshSell();
  await refresh();
  if (placed) {
    log(`Sell order placed: ${fmt(size, 2)} ${BS} at ${px4(pxAt(pct))} USDC or more, for 30 days. It earns on Blend while it waits.`, "ok");
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
async function vaultInterest(v) {
  const [bal, st] = await Promise.all([read(v, "balance"), read(v, "stats")]);
  if (!bal.ok || !st.ok) return null;
  const s = st.value;
  const earned = BigInt(bal.value) + BigInt(s.total_withdrawn) + BigInt(s.total_spent) - BigInt(s.total_deposited);
  return { earned: earned > 0n ? earned : 0n, bal: BigInt(bal.value) };
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
  rows.push(["Expires", new Date(expiry * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })]);
  rows.push(["Max price impact", `${impactPct}% per fill`]);
  if (AUTO.px) rows.push(["Take profit", `each order's ${BS} is sold at ≥ ${px4(Number(AUTO.px) / 1e7)} USDC from your sell vault (${AUTO_DAYS} days)`]);
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
        ? call(vault, "place_order_then", [i128(l.amt), i128(l.lim), i128(minFill), u32(bps), u64(expiry), addr(sv), i128(autoSellLimit().lim), u32(300), u64(AUTO_DAYS * 86400)], label, VAULT_ERRORS)
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

// Fetches every event the network keeps (about 7 days). The RPC scans about 10,000 ledgers per request and may
// return empty pages in between; so it continues until the ledger the cursor points to reaches the latest ledger.
// Event cache per vault: after the first scan only new events are read on each refresh.
const eventCache = new Map(); // vault -> { events, cursor }
async function fetchVaultEvents() {
  const v = vault;
  const filters = [{ type: "contract", contractIds: [realId(v)] }];
  const dedupe = (list) => {
    const seen = new Set();
    return list.filter((e) => {
      const k = e.id || `${e.txHash}:${e.ledger}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const cached = eventCache.get(v);
  if (cached && cached.cursor) {
    try {
      let cursor = cached.cursor;
      for (let page = 0; page < 10; page++) {
        const res = await server.getEvents({ cursor, filters, limit: 200 });
        cached.events.push(...(res.events || []));
        if (!res.cursor || res.cursor === cursor) break;
        cursor = res.cursor;
      }
      cached.cursor = cursor;
      cached.events = dedupe(cached.events);
      return cached.events;
    } catch (e) {
      console.warn("events (incremental)", e); // if the cursor fell outside the range the network keeps, scan from the start
    }
  }
  const ledgerOf = (c) => {
    try {
      return Number(BigInt(String(c).split("-")[0]) >> 32n);
    } catch {
      return Infinity;
    }
  };
  let all = [];
  try {
    const h = await server.getHealth();
    const latest = h.latestLedger;
    let res = await server.getEvents({ startLedger: h.oldestLedger + 2, filters, limit: 200 });
    all = [...(res.events || [])];
    let cursor = res.cursor;
    for (let page = 0; page < 30 && cursor && ledgerOf(cursor) < latest; page++) {
      res = await server.getEvents({ cursor, filters, limit: 200 });
      all.push(...(res.events || []));
      if (!res.cursor || res.cursor === cursor) break;
      cursor = res.cursor;
    }
    eventCache.set(v, { events: dedupe(all), cursor });
  } catch (e) {
    console.warn("events", e);
  }
  return dedupe(all);
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
  for (const el of document.querySelectorAll("[data-out-coin]")) el.className = `coin ${m ? "other" : "usdc"}`;
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
      log(`${esc(sym)} trustline: waiting for wallet approval…`);
      const r = await signAndSend(tx);
      log(`${esc(sym)} trustline added · <a href="${EXPLORER}/tx/${r.hash}" target="_blank" rel="noopener">transaction</a>`, "ok");
    } catch (e) {
      log(`Trustline: ${esc(e.message)}`, "err");
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
  const [vo, pool, q] = await Promise.all([
    read(SV.factory, "vault_of", [addr(me)]),
    readXlmPool(),
    read(C.router, "router_get_amounts_out", [i128(U), addrVec([BASE.addr, SV.out.addr])]),
  ]);
  // Market: USDC received for selling 1 XLM
  if (q.ok) SV.mkt = Number(BigInt(q.value[q.value.length - 1])) / 1e7;
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
    items.push(`The stop stays in place until it triggers or you cancel it (it ends by itself after a year).`);
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
    items.push(`Each order is placed with its own signature: <b>${scale.length} signatures</b>. Unsold orders keep earning; you can cancel any of them at any time.`);
    $("sv-preview-list").innerHTML = items.map((t) => `<li>${t}</li>`).join("");
    return;
  }
  items.push(`You receive at least <b>${fmt(out, outDp(4))} ${SV.out.sym}</b> ${outIn(SV.vault)}.`);
  if (feeNote(SV.vault, SV.out.sym)) items.push(feeNote(SV.vault, SV.out.sym));
  items.push(`The order stays open until it sells or you cancel it (it ends by itself after a year). You can cancel and withdraw at any time.`);
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
      const label = expired ? "Expired" : status;
      const sold = BigInt(o.filled_in);
      const pct = Number((sold * 100n) / BigInt(o.amount_in));
      let avg = "—";
      if (sold > 0n) {
        const got = Number(BigInt(o.filled_out)) / Number(sold);
        const better = (got / sellPrice(BigInt(o.limit_price)) - 1) * 100;
        avg = `${px4(got)} <span class="muted">${better.toFixed(1)}% better</span>`;
      }
      const left = Number(o.expiry) - now;
      const exp = status !== "Open" ? "—" : expired ? "Ended" : left > 86400 ? `in ${Math.floor(left / 86400)} d` : left > 3600 ? `in ${Math.floor(left / 3600)} h` : "< 1 h";
      let waitCell = `<span class="muted">—</span>`;
      if (SV.apr !== null && status === "Open" && !expired) {
        const base = Number(BigInt(o.amount_in) - sold) / 1e7;
        waitCell = `<span class="earn-cell">+${((base * SV.apr) / 365).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${BS} / day</span>`;
      }
      return `<tr class="${status === "Open" && !expired ? "is-open" : "is-done"}">
        <td>#${o.id}</td>
        <td>${fmt(o.amount_in, 2)} ${BS}</td>
        <td>${BigInt(o.trigger_price || 0) > 0n ? `<span class="tag stop">Stop</span> ≤ ${px4(sellPrice(BigInt(o.trigger_price)))}<span class="then-note">not below ${px4(sellPrice(BigInt(o.limit_price)))}</span>` : `≥ ${px4(sellPrice(BigInt(o.limit_price)))}`}</td>
        <td><div class="bar"><span style="width:${pct}%"></span></div>${pct}%<span class="muted">${fmt(o.filled_out, outDp(2))} ${SV.out.sym}</span></td>
        <td>${avg}</td>
        <td>${waitCell}</td>
        <td>${exp}</td>
        <td><span class="tag ${status.toLowerCase()}${expired ? " expired" : ""}">${esc(label)}</span></td>
        <td>${status === "Open" ? `<button class="small ghost" data-sv-cancel="${o.id}">Cancel</button>` : ""}</td>
      </tr>`;
    })
    .join("");
  checkSellFills(rows);
  $("sv-count").textContent = `(${openCount})`;
  $("sv-orders").innerHTML = `<table><thead><tr><th>#</th><th>Amount</th><th>Price</th><th>Sold</th><th>Avg. price</th><th>Earning ${tip(`Estimated ${BS} interest the unsold part earns on Blend per day, at today's rate.`)}</th><th>Expires</th><th>Status</th><th></th></tr></thead><tbody>${html}</tbody></table>`;
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
for (const c of document.querySelectorAll("#sv-days [data-days]")) {
  c.onclick = () => {
    SV.days = Number(c.dataset.days);
    for (const o of document.querySelectorAll("#sv-days [data-days]")) o.setAttribute("aria-pressed", String(o === c));
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
  const expiry = Math.floor(Date.now() / 1000) + SV.days * 86400;
  const p = Number(price) / 1e7;
  const rows = [
    ["You sell", `${fmt(amount, 4)} ${BS}`],
    [`Sell when 1 ${BS} is at or above`, `${px4(p)} ${SV.out.sym}`],
    ["You receive at least", `${fmt(minOut(amount, limit), outDp(4))} ${SV.out.sym}`],
  ];
  if (SV.mkt) rows.push(["Market price now", `${px4(SV.mkt)} ${SV.out.sym}${p > SV.mkt ? ` (your price is ${((p / SV.mkt - 1) * 100).toFixed(1)}% above)` : ""}`]);
  rows.push(["Expires", new Date(expiry * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })]);
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
  const expiry = Math.floor(Date.now() / 1000) + SV.days * 86400;
  const rows = [
    ["You sell", `${fmt(amount, 4)} ${BS}`],
    [`Sell if 1 ${BS} drops to`, `${px4(p)} ${SV.out.sym}`],
    ["Never sell below", `${px4(Number(worst) / 1e7)} ${SV.out.sym}`],
    ["You receive at least", `${fmt(minOut(amount, limit), outDp(4))} ${SV.out.sym}`],
  ];
  if (SV.mkt) rows.push(["Market price now", `${px4(SV.mkt)} ${SV.out.sym}${p < SV.mkt ? ` (your stop is ${((1 - p / SV.mkt) * 100).toFixed(1)}% below)` : ""}`]);
  rows.push(["Expires", new Date(expiry * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })]);
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
  const expiry = Math.floor(Date.now() / 1000) + SV.days * 86400;
  const rows = lv.map((l, i) => [`Order ${i + 1}`, `${fmt(l.amt, 2)} ${BS} at ≥ ${px4(Number(l.px) / 1e7)} (≥ ${fmt(minOut(l.amt, l.lim), outDp(2))} ${SV.out.sym})`]);
  if (SV.mkt) rows.push(["Market price now", `${px4(SV.mkt)} ${SV.out.sym}`]);
  rows.push(["Expires", new Date(expiry * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })]);
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
  if (!r.ok || !r.value) return tradeNote("This market has no Soroswap pool yet, so there is no price to chart.");
  const pair = String(r.value);
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
  const full = (filters, limit) => async () => ({ ...(await scan((h) => ({ startLedger: h.oldestLedger + 2 }), filters, limit)), full: true });
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
  TR.lines = out.filter((o) => o.price > 0);
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
$("olimit2").addEventListener("input", updateTicket);
$("sv-px2").addEventListener("input", updateSellTicket);
// The "get USDC" button on the Test funds page: Trade > Sell > Market
$("go-mkt-sell").addEventListener("click", () => setTimeout(() => document.querySelector('#tk-sell [data-ot="market"]').click(), 0));

// Percentage buttons under the amount boxes: what share of the available balance to trade with.
// (The old "Market / -5% / -10% / -20%" price buttons were removed; clicking the market price label fills in the price.)
{
  const pctOf = (units, p) => (units * BigInt(p)) / 100n;
  const mark = (box, on) => {
    for (const o of box.querySelectorAll("[data-p]")) o.setAttribute("aria-pressed", String(o === on));
  };
  const wire = (boxId, inputId, max, after) => {
    const box = $(boxId), input = $(inputId);
    for (const b of box.querySelectorAll("[data-p]")) {
      b.onclick = () => {
        const m = max();
        if (m === null) return;
        const v = pctOf(m, Number(b.dataset.p));
        input.value = v > 0n ? trim7(v) : "";
        after();
        mark(box, b); // "after" does not fire the input event; the selected button stays marked
      };
    }
    input.addEventListener("input", () => mark(box, null)); // typing by hand clears the mark
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
// "+" : the Deposit tab of the vault card
for (const b of document.querySelectorAll("[data-open-dep]")) b.onclick = () => openDeposit(b.dataset.openDep);
$("buy-wal-dep").onclick = () => openDeposit("dep", walletDepositable("dep"));
$("sv-wal-dep").onclick = () => openDeposit("sv-dep", walletDepositable("sv-dep"));
// Take profit checkbox: unticking clears the price (take profit off)
$("tp-on").onchange = () => {
  const on = $("tp-on").checked;
  $("autosell-row").classList.toggle("open", on);
  if (on) return $("tp-px").focus();
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
