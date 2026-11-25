// Iora landing: the interest calculator, the beta form's request, and the page's own motion (the kit's motion
// layer, kit/motion, does the rest: the hero's entrance, buttons, links and the looping cards).
const html = document.documentElement;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const motionOff = () => html.dataset.motion === "off";
const still = () => reduced() || motionOff();
const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const EASE_IO = "cubic-bezier(0.65, 0, 0.35, 1)";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v, d = 2) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
/** Calls fn once, when el is in view (at least `share` of it); never if it was already in view when the page opened. */
function whenSeen(el, share, fn, { atLoad } = {}) {
  if (!el || typeof IntersectionObserver !== "function") return;
  let first = true;
  const io = new IntersectionObserver((entries) => {
    const e = entries[entries.length - 1];
    const was = first;
    first = false;
    if (!e.isIntersecting || e.intersectionRatio < share) {
      if (was && atLoad) atLoad(false);
      return;
    }
    io.disconnect();
    if (was && atLoad) atLoad(true);
    else fn();
  }, { threshold: [0, share, 1] });
  io.observe(el);
}

// ---- the interest calculator ------------------------------------------------------------------------------
// What a waiting order earns: an order book pays nothing, a vault earns the rate the visitor sets.
const calc = document.getElementById("calc");
const $ = (id) => document.getElementById(id);
function calcState() {
  // The size slider grows exponentially: 100 USDC -> 1,000,000 USDC (positions 0..100), rounded to two significant digits.
  const raw = 100 * Math.pow(10, Number($("c-amount").value) / 25);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)) - 1);
  const amount = Math.round(raw / mag) * mag;
  const days = Number($("c-days").value);
  const rate = Number($("c-apy").value) / 100;
  const earned = (amount * rate * days) / 365;
  // The bar: interest relative to the order's size, scaled to the sliders' highest values (15% for 180 days).
  const share = (rate * days) / 365 / ((0.15 * 180) / 365);
  return { amount, days, rate, earned, k: 0.04 + 0.96 * share };
}
let firstLook = null; // the calculator's first appearance, while it runs
if (calc) {
  const update = () => {
    const s = calcState();
    $("c-amount-v").textContent = `${num(s.amount, 0)} USDC`;
    $("c-days-v").textContent = `${s.days} day${s.days === 1 ? "" : "s"}`;
    $("c-apy-v").textContent = `${num(s.rate * 100, 1)}% a year`;
    $("c-earn").textContent = `+${num(s.earned)} USDC`;
    $("c-bar").style.setProperty("--k", s.k.toFixed(3));
  };
  calc.addEventListener("input", () => {
    if (firstLook) firstLook.stop();
    update();
  });
  calc.addEventListener("submit", (e) => e.preventDefault());
  update();
  // The first time the calculator comes into view, the vault's bar grows from nothing and its figure counts up,
  // beside the order book's bar that stays at nothing. Moving a slider is instant as before.
  if (!still()) {
    const bar = $("c-bar"), earn = $("c-earn");
    let pending = false;
    whenSeen(calc, 0.4, () => {
      if (!pending) return;
      const s = calcState();
      let raf = 0;
      const t0 = performance.now();
      firstLook = { stop() { cancelAnimationFrame(raf); bar.style.removeProperty("--dur"); firstLook = null; } };
      bar.style.setProperty("--dur", "700ms");
      bar.style.setProperty("--k", s.k.toFixed(3));
      const step = (t) => {
        const k = Math.min(1, (t - t0) / 700);
        earn.textContent = `+${num(s.earned * (1 - Math.pow(1 - k, 3)))} USDC`;
        if (k < 1) raf = requestAnimationFrame(step);
        else if (firstLook) firstLook.stop();
      };
      raf = requestAnimationFrame(step);
    }, {
      atLoad(inView) {
        if (inView) return; // already on screen: nothing waits
        pending = true;
        bar.style.setProperty("--dur", "0ms");
        bar.style.setProperty("--k", "0");
        earn.textContent = "+0.00 USDC";
      },
    });
  }
}

