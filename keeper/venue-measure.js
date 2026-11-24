// What would each trading venue pay on the REAL market (mainnet)? Read-only: every call is a simulation, nothing
// is signed, nothing is sent, no key is used.
// For a range of trade sizes in both directions it quotes Soroswap, every Aquarius pool and Phoenix side by side,
// then works out the best split of the amount across all of those pools (in 10 slices) and what that would add
// over the best single pool. It also prints how Phoenix's functions are called, to check the keeper's assumptions.
// Usage: node keeper/venue-measure.js            (mainnet; RPC_URL overrides the RPC server)
//        node keeper/venue-measure.js --testnet  (the testnet addresses of testnet/addr.env and testnet/filler.env)
import { readFileSync, existsSync } from "node:fs";
import { Account, Address, BASE_FEE, Contract, Keypair, Networks, StrKey, TransactionBuilder, contract, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

const TESTNET = process.argv.includes("--testnet");
const envFile = (name) => {
  const url = new URL(`../testnet/${name}`, import.meta.url);
  if (!existsSync(url)) return {};
  return Object.fromEntries(
    readFileSync(url, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
};
const t = TESTNET ? { ...envFile("addr.env"), ...envFile("filler.env") } : {};
const NET = TESTNET
  ? { USDC: t.USDC, XLM: t.XLM, SOROSWAP: t.ROUTER, AQUA: t.AQUA_ROUTER || "", PHOENIX: t.PHOENIX_MULTIHOP || "" }
  : {
      // Circle's USDC and native XLM as Stellar Asset Contracts; the routers as listed in soroswap/core and soroswap/aggregator.
      USDC: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
      XLM: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
      SOROSWAP: "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH",
      AQUA: "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK",
      PHOENIX: "CCLZRD4E72T7JCZCN3P7KNPYNXFYKQCL64ECLX7WP5GNVYPYJGU2IO2G",
    };
const RPC_URL = process.env.RPC_URL || (TESTNET ? "https://soroban-testnet.stellar.org" : "https://soroban-rpc.mainnet.stellar.gateway.fm");
const PASSPHRASE = TESTNET ? Networks.TESTNET : Networks.PUBLIC;
const server = new rpc.Server(RPC_URL);
const source = new Account(Keypair.random().publicKey(), "0");
const UNIT = 10_000_000n;

const addr = (a) => new Address(a).toScVal();
const i128 = (n) => nativeToScVal(BigInt(n), { type: "i128" });
const u128 = (n) => nativeToScVal(BigInt(n), { type: "u128" });
const u32 = (n) => nativeToScVal(n, { type: "u32" });
const sym = (x) => xdr.ScVal.scvSymbol(x);
const struct = (o) => xdr.ScVal.scvMap(Object.keys(o).sort().map((k) => new xdr.ScMapEntry({ key: sym(k), val: o[k] })));
const xget = (o, n) => (typeof o[n] === "function" ? o[n]() : o[n]);
const fmt = (n, d = 2) => (Number(n) / 1e7).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const name = (a) => (a === NET.USDC ? "USDC" : a === NET.XLM ? "XLM" : a.slice(0, 4));

/**
 * One simulated call. Returns the raw result value, or null if the call fails.
 * Public RPC servers throttle bursts, so calls go one at a time with a short pause, and a call that fails for a
 * network reason (not a contract error) is tried again a few times. The last failure is kept in `lastError`.
 */
let lastError = "";
let chain = Promise.resolve();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function sim(id, fn, args) {
  const run = async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await pause(attempt === 0 ? 120 : 1500 * attempt);
      try {
        const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: PASSPHRASE }).addOperation(new Contract(id).call(fn, ...args)).setTimeout(60).build();
        const r = await server.simulateTransaction(tx);
        if (rpc.Api.isSimulationError(r)) {
          lastError = `${fn}: ${String(r.error).split("\n")[0].slice(0, 160)}`;
          return null; // the contract said no: asking again would not help
        }
        return r.result ? r.result.retval : null;
      } catch (e) {
        lastError = `${fn}: ${String(e.message || e).split("\n")[0].slice(0, 160)}`;
      }
    }
    return null;
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}
const big = (v) => {
  try {
    return v === null || v === undefined ? null : BigInt(v);
  } catch {
    return null;
  }
};

// ----- the pools -----
const aquaTokens = (a, b) => xdr.ScVal.scvVec([a, b].sort((x, y) => Buffer.compare(StrKey.decodeContract(x), StrKey.decodeContract(y))).map(addr));
async function aquaPools(a, b) {
  if (!NET.AQUA) return [];
  const map = await sim(NET.AQUA, "get_pools", [aquaTokens(a, b)]);
  if (!map) return [];
  const entries = (typeof map.map === "function" ? map.map() : map.value ?? map._value) || [];
  const out = [];
  for (const e of entries) {
    const kn = scValToNative(xget(e, "key"));
    const hash = Buffer.from(kn instanceof Uint8Array ? kn : Object.values(kn));
    if (hash.length === 32) out.push(hash);
  }
  return out;
}
const phoenixOps = (tin, tout) => xdr.ScVal.scvVec([struct({ offer_asset: addr(tin), ask_asset: addr(tout), ask_asset_min_amount: xdr.ScVal.scvVoid() })]);

