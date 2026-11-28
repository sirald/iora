import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide } from "../logic.js";
import { curveOf, decideMulti, supplyApr, targetUtil } from "../multi.js";
import {
  borrowerStatus, multiAfter, multiRecord, readStatus, runInfo, statusPath, tidy, usdcAfter, usdcRecord, writeStatus,
} from "../status.js";

const T0 = Date.parse("2026-11-28T10:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);

// The USDC step, as in logic.test.js: 2000 XLM at 0.125 USD, c_factor 0.75 -> 187.5 USD effective collateral
const cfg = { utilTarget: 0.6, utilBand: 0.1, minHf: 1.5, targetHf: 2.0, maxDebt: 1000, collateralTarget: 2000, collReserve: 50, minAction: 0.5 };
const usdcState = {
  poolActive: true, pricesOk: true, supplied: 100, borrowed: 20, usdcPrice: 1, usdcLFactor: 0.95,
  collPrice: 0.125, collCFactor: 0.75, effCollateral: 187.5, effLiabilities: 0, debt: 0, collateral: 2000,
  walletUsdc: 0, walletColl: 60,
};

test("status path and run info: the same rules as the price bot's", () => {
  assert.equal(statusPath({ STATE_DIRECTORY: "/var/lib/iora/borrower-multi" }), join("/var/lib/iora/borrower-multi", "status.json"));
  assert.equal(statusPath({ STATUS_FILE: "/tmp/s.json" }), "/tmp/s.json");
  assert.equal(statusPath({}), null);
  const f1 = runInfo({ lastOkAt: "a", failsInRow: 0 }, false, "b");
  assert.deepEqual(f1, { lastOkAt: "a", failsInRow: 1, failingSince: "b" });
  assert.deepEqual(runInfo(f1, false, "c"), { lastOkAt: "a", failsInRow: 2, failingSince: "b" });
});

test("write: atomic and never throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "iora-bb-status-"));
  const was = console.error;
  console.error = () => {};
  try {
    const file = join(dir, "status.json");
    assert.equal(writeStatus(file, { hf: 2 }), true);
    assert.deepEqual(readStatus(file), { hf: 2 });
    assert.deepEqual(readdirSync(dir), ["status.json"]);
    assert.equal(writeStatus(join(dir, "no", "status.json"), { hf: 2 }), false);
  } finally {
    console.error = was;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("USDC step: utilisation, health factor, debt and collateral", () => {
  const debt = { ...usdcState, borrowed: 60, debt: 40, effLiabilities: 40 / 0.95 };
  const r = usdcRecord(debt, [], cfg);
  near(r.hf, 187.5 / (40 / 0.95));
  assert.equal(r.hfRead, r.hf);
  near(r.usdc.util, 0.6);
  assert.deepEqual(r.usdc.band.map((x) => Number(x.toFixed(6))), [0.5, 0.7]);
  assert.equal(r.usdc.debt, 40);
  assert.equal(r.usdc.collateralXlm, 2000);
  assert.equal(r.liabilitiesUsd, 40 / 0.95);
  // no debt: no health factor (Blend's infinity)
  assert.equal(usdcRecord(usdcState, [], cfg).hf, null);
  // a missing price: unknown, not a number made with price 0
  const unknown = usdcRecord({ ...debt, pricesOk: false }, [], cfg);
  assert.equal(unknown.hf, null);
  assert.equal(unknown.pricesOk, false);
  assert.equal(unknown.collateralUsd, null);
});

test("USDC step: the health factor after the submit follows the actions", () => {
  // below the band: borrows 40 -> eff. liabilities 40 / 0.95
  const { actions } = decide(usdcState, cfg);
  assert.deepEqual(actions.map((a) => a.kind), ["borrow"]);
  const after = usdcAfter(usdcState, actions);
  near(after.liabilitiesUsd, 40 / 0.95);
  near(after.hf, 187.5 / (40 / 0.95));
  // low HF: repays down to the target health factor (2.0)
  const low = { ...usdcState, borrowed: 60, debt: 130, effLiabilities: 130 / 0.95, walletUsdc: 200 };
  const r = decide(low, cfg);
  near(usdcAfter(low, r.actions).hf, 2.0, 1e-9);
  // collateral added from the wallet counts at c_factor
  const top = usdcAfter({ ...usdcState, effLiabilities: 50 }, [{ kind: "collateral", amount: 400 }]);
  near(top.collateralUsd, 187.5 + 400 * 0.125 * 0.75);
  // a repay larger than the debt does not go below zero
  assert.equal(usdcAfter({ ...usdcState, effLiabilities: 5 }, [{ kind: "repay", amount: 100 }]).hf, null);
  // the record keeps the actions as text
  assert.deepEqual(usdcRecord(usdcState, actions, cfg).usdc.actions, ["borrow 40.0000"]);
});

// The other coins, as in multi.test.js
const cfg7 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === "reactivity" ? v : Math.round(v * 1e7)]));
const BTC = curveOf(cfg7({ c_factor: 0.8, l_factor: 0.8, util: 0.45, max_util: 0.8, r_base: 0.01, r_one: 0.04, r_two: 0.3, r_three: 5, reactivity: 20 }));
const SOL = curveOf(cfg7({ c_factor: 0.65, l_factor: 0.65, util: 0.4, max_util: 0.7, r_base: 0.01, r_one: 0.05, r_two: 0.3, r_three: 5, reactivity: 20 }));
const coin = (o) => ({ active: true, price: 1, irMod: 1, supplied: 0, borrowed: 0, ownSupply: 0, ownCollateral: 0, ownDebt: 0, wallet: 0, ...o });
const multiState = () => ({
  poolActive: true, bstopRate: 0.1, pricesOk: true, effCollateral: 16000, effLiabilities: 2000,
  coins: {
    iBTC: coin({ price: 60000, curve: BTC, irMod: 0.1, supplied: 0.4, borrowed: 0.02, ownCollateral: 0.333, ownSupply: 0.05, wallet: 0.1 }),
    iSOL: coin({ price: 72, curve: SOL, supplied: 40, borrowed: 16, ownDebt: 16, ownSupply: 40, wallet: 10 }),
    iETH: { active: false, price: null, wallet: 2 },
  },
});
const targets = { iBTC: { supplyApr: 0.0001, maxDebtUsd: 1000 }, iSOL: { supplyApr: 0.02, maxDebtUsd: 1500 }, iETH: { supplyApr: 0.01, maxDebtUsd: 1500 } };
const mcfg = { minHf: 1.5, targetHf: 2.0, minActionUsd: 1, overshoot: 0.02, collateral: { coin: "iBTC", targetUsd: 20000 }, reserve: {} };

