// Vercel serverless function: exchanges Blend's old test USDC for Circle's test USDC, 1:1, when an earlier vault is
// moved to the newest one. The wallet first pays its old test USDC back to that token's issuer (which burns it) and
// sends the hash of that transaction here; this function checks the burn on Horizon and sends the same amount of
// Circle's test USDC from the faucet account (the same account as api/faucet.js).
// POST { address: "G...", hash: "<burn transaction>", token: "<access ticket>" }
//   -> { ok: true, hash: "<payment>", amount } | { ok: false, error, ... }
// Every burn is paid once: the burn hash is recorded in the private Blob store (convert/hash/<hash>.json) before
// paying; a retry with the same hash returns the earlier payment, or pays again only if that payment certainly did
// not apply. A wallet can exchange at most CONVERT_MAX_PER_WALLET in total (convert/wallet/<G...>.json).
// Environment variables: those of api/faucet.js (FAUCET_SECRET, FAUCET_USDC_ISSUER, FAUCET_HORIZON_URL,
// FAUCET_NETWORK_PASSPHRASE, FAUCET_REQUIRE_ACCESS, IORA_ACCESS_SECRET, BLOB_READ_WRITE_TOKEN), plus
//   CONVERT_MAX_PER_WALLET  total per wallet (default 5000)
//   CONVERT_OLD_ISSUER      issuer of the old test USDC (default Blend's GATALT…V56)
const lib = require("./_faucet-lib.cjs");
const cv = require("./_convert-lib.cjs");

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
// A conditional write: if another request changed (or created) the record meanwhile, it fails instead of overwriting.
async function writeRec(blob, path, data, etag) {
  const opt = { access: "private", addRandomSuffix: false, contentType: "application/json" };
  const r = await blob.put(path, JSON.stringify(data), etag ? { ...opt, allowOverwrite: true, ifMatch: etag } : { ...opt, allowOverwrite: false });
  return r.etag;
}
async function horizonJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`horizon ${r.status}`);
  return r.json();
}

