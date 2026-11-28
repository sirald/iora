import { test } from "node:test";
import assert from "node:assert/strict";
import { message, step, summary } from "../alerts.js";

const T0 = Date.parse("2026-11-28T12:00:00Z");
const MIN = 60000;
const H = 60 * MIN;
const cfg = { alarmRepeatMin: 60, stockRepeatH: 12 };
const alarm = { key: "price-bot:stale", level: "alarm", title: "price bot: no recent successful run", text: "price bot: the last run was 20 min ago" };
const stock = { key: "faucet:usdc", level: "stock", title: "faucet: Circle USDC low", text: "faucet holds 1,900 Circle USDC" };
const soft = { key: "check:horizon", level: "soft", title: "check: Horizon not reachable", text: "the check cannot read Horizon", delayMin: 10 };

/** Runs the check at the given minutes with the given problems each time; returns every step's plan. */
function timeline(runs, opts = {}) {
  let state = null;
  return runs.map(([min, problems, extra = {}]) => {
    const plan = step(state, problems, { ...opts, ...extra }, T0 + min * MIN, cfg);
    state = extra.undelivered ? plan.failState : plan.state;
    return plan;
  });
}
const sent = (plan) => plan.send.map((i) => i.key);
const ok = (plan) => plan.recovered.map((i) => i.key);

test("a new alarm is told at once, then at most once an hour while it lasts", () => {
  const p = timeline([[0, [alarm]], [5, [alarm]], [55, [alarm]], [60, [alarm]], [65, [alarm]]]);
  assert.deepEqual(p.map(sent), [[alarm.key], [], [], [alarm.key], []]);
  assert.ok(p.every((x) => x.exitCode === 1));
  assert.equal(p[0].state.items[alarm.key].told, true);
  assert.equal(p[0].state.items[alarm.key].lastSent, T0);
  assert.equal(p[4].state.items[alarm.key].since, T0);
});

test("the text of a repeat is the latest one", () => {
  const p = timeline([[0, [alarm]], [61, [{ ...alarm, text: "price bot: the last run was 81 min ago" }]]]);
  assert.equal(p[1].send[0].text, "price bot: the last run was 81 min ago");
});

test("stock warnings: at most every 12 hours", () => {
  const p = timeline([[0, [stock]], [60, [stock]], [11 * 60, [stock]], [12 * 60, [stock]]]);
  assert.deepEqual(p.map(sent), [[stock.key], [], [], [stock.key]]);
  assert.ok(p.every((x) => x.exitCode === 1));
});

test("cleared: one OK line; an alarm that comes back is told again at once", () => {
  const p = timeline([[0, [alarm]], [5, []], [10, []], [15, [alarm]]]);
  assert.deepEqual(p.map(ok), [[], [alarm.key], [], []]);
  assert.deepEqual(p.map(sent), [[alarm.key], [], [], [alarm.key]]);
  assert.equal(p[1].exitCode, 0);
  assert.deepEqual(p[1].state.items, {});
});

test("a stock warning that flaps around its limit: one warning and one OK per 12 hours", () => {
  const p = timeline([[0, [stock]], [5, []], [10, [stock]], [15, []], [20, [stock]], [12 * 60 + 1, [stock]], [12 * 60 + 6, []]]);
  assert.deepEqual(p.map(sent), [[stock.key], [], [], [], [], [stock.key], []]);
  assert.deepEqual(p.map(ok), [[], [stock.key], [], [], [], [], [stock.key]]);
  // while it is back but not told again, it still makes the check fail
  assert.equal(p[2].exitCode, 1);
  // after the window it is forgotten
  const later = step(p[6].state, [], {}, T0 + 25 * H, cfg);
  assert.deepEqual(later.state.items, {});
});

