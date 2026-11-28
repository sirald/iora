#!/usr/bin/env node
// Iora price bot (TESTNET ONLY). Keeps Iora's own USDC pools at the real price: the XLM reference pool (Aquarius
// concentrated, full range, testnet/ref-pool.env) and the Soroswap USDC pairs of Iora's coins iBTC, iETH, iSOL,
// iAVAX, iXRP (testnet/iora-coins.env). The pools come from POOLS_FILE (default pools.json, made by make-pools.sh).
// Each run checks every pool: it compares the pool price with the oracle adapter's (Reflector) price of the coin
// and of USDC and, when the deviation is above THRESHOLD, swaps through the pool's router just enough to bring the
// pool back to the reference (pool too expensive: sells the coin; too cheap: buys it with USDC), within
// MAX_TRADE_USD and the bot's own inventory. No fresh price: that pool is left alone.
// One run per call: systemd runs it on a timer (iora-price-bot.timer).
// At the end of every run, success or failure, it writes a status file for the bots check (status.js,
// scripts/monitor): $STATE_DIRECTORY/status.json from the unit's StateDirectory=, or STATUS_FILE. Not in a dry run.
//
// Usage:  node price-bot.js            one run
//         node price-bot.js --dry-run  only prints the decisions
//         node price-bot.js --setup    adds the missing trustlines (Circle USDC and every coin of POOLS_FILE), then one run
// Settings come from the environment (see price-bot.env.example). The secret key is PRICE_BOT_SECRET and is read
// from the environment only (systemd EnvironmentFile=/etc/iora/price-bot.env, root:iora 0640); it is never printed.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Address, Asset, BASE_FEE, Contract, Keypair, Networks, Operation, TransactionBuilder, nativeToScVal, rpc,
  scValToNative, xdr,
} from "@stellar/stellar-sdk";
import { decide, fairEnough, fromReserves, minOut, poolPrice } from "./logic.js";
import { priceBotStatus, readStatus, statusPath, writeStatus } from "./status.js";

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? process.env[k] : d);
const num = (k, d) => {
  const v = Number(env(k, d));
  if (!Number.isFinite(v)) throw new Error(`${k} is not a number`);
  return v;
};
const here = dirname(fileURLToPath(import.meta.url));

const cfg = {
  rpcUrl: env("RPC_URL", "https://soroban-testnet.stellar.org"),
  horizonUrl: env("HORIZON_URL", "https://horizon-testnet.stellar.org"),
  poolsFile: resolve(here, env("POOLS_FILE", "pools.json")),
  only: env("ONLY", "").split(",").map((s) => s.trim()).filter(Boolean), // pool names; empty = all
  threshold: num("THRESHOLD", 0.005), // act above 0.5% deviation
  maxAge: num("MAX_PRICE_AGE", 900), // seconds
  maxTradeUsd: num("MAX_TRADE_USD", 300), // per pool per run
  minTradeUsd: num("MIN_TRADE_USD", 1),
  xlmReserve: num("XLM_RESERVE", 20), // XLM never sold (fees)
  warnUsdc: num("WARN_USDC", 200), // warn when the USDC inventory falls below
  warnCoinUsd: num("WARN_COIN_USD", 100), // warn when a coin's inventory is worth less (USD)
  slippage: num("SLIPPAGE", 0.005), // below the router's estimate
  fairTolerance: num("FAIR_TOLERANCE", 0.003),
  expectAddress: env("PRICE_BOT_ADDRESS"),
};
const DRY = process.argv.includes("--dry-run");
const SETUP = process.argv.includes("--setup");
const S7 = 1e7;

