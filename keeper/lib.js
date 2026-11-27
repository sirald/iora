// Pure logic of the Iora keeper: no network calls, no Stellar SDK. keeper.js wires these into the RPC and the
// transaction flow; test/*.test.js tests them with `npm test`.
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Single-instance lock (works on Linux and Windows, no flock needed)
// ---------------------------------------------------------------------------

/** True if a process with this PID exists (EPERM: it exists but belongs to another user). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM";
  }
}

/**
 * Takes the lock file, writing this process's PID into it. If the file names a process that is no longer running
 * (or this very PID, e.g. a container where the keeper is always PID 1), the stale lock is taken over.
 * A file with no readable PID that is younger than `freshMs` is treated as held: another keeper may be between
 * creating the file and writing its PID.
 * Returns { ok: true, release } or { ok: false, pid } (pid: the running holder, or null if unknown).
 */
export function acquireLock(file, { pid = process.pid, isAlive = pidAlive, freshMs = 10_000, now = Date.now } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      try {
        fs.writeSync(fd, String(pid));
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true, release: () => releaseLock(file, pid) };
    } catch (e) {
      if (!e || e.code !== "EEXIST") throw e;
    }
    let text = "";
    let mtime = 0;
    try {
      text = fs.readFileSync(file, "utf8").trim();
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue; // removed in the meantime: try again
    }
    const holder = /^\d+$/.test(text) ? Number(text) : NaN;
    if (Number.isInteger(holder) && holder !== pid && isAlive(holder)) return { ok: false, pid: holder };
    if (!Number.isInteger(holder) && now() - mtime < freshMs) return { ok: false, pid: null };
    try {
      fs.unlinkSync(file); // stale: its process is gone
    } catch {}
  }
  return { ok: false, pid: null };
}

/** Removes the lock file, but only if it is still ours. */
export function releaseLock(file, pid = process.pid) {
  try {
    if (fs.readFileSync(file, "utf8").trim() === String(pid)) fs.unlinkSync(file);
  } catch {}
}

// ---------------------------------------------------------------------------
// On-chain failures per order: after `threshold` failures the order rests for `pauseMs`
// ---------------------------------------------------------------------------

export class FailureGuard {
  constructor({ threshold = 3, pauseMs = 6 * 3600_000 } = {}) {
    this.threshold = Math.max(1, threshold);
    this.pauseMs = pauseMs;
    this.map = new Map(); // key -> { n, last, until }
  }

  /** Records an on-chain failure. Returns { n, paused, until }: paused is true when this failure starts a pause. */
  record(key, now = Date.now()) {
    const e = this.map.get(key) || { n: 0, last: 0, until: 0 };
    // Failures long apart do not add up: a fresh run starts after a quiet pause-length period.
    if (e.last && now - e.last > this.pauseMs) e.n = 0;
    e.n++;
    e.last = now;
    let paused = false;
    if (e.n >= this.threshold) {
      e.until = now + this.pauseMs;
      e.n = 0;
      paused = true;
    }
    this.map.set(key, e);
    return { n: paused ? this.threshold : e.n, paused, until: e.until };
  }

  /** The time until which the key rests, or 0. */
  pausedUntil(key, now = Date.now()) {
    const e = this.map.get(key);
    return e && e.until > now ? e.until : 0;
  }

  /** How many keys are resting now. */
  pausedCount(now = Date.now()) {
    let n = 0;
    for (const e of this.map.values()) if (e.until > now) n++;
    return n;
  }

