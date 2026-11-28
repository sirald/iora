// Rules of the Iora bots check (check-bots.js): what is wrong, from what check-bots.js has read. No network, no
// files, no clock: everything comes in as arguments, so every rule is tested in test/rules.test.js.
//
// A problem is { key, level, title, text, delayMin? }:
//   key       stable name. The same key is the same alarm: alerts.js repeats it at most once an hour (12 h for stock
//             and soft), and says "OK (was: title)" once when it clears.
//   level     "alarm"  a bot does not run, or runs but does its job badly
//             "stock"  something to top up: the price bot's inventory, a borrower's wallet, the faucet, the exchange
//             "soft"   a notice that is not a bot alarm: the check itself could not read Horizon / the RPC / systemd,
//                      or a timer that runs but would not come back after a reboot. Does not make the check fail.
//   delayMin  the problem must last this long before it is told (a status file not written yet after an install,
//             a short Horizon outage).
// evaluate() also returns two lists of key prefixes:
//   unknown   what could not be checked this time. Those keys keep their state, so nothing is "cleared" by mistake
//             (a failed price-bot run does not mean its inventory is fine again).
//   ignore    bots that are no longer in BOTS: their old state is dropped without a message.
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The bots the check knows. status / maxAgeMin are the defaults; the *Env names override them. */
export const BOTS = {
  "price-bot": {
    label: "price bot", unit: "iora-price-bot", kind: "price",
    status: "/var/lib/iora/price-bot/status.json", statusEnv: "PRICE_BOT_STATUS",
    maxAgeMin: 15, maxAgeEnv: "PRICE_BOT_MAX_AGE_MIN", topUp: "scripts/price-bot/fund-bot.sh",
  },
  borrower: {
    label: "USDC borrower", unit: "iora-blend-borrower", kind: "borrower",
    status: "/var/lib/iora/borrower/status.json", statusEnv: "BORROWER_STATUS",
    maxAgeMin: 45, maxAgeEnv: "BORROWER_MAX_AGE_MIN",
  },
  "borrower-multi": {
    label: "multi-coin borrower", unit: "iora-blend-borrower-multi", kind: "borrower",
    status: "/var/lib/iora/borrower-multi/status.json", statusEnv: "BORROWER_MULTI_STATUS",
    maxAgeMin: 45, maxAgeEnv: "BORROWER_MAX_AGE_MIN",
  },
};

/** Public testnet addresses (testnet/addr.env, testnet/mover.env) and endpoints. */
export const DEFAULTS = {
  faucet: "GDWNSKKAMSQZRLV4EGXFMY7QSUQ5EOOXJGUNMLH6H3KFU4B2ZZESSY47", // the site's faucet (web/api/faucet.js)
  usdcIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5", // Circle USDC (USDC_ISSUER)
  usdc: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", // its SAC (CIRCLE_USDC)
  exchange: "CARNY3MIP5MWSTM5IMQCDDQGNNMUR5UR5VZRGBXSC6NQCV74KWFAAKTT", // USDC_EXCHANGE
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
};

/** Where the check keeps what it told: MONITOR_STATE_FILE, else $STATE_DIRECTORY/state.json, else the temp dir. */
export function stateFileOf(env) {
  const set = String(env.MONITOR_STATE_FILE ?? "").trim();
  if (set) return set;
  const dir = String(env.STATE_DIRECTORY ?? "").split(":")[0];
  return dir ? join(dir, "state.json") : join(tmpdir(), "iora-bots-check.json");
}

