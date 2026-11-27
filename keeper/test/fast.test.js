// Fill latency: timing, percentiles, server choice, the Horizon ledger stream parser, prepared route shapes.
// No network.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Ewma, FillStats, FillTimer, TokenBucket, ledgerFromSse, parseSse, percentile, pickReadServer, scaleShares, shapeKey, sharesOf } from "../lib.js";

describe("fill timer", () => {
  test("marks are ms after the trigger ledger was seen; the first mark of a stage counts", () => {
    const t = new FillTimer(1000, 500);
    t.mark("event", 1300);
    t.mark("event", 1900); // ignored
    t.mark("order", 1500);
    t.mark("quote", 2100);
    t.mark("sim", 2400);
    t.mark("sent", 2600);
    t.mark("included", 6200);
    t.includedLedger = 501;
    assert.equal(t.ledgersLater(), 1);
    assert.equal(t.line(), "fill timing: event+300ms order+500ms quote+1100ms sim+1400ms sent+1600ms included+5200ms L(500+1)");
  });

  test("stages that did not happen are left out; unknown ledger", () => {
    const t = new FillTimer(0, 0);
    t.mark("quote", 50);
    assert.equal(t.line(), "fill timing: quote+50ms L(?)");
    assert.equal(t.ledgersLater(), null);
  });

  test("a mark before t0 counts as 0", () => {
    const t = new FillTimer(1000, 10);
    t.mark("event", 900);
    assert.equal(t.marks.event, 0);
  });
});

describe("percentiles and the last 20 fills", () => {
  test("nearest rank", () => {
    const v = [5, 1, 4, 2, 3];
    assert.equal(percentile(v, 50), 3);
    assert.equal(percentile(v, 90), 5);
    assert.equal(percentile(v, 0), 1);
    assert.equal(percentile([], 50), null);
    assert.equal(percentile([7], 90), 7);
  });

  test("keeps the last 20; next-ledger share", () => {
    const s = new FillStats(20);
    for (let i = 1; i <= 25; i++) s.add(i * 1000, i <= 20 ? 2 : 1);
    const m = s.summary();
    assert.equal(m.fills, 20);
    assert.equal(m.p50_ms, 15_000); // items 6..25
    assert.equal(m.p90_ms, 23_000);
    assert.equal(m.next_ledger_share, 25); // 5 of 20 in the next ledger
    assert.deepEqual(new FillStats().summary(), { fills: 0, p50_ms: null, p90_ms: null, p50_ledgers: null, p90_ledgers: null, next_ledger_share: null });
  });
});

describe("read server choice", () => {
  test("the one expected to answer first; ties to the preferred (lower) index", () => {
    assert.equal(pickReadServer([{ usable: true, waitMs: 0, latencyMs: 150 }, { usable: true, waitMs: 0, latencyMs: 1500 }]), 0);
    assert.equal(pickReadServer([{ usable: true, waitMs: 2000, latencyMs: 150 }, { usable: true, waitMs: 0, latencyMs: 600 }]), 1);
    assert.equal(pickReadServer([{ usable: true, waitMs: 0, latencyMs: 300 }, { usable: true, waitMs: 0, latencyMs: 300 }]), 0);
  });

  test("unusable servers are skipped; unmeasured ones count as unknownMs", () => {
    assert.equal(pickReadServer([{ usable: false, waitMs: 0, latencyMs: 10 }, { usable: true, waitMs: 0, latencyMs: 900 }]), 1);
    assert.equal(pickReadServer([{ usable: true, waitMs: 0, latencyMs: 1200 }, { usable: true, waitMs: 0, latencyMs: null }], 1000), 1);
    assert.equal(pickReadServer([{ usable: false }, { usable: false }]), -1);
  });

  test("ewma", () => {
    const e = new Ewma(0.5);
    assert.equal(e.add(100), 100);
    assert.equal(e.add(200), 150);
  });

  test("token bucket peek tells the wait without taking a token", () => {
    const b = new TokenBucket(4, 1, 0);
    assert.equal(b.peek(0), 0);
    b.take(0);
    assert.equal(b.peek(0), 250);
    assert.equal(b.peek(0), 250); // unchanged: nothing taken
    assert.equal(b.take(0), 250);
    b.drain(1000);
    assert.ok(b.peek(0) >= 1000);
  });
});

describe("Horizon ledger stream", () => {
  test("events split across chunks; hello and comments ignored", () => {
    const chunks = [
      'retry: 1000\nevent: open\ndata: "hello"\n\n: keep-alive\n\nid: 1-2\ndata: {"sequence": 5001, "closed_at": "2026-11-27T10:00:00Z"}\n',
      '\ndata: {"seq',
      'uence": 5002}\n\n',
    ];
    let buf = "";
    const got = [];
    for (const c of chunks) {
      buf += c;
      const { events, rest } = parseSse(buf);
      buf = rest;
      for (const ev of events) {
        const l = ledgerFromSse(ev);
        if (l) got.push(l.sequence);
      }
    }
    assert.deepEqual(got, [5001, 5002]);
    assert.equal(buf, "");
  });

  test("CRLF line ends and the closed_at time", () => {
    const { events } = parseSse('data: {"sequence": 7, "closed_at": "2026-11-27T10:00:05Z"}\r\n\r\n');
    const l = ledgerFromSse(events[0]);
    assert.equal(l.sequence, 7);
    assert.equal(l.closedAt, Date.parse("2026-11-27T10:00:05Z"));
  });

  test("not a ledger: null", () => {
    assert.equal(ledgerFromSse({ data: '"hello"' }), null);
    assert.equal(ledgerFromSse({ data: "not json" }), null);
    assert.equal(ledgerFromSse({ data: '{"sequence": "x"}' }), null);
    assert.equal(ledgerFromSse(null), null);
  });
});

describe("prepared route shapes", () => {
  test("size class: same for fills of a similar size, different for much larger ones", () => {
    assert.equal(shapeKey("A", "B", 1_100_000n), shapeKey("A", "B", 1_900_000n)); // both 2^20..2^21
    assert.notEqual(shapeKey("A", "B", 1_100_000n), shapeKey("A", "B", 4_400_000n));
    assert.notEqual(shapeKey("A", "B", 1n), shapeKey("B", "A", 1n));
  });

  test("shares round-trip: amounts add up to the fill exactly", () => {
    const shares = sharesOf([680n, 200n, 120n], 1000n);
    assert.deepEqual(shares, [6800, 2000, 1200]);
    const a = scaleShares(shares, 1_234_567n);
    assert.equal(
      a.reduce((x, y) => x + y, 0n),
      1_234_567n,
    );
    assert.deepEqual(scaleShares([10_000], 99n), [99n]);
    assert.equal(sharesOf([1n, 1n, 1n], 3n).reduce((x, y) => x + y, 0), 10_000);
  });
});
