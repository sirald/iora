// End to end: the keeper's real main loop (keeper.js, unchanged, in a temporary copy) against a fake RPC and a fake
// Horizon ledger stream on 127.0.0.1 (testing/fake-net.js). Nothing leaves the machine: the network passphrase is a
// test one (no testnet defaults), the key is generated for the test, no Telegram, no .env or testnet files are read.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { FAKE_PASSPHRASE, startFakeNet } from "../testing/fake-net.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const keeperDir = path.join(here, "..");
const temps = [];
after(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// On a slow machine (one CPU, as the server: the keeper, the fake network and the test runner share it) the timing
// checks get SLOW times the time and need only 1/SLOW of the scans. E2E_SLOW=n sets it by hand.
const SLOW = Math.max(1, Number(process.env.E2E_SLOW || ((os.availableParallelism?.() ?? os.cpus().length) <= 1 ? 2 : 1)));
const need = (n) => Math.max(1, Math.floor(n / SLOW));
/** Waits until cond() is true (checked every 100 ms), at most maxMs; returns whether it became true. */
async function waitFor(cond, maxMs) {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    if (cond()) return true;
    await sleep(100);
  }
  return cond();
}

/** Starts the keeper against `net`; returns { scans, output(), status(), stop() }. */
function startKeeper(net, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iora-keeper-e2e-"));
  temps.push(dir);
  const run = path.join(dir, "keeper");
  fs.mkdirSync(run);
  for (const f of ["keeper.js", "lib.js", "package.json"]) fs.copyFileSync(path.join(keeperDir, f), path.join(run, f));
  fs.symlinkSync(path.join(keeperDir, "node_modules"), path.join(run, "node_modules"), "junction");
  const cid = () => StrKey.encodeContract(crypto.randomBytes(32));
  const env = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    NETWORK_PASSPHRASE: FAKE_PASSPHRASE,
    RPC_URL: net.rpcUrl,
    HORIZON_URL: net.horizonUrl,
    FACTORY: cid(),
    USDC: cid(),
    XLM: cid(),
    ROUTER: cid(),
    KEEPER_SECRET: Keypair.random().secret(),
    KEEPER_WORKERS: "0",
    SCAN_IDLE_SEC: "0",
    INTERVAL_SEC: "3",
    RPC_TIMEOUT_MS: "1500",
    RPC_MAX_RPS: "20", // the fake ledgers are faster than real ones (1 s instead of 5 s)
    LEDGER_SEC: "1",
    ...extraEnv,
  };
  const child = spawn(process.execPath, ["keeper.js", "--ttl"], { cwd: run, env });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const startedAt = Date.now();
  const scans = [];
  const beats = []; // [ms since start, heartbeat age in ms] every 100 ms
  const poll = setInterval(() => {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(run, "status.json"), "utf8"));
      if (s.last_scan && scans[scans.length - 1] !== s.last_scan) scans.push(s.last_scan);
      if (s.heartbeat) beats.push([Date.now() - startedAt, Date.now() - Date.parse(s.heartbeat)]);
    } catch {}
  }, 100);
  return {
    startedAt,
    scans,
    /** The oldest the heartbeat was seen between two moments (ms since the keeper started). */
    maxBeatAge: (fromMs, toMs) => Math.max(0, ...beats.filter(([t]) => t >= fromMs && t < toMs).map(([, a]) => a)),
    output: () => out,
    status: () => JSON.parse(fs.readFileSync(path.join(run, "status.json"), "utf8")),
    async stop() {
      clearInterval(poll);
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
    },
  };
}

/** Scans that finished between two moments (ms since the keeper started). */
const scansBetween = (k, fromMs, toMs) => k.scans.filter((t) => Date.parse(t) - k.startedAt >= fromMs && Date.parse(t) - k.startedAt < toMs).length;

async function withKeeper(netOpts, env, fn) {
  const net = await startFakeNet(netOpts);
  const k = startKeeper(typeof env === "function" ? net : net, typeof env === "function" ? env(net) : env);
  try {
    await fn(k, net);
  } finally {
    await k.stop();
    await net.close();
  }
}

