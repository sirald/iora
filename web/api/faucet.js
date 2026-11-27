// Vercel serverless function: the test USDC faucet of the Test funds page. Sends a fixed amount of Circle's testnet
// USDC (the USDC Iora uses on testnet) from a faucet account to a wallet, with a classic payment.
// POST { address: "G...", token: "<access ticket>" } -> { ok: true, hash, amount } | { ok: false, error, ... }
// Testnet only: it refuses to run if the network passphrase is not testnet's, or if Horizon reports another network.
// Environment variables (Vercel, production):
//   FAUCET_SECRET        the faucet account's secret key (S...). Read only here; never logged or returned.
//   FAUCET_USDC_AMOUNT   USDC per request (default 100)
//   FAUCET_USDC_ISSUER   USDC issuer (default Circle's testnet issuer)
//   FAUCET_HORIZON_URL   Horizon (default https://horizon-testnet.stellar.org)
//   FAUCET_NETWORK_PASSPHRASE  (default testnet; any other value disables the faucet)
//   FAUCET_REQUIRE_ACCESS "0" lets wallets without an access ticket use it (default: ticket required)
//   IORA_ACCESS_SECRET   the access gate's ticket secret (same as api/access.js)
//   BLOB_READ_WRITE_TOKEN the private Blob store of api/beta.js (set by Vercel when the store is linked)
// Limits: one request per wallet per 24 hours, three per IP per 24 hours, kept in the private Blob store
// (faucet/wallet/<G...>.json, faucet/ip/<hash>.json). Without the store the faucet does not send (fail closed).
const lib = require("./_faucet-lib.cjs");

const ORIGINS = /^https:\/\/(iorafi\.com|www\.iorafi\.com|berthly[a-z0-9-]*\.vercel\.app)$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const CIRCLE_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const fail = (res, status, error, extra = {}) => res.status(status).json({ ok: false, error, ...extra });

async function readRec(blob, path) {
  let r;
  try {
    r = await blob.get(path, { access: "private", useCache: false });
  } catch (e) {
    if (e && e.name === "BlobNotFoundError") return { data: null, etag: null };
    throw e;
  }
  if (!r || r.statusCode !== 200 || !r.stream) return { data: null, etag: null };
  const text = await new Response(r.stream).text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return { data, etag: r.blob.etag };
}
// A conditional write: if another request changed the record meanwhile, it fails instead of overwriting.
async function writeRec(blob, path, data, etag) {
  const opt = { access: "private", addRandomSuffix: false, contentType: "application/json" };
  const r = await blob.put(path, JSON.stringify(data), etag ? { ...opt, allowOverwrite: true, ifMatch: etag } : { ...opt, allowOverwrite: false });
  return r.etag;
}

