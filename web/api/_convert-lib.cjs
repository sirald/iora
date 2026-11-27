// Pure logic of the old-test-USDC exchange (api/convert.js): no network, no store, no keys, so it can be tested.
// A wallet pays Blend's old test USDC back to its issuer (that burns it); the function then sends the same amount of
// Circle's test USDC from the faucet account. The leading "_" keeps Vercel from serving this file as an endpoint.
const { toStroops, fromStroops } = require("./_faucet-lib.cjs");

const OLD_USDC_ISSUER = "GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56";
const MAX_AGE = 3600 * 1000; // a burn is exchanged within one hour
const HASH = /^[0-9a-f]{64}$/;
const validHash = (h) => typeof h === "string" && HASH.test(h);

/** The per-wallet cap from CONVERT_MAX_PER_WALLET (default 5000 USDC), in stroops. Throws if invalid. */
function convertCap(env) {
  const raw = env && env.CONVERT_MAX_PER_WALLET !== undefined && String(env.CONVERT_MAX_PER_WALLET).trim() !== "" ? env.CONVERT_MAX_PER_WALLET : "5000";
  const n = toStroops(raw);
  if (n === null || n <= 0n) throw new Error("CONVERT_MAX_PER_WALLET must be a positive number");
  return n;
}

/**
 * Reads the burn out of a Horizon transaction (`tx`: /transactions/<hash>) and its operations (`ops`: the records of
 * /transactions/<hash>/operations). The burn is every payment of USDC:<issuer> from `address` to the issuer.
 * Returns { amount: "<7-decimal string>" } or { error }.
 */
function burnOf(tx, ops, { address, issuer = OLD_USDC_ISSUER, now = Date.now(), maxAge = MAX_AGE }) {
  if (!tx || typeof tx !== "object") return { error: "tx_not_found" };
  if (tx.successful !== true) return { error: "tx_failed" };
  if (tx.source_account !== address) return { error: "tx_not_yours" };
  const at = Date.parse(tx.created_at);
  if (!Number.isFinite(at) || now - at > maxAge) return { error: "tx_too_old" };
  if (at - now > 5 * 60 * 1000) return { error: "tx_too_old" }; // clock nonsense
  let sum = 0n;
  for (const op of Array.isArray(ops) ? ops : []) {
    if (op.type !== "payment" || op.transaction_successful === false) continue;
    if (op.asset_type === "native" || op.asset_code !== "USDC" || op.asset_issuer !== issuer) continue;
    if (op.to !== issuer || op.from !== address) continue;
    const a = toStroops(op.amount);
    if (a === null || a <= 0n) continue;
    sum += a;
  }
  if (sum <= 0n) return { error: "no_burn" };
  return { amount: fromStroops(sum) };
}

/** Would `amount` keep the wallet's total under the cap? `total` and `cap` in stroops. */
const underCap = (total, amount, cap) => BigInt(total || 0) + toStroops(amount) <= BigInt(cap);

/**
 * What to do with a burn hash, given its record ({ status: "sending" | "done" | "failed", payHash, maxTime }) and the
 * state of the faucet payment it names ("success" | "failed" | "missing" | null when unknown):
 *   "new"    never seen: claim it and pay;
 *   "done"   already paid: answer with the earlier payment (so a retry after a lost answer is harmless);
 *   "resend" the earlier payment certainly did not apply (rejected, or expired without being in the ledger): pay again;
 *   "wait"   the earlier payment may still apply: ask the client to retry later.
 */
function retryDecision(rec, payState, now = Date.now()) {
  if (!rec) return "new";
  if (rec.status === "done") return "done";
  if (rec.status === "failed" || rec.status === "claimed") return "resend"; // claimed: no payment was built yet
  if (payState === "success") return "done";
  if (payState === "failed") return "resend";
  if (payState === "missing" && Number.isFinite(rec.maxTime) && now > rec.maxTime * 1000 + 30_000) return "resend";
  return "wait";
}

module.exports = { OLD_USDC_ISSUER, MAX_AGE, validHash, convertCap, burnOf, underCap, retryDecision };
