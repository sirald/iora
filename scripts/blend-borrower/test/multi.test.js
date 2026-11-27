import { test } from "node:test";
import assert from "node:assert/strict";
import { borrowApr, curveOf, decideMulti, supplyApr, targetUtil } from "../multi.js";

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);
const cfg7 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === "reactivity" ? v : Math.round(v * 1e7)]));
// The queued iCOIN curves (scripts/blend-rates.sh) and the XLM curve of 2026-12-04
const BTC = curveOf(cfg7({ c_factor: 0.8, l_factor: 0.8, util: 0.45, max_util: 0.8, r_base: 0.01, r_one: 0.04, r_two: 0.3, r_three: 5, reactivity: 20 }));
const SOL = curveOf(cfg7({ c_factor: 0.65, l_factor: 0.65, util: 0.4, max_util: 0.7, r_base: 0.01, r_one: 0.05, r_two: 0.3, r_three: 5, reactivity: 20 }));
const XLM = curveOf(cfg7({ c_factor: 0.75, l_factor: 0.75, util: 0.3, max_util: 0.7, r_base: 0.03, r_one: 0.08, r_two: 0.3, r_three: 5, reactivity: 50 }));

test("Blend v2 curve", () => {
  near(borrowApr(BTC, 0.45, 1), 0.05);
  near(borrowApr(BTC, 0.225, 1), 0.03);
  near(borrowApr(BTC, 0.45, 0.1), 0.005);
  near(borrowApr(BTC, 0.7, 1), 0.05 + 0.3 * 0.25 / 0.5);
  near(supplyApr(BTC, 0.45, 1, 0.1), 0.05 * 0.45 * 0.9);
});

test("target utilisation: at util with the right ir_mod, below util at the ir_mod floor", () => {
  // iSOL 2%: at ir_mod 0.926 the curve's util (40%) pays exactly 2%
  near(targetUtil(SOL, 0.92593, { supplyApr: 0.02 }, 0.1, 0.02), 0.4, 1e-3);
  // with ir_mod 1 a little less is enough
  const u1 = targetUtil(SOL, 1, { supplyApr: 0.02 }, 0.1, 0.02);
  assert.ok(u1 < 0.4 && u1 > 0.37, String(u1));
  near(supplyApr(SOL, u1, 1, 0.1), 0.02, 1e-6);
  // iBTC 0.01% at the floor: ~6.9%
  near(targetUtil(BTC, 0.1, { supplyApr: 0.0001 }, 0.1, 0.02), 0.069, 0.02);
  // XLM 0.01% at the floor: ~2.9%
  near(targetUtil(XLM, 0.1, { supplyApr: 0.0001 }, 0.1, 0.02), 0.029, 0.03);
});

test("target utilisation: capped at util + overshoot when ir_mod is too low", () => {
  // iETH-like 3% target at ir_mod 0.2 is out of reach: cap 47%, which then raises ir_mod
  near(targetUtil(BTC, 0.2, { supplyApr: 0.03 }, 0.1, 0.02), 0.47);
  // a larger overshoot lets r_two work: 3% is reached at ~74%; never above max_util - 2%
  const u = targetUtil(BTC, 0.2, { supplyApr: 0.03 }, 0.1, 0.5);
  near(supplyApr(BTC, u, 0.2, 0.1), 0.03, 1e-6);
  near(targetUtil(BTC, 0.2, { supplyApr: 0.2 }, 0.1, 0.5), 0.78);
});

test("target utilisation: maxBorrowApr keeps the borrow rate realistic", () => {
  const u = targetUtil(BTC, 1, { supplyApr: 0.03, maxBorrowApr: 0.03 }, 0.1, 0.02);
  near(u, 0.225, 1e-4); // 1% + 4% * u/45% = 3%
});

const coin = (o) => ({ active: true, price: 1, irMod: 1, supplied: 0, borrowed: 0, ownSupply: 0, ownCollateral: 0, ownDebt: 0, wallet: 0, ...o });
const base = () => ({
  poolActive: true, bstopRate: 0.1, pricesOk: true, effCollateral: 0, effLiabilities: 0,
  coins: {
    iBTC: coin({ price: 60000, curve: BTC, irMod: 0.1, supplied: 0.05, wallet: 0.3 }),
    iSOL: coin({ price: 72, curve: SOL, supplied: 30, wallet: 10 }),
    XLM: coin({ price: 0.127, curve: XLM, irMod: 0.1, supplied: 135000, borrowed: 3400, wallet: 500 }),
  },
});
const targets = { iBTC: { supplyApr: 0.0001, maxDebtUsd: 2000, supplyUsd: 3000 }, iSOL: { supplyApr: 0.02, maxDebtUsd: 2000, supplyUsd: 2000 }, XLM: { supplyApr: 0.0001, maxDebtUsd: 1000 } };
const cfg = { minHf: 1.5, targetHf: 2.0, minActionUsd: 1, overshoot: 0.02, collateral: { coin: "iBTC", targetUsd: 12000 }, reserve: { XLM: 50 } };

