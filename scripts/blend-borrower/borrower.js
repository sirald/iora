#!/usr/bin/env node
// Iora Blend borrower bot (TESTNET ONLY). Keeps Circle USDC borrowed from Iora's own Blend pool so that the USDC
// supplied by Iora vaults earns interest: it puts XLM up as collateral and borrows USDC until the pool's USDC
// utilisation is inside a band (default 50-70%), repays when utilisation is above the band, and repays when its
// own health factor falls below MIN_HF. One run per call: systemd runs it on a timer (iora-blend-borrower.timer).
//
//
// Other coins (multi.js, targets.json): after the USDC step the bot also borrows XLM and Iora's coins (iBTC, iETH,
// iSOL, iAVAX, iXRP) so that each of them pays its target supply APR (targets.json, numbers in faiz-hedefleri.md).
// For those it supplies the coin to the pool as a lender (supplyUsd, from its wallet), keeps one collateral coin
// posted (collateral.coin, default iBTC: minted by the issuer on the development machine, so it does not grow the
// USDC or XLM supply), and borrows / repays towards the utilisation that pays the target at the current ir_mod.
// A coin that is not an active reserve yet (Iora's coins before 2026-12-04T19:58Z) is skipped.
// MULTI=off, or no targets file, keeps the bot USDC-only exactly as before.
// At the end of every run, success or failure, it writes a status file for the bots check (status.js,
// scripts/monitor): $STATE_DIRECTORY/status.json from the unit's StateDirectory=, or STATUS_FILE. Not in a dry run.
//
// Usage:  node borrower.js            one run (does what logic.js and multi.js decide)
//         node borrower.js --dry-run  only prints the decisions
//         node borrower.js --setup    adds the missing trustlines (Circle USDC and the coins of targets.json), then one run
// Settings come from the environment (see borrower.env.example). The secret key is BORROWER_SECRET and is read
// from the environment only (systemd EnvironmentFile=/etc/iora/borrower.env, root:iora 0640); it is never printed.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Address, Asset, BASE_FEE, Contract, Keypair, Networks, Operation, TransactionBuilder, nativeToScVal, rpc,
  scValToNative, xdr,
} from "@stellar/stellar-sdk";
import { decide } from "./logic.js";
import { curveOf, decideMulti } from "./multi.js";
import { borrowerStatus, multiAfter, multiRecord, readStatus, statusPath, usdcAfter, usdcRecord, writeStatus } from "./status.js";

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? process.env[k] : d);
const num = (k, d) => {
  const v = Number(env(k, d));
  if (!Number.isFinite(v)) throw new Error(`${k} is not a number`);
  return v;
};

