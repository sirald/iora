// Builds ONE move transaction (iora-mover) for an old vault, simulates it and writes the prepared, UNSIGNED
// transaction to a file. Reference for the web app: the same steps build the call there, and the wallet signs it
// once. Nothing is signed or sent here.
// - Old single vault (iora-vault, version 8 and later): `move_vault`.
// - Old two-vault design vault (order-vault, any generation; it has no `version`): `move_order_vault` (mover 2).
//
//   node scripts/move-vault.mjs --owner G... --old C... --factory C... --mover C... [--exchange C...] \
//        [--rpc https://soroban-testnet.stellar.org] [--out move.xdr]
//
//   --keep false: orders moved from an old two-vault design vault send their output to the wallet as the old vault did
//   (default true: the output stays in the new vault and keeps earning).
// Needs @stellar/stellar-sdk (keeper/node_modules); STELLAR_SDK=<path to the package> overrides where it is loaded from.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const sdkPath = process.env.STELLAR_SDK || path.join(process.cwd(), "keeper/node_modules/@stellar/stellar-sdk");
const { rpc, Account, StrKey, Contract, TransactionBuilder, Networks, nativeToScVal, scValToNative, Address, xdr, BASE_FEE } = require(sdkPath);

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const OWNER = arg("owner");
const OLD = arg("old");
const FACTORY = arg("factory");
const MOVER = arg("mover");
const EXCHANGE = arg("exchange");
const RPC = arg("rpc", "https://soroban-testnet.stellar.org");
const OUT = arg("out", "move.xdr");
const PASSPHRASE = arg("passphrase", Networks.TESTNET);
const KEEP = arg("keep", "true") !== "false";
if (!OWNER || !OLD || !FACTORY || !MOVER) {
  console.error("usage: --owner G.. --old C.. --factory C.. --mover C.. [--exchange C..]");
  process.exit(2);
}

/** Vault rules the new orders must respect (iora-vault). */
const MAX_FILLS = 20n;
const ROUNDING_BUFFER = 10_000n; // 0.001: held back from orders on a token supplied to Blend
const SAFETY = 10n; // a few stroops for Blend's rounding on withdraw / supply
const BAND_DEFAULT = 200; // stop band for old triggered orders that had none (order-vault before version 4)
const EXPIRY_MARGIN = 120; // seconds: an order that ends sooner is not moved (it would expire on the way)

const server = new rpc.Server(RPC);
const seq = (await server.getAccount(OWNER)).sequenceNumber();
// Every build() advances an Account's sequence number: reads use throw-away copies, the move uses a fresh one.
const fresh = () => new Account(OWNER, seq);

const u32 = (n) => nativeToScVal(Number(n), { type: "u32" });
const u64 = (n) => nativeToScVal(BigInt(n), { type: "u64" });
const i128 = (n) => nativeToScVal(BigInt(n), { type: "i128" });
const bool = (b) => nativeToScVal(!!b, { type: "bool" });
const addr = (a) => new Address(a).toScVal();
const sym = (s) => xdr.ScVal.scvSymbol(s);

