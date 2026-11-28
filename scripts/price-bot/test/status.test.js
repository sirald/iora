import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY, priceBotStatus, readStatus, runInfo, scrub, statusPath, writeStatus } from "../status.js";

const T0 = Date.parse("2026-11-28T10:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const tempDir = () => mkdtempSync(join(tmpdir(), "iora-pb-status-"));
const quiet = (f) => {
  const was = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(" "));
  try {
    return { value: f(), lines };
  } finally {
    console.error = was;
  }
};

// One run as price-bot.js records it: XLM swapped back near the reference, iBTC without a fresh price, iETH failed.
const run = (o = {}) => ({
  startedAt: T0 - 20000,
  address: "GBOTADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  checked: true,
  pools: {
    XLM: { dev: 0.00012345678, poolPrice: 0.12741, refPrice: 0.1274, action: "swap", tx: "abc123" },
    iBTC: { dev: NaN, poolPrice: NaN, refPrice: NaN, action: "skipped" },
    iETH: { dev: NaN, action: "error", error: "simulate: timeout" },
  },
  inventory: { XLM: { amount: 4000, usd: 509.6 }, iBTC: { amount: 0.01, usd: null }, USDC: { amount: 1500.12345678, usd: 1500.1 } },
  warnings: new Set(["inventory low: 150.0000 USDC (warn below 200)"]),
  ...o,
});

test("status path: STATUS_FILE, else the first STATE_DIRECTORY, else nothing", () => {
  assert.equal(statusPath({ STATUS_FILE: "/x/s.json", STATE_DIRECTORY: "/var/lib/iora/price-bot" }), "/x/s.json");
  assert.equal(statusPath({ STATE_DIRECTORY: "/var/lib/iora/price-bot" }), join("/var/lib/iora/price-bot", "status.json"));
  assert.equal(statusPath({ STATE_DIRECTORY: "/var/lib/a:/var/lib/b" }), join("/var/lib/a", "status.json"));
  assert.equal(statusPath({}), null);
  assert.equal(statusPath({ STATUS_FILE: "", STATE_DIRECTORY: "" }), null);
});

test("run info: the last good run and the failures in a row are carried", () => {
  const a = iso(T0);
  const b = iso(T0 + 120000);
  const c = iso(T0 + 240000);
  assert.deepEqual(runInfo(null, true, a), { lastOkAt: a, failsInRow: 0, failingSince: null });
  assert.deepEqual(runInfo(null, false, a), { lastOkAt: null, failsInRow: 1, failingSince: a });
  const ok = runInfo(null, true, a);
  const f1 = runInfo(ok, false, b);
  assert.deepEqual(f1, { lastOkAt: a, failsInRow: 1, failingSince: b });
  const f2 = runInfo(f1, false, c);
  assert.deepEqual(f2, { lastOkAt: a, failsInRow: 2, failingSince: b });
  assert.deepEqual(runInfo(f2, true, c), { lastOkAt: c, failsInRow: 0, failingSince: null });
  // a damaged previous status does not break it
  assert.deepEqual(runInfo({ failsInRow: "x", lastOkAt: 5 }, false, a), { lastOkAt: null, failsInRow: 1, failingSince: a });
});

test("scrub: no secret key in the file, long texts cut", () => {
  const secret = `S${"A".repeat(55)}`;
  assert.equal(scrub(`bad key ${secret} here`), "bad key S*** here");
  const long = scrub("x".repeat(1000), 50);
  assert.equal(long.length, 50);
  assert.ok(long.endsWith("..."));
  assert.equal(scrub(undefined), "");
});

