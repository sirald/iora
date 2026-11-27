import { test } from "node:test";
import assert from "node:assert/strict";
import { bestVenue, coinStyle, reflectorPrice, testnetNote, venueLine } from "../src/prices.js";

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
