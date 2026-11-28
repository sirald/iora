// The Iora bots check's reading and telling: systemd, the bots' status files, Horizon, the RPC (a read-only
// simulation), the state file and Telegram, plus main(). check-bots.js is the command that calls main(); the rules
// are in rules.js, what is told and when in alerts.js. Every function takes the outside world as an argument, so
// test/monitor.test.js runs it with fakes (no network, no systemd).
import { execFile } from "node:child_process";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { message, step, summary } from "./alerts.js";
import { config, evaluate, stateFileOf } from "./rules.js";

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const oneLine = (x) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
/** A text with the Telegram token (if any) blanked out. */
export const hideToken = (text, env) => {
  const token = String(env?.TELEGRAM_BOT_TOKEN ?? "").trim();
  return token ? String(text).split(token).join("***") : String(text);
};

/** `systemctl show -p A -p B unit` output -> { A, B } */
export function parseShow(stdout) {
  const out = {};
  for (const line of String(stdout).split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export async function unitState(unit, run = execFileP) {
  const props = ["LoadState", "ActiveState", "SubState", "Result", "UnitFileState"];
  const { stdout } = await run("systemctl", ["show", ...props.flatMap((p) => ["-p", p]), unit], { timeout: 5000 });
  return parseShow(stdout);
}

/** A bot's status file -> object (throws when it is not one). */
export function parseStatus(text) {
  const s = JSON.parse(text);
  if (!s || typeof s !== "object" || Array.isArray(s) || typeof s.at !== "string") throw new Error("not a status (no 'at')");
  return s;
}

/** The faucet's balances from Horizon: { xlm, usdc (null: no trustline) } | { notFound } | { error }. */
export async function faucetBalances(cfg, fetchImpl = globalThis.fetch, wait = sleep) {
  const url = `${cfg.horizonUrl.replace(/\/+$/, "")}/accounts/${encodeURIComponent(cfg.faucet)}`;
  let error = "no answer";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await wait(3000);
    try {
      const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) });
      if (res.status === 404) return { notFound: true };
      if (!res.ok) {
        error = `HTTP ${res.status}`;
        continue;
      }
      const acc = await res.json();
      const balances = Array.isArray(acc?.balances) ? acc.balances : [];
      const xlm = Number(balances.find((b) => b.asset_type === "native")?.balance);
      const usdc = balances.find((b) => b.asset_code === "USDC" && b.asset_issuer === cfg.usdcIssuer);
      return { xlm: Number.isFinite(xlm) ? xlm : 0, usdc: usdc ? Number(usdc.balance) : null };
    } catch (e) {
      error = oneLine(e?.message ?? e);
    }
  }
  return { error };
}

function within(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000} s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The Circle USDC the USDC exchange contract holds: { usdc } | { error, sdkMissing? }. A read-only simulation of
 * the USDC token's balance(exchange); nothing is signed or sent. Needs @stellar/stellar-sdk (npm ci here); without
 * it the rest of the check still runs.
 */
