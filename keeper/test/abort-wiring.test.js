// The keeper cancels a slow RPC request with an AbortController that reaches the SDK's HTTP client through
// AsyncLocalStorage and a request interceptor (keeper.js makeServer). This checks that wiring against the real SDK
// with a stand-in fetch: nothing leaves the machine.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test } from "node:test";
import { rpc } from "@stellar/stellar-sdk";

test("an aborted call cancels the SDK's fetch", async () => {
  const realFetch = globalThis.fetch;
  let seenSignal = null;
  globalThis.fetch = (url, init = {}) => {
    seenSignal = init.signal;
    return new Promise((_, reject) => {
      if (!init.signal) return; // would hang forever without a signal
      init.signal.addEventListener("abort", () => reject(init.signal.reason || new Error("aborted")));
    });
  };
  try {
    const ctx = new AsyncLocalStorage();
    const s = new rpc.Server("https://rpc.invalid", { timeout: 60_000 });
    s.httpClient.interceptors.request.use((config) => {
      const signal = ctx.getStore();
      if (signal) config.signal = signal;
      return config;
    });
    const ac = new AbortController();
    const p = ctx.run(ac.signal, () => s.getLatestLedger());
    setTimeout(() => ac.abort(new Error("the RPC did not answer within 50 ms")), 50);
    await assert.rejects(p);
    assert.ok(seenSignal, "fetch got a signal");
    assert.equal(seenSignal.aborted, true, "the request itself was cancelled");
  } finally {
    globalThis.fetch = realFetch;
  }
});
