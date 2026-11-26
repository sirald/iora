// Pure Blend position math for the Lend view (no DOM, no network), so it can be tested on its own.
// A reserve: { asset, price (number | null), cf, lf, collat, supplyNc, debt, wallet (number | null), cash, room }.

/** Does this reserve hold any position of the user (or would the pending change give it one)? */
const hasPosition = (r, change) => r.collat > 0 || r.supplyNc > 0 || r.debt > 0 || !!(change && change.asset === r.asset && change.amt > 0);

/**
 * Dollar totals and health factor. `incomplete` is true when the data itself is missing (the positions or a
 * reserve could not be read). If a price is missing for a reserve the user has a position in, or anything is
 * incomplete, the totals are not known: `known` is false and the caller must not show a health factor, dollar
 * totals or "No debt", and must not compute a borrow/withdraw Max from them.
 */
export function lpTotals(rs, change, incomplete = false) {
  let col = 0, liab = 0, sup = 0, bor = 0;
  let known = !incomplete;
  for (const r of rs) {
    if (r.price === null || r.price === undefined || !Number.isFinite(r.price)) {
      if (hasPosition(r, change)) known = false;
      continue;
    }
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
  if (!known) return { known, col: NaN, liab: NaN, sup: NaN, bor: NaN, hf: NaN, used: NaN };
  return { known, col, liab, sup, bor, hf: liab > 0 ? col / liab : Infinity, used: col > 0 ? liab / col : liab > 0 ? Infinity : 0 };
}

export const hfText = (h) => (Number.isNaN(h) ? "Unknown" : h === Infinity ? "No debt" : h.toFixed(2));
export const hfClass = (h) => (Number.isNaN(h) ? "warn" : h === Infinity || h >= 1.5 ? "good" : h >= 1.1 ? "warn" : "bad");

/**
 * The most that can be done in `mode` (2 supply, 3 withdraw, 4 borrow, 5 repay).
 * `keep` is left in the wallet (the native XLM fee/reserve margin): it is taken off the wallet budget, never off
 * the debt, so a wallet that covers the debt still repays all of it. `posOk` false (positions unreadable): no Max.
 */
export function lpMax(r, mode, t, { keep = 0, posOk = true } = {}) {
  const budget = Math.max(0, (r.wallet ?? 0) - keep);
  if (mode === 2) return budget;
  if (!posOk) return 0;
  if (mode === 5) return Math.min(r.debt * 1.001 + 1e-7, budget);
  if (!t.known) return 0;
  if (mode === 3) {
    if (t.liab === 0 || !r.price) return Math.min(r.collat, r.cash);
    const spare = (t.col - t.liab * 1.05) / (r.price * r.cf);
    return Math.max(0, Math.min(r.collat, spare, r.cash));
  }
  if (mode === 4) {
    if (!r.price) return 0;
    return Math.max(0, Math.min(((t.col - t.liab) * r.lf * 0.95) / r.price, r.room));
  }
  return 0;
}

/** What the Max button fills in: for borrow/withdraw it stops where the health factor is still `safeHf`. */
export function lpSafeMax(r, mode, t, opts = {}, safeHf = 1.2) {
  const max = lpMax(r, mode, t, opts);
  if ((mode !== 3 && mode !== 4) || !r.price || !t.known) return max;
  if (mode === 4) return Math.max(0, Math.min(max, ((t.col / safeHf - t.liab) * r.lf) / r.price));
  if (t.liab === 0) return max;
  return Math.max(0, Math.min(max, (t.col - t.liab * safeHf) / (r.price * r.cf)));
}
