// The oracle price band: a pool whose price is far from the oracle's is not used (fill_via legs, the vault's own
// route, the price board and its quick quote), crosses stay inside the band, the reference pool is preferred.
// The pure math from lib.js, then keeper.js's real code in a sandbox with fake pools and a fake oracle. No network.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Address, Keypair, StrKey, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import * as lib from "../lib.js";
import { bandCheck, crossBand, oracleRate, preferQuote, shownPrice } from "../lib.js";

describe("band math", () => {
  test("the oracle rate from two prices (their decimals cancel) and the tokens' decimals", () => {
    assert.equal(oracleRate(1_270_000n, 10_000_000n), 0.127); // XLM in USDC
    assert.ok(Math.abs(oracleRate(10_000_000n, 1_270_000n) - 7.874) < 0.001); // USDC in XLM
    assert.equal(oracleRate(2n, 1n, 6, 7), 20); // a 6-decimal coin worth 2 of a 7-decimal one: 20 raw units each
    assert.equal(oracleRate(0n, 1n), null);
    assert.equal(oracleRate(1n, null), null);
  });

  test("the deviation is symmetric: 0.60 vs 0.127 is 372% whichever way the pair is written", () => {
    const sell = bandCheck(10_000_000n, 6_000_000n, 0.127, 500); // 1 XLM -> 0.60 USDC
    assert.equal(sell.ok, false);
    assert.equal(Math.round(sell.devBps / 100), 372);
    const buy = bandCheck(6_000_000n, 10_000_000n, 1 / 0.127, 500); // 0.60 USDC -> 1 XLM
    assert.equal(buy.devBps, sell.devBps);
    assert.equal(bandCheck(10_000_000n, 1_300_000n, 0.127, 500).ok, true); // 2.4% off
    assert.equal(bandCheck(10_000_000n, 1_340_000n, 0.127, 500).ok, false); // 5.5% off
    assert.equal(bandCheck(0n, 1n, 0.127, 500).ok, false);
  });

  test("the price in a log line: the coin in USDC whichever side USDC is on", () => {
    assert.ok(Math.abs(shownPrice(1 / 0.6, true) - 0.6) < 1e-12); // USDC -> XLM quote, shown as XLM in USDC
    assert.equal(shownPrice(0.6, false), 0.6);
  });

  test("a cross stays inside the band; limits that only meet outside it give no cross", () => {
    const p = 78_740_157n; // 7.874 XLM per USDC, scaled 1e7
    const r = crossBand(50_000_000n, 100_000_000n, p, 500);
    assert.equal(r.p, p);
    assert.ok(r.lo >= 74_990_000n && r.hi <= 82_680_000n);
    assert.equal(crossBand(50_000_000n, 60_000_000n, p, 500), null);
    // the overlap reaches into the band only at one end: the price is the nearest point of the band
    const edge = crossBand(50_000_000n, 76_000_000n, p, 500);
    assert.equal(edge.p, 76_000_000n);
  });

  test("the reference pool is preferred while it pays at most preferBps less", () => {
    const qs = [
      ["Soroswap", 10_000n],
      ["Aquarius ab12 ref", 9_980n],
    ];
    assert.equal(preferQuote(qs, "Aquarius ab12 ref", 25).label, "Aquarius ab12 ref"); // 20 bps less
    assert.equal(preferQuote(qs, "Aquarius ab12 ref", 10).label, "Soroswap");
    assert.equal(preferQuote(qs, null, 25).label, "Soroswap");
    assert.equal(preferQuote([["Aquarius ab12 ref", null], ["Soroswap", 5n]], "Aquarius ab12 ref", 25).label, "Soroswap");
  });
});

// ----- keeper.js in a sandbox -----
const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "keeper.js"), "utf8").replace(/\r\n/g, "\n");
const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, `keeper.js: ${from.slice(0, 40)}`);
  return src.slice(a, b);
};
const code = [
  cut("const oracleCache = new Map();", "const quote = (amount, tin, tout)"),
  cut("async function bestRoute(", "const minOut ="),
  cut("async function venueEst(", "/**\n * Every pool"),
  cut("async function sourcesFor(", "/**\n * Spreads"),
  cut("// ----- price board -----\nfunction boardSummary", "// pair + fill size class"),
  cut("function priceNoteFor(", "async function tryOrder("),
  cut("/** A fill size the contract accepts", "/** The failure-guard key"),
]
  .join("\n")
  .replace(/^(const|let) (\w+) = /gm, "var $2 = ");