  clear(key) {
    this.map.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Fee budget: per hour (sliding window) and per scan round
// ---------------------------------------------------------------------------

export class FeeBudget {
  /** Limits in stroops; 0 or less = no limit. */
  constructor({ perHour = 0, perRound = 0 } = {}) {
    this.perHour = perHour;
    this.perRound = perRound;
    this.entries = []; // { id, at, fee } (fee: reserved maximum until settled, then what was charged)
    this.round = 0;
    this.seq = 0;
  }

  _prune(now) {
    while (this.entries.length && now - this.entries[0].at > 3600_000) this.entries.shift();
  }

  spentLastHour(now = Date.now()) {
    this._prune(now);
    return this.entries.reduce((a, e) => a + e.fee, 0);
  }

  startRound() {
    this.round = 0;
  }

  /** Why a write of `fee` stroops may not go out now, or null if it may. */
  blockReason(fee = 0, now = Date.now()) {
    if (this.perHour > 0 && this.spentLastHour(now) + fee > this.perHour) return "hourly fee budget";
    if (this.perRound > 0 && this.round + fee > this.perRound) return "per-round fee budget";
    return null;
  }

  /** Reserves the maximum fee of a transaction about to be sent; returns an id for settle(). */
  reserve(fee, now = Date.now()) {
    const id = ++this.seq;
    this.entries.push({ id, at: now, fee });
    this.round += fee;
    return id;
  }

  /** Replaces a reservation with what was really charged (0 when the network did not take the transaction). */
  settle(id, charged) {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    this.round += charged - e.fee;
    if (this.round < 0) this.round = 0;
    e.fee = charged;
  }
}

// ---------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------

/** XLM (string or number) to stroops; NaN-safe (returns the fallback). */
export function xlmToStroops(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e7) : fallback;
}

/**
 * The inclusion fee to bid, in stroops: the chosen percentile of recent Soroban inclusion fees (getFeeStats),
 * never below `base` and never above `max` (0 = no maximum). Falls back to `base` when the stats are missing.
 */
export function inclusionFeeFrom(stats, { base = 100, percentile = "p70", max = 0 } = {}) {
  const src = stats && (stats.sorobanInclusionFee || stats.inclusionFee);
  const v = src ? Number(src[percentile] ?? src.p50 ?? src.mode) : NaN;
  let fee = Number.isFinite(v) && v > base ? Math.ceil(v) : base;
  if (max > 0 && fee > max) fee = Math.max(base, max);
  return fee;
}

/** True when a transaction's total fee (inclusion + resource, stroops) is within the cap (0 = no cap). */
export const withinFeeCap = (totalFee, cap) => !(cap > 0) || Number(totalFee) <= cap;

/** True when a sendTransaction error result names a bad sequence number. */
export const isBadSeq = (name) => /bad_?seq/i.test(String(name || ""));

/** The sequence to build on: the RPC's, unless we know a later one this account has already used on chain. */
export function pickSequence(rpcSeq, knownSeq) {
  const a = BigInt(rpcSeq);
  if (knownSeq === undefined || knownSeq === null) return a;
  const b = BigInt(knownSeq);
  return b > a ? b : a;
}

// ---------------------------------------------------------------------------
// RPC: list, error classification and server choice
// ---------------------------------------------------------------------------

/** RPC_URL first, then every entry of the comma-separated RPC_FALLBACK, then the extra defaults; no duplicates. */
export function rpcList(primary, fallback, extra = []) {
  const list = [primary, ...String(fallback || "").split(","), ...extra].map((s) => String(s || "").trim()).filter(Boolean);
  return [...new Set(list)];
}

/** Short reason for an RPC failure: "timeout", "HTTP 503", or the network error. */
export function rpcFailReason(e) {
  const status = e && e.response && e.response.status;
  if (status) return `HTTP ${status}`;
  const msg = String((e && e.message) || e || "");
  if (/did not answer|timeout|timed out|TimeoutError|aborted|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(msg)) return `timeout (${msg.slice(0, 80)})`;
  return msg.slice(0, 120) || "unknown error";
}

/** True for failures worth repeating on another server (network, timeout, 429, 5xx, RPC overload). */
export function transientRpc(e) {
  const status = e && e.response && e.response.status;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  return /fetch failed|network|timeout|timed out|aborted|ECONN|socket|EAI_AGAIN|ENOTFOUND|did not answer|queue full|retry later/i.test(
    String((e && e.message) || e),
  );
}

/**
 * Which RPC server to use. The first server is preferred; after it fails, the others are used and the first one is
 * tried again after a back-off that doubles with each failure that comes soon after the last one (1, 2, 4 ... up to
 * maxMs), so a flaky first server does not make the keeper switch back and forth every few minutes.
 */
export class RpcPicker {
  constructor(n, { baseMs = 60_000, maxMs = 30 * 60_000 } = {}) {
    this.n = n;
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.cur = 0;
    this.strikes = 0; // failures of the first server close together
    this.primaryFailedAt = null;
    this.retryAt = 0; // when the first server is tried again
    this.consecutiveErrors = 0; // failed attempts in a row, any server
    this.lastError = null;
  }

