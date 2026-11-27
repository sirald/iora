// The price board (which pairs to quote when, within a quote budget), the single-leg fast route for small fills,
// and the priority queue (background work never queues ahead of the fill path). No network.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TokenBucket, bestQuote, boardPlan, fastRouteOk } from "../lib.js";

const dir = (key, priority, lastLedger, cost = 3) => ({ key, priority, lastLedger, cost });

describe("price board plan", () => {
  test("hot every ledger, active every 2, cold every 12; never quoted: at once", () => {
    const dirs = [dir("hot", "hot", 99), dir("act", "active", 99), dir("act2", "active", 98), dir("cold", "cold", 90), dir("cold2", "cold", 88), dir("new", "cold", 0)];
    const keys = boardPlan(dirs, { ledger: 100, maxQuotes: 100 }).map((d) => d.key);
    assert.deepEqual(keys.sort(), ["act2", "cold2", "hot", "new"].sort());
  });

  test("hot first, then the most overdue, within the quote budget", () => {
    const dirs = [dir("c1", "cold", 80), dir("c2", "cold", 50), dir("h", "hot", 99), dir("a", "active", 90)];
    const keys = boardPlan(dirs, { ledger: 100, maxQuotes: 7 }).map((d) => d.key);
    assert.deepEqual(keys, ["h", "a"]); // 3 + 3 quotes; the cold ones wait (6 + 3 > 7)
    const more = boardPlan(dirs, { ledger: 100, maxQuotes: 12 }).map((d) => d.key);
    assert.deepEqual(more, ["h", "a", "c2", "c1"].slice(0, 4)); // c2 is more overdue than c1
  });

  test("the budget holds with many pairs: at most maxQuotes per ledger", () => {
    const dirs = Array.from({ length: 40 }, (_, i) => dir(`d${i}`, i < 5 ? "hot" : "cold", 0, 3));
    const pick = boardPlan(dirs, { ledger: 1000, maxQuotes: 10 });
    assert.ok(pick.reduce((a, d) => a + d.cost, 0) <= 10);
    assert.ok(pick.every((d) => d.priority === "hot"));
  });

  test("one direction dearer than the budget still goes when nothing else is picked", () => {
    assert.equal(boardPlan([dir("big", "hot", 0, 15)], { ledger: 5, maxQuotes: 10 }).length, 1);
  });

  test("over 12 ledgers, the cost of 12 cold directions spreads to ~1 refresh per ledger", () => {
    const last = new Map();
    let quotes = 0;
    for (let L = 1000; L < 1048; L++) {
      const dirs = Array.from({ length: 12 }, (_, i) => dir(`c${i}`, "cold", last.get(`c${i}`) || 0, 3));
      const pick = boardPlan(dirs, { ledger: L, maxQuotes: 10 });
      for (const d of pick) last.set(d.key, L);
      quotes += pick.reduce((a, d) => a + d.cost, 0);
    }
    assert.ok(quotes / 48 <= 10, `${quotes / 48} quotes per ledger`);
    assert.ok(quotes / 48 >= 2, "the cold pairs must be refreshed regularly");
  });
});

describe("best quote and the fast single-leg route", () => {
  test("best of the sources; missing and zero quotes ignored", () => {
    assert.deepEqual(bestQuote([["Soroswap", 990n], ["Aquarius 1a2b", 1002n], ["Phoenix", null], ["Comet", 0n]]), { label: "Aquarius 1a2b", q: 1002n });
    assert.equal(bestQuote([["Soroswap", null]]), null);
  });

  test("only a fresh entry, with a best venue, for a fill up to mult x the reference amount", () => {
    const e = { ref: 200_000_000n, at: 1_000_000, best: { label: "Soroswap", q: 1n } };
    const opts = { now: 1_030_000, maxAgeMs: 90_000, mult: 5 };
    assert.equal(fastRouteOk(e, 200_000_000n, opts), true);
    assert.equal(fastRouteOk(e, 1_000_000_000n, opts), true); // 5x
    assert.equal(fastRouteOk(e, 1_000_000_001n, opts), false); // larger: route search
    assert.equal(fastRouteOk(e, 1n, { ...opts, now: 1_000_000 + 90_001 }), false); // stale
    assert.equal(fastRouteOk({ ...e, best: null }, 1n, opts), false);
    assert.equal(fastRouteOk(undefined, 1n, opts), false);
    assert.equal(fastRouteOk(e, 0n, opts), false);
  });
});

describe("priority queue", () => {
  test("background work takes only a free token: no debt the fill path would wait behind", () => {
    const b = new TokenBucket(4, 2, 0);
    assert.equal(b.tryTake(0), true);
    assert.equal(b.tryTake(0), true);
    assert.equal(b.tryTake(0), false); // nothing free: the background request waits outside the queue
    assert.equal(b.tryTake(0), false);
    // a fill-path request now waits only for the next token (250 ms at 4/s), not behind background requests
    assert.equal(b.take(0), 250);
  });

  test("the same load with the old queueing would make the fill wait behind the background", () => {
    const b = new TokenBucket(4, 2, 0);
    for (let i = 0; i < 10; i++) b.take(0); // 10 background requests queued
    assert.ok(b.take(0) >= 2000); // the fill would wait >= 2 s
  });

  test("background is not starved for good: a token frees up with time", () => {
    const b = new TokenBucket(4, 1, 0);
    b.take(0);
    assert.equal(b.tryTake(100), false);
    assert.equal(b.tryTake(260), true);
  });

  test("no token while a 429 pause lasts", () => {
    const b = new TokenBucket(4, 4, 0);
    b.drain(1000);
    assert.equal(b.tryTake(500), false);
    assert.equal(b.tryTake(1300), true);
  });
});