// What this run saw, for the status file (only recorded here; nothing below reads it to decide or trade).
const STATUS_FILE = DRY ? null : statusPath(process.env);
const run = { startedAt: Date.now(), address: null, checked: false, pools: {}, inventory: {}, warnings: new Set() };
function saveStatus(ok, error) {
  if (!STATUS_FILE) return;
  try {
    writeStatus(STATUS_FILE, priceBotStatus(readStatus(STATUS_FILE), run, { ok, error }));
  } catch (e) {
    console.error(new Date().toISOString(), "WARN", `status file not written: ${e?.message ?? e}`);
  }
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
const warn = (...a) => console.log(new Date().toISOString(), "WARN", ...a);
const fail = (m) => {
  console.error(new Date().toISOString(), "ERROR", m);
  saveStatus(false, m);
  process.exit(1);
};

let book;
try {
  book = JSON.parse(readFileSync(cfg.poolsFile, "utf8"));
} catch (e) {
  fail(`cannot read POOLS_FILE ${cfg.poolsFile}: ${e.message}`);
}
const USDC = book.usdc;
const ORACLE = env("ORACLE", book.oracle);
let pools = book.pools ?? [];
if (cfg.only.length) pools = pools.filter((p) => cfg.only.includes(p.name));
for (const p of pools) {
  if (!["aquarius", "soroswap"].includes(p.venue)) fail(`pool ${p.name}: unknown venue ${p.venue}`);
  if (p.venue === "aquarius" && !/^[0-9a-f]{64}$/.test(p.poolIndex || "")) fail(`pool ${p.name}: poolIndex (64 hex) missing`);
}
if (!USDC || !ORACLE || pools.length === 0) fail("POOLS_FILE needs usdc, oracle and at least one pool");
if (!(cfg.threshold > 0)) fail("THRESHOLD must be > 0");

const secret = process.env.PRICE_BOT_SECRET;
if (!secret) fail("PRICE_BOT_SECRET is not set");
const kp = Keypair.fromSecret(secret);
delete process.env.PRICE_BOT_SECRET;
const ME = kp.publicKey();
run.address = ME;
if (cfg.expectAddress && cfg.expectAddress !== ME) fail(`PRICE_BOT_SECRET does not belong to PRICE_BOT_ADDRESS ${cfg.expectAddress}`);

const server = new rpc.Server(cfg.rpcUrl, { allowHttp: cfg.rpcUrl.startsWith("http://") });
let passphrase;
try {
  passphrase = (await server.getNetwork()).passphrase;
} catch (e) {
  fail(`RPC ${cfg.rpcUrl} did not answer: ${e?.message ?? e}`);
}
if (passphrase !== Networks.TESTNET) fail(`this bot runs on testnet only (RPC says "${passphrase}")`);

const addr = (a) => new Address(a).toScVal();
const u128 = (v) => nativeToScVal(BigInt(v), { type: "u128" });
const i128 = (v) => nativeToScVal(BigInt(v), { type: "i128" });
const u64 = (v) => nativeToScVal(BigInt(v), { type: "u64" });
const stellarAsset = (a) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Stellar"), addr(a)]);
const addrVec = (list) => xdr.ScVal.scvVec(list.map(addr));

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

async function ensureTrustlines() {
  const res = await fetch(`${cfg.horizonUrl}/accounts/${ME}`);
  if (!res.ok) fail(`account ${ME} not found on Horizon (fund it first)`);
  const acc = await res.json();
  const want = [{ code: "USDC", issuer: book.usdcIssuer }, ...(book.pools ?? []).filter((p) => p.code && p.issuer).map((p) => ({ code: p.code, issuer: p.issuer }))];
  const missing = want.filter((w) => !acc.balances.some((b) => b.asset_code === w.code && b.asset_issuer === w.issuer));
  if (missing.length === 0) return log("trustlines present");
  if (DRY) return log(`dry run: trustlines missing and would be added: ${missing.map((m) => m.code).join(", ")}`);
  let b = new TransactionBuilder(await server.getAccount(ME), { fee: BASE_FEE, networkPassphrase: passphrase });
  for (const m of missing) b = b.addOperation(Operation.changeTrust({ asset: new Asset(m.code, m.issuer) }));
  log(`adding trustlines ${missing.map((m) => m.code).join(", ")}:`, (await send(b.setTimeout(60).build())).hash);
}

const priceCache = new Map();
async function oraclePrice(token) {
  if (priceCache.has(token)) return priceCache.get(token);
  let v = null;
  try {
    const p = await read(ORACLE, "lastprice", stellarAsset(token));
    if (p && Number(p.price) > 0) v = { price: Number(p.price) / S7, ts: Number(p.timestamp) };
  } catch {
    v = null;
  }
  priceCache.set(token, v);
  return v;
}

/** Venue adapters: pool state as { sqrtPriceX96, liquidity, feeBps }, the router's estimate, and the swap call. */
const venues = {
  aquarius: {
    tokens: (p) => addrVec([USDC, p.token]), // Aquarius wants the pair in address order; checked in state()
    async state(p) {
      const toks = await read(p.pool, "get_tokens");
      if (toks[0] !== USDC || toks[1] !== p.token) throw new Error(`pool tokens ${toks} are not [USDC, ${p.name}]`);
      const slot0 = await read(p.pool, "get_slot0");
      const info = await read(p.pool, "get_info");
      return { sqrtPriceX96: BigInt(slot0.sqrt_price_x96), liquidity: BigInt(await read(p.pool, "get_active_liquidity")), feeBps: Number(info.fee) };
    },
    estimate: (p, tin, tout, amt) =>
      read(p.router, "estimate_swap", venues.aquarius.tokens(p), addr(tin), addr(tout), xdr.ScVal.scvBytes(Buffer.from(p.poolIndex, "hex")), u128(amt)),
    call: (p, tin, tout, amt, min) =>
      new Contract(p.router).call("swap", addr(ME), venues.aquarius.tokens(p), addr(tin), addr(tout), xdr.ScVal.scvBytes(Buffer.from(p.poolIndex, "hex")), u128(amt), u128(min)),
  },
  soroswap: {
    async state(p) {
      const [r0, r1] = await read(p.pool, "get_reserves");
      const t0 = await read(p.pool, "token_0");
      const [x, y] = t0 === USDC ? [r0, r1] : [r1, r0];
      return { ...fromReserves(x, y), feeBps: 30 }; // Soroswap: 0.3% on every pair
    },
    async estimate(p, tin, tout, amt) {
      const out = await read(p.router, "router_get_amounts_out", i128(amt), addrVec([tin, tout]));
      return out[out.length - 1];
    },
    call: (p, tin, tout, amt, min) =>
      new Contract(p.router).call("swap_exact_tokens_for_tokens", i128(amt), i128(min), addrVec([tin, tout]), addr(ME), u64(Math.floor(Date.now() / 1000) + 300)),
  },
};

const balance = async (token) => Number(await read(token, "balance", addr(ME))) / S7;

// rec: this pool's line in the status file (filled in as the run goes; never read back here).
async function runPool(p, warnings, rec) {
  const v = venues[p.venue];
  const [pc, pu] = [await oraclePrice(p.token), await oraclePrice(USDC)];
  const ps = await v.state(p);
  const state = {
    coin: p.name,
    ...ps,
    coinUsd: pc?.price ?? null,
    usdcUsd: pu?.price ?? null,
    priceAge: pc && pu ? Math.floor(Date.now() / 1000) - Math.min(pc.ts, pu.ts) : undefined,
    walletUsdc: await balance(USDC),
    walletCoin: await balance(p.token),
  };
  const d = decide(state, { ...cfg, coinReserve: p.native ? cfg.xlmReserve : 0 });
  const held = { amount: state.walletCoin, usd: state.coinUsd > 0 ? state.walletCoin * state.coinUsd : null };
  run.inventory[p.name] = held;
  Object.assign(rec, { dev: d.deviation, poolPrice: d.poolPrice, refPrice: d.refPrice, action: Number.isFinite(d.deviation) ? "none" : "skipped" });
  for (const n of d.notes) log(n);
  for (const w of d.warnings) warnings.add(w);
  if (!d.action) return;

  const a = d.action;
  const [tin, tout] = a.sell === "COIN" ? [p.token, USDC] : [USDC, p.token];
  const [nin, nout] = a.sell === "COIN" ? [p.name, "USDC"] : ["USDC", p.name];
  const amountIn = BigInt(Math.floor(a.amountIn * S7));
  const est = await v.estimate(p, tin, tout, amountIn);
  const estOut = Number(est) / S7;
  const avg = a.sell === "COIN" ? estOut / a.amountIn : a.amountIn / estOut;
  log(`${p.name}: swap ${a.amountIn.toPrecision(8)} ${nin} -> ~${estOut.toPrecision(8)} ${nout} (${avg.toPrecision(8)} USDC per ${p.name})`);
  if (!fairEnough(a, estOut, d.refPrice, ps.feeBps, cfg.fairTolerance)) {
    warnings.add(`${p.name}: the router's estimate is worse than the reference less the fee (the pool moved or differs from what was read); nothing sent`);
    rec.action = "refused";
    return;
  }
  if (DRY) return log(`${p.name}: dry run: nothing sent`);
  const tx = new TransactionBuilder(await server.getAccount(ME), { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(v.call(p, tin, tout, amountIn, minOut(est, cfg.slippage)))
    .setTimeout(60)
    .build();
  const r = await send(await server.prepareTransaction(tx));
  Object.assign(rec, { action: "swap", tx: r.hash, dev: NaN }); // the deviation is measured again below
  held.amount = a.sell === "COIN" ? state.walletCoin - a.amountIn : state.walletCoin + estOut; // about, after the swap
  if (held.usd !== null) held.usd = held.amount * state.coinUsd;
  const after = poolPrice((await v.state(p)).sqrtPriceX96);
  Object.assign(rec, { dev: after / d.refPrice - 1, poolPrice: after });
  log(
    `${p.name}: swapped, tx ${r.hash} ledger ${r.ledger} | pool ${d.poolPrice.toPrecision(8)} -> ${after.toPrecision(8)} USDC ` +
      `(reference ${d.refPrice.toPrecision(8)}, deviation now ${((after / d.refPrice - 1) * 100).toFixed(3)}%)`,
  );
}

async function main() {
  log(`bot ${ME}  pools ${pools.map((p) => p.name).join(", ")}${DRY ? "  (dry run)" : ""}`);
  if (SETUP) await ensureTrustlines();
  const warnings = run.warnings;
  let failed = 0;
  const errors = [];
  for (const p of pools) {
    const rec = (run.pools[p.name] = { action: "error" });
    try {
      await runPool(p, warnings, rec);
    } catch (e) {
      failed++;
      console.error(new Date().toISOString(), "ERROR", `${p.name}: ${e?.message ?? e}`);
      Object.assign(rec, { action: "error", dev: NaN, error: String(e?.message ?? e) });
      errors.push(`${p.name}: ${e?.message ?? e}`);
    }
  }
  run.checked = true;
  for (const w of warnings) warn(w);
  const usdc = await balance(USDC);
  const usdcUsd = priceCache.get(USDC)?.price;
  run.inventory.USDC = { amount: usdc, usd: usdcUsd > 0 ? usdc * usdcUsd : null };
  log(`wallet ${usdc.toFixed(4)} USDC`);
  saveStatus(failed === 0, failed ? `${failed} of ${pools.length} pools failed: ${errors.join("; ")}` : null);
  if (failed) process.exit(1);
}

main().catch((e) => fail(e?.message ?? String(e)));