  /** Server indexes to try, in order. */
  order(now = Date.now()) {
    const start = this.cur !== 0 && now >= this.retryAt ? 0 : this.cur;
    return Array.from({ length: this.n }, (_, i) => (start + i) % this.n);
  }

  /** Returns "primary" when this success moved the keeper back to the first server, "switched" when to another one. */
  success(idx) {
    this.consecutiveErrors = 0;
    if (idx === this.cur) return null;
    this.cur = idx;
    return idx === 0 ? "primary" : "switched";
  }

  failure(idx, reason, now = Date.now()) {
    this.consecutiveErrors++;
    this.lastError = `${idx}: ${reason}`;
    if (idx !== 0) return;
    // A failure long after the previous one starts the back-off again from the bottom.
    this.strikes = this.primaryFailedAt !== null && now - this.primaryFailedAt < this.maxMs + this.baseMs ? this.strikes + 1 : 1;
    this.primaryFailedAt = now;
    this.retryAt = now + Math.min(this.baseMs * 2 ** (this.strikes - 1), this.maxMs);
  }
}

// ---------------------------------------------------------------------------
// Memory: forget everything kept about an order once it is closed
// ---------------------------------------------------------------------------

/**
 * Removes an order's entries from the per-order maps: plain "vault:id" keys, "venue:vault:id" notes and cross-pair
 * keys "x:a|b" that name it. `maps` are Maps or Sets keyed by strings.
 */
export function forgetOrder(key, maps) {
  for (const m of maps) {
    if (!m) continue;
    m.delete(key);
    m.delete(`venue:${key}`);
    for (const k of m.keys()) {
      if (typeof k === "string" && k.startsWith("x:") && (k.startsWith(`x:${key}|`) || k.endsWith(`|${key}`))) m.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------
// RPC rate limiting: token bucket per server, AIMD on HTTP 429, Retry-After
// ---------------------------------------------------------------------------

/** RPC_MAX_RPS: one number for every server, or a comma list in server order (the last value repeats). */
export function rpsList(spec, n, fallback) {
  const vals = String(spec ?? "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x) && x > 0);
  if (!vals.length) return Array.from({ length: n }, () => fallback);
  return Array.from({ length: n }, (_, i) => vals[Math.min(i, vals.length - 1)]);
}

/**
 * A token bucket that also works as a FIFO queue: take() always takes a token and says how long the caller must
 * wait before using it (0 = now). Tokens may go negative; each later caller waits its turn behind the earlier ones.
 * The rate can change at any time (AIMD below).
 */
export class TokenBucket {
  constructor(rate, burst = Math.max(1, rate), now = Date.now()) {
    this.rate = rate; // tokens per second
    this.burst = burst;
    this.tokens = burst;
    this.at = now;
  }

  _refill(now) {
    if (now > this.at) {
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
      this.at = now;
    }
  }

  /** Takes one token; returns the wait in ms before the request may go out. */
  take(now = Date.now()) {
    this._refill(now);
    this.tokens -= 1;
    if (this.tokens >= 0 && this.at <= now) return 0;
    // the moment the bucket is back at zero: from `at` (which is in the future after drain()), at `rate`
    return Math.max(0, Math.ceil(this.at + (Math.max(0, -this.tokens) / this.rate) * 1000 - now));
  }

  /** The wait in ms a take() now would have to do, without taking anything. */
  peek(now = Date.now()) {
    const t = this.at <= now ? Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate) : this.tokens;
    const after = t - 1;
    if (after >= 0 && this.at <= now) return 0;
    return Math.max(0, Math.ceil(Math.max(this.at, now) + (Math.max(0, -after) / this.rate) * 1000 - now));
  }

  /** Nothing goes out before `until`, and no tokens build up meanwhile (after a 429: no burst when it ends). */
  drain(until) {
    this.tokens = Math.min(this.tokens, 0);
    this.at = Math.max(this.at, until);
  }

  setRate(rate, now = Date.now()) {
    this._refill(now);
    this.rate = rate;
  }
}

/**
 * Additive increase, multiplicative decrease: a 429 halves the rate (not below `min`); after `holdMs` without a 429
 * the rate grows back by `stepPerSec` every second, up to `max`.
 */
export class Aimd {
  constructor(max, { min = Math.min(0.5, max), stepPerSec = max / 60, holdMs = 30_000 } = {}) {
    this.max = max;
    this.min = min;
    this.stepPerSec = stepPerSec;
    this.holdMs = holdMs;
    this.cur = max;
    this.cutAt = -Infinity;
    this.at = 0;
  }

  /** The rate allowed now. */
  rate(now = Date.now()) {
    if (this.cur < this.max) {
      const from = Math.max(this.at, this.cutAt + this.holdMs);
      if (now > from) {
        this.cur = Math.min(this.max, this.cur + ((now - from) / 1000) * this.stepPerSec);
        this.at = now;
      }
    }
    return this.cur;
  }

  /** A 429 came back: halve the rate (several 429s within one second count once). */
  cut(now = Date.now()) {
    this.rate(now);
    if (now - this.cutAt < 1000) return this.cur;
    this.cur = Math.max(this.min, this.cur / 2);
    this.cutAt = now;
    this.at = now;
    return this.cur;
  }
}

/** The Retry-After of an HTTP error in ms (seconds or an HTTP date), capped at maxMs; null when absent/unreadable. */
export function retryAfterMs(e, now = Date.now(), maxMs = 60_000) {
  const h = e && e.response && e.response.headers;
  if (!h) return null;
  const raw = typeof h.get === "function" ? h.get("retry-after") : (h["retry-after"] ?? h["Retry-After"]);
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const s = String(raw).trim();
  let ms;
  if (/^\d+(\.\d+)?$/.test(s)) ms = Number(s) * 1000;
  else {
    const t = Date.parse(s);
    if (!Number.isFinite(t)) return null;
    ms = t - now;
  }
  return Math.max(0, Math.min(maxMs, Math.round(ms)));
}

export const isRateLimited = (e) => !!(e && e.response && e.response.status === 429);

// ---------------------------------------------------------------------------
// RPC usage counter: requests per server and per method over the last full minute
// ---------------------------------------------------------------------------

export class RpcUsage {
  constructor(now = Date.now()) {
    this.start = now;
    this.cur = { servers: new Map(), methods: new Map(), rateLimited: 0, waitedMs: 0 };
    this.last = null; // the last complete minute
  }

  _roll(now) {
    if (now - this.start < 60_000) return;
    // A gap of several idle minutes: the last complete minute is the empty one just before now.
    this.last = now - this.start < 120_000 ? this.cur : { servers: new Map(), methods: new Map(), rateLimited: 0, waitedMs: 0 };
    this.cur = { servers: new Map(), methods: new Map(), rateLimited: 0, waitedMs: 0 };
    this.start = now - ((now - this.start) % 60_000);
  }

  count(server, method, now = Date.now()) {
    this._roll(now);
    this.cur.servers.set(server, (this.cur.servers.get(server) || 0) + 1);
    this.cur.methods.set(method, (this.cur.methods.get(method) || 0) + 1);
  }

  rateLimited(now = Date.now()) {
    this._roll(now);
    this.cur.rateLimited++;
  }

  waited(ms, now = Date.now()) {
    this._roll(now);
    this.cur.waitedMs += ms;
  }

  /** The last complete minute: { per_server: {url: n}, top_methods: [[method, n] x5], total, rate_limited, waited_ms }. */
  lastMinute(now = Date.now()) {
    this._roll(now);
    const m = this.last;
    if (!m) return null;
    const total = [...m.servers.values()].reduce((a, b) => a + b, 0);
    return {
      total,
      per_server: Object.fromEntries(m.servers),
      top_methods: [...m.methods].sort((a, b) => b[1] - a[1]).slice(0, 5),
      rate_limited: m.rateLimited,
      waited_ms: m.waitedMs,
    };
  }
}

// ---------------------------------------------------------------------------
// Adaptive scan interval
// ---------------------------------------------------------------------------

/**
 * How close an order is to filling: output it would get now / output its limit needs (1 = exactly at the limit).
 * Null when either is unknown.
 */
export function limitRatio(q, need) {
  if (q === null || q === undefined || need === null || need === undefined) return null;
  const n = Number(need);
  if (!(n > 0)) return null;
  return Number(q) / n;
}

/** True when the order is within `nearPct` percent of its limit (or past it). An unknown ratio counts as near. */
export const isNear = (ratio, nearPct) => ratio === null || ratio >= 1 - nearPct / 100;

/**
 * The time to wait between full scans: every ledger (0) while any order is near its limit (or could cross, or is
 * due, or events cannot be read), `idleMs` otherwise.
 */
export function scanIntervalMs({ near, eventsOk, idleMs }) {
  return near || !eventsOk ? 0 : idleMs;
}

// ---------------------------------------------------------------------------
// Crossing: bounded work per scan (IORA-06)
// ---------------------------------------------------------------------------

/**
 * Picks the crossing candidates for this scan: vaults in turn starting at `cursor`, at most `perVault` orders of
 * each and at most `max` in all. `groups` is [[vault, orders[]], ...] (each vault's orders already in its own turn).
 * Returns { list, nextCursor }; the cursor moves on by the vaults used, so a large book is covered over several scans.
 */
export function takeCandidates(groups, cursor = 0, { max = 200, perVault = 12 } = {}) {
  const n = groups.length;
  const list = [];
  let used = 0;
  for (let i = 0; i < n && list.length < max; i++) {
    const orders = groups[(cursor + i) % n][1];
    list.push(...orders.slice(0, Math.min(perVault, max - list.length)));
    used = i + 1;
  }
  return { list, nextCursor: n ? (cursor + used) % n : 0 };
}

/**
 * The crossing pairs to try, lazily: for each order a (starting at `offset` and wrapping), the opposite orders b in
 * other vaults whose limits overlap, most generous first, at most `perOrder` per a; each pair once. Opposite orders
 * are found through an index by direction, so the work is about list size x perOrder, not list size squared.
 * `limitOf(x)` gives the order's limit (BigInt); two limits overlap when la * lb >= scale * scale.
 * `isUsed(key)` is asked as pairs are produced (an order crossed earlier in the same pass is skipped).
 * Yields { a, b, index } (index: a's position in `list`).
 */
export function* crossPairs(list, { offset = 0, perOrder = 2, scale = 10_000_000n, isUsed = () => false } = {}) {
  const n = list.length;
  if (n < 2) return;
  const byDir = new Map();
  for (const o of list) {
    const k = `${o.tin}|${o.tout}`;
    if (!byDir.has(k)) byDir.set(k, []);
    byDir.get(k).push(o);
  }
  for (const g of byDir.values()) g.sort((p, q) => (q.limit > p.limit ? 1 : q.limit < p.limit ? -1 : 0));
  const seen = new Set();
  const need = scale * scale;
  for (let i = 0; i < n; i++) {
    const index = (((offset % n) + n) % n + i) % n;
    const a = list[index];
    if (isUsed(a.key)) continue;
    const opp = byDir.get(`${a.tout}|${a.tin}`);
    if (!opp) continue;
    let given = 0;
    for (const b of opp) {
      if (given >= perOrder) break;
      if (a.limit * b.limit < need) break; // sorted most generous first: no later b overlaps either
      if (b.vault === a.vault || isUsed(b.key)) continue;
      const pk = a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`;
      if (seen.has(pk)) continue;
      seen.add(pk);
      given++;
      yield { a, b, index };
      if (isUsed(a.key)) break; // a was just crossed
    }
  }
}

/** A work budget for one pass: pairs tried, price quotes and time. */
export class WorkBudget {
  constructor({ pairs = 10, quotes = 24, ms = 4000 } = {}, now = Date.now()) {
    this.max = { pairs, quotes, ms };
    this.start = now;
    this.pairs = 0;
    this.quotes = 0;
  }

  /** May one more pair (needing up to `quotes` price quotes) start now? */
  canStart(quotes = 0, now = Date.now()) {
    return this.pairs < this.max.pairs && this.quotes + quotes <= this.max.quotes && now - this.start < this.max.ms;
  }

  pair() {
    this.pairs++;
  }

  quote(n = 1) {
    this.quotes += n;
  }
}

// ---------------------------------------------------------------------------
// Minimum output per route leg (slippage protection for filler routes)
// ---------------------------------------------------------------------------

/** A leg's minimum: its quote less `bps` basis points, rounded down; 0 without a positive quote. */
export function legMinOut(quote, bps) {
  if (quote === null || quote === undefined) return 0n;
  const q = BigInt(quote);
  if (q <= 0n) return 0n;
  const t = BigInt(Math.max(0, Math.min(10_000, Math.round(Number(bps) || 0))));
  return (q * (10_000n - t)) / 10_000n;
}

/**
 * Minimums for the legs of a route whose legs all pay out the bought token (one leg, or a split over pools):
 * each leg's own quote less the tolerance, raised where needed so that together they still cover `need` (what the
 * vault's limit requires; 0 = no floor), shared in proportion to the quotes. A leg's minimum never exceeds its quote.
 * Returns null when the quotes together cannot cover `need` (the route cannot meet the limit).
 */
export function splitMins(quotes, need, bps) {
  const qs = quotes.map((q) => (q === null || q === undefined ? 0n : BigInt(q)));
  const total = qs.reduce((a, b) => a + b, 0n);
  const n = BigInt(need || 0);
  if (n > total) return null;
  return qs.map((q) => {
    const tol = legMinOut(q, bps);
    const share = total > 0n && n > 0n ? (n * q + total - 1n) / total : 0n; // ceil(need * q / total)
    const m = tol > share ? tol : share;
    return m > q ? q : m;
  });
}

/**
 * A route through an intermediate token: leg 1 sells the order's amount for the mid token (quote q1), leg 2 sells
 * the mid token. Leg 2 is planned for leg 1's MINIMUM, so any leg-1 result the tolerance allows can pay for it;
 * what leg 1 brings above that minimum is sent to the vault by the filler's `sweep` step. Returns { min1, in2 }.
 */
export function viaPlan(q1, bps) {
  const min1 = legMinOut(q1, bps);
  return { min1, in2: min1 };
}

/**
 * Comet's max_price: the highest spot price (token in per token out, 7 decimals) the pool may reach. A loose
 * ceiling, `factor` times the worst average price the leg's minimum allows (amount in / minimum out); the minimum
 * itself is the real protection. factor <= 0 or no minimum: no ceiling (i128 max).
 */
export function cometMaxPrice(amountIn, minOut, factor, scale = 10_000_000n) {
  const I128_MAX = 170141183460469231731687303715884105727n;
  const m = BigInt(minOut || 0);
  const f = Number(factor);
  if (!(f > 0) || m <= 0n) return I128_MAX;
  const avg = (BigInt(amountIn) * scale + m - 1n) / m;
  const p = (avg * BigInt(Math.round(f * 100))) / 100n;
  return p > I128_MAX ? I128_MAX : p;
}

/**
 * Whether a filler route that failed in simulation should simply be tried again on the next ledger (a quote that
 * moved past the tolerance: free, no penalty) instead of falling back to the vault's own route. After `max`
 * misses in a row the fallback is used, so a venue that is broken for good cannot hold an order up.
 */
export const retryRoute = (misses, max) => misses < max;

// ---------------------------------------------------------------------------
// Fill latency: timed stages per fill, and p50 / p90 over the last fills
// ---------------------------------------------------------------------------

/** The stages of one fill, in order. "ledger" is the moment the keeper saw the ledger that made the fill possible. */
export const FILL_STAGES = ["event", "order", "quote", "sim", "sent", "included"];

/**
 * Times one fill from `t0` (when the keeper saw ledger `ledger` close: the ledger with the new order, or the one in
 * which the price met the limit). Each stage keeps its first mark, in ms after t0.
 */
export class FillTimer {
  constructor(t0, ledger) {
    this.t0 = t0;
    this.ledger = ledger;
    this.marks = {};
    this.includedLedger = null;
  }

  mark(stage, at = Date.now()) {
    if (this.marks[stage] === undefined) this.marks[stage] = Math.max(0, Math.round(at - this.t0));
  }

  /** Ledgers between the trigger ledger and the one the fill was written in (1 = the next ledger, the target). */
  ledgersLater() {
    return this.includedLedger !== null && this.ledger ? this.includedLedger - this.ledger : null;
  }

  /** "fill timing: event+Xms order+..ms quote+Yms sim+Zms sent+Wms included L(N+k)" (stages that did not happen are left out). */
  line() {
    const parts = FILL_STAGES.filter((s) => this.marks[s] !== undefined && s !== "included").map((s) => `${s}+${this.marks[s]}ms`);
    if (this.marks.included !== undefined) parts.push(`included+${this.marks.included}ms`);
    const k = this.ledgersLater();
    parts.push(k !== null ? `L(${this.ledger}+${k})` : "L(?)");
    return `fill timing: ${parts.join(" ")}`;
  }
}

/** Nearest-rank percentile of a list of numbers (p in 0..100); null for an empty list. */
export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * v.length));
  return v[Math.min(rank, v.length) - 1];
}

/** The last `size` fills: total time (trigger ledger seen -> included) and ledgers later; p50 / p90 of each. */
export class FillStats {
  constructor(size = 20) {
    this.size = size;
    this.items = [];
  }

  add(totalMs, ledgers) {
    this.items.push({ totalMs, ledgers });
    if (this.items.length > this.size) this.items.shift();
  }

  summary() {
    const ms = this.items.map((x) => x.totalMs);
    const l = this.items.map((x) => x.ledgers).filter((x) => x !== null && x !== undefined);
    return {
      fills: this.items.length,
      p50_ms: percentile(ms, 50),
      p90_ms: percentile(ms, 90),
      p50_ledgers: percentile(l, 50),
      p90_ledgers: percentile(l, 90),
      next_ledger_share: l.length ? Math.round((100 * l.filter((x) => x <= 1).length) / l.length) : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Reads spread over the RPC servers: the one that answers soonest
// ---------------------------------------------------------------------------

/** Exponentially weighted moving average (e.g. of an RPC server's answer time). */
export class Ewma {
  constructor(alpha = 0.2, initial = null) {
    this.alpha = alpha;
    this.value = initial;
  }

  add(x) {
    this.value = this.value === null ? x : this.value + this.alpha * (x - this.value);
    return this.value;
  }
}

/**
 * The server a read should go to: of the usable ones, the one expected to answer soonest (time waiting for its rate
 * limit + its usual answer time). `servers`: [{ usable, waitMs, latencyMs }] (latencyMs null = not measured yet:
 * counted as `unknownMs`). Ties go to the lower index (the preferred server). -1 if none is usable.
 */
export function pickReadServer(servers, unknownMs = 1000) {
  let best = -1;
  let bestT = Infinity;
  servers.forEach((s, i) => {
    if (!s.usable) return;
    const t = Math.max(0, s.waitMs || 0) + (s.latencyMs ?? unknownMs);
    if (t < bestT) {
      bestT = t;
      best = i;
    }
  });
  return best;
}

// ---------------------------------------------------------------------------
// Horizon ledger stream (server-sent events)
// ---------------------------------------------------------------------------

/**
 * Splits a server-sent-events text buffer into complete events. Returns { events: [{ id, event, data }], rest }
 * (`rest`: an incomplete event to keep for the next chunk). Comment lines (":...") are ignored.
 */
export function parseSse(buffer) {
  const text = buffer.replace(/\r\n/g, "\n");
  const blocks = text.split("\n\n");
  const rest = blocks.pop();
  const events = [];
  for (const b of blocks) {
    const ev = { id: null, event: "message", data: "" };
    let any = false;
    for (const line of b.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (field === "data") ev.data += (ev.data ? "\n" : "") + value;
      else if (field === "id") ev.id = value;
      else if (field === "event") ev.event = value;
      else continue;
      any = true;
    }
    if (any) events.push(ev);
  }
  return { events, rest };
}

/** The ledger sequence in a Horizon /ledgers stream event, or null (Horizon sends "hello" / keep-alive events too). */
export function ledgerFromSse(ev) {
  if (!ev || !ev.data || ev.data === '"hello"' || ev.data === "hello") return null;
  try {
    const j = JSON.parse(ev.data);
    const n = Number(j && j.sequence);
    return Number.isInteger(n) && n > 0 ? { sequence: n, closedAt: j.closed_at ? Date.parse(j.closed_at) : null } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Prepared routes: the shape of the best route for a pair, reused for a fill of a similar size
// ---------------------------------------------------------------------------

/** Cache key of a route shape: the pair and the size class of the fill (powers of two). */
export function shapeKey(tin, tout, fill) {
  const f = BigInt(fill);
  return `${tin}|${tout}|${f > 0n ? f.toString(2).length : 0}`;
}

/** The amounts for `fill` split by the shares (basis points summing to 10000) of a prepared shape; the rest goes to the first part. */
export function scaleShares(sharesBps, fill) {
  const f = BigInt(fill);
  const amounts = sharesBps.map((s) => (f * BigInt(s)) / 10_000n);
  const used = amounts.reduce((a, b) => a + b, 0n);
  if (amounts.length) amounts[0] += f - used;
  return amounts;
}

/** Shares in basis points of each part's amount in a route of `total` (inverse of scaleShares, for the cache). */
export function sharesOf(amounts, total) {
  const t = BigInt(total);
  if (t <= 0n) return amounts.map(() => 0);
  const s = amounts.map((a) => Number((BigInt(a) * 10_000n) / t));
  const used = s.reduce((a, b) => a + b, 0);
  if (s.length) s[0] += 10_000 - used;
  return s;
}

// ---------------------------------------------------------------------------
// Main-loop watchdog
// ---------------------------------------------------------------------------

/**
 * Watches the main loop: `stage(name)` when it moves to another step, `progress()` when work finishes (an RPC answer).
 * `check()` (called every few seconds) reports a stall once per stall when nothing happened for `stallMs`, and then
 * keeps `safe()` true for `safeMs`: the fast paths are off and the keeper runs on plain RPC polling.
 */
export class LoopWatch {
  constructor({ stallMs = 60_000, safeMs = 600_000, now = Date.now } = {}) {
    this.stallMs = stallMs;
    this.safeMs = safeMs;
    this.now = now;
    this.lastAt = now();
    this.stageName = "start";
    this.stalls = 0;
    this.safeUntil = 0;
    this.reported = false;
  }

  stage(name) {
    this.stageName = name;
    this.progress();
  }

  progress() {
    this.lastAt = this.now();
    this.reported = false;
  }

  safe() {
    return this.now() < this.safeUntil;
  }

  /** { stage, stalledMs } once per stall, else null. */
  check() {
    const at = this.now();
    const d = at - this.lastAt;
    if (d < this.stallMs || this.reported) return null;
    this.reported = true;
    this.stalls++;
    this.safeUntil = at + this.safeMs;
    return { stage: this.stageName, stalledMs: d };
  }
}
