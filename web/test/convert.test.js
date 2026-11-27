import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const cv = createRequire(import.meta.url)("../api/_convert-lib.cjs");
const ME = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"; // any valid G address
const OLD = cv.OLD_USDC_ISSUER;
const now = Date.parse("2026-11-27T12:00:00Z");
const tx = (o = {}) => ({ successful: true, source_account: ME, created_at: "2026-11-27T11:30:00Z", ...o });
const burnOp = (o = {}) => ({ type: "payment", asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: OLD, from: ME, to: OLD, amount: "123.4567890", ...o });
const opts = { address: ME, now };

test("a burn to the issuer is read with all 7 decimals", () => {
  assert.deepEqual(cv.burnOf(tx(), [burnOp()], opts), { amount: "123.456789" });
  assert.deepEqual(cv.burnOf(tx(), [burnOp({ amount: "0.0000001" })], opts), { amount: "0.0000001" });
  assert.deepEqual(cv.burnOf(tx(), [burnOp({ amount: "10" }), burnOp({ amount: "5.5" })], opts), { amount: "15.5" });
});

test("rejected transactions", () => {
  assert.equal(cv.burnOf(null, [], opts).error, "tx_not_found");
  assert.equal(cv.burnOf(tx({ successful: false }), [burnOp()], opts).error, "tx_failed");
  assert.equal(cv.burnOf(tx({ source_account: OLD }), [burnOp()], opts).error, "tx_not_yours");
  assert.equal(cv.burnOf(tx({ created_at: "2026-11-27T10:59:00Z" }), [burnOp()], opts).error, "tx_too_old");
  assert.equal(cv.burnOf(tx({ created_at: "2026-11-27T10:59:00Z" }), [burnOp()], { ...opts, maxAge: Infinity }).amount, "123.456789");
  assert.equal(cv.burnOf(tx({ created_at: "garbage" }), [burnOp()], opts).error, "tx_too_old");
});

test("only payments of the old USDC from the wallet to its issuer count", () => {
  const no = (op) => assert.equal(cv.burnOf(tx(), [op], opts).error, "no_burn");
  no(burnOp({ to: "GOTHER" })); // a transfer, not a burn
  no(burnOp({ asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" })); // Circle USDC
  no(burnOp({ asset_code: "EURC" }));
  no(burnOp({ asset_type: "native", asset_code: undefined }));
  no(burnOp({ from: "GSOMEONEELSE" }));
  no(burnOp({ type: "path_payment_strict_receive" }));
  no(burnOp({ amount: "0" }));
  assert.equal(cv.burnOf(tx(), [], opts).error, "no_burn");
});

test("per-wallet cap", () => {
  const cap = cv.convertCap({});
  assert.equal(cap, 5000n * 10_000_000n);
  assert.equal(cv.convertCap({ CONVERT_MAX_PER_WALLET: "100.5" }), 1005000000n);
  assert.throws(() => cv.convertCap({ CONVERT_MAX_PER_WALLET: "0" }));
  assert.throws(() => cv.convertCap({ CONVERT_MAX_PER_WALLET: "abc" }));
  assert.equal(cv.underCap(0n, "5000", cap), true);
  assert.equal(cv.underCap(0n, "5000.0000001", cap), false);
  assert.equal(cv.underCap(4000n * 10_000_000n, "1000", cap), true);
  assert.equal(cv.underCap(4000n * 10_000_000n, "1000.1", cap), false);
});

test("each burn is paid once; a retry is answered or paid again only when safe", () => {
  assert.equal(cv.retryDecision(null, null, now), "new");
  assert.equal(cv.retryDecision({ status: "done" }, null, now), "done");
  assert.equal(cv.retryDecision({ status: "failed" }, null, now), "resend");
  assert.equal(cv.retryDecision({ status: "claimed" }, null, now), "resend");
  const sending = { status: "sending", maxTime: now / 1000 - 10 };
  assert.equal(cv.retryDecision(sending, "success", now), "done");
  assert.equal(cv.retryDecision(sending, "failed", now), "resend");
  assert.equal(cv.retryDecision(sending, null, now), "wait"); // Horizon unreadable: unknown
  assert.equal(cv.retryDecision(sending, "missing", now), "wait"); // not 30 s past its time bound yet
  assert.equal(cv.retryDecision({ ...sending, maxTime: now / 1000 - 60 }, "missing", now), "resend");
});

test("hash format", () => {
  assert.equal(cv.validHash("a".repeat(64)), true);
  assert.equal(cv.validHash("A".repeat(64)), false);
  assert.equal(cv.validHash("a".repeat(63)), false);
});
