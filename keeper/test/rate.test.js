// Tests of the RPC rate limiting and the adaptive scan interval (keeper/lib.js). No network.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Aimd, RpcUsage, TokenBucket, isNear, isRateLimited, limitRatio, retryAfterMs, rpsList, scanIntervalMs } from "../lib.js";

describe("RPC_MAX_RPS list", () => {
  test("one value for all, a list per server, the last value repeats, bad values fall back", () => {
    assert.deepEqual(rpsList("", 3, 4), [4, 4, 4]);
    assert.deepEqual(rpsList(undefined, 2, 4), [4, 4]);
    assert.deepEqual(rpsList("6", 3, 4), [6, 6, 6]);
    assert.deepEqual(rpsList("6, 10", 3, 4), [6, 10, 10]);
    assert.deepEqual(rpsList("x,-1,0", 2, 4), [4, 4]);
    assert.deepEqual(rpsList("0.5", 1, 4), [0.5]);
  });
});

describe("token bucket", () => {
  test("a burst goes out at once, then requests are spaced at the rate, in order", () => {
    const b = new TokenBucket(4, 2, 0);
    assert.equal(b.take(0), 0);
    assert.equal(b.take(0), 0);
    assert.equal(b.take(0), 250); // 3rd waits 1/4 s
    assert.equal(b.take(0), 500); // 4th waits behind it
  });

  test("tokens refill with time, up to the burst", () => {
    const b = new TokenBucket(2, 2, 0);
    b.take(0);
    b.take(0);
    assert.equal(b.take(500), 0); // one token back after 0.5 s at 2/s
    assert.equal(b.take(10_000), 0);
    assert.equal(b.take(10_000), 0);
    assert.equal(b.take(10_000), 500); // no more than the burst saved up
  });

  test("a lower rate spaces requests further apart", () => {
    const b = new TokenBucket(4, 1, 0);
    b.take(0);
    b.setRate(1, 0);
    assert.equal(b.take(0), 1000);
  });

  test("drain: nothing before the pause ends, then spaced (no burst)", () => {
    const b = new TokenBucket(2, 4, 0);
    b.drain(3000);
    assert.equal(b.take(0), 3500); // pause, then one token at 2/s
    assert.equal(b.take(100), 3900); // the next one 0.5 s later
    assert.equal(b.take(5000), 0); // long after: back to normal
  });
});

describe("AIMD", () => {
  test("a 429 halves the rate, not below the minimum", () => {
    const a = new Aimd(4, { min: 0.5, stepPerSec: 0.1, holdMs: 30_000 });
    assert.equal(a.cut(0), 2);
    assert.equal(a.cut(2000), 1);
    assert.equal(a.cut(4000), 0.5);
    assert.equal(a.cut(6000), 0.5);
  });

  test("several 429s within one second count once", () => {
    const a = new Aimd(4, { min: 0.5 });
    a.cut(0);
    assert.equal(a.cut(300), 2);
    assert.equal(a.cut(900), 2);
  });

  test("the rate holds after a cut, then grows back slowly to the maximum", () => {
    const a = new Aimd(4, { min: 0.5, stepPerSec: 0.1, holdMs: 30_000 });
    a.cut(0); // 2/s
    assert.equal(a.rate(20_000), 2); // still holding
    assert.ok(Math.abs(a.rate(40_000) - 3) < 1e-9); // 10 s of growth at 0.1/s
    assert.equal(a.rate(1_000_000), 4); // capped at the maximum
  });
});

describe("Retry-After", () => {
  const err = (headers, status = 429) => ({ response: { status, headers } });
  test("seconds, from a Headers object or a plain object", () => {
    assert.equal(retryAfterMs(err(new Headers({ "retry-after": "3" }))), 3000);
    assert.equal(retryAfterMs(err({ "retry-after": "1.5" })), 1500);
    assert.equal(retryAfterMs(err({ "Retry-After": "0" })), 0);
  });

  test("an HTTP date", () => {
    const now = Date.parse("2026-11-26T12:00:00Z");
    assert.equal(retryAfterMs(err({ "retry-after": "Thu, 26 Nov 2026 12:00:07 GMT" }), now), 7000);
    assert.equal(retryAfterMs(err({ "retry-after": "Thu, 26 Nov 2026 11:59:00 GMT" }), now), 0); // in the past
  });

  test("capped, and null when absent or unreadable", () => {
    assert.equal(retryAfterMs(err({ "retry-after": "3600" })), 60_000);
    assert.equal(retryAfterMs(err({ "retry-after": "3600" }), Date.now(), 5000), 5000);
    assert.equal(retryAfterMs(err({})), null);
    assert.equal(retryAfterMs(err({ "retry-after": "soon" })), null);
    assert.equal(retryAfterMs(new Error("fetch failed")), null);
  });

  test("429 detection", () => {
    assert.equal(isRateLimited(err({})), true);
    assert.equal(isRateLimited(err({}, 503)), false);
    assert.equal(isRateLimited(new Error("x")), false);
  });
});

describe("usage counter", () => {
  test("reports the last complete minute per server and the top 5 methods", () => {
    const u = new RpcUsage(0);
    assert.equal(u.lastMinute(10), null);
    for (let i = 0; i < 6; i++) u.count("a", "simulate:get_order", 1000);
    u.count("a", "getLatestLedger", 1000);
    u.count("b", "getEvents", 2000);
    for (const m of ["m1", "m2", "m3", "m4"]) u.count("a", m, 3000);
    u.rateLimited(4000);
    u.waited(1500, 4000);
    const m = u.lastMinute(61_000);
    assert.equal(m.total, 12);
    assert.deepEqual(m.per_server, { a: 11, b: 1 });
    assert.equal(m.top_methods.length, 5);
    assert.deepEqual(m.top_methods[0], ["simulate:get_order", 6]);
    assert.equal(m.rate_limited, 1);
    assert.equal(m.waited_ms, 1500);
  });

  test("after idle minutes the last minute is empty, not stale", () => {
    const u = new RpcUsage(0);
    u.count("a", "x", 10);
    assert.equal(u.lastMinute(300_000).total, 0);
  });
});

describe("adaptive scan interval", () => {
  test("limit ratio", () => {
    assert.equal(limitRatio(99n, 100n), 0.99);
    assert.equal(limitRatio(null, 100n), null);
    assert.equal(limitRatio(5n, 0n), null);
  });

  test("near: within the percentage, past the limit, or unknown", () => {
    assert.equal(isNear(0.985, 2), true);
    assert.equal(isNear(0.97, 2), false);
    assert.equal(isNear(1.2, 2), true);
    assert.equal(isNear(null, 2), true);
  });

  test("every ledger when near or without events, otherwise the idle interval", () => {
    assert.equal(scanIntervalMs({ near: true, eventsOk: true, idleMs: 30_000 }), 0);
    assert.equal(scanIntervalMs({ near: false, eventsOk: false, idleMs: 30_000 }), 0);
    assert.equal(scanIntervalMs({ near: false, eventsOk: true, idleMs: 30_000 }), 30_000);
    assert.equal(scanIntervalMs({ near: false, eventsOk: true, idleMs: 0 }), 0);
  });
});
