// One signed transaction sent to every RPC server at once (RPC_SEND_ALL): the keeper's real RPC proxy code
// (keeper.js makeServer) run in a sandbox against two fake JSON-RPC servers on 127.0.0.1. Nothing leaves the machine.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Account, Keypair, Operation, TransactionBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import * as lib from "../lib.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "keeper.js"), "utf8").replace(/\r\n/g, "\n");
const start = src.indexOf("const rpcCallCtx = new AsyncLocalStorage();");
const end = src.indexOf("// Telegram notifications", start);
const rpcCode = src.slice(start, end).replace(/^(const|let) (\w+) = /gm, "var $2 = ");
const PASS = "Iora fake network for tests ; 2026";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const servers = [];
after(async () => {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(r));
  }
});

/** A fake RPC that answers sendTransaction with `reply` after `delayMs` (reply "hang": never answers). */
async function fakeRpc({ reply = "PENDING", delayMs = 0 } = {}) {
  const st = { sends: 0, hashes: [] };
  const s = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body);
      if (method !== "sendTransaction") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -1, message: "no" } }));
      st.sends++;
      const tx = TransactionBuilder.fromXDR(params.transaction, PASS);
      st.hashes.push(tx.hash().toString("hex"));
      if (reply === "hang") return;
      const out = JSON.stringify({ jsonrpc: "2.0", id, result: { status: reply, hash: tx.hash().toString("hex"), latestLedger: 10, latestLedgerCloseTime: "0" } });
      setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(out), delayMs);
    });
  });
  servers.push(s);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${s.address().port}`, st };
}

function proxyFor(urls) {
  const logs = [];
  const ctx = vm.createContext({
    ...lib,
    AsyncLocalStorage,
    rpc,
    xdr,
    Account,
    Keypair,
    RPC_URLS: urls,
    RPC_MAX_RPS: urls.map(() => 20),
    RPC_BURST: 8,
    RPC_TIMEOUT_MS: 3000,
    RPC_RETRY_BASE_SEC: 30,
    RPC_RETRY_MAX_SEC: 600,
    RPC_429_SWITCH_AFTER: 3,
    RPC_SPREAD_READS: true,
    loopWatch: { safe: () => false, progress() {} },
    log: (l) => logs.push(l),
    sleep,
    Date,
    setTimeout,
    clearTimeout,
    AbortController,
    Promise,
    Error,
    Object,
  });
  vm.runInContext(rpcCode, ctx);
  return { server: vm.runInContext("makeServer(RPC_URLS)", ctx), ctx, logs };
}

function signedTx() {
  const kp = Keypair.random();
  const tx = new TransactionBuilder(new Account(kp.publicKey(), "1"), { fee: "100", networkPassphrase: PASS })
    .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
    .setTimeout(30)
    .build();
  tx.sign(kp);
  return tx;
}

describe("sendTransaction to every RPC server", () => {
  test("both servers get the same signed transaction; the first PENDING wins", async () => {
    const a = await fakeRpc({ reply: "PENDING", delayMs: 300 });
    const b = await fakeRpc({ reply: "PENDING", delayMs: 0 });
    const { server, ctx } = proxyFor([a.url, b.url]);
    const tx = signedTx();
    const t0 = Date.now();
    const r = await server.sendTransactionAll(tx);
    assert.equal(r.status, "PENDING");
    assert.equal(r.via, 1, "the copy to the second server answered first");
    assert.ok(Date.now() - t0 < 250, "it did not wait for the slow server");
    await sleep(400);
    assert.equal(a.st.sends, 1);
    assert.equal(b.st.sends, 1);
    assert.equal(a.st.hashes[0], b.st.hashes[0], "the same hash: the network applies it once at most");
    assert.equal(ctx.sendAllStats.firstByCopy, 1);
    assert.equal(ctx.rpcPicker.cur, 0, "a copy never moves the current server");
  });

  test("DUPLICATE on one server is no problem while the other takes it", async () => {
    const a = await fakeRpc({ reply: "DUPLICATE" });
    const b = await fakeRpc({ reply: "PENDING", delayMs: 50 });
    const { server } = proxyFor([a.url, b.url]);
    const r = await server.sendTransactionAll(signedTx());
    assert.ok(r.status === "DUPLICATE" || r.status === "PENDING");
  });

  test("a hanging copy does not hold up the send", async () => {
    const a = await fakeRpc({ reply: "PENDING" });
    const b = await fakeRpc({ reply: "hang" });
    const { server, ctx } = proxyFor([a.url, b.url]);
    const t0 = Date.now();
    const r = await server.sendTransactionAll(signedTx());
    assert.equal(r.status, "PENDING");
    assert.equal(r.via, 0);
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(ctx.rpcPicker.cur, 0);
  });

  test("nobody took it: the usual server's answer comes back (TRY_AGAIN_LATER), after at most the grace time", async () => {
    const a = await fakeRpc({ reply: "TRY_AGAIN_LATER" });
    const b = await fakeRpc({ reply: "hang" });
    const { server } = proxyFor([a.url, b.url]);
    const t0 = Date.now();
    const r = await server.sendTransactionAll(signedTx());
    assert.equal(r.status, "TRY_AGAIN_LATER");
    assert.ok(Date.now() - t0 < 3500);
  });

  test("one server only: a plain sendTransaction", async () => {
    const a = await fakeRpc({ reply: "PENDING" });
    const { server } = proxyFor([a.url]);
    const r = await server.sendTransactionAll(signedTx());
    assert.equal(r.status, "PENDING");
    assert.equal(a.st.sends, 1);
  });
});
