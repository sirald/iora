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

/** A cell whose amount keeps adding up: "+465.50" or "+61.56 USDC" turns into the same amount with as many decimals
    as its column has room for (six, four or the two it had); only the digits that change move. */
function liveCell(cell) {
  const m = cell && /^([+-]?)([\d,]+\.\d+)(.*)$/.exec(cell.textContent.trim());
  if (!m) return null;
  const sign = m[1], start = Number(m[2].replace(/,/g, "")), unit = m[3];
  const live = document.createElement("span");
  live.className = "mk-live";
  cell.replaceChildren(live, ...(unit ? [document.createTextNode(unit)] : []));
  let shown = "", places = 6;
  const paint = (v, roll = true) => {
    const txt = sign + num(v, places);
    if (txt === shown) return;
    live.innerHTML = [...txt].map((ch, i) => `<span${roll && shown.length === txt.length && shown[i] !== ch && !reduced() ? ' class="roll"' : ""}>${ch}</span>`).join("");
    shown = txt;
  };
  const fit = (v) => {
    for (places of [6, 4, 2]) {
      shown = "";
      paint(v, false);
      if (cell.scrollWidth <= cell.clientWidth + 0.5) return;
    }
  };
  return { start, paint, fit };
}
/** Runs fn again when the layout may have changed the room a number has: a resize, or the page's fonts arriving. */
function onRelayout(fn) {
  let t = 0;
  addEventListener("resize", () => { clearTimeout(t); t = setTimeout(fn, 150); });
  if (document.fonts) document.fonts.ready.then(fn);
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
  // the balances under it add up on the same clock: the USDC row at 6.42%, the XLM row at 0.84% (their sum at the
  // window's price, 0.1311, is the total above)
  const rows = [...document.querySelectorAll(".hero__window .mk-pf .mk-tr")];
  const earned = [["USDC", (60587.5 * 0.0642) / 31_536_000], ["XLM", (241005 * 0.0084) / 31_536_000]].map(([coin, rate]) => {
    const row = rows.find((r) => r.firstElementChild && r.firstElementChild.textContent.trim() === coin);
    const c = row && liveCell(row.lastElementChild);
    return c && { ...c, rate };
  }).filter(Boolean);
  let seconds = 0;
  let shown = "", places = 6;
  const paint = () => {
    const txt = `+${(start + seconds * perSecond).toFixed(places)}`;
    live.innerHTML = [...txt].map((ch, i) => `<span${shown && shown.length === txt.length && shown[i] !== ch && !reduced() ? ' class="roll"' : ""}>${ch}</span>`).join("");
    shown = txt;
    for (const e of earned) e.paint(e.start + seconds * e.rate);
  };
  // the total keeps as many decimals as its box has room for (a phone's two boxes a row are narrow)
  const refit = () => {
    for (places of [6, 4, 2]) {
      shown = "";
      paint();
      if (el.scrollWidth <= el.clientWidth + 0.5) break;
    }
    for (const e of earned) e.fit(e.start + seconds * e.rate);
  };
  refit();
  onRelayout(refit);
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

// ---- "Every order and what it earned": what the open orders earn adds up by the second while they wait ---------
// At the rates the window shows: #18's 25,000 USDC at 6.42% (until it fills), the 90,000 XLM of #17 that has not sold
// yet at 0.84%, and #16's DCA at the pace of what it has earned so far (2.11 USDC in 9 days). Filled orders keep theirs.
(() => {
  const win = document.querySelector("#product .mk-td");
  if (!win || motionOff()) return;
  const YEAR = 31_536_000;
  const rates = { "#18": (25000 * 0.0642) / YEAR, "#17": (90000 * 0.0084) / YEAR, "#16": 2.11 / (9 * 86400) };
  const cells = [...win.querySelectorAll(".mk-deck .mk-tr")].map((row) => {
    const id = row.firstElementChild && row.firstElementChild.textContent.trim();
    if (!(id in rates)) return null;
    const c = liveCell(row.children[4]);
    return c && { ...c, row, rate: rates[id], until: Infinity };
  }).filter(Boolean);
  if (!cells.length) return;
  let seconds = 0;
  const value = (c) => c.start + Math.min(seconds, c.until) * c.rate;
  const paint = () => {
    for (const c of cells) {
      if (c.until === Infinity && c.row.classList.contains("mk-done")) c.until = seconds; // it filled: it stops earning
      c.paint(value(c));
    }
  };
  const refit = () => { for (const c of cells) c.fit(value(c)); };
  refit();
  onRelayout(refit);
  let on = false;
  if (typeof IntersectionObserver === "function") new IntersectionObserver((e) => (on = e[e.length - 1].isIntersecting)).observe(win);
  setInterval(() => {
    if (!on || document.hidden) return;
    seconds++;
    paint();
  }, 1000);
})();

// ---- "Every order and what it earned": the chart lives -----------------------------------------------------------
// It draws itself in from the left the first time it is seen, then trades: about twice a second the last candle's
// close moves a little and the price, the 24h change, high and low above it follow; every six moves a new candle
// opens and the chart slides one candle to the left. Where the price crosses a dashed order line, a small ring, as
// when an order fills there. Under the pointer, a crosshair: a line on the nearest candle and one at the pointer's
// height, the price there on the right edge and that candle's open, high, low and close beside the tabs.
// It trades only while it is on screen and the tab is visible, has a pause button under the window's corner, and
// holds still under reduced motion and with data-motion="off". The price scale is the drawing's own: 0.1300 at y 64
// and 0.1250 at y 212 (the two order lines); the last close, y 35.5, is the 0.1311 above the chart.
(() => {
  const win = document.querySelector("#product .mk-td");
  const box = win && win.querySelector(".mk-chartbig");
  const svg = box && box.querySelector("svg");
  if (!svg) return;
  const NS = "http://www.w3.org/2000/svg", STEP = 12.5, HALF = 3.75;
  const K = 0.005 / 148, Y0 = 35.5, P0 = 0.1311;
  const price = (y) => P0 + (Y0 - y) * K;
  const fmt = (p) => p.toFixed(4);

  // the candles as the page drew them (a wick, then its body), moved into one group that can slide
  const levels = [...svg.querySelectorAll(":scope > line.o")];
  const g = document.createElementNS(NS, "g");
  const candles = [];
  for (const w of [...svg.querySelectorAll(":scope > line:not(.o)")]) {
    const b = w.nextElementSibling;
    if (!b || b.tagName.toLowerCase() !== "rect") continue;
    const up = w.classList.contains("u"), top = +b.getAttribute("y"), h = +b.getAttribute("height");
    candles.push({ w, b, x: +w.getAttribute("x1"), hi: +w.getAttribute("y1"), lo: +w.getAttribute("y2"), open: up ? top + h : top, close: up ? top : top + h });
    g.append(w, b);
  }
  if (!candles.length) return;
  svg.append(g);
  let shift = 0;
  const paint = (c) => {
    const cls = c.close <= c.open ? "u" : "d"; // y grows downward: a close above the open is a rise
    c.w.setAttribute("class", cls);
    c.b.setAttribute("class", cls);
    c.w.setAttribute("y1", c.hi.toFixed(1));
    c.w.setAttribute("y2", c.lo.toFixed(1));
    c.b.setAttribute("y", Math.min(c.open, c.close).toFixed(1));
    c.b.setAttribute("height", Math.max(1.5, Math.abs(c.open - c.close)).toFixed(1));
  };

  // the first look: below the fold at load, the chart waits behind a clip and draws in from the left when seen
  let readyAt = 0;
  if (!still() && typeof IntersectionObserver === "function" && svg.getBoundingClientRect().top > innerHeight) {
    svg.classList.add("is-undrawn");
    readyAt = Infinity;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      svg.animate([{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], { duration: 800, easing: EASE_IO, fill: "backwards" });
      svg.classList.remove("is-undrawn");
      readyAt = performance.now() + 800;
      go();
    }, { rootMargin: "0px 0px -80px 0px" });
    io.observe(svg);
    // if something stops the observer, the chart does not stay hidden
    setTimeout(() => {
      if (!svg.classList.contains("is-undrawn") || svg.getBoundingClientRect().top >= innerHeight) return;
      io.disconnect();
      svg.classList.remove("is-undrawn");
      readyAt = 0;
      go();
    }, 6000);
  }

  // the numbers above the chart follow the price
  const strip = win.querySelector(".mk-strip");
  const pxEl = strip && strip.querySelector(".mk-px");
  const cell = (label) => {
    const s = strip && [...strip.querySelectorAll(":scope > span")].find((c) => (c.querySelector("i") || {}).textContent === label);
    return s ? s.querySelector("b") : null;
  };
  const chg = cell("24h change"), hiEl = cell("24h high"), loEl = cell("24h low");
  const P24 = P0 / 1.0106;
  let dayHi = 0.134, dayLo = 0.1288;
  const showPrice = (p, dir) => {
    if (!pxEl) return;
    const t = fmt(p);
    if (pxEl.textContent === t) return;
    pxEl.textContent = t;
    if (dir && !reduced()) pxEl.animate([{ color: dir > 0 ? "var(--mk-up)" : "var(--mk-down)" }, { color: "var(--u-ink)" }], { duration: 600, easing: "ease-out" });
    if (chg) {
      const pct = (p / P24 - 1) * 100;
      chg.textContent = `${pct >= 0 ? "+" : "\u2212"}${Math.abs(pct).toFixed(2)}%`;
      chg.classList.toggle("mk-up", pct >= 0);
      chg.style.color = pct >= 0 ? "" : "var(--mk-down)";
    }
    if (p > dayHi && hiEl) { dayHi = p; hiEl.textContent = fmt(p); }
    if (p < dayLo && loEl) { dayLo = p; loEl.textContent = fmt(p); }
  };

  // the trading
  const local = () => {
    const bb = box.getBoundingClientRect(), sb = svg.getBoundingClientRect();
    return { x: sb.left - bb.left - box.clientLeft, y: sb.top - bb.top - box.clientTop, w: sb.width, h: sb.height };
  };
  const ring = (line, vx, vy) => {
    const l = local(), r = document.createElement("i");
    r.className = "mk-ring" + (line.classList.contains("s") ? " mk-ring--s" : "");
    r.setAttribute("aria-hidden", "true");
    r.style.left = `${l.x + (vx / 900) * l.w}px`;
    r.style.top = `${l.y + (vy / 300) * l.h}px`;
    box.append(r);
    r.animate([{ transform: "scale(0.14)", opacity: 0.9 }, { transform: "scale(1)", opacity: 0 }], { duration: 1200, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }).onfinish = () => r.remove();
    line.animate([{ opacity: 1 }, { opacity: 0.7 }], { duration: 1200, easing: "ease-out" });
  };
  const tween = (c, a, b) => {
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 200), e = 1 - Math.pow(1 - k, 3);
      c.close = a + (b - a) * e;
      c.hi = Math.min(c.hi, c.close);
      c.lo = Math.max(c.lo, c.close);
      paint(c);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const slide = () => {
    const a = shift, t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 450), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      shift = a + STEP * e;
      g.setAttribute("transform", `translate(${(-shift).toFixed(2)} 0)`);
      if (k < 1) return requestAnimationFrame(step);
      while (candles.length > 1 && candles[0].x - shift < -STEP) { const o = candles.shift(); o.w.remove(); o.b.remove(); }
    };
    requestAnimationFrame(step);
  };
  const open = () => {
    const prev = candles[candles.length - 1], x = prev.x + STEP;
    const w = document.createElementNS(NS, "line"), b = document.createElementNS(NS, "rect");
    w.setAttribute("x1", x.toFixed(1));
    w.setAttribute("x2", x.toFixed(1));
    b.setAttribute("x", (x - HALF).toFixed(1));
    b.setAttribute("width", "7.5");
    b.setAttribute("rx", "1");
    const c = { w, b, x, open: prev.close, close: prev.close, hi: prev.close, lo: prev.close };
    paint(c);
    g.append(w, b);
    candles.push(c);
    slide();
  };
  // where the price leans: a slow swell (95 s of trading) and a shorter one (31 s), so it comes down to the 0.1300
  // line now and then
  const lean = (t) => 62 + 40 * Math.sin((t * 2 * Math.PI) / 95 - 0.7) + 14 * Math.sin((t * 2 * Math.PI) / 31);
  const gauss = () => { let u = 0; while (!u) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()); };
  let T = 0, moves = 0, timer = 0, running = false, onScreen = false, paused = false;
  const move = () => {
    const c = candles[candles.length - 1];
    T += 1.1;
    const from = c.close;
    const to = Math.max(10, Math.min(286, from + (lean(T) - from) * 0.12 + gauss() * 3));
    if (Math.random() < 0.3) c.hi = Math.min(c.hi, Math.min(from, to) - Math.random() * 4);
    if (Math.random() < 0.3) c.lo = Math.max(c.lo, Math.max(from, to) + Math.random() * 4);
    for (const line of levels) {
      const ly = +line.getAttribute("y1");
      if ((from - ly) * (to - ly) < 0) ring(line, c.x - shift, ly);
    }
    tween(c, from, to);
    showPrice(price(to), Math.sign(from - to));
    if (++moves % 6 === 0) setTimeout(() => running && open(), 260);
  };
  const step = () => {
    if (!running) return;
    if (still()) { running = false; return; }
    move();
    timer = setTimeout(step, 450 + Math.random() * 300);
  };
  const go = () => {
    const want = onScreen && !paused && !document.hidden && !still() && readyAt !== Infinity;
    if (want && !running) {
      running = true;
      timer = setTimeout(step, Math.max(0, readyAt - performance.now()) + 400);
    } else if (!want && running) {
      running = false;
      clearTimeout(timer);
    }
  };
  if (!still() && typeof IntersectionObserver === "function") {
    new IntersectionObserver((e) => { onScreen = e[e.length - 1].isIntersecting; go(); }).observe(box);
    document.addEventListener("visibilitychange", go);
    // its pause button, under the window's bottom-right corner (as the hero window's)
    const host = win.parentElement;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ui-pause loop-pause mk-chart-pause";
    const show = () => {
      const label = `${paused ? "Play" : "Pause"} the chart`;
      btn.innerHTML = paused
        ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.25 3.7v8.6c0 .62.68 1 1.2.66l6.5-4.3c.47-.31.47-1 0-1.32l-6.5-4.3c-.52-.34-1.2.04-1.2.66Z"/></svg>'
        : '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.25" y="3.25" width="2.75" height="9.5" rx="0.9"/><rect x="9" y="3.25" width="2.75" height="9.5" rx="0.9"/></svg>';
      btn.setAttribute("aria-label", label);
      btn.title = label;
      btn.classList.toggle("is-paused", paused);
    };
    btn.addEventListener("click", () => { paused = !paused; show(); go(); });
    show();
    host.appendChild(btn);
  }

  // the crosshair
  const xg = document.createElementNS(NS, "g");
  xg.setAttribute("class", "mk-xh");
  const vl = document.createElementNS(NS, "line"), hl = document.createElementNS(NS, "line");
  vl.setAttribute("y1", "0");
  vl.setAttribute("y2", "300");
  hl.setAttribute("x1", "0");
  hl.setAttribute("x2", "900");
  xg.append(vl, hl);
  svg.append(xg);
  const tag = document.createElement("span");
  tag.className = "mk-xh-tag";
  tag.setAttribute("aria-hidden", "true");
  box.append(tag);
  const read = document.createElement("span");
  read.className = "mk-xh-read";
  read.setAttribute("aria-hidden", "true");
  const tabs = box.querySelector(".mk-tabs");
  if (tabs) tabs.insertBefore(read, tabs.querySelector(".mk-sp"));
  const hide = () => box.classList.remove("is-xh");
  const at = (e) => {
    const r = svg.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * 900, vy = ((e.clientY - r.top) / r.height) * 300;
    if (vx < 0 || vx > 900 || vy < 0 || vy > 300) return hide();
    const c = candles.reduce((a, b) => (Math.abs(b.x - shift - vx) < Math.abs(a.x - shift - vx) ? b : a));
    const cx = (c.x - shift).toFixed(1);
    vl.setAttribute("x1", cx);
    vl.setAttribute("x2", cx);
    hl.setAttribute("y1", vy.toFixed(1));
    hl.setAttribute("y2", vy.toFixed(1));
    tag.textContent = fmt(price(vy));
    tag.style.top = `${r.top - box.getBoundingClientRect().top - box.clientTop + (vy / 300) * r.height}px`;
    read.innerHTML = `O <b>${fmt(price(c.open))}</b>H <b>${fmt(price(c.hi))}</b>L <b>${fmt(price(c.lo))}</b>C <b>${fmt(price(c.close))}</b>`;
    box.classList.add("is-xh");
  };
  svg.addEventListener("pointermove", (e) => { if (e.pointerType !== "touch") at(e); });
  svg.addEventListener("pointerleave", (e) => { if (e.pointerType !== "touch") hide(); });
  // on a touch screen a tap shows it for a moment; the page still scrolls under the finger
  let held = 0;
  svg.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    at(e);
    clearTimeout(held);
    held = setTimeout(hide, 1600);
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
