// Pure logic of the test USDC faucet (api/faucet.js): no network, no store, no keys, so it can be tested on its own.
// The leading "_" keeps Vercel from serving this file as an endpoint.
const crypto = require("crypto");

const DAY = 24 * 3600 * 1000;
const TESTNET = "Test SDF Network ; September 2015";
const LIMITS = { walletPerDay: 1, ipPerDay: 3 };

// ---- Stellar account address (G...): base32, version byte 6 << 3, 32-byte key, CRC16-XModem checksum ----
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(s) {
  let bits = 0, val = 0;
  const out = [];
  for (const ch of s) {
    const i = B32.indexOf(ch);
    if (i < 0) return null;
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}
function crc16(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
/** True for a valid Stellar account address (G..., 56 characters, correct checksum). */
function validAddress(a) {
  if (typeof a !== "string" || !/^G[A-Z2-7]{55}$/.test(a)) return false;
  const raw = base32(a);
  if (!raw || raw.length !== 35 || raw[0] !== 6 << 3) return false;
  const sum = crc16(raw.subarray(0, 33));
  return raw[33] === (sum & 0xff) && raw[34] === sum >> 8;
}

// ---- Amounts: Stellar amounts have 7 decimals; kept as BigInt stroops so nothing is rounded ----
function toStroops(s) {
  const m = /^(\d{1,12})(?:\.(\d{1,7}))?$/.exec(String(s).trim());
  if (!m) return null;
  return BigInt(m[1]) * 10_000_000n + BigInt((m[2] || "").padEnd(7, "0"));
}
const fromStroops = (n) => {
  const s = (BigInt(n) / 10_000_000n).toString();
  const f = (BigInt(n) % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return f ? `${s}.${f}` : s;
};
/** The amount sent per request, from FAUCET_USDC_AMOUNT (default 100, at most 10,000). Throws if invalid. */
function faucetAmount(env) {
  const raw = env && env.FAUCET_USDC_AMOUNT !== undefined && String(env.FAUCET_USDC_AMOUNT).trim() !== "" ? env.FAUCET_USDC_AMOUNT : "100";
  const n = toStroops(raw);
  if (n === null || n <= 0n || n > 10_000n * 10_000_000n) throw new Error("FAUCET_USDC_AMOUNT must be a number between 0.0000001 and 10000");
  return fromStroops(n);
}

// ---- Horizon account balances ----
/** The account's trustline to code:issuer: "missing", "unauthorized", "full", or "ok" (there is room for amount). */
function trustlineState(balances, code, issuer, amount) {
  const t = (balances || []).find((b) => b.asset_code === code && b.asset_issuer === issuer);
  if (!t) return "missing";
  if (t.is_authorized === false) return "unauthorized";
  const room = toStroops(t.limit) - toStroops(t.balance);
  return room >= toStroops(amount) ? "ok" : "full";
}
/** Can the faucet account pay `amount` and the fee? Returns null if yes, else "usdc" or "xlm". */
function faucetShort(balances, code, issuer, amount) {
  const usdc = (balances || []).find((b) => b.asset_code === code && b.asset_issuer === issuer);
  if (!usdc || toStroops(usdc.balance) < toStroops(amount)) return "usdc";
  const xlm = (balances || []).find((b) => b.asset_type === "native");
  if (!xlm || toStroops(xlm.balance) < 2n * 10_000_000n) return "xlm"; // base reserve + fees
  return null;
}

// ---- Limits: one record per wallet, one per IP (hashed), both in the private blob store ----
/** Wallet record { at }: the wallet may ask again once 24 hours have passed. Returns ms to wait, 0 if allowed. */
function walletWait(rec, now) {
  if (!rec || !Number.isFinite(rec.at)) return 0;
  return Math.max(0, rec.at + DAY - now);
}
/** IP record { times: [...] }: at most LIMITS.ipPerDay in any 24 hours. Returns ms to wait, 0 if allowed. */
function ipWait(rec, now) {
  const times = ipTimes(rec, now);
  if (times.length < LIMITS.ipPerDay) return 0;
  return Math.max(0, Math.min(...times) + DAY - now);
}
const ipTimes = (rec, now) => (rec && Array.isArray(rec.times) ? rec.times.filter((t) => Number.isFinite(t) && now - t < DAY) : []);
const nextIp = (rec, now) => ({ times: [...ipTimes(rec, now), now] });
/** Store key for an IP: a hash, so the store holds no raw IP addresses. */
const ipKey = (ip) => crypto.createHash("sha256").update(`iora-faucet:${String(ip)}`).digest("hex").slice(0, 32);
/** The client IP from Vercel's x-forwarded-for (first entry). */
const clientIp = (req) => String((req.headers && req.headers["x-forwarded-for"]) || (req.socket && req.socket.remoteAddress) || "?").split(",")[0].trim();

// ---- Access ticket of the testnet gate (same format and secret as api/access.js) ----
const sign = (data, secret) => crypto.createHmac("sha256", secret).update(data).digest("base64url");
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
/** The ticket's subject ("code" or a wallet address) if it is valid and not expired, otherwise null. */
function verifyTicket(token, secret, now = Date.now()) {
  if (!secret) return null;
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig || !same(sig, sign(payload, secret))) return null;
  try {
    const { sub, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof exp === "number" && exp > now ? String(sub) : null;
  } catch {
    return null;
  }
}
/** An invite-code ticket allows any wallet; a wallet ticket only its own wallet (as the gate in the app). */
const ticketAllows = (sub, address) => sub === "code" || sub === address;

module.exports = { DAY, TESTNET, LIMITS, validAddress, toStroops, fromStroops, faucetAmount, trustlineState, faucetShort, walletWait, ipWait, nextIp, ipKey, clientIp, verifyTicket, ticketAllows };
