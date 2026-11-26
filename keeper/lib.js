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
