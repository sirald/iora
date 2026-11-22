// Testnet uygulamasina erisim kontrolu (davet kodu veya izinli cuzdan).
// Kodlar ve cuzdanlar sunucuda gizli ortam degiskenlerinde durur, sitenin kodunda gorunmez:
//   IORA_ACCESS_CODES    virgulle ayrilmis davet kodlari (buyuk/kucuk harf fark etmez)
//   IORA_ALLOWED_WALLETS virgulle ayrilmis Stellar adresleri (G...)
//   IORA_ACCESS_SECRET   erisim biletlerini imzalamak icin rastgele uzun bir metin
// Not: bu bir giris kapisidir, guvenlik siniri degil. Kontratlar zincirde herkese aciktir.
// Cuzdanla alinan bilet o cuzdana baglidir: uygulama, bagli cuzdan biletteki adresle ayni degilse
// kapiyi yeniden kapatir. Baska birinin adresini yazan kisi o cuzdanla islem imzalayamayacagi icin
// uygulamayi kullanamaz.
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

/** Gecerliyse biletin sahibini ("code" ya da cuzdan adresi) dondurur, degilse null. */
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
    // Tahmin denemelerini yavaslat
    if (!ok) await new Promise((r) => setTimeout(r, 800));
    return res.status(200).json(ok ? { ok: true, token: issue("code", secret) } : { ok: false });
  }
  if (/^G[A-Z2-7]{55}$/.test(address)) {
    const ok = list(process.env.IORA_ALLOWED_WALLETS).some((w) => w.toUpperCase() === address);
    return res.status(200).json(ok ? { ok: true, token: issue(address, secret) } : { ok: false });
  }
  return res.status(400).json({ ok: false });
};
