import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { decide as priceDecide } from "../../price-bot/logic.js";
import { decide as borrowDecide } from "../../blend-borrower/logic.js";
import { BOTS, DEFAULTS, amount, config, debtSummary, evaluate, inventoryWarning, pct, stateFileOf, unwatchedKeys } from "../rules.js";

const NOW = Date.parse("2026-11-28T12:00:00Z");
const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();
const cfg = (env = {}) => config({ MONITOR_STATE_FILE: "/tmp/x.json", ...env });

const unitsOk = () => ({
  timer: { LoadState: "loaded", ActiveState: "active", SubState: "waiting", Result: "success", UnitFileState: "enabled" },
  service: { LoadState: "loaded", ActiveState: "inactive", SubState: "dead", Result: "success", UnitFileState: "static" },
});
const good = (dev) => ({ at: iso(NOW - 3 * MIN), ok: true, dev: { XLM: dev, iBTC: -0.001 } });
const priceStatus = (o = {}) => ({
  bot: "price-bot", at: iso(NOW - 2 * MIN), ok: true, lastOkAt: iso(NOW - 2 * MIN), failsInRow: 0, failingSince: null,
  warnings: [], pools: {}, inventory: {}, history: [good(0.001), good(0.0005), good(-0.0002)], ...o,
});
const borrowerStatus = (o = {}) => ({
  bot: "blend-borrower", at: iso(NOW - 5 * MIN), ok: true, lastOkAt: iso(NOW - 5 * MIN), failsInRow: 0,
  warnings: [], pricesOk: true, hf: 2.05, collateralUsd: 640, liabilitiesUsd: 312,
  usdc: { util: 0.6, debt: 296.4, collateralXlm: 5000 }, ...o,
});
/** Everything fine; o: { bots: { NAME: {...} }, watch, faucet, exchange, systemdError } */
const input = (o = {}) => ({
  bots: {
    "price-bot": { units: unitsOk(), status: priceStatus(), ...o.bots?.["price-bot"] },
    borrower: { units: unitsOk(), status: borrowerStatus(), ...o.bots?.borrower },
    "borrower-multi": { units: unitsOk(), status: borrowerStatus({ usdc: undefined, hf: null, liabilitiesUsd: 0 }), ...o.bots?.["borrower-multi"] },
  },
  watch: "watch" in o ? o.watch : { "iora-keeper-heartbeat.timer": unitsOk().timer },
  faucet: "faucet" in o ? o.faucet : { xlm: 1999.99, usdc: 14603.3 },
  exchange: "exchange" in o ? o.exchange : { usdc: 2995.47 },
  systemdError: o.systemdError ?? null,
});
const run = (o, env, now = NOW) => evaluate(input(o), cfg(env), now);
const keys = (r) => r.problems.map((p) => p.key).sort();
const one = (r, key) => {
  const p = r.problems.find((x) => x.key === key);
  assert.ok(p, `no problem ${key} in ${keys(r).join(", ") || "(none)"}`);
  return p;
};

