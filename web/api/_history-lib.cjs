// Pure helpers of api/history.js (no network): which coins, how a Kraken answer becomes candles, and how the four
// candle sizes are joined into one series (finest where it exists).

/** The coins with a market history, and their Kraken pair (USD). Only these are accepted. */
const COINS = { XLM: "XLMUSD", BTC: "XBTUSD", ETH: "ETHUSD", SOL: "SOLUSD", AVAX: "AVAXUSD", XRP: "XRPUSD" };
/** Candle sizes asked from Kraken (seconds) and how far back each is used: 15m for the last week, then 1H, 4H, 1D. */
const LAYERS = [
  { tf: 900, keep: 7.5 * 86400 },
  { tf: 3600, keep: 30 * 86400 },
  { tf: 14400, keep: 120 * 86400 },
  { tf: 86400, keep: 365 * 86400 },
];

/** "iBTC" -> "BTC", "xlm" -> "XLM"; null for a coin that has no market history here. */
function coinOf(sym) {
  let s = String(sym || "").trim();
  const m = /^i([A-Z][A-Z0-9]{1,11})$/.exec(s);
  if (m) s = m[1];
  s = s.toUpperCase();
  return Object.prototype.hasOwnProperty.call(COINS, s) ? s : null;
}

/** 6 significant digits are plenty for a chart and keep the answer small. */
const sig = (v) => Number(Number(v).toPrecision(6));

/**
 * Kraken /0/public/OHLC answer -> [[t, o, h, l, c]] (t: start of the candle, seconds), oldest first.
 * Rows: [time, open, high, low, close, vwap, volume, count], prices as strings. Throws on an error answer.
 */
function krakenCandles(json) {
  if (!json || (Array.isArray(json.error) && json.error.length)) throw new Error(`kraken: ${json && json.error ? json.error.join(", ") : "no answer"}`);
  const r = json.result || {};
  const key = Object.keys(r).find((k) => k !== "last");
  const rows = key && Array.isArray(r[key]) ? r[key] : [];
  const out = [];
  for (const x of rows) {
    const t = Number(x[0]), o = Number(x[1]), h = Number(x[2]), l = Number(x[3]), c = Number(x[4]);
    if (t > 0 && o > 0 && h > 0 && l > 0 && c > 0) out.push([t, sig(o), sig(h), sig(l), sig(c)]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/**
 * Joins candle layers into one series [[t, tf, o, h, l, c]], oldest first, without overlaps: each layer covers
 * only the time before the next finer layer starts, and no further back than its `keep`.
 * `layers`: [{ tf, keep, candles: [[t, o, h, l, c]] }] in any order. `now`: seconds.
 */
function joinLayers(layers, now) {
  const fine = [...layers].filter((L) => L.candles && L.candles.length).sort((a, b) => a.tf - b.tf);
  const out = [];
  let until = Infinity; // the finer layers cover from here on
  for (const L of fine) {
    const from = now - L.keep;
    const part = L.candles.filter(([t]) => t >= from && t + L.tf <= until);
    for (const [t, o, h, l, c] of part) out.push([t, L.tf, o, h, l, c]);
    // The last finer candle may still be open; the next coarser layer stops where this one starts.
    if (part.length) until = Math.min(until, part[0][0]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/**
 * Reflector answers -> candles of a single price (o = h = l = c), used when Kraken cannot be reached.
 * `points`: [{ t, p }] (seconds, price), any order; `tf`: the spacing between them.
 */
function flatCandles(points, tf) {
  const seen = new Set();
  return points
    .filter((x) => x && x.t > 0 && x.p > 0 && !seen.has(x.t) && seen.add(x.t))
    .sort((a, b) => a.t - b.t)
    .map((x) => [x.t, tf, sig(x.p), sig(x.p), sig(x.p), sig(x.p)]);
}

module.exports = { COINS, LAYERS, coinOf, krakenCandles, joinLayers, flatCandles, sig };
