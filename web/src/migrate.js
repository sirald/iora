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
 * `exchange` maps a retired coin to the coin it is exchanged for 1:1 on the way (Blend's old test USDC -> Circle's
 * USDC); such a coin is carried too, marked with `convert`, as long as its new coin is allowed.
 *   carry      coins moved into the new vault ({ ...coin, convert: newToken } for an exchanged coin)
 *   convert    [{ from, to }]: the exchanges the move makes
 *   walletOnly coins only withdrawn to the wallet (not allowed and not exchangeable)
 *   keep       open orders that can be placed again, with exchanged coins already replaced (`from` = the original)
 *   cancelOnly open orders that are only cancelled
 */
export function planMove(coins, orders, allowed, exchange = {}) {
  const to = (t) => (allowed.has(String(t)) ? String(t) : exchange[String(t)] && allowed.has(exchange[String(t)]) ? exchange[String(t)] : null);
  const carry = [], walletOnly = [], convert = [], keep = [], cancelOnly = [];
  for (const c of coins) {
    const t = to(c.token);
    if (!t) walletOnly.push(c);
    else if (t === String(c.token)) carry.push(c);
    else {
      carry.push({ ...c, convert: t });
      if (!convert.some((x) => x.from === String(c.token))) convert.push({ from: String(c.token), to: t });
    }
  }
  for (const o of orders) {
    const sell = to(o.sell), buy = to(o.buy);
    if (sell && buy && sell !== buy) keep.push(sell === String(o.sell) && buy === String(o.buy) ? o : { ...o, sell, buy, from: o });
    else cancelOnly.push(o);
  }
  return { carry, convert, walletOnly, keep, cancelOnly };
}

/** The app stays on the newest factory unless the build says VITE_STAY_NEWEST=0. */
export const stayNewest = (flag) => String(flag ?? "1").trim() !== "0";