test("other coins: per coin utilisation, target, supply APR and debt", () => {
  const st = multiState();
  const r = multiRecord(st, targets, [], { overshoot: 0.02 });
  near(r.hf, 8);
  near(r.coins.iSOL.util, 0.4);
  near(r.coins.iSOL.targetUtil, targetUtil(SOL, 1, targets.iSOL, 0.1, 0.02));
  near(r.coins.iSOL.supplyApr, supplyApr(SOL, 0.4, 1, 0.1));
  assert.equal(r.coins.iSOL.targetApr, 0.02);
  near(r.coins.iSOL.debtUsd, 16 * 72);
  assert.equal(r.coins.iBTC.collateral, 0.333);
  assert.deepEqual(r.coins.iETH, { active: false, wallet: 2 });
  assert.equal(multiRecord({ ...st, pricesOk: false }, targets, [], { overshoot: 0.02 }).hf, null);
});

test("other coins: the health factor after the submit follows the requests", () => {
  const st = multiState();
  const { requests } = decideMulti(st, targets, mcfg);
  assert.ok(requests.length > 0);
  let c = st.effCollateral;
  let l = st.effLiabilities;
  for (const q of requests) {
    const s = st.coins[q.coin];
    if (q.kind === "collateral") c += q.amount * s.price * s.curve.c_factor;
    if (q.kind === "borrow") l += (q.amount * s.price) / s.curve.l_factor;
    if (q.kind === "repay") l -= (q.amount * s.price) / s.curve.l_factor;
  }
  const after = multiAfter(st, requests);
  near(after.collateralUsd, c);
  near(after.liabilitiesUsd, l);
  near(after.hf, c / l);
  // lender supply is not collateral
  assert.equal(multiAfter(st, [{ coin: "iSOL", kind: "supply", amount: 100 }]).hf, 8);
  assert.deepEqual(multiRecord(st, targets, [{ coin: "iSOL", kind: "borrow", amount: 1.5 }], mcfg).multiActions, ["borrow 1.5000000 iSOL"]);
});

test("status of a run: shape, no NaN or Infinity, error only when it failed", () => {
  const run = {
    startedAt: T0 - 3000, address: "GBORROWER", pool: "CPOOL", steps: { usdc: true, multi: false },
    warnings: ["wallet holds only 1.0000 USDC of 5.0000 needed: add XLM or USDC to the bot"], submitted: ["hash1"],
    ...usdcRecord({ ...usdcState, borrowed: 60, debt: 40, effLiabilities: 40 / 0.95 }, [], cfg),
  };
  const s = borrowerStatus(null, run, { ok: true, now: T0 });
  assert.equal(s.bot, "blend-borrower");
  assert.equal(s.at, iso(T0));
  assert.equal(s.ok, true);
  assert.equal("error" in s, false);
  assert.equal(s.lastOkAt, iso(T0));
  assert.equal(s.durationSec, 3);
  assert.equal(s.hf, Number((187.5 / (40 / 0.95)).toPrecision(8)));
  assert.equal(s.usdc.util, 0.6);
  assert.deepEqual(s.submitted, ["hash1"]);
  assert.equal(s.warnings.length, 1);
  const bad = borrowerStatus(s, { ...run, hf: Infinity, collateralUsd: NaN }, { ok: false, error: `x S${"C".repeat(55)}`, now: T0 + 600000 });
  assert.equal(bad.hf, null);
  assert.equal(bad.collateralUsd, null);
  assert.equal(bad.error, "x S***");
  assert.equal(bad.failsInRow, 1);
  assert.equal(bad.lastOkAt, iso(T0));
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(bad)));
  assert.deepEqual(tidy({ a: [1 / 3, NaN], b: { c: Infinity, d: "x" } }), { a: [0.33333333, null], b: { c: null, d: "x" } });
});
