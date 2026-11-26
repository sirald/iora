// IORA-06: the crossing pass must stay within a fixed amount of work per scan, however many opposite orders there
// are. Pure functions from lib.js, plus the real crossPass from keeper.js run in a sandbox with counters in place of
// the network (the same method as the audit's proof). No network.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import * as lib from "../lib.js";

const { WorkBudget, crossPairs, takeCandidates } = lib;
const S = 10_000_000n;
const order = (vault, i, tin, tout, limit = S) => ({ key: `${vault}:${i}`, vault, tin, tout, limit });

describe("crossing candidates", () => {
  test("vaults in turn from the cursor, capped per vault and in all", () => {
    const groups = ["A", "B", "C"].map((v) => [v, Array.from({ length: 10 }, (_, i) => order(v, i, "X", "Y"))]);
    const r1 = takeCandidates(groups, 0, { max: 15, perVault: 6 });
    assert.equal(r1.list.length, 15);
    assert.deepEqual([...new Set(r1.list.map((o) => o.vault))], ["A", "B", "C"]);
    assert.equal(r1.list.filter((o) => o.vault === "A").length, 6);
    assert.equal(r1.nextCursor, 0); // all three vaults used: back to the start
    const r2 = takeCandidates(groups, 1, { max: 8, perVault: 6 });
    assert.equal(r2.list[0].vault, "B");
    assert.equal(r2.nextCursor, 0); // B and C used
    assert.deepEqual(takeCandidates([], 0), { list: [], nextCursor: 0 });
  });
});

describe("crossing pairs", () => {
  test("only opposite orders of other vaults whose limits overlap, most generous first", () => {
    const list = [
      order("A", 0, "X", "Y", S),
      order("A", 1, "Y", "X", 2n * S), // same vault as A:0: never paired with it
      order("B", 0, "Y", "X", 2n * S),
      order("C", 0, "Y", "X", S / 2n), // 1 x 0.5 < 1: does not overlap with A:0
      order("D", 0, "X", "Y", S),
    ];
    const pairs = [...crossPairs(list, { perOrder: 5, scale: S })].map(({ a, b }) => `${a.key}>${b.key}`);
    assert.deepEqual(pairs, ["A:0>B:0", "A:1>D:0", "B:0>D:0"]); // in list order of a
  });

  test("at most perOrder partners per order and each pair once", () => {
    const list = [...Array.from({ length: 5 }, (_, i) => order("A", i, "X", "Y")), ...Array.from({ length: 5 }, (_, i) => order("B", i, "Y", "X"))];
    const pairs = [...crossPairs(list, { perOrder: 2, scale: S })];
    const keys = pairs.map(({ a, b }) => [a.key, b.key].sort().join("|"));
    assert.equal(new Set(keys).size, keys.length);
    for (const o of list) assert.ok(pairs.filter((p) => p.a.key === o.key).length <= 2);
  });

  test("an order crossed earlier is skipped as the pairs are produced", () => {
    const used = new Set();
    const list = [order("A", 0, "X", "Y"), order("B", 0, "Y", "X"), order("C", 0, "Y", "X")];
    const out = [];
    for (const p of crossPairs(list, { perOrder: 5, scale: S, isUsed: (k) => used.has(k) })) {
      out.push(`${p.a.key}>${p.b.key}`);
      used.add(p.a.key);
      used.add(p.b.key);
    }
    assert.deepEqual(out, ["A:0>B:0"]); // A:0 and B:0 used; C:0's only partner A:0 is gone
  });

  test("the offset rotates which orders lead", () => {
    const list = [order("A", 0, "X", "Y"), order("A", 1, "X", "Y"), order("B", 0, "Y", "X")];
    const first = crossPairs(list, { offset: 1, perOrder: 1, scale: S }).next().value;
    assert.equal(first.a.key, "A:1");
    assert.equal(first.index, 1);
  });

  test("thousands of opposite orders: the work stays small", () => {
    const n = 3000;
    const list = [...Array.from({ length: n }, (_, i) => order("A", i, "X", "Y")), ...Array.from({ length: n }, (_, i) => order("B", i, "Y", "X"))];
    let produced = 0;
    const t0 = Date.now();
    for (const _ of crossPairs(list, { perOrder: 2, scale: S })) produced++;
    assert.ok(produced <= 2 * list.length);
    assert.ok(Date.now() - t0 < 2000, "index by direction, not list x list");
  });
});

