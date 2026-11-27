import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_GAP, bestVenue, coinStyle, gapFrom, markFar, refKind, reflectorPrice, reservesFromEvent, testnetNote, venueLine } from "../src/prices.js";

const quotes = [{ venue: "Soroswap", price: 0.605 }, { venue: "Aquarius", price: 0.366 }];

test("the best venue: lowest price to buy, highest to sell", () => {
  assert.equal(bestVenue(quotes, "buy").venue, "Aquarius");
  assert.equal(bestVenue(quotes, "sell").venue, "Soroswap");
  assert.equal(bestVenue([{ venue: "Soroswap", price: null }, { venue: "Aquarius", price: 0.4 }], "buy").venue, "Aquarius");
  assert.equal(bestVenue([], "buy"), null);
});

test("the venue line lists every quote and the Reflector reference", () => {
  assert.equal(venueLine(quotes, 0.1292559), "Soroswap 0.6050 · Aquarius 0.3660 · Reference (Reflector) 0.1293 $");
  assert.equal(venueLine([{ venue: "Soroswap", price: null }, quotes[1]], null), "Aquarius 0.3660");
  assert.equal(venueLine([{ venue: "Soroswap", price: 0.000012345 }], null), "Soroswap 0.00001235");
});

test("the testnet note works for any coin, with or without a reference", () => {
  assert.match(testnetNote("XLM", 0.129), /nobody arbitrages the testnet pools/);
  assert.match(testnetNote("XLM", 0.129), /reference for XLM: 0\.1290 \$ from the Reflector oracle/);
  assert.match(testnetNote("BTC", null), /Orders fill at the best pool price\.$/);
  assert.doesNotMatch(testnetNote("BTC", null), /Reflector/);
});

test("Reflector prices have 7 decimals", () => {
  assert.equal(reflectorPrice({ price: 1292559n, timestamp: 1n }), 0.1292559);
  assert.equal(reflectorPrice(null), null);
  assert.equal(reflectorPrice({ price: 0n }), null);
});

test("coin icons: drawn XLM/USDC, known coins, a fallback for any symbol", () => {
  assert.deepEqual(coinStyle("XLM"), { cls: "xlm", mark: "", color: "" });
  assert.deepEqual(coinStyle("usdc"), { cls: "usdc", mark: "", color: "" });
  assert.deepEqual(coinStyle("BTC"), { cls: "gen btc", mark: "₿", color: "#f7931a" });
  for (const s of ["ETH", "SOL", "EURC", "XRP", "AQUA"]) assert.equal(coinStyle(s).cls, `gen ${s.toLowerCase()}`);
  const n = coinStyle("NEWCOIN");
  assert.equal(n.cls, "gen");
  assert.equal(n.mark, "N");
  assert.match(n.color, /^hsl\(\d+ 45% 42%\)$/);
  assert.deepEqual(coinStyle("NEWCOIN"), n); // stable
  assert.equal(coinStyle("").mark, "?");
});

test("reference pool: pools more than 5% from the real price are marked ignored", () => {
  const real = 0.1293;
  const q = markFar([{ venue: "Iora reference pool (Aquarius)", price: 0.127, ref: true }, { venue: "Soroswap", price: 0.605 }, { venue: "Aquarius", price: 0.3676 }, { venue: "Near", price: 0.131 }], real);
  assert.deepEqual(q.map((x) => x.ignored), [false, true, true, false]);
  assert.equal(MAX_GAP, 0.05);
  assert.ok(Math.abs(gapFrom(0.1358, 0.1293) - 0.0503) < 0.001);
  assert.equal(gapFrom(null, 1), null);
  assert.deepEqual(markFar([{ venue: "A", price: 1 }], null).map((x) => x.ignored), [false]); // no real price: nothing is ignored
  assert.equal(
    venueLine(q, real),
    "Iora reference pool (Aquarius) 0.1270 · Soroswap 0.6050 (ignored: far from the real price) · Aquarius 0.3676 (ignored: far from the real price) · Near 0.1310 · Reference (Reflector) 0.1293 $",
  );
});

test("reference pool events: Soroswap sync and Aquarius update_reserves", () => {
  assert.deepEqual(reservesFromEvent("soroswap", { new_reserve_0: 5n, new_reserve_1: 7n }), [5n, 7n]);
  assert.deepEqual(reservesFromEvent("aquarius", [126318124538n, 602197194860n]), [126318124538n, 602197194860n]);
  assert.deepEqual(reservesFromEvent("aquarius", ["1", "2"]), [1n, 2n]);
  assert.equal(reservesFromEvent("aquarius", { new_reserve_0: 1n }), null);
  assert.equal(reservesFromEvent("soroswap", [1n, 2n]), null);
  assert.equal(reservesFromEvent("aquarius", null), null);
  assert.equal(refKind("aquarius"), "aquarius");
  assert.equal(refKind("Aqua"), "aquarius");
  assert.equal(refKind("soroswap"), "soroswap");
  assert.equal(refKind(""), null);
});

test("the testnet note with the reference pool", () => {
  const n = testnetNote("XLM", 0.127, "Iora reference pool (Aquarius)");
  assert.match(n, /come from Iora reference pool \(Aquarius\), which is kept at the real price/);
  assert.match(n, /more than 5% away from it are ignored/);
});
