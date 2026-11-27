// Pure logic for the coins beyond USDC (no network): XLM and Iora's coins iBTC, iETH, iSOL, iAVAX, iXRP.
// Amounts are plain numbers in token units, prices in USD, rates and ratios as fractions (0.06 = 6%).
//
// Why a target supply APR and not a target utilisation: Blend v2 (pool/src/pool/interest.rs, calc_accrual)
// multiplies the curve by ir_mod and moves ir_mod by (u - util) * dt * reactivity on every accrual, bounded to
// [0.1, 10]. Holding u below the curve's `util` drifts ir_mod to 0.1, holding it above drifts it to 10. A fixed
// utilisation therefore gives no fixed rate. Instead the bot solves, each run, for the utilisation that pays the
// coin's target supply APR at the current ir_mod, capped at util + overshoot. That settles either at u = util with
// the ir_mod that pays the target, or (for tiny targets) at the 0.1 floor with u below util.
// Numbers behind the targets: side-session note faiz-hedefleri.md.

const R7 = 1e7;

/** Borrow APR of a reserve at utilisation u (Blend v2 curve). c: ReserveConfig fields as fractions. */
export function borrowApr(c, u, irMod) {
  if (u <= c.util) return (c.r_base + (c.util > 0 ? (c.r_one * u) / c.util : 0)) * irMod;
  if (u <= 0.95) return (c.r_base + c.r_one + (c.r_two * (u - c.util)) / (0.95 - c.util)) * irMod;
  return (c.r_base + c.r_one + c.r_two) * irMod + (c.r_three * (u - 0.95)) / 0.05;
}

/** Supply APR: borrow APR x utilisation x (1 - backstop take rate). */
export function supplyApr(c, u, irMod, bstopRate) {
  return borrowApr(c, u, irMod) * u * (1 - bstopRate);
}

/** ReserveConfig as returned by the pool (7-decimal integers) -> fractions. */
export function curveOf(config) {
  const f = (k) => Number(config[k]) / R7;
  return {
    util: f("util"), max_util: f("max_util"), r_base: f("r_base"), r_one: f("r_one"), r_two: f("r_two"),
    r_three: f("r_three"), c_factor: f("c_factor"), l_factor: f("l_factor"), reactivity: Number(config.reactivity),
  };
}

/**
 * The utilisation that pays `target.supplyApr` at the current ir_mod, in [0, cap], cap = min(util + overshoot,
 * max_util - 0.02), and never above the utilisation where the borrow APR would exceed `target.maxBorrowApr`.
 */
