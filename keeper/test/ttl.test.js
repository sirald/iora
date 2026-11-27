// The TTL job list (keeper.js factoryTtlJobs, run in a sandbox with a fake factory): which reads it needs, and that
// the next round reuses them; the band's reference price of one token (lib tokenReference); and the watchdog's idea
// of main-loop progress (keeper.js makeServer in a sandbox against a fake JSON-RPC on 127.0.0.1). No network.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Address, StrKey, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import * as lib from "../lib.js";
import { LoopWatch, tokenReference, ttlPageStarts } from "../lib.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "keeper.js"), "utf8").replace(/\r\n/g, "\n");
const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, `keeper.js: ${from.slice(0, 40)}`);
  return src.slice(a, b).replace(/^(const|let) (\w+) = /gm, "var $2 = ");
};

describe("TTL pages and the band's reference (lib)", () => {
  test("a bucket of up to 40 needs no read; a longer one reuses its pages while its head and length are the same", () => {
    assert.deepEqual(ttlPageStarts(undefined, "G1", 40), [null]);
    assert.deepEqual(ttlPageStarts(undefined, "G1", 1), [null]);
    assert.equal(ttlPageStarts(undefined, "G1", 41), null);
    const cached = { last: "G1", len: 85, froms: [null, "G2", "G3"] };
    assert.deepEqual(ttlPageStarts(cached, "G1", 85), [null, "G2", "G3"]);
    assert.equal(ttlPageStarts(cached, "G9", 86), null); // a new vault: read again
    assert.equal(ttlPageStarts(cached, "G1", 86), null);
  });

  test("tokenReference: fresh oracle, then a stablecoin's 1.0, then the newest price up to the fallback age, else none", () => {
    const now = 100_000;
    const o = { maxAgeSec: 600, fallbackSec: 1800, now };
    assert.deepEqual(tokenReference({ price: 5n, ts: now - 30 }, undefined, o), { price: 5n, src: "oracle", ageSec: 30 });
    // stale: a stablecoin is 1.0; another coin takes the newest price it has, if young enough
    assert.equal(tokenReference({ price: 5n, ts: now - 900 }, undefined, { ...o, oneUsd: 10n ** 14n }).src, "stablecoin 1.0");
    assert.deepEqual(tokenReference({ price: 5n, ts: now - 900 }, { price: 4n, ts: now - 1200 }, o), { price: 5n, src: "oracle price 15 min old", ageSec: 900 });
    // none now (the oracle did not answer): the last good one
    assert.deepEqual(tokenReference({ price: null }, { price: 4n, ts: now - 120 }, o), { price: 4n, src: "oracle price 2 min old", ageSec: 120 });
    assert.deepEqual(tokenReference({ price: null }, { price: 4n, ts: now - 3600 }, o), {});
    assert.deepEqual(tokenReference({ price: null }, undefined, o), {});
    assert.deepEqual(tokenReference({ price: 0n, ts: now }, undefined, o), {});
  });

  test("LoopWatch: the stage's start time stays while the same stage is reported again", () => {
    let t = 1000;
    const w = new LoopWatch({ stallMs: 60_000, now: () => t });
    w.stage("a");
    t = 5000;
    w.stage("a");
    assert.equal(w.stageAt, 1000);
    w.stage("b");
    assert.equal(w.stageAt, 5000);
  });
});

// ----- factoryTtlJobs in a sandbox -----
const ttlCode = cut("const TTL_PREP_PAUSE_MS =", "/** Starts the day's TTL round");
const plain = (v) => JSON.parse(JSON.stringify(v)); // values made in the sandbox (another realm)
const owner = () => StrKey.encodeEd25519PublicKey(crypto.randomBytes(32));

/** A version 9 factory: lens[i] is bucket i's length (0 = empty); the chains are made up from it. */
function fakeFactory(lens) {
  const F = StrKey.encodeContract(crypto.randomBytes(32));
  const chains = lens.map((n) => Array.from({ length: n }, owner)); // newest first
  const st = { count: lens.reduce((a, b) => a + b, 0), reads: {} };
  const read = async (contract, method, args = []) => {
    st.reads[method] = (st.reads[method] || 0) + 1;
    const a = args.map((x) => scValToNative(x));
    if (method === "vault_count") return { ok: true, value: st.count };
    if (method === "heads") {
      const out = [];
      for (let i = a[0]; i < Math.min(a[0] + a[1], 256, chains.length); i++) if (chains[i].length) out.push({ index: i, last: chains[i][0], len: chains[i].length });
      return { ok: true, value: out };
    }
    if (method === "bucket") {
      const c = chains[a[0]];
      const at = a[1] ? c.indexOf(a[1]) : 0;
      return { ok: true, value: c.slice(at, at + a[2]).map((o, k) => ({ owner: o, vault: "V", prev: c[at + k + 1] || null })) };
    }
    return { ok: false };
  };
  const ctx = vm.createContext({
    cfg: { TTL_PREP_PAUSE_MS: "0" },
    FACTORIES: [F],
    Math,
    Number,
    String,
    Map,
    Error,
    read,
    bucketsOf: async () => 256,
    isChained: async () => true,
    giveWay: async () => {},
    u32: (n) => xdr.ScVal.scvU32(n),
    optAddr: (o) => (o ? new Address(String(o)).toScVal() : xdr.ScVal.scvVoid()),
    errText: () => "error",
    short: (x) => String(x).slice(0, 4),
    ttlPageStarts,
  });
  vm.runInContext(ttlCode, ctx);
  const run = async () => {
    st.reads = {};
    const pr = { buckets: 0, of: 0, reads: 0, reused: 0 };
    const jobs = await ctx.factoryTtlJobs(pr);
    return { jobs, pr, reads: { ...st.reads } };
  };
  return { F, chains, st, run };
}

