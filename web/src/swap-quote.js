// Pure helpers for the Market swap quote (no DOM, no network), so they can be tested on their own (audit IORA-01).
// A quote is an immutable snapshot; the signed transaction is built from it alone and only while it still matches
// what the user has on screen.

/** Minimum output for a slippage in percent (0.01 - 50), rounded down. */
export function minOut(out, slip) {
  const bps = BigInt(Math.round((100 - slip) * 100));
  return (BigInt(out) * bps) / 10000n;
}

const freezeRoute = (route) => {
  if (!route) return null;
  if (route.name !== "split") return Object.freeze({ ...route });
  return Object.freeze({ ...route, parts: Object.freeze(route.parts.map((p) => Object.freeze({ ...p }))) });
};

/** The immutable quote: { sell, buy, dir, amount, out, slip, minOut, route, wallet, requestId }. */
export function makeQuote({ sell, buy, dir, amount, out, slip, route, wallet, requestId }) {
  return Object.freeze({ sell, buy, dir, amount: BigInt(amount), out: BigInt(out), slip, minOut: minOut(out, slip), route: freezeRoute(route), wallet, requestId });
}

/**
 * Why a quote can not be signed for what is on screen now (`cur`: { sell, buy, dir, amount, slip, wallet,
 * requestId }), or null if it can. Any difference, including a newer request, means: ask again, sign nothing.
 */
export function quoteMismatch(q, cur) {
  if (!q) return "no quote";
  if (q.requestId !== cur.requestId) return "a newer quote was requested";
  if (q.wallet !== cur.wallet) return "the wallet changed";
  if (q.dir !== cur.dir || q.sell !== cur.sell || q.buy !== cur.buy) return "the direction changed";
  if (cur.amount === null || q.amount !== BigInt(cur.amount)) return "the amount changed";
  if (q.slip !== cur.slip) return "the slippage changed";
  return null;
}

/** Checks the route is internally consistent with the quote; returns an error text or null. */
export function routeProblem(q) {
  const r = q.route;
  if (!r) return "no route";
  if (q.out <= 0n || q.minOut <= 0n || q.minOut > q.out) return "bad minimum";
  if (q.sell === q.buy) return "same token";
  if (r.name === "Soroswap") return null;
  if (r.name === "Aquarius") return r.hash ? null : "no Aquarius pool";
  if (r.name === "split") {
    if (!Array.isArray(r.parts) || r.parts.length < 2) return "split needs two pools";
    let sum = 0n;
    for (const p of r.parts) {
      if (BigInt(p.amount) <= 0n) return "empty split part";
      sum += BigInt(p.amount);
    }
    return sum === q.amount ? null : "split parts do not add up to the amount";
  }
  return "unknown route";
}