/** Settings from the environment (heartbeat.env, monitor.env). Throws on a value that is not a number. */
export function config(env) {
  const num = (k, d, min) => {
    const raw = env[k];
    if (raw === undefined || String(raw).trim() === "") return d;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < min) throw new Error(`${k}=${raw} is not a number >= ${min}`);
    return v;
  };
  // An address set to an empty value turns its check off; an unset one keeps the default.
  const str = (k, d) => (env[k] === undefined ? d : String(env[k]).trim());
  const names = str("BOTS", Object.keys(BOTS).join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const bots = names.map((n) => {
    const b = BOTS[n];
    if (!b) throw new Error(`BOTS: unknown bot "${n}" (known: ${Object.keys(BOTS).join(", ")})`);
    return { name: n, ...b, status: str(b.statusEnv, "") || b.status, maxAgeMin: num(b.maxAgeEnv, b.maxAgeMin, 1) };
  });
  return {
    bots,
    systemd: str("SYSTEMD", "auto").toLowerCase() === "off" ? "off" : "auto",
    failedRuns: Math.round(num("FAILED_RUNS", 2, 1)),
    maxPoolDev: num("MAX_POOL_DEV", 0.01, 0),
    poolDevRuns: Math.round(num("POOL_DEV_RUNS", 3, 1)),
    minHf: num("MIN_HF", 1.3, 0),
    faucet: str("FAUCET_ADDRESS", DEFAULTS.faucet),
    faucetMinUsdc: num("FAUCET_MIN_USDC", 2000, 0),
    faucetMinXlm: num("FAUCET_MIN_XLM", 50, 0),
    usdcIssuer: str("USDC_ISSUER", "") || DEFAULTS.usdcIssuer,
    horizonUrl: str("HORIZON_URL", "") || DEFAULTS.horizonUrl,
    exchange: str("USDC_EXCHANGE", DEFAULTS.exchange),
    exchangeMinUsdc: num("EXCHANGE_MIN_USDC", 500, 0),
    usdc: str("USDC", "") || DEFAULTS.usdc,
    rpcUrl: str("RPC_URL", "") || DEFAULTS.rpcUrl,
    alarmRepeatMin: num("ALARM_REPEAT_MIN", 60, 1),
    stockRepeatH: num("STOCK_REPEAT_H", 12, 0.1),
    softDelayMin: num("SOFT_DELAY_MIN", 10, 0),
    stateFile: stateFileOf(env),
  };
}

// ---- formatting ----

/** 1234.5 -> "1,235"; 12.345 -> "12.35" */
export function amount(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "?";
  const r = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
  const [i, f] = String(r).split(".");
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f ? `.${f}` : "");
}
export const pct = (x, sign = true) => `${sign && x > 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
const usd = (n) => `${amount(n)} USD`;
const short = (a) => (a.length > 12 ? `${a.slice(0, 5)}...${a.slice(-4)}` : a);
const list = (x) => (Array.isArray(x) ? x.filter((v) => typeof v === "string") : []);
const finite = (x) => typeof x === "number" && Number.isFinite(x);
/** "11-28 10:02 UTC" */
const clock = (ms) => (Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(5, 16).replace("T", " ")} UTC` : "?");
const ago = (min) => (min < 120 ? `${Math.round(min)} min` : min < 48 * 60 ? `${(min / 60).toFixed(1)} h` : `${Math.round(min / 1440)} days`);

// ---- the rules ----

/**
 * input: {
 *   bots: { NAME: { units: { timer, service } | null (systemd not read), status: object | null, statusError, raced } },
 *         units' values are `systemctl show` properties: { LoadState, ActiveState, SubState, Result, UnitFileState };
 *         raced: the status file changed while systemd was read
 *   systemdError: string | null      systemctl exists but could not be read
 *   faucet: { xlm, usdc (null = no trustline) } | { notFound: true } | { error } | null (check off)
 *   exchange: { usdc } | { error, sdkMissing? } | null (check off)
 * }
 * Returns { problems, unknown, ignore }.
 */
export function evaluate(input, cfg, now) {
  const out = { problems: [], unknown: [], ignore: [] };
  for (const name of Object.keys(BOTS)) if (!cfg.bots.some((b) => b.name === name)) out.ignore.push(`${name}:`);
  if (input.systemdError) {
    out.problems.push({
      key: "check:systemd", level: "soft", title: "check: systemd not readable",
      text: `the check cannot read systemd (${input.systemdError}): timers and services are not checked`,
      delayMin: cfg.softDelayMin,
    });
  }
  for (const bot of cfg.bots) botRules(bot, input.bots?.[bot.name] ?? {}, cfg, now, out);
  faucetRules(input.faucet, cfg, out);
  exchangeRules(input.exchange, cfg, out);
  return out;
}

