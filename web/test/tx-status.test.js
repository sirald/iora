import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingAdd, pendingDrop, pendingParse, pendingTooOld, txVerdict } from "../src/tx-status.js";

const tx = { at: 1000, maxTime: 1180 };
const H = "a".repeat(64);

test("IORA-03: read errors are never a verdict", () => {
  assert.equal(txVerdict(null, tx), "pending");
  assert.equal(txVerdict(undefined, tx), "pending");
});

test("IORA-03: final answers from the network", () => {
  assert.equal(txVerdict({ status: "SUCCESS" }, tx), "success");
  assert.equal(txVerdict({ status: "FAILED" }, tx), "failed");
});

test("IORA-03: NOT_FOUND before the time bound has passed is still pending", () => {
  assert.equal(txVerdict({ status: "NOT_FOUND", latestLedgerCloseTime: "1100", oldestLedgerCloseTime: "500" }, tx), "pending");
  assert.equal(txVerdict({ status: "NOT_FOUND", latestLedgerCloseTime: "1180", oldestLedgerCloseTime: "500" }, tx), "pending");
});

test("IORA-03: NOT_FOUND after the time bound, with history reaching back, is expired", () => {
  assert.equal(txVerdict({ status: "NOT_FOUND", latestLedgerCloseTime: "1190", oldestLedgerCloseTime: "500" }, tx), "expired");
});

test("IORA-03: NOT_FOUND when the RPC history no longer covers the submission proves nothing", () => {
  assert.equal(txVerdict({ status: "NOT_FOUND", latestLedgerCloseTime: "99999", oldestLedgerCloseTime: "2000" }, tx), "pending");
  assert.equal(txVerdict({ status: "NOT_FOUND" }, tx), "pending");
  assert.equal(txVerdict({ status: "NOT_FOUND", latestLedgerCloseTime: "1190", oldestLedgerCloseTime: "500" }, { at: 1000, maxTime: 0 }), "pending");
});

test("IORA-03: the saved list survives a reload and drops malformed entries", () => {
  let list = pendingAdd([], { hash: H, label: "Swap", at: 1, maxTime: 2, wallet: "G" });
  list = pendingAdd(list, { hash: H, label: "Swap again", at: 3, maxTime: 4, wallet: "G" });
  assert.equal(list.length, 1);
  const back = pendingParse(JSON.stringify([...list, { hash: "nope", at: 1, maxTime: 1 }, null]));
  assert.deepEqual(back, [{ hash: H, label: "Swap again", at: 3, maxTime: 4, wallet: "G" }]);
  assert.deepEqual(pendingDrop(back, H), []);
  assert.deepEqual(pendingParse("{bad json"), []);
  assert.deepEqual(pendingParse(null), []);
});

test("very old entries are given up", () => {
  assert.equal(pendingTooOld({ at: 0 }, 8 * 24 * 3600), true);
  assert.equal(pendingTooOld({ at: 0 }, 3600), false);
});