/** Read-only call (simulation). Returns the native value, or undefined if the call fails. */
async function read(id, fn, args = []) {
  const tx = new TransactionBuilder(fresh(), { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(id).call(fn, ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim) || !sim.result) return undefined;
  return scValToNative(sim.result.retval);
}

const now = Math.floor(Date.now() / 1000);
const versionRaw = await read(OLD, "version");
const version = Number(versionRaw ?? 0);
const oldCfg = await read(OLD, "get_config");
// The two-vault design (order-vault) has no `version` and one coin per vault: config field `usdc` is the coin it
// holds (XLM in a sell vault), `xlm` the coin its orders buy.
const LEGACY = versionRaw === undefined && oldCfg && oldCfg.usdc && oldCfg.xlm;
if (!LEGACY && version < 8) throw new Error(`old vault version ${version}: not a supported vault`);
if (LEGACY && oldCfg.owner !== OWNER) throw new Error(`old vault belongs to ${oldCfg.owner}`);

// 1) Coins: every listed token with a balance (after the cancels everything is free) and that balance.
//    An old two-vault design vault holds one coin: `balance()` (no argument).
const tokens = LEGACY ? [oldCfg.usdc] : ((await read(OLD, "tokens")) ?? []);
const balance = {};
for (const t of tokens) {
  const b = BigInt((await read(OLD, "balance", LEGACY ? [] : [addr(t)])) ?? 0);
  if (b > 0n) balance[t] = b;
}
if (LEGACY && !balance[oldCfg.usdc]) throw new Error("the old vault is empty");
const coins = Object.keys(balance);

// 2) Mock USDC is exchanged 1:1 for Circle USDC (up to what the exchange allows for this wallet).
let mock, usdc, left = 0n;
if (EXCHANGE) {
  mock = await read(EXCHANGE, "mock");
  usdc = await read(EXCHANGE, "usdc");
  left = BigInt((await read(EXCHANGE, "left", [addr(OWNER)])) ?? 0);
}
const inNew = (t) => (EXCHANGE && t === mock ? usdc : t);
// What will arrive in the new vault per token, minus Blend's buffer and rounding: the most the orders may reserve.
const room = {};
for (const t of coins) {
  let n = balance[t];
  if (EXCHANGE && t === mock) n = n < left ? n : left;
  room[inNew(t)] = (room[inNew(t)] ?? 0n) + n - ROUNDING_BUFFER - SAFETY;
}

// 3) Orders: every open order is cancelled; those that can still run are opened again in the new vault.
const count = Number((await read(OLD, "order_count")) ?? 0);
const cancel = [];
const place = [];
const skipped = [];
for (let id = 0; id < count; id++) {
  const o = await read(OLD, "get_order", [u32(id)]);
  if (!o || o.status?.[0] !== "Open") continue;
  cancel.push(id);
  if (Number(o.expiry) <= now + EXPIRY_MARGIN) {
    skipped.push(`#${id} expires too soon`);
    continue;
  }
  // An old two-vault design order sells the vault's coin (`usdc`) for its other coin (`xlm`); its prices are in the
  // same unit as the new vault's (sell token paid per 1 buy token).
  const sell = inNew(LEGACY ? oldCfg.usdc : o.sell);
  const buy = inNew(LEGACY ? oldCfg.xlm : o.buy);
  let rem = BigInt(o.amount_in) - BigInt(o.filled_in);
  const sch = !LEGACY && version >= 11 ? await read(OLD, "get_schedule", [u32(id)]) : undefined;
  // (order-vault generation 1 has no follow-up orders: the read fails and gives undefined)
  const fol = await read(OLD, "get_follow_up", [u32(id)]);
  const keep = LEGACY ? KEEP : o.keep;
  if (sch) rem = BigInt(sch.part);
  // Keep the sum of the orders on one token within what arrives.
  const r = room[sell] ?? 0n;
  if (rem > r) rem = r;
  if (rem <= 0n) {
    skipped.push(`#${id} nothing left to sell`);
    continue;
  }
  room[sell] = r - rem;
  const minFill = (() => {
    const lo = (rem - 1n) / MAX_FILLS + 1n; // at most MAX_FILLS pieces
    const m = BigInt(o.min_fill) < rem ? BigInt(o.min_fill) : rem;
    return m > lo ? m : lo;
  })();
  let func, args;
  if (sch) {
    const fillsLeft = sch.fills === 0 ? 0 : Number(sch.fills) - Number(sch.done);
    if (sch.fills !== 0 && fillsLeft <= 0) {
      skipped.push(`#${id} plan finished`);
      continue;
    }
    func = "place_dca";
    args = [addr(sell), addr(buy), i128(rem), u32(fillsLeft), u64(sch.every), i128(o.limit_price), u32(o.max_impact_bps), u32(o.stop_band_bps), u64(o.expiry), bool(o.keep)];
  } else if (fol) {
    // order-vault: the follow-up went to the sibling vault; in the new vault it is the reverse order in the same vault,
    // with the same limit unit (buy token paid per 1 sell token).
    func = "place_order_then";
    args = [addr(sell), addr(buy), i128(rem), i128(o.limit_price), i128(minFill), u32(o.max_impact_bps), u64(o.expiry), i128(fol.limit_price), u32(fol.max_impact_bps), u64(fol.duration)];
  } else if (BigInt(o.trigger_price ?? 0) > 0n) {
    func = "place_stop_order";
    const band = Number(o.stop_band_bps ?? 0) || BAND_DEFAULT;
    args = [addr(sell), addr(buy), i128(rem), i128(o.trigger_price), i128(o.limit_price), i128(minFill), u32(o.max_impact_bps), u64(o.expiry), u32(band), bool(keep)];
  } else {
    func = "place_order";
    args = [addr(sell), addr(buy), i128(rem), i128(o.limit_price), i128(minFill), u32(o.max_impact_bps), u64(o.expiry), bool(keep)];
  }
  // PlaceCall { func: Symbol, args: Vec<Val> }: a contracttype struct is a map with its field names sorted.
  place.push(
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: sym("args"), val: xdr.ScVal.scvVec(args) }),
      new xdr.ScMapEntry({ key: sym("func"), val: sym(func) }),
    ]),
  );
  console.log(`order #${id}: ${func} sell ${sell} buy ${buy} amount ${rem}`);
}

