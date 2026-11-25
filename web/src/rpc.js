// Soroban RPC connection: the fast server first, a fallback if there is a problem.
//
// Stellar's free testnet RPC (soroban-testnet.stellar.org) answers in 1.5-5 s from some connections
// (measured 8 Nov 2026); Gateway's public testnet RPC does the same job in about 0.15 s. The app makes dozens of
// reads when it opens, so this difference directly sets how long the page takes to load.
// If the first server gives a network error, returns 5xx or does not answer within TIMEOUT_MS, the same call
// is repeated on the next server; a minute later the first server is tried again. Contract errors (a simulation
// error, "account not found" and the like) are real answers: they are not repeated on another server.
//
// Measured on 25 Nov 2026: one page load sent 163 requests in 5 s, 81 of them the same `vault_of` question.
// Gateway lets about 30 requests through at once and then roughly 15 a second (per visitor address); beyond that
// it answers 429. The 429s pushed the whole app to the slow fallback for a minute. Five things in this file keep
// that from happening:
//   1. Reads are shared: the same question asked twice within a few seconds goes to the network once
//      (and answers that can never change, such as "which vault belongs to this wallet", are remembered).
//   2. Requests leave each server in a steady stream it accepts, never as a burst it would refuse.
//   3. What does not fit into that stream right away goes to the next server instead of waiting in line.
//   4. A 429 means "slow down", not "this server is down": the stream slows, the call tries again.
//   5. A read that a server does not answer within a second or so is also sent to the next server.
import { Account, Address, Keypair, rpc, xdr } from "@stellar/stellar-sdk";

export const RPC_PRIMARY = "https://soroban-rpc.testnet.stellar.gateway.fm";
export const RPC_FALLBACK = "https://soroban-testnet.stellar.org";
const TIMEOUT_MS = 8000;
const RETRY_PRIMARY_MS = 60_000;
// If the server in use has not answered a read after this long, the same read is also sent to the next server
// and the first answer wins. A slow server then costs about a second, not the full timeout.
const HEDGE_MS = 1200;
// A read still waiting for its turn after this long is offered to the next server too: two servers carry a busy
// moment (a first visit, a page with many orders) between them.
const SPILL_MS = 250;
const SLOW_STRIKES = 3; // this many reads in a row answered first by the next server: use that server for a while

// The Stellar SDK adds X-Client-Name / X-Client-Version headers to every request. Gateway's browser (CORS) setting
// does not allow these headers, so the browser never sent the request; the SDK reported that network error as
// "Account not found" (8 Nov 2026). The headers are informational only: they are removed from requests to our RPC addresses.
const rpcBases = new Set();
function stripClientHeaders(headers) {
  const h = new Headers(headers || {});
  h.delete("x-client-name");
  h.delete("x-client-version");
  return h;
}
if (typeof window !== "undefined" && typeof window.fetch === "function" && !window.__ioraRpcFetch) {
  const orig = window.fetch.bind(window);
  window.__ioraRpcFetch = true;
  window.fetch = (input, init) => {
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
      if (url && [...rpcBases].some((b) => url.startsWith(b))) {
        if (init) init = { ...init, headers: stripClientHeaders(init.headers) };
        else if (input instanceof Request) input = new Request(input, { headers: stripClientHeaders(input.headers) });
      }
    } catch {}
    return orig(input, init);
  };
}