// The beta form. The kit checks the fields and sends the form as form data; the site's function (/api/beta)
// takes JSON. This turns that one request into JSON and leaves every other request alone.
const nativeFetch = window.fetch.bind(window);
window.fetch = (url, opt) => {
  if (url === "/api/beta" && opt && opt.body instanceof FormData) {
    const f = opt.body;
    const body = { x: String(f.get("x") || ""), wallet: String(f.get("wallet") || ""), website: String(f.get("website") || "") };
    return nativeFetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  }
  return nativeFetch(url, opt);
};

// ---- the hero: interest that keeps adding up -------------------------------------------------------------
// The Portfolio window's "Interest earned" counts on by the second at the rate the window shows (USDC at 6.42% and
// XLM at 0.84% on the balances in it: about 0.00013 USDC a second). Only the digits that change move.
(() => {
  const el = [...document.querySelectorAll(".hero__window .mk-kpi")].find((k) => /Interest earned/.test(k.textContent));
  const b = el && el.querySelector("b");
  if (!b || motionOff()) return;
  const node = [...b.childNodes].find((n) => n.nodeType === 3 && /\d/.test(n.textContent));
  if (!node) return;
  const start = Number(node.textContent.replace(/[^\d.]/g, ""));
  const perSecond = (60587.5 * 0.0642 + 241005 * 0.1311 * 0.0084) / 31_536_000;
  const live = document.createElement("span");
  live.className = "mk-live";
  b.replaceChild(live, node);
  b.insertBefore(document.createTextNode(" "), live.nextSibling);
  let seconds = 0;
  let shown = "";
  const paint = () => {
    const txt = `+${(start + seconds * perSecond).toFixed(6)}`;
    live.innerHTML = [...txt].map((ch, i) => `<span${shown && shown.length === txt.length && shown[i] !== ch && !reduced() ? ' class="roll"' : ""}>${ch}</span>`).join("");
    shown = txt;
  };
  paint();
  let on = true;
  if (typeof IntersectionObserver === "function") new IntersectionObserver((e) => (on = e[e.length - 1].isIntersecting)).observe(b);
  setInterval(() => {
    if (!on || document.hidden) return;
    seconds++;
    paint();
  }, 1000);
})();

