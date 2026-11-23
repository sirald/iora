// Deploys the Iora contracts to testnet with the current SDK (CLI 28 inflates the fees).
//   DEV_SECRET=... node deploy.js
// 1) uploads the vault and factory wasm  2) deploys the new factory  3) updates testnet/factory.env
//
//   DEV_SECRET=... node deploy.js --sell
// Sell factory: the SAME vault contract with the tokens reversed (XLM is deposited, earns on Blend, USDC is bought).
// The existing vault wasm (testnet/factory.env VAULT_WASM_HASH) is used; the contract code does not change.
// The result is written to testnet/factory-sell.env; the buy factory (factory.env) is not changed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Address,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}
const { USDC, XLM, POOL, ROUTER } = readEnv(path.join(root, "testnet/addr.env"));
const PASS = Networks.TESTNET;
const server = new rpc.Server("https://soroban-testnet.stellar.org");
const HORIZON = "https://horizon-testnet.stellar.org";
if (!process.env.DEV_SECRET) {
  console.error("DEV_SECRET is not set");
  process.exit(1);
}
const kp = Keypair.fromSecret(process.env.DEV_SECRET);
const me = kp.publicKey();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function feeOf(hash) {
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch(`${HORIZON}/transactions/${hash}`);
      if (r.ok) return (Number((await r.json()).fee_charged) / 1e7).toFixed(4);
    } catch {}
    await sleep(2000);
  }
  return "?";
}

async function run(label, op) {
  const account = await server.getAccount(me);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASS })
    .addOperation(op)
    .setTimeout(180)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`${label}: could not be sent`);
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const r = await server.getTransaction(sent.hash);
    if (r.status === "SUCCESS") {
      console.log(`${label.padEnd(30)} fee ${await feeOf(sent.hash)} XLM`);
      return r.returnValue ? scValToNative(r.returnValue) : undefined;
    }
    if (r.status === "FAILED") throw new Error(`${label}: failed on the network ${sent.hash}`);
  }
  throw new Error(`${label}: timed out`);
}

async function upload(file) {
  const wasm = fs.readFileSync(path.join(root, "wasm", file));
  const hash = crypto.createHash("sha256").update(wasm).digest();
  try {
    await run(`upload ${file}`, Operation.uploadContractWasm({ wasm }));
  } catch (e) {
    // If the same wasm was uploaded before, the simulation may fail; the hash is still valid.
    console.log(`upload ${file}: ${e.message.split("\n")[0]} (it may be uploaded already)`);
  }
  return hash;
}

// Version 7: one multi-asset vault and one factory (no buy/sell split). Deployed with "--v7".
const V9 = process.argv.includes("--v9"); // version 9: uncapped vault list (chain per bucket), vault `forget`; same constructor as 8
const V8 = process.argv.includes("--v8") || V9; // version 8: allowed token list, fills through an intermediate token
const V7 = process.argv.includes("--v7") || V8;
const SELL = process.argv.includes("--sell");
// Extra market: "--market SYM TOKEN". The vault deposits XLM (earns on Blend) and buys TOKEN. The same vault code is used.
const MI = process.argv.indexOf("--market");
const MARKET = MI > 0 ? { sym: String(process.argv[MI + 1] || ""), token: String(process.argv[MI + 2] || "") } : null;
if (MARKET && (!/^[A-Za-z0-9]{1,12}$/.test(MARKET.sym) || !/^C[A-Z2-7]{55}$/.test(MARKET.token))) {
  console.error("Kullanim: node deploy.js --market SEMBOL TOKEN_ADRESI");
  process.exit(1);
}

/**
 * Registers the two factories as each other's "sibling" (version 4). Vaults check the target of a follow-up
 * order here. It can be set only once per factory; if it was set before, it fails and is skipped.
 */
async function linkSiblings(buy, sell) {
  for (const [from, to, label] of [
    [buy, sell, "buy -> sell"],
    [sell, buy, "sell -> buy"],
  ]) {
    try {
      await run(
        `sibling factory (${label})`,
        Operation.invokeContractFunction({ contract: from, function: "set_sibling", args: [new Address(to).toScVal()] }),
      );
    } catch (e) {
      console.log(`WARNING the sibling factory (${label}) could not be set: ${e.message.split("\n")[0]}`);
      console.log("  Follow-up orders (buy, then sell) will not work in this factory's vaults. Deploy the two factories again together.");
    }
  }
}