describe("work budget", () => {
  test("pairs, quotes and time each stop the pass", () => {
    const b = new WorkBudget({ pairs: 2, quotes: 6, ms: 1000 }, 0);
    assert.equal(b.canStart(4, 0), true);
    b.pair();
    b.quote(4);
    assert.equal(b.canStart(4, 10), false); // 8 quotes > 6
    assert.equal(b.canStart(2, 10), true);
    b.pair();
    assert.equal(b.canStart(0, 10), false); // 2 pairs
    assert.equal(new WorkBudget({ ms: 1000 }, 0).canStart(0, 1000), false); // out of time
  });
});

// ----- the real crossPass, as the audit ran it: extracted from keeper.js, network replaced by counters -----
const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "keeper.js"), "utf8");
const start = source.indexOf("const crossState = ");
const end = source.indexOf("\n// ---------------------------------------------------------------------------", start);
const extracted = source.slice(start, end).replace(/^const crossState = /m, "var crossState = ").replace(/^let crossStats = null;/m, "var crossStats = null;");

function runCrossPass({ perVaultOrders = 24, vaults = 2, rounds = 1, limits = {} } = {}) {
  const book = new Map();
  const names = Array.from({ length: vaults }, (_, i) => `vault${i}`);
  names.forEach((vault, vi) => {
    const [sell, buy] = vi % 2 === 0 ? ["X", "Y"] : ["Y", "X"];
    const open = Array.from({ length: perVaultOrders }, (_, i) => i);
    const orders = new Map(
      open.map((id) => [
        id,
        { id, sell, buy, amount_in: S * 100n, filled_in: 0n, limit_price: S, min_fill: S, trigger_price: 0n, expiry: BigInt(Math.floor(Date.now() / 1000) + 3600) },
      ]),
    );
    book.set(vault, { open, orders });
  });
  const calls = [];
  const ctx = vm.createContext({
    ...lib,
    CROSS: true,
    crossedNow: new Set(),
    Date,
    book,
    pair: async () => ({ v10: true, v11: false, fees: {} }),
    closed: new Set(),
    failGuard: { pausedUntil: () => 0 },
    schedules: new Map(),
    SCALE: S,
    stuck: new Map(),
    scanNo: 1,
    proximity: { near: false },
    CROSS_MAX_CANDIDATES: limits.candidates ?? 200,
    CROSS_PER_VAULT: limits.perVault ?? 12,
    CROSS_PER_ORDER: limits.perOrder ?? 2,
    CROSS_MAX_PAIRS: limits.pairs ?? 10,
    CROSS_MAX_QUOTES: limits.quotes ?? 24,
    CROSS_MAX_MS: 60_000,
    crossKey: (a, b) => [a.key, b.key].sort().join("|"),
    tryCross: async (a, b, budget) => {
      calls.push(`${a.key}>${b.key}`);
      budget.quote(2);
      return "no";
    },
    log: () => {},
    short: (x) => x,
  });
  vm.runInContext(extracted, ctx);
  const perRound = [];
  return (async () => {
    for (let r = 0; r < rounds; r++) {
      const before = calls.length;
      await ctx.crossPass(names);
      perRound.push(calls.length - before);
    }
    return { calls, perRound, stats: ctx.crossStats };
  })();
}

describe("crossPass (keeper.js) under load", () => {
  test("the audit case: 2 vaults x 24 opposite orders no longer gives 576 tries", async () => {
    const { perRound } = await runCrossPass({ perVaultOrders: 24, vaults: 2 });
    assert.ok(perRound[0] <= 10, `tried ${perRound[0]} pairs`);
  });

  test("thousands of opposite, unfillable orders: every scan stays within the limits", async () => {
    const { perRound, stats } = await runCrossPass({ perVaultOrders: 1000, vaults: 4, rounds: 5 });
    for (const n of perRound) assert.ok(n <= 10, `a round tried ${n} pairs`);
    assert.ok(stats.candidates <= 200);
    assert.ok(stats.quotes <= 24);
  });

  test("over several scans, different orders get their turn", async () => {
    const { calls } = await runCrossPass({ perVaultOrders: 24, vaults: 2, rounds: 6 });
    const leaders = new Set(calls.map((c) => c.split(">")[0]));
    assert.ok(leaders.size >= 20, `only ${leaders.size} orders led a pair in 6 scans`);
  });
});
