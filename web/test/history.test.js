import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { candlesToPoints, historyCaption, historyCoin, joinHistory } from "../src/history.js";

const lib = createRequire(import.meta.url)("../api/_history-lib.cjs");

test("history coins: XLM and the coins Iora's test tokens follow, nothing else", () => {
  assert.equal(lib.coinOf("XLM"), "XLM");
  assert.equal(lib.coinOf("iBTC"), "BTC");
  assert.equal(lib.coinOf("iAVAX"), "AVAX");
  assert.equal(lib.coinOf("xrp"), "XRP");
  for (const bad of ["DOGE", "", null, "../x", "constructor", "__proto__", "IBTC"]) assert.equal(lib.coinOf(bad), null, String(bad));
  assert.equal(historyCoin("iSOL"), "SOL");
  assert.equal(historyCoin("XLM"), "XLM");
  assert.equal(historyCoin("USDC"), null);
  assert.deepEqual(Object.keys(lib.COINS).sort(), ["AVAX", "BTC", "ETH", "SOL", "XLM", "XRP"]);
});

test("a Kraken OHLC answer becomes candles (real answer shape)", () => {
  const json = { error: [], result: { XXLMZUSD: [[1795737600, "0.126611", "0.130630", "0.124162", "0.126608", "0.12", "1000", 50], [1795651200, "0.1", "0.2", "0.05", "0.15", "0", "0", 0], [1, "0", "1", "1", "1", "", "", 0]], last: 1795651200 } };
  assert.deepEqual(lib.krakenCandles(json), [[1795651200, 0.1, 0.2, 0.05, 0.15], [1795737600, 0.126611, 0.13063, 0.124162, 0.126608]]);
  assert.throws(() => lib.krakenCandles({ error: ["EQuery:Unknown asset pair"] }), /Unknown asset pair/);
});

test("the four candle sizes join without overlaps, finest where it exists", () => {
  const now = 1_000_000;
  const mk = (tf, n) => Array.from({ length: n }, (_, i) => [Math.floor(now / tf) * tf - (n - 1 - i) * tf, 1, 2, 0.5, 1.5]);
  const layers = [
    { tf: 86400, keep: 365 * 86400, candles: mk(86400, 30) },
    { tf: 900, keep: 7200, candles: mk(900, 20) },
    { tf: 3600, keep: 86400, candles: mk(3600, 40) },
  ];
  const rows = lib.joinLayers(layers, now);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1][0] + rows[i - 1][1] <= rows[i][0], `overlap at ${i}`);
  const last = rows[rows.length - 1];
  assert.equal(last[1], 900, "the newest candles are 15 minutes");
  assert.ok(rows.filter((r) => r[1] === 900).every((r) => r[0] >= now - 7200), "15m only as far back as kept");
  assert.ok(rows.some((r) => r[1] === 3600) && rows.some((r) => r[1] === 86400));
  assert.deepEqual(lib.joinLayers([], now), []);
});

test("Reflector prices become flat candles, once per time", () => {
  assert.deepEqual(lib.flatCandles([{ t: 600, p: 0.12 }, { t: 300, p: 0.1234567891 }, { t: 600, p: 9 }, { t: 0, p: 1 }], 300), [
    [300, 300, 0.123457, 0.123457, 0.123457, 0.123457],
    [600, 300, 0.12, 0.12, 0.12, 0.12],
  ]);
});

test("candles become chart points that rebuild the same candle", () => {
  const pts = candlesToPoints([[1800, 900, 1, 3, 0.5, 2], [900, 900, 2, 2.5, 0.8, 1], [2700, 900, 4, 4, 4, 4]], 4000);
  assert.deepEqual(pts.map((x) => x.p), [2, 2.5, 0.8, 1, 1, 0.5, 3, 2, 4]);
  assert.ok(pts.every((x) => x.m === 1));
  assert.ok(pts.every((x, i) => i === 0 || x.t >= pts[i - 1].t));
  // a candle bucket of the same size sees open first, close last, and the high and low
  const b = pts.filter((x) => x.t >= 1800 && x.t < 2700).map((x) => x.p);
  assert.deepEqual([b[0], b[b.length - 1], Math.max(...b), Math.min(...b)], [1, 2, 3, 0.5]);
  // nothing after now; bad rows are skipped
  assert.equal(candlesToPoints([[900, 900, 1, 3, 0.5, 2]], 1000).length, 1);
  assert.equal(candlesToPoints([[900, 900, 1, 1, 1, 1]], 1000).length, 1, "a flat candle is one point");
  assert.deepEqual(candlesToPoints([[0, 900, 0, 1, 1, 1], null].filter(Boolean)), []);
});

test("market history only before the pool's first point; the pool's points are kept as they are", () => {
  const market = [{ t: 10, p: 1, m: 1 }, { t: 20, p: 2, m: 1 }, { t: 30, p: 3, m: 1 }];
  const pool = [{ t: 25, p: 2.1 }, { t: 40, p: 2.2, live: 1 }];
  assert.deepEqual(joinHistory(market, pool), [market[0], market[1], ...pool]);
  assert.equal(joinHistory(null, pool), pool);
  assert.equal(joinHistory(market, []).length, 3, "no pool trades yet: the market line alone");
  const fmt = (t) => `T${t}`;
  assert.equal(historyCaption("Kraken", 25, "Iora reference pool (Aquarius)", fmt), "Before T25: market price from Kraken (USD), dashed; after: trades in Iora reference pool (Aquarius).");
  assert.match(historyCaption("Reflector", null, "x", fmt), /Reflector oracle .*no trades yet/);
});
