// What did these transactions cost, and why? Reads finished transactions from the network (nothing is sent) and
// prints, side by side: the fee charged, how it splits (fixed part, refundable part, rent), and the resources the
// transaction declared (CPU instructions, bytes read and written, ledger entries touched).
// The XDR is decoded by the stellar command line tool, so this does not depend on the SDK version.
// Usage: node keeper/tx-cost.js <tx hash> [<tx hash> ...]
//        (no arguments: the first cross on testnet and the pool fill that followed it)
import { execFileSync } from "node:child_process";

const RPC_URL = process.env.RPC_URL || "https://soroban-testnet.stellar.org";
const args = process.argv.slice(2);
const hashes = args.length
  ? args
  : ["0e5b1cac8d8cb3b79f7b7ba08e479ec4ca07ff266445e2d769684fc83d389044", "e762d85c5e5e06ea2961cac4c494d553df4bbb1dc95b0c90a25257bc2945ba76"];

async function rpc(method, params) {
  const r = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}
function decode(type, b64) {
  const out = execFileSync("stellar", ["xdr", "decode", "--type", type, "--input", "single-base64", "--output", "json"], { input: b64, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}
/** Every value stored under `key`, anywhere in the decoded structure. */
function find(o, key, acc = []) {
  if (Array.isArray(o)) for (const v of o) find(v, key, acc);
  else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) {
    if (k === key) acc.push(v);
    find(v, key, acc);
  }
  return acc;
}
const first = (o, ...keys) => { for (const k of keys) { const v = find(o, k)[0]; if (v !== undefined) return v; } return undefined; };
const xlm = (v) => (v === undefined ? "?" : (Number(v) / 1e7).toFixed(4));
const num = (v) => (v === undefined ? "?" : Number(v).toLocaleString("en-US"));

const rows = [];
for (const hash of hashes) {
  const t = await rpc("getTransaction", { hash });
  if (t.status !== "SUCCESS" && t.status !== "FAILED") { console.log(`${hash.slice(0, 8)}: ${t.status} (too old for this RPC server, or not found)`); continue; }
  const env = decode("TransactionEnvelope", t.envelopeXdr);
  const res = decode("TransactionResult", t.resultXdr);
  const meta = decode("TransactionMeta", t.resultMetaXdr);
  const fn = first(env, "function_name");
  const events = find(meta, "events").flat().filter((e) => e && typeof e === "object");
  rows.push({
    tx: hash.slice(0, 8),
    call: String(fn ?? "?"),
    status: t.status,
    "fee charged (XLM)": xlm(first(res, "fee_charged")),
    "- fixed part": xlm(first(meta, "total_non_refundable_resource_fee_charged")),
    "- refundable part": xlm(first(meta, "total_refundable_resource_fee_charged")),
    "  of which rent": xlm(first(meta, "rent_fee_charged")),
    "declared resource fee": xlm(first(env, "resource_fee")),
    instructions: num(first(env, "instructions")),
    "bytes read": num(first(env, "disk_read_bytes", "read_bytes")),
    "bytes written": num(first(env, "write_bytes")),
    "entries read-only": (first(env, "read_only") || []).length,
    "entries read-write": (first(env, "read_write") || []).length,
    "events in meta": events.length,
  });
}
if (rows.length) {
  const keys = Object.keys(rows[0]);
  const w = Math.max(...keys.map((k) => k.length));
  for (const k of keys) console.log(k.padEnd(w + 2) + rows.map((r) => String(r[k]).padStart(16)).join(""));
}
