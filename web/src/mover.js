// Pure planning for the one-approval vault move (iora-mover `move_vault`), no DOM, no network, no SDK, so it can be
// tested on its own. Follows scripts/move-vault.mjs (the reference builder). Arguments are returned as typed values
// ([type, value]) that the app turns into ScVals: ["addr", "C…"], ["i128", 5n], ["u32", 3], ["u64", 9n], ["bool", true].

export const MAX_FILLS = 20n; // a new order may need at most this many fills (vault rule)
export const ROUNDING_BUFFER = 10_000n; // 0.001: held back from orders on a token supplied to Blend
export const SAFETY = 10n; // a few stroops for Blend's rounding on withdraw / supply
export const EXPIRY_MARGIN = 120; // seconds: an order that ends sooner is only cancelled (it would expire on the way)
export const PART = { coins: 4, orders: 6 }; // recommended most per transaction

const big = (v) => BigInt(v ?? 0);
const isOpen = (o) => !!o && (o.status === "Open" || (Array.isArray(o.status) && o.status[0] === "Open") || (o.status && o.status.tag === "Open"));

/** min_fill of a placed-again order: its old one (at most the amount), but never more than MAX_FILLS pieces. */
export function minFillFor(rem, oldMin) {
  const lo = (rem - 1n) / MAX_FILLS + 1n;
  const m = big(oldMin) < rem ? big(oldMin) : rem;
  return m > lo ? m : lo;
}

/**
 * The plan of one move.
 *   balances  { token: bigint }  the old vault's balances now (only > 0 are moved)
 *   orders    [{ id, order, schedule, followUp }]  every order of the old vault (raw get_order values)
 *   exchange  null | { mock, usdc, left }  the on-chain exchange; mock USDC is exchanged up to `left`
 *   withOrders false: every open order is only cancelled
 * Returns { coins: [[token, amount]], cancel: [id], place: [{ id, func, args, sell, buy, amount }],
 *           skipped: [{ id, why }], mockLeftInWallet: bigint }.
 */
export function planMove({ balances, orders, exchange = null, now, version = 14, withOrders = true }) {
  const coins = Object.entries(balances)
    .map(([t, b]) => [t, big(b)])
    .filter(([, b]) => b > 0n);
  const inNew = (t) => (exchange && t === exchange.mock ? exchange.usdc : t);
  let mockLeftInWallet = 0n;
  // What will arrive in the new vault per token, minus Blend's buffer and rounding: the most its orders may reserve.
  const room = {};
  for (const [t, b] of coins) {
    let n = b;
    if (exchange && t === exchange.mock) {
      const left = big(exchange.left) > 0n ? big(exchange.left) : 0n;
      if (n > left) {
        mockLeftInWallet = n - left;
        n = left;
      }
    }
    room[inNew(t)] = (room[inNew(t)] ?? 0n) + n - ROUNDING_BUFFER - SAFETY;
  }
  const cancel = [], place = [], skipped = [];
  for (const { id, order: o, schedule: sch, followUp: fol } of orders) {
    if (!isOpen(o)) continue;
    cancel.push(id);
    if (!withOrders) {
      skipped.push({ id, why: "moved without orders" });
      continue;
    }
    if (Number(o.expiry) <= now + EXPIRY_MARGIN) {
      skipped.push({ id, why: "it expires within two minutes" });
      continue;
    }
    const sell = inNew(String(o.sell)), buy = inNew(String(o.buy));
    let rem = big(o.amount_in) - big(o.filled_in);
    const dca = version >= 11 && sch ? sch : null;
    if (dca) rem = big(dca.part);
    const r = room[sell] ?? 0n;
    if (rem > r) rem = r;
    if (rem <= 0n) {
      skipped.push({ id, why: "nothing left to sell for it in the new vault" });
      continue;
    }
    const mf = minFillFor(rem, o.min_fill);
    let func, args;
    if (dca) {
      const fillsLeft = Number(dca.fills) === 0 ? 0 : Number(dca.fills) - Number(dca.done);
      if (Number(dca.fills) !== 0 && fillsLeft <= 0) {
        skipped.push({ id, why: "its plan is finished" });
        continue;
      }
      func = "place_dca";
      args = [["addr", sell], ["addr", buy], ["i128", rem], ["u32", fillsLeft], ["u64", big(dca.every)], ["i128", big(o.limit_price)], ["u32", Number(o.max_impact_bps)], ["u32", Number(o.stop_band_bps || 0)], ["u64", big(o.expiry)], ["bool", o.keep !== false]];
    } else if (fol) {
      func = "place_order_then";
      args = [["addr", sell], ["addr", buy], ["i128", rem], ["i128", big(o.limit_price)], ["i128", mf], ["u32", Number(o.max_impact_bps)], ["u64", big(o.expiry)], ["i128", big(fol.limit_price)], ["u32", Number(fol.max_impact_bps)], ["u64", big(fol.duration)]];
    } else if (big(o.trigger_price) > 0n) {
      func = "place_stop_order";
      args = [["addr", sell], ["addr", buy], ["i128", rem], ["i128", big(o.trigger_price)], ["i128", big(o.limit_price)], ["i128", mf], ["u32", Number(o.max_impact_bps)], ["u64", big(o.expiry)], ["u32", Number(o.stop_band_bps || 0)], ["bool", o.keep !== false]];
    } else {
      func = "place_order";
      args = [["addr", sell], ["addr", buy], ["i128", rem], ["i128", big(o.limit_price)], ["i128", mf], ["u32", Number(o.max_impact_bps)], ["u64", big(o.expiry)], ["bool", o.keep !== false]];
    }
    room[sell] = r - rem;
    place.push({ id, func, args, sell, buy, amount: rem, limit: big(o.limit_price) });
  }
  return { coins, cancel, place, skipped, mockLeftInWallet };
}