test("settings: defaults, a subset of bots, unknown names and bad numbers", () => {
  const c = cfg();
  assert.deepEqual(c.bots.map((b) => b.name), ["price-bot", "borrower", "borrower-multi"]);
  assert.equal(c.bots[0].status, "/var/lib/iora/price-bot/status.json");
  assert.equal(c.bots[0].maxAgeMin, 15);
  assert.equal(c.bots[1].maxAgeMin, 45);
  assert.equal(c.maxPoolDev, 0.01);
  assert.equal(c.poolDevRuns, 3);
  assert.equal(c.minHf, 1.3);
  assert.equal(c.failedRuns, 2);
  assert.equal(c.faucet, DEFAULTS.faucet);
  assert.equal(c.faucetMinUsdc, 2000);
  assert.equal(c.faucetMinXlm, 50);
  assert.equal(c.exchange, DEFAULTS.exchange);
  assert.equal(c.alarmRepeatMin, 60);
  assert.equal(c.stockRepeatH, 12);
  const s = cfg({ BOTS: "price-bot", PRICE_BOT_MAX_AGE_MIN: "20", PRICE_BOT_STATUS: "/x/p.json", MIN_HF: "1.4", FAUCET_ADDRESS: "", USDC_EXCHANGE: "" });
  assert.deepEqual(s.bots.map((b) => [b.name, b.maxAgeMin, b.status]), [["price-bot", 20, "/x/p.json"]]);
  assert.equal(s.minHf, 1.4);
  assert.equal(s.faucet, "");
  assert.equal(s.exchange, "");
  assert.throws(() => cfg({ BOTS: "price-bot,keeper" }), /unknown bot "keeper"/);
  assert.throws(() => cfg({ MIN_HF: "abc" }), /MIN_HF=abc is not a number/);
  assert.throws(() => cfg({ FAILED_RUNS: "0" }), /FAILED_RUNS/);
  assert.equal(cfg({ BOTS: "" }).bots.length, 0);
  assert.deepEqual(c.watchTimers, ["iora-keeper-heartbeat.timer"]);
  assert.deepEqual(cfg({ WATCH_TIMERS: "" }).watchTimers, []);
  assert.deepEqual(cfg({ WATCH_TIMERS: " a.timer, b.timer,,a.timer " }).watchTimers, ["a.timer", "b.timer"]);
});

test("state file: MONITOR_STATE_FILE, else STATE_DIRECTORY, else the temp dir", () => {
  assert.equal(stateFileOf({ MONITOR_STATE_FILE: "/a/s.json", STATE_DIRECTORY: "/b" }), "/a/s.json");
  assert.equal(stateFileOf({ STATE_DIRECTORY: "/var/lib/iora/monitor" }), join("/var/lib/iora/monitor", "state.json"));
  assert.match(stateFileOf({}), /iora-bots-check\.json$/);
});

test("all fine: no problem, nothing unknown", () => {
  const r = run();
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.unknown, []);
  assert.deepEqual(r.ignore, []);
});

test("timer not active, not installed, or not enabled", () => {
  const stopped = unitsOk();
  stopped.timer = { ...stopped.timer, ActiveState: "inactive", SubState: "dead" };
  let p = one(run({ bots: { "price-bot": { units: stopped } } }), "price-bot:timer");
  assert.equal(p.level, "alarm");
  assert.match(p.text, /^price bot: iora-price-bot\.timer is inactive: the bot does not run/);
  const missing = unitsOk();
  missing.timer = { LoadState: "not-found", ActiveState: "inactive" };
  p = one(run({ bots: { borrower: { units: missing } } }), "borrower:timer");
  assert.match(p.text, /iora-blend-borrower\.timer is not installed: the bot does not run/);
  missing.timer.LoadState = "masked";
  p = one(run({ bots: { borrower: { units: missing } } }), "borrower:timer");
  assert.match(p.text, /iora-blend-borrower\.timer is not loaded \(LoadState=masked\)/);
  const disabled = unitsOk();
  disabled.timer.UnitFileState = "disabled";
  p = one(run({ bots: { "borrower-multi": { units: disabled } } }), "borrower-multi:enabled");
  assert.equal(p.level, "soft");
});

