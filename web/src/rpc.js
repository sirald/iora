// Soroban RPC connection: the fast server first, a fallback if there is a problem.
//
// Stellar's free testnet RPC (soroban-testnet.stellar.org) answers in 1.5-5 s from some connections
// (measured 8 Nov 2026); Gateway's public testnet RPC does the same job in about 0.15 s. The app makes dozens of
// reads when it opens, so this difference directly sets how long the page takes to load.
// If the first server gives a network error, returns 429/5xx or does not answer within TIMEOUT_MS, the same call
// is repeated on the next server; a minute later the first server is tried again. Contract errors (a simulation
// error, "account not found" and the like) are real answers: they are not repeated on another server.
import { Account, Keypair, rpc, xdr } from "@stellar/stellar-sdk";

export const RPC_PRIMARY = "https://soroban-rpc.testnet.stellar.gateway.fm";
export const RPC_FALLBACK = "https://soroban-testnet.stellar.org";
const TIMEOUT_MS = 8000;
const RETRY_PRIMARY_MS = 60_000;

// The Stellar SDK adds X-Client-Name / X-Client-Version headers to every request. Gateway's browser (CORS) setting
// does not allow these headers, so the browser never sent the request; the SDK reported that network error as
// "Account not found" (8 Nov 2026). The headers are informational only: they are removed from requests to our RPC addresses.
const rpcBases = new Set();
function stripClientHeaders(headers) {
  const h = new Headers(headers || {});
  h.delete("x-client-name");
  h.delete("x-client-version");
  return h;
}
if (typeof window !== "undefined" && typeof window.fetch === "function" && !window.__ioraRpcFetch) {
  const orig = window.fetch.bind(window);
  window.__ioraRpcFetch = true;
  window.fetch = (input, init) => {
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
      if (url && [...rpcBases].some((b) => url.startsWith(b))) {
        if (init) init = { ...init, headers: stripClientHeaders(init.headers) };
        else if (input instanceof Request) input = new Request(input, { headers: stripClientHeaders(input.headers) });
      }
    } catch {}
    return orig(input, init);
  };
}

function transient(e) {
  const status = e && e.response && e.response.status;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  return /failed to fetch|network|timeout|timed out|aborted|ECONN|socket|load failed|did not answer/i.test(String((e && e.message) || e));
}

// The SDK's getAccount reports every case where the account cannot be read (network error, CORS included) as
// "Account not found"; so when the first server went down there was no falling back, and every transaction to be
// signed stopped with that error. The same read is done here with getLedgerEntries: a network error is retried on
// the next server, and an account that really does not exist returns "Account not found" in one call (no slow fallback). Same read as getAccount in SDK 17.4.0.
function accountKey(address) {
  return xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrPublicKey() }));
}

/** urls: RPC addresses to try (in order). The returned object has the same methods as rpc.Server. */
export function makeServer(urls) {
  const list = [...new Set(urls.filter(Boolean))];
  for (const u of list) rpcBases.add(u.replace(/\/+$/, ""));
  const servers = list.map((u) => new rpc.Server(u, { allowHttp: u.startsWith("http://") }));
  let cur = 0;
  let switchedAt = 0;

  async function call(name, args) {
    if (cur !== 0 && Date.now() - switchedAt > RETRY_PRIMARY_MS) cur = 0;
    let lastErr;
    for (let i = 0; i < servers.length; i++) {
      const idx = (cur + i) % servers.length;
      let timer;
      try {
        const res = await Promise.race([
          servers[idx][name](...args),
          new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("the RPC did not answer (timeout)")), TIMEOUT_MS))),
        ]);
        if (idx !== cur) {
          cur = idx;
          switchedAt = Date.now();
        }
        return res;
      } catch (e) {
        lastErr = e;
        if (!transient(e)) throw e;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  async function getAccount(address) {
    const res = await call("getLedgerEntries", [accountKey(address)]);
    const entry = res && res.entries && res.entries[0];
    if (!entry || !entry.val || entry.val.type !== "account") throw new Error(`Account not found: ${address}`);
    return new Account(address, entry.val.value.seqNum.toString());
  }

  return new Proxy(
    {},
    {
      get(_, name) {
        if (name === "urls") return list;
        if (name === "getAccount") return getAccount;
        // "then" and non-method fields are returned as they are: the object must not hang if it is awaited by mistake.
        const v = servers[0][name];
        if (name === "then" || typeof name === "symbol" || (v !== undefined && typeof v !== "function")) return v;
        return (...args) => call(name, args);
      },
    },
  );
}