test("write: atomic (no temporary file left), readable, replaces the old file", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "status.json");
    assert.equal(writeStatus(file, { a: 1 }), true);
    assert.equal(writeStatus(file, { a: 2 }), true);
    assert.deepEqual(readStatus(file), { a: 2 });
    assert.deepEqual(readdirSync(dir), ["status.json"]);
    assert.ok(readFileSync(file, "utf8").endsWith("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("write: a failure is one WARN line, never an exception", () => {
  const dir = tempDir();
  try {
    const { value, lines } = quiet(() => writeStatus(join(dir, "missing-dir", "status.json"), { a: 1 }));
    assert.equal(value, false);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /WARN status file .* not written/);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read: missing, broken or not an object -> null", () => {
  const dir = tempDir();
  try {
    assert.equal(readStatus(join(dir, "none.json")), null);
    writeFileSync(join(dir, "bad.json"), "{not json");
    assert.equal(readStatus(join(dir, "bad.json")), null);
    writeFileSync(join(dir, "arr.json"), "[1,2]");
    assert.equal(readStatus(join(dir, "arr.json")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status of a run: pools, deviation after the run, inventory in USD, warnings, history entry", () => {
  const s = priceBotStatus(null, run(), { ok: false, error: "1 of 3 pools failed: iETH: simulate: timeout", now: T0 });
  assert.equal(s.bot, "price-bot");
  assert.equal(s.at, iso(T0));
  assert.equal(s.ok, false);
  assert.equal(s.error, "1 of 3 pools failed: iETH: simulate: timeout");
  assert.equal(s.failsInRow, 1);
  assert.equal(s.durationSec, 20);
  assert.deepEqual(s.pools.XLM, { dev: 0.000123, pool: 0.12741, reference: 0.1274, action: "swap", tx: "abc123" });
  assert.deepEqual(s.pools.iBTC, { dev: null, pool: null, reference: null, action: "skipped" });
  assert.equal(s.pools.iETH.action, "error");
  assert.equal(s.pools.iETH.error, "simulate: timeout");
  assert.deepEqual(s.inventory.USDC, { amount: 1500.1234568, usd: 1500.1 });
  assert.deepEqual(s.inventory.iBTC, { amount: 0.01, usd: null });
  assert.equal(s.inventoryUsd, 2009.7);
  assert.deepEqual(s.warnings, ["inventory low: 150.0000 USDC (warn below 200)"]);
  assert.deepEqual(s.history, [{ at: iso(T0), ok: false, dev: { XLM: 0.000123, iBTC: "skipped", iETH: "error" } }]);
  // a good run has no error field and resets the failures
  const ok = priceBotStatus(s, run(), { ok: true, now: T0 + 120000 });
  assert.equal("error" in ok, false);
  assert.equal(ok.failsInRow, 0);
  assert.equal(ok.lastOkAt, iso(T0 + 120000));
  assert.equal(ok.history.length, 2);
  assert.ok(JSON.parse(JSON.stringify(ok))); // plain JSON (no NaN, no Set)
});

test("history: one entry per run that went through the pools, at most HISTORY", () => {
  let prev = null;
  for (let i = 0; i < HISTORY + 5; i++) prev = priceBotStatus(prev, run(), { ok: true, now: T0 + i * 120000 });
  assert.equal(prev.history.length, HISTORY);
  assert.equal(prev.history.at(-1).at, iso(T0 + (HISTORY + 4) * 120000));
  // a run that failed before the pools (RPC down at start) adds no entry but keeps the history
  const early = priceBotStatus(prev, { startedAt: T0, checked: false, pools: {}, inventory: {}, warnings: [] }, {
    ok: false, error: "RPC https://soroban-testnet.stellar.org did not answer", now: T0 + 99e6,
  });
  assert.equal(early.history.length, HISTORY);
  assert.deepEqual(early.history, prev.history);
  assert.equal(early.lastOkAt, prev.at);
  assert.equal(early.failingSince, early.at);
});

test("a secret key never reaches the file, from the error or a warning", () => {
  const secret = `S${"B".repeat(55)}`;
  const s = priceBotStatus(null, run({ warnings: [`odd ${secret}`] }), { ok: false, error: `boom ${secret}`, now: T0 });
  assert.equal(JSON.stringify(s).includes(secret), false);
  assert.equal(s.error, "boom S***");
});

test("round trip through the file: the next run reads what the last one wrote", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "status.json");
    writeStatus(file, priceBotStatus(readStatus(file), run(), { ok: false, error: "x", now: T0 }));
    writeStatus(file, priceBotStatus(readStatus(file), run(), { ok: false, error: "y", now: T0 + 120000 }));
    const s = readStatus(file);
    assert.equal(s.failsInRow, 2);
    assert.equal(s.failingSince, iso(T0));
    assert.equal(s.error, "y");
    assert.equal(s.history.length, 2);
    assert.ok(existsSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
