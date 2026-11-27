import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import crypto from "node:crypto";

const lib = createRequire(import.meta.url)("../api/_faucet-lib.cjs");
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const H = 3600 * 1000;

test("address validation checks format and checksum", () => {
  assert.equal(lib.validAddress(ISSUER), true);
  assert.equal(lib.validAddress("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"), true);
  assert.equal(lib.validAddress(ISSUER.slice(0, 55) + (ISSUER[55] === "A" ? "B" : "A")), false); // checksum
  assert.equal(lib.validAddress("CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"), false); // contract
  assert.equal(lib.validAddress("SBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"), false);
  assert.equal(lib.validAddress(ISSUER.toLowerCase()), false);
  assert.equal(lib.validAddress(""), false);
  assert.equal(lib.validAddress(null), false);
});

test("amount: default 100, from the env, rejected when invalid", () => {
  assert.equal(lib.faucetAmount({}), "100");
  assert.equal(lib.faucetAmount({ FAUCET_USDC_AMOUNT: "" }), "100");
  assert.equal(lib.faucetAmount({ FAUCET_USDC_AMOUNT: "25.5" }), "25.5");
  assert.equal(lib.faucetAmount({ FAUCET_USDC_AMOUNT: "10000" }), "10000");
  for (const bad of ["0", "-1", "abc", "1.12345678", "10000.0000001", "1e3"]) assert.throws(() => lib.faucetAmount({ FAUCET_USDC_AMOUNT: bad }), bad);
});

test("trustline state", () => {
  const tl = (balance, limit, extra = {}) => [{ asset_type: "native", balance: "50" }, { asset_code: "USDC", asset_issuer: ISSUER, balance, limit, ...extra }];
  assert.equal(lib.trustlineState([{ asset_type: "native", balance: "50" }], "USDC", ISSUER, "100"), "missing");
  assert.equal(lib.trustlineState([{ asset_code: "USDC", asset_issuer: "GOTHER", balance: "0", limit: "922337203685.4775807" }], "USDC", ISSUER, "100"), "missing");
  assert.equal(lib.trustlineState(tl("0.0000000", "922337203685.4775807"), "USDC", ISSUER, "100"), "ok");
  assert.equal(lib.trustlineState(tl("950", "1000"), "USDC", ISSUER, "100"), "full");
  assert.equal(lib.trustlineState(tl("0", "1000", { is_authorized: false }), "USDC", ISSUER, "100"), "unauthorized");
});

test("faucet balance check", () => {
  const f = (usdc, xlm) => [{ asset_type: "native", balance: xlm }, { asset_code: "USDC", asset_issuer: ISSUER, balance: usdc, limit: "1000000" }];
  assert.equal(lib.faucetShort(f("500", "100"), "USDC", ISSUER, "100"), null);
  assert.equal(lib.faucetShort(f("99.9999999", "100"), "USDC", ISSUER, "100"), "usdc");
  assert.equal(lib.faucetShort(f("500", "1.5"), "USDC", ISSUER, "100"), "xlm");
  assert.equal(lib.faucetShort([], "USDC", ISSUER, "100"), "usdc");
});

test("wallet limit: once per 24 hours", () => {
  const now = 1_000_000_000_000;
  assert.equal(lib.walletWait(null, now), 0);
  assert.equal(lib.walletWait({ at: now - 23 * H }, now), H);
  assert.equal(lib.walletWait({ at: now - 24 * H }, now), 0);
});

test("IP limit: three per 24 hours, sliding window", () => {
  const now = 1_000_000_000_000;
  let rec = null;
  for (let i = 0; i < 3; i++) {
    assert.equal(lib.ipWait(rec, now + i), 0);
    rec = lib.nextIp(rec, now + i);
  }
  assert.equal(lib.ipWait(rec, now + 3), 24 * H - 3);
  assert.equal(lib.ipWait(rec, now + 24 * H), 0); // the first one has aged out
  assert.equal(lib.nextIp({ times: [now - 25 * H, now - H] }, now).times.length, 2); // old entries are dropped
});

test("IP key is a hash, not the address", () => {
  const k = lib.ipKey("203.0.113.7");
  assert.match(k, /^[0-9a-f]{32}$/);
  assert.equal(k, lib.ipKey("203.0.113.7"));
  assert.notEqual(k, lib.ipKey("203.0.113.8"));
  assert.equal(lib.clientIp({ headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } }), "203.0.113.7");
});

test("access ticket: same format as api/access.js; wallet tickets only for their wallet", () => {
  const secret = "test-secret";
  const mk = (sub, exp) => {
    const p = Buffer.from(JSON.stringify({ sub, exp })).toString("base64url");
    return `${p}.${crypto.createHmac("sha256", secret).update(p).digest("base64url")}`;
  };
  const now = Date.now();
  assert.equal(lib.verifyTicket(mk("code", now + H), secret, now), "code");
  assert.equal(lib.verifyTicket(mk("code", now - 1), secret, now), null);
  assert.equal(lib.verifyTicket(mk("code", now + H), "other", now), null);
  assert.equal(lib.verifyTicket(mk("code", now + H), "", now), null);
  assert.equal(lib.verifyTicket("garbage", secret, now), null);
  assert.equal(lib.ticketAllows("code", ISSUER), true);
  assert.equal(lib.ticketAllows(ISSUER, ISSUER), true);
  assert.equal(lib.ticketAllows("GOTHER", ISSUER), false);
});