test("failed service: one recorded failure waits, two in a row alarm, an unrecorded failure alarms at once", () => {
  const failed = (Result = "exit-code") => {
    const u = unitsOk();
    u.service = { ...u.service, ActiveState: "failed", SubState: "failed", Result };
    return u;
  };
  const once = priceStatus({ ok: false, failsInRow: 1, error: "1 of 6 pools failed: XLM: timeout", lastOkAt: iso(NOW - 4 * MIN), failingSince: iso(NOW - 2 * MIN) });
  assert.deepEqual(keys(run({ bots: { "price-bot": { units: failed(), status: once } } })), []);
  const twice = { ...once, failsInRow: 2 };
  let p = one(run({ bots: { "price-bot": { units: failed(), status: twice } } }), "price-bot:failed");
  assert.equal(p.text, "price bot: 2 runs in a row failed; last error: 1 of 6 pools failed: XLM: timeout");
  assert.deepEqual(keys(run({ bots: { "price-bot": { units: failed(), status: twice } } }, { FAILED_RUNS: "3" })), []);
  // systemd says failed, the status says the last run was fine: the failed run could not write it
  p = one(run({ bots: { borrower: { units: failed() } } }), "borrower:failed");
  assert.match(p.text, /failed before it could write its status .*journalctl -u iora-blend-borrower/);
  p = one(run({ bots: { borrower: { units: failed("timeout"), status: borrowerStatus({ ok: false, failsInRow: 1 }) } } }), "borrower:failed");
  assert.match(p.text, /failed \(timeout: the run took longer than TimeoutStartSec\)/);
  p = one(run({ bots: { borrower: { units: failed("resources") } } }), "borrower:failed");
  assert.match(p.text, /failed \(result resources\)/);
  // a run finished while systemd was read: the two do not belong together, the rule waits for the next check
  const raced = run({ bots: { borrower: { units: failed(), raced: true } } });
  assert.deepEqual(keys(raced), []);
  assert.ok(raced.unknown.includes("borrower:failed"));
});

test("no successful run for too long: 15 min for the price bot, 45 for the borrowers", () => {
  assert.deepEqual(keys(run({ bots: { "price-bot": { status: priceStatus({ at: iso(NOW - 14 * MIN) }) } } })), []);
  let p = one(run({ bots: { "price-bot": { status: priceStatus({ at: iso(NOW - 16 * MIN) }) } } }), "price-bot:stale");
  assert.equal(p.level, "alarm");
  assert.match(p.text, /^price bot: the last run was 16 min ago \(11-28 11:44 UTC; limit 15 min\): the bot has stopped running/);
  assert.deepEqual(keys(run({ bots: { borrower: { status: borrowerStatus({ at: iso(NOW - 44 * MIN) }) } } })), []);
  one(run({ bots: { borrower: { status: borrowerStatus({ at: iso(NOW - 46 * MIN) }) } } }), "borrower:stale");
  // failing runs: counted from the last good run
  const failing = priceStatus({ at: iso(NOW - 1 * MIN), ok: false, lastOkAt: iso(NOW - 20 * MIN), failsInRow: 9, error: "RPC did not answer" });
  p = one(run({ bots: { "price-bot": { status: failing } } }), "price-bot:stale");
  assert.match(p.text, /no successful run for 20 min \(limit 15 min; last good run 11-28 11:40 UTC\); the last run \(11-28 11:59 UTC\) failed: RPC did not answer/);
  const never = priceStatus({ at: iso(NOW - 1 * MIN), ok: false, lastOkAt: null, failingSince: iso(NOW - 16 * MIN), failsInRow: 8, error: "x" });
  assert.match(one(run({ bots: { "price-bot": { status: never } } }), "price-bot:stale").text, /none recorded/);
  assert.equal(cfg({ BORROWER_MAX_AGE_MIN: "60" }).bots[1].maxAgeMin, 60);
  assert.deepEqual(keys(run({ bots: { borrower: { status: borrowerStatus({ at: iso(NOW - 50 * MIN) }) } } }, { BORROWER_MAX_AGE_MIN: "60" })), []);
});

test("no status file: an alarm that waits the bot's age limit; the rest of its checks are unknown", () => {
  const r = run({ bots: { borrower: { status: null, statusError: "missing" } } });
  const p = one(r, "borrower:status");
  assert.equal(p.delayMin, 45);
  assert.match(p.text, /no status file \/var\/lib\/iora\/borrower\/status\.json/);
  for (const k of ["borrower:stale", "borrower:pool:", "borrower:stock:", "borrower:hf"]) assert.ok(r.unknown.includes(k), k);
  const bad = one(run({ bots: { "price-bot": { status: null, statusError: "Unexpected token" } } }), "price-bot:status");
  assert.match(bad.text, /cannot be read \(Unexpected token\)/);
  assert.equal(bad.delayMin, 15);
});

