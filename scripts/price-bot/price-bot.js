#!/usr/bin/env node
// Iora price bot (TESTNET ONLY). Keeps Iora's Circle USDC / XLM reference pool (an Aquarius concentrated pool with
// full-range liquidity, testnet/ref-pool.env) at the real XLM price: each run compares the pool price with the
// oracle adapter's (Reflector) XLM and USDC prices and, when the deviation is above THRESHOLD, swaps through the
// Aquarius router just enough to bring the pool back to the reference (pool too expensive: sells XLM; too cheap:
// buys XLM), within MAX_TRADE_USD and its own USDC / XLM inventory. No fresh price: nothing is done.
// One run per call: systemd runs it on a timer (iora-price-bot.timer).
//
// Usage:  node price-bot.js            one run
//         node price-bot.js --dry-run  only prints the decision
//         node price-bot.js --setup    adds the Circle USDC trustline to the bot's account if missing, then one run
// Settings come from the environment (see price-bot.env.example). The secret key is PRICE_BOT_SECRET and is read
// from the environment only (systemd EnvironmentFile=/etc/iora/price-bot.env, root:iora 0640); it is never printed.
import {
  Address, Asset, BASE_FEE, Contract, Keypair, Networks, Operation, TransactionBuilder, nativeToScVal, rpc,
  scValToNative, xdr,
} from "@stellar/stellar-sdk";
import { decide, fairEnough, minOut, poolPrice } from "./logic.js";

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? process.env[k] : d);
const num = (k, d) => {
  const v = Number(env(k, d));
  if (!Number.isFinite(v)) throw new Error(`${k} is not a number`);
  return v;
};

