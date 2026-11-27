// Pure decision logic of the Iora price bot (no network). Amounts are in token units (1 USDC = 1.0, 1 coin = 1.0),
// prices in USDC per coin unless said otherwise. Every pool is USDC against one coin, both 7 decimals.
//
// Both kinds of pool the bot looks after price like a constant-product pool x * y = L^2 (x USDC, y coin):
//   - the Aquarius concentrated XLM pool with full-range liquidity (Uniswap v3 formulas, slot0 + active liquidity),
//   - the Soroswap USDC/coin pairs (Uniswap v2: reserves).
// With s = sqrt(y / x) (coin per USDC): adding dy coin (net of the fee) raises s by dy / L, adding dx USDC raises
// 1/s by dx / L. sqrtPriceX96 = s * 2^96 as in Uniswap v3; for a v2 pair it comes from the reserves (fromReserves).

const Q96 = 2 ** 96;

/** Pool price in USDC per coin from sqrt_price_x96 (coin per USDC, token1 per token0). */
export function poolPrice(sqrtPriceX96) {
  const s = Number(sqrtPriceX96) / Q96;
  return 1 / (s * s);
}

/** sqrtPriceX96 and liquidity (raw units) of a constant-product pool with reserves x USDC and y coin (raw). */
export function fromReserves(x, y) {
  const fx = Number(x);
  const fy = Number(y);
  if (!(fx > 0) || !(fy > 0)) return { sqrtPriceX96: 0, liquidity: 0 };
  return { sqrtPriceX96: Math.sqrt(fy / fx) * Q96, liquidity: Math.sqrt(fx * fy) };
}

/**
 * The swap (net of the pool fee) that moves the pool price to `target` USDC per coin, for liquidity L (raw units,
 * 1e7 per token unit). Returns { sell: "COIN" | "USDC", netIn } in token units, or null when already there.
 */
export function swapToTarget(sqrtPriceX96, liquidity, target) {
  const s = Number(sqrtPriceX96) / Q96;
  const L = Number(liquidity) / 1e7;
  if (!(L > 0) || !(target > 0) || !(s > 0)) return null;
  const sT = Math.sqrt(1 / target);
  if (sT > s) return { sell: "COIN", netIn: L * (sT - s) }; // pool price above target: coin in
  if (sT < s) return { sell: "USDC", netIn: L * (1 / sT - 1 / s) }; // pool price below target: USDC in
  return null;
}

/**
 * Decides one pool in one run.
 * state: {
 *   coin,                     the coin's name (for the log)
 *   sqrtPriceX96, liquidity,  pool price and liquidity (raw)
 *   feeBps,                   the pool fee (30 = 0.3%)
 *   coinUsd, usdcUsd,         oracle prices in USD (null when missing)
 *   priceAge,                 seconds since the older of the two oracle prices
 *   walletUsdc, walletCoin    the bot's balances
 * }
 * cfg: { threshold, maxAge, maxTradeUsd, minTradeUsd, coinReserve, warnUsdc, warnCoinUsd }
 * Returns { action: null | { sell, amountIn }, notes, warnings, poolPrice, refPrice, deviation }.
 * action.sell is "COIN" (the bot sells the coin for USDC) or "USDC" (it buys the coin).
 */
export function decide(state, cfg) {
  const notes = [];
  const warnings = [];
  const coin = state.coin ?? "coin";
  const out = { action: null, notes, warnings, poolPrice: NaN, refPrice: NaN, deviation: NaN };

  if (state.walletUsdc < cfg.warnUsdc) warnings.push(`inventory low: ${state.walletUsdc.toFixed(4)} USDC (warn below ${cfg.warnUsdc})`);
  if (state.coinUsd > 0 && state.walletCoin * state.coinUsd < cfg.warnCoinUsd)
    warnings.push(`inventory low: ${state.walletCoin.toFixed(7)} ${coin} = ${(state.walletCoin * state.coinUsd).toFixed(2)} USD (warn below ${cfg.warnCoinUsd} USD)`);

  if (!(state.coinUsd > 0) || !(state.usdcUsd > 0) || !(state.priceAge <= cfg.maxAge)) {
    notes.push(`${coin}: oracle price missing or stale (age ${state.priceAge ?? "?"} s, max ${cfg.maxAge}): nothing done`);
    return out;
  }
  if (!(Number(state.liquidity) > 0)) {
    notes.push(`${coin}: pool has no liquidity: nothing done`);
    return out;
  }
  const ref = state.coinUsd / state.usdcUsd;
  const p = poolPrice(state.sqrtPriceX96);
  const dev = p / ref - 1;
  Object.assign(out, { poolPrice: p, refPrice: ref, deviation: dev });
  notes.push(
    `${coin}: pool ${p.toPrecision(8)} USDC, reference ${ref.toPrecision(8)}, deviation ${(dev * 100).toFixed(3)}% ` +
      `(threshold ${(cfg.threshold * 100).toFixed(2)}%)`,
  );
  if (Math.abs(dev) <= cfg.threshold) {
    notes.push(`${coin}: inside the threshold: nothing done`);
    return out;
  }

  const want = swapToTarget(state.sqrtPriceX96, state.liquidity, ref);
  if (!want) return out;
  const name = want.sell === "COIN" ? coin : "USDC";
  let amountIn = want.netIn / (1 - state.feeBps / 10000);
  const inPrice = want.sell === "COIN" ? state.coinUsd : state.usdcUsd;
  const have = Math.max(0, want.sell === "COIN" ? state.walletCoin - (cfg.coinReserve ?? 0) : state.walletUsdc);
  const parts = [`${coin}: to reach the reference sell ${amountIn.toPrecision(8)} ${name}`];
  if (amountIn * inPrice > cfg.maxTradeUsd) {
    amountIn = cfg.maxTradeUsd / inPrice;
    parts.push(`capped at MAX_TRADE_USD ${cfg.maxTradeUsd} -> ${amountIn.toPrecision(8)}`);
  }
  if (amountIn > have) {
    amountIn = have;
    warnings.push(`inventory short: ${coin} pool wanted more ${name} than the ${have.toPrecision(8)} available`);
    parts.push(`limited by the inventory -> ${amountIn.toPrecision(8)}`);
  }
  notes.push(parts.join(", "));
  if (amountIn * inPrice < cfg.minTradeUsd) {
    notes.push(`${coin}: trade below MIN_TRADE_USD ${cfg.minTradeUsd}: nothing done`);
    return out;
  }
  out.action = { sell: want.sell, amountIn };
  return out;
}

/**
 * A swap toward the reference never pays worse than the reference less the fee. When the router's estimate is
 * worse than that (by more than `tolerance`), the pool is not where the decision assumed: do not send.
 * estimateOut in token units of the bought token.
 */
export function fairEnough(action, estimateOut, refPrice, feeBps, tolerance) {
  const fair = action.sell === "COIN" ? action.amountIn * refPrice : action.amountIn / refPrice;
  return estimateOut >= fair * (1 - feeBps / 10000) * (1 - tolerance);
}

/** Minimum output accepted for a swap: the router's estimate less the slippage allowance (raw units). */
export function minOut(estimate, slippage) {
  return BigInt(Math.floor(Number(estimate) * (1 - slippage)));
}