export async function exchangeBalance(cfg, load = () => import("@stellar/stellar-sdk")) {
  let sdk;
  try {
    sdk = await load();
  } catch {
    return { error: "@stellar/stellar-sdk is not installed next to check-bots.js (run npm ci --omit=dev there)", sdkMissing: true };
  }
  try {
    const { Account, Address, BASE_FEE, Contract, Networks, TransactionBuilder, rpc, scValToNative } = sdk;
    const server = new rpc.Server(cfg.rpcUrl, { allowHttp: cfg.rpcUrl.startsWith("http://") });
    const net = await within(server.getNetwork(), 15000, "getNetwork");
    if (net?.passphrase !== Networks.TESTNET) return { error: `RPC ${cfg.rpcUrl} is not on testnet` };
    // The source of a simulation only has to look like an account: the USDC issuer (public) is used.
    const tx = new TransactionBuilder(new Account(cfg.usdcIssuer, "0"), { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(new Contract(cfg.usdc).call("balance", new Address(cfg.exchange).toScVal()))
      .setTimeout(30)
      .build();
    const sim = await within(server.simulateTransaction(tx), 15000, "simulateTransaction");
    if (rpc.Api.isSimulationError(sim)) return { error: `simulation failed: ${oneLine(sim.error).slice(0, 160)}` };
    const usdc = Number(sim.result ? scValToNative(sim.result.retval) : NaN) / 1e7;
    return Number.isFinite(usdc) ? { usdc } : { error: "the simulation returned no balance" };
  } catch (e) {
    return { error: oneLine(e?.message ?? e).slice(0, 200) };
  }
}

/** Sends one Telegram message: { configured, sent }. The token never goes to a log. */
export async function telegram(text, env, fetchImpl = globalThis.fetch, err = console.error) {
  const token = String(env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chat = String(env.TELEGRAM_CHAT_ID ?? "").trim();
  if (!token || !chat) return { configured: false, sent: false };
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      err(`telegram: HTTP ${res.status}`);
      return { configured: true, sent: false };
    }
    return { configured: true, sent: true };
  } catch (e) {
    err(`telegram message could not be sent: ${hideToken(oneLine(e?.message ?? e), env)}`);
    return { configured: true, sent: false };
  }
}

/** Everything the rules need, read from systemd, the status files, Horizon and the RPC. */
export async function gather(cfg, d) {
  const input = { bots: {}, faucet: null, exchange: null, systemdError: null, notes: [] };
  let systemd = cfg.systemd !== "off";
  if (!systemd) input.notes.push("SYSTEMD=off: timers and services are not checked");
  const readStatus = (file) => {
    try {
      return { status: parseStatus(d.readFile(file)), statusError: null };
    } catch (e) {
      return { status: null, statusError: e?.code === "ENOENT" ? "missing" : oneLine(e?.message ?? e) };
    }
  };
  for (const bot of cfg.bots) {
    // The status is read before and after systemd: when a run finished in between, the two do not match each
    // other and the "failed" rule waits for the next check (raced).
    const before = readStatus(bot.status);
    let units = null;
    if (systemd) {
      try {
        units = { timer: await unitState(`${bot.unit}.timer`, d.run), service: await unitState(`${bot.unit}.service`, d.run) };
      } catch (e) {
        if (e?.code === "ENOENT") {
          systemd = false;
          input.notes.push("systemctl not found: timers and services are not checked");
        } else {
          input.systemdError ??= oneLine(e?.stderr || e?.message || e);
        }
      }
    }
    const after = units ? readStatus(bot.status) : before;
    input.bots[bot.name] = { units, ...after, raced: (before.status?.at ?? null) !== (after.status?.at ?? null) };
  }
  if (cfg.faucet) input.faucet = await faucetBalances(cfg, d.fetch, d.sleep);
  if (cfg.exchange) input.exchange = await d.exchange(cfg);
  return input;
}

function readJson(file, d) {
  try {
    return JSON.parse(d.readFile(file));
  } catch {
    return null;
  }
}

/** Atomic write (temporary file, fsync, rename); an error is logged, never thrown. */
export function writeJson(file, data, err = console.error) {
  const tmp = `${file}.tmp-${process.pid}`;
  let fd = null;
  try {
    fd = openSync(tmp, "w", 0o644);
    writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, file);
    return true;
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
    try {
      unlinkSync(tmp);
    } catch {}
    err(`state file ${file} not written: ${e?.message ?? e}`);
    return false;
  }
}

/** One check. deps replace the outside world in tests. Returns the exit code. */
export async function main({ env = process.env, now = Date.now(), deps = {} } = {}) {
  const d = {
    run: execFileP,
    readFile: (f) => readFileSync(f, "utf8"),
    fetch: globalThis.fetch,
    sleep,
    exchange: exchangeBalance,
    host: hostname(),
    out: (s) => console.log(s),
    err: (s) => console.error(s),
    ...deps,
  };
  const cfg = config(env);
  const input = await gather(cfg, d);
  const found = evaluate(input, cfg, now);
  const plan = step(readJson(cfg.stateFile, d), found.problems, found, now, cfg);
  for (const n of input.notes) d.out(`note: ${n}`);
  d.out(summary(plan));
  const text = message(plan, d.host);
  let delivered = true;
  if (text) {
    d.err(text);
    const t = await telegram(text, env, d.fetch, d.err);
    if (!t.configured) d.err("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set: this message went to the journal only");
    delivered = !t.configured || t.sent;
  }
  writeJson(cfg.stateFile, delivered ? plan.state : plan.failState, d.err);
  return plan.exitCode;
}

/** The check itself failed (a bad setting, a bug): tell Telegram at most once an hour. */
export async function reportCrash(e, { env = process.env, now = Date.now(), deps = {} } = {}) {
  const d = { readFile: (f) => readFileSync(f, "utf8"), fetch: globalThis.fetch, host: hostname(), err: (s) => console.error(s), ...deps };
  const file = `${stateFileOf(env)}.crash`;
  const last = Number(readJson(file, d)?.at);
  if (Number.isFinite(last) && now - last < 3600e3) return false;
  const t = await telegram(`[Iora bots] the bots check itself failed on ${d.host}: ${hideToken(oneLine(e?.message ?? e), env)}`, env, d.fetch, d.err);
  writeJson(file, { at: now }, d.err);
  return t.sent;
}
