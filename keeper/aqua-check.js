// Can Aquarius fill our orders on this network? Simulation only: nothing is sent, nothing is signed.
// 1) prints the functions of the Aquarius router that is deployed at the given address,
// 2) lists its pools for USDC and XLM (the same two tokens our vaults hold),
// 3) quotes the same swaps on Aquarius and on Soroswap, side by side.
// Usage: node keeper/aqua-check.js            (testnet: reads testnet/addr.env; AQUA_ROUTER overrides the router address)
//        node keeper/aqua-check.js --mainnet  (the real market: public addresses below, still read-only)
import { readFileSync } from "node:fs";
import { Account, Address, BASE_FEE, Contract, Keypair, Networks, StrKey, TransactionBuilder, contract, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

const MAINNET = process.argv.includes("--mainnet");
const env = MAINNET
  ? {
      // Circle's USDC and native XLM as Stellar Asset Contracts; Soroswap's router from soroswap/core public/mainnet.contracts.json
      USDC: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
      XLM: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
      ROUTER: "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH",
    }
  : Object.fromEntries(
      readFileSync(new URL("../testnet/addr.env", import.meta.url), "utf8")
        .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
const RPC_URL = process.env.RPC_URL || (MAINNET ? "https://soroban-rpc.mainnet.stellar.gateway.fm" : "https://soroban-testnet.stellar.org");
const PASSPHRASE = MAINNET ? Networks.PUBLIC : Networks.TESTNET;
// The router addresses Soroswap's aggregator repository lists for Aquarius (protocols/aqua-addresses).
const AQUA = process.env.AQUA_ROUTER || (MAINNET ? "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK" : "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD");
const { USDC, XLM, ROUTER: SOROSWAP } = env;
const server = new rpc.Server(RPC_URL);
const source = new Account(Keypair.random().publicKey(), "0");
const UNIT = 10_000_000n; // both tokens have 7 decimals

const J = (v) => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? x.toString() : x && x.type === "Buffer" ? Buffer.from(x.data).toString("hex") : x));
const addr = (a) => new Address(a).toScVal();
const u128 = (n) => nativeToScVal(n, { type: "u128" });
const i128 = (n) => nativeToScVal(n, { type: "i128" });
const u32 = (n) => nativeToScVal(n, { type: "u32" });
const fmt = (n) => (Number(n) / Number(UNIT)).toFixed(4);

/** Simulates one read-only call and returns its value, or throws with the first line of the error. */
async function read(id, fn, ...args) {
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(id).call(fn, ...args)).setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(String(sim.error).split("\n")[0].slice(0, 220));
  return raw ? sim.result.retval : scValToNative(sim.result.retval);
}
let raw = false;

// Aquarius wants a pool's tokens in address order (the raw contract ids compared as bytes).
const sorted = [USDC, XLM].sort((a, b) => Buffer.compare(StrKey.decodeContract(a), StrKey.decodeContract(b)));
const tokens = xdr.ScVal.scvVec(sorted.map(addr));

console.log(`Network          ${MAINNET ? "MAINNET (read-only)" : "testnet"}`);
console.log(`Aquarius router  ${AQUA}`);
console.log(`Soroswap router  ${SOROSWAP}`);
console.log(`USDC ${USDC}\nXLM  ${XLM}\n`);