module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") return fail(res, 405, "method");
  if (!ORIGINS.test(String(req.headers.origin || ""))) return fail(res, 403, "origin");

  // ---- configuration ----
  const env = process.env;
  const passphrase = env.FAUCET_NETWORK_PASSPHRASE || lib.TESTNET;
  if (passphrase !== lib.TESTNET) return fail(res, 503, "not_testnet");
  let amount;
  try {
    amount = lib.faucetAmount(env);
  } catch {
    return fail(res, 500, "not_configured");
  }
  if (!env.FAUCET_SECRET) return fail(res, 503, "not_configured");
  const issuer = env.FAUCET_USDC_ISSUER || CIRCLE_ISSUER;
  const horizonUrl = (env.FAUCET_HORIZON_URL || "https://horizon-testnet.stellar.org").replace(/\/+$/, "");

  // ---- request ----
  let body = req.body || {};
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return fail(res, 400, "bad_request");
    }
  }
  const address = String(body.address || "").trim().toUpperCase();
  if (!lib.validAddress(address)) return fail(res, 400, "bad_address");
  // Same rule as the app's entry gate: an invite-code ticket, or a ticket for this very wallet.
  if (env.FAUCET_REQUIRE_ACCESS !== "0") {
    const sub = lib.verifyTicket(body.token, env.IORA_ACCESS_SECRET);
    if (!sub || !lib.ticketAllows(sub, address)) return fail(res, 403, "no_access");
  }

  let sdk, blob, kp;
  try {
    // The SDK is loaded with import(): its CommonJS build requires an ES-only dependency, which Vercel's runtime
    // refuses with require() ("require() of ES Module … not supported").
    const m = await import("@stellar/stellar-sdk");
    sdk = m.default && m.default.Keypair ? m.default : m;
    blob = require("@vercel/blob");
    kp = sdk.Keypair.fromSecret(env.FAUCET_SECRET);
  } catch {
    return fail(res, 503, "not_configured"); // no detail: the error could mention the key
  }
  const horizon = new sdk.Horizon.Server(horizonUrl);
  const usdc = new sdk.Asset("USDC", issuer);

  // ---- network and accounts ----
  let target, faucet;
  try {
    const root = await fetch(`${horizonUrl}/`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
    if (!root || root.network_passphrase !== lib.TESTNET) return fail(res, 503, "not_testnet");
    try {
      target = await horizon.loadAccount(address);
    } catch (e) {
      if (e && e.response && e.response.status === 404) return fail(res, 400, "no_account");
      throw e;
    }
    faucet = await horizon.loadAccount(kp.publicKey());
  } catch {
    return fail(res, 502, "network");
  }
  const trust = lib.trustlineState(target.balances, "USDC", issuer, amount);
  if (trust === "missing") return fail(res, 400, "no_trustline");
  if (trust !== "ok") return fail(res, 400, trust === "full" ? "trustline_full" : "trustline_unauthorized");
  const short = lib.faucetShort(faucet.balances, "USDC", issuer, amount);
  if (short) return fail(res, 503, "faucet_low");

  // ---- limits: claimed before sending, so two requests at once cannot both pass ----
  const now = Date.now();
  const wPath = `faucet/wallet/${address}.json`;
  const iPath = `faucet/ip/${lib.ipKey(lib.clientIp(req))}.json`;
  let w, ip, wTag;
  try {
    [w, ip] = await Promise.all([readRec(blob, wPath), readRec(blob, iPath)]);
    const wait = Math.max(lib.walletWait(w.data, now), lib.ipWait(ip.data, now));
    if (wait > 0) return fail(res, 429, lib.walletWait(w.data, now) > 0 ? "wallet_limit" : "ip_limit", { retryAfter: Math.ceil(wait / 1000) });
    wTag = await writeRec(blob, wPath, { at: now }, w.etag);
    await writeRec(blob, iPath, lib.nextIp(ip.data, now), ip.etag);
  } catch (e) {
    console.error("faucet store:", String((e && e.name) || "error"));
    return fail(res, 503, "limits_unavailable");
  }

  // ---- send ----
  try {
    const tx = new sdk.TransactionBuilder(faucet, { fee: String(Number(sdk.BASE_FEE) * 10), networkPassphrase: lib.TESTNET })
      .addOperation(sdk.Operation.payment({ destination: address, asset: usdc, amount }))
      .addMemo(sdk.Memo.text("Iora test USDC"))
      .setTimeout(60)
      .build();
    tx.sign(kp);
    const r = await horizon.submitTransaction(tx);
    return res.status(200).json({ ok: true, hash: r.hash, amount });
  } catch (e) {
    const codes = e && e.response && e.response.data && e.response.data.extras && e.response.data.extras.result_codes;
    // Rejected by the network (result codes): nothing was sent, so the wallet's claim is given back and the user can
    // try again (best effort; the IP count stays). A timeout may still apply, so then the claim stays.
    if (codes) {
      try {
        if (w.data) await writeRec(blob, wPath, w.data, wTag);
        else await blob.del(wPath);
      } catch {}
    }
    console.error("faucet send:", JSON.stringify(codes || String((e && e.name) || "error")).slice(0, 200));
    return fail(res, 502, codes ? "send_failed" : "send_unknown");
  }
};