const cfg = {
  rpcUrl: env("RPC_URL", "https://soroban-testnet.stellar.org"),
  horizonUrl: env("HORIZON_URL", "https://horizon-testnet.stellar.org"),
  pool: env("BLEND_POOL"),
  usdc: env("USDC", "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"),
  usdcIssuer: env("USDC_ISSUER", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
  coll: env("COLLATERAL", "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"), // XLM SAC
  utilTarget: num("UTIL_TARGET", 0.6),
  utilBand: num("UTIL_BAND", 0.1),
  minHf: num("MIN_HF", 1.5),
  targetHf: num("TARGET_HF", 2.0),
  maxDebt: num("MAX_DEBT", 5000), // USDC
  collateralTarget: num("COLLATERAL_TARGET", 5000), // XLM kept as collateral
  collReserve: num("XLM_RESERVE", 50), // XLM left in the wallet for fees
  minAction: num("MIN_ACTION", 0.5), // USD; smaller changes are skipped
  expectAddress: env("BORROWER_ADDRESS"),
  multi: String(env("MULTI", "on")).toLowerCase() !== "off",
  usdcStep: String(env("USDC_STEP", "on")).toLowerCase() !== "off", // off: a second account that runs only the other coins
  targetsFile: resolve(dirname(fileURLToPath(import.meta.url)), env("TARGETS_FILE", "targets.json")),
  multiMinHf: num("MULTI_MIN_HF", env("MIN_HF", 1.5)),
  multiTargetHf: num("MULTI_TARGET_HF", env("TARGET_HF", 2.0)),
  overshoot: num("UTIL_OVERSHOOT", 0.02), // how far above a curve's util the bot may go to raise a low ir_mod
};
const DRY = process.argv.includes("--dry-run");
const SETUP = process.argv.includes("--setup");

// What this run saw, for the status file (only recorded here; nothing below reads it to decide or send).
const STATUS_FILE = DRY ? null : statusPath(process.env);
const run = { startedAt: Date.now(), address: null, pool: cfg.pool ?? null, steps: { usdc: cfg.usdcStep, multi: false }, warnings: [], submitted: [] };
function saveStatus(ok, error) {
  if (!STATUS_FILE) return;
  try {
    writeStatus(STATUS_FILE, borrowerStatus(readStatus(STATUS_FILE), run, { ok, error }));
  } catch (e) {
    console.error(new Date().toISOString(), "WARN", `status file not written: ${e?.message ?? e}`);
  }
}
/** Adds the numbers f() returns to the run's record; an error there only costs the status those numbers. */
function record(f) {
  try {
    Object.assign(run, f());
  } catch (e) {
    console.error(new Date().toISOString(), "WARN", `status numbers not recorded: ${e?.message ?? e}`);
  }
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
const fail = (m) => {
  console.error(new Date().toISOString(), "ERROR", m);
  saveStatus(false, m);
  process.exit(1);
};

// targets.json: { "collateral": { "coin", "targetUsd" }, "coins": { NAME: { token, code?, issuer?, supplyApr,
// maxBorrowApr?, maxDebtUsd, supplyUsd?, band? } } }
let targets = null;
if (cfg.multi && existsSync(cfg.targetsFile)) {
  try {
    targets = JSON.parse(readFileSync(cfg.targetsFile, "utf8"));
  } catch (e) {
    fail(`cannot read ${cfg.targetsFile}: ${e.message}`);
  }
  for (const [k, t] of Object.entries(targets.coins ?? {})) {
    if (!t.token || !(t.supplyApr >= 0) || !(t.maxDebtUsd >= 0)) fail(`targets.json: ${k} needs token, supplyApr and maxDebtUsd`);
    if (t.token === (process.env.USDC || "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"))
      fail("targets.json: USDC is handled by the USDC step (UTIL_TARGET), not by targets.json");
  }
  run.steps.multi = true;
}
const SCALAR7 = 1e7;
const SCALAR12 = 1e12;

if (!cfg.pool) fail("BLEND_POOL is not set");
if (!(cfg.utilBand > 0 && cfg.utilTarget - cfg.utilBand > 0 && cfg.utilTarget + cfg.utilBand < 0.95))
  fail("UTIL_TARGET +- UTIL_BAND must stay inside (0, 0.95)");
if (!(cfg.targetHf >= cfg.minHf && cfg.minHf > 1)) fail("need TARGET_HF >= MIN_HF > 1");
if (!(cfg.multiTargetHf >= cfg.multiMinHf && cfg.multiMinHf > 1)) fail("need MULTI_TARGET_HF >= MULTI_MIN_HF > 1");
const secret = process.env.BORROWER_SECRET;
if (!secret) fail("BORROWER_SECRET is not set");
const kp = Keypair.fromSecret(secret);
delete process.env.BORROWER_SECRET;
const ME = kp.publicKey();
run.address = ME;
if (cfg.expectAddress && cfg.expectAddress !== ME) fail(`BORROWER_SECRET does not belong to BORROWER_ADDRESS ${cfg.expectAddress}`);

const server = new rpc.Server(cfg.rpcUrl, { allowHttp: cfg.rpcUrl.startsWith("http://") });
let passphrase;
try {
  passphrase = (await server.getNetwork()).passphrase;
} catch (e) {
  fail(`RPC ${cfg.rpcUrl} did not answer: ${e?.message ?? e}`);
}
if (passphrase !== Networks.TESTNET) fail(`this bot runs on testnet only (RPC says "${passphrase}")`);

async function account() {
  return server.getAccount(ME);
}

async function read(contractId, method, ...args) {
  const tx = new TransactionBuilder(await account(), { fee: BASE_FEE, networkPassphrase: passphrase })
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
  if (sent.status === "ERROR") throw new Error(`send failed: ${JSON.stringify(sent.errorResult?.result?.()?.switch?.()?.name ?? sent.status)}`);
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await server.getTransaction(sent.hash);
    if (r.status === "SUCCESS") return sent.hash;
    if (r.status === "FAILED") throw new Error(`transaction ${sent.hash} failed`);
  }
  throw new Error(`transaction ${sent.hash} not confirmed in 60 s`);
}

const addr = (a) => new Address(a).toScVal();
const stellarAsset = (a) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Stellar"), addr(a)]);
const toStroops = (x) => BigInt(Math.floor(x * SCALAR7));

async function ensureTrustline() {
  const res = await fetch(`${cfg.horizonUrl}/accounts/${ME}`);
  if (!res.ok) fail(`account ${ME} not found on Horizon (fund it first)`);
  const acc = await res.json();
  const want = [{ code: "USDC", issuer: cfg.usdcIssuer }];
  for (const t of Object.values(targets?.coins ?? {})) if (t.code && t.issuer) want.push({ code: t.code, issuer: t.issuer });
  const missing = want.filter((w) => !acc.balances.some((b) => b.asset_code === w.code && b.asset_issuer === w.issuer));
  if (missing.length === 0) return log("trustlines present");
  if (DRY) return log(`dry run: trustlines missing and would be added: ${missing.map((m) => m.code).join(", ")}`);
  let b = new TransactionBuilder(await account(), { fee: BASE_FEE, networkPassphrase: passphrase });
  for (const m of missing) b = b.addOperation(Operation.changeTrust({ asset: new Asset(m.code, m.issuer) }));
  log(`adding trustlines ${missing.map((m) => m.code).join(", ")}:`, await send(b.setTimeout(60).build()));
}

async function submitRequests(requests) {
  const reqVal = nativeToScVal(requests, {
    type: { address: ["symbol", "address"], amount: ["symbol", "i128"], request_type: ["symbol", "u32"] },
  });
  const tx = new TransactionBuilder(await account(), { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(new Contract(cfg.pool).call("submit", addr(ME), addr(ME), addr(ME), reqVal))
    .setTimeout(60)
    .build();
  const prepared = await server.prepareTransaction(tx);
  return send(prepared);
}

async function main() {
  log(`bot ${ME}  pool ${cfg.pool}${DRY ? "  (dry run)" : ""}`);
  if (SETUP) await ensureTrustline();
  if (cfg.usdcStep) await usdcStep();
  if (targets) await multiStep();
  else if (!cfg.usdcStep) log(`USDC_STEP=off and no targets (${cfg.multi ? `${cfg.targetsFile} missing` : "MULTI=off"}): nothing to do`);
  saveStatus(true);
}

// Blend request types: 0 supply, 2 supply collateral, 4 borrow, 5 repay.
const MULTI_TYPE = { supply: 0, collateral: 2, borrow: 4, repay: 5 };

async function multiStep() {
  const names = Object.keys(targets.coins ?? {});
  if (names.length === 0) return;
  const poolCfg = await read(cfg.pool, "get_config");
  const reserveList = await read(cfg.pool, "get_reserve_list");
  const positions = await read(cfg.pool, "get_positions", addr(ME));
  const reserves = {};
  for (const a of reserveList) reserves[a] = await read(cfg.pool, "get_reserve", addr(a));
  const byIndex = Object.fromEntries(Object.values(reserves).map((r) => [r.config.index, r]));
  const units = (r, tokens, rate) => (Number(tokens) * Number(rate)) / SCALAR12 / 10 ** r.config.decimals;

  const tokenOf = Object.fromEntries(names.map((k) => [k, targets.coins[k].token]));
  const priceCache = {};
  const priceOf = async (a) => {
    if (a in priceCache) return priceCache[a];
    let v = null;
    try {
      const p = await read(poolCfg.oracle, "lastprice", stellarAsset(a));
      if (p && Number(p.price) > 0) v = Number(p.price) / SCALAR7;
    } catch {
      v = null;
    }
    return (priceCache[a] = v);
  };

  // Effective collateral and liabilities over all positions (after the USDC step).
  let pricesOk = true;
  let effCollateral = 0;
  let effLiabilities = 0;
  for (const [k, v] of Object.entries(positions.collateral)) {
    const r = byIndex[k];
    const p = await priceOf(r.asset);
    if (p == null) pricesOk = false;
    effCollateral += units(r, v, r.data.b_rate) * (p ?? 0) * (r.config.c_factor / SCALAR7);
  }
  for (const [k, v] of Object.entries(positions.liabilities)) {
    const r = byIndex[k];
    const p = await priceOf(r.asset);
    if (p == null) pricesOk = false;
    effLiabilities += (units(r, v, r.data.d_rate) * (p ?? 0)) / (r.config.l_factor / SCALAR7);
  }

  const coins = {};
  for (const k of names) {
    const a = tokenOf[k];
    const r = reserves[a];
    const active = !!r && reserveList.includes(a) && r.config.enabled !== false;
    const wallet = Number(await read(a, "balance", addr(ME))) / SCALAR7;
    if (!active) {
      coins[k] = { active: false, price: null, wallet };
      continue;
    }
    const idx = r.config.index;
    coins[k] = {
      active,
      price: await priceOf(a),
      curve: curveOf(r.config),
      irMod: Number(r.data.ir_mod) / SCALAR7,
      supplied: units(r, r.data.b_supply, r.data.b_rate),
      borrowed: units(r, r.data.d_supply, r.data.d_rate),
      ownSupply: units(r, positions.supply?.[idx] ?? 0, r.data.b_rate),
      ownCollateral: units(r, positions.collateral[idx] ?? 0, r.data.b_rate),
      ownDebt: units(r, positions.liabilities[idx] ?? 0, r.data.d_rate),
      wallet,
      decimals: r.config.decimals,
    };
  }
  const state = {
    poolActive: poolCfg.status === 0 || poolCfg.status === 1,
    bstopRate: Number(poolCfg.bstop_rate) / SCALAR7,
    pricesOk,
    effCollateral,
    effLiabilities,
    coins,
  };
  const reserve = {};
  for (const k of names) if (tokenOf[k] === cfg.coll) reserve[k] = cfg.collReserve; // XLM kept for fees
  const { requests, notes, warnings } = decideMulti(state, targets.coins, {
    minHf: cfg.multiMinHf,
    targetHf: cfg.multiTargetHf,
    minActionUsd: cfg.minAction,
    overshoot: cfg.overshoot,
    collateral: targets.collateral ?? null,
    reserve,
  });
  record(() => multiRecord(state, targets.coins, requests, cfg));
  run.warnings.push(...warnings);
  for (const n of notes) log(n);
  if (requests.length === 0) return log("multi: no action");
  log("multi actions:", requests.map((q) => `${q.kind} ${q.amount.toPrecision(8)} ${q.coin}`).join(", "));
  if (DRY) return log("multi: dry run: nothing sent");
  // Amounts rounded down (a repay never asks for more than the wallet holds).
  const req = requests.map((q) => ({
    address: tokenOf[q.coin],
    amount: BigInt(Math.floor(q.amount * 10 ** (coins[q.coin].decimals ?? 7))),
    request_type: MULTI_TYPE[q.kind],
  }));
  const hash = await submitRequests(req);
  log("multi submitted:", hash);
  run.submitted.push(hash);
  record(() => multiAfter(state, requests));
}

async function usdcStep() {
  const poolCfg = await read(cfg.pool, "get_config");
  const poolActive = poolCfg.status === 0 || poolCfg.status === 1;
  const reserveList = await read(cfg.pool, "get_reserve_list");
  if (!reserveList.includes(cfg.usdc) || !reserveList.includes(cfg.coll)) fail("USDC or the collateral is not a reserve of this pool");
  const positions = await read(cfg.pool, "get_positions", addr(ME));

  // Reserves the bot touches: USDC, the collateral, and anything else it holds a position in.
  const reserves = {};
  for (const a of reserveList) reserves[a] = await read(cfg.pool, "get_reserve", addr(a));
  const byIndex = Object.fromEntries(Object.values(reserves).map((r) => [r.config.index, r]));
  const used = new Set([cfg.usdc, cfg.coll]);
  for (const k of [...Object.keys(positions.collateral), ...Object.keys(positions.liabilities)]) used.add(byIndex[k].asset);

  let pricesOk = true;
  const price = {};
  for (const a of used) {
    try {
      const p = await read(poolCfg.oracle, "lastprice", stellarAsset(a));
      if (p && Number(p.price) > 0) price[a] = Number(p.price) / SCALAR7;
      else pricesOk = false;
    } catch {
      pricesOk = false;
    }
  }
  const decimals = await read(poolCfg.oracle, "decimals");
  if (decimals !== 7) fail(`oracle decimals ${decimals}, expected 7`);

  const units = (r, tokens, rate) => (Number(tokens) * Number(rate)) / SCALAR12 / 10 ** r.config.decimals;
  let effCollateral = 0;
  let effLiabilities = 0;
  for (const [k, v] of Object.entries(positions.collateral)) {
    const r = byIndex[k];
    effCollateral += units(r, v, r.data.b_rate) * (price[r.asset] ?? 0) * (r.config.c_factor / SCALAR7);
  }
  for (const [k, v] of Object.entries(positions.liabilities)) {
    const r = byIndex[k];
    effLiabilities += (units(r, v, r.data.d_rate) * (price[r.asset] ?? 0)) / (r.config.l_factor / SCALAR7);
  }
  const ru = reserves[cfg.usdc];
  const rc = reserves[cfg.coll];
  const state = {
    poolActive,
    pricesOk,
    supplied: units(ru, ru.data.b_supply, ru.data.b_rate),
    borrowed: units(ru, ru.data.d_supply, ru.data.d_rate),
    usdcPrice: price[cfg.usdc],
    usdcLFactor: ru.config.l_factor / SCALAR7,
    collPrice: price[cfg.coll],
    collCFactor: rc.config.c_factor / SCALAR7,
    effCollateral,
    effLiabilities,
    debt: units(ru, positions.liabilities[ru.config.index] ?? 0, ru.data.d_rate),
    collateral: units(rc, positions.collateral[rc.config.index] ?? 0, rc.data.b_rate),
    walletUsdc: Number(await read(cfg.usdc, "balance", addr(ME))) / SCALAR7,
    walletColl: Number(await read(cfg.coll, "balance", addr(ME))) / SCALAR7,
  };
  log(
    `pool USDC supplied ${state.supplied.toFixed(4)} borrowed ${state.borrowed.toFixed(4)} | bot debt ${state.debt.toFixed(4)} USDC, ` +
      `collateral ${state.collateral.toFixed(2)} XLM, wallet ${state.walletUsdc.toFixed(4)} USDC / ${state.walletColl.toFixed(2)} XLM | ` +
      `prices USDC ${state.usdcPrice} XLM ${state.collPrice} | pool status ${poolCfg.status}`,
  );

  const { actions, notes, warnings } = decide(state, cfg);
  record(() => usdcRecord(state, actions, cfg));
  run.warnings.push(...warnings);
  for (const n of notes) log(n);
  if (actions.length === 0) return log("no action");
  // Blend request types: 2 supply collateral, 4 borrow, 5 repay.
  const TYPE = { collateral: 2, borrow: 4, repay: 5 };
  // Amounts are rounded down, so a repay never asks for more than the wallet holds. Repaying the whole debt adds a
  // little (when the wallet has it) so no dust of accrued interest stays behind; the pool refunds any excess.
  const requests = actions.map((a) => ({
    address: a.kind === "collateral" ? cfg.coll : cfg.usdc,
    amount: toStroops(a.kind === "repay" && a.amount >= state.debt - 1e-6 ? Math.min(state.walletUsdc, state.debt + 0.001) : a.amount),
    request_type: TYPE[a.kind],
  }));
  log("actions:", actions.map((a) => `${a.kind} ${a.amount.toFixed(4)}`).join(", "));
  if (DRY) return log("dry run: nothing sent");
  const hash = await submitRequests(requests);
  log("submitted:", hash);
  run.submitted.push(hash);
  record(() => usdcAfter(state, actions));
}

main().catch((e) => fail(String(e?.message ?? e).replace(/S[A-Z2-7]{55}/g, "S***")));