const cid = () => StrKey.encodeContract(crypto.randomBytes(32));
const USDC = cid();
const XLM = cid();
const BTC = cid();
const ORACLE = cid();
const ROUTER = cid();
const REF_ADDR = cid();
const E14 = 100_000_000_000_000;

/**
 * pools: { soroswap: price of XLM in USDC | null, aquarius: [[id, address, price], ...] }; oracle: { token: $ price
 * | null }; the rates are applied both ways with no fee, so a quote's implied price is exactly the pool's price.
 */
function sandbox({ soroswap = 0.6, aquarius = [["ab12", cid(), 0.37]], oracle = { [USDC]: 1, [XLM]: 0.127 }, oracleAgeSec = 30, ref = null, require = true, maxBps = 500, oracleDown = false } = {}) {
  const logs = [];
  const writes = [];
  const reads = [];
  // changed by a test while it runs: the oracle's prices, per-token ages, and whether it answers at all
  const net = { oracleDown, ages: {} };
  const xlmIn = (price, tin, a) => (tin === USDC ? (BigInt(a) * 10_000n) / BigInt(Math.round(price * 10_000)) : (BigInt(a) * BigInt(Math.round(price * 10_000))) / 10_000n);
  const read = async (contract, method, args = []) => {
    reads.push(`${method}`);
    if (contract === ORACLE && method === "decimals") return { ok: true, value: 14 };
    if (contract === ORACLE && method === "lastprice") {
      if (net.oracleDown) return { ok: false, error: "HostError: oracle down" };
      const [, token] = scValToNative(args[0]);
      const ageSec = net.ages[token] ?? oracleAgeSec;
      const p = oracle[token];
      if (p === null || p === undefined) return { ok: true, value: undefined };
      return { ok: true, value: { price: BigInt(Math.round(p * E14)), timestamp: BigInt(Math.floor(Date.now() / 1000) - ageSec) } };
    }
    if (method === "decimals") return { ok: true, value: 7 };
    if (contract === ROUTER && method === "router_get_amounts_out") {
      const amount = scValToNative(args[0]);
      const p = scValToNative(args[1]);
      if (soroswap === null) return { ok: false };
      return { ok: true, value: [amount, xlmIn(soroswap, p[0], amount)] };
    }
    return { ok: false };
  };
  const aqua = {
    name: "Aquarius",
    options: async () => aquarius.map(([id, address]) => ({ id, address, hash: Buffer.alloc(32) })),
    quote: async (opt, tin, tout, a) => xlmIn(aquarius.find(([id]) => id === opt.id)[2], tin, a),
    call: async (user, opt, tin, tout, a, lim) => ({ contract: "AQUA", func: "swap", args: [opt.id, a, lim.min] }),
  };
  const ctx = vm.createContext({
    ...lib,
    Address,
    xdr,
    Date,
    Math,
    Number,
    BigInt,
    Promise,
    Map,
    Set,
    USDC,
    XLM,
    ROUTER,
    PRICE_ORACLE: ORACLE,
    BAND_ON: maxBps > 0,
    VENUE_MAX_DEVIATION_BPS: maxBps,
    VENUE_REQUIRE_ORACLE: require,
    ORACLE_MAX_AGE_SEC: 600,
    ORACLE_FALLBACK_SEC: 1800,
    STABLE_TOKENS: new Set(),
    REF_RATE_MAX_SEC: 300,
    REF_POOL: ref || "",
    REF_VENUE: ref ? "aquarius" : "",
    REF_PREFER_BPS: 25,
    refSeen: false,
    SCALE: 10_000_000n,
    SYM: { [USDC]: "USDC", [XLM]: "XLM", [BTC]: "BTC" },
    sym: (a) => ({ [USDC]: "USDC", [XLM]: "XLM", [BTC]: "BTC" })[a] || a.slice(0, 4),
    short: (a) => String(a).slice(0, 4),
    fmt: (v) => (Number(BigInt(v)) / 1e7).toFixed(4),
    log: (l) => logs.push(l),
    read,
    i128: (n) => nativeToScVal(BigInt(n), { type: "i128" }),
    u32: (n) => nativeToScVal(n, { type: "u32" }),
    addrVec: (list) => xdr.ScVal.scvVec(list.map((a) => new Address(a).toScVal())),
    rpcLabelCtx: { run: (l, f) => f() },
    low: (f) => f(),
    background: (f) => f(),
    pathOf: (tin, tout, via) => (via ? [tin, via, tout] : [tin, tout]),
    poolOf: async () => (soroswap === null ? null : { pair: cid() }),
    soroStep: async (tin, tout, pair, a, min) => ({ label: "Soroswap", a, min }),
    venueList: () => [aqua],
    venueTemplate: async () => [],
    venueAuths: () => [],
    callVal: (contract, func, args) => ({ contract, func, args }),
    FILLER: cid(),
    VENUES: true,
    VENUE_REF: 100_000_000n,
    venueSpot: new Map(),
    venueState: { offUntil: 0 },
    MARKET_TOKENS: [],
    PAIR_TOKENS: [],
    allowedTokens: new Set(),
    FACTORIES: [],
    BOARD_ON: true,
    BOARD_QUICK: true,
    BOARD_REF_USDC: 20,
    BOARD_FAST_MULT: 5,
    BOARD_MAX_AGE_SEC: 90,
    BOARD_COLD_LEDGERS: 24,
    BOARD_MAX_QUOTES: 10,
    SLIPPAGE_BPS: 50,
    lastLedger: 1000,
    latestCache: { seq: 1000 },
    book: new Map(),
    pairOf: new Map(),
    proximity: { checked: new Set(), far: new Set() },
    // crosses
    minOut: (fill, limit) => (fill * 10_000_000n + limit - 1n) / limit,
    minFillFor: () => 1n,
    quote: async () => null, // no pool quote for the cross: the oracle price (in the band) is the start
    write: async (vault, func, args) => {
      writes.push(args.map((a) => scValToNative(a)));
      return { ok: true, fee: null, hash: "h" };
    },
    dirty: new Set(),
    stats: { fills: 0, feesStroop: 0n },
    crossFills: 0,
    crossedNow: new Set(),
    stuck: new Map(),
    failGuard: { clear() {} },
    notify: async () => {},
    kp: Keypair.random(),
    crossKey: (a, b) => `${a.key}|${b.key}`,
  });
  vm.runInContext(code, ctx);
  return { ctx, logs, writes, reads, net, oracle };
}