/** Every pool that can swap the pair, as { label, quote(amount) -> bigint | null }. */
async function poolsFor(tin, tout) {
  const list = [
    {
      label: "Soroswap",
      quote: async (amt) => {
        const v = await sim(NET.SOROSWAP, "router_get_amounts_out", [i128(amt), xdr.ScVal.scvVec([addr(tin), addr(tout)])]);
        const n = v && scValToNative(v);
        return n ? big(n[n.length - 1]) : null;
      },
    },
  ];
  for (const hash of await aquaPools(tin, tout)) {
    list.push({
      label: `Aquarius ${hash.toString("hex").slice(0, 6)}`,
      quote: async (amt) => {
        const v = await sim(NET.AQUA, "estimate_swap", [aquaTokens(tin, tout), addr(tin), addr(tout), xdr.ScVal.scvBytes(hash), u128(amt)]);
        return v ? big(scValToNative(v)) : null;
      },
    });
  }
  if (NET.PHOENIX) {
    list.push({
      label: "Phoenix",
      quote: async (amt) => {
        const v = await sim(NET.PHOENIX, "simulate_swap", [phoenixOps(tin, tout), i128(amt), u32(0)]);
        const n = v && scValToNative(v);
        return n && n.ask_amount !== undefined ? big(n.ask_amount) : null;
      },
    });
  }
  return list;
}

/**
 * The best split of `amount` over the pools, found greedily in `slices` equal slices: each slice goes to the pool
 * that pays the most for it on top of what that pool already took. Returns { out, shares: {label: percent} }.
 */
async function bestSplit(pools, amount, slices = 10) {
  const step = amount / BigInt(slices);
  const taken = pools.map(() => 0n);
  const got = pools.map(() => 0n);
  for (let s = 0; s < slices; s++) {
    const size = s === slices - 1 ? amount - step * BigInt(slices - 1) : step;
    const next = await Promise.all(pools.map((p, i) => p.quote(taken[i] + size)));
    let pick = -1;
    let gain = -1n;
    next.forEach((q, i) => {
      if (q !== null && q - got[i] > gain) {
        gain = q - got[i];
        pick = i;
      }
    });
    if (pick < 0) return null;
    taken[pick] += size;
    got[pick] = next[pick];
  }
  const shares = {};
  pools.forEach((p, i) => {
    if (taken[i] > 0n) shares[p.label] = Number((taken[i] * 1000n) / amount) / 10;
  });
  return { out: got.reduce((a, b) => a + b, 0n), shares };
}

console.log(`Network   ${TESTNET ? "testnet" : "MAINNET (read-only)"}   RPC ${RPC_URL}`);
console.log(`Soroswap  ${NET.SOROSWAP}\nAquarius  ${NET.AQUA || "-"}\nPhoenix   ${NET.PHOENIX || "-"}`);

// How Phoenix's functions are called on this network (the keeper builds its arguments from these names).
if (NET.PHOENIX) {
  try {
    const client = await contract.Client.from({ contractId: NET.PHOENIX, rpcUrl: RPC_URL, networkPassphrase: PASSPHRASE });
    for (const f of client.spec.funcs()) {
      const n = String(xget(f, "name"));
      if (n === "swap" || n === "simulate_swap") console.log(`Phoenix ${n}(${(xget(f, "inputs") || []).map((i) => String(xget(i, "name"))).join(", ")})`);
    }
  } catch (e) {
    console.log(`Phoenix: the contract could not be read (${String(e.message || e).split("\n")[0].slice(0, 120)})`);
  }
}

const cases = [
  [NET.USDC, NET.XLM, [100n, 1_000n, 10_000n, 100_000n]],
  [NET.XLM, NET.USDC, [1_000n, 10_000n, 100_000n, 1_000_000n]],
];
for (const [tin, tout, sizes] of cases) {
  const pools = await poolsFor(tin, tout);
  console.log(`\n===== ${name(tin)} -> ${name(tout)} : ${pools.length} pools (${pools.map((p) => p.label).join(", ")}) =====`);
  if (NET.AQUA && !pools.some((p) => p.label.startsWith("Aquarius"))) console.log(`  (no Aquarius pool was returned; last error: ${lastError || "none reported"})`);
  for (const size of sizes) {
    const amount = size * UNIT;
    const quotes = await Promise.all(pools.map((p) => p.quote(amount)));
    const soro = quotes[0];
    let bestI = -1;
    quotes.forEach((q, i) => {
      if (q !== null && (bestI < 0 || q > quotes[bestI])) bestI = i;
    });
    console.log(`\n${size.toLocaleString("en-US")} ${name(tin)}`);
    if (quotes.every((q) => q === null)) console.log(`  (every quote failed; last error: ${lastError || "none reported"})`);
    quotes.forEach((q, i) => {
      const vs = q !== null && soro ? ` (${(((Number(q) - Number(soro)) / Number(soro)) * 100).toFixed(2)}% vs Soroswap)` : "";
      console.log(`  ${pools[i].label.padEnd(16)} ${q === null ? "no quote" : fmt(q).padStart(16)} ${name(tout)}${i === 0 ? "" : vs}${i === bestI ? "   <- best single pool" : ""}`);
    });
    if (bestI < 0) continue;
    const split = await bestSplit(pools, amount);
    if (split) {
      const gain = ((Number(split.out) - Number(quotes[bestI])) / Number(quotes[bestI])) * 100;
      const how = Object.entries(split.shares).map(([l, p]) => `${l} ${p}%`).join(" + ");
      console.log(`  ${"best split".padEnd(16)} ${fmt(split.out).padStart(16)} ${name(tout)}   ${how}   -> ${gain.toFixed(3)}% over the best single pool`);
    }
  }
}
console.log("\nDone. Nothing was sent.");