const statusOf = (e) => (e && e.response && e.response.status) || 0;
function transient(e) {
  const status = statusOf(e);
  if (status === 429 || (status >= 500 && status < 600)) return true;
  return /failed to fetch|network|timeout|timed out|aborted|ECONN|socket|load failed|did not answer/i.test(String((e && e.message) || e));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Counters for diagnosing a slow page: type __ioraRpc in the browser console.
const stats = { sent: 0, shared: 0, remembered: 0, waited429: 0, hedged: 0, fellBack: 0, queuedMax: 0 };
if (typeof window !== "undefined") window.__ioraRpc = stats;

// ---------------------------------------------------------------------------
// A steady stream of requests (one gate per server)
// ---------------------------------------------------------------------------
// At most MAX_ACTIVE requests are on the wire. BURST of them may leave at once, after that PER_SECOND.
// Gateway accepts about 30 at once and then roughly 15 a second (measured on the live site, 25 Nov 2026); this
// stream stays under both. If a server still answers 429 (a second open tab, several people behind one address),
// its stream slows down and speeds up again only gradually.
// Three lanes: 0 = the user's own action (building, sending and following a transaction), 1 = reads for the
// screen, 2 = background history scans. A lower lane always goes first.
const MAX_ACTIVE = 16;
const BURST = 22;
const PER_SECOND = 12;
const SKIPPED = new Error("not needed any more");
function makeGate() {
  const lanes = [[], [], []];
  let rate = PER_SECOND;
  let burst = BURST;
  let tokens = BURST;
  let tokensAt = Date.now();
  let active = 0;
  let holdUntil = 0; // after a 429 nothing new starts until this time
  let timer = null;
  function pump() {
    for (;;) {
      let lane;
      for (;;) {
        lane = lanes.find((l) => l.length);
        if (!lane || !lane[0].ctl.done) break;
        lane.shift().skip(); // another server has answered this call already
      }
      if (!lane || active >= MAX_ACTIVE) return;
      const now = Date.now();
      tokens = Math.min(burst, tokens + ((now - tokensAt) * rate) / 1000);
      tokensAt = now;
      const wait = Math.max(holdUntil - now, tokens >= 1 ? 0 : Math.ceil(((1 - tokens) * 1000) / rate));
      if (wait > 0) {
        if (!timer)
          timer = setTimeout(() => {
            timer = null;
            pump();
          }, wait);
        return;
      }
      tokens -= 1;
      const job = lane.shift();
      active++;
      stats.sent++;
      job.run().finally(() => {
        active--;
        pump();
      });
    }
  }
  return {
    /** Runs `fn` (one network request) when its turn comes; `ctl.done` drops it if it is still waiting. */
    inTurn(lane, ctl, fn) {
      return new Promise((resolve, reject) => {
        const run = () => {
          let p;
          try {
            p = fn();
          } catch (e) {
            p = Promise.reject(e);
          }
          return p.then(resolve, reject);
        };
        lanes[lane].push({ ctl, run, skip: () => reject(SKIPPED) });
        const waiting = lanes[0].length + lanes[1].length + lanes[2].length;
        if (waiting > stats.queuedMax) stats.queuedMax = waiting;
        pump();
      });
    },
    tooMany(pause) {
      holdUntil = Math.max(holdUntil, Date.now() + pause);
      tokens = 0;
      rate = Math.max(4, rate * 0.6);
      burst = Math.max(4, Math.floor(burst * 0.6));
    },
    answered() {
      if (rate < PER_SECOND) rate = Math.min(PER_SECOND, rate + 0.2);
      if (burst < BURST) burst = Math.min(BURST, burst + 0.2);
    },
  };
}
const LANE = { sendTransaction: 0, getTransaction: 0, getLedgerEntries: 0, getEvents: 2, getHealth: 2 };

// ---------------------------------------------------------------------------
// Shared reads
// ---------------------------------------------------------------------------
// A read is a simulation the app builds on sequence number "0" (readCall in main.js); a transaction that is
// about to be signed uses the account's real sequence number and is never shared or remembered.
const READ_TTL_MS = 4000;
const STORE = "iora-rc1:";
const VOID_XDR = "AAAAAQ=="; // an empty answer (for example: this wallet has no vault in that factory)
const mem = new Map(); // key -> { p } while on the wire, { v, until } once answered
const exists = new Map(); // address -> the same, for "does this account exist?"
let epoch = 0;
let policy = () => null;
/**
 * How long may an answer be reused? `fn({ contract, fn, empty })` returns null for the default (a few seconds),
 * or { ttl: milliseconds, keep: true } to remember it in this browser across page loads as well.
 */
export function setReadPolicy(fn) {
  policy = typeof fn === "function" ? fn : () => null;
}
/** Forget every shared answer (after a transaction, or when the user presses Refresh). With `all`, the remembered "nothing there" answers go too. */
export function flushReads(all = false) {
  epoch++;
  mem.clear();
  exists.clear();
  if (!all) return;
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(STORE) && String(localStorage.getItem(k)).endsWith(`"${VOID_XDR}"}`)) localStorage.removeItem(k);
    }
  } catch {}
}
// SDK versions expose XDR fields either as properties or as functions; both are read.
const field = (o, k) => (o && typeof o[k] === "function" ? o[k]() : o?.[k]);
function readInfo(tx) {
  try {
    if (!tx || String(tx.sequence) !== "1") return null;
    const ops = tx.operations;
    if (!ops || ops.length !== 1 || ops[0].type !== "invokeHostFunction") return null;
    const hf = ops[0].func;
    const ic = field(hf, "invokeContract");
    if (!ic) return null;
    const contract = Address.fromScAddress(field(ic, "contractAddress")).toString();
    const fn = String(field(ic, "functionName"));
    const what = hf.toXDR("base64");
    return { key: `${tx.source}|${what}`, contract, fn, slot: `${STORE}${contract}:${fn}:${xdr.ScVal.scvVec(field(ic, "args")).toXDR("base64")}` };
  } catch {
    return null;
  }
}
function remembered(info) {
  try {
    const raw = localStorage.getItem(info.slot);
    if (!raw) return null;
    const { u, x } = JSON.parse(raw);
    if (typeof x !== "string" || (u && Date.now() > u)) {
      localStorage.removeItem(info.slot);
      return null;
    }
    return { v: { latestLedger: 0, result: { auth: [], retval: xdr.ScVal.fromXDR(x, "base64") } }, until: u || Infinity };
  } catch {
    return null;
  }
}
function sharedRead(info, send) {
  const now = Date.now();
  const hit = mem.get(info.key);
  if (hit && (hit.p || now < hit.until)) {
    stats.shared++;
    return hit.p || Promise.resolve(hit.v);
  }
  const kept = remembered(info);
  if (kept) {
    stats.remembered++;
    mem.set(info.key, kept);
    return Promise.resolve(kept.v);
  }
  const at = epoch;
  const p = send().then(
    (sim) => {
      if (at !== epoch) return sim; // a transaction went out meanwhile: this answer may describe the state before it
      let ttl = READ_TTL_MS;
      const ok = sim && !("error" in sim) && sim.result && sim.result.retval;
      if (ok) {
        let x = null;
        try {
          x = sim.result.retval.toXDR("base64");
        } catch {}
        let rule = null;
        try {
          rule = policy({ contract: info.contract, fn: info.fn, empty: x === VOID_XDR });
        } catch {}
        if (rule && rule.ttl > 0) {
          ttl = rule.ttl;
          if (rule.keep && x) {
            try {
              localStorage.setItem(info.slot, JSON.stringify({ u: Number.isFinite(ttl) ? Date.now() + ttl : 0, x }));
            } catch {}
          }
        }
      }
      mem.set(info.key, { v: sim, until: Date.now() + ttl });
      return sim;
    },
    (e) => {
      if (mem.get(info.key) && mem.get(info.key).p === p) mem.delete(info.key);
      throw e;
    },
  );
  mem.set(info.key, { p });
  return p;
}

