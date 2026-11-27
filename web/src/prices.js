// Pure helpers for showing testnet prices with their source, and for coin icons (no DOM, no network).
// On testnet every pool has its own price (test tokens have no value and nobody arbitrages the pools), so the app
// says where each price comes from instead of pretending there is one market price.

/** Formats a price with 4 decimals, or significant digits for small values. */
export const px = (v) => (v !== 0 && Math.abs(v) < 0.01 ? v.toLocaleString("en-US", { maximumSignificantDigits: 4 }) : v.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 }));

/**
 * The best quote for a side: a buyer wants the lowest price, a seller the highest.
 * `quotes`: [{ venue, price }] with price in quote units per coin (null = no quote).
 */
export function bestVenue(quotes, side) {
  const ok = quotes.filter((q) => q && Number.isFinite(q.price) && q.price > 0);
  if (!ok.length) return null;
  return ok.reduce((a, b) => (side === "sell" ? (b.price > a.price ? b : a) : b.price < a.price ? b : a));
}

/**
 * "Soroswap 0.6050 · Aquarius 0.3660 · Reference (Reflector) 0.1290 $" (missing quotes are left out); a quote marked
 * `ignored` says so: "Soroswap 0.6050 (ignored: far from the real price)".
 */
export function venueLine(quotes, ref) {
  const parts = quotes.filter((q) => q && Number.isFinite(q.price) && q.price > 0).map((q) => `${q.venue} ${px(q.price)}${q.ignored ? " (ignored: far from the real price)" : ""}`);
  if (Number.isFinite(ref) && ref > 0) parts.push(`Reference (Reflector) ${px(ref)} $`);
  return parts.join(" · ");
}

/**
 * The testnet note shown beside a price, for any coin. With Iora's reference pool (`refPool`: its name) the chart
 * and the price at the top come from that pool, and pools far from the real price are ignored.
 */
export function testnetNote(sym, ref, refPool = "") {
  const r = Number.isFinite(ref) && ref > 0 ? ` (reference for ${sym}: ${px(ref)} $ from the Reflector oracle)` : "";
  if (refPool)
    return `Testnet prices: test tokens have no real value and nobody arbitrages the testnet pools, so most pools have their own price, far from the real market. The chart and the price at the top come from ${refPool}, which is kept at the real price${r}. Pools more than ${Math.round(MAX_GAP * 100)}% away from it are ignored when orders fill.`;
  return `Testnet prices: test tokens have no real value and nobody arbitrages the testnet pools, so each pool has its own price, far from the real market${r}. Orders fill at the best pool price.`;
}

// ---- Iora's reference pool (kept at the real price) and the pools far from it ----
/** The keeper ignores pools whose price is further than this from the real price. */
export const MAX_GAP = 0.05;
/** How far a price is from the reference, as a fraction (0.05 = 5%); null if either is missing. */
export const gapFrom = (price, ref) => (Number.isFinite(price) && price > 0 && Number.isFinite(ref) && ref > 0 ? Math.abs(price / ref - 1) : null);
/** The quotes with `ignored` set on those further than MAX_GAP from the real price (`real`, in the same unit). */
export const markFar = (quotes, real, max = MAX_GAP) => quotes.map((q) => ({ ...q, ignored: !q.ref && gapFrom(q.price, real) !== null && gapFrom(q.price, real) > max }));
/** "aquarius" | "soroswap" for a VENUE setting (anything else: null). */
export function refKind(venue) {
  const v = String(venue || "").toLowerCase();
  return v.startsWith("aqua") ? "aquarius" : v.startsWith("soro") ? "soroswap" : null;
}
/**
 * The pool's reserves from one of its events, in the pool's token order, or null:
 *   Soroswap pair: "sync" event, value { new_reserve_0, new_reserve_1 }
 *   Aquarius pool: "update_reserves" event, value [reserve_a, reserve_b] (order of the pool's get_tokens)
 */
export function reservesFromEvent(kind, value) {
  try {
    if (kind === "aquarius") return Array.isArray(value) && value.length >= 2 ? [BigInt(value[0]), BigInt(value[1])] : null;
    if (value && value.new_reserve_0 !== undefined) return [BigInt(value.new_reserve_0), BigInt(value.new_reserve_1)];
  } catch {}
  return null;
}

/** A Reflector price (i128 with 7 decimals) as a number, or null. */
export const reflectorPrice = (v) => {
  const p = v && v.price !== undefined ? Number(BigInt(v.price)) / 1e7 : NaN;
  return Number.isFinite(p) && p > 0 ? p : null;
};

// ---- Coin icons: a known symbol gets its colour and mark; any other symbol a colour from its name and its initial ----
const KNOWN = {
  BTC: { color: "#f7931a", mark: "₿" },
  ETH: { color: "#627eea", mark: "Ξ" },
  WETH: { color: "#627eea", mark: "Ξ" },
  SOL: { color: "#7a4fe0", mark: "S" },
  EURC: { color: "#0b5bd3", mark: "€" },
  XRP: { color: "#23292f", mark: "X" },
  AVAX: { color: "#e84142", mark: "A" },
  AQUA: { color: "#1fb5d8", mark: "A" },
};
/**
 * Iora's own test tokens are named "i" + the coin they follow (iBTC, iETH, iSOL, iAVAX, iXRP): the coin they
 * follow, or null for any other symbol. Only a lowercase "i" before an uppercase name counts (not "IOTA").
 */
export function ioraUnderlying(sym) {
  const m = /^i([A-Z][A-Z0-9]{1,11})$/.exec(String(sym || ""));
  return m ? m[1] : null;
}
/** The one-line description of an Iora test token (null for other coins). */
export function coinBlurb(sym) {
  const u = ioraUnderlying(sym);
  return u ? `Iora test token, priced at the real ${u} price (Reflector)` : null;
}
/** Interest tag for a coin: { text, warn }. `inBlend`: the coin is a reserve of the Blend pool. */
export function interestTag(sym, inBlend) {
  if (inBlend) return { text: `${sym} earns on Blend`, warn: false };
  return { text: ioraUnderlying(sym) ? `${sym} earns no interest yet` : `${sym} earns no interest`, warn: true };
}

/** For an <i class="coin"> icon: { cls, mark, color }. XLM and USDC keep their drawn icons (cls only). An Iora test
 * token (iBTC) gets the icon of the coin it follows (BTC). */
export function coinStyle(sym) {
  const under = ioraUnderlying(sym);
  if (under) sym = under;
  const s = String(sym || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s === "XLM" || s === "USDC") return { cls: s.toLowerCase(), mark: "", color: "" };
  const k = KNOWN[s];
  if (k) return { cls: `gen ${s.toLowerCase()}`, mark: k.mark, color: k.color };
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return { cls: "gen", mark: s ? s[0] : "?", color: `hsl(${h} 45% 42%)` };
}
