import { test } from "node:test";
import assert from "node:assert/strict";
import { StrKey } from "@stellar/stellar-sdk";
import { EXPIRY_MARGIN, minFillFor, planMove, sortCoins, splitPlan } from "../src/mover.js";

const MOCK = "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const now = 1_800_000_000;
const FAR = 18446744073709551615n;
const ex = { mock: MOCK, usdc: USDC, left: 5000n * 10_000_000n };
const order = (o = {}) => ({ status: ["Open"], sell: MOCK, buy: XLM, amount_in: 100_0000000n, filled_in: 0n, limit_price: 1_2000000n, min_fill: 5_0000000n, max_impact_bps: 300, trigger_price: 0n, stop_band_bps: 0, expiry: FAR, keep: true, ...o });

test("plain order: mock USDC becomes Circle USDC, same price, place_order args in order", () => {
  const p = planMove({ balances: { [MOCK]: 200_0000000n }, orders: [{ id: 3, order: order() }], exchange: ex, now });
  assert.deepEqual(p.coins, [[MOCK, 200_0000000n]]);
  assert.deepEqual(p.cancel, [3]);
  assert.equal(p.place.length, 1);
  const c = p.place[0];
  assert.equal(c.func, "place_order");
  assert.deepEqual(c.args, [["addr", USDC], ["addr", XLM], ["i128", 100_0000000n], ["i128", 1_2000000n], ["i128", 5_0000000n], ["u32", 300], ["u64", FAR], ["bool", true]]);
});

test("order kinds: DCA > follow-up > stop > plain", () => {
  const orders = [
    { id: 0, order: order(), schedule: { part: 10_0000000n, fills: 5, done: 2, every: 3600n } },
    { id: 1, order: order({ trigger_price: 9n }), followUp: { limit_price: 2_0000000n, max_impact_bps: 200, duration: 86400n } },
    { id: 2, order: order({ trigger_price: 1_0000000n, stop_band_bps: 150 }) },
  ];
  const p = planMove({ balances: { [MOCK]: 1000_0000000n }, orders, exchange: ex, now });
  assert.deepEqual(p.place.map((x) => x.func), ["place_dca", "place_order_then", "place_stop_order"]);
  assert.deepEqual(p.place[0].args.slice(2, 5), [["i128", 10_0000000n], ["u32", 3], ["u64", 3600n]]);
  assert.deepEqual(p.place[1].args.slice(7), [["i128", 2_0000000n], ["u32", 200], ["u64", 86400n]]);
  assert.deepEqual(p.place[2].args.slice(3, 4), [["i128", 1_0000000n]]);
  assert.deepEqual(p.place[2].args.slice(8), [["u32", 150], ["bool", true]]);
});

test("a finished DCA plan and an order about to expire are only cancelled", () => {
  const orders = [
    { id: 0, order: order(), schedule: { part: 1n, fills: 3, done: 3, every: 60n } },
    { id: 1, order: order({ expiry: BigInt(now + EXPIRY_MARGIN) }) },
    { id: 2, order: order({ expiry: BigInt(now + EXPIRY_MARGIN + 1) }) },
    { id: 3, order: order({ status: ["Filled"] }) },
  ];
  const p = planMove({ balances: { [MOCK]: 1000_0000000n }, orders, exchange: ex, now });
  assert.deepEqual(p.cancel, [0, 1, 2]);
  assert.deepEqual(p.place.map((x) => x.id), [2]);
  assert.deepEqual(p.skipped.map((x) => x.id), [0, 1]);
});

test("orders on one coin are trimmed to what arrives (minus Blend's buffer); an empty one is skipped", () => {
  const orders = [{ id: 0, order: order({ amount_in: 60_0000000n }) }, { id: 1, order: order({ amount_in: 60_0000000n }) }, { id: 2, order: order() }];
  const p = planMove({ balances: { [MOCK]: 100_0000000n }, orders, exchange: ex, now });
  const arrive = 100_0000000n - 10_000n - 10n;
  assert.equal(p.place[0].amount, 60_0000000n);
  assert.equal(p.place[1].amount, arrive - 60_0000000n);
  assert.deepEqual(p.skipped.map((x) => x.id), [2]);
});