describe("price band in keeper.js (sandbox)", () => {
  test("both pools far from the oracle: no quote either way, the log says why", async () => {
    const { ctx, logs } = sandbox();
    assert.equal(await ctx.quotePath(100_000_000n, [USDC, XLM]), null); // buy: USDC -> XLM
    assert.equal(await ctx.quotePath(100_000_000n, [XLM, USDC]), null); // sell: XLM -> USDC
    const line = logs.find((l) => l.includes("venue Soroswap skipped"));
    assert.ok(line, logs.join("\n"));
    assert.match(line, /price 0\.600 is 372% off the oracle 0\.127 \(XLM in USDC; band 5\.0%\)/);
    const sources = await ctx.sourcesFor(XLM, USDC);
    assert.deepEqual(await Promise.all(sources.map((s) => s.quote(100_000_000n))), [null, null]);
    assert.ok(logs.some((l) => /venue Aquarius skipped: price 0\.370 is 191% off/.test(l)), logs.join("\n"));
  });

  test("every venue outside the band: the vault's route, the board and the quick quote give nothing; the order waits with the reason", async () => {
    const { ctx } = sandbox();
    assert.equal(await ctx.bestRoute(100_000_000n, USDC, XLM, [null]), null); // the vault's own route (execute)
    assert.equal(await ctx.venueEst(100_000_000n, USDC, XLM), null);
    await ctx.refreshBoard(USDC, XLM);
    assert.equal(ctx.board.get(`${USDC}|${XLM}`).best, null);
    assert.equal(await ctx.boardRoute(100_000_000n, USDC, XLM, 0n), null);
    assert.match(ctx.priceNoteFor(USDC, XLM, 100_000_000n, 0n, 1n), /^no pool within the oracle band: venue .* skipped/);
  });

  test("a pool inside the band is used; pools outside it are left out of the same route", async () => {
    const { ctx } = sandbox({ aquarius: [["ab12", cid(), 0.37], ["cd34", cid(), 0.129]] });
    const r = await ctx.boardRoute(100_000_000n, USDC, XLM, 0n); // 10 USDC, quick quote
    assert.equal(r.text, "Aquarius cd34 (price board, quick quote)");
    const sell = await ctx.boardRoute(100_000_000n, XLM, USDC, 0n); // 10 XLM
    assert.equal(sell.text, "Aquarius cd34 (price board, quick quote)");
    assert.equal(sell.q, 12_900_000n); // 10 XLM at 0.129
  });

  test("the reference pool is marked, put first and preferred on the board while it pays at most 25 bps less", async () => {
    const { ctx, logs } = sandbox({ soroswap: 0.1272, aquarius: [["ab12", cid(), 0.37], ["ef56", REF_ADDR, 0.1270]], ref: REF_ADDR });
    const sources = await ctx.sourcesFor(XLM, USDC);
    assert.equal(sources[0].label, "Aquarius ef56 ref");
    assert.ok(logs.some((l) => l.includes(`reference pool ${REF_ADDR} found`)));
    await ctx.refreshBoard(XLM, USDC);
    assert.equal(ctx.board.get(`${XLM}|${USDC}`), undefined); // XLM -> USDC needs the USDC -> XLM entry for its amount
    await ctx.refreshBoard(USDC, XLM);
    await ctx.refreshBoard(XLM, USDC);
    assert.equal(ctx.board.get(`${XLM}|${USDC}`).best.label, "Aquarius ef56 ref"); // 0.1270 vs Soroswap 0.1272: 16 bps less
  });

  test("no reference price at all: the pair is closed (no fill), logged and in status; VENUE_REQUIRE_ORACLE=0: the old behaviour", async () => {
    const closed = sandbox({ oracle: { [USDC]: 1, [XLM]: null } });
    assert.equal(await closed.ctx.quotePath(100_000_000n, [XLM, USDC]), null);
    assert.match(closed.ctx.priceNoteFor(XLM, USDC, 1n, null, 1n), /no fill: no reference price for the oracle band \(XLM: the oracle has no price for it/);
    assert.ok(closed.logs.some((l) => /price band: XLM->USDC closed: no fill: no reference price/.test(l)), closed.logs.join("\n"));
    assert.deepEqual(Object.keys(closed.ctx.bandSummary().closed_pairs), ["XLM->USDC"]);
    const old = sandbox({ oracle: { [USDC]: 1, [XLM]: null }, require: false });
    assert.equal(await old.ctx.quotePath(100_000_000n, [XLM, USDC]), 60_000_000n); // 10 XLM at 0.60
    assert.ok(old.logs.some((l) => /oracle price band off for XLM->USDC: XLM: the oracle has no price/.test(l)));
  });

  test("the oracle has no USDC price (2026-11-27 21:49): USDC counts as 1.0 and the band stays on", async () => {
    const { ctx, logs } = sandbox({ oracle: { [USDC]: null, [XLM]: 0.127 } });
    assert.equal(await ctx.quotePath(100_000_000n, [USDC, XLM]), null); // Soroswap 0.60 is still kept out
    assert.equal(await ctx.quotePath(100_000_000n, [XLM, USDC]), null);
    assert.ok(logs.some((l) => /venue Soroswap skipped: price 0\.600 is 372% off the oracle 0\.127/.test(l)), logs.join("\n"));
    assert.ok(!logs.some((l) => /band off/.test(l)), logs.join("\n"));
    assert.equal(ctx.bandSummary().reference.USDC, "stablecoin 1.0");
    // a pool at the real price is still used
    const ok = sandbox({ soroswap: 0.128, aquarius: [], oracle: { [USDC]: null, [XLM]: 0.127 } });
    assert.equal(await ok.ctx.quotePath(100_000_000n, [XLM, USDC]), 1_280_000n * 10n);
  });

  test("the oracle stops answering: the last price it gave (up to 30 min) keeps the band on", async () => {
    const { ctx, logs, net } = sandbox();
    assert.equal(await ctx.quotePath(100_000_000n, [XLM, USDC]), null); // fresh oracle: Soroswap is out
    net.oracleDown = true;
    ctx.oracleCache.clear(); // a minute later: the cache is stale, the oracle does not answer
    assert.equal(await ctx.quotePath(100_000_000n, [XLM, USDC]), null);
    assert.equal(ctx.bandSummary().reference.XLM, "oracle price 1 min old");
    assert.ok(logs.some((l) => /no fresh oracle price for both coins; the band uses XLM: oracle price 1 min old, USDC: stablecoin 1\.0/.test(l)), logs.join("\n"));
  });

  test("an oracle price 20 min old is still a reference; 60 min old is none (closed)", async () => {
    const recent = sandbox({ oracleAgeSec: 1200 });
    assert.equal(await recent.ctx.quotePath(100_000_000n, [XLM, USDC]), null); // Soroswap 0.60 out, against 0.127
    assert.ok(recent.logs.some((l) => /Soroswap skipped: price 0\.600 is 372% off the oracle 0\.127 .*reference: XLM: oracle price 20 min old/.test(l)), recent.logs.join("\n"));
    const old = sandbox({ oracleAgeSec: 3600 });
    assert.equal(await old.ctx.quotePath(100_000_000n, [XLM, USDC]), null);
    assert.match(old.ctx.priceNoteFor(XLM, USDC, 1n, null, 1n), /no reference price .*XLM: the oracle price is 60 min old/);
  });

  test("no oracle price for the coin: the reference pool's own price is the reference", async () => {
    const { ctx, logs } = sandbox({ soroswap: 0.6, aquarius: [["ef56", REF_ADDR, 0.127]], ref: REF_ADDR, oracle: { [USDC]: 1, [XLM]: null } });
    const sources = await ctx.sourcesFor(XLM, USDC);
    assert.equal(sources[0].label, "Aquarius ref");
    const ref = await sources[0].quote(100_000_000n);
    const soro = await sources[1].quote(100_000_000n);
    assert.equal(ref, 1_270_000n * 10n); // the reference pool itself
    assert.equal(soro, null); // Soroswap 0.60 against the reference pool's 0.127
    assert.ok(logs.some((l) => /the band uses the reference pool's price/.test(l)), logs.join("\n"));
  });

  test("oracle prices are read once a minute, not on every quote", async () => {
    const { ctx, reads } = sandbox();
    for (let i = 0; i < 5; i++) await ctx.quotePath(100_000_000n, [XLM, USDC]);
    assert.equal(reads.filter((r) => r === "lastprice").length, 2); // XLM and USDC
  });

  test("a cross at the oracle price, inside the band; limits that meet only outside it: no cross", async () => {
    const { ctx, writes } = sandbox();
    const order = (vault, id, tin, tout, remaining, limit) => ({ vault, o: { id }, key: `${vault}:${id}`, tin, tout, remaining, limit, minFill: 1n, fees: {} });
    // a sells XLM for USDC paying at most 10 XLM per USDC; b sells USDC for XLM paying at most 0.2 USDC per XLM
    const a = order(cid(), 1, XLM, USDC, 1_000_000_000n, 100_000_000n);
    const b = order(cid(), 2, USDC, XLM, 200_000_000n, 2_000_000n);
    assert.equal(await ctx.tryCross(a, b), "crossed");
    const [, , x, , , y] = writes[0];
    const xlmPerUsdc = Number(x) / Number(y);
    assert.ok(Math.abs(xlmPerUsdc / 7.874 - 1) < 0.001, `cross at ${xlmPerUsdc} XLM per USDC`);
    // limits [5, 6] XLM per USDC: the oracle's 7.87 is more than 5% away from all of them
    const a2 = order(cid(), 3, XLM, USDC, 1_000_000_000n, 60_000_000n);
    assert.equal(await ctx.tryCross(a2, b), "no");
    assert.equal(writes.length, 1);
  });

  test("a cross without any reference price: none (fail-closed); VENUE_REQUIRE_ORACLE=0: the middle of the limits as before", async () => {
    const order = (vault, id, tin, tout, remaining, limit) => ({ vault, o: { id }, key: `${vault}:${id}`, tin, tout, remaining, limit, minFill: 1n, fees: {} });
    const a = order(cid(), 1, XLM, USDC, 1_000_000_000n, 60_000_000n);
    const b = order(cid(), 2, USDC, XLM, 200_000_000n, 2_000_000n);
    const off = sandbox({ oracle: { [USDC]: 1, [XLM]: null }, require: false });
    assert.equal(await off.ctx.tryCross(a, b), "crossed");
    const req = sandbox({ oracle: { [USDC]: 1, [XLM]: null } });
    assert.equal(await req.ctx.tryCross(a, b), "no");
    assert.deepEqual(Object.keys(req.ctx.bandSummary().closed_pairs), ["XLM->USDC"]);
  });
});