function botRules(bot, got, cfg, now, out) {
  const add = (suffix, level, title, text, extra = {}) =>
    out.problems.push({ key: `${bot.name}:${suffix}`, level, title: `${bot.label}: ${title}`, text: `${bot.label}: ${text}`, ...extra });
  const units = got.units ?? null;
  const st = got.status ?? null;

  // 1) The timer. Stopped by hand on purpose? Take the bot out of BOTS in /etc/iora/monitor.env.
  if (!units) out.unknown.push(`${bot.name}:timer`, `${bot.name}:failed`, `${bot.name}:enabled`);
  else {
    const t = units.timer ?? {};
    if (t.LoadState !== "loaded") {
      const state = t.LoadState === "not-found" ? "not installed" : `not loaded (LoadState=${t.LoadState || "?"})`;
      add("timer", "alarm", "timer missing",
        `${bot.unit}.timer is ${state}: the bot does not run. Install it, or take "${bot.name}" out of BOTS in /etc/iora/monitor.env`);
    } else if (t.ActiveState !== "active") {
      add("timer", "alarm", "timer stopped",
        `${bot.unit}.timer is ${t.ActiveState || "?"}: the bot does not run (systemctl enable --now ${bot.unit}.timer, or take "${bot.name}" out of BOTS)`);
    } else if (t.UnitFileState === "disabled") {
      add("enabled", "soft", "timer not enabled",
        `${bot.unit}.timer runs but is not enabled: it does not come back after a reboot (systemctl enable ${bot.unit}.timer)`);
    }
  }

  // 2) The service's last run failed. One failed run that recorded itself (an RPC hiccup) is not an alarm yet;
  //    FAILED_RUNS in a row are. A failure the bot could not record (start-up error, crash, timeout) is.
  //    raced: a run finished while the check read systemd, so the two do not belong together: next check.
  const s = units?.service;
  if (s && got.raced) out.unknown.push(`${bot.name}:failed`);
  else if (s && s.ActiveState === "failed") {
    const result = s.Result || "?";
    const recorded = !!st && st.ok === false;
    const fails = recorded && Number.isInteger(st.failsInRow) && st.failsInRow > 0 ? st.failsInRow : 1;
    const logs = `journalctl -u ${bot.unit} -n 50`;
    if (result === "exit-code" && recorded) {
      if (fails >= cfg.failedRuns) add("failed", "alarm", "runs fail", `${fails} runs in a row failed; last error: ${st.error ?? "?"}`);
    } else if (result === "exit-code") {
      add("failed", "alarm", "runs fail", `the last run failed before it could write its status (start-up error or crash): ${logs}`);
    } else {
      const why = result === "timeout" ? "timeout: the run took longer than TimeoutStartSec" : `result ${result}`;
      add("failed", "alarm", "runs fail", `${bot.unit}.service failed (${why}): ${logs}`);
    }
  }

  // 3) The status file. Right after an install it is not there yet: told only when it stays missing for the
  //    bot's age limit.
  if (!st) {
    const text = !got.statusError || got.statusError === "missing"
      ? `no status file ${bot.status} (no run has finished since the unit got StateDirectory=)`
      : `status file ${bot.status} cannot be read (${got.statusError})`;
    add("status", "alarm", "no status file", text, { delayMin: bot.maxAgeMin });
    out.unknown.push(`${bot.name}:stale`, `${bot.name}:pool:`, `${bot.name}:stock:`, `${bot.name}:hf`);
    return;
  }

  // 4) The last successful run.
  const lastOk = Date.parse(st.ok === true ? st.at : st.lastOkAt ?? st.failingSince ?? st.at);
  const age = Number.isFinite(lastOk) ? (now - lastOk) / 60000 : Infinity;
  if (age > bot.maxAgeMin) {
    const text = st.ok === true
      ? `the last run was ${ago(age)} ago (${clock(lastOk)}; limit ${bot.maxAgeMin} min): the bot has stopped running, or cannot write ${bot.status}`
      : `no successful run for ${ago(age)} (limit ${bot.maxAgeMin} min; ${st.lastOkAt ? `last good run ${clock(Date.parse(st.lastOkAt))}` : "none recorded"}); ` +
        `the last run (${clock(Date.parse(st.at))}) failed: ${st.error ?? "?"}`;
    add("stale", "alarm", "no recent successful run", text);
  }

  if (bot.kind === "price") priceRules(bot, st, cfg, out, add);
  else borrowerRules(bot, st, cfg, out, add);
}

