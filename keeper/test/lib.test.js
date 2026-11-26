// Tests of the keeper's pure logic (keeper/lib.js). No network, no Stellar SDK: `npm test`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import {
  FailureGuard,
  FeeBudget,
  RpcPicker,
  acquireLock,
  forgetOrder,
  inclusionFeeFrom,
  isBadSeq,
  pickSequence,
  pidAlive,
  releaseLock,
  rpcFailReason,
  rpcList,
  transientRpc,
  withinFeeCap,
  xlmToStroops,
} from "../lib.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iora-keeper-test-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const lockPath = (name) => path.join(tmp, `${name}.lock`);

describe("single-instance lock", () => {
  test("takes a free lock and writes its PID", () => {
    const f = lockPath("free");
    const l = acquireLock(f, { pid: 4242 });
    assert.equal(l.ok, true);
    assert.equal(fs.readFileSync(f, "utf8"), "4242");
    l.release();
    assert.equal(fs.existsSync(f), false);
  });

  test("refuses while the holder is alive", () => {
    const f = lockPath("held");
    fs.writeFileSync(f, "777");
    const l = acquireLock(f, { pid: 4242, isAlive: (p) => p === 777 });
    assert.deepEqual(l, { ok: false, pid: 777 });
    assert.equal(fs.readFileSync(f, "utf8"), "777"); // untouched
  });

  test("takes over a lock whose process is dead", () => {
    const f = lockPath("stale");
    fs.writeFileSync(f, "777");
    const l = acquireLock(f, { pid: 4242, isAlive: () => false });
    assert.equal(l.ok, true);
    assert.equal(fs.readFileSync(f, "utf8"), "4242");
  });

  test("takes over a lock naming its own PID (e.g. PID 1 in a container after a crash)", () => {
    const f = lockPath("self");
    fs.writeFileSync(f, "4242");
    const l = acquireLock(f, { pid: 4242, isAlive: () => true });
    assert.equal(l.ok, true);
  });

  test("a fresh lock with no PID yet is respected, an old one is taken over", () => {
    const f = lockPath("empty");
    fs.writeFileSync(f, "");
    const t = fs.statSync(f).mtimeMs;
    assert.deepEqual(acquireLock(f, { pid: 1, now: () => t + 1000 }), { ok: false, pid: null });
    assert.equal(acquireLock(f, { pid: 1, now: () => t + 60_000 }).ok, true);
  });

  test("release only removes the lock if it is still ours", () => {
    const f = lockPath("other");
    fs.writeFileSync(f, "999");
    releaseLock(f, 4242);
    assert.equal(fs.readFileSync(f, "utf8"), "999");
  });

  test("pidAlive: this process is alive, nonsense PIDs are not", () => {
    assert.equal(pidAlive(process.pid), true);
    assert.equal(pidAlive(0), false);
    assert.equal(pidAlive(-5), false);
    assert.equal(pidAlive(NaN), false);
  });
});

describe("on-chain failure guard", () => {
  const H = 3600_000;
  test("pauses after the threshold, for the pause time", () => {
    const g = new FailureGuard({ threshold: 3, pauseMs: 6 * H });
    assert.equal(g.record("v:1", 0).paused, false);
    assert.equal(g.record("v:1", 10).n, 2);
    const third = g.record("v:1", 20);
    assert.equal(third.paused, true);
    assert.equal(third.until, 20 + 6 * H);
    assert.equal(g.pausedUntil("v:1", 1000), 20 + 6 * H);
    assert.equal(g.pausedUntil("v:1", 20 + 6 * H + 1), 0);
    assert.equal(g.pausedCount(1000), 1);
  });

  test("failures far apart do not add up", () => {
    const g = new FailureGuard({ threshold: 3, pauseMs: H });
    g.record("k", 0);
    g.record("k", 10);
    assert.equal(g.record("k", 10 + 2 * H).n, 1);
  });

  test("keys are independent and clear() resets", () => {
    const g = new FailureGuard({ threshold: 2, pauseMs: H });
    g.record("a", 0);
    g.record("b", 0);
    g.clear("a");
    assert.equal(g.record("a", 1).paused, false);
    assert.equal(g.record("b", 1).paused, true);
  });
});