describe("TTL job list (keeper.js factoryTtlJobs, sandbox)", () => {
  test("250 buckets: short ones need no read, long ones one read per page after the first; the next round reads only the vault count", async () => {
    // 200 buckets of 5 vaults, 50 of 85 (three pages: two reads to find where pages 2 and 3 start), 6 empty
    const lens = [...Array(200).fill(5), ...Array(50).fill(85), ...Array(6).fill(0)];
    const f = fakeFactory(lens);
    const r1 = await f.run();
    assert.equal(r1.jobs.length, 200 + 50 * 3);
    assert.deepEqual(r1.reads, { vault_count: 1, heads: 4, bucket: 100 }); // before: 250 bucket reads and more, every day
    assert.equal(r1.pr.of, 250);
    // the pages of a long bucket start where the chain says
    const long = r1.jobs.filter((j) => j.bucket === 200);
    assert.deepEqual(plain(long.map((j) => j.from)), [null, f.chains[200][40], f.chains[200][80]]);
    // the next day, nothing added: one read
    const r2 = await f.run();
    assert.deepEqual(r2.reads, { vault_count: 1 });
    assert.deepEqual(plain(r2.jobs), plain(r1.jobs));
    // a vault added to one long bucket: the heads, and that bucket only
    f.chains[210].unshift(owner());
    f.st.count++;
    const r3 = await f.run();
    assert.deepEqual(r3.reads, { vault_count: 1, heads: 4, bucket: 2 });
    assert.equal(r3.pr.reused, 249);
    assert.equal(r3.jobs.filter((j) => j.bucket === 210).length, 3); // 86 vaults: still three pages
    assert.equal(r3.jobs.filter((j) => j.bucket === 210)[1].from, f.chains[210][40]);
  });
});

// ----- the watchdog's progress: only what the main loop waits for -----
const rpcCode = cut("const rpcCallCtx = new AsyncLocalStorage();", "// Telegram notifications");
const servers = [];
after(async () => {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(r));
  }
});

describe("main-loop progress for the watchdog (keeper.js makeServer, sandbox)", () => {
  test("an RPC answer counts only inside the main loop: not from the ledger poll, not from background work", async () => {
    const s = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { id } = JSON.parse(body);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result: { status: "healthy", latestLedger: 5, oldestLedger: 1, ledgerRetentionWindow: 10 } }));
      });
    });
    servers.push(s);
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    let progress = 0;
    const ctx = vm.createContext({
      ...lib,
      AsyncLocalStorage,
      rpc,
      xdr,
      RPC_URLS: [`http://127.0.0.1:${s.address().port}`],
      RPC_MAX_RPS: [50],
      RPC_BURST: 8,
      RPC_TIMEOUT_MS: 3000,
      RPC_RETRY_BASE_SEC: 30,
      RPC_RETRY_MAX_SEC: 600,
      RPC_429_SWITCH_AFTER: 3,
      RPC_SPREAD_READS: false,
      loopWatch: { safe: () => false, progress: () => progress++ },
      log: () => {},
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      Date,
      setTimeout,
      clearTimeout,
      AbortController,
      Promise,
      Error,
      Object,
    });
    vm.runInContext(rpcCode, ctx);
    const server = vm.runInContext("makeServer(RPC_URLS)", ctx);
    await server.getHealth(); // a loop of its own (as the ledger poll): not the main loop
    assert.equal(progress, 0);
    await ctx.mainLoopCtx.run(true, async () => {
      await server.getHealth(); // the main loop's own read
      await ctx.low(() => server.getHealth()); // the main loop waits for it, at background priority
      await ctx.background(() => server.getHealth()); // work it starts and leaves running
    });
    assert.equal(progress, 2);
  });
});