// ---- "Every order and what it earned": order #18 fills, once ---------------------------------------------
(() => {
  const win = document.querySelector("#product .mk-td");
  if (!win || still()) return;
  const rows = [...win.querySelectorAll(".mk-deck .mk-tr")];
  const row = rows.find((r) => r.firstElementChild && r.firstElementChild.textContent.trim() === "#18");
  if (!row) return;
  const cells = row.children;
  const filled = cells[3], tag = row.querySelector(".mk-tag"), cancel = row.querySelector(".mk-x");
  const tab = win.querySelector(".mk-deck .mk-tabs .is-on");
  const xlm = [...win.querySelectorAll(".mk-acct .mk-row")].find((r) => /XLM in vault/.test(r.textContent));
  whenSeen(win, 0.45, async () => {
    // the filled share counts up to 100%
    const t0 = performance.now();
    await new Promise((done) => {
      const step = (t) => {
        const k = Math.min(1, (t - t0) / 900);
        filled.textContent = `${Math.round(100 * (1 - Math.pow(1 - k, 2)))}%`;
        if (k < 1) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
    // the tag says Filled; the row goes quiet; Cancel goes
    tag.textContent = "Filled";
    tag.classList.add("mk-tag--done");
    tag.animate([{ opacity: 0, filter: "blur(2px)" }, { opacity: 1, filter: "none" }], { duration: 200, easing: "ease" });
    row.classList.add("mk-done");
    if (cancel) cancel.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: EASE, fill: "forwards" });
    if (tab) tab.textContent = "Orders · 2";
    await wait(150);
    // the XLM it bought arrives in the vault
    const b = xlm && xlm.querySelector("b");
    if (b) {
      b.textContent = "291,325.51";
      b.animate([{ transform: "translateY(40%)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 260, easing: EASE });
      b.animate([{ color: "var(--mk-up)" }, { color: "var(--mk-up)", offset: 0.4 }, {}], { duration: 1400, easing: "ease" });
    }
    await wait(150);
    // and the notice comes up in the corner, then goes back down
    const note = document.createElement("div");
    note.className = "mk-note";
    note.setAttribute("aria-hidden", "true");
    note.innerHTML = `<i>✓</i><div><b>Order #18 filled</b><span>200,320.51 XLM at 0.1248 USDC</span></div>`;
    (win.querySelector(".mk-chartbig") || win).appendChild(note); // over the empty corner of the chart, clear of the balances
    note.animate([{ transform: "translateY(calc(100% + 16px))", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 400, easing: "ease", fill: "both" });
    await wait(3600);
    const out = note.animate([{ transform: "none", opacity: 1 }, { transform: "translateY(calc(100% + 16px))", opacity: 0 }], { duration: 220, easing: "cubic-bezier(0.23, 1, 0.32, 1)", fill: "forwards" });
    out.onfinish = () => note.remove();
  });
})();

// ---- "An order in 3 steps": the pictures open from the top as they come into view ----------------------------
(() => {
  const panels = [...document.querySelectorAll("#how .card .panel")];
  if (!panels.length || still() || typeof IntersectionObserver !== "function") return;
  const below = panels.filter((p) => p.getBoundingClientRect().top > innerHeight);
  if (!below.length) return;
  for (const p of below) p.classList.add("is-veiled");
  const io = new IntersectionObserver((entries) => {
    const seen = entries.filter((e) => e.isIntersecting).map((e) => e.target);
    seen.forEach((p, i) => {
      io.unobserve(p);
      p.animate([{ clipPath: "inset(0 0 100% 0)" }, { clipPath: "inset(0 0 0 0)" }], { duration: 600, delay: [0, 60, 110][i] || 110, easing: EASE_IO, fill: "backwards" });
      p.classList.remove("is-veiled");
    });
  }, { rootMargin: "0px 0px -80px 0px" });
  for (const p of below) io.observe(p);
  // if something stops the observer, the pictures do not stay hidden
  setTimeout(() => { for (const p of below) if (p.classList.contains("is-veiled") && p.getBoundingClientRect().top < innerHeight) p.classList.remove("is-veiled"); }, 6000);
})();

// ---- the order types: each says what it is in the line under them ----------------------------------------
(() => {
  const list = document.querySelector(".how__types");
  const note = document.querySelector(".how__note");
  if (!list || !note) return;
  const items = [...list.querySelectorAll("li[data-note]")];
  if (!items.length) return;
  const first = note.textContent.trim();
  note.classList.add("is-swap");
  note.innerHTML = "<span></span><span class=\"is-off\" aria-hidden=\"true\"></span>";
  const [a, b] = note.children;
  a.textContent = first;
  let front = a;
  let current = first;
  const show = (li) => {
    for (const x of items) x.classList.toggle("is-on", x === li);
    const text = li.dataset.note;
    if (text === current) return;
    current = text;
    const back = front === a ? b : a;
    back.textContent = text;
    back.classList.remove("is-off");
    back.removeAttribute("aria-hidden");
    front.classList.add("is-off");
    front.setAttribute("aria-hidden", "true");
    front = back;
  };
  for (const li of items) {
    li.addEventListener("pointerenter", () => { list.classList.add("is-pointing"); show(li); });
    li.addEventListener("focus", () => { list.classList.add("is-pointing"); show(li); });
    li.addEventListener("click", () => show(li));
  }
  list.addEventListener("pointerleave", () => list.classList.remove("is-pointing"));
  list.addEventListener("focusout", (e) => { if (!list.contains(e.relatedTarget)) list.classList.remove("is-pointing"); });
})();

// ---- the beta form: once it is sent, the first step of "After you join" is ticked ---------------------------
(() => {
  const form = document.querySelector("#beta form.form");
  const status = form && form.querySelector("[data-form-status]");
  const panel = document.querySelector(".ui-checks--next");
  if (!status || !panel) return;
  const sent = form.dataset.sent || "";
  new MutationObserver(() => {
    if (!sent || status.textContent.trim() !== sent) return;
    const step = panel.querySelector(".ui-check");
    const bar = panel.querySelector(".ui-checks__bar i");
    const meta = panel.querySelector(".ui-meta");
    if (!step || step.classList.contains("is-done")) return;
    step.classList.add("is-done", "is-now");
    setTimeout(() => step.classList.remove("is-now"), 420);
    if (bar) bar.style.setProperty("--k", "0.25");
    if (meta) meta.textContent = "1 of 4";
  }).observe(status, { childList: true, characterData: true, subtree: true });
})();