describe("fee budget", () => {
  test("hourly budget blocks and frees up after an hour", () => {
    const b = new FeeBudget({ perHour: 1000 });
    b.reserve(600, 0);
    assert.equal(b.blockReason(300, 10), null);
    assert.equal(b.blockReason(500, 10), "hourly fee budget");
    assert.equal(b.blockReason(500, 3600_001), null);
  });

  test("settle replaces the reservation with what was charged", () => {
    const b = new FeeBudget({ perHour: 1000 });
    const id = b.reserve(900, 0);
    b.settle(id, 100);
    assert.equal(b.spentLastHour(1), 100);
    const id2 = b.reserve(500, 2);
    b.settle(id2, 0); // not taken by the network: nothing paid
    assert.equal(b.spentLastHour(3), 100);
  });

  test("per-round budget resets each round", () => {
    const b = new FeeBudget({ perRound: 100 });
    b.reserve(80, 0);
    assert.equal(b.blockReason(30, 0), "per-round fee budget");
    b.startRound();
    assert.equal(b.blockReason(30, 0), null);
  });

  test("no limits means never blocked", () => {
    const b = new FeeBudget();
    b.reserve(1e12, 0);
    assert.equal(b.blockReason(1e12, 0), null);
  });
});

describe("fees", () => {
  test("xlmToStroops", () => {
    assert.equal(xlmToStroops("2"), 20_000_000);
    assert.equal(xlmToStroops(0.5), 5_000_000);
    assert.equal(xlmToStroops("abc", 7), 7);
    assert.equal(xlmToStroops(-1, 7), 7);
  });

  test("inclusion fee: percentile, base as the floor, max as the ceiling", () => {
    const stats = { sorobanInclusionFee: { p50: "120", p70: "350", mode: "100" } };
    assert.equal(inclusionFeeFrom(stats, { base: 100, percentile: "p70" }), 350);
    assert.equal(inclusionFeeFrom({ sorobanInclusionFee: { p70: "40" } }, { base: 100 }), 100);
    assert.equal(inclusionFeeFrom(stats, { base: 100, percentile: "p70", max: 200 }), 200);
    assert.equal(inclusionFeeFrom(null, { base: 100 }), 100);
    assert.equal(inclusionFeeFrom({ sorobanInclusionFee: { p70: "x" } }, { base: 100 }), 100);
    assert.equal(inclusionFeeFrom(stats, { base: 100, percentile: "p99" }), 120); // missing percentile: p50
  });

  test("fee cap", () => {
    assert.equal(withinFeeCap(20_000_000, 20_000_000), true);
    assert.equal(withinFeeCap("20000001", 20_000_000), false);
    assert.equal(withinFeeCap(1e12, 0), true);
  });

  test("bad sequence detection", () => {
    assert.equal(isBadSeq("txBadSeq"), true);
    assert.equal(isBadSeq("txBAD_SEQ"), true);
    assert.equal(isBadSeq("txInsufficientFee"), false);
    assert.equal(isBadSeq(undefined), false);
  });

  test("sequence: never below what this account already used", () => {
    assert.equal(pickSequence("100", undefined), 100n);
    assert.equal(pickSequence("100", "105"), 105n);
    assert.equal(pickSequence("110", "105"), 110n);
  });
});

