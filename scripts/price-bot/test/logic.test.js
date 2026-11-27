import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, fairEnough, minOut, poolPrice, swapToTarget } from "../logic.js";

const Q96 = 2 ** 96;
const sqrtX96For = (usdcPerXlm) => Math.sqrt(1 / usdcPerXlm) * Q96;
const cfg = { threshold: 0.005, maxAge: 900, maxTradeUsd: 300, minTradeUsd: 1, xlmReserve: 20, warnUsdc: 100, warnXlm: 800 };
// 3000 USDC + 23,557 XLM full range: L = sqrt(x * y) in raw units
const L = Math.sqrt(3000e7 * 23557e7);
const base = {
  sqrtPriceX96: sqrtX96For(0.1274), liquidity: L, feeBps: 30, xlmUsd: 0.1274, usdcUsd: 1, priceAge: 60,
  walletUsdc: 500, walletXlm: 4000,
};
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);

test("pool price from sqrt_price_x96", () => {
  near(poolPrice(sqrtX96For(0.1274)), 0.1274);
  // the live pool right after creation (tick 20609): 0.12735 USDC per XLM
  near(poolPrice(222017009681545656796281878530n), 0.12735, 1e-3);
});

test("swap to target follows the constant-product invariant", () => {
  const x = 3000, y = 23557, k = x * y; // USDC, XLM
  const s0 = Math.sqrt(y / x) * Q96;
  const w = swapToTarget(s0, L, 0.12); // cheaper XLM: XLM in
  assert.equal(w.sell, "XLM");
  near(w.netIn, Math.sqrt(k / 0.12) - y);
  const w2 = swapToTarget(s0, L, 0.14); // dearer XLM: USDC in
  assert.equal(w2.sell, "USDC");
  near(w2.netIn, Math.sqrt(k * 0.14) - x);
  assert.equal(swapToTarget(s0, 0, 0.12), null);
});

test("inside the threshold: no action", () => {
  const r = decide({ ...base, sqrtPriceX96: sqrtX96For(0.1274 * 1.004) }, cfg);
  assert.equal(r.action, null);
  near(r.deviation, 0.004);
});

test("pool too expensive: sells XLM, gross of the fee", () => {
  const sp = sqrtX96For(0.1274 * 1.01);
  const r = decide({ ...base, sqrtPriceX96: sp }, cfg);
  assert.equal(r.action.sell, "XLM");
  assert.equal(r.action.buy, "USDC");
  near(r.action.amountIn, swapToTarget(sp, L, 0.1274).netIn / 0.997);
});

test("pool too cheap: buys XLM with USDC", () => {
  const r = decide({ ...base, sqrtPriceX96: sqrtX96For(0.1274 * 0.99) }, cfg);
  assert.equal(r.action.sell, "USDC");
  assert.ok(r.action.amountIn > 10 && r.action.amountIn < 20, String(r.action.amountIn));
});

test("reference uses USDC's own USD price", () => {
  // XLM 0.1274 USD, USDC 1.01 USD -> 0.126139 USDC per XLM; a pool at 0.1274 is 1% too expensive
  const r = decide({ ...base, usdcUsd: 1.01 }, cfg);
  near(r.refPrice, 0.1274 / 1.01);
  assert.equal(r.action.sell, "XLM");
});

test("stale or missing price, or an empty pool: nothing done", () => {
  const far = { ...base, sqrtPriceX96: sqrtX96For(0.2) };
  assert.equal(decide({ ...far, priceAge: 901 }, cfg).action, null);
  assert.equal(decide({ ...far, priceAge: undefined }, cfg).action, null);
  assert.equal(decide({ ...far, xlmUsd: null }, cfg).action, null);
  assert.equal(decide({ ...far, usdcUsd: 0 }, cfg).action, null);
  assert.equal(decide({ ...far, liquidity: 0 }, cfg).action, null);
});

test("MAX_TRADE_USD caps the trade", () => {
  const r = decide({ ...base, sqrtPriceX96: sqrtX96For(0.2) }, cfg);
  assert.equal(r.action.sell, "XLM");
  near(r.action.amountIn, 300 / 0.1274);
  assert.ok(r.notes.some((n) => n.includes("MAX_TRADE_USD")));
});

test("inventory limits the trade and warns; nothing left: no action", () => {
  let r = decide({ ...base, sqrtPriceX96: sqrtX96For(0.1274 * 1.02), walletXlm: 120 }, cfg);
  near(r.action.amountIn, 100); // 120 - 20 reserve
  assert.ok(r.warnings.some((w) => w.includes("inventory short")));
  assert.ok(r.warnings.some((w) => w.includes("inventory low") && w.includes("XLM")));
  r = decide({ ...base, sqrtPriceX96: sqrtX96For(0.1274 * 0.98), walletUsdc: 0.5 }, cfg);
  assert.equal(r.action, null);
  assert.ok(r.warnings.some((w) => w.includes("USDC")));
});

test("tiny trade below MIN_TRADE_USD: nothing done", () => {
  const r = decide({ ...base, sqrtPriceX96: sqrtX96For(0.1274 * 1.006), liquidity: L / 100 }, cfg);
  assert.equal(r.action, null);
  assert.ok(r.notes.some((n) => n.includes("MIN_TRADE_USD")));
});

test("fair price check", () => {
  const sell = { sell: "XLM", amountIn: 100 }; // at 0.1274: 12.74 USDC, less 0.3% fee = 12.70178
  assert.ok(fairEnough(sell, 12.72, 0.1274, 30, 0.002));
  assert.ok(!fairEnough(sell, 12.6, 0.1274, 30, 0.002));
  const buy = { sell: "USDC", amountIn: 10 }; // 78.49 XLM, less fee 78.26
  assert.ok(fairEnough(buy, 78.3, 0.1274, 30, 0.002));
  assert.ok(!fairEnough(buy, 77, 0.1274, 30, 0.002));
});

test("minimum output", () => {
  assert.equal(minOut(1000000n, 0.01), 990000n);
});