module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") return fail(res, 405, "method");
  if (!ORIGINS.test(String(req.headers.origin || ""))) return fail(res, 403, "origin");

  // ---- configuration ----
  const env = process.env;
  if ((env.FAUCET_NETWORK_PASSPHRASE || lib.TESTNET) !== lib.TESTNET) return fail(res, 503, "not_testnet");
  let cap;
  try {
    cap = cv.convertCap(env);
  } catch {
    return fail(res, 500, "not_configured");
  }
  if (!env.FAUCET_SECRET) return fail(res, 503, "not_configured");
  const issuer = env.FAUCET_USDC_ISSUER || CIRCLE_ISSUER;
  const oldIssuer = env.CONVERT_OLD_ISSUER || cv.OLD_USDC_ISSUER;
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
  const hash = String(body.hash || "").trim().toLowerCase();
  if (!lib.validAddress(address)) return fail(res, 400, "bad_address");
  if (!cv.validHash(hash)) return fail(res, 400, "bad_hash");
  if (env.FAUCET_REQUIRE_ACCESS !== "0") {
    const sub = lib.verifyTicket(body.token, env.IORA_ACCESS_SECRET);
    if (!sub || !lib.ticketAllows(sub, address)) return fail(res, 403, "no_access");
  }

  let sdk, blob, kp;
  try {
    // import(): the SDK's CommonJS build requires an ES-only dependency, which Vercel refuses with require()
    const m = await import("@stellar/stellar-sdk");
    sdk = m.default && m.default.Keypair ? m.default : m;
    blob = require("@vercel/blob");
    kp = sdk.Keypair.fromSecret(env.FAUCET_SECRET);
  } catch {
    return fail(res, 503, "not_configured"); // no detail: the error could mention the key
  }
  const horizon = new sdk.Horizon.Server(horizonUrl);
  const usdc = new sdk.Asset("USDC", issuer);

  // ---- the burn ----
  const hPath = `convert/hash/${hash}.json`;
  const wPath = `convert/wallet/${address}.json`;
  let h;
  try {
    h = await readRec(blob, hPath);
  } catch {
    return fail(res, 503, "store_busy");
  }
  let amount, target, faucet;
  try {
    const root = await horizonJson(`${horizonUrl}/`);
    if (!root || root.network_passphrase !== lib.TESTNET) return fail(res, 503, "not_testnet");
    const tx = await horizonJson(`${horizonUrl}/transactions/${hash}`);
    if (!tx) return fail(res, 404, "tx_not_found"); // Horizon can be a few seconds behind: the client retries
    const ops = await horizonJson(`${horizonUrl}/transactions/${hash}/operations?limit=200`);
    const burn = cv.burnOf(tx, ops && ops._embedded ? ops._embedded.records : [], { address, issuer: oldIssuer, maxAge: h.data ? Infinity : cv.MAX_AGE }); // a burn seen before stays exchangeable
    if (burn.error) return fail(res, 400, burn.error);
    amount = burn.amount;
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

  // ---- once per burn, and the wallet's cap ----
  let hTag;
  try {
    let payState = null;
    if (h.data && h.data.status === "sending" && cv.validHash(h.data.payHash)) {
      const p = await horizonJson(`${horizonUrl}/transactions/${h.data.payHash}`).catch(() => undefined);
      payState = p === undefined ? null : p === null ? "missing" : p.successful ? "success" : "failed";
    }
    const step = cv.retryDecision(h.data, payState);
    if (step === "done") {
      if (h.data.status !== "done") await writeRec(blob, hPath, { ...h.data, status: "done" }, h.etag).catch(() => {});
      return res.status(200).json({ ok: true, hash: h.data.payHash, amount: h.data.amount, again: true });
    }
    if (step === "wait") return fail(res, 409, "in_progress", { retryAfter: 30 });
    if (h.data && h.data.address !== address) return fail(res, 400, "tx_not_yours");
    if (step === "new") {
      // The wallet's total is counted once per burn, when it is first claimed.
      const w = await readRec(blob, wPath);
      const total = w.data && /^\d+$/.test(String(w.data.total)) ? BigInt(w.data.total) : 0n;
      if (!cv.underCap(total, amount, cap)) return fail(res, 400, "wallet_cap", { left: lib.fromStroops(cap > total ? cap - total : 0n) });
      if (lib.faucetShort(faucet.balances, "USDC", issuer, amount)) return fail(res, 503, "faucet_low");
      hTag = await writeRec(blob, hPath, { status: "claimed", address, amount, at: Date.now() }, null); // fails if another request got here first
      await writeRec(blob, wPath, { total: String(total + lib.toStroops(amount)) }, w.etag);
    } else {
      if (lib.faucetShort(faucet.balances, "USDC", issuer, amount)) return fail(res, 503, "faucet_low");
      hTag = h.etag;
    }
  } catch (e) {
    console.error("convert store:", String((e && e.name) || "error"));
    return fail(res, 503, "store_busy"); // includes a lost race on the same hash: the client retries
  }

  // ---- pay ----
  const tx = new sdk.TransactionBuilder(faucet, { fee: String(Number(sdk.BASE_FEE) * 10), networkPassphrase: lib.TESTNET })
    .addOperation(sdk.Operation.payment({ destination: address, asset: usdc, amount }))
    .addMemo(sdk.Memo.text("Iora USDC exchange"))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  const payHash = Buffer.from(tx.hash()).toString("hex");
  const maxTime = Number(tx.timeBounds.maxTime);
  try {
    hTag = await writeRec(blob, hPath, { status: "sending", address, amount, payHash, maxTime, at: Date.now() }, hTag);
  } catch {
    return fail(res, 503, "store_busy");
  }
  try {
    await horizon.submitTransaction(tx);
    await writeRec(blob, hPath, { status: "done", address, amount, payHash, at: Date.now() }, hTag).catch(() => {});
    return res.status(200).json({ ok: true, hash: payHash, amount });
  } catch (e) {
    const codes = e && e.response && e.response.data && e.response.data.extras && e.response.data.extras.result_codes;
    console.error("convert send:", JSON.stringify(codes || String((e && e.name) || "error")).slice(0, 200));
    // Rejected: certainly not applied, so a retry pays again. A timeout stays "sending" and is settled on retry.
    if (codes) await writeRec(blob, hPath, { status: "failed", address, amount, payHash, at: Date.now() }, hTag).catch(() => {});
    return fail(res, 502, codes ? "send_failed" : "send_unknown", { retryAfter: codes ? 10 : 90 });
  }
};