test("price bot inventory warnings, as logic.js writes them, are stock warnings with stable keys", () => {
  // real warnings from the price bot's decide(): 15 USD of XLM, 0.5 USDC, and a trade the inventory limited
  const Q96 = 2 ** 96;
  const sq = (p) => Math.sqrt(1 / p) * Q96;
  const L = Math.sqrt(3000e7 * 23557e7);
  const d = priceDecide(
    { coin: "XLM", sqrtPriceX96: sq(0.1274 * 1.02), liquidity: L, feeBps: 30, coinUsd: 0.1274, usdcUsd: 1, priceAge: 60, walletUsdc: 0.5, walletCoin: 120 },
    { threshold: 0.005, maxAge: 900, maxTradeUsd: 300, minTradeUsd: 1, coinReserve: 20, warnUsdc: 200, warnCoinUsd: 100 },
  );
  assert.equal(d.warnings.length, 3);
  const r = run({ bots: { "price-bot": { status: priceStatus({ warnings: [...d.warnings, "XLM: the router's estimate is worse than the reference less the fee (the pool moved); nothing sent"] }) } } });
  assert.deepEqual(keys(r), ["price-bot:stock:low:USDC", "price-bot:stock:low:XLM", "price-bot:stock:short:XLM"]);
  const low = one(r, "price-bot:stock:low:XLM");
  assert.equal(low.level, "stock");
  assert.equal(low.title, "price bot: XLM inventory low");
  assert.match(low.text, /^price bot: inventory low: 120\.0000000 XLM = 15\.29 USD .*; send XLM to the bot's account$/);
  assert.match(one(r, "price-bot:stock:low:USDC").text, /^price bot: inventory low: 0\.5000 USDC \(warn below 200\); top up with scripts\/price-bot\/fund-bot\.sh$/);
  assert.equal(one(r, "price-bot:stock:short:XLM").title, "price bot: XLM pool short of XLM");
  assert.deepEqual(inventoryWarning("inventory low: 150.0000 USDC (warn below 200)"), { id: "low:USDC", title: "USDC inventory low", asset: "USDC" });
  assert.equal(inventoryWarning("inventory low: 0.0100000 iBTC = 597.00 USD (warn below 100 USD)").asset, "iBTC");
  assert.equal(inventoryWarning("XLM: the router's estimate is worse"), null);
  // a failed run may have skipped pools: its (missing) warnings clear nothing
  const failed = run({ bots: { "price-bot": { status: priceStatus({ ok: false, failsInRow: 1, warnings: [] }) } } });
  assert.ok(failed.unknown.includes("price-bot:stock:"));
});

test("pool off the Reflector price: alarm only for POOL_DEV_RUNS runs in a row", () => {
  const h = (...devs) => devs.map((dev, i) => ({ at: iso(NOW - (devs.length - i) * 2 * MIN), ok: true, dev: { XLM: dev, iBTC: 0.001 } }));
  const at = (history, env) => run({ bots: { "price-bot": { status: priceStatus({ history }) } } }, env);
  let p = one(at(h(0.001, 0.015, -0.012, 0.0151)), "price-bot:pool:XLM");
  assert.equal(p.level, "alarm");
  assert.equal(p.text, "price bot: pool XLM is +1.51% off the Reflector price, more than 1.00% for 3 runs in a row");
  assert.deepEqual(keys(at(h(0.015, 0.015))), []); // only 2 runs
  assert.deepEqual(keys(at(h(0.015, 0.009, 0.015))), []); // one good run in between
  assert.deepEqual(keys(at(h(0.015, 0.015, 0.015), { MAX_POOL_DEV: "0.02" })), []);
  one(at(h(0.009, 0.015, 0.015), { POOL_DEV_RUNS: "2" }), "price-bot:pool:XLM");
  // a run where the pool failed is left out (the failure rules see it)
  one(at(h(0.02, "error", 0.02, 0.02)), "price-bot:pool:XLM");
  assert.deepEqual(keys(at(h(0.02, "error", "error", 0.02))), []);
  // not checked at all (no fresh oracle price): the bot leaves the pool alone, the check does not
  p = one(at(h("skipped", "skipped", "skipped")), "price-bot:pool:XLM");
  assert.match(p.text, /pool XLM was not checked in the last 3 runs \(no fresh oracle price, or no liquidity\)/);
  p = one(at(h(0.03, "skipped", -0.02)), "price-bot:pool:XLM");
  assert.match(p.text, /off the Reflector price, or not checked, in each of the last 3 runs \(latest: -2\.00%\)/);
  // the bot's own words about the pool are added
  const said = run({ bots: { "price-bot": { status: priceStatus({
    history: h(0.02, 0.02, 0.02),
    warnings: ["XLM: the router's estimate is worse than the reference less the fee; nothing sent", "inventory short: XLM pool wanted more USDC than the 3.0000000 available", "iBTC: other"],
  }) } } });
  p = one(said, "price-bot:pool:XLM");
  assert.match(p.text, /; the bot says: the router's estimate is worse .* \/ inventory short: XLM pool wanted more USDC/);
  assert.doesNotMatch(p.text, /iBTC: other/);
});

test("borrower health factor below MIN_HF: an alarm with a debt and collateral summary", () => {
  let p = one(run({ bots: { borrower: { status: borrowerStatus({ hf: 1.21, collateralUsd: 476.3, liabilitiesUsd: 393.6 }) } } }), "borrower:hf");
  assert.equal(p.level, "alarm");
  assert.equal(p.title, "USDC borrower: health factor below 1.3");
  assert.match(p.text, /^USDC borrower: health factor 1\.210 is below 1\.3 \(effective collateral 476 USD, liabilities 394 USD; USDC debt 296 against 5,000 XLM\)\. Nothing liquidates/);
  const coins = { iETH: { debtUsd: 1350 }, iSOL: { debtUsd: 1200 }, XLM: { debtUsd: 0 }, iBTC: { active: false } };
  p = one(run({ bots: { "borrower-multi": { status: borrowerStatus({ hf: 1.1, usdc: undefined, coins }) } } }), "borrower-multi:hf");
  assert.match(p.text, /debts iETH 1,350 USD, iSOL 1,200 USD\)/);
  assert.deepEqual(keys(run({ bots: { borrower: { status: borrowerStatus({ hf: 1.3 }) } } })), []);
  assert.deepEqual(keys(run({ bots: { borrower: { status: borrowerStatus({ hf: 1.4 }) } } }, { MIN_HF: "1.5" })), ["borrower:hf"]);
  // no debt: nothing to check; a missing price: unknown (kept as it was)
  assert.deepEqual(keys(run({ bots: { borrower: { status: borrowerStatus({ hf: null, liabilitiesUsd: 0 }) } } })), []);
  const r = run({ bots: { borrower: { status: borrowerStatus({ hf: null, pricesOk: false }) } } });
  assert.ok(r.unknown.includes("borrower:hf"));
  assert.equal(debtSummary({}), "no position numbers");
});

test("borrower top-up warnings, as logic.js writes them, are stock warnings", () => {
  const { warnings } = borrowDecide(
    { poolActive: true, pricesOk: true, supplied: 100, borrowed: 60, usdcPrice: 1, usdcLFactor: 0.95, collPrice: 0.125, collCFactor: 0.75,
      effCollateral: 187.5, effLiabilities: 130 / 0.95, debt: 130, collateral: 2000, walletUsdc: 10, walletColl: 60 },
    { utilTarget: 0.6, utilBand: 0.1, minHf: 1.5, targetHf: 2.0, maxDebt: 1000, collateralTarget: 2000, collReserve: 50, minAction: 0.5 },
  );
  const r = run({ bots: { borrower: { status: borrowerStatus({ warnings }) } } });
  const p = r.problems.find((x) => x.key.startsWith("borrower:stock:"));
  assert.equal(p.level, "stock");
  assert.equal(p.title, "USDC borrower: USDC wallet too small to repay");
  assert.equal(p.key, "borrower:stock:wallet holds only # USDC of # needed: add XLM or USDC to the bot");
  const m = run({ bots: { "borrower-multi": { status: borrowerStatus({ warnings: ["multi: collateral iBTC short by 0.0123 and the wallet has 0.00000: mint more (fund-multi.sh)"] }) } } });
  assert.equal(m.problems[0].title, "multi-coin borrower: collateral iBTC short");
  const failed = run({ bots: { borrower: { status: borrowerStatus({ ok: false, failsInRow: 1 }) } } });
  assert.ok(failed.unknown.includes("borrower:stock:"));
});

test("faucet: Circle USDC and XLM left, no trustline, account gone, Horizon not reachable", () => {
  let p = one(run({ faucet: { xlm: 1999, usdc: 1999.5 } }), "faucet:usdc");
  assert.equal(p.level, "stock");
  assert.equal(p.text, "faucet GDWNS...SY47 holds 2,000 Circle USDC (warn below 2,000): top it up");
  assert.deepEqual(keys(run({ faucet: { xlm: 1999, usdc: 2000 } })), []);
  p = one(run({ faucet: { xlm: 49.9, usdc: 5000 } }), "faucet:xlm");
  assert.match(p.text, /holds 49\.9 XLM \(warn below 50\)/);
  assert.match(one(run({ faucet: { xlm: 100, usdc: null } }), "faucet:usdc").text, /no Circle USDC trustline/);
  let r = run({ faucet: { notFound: true } });
  assert.deepEqual(keys(r), ["faucet:account"]);
  assert.ok(r.unknown.includes("faucet:usdc") && r.unknown.includes("faucet:xlm"));
  // the check itself cannot read Horizon: a soft notice after SOFT_DELAY_MIN, not a bot alarm
  r = run({ faucet: { error: "HTTP 503" } });
  p = one(r, "check:horizon");
  assert.equal(p.level, "soft");
  assert.equal(p.delayMin, 10);
  assert.match(p.text, /cannot read the faucet account from Horizon \(HTTP 503\)/);
  assert.ok(r.unknown.includes("faucet:"));
  assert.deepEqual(keys(run({ faucet: { xlm: 1, usdc: 1 } }, { FAUCET_ADDRESS: "" })), []);
  assert.deepEqual(keys(run({ faucet: { xlm: 1999, usdc: 2500 } }, { FAUCET_MIN_USDC: "3000" })), ["faucet:usdc"]);
});

test("USDC exchange: Circle USDC left, or why it was not read", () => {
  const p = one(run({ exchange: { usdc: 120.5 } }), "exchange:usdc");
  assert.equal(p.level, "stock");
  assert.match(p.text, /USDC exchange CARNY\.\.\.AKTT holds 121 Circle USDC \(warn below 500\)/);
  assert.deepEqual(keys(run({ exchange: { usdc: 600 } })), []);
  let r = run({ exchange: { error: "getNetwork: no answer in 15 s" } });
  assert.equal(one(r, "check:rpc").level, "soft");
  assert.ok(r.unknown.includes("exchange:"));
  r = run({ exchange: { error: "@stellar/stellar-sdk is not installed", sdkMissing: true } });
  assert.equal(one(r, "check:sdk").delayMin, undefined);
  assert.deepEqual(keys(run({ exchange: { usdc: 1 } }, { USDC_EXCHANGE: "" })), []);
});

test("systemd: not read -> timer and service unknown; readable failure -> soft notice", () => {
  const r = run({ bots: { "price-bot": { units: null } } });
  assert.deepEqual(keys(r), []);
  for (const k of ["price-bot:timer", "price-bot:failed", "price-bot:enabled"]) assert.ok(r.unknown.includes(k), k);
  const s = one(run({ systemdError: "Failed to connect to bus" }), "check:systemd");
  assert.equal(s.level, "soft");
});

test("WATCH_TIMERS: the keeper heartbeat's timer must be active (the heartbeat watches this check in turn)", () => {
  const hb = "iora-keeper-heartbeat.timer";
  const t = (o) => ({ [hb]: { ...unitsOk().timer, ...o } });
  let p = one(run({ watch: t({ ActiveState: "inactive", SubState: "dead" }) }), `watch:${hb}`);
  assert.equal(p.level, "alarm");
  assert.equal(p.text, "timer iora-keeper-heartbeat.timer is not active: the keeper heartbeat check does not run");
  assert.equal(p.title, "timer iora-keeper-heartbeat.timer not active");
  p = one(run({ watch: t({ LoadState: "not-found", ActiveState: "inactive" }) }), `watch:${hb}`);
  assert.equal(p.text, "timer iora-keeper-heartbeat.timer is not active (not installed): the keeper heartbeat check does not run");
  p = one(run({ watch: t({ ActiveState: "failed" }) }), `watch:${hb}`);
  assert.match(p.text, /is not active \(failed\):/);
  assert.deepEqual(keys(run({ watch: t({ ActiveState: "reloading" }) })), []);
  // other units: a generic text, "unit" for anything that is not a timer
  const r = run(
    { watch: { "x.timer": { LoadState: "loaded", ActiveState: "inactive" }, "iora-keeper.service": { LoadState: "loaded", ActiveState: "failed" } } },
    { WATCH_TIMERS: "x.timer,iora-keeper.service" },
  );
  assert.deepEqual(r.problems.map((x) => x.text), ["timer x.timer is not active", "unit iora-keeper.service is not active (failed)"]);
  // empty: off
  assert.deepEqual(run({ watch: t({ ActiveState: "inactive" }) }, { WATCH_TIMERS: "" }).problems, []);
  // systemd not read: no alarm, the state is kept; one unit not read: only that one
  const unread = run({ watch: null });
  assert.deepEqual(keys(unread), []);
  assert.ok(unread.unknown.includes("watch:"));
  const half = run({ watch: {} });
  assert.deepEqual(keys(half), []);
  assert.ok(half.unknown.includes(`watch:${hb}`));
  // a unit taken out of WATCH_TIMERS: its old state is dropped without an OK line
  const items = { [`watch:${hb}`]: {}, "watch:old.timer": {}, "price-bot:stale": {} };
  assert.deepEqual(unwatchedKeys(items, cfg()), ["watch:old.timer"]);
  assert.deepEqual(unwatchedKeys(items, cfg({ WATCH_TIMERS: "" })), [`watch:${hb}`, "watch:old.timer"]);
  assert.deepEqual(unwatchedKeys(null, cfg()), []);
});

test("bots left out of BOTS: their old state is dropped, and they are not checked", () => {
  const r = run({ bots: { borrower: { units: null, status: null } } }, { BOTS: "price-bot" });
  assert.deepEqual(r.ignore, ["borrower:", "borrower-multi:"]);
  assert.deepEqual(keys(r), []);
  assert.equal(Object.keys(BOTS).length, 3);
});

test("formatting", () => {
  assert.equal(amount(14603.3033517), "14,603");
  assert.equal(amount(1234567.8), "1,234,568");
  assert.equal(amount(49.987), "49.99");
  assert.equal(amount(-1500), "-1,500");
  assert.equal(amount(NaN), "?");
  assert.equal(pct(0.0151), "+1.51%");
  assert.equal(pct(-0.02), "-2.00%");
  assert.equal(pct(0.01, false), "1.00%");
});