/**
 * Version 7 deployment: iora_vault.wasm is uploaded, iora_factory.wasm is deployed. Fill fee caps are given in a
 * table by the token bought (0.02 XLM when buying XLM, 0.003 USDC when buying USDC; environment variables
 * override them). Buying and selling use the same factory, so factory-sell.env carries the same address.
 */
/** Reads from the chain (without sending a transaction). Null on failure. */
async function simRead(contract, fn, args) {
  try {
    const account = await server.getAccount(me);
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASS })
      .addOperation(Operation.invokeContractFunction({ contract, function: fn, args }))
      .setTimeout(60)
      .build();
    const sim = await server.simulateTransaction(tx);
    return sim.result && sim.result.retval ? scValToNative(sim.result.retval) : null;
  } catch {
    return null;
  }
}

async function mainV7() {
  console.log(`deployer account: ${me} (version ${V8 ? 8 : 7}: single vault)`);
  // Other coins traded against USDC (testnet/pairs.env PAIRS=SYMBOL:token,...)
  const PAIRS = V8
    ? String(readEnv(path.join(root, "testnet/pairs.env")).PAIRS || "")
        .split(",")
        .map((x) => x.trim().split(":"))
        .filter((p) => p.length === 2 && /^C[A-Z2-7]{55}$/.test(p[1]) && p[1] !== USDC && p[1] !== XLM)
    : [];
  const symOf = Object.fromEntries([[XLM, "XLM"], [USDC, "USDC"], ...PAIRS.map(([s, t]) => [t, s])]);
  const vaultHash = await upload("iora_vault.wasm");
  const factoryHash = await upload("iora_factory.wasm");
  console.log(`vault wasm hash: ${vaultHash.toString("hex")}`);
  const addr = (a) => new Address(a).toScVal();
  const usdcFee = BigInt(process.env.EXEC_FEE_USDC_UNITS || 30_000);
  const feeList = [
    [XLM, BigInt(process.env.EXEC_FEE_XLM_UNITS || 200_000)],
    [USDC, usdcFee],
  ];
  // For other coins the cap is the USDC cap's value in that coin (at the pool price when deploying).
  for (const [sym, tok] of PAIRS) {
    const q = await simRead(ROUTER, "router_get_amounts_out", [
      nativeToScVal(usdcFee, { type: "i128" }),
      xdr.ScVal.scvVec([addr(USDC), addr(tok)]),
    ]);
    const cap = Array.isArray(q) && q.length ? BigInt(q[q.length - 1]) : 0n;
    if (cap > 0n) feeList.push([tok, cap]);
    else console.log(`WARNING ${sym}: the price could not be read, there will be no fill fee when this coin is bought`);
  }
  const fees = feeList
    .filter(([, v]) => v > 0n)
    // Map keys must be sorted in Soroban (by the raw bytes of the contract address).
    .sort((a, b) => Buffer.compare(Buffer.from(StrKey.decodeContract(a[0])), Buffer.from(StrKey.decodeContract(b[0]))));
  const feeMap = xdr.ScVal.scvMap(fees.map(([t, v]) => new xdr.ScMapEntry({ key: addr(t), val: nativeToScVal(v, { type: "i128" }) })));
  console.log(`fill fee caps: ${fees.map(([t, v]) => `${Number(v) / 1e7} when buying ${symOf[t]}`).join(", ")}`);
  const tokens = [USDC, XLM, ...PAIRS.map(([, t]) => t)];
  if (V8) console.log(`allowed tokens: ${tokens.map((t) => symOf[t]).join(", ")}`);
  const factory = await run(
    "factory deployment",
    Operation.createCustomContract({
      address: new Address(me),
      wasmHash: factoryHash,
      salt: crypto.randomBytes(32),
      constructorArgs: [addr(me), nativeToScVal(vaultHash, { type: "bytes" }), addr(POOL), addr(ROUTER), feeMap, ...(V8 ? [xdr.ScVal.scvVec(tokens.map(addr))] : [])],
    }),
  );
  if (!factory || !String(factory).startsWith("C")) throw new Error(`could not get the factory address: ${factory}`);
  const envFile = path.join(root, "testnet/factory.env");
  fs.writeFileSync(envFile, `FACTORY=${factory}\nVAULT_WASM_HASH=${vaultHash.toString("hex")}\nVAULT_V=${V9 ? 9 : V8 ? 8 : 7}\n`);
  fs.writeFileSync(path.join(root, "testnet/factory-sell.env"), `FACTORY_SELL=${factory}\n`);
  console.log(`FACTORY=${factory}`);
  console.log(`testnet/factory.env and factory-sell.env updated (one factory, VAULT_V=${V9 ? 9 : V8 ? 8 : 7})`);
}

