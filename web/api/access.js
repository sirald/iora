// Access control for the testnet app (invite code or allowed wallet).
// Codes and wallets live in secret environment variables on the server; they do not appear in the site's code:
//   IORA_ACCESS_CODES    comma-separated invite codes (case does not matter)
//   IORA_ALLOWED_WALLETS comma-separated Stellar addresses (G...)
//   IORA_ACCESS_SECRET   a long random text used to sign access tickets
// Note: this is an entry gate, not a security boundary. The contracts are open to everyone on-chain.
// A ticket obtained with a wallet is bound to that wallet: if the connected wallet is not the address in the
// ticket, the app closes the gate again. Someone who types another person's address cannot sign transactions
// with that wallet, so they cannot use the app.
const crypto = require("crypto");

const DAYS = 30;
const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
const b64 = (s) => Buffer.from(s).toString("base64url");
const sign = (data, secret) => crypto.createHmac("sha256", secret).update(data).digest("base64url");
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function issue(sub, secret) {
  const payload = b64(JSON.stringify({ sub, exp: Date.now() + DAYS * 864e5 }));
  return `${payload}.${sign(payload, secret)}`;
}

/** Returns the ticket's subject ("code" or a wallet address) if it is valid, otherwise null. */
function verify(token, secret) {
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig || !same(sig, sign(payload, secret))) return null;
  try {
    const { sub, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof exp === "number" && exp > Date.now() ? String(sub) : null;
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  const secret = process.env.IORA_ACCESS_SECRET;
  if (!secret) return res.status(500).json({ ok: false, error: "not configured" });

  let body = req.body || {};
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  if (req.method === "GET" || body.token) {
    const token = req.method === "GET" ? req.query && req.query.token : body.token;
    const sub = verify(token, secret);
    return res.status(200).json(sub ? { ok: true, sub } : { ok: false });
  }
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  const code = String(body.code || "").trim().toLowerCase().slice(0, 64);
  const address = String(body.address || "").trim().toUpperCase().slice(0, 56);

  if (code) {
    const ok = list(process.env.IORA_ACCESS_CODES).some((c) => same(c.toLowerCase(), code));
    // Slow down guessing attempts
    if (!ok) await new Promise((r) => setTimeout(r, 800));
    return res.status(200).json(ok ? { ok: true, token: issue("code", secret) } : { ok: false });
  }
  if (/^G[A-Z2-7]{55}$/.test(address)) {
    const ok = list(process.env.IORA_ALLOWED_WALLETS).some((w) => w.toUpperCase() === address);
    return res.status(200).json(ok ? { ok: true, token: issue(address, secret) } : { ok: false });
  }
  return res.status(400).json({ ok: false });
};
