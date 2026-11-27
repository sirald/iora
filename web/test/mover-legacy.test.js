import { test } from "node:test";
import assert from "node:assert/strict";
import { BAND_DEFAULT, ROUNDING_BUFFER, SAFETY, planOrderVaultMove, planOrderVaultMoves } from "../src/mover.js";

// Real testnet tokens: XLM, Blend's old mock USDC, Circle's test USDC
const XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const MOCK = "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const ME = "GALJTDLCNLPSEXRKGRC2ZLY7WYZISOSNUOBVXSU2FX5X3D5DMWZ3HUWT";
const now = 1_795_800_000;
const ex = (left = 5_000n * 10_000_000n) => ({ mock: MOCK, usdc: USDC, left });
const sellCfg = { owner: ME, usdc: XLM, xlm: MOCK }; // old sell vault: holds XLM, its orders buy (mock) USDC
const buyCfg = { owner: ME, usdc: MOCK, xlm: XLM }; // old buy vault: holds mock USDC, its orders buy XLM
// An order as get_order returns it (G4 field set; G1 has no trigger_price / stop_band_bps)
const ord = (o = {}) => ({ amount_in: 300_000_000n, filled_in: 0n, limit_price: 10_000_000n, min_fill: 15_000_000n, max_impact_bps: 100, expiry: BigInt(now + 7 * 86400), status: ["Open"], ...o });

test("old sell vault (G4, as the testnet trial): place_order in the new vault, same price, output kept", () => {
  // tx 39a34ea1…: 100 XLM, one order 30 XLM at limit 1.0, 7 days
  const p = planOrderVaultMove({ cfg: sellCfg, amount: 1_000_000_000n, orders: [{ id: 0, order: ord(), followUp: null }], exchange: ex(), now });
  assert.equal(p.convert, true, "the order buys mock USDC, so it becomes Circle USDC");
  assert.equal(p.sell, XLM);
  assert.equal(p.buy, USDC);
  assert.deepEqual(p.cancel, [0]);
  assert.equal(p.place.length, 1);
  const [c] = p.place;
  assert.equal(c.func, "place_order");
  assert.deepEqual(c.args, [["addr", XLM], ["addr", USDC], ["i128", 300_000_000n], ["i128", 10_000_000n], ["i128", 15_000_000n], ["u32", 100], ["u64", BigInt(now + 7 * 86400)], ["bool", true]]);
  assert.equal(p.mockLeftInWallet, 0n);
});

test("units: limits, triggers and follow-up limits are passed through unchanged", () => {
  const orders = [
    { id: 0, order: ord({ limit_price: 1_234_567n }), followUp: { limit_price: 8_100_000n, max_impact_bps: 50, duration: 86400n } },
    { id: 1, order: ord({ trigger_price: 1_150_000n, limit_price: 1_100_000n, stop_band_bps: 300 }), followUp: null },
    { id: 2, order: ord({ trigger_price: 1_150_000n, limit_price: 1_100_000n }), followUp: null }, // G2: no band field
  ];
  const p = planOrderVaultMove({ cfg: buyCfg, amount: 2_000_000_000n, orders, exchange: ex(), now });
  const [then, stop, stopG2] = p.place;
  assert.equal(then.func, "place_order_then");
  assert.deepEqual(then.args.slice(0, 4), [["addr", USDC], ["addr", XLM], ["i128", 300_000_000n], ["i128", 1_234_567n]]);
  assert.deepEqual(then.args.slice(7), [["i128", 8_100_000n], ["u32", 50], ["u64", 86400n]]);
  assert.equal(stop.func, "place_stop_order");
  assert.deepEqual(stop.args.slice(3, 5), [["i128", 1_150_000n], ["i128", 1_100_000n]]);
  assert.deepEqual(stop.args[8], ["u32", 300]);
  assert.deepEqual(stopG2.args[8], ["u32", BAND_DEFAULT], "an old stop without a band gets 2%");
  assert.equal(BAND_DEFAULT, 200);
});

test("what is placed never exceeds what arrives; filled, expiring and closed orders", () => {
  const orders = [
    { id: 0, order: ord({ amount_in: 600_000_000n, filled_in: 200_000_000n }), followUp: null }, // 40 left
    { id: 1, order: ord({ expiry: BigInt(now + 60) }), followUp: null }, // ends on the way: cancelled only
    { id: 2, order: ord({ status: ["Filled"] }), followUp: null }, // not open: untouched
    { id: 3, order: ord(), followUp: null }, // 30 wanted, only what is left of the room
  ];
  const amount = 500_000_000n; // 50
  const p = planOrderVaultMove({ cfg: sellCfg, amount, orders, exchange: null, now });
  assert.deepEqual(p.cancel, [0, 1, 3]);
  assert.equal(p.convert, false);
  assert.equal(p.buy, MOCK, "without the exchange the coin stays as it is");
  assert.equal(p.place[0].amount, 400_000_000n);
  assert.equal(p.place[1].amount, amount - ROUNDING_BUFFER - SAFETY - 400_000_000n);
  assert.deepEqual(p.skipped, [{ id: 1, why: "it expires within two minutes" }]);
  // min_fill: never more than 20 pieces
  const small = planOrderVaultMove({ cfg: sellCfg, amount, orders: [{ id: 0, order: ord({ min_fill: 1n }), followUp: null }], now });
  assert.equal(small.place[0].args[4][1], 15_000_000n); // 300_000_000 / 20
});

test("without orders: every open order is cancelled, none placed; the amount is the balance", () => {
  const p = planOrderVaultMove({ cfg: sellCfg, amount: 11_914_400_000n, orders: [{ id: 0, order: ord(), followUp: null }], now, withOrders: false });
  assert.deepEqual(p.cancel, [0]);
  assert.deepEqual(p.place, []);
  assert.equal(p.amount, 11_914_400_000n);
});

test("old buy vault of mock USDC: exchanged up to the allowance, the rest stays in the wallet", () => {
  const p = planOrderVaultMove({ cfg: buyCfg, amount: 70_000_000_000n, orders: [{ id: 0, order: ord({ amount_in: 69_000_000_000n }), followUp: null }], exchange: ex(50_000_000_000n), now });
  assert.equal(p.sell, USDC);
  assert.equal(p.mockLeftInWallet, 20_000_000_000n);
  assert.equal(p.place[0].amount, 50_000_000_000n - ROUNDING_BUFFER - SAFETY, "orders only reserve what arrives");
});

test("two old vaults of one wallet: two calls, the exchange allowance is shared", () => {
  const vaults = [
    { id: "CBUY", cfg: buyCfg, amount: 30_000_000_000n, orders: [] },
    { id: "COLDERBUY", cfg: buyCfg, amount: 30_000_000_000n, orders: [] },
    { id: "CSELL", cfg: sellCfg, amount: 1_000_000_000n, orders: [{ id: 0, order: ord(), followUp: null }] },
  ];
  const plans = planOrderVaultMoves(vaults, { exchange: ex(50_000_000_000n), now });
  assert.deepEqual(plans.map((p) => p.id), ["CBUY", "COLDERBUY", "CSELL"]);
  assert.equal(plans[0].mockLeftInWallet, 0n);
  assert.equal(plans[1].mockLeftInWallet, 10_000_000_000n, "the second buy vault gets what is left of 5,000");
  assert.equal(plans[2].place[0].buy, USDC);
  assert.equal(plans[2].mockLeftInWallet, 0n, "a sell vault uses none of the allowance");
});
