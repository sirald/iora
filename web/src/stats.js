// Live testnet numbers on the home page: a free read from the chain (simulation), no signature.
// Loaded dynamically when the page comes near this section, so the Stellar SDK does not slow the home page down.
import "./polyfill.js";
import { Account, BASE_FEE, Contract, Networks, TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr, Address } from "@stellar/stellar-sdk";
import { makeServer, RPC_FALLBACK, RPC_PRIMARY } from "./rpc.js";

const E = import.meta.env;
const server = makeServer([E.VITE_RPC_URL, E.VITE_RPC_FALLBACK, RPC_PRIMARY, RPC_FALLBACK]);
// Any existing account is enough for reading; the USDC issuer always exists.
const SOURCE = E.VITE_USDC_ISSUER || "GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56";
const MAX_VAULTS = 150;

async function read(id, method, args = []) {
  const tx = new TransactionBuilder(new Account(SOURCE, "0"), { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(id).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return sim.result ? scValToNative(sim.result.retval) : undefined;
}
const u32 = (n) => nativeToScVal(n, { type: "u32" });

// At most `n` requests at the same time
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        try {
          out[k] = await fn(items[k]);
        } catch {
          out[k] = null;
        }
      }
    }),
  );
  return out;
}

async function vaultsOf(factory) {
  if (!factory) return [];
  const count = Number(await read(factory, "vault_count"));
  const list = [];
  for (let s = 0; s < Math.min(count, MAX_VAULTS); s += 50) list.push(...(await read(factory, "vaults", [u32(s), u32(50)])));
  return { count, list: list.slice(0, MAX_VAULTS) };
}

async function vaultFacts(v) {
  const [bal, n] = await Promise.all([read(v, "balance"), read(v, "order_count")]);
  const orders = await pool([...Array(Number(n)).keys()], 4, (id) => read(v, "get_order", [u32(id)]));
  let open = 0, filled = 0;
  const now = Date.now() / 1000;
  for (const o of orders) {
    if (!o) continue;
    const st = Array.isArray(o.status) ? o.status[0] : o.status?.tag || String(o.status);
    if (st === "Open" && Number(o.expiry) > now) open++;
    if (BigInt(o.filled_in) > 0n) filled++;
  }
  return { bal: Number(BigInt(bal)) / 1e7, open, filled };
}

export async function loadStats() {
  const KEY = "iora-live-v1";
  try {
    const c = JSON.parse(sessionStorage.getItem(KEY) || "null");
    if (c && Date.now() - c.t < 5 * 60 * 1000) return c.v;
  } catch {}
  const [buy, sell] = await Promise.all([vaultsOf(E.VITE_FACTORY), vaultsOf(E.VITE_FACTORY_SELL)]);
  let px = 0;
  try {
    const q = await read(E.VITE_ROUTER, "router_get_amounts_out", [
      nativeToScVal(10_000_000n, { type: "i128" }),
      xdr.ScVal.scvVec([new Address(E.VITE_XLM).toScVal(), new Address(E.VITE_USDC).toScVal()]),
    ]);
    px = Number(BigInt(q[q.length - 1])) / 1e7;
  } catch {}
  const bf = await pool(buy.list || [], 6, vaultFacts);
  const sf = await pool(sell.list || [], 6, vaultFacts);
  const sum = (arr, k) => arr.reduce((s, x) => s + (x ? x[k] : 0), 0);
  const v = {
    vaults: (buy.count || 0) + (sell.count || 0),
    open: sum(bf, "open") + sum(sf, "open"),
    filled: sum(bf, "filled") + sum(sf, "filled"),
    tvl: sum(bf, "bal") + sum(sf, "bal") * px,
  };
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ t: Date.now(), v }));
  } catch {}
  return v;
}
