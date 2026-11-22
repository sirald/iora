// Vercel sunucusuz fonksiyonu: beta kaydini sahibin Telegram'ina iletir. Hicbir yerde saklamaz.
// Gerekli ortam degiskenleri: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (set by scripts/deploy-web.sh).
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TELEGRAM = /^@?[A-Za-z0-9_]{5,32}$/;
const LEVELS = { yeni: "Hic kullanmadim", biraz: "Cuzdani var", deneyimli: "DeFi kullaniyor" };
// Only form posts from our own site (browsers always add the Origin header).
const ORIGINS = /^https:\/\/(iorafi\.com|www\.iorafi\.com|berthly[a-z0-9-]*\.vercel\.app)$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
// Basit sel korumasi (sunucu ornegi basina): ayni IP 10 dakikada en fazla 3, toplamda saatte en fazla 30 kayit.
// Amac, sahte kayit seliyle Telegram'in hiz sinirina takilip keeper uyarilarinin gecikmesini onlemek.
const hits = new Map();
let hourStart = 0;
let hourCount = 0;
function limited(ip) {
  const now = Date.now();
  if (now - hourStart > 3600_000) {
    hourStart = now;
    hourCount = 0;
    hits.clear();
  }
  const list = (hits.get(ip) || []).filter((t) => now - t < 600_000);
  if (list.length >= 3 || hourCount >= 30) return true;
  list.push(now);
  hits.set(ip, list);
  hourCount++;
  return false;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ ok: false });
  const origin = String(req.headers.origin || "");
  // Browsers always send Origin on a form POST; a request without it is a script, not our form.
  if (!ORIGINS.test(origin)) return res.status(403).json({ ok: false });
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "?").split(",")[0].trim();
  if (limited(ip)) return res.status(429).json({ ok: false, error: "too_many" });
  let body = req.body || {};
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ ok: false });
    }
  }
  // Bot tuzagi: gercek kullanicilar bu alani gormez.
  if (body.website) return res.status(200).json({ ok: true });

  const contact = String(body.contact || "").trim().slice(0, 120);
  // Ad serbest metin: satir sonu ve kontrol karakterleri temizlenir ki Telegram mesajina sahte
  // satir (or. sahte bir "calistir" komutu) eklenemesin.
  const name = String(body.name || "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  const level = LEVELS[body.level] || "belirtilmedi";
  const wallet = String(body.wallet || "").trim().toUpperCase();
  if (!/^G[A-Z2-7]{55}$/.test(wallet)) return res.status(400).json({ ok: false });
  if (!(EMAIL.test(contact) || TELEGRAM.test(contact)) || body.consent !== true) {
    return res.status(400).json({ ok: false });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  // Ayri bir sohbet tanimlanmissa beta kayitlari oraya gider (keeper uyarilariyla karismaz).
  const chat = process.env.TELEGRAM_BETA_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return res.status(500).json({ ok: false });

  const text = `[Iora] New beta sign-up\nContact: ${contact}\nName: ${name || "-"}\nExperience: ${level}\nWallet: ${wallet}\nTo allow it: bash scripts/access.sh wallet ${wallet}`;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    return res.status(r.ok ? 200 : 502).json({ ok: r.ok });
  } catch {
    return res.status(502).json({ ok: false });
  }
};
