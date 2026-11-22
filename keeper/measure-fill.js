// Measures what filling orders costs the network. Simulation only: nothing is sent, nothing is signed.
// Prints, for a `fill_many` call with 1..N of the given orders: CPU instructions, bytes read and written,
// ledger entries touched, the resource fee, and every contract event with its size (events are the limit that
// stops a batch at 6 fills today).
// Usage: node keeper/measure-fill.js <batch> <vault> <executor G...> <amount> <order ids, comma separated>
import { Account, Address, BASE_FEE, Contract, Networks, TransactionBuilder, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";

const [batch, vault, executor, amount, idList] = process.argv.slice(2);
if (!idList) {
  console.log("usage: node keeper/measure-fill.js <batch> <vault> <executor> <amount> <ids>");
  process.exit(1);
}
const ids = idList.split(",").map(Number);
const server = new rpc.Server(process.env.RPC_URL || "https://soroban-testnet.stellar.org");

function fill(id) {
  const e = (k, v) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v });
  // Struct fields in alphabetical order, as the contract type expects.
  return xdr.ScVal.scvMap([
    e("amount", nativeToScVal(BigInt(amount), { type: "i128" })),
    e("order_id", nativeToScVal(id, { type: "u32" })),
    e("vault", new Address(vault).toScVal()),
    e("via", xdr.ScVal.scvVoid()),
  ]);
}

// The SDK exposes XDR values as plain objects in new versions and through accessor functions in old ones.
const g = (o, ...names) => {
  for (const n of names) {
    if (o && o[n] !== undefined) return typeof o[n] === "function" ? o[n]() : o[n];
  }
  return undefined;
};
const J = (o) => JSON.stringify(o, (k, v) => (typeof v === "bigint" ? v.toString() : v && v.type === "Buffer" ? "<" + v.data.length + " bytes>" : v));
const num = (v) => (v === undefined || v === null ? "?" : Number(v.toString()));
const short = (s) => (s.length > 12 ? s.slice(0, 4) + ".." + s.slice(-4) : s);
const xlen = (v) => (v && typeof v.toXDR === "function" ? v.toXDR().length : Buffer.byteLength(J(v) || ""));
/** Finds the part of an event that holds `topics` and `data`, wherever the SDK version puts it. */
function topicsOf(o, depth = 0) {
  if (!o || typeof o !== "object" || depth > 4) return null;
  const t = g(o, "topics");
  if (Array.isArray(t)) return { topics: t, data: g(o, "data") };
  for (const k of ["event", "body", "v0", "value", "_value"]) {
    const r = topicsOf(g(o, k), depth + 1);
    if (r) return r;
  }
  return null;
}

async function measure(n) {
  const args = [new Address(executor).toScVal(), xdr.ScVal.scvVec(ids.slice(0, n).map(fill))];
  const tx = new TransactionBuilder(new Account(executor, "0"), { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(batch).call("fill_many", ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    console.log(`${n} fill(s): simulation failed: ${String(sim.error).split("\n")[0].slice(0, 200)}`);
    return;
  }
  const res = g(sim.transactionData.build(), "resources");
  const fp = g(res, "footprint");
  const events = [];
  for (const d of sim.events || []) {
    const ev = g(d, "event") || d;
    const type = J(g(ev, "type")) || "";
    if (g(d, "inSuccessfulContractCall") === false || !/contract/i.test(type)) continue;
    const td = topicsOf(ev);
    if (!td) continue;
    const size = td.topics.reduce((a, t) => a + xlen(t), 0) + xlen(td.data);
    const cid = g(ev, "contractId");
    let who = "-";
    try {
      who = typeof cid === "string" ? cid : cid ? Address.contract(cid).toString() : "-";
    } catch {
      who = J(cid);
    }
    const t0 = td.topics[0];
    const name = (t0 && (g(t0, "sym") || J(t0))) || "-";
    events.push({ size, who: who === vault ? "VAULT" : short(String(who)), name: String(name).slice(0, 40) });
  }
  const total = events.reduce((a, e) => a + e.size, 0);
  console.log(
    `${n} fill(s): instructions ${num(g(res, "instructions"))}, read bytes ${num(g(res, "diskReadBytes", "readBytes"))}, ` +
      `write bytes ${num(g(res, "writeBytes"))}, entries read-only ${g(fp, "readOnly").length} / read-write ${g(fp, "readWrite").length}, ` +
      `resource fee ${num(sim.minResourceFee)} stroops, events ${events.length} = ${total} bytes (topics and data)`,
  );
  if (n === 1) {
    for (const e of events) console.log(`   ${String(e.size).padStart(5)} bytes  ${e.who.padEnd(10)} ${e.name}`);
    if (events.length === 0 && (sim.events || []).length) console.log("   first raw event: " + (J(sim.events[0]) || "").slice(0, 300));
  }
}

for (const n of [1, 2, ids.length].filter((v, i, a) => v <= ids.length && a.indexOf(v) === i)) {
  try {
    await measure(n);
  } catch (e) {
    console.log(`${n} fill(s): ${String(e.message || e).slice(0, 200)}`);
  }
}