test("delayMin: told only when it lasts; cleared before that, nothing is said", () => {
  let p = timeline([[0, [soft]], [5, [soft]], [10, [soft]], [15, [soft]], [20, []]]);
  assert.deepEqual(p.map(sent), [[], [], [soft.key], [], []]);
  assert.deepEqual(p.map((x) => x.pending.length), [1, 1, 0, 0, 0]);
  assert.deepEqual(p.map(ok), [[], [], [], [], [soft.key]]);
  // soft notices do not make the check fail
  assert.ok(p.every((x) => x.exitCode === 0));
  p = timeline([[0, [soft]], [5, [soft]], [8, []], [12, [soft]]]);
  assert.deepEqual(p.map(sent), [[], [], [], []]);
  assert.deepEqual(p.map(ok), [[], [], [], []]);
  // a missing status file (an alarm with a delay) does not fail the check while it waits
  const waiting = step(null, [{ ...alarm, key: "borrower:status", delayMin: 45 }], {}, T0, cfg);
  assert.equal(waiting.exitCode, 0);
});

test("not checked this time: the state is kept, nothing is said, it still counts", () => {
  const p = timeline([[0, [alarm, stock]], [5, [], { unknown: ["faucet:", "price-bot:stale"] }], [10, [], { unknown: ["faucet:"] }]]);
  assert.deepEqual(p.map(ok), [[], [], [alarm.key]]);
  assert.equal(p[1].exitCode, 1);
  assert.deepEqual(p[1].active.map((i) => [i.key, i.carried]), [[alarm.key, true], [stock.key, true]]);
  assert.ok(p[2].state.items[stock.key].present);
});

test("a bot taken out of BOTS: its state is dropped without a message", () => {
  const p = timeline([[0, [alarm]], [5, [], { ignore: ["price-bot:"] }]]);
  assert.deepEqual(p[1].recovered, []);
  assert.deepEqual(p[1].state.items, {});
});

test("not delivered: the same lines are tried again on the next run", () => {
  const p = timeline([[0, [alarm], { undelivered: true }], [5, [alarm]], [10, [], { undelivered: true }], [15, []], [20, []]]);
  assert.deepEqual(p.map(sent), [[alarm.key], [alarm.key], [], [], []]);
  assert.deepEqual(p.map(ok), [[], [], [alarm.key], [alarm.key], []]);
});

test("the first problem with a key wins", () => {
  const plan = step(null, [alarm, { ...alarm, text: "other" }], {}, T0, cfg);
  assert.equal(plan.send.length, 1);
  assert.equal(plan.send[0].text, alarm.text);
});

test("a damaged state file is treated as empty", () => {
  for (const bad of [null, {}, { items: null }, { items: { x: null, y: 5 } }, "text"]) {
    const plan = step(bad, [alarm], {}, T0, cfg);
    assert.deepEqual(sent(plan), [alarm.key]);
  }
});

test("message: one Telegram text with a header, one line per problem, the OK lines last", () => {
  let plan = step(null, [alarm, stock], {}, T0, cfg);
  assert.equal(message(plan, "vps1"), "[Iora bots] ALARM on vps1\nALARM price bot: the last run was 20 min ago\nLOW faucet holds 1,900 Circle USDC");
  plan = step(plan.state, [stock], {}, T0 + 5 * MIN, cfg);
  assert.equal(message(plan, "vps1"), "[Iora bots] recovered on vps1\nOK (was: price bot: no recent successful run)");
  plan = step(null, [stock], {}, T0, cfg);
  assert.match(message(plan, "h"), /^\[Iora bots\] WARNING on h\n/);
  assert.equal(message(step(plan.state, [stock], {}, T0 + MIN, cfg), "h"), null);
  const many = Array.from({ length: 80 }, (_, i) => ({ ...alarm, key: `k${i}`, text: "x".repeat(100) }));
  const long = message(step(null, many, {}, T0, cfg), "h");
  assert.ok(long.length <= 3800);
  assert.ok(long.endsWith("\n..."));
});

test("summary for the journal", () => {
  assert.equal(summary(step(null, [], {}, T0, cfg)), "OK: no problems");
  const plan = step(null, [alarm, soft], {}, T0, cfg);
  assert.equal(summary(plan), "ALARM price bot: the last run was 20 min ago\nWAIT the check cannot read Horizon (told if it lasts 10 min)");
});