async function main() {
  if (V7) return mainV7();
  console.log(`deployer account: ${me}${SELL ? " (sell factory: XLM -> USDC)" : MARKET ? ` (extra market: XLM -> ${MARKET.sym})` : ""}`);
  const known = readEnv(path.join(root, "testnet/factory.env")).VAULT_WASM_HASH;
  if (MARKET && !known) throw new Error("the main factories must be deployed first (no testnet/factory.env)");
  const vaultHash = (SELL || MARKET) && known ? Buffer.from(known, "hex") : await upload("order_vault.wasm");
  const factoryHash = await upload("vault_factory.wasm");
  console.log(`vault wasm hash: ${vaultHash.toString("hex")}`);

  const addr = (a) => new Address(a).toScVal();
  // Fill fee (version 5): the MOST that may be paid to the filler per fill, in the token the vault
  // BUYS (7 decimals). Taken only from what comes in above the limit; cannot be changed after deployment.
  // The default is close to a fill's network cost: 0.02 XLM in a buy vault, 0.003 USDC in a sell vault.
  // No fee on the extra (showcase) markets.
  const execFee = MARKET
    ? 0n
    : SELL
      ? BigInt(process.env.EXEC_FEE_USDC_UNITS || 30_000)
      : BigInt(process.env.EXEC_FEE_XLM_UNITS || 200_000);
  console.log(`fill fee (maximum, per fill): ${Number(execFee) / 1e7} ${MARKET ? MARKET.sym : SELL ? "USDC" : "XLM"}`);
  const factory = await run(
    "factory deployment",
    Operation.createCustomContract({
      address: new Address(me),
      wasmHash: factoryHash,
      salt: crypto.randomBytes(32),
      constructorArgs: [
        addr(me), // guardian
        nativeToScVal(vaultHash, { type: "bytes" }),
        // The vault deposits the token in the "usdc" field (and supplies it to Blend) and buys the one in the "xlm" field.
        addr(SELL || MARKET ? XLM : USDC),
        addr(MARKET ? MARKET.token : SELL ? USDC : XLM),
        addr(POOL),
        addr(ROUTER),
        nativeToScVal(execFee, { type: "i128" }),
      ],
    }),
  );
  if (!factory || !String(factory).startsWith("C")) throw new Error(`could not get the factory address: ${factory}`);

  if (MARKET) {
    // testnet/markets.env: MARKETS=SYMBOL:token:factory,... (the app and the keeper read it)
    const file = path.join(root, "testnet/markets.env");
    const old = String(readEnv(file).MARKETS || "").split(",").filter(Boolean).filter((x) => x.split(":")[0] !== MARKET.sym);
    old.push(`${MARKET.sym}:${MARKET.token}:${factory}`);
    fs.writeFileSync(file, `MARKETS=${old.join(",")}\n`);
    console.log(`MARKET ${MARKET.sym} FACTORY=${factory}`);
    console.log("testnet/markets.env updated");
    return;
  }
  if (SELL) {
    const sellFile = path.join(root, "testnet/factory-sell.env");
    fs.writeFileSync(sellFile, `FACTORY_SELL=${factory}\n`);
    console.log(`FACTORY_SELL=${factory}`);
    console.log("testnet/factory-sell.env written (the buy factory is unchanged)");
    const buy = readEnv(path.join(root, "testnet/factory.env")).FACTORY;
    if (buy) await linkSiblings(buy, String(factory));
    return;
  }
  const envFile = path.join(root, "testnet/factory.env");
  if (fs.existsSync(envFile)) fs.copyFileSync(envFile, path.join(root, "testnet/factory.v1.env"));
  // VAULT_V: the app picks the call signatures for this version (scripts/build-web.sh reads it).
  fs.writeFileSync(envFile, `FACTORY=${factory}\nVAULT_WASM_HASH=${vaultHash.toString("hex")}\nVAULT_V=5\n`);
  console.log(`FACTORY=${factory}`);
  console.log("testnet/factory.env updated (the previous one is factory.v1.env)");
}

main().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
});
