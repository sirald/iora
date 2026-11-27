// Fill latency: timing, percentiles, server choice, the Horizon ledger stream parser, prepared route shapes.
// No network.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Ewma, FillStats, FillTimer, LedgerRace, TokenBucket, boardMode, firstAccepted, ledgerFromSse, parseSse, percentile, pickReadServer, scaleShares, shapeKey, sharesOf } from "../lib.js";

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

describe("main-loop watchdog", () => {
  test("reports a stall once, after stallMs without a stage change or progress, and turns the fast paths off", async () => {
    const { LoopWatch } = await import("../lib.js");
    let t = 0;
    const w = new LoopWatch({ stallMs: 60_000, safeMs: 600_000, now: () => t });
    w.stage("scan: vault list");
    t = 30_000;
    assert.equal(w.check(), null);
    w.progress(); // an RPC answer
    t = 89_000;
    assert.equal(w.check(), null);
    t = 91_000;
    assert.deepEqual(w.check(), { stage: "scan: vault list", stalledMs: 61_000 });
    assert.equal(w.check(), null); // once per stall
    assert.equal(w.safe(), true);
    assert.equal(w.stalls, 1);
    t = 91_000 + 600_001;
    assert.equal(w.safe(), false);
    w.stage("waiting for the next ledger");
    t += 61_000;
    assert.equal(w.check().stage, "waiting for the next ledger"); // a new stall is reported again
  });
});

describe("board mode: board entry, quick quote or route search", () => {
  const e = { ref: 200_000_000n, at: 1_000_000, best: { label: "Soroswap", q: 1n } };
  const o = { now: 1_030_000, maxAgeMs: 90_000, mult: 5 };
  test("fresh entry and small fill: board; stale or missing: quick; too large: search", () => {
    assert.equal(boardMode(e, 500_000_000n, o), "board");
    assert.equal(boardMode(e, 500_000_000n, { ...o, now: 1_000_000 + 90_001 }), "quick");
    assert.equal(boardMode({ ...e, best: null }, 1n, o), "quick"); // quoted, but no venue had a price then
    assert.equal(boardMode(undefined, 1n, o), "quick");
    assert.equal(boardMode(e, 1_000_000_001n, o), null);
    assert.equal(boardMode(e, 0n, o), null);
  });
  test("with no entry the size limit comes from refHint; with neither the fill counts as small", () => {
    assert.equal(boardMode(undefined, 1_000_000_001n, { ...o, refHint: 200_000_000n }), null);
    assert.equal(boardMode(undefined, 1_000_000_000n, { ...o, refHint: 200_000_000n }), "quick");
    assert.equal(boardMode(undefined, 10n ** 15n, o), "quick");
    // a stale entry keeps its own reference amount for the size limit
    assert.equal(boardMode({ ...e, at: 0 }, 1_000_000_001n, o), null);
  });
});

describe("one transaction sent to every RPC server", () => {
  const later = (ms, v, fail = false) => new Promise((res, rej) => setTimeout(() => (fail ? rej(v) : res(v)), ms));
  test("the first PENDING wins, even from a copy", async () => {
    const r = await firstAccepted([later(80, { status: "PENDING", hash: "h" }), later(10, { status: "PENDING", hash: "h" })]);
    assert.equal(r.idx, 1);
    assert.equal(r.res.status, "PENDING");
  });
  test("an error on one server (DUPLICATE / ERROR / timeout) is no problem while another took it", async () => {
    const dup = await firstAccepted([later(5, { status: "ERROR" }), later(30, { status: "PENDING" })]);
    assert.equal(dup.idx, 1);
    const thrown = await firstAccepted([later(5, new Error("timeout"), true), later(20, { status: "DUPLICATE" })]);
    assert.equal(thrown.idx, 1);
    assert.equal(thrown.res.status, "DUPLICATE");
  });
  test("nobody took it: the usual server's answer (e.g. its ERROR), waiting at most graceMs for the others", async () => {
    const t0 = Date.now();
    const r = await firstAccepted([later(5, { status: "ERROR", why: "bad seq" }), new Promise(() => {})], { graceMs: 50 });
    assert.equal(r.idx, 0);
    assert.equal(r.res.why, "bad seq");
    assert.ok(Date.now() - t0 < 1000);
    const copy = await firstAccepted([later(5, new Error("down"), true), later(10, { status: "TRY_AGAIN_LATER" })]);
    assert.equal(copy.idx, 1);
  });
  test("every server threw: the error comes through", async () => {
    await assert.rejects(firstAccepted([later(5, new Error("a"), true), later(10, new Error("b"), true)]), /a/);
  });
});

describe("ledger race: stream vs RPC", () => {
  test("who saw each ledger first, by how much, and how long after the close", () => {
    const r = new LedgerRace();
    for (let i = 0; i < 10; i++) {
      const close = 100_000 + i * 5000;
      r.seen(500 + i, "stream", close + 1800, close);
      r.seen(500 + i, "rpc", close + (i < 7 ? 1200 : 2500));
      r.seen(500 + i, "rpc", close + 9999); // a later sighting does not count
    }
    const s = r.summary();
    assert.equal(s.ledgers, 10);
    assert.equal(s.both, 10);
    assert.equal(s.rpc_first, 7);
    assert.equal(s.stream_first, 3);
    assert.equal(s.rpc_lead_p50_ms, 600);
    assert.equal(s.stream_after_close_p50_ms, 1800);
    assert.equal(s.rpc_after_close_p50_ms, 1200); // the close time from the stream serves the RPC sighting too
    r.reset();
    assert.equal(r.summary().ledgers, 0);
  });
  test("the RPC is worth polling only while it is first now and then (auto mode)", () => {
    const r = new LedgerRace();
    assert.equal(r.rpcUseful(), true); // not measured yet
    for (let i = 0; i < 60; i++) {
      r.seen(i + 1, "stream", 1000);
      r.seen(i + 1, "rpc", 1500);
    }
    assert.equal(r.rpcUseful(), false);
    for (let i = 60; i < 70; i++) {
      r.seen(i + 1, "rpc", 1000);
      r.seen(i + 1, "stream", 1300);
    }
    assert.equal(r.rpcUseful(), true);
  });
});