// The SDK's getAccount reports every case where the account cannot be read (network error, CORS included) as
// "Account not found"; so when the first server went down there was no falling back, and every transaction to be
// signed stopped with that error. The same read is done here with getLedgerEntries: a network error is retried on
// the next server, and an account that really does not exist returns "Account not found" in one call (no slow fallback). Same read as getAccount in SDK 17.4.0.
function accountKey(address) {
  return xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrPublicKey() }));
}

/** urls: RPC addresses to try (in order). The returned object has the same methods as rpc.Server. */
export function makeServer(urls) {
  const list = [...new Set(urls.filter(Boolean))];
  for (const u of list) rpcBases.add(u.replace(/\/+$/, ""));
  const servers = list.map((u) => new rpc.Server(u, { allowHttp: u.startsWith("http://") }));
  const gates = servers.map(() => makeGate());
  let cur = 0; // the server in use
  let switchedAt = 0;
  let probing = false; // one call is checking whether the first server is back
  let slow = 0; // reads in a row that the next server answered first

  /** One request to one server: waits its turn, has a time limit, and waits out a 429 on the same server. */
  async function one(idx, name, args, lane, ctl, on) {
    for (let again = 0; ; again++) {
      let timer;
      try {
        const res = await gates[idx].inTurn(lane, ctl, () => {
          on.wire(); // the request leaves now: the time limits count from here, not from when it joined the queue
          return Promise.race([
            servers[idx][name](...args),
            new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("the RPC did not answer (timeout)")), TIMEOUT_MS))),
          ]).finally(() => clearTimeout(timer));
        });
        gates[idx].answered();
        return res;
      } catch (e) {
        if (statusOf(e) !== 429 || again >= 2 || ctl.done) throw e;
        // "Too many requests": the limit clears within a moment. This server pauses briefly, then the call tries it
        // again; meanwhile a read is also put to the next server, so the user does not wait for the pause.
        stats.waited429++;
        on.limited();
        const pause = 350 * (again + 1) + Math.floor(Math.random() * 150);
        gates[idx].tooMany(pause);
        await sleep(pause);
        if (ctl.done) throw SKIPPED;
      }
    }
  }

  function call(name, args, lane = LANE[name] ?? 1) {
    // Which servers, in which order? Normally the one in use, then the others. Once a minute a single call checks
    // whether the first server is back, while every other call stays where it is. Background history scans start
    // on the other server, so the stream of the server in use is left to what the screen is waiting for.
    const background = lane === 2 && servers.length > 1;
    let probe = false;
    if (!background && cur !== 0 && !probing && Date.now() - switchedAt > RETRY_PRIMARY_MS) probe = probing = true;
    const first = probe ? 0 : background && cur === 0 ? 1 : cur;
    const order = [first, ...servers.map((_, i) => i).filter((i) => i !== first)];
    const hedge = name !== "sendTransaction" && order.length > 1;
    const ctl = { done: false };
    return new Promise((resolve, reject) => {
      let next = 0;
      let pending = 0;
      let lastErr;
      let timer = null;
      let sentAt = 0; // when the first server got the request (0: still in line, or it said "slow down")
      const finish = (idx) => {
        if (probe) probing = false;
        if (background) return; // a history scan says nothing about the server the screen uses
        if (idx === first) {
          slow = 0;
          if (probe) cur = 0; // the first server answers again
        } else if (pending > 0) {
          // another server answered first
          stats.hedged++;
          // Only a server that has had the request for a while without answering counts as slow; one that was
          // merely busy (the request waited in line, or was told to slow down) is fine.
          if (!sentAt || Date.now() - sentAt < HEDGE_MS - 100) return;
          if (probe) switchedAt = Date.now();
          else if (++slow >= SLOW_STRIKES) {
            cur = idx;
            switchedAt = Date.now();
            slow = 0;
          }
        } else {
          // the first choice failed and this one answered: use it for the next minute
          stats.fellBack++;
          cur = idx;
          switchedAt = Date.now();
        }
      };
      const arm = (ms) => {
        clearTimeout(timer);
        if (hedge && !ctl.done && next < order.length) timer = setTimeout(start, ms);
      };
      const start = () => {
        if (ctl.done || next >= order.length) return;
        const idx = order[next++];
        pending++;
        let onWire = false;
        one(idx, name, args, lane, ctl, {
          wire: () => {
            onWire = true;
            if (idx === first) sentAt = Date.now();
            arm(HEDGE_MS);
          },
          limited: () => {
            if (idx === first) sentAt = 0;
            if (!hedge) return;
            clearTimeout(timer);
            start();
          },
        }).then(
          (res) => {
            pending--;
            if (ctl.done) return;
            ctl.done = true;
            clearTimeout(timer);
            finish(idx);
            resolve(res);
          },
          (e) => {
            pending--;
            if (ctl.done) return;
            lastErr = e;
            clearTimeout(timer);
            if (probe && idx === 0) {
              probing = false;
              switchedAt = Date.now();
            }
            if (!transient(e)) {
              ctl.done = true;
              return reject(e);
            }
            if (next < order.length) start();
            else if (!pending) {
              ctl.done = true;
              reject(lastErr);
            }
          },
        );
        if (!onWire) arm(SPILL_MS);
      };
      start();
    });
  }

  function simulateTransaction(tx, ...rest) {
    const info = rest.length ? null : readInfo(tx);
    if (!info) return call("simulateTransaction", [tx, ...rest], 0); // a transaction about to be signed
    return sharedRead(info, () => call("simulateTransaction", [tx]));
  }
  async function sendTransaction(...args) {
    flushReads();
    return call("sendTransaction", args);
  }
  async function getTransaction(...args) {
    const res = await call("getTransaction", args);
    if (res && res.status && res.status !== "NOT_FOUND") flushReads(); // applied (or failed): what was read before is out of date
    return res;
  }

  async function getAccount(address) {
    const res = await call("getLedgerEntries", [accountKey(address)]);
    const entry = res && res.entries && res.entries[0];
    if (!entry || !entry.val || entry.val.type !== "account") throw new Error(`Account not found: ${address}`);
    return new Account(address, entry.val.value.seqNum.toString());
  }
  /**
   * Does this account exist on the network? Shared like the other reads (the screen asks on every refresh).
   * getAccount itself is never shared: a transaction needs the account's sequence number as it is right now.
   */
  function accountExists(address) {
    const hit = exists.get(address);
    if (hit && (hit.p || Date.now() < hit.until)) return hit.p || Promise.resolve(hit.v);
    const at = epoch;
    const p = getAccount(address)
      .then(
        () => true,
        (e) => {
          if (/Account not found/.test(String((e && e.message) || e))) return false;
          throw e;
        },
      )
      .then(
        (v) => {
          if (at === epoch) exists.set(address, { v, until: Date.now() + READ_TTL_MS });
          else if (exists.get(address) && exists.get(address).p === p) exists.delete(address);
          return v;
        },
        (e) => {
          if (exists.get(address) && exists.get(address).p === p) exists.delete(address);
          throw e;
        },
      );
    exists.set(address, { p });
    return p;
  }

  const own = { getAccount, accountExists, simulateTransaction, sendTransaction, getTransaction };
  return new Proxy(
    {},
    {
      get(_, name) {
        if (name === "urls") return list;
        if (Object.prototype.hasOwnProperty.call(own, name)) return own[name];
        // "then" and non-method fields are returned as they are: the object must not hang if it is awaited by mistake.
        const v = servers[0][name];
        if (name === "then" || typeof name === "symbol" || (v !== undefined && typeof v !== "function")) return v;
        return (...args) => call(name, args);
      },
    },
  );
}
