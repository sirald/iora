// Pure helpers for the chart's market history (no DOM, no network): the price of a coin before Iora's pool for it
// existed, from api/history.js (Kraken, or the Reflector oracle). The pool's own trades always win after its first one.
import { ioraUnderlying } from "./prices.js";

/** Coins with a market history (api/history.js accepts the same ones). */
export const HISTORY_COINS = ["XLM", "BTC", "ETH", "SOL", "AVAX", "XRP"];

/** The coin whose market history a symbol uses ("iBTC" -> "BTC", "XLM" -> "XLM"), or null. */
export function historyCoin(sym) {
  const s = (ioraUnderlying(sym) || String(sym || "")).toUpperCase();
  return HISTORY_COINS.includes(s) ? s : null;
}

/**
 * Candles [[t, tf, o, h, l, c]] -> chart price points [{ t, p, m: 1, c? }] (m: market history, not a pool trade;
 * c: the candle's close).
 * Each candle becomes open, then low and high in the order that leads to the close, then the close; the chart's own
 * buckets rebuild the same candle from them. A flat candle (one price) is a single point. Nothing after `now`.
 */
export function candlesToPoints(candles, now = Infinity) {
  const out = [];
  for (const row of candles || []) {
    const [t, tf, o, h, l, c] = row.map(Number);
    if (!(t > 0 && tf > 0 && o > 0 && h > 0 && l > 0 && c > 0)) continue;
    const seq = o === h && h === l && l === c ? [o] : c >= o ? [o, l, h, c] : [o, h, l, c];
    seq.forEach((p, i) => {
      const at = Math.floor(t + (i * tf) / seq.length);
      // c: the candle's close, the only point the line view draws (the others are for the candle view)
      if (at <= now) out.push(i === seq.length - 1 ? { t: at, p, m: 1, c: 1 } : { t: at, p, m: 1 });
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** The market history before the pool's first point, then the pool's points (unchanged). */
export function joinHistory(market, pool) {
  if (!market || !market.length) return pool;
  const start = pool.length ? pool[0].t : Infinity;
  const before = market.filter((x) => x.t < start);
  return before.length ? [...before, ...pool] : pool;
}

/** Where the line is from, for the chart's caption. `start`: the pool's first point (seconds) or null. */
export function historyCaption(source, start, pool, fmtDate) {
  const src = source === "Reflector" ? "the Reflector oracle" : `${source || "market data"}`;
  if (!start) return `Market price from ${src} (USD), dashed; the pool has no trades yet.`;
  return `Before ${fmtDate(start)}: market price from ${src} (USD), dashed; after: trades in ${pool}.`;
}
