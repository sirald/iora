import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, fairEnough, fromReserves, minOut, poolPrice, swapToTarget } from "../logic.js";

const Q96 = 2 ** 96;
const sqrtX96For = (usdcPerCoin) => Math.sqrt(1 / usdcPerCoin) * Q96;
const cfg = { threshold: 0.005, maxAge: 900, maxTradeUsd: 300, minTradeUsd: 1, coinReserve: 20, warnUsdc: 100, warnCoinUsd: 100 };
// XLM pool: 3000 USDC + 23,557 XLM full range: L = sqrt(x * y) in raw units
const L = Math.sqrt(3000e7 * 23557e7);
const base = {
  coin: "XLM", sqrtPriceX96: sqrtX96For(0.1274), liquidity: L, feeBps: 30, coinUsd: 0.1274, usdcUsd: 1, priceAge: 60,
  walletUsdc: 500, walletCoin: 4000,
};
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);

test("pool price from sqrt_price_x96", () => {
  near(poolPrice(sqrtX96For(0.1274)), 0.1274);
  // the live XLM pool right after creation (tick 20609): 0.12735 USDC per XLM
  near(poolPrice(222017009681545656796281878530n), 0.12735, 1e-3);
});

test("a v2 pair's reserves give the same price and liquidity", () => {
  // 1500 USDC + 0.025 iBTC -> 60,000 USDC per iBTC
  const r = fromReserves(1500e7, 0.025e7);
  near(poolPrice(r.sqrtPriceX96), 60000);
  near(r.liquidity, Math.sqrt(1500e7 * 0.025e7));
  assert.equal(fromReserves(0, 5).liquidity, 0);
});

test("swap to target follows the constant-product invariant", () => {
  const x = 3000, y = 23557, k = x * y; // USDC, XLM
  const s0 = Math.sqrt(y / x) * Q96;
  const w = swapToTarget(s0, L, 0.12); // cheaper coin: coin in
  assert.equal(w.sell, "COIN");
  near(w.netIn, Math.sqrt(k / 0.12) - y);
  const w2 = swapToTarget(s0, L, 0.14); // dearer coin: USDC in
  assert.equal(w2.sell, "USDC");
  near(w2.netIn, Math.sqrt(k * 0.14) - x);
  assert.equal(swapToTarget(s0, 0, 0.12), null);
});

test("same on a v2 pair: iBTC 2% too cheap -> USDC in up to sqrt(k * ref) - x", () => {
  const x = 1500, y = 0.025, ref = 60000 * 1.02;
  const r = fromReserves(x * 1e7, y * 1e7);
  const w = swapToTarget(r.sqrtPriceX96, r.liquidity, ref);
  assert.equal(w.sell, "USDC");
  near(w.netIn, Math.sqrt(x * y * ref) - x);
});

test("inside the threshold: no action", () => {
  const r = decide({ ...base, sqrtPriceX96: sqrtX96For(0.1274 * 1.004) }, cfg);
  assert.equal(r.action, null);
  near(r.deviation, 0.004);
});

test("pool too expensive: sells the coin, gross of the fee", () => {
  const sp = sqrtX96For(0.1274 * 1.01);
  const r = decide({ ...base, sqrtPriceX96: sp }, cfg);
  assert.equal(r.action.sell, "COIN");
  near(r.action.amountIn, swapToTarget(sp, L, 0.1274).netIn / 0.997);
});

test("pool too cheap: buys the coin with USDC", () => {
  const r = decide({ ...base, sqrtPriceX96: sqrtX96For(0.1274 * 0.99) }, cfg);
  assert.equal(r.action.sell, "USDC");
  assert.ok(r.action.amountIn > 10 && r.action.amountIn < 20, String(r.action.amountIn));
});

test("reference uses USDC's own USD price", () => {
  // XLM 0.1274 USD, USDC 1.01 USD -> 0.126139 USDC per XLM; a pool at 0.1274 is 1% too expensive
  const r = decide({ ...base, usdcUsd: 1.01 }, cfg);
  near(r.refPrice, 0.1274 / 1.01);
  assert.equal(r.action.sell, "COIN");
});

test("stale or missing price, or an empty pool: nothing done", () => {
  const far = { ...base, sqrtPriceX96: sqrtX96For(0.2) };
  assert.equal(decide({ ...far, priceAge: 901 }, cfg).action, null);
  assert.equal(decide({ ...far, priceAge: undefined }, cfg).action, null);
  assert.equal(decide({ ...far, coinUsd: null }, cfg).action, null);
  assert.equal(decide({ ...far, usdcUsd: 0 }, cfg).action, null);
  assert.equal(decide({ ...far, liquidity: 0 }, cfg).action, null);
});

test("MAX_TRADE_USD caps the trade", () => {
  const r = decide({ ...base, sqrtPriceX96: sqrtX96For(0.2) }, cfg);
  assert.equal(r.action.sell, "COIN");
  near(r.action.amountIn, 300 / 0.1274);
  assert.ok(r.notes.some((n) => n.includes("MAX_TRADE_USD")));
});

test("inventory limits the trade and warns; nothing left: no action", () => {
  let r = decide({ ...base, sqrtPriceX96: sqrtX96For(0.1274 * 1.02), walletCoin: 120 }, cfg);
  near(r.action.amountIn, 100); // 120 - 20 reserve
  assert.ok(r.warnings.some((w) => w.includes("inventory short")));
  assert.ok(r.warnings.some((w) => w.includes("inventory low") && w.includes("XLM"))); // 120 XLM = 15 USD
  r = decide({ ...base, sqrtPriceX96: sqrtX96For(0.1274 * 0.98), walletUsdc: 0.5 }, cfg);
  assert.equal(r.action, null);
  assert.ok(r.warnings.some((w) => w.includes("USDC")));
});

test("a coin without a reserve can be sold down to zero", () => {
  const r = decide({ ...base, coin: "iSOL", sqrtPriceX96: sqrtX96For(0.1274 * 1.02), walletCoin: 50 }, { ...cfg, coinReserve: 0 });
  near(r.action.amountIn, 50);
});

test("tiny trade below MIN_TRADE_USD: nothing done", () => {
  const r = decide({ ...base, sqrtPriceX96: sqrtX96For(0.1274 * 1.006), liquidity: L / 100 }, cfg);
  assert.equal(r.action, null);
  assert.ok(r.notes.some((n) => n.includes("MIN_TRADE_USD")));
});

test("fair price check", () => {
  const sell = { sell: "COIN", amountIn: 100 }; // at 0.1274: 12.74 USDC, less 0.3% fee = 12.70178
  assert.ok(fairEnough(sell, 12.72, 0.1274, 30, 0.002));
  assert.ok(!fairEnough(sell, 12.6, 0.1274, 30, 0.002));
  const buy = { sell: "USDC", amountIn: 10 }; // 78.49 XLM, less fee 78.26
  assert.ok(fairEnough(buy, 78.3, 0.1274, 30, 0.002));
  assert.ok(!fairEnough(buy, 77, 0.1274, 30, 0.002));
});

test("minimum output", () => {
  assert.equal(minOut(1000000n, 0.01), 990000n);
});
