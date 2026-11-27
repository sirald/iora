import { test } from "node:test";
import assert from "node:assert/strict";
import { OLD_BLEND_USDC, coinLabel, planMove, stayNewest } from "../src/migrate.js";

const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"; // Circle
const XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const AQUA = "CAQUA";
const BTC = "COLDBTC";
const allowed = new Set([USDC, XLM, AQUA]);
const coins = [{ sym: "USDC", token: USDC }, { sym: "XLM", token: XLM }, { sym: "AQUA", token: AQUA }];

test("old Blend test USDC is never called just USDC", () => {
  assert.equal(coinLabel(OLD_BLEND_USDC, coins), "old test USDC (Blend)");
  assert.equal(coinLabel(USDC, coins), "USDC");
  assert.equal(coinLabel(BTC, coins, (t) => `${t.slice(0, 4)}…`), "COLD…");
});

test("allowed coins are carried, others only withdrawn to the wallet", () => {
  const p = planMove(
    [{ token: OLD_BLEND_USDC, bal: 5n }, { token: XLM, bal: 7n }, { token: BTC, bal: 1n }, { token: AQUA, bal: 2n }],
    [],
    allowed,
  );
  assert.deepEqual(p.carry.map((c) => c.token), [XLM, AQUA]);
  assert.deepEqual(p.walletOnly.map((c) => c.token), [OLD_BLEND_USDC, BTC]);
});

test("orders with a retired coin are cancelled only; the others are kept", () => {
  const orders = [
    { id: 0, sell: OLD_BLEND_USDC, buy: XLM }, // buy XLM with old USDC
    { id: 1, sell: XLM, buy: OLD_BLEND_USDC }, // sell XLM for old USDC
    { id: 2, sell: USDC, buy: AQUA },
    { id: 3, sell: AQUA, buy: USDC },
  ];
  const p = planMove([], orders, allowed);
  assert.deepEqual(p.keep.map((o) => o.id), [2, 3]);
  assert.deepEqual(p.cancelOnly.map((o) => o.id), [0, 1]);
});

test("a vault with only old USDC needs no new vault", () => {
  const p = planMove([{ token: OLD_BLEND_USDC, bal: 9n }], [{ id: 4, sell: OLD_BLEND_USDC, buy: XLM }], allowed);
  assert.equal(p.carry.length + p.keep.length, 0);
  assert.equal(p.walletOnly.length, 1);
  assert.equal(p.cancelOnly.length, 1);
});

test("stay on the newest factory unless the build says 0", () => {
  assert.equal(stayNewest(undefined), true);
  assert.equal(stayNewest("1"), true);
  assert.equal(stayNewest(""), true);
  assert.equal(stayNewest("0"), false);
  assert.equal(stayNewest(" 0 "), false);
});