test("collateral first, lender supply, then borrow to the target utilisation", () => {
  const r = decideMulti(base(), targets, cfg);
  const by = (c, k) => r.requests.find((q) => q.coin === c && q.kind === k);
  near(by("iBTC", "collateral").amount, 0.2); // 12000 USD / 60000
  near(by("iBTC", "supply").amount, 0.05 - 0); // up to 3000 USD = 0.05, wallet 0.1 left after collateral
  // iBTC: supplied 0.05 + 0.05 = 0.1, target ~6.9% -> ~0.0069 borrowed
  const b = by("iBTC", "borrow").amount;
  assert.ok(b > 0.006 && b < 0.0075, String(b));
  // iSOL: 30 + 10 wallet (supplyUsd 2000 = 27.8 iSOL wanted, wallet 10) -> 40 supplied, target ~38.4%
  near(by("iSOL", "supply").amount, 10);
  const s = by("iSOL", "borrow").amount;
  assert.ok(s > 14.5 && s < 16, String(s));
  // XLM: 3400 / 135000 = 2.5%, target ~2.9% (inside the 2% band): nothing
  assert.equal(by("XLM", "borrow"), undefined);
});

test("inactive reserves are skipped (iCOINs before 2026-12-04)", () => {
  const st = base();
  for (const k of ["iBTC", "iSOL"]) st.coins[k].active = false;
  const r = decideMulti(st, targets, cfg);
  assert.equal(r.requests.length, 0);
  assert.ok(r.notes.some((n) => n.includes("iBTC is not an active reserve")));
  assert.ok(r.notes.some((n) => n.includes("collateral coin iBTC is not an active reserve")));
});

test("borrows are limited by the target health factor, MAX_DEBT_USD and max_util", () => {
  const st = base();
  st.coins.iBTC.wallet = 0; // no collateral to add
  st.effCollateral = 1000;
  st.effLiabilities = 480; // HF 2.08: room for 20 USD of effective liabilities
  const r = decideMulti(st, { iSOL: targets.iSOL }, { ...cfg, collateral: { coin: "iBTC", targetUsd: 0 } });
  const b = r.requests.find((q) => q.kind === "borrow");
  near(b.amount, (20 * 0.65) / 72, 1e-6);
  const st2 = base();
  st2.effCollateral = 1e9;
  const r2 = decideMulti(st2, { iSOL: { ...targets.iSOL, maxDebtUsd: 360 } }, cfg);
  near(r2.requests.find((q) => q.coin === "iSOL" && q.kind === "borrow").amount, 5);
});

test("above the target: repays from the wallet", () => {
  const st = base();
  st.coins.iSOL = coin({ price: 72, curve: SOL, supplied: 100, borrowed: 60, ownDebt: 60, wallet: 25 });
  st.effCollateral = 1e9;
  const r = decideMulti(st, { iSOL: { supplyApr: 0.02 } }, cfg);
  // target ~38.4% of 100 -> repay ~21.6 (the wallet's 25 is enough)
  const rp = r.requests.find((q) => q.kind === "repay").amount;
  near(rp, 60 - 100 * targetUtil(SOL, 1, { supplyApr: 0.02 }, 0.1, 0.02));
  // limited by the wallet
  st.coins.iSOL.wallet = 5;
  near(decideMulti(st, { iSOL: { supplyApr: 0.02 } }, cfg).requests.find((q) => q.kind === "repay").amount, 5);
});

test("low health factor: repays and borrows nothing", () => {
  const st = base();
  st.coins.iSOL = coin({ price: 72, curve: SOL, supplied: 100, borrowed: 20, ownDebt: 20, wallet: 20 });
  st.coins.iBTC.wallet = 0;
  st.effCollateral = 1300;
  st.effLiabilities = 1000; // HF 1.3
  const r = decideMulti(st, targets, { ...cfg, collateral: { coin: "iBTC", targetUsd: 0 } });
  assert.ok(r.requests.every((q) => q.kind === "repay"));
  const rp = r.requests.find((q) => q.coin === "iSOL");
  near(rp.amount, ((1000 - 650) * 0.65) / 72); // down to HF 2: eff liab 650
});

test("missing price of a held coin: nothing at all", () => {
  const r = decideMulti({ ...base(), pricesOk: false }, targets, cfg);
  assert.equal(r.requests.length, 0);
});

test("XLM keeps its fee reserve", () => {
  const st = base();
  st.coins.XLM = coin({ price: 0.127, curve: XLM, irMod: 0.1, supplied: 135000, borrowed: 9000, ownDebt: 9000, wallet: 60 });
  st.effCollateral = 1e9;
  const r = decideMulti(st, { XLM: targets.XLM }, cfg);
  near(r.requests.find((q) => q.kind === "repay").amount, 10); // 60 - 50 reserve
});
