// Motion layer of the app (26 Nov 2026): what CSS alone cannot do. motion.css says the rules.
//  1. A pressed button sinks to 97%.
//  4. The line under the chosen tab, and the Buy / Sell ground, travel to the new choice.
//  5. A balance that changes rises into place (green when it grew).
//  6. A new order slides into the list and is marked for a moment; an order whose status changes swaps its tag softly.
//  9. copied(): "Copy" becomes "Copied ✓" in place.
// With "reduce motion" set nothing moves; colours still change. Nothing moves right after a key press.
const reduce = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : { matches: true };
const still = () => reduce.matches;
const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const EASE_IO = "cubic-bezier(0.65, 0, 0.35, 1)";
let lastKey = 0;
addEventListener("keydown", () => (lastKey = Date.now()), true);
const byKeyboard = () => Date.now() - lastKey < 400;
const can = (el) => el && typeof el.animate === "function";
const cssVar = (name, fallback) => getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;

// ---- 1. press -------------------------------------------------------------------------------------------------
const PRESS = ".btn, button.small, button.ghost, .theme-toggle, #connect, .sidesw a, .wm-addr";
let pressed = null;
function letGo() {
  if (!pressed) return;
  const { el, run } = pressed;
  pressed = null;
  const from = getComputedStyle(el).scale;
  run.cancel();
  el.animate([{ scale: from && from !== "none" ? from : "0.97" }, { scale: "1" }], { duration: 200, easing: EASE });
}
document.addEventListener("pointerdown", (e) => {
  if (still() || e.button !== 0) return;
  const el = e.target.closest && e.target.closest(PRESS);
  if (!can(el) || el.disabled || el.matches('[role="tab"], .swap-arrow')) return;
  letGo();
  pressed = { el, run: el.animate([{ scale: "1" }, { scale: "0.97" }], { duration: 160, easing: EASE, fill: "forwards" }) };
});
for (const type of ["pointerup", "pointercancel", "dragstart"]) document.addEventListener(type, letGo, true);
addEventListener("blur", letGo);

// ---- 4. tabs --------------------------------------------------------------------------------------------------
function tabLine(list) {
  if (list.dataset.ind) return;
  list.dataset.ind = "1";
  const ind = document.createElement("i");
  ind.className = "tab-ind off";
  ind.setAttribute("aria-hidden", "true");
  list.appendChild(ind);
  list.classList.add("has-ind");
  const place = (glide) => {
    const sel = list.querySelector('[aria-selected="true"], .solo');
    if (!sel || !list.offsetWidth || !sel.offsetWidth) return ind.classList.add("off");
    ind.classList.toggle("glide", !!glide && !still() && !byKeyboard() && !ind.classList.contains("off"));
    ind.classList.remove("off");
    ind.style.transform = `translate(${sel.offsetLeft}px, ${sel.offsetTop + sel.offsetHeight - 2}px) scaleX(${sel.offsetWidth})`;
  };
  new MutationObserver(() => place(true)).observe(list, { attributes: true, subtree: true, attributeFilter: ["aria-selected", "hidden"] });
  if (typeof ResizeObserver === "function") new ResizeObserver(() => place(false)).observe(list);
  place(false);
}
// Buy / Sell are two pages, each with its own switch: the switch of the page that opens starts on the side the
// user came from and travels to its own.
const sideOfHash = (url) => {
  const h = String(url || "").split("#")[1] || "";
  return h === "sell" || h.startsWith("sell:") ? "s" : h === "vault" ? "b" : null;
};
function sidePills(from) {
  for (const sw of document.querySelectorAll(".sidesw")) {
    if (!sw.dataset.pill) {
      sw.dataset.pill = "1";
      const p = document.createElement("i");
      p.className = "sw-pill";
      p.setAttribute("aria-hidden", "true");
      sw.prepend(p);
      sw.classList.add("has-pill");
      if (typeof ResizeObserver === "function") new ResizeObserver(() => sidePills(null)).observe(sw);
    }
    const cur = sw.querySelector("a[aria-current]");
    const pill = sw.querySelector(".sw-pill");
    if (!cur || !sw.offsetWidth) continue;
    const mine = cur.classList.contains("s") ? "s" : "b";
    pill.className = `sw-pill ${mine}`;
    pill.style.width = `${cur.offsetWidth}px`;
    pill.style.transform = `translateX(${cur.offsetLeft}px)`;
    const other = sw.querySelector(mine === "s" ? "a.b" : "a.s");
    if (from && from !== mine && other && can(pill) && !still() && !byKeyboard()) {
      pill.animate([{ transform: `translateX(${other.offsetLeft}px)` }, { transform: `translateX(${cur.offsetLeft}px)` }], { duration: 240, easing: EASE_IO });
    }
  }
}

