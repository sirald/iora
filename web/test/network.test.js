import { test } from "node:test";
import assert from "node:assert/strict";
import { FUTURENET, PUBLIC, TESTNET, capabilityOf, createNetWait, mustCheck, networkName, networkState, noSwitchIds } from "../src/network.js";

test("network comparison: passphrase first, then the name; no answer is never 'wrong'", () => {
  assert.equal(networkState({ network: "TESTNET", networkPassphrase: TESTNET }), "ok");
  assert.equal(networkState({ network: "PUBLIC", networkPassphrase: PUBLIC }), "wrong");
  assert.equal(networkState({ networkPassphrase: FUTURENET }), "wrong");
  assert.equal(networkState({ network: "TESTNET" }), "ok");
  assert.equal(networkState({ network: "PUBLIC" }), "wrong");
  assert.equal(networkState({ network: "testnet" }), "ok");
  assert.equal(networkState(null), "unknown");
  assert.equal(networkState({}), "unknown");
  assert.equal(networkState({ error: { message: "locked" }, network: "PUBLIC" }), "unknown");
  assert.equal(networkState({ network: "PUBLIC" }, PUBLIC), "ok");
});

test("network names", () => {
  assert.equal(networkName({ networkPassphrase: PUBLIC }), "Mainnet");
  assert.equal(networkName({ network: "PUBLIC" }), "Mainnet");
  assert.equal(networkName({ networkPassphrase: FUTURENET }), "Futurenet");
  assert.equal(networkName({ network: "STANDALONE" }), "Standalone");
  assert.equal(networkName(null), "another network");
});

test("wallet capabilities", () => {
  for (const id of ["albedo", "xbull"]) {
    assert.equal(capabilityOf(id).byRequest, true, id);
    assert.equal(mustCheck(capabilityOf(id)), false, id);
  }
  for (const id of ["freighter", "varial", "hana", "rabet"]) assert.equal(mustCheck(capabilityOf(id)), true, id);
  assert.equal(capabilityOf("freighter").query, true);
  assert.ok(capabilityOf("freighter").steps.length >= 3);
  assert.match(capabilityOf("lobstr").warn, /can't be told to sign for testnet/);
  assert.equal(capabilityOf("Varial Wallet").name, "Varial");
  assert.equal(capabilityOf("xBull Wallet").name, "xBull");
  const u = capabilityOf("somewallet");
  assert.equal(u.testnet, "unknown");
  assert.equal(mustCheck(u), true);
  assert.ok(u.steps.length > 0);
  assert.deepEqual(noSwitchIds().sort(), ["albedo", "xbull"]);
});

test("waiting requests continue when the network becomes right", async () => {
  const w = createNetWait();
  const a = w.wait(), b = w.wait();
  assert.equal(w.waiting, 2);
  assert.equal(w.update("wrong"), 0);
  assert.equal(w.update("unknown"), 0);
  assert.equal(w.waiting, 2);
  assert.equal(w.update("ok"), 2);
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(w.waiting, 0);
  assert.equal(w.update("ok"), 0);
});

test("the user can continue anyway, or cancel", async () => {
  const w = createNetWait();
  const a = w.wait();
  w.proceed();
  assert.equal(await a, true);
  const b = w.wait();
  w.cancel();
  assert.equal(await b, false);
});
