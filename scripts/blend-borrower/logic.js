// Pure decision logic of the Blend borrower bot (no network). Amounts are plain numbers in token units
// (1 USDC = 1.0), prices in USD, ratios as fractions (0.6 = 60%).

/** Health factor as Blend computes it: sum(collateral value x c_factor) / sum(liability value / l_factor). */
export function healthFactor(effCollateral, effLiabilities) {
  if (effLiabilities <= 0) return Infinity;
  return effCollateral / effLiabilities;
}

/**
 * Decides what to do in one run.
 * state: {
 *   poolActive: bool,            pool status 0 or 1 (borrowing allowed)
 *   pricesOk: bool,              the oracle answered for every reserve the bot uses
 *   supplied, borrowed,          USDC reserve totals in the pool
 *   usdcPrice, usdcLFactor,      USDC price and its l_factor
 *   collPrice, collCFactor,      collateral (XLM) price and c_factor
 *   effCollateral, effLiabilities  over ALL of the bot's positions (USD)
 *   debt,                        the bot's USDC debt
 *   collateral,                  the bot's XLM collateral
 *   walletUsdc, walletColl       what the bot's account holds
 * }
 * cfg: { utilTarget, utilBand, minHf, targetHf, maxDebt, collateralTarget, collReserve, minAction }
 * Returns { actions: [{ kind: "collateral" | "repay" | "borrow", amount }], notes: [string] }.
 */
export function decide(state, cfg) {
  const actions = [];
  const notes = [];
  const low = cfg.utilTarget - cfg.utilBand;
  const high = cfg.utilTarget + cfg.utilBand;
  const util = state.supplied > 0 ? state.borrowed / state.supplied : 0;
  notes.push(`utilisation ${(util * 100).toFixed(2)}% (band ${(low * 100).toFixed(0)}-${(high * 100).toFixed(0)}%)`);

  if (!state.pricesOk) {
    notes.push("oracle price missing or stale: nothing done (borrowing would fail, and the health factor is unknown)");
    return { actions, notes };
  }

  let effCol = state.effCollateral;
  let effLiab = state.effLiabilities;
  let debt = state.debt;
  let wallet = state.walletUsdc;

  // 1) Keep the collateral topped up from the wallet (minus a reserve for fees).
  const spareColl = state.walletColl - cfg.collReserve;
  const missingColl = cfg.collateralTarget - state.collateral;
  if (missingColl > 0 && spareColl > 0) {
    const add = Math.min(missingColl, spareColl);
    if (add * state.collPrice >= cfg.minAction) {
      actions.push({ kind: "collateral", amount: add });
      effCol += add * state.collPrice * state.collCFactor;
    }
  }

  const hf = healthFactor(effCol, effLiab);
  notes.push(`health factor ${hf === Infinity ? "inf" : hf.toFixed(3)} (min ${cfg.minHf}, target ${cfg.targetHf})`);

  // 2) Health factor too low: repay down to the target health factor.
  if (hf < cfg.minHf) {
    const allowedEffLiab = effCol / cfg.targetHf;
    const repayUsd = (effLiab - allowedEffLiab) * state.usdcLFactor;
    const want = Math.min(debt, repayUsd / state.usdcPrice);
    const amount = Math.min(want, wallet);
    if (amount < want) notes.push(`wallet holds only ${wallet.toFixed(4)} USDC of ${want.toFixed(4)} needed: add XLM or USDC to the bot`);
    if (amount >= cfg.minAction) actions.push({ kind: "repay", amount });
    return { actions, notes };
  }

  // 3) Utilisation above the band: repay towards the target.
  if (util > high && debt > 0) {
    const want = Math.min(debt, state.borrowed - cfg.utilTarget * state.supplied);
    const amount = Math.min(want, wallet);
    if (amount >= cfg.minAction) actions.push({ kind: "repay", amount });
    else notes.push("above the band, but nothing (enough) to repay");
    return { actions, notes };
  }

  // 4) Utilisation below the band: borrow towards the target, limited by the health factor and maxDebt.
  if (util < low) {
    if (!state.poolActive) {
      notes.push("pool not Active: no borrowing");
      return { actions, notes };
    }
    const want = cfg.utilTarget * state.supplied - state.borrowed;
    const byHf = Math.max(0, ((effCol / cfg.targetHf - effLiab) * state.usdcLFactor) / state.usdcPrice);
    const byCap = Math.max(0, cfg.maxDebt - debt);
    const amount = Math.min(want, byHf, byCap);
    if (amount < want) notes.push(`borrow limited to ${amount.toFixed(4)} USDC (health factor or MAX_DEBT)`);
    if (amount >= cfg.minAction) actions.push({ kind: "borrow", amount });
    return { actions, notes };
  }

  notes.push("inside the band: nothing to do");
  return { actions, notes };
}