export function targetUtil(c, irMod, target, bstopRate, overshoot) {
  let cap = Math.min(c.util + overshoot, c.max_util - 0.02);
  if (target.maxBorrowApr > 0) {
    let lo = 0, hi = cap;
    if (borrowApr(c, hi, irMod) > target.maxBorrowApr) {
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (borrowApr(c, mid, irMod) > target.maxBorrowApr) hi = mid;
        else lo = mid;
      }
      cap = lo;
    }
  }
  if (!(cap > 0)) return 0;
  if (supplyApr(c, cap, irMod, bstopRate) <= target.supplyApr) return cap;
  let lo = 0, hi = cap;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (supplyApr(c, mid, irMod, bstopRate) < target.supplyApr) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * Decides one run for the extra coins.
 * state: {
 *   poolActive,                  pool status 0 or 1 (borrowing allowed)
 *   bstopRate,                   backstop take rate (0.1)
 *   effCollateral, effLiabilities  over ALL of the bot's positions (USD), after the USDC step
 *   coins: { NAME: { active, price (USD, null = missing/stale), curve (curveOf), irMod, supplied, borrowed,
 *                    ownSupply, ownCollateral, ownDebt, wallet } }   (pool totals and the bot's own, token units)
 *   pricesOk                     every coin the bot has a position in has a price
 * }
 * targets: { NAME: { supplyApr, maxBorrowApr, maxDebtUsd, supplyUsd, band } }
 * cfg: { minHf, targetHf, minActionUsd, overshoot, collateral: { coin, targetUsd }, reserve: { NAME: units kept } }
 * Returns { requests: [{ coin, kind: "supply" | "collateral" | "borrow" | "repay", amount }], notes }.
 */
export function decideMulti(state, targets, cfg) {
  const requests = [];
  const notes = [];
  if (!state.pricesOk) {
    notes.push("multi: an oracle price of a coin the bot holds a position in is missing or stale: nothing done");
    return { requests, notes };
  }
  let effCol = state.effCollateral;
  let effLiab = state.effLiabilities;
  const wallet = Object.fromEntries(Object.entries(state.coins).map(([k, v]) => [k, Math.max(0, v.wallet - (cfg.reserve?.[k] ?? 0))]));
  const usd = (k, x) => x * state.coins[k].price;

  // 1) Collateral: keep cfg.collateral.targetUsd of the collateral coin posted (topped up from the wallet).
  const cc = cfg.collateral?.coin;
  const cs = cc && state.coins[cc];
  if (cs && cs.active && cs.price > 0 && cfg.collateral.targetUsd > 0) {
    const missing = cfg.collateral.targetUsd / cs.price - cs.ownCollateral;
    const add = Math.min(missing, wallet[cc]);
    if (add > 0 && usd(cc, add) >= cfg.minActionUsd) {
      requests.push({ coin: cc, kind: "collateral", amount: add });
      wallet[cc] -= add;
      effCol += usd(cc, add) * cs.curve.c_factor;
    } else if (missing > 0 && usd(cc, missing) >= cfg.minActionUsd) {
      notes.push(`multi: collateral ${cc} short by ${missing.toPrecision(6)} and the wallet has ${wallet[cc].toPrecision(6)}: mint more (fund-bot.sh)`);
    }
  } else if (cc) {
    notes.push(`multi: collateral coin ${cc} is not an active reserve with a price yet: no new collateral`);
  }

  // 2) Health factor too low: repay the extra coins (largest effective liability first) down to the target HF.
  const hf = effLiab > 0 ? effCol / effLiab : Infinity;
  notes.push(`multi: health factor ${hf === Infinity ? "inf" : hf.toFixed(3)} (min ${cfg.minHf}, target ${cfg.targetHf})`);
  if (hf < cfg.minHf) {
    const byLiab = Object.keys(targets)
      .filter((k) => state.coins[k]?.ownDebt > 0 && state.coins[k].price > 0)
      .sort((a, b) => usd(b, state.coins[b].ownDebt) / state.coins[b].curve.l_factor - usd(a, state.coins[a].ownDebt) / state.coins[a].curve.l_factor);
    for (const k of byLiab) {
      const excess = effLiab - effCol / cfg.targetHf;
      if (excess <= 0) break;
      const s = state.coins[k];
      const amount = Math.min(s.ownDebt, wallet[k], (excess * s.curve.l_factor) / s.price);
      if (amount > 0 && usd(k, amount) >= cfg.minActionUsd) {
        requests.push({ coin: k, kind: "repay", amount });
        wallet[k] -= amount;
        effLiab -= (usd(k, amount)) / s.curve.l_factor;
      }
    }
    if (effLiab > effCol / cfg.targetHf) notes.push("multi: wallet balances are not enough to restore the target health factor: add collateral (fund-bot.sh)");
    return { requests, notes };
  }

  // 3) Each coin: lender supply, then borrow / repay towards the utilisation that pays the target supply APR.
  for (const [k, t] of Object.entries(targets)) {
    const s = state.coins[k];
    if (!s || !s.active) {
      notes.push(`multi: ${k} is not an active reserve of the pool yet: skipped`);
      continue;
    }
    if (!(s.price > 0)) {
      notes.push(`multi: ${k} has no fresh oracle price: skipped`);
      continue;
    }
    let supplied = s.supplied;
    let borrowed = s.borrowed;
    const wantSup = (t.supplyUsd ?? 0) / s.price - s.ownSupply;
    if (wantSup > 0) {
      const add = Math.min(wantSup, wallet[k]);
      if (add > 0 && usd(k, add) >= cfg.minActionUsd) {
        requests.push({ coin: k, kind: "supply", amount: add });
        wallet[k] -= add;
        supplied += add;
      }
    }
    if (!(supplied > 0)) {
      notes.push(`multi: ${k}: nothing supplied in the pool: nothing to borrow`);
      continue;
    }
    const u = borrowed / supplied;
    const ut = targetUtil(s.curve, s.irMod, t, state.bstopRate, cfg.overshoot);
    const band = t.band ?? 0.02;
    notes.push(
      `multi: ${k}: util ${(u * 100).toFixed(2)}% -> target ${(ut * 100).toFixed(2)}% (supply APR now ` +
        `${(supplyApr(s.curve, u, s.irMod, state.bstopRate) * 100).toFixed(4)}%, target ${(t.supplyApr * 100).toFixed(4)}%, ir_mod ${s.irMod.toFixed(4)})`,
    );
    if (Math.abs(u - ut) <= band) continue;
    const delta = ut * supplied - borrowed;
    if (delta > 0) {
      if (!state.poolActive) {
        notes.push(`multi: ${k}: pool not Active: no borrowing`);
        continue;
      }
      const byCap = Math.max(0, (t.maxDebtUsd ?? Infinity) / s.price - s.ownDebt);
      const byHf = Math.max(0, ((effCol / cfg.targetHf - effLiab) * s.curve.l_factor) / s.price);
      const byMaxUtil = Math.max(0, (s.curve.max_util - 0.01) * supplied - borrowed);
      const amount = Math.min(delta, byCap, byHf, byMaxUtil);
      if (amount < delta) notes.push(`multi: ${k}: borrow limited to ${amount.toPrecision(6)} (MAX_DEBT_USD, health factor or max_util)`);
      if (usd(k, amount) >= cfg.minActionUsd) {
        requests.push({ coin: k, kind: "borrow", amount });
        effLiab += usd(k, amount) / s.curve.l_factor;
      }
    } else {
      const amount = Math.min(-delta, s.ownDebt, wallet[k]);
      if (usd(k, amount) >= cfg.minActionUsd) {
        requests.push({ coin: k, kind: "repay", amount });
        wallet[k] -= amount;
        effLiab -= usd(k, amount) / s.curve.l_factor;
      } else if (s.ownDebt > 0) notes.push(`multi: ${k}: above the target, but nothing (enough) of the bot's own debt or wallet to repay`);
    }
  }
  return { requests, notes };
}
