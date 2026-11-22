import "./landing.css";
import "./hero.js";
import "./motion.js";
import "./skin.css";

// Canli testnet rakamlari: bolume yaklasinca zincirden okunur; okunamazsa bolum gizli kalir.
const live = document.getElementById("live");
if (live && import.meta.env.VITE_FACTORY) {
  live.hidden = false;
  const io = new IntersectionObserver(
    async ([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      try {
        const { loadStats } = await import("./stats.js");
        const v = await loadStats();
        const n = (x, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d });
        document.getElementById("live-vaults").textContent = n(v.vaults);
        document.getElementById("live-open").textContent = n(v.open);
        document.getElementById("live-filled").textContent = n(v.filled);
        document.getElementById("live-tvl").textContent = `$${n(v.tvl, v.tvl < 1000 ? 2 : 0)}`;
        live.classList.add("ready");
      } catch {
        live.hidden = true;
      }
    },
    { rootMargin: "300px 0px" },
  );
  io.observe(live);
}

const form = document.getElementById("betaform");
const msg = document.getElementById("betamsg");

function show(text, kind) {
  msg.textContent = text;
  msg.className = `formmsg ${kind}`;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TELEGRAM = /^@?[A-Za-z0-9_]{5,32}$/;

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const contact = String(data.contact || "").trim();
  if (!EMAIL.test(contact) && !TELEGRAM.test(contact)) {
    return show("Enter a valid email or Telegram username (e.g. @username).", "err");
  }
  const wallet = String(data.wallet || "").trim().toUpperCase();
  if (!wallet) return show("Enter your Stellar wallet address (it starts with G).", "err");
  if (!/^G[A-Z2-7]{55}$/.test(wallet)) {
    return show("That wallet address does not look right. It starts with G and has 56 characters.", "err");
  }
  if (!data.consent) return show("Tick the consent box to continue.", "err");

  const button = form.querySelector("button");
  button.disabled = true;
  show("Sending…", "");
  try {
    const res = await fetch("/api/beta", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...data, contact, wallet, consent: true }),
    });
    if (!res.ok) throw new Error(String(res.status));
    form.reset();
    show("You are on the list. We will contact you when the beta starts.", "ok");
  } catch (e) {
    show(e && e.message === "429" ? "Too many sign-ups from this connection. Please try again in a few minutes." : "Could not send your sign-up. Please try again shortly.", "err");
  } finally {
    button.disabled = false;
  }
});

// Bekleyen emrin kazanci: emir defteri ile Iora karsilastirmasi (ornek oranla)
const calc = document.getElementById("calc");
if (calc) {
  const $ = (id) => document.getElementById(id);
  const usd = (v, d = 2) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const update = () => {
    // Tutar kaydiricisi katlanarak buyur: 100 USDC -> 1.000.000 USDC (0..100 konum), iki anlamli basamaga yuvarlanir.
    const raw = 100 * Math.pow(10, Number($("c-amount").value) / 25);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)) - 1);
    const amount = Math.round(raw / mag) * mag;
    const days = Number($("c-days").value);
    const apy = Number($("c-apy").value) / 100;
    const earned = (amount * apy * days) / 365;
    $("c-amount-v").textContent = `${usd(amount, 0)} USDC`;
    $("c-days-v").textContent = `${days} day${days === 1 ? "" : "s"}`;
    $("c-apy-v").textContent = `${usd(apy * 100, 1)}% a year`;
    $("c-earn").textContent = `+${usd(earned)} USDC`;
    // Cubuk: kazancin tutara orani, kaydiricilarin en yuksek degerine gore
    const share = (apy * days) / 365 / ((0.15 * 180) / 365);
    $("c-bar").style.setProperty("--w", `${(6 + 94 * share).toFixed(1)}%`);
  };
  calc.addEventListener("input", update);
  update();
}
