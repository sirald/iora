import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  exchangeBalance, faucetBalances, hideToken, main, parseShow, parseStatus, reportCrash, telegram, unitState, writeJson,
} from "../monitor.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-11-28T12:00:00Z");
const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();
const TOKEN = "123456:SECRET-TELEGRAM-TOKEN";
const FAUCET = "GDWNSKKAMSQZRLV4EGXFMY7QSUQ5EOOXJGUNMLH6H3KFU4B2ZZESSY47";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const response = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const account = (usdc = "14603.3033517", xlm = "1999.9983371") => ({
  balances: [
    { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: usdc },
    { asset_type: "native", balance: xlm },
  ],
});

/** A fake world: status files in a temp dir, systemd, Horizon, Telegram, the exchange. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), "iora-monitor-"));
  const w = {
    dir,
    units: {}, // unit -> properties; default: an active timer, an inactive service
    horizon: () => response(200, account()),
    telegramStatus: 200,
    telegramThrows: null,
    sent: [], // Telegram bodies
    horizonCalls: 0,
    exchange: { usdc: 2995.47 },
    out: [],
    err: [],
    env: {
      PRICE_BOT_STATUS: join(dir, "price-bot.json"),
      BORROWER_STATUS: join(dir, "borrower.json"),
      BORROWER_MULTI_STATUS: join(dir, "borrower-multi.json"),
      MONITOR_STATE_FILE: join(dir, "state.json"),
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_CHAT_ID: "-100123",
    },
    status(name, s) {
      writeFileSync(join(dir, `${name}.json`), JSON.stringify(s));
    },
    deps() {
      return {
        run: async (cmd, args) => {
          assert.equal(cmd, "systemctl");
          const unit = args[args.length - 1];
          w.onSystemctl?.(unit);
          const p = w.units[unit] ?? (unit.endsWith(".timer")
            ? { LoadState: "loaded", ActiveState: "active", SubState: "waiting", Result: "success", UnitFileState: "enabled" }
            : { LoadState: "loaded", ActiveState: "inactive", SubState: "dead", Result: "success", UnitFileState: "static" });
          if (p instanceof Error) throw p;
          return { stdout: Object.entries(p).map(([k, v]) => `${k}=${v}`).join("\n") + "\n" };
        },
        fetch: async (url, opts) => {
          if (url.startsWith("https://api.telegram.org/")) {
            assert.equal(url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
            if (w.telegramThrows) throw w.telegramThrows;
            w.sent.push(JSON.parse(opts.body));
            return response(w.telegramStatus, {});
          }
          assert.equal(url, `https://horizon-testnet.stellar.org/accounts/${FAUCET}`);
          w.horizonCalls++;
          return w.horizon();
        },
        sleep: async () => {},
        exchange: async () => w.exchange,
        host: "test-host",
        out: (s) => w.out.push(s),
        err: (s) => w.err.push(s),
      };
    },
    check: (now = NOW, env = {}) => main({ env: { ...w.env, ...env }, now, deps: w.deps() }),
    state: () => JSON.parse(readFileSync(join(dir, "state.json"), "utf8")),
    texts: () => w.sent.map((b) => b.text),
    clean: () => rmSync(dir, { recursive: true, force: true }),
  };
  return w;
}
const priceStatus = (at, o = {}) => ({
  bot: "price-bot", at: iso(at), ok: true, lastOkAt: iso(at), failsInRow: 0, warnings: [],
  history: [0.001, 0.002, -0.001].map((d) => ({ at: iso(at), ok: true, dev: { XLM: d } })), ...o,
});
const borrowerStatus = (at, o = {}) => ({ bot: "blend-borrower", at: iso(at), ok: true, lastOkAt: iso(at), failsInRow: 0, warnings: [], pricesOk: true, hf: 2.1, ...o });
function healthy(w, now = NOW) {
  w.status("price-bot", priceStatus(now - 2 * MIN));
  w.status("borrower", borrowerStatus(now - 5 * MIN));
  w.status("borrower-multi", borrowerStatus(now - 5 * MIN, { hf: null }));
}

test("systemctl show output -> properties; the unit is asked with -p", async () => {
  assert.deepEqual(parseShow("LoadState=loaded\nActiveState=failed\nResult=exit-code\nNoEquals\nX=a=b\n"), {
    LoadState: "loaded", ActiveState: "failed", Result: "exit-code", X: "a=b",
  });
  let seen;
  const props = await unitState("iora-price-bot.timer", async (cmd, args) => {
    seen = [cmd, ...args];
    return { stdout: "ActiveState=active\nLoadState=loaded\n" };
  });
  assert.deepEqual(props, { ActiveState: "active", LoadState: "loaded" });
  assert.deepEqual(seen, ["systemctl", "show", "-p", "LoadState", "-p", "ActiveState", "-p", "SubState", "-p", "Result", "-p", "UnitFileState", "iora-price-bot.timer"]);
});

test("status files: a JSON object with 'at'", () => {
  assert.equal(parseStatus('{"at":"2026-11-28T12:00:00Z","ok":true}').ok, true);
  assert.throws(() => parseStatus("[]"), /no 'at'/);
  assert.throws(() => parseStatus('{"ok":true}'), /no 'at'/);
  assert.throws(() => parseStatus("{bad"));
});

test("faucet from Horizon: balances, no trustline, not found, one retry, then an error", async () => {
  const cfg = { horizonUrl: "https://horizon-testnet.stellar.org/", faucet: FAUCET, usdcIssuer: ISSUER };
  const fake = (...answers) => {
    const calls = [];
    return {
      calls,
      fetch: async (url, opts) => {
        calls.push(url);
        assert.ok(opts.signal, "a timeout signal");
        const a = answers.shift();
        if (a instanceof Error) throw a;
        return a;
      },
    };
  };
  let f = fake(response(200, account()));
  assert.deepEqual(await faucetBalances(cfg, f.fetch, async () => {}), { xlm: 1999.9983371, usdc: 14603.3033517 });
  assert.deepEqual(f.calls, [`https://horizon-testnet.stellar.org/accounts/${FAUCET}`]);
  f = fake(response(200, { balances: [{ asset_type: "native", balance: "10" }, { asset_code: "USDC", asset_issuer: "GOTHER", balance: "5" }] }));
  assert.deepEqual(await faucetBalances(cfg, f.fetch, async () => {}), { xlm: 10, usdc: null });
  f = fake(response(404, {}));
  assert.deepEqual(await faucetBalances(cfg, f.fetch, async () => {}), { notFound: true });
  f = fake(response(503, {}), response(200, account("100")));
  assert.deepEqual(await faucetBalances(cfg, f.fetch, async () => {}), { xlm: 1999.9983371, usdc: 100 });
  f = fake(new Error("getaddrinfo ENOTFOUND"), new Error("getaddrinfo ENOTFOUND"));
  assert.deepEqual(await faucetBalances(cfg, f.fetch, async () => {}), { error: "getaddrinfo ENOTFOUND" });
  assert.equal(f.calls.length, 2);
});

test("USDC exchange: a read-only simulation of balance(exchange); the SDK may be missing", async () => {
  const cfg = { rpcUrl: "https://soroban-testnet.stellar.org", usdcIssuer: ISSUER, usdc: "CUSDC", exchange: "CEXCHANGE" };
  assert.equal((await exchangeBalance(cfg, async () => { throw new Error("Cannot find package"); })).sdkMissing, true);
  const calls = [];
  const sdk = (o = {}) => ({
    Networks: { TESTNET: "Test SDF Network ; September 2015" },
    BASE_FEE: "100",
    Account: class { constructor(id, seq) { calls.push(["account", id, seq]); } },
    Address: class { constructor(a) { this.a = a; } toScVal() { return `addr:${this.a}`; } },
    Contract: class { constructor(id) { this.id = id; } call(m, ...args) { calls.push(["call", this.id, m, ...args]); return "op"; } },
    TransactionBuilder: class {
      constructor(src, opts) { calls.push(["network", opts.networkPassphrase]); }
      addOperation() { return this; }
      setTimeout() { return this; }
      build() { return "tx"; }
    },
    rpc: {
      Server: class {
        async getNetwork() { return { passphrase: o.passphrase ?? "Test SDF Network ; September 2015" }; }
        async simulateTransaction(tx) { calls.push(["simulate", tx]); return o.sim ?? { result: { retval: "i128" } }; }
      },
      Api: { isSimulationError: (s) => !!s.error },
    },
    scValToNative: () => 29954693933n,
  });
  assert.deepEqual(await exchangeBalance(cfg, async () => sdk()), { usdc: 2995.4693933 });
  assert.deepEqual(calls, [
    ["account", ISSUER, "0"], ["network", "Test SDF Network ; September 2015"], ["call", "CUSDC", "balance", "addr:CEXCHANGE"], ["simulate", "tx"],
  ]);
  assert.match((await exchangeBalance(cfg, async () => sdk({ passphrase: "Public Global Stellar Network ; September 2015" }))).error, /not on testnet/);
  assert.match((await exchangeBalance(cfg, async () => sdk({ sim: { error: "HostError: contract missing" } }))).error, /simulation failed: HostError/);
});

test("telegram: not configured, sent, refused, and the token never in a log line", async () => {
  assert.deepEqual(await telegram("hi", {}, async () => assert.fail("no call")), { configured: false, sent: false });
  const errs = [];
  let body;
  const r = await telegram("hi", { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "42" }, async (url, o) => {
    body = JSON.parse(o.body);
    return response(200, {});
  });
  assert.deepEqual(r, { configured: true, sent: true });
  assert.deepEqual(body, { chat_id: "42", text: "hi", disable_web_page_preview: true });
  assert.deepEqual(await telegram("hi", { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "42" }, async () => response(401, {}), (s) => errs.push(s)), { configured: true, sent: false });
  await telegram("hi", { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "42" }, async () => { throw new Error(`fetch https://api.telegram.org/bot${TOKEN}/sendMessage failed`); }, (s) => errs.push(s));
  assert.equal(errs.length, 2);
  assert.ok(errs.every((s) => !s.includes(TOKEN)), errs.join("\n"));
  assert.equal(hideToken(`a ${TOKEN} b`, { TELEGRAM_BOT_TOKEN: TOKEN }), "a *** b");
});

test("state file: atomic write, a failure is logged and not thrown", () => {
  const dir = mkdtempSync(join(tmpdir(), "iora-monitor-w-"));
  try {
    const errs = [];
    assert.equal(writeJson(join(dir, "s.json"), { items: {} }, (s) => errs.push(s)), true);
    assert.deepEqual(readdirSync(dir), ["s.json"]);
    assert.equal(writeJson(join(dir, "no", "s.json"), {}, (s) => errs.push(s)), false);
    assert.equal(errs.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main: all fine -> exit 0, nothing sent, an empty state written", async () => {
  const w = world();
  try {
    healthy(w);
    assert.equal(await w.check(), 0);
    assert.deepEqual(w.sent, []);
    assert.deepEqual(w.out, ["OK: no problems"]);
    assert.deepEqual(w.state(), { items: {} });
    assert.equal(w.horizonCalls, 1);
  } finally {
    w.clean();
  }
});

test("main: an alarm is sent once, not repeated within the hour, then OK when it clears", async () => {
  const w = world();
  // the borrowers keep running; the price bot stopped at NOW - 20 min
  const at = (t, priceAt = NOW - 20 * MIN) => {
    healthy(w, t);
    w.status("price-bot", priceStatus(priceAt));
    return w.check(t);
  };
  try {
    assert.equal(await at(NOW), 1);
    assert.equal(w.sent.length, 1);
    assert.equal(w.sent[0].chat_id, "-100123");
    assert.match(w.texts()[0], /^\[Iora bots\] ALARM on test-host\nALARM price bot: the last run was 20 min ago/);
    assert.ok(w.err.some((s) => s.startsWith("[Iora bots] ALARM")), "the message also goes to the journal");
    // 5 and 55 minutes later: still broken, nothing new sent
    assert.equal(await at(NOW + 5 * MIN), 1);
    assert.equal(await at(NOW + 55 * MIN), 1);
    assert.equal(w.sent.length, 1);
    // an hour after the first message: told again
    assert.equal(await at(NOW + 61 * MIN), 1);
    assert.equal(w.sent.length, 2);
    assert.match(w.texts()[1], /the last run was 81 min ago/);
    // the bot runs again: one OK line
    assert.equal(await at(NOW + 66 * MIN, NOW + 64 * MIN), 0);
    assert.equal(w.texts()[2], "[Iora bots] recovered on test-host\nOK (was: price bot: no recent successful run)");
    assert.equal(await at(NOW + 71 * MIN, NOW + 70 * MIN), 0);
    assert.equal(w.sent.length, 3);
    // the token is in no output line
    assert.ok([...w.out, ...w.err].every((s) => !s.includes(TOKEN)));
  } finally {
    w.clean();
  }
});

test("main: every rule end to end (timer, failed service, pool, health factor, inventory, faucet, exchange)", async () => {
  const w = world();
  try {
    w.units["iora-blend-borrower-multi.timer"] = { LoadState: "loaded", ActiveState: "inactive", SubState: "dead", Result: "success", UnitFileState: "disabled" };
    w.units["iora-price-bot.service"] = { LoadState: "loaded", ActiveState: "failed", SubState: "failed", Result: "exit-code", UnitFileState: "static" };
    const off = [0.02, 0.021, 0.022].map((d, i) => ({ at: iso(NOW - (3 - i) * 2 * MIN), ok: false, dev: { XLM: d, iBTC: 0.001 } }));
    w.status("price-bot", priceStatus(NOW - 2 * MIN, {
      ok: false, failsInRow: 3, lastOkAt: iso(NOW - 8 * MIN), error: "1 of 6 pools failed: iETH: timeout", history: off,
      warnings: ["inventory low: 120.0000000 XLM = 15.29 USD (warn below 100 USD)"],
    }));
    w.status("borrower", borrowerStatus(NOW - 5 * MIN, { hf: 1.2, usdc: { debt: 300, collateralXlm: 5000 } }));
    w.status("borrower-multi", borrowerStatus(NOW - 5 * MIN, { hf: null }));
    w.horizon = () => response(200, account("1500", "20"));
    w.exchange = { usdc: 100 };
    assert.equal(await w.check(), 1);
    const text = w.texts()[0];
    for (const line of [
      "ALARM price bot: 3 runs in a row failed; last error: 1 of 6 pools failed: iETH: timeout",
      "ALARM price bot: pool XLM is +2.20% off the Reflector price, more than 1.00% for 3 runs in a row",
      "ALARM USDC borrower: health factor 1.200 is below 1.3",
      "ALARM multi-coin borrower: iora-blend-borrower-multi.timer is inactive",
      "LOW faucet GDWNS...SY47 holds 1,500 Circle USDC (warn below 2,000): top it up",
      "LOW faucet GDWNS...SY47 holds 20 XLM (warn below 50)",
      "LOW the USDC exchange CARNY...AKTT holds 100 Circle USDC (warn below 500)",
    ]) assert.ok(text.includes(line), `missing: ${line}\n${text}`);
    // the inventory warning of a failed run is not told (that run may have skipped pools)
    assert.ok(!text.includes("inventory low"), text);
  } finally {
    w.clean();
  }
});

test("main: Horizon not reachable is a soft notice after 10 minutes, not a bot alarm", async () => {
  const w = world();
  try {
    healthy(w);
    w.horizon = () => { throw new Error("connect ETIMEDOUT"); };
    assert.equal(await w.check(NOW), 0);
    assert.equal(await w.check(NOW + 5 * MIN), 0);
    assert.deepEqual(w.sent, []);
    assert.equal(await w.check(NOW + 10 * MIN), 0);
    assert.equal(w.texts()[0], "[Iora bots] WARNING on test-host\nNOTE the check cannot read the faucet account from Horizon (connect ETIMEDOUT); the faucet is not checked meanwhile");
    // a low faucet that was told before stays as it was while Horizon is down (no false OK)
    w.horizon = () => response(200, account("10"));
    await w.check(NOW + 20 * MIN);
    assert.match(w.texts().at(-1), /LOW faucet .* holds 10 Circle USDC/);
    w.horizon = () => { throw new Error("connect ETIMEDOUT"); };
    await w.check(NOW + 25 * MIN);
    assert.ok(!w.texts().some((t) => t.includes("OK (was: faucet")), w.texts().join("\n---\n"));
    assert.ok(w.state().items["faucet:usdc"].present);
  } finally {
    w.clean();
  }
});

test("main: Telegram down -> the message is tried again on the next run", async () => {
  const w = world();
  try {
    healthy(w);
    w.status("borrower", borrowerStatus(NOW - 50 * MIN));
    w.telegramStatus = 502;
    assert.equal(await w.check(NOW), 1);
    w.telegramStatus = 200;
    assert.equal(await w.check(NOW + 5 * MIN), 1);
    assert.equal(w.sent.length, 2);
    assert.equal(w.texts()[0], w.texts()[1].replace("55 min", "50 min"));
    assert.ok(w.err.some((s) => s === "telegram: HTTP 502"));
  } finally {
    w.clean();
  }
});

test("main: without systemctl the unit checks are skipped; without Telegram the message goes to the journal", async () => {
  const w = world();
  try {
    healthy(w);
    for (const u of ["iora-price-bot.timer", "iora-blend-borrower.timer", "iora-blend-borrower-multi.timer"]) {
      w.units[u] = Object.assign(new Error("spawn systemctl ENOENT"), { code: "ENOENT" });
    }
    w.status("borrower-multi", borrowerStatus(NOW - 2 * MIN, { hf: 1.1 }));
    assert.equal(await w.check(NOW, { TELEGRAM_BOT_TOKEN: "" }), 1);
    assert.deepEqual(w.sent, []);
    assert.ok(w.out.includes("note: systemctl not found: timers and services are not checked"));
    assert.ok(w.err.some((s) => s.includes("ALARM multi-coin borrower: health factor 1.100")));
    assert.ok(w.err.some((s) => s.includes("went to the journal only")));
  } finally {
    w.clean();
  }
});

test("main: a run that finishes while systemd is read does not give a false 'failed' alarm", async () => {
  const w = world();
  try {
    healthy(w);
    // systemd still shows the last (failed, recorded) run as failed; a good run ends while the check reads it
    w.units["iora-price-bot.service"] = { LoadState: "loaded", ActiveState: "failed", SubState: "failed", Result: "exit-code", UnitFileState: "static" };
    w.status("price-bot", priceStatus(NOW - 3 * MIN, { ok: false, failsInRow: 1, lastOkAt: iso(NOW - 5 * MIN), error: "x" }));
    w.onSystemctl = (unit) => {
      if (unit === "iora-price-bot.service") w.status("price-bot", priceStatus(NOW - 1000));
    };
    assert.equal(await w.check(), 0);
    assert.deepEqual(w.sent, []);
    // without the race, the same picture is a real alarm: failed, but the status says the last run was fine
    w.onSystemctl = null;
    assert.equal(await w.check(NOW + 5 * MIN), 1);
    assert.match(w.texts()[0], /price bot: the last run failed before it could write its status/);
  } finally {
    w.clean();
  }
});

test("main: a new install: missing status files wait for the bots' first runs", async () => {
  const w = world();
  try {
    w.status("price-bot", priceStatus(NOW - 1 * MIN));
    assert.equal(await w.check(NOW), 0); // the borrowers have not run yet
    assert.ok(w.out[0].includes("WAIT USDC borrower: no status file"));
    w.status("borrower", borrowerStatus(NOW + 8 * MIN));
    w.status("borrower-multi", borrowerStatus(NOW + 9 * MIN, { hf: null }));
    assert.equal(await w.check(NOW + 10 * MIN), 0);
    assert.deepEqual(w.sent, []);
    // one that never comes is told after its age limit (45 min for a borrower)
    rmSync(join(w.dir, "borrower.json"));
    w.status("price-bot", priceStatus(NOW + 14 * MIN));
    assert.equal(await w.check(NOW + 15 * MIN), 0);
    w.status("price-bot", priceStatus(NOW + 58 * MIN));
    w.status("borrower-multi", borrowerStatus(NOW + 58 * MIN, { hf: null }));
    assert.equal(await w.check(NOW + 59 * MIN), 0);
    assert.deepEqual(w.sent, []);
    w.status("price-bot", priceStatus(NOW + 60 * MIN));
    assert.equal(await w.check(NOW + 61 * MIN), 1);
    assert.equal(w.texts()[0], `[Iora bots] ALARM on test-host\nALARM USDC borrower: no status file ${join(w.dir, "borrower.json")} (no run has finished since the unit got StateDirectory=)`);
  } finally {
    w.clean();
  }
});

test("the check itself failing is told at most once an hour", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iora-monitor-c-"));
  try {
    const sent = [];
    const deps = { fetch: async (u, o) => { sent.push(JSON.parse(o.body).text); return response(200, {}); }, host: "h", err: () => {} };
    const env = { MONITOR_STATE_FILE: join(dir, "state.json"), TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "1" };
    assert.equal(await reportCrash(new Error("MIN_HF=abc is not a number >= 0"), { env, now: NOW, deps }), true);
    assert.equal(await reportCrash(new Error("again"), { env, now: NOW + 30 * MIN, deps }), false);
    assert.equal(await reportCrash(new Error("later"), { env, now: NOW + 61 * MIN, deps }), true);
    assert.deepEqual(sent, ["[Iora bots] the bots check itself failed on h: MIN_HF=abc is not a number >= 0", "[Iora bots] the bots check itself failed on h: later"]);
    assert.ok(existsSync(join(dir, "state.json.crash")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-bots.js as a command: exit 0 with nothing to check, exit 2 on a bad setting (no network)", () => {
  const dir = mkdtempSync(join(tmpdir(), "iora-monitor-cli-"));
  try {
    const base = { PATH: process.env.PATH, SYSTEMD: "off", BOTS: "", FAUCET_ADDRESS: "", USDC_EXCHANGE: "", MONITOR_STATE_FILE: join(dir, "state.json") };
    const cli = join(HERE, "..", "check-bots.js");
    let r = spawnSync(process.execPath, [cli], { env: base, encoding: "utf8", timeout: 30000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OK: no problems/);
    assert.ok(existsSync(join(dir, "state.json")));
    r = spawnSync(process.execPath, [cli], { env: { ...base, MIN_HF: "abc" }, encoding: "utf8", timeout: 30000 });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /the bots check failed: Error: MIN_HF=abc is not a number/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
