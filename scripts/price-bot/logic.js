// Pure decision logic of the Iora price bot (no network). Amounts are in token units (1 USDC = 1.0, 1 XLM = 1.0),
// prices in USDC per XLM unless said otherwise.
//
// The pool is an Aquarius concentrated pool with full-range liquidity (testnet/ref-pool.env), token 0 = USDC,
// token 1 = XLM, both 7 decimals. Inside one price range it follows the Uniswap v3 formulas, with
// s = sqrt(XLM per USDC) and L = active liquidity: adding dx XLM (net of the fee) raises s by dx / L, adding du USDC
// raises 1/s by du / L. With full-range liquidity only this is the constant-product pool x * y = L^2.

const Q96 = 2 ** 96;

/** Pool price in USDC per XLM from slot0's sqrt_price_x96 (token1 per token0 = XLM per USDC). */
export function poolPrice(sqrtPriceX96) {
  const s = Number(sqrtPriceX96) / Q96;
  return 1 / (s * s);
}

/**
 * The swap (net of the pool fee) that moves the pool price to `target` USDC per XLM, for liquidity L (raw units,
 * 1e7 per token unit). Returns { sell: "XLM" | "USDC", netIn } in token units, or null when already there.
 */
export function swapToTarget(sqrtPriceX96, liquidity, target) {
  const s = Number(sqrtPriceX96) / Q96;
  const L = Number(liquidity) / 1e7;
  if (!(L > 0) || !(target > 0) || !(s > 0)) return null;
  const sT = Math.sqrt(1 / target);
  if (sT > s) return { sell: "XLM", netIn: L * (sT - s) }; // pool price above target: XLM in
  if (sT < s) return { sell: "USDC", netIn: L * (1 / sT - 1 / s) }; // pool price below target: USDC in
  return null;
}

/**
 * Decides one run.
 * state: {
 *   sqrtPriceX96, liquidity,  the pool's slot0 price and active liquidity (raw)
 *   feeBps,                   the pool fee (30 = 0.3%)
 *   xlmUsd, usdcUsd,          oracle prices in USD (null when missing)
 *   priceAge,                 seconds since the older of the two oracle prices
 *   walletUsdc, walletXlm     the bot's balances
 * }
 * cfg: { threshold, maxAge, maxTradeUsd, minTradeUsd, xlmReserve, warnUsdc, warnXlm }
 * Returns { action: null | { sell, buy, amountIn }, notes, warnings, poolPrice, refPrice, deviation }.
 */
export function decide(state, cfg) {
  const notes = [];
  const warnings = [];
  const out = { action: null, notes, warnings, poolPrice: NaN, refPrice: NaN, deviation: NaN };

  if (state.walletUsdc < cfg.warnUsdc) warnings.push(`inventory low: ${state.walletUsdc.toFixed(4)} USDC (warn below ${cfg.warnUsdc})`);
  if (state.walletXlm < cfg.warnXlm) warnings.push(`inventory low: ${state.walletXlm.toFixed(4)} XLM (warn below ${cfg.warnXlm})`);

  if (!(state.xlmUsd > 0) || !(state.usdcUsd > 0) || !(state.priceAge <= cfg.maxAge)) {
    notes.push(`oracle price missing or stale (age ${state.priceAge ?? "?"} s, max ${cfg.maxAge}): nothing done`);
    return out;
  }
  if (!(Number(state.liquidity) > 0)) {
    notes.push("pool has no active liquidity: nothing done");
    return out;
  }
  const ref = state.xlmUsd / state.usdcUsd;
  const p = poolPrice(state.sqrtPriceX96);
  const dev = p / ref - 1;
  Object.assign(out, { poolPrice: p, refPrice: ref, deviation: dev });
  notes.push(
    `pool ${p.toFixed(7)} USDC/XLM, reference ${ref.toFixed(7)}, deviation ${(dev * 100).toFixed(3)}% ` +
      `(threshold ${(cfg.threshold * 100).toFixed(2)}%)`,
  );
  if (Math.abs(dev) <= cfg.threshold) {
    notes.push("inside the threshold: nothing done");
    return out;
  }

  const want = swapToTarget(state.sqrtPriceX96, state.liquidity, ref);
  if (!want) return out;
  const fee = state.feeBps / 10000;
  let amountIn = want.netIn / (1 - fee);
  const inPrice = want.sell === "XLM" ? state.xlmUsd : state.usdcUsd;
  const have = Math.max(0, want.sell === "XLM" ? state.walletXlm - cfg.xlmReserve : state.walletUsdc);
  const parts = [`to reach the reference: sell ${amountIn.toFixed(4)} ${want.sell}`];
  if (amountIn * inPrice > cfg.maxTradeUsd) {
    amountIn = cfg.maxTradeUsd / inPrice;
    parts.push(`capped at MAX_TRADE_USD ${cfg.maxTradeUsd} -> ${amountIn.toFixed(4)}`);
  }
  if (amountIn > have) {
    amountIn = have;
    warnings.push(`inventory short: wanted to sell more ${want.sell} than the ${have.toFixed(4)} available`);
    parts.push(`limited by the inventory -> ${amountIn.toFixed(4)}`);
  }
  notes.push(parts.join(", "));
  if (amountIn * inPrice < cfg.minTradeUsd) {
    notes.push(`trade below MIN_TRADE_USD ${cfg.minTradeUsd}: nothing done`);
    return out;
  }
  out.action = { sell: want.sell, buy: want.sell === "XLM" ? "USDC" : "XLM", amountIn };
  return out;
}

/**
 * A swap toward the reference never pays worse than the reference less the fee. When the router's estimate is
 * worse than that (by more than `tolerance`), the pool is not where the decision assumed: do not send.
 * estimateOut in token units of the bought token.
 */
export function fairEnough(action, estimateOut, refPrice, feeBps, tolerance) {
  const fair = action.sell === "XLM" ? action.amountIn * refPrice : action.amountIn / refPrice;
  return estimateOut >= fair * (1 - feeBps / 10000) * (1 - tolerance);
}

/** Minimum output accepted for a swap: the router's estimate less the slippage allowance (raw units). */
export function minOut(estimate, slippage) {
  return BigInt(Math.floor(Number(estimate) * (1 - slippage)));
}
