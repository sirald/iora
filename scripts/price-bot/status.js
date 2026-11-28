// Status file of the price bot: one small JSON file written at the end of every run, success or failure, for the
// bots check (scripts/monitor/check-bots.js). No network here.
//
// Where: STATUS_FILE, else $STATE_DIRECTORY/status.json. systemd sets STATE_DIRECTORY from the unit's
// StateDirectory=iora/price-bot, so the file is /var/lib/iora/price-bot/status.json. A run by hand (neither set) and
// a dry run write nothing.
// Writing it never fails a run and never changes what the bot trades: every error ends as one WARN line.
//
// Besides this run's numbers, the file keeps the deviations of the last HISTORY runs, so that the check can tell a
// pool that stays off the reference for several runs from one bad run. Each history entry:
//   { at, ok, dev: { POOL: deviation after the run (pool / reference - 1) | "skipped" (no fresh price or no
//     liquidity) | "error" } }
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export const HISTORY = 10;

/** The status file's path, or null when nothing should be written. */
export function statusPath(env) {
  if (env.STATUS_FILE) return env.STATUS_FILE;
  const dir = String(env.STATE_DIRECTORY ?? "").split(":")[0]; // systemd lists several directories with ":"
  return dir ? join(dir, "status.json") : null;
}

/** The previous status, or null when there is none or it cannot be read. */
export function readStatus(file) {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    return s && typeof s === "object" && !Array.isArray(s) ? s : null;
  } catch {
    return null;
  }
}

/** What is carried from run to run: the last good run and how many runs in a row failed since. */
export function runInfo(prev, ok, at) {
  if (ok) return { lastOkAt: at, failsInRow: 0, failingSince: null };
  const before = Number.isInteger(prev?.failsInRow) && prev.failsInRow > 0 ? prev.failsInRow : 0;
  return {
    lastOkAt: typeof prev?.lastOkAt === "string" ? prev.lastOkAt : null,
    failsInRow: before + 1,
    failingSince: before > 0 && typeof prev?.failingSince === "string" ? prev.failingSince : at,
  };
}

/** A text for the file: never a secret key, and not too long. */
export function scrub(text, max = 400) {
  const s = String(text ?? "").replace(/S[A-Z2-7]{55}/g, "S***");
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

/** Writes `data` as JSON atomically (temporary file, fsync, rename). Never throws; false when it failed. */
export function writeStatus(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  let fd = null;
  try {
    fd = openSync(tmp, "w", 0o644);
    writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, file);
    return true;
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
    try {
      unlinkSync(tmp);
    } catch {}
    console.error(new Date().toISOString(), "WARN", `status file ${file} not written: ${e?.message ?? e}`);
    return false;
  }
}

const finite = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const round = (x, d) => (finite(x) === null ? null : Number(x.toFixed(d)));
const sig = (x, n) => (finite(x) === null ? null : Number(x.toPrecision(n)));

/**
 * The status of one run.
 * prev: the previous status (readStatus), or null.
 * run: {
 *   startedAt,                          ms
 *   address,                            the bot's account
 *   checked,                            true once the run went through the pools (a run that failed before does not
 *                                       add a history entry)
 *   pools: { NAME: { dev, poolPrice, refPrice, action, error?, tx? } }
 *       dev: deviation after the run (after a swap: measured again), NaN / null when unknown;
 *       action: "none" (inside the threshold or below MIN_TRADE_USD), "swap", "refused" (the fair-price check
 *       stopped it), "skipped" (no fresh price or no liquidity), "error"
 *   inventory: { NAME: { amount, usd } }   USDC and each coin, usd null when there is no price
 *   warnings,                           Set or array of the run's WARN lines
 * }
 * opts: { ok, error, now }
 */
export function priceBotStatus(prev, run, { ok, error = null, now = Date.now() } = {}) {
  const at = new Date(now).toISOString();
  const pools = {};
  const dev = {};
  for (const [name, p] of Object.entries(run.pools ?? {})) {
    const d = round(p.dev, 6);
    const action = p.action ?? (d === null ? "skipped" : "none");
    pools[name] = { dev: d, pool: sig(p.poolPrice, 10), reference: sig(p.refPrice, 10), action };
    if (p.tx) pools[name].tx = p.tx;
    if (p.error) pools[name].error = scrub(p.error, 200);
    dev[name] = action === "error" ? "error" : (d ?? "skipped");
  }
  let history = Array.isArray(prev?.history) ? prev.history.filter((h) => h && typeof h === "object" && h.dev) : [];
  if (run.checked) history = [...history, { at, ok: !!ok, dev }];
  history = history.slice(-HISTORY);

  const inventory = {};
  let usd = 0;
  for (const [name, v] of Object.entries(run.inventory ?? {})) {
    inventory[name] = { amount: round(v.amount, 7), usd: round(v.usd, 2) };
    usd += finite(v.usd) ?? 0;
  }
  const s = { bot: "price-bot", at, ok: !!ok };
  if (!ok) s.error = scrub(error ?? "the run failed");
  return {
    ...s,
    ...runInfo(prev, !!ok, at),
    durationSec: finite(run.startedAt) === null ? null : Math.round((now - run.startedAt) / 1000),
    address: run.address ?? null,
    warnings: [...(run.warnings ?? [])].map((w) => scrub(w, 300)),
    pools,
    inventory,
    inventoryUsd: round(usd, 2),
    history,
  };
}