/** A price-bot inventory warning (logic.js decide()) -> { id, title, asset }, or null for other warnings. */
export function inventoryWarning(w) {
  let m = /^inventory low: [0-9.]+ (\S+)/.exec(w);
  if (m) return { id: `low:${m[1]}`, title: `${m[1]} inventory low`, asset: m[1] };
  m = /^inventory short: (\S+) pool wanted more (\S+)/.exec(w);
  if (m) return { id: `short:${m[1]}`, title: `${m[1]} pool short of ${m[2]}`, asset: m[2] };
  if (/^inventory\b/.test(w)) return { id: `other:${w.replace(/[0-9.]+/g, "#")}`, title: "inventory warning", asset: null };
  return null;
}

function priceRules(bot, st, cfg, out, add) {
  // Inventory, from the last run. A failed run may have skipped pools: it clears nothing.
  if (st.ok === true) {
    for (const w of list(st.warnings)) {
      const inv = inventoryWarning(w);
      // fund-bot.sh tops up the coins and USDC; XLM came from friendbot and is sent by hand
      const how = inv?.asset === "XLM" ? "send XLM to the bot's account" : `top up with ${bot.topUp}`;
      if (inv) add(`stock:${inv.id}`, "stock", inv.title, `${w}; ${how}`);
    }
  } else out.unknown.push(`${bot.name}:stock:`);

  // Pools: off the Reflector price (or not checked at all) in each of the last POOL_DEV_RUNS runs that looked at
  // the pool. One bad run is normal; a run where the pool failed ("error") is left out (the failure rules see it).
  const runs = cfg.poolDevRuns;
  const history = (Array.isArray(st.history) ? st.history : []).filter((h) => h && h.dev && typeof h.dev === "object");
  const names = [...new Set(history.slice(-runs).flatMap((h) => Object.keys(h.dev)))];
  for (const name of names) {
    const seen = history.map((h) => h.dev[name]).filter((v) => v !== undefined && v !== "error").slice(-runs);
    if (seen.length < runs) continue;
    const measured = seen.filter(finite);
    if (measured.some((v) => Math.abs(v) <= cfg.maxPoolDev)) continue;
    const last = seen[seen.length - 1];
    let text;
    if (measured.length === runs) {
      text = `pool ${name} is ${pct(last)} off the Reflector price, more than ${pct(cfg.maxPoolDev, false)} for ${runs} runs in a row`;
    } else if (measured.length === 0) {
      text = `pool ${name} was not checked in the last ${runs} runs (no fresh oracle price, or no liquidity): the bot leaves it alone`;
    } else {
      text = `pool ${name} was more than ${pct(cfg.maxPoolDev, false)} off the Reflector price, or not checked, in each of the last ${runs} runs ` +
        `(latest: ${finite(last) ? pct(last) : "not checked"})`;
    }
    const said = list(st.warnings)
      .filter((w) => w.startsWith(`${name}: `) || w.includes(` ${name} pool `))
      .map((w) => (w.startsWith(`${name}: `) ? w.slice(name.length + 2) : w));
    if (said.length) text += `; the bot says: ${said.join(" / ")}`;
    add(`pool:${name}`, "alarm", `pool ${name} off the Reflector price`, text);
  }
}

/** A borrower top-up warning (logic.js / multi.js) -> a short title. */
function borrowerWarningTitle(w) {
  if (/^wallet holds only/.test(w)) return "USDC wallet too small to repay";
  const m = /collateral (\S+) short by/.exec(w);
  if (m) return `collateral ${m[1]} short`;
  if (/not enough to restore/.test(w)) return "wallet cannot restore the health factor";
  return "top-up needed";
}

/** "effective collateral 640 USD, liabilities 529 USD; USDC debt 300 against 5,000 XLM; debts iETH 1,350 USD, ..." */
export function debtSummary(st) {
  const parts = [];
  if (finite(st.collateralUsd) && finite(st.liabilitiesUsd)) parts.push(`effective collateral ${usd(st.collateralUsd)}, liabilities ${usd(st.liabilitiesUsd)}`);
  if (st.usdc && finite(st.usdc.debt)) parts.push(`USDC debt ${amount(st.usdc.debt)} against ${amount(st.usdc.collateralXlm)} XLM`);
  if (st.coins && typeof st.coins === "object") {
    const debts = Object.entries(st.coins)
      .filter(([, c]) => c && finite(c.debtUsd) && c.debtUsd > 0)
      .sort((a, b) => b[1].debtUsd - a[1].debtUsd)
      .slice(0, 4)
      .map(([k, c]) => `${k} ${usd(c.debtUsd)}`);
    if (debts.length) parts.push(`debts ${debts.join(", ")}`);
  }
  return parts.join("; ") || "no position numbers";
}