describe("RPC", () => {
  test("list: primary, comma-separated fallbacks, extras, no duplicates", () => {
    assert.deepEqual(rpcList("https://a", " https://b ,https://c,,https://a", ["https://c", "https://d"]), [
      "https://a",
      "https://b",
      "https://c",
      "https://d",
    ]);
    assert.deepEqual(rpcList(undefined, undefined, []), []);
  });

  test("failure reason: HTTP code, timeout or the network error", () => {
    assert.equal(rpcFailReason({ response: { status: 503 }, message: "x" }), "HTTP 503");
    assert.match(rpcFailReason(new Error("the RPC did not answer within 12000 ms")), /^timeout/);
    assert.match(rpcFailReason(new Error("fetch failed (ETIMEDOUT)")), /^timeout/);
    assert.equal(rpcFailReason(new Error("fetch failed (ECONNREFUSED)")), "fetch failed (ECONNREFUSED)");
  });

  test("transient errors are retried elsewhere, contract errors are not", () => {
    assert.equal(transientRpc({ response: { status: 429 } }), true);
    assert.equal(transientRpc({ response: { status: 502 } }), true);
    assert.equal(transientRpc(new Error("preflight queue full; retry later")), true);
    assert.equal(transientRpc(new Error("fetch failed")), true);
    assert.equal(transientRpc({ response: { status: 400 } }), false);
    assert.equal(transientRpc(new Error("HostError: Error(Contract, #8)")), false);
  });

  test("picker: stays on the fallback until the back-off ends", () => {
    const p = new RpcPicker(3, { baseMs: 60_000, maxMs: 30 * 60_000 });
    assert.deepEqual(p.order(0), [0, 1, 2]);
    p.failure(0, "timeout", 0);
    assert.equal(p.success(1), "switched");
    assert.deepEqual(p.order(30_000), [1, 2, 0]); // first server not retried yet
    assert.deepEqual(p.order(60_000), [0, 1, 2]); // retried after 1 min
    assert.equal(p.success(0), "primary");
    assert.equal(p.consecutiveErrors, 0);
  });

  test("picker: back-off doubles while the first server keeps failing, up to the max", () => {
    const p = new RpcPicker(2, { baseMs: 60_000, maxMs: 8 * 60_000 });
    let t = 0;
    const waits = [];
    for (let i = 0; i < 6; i++) {
      p.failure(0, "timeout", t);
      p.success(1);
      waits.push(p.retryAt - t);
      t = p.retryAt; // the retry happens and fails again
    }
    assert.deepEqual(waits, [60_000, 120_000, 240_000, 480_000, 480_000, 480_000]);
  });

  test("picker: a flapping first server keeps its back-off; a long quiet period resets it", () => {
    const p = new RpcPicker(2, { baseMs: 60_000, maxMs: 8 * 60_000 });
    p.failure(0, "timeout", 0);
    p.success(1);
    p.success(0); // back on the first server at 1 min ...
    p.failure(0, "HTTP 503", 2 * 60_000); // ... and it fails again soon after
    assert.equal(p.retryAt - 2 * 60_000, 120_000);
    p.success(1);
    p.success(0);
    p.failure(0, "timeout", 3 * 3600_000); // hours later: from the bottom again
    assert.equal(p.retryAt - 3 * 3600_000, 60_000);
  });

  test("picker: counts consecutive errors on any server and keeps the last reason", () => {
    const p = new RpcPicker(2);
    p.failure(0, "a timeout", 0);
    p.failure(1, "b HTTP 502", 0);
    assert.equal(p.consecutiveErrors, 2);
    assert.equal(p.lastError, "1: b HTTP 502");
  });
});

describe("memory", () => {
  test("forgetOrder removes the order's own, venue and cross-pair entries only", () => {
    const k = "CV1:3";
    const stuck = new Map([
      [k, 1],
      [`x:${k}|CV2:1`, 1],
      [`x:CV0:9|${k}`, 1],
      ["x:CV1:30|CV2:1", 1], // another order whose id starts the same
      ["CV1:30", 1],
    ]);
    const notes = new Map([
      [k, 1],
      [`venue:${k}`, 1],
    ]);
    const closed = new Set([k, "CV1:4"]);
    forgetOrder(k, [stuck, notes, closed, null]);
    assert.deepEqual([...stuck.keys()], ["x:CV1:30|CV2:1", "CV1:30"]);
    assert.equal(notes.size, 0);
    assert.deepEqual([...closed], ["CV1:4"]);
  });
});
