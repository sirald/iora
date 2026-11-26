// Minimum output per filler route leg (slippage protection). No network.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cometMaxPrice, legMinOut, retryRoute, splitMins, viaPlan } from "../lib.js";

const I128_MAX = 170141183460469231731687303715884105727n;

describe("one leg", () => {
  test("quote less the tolerance, rounded down", () => {
    assert.equal(legMinOut(1_000_000n, 50), 995_000n);
    assert.equal(legMinOut(1_000_001n, 50), 995_000n); // 995000.995 -> down
    assert.equal(legMinOut(1_000_000n, 0), 1_000_000n);
    assert.equal(legMinOut(1_000_000n, 10_000), 0n);
  });

  test("no quote, a non-positive quote or a silly tolerance never gives a negative minimum", () => {
    assert.equal(legMinOut(null, 50), 0n);
    assert.equal(legMinOut(0n, 50), 0n);
    assert.equal(legMinOut(-5n, 50), 0n);
    assert.equal(legMinOut(100n, 20_000), 0n);
    assert.equal(legMinOut(100n, -50), 100n);
    assert.equal(legMinOut(100n, "x"), 100n);
  });
});

describe("split routes", () => {
  test("each leg from its own quote", () => {
    assert.deepEqual(splitMins([600_000n, 400_000n], 0n, 50), [597_000n, 398_000n]);
  });

  test("the vault's minimum is a floor, shared in proportion to the quotes", () => {
    // tolerance alone would allow 995 in all; the vault needs 998
    const m = splitMins([600n, 400n], 998n, 50);
    assert.deepEqual(m, [599n, 400n]); // ceil(998*0.6)=599, ceil(998*0.4)=400
    assert.ok(m[0] + m[1] >= 998n);
    assert.ok(m[0] <= 600n && m[1] <= 400n);
  });

  test("a leg's minimum never exceeds its quote, even with the floor", () => {
    assert.deepEqual(splitMins([600n, 400n], 1000n, 50), [600n, 400n]);
  });

  test("quotes that cannot cover the vault's minimum: no route", () => {
    assert.equal(splitMins([600n, 399n], 1000n, 50), null);
  });

  test("the floor matters only when it is above the tolerance", () => {
    assert.deepEqual(splitMins([1_000_000n], 900_000n, 50), [995_000n]);
    assert.deepEqual(splitMins([1_000_000n], 999_000n, 50), [999_000n]);
  });
});

describe("intermediate token", () => {
  test("leg 2 sells leg 1's minimum", () => {
    assert.deepEqual(viaPlan(2_000_000n, 50), { min1: 1_990_000n, in2: 1_990_000n });
    assert.deepEqual(viaPlan(0n, 50), { min1: 0n, in2: 0n });
  });
});

describe("Comet max_price", () => {
  test("factor times the worst average price the minimum allows (7 decimals)", () => {
    // 100 in for at least 50 out: worst average 2.0 -> 2x = 4.0
    assert.equal(cometMaxPrice(100n, 50n, 2), 40_000_000n);
    assert.equal(cometMaxPrice(100n, 30n, 1.5), 50_000_001n); // ceil(100/30 * 1e7)=33333334, x1.5
  });

  test("no minimum or factor 0: no ceiling", () => {
    assert.equal(cometMaxPrice(100n, 0n, 2), I128_MAX);
    assert.equal(cometMaxPrice(100n, 50n, 0), I128_MAX);
  });
});

describe("retry after a moved price", () => {
  test("free retries, then the vault's own route", () => {
    assert.equal(retryRoute(0, 2), true);
    assert.equal(retryRoute(1, 2), true);
    assert.equal(retryRoute(2, 2), false);
    assert.equal(retryRoute(0, 0), false);
  });
});