/** Byte-wise comparison of two 32-byte ids. */
const cmp = (a, b) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};
/** Soroban map keys must ascend: contract addresses order by their 32-byte id (`idOf`: StrKey.decodeContract). */
export const sortCoins = (coins, idOf) => [...coins].sort(([a], [b]) => cmp(idOf(a), idOf(b)));

/**
 * Splits a plan into transactions of at most `max.coins` coins and `max.orders` orders. Every cancel goes in the
 * first part (a reserved balance cannot be withdrawn). An order goes in the part where the coin it sells arrives
 * (`inNew` maps an old token to the token it becomes) or later, so the new vault already holds what it reserves.
 */
export function splitPlan(plan, max = PART, inNew = (t) => t) {
  const coinPart = {};
  const parts = [];
  const at = (k) => (parts[k] ??= { coins: [], cancel: [], place: [] });
  plan.coins.forEach((c, i) => {
    const k = Math.floor(i / max.coins);
    at(k).coins.push(c);
    const t = inNew(c[0]);
    coinPart[t] = Math.min(coinPart[t] ?? Infinity, k);
  });
  at(0).cancel = [...plan.cancel];
  for (const p of plan.place) {
    let k = coinPart[p.sell] ?? 0;
    while (at(k).place.length >= max.orders) k++;
    at(k).place.push(p);
  }
  return parts.filter((p, i) => i === 0 || p.coins.length || p.place.length);
}

// ---- Old two-vault design (order-vault, any generation): iora-mover 2 `move_order_vault` ----
export const BAND_DEFAULT = 200; // stop band for an old triggered order that had none (order-vault generation 2)

/**
 * The plan of one `move_order_vault` call, as scripts/move-vault.mjs builds it.
 *   cfg       the old vault's get_config: { owner, usdc, xlm } (usdc = the coin it holds, xlm = the coin its orders buy)
 *   amount    balance() now (fixed in the call: the signature covers every argument)
 *   orders    [{ id, order, followUp }]  raw get_order / get_follow_up values (open ones count; followUp null in G1)
 *   exchange  null | { mock, usdc, left }  the on-chain exchange; mock USDC becomes Circle USDC up to `left`
 *   keep      true: the output of an order moved here stays in the new vault (the old vault sent it to the wallet)
 * Prices need no change: an old order's limit is the most of its vault's coin paid for 1 of the other coin, the same
 * unit as the new vault's (sell token paid per 1 buy token); a follow-up's limit likewise for the reverse order.
 * Returns { amount, coin, other, sell, buy, convert, cancel, place: [{ id, func, args, sell, buy, amount, limit }],
 *           skipped: [{ id, why }], mockLeftInWallet }.
 */