describe("main loop end to end (fake RPC + fake Horizon)", { timeout: 400_000 * SLOW }, () => {
  test("the first scan comes within 5 s and the loop moves on every ledger", async () => {
    await withKeeper({ ledgerMs: 1000 }, {}, async (k) => {
      await sleep(9000);
      assert.ok(k.scans.length > 0, `no scan at all:\n${k.output()}`);
      assert.ok(Date.parse(k.scans[0]) - k.startedAt < 5000 * SLOW, "the first scan came late");
      // 6 ledgers between 3 s and 9 s: a scan on (nearly) every one
      assert.ok(scansBetween(k, 3000, 9000) >= need(5), `only ${scansBetween(k, 3000, 9000)} scans in 6 s\n${k.output()}`);
      assert.match(k.output(), /ledger stream: connected/);
      assert.match(k.output(), /first scan done in/);
      assert.equal(k.status().ledger_stream, "up");
    });
  });

  test("the stream drops every 3 ledgers: it reconnects and the loop keeps moving", async () => {
    await withKeeper({ ledgerMs: 1000, streamDropAfter: 3 }, {}, async (k, net) => {
      await sleep(11000);
      assert.ok(net.state.streamConnections >= 3, `${net.state.streamConnections} stream connections`);
      assert.ok(scansBetween(k, 3000, 11000) >= need(5), `only ${scansBetween(k, 3000, 11000)} scans in 8 s\n${k.output()}`);
    });
  });

  test("the stream is ahead of the RPC (2 ledgers): events are not lost and the loop keeps moving", async () => {
    await withKeeper({ ledgerMs: 1000, rpcLagLedgers: 2 }, {}, async (k) => {
      await sleep(9000);
      assert.ok(scansBetween(k, 3000, 9000) >= need(4), `only ${scansBetween(k, 3000, 9000)} scans in 6 s\n${k.output()}`);
      assert.doesNotMatch(k.output(), /could not read order events/);
    });
  });

  test("no Horizon at all: the keeper asks the RPC and still scans", async () => {
    await withKeeper({ ledgerMs: 1000, stream: false }, {}, async (k) => {
      await sleep(9000);
      assert.ok(k.scans.length >= 2, `only ${k.scans.length} scans\n${k.output()}`);
    });
  });

  test("the RPC stops answering for 8 s: no request waits for ever, and the loop recovers when the RPC is back", async () => {
    await withKeeper({ ledgerMs: 1000 }, { LOOP_STALL_SEC: "30" }, async (k, net) => {
      assert.ok(await waitFor(() => k.scans.length > 0, 10_000 * SLOW), `no scan before the hang:\n${k.output()}`);
      net.state.hang = true;
      await sleep(8000);
      net.state.hang = false;
      const atRecovery = k.scans.length;
      assert.ok(await waitFor(() => k.scans.length > atRecovery, 15_000 * SLOW), `no scan after the RPC came back\n${k.output()}`);
      assert.doesNotMatch(k.output(), /WATCHDOG/); // the loop kept moving (failing and retrying) the whole time
    });
  });

  test("a second RPC that never answers and a slow first one (the 068fd53 stall): the first scan of 40 vaults stays fast", async () => {
    // 068fd53 sent reads to the stuck server and waited its full 12 s timeout each time, silently: 20+ s here instead
    // of ~10 s, and on the real network (hundreds of reads, a busier first server) minutes without a log line.
    await withKeeper(
      { ledgerMs: 1000, vaults: 40, secondRpc: "hang", latencyMs: 300 },
      (net) => ({ RPC_FALLBACK: net.rpcUrl2, RPC_MAX_RPS: "4", RPC_TIMEOUT_MS: "12000" }),
      async (k) => {
        await waitFor(() => k.scans.length > 0, 20_000 * SLOW);
        assert.ok(k.scans.length > 0, `no first scan in ${20 * SLOW} s\n${k.output()}`);
        assert.ok(Date.parse(k.scans[0]) - k.startedAt < 15000 * SLOW, `first scan after ${Date.parse(k.scans[0]) - k.startedAt} ms`);
        assert.match(k.output(), /first scan: 40 vaults listed/);
      },
    );
  });

  test("ledger race: Horizon 600 ms behind the RPC: the RPC poll sees the ledgers first and wakes the loop", async () => {
    await withKeeper({ ledgerMs: 1000, streamDelayMs: 600 }, { LEDGER_POLL_MS: "100", LEDGER_POLL_EARLY_MS: "300" }, async (k, net) => {
      await sleep(10000);
      const s = k.status().ledger_sources;
      assert.ok(s.both >= need(4), `only ${s.both} ledgers seen by both\n${JSON.stringify(s)}`);
      assert.ok(s.rpc_first >= s.both / 2, `the RPC was first ${s.rpc_first} of ${s.both}\n${JSON.stringify(s)}`);
      assert.ok(s.rpc_lead_p50_ms > 200, `RPC lead ${s.rpc_lead_p50_ms} ms`);
      assert.ok(s.stream_after_close_p50_ms >= 400, `stream after close ${s.stream_after_close_p50_ms} ms`);
      assert.ok(scansBetween(k, 3000, 10000) >= need(5), `only ${scansBetween(k, 3000, 10000)} scans in 7 s\n${k.output()}`);
      assert.ok((net.state.calls.getLatestLedger || 0) < 10 * 12, `${net.state.calls.getLatestLedger} getLatestLedger calls`);
    });
  });

  test("ledger race: the stream first: the loop follows the stream, the RPC is still measured", async () => {
    await withKeeper({ ledgerMs: 1000 }, { LEDGER_POLL_MS: "100" }, async (k) => {
      await sleep(8000);
      const s = k.status();
      assert.equal(s.ledger_stream, "up");
      assert.ok(s.ledger_sources.ledgers >= need(5), JSON.stringify(s.ledger_sources));
      assert.ok(scansBetween(k, 3000, 8000) >= need(4), `only ${scansBetween(k, 3000, 8000)} scans in 5 s\n${k.output()}`);
    });
  });

  test("HTTP 429 for 4 s: the keeper slows down and carries on afterwards", async () => {
    await withKeeper({ ledgerMs: 1000 }, {}, async (k, net) => {
      assert.ok(await waitFor(() => k.scans.length > 0, 10_000 * SLOW), `no scan before the 429s\n${k.output()}`);
      net.state.tooMany = true;
      await sleep(4000);
      net.state.tooMany = false;
      const at = k.scans.length;
      // the rate limit has slowed down and comes back step by step: a scan within 20 s (it once took over 8 s on the
      // one-CPU server, where this test looked only once, after 8 s)
      const ok = await waitFor(() => k.scans.length > at, 20_000 * SLOW);
      assert.ok((net.state.calls["429"] || 0) > 0, "the fake never answered 429");
      assert.ok(ok, `no scan after the 429s ended\n${k.output()}`);
    });
  });

  test("the daily TTL round on a factory of 250 buckets (the 2026-11-27 stall): the loop and the heartbeat go on while the job list is read", async () => {
    // A version 9 factory with 250 buckets of 45 vaults (two pages each: one read per bucket to find the second page).
    // The first 250 bucket reads (the vault list) answer at once, every later one (the TTL preparation) after 400 ms:
    // the preparation takes ~2 minutes. Before, the loop waited for it all that time, status.json was not written and
    // the watchdog stayed quiet (the RPC ledger poll counted as progress).
    await withKeeper({ ledgerMs: 1000, chained: { buckets: 250, len: 45, slowAfter: 250, slowMs: 400 } }, { RPC_MAX_RPS: "100" }, async (k, net) => {
      assert.ok(await waitFor(() => net.state.bucketReads > 255, 40_000 * SLOW), `the TTL preparation did not start (${net.state.bucketReads} bucket reads)\n${k.output()}`);
      const from = Date.now() - k.startedAt;
      const events0 = net.state.calls.getEvents || 0;
      const reads0 = net.state.bucketReads;
      await sleep(25_000);
      const to = Date.now() - k.startedAt;
      const s = k.status();
      assert.equal(s.ttl_prep && s.ttl_prep.stage, "ttl-prep", JSON.stringify(s.ttl_prep)); // still preparing: the overlap is real
      assert.ok(s.background.some((w) => w.startsWith("ttl-prep")), JSON.stringify(s.background));
      assert.ok(net.state.bucketReads - reads0 >= need(20), `the preparation is not moving: ${net.state.bucketReads - reads0} reads in 25 s`);
      // the heartbeat never got old (the limit asked for is 60 s; the loop writes it on every ledger here)
      const age = k.maxBeatAge(from, to);
      assert.ok(age < 15_000, `the heartbeat was ${age} ms old during the TTL preparation\n${k.output().slice(-3000)}`);
      // the main loop went on: scans and the order events of every ledger (the fill path starts there)
      assert.ok(scansBetween(k, from, to) >= need(10), `only ${scansBetween(k, from, to)} scans in 25 s during the TTL preparation\n${k.output().slice(-3000)}`);
      assert.ok((net.state.calls.getEvents || 0) - events0 >= need(10), `only ${(net.state.calls.getEvents || 0) - events0} event reads`);
      assert.ok(s.loop_progress_age_sec < 15, JSON.stringify({ stage: s.stage, loop_progress_age_sec: s.loop_progress_age_sec }));
      assert.doesNotMatch(k.output(), /WATCHDOG/);
    });
  });
});