// 1) what the deployed router offers
try {
  const client = await contract.Client.from({ contractId: AQUA, rpcUrl: RPC_URL, networkPassphrase: PASSPHRASE });
  // The SDK exposes XDR values as plain objects in new versions and through accessor functions in old ones.
  const g = (o, n) => (typeof o[n] === "function" ? o[n]() : o[n]);
  const fns = client.spec.funcs().map((f) => `${String(g(f, "name"))}(${(g(f, "inputs") || []).map((i) => String(g(i, "name"))).join(", ")})`);
  const want = fns.filter((f) => /^(get_pools|estimate_swap|swap|swap_chained|get_tokens|get_reserves|get_info)\(/.test(f));
  console.log(`1) router found, ${fns.length} functions. The ones we would use:`);
  for (const f of want) console.log("   " + f);
} catch (e) {
  console.log(`1) NO Aquarius router at this address on this network: ${String(e.message || e).split("\n")[0].slice(0, 200)}`);
  console.log("   Result: Aquarius cannot be tried on testnet with this address.");
  process.exit(0);
}

// 2) its pools for our two tokens
let pools = {};
try {
  // a map of pool hash (32 bytes) -> pool address; read by hand so the hash stays hex
  raw = true;
  const map = await read(AQUA, "get_pools", tokens);
  raw = false;
  const native = scValToNative(map); // Buffer keys lose their bytes as object keys, so pair them by position
  const entries = (typeof map.map === "function" ? map.map() : map.value ?? map._value) || [];
  const vals = Object.values(native);
  entries.forEach((e, i) => {
    const k = typeof e.key === "function" ? e.key() : e.key;
    const kn = scValToNative(k); // 32 bytes
    pools[Buffer.from(kn instanceof Uint8Array ? kn : Object.values(kn)).toString("hex")] = String(vals[i]);
  });
} catch (e) {
  console.log(`\n2) get_pools failed: ${e.message}`);
  process.exit(0);
}
const hashes = Object.keys(pools);
console.log(`\n2) pools for USDC and XLM: ${hashes.length}   (token order: ${sorted[0] === USDC ? "USDC, XLM" : "XLM, USDC"})`);
if (!hashes.length) {
  console.log("   Result: Aquarius has no pool for our two tokens here, so there is nothing to fill against.");
  process.exit(0);
}
for (const h of hashes) {
  let extra = "";
  const idx = xdr.ScVal.scvBytes(Buffer.from(h, "hex"));
  try { extra = "\n      reserves (in token order) " + J(await read(AQUA, "get_reserves", tokens, idx)); } catch (e) { extra = "\n      reserves: " + e.message.slice(0, 100); }
  try { extra += "\n      info " + J(await read(AQUA, "get_info", tokens, idx)); } catch (e) { extra += "\n      info: " + e.message.slice(0, 100); }
  console.log(`   ${h}  ->  ${pools[h]}${extra}`);
}

// 3) the same swaps quoted on both
console.log("\n3) quotes (what you receive)");
const cases = [
  ["100 USDC -> XLM", USDC, XLM, 100n * UNIT],
  ["1000 USDC -> XLM", USDC, XLM, 1000n * UNIT],
  ["1000 XLM -> USDC", XLM, USDC, 1000n * UNIT],
  ["10000 XLM -> USDC", XLM, USDC, 10000n * UNIT],
  ["10000 USDC -> XLM", USDC, XLM, 10000n * UNIT],
  ["100000 XLM -> USDC", XLM, USDC, 100000n * UNIT],
];
for (const [label, tin, tout, amount] of cases) {
  let soro = "?";
  try {
    const out = await read(SOROSWAP, "router_get_amounts_out", i128(amount), xdr.ScVal.scvVec([addr(tin), addr(tout)]));
    soro = fmt(out[out.length - 1]);
  } catch (e) { soro = "failed: " + e.message.slice(0, 80); }
  const aqua = [];
  for (const h of hashes) {
    try {
      const out = await read(AQUA, "estimate_swap", tokens, addr(tin), addr(tout), xdr.ScVal.scvBytes(Buffer.from(h, "hex")), u128(amount));
      aqua.push(fmt(out));
    } catch (e) { aqua.push("failed: " + e.message.slice(0, 80)); }
  }
  const best = Math.max(...aqua.map(Number).filter((n) => !Number.isNaN(n)), 0);
  const diff = Number(soro) > 0 && best > 0 ? `   best Aquarius vs Soroswap ${(((best - Number(soro)) / Number(soro)) * 100).toFixed(2)}%` : "";
  console.log(`   ${label.padEnd(19)} Soroswap ${soro.padStart(14)}   Aquarius ${aqua.join(" | ")}${diff}`);
}
