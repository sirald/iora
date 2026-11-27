// Pure helpers for moving out of an earlier vault (no DOM, no network), so they can be tested on their own.
// Only coins the newest factory allows are carried into the new vault; the rest (for example Blend's old test USDC)
// are withdrawn to the wallet only, and orders that use such a coin are cancelled, not placed again.

/** Blend's old test USDC (issuer GATALT…V56): earlier vaults may still hold it; the app's USDC is Circle's. */
export const OLD_BLEND_USDC = "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU";
export const OLD_COIN_NAMES = Object.freeze({ [OLD_BLEND_USDC]: "old test USDC (Blend)" });

/**
 * The name shown for a token: a coin of the app (`coins`: [{ sym, token }]) by its symbol, a known retired coin by
 * a name that cannot be mistaken for the app's coin, anything else by its shortened address.
 */
export function coinLabel(token, coins, short = (t) => t) {
  const t = String(token);
  const c = coins.find((x) => x.token === t);
  if (c) return c.sym;
  return OLD_COIN_NAMES[t] || short(t);
}

/**
 * Splits an earlier vault's content by the newest factory's allowed list (`allowed`: Set of token addresses).
 *   carry      coins moved into the new vault
 *   walletOnly coins only withdrawn to the wallet (not allowed in the new vault)
 *   keep       open orders that can be placed again (both of their coins allowed)
 *   cancelOnly open orders that are only cancelled
 */
export function planMove(coins, orders, allowed) {
  const ok = (t) => allowed.has(String(t));
  return {
    carry: coins.filter((c) => ok(c.token)),
    walletOnly: coins.filter((c) => !ok(c.token)),
    keep: orders.filter((o) => ok(o.sell) && ok(o.buy)),
    cancelOnly: orders.filter((o) => !(ok(o.sell) && ok(o.buy))),
  };
}

/** The app stays on the newest factory unless the build says VITE_STAY_NEWEST=0. */
export const stayNewest = (flag) => String(flag ?? "1").trim() !== "0";