// ----- the real board code from keeper.js, run in a sandbox with fake venue sources -----
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import * as lib from "../lib.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "keeper.js"), "utf8").replace(/\r\n/g, "\n");
const start = src.indexOf("// ----- price board -----\nfunction boardSummary");
const end = src.indexOf("// pair + fill size class", start);
const boardCode = src.slice(start, end).replace(/^const board = /m, "var board = ").replace(/^let (boardBusy|boardQuotes) = /gm, "var $1 = ");

function sandbox({ sources }) {
  const calls = [];
  const USDC = "USDC";
  const XLM = "XLM";
  const BTC = "BTC";
  const mkSource = (label, rate) => ({
    label,
    soroswap: label === "Soroswap",
    quote: async (a) => {
      calls.push(`quote ${label} ${a}`);
      return (BigInt(a) * BigInt(Math.round(rate * 1000))) / 1000n;
    },
    step: async (a, min) => {
      calls.push(`step ${label} ${a} min ${min}`);
      return { label, a, min };
    },
  });
  const ctx = vm.createContext({
    ...lib,
    USDC,
    XLM,
    MARKET_TOKENS: [BTC],
    BOARD_ON: true,
    VENUES: true,
    BOARD_REF_USDC: 20,
    BOARD_FAST_MULT: 5,
    BOARD_MAX_AGE_SEC: 90,
    BOARD_COLD_LEDGERS: 12,
    BOARD_MAX_QUOTES: 10,
    SLIPPAGE_BPS: 50,
    lastLedger: 1000,
    latestCache: { seq: 1000 },
    venueState: { offUntil: 0 },
    book: new Map(),
    pairOf: new Map(),
    proximity: { checked: new Set(), far: new Set() },
    sourcesFor: async (tin, tout) => (sources[`${tin}|${tout}`] || []).map(([l, r]) => mkSource(l, r)),
    low: (fn) => fn(),
    xdr: { ScVal: { scvVec: (steps) => ({ steps }) } },
    Date,
  });
  vm.runInContext(boardCode, ctx);
  return { ctx, calls };
}

describe("price board in keeper.js (sandbox)", () => {
  const sources = {
    "USDC|XLM": [
      ["Soroswap", 9.9],
      ["Aquarius 1a2b", 10.0],
    ],
    "XLM|USDC": [
      ["Soroswap", 0.1],
      ["Aquarius 1a2b", 0.099],
    ],
    "USDC|BTC": [["Soroswap", 0.001]],
    "BTC|USDC": [["Soroswap", 1000]],
  };

  test("refresh: every source quoted at 20 USDC worth; the reverse direction uses the forward one's amount", async () => {
    const { ctx } = sandbox({ sources });
    await ctx.refreshBoard("USDC", "XLM");
    await ctx.refreshBoard("XLM", "USDC");
    const fwd = ctx.board.get("USDC|XLM");
    assert.equal(fwd.ref, 200_000_000n);
    assert.equal(fwd.best.label, "Aquarius 1a2b");
    assert.equal(fwd.best.q, 2_000_000_000n);
    const rev = ctx.board.get("XLM|USDC");
    assert.equal(rev.ref, 2_000_000_000n); // 20 USDC worth of XLM, from the forward entry
    assert.equal(rev.best.label, "Soroswap");
  });

  test("a small fill: one quote at the real amount, single leg, minimum from that quote (50 bps), no search", async () => {
    const { ctx, calls } = sandbox({ sources });
    await ctx.refreshBoard("USDC", "XLM");
    calls.length = 0;
    const r = await ctx.boardRoute(500_000_000n, "USDC", "XLM", 0n); // 50 USDC: 2.5x the reference
    assert.equal(r.text, "Aquarius 1a2b (price board)");
    assert.equal(r.q, 5_000_000_000n);
    assert.deepEqual(calls, ["quote Aquarius 1a2b 500000000", "step Aquarius 1a2b 500000000 min 4975000000"]);
    assert.equal(r.route.steps.length, 1);
  });

  test("the vault's limit is a floor for the minimum; a venue that cannot meet it gives no board route", async () => {
    const { ctx } = sandbox({ sources });
    await ctx.refreshBoard("USDC", "XLM");
    const r = await ctx.boardRoute(500_000_000n, "USDC", "XLM", 4_990_000_000n);
    assert.equal(r.route.steps[0].min, 4_990_000_000n);
    assert.equal(await ctx.boardRoute(500_000_000n, "USDC", "XLM", 5_000_000_001n), null);
  });

  test("too large (over 5x) or no entry: no board route (the route search runs)", async () => {
    const { ctx } = sandbox({ sources });
    await ctx.refreshBoard("USDC", "XLM");
    assert.equal(await ctx.boardRoute(1_000_000_001n, "USDC", "XLM", 0n), null);
    assert.equal(await ctx.boardRoute(1n, "USDC", "BTC", 0n), null);
  });

  test("tick: the quote budget holds; what does not fit goes on the next ledger", async () => {
    const { ctx, calls } = sandbox({ sources });
    ctx.boardTick(); // 4 new directions at an assumed 3 quotes each: 3 fit in 10
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ctx.board.size, 3);
    assert.ok(calls.filter((c) => c.startsWith("quote")).length <= 10);
    ctx.lastLedger = 1001;
    ctx.boardTick();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ctx.board.size, 4);
    assert.equal(ctx.boardSummary(Date.now()).fresh, 4);
  });
});
