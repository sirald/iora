// Pure helpers for following a submitted transaction (no DOM, no network), so they can be tested (audit IORA-03).
// A read error or "not found yet" is never taken as proof that a transaction was not applied.

const HASH = /^[0-9a-f]{64}$/;
export const PENDING_MAX_AGE = 7 * 24 * 3600; // seconds; after that an entry is given up (with a link to check by hand)

/**
 * The verdict for one getTransaction answer `r` (null = the read failed) of a transaction submitted at `at` with
 * time bound `maxTime` (both unix seconds):
 *   "success" | "failed"  - final, as the network says;
 *   "expired"             - final: the network's latest ledger closed after maxTime, and the RPC's history reaches
 *                           back to before the submission, yet the transaction is not in it, so it can never apply;
 *   "pending"             - anything else: the outcome is unknown, and a retry could double the operation.
 */
export function txVerdict(r, { at, maxTime }) {
  if (!r || typeof r !== "object") return "pending";
  if (r.status === "SUCCESS") return "success";
  if (r.status === "FAILED") return "failed";
  if (r.status !== "NOT_FOUND") return "pending";
  const latest = Number(r.latestLedgerCloseTime);
  const oldest = Number(r.oldestLedgerCloseTime);
  if (!(maxTime > 0) || !(at > 0) || !Number.isFinite(latest) || !Number.isFinite(oldest)) return "pending";
  return latest > maxTime && oldest <= at ? "expired" : "pending";
}

/** Reads the saved list (from localStorage text); anything malformed is dropped. */
export function pendingParse(text) {
  let v;
  try {
    v = JSON.parse(text || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  return v.filter((p) => p && HASH.test(p.hash) && Number.isFinite(p.at) && Number.isFinite(p.maxTime)).map((p) => ({ hash: p.hash, label: String(p.label || "Transaction").slice(0, 200), at: p.at, maxTime: p.maxTime, wallet: typeof p.wallet === "string" ? p.wallet : null }));
}

export const pendingAdd = (list, item) => [...list.filter((p) => p.hash !== item.hash), item].slice(-20);
export const pendingDrop = (list, hash) => list.filter((p) => p.hash !== hash);
/** Entries older than PENDING_MAX_AGE can no longer be settled from RPC history. */
export const pendingTooOld = (p, now) => now - p.at > PENDING_MAX_AGE;