function borrowerRules(bot, st, cfg, out, add) {
  // Health factor after the last run (estimated when it sent something). Nothing liquidates our own pool, so this
  // is the early warning. Unknown (missing price, or a failed run without a number): its state is kept.
  if (finite(st.hf)) {
    if (st.hf < cfg.minHf) {
      add("hf", "alarm", `health factor below ${cfg.minHf}`,
        `health factor ${st.hf.toFixed(3)} is below ${cfg.minHf} (${debtSummary(st)}). Nothing liquidates positions in Iora's Blend pool: repay or add collateral`);
    }
  } else if (st.ok !== true || st.pricesOk === false) out.unknown.push(`${bot.name}:hf`);

  if (st.ok === true) {
    for (const w of list(st.warnings)) add(`stock:${w.replace(/[0-9.]+/g, "#")}`, "stock", borrowerWarningTitle(w), w);
  } else out.unknown.push(`${bot.name}:stock:`);
}

function faucetRules(f, cfg, out) {
  if (!cfg.faucet) return;
  const who = `faucet ${short(cfg.faucet)}`;
  const add = (key, level, title, text, extra = {}) => out.problems.push({ key, level, title, text, ...extra });
  if (!f || f.error) {
    out.unknown.push("faucet:");
    add("check:horizon", "soft", "check: Horizon not reachable",
      `the check cannot read the faucet account from Horizon (${f?.error ?? "no answer"}); the faucet is not checked meanwhile`,
      { delayMin: cfg.softDelayMin });
    return;
  }
  if (f.notFound) {
    out.unknown.push("faucet:usdc", "faucet:xlm");
    add("faucet:account", "stock", "faucet account missing",
      `${who} does not exist on testnet (a testnet reset?): the site's "Get test USDC" fails until it is funded again`);
    return;
  }
  if (f.usdc === null || f.usdc === undefined) {
    add("faucet:usdc", "stock", "faucet: no Circle USDC", `${who} has no Circle USDC trustline: every claim fails`);
  } else if (f.usdc < cfg.faucetMinUsdc) {
    add("faucet:usdc", "stock", "faucet: Circle USDC low", `${who} holds ${amount(f.usdc)} Circle USDC (warn below ${amount(cfg.faucetMinUsdc)}): top it up`);
  }
  if (finite(f.xlm) && f.xlm < cfg.faucetMinXlm) {
    add("faucet:xlm", "stock", "faucet: XLM low", `${who} holds ${amount(f.xlm)} XLM (warn below ${amount(cfg.faucetMinXlm)}); it pays the claims' fees: top it up`);
  }
}

function exchangeRules(x, cfg, out) {
  if (!cfg.exchange) return;
  if (!x || x.error) {
    out.unknown.push("exchange:");
    if (x?.sdkMissing) {
      out.problems.push({ key: "check:sdk", level: "soft", title: "check: USDC exchange not checked", text: `the USDC exchange is not checked: ${x.error}` });
    } else {
      out.problems.push({
        key: "check:rpc", level: "soft", title: "check: RPC not reachable",
        text: `the check cannot read the USDC exchange's balance from the RPC (${x?.error ?? "no answer"})`, delayMin: cfg.softDelayMin,
      });
    }
    return;
  }
  if (finite(x.usdc) && x.usdc < cfg.exchangeMinUsdc) {
    out.problems.push({
      key: "exchange:usdc", level: "stock", title: "USDC exchange: Circle USDC low",
      text: `the USDC exchange ${short(cfg.exchange)} holds ${amount(x.usdc)} Circle USDC (warn below ${amount(cfg.exchangeMinUsdc)}): ` +
        "moving an old vault that holds Blend's old test USDC fails once it runs out; top it up with a plain transfer to the contract",
    });
  }
}