export function planOrderVaultMove({ cfg, amount, orders, exchange = null, now, withOrders = true, keep = true, band = BAND_DEFAULT }) {
  const coin = String(cfg.usdc), other = String(cfg.xlm);
  amount = big(amount);
  const convert = !!exchange && (coin === exchange.mock || other === exchange.mock);
  const inNew = (t) => (convert && t === exchange.mock ? exchange.usdc : t);
  const sell = inNew(coin), buy = inNew(other);
  let arrive = amount, mockLeftInWallet = 0n;
  if (convert && coin === exchange.mock) {
    const left = big(exchange.left) > 0n ? big(exchange.left) : 0n;
    if (arrive > left) {
      mockLeftInWallet = arrive - left;
      arrive = left;
    }
  }
  let room = arrive - ROUNDING_BUFFER - SAFETY;
  const cancel = [], place = [], skipped = [];
  for (const { id, order: o, followUp: fol } of orders) {
    if (!isOpen(o)) continue;
    cancel.push(id);
    if (!withOrders) {
      skipped.push({ id, why: "moved without orders" });
      continue;
    }
    if (Number(o.expiry) <= now + EXPIRY_MARGIN) {
      skipped.push({ id, why: "it expires within two minutes" });
      continue;
    }
    let rem = big(o.amount_in) - big(o.filled_in);
    if (rem > room) rem = room;
    if (rem <= 0n) {
      skipped.push({ id, why: "nothing left to sell for it in the new vault" });
      continue;
    }
    room -= rem;
    const mf = minFillFor(rem, o.min_fill);
    let func, args;
    if (fol) {
      func = "place_order_then";
      args = [["addr", sell], ["addr", buy], ["i128", rem], ["i128", big(o.limit_price)], ["i128", mf], ["u32", Number(o.max_impact_bps)], ["u64", big(o.expiry)], ["i128", big(fol.limit_price)], ["u32", Number(fol.max_impact_bps)], ["u64", big(fol.duration)]];
    } else if (big(o.trigger_price) > 0n) {
      func = "place_stop_order";
      args = [["addr", sell], ["addr", buy], ["i128", rem], ["i128", big(o.trigger_price)], ["i128", big(o.limit_price)], ["i128", mf], ["u32", Number(o.max_impact_bps)], ["u64", big(o.expiry)], ["u32", Number(o.stop_band_bps || 0) || band], ["bool", !!keep]];
    } else {
      func = "place_order";
      args = [["addr", sell], ["addr", buy], ["i128", rem], ["i128", big(o.limit_price)], ["i128", mf], ["u32", Number(o.max_impact_bps)], ["u64", big(o.expiry)], ["bool", !!keep]];
    }
    place.push({ id, func, args, sell, buy, amount: rem, limit: big(o.limit_price) });
  }
  return { amount, coin, other, sell, buy, convert, cancel, place, skipped, mockLeftInWallet };
}

/**
 * Several old vaults of one wallet (an old buy vault and an old sell vault, maybe of several generations): one
 * `move_order_vault` call each, one after the other (a Soroban transaction carries one call). The exchange's
 * per-wallet allowance is shared, so each plan sees what the ones before it used. `vaults`: [{ id, cfg, amount, orders }].
 */
export function planOrderVaultMoves(vaults, { exchange = null, ...opts }) {
  let left = exchange ? big(exchange.left) : 0n;
  return vaults.map((v) => {
    const plan = planOrderVaultMove({ ...opts, ...v, exchange: exchange ? { ...exchange, left } : null });
    if (plan.convert && plan.coin === exchange.mock) left -= plan.amount - plan.mockLeftInWallet;
    return { id: v.id, ...plan };
  });
}
