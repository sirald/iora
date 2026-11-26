import { test } from "node:test";
import assert from "node:assert/strict";
import { makeQuote, minOut, quoteMismatch, routeProblem } from "../src/swap-quote.js";

const XLM = "CXLM", USDC = "CUSDC", ME = "GME";
const base = { sell: XLM, buy: USDC, dir: "xu", amount: 100_000_000n, out: 12_000_000n, slip: 1, route: { name: "Soroswap" }, wallet: ME, requestId: 7 };
const screen = (o = {}) => ({ sell: XLM, buy: USDC, dir: "xu", amount: 100_000_000n, slip: 1, wallet: ME, requestId: 7, ...o });

test("minOut rounds down by the slippage", () => {
  assert.equal(minOut(12_000_000n, 1), 11_880_000n);
  assert.equal(minOut(1000n, 0.5), 995n);
});

test("the quote is immutable and carries its own minimum", () => {
  const q = makeQuote(base);
  assert.ok(Object.isFrozen(q) && Object.isFrozen(q.route));
  assert.equal(q.minOut, 11_880_000n);
  assert.throws(() => {
    "use strict";
    q.minOut = 1n;
  });
});

test("IORA-01: a direction change while the quote loads blocks signing", () => {
  const q = makeQuote(base);
  assert.equal(quoteMismatch(q, screen()), null);
  // the auditor's scenario: Sell 10 XLM, then the Buy side is opened while the read is pending
  assert.equal(quoteMismatch(q, screen({ dir: "ux", sell: USDC, buy: XLM })), "the direction changed");
});

test("IORA-01: amount, slippage, wallet or a newer request block signing", () => {
  const q = makeQuote(base);
  assert.equal(quoteMismatch(q, screen({ amount: 200_000_000n })), "the amount changed");
  assert.equal(quoteMismatch(q, screen({ amount: null })), "the amount changed");
  assert.equal(quoteMismatch(q, screen({ slip: 0.5 })), "the slippage changed");
  assert.equal(quoteMismatch(q, screen({ wallet: "GOTHER" })), "the wallet changed");
  assert.equal(quoteMismatch(q, screen({ requestId: 8 })), "a newer quote was requested");
  assert.equal(quoteMismatch(null, screen()), "no quote");
});

test("IORA-01: single-venue routes", () => {
  assert.equal(routeProblem(makeQuote(base)), null);
  assert.equal(routeProblem(makeQuote({ ...base, route: { name: "Aquarius", hash: new Uint8Array(32) } })), null);
  assert.equal(routeProblem(makeQuote({ ...base, route: { name: "Aquarius" } })), "no Aquarius pool");
  assert.equal(routeProblem(makeQuote({ ...base, route: null })), "no route");
  assert.equal(routeProblem(makeQuote({ ...base, route: { name: "Other" } })), "unknown route");
  assert.equal(routeProblem(makeQuote({ ...base, buy: XLM })), "same token");
  assert.equal(routeProblem(makeQuote({ ...base, out: 0n })), "bad minimum");
});

test("IORA-01: split routes must add up to the quoted amount", () => {
  const split = (amounts) => makeQuote({ ...base, route: { name: "split", text: "x", parts: amounts.map((amount) => ({ src: {}, amount })) } });
  assert.equal(routeProblem(split([60_000_000n, 40_000_000n])), null);
  assert.equal(routeProblem(split([60_000_000n, 30_000_000n])), "split parts do not add up to the amount");
  assert.equal(routeProblem(split([100_000_000n])), "split needs two pools");
  assert.equal(routeProblem(split([100_000_000n, 0n])), "empty split part");
  assert.ok(Object.isFrozen(split([60_000_000n, 40_000_000n]).route.parts[0]));
});