// ---- 5. balances that change ----------------------------------------------------------------------------------
const NUMBERS = "#avail-buy, #sv-free2, #wallet-usdc, #sv-wallet, [data-mirror]:not([data-mirror=\"m-apr\"])";
const valueOf = (t) => {
  const s = String(t).replace(/[,\s]/g, "");
  if (!/^[+-]?\d*\.?\d+%?$/.test(s)) return null;
  return Number(s.replace("%", ""));
};
function watchNumber(el) {
  let before = el.textContent.trim();
  new MutationObserver(() => {
    const now = el.textContent.trim();
    if (now === before) return;
    const a = valueOf(before);
    const b = valueOf(now);
    before = now;
    if (a === null || b === null || a === b || document.hidden || !el.offsetParent || !can(el)) return;
    if (b > a) el.animate([{ color: cssVar("--ok", "#12764c") }, { color: cssVar("--ok", "#12764c"), offset: 0.3 }, {}], { duration: 1100, easing: "ease" });
    if (!still()) el.animate([{ transform: "translateY(40%)", opacity: 0, filter: "blur(2px)" }, { transform: "none", opacity: 1, filter: "none" }], { duration: 260, easing: EASE });
  }).observe(el, { childList: true, characterData: true, subtree: true });
}

// ---- 6. order lists -------------------------------------------------------------------------------------------
function watchOrders(box) {
  let known = null; // order id -> status shown, after the first list was drawn
  new MutationObserver(() => {
    const rows = new Map();
    for (const tr of box.querySelectorAll("tbody tr")) {
      const m = /#(\d+)/.exec((tr.cells[0] && tr.cells[0].textContent) || "");
      if (!m) continue;
      const tag = tr.querySelector(".tag");
      rows.set(m[1], { tr, tag, st: tag ? tag.textContent.trim() : "" });
    }
    const before = known;
    known = new Map([...rows].map(([id, r]) => [id, r.st]));
    if (!before || document.hidden || !rows.size) return;
    // a list where nothing is known any more is another vault (or the first list after a reload): no motion
    if (before.size && ![...rows.keys()].some((id) => before.has(id))) return;
    const tint = `color-mix(in srgb, ${cssVar("--accent", "#1f4fd1")} 14%, transparent)`;
    let n = 0;
    for (const [id, r] of rows) {
      if (!before.has(id)) {
        const delay = 40 * n++;
        for (const td of r.tr.cells) {
          if (!can(td)) continue;
          if (!still()) td.animate([{ opacity: 0, transform: "translateY(-6px)", filter: "blur(2px)" }, { opacity: 1, transform: "none", filter: "none" }], { duration: 260, easing: EASE, delay, fill: "backwards" });
          td.animate([{ backgroundColor: tint }, { backgroundColor: tint, offset: 0.2 }, {}], { duration: 1400, easing: "ease", delay });
        }
      } else if (before.get(id) !== r.st && can(r.tag)) {
        r.tag.animate([{ opacity: 0, filter: still() ? "none" : "blur(2px)" }, { opacity: 1, filter: "none" }], { duration: 200, easing: "ease" });
      }
    }
  }).observe(box, { childList: true, subtree: true });
}

// ---- 9. copy --------------------------------------------------------------------------------------------------
/** The label for a copy button: "Copy" and "Copied ✓" share one place, so the button does not change width. */
export const COPY_LABEL = '<span class="cp"><span class="cp-a">Copy</span><span class="cp-b" aria-hidden="true">Copied ✓</span></span>';
/** After a successful copy: the button says "Copied ✓" for a moment. */
export function copied(el) {
  if (!el) return;
  if (!el.querySelector(".cp")) el.innerHTML = COPY_LABEL;
  el.classList.add("is-copied");
  el.setAttribute("aria-label", "Copied");
  clearTimeout(el.cpTimer);
  el.cpTimer = setTimeout(() => {
    el.classList.remove("is-copied");
    el.removeAttribute("aria-label");
  }, 1400);
}

// ---- start ----------------------------------------------------------------------------------------------------
function start() {
  try {
    for (const list of document.querySelectorAll(".tradeview .ticket > .tabs, .ttabs, .vtabs")) tabLine(list);
    sidePills(null);
    addEventListener("hashchange", (e) => {
      const from = sideOfHash(e.oldURL);
      requestAnimationFrame(() => sidePills(sideOfHash(e.newURL) ? from : null));
    });
    for (const el of document.querySelectorAll(NUMBERS)) watchNumber(el);
    for (const id of ["orders", "sv-orders"]) if (document.getElementById(id)) watchOrders(document.getElementById(id));
  } catch (e) {
    console.warn("motion", e);
  }
}
// main.js imports this file, so this runs before main.js has drawn the page: start right after it.
setTimeout(start, 0);