test("the exchange cap: only `left` mock arrives, the rest stays in the wallet", () => {
  const p = planMove({ balances: { [MOCK]: 100_0000000n }, orders: [{ id: 0, order: order({ amount_in: 90_0000000n }) }], exchange: { ...ex, left: 40_0000000n }, now });
  assert.equal(p.mockLeftInWallet, 60_0000000n);
  assert.equal(p.coins[0][1], 100_0000000n); // the whole balance is withdrawn; the mover leaves the rest in the wallet
  assert.equal(p.place[0].amount, 40_0000000n - 10_000n - 10n);
});

test("without orders: every open order is cancelled, none placed", () => {
  const p = planMove({ balances: { [XLM]: 5n }, orders: [{ id: 0, order: order() }, { id: 1, order: order() }], exchange: ex, now, withOrders: false });
  assert.deepEqual(p.cancel, [0, 1]);
  assert.equal(p.place.length, 0);
});

test("min_fill: the old one, but at most 20 pieces and never above the amount", () => {
  assert.equal(minFillFor(100n, 5n), 5n);
  assert.equal(minFillFor(100n, 1n), 5n); // 20 pieces
  assert.equal(minFillFor(101n, 1n), 6n); // ceil(101/20)
  assert.equal(minFillFor(10n, 50n), 10n);
});

test("coins are sorted by their 32-byte contract id", () => {
  const sorted = sortCoins([[XLM, 1n], [MOCK, 2n], [USDC, 3n]], (t) => StrKey.decodeContract(t));
  const ids = sorted.map(([t]) => Buffer.from(StrKey.decodeContract(t)).toString("hex"));
  assert.deepEqual([...ids].sort(), ids);
});

test("split: cancels first, at most 4 coins / 6 orders, an order never before its coin", () => {
  const coins = ["CA", "CB", "CC", "CD", "CE"].map((t) => [t, 1n]);
  const place = [...Array(8).keys()].map((i) => ({ id: i, sell: i === 7 ? "CE" : "CA" }));
  const parts = splitPlan({ coins, cancel: [0, 1, 2], place }, { coins: 4, orders: 6 });
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0].cancel, [0, 1, 2]);
  assert.deepEqual(parts[1].cancel, []);
  assert.equal(parts[0].coins.length, 4);
  assert.deepEqual(parts[1].coins.map((c) => c[0]), ["CE"]);
  assert.deepEqual(parts[0].place.map((p) => p.id), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(parts[1].place.map((p) => p.id), [6, 7]);
  // smaller parts (used when a simulation fails)
  const small = splitPlan({ coins: coins.slice(0, 2), cancel: [1], place: place.slice(0, 4) }, { coins: 1, orders: 2 });
  assert.equal(small.length, 2);
  assert.deepEqual(small.map((p) => p.place.length), [2, 2]);
  assert.deepEqual(splitPlan({ coins: [], cancel: [], place: [] }).length, 1);
});

test("reproduces the arguments of the real testnet move (tx b7419417…)", () => {
  const exp = 1796385442n;
  const orders = [
    { id: 0, order: order({ sell: MOCK, buy: XLM, amount_in: 200000000n, limit_price: 1000000n, min_fill: 200000000n, expiry: exp }) },
    { id: 1, order: order({ sell: XLM, buy: MOCK, amount_in: 500000000n, limit_price: 50000000n, min_fill: 100000000n, expiry: exp }) },
  ];
  const p = planMove({ balances: { [MOCK]: 300001834n, [XLM]: 1000092474n }, orders, exchange: { ...ex, left: 300001834n }, now: 1795700000 });
  assert.deepEqual(p.cancel, [0, 1]);
  const flat = (c) => [c.func, c.args.map(([, v]) => (typeof v === "bigint" ? String(v) : v))];
  assert.deepEqual(p.place.map(flat), [
    ["place_order", [USDC, XLM, "200000000", "1000000", "200000000", 300, "1796385442", true]],
    ["place_order", [XLM, USDC, "500000000", "50000000", "100000000", 300, "1796385442", true]],
  ]);
});
