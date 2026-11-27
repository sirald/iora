// A fake Stellar network for the keeper's end-to-end tests: a JSON-RPC server (getLatestLedger, getEvents,
// simulateTransaction, getLedgerEntries, getFeeStats) and a Horizon /ledgers server-sent-events stream, both on
// 127.0.0.1 only. Ledgers advance on a timer. Nothing leaves the machine.
import http from "node:http";
import crypto from "node:crypto";
import { Address, SorobanDataBuilder, StrKey, TransactionBuilder, scValToNative, xdr } from "@stellar/stellar-sdk";

export const FAKE_PASSPHRASE = "Iora fake network for tests ; 2026";

/**
 * opts: ledgerMs (time between ledgers), rpcLagLedgers (the RPC is this many ledgers behind Horizon),
 * streamDropAfter (Horizon ends each stream after this many ledgers; 0 = never), stream (false = no Horizon).
 */
// vaults: how many (empty) vaults the factory lists (< 50: one page); secondRpc: "hang" adds a second RPC server that
// takes requests and never answers (a stuck fallback such as a slow public RPC).
// latencyMs: how long the main RPC takes to answer. streamDelayMs: Horizon announces each ledger this long after the
// RPC has it (the RPC can then be first).
// chained: a version 9 factory (buckets as chains) instead: { buckets (non-empty ones, of 256), len (each bucket's
// length in `heads`), slowAfter (bucket reads after this many answer only after slowMs) }. Its `bucket` pages are empty,
// so it lists no vaults; it is there for the TTL job list (the 2026-11-27 stall: 228 bucket reads in a row).
export async function startFakeNet({ ledgerMs = 400, rpcLagLedgers = 0, streamDropAfter = 0, stream = true, vaults = 0, secondRpc = null, latencyMs = 0, streamDelayMs = 0, chained = null } = {}) {
  const vaultIds = Array.from({ length: vaults }, () => StrKey.encodeContract(crypto.randomBytes(32)));
  // hang: the RPC takes requests but never answers; tooMany: the RPC answers HTTP 429 (with Retry-After: 1)
  const state = { ledger: 1000, calls: {}, streamConnections: 0, streamClients: new Set(), events: [], hang: false, tooMany: false, bucketReads: 0 };
  const lastOwner = chained ? Array.from({ length: chained.buckets }, () => StrKey.encodeEd25519PublicKey(crypto.randomBytes(32))) : [];
  const u32 = (n) => xdr.ScVal.scvU32(n);
  const entry = (k, v) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v });
  const count = (m) => (state.calls[m] = (state.calls[m] || 0) + 1);
  const rpcLedger = () => state.ledger - rpcLagLedgers;

  const tick = setInterval(() => {
    state.ledger++;
    const seq = state.ledger;
    const closedAt = new Date().toISOString();
    const announce = () => {
      for (const c of [...state.streamClients]) {
        c.res.write(`id: ${seq}-0\ndata: {"sequence": ${seq}, "closed_at": "${closedAt}"}\n\n`);
        c.sent++;
        if (streamDropAfter && c.sent >= streamDropAfter) {
          state.streamClients.delete(c);
          c.res.end();
        }
      }
    };
    if (streamDelayMs > 0) setTimeout(announce, streamDelayMs);
    else announce();
  }, ledgerMs);

  const emptyData = new SorobanDataBuilder().build().toXDR("base64");
  const ok = (id, result) => JSON.stringify({ jsonrpc: "2.0", id, result });
  const fail = (id, message) => JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32600, message } });

  function simulate(id, params) {
    let fn = "?";
    let args = [];
    try {
      const tx = TransactionBuilder.fromXDR(params.transaction, FAKE_PASSPHRASE);
      // XDR fields are properties in SDK 17 and functions in older versions
      const get = (o, k) => (typeof o[k] === "function" ? o[k]() : o[k]);
      const inv = get(tx.operations[0].func, "invokeContract");
      fn = String(get(inv, "functionName"));
      args = get(inv, "args") || [];
    } catch {}
    count(`simulate:${fn}`);
    const base = { latestLedger: rpcLedger(), minResourceFee: "100", transactionData: emptyData };
    const answer = (v) => ok(id, { ...base, results: [{ auth: [], xdr: v.toXDR("base64") }] });
    if (chained) {
      if (fn === "bucket_count") return answer(u32(256));
      if (fn === "vault_count") return answer(u32(0));
      if (fn === "heads") {
        const start = Number(scValToNative(args[0]));
        const limit = Number(scValToNative(args[1]));
        const list = [];
        for (let i = start; i < Math.min(start + limit, chained.buckets); i++) {
          list.push(xdr.ScVal.scvMap([entry("index", u32(i)), entry("last", new Address(lastOwner[i]).toScVal()), entry("len", u32(chained.len))]));
        }
        return answer(xdr.ScVal.scvVec(list));
      }
      if (fn === "bucket") {
        state.bucketReads++;
        const out = answer(xdr.ScVal.scvVec([]));
        return state.bucketReads > (chained.slowAfter ?? Infinity) ? { slowMs: chained.slowMs || 0, out } : out;
      }
    }
    // the factory lists no vaults; every other read is a contract error (a simulation error, not an RPC error)
    if (fn === "vaults") {
      const list = xdr.ScVal.scvVec(vaultIds.map((v) => new Address(v).toScVal()));
      return ok(id, { ...base, results: [{ auth: [], xdr: list.toXDR("base64") }] });
    }
    // a vault with no orders: order 0 is "not found" (contract error #3)
    if (fn === "get_order") return ok(id, { latestLedger: rpcLedger(), error: "HostError: Error(Contract, #3)" });
    return ok(id, { latestLedger: rpcLedger(), error: "HostError: Error(Contract, #1)" });
  }

  const rpcServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const { id, method, params } = msg;
      count(method);
      if (state.hang) return; // never answered (the keeper's own timeout must end it)
      if (state.tooMany) {
        count("429");
        res.writeHead(429, { "retry-after": "1", "content-type": "application/json" }).end("{}");
        return;
      }
      let out;
      if (method === "getLatestLedger") out = ok(id, { id: "x", sequence: rpcLedger(), protocolVersion: 23 });
      else if (method === "getEvents") {
        const start = params && params.startLedger;
        if (start && start > rpcLedger()) out = fail(id, `startLedger must be between the oldest ledger: 1 and the latest ledger: ${rpcLedger()}`);
        else out = ok(id, { events: state.events.splice(0), latestLedger: rpcLedger(), cursor: "" });
      } else if (method === "simulateTransaction") {
        out = simulate(id, params);
        if (out && out.slowMs) {
          const { slowMs, out: later } = out;
          setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(later), slowMs);
          return;
        }
      }
      else if (method === "getLedgerEntries") out = ok(id, { entries: [], latestLedger: rpcLedger() });
      else if (method === "getFeeStats") out = ok(id, { sorobanInclusionFee: { p70: "100" }, inclusionFee: { p70: "100" }, latestLedger: rpcLedger() });
      else out = fail(id, `fake RPC: ${method} is not served`);
      if (latencyMs > 0) setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(out), latencyMs);
      else res.writeHead(200, { "content-type": "application/json" }).end(out);
    });
  });

  const horizon = http.createServer((req, res) => {
    if (!stream || !req.url.startsWith("/ledgers")) {
      res.writeHead(404).end();
      return;
    }
    state.streamConnections++;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write('retry: 1000\nevent: open\ndata: "hello"\n\n');
    const c = { res, sent: 0 };
    state.streamClients.add(c);
    req.on("close", () => state.streamClients.delete(c));
  });

  const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
  const rpcPort = await listen(rpcServer);
  const horizonPort = await listen(horizon);
  let second = null;
  if (secondRpc === "hang") {
    second = http.createServer((req) => {
      count("second:request");
      req.resume(); // read it, never answer
    });
    await listen(second);
  }
  return {
    state,
    rpcUrl: `http://127.0.0.1:${rpcPort}`,
    rpcUrl2: second ? `http://127.0.0.1:${second.address().port}` : null,
    horizonUrl: `http://127.0.0.1:${horizonPort}`,
    async close() {
      clearInterval(tick);
      for (const c of state.streamClients) c.res.end();
      rpcServer.closeAllConnections?.();
      horizon.closeAllConnections?.();
      second?.closeAllConnections?.();
      await Promise.all([new Promise((r) => rpcServer.close(r)), new Promise((r) => horizon.close(r)), second ? new Promise((r) => second.close(r)) : null]);
    },
  };
}
