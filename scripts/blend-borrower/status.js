// Status file of the Blend borrower bot: one small JSON file written at the end of every run, success or failure,
// for the bots check (scripts/monitor/check-bots.js). No network here.
//
// Where: STATUS_FILE, else $STATE_DIRECTORY/status.json. systemd sets STATE_DIRECTORY from the unit's
// StateDirectory= (iora-blend-borrower: /var/lib/iora/borrower, iora-blend-borrower-multi: /var/lib/iora/borrower-multi).
// A run by hand (neither set) and a dry run write nothing.
// Writing it never fails a run and never changes what the bot borrows or repays: every error ends as one WARN line.
//
// The numbers: the health factor (after this run's requests, estimated from what was read; hfRead is the one read at
// the start of the step), the effective collateral and liabilities (USD, weighted by c_factor / l_factor as Blend
// does), the USDC step's utilisation, debt and collateral, and per other coin its utilisation, target, supply APR,
// debt, supply and collateral. hf is null when the bot owes nothing, or when a price was missing (pricesOk false).
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { supplyApr, targetUtil } from "./multi.js";

// ---- the same helpers as scripts/price-bot/status.js ----

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

// ---- the borrower's numbers ----

const finite = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const hfOf = (effCollateral, effLiabilities) => (finite(effLiabilities) > 0 && finite(effCollateral) !== null ? effCollateral / effLiabilities : null);

/** Numbers to 8 significant digits, NaN / Infinity to null, all the way down. */
export function tidy(v) {
  if (typeof v === "number") return Number.isFinite(v) ? Number(v.toPrecision(8)) : null;
  if (Array.isArray(v)) return v.map(tidy);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tidy(x)]));
  return v;
}

/** The USDC step's part. state: what decide() got; actions: what it returned; cfg: utilTarget, utilBand. */
export function usdcRecord(state, actions, cfg) {
  const known = !!state.pricesOk;
  const hf = known ? hfOf(state.effCollateral, state.effLiabilities) : null;
  return {
    pricesOk: known,
    hfRead: hf,
    hf,
    collateralUsd: known ? state.effCollateral : null,
    liabilitiesUsd: known ? state.effLiabilities : null,
    usdc: {
      supplied: state.supplied,
      borrowed: state.borrowed,
      util: state.supplied > 0 ? state.borrowed / state.supplied : 0,
      band: [cfg.utilTarget - cfg.utilBand, cfg.utilTarget + cfg.utilBand],
      debt: state.debt,
      collateralXlm: state.collateral,
      walletUsdc: state.walletUsdc,
      walletXlm: state.walletColl,
      priceUsdc: state.usdcPrice ?? null,
      priceXlm: state.collPrice ?? null,
      actions: actions.map((a) => `${a.kind} ${a.amount.toFixed(4)}`),
    },
  };
}

/** After the USDC step's submit went through: the effective totals and the health factor it leads to (estimate). */
export function usdcAfter(state, actions) {
  let c = state.effCollateral;
  let l = state.effLiabilities;
  for (const a of actions) {
    if (a.kind === "collateral") c += a.amount * state.collPrice * state.collCFactor;
    else if (a.kind === "borrow") l += (a.amount * state.usdcPrice) / state.usdcLFactor;
    else if (a.kind === "repay") l = Math.max(0, l - (a.amount * state.usdcPrice) / state.usdcLFactor);
  }
  return { hf: hfOf(c, l), collateralUsd: c, liabilitiesUsd: l };
}

/** The other coins' part. state: what decideMulti() got; targets: targets.json coins; requests: what it returned. */
export function multiRecord(state, targets, requests, cfg) {
  const coins = {};
  for (const [k, s] of Object.entries(state.coins ?? {})) {
    if (!s.active) {
      coins[k] = { active: false, wallet: s.wallet };
      continue;
    }
    const u = s.supplied > 0 ? s.borrowed / s.supplied : 0;
    const t = targets?.[k];
    coins[k] = {
      active: true,
      price: s.price ?? null,
      util: u,
      targetUtil: t && s.curve ? targetUtil(s.curve, s.irMod, t, state.bstopRate, cfg.overshoot) : null,
      supplyApr: s.curve ? supplyApr(s.curve, u, s.irMod, state.bstopRate) : null,
      targetApr: t?.supplyApr ?? null,
      irMod: s.irMod,
      debt: s.ownDebt,
      supply: s.ownSupply,
      collateral: s.ownCollateral,
      wallet: s.wallet,
      debtUsd: s.price > 0 ? s.ownDebt * s.price : null,
    };
  }
  const known = !!state.pricesOk;
  const hf = known ? hfOf(state.effCollateral, state.effLiabilities) : null;
  return {
    pricesOk: known,
    hfRead: hf,
    hf,
    collateralUsd: known ? state.effCollateral : null,
    liabilitiesUsd: known ? state.effLiabilities : null,
    coins,
    multiActions: requests.map((q) => `${q.kind} ${q.amount.toPrecision(8)} ${q.coin}`),
  };
}

/** After the other coins' submit went through: the effective totals and the health factor it leads to (estimate). */
export function multiAfter(state, requests) {
  let c = state.effCollateral;
  let l = state.effLiabilities;
  for (const q of requests) {
    const s = state.coins?.[q.coin];
    if (!s || !(s.price > 0) || !s.curve) continue;
    const usd = q.amount * s.price;
    if (q.kind === "collateral") c += usd * s.curve.c_factor;
    else if (q.kind === "borrow") l += usd / s.curve.l_factor;
    else if (q.kind === "repay") l = Math.max(0, l - usd / s.curve.l_factor);
    // "supply" (lender supply) is not collateral: no change
  }
  return { hf: hfOf(c, l), collateralUsd: c, liabilitiesUsd: l };
}

/**
 * The status of one run.
 * prev: the previous status (readStatus), or null.
 * run: { startedAt (ms), address, pool, steps: { usdc, multi }, warnings, submitted: [tx hash], and what
 *        usdcRecord / usdcAfter / multiRecord / multiAfter returned (the later step overwrites hf and the totals) }
 * opts: { ok, error, now }
 */
export function borrowerStatus(prev, run, { ok, error = null, now = Date.now() } = {}) {
  const at = new Date(now).toISOString();
  const s = { bot: "blend-borrower", at, ok: !!ok };
  if (!ok) s.error = scrub(error ?? "the run failed");
  const out = {
    ...s,
    ...runInfo(prev, !!ok, at),
    durationSec: finite(run.startedAt) === null ? null : Math.round((now - run.startedAt) / 1000),
    address: run.address ?? null,
    pool: run.pool ?? null,
    steps: run.steps ?? null,
    warnings: [...(run.warnings ?? [])].map((w) => scrub(w, 300)),
    pricesOk: typeof run.pricesOk === "boolean" ? run.pricesOk : null,
    hf: tidy(finite(run.hf)),
    hfRead: tidy(finite(run.hfRead)),
    collateralUsd: tidy(finite(run.collateralUsd)),
    liabilitiesUsd: tidy(finite(run.liabilitiesUsd)),
    submitted: [...(run.submitted ?? [])],
  };
  if (run.usdc) out.usdc = tidy(run.usdc);
  if (run.coins) out.coins = tidy(run.coins);
  if (run.multiActions) out.multiActions = run.multiActions;
  return out;
}
