import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, healthFactor } from "../logic.js";

const cfg = {
  utilTarget: 0.6, utilBand: 0.1, minHf: 1.5, targetHf: 2.0, maxDebt: 1000,
  collateralTarget: 2000, collReserve: 50, minAction: 0.5,
};
// 2000 XLM at 0.125 USD, c_factor 0.75 -> 187.5 USD effective collateral
const base = {
  poolActive: true, pricesOk: true, supplied: 100, borrowed: 20, usdcPrice: 1, usdcLFactor: 0.95,
  collPrice: 0.125, collCFactor: 0.75, effCollateral: 187.5, effLiabilities: 0, debt: 0, collateral: 2000,
  walletUsdc: 0, walletColl: 60,
};
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("health factor", () => {
  assert.equal(healthFactor(10, 0), Infinity);
  near(healthFactor(150, 100), 1.5);
});

test("below the band: borrows up to the target", () => {
  const r = decide(base, cfg);
  assert.deepEqual(r.actions.map((a) => a.kind), ["borrow"]);
  near(r.actions[0].amount, 40); // 60% of 100 - 20
});

test("borrow is limited by the target health factor and MAX_DEBT", () => {
  // eff. collateral 50 -> may hold eff. liabilities 25 -> 23.75 USDC
  let r = decide({ ...base, effCollateral: 50 }, cfg);
  near(r.actions[0].amount, 23.75);
  r = decide(base, { ...cfg, maxDebt: 10 });
  near(r.actions[0].amount, 10);
  r = decide({ ...base, debt: 1000 }, { ...cfg, maxDebt: 1000 });
  assert.equal(r.actions.length, 0);
});

test("inside the band: nothing", () => {
  assert.equal(decide({ ...base, borrowed: 60, debt: 40, effLiabilities: 42.1 }, cfg).actions.length, 0);
});

test("above the band: repays towards the target, limited by the wallet", () => {
  const s = { ...base, borrowed: 80, debt: 40, effLiabilities: 40 / 0.95, walletUsdc: 40 };
  let r = decide(s, cfg);
  assert.deepEqual(r.actions.map((a) => a.kind), ["repay"]);
  near(r.actions[0].amount, 20);
  r = decide({ ...s, walletUsdc: 5 }, cfg);
  near(r.actions[0].amount, 5);
  r = decide({ ...s, walletUsdc: 0 }, cfg);
  assert.equal(r.actions.length, 0);
});

test("low health factor: repays down to the target health factor", () => {
  // eff. collateral 187.5, debt 130 USDC -> eff. liab 136.84 -> HF 1.37 < 1.5
  const s = { ...base, borrowed: 60, debt: 130, effLiabilities: 130 / 0.95, walletUsdc: 200 };
  const r = decide(s, cfg);
  assert.deepEqual(r.actions.map((a) => a.kind), ["repay"]);
  // allowed eff. liab = 93.75 -> allowed debt 89.0625 -> repay 40.9375
  near(r.actions[0].amount, 130 - 93.75 * 0.95);
});

test("tops up collateral from the wallet, keeping the reserve", () => {
  const r = decide({ ...base, collateral: 1000, effCollateral: 93.75, walletColl: 550 }, cfg);
  assert.equal(r.actions[0].kind, "collateral");
  near(r.actions[0].amount, 500);
  assert.equal(r.actions[1].kind, "borrow");
});

test("stale prices or inactive pool: no borrowing", () => {
  assert.equal(decide({ ...base, pricesOk: false }, cfg).actions.length, 0);
  assert.equal(decide({ ...base, poolActive: false }, cfg).actions.length, 0);
});

test("a repay the wallet cannot cover is a warning for the bots check (and still a note)", () => {
  // HF 1.37 < 1.5, wants ~40.9 USDC back, the wallet holds 10
  const r = decide({ ...base, borrowed: 60, debt: 130, effLiabilities: 130 / 0.95, walletUsdc: 10 }, cfg);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /^wallet holds only 10\.0000 USDC of 40\.9375 needed: add XLM or USDC to the bot$/);
  assert.ok(r.notes.includes(r.warnings[0]));
  assert.deepEqual(r.actions.map((a) => a.kind), ["repay"]);
  assert.deepEqual(decide(base, cfg).warnings, []);
});
