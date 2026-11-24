// Vercel serverless function: forwards a beta sign-up to the owner's Telegram and keeps it in a PRIVATE Vercel
// Blob store, one small file per wallet (beta/<wallet>.json), so the sign-ups can be counted and listed
// (bash scripts/beta.sh count | list). The same wallet signing up again replaces its own file: one wallet counts once.
// If the store is missing or over its free quota the sign-up still reaches Telegram; nothing is lost.
// Required environment variables: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (set by scripts/deploy-web.sh).
// The store is created once with: bash scripts/beta.sh setup
// Only form posts from our own site (browsers always add the Origin header).
const ORIGINS = /^https:\/\/(iorafi\.com|www\.iorafi\.com|berthly[a-z0-9-]*\.vercel\.app)$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
// Simple flood protection (per server instance): at most 3 sign-ups per IP in 10 minutes, 30 per hour in total.
// The aim is to keep a flood of fake sign-ups from hitting Telegram's rate limit and delaying keeper alerts.
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
  // Bot trap: real users never see this field.
  if (body.website) return res.status(200).json({ ok: true });

  // The form asks for two things only: an X (Twitter) handle and a Stellar address.
  const handle = String(body.x || "").trim().replace(/^@/, "");
  const wallet = String(body.wallet || "").trim().toUpperCase();
  if (!/^G[A-Z2-7]{55}$/.test(wallet) || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) return res.status(400).json({ ok: false });
  const token = process.env.TELEGRAM_BOT_TOKEN;
  // If a separate chat is configured, beta sign-ups go there (they do not mix with keeper alerts).
  const chat = process.env.TELEGRAM_BETA_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return res.status(500).json({ ok: false });

  // Keep the sign-up (private store) and count the wallets so far. Never blocks the Telegram message.
  let total = null;
  try {
    const { put, list } = require("@vercel/blob");
    const record = { wallet, x: handle, at: new Date().toISOString() };
    await put(`beta/${wallet}.json`, JSON.stringify(record), { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" });
    let n = 0;
    let cursor;
    for (let page = 0; page < 20; page++) {
      const r = await list({ prefix: "beta/", limit: 1000, cursor });
      n += r.blobs.length;
      if (!r.hasMore) break;
      cursor = r.cursor;
    }
    total = n;
  } catch (e) {
    console.error("beta store:", String((e && e.message) || e).slice(0, 200));
  }
  const tally = total === null ? "Not saved to the list (store unavailable); this message is the only copy." : `Sign-ups so far: ${total} wallet${total === 1 ? "" : "s"}`;
  const text = `[Iora] New beta sign-up\nX: @${handle}  https://x.com/${handle}\nWallet: ${wallet}\n${tally}\nTo allow it: bash scripts/access.sh wallet ${wallet}`;
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