// 4) The call. `coins` is a Map<Address, i128>: token -> amount, the balance seen now. The amounts are fixed in the
// call because the owner's signature covers every argument of the call tree (deposit, transfer, burn); interest
// that accrues between this simulation and execution stays in the old vault as dust.
// A Soroban map must have its keys in ascending order. Tokens are contract addresses (C...), which order by their
// 32-byte contract id.
function coinMap(pairs) {
  const id = (t) => StrKey.decodeContract(t);
  const sorted = [...pairs].sort(([a], [b]) => Buffer.compare(id(a), id(b)));
  return xdr.ScVal.scvMap(sorted.map(([t, n]) => new xdr.ScMapEntry({ key: addr(t), val: i128(n) })));
}

// An old two-vault design vault: `move_order_vault(owner, old_vault, factory, amount, cancel, place, convert)`; the
// coin is read from the old vault's config by the mover itself.
const call = LEGACY
  ? new Contract(MOVER).call(
      "move_order_vault",
      addr(OWNER),
      addr(OLD),
      addr(FACTORY),
      i128(balance[oldCfg.usdc]),
      xdr.ScVal.scvVec(cancel.map(u32)),
      xdr.ScVal.scvVec(place),
      EXCHANGE ? addr(EXCHANGE) : xdr.ScVal.scvVoid(),
    )
  : new Contract(MOVER).call(
      "move_vault",
      addr(OWNER),
      addr(OLD),
      addr(FACTORY),
      coinMap(coins.map((t) => [t, balance[t]])),
      xdr.ScVal.scvVec(cancel.map(u32)),
      xdr.ScVal.scvVec(place),
      EXCHANGE ? addr(EXCHANGE) : xdr.ScVal.scvVoid(),
    );
const tx = new TransactionBuilder(fresh(), { fee: BASE_FEE, networkPassphrase: PASSPHRASE }).addOperation(call).setTimeout(300).build();
const sim = await server.simulateTransaction(tx);
if (rpc.Api.isSimulationError(sim)) {
  console.error("SIMULATION FAILED:", sim.error);
  for (const e of sim.events ?? []) console.error(scValToNative(e.event().body().v0().data()));
  process.exit(1);
}
// (stellar-sdk 17: read the built SorobanTransactionData through its JSON form)
const res = JSON.parse(JSON.stringify(sim.transactionData.build(), (k, v) => (typeof v === "bigint" ? String(v) : v))).resources;
console.log(
  JSON.stringify(
    {
      function: LEGACY ? "move_order_vault" : "move_vault",
      coins,
      cancel,
      orders: place.length,
      skipped,
      new_vault: scValToNative(sim.result.retval),
      instructions: res.instructions,
      disk_read_bytes: res.disk_read_bytes,
      write_bytes: res.write_bytes,
      read_only_entries: res.footprint.read_only.length,
      read_write_entries: res.footprint.read_write.length,
      min_resource_fee_stroops: sim.minResourceFee,
      auth_entries: (sim.result.auth ?? []).length,
    },
    null,
    1,
  ),
);
// Headroom: Blend's interest grows its entries by a few bytes and costs a little more work between simulation and
// execution (seen on testnet: 11,388 bytes written against 11,332 simulated). Without a margin the transaction
// fails with "resource_limit_exceeded". Unused refundable fee is returned.
const margin = (n, pct) => Math.ceil(Number(n) * (1 + pct / 100));
sim.transactionData.setResources(margin(res.instructions, 25), margin(res.disk_read_bytes, 20) + 1000, margin(res.write_bytes, 20) + 1000);
const fee = margin(sim.minResourceFee, 50);
sim.transactionData.setResourceFee(fee);
sim.minResourceFee = String(fee);
const prepared = rpc.assembleTransaction(tx, sim).build();
writeFileSync(OUT, prepared.toXDR());
console.log(`prepared, unsigned transaction written to ${OUT}`);