const cfg = {
  rpcUrl: env("RPC_URL", "https://soroban-testnet.stellar.org"),
  horizonUrl: env("HORIZON_URL", "https://horizon-testnet.stellar.org"),
  router: env("AQUA_ROUTER", "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD"),
  pool: env("REF_POOL"),
  poolIndex: env("REF_POOL_INDEX"),
  oracle: env("ORACLE", "CCSZNMAXTNMIZNGDBLIZYKLOZG3LYKSIXCYC7GKWLOBLSMUPX7MKPHDF"),
  usdc: env("USDC", "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"),
  usdcIssuer: env("USDC_ISSUER", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
  xlm: env("XLM", "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"),
  threshold: num("THRESHOLD", 0.005), // act above 0.5% deviation
  maxAge: num("MAX_PRICE_AGE", 900), // seconds
  maxTradeUsd: num("MAX_TRADE_USD", 300), // per run
  minTradeUsd: num("MIN_TRADE_USD", 1),
  xlmReserve: num("XLM_RESERVE", 20), // XLM never sold (fees)
  warnUsdc: num("WARN_USDC", 100), // warn when the inventory falls below
  warnXlm: num("WARN_XLM", 800),
  slippage: num("SLIPPAGE", 0.005), // below the router's estimate
  fairTolerance: num("FAIR_TOLERANCE", 0.003),
  expectAddress: env("PRICE_BOT_ADDRESS"),
};
const DRY = process.argv.includes("--dry-run");
const SETUP = process.argv.includes("--setup");
const S7 = 1e7;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const warn = (...a) => console.log(new Date().toISOString(), "WARN", ...a);
const fail = (m) => {
  console.error(new Date().toISOString(), "ERROR", m);
  process.exit(1);
};

if (!cfg.pool || !/^[0-9a-f]{64}$/.test(cfg.poolIndex || "")) fail("REF_POOL and REF_POOL_INDEX (64 hex) must be set (testnet/ref-pool.env)");
if (!(cfg.threshold > 0)) fail("THRESHOLD must be > 0");
const secret = process.env.PRICE_BOT_SECRET;
if (!secret) fail("PRICE_BOT_SECRET is not set");
const kp = Keypair.fromSecret(secret);
delete process.env.PRICE_BOT_SECRET;
const ME = kp.publicKey();
if (cfg.expectAddress && cfg.expectAddress !== ME) fail(`PRICE_BOT_SECRET does not belong to PRICE_BOT_ADDRESS ${cfg.expectAddress}`);

const server = new rpc.Server(cfg.rpcUrl, { allowHttp: cfg.rpcUrl.startsWith("http://") });
const passphrase = (await server.getNetwork()).passphrase;
if (passphrase !== Networks.TESTNET) fail(`this bot runs on testnet only (RPC says "${passphrase}")`);

const addr = (a) => new Address(a).toScVal();
const u128 = (v) => nativeToScVal(BigInt(v), { type: "u128" });
const stellarAsset = (a) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Stellar"), addr(a)]);
// Aquarius wants the pair's tokens in address order; USDC (CBIE...) sorts before XLM (CDLZ...), checked below.
const tokens = () => xdr.ScVal.scvVec([addr(cfg.usdc), addr(cfg.xlm)]);
const poolIndex = () => xdr.ScVal.scvBytes(Buffer.from(cfg.poolIndex, "hex"));

async function read(contractId, method, ...args) {
  const tx = new TransactionBuilder(await server.getAccount(ME), { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${method}: ${String(sim.error).slice(0, 200)}`);
  return sim.result ? scValToNative(sim.result.retval) : undefined;
}

async function send(tx) {
  tx.sign(kp);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(`send failed: ${sent.status}`);
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await server.getTransaction(sent.hash);
    if (r.status === "SUCCESS") return { hash: sent.hash, ledger: r.ledger };
    if (r.status === "FAILED") throw new Error(`transaction ${sent.hash} failed`);
  }
  throw new Error(`transaction ${sent.hash} not confirmed in 60 s`);
}

async function ensureTrustline() {
  const res = await fetch(`${cfg.horizonUrl}/accounts/${ME}`);
  if (!res.ok) fail(`account ${ME} not found on Horizon (fund it first)`);
  const acc = await res.json();
  if (acc.balances.some((b) => b.asset_code === "USDC" && b.asset_issuer === cfg.usdcIssuer)) return log("USDC trustline present");
  if (DRY) return log("dry run: the USDC trustline is missing and would be added");
  const tx = new TransactionBuilder(await server.getAccount(ME), { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(Operation.changeTrust({ asset: new Asset("USDC", cfg.usdcIssuer) }))
    .setTimeout(60)
    .build();
  log("adding the USDC trustline:", (await send(tx)).hash);
}

async function oraclePrice(token) {
  try {
    const p = await read(cfg.oracle, "lastprice", stellarAsset(token));
    return p && Number(p.price) > 0 ? { price: Number(p.price) / S7, ts: Number(p.timestamp) } : null;
  } catch {
    return null;
  }
}

async function poolState() {
  const slot0 = await read(cfg.pool, "get_slot0");
  return { sqrtPriceX96: BigInt(slot0.sqrt_price_x96), tick: slot0.tick, liquidity: BigInt(await read(cfg.pool, "get_active_liquidity")) };
}

async function main() {
  log(`bot ${ME}  pool ${cfg.pool}${DRY ? "  (dry run)" : ""}`);
  if (SETUP) await ensureTrustline();
  const ptoks = await read(cfg.pool, "get_tokens");
  if (ptoks[0] !== cfg.usdc || ptoks[1] !== cfg.xlm) fail(`pool tokens ${ptoks} are not [USDC, XLM]`);
  const info = await read(cfg.pool, "get_info");
  const feeBps = Number(info.fee);

  const [px, pu] = [await oraclePrice(cfg.xlm), await oraclePrice(cfg.usdc)];
  const now = Math.floor(Date.now() / 1000);
  const ps = await poolState();
  const state = {
    ...ps,
    feeBps,
    xlmUsd: px?.price ?? null,
    usdcUsd: pu?.price ?? null,
    priceAge: px && pu ? now - Math.min(px.ts, pu.ts) : undefined,
    walletUsdc: Number(await read(cfg.usdc, "balance", addr(ME))) / S7,
    walletXlm: Number(await read(cfg.xlm, "balance", addr(ME))) / S7,
  };
  log(
    `oracle XLM ${state.xlmUsd} USD, USDC ${state.usdcUsd} USD (age ${state.priceAge ?? "?"} s) | pool tick ${ps.tick}, ` +
      `liquidity ${ps.liquidity}, fee ${feeBps} bps | wallet ${state.walletUsdc.toFixed(4)} USDC / ${state.walletXlm.toFixed(4)} XLM`,
  );

  const d = decide(state, cfg);
  for (const n of d.notes) log(n);
  for (const w of d.warnings) warn(w);
  if (!d.action) return log("no action");

  const a = d.action;
  const tin = a.sell === "XLM" ? cfg.xlm : cfg.usdc;
  const tout = a.sell === "XLM" ? cfg.usdc : cfg.xlm;
  const amountIn = BigInt(Math.floor(a.amountIn * S7));
  const est = await read(cfg.router, "estimate_swap", tokens(), addr(tin), addr(tout), poolIndex(), u128(amountIn));
  const estOut = Number(est) / S7;
  log(`swap ${a.amountIn.toFixed(7)} ${a.sell} -> ~${estOut.toFixed(7)} ${a.buy} (${(a.sell === "XLM" ? estOut / a.amountIn : a.amountIn / estOut).toFixed(7)} USDC/XLM)`);
  if (!fairEnough(a, estOut, d.refPrice, feeBps, cfg.fairTolerance)) {
    warn("the router's estimate is worse than the reference less the fee: the pool moved or differs from what was read; nothing sent");
    return;
  }
  if (DRY) return log("dry run: nothing sent");

  const out = minOut(est, cfg.slippage);
  const tx = new TransactionBuilder(await server.getAccount(ME), { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(new Contract(cfg.router).call("swap", addr(ME), tokens(), addr(tin), addr(tout), poolIndex(), u128(amountIn), u128(out)))
    .setTimeout(60)
    .build();
  const prepared = await server.prepareTransaction(tx);
  const r = await send(prepared);
  const after = await poolState();
  const pAfter = poolPrice(after.sqrtPriceX96);
  log(
    `swapped: tx ${r.hash} ledger ${r.ledger} | pool ${d.poolPrice.toFixed(7)} -> ${pAfter.toFixed(7)} USDC/XLM ` +
      `(reference ${d.refPrice.toFixed(7)}, deviation now ${((pAfter / d.refPrice - 1) * 100).toFixed(3)}%)`,
  );
}

main().catch((e) => fail(e?.message ?? String(e)));
