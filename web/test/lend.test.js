import { test } from "node:test";
import assert from "node:assert/strict";
import { hfClass, hfText, lpMax, lpSafeMax, lpTotals } from "../src/lend.js";

const res = (o) => ({ asset: "A", price: 1, cf: 0.8, lf: 1, collat: 0, supplyNc: 0, debt: 0, wallet: 0, cash: 1e9, room: 1e9, ...o });

test("IORA-02: a debt whose price is missing makes the totals unknown, never 'No debt'", () => {
  const rs = [res({ asset: "COL", collat: 200 }), res({ asset: "DEBT", price: null, debt: 100 })];
  const t = lpTotals(rs);
  assert.equal(t.known, false);
  assert.ok(Number.isNaN(t.hf) && Number.isNaN(t.bor));
  assert.equal(hfText(t.hf), "Unknown");
  assert.notEqual(hfClass(t.hf), "good");
});

test("IORA-02: a missing price for a reserve without a position does not matter", () => {
  const t = lpTotals([res({ asset: "COL", collat: 200 }), res({ asset: "X", price: null })]);
  assert.equal(t.known, true);
  assert.equal(t.hf, Infinity);
  assert.equal(hfText(t.hf), "No debt");
});

test("IORA-02: incomplete data (positions or a reserve unreadable) is unknown", () => {
  const t = lpTotals([res({ collat: 200 })], undefined, true);
  assert.equal(t.known, false);
  assert.equal(hfText(t.hf), "Unknown");
});

test("IORA-02: complete data gives the normal estimate", () => {
  const t = lpTotals([res({ asset: "COL", collat: 200 }), res({ asset: "DEBT", debt: 100 })]);
  assert.equal(t.known, true);
  assert.equal(t.hf, 1.6);
  assert.equal(t.bor, 100);
});

test("IORA-02: no borrow/withdraw Max on unknown totals", () => {
  const rs = [res({ asset: "COL", collat: 200 }), res({ asset: "DEBT", price: null, debt: 100 })];
  const t = lpTotals(rs);
  assert.equal(lpSafeMax(rs[0], 4, t), 0);
  assert.equal(lpSafeMax(rs[0], 3, t), 0);
  // repaying only lowers the debt: still allowed, it needs no price
  assert.ok(lpSafeMax({ ...rs[1], wallet: 500 }, 5, t) > 100);
});

test("IORA-02: no Max for repay/withdraw when positions could not be read", () => {
  const r = res({ debt: 0, wallet: 50 });
  const t = lpTotals([r], undefined, true);
  assert.equal(lpMax(r, 5, t, { posOk: false }), 0);
  assert.equal(lpMax(r, 2, t, { posOk: false }), 50); // supplying is fine
});

test("IORA-08: XLM repay Max repays the whole debt when the wallet covers it", () => {
  for (const debt of [50, 1]) {
    const r = res({ asset: "XLM", debt, wallet: 1000 });
    const m = lpSafeMax(r, 5, lpTotals([r]), { keep: 2 });
    assert.ok(m >= debt, `debt ${debt}: Max ${m} must cover the debt`);
    assert.ok(m <= debt * 1.001 + 1e-7 + 1e-12);
  }
});

test("IORA-08: a wallet-limited XLM repay keeps the fee reserve", () => {
  const r = res({ asset: "XLM", debt: 50, wallet: 30 });
  assert.equal(lpSafeMax(r, 5, lpTotals([r]), { keep: 2 }), 28);
  const poor = res({ asset: "XLM", debt: 50, wallet: 1.5 });
  assert.equal(lpSafeMax(poor, 5, lpTotals([poor]), { keep: 2 }), 0);
});

test("IORA-08: XLM supply Max is the wallet minus the reserve", () => {
  const r = res({ asset: "XLM", wallet: 1000 });
  assert.equal(lpSafeMax(r, 2, lpTotals([r]), { keep: 2 }), 998);
});

test("borrow Max stops at health factor 1.2", () => {
  const rs = [res({ asset: "COL", collat: 240 }), res({ asset: "B" })];
  const m = lpSafeMax(rs[1], 4, lpTotals(rs));
  const after = lpTotals(rs, { asset: "B", mode: 4, amt: m });
  assert.ok(Math.abs(after.hf - 1.2) < 1e-9);
});
