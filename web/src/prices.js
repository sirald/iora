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

/** "Soroswap 0.6050 · Aquarius 0.3660 · Reference (Reflector) 0.1290 $" (missing quotes are left out). */
export function venueLine(quotes, ref) {
  const parts = quotes.filter((q) => q && Number.isFinite(q.price) && q.price > 0).map((q) => `${q.venue} ${px(q.price)}`);
  if (Number.isFinite(ref) && ref > 0) parts.push(`Reference (Reflector) ${px(ref)} $`);
  return parts.join(" · ");
}

/** The testnet note shown beside a price, for any coin. */
export function testnetNote(sym, ref) {
  const r = Number.isFinite(ref) && ref > 0 ? ` (reference for ${sym}: ${px(ref)} $ from the Reflector oracle)` : "";
  return `Testnet prices: test tokens have no real value and nobody arbitrages the testnet pools, so each pool has its own price, far from the real market${r}. Orders fill at the best pool price.`;
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
  AQUA: { color: "#1fb5d8", mark: "A" },
};
/** For an <i class="coin"> icon: { cls, mark, color }. XLM and USDC keep their drawn icons (cls only). */
export function coinStyle(sym) {
  const s = String(sym || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s === "XLM" || s === "USDC") return { cls: s.toLowerCase(), mark: "", color: "" };
  const k = KNOWN[s];
  if (k) return { cls: `gen ${s.toLowerCase()}`, mark: k.mark, color: k.color };
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return { cls: "gen", mark: s ? s[0] : "?", color: `hsl(${h} 45% 42%)` };
}
