// Iora landing: the quiet moving grounds of four sections (26 Nov 2026). page.css places them; the hero's painted
// sky is the kit's own effect (data-fx on .hero-sky).
//   price  "Every fill is one transaction": faint price levels and a slow price line; where the line meets a level,
//          a small ring, as when an order fills
//   chart  "Rules the contract enforces": the depth lines of a sea chart, slowly drifting (WebGL)
//   rings  "Join the beta": now and then a faint ripple, never behind the words
//   tide   the footer: three layers of soft waves along the bottom of the page
// Each moves only while it is on screen and the tab is visible, at about 30 frames a second. On a phone, with
// <html data-motion="off"> or under reduced motion it is drawn once and holds still. Each has the kit's pause button
// (motion that lasts longer than five seconds can be stopped).
const html = document.documentElement;
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches || html.dataset.motion === "off" || matchMedia("(max-width: 639px)").matches;
const ICON_PAUSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.25" y="3.25" width="2.75" height="9.5" rx="0.9"/><rect x="9" y="3.25" width="2.75" height="9.5" rx="0.9"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.25 3.7v8.6c0 .62.68 1 1.2.66l6.5-4.3c.47-.31.47-1 0-1.32l-6.5-4.3c-.52-.34-1.2.04-1.2.66Z"/></svg>';

// ---- colours: the section's accent and ground (page.css gives .bd color: var(--accent) and
// text-decoration-color: var(--bg)), read again when the theme changes --------------------------------------------
let probe = null;
function bytes(value, fallback) {
  probe = probe || document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  probe.canvas.width = probe.canvas.height = 1;
  probe.fillStyle = "#010203";
  probe.fillStyle = value || "#010203";
  if (probe.fillStyle === "#010203") return fallback;
  probe.clearRect(0, 0, 1, 1);
  probe.fillRect(0, 0, 1, 1);
  const d = probe.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}
const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
function inkOf(box) {
  const ink = { line: [31, 79, 209], bg: [244, 246, 250], dark: false };
  ink.read = () => {
    const cs = getComputedStyle(box);
    ink.line = bytes(cs.color, ink.line);
    ink.bg = bytes(cs.textDecorationColor, ink.bg);
    ink.dark = 0.2126 * lin(ink.bg[0]) + 0.7152 * lin(ink.bg[1]) + 0.0722 * lin(ink.bg[2]) < 0.18;
  };
  ink.read();
  return ink;
}
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// ---- measured places are kept a while: fn() runs again after ms, after reset(), or when the page's layout may
// have moved (a font arrived: epoch goes up) --------------------------------------------------------------------------
let epoch = 0;
function every(ms, fn) {
  let at = -Infinity, ep = -1, v;
  const get = () => {
    const now = performance.now();
    if (ep !== epoch || now - at > ms) { at = now; ep = epoch; v = fn(); }
    return v;
  };
  get.reset = () => { at = -Infinity; };
  return get;
}

// ---- where the words are: the boxes of the given blocks inside a section, relative to its ground and merged
// where they touch (a title and the paragraph under it are one place); a paragraph counts by its lines' ink ---------
function wordsIn(section, box, sel, pad) {
  const b = box.getBoundingClientRect();
  const range = document.createRange();
  const list = [...section.querySelectorAll(sel)]
    .filter((el) => !el.closest(".panel__screen, .stage, .bd"))
    .map((el) => { if (/^(P|H2|H3)$/.test(el.tagName)) { range.selectNodeContents(el); return range.getBoundingClientRect(); } return el.getBoundingClientRect(); })
    .filter((r) => r.width && r.height)
    .map((r) => ({ x0: r.left - b.left - pad, y0: r.top - b.top - pad, x1: r.right - b.left + pad, y1: r.bottom - b.top + pad }));
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < list.length && !merged; i++) for (let j = i + 1; j < list.length && !merged; j++) {
      const a = list[i], c = list[j];
      if (a.x0 < c.x1 && c.x0 < a.x1 && a.y0 < c.y1 && c.y0 < a.y1) {
        list[i] = { x0: Math.min(a.x0, c.x0), y0: Math.min(a.y0, c.y0), x1: Math.max(a.x1, c.x1), y1: Math.max(a.y1, c.y1) };
        list.splice(j, 1);
        merged = true;
      }
    }
  }
  return list;
}

// ---- the pause button, in the section's bottom-right corner, above its words ------------------------------------
function pauseButton(box, onToggle) {
  if (still()) return null;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ui-pause loop-pause bd-pause";
  let paused = false;
  const show = () => {
    const label = `${paused ? "Play" : "Pause"} background animation`;
    btn.innerHTML = paused ? ICON_PLAY : ICON_PAUSE;
    btn.setAttribute("aria-label", label);
    btn.title = label;
    btn.classList.toggle("is-paused", paused);
  };
  btn.addEventListener("click", () => { paused = !paused; show(); onToggle(paused); });
  show();
  box.parentElement.appendChild(btn);
  return btn;
}

// ---- the frame loop of one ground --------------------------------------------------------------------------------
/** Runs draw(t, first) while the ground is on screen; t is the seconds of motion so far. Returns { redraw }. */
function animate(box, draw) {
  let raf = 0, t = 0, last = 0, onScreen = false, paused = false, started = false, frameAt = 0;
  const tick = (now) => {
    raf = 0;
    if (!onScreen || paused || document.hidden || still()) return;
    if (now - frameAt >= 32) { // about 30 frames a second is plenty for something this slow
      t += last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      frameAt = now;
      draw(t, false);
    }
    raf = requestAnimationFrame(tick);
  };
  const go = () => { if (!raf && onScreen && !paused && !document.hidden && !still()) { last = 0; raf = requestAnimationFrame(tick); } };
  new IntersectionObserver((e) => {
    onScreen = e[e.length - 1].isIntersecting;
    if (onScreen && !started) { started = true; draw(t, true); }
    go();
  }, { rootMargin: "80px 0px" }).observe(box);
  document.addEventListener("visibilitychange", go);
  const btn = pauseButton(box, (p) => { paused = p; go(); });
  return { btn, redraw: () => { if (started) draw(t, false); } };
}

// ---- a 2D canvas the size of the box -------------------------------------------------------------------------
function surface(box) {
  const c = document.createElement("canvas");
  box.appendChild(c);
  const g = c.getContext("2d");
  const s = { g, w: 0, h: 0 };
  s.fit = () => {
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    s.w = Math.max(1, box.clientWidth);
    s.h = Math.max(1, box.clientHeight);
    c.width = Math.round(s.w * dpr);
    c.height = Math.round(s.h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  s.fit();
  return s;
}

// ---- price: levels and a price line that fills where it meets them, in the free place beside the statement --------
function price(box) {
  const ink = inkOf(box);
  const s = surface(box);
  const { g } = s;
  const section = box.parentElement;
  const pulses = [];
  let prevY = null, born = 0, btn = null;
  const SPEED = 18;
  // in the band page.css keeps under the words (140px or more), else beside them (220px or more), else nowhere;
  // across the page's text column
  const place = every(1000, () => {
    let area = null;
    const ws = wordsIn(section, box, ".wrap p, .wrap h2", 0);
    const wrap = section.querySelector(":scope > .wrap");
    if (!ws.length || !wrap) return area;
    const b = box.getBoundingClientRect(), wr = wrap.getBoundingClientRect(), cs = getComputedStyle(wrap);
    const cl = wr.left - b.left + (parseFloat(cs.paddingLeft) || 0), cr = wr.right - b.left - (parseFloat(cs.paddingRight) || 0);
    const tr = Math.max(...ws.map((r) => r.x1)), tb = Math.max(...ws.map((r) => r.y1)), tt = Math.min(...ws.map((r) => r.y0));
    if (s.h - 24 - (tb + 32) >= 140) area = { x0: cl, x1: cr, y0: tb + 32, y1: s.h - 24 };
    else if (cr - (tr + 64) >= 220) area = { x0: tr + 64, x1: cr, y0: tt, y1: tb };
    if (btn) btn.hidden = !area;
    return area;
  });
  const at = (sec, a) => a.y0 + (a.y1 - a.y0) * (0.5 + 0.24 * Math.sin(sec * 0.11) + 0.11 * Math.sin(sec * 0.27 + 1.3) + 0.04 * Math.sin(sec * 0.61 + 0.4));
  const draw = (t, first) => {
    if (first) born = t;
    const { w, h } = s;
    g.clearRect(0, 0, w, h);
    const a = place();
    if (!a) return;
    const head = a.x1 - 24;
    const sec = t + 24;
    const shown = still() ? 1 : Math.min(1, (t - born) / 1.4);
    const L = [0.22, 0.5, 0.78].map((k) => Math.round(a.y0 + (a.y1 - a.y0) * k) + 0.5);
    g.lineWidth = 1;
    g.setLineDash([6, 8]);
    for (const y of L) {
      const lit = pulses.some((p) => p.y === y && t - p.t < 1.2);
      g.strokeStyle = rgba(ink.line, (lit ? 0.32 : 0.18) * (ink.dark ? 1.3 : 1) * shown);
      g.beginPath(); g.moveTo(a.x0, y); g.lineTo(a.x1, y); g.stroke();
    }
    g.setLineDash([]);
    // the line draws itself in from its head, then runs on
    const from = head - (head - a.x0 + 40) * (1 - Math.pow(1 - shown, 3));
    g.beginPath();
    for (let x = Math.max(a.x0 - 40, from); x <= head; x += 4) {
      const y = at(sec - (head - x) / SPEED, a);
      if (x === Math.max(a.x0 - 40, from)) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.strokeStyle = rgba(ink.line, ink.dark ? 0.55 : 0.45);
    g.lineWidth = 1.6;
    g.stroke();
    const y = at(sec, a);
    if (prevY !== null && !still()) for (const lv of L) if ((prevY - lv) * (y - lv) < 0) pulses.push({ y: lv, t });
    prevY = y;
    g.beginPath(); g.arc(head, y, 3.5, 0, Math.PI * 2); g.fillStyle = rgba(ink.line, ink.dark ? 0.85 : 0.65); g.fill();
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i], k = (t - p.t) / 1.2;
      if (k > 1) { pulses.splice(i, 1); continue; }
      g.beginPath(); g.arc(head, p.y, 4 + 30 * (1 - Math.pow(1 - k, 3)), 0, Math.PI * 2);
      g.strokeStyle = rgba(ink.line, (ink.dark ? 0.6 : 0.45) * (1 - k)); g.lineWidth = 1.5; g.stroke();
    }
    // it comes out of nothing at the place's left edge
    g.save();
    g.globalCompositeOperation = "destination-in";
    const fade = g.createLinearGradient(a.x0, 0, a.x0 + Math.min(140, (a.x1 - a.x0) * 0.4), 0);
    fade.addColorStop(0, "rgba(0,0,0,0)");
    fade.addColorStop(1, "#000");
    g.fillStyle = fade;
    g.fillRect(0, 0, w, h);
    g.restore();
  };
  const run = animate(box, draw);
  btn = run.btn;
  place.reset();
  place();
  new ResizeObserver(() => { s.fit(); place.reset(); run.redraw(); }).observe(box);
  return { ink, redraw: run.redraw };
}

// ---- chart: the depth lines of a sea chart (WebGL2) ----------------------------------------------------------------
function chart(box) {
  const c = document.createElement("canvas");
  box.appendChild(c);
  const gl = c.getContext("webgl2", { premultipliedAlpha: true, antialias: false, alpha: true });
  if (!gl) { c.remove(); return null; }
  const vs = "#version 300 es\nin vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }";
  const fs = `#version 300 es
precision highp float;
uniform vec2 res; uniform float t; uniform float a0; uniform vec3 col;
uniform vec4 holes[16]; uniform int nh; uniform float feather;
out vec4 o;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), u.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), u.x), u.y); }
float fbm(vec2 p){ float v = 0., a = .5; for (int i = 0; i < 5; i++){ v += a * n(p); p = p * 2.02 + vec2(1.7, 9.2); a *= .5; } return v; }
void main(){
  vec2 uv = gl_FragCoord.xy / res; uv.y = 1. - uv.y;
  vec2 p = vec2(uv.x * res.x / res.y, uv.y) * 1.6 * max(1., res.y / res.x * 1.4);
  float f = fbm(p + vec2(t * .018, -t * .011)) + .45 * fbm(p * 1.6 - vec2(t * .009, t * .004));
  float v = f * 16.;
  float d = min(fract(v), 1. - fract(v));
  float line = 1. - smoothstep(0., fwidth(v) * 1.3, d);
  float major = 1. - step(.5, mod(floor(v + .5), 5.));
  float a = line * mix(.55, 1., major);
  for (int i = 0; i < 16; i++) {
    if (i >= nh) break;
    vec4 r = holes[i];
    vec2 q = abs(gl_FragCoord.xy - (r.xy + r.zw) * .5) - (r.zw - r.xy) * .5;
    a *= smoothstep(0., feather, length(max(q, 0.)) + min(max(q.x, q.y), 0.));
  }
  o = vec4(col * a, a) * a0;
}`;
  const sh = (type, src) => { const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); return x; };
  const pr = gl.createProgram();
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) { c.remove(); return null; }
  gl.useProgram(pr);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (k) => gl.getUniformLocation(pr, k);
  const ink = inkOf(box);
  const section = box.parentElement;
  let scale = 1;
  const fit = () => {
    scale = Math.min(1.25, window.devicePixelRatio || 1) * 0.75; // thin lines stay soft enough at three quarters
    c.width = Math.max(1, Math.round(box.clientWidth * scale));
    c.height = Math.max(1, Math.round(box.clientHeight * scale));
    gl.viewport(0, 0, c.width, c.height);
    gl.uniform2f(U("res"), c.width, c.height);
    gl.uniform1f(U("feather"), 36 * scale);
    holes.reset();
  };
  // the headings, the cards' words and the labels over the pictures (measured again every second at most)
  const holes = every(1000, () => {
    const list = wordsIn(section, box, "h2, h3, p, .panel__bar", 10).slice(0, 16);
    const data = new Float32Array(64);
    list.forEach((r, i) => data.set([r.x0 * scale, c.height - r.y1 * scale, r.x1 * scale, c.height - r.y0 * scale], i * 4));
    gl.uniform4fv(U("holes"), data);
    gl.uniform1i(U("nh"), list.length);
    return list.length;
  });
  fit();
  let born = 0;
  const draw = (t, first) => {
    if (first) born = t;
    holes();
    const k = still() ? 1 : Math.min(1, (t - born) / 1.6);
    gl.uniform3f(U("col"), ink.line[0] / 255, ink.line[1] / 255, ink.line[2] / 255);
    gl.uniform1f(U("a0"), (ink.dark ? 0.2 : 0.15) * k);
    gl.uniform1f(U("t"), t + 40);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const run = animate(box, draw);
  new ResizeObserver(() => { fit(); run.redraw(); }).observe(box);
  return { ink, redraw: run.redraw };
}

// ---- rings: a faint ripple now and then, never behind the words ------------------------------------------------
function rings(box) {
  const ink = inkOf(box);
  const s = surface(box);
  const { g } = s;
  const section = box.parentElement;
  const ripples = [];
  let next = 0;
  // where the words and the form are, inside the section (measured again every half second at most)
  const blocked = every(500, () => {
    const b = box.getBoundingClientRect();
    return [...section.querySelectorAll("h2, p, form, .frame, .ui-panel")].map((el) => el.getBoundingClientRect())
      .filter((r) => r.width && r.height)
      .map((r) => ({ x0: r.left - b.left - 20, y0: r.top - b.top - 20, x1: r.right - b.left + 20, y1: r.bottom - b.top + 20 }));
  });
  const free = (x, y, list) => !list.some((r) => x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1);
  const spot = () => {
    const list = blocked();
    for (let i = 0; i < 30; i++) {
      const x = 40 + Math.random() * (s.w - 80), y = 40 + Math.random() * (s.h - 80);
      if (free(x, y, list)) return { x, y };
    }
    return null;
  };
  const draw = (t, first) => {
    const { w, h } = s;
    if (first) { ripples.push({ x: w / 2, y: h * 0.55, t, big: true }); next = t + 2.4; }
    if (!still() && t > next) { const p = spot(); if (p) ripples.push({ ...p, t, big: false }); next = t + 2 + Math.random() * 1.5; }
    g.clearRect(0, 0, w, h);
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      const life = r.big ? 2.6 : 4.2;
      const k = still() ? 0.35 : (t - r.t) / life;
      if (k > 1) { ripples.splice(i, 1); continue; }
      const e = 1 - Math.pow(1 - k, 3);
      for (let j = 0; j < 3; j++) {
        const rad = (r.big ? Math.max(w, h) * 0.55 : 160) * e - j * (r.big ? 46 : 20);
        if (rad <= 2) continue;
        const a = (r.big ? (ink.dark ? 0.45 : 0.32) : (ink.dark ? 0.38 : 0.28)) * (1 - k) * (1 - j * 0.28);
        g.beginPath(); g.ellipse(r.x, r.y, rad, rad * 0.42, 0, 0, Math.PI * 2);
        g.strokeStyle = rgba(ink.line, a); g.lineWidth = r.big ? 1.6 : 1.2; g.stroke();
      }
    }
    // the words stay clear of every ring: each block is wiped with a soft edge
    g.save();
    g.globalCompositeOperation = "destination-out";
    g.fillStyle = "#000";
    g.shadowColor = "#000";
    g.shadowBlur = 24;
    for (const r of blocked()) g.fillRect(r.x0 + 8, r.y0 + 8, r.x1 - r.x0 - 16, r.y1 - r.y0 - 16);
    g.restore();
  };
  const run = animate(box, draw);
  new ResizeObserver(() => { s.fit(); blocked.reset(); run.redraw(); }).observe(box);
  return { ink, redraw: run.redraw };
}

// ---- tide: three layers of soft waves along the bottom of the page ---------------------------------------------
function tide(box) {
  const ink = inkOf(box);
  const layers = [
    { y: 90, amp: 14, len: 720, ph: 0.4, a: 0.06, ad: 0.07, dur: 75000, bob: 11000 },
    { y: 140, amp: 18, len: 1440, ph: 2.1, a: 0.08, ad: 0.09, dur: 55000, bob: 9000 },
    { y: 195, amp: 12, len: 480, ph: 4.0, a: 0.1, ad: 0.12, dur: 40000, bob: 7000 },
  ];
  // both waves of a layer repeat within 1440 units, so it slides by 1440 and starts again without a seam
  const wave = (l) => {
    let d = `M 0 ${l.y}`;
    for (let x = 0; x <= 2880; x += 24) d += ` L ${x} ${(l.y + l.amp * Math.sin((x / l.len) * Math.PI * 2 + l.ph) + l.amp * 0.35 * Math.sin((x / (l.len / 2)) * Math.PI * 2 + l.ph * 1.7)).toFixed(1)}`;
    return `${d} L 2880 270 L 0 270 Z`;
  };
  box.innerHTML = `<svg viewBox="0 0 1440 260" preserveAspectRatio="none">${layers.map((l) => `<g class="bd-rise"><g class="bd-bob"><path d="${wave(l)}"/></g></g>`).join("")}</svg>`;
  const paths = [...box.querySelectorAll("path")];
  const paint = () => paths.forEach((p, i) => p.setAttribute("fill", rgba(ink.line, ink.dark ? layers[i].ad : layers[i].a)));
  paint();
  const moving = [];
  let started = false, onScreen = false, paused = false;
  const sync = () => { for (const a of moving) (onScreen && !paused && !document.hidden ? a.play() : a.pause()); };
  const start = () => {
    if (started) return;
    started = true;
    if (still()) return;
    box.querySelectorAll(".bd-rise").forEach((g, i) => g.animate([{ transform: "translateY(120px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 1400, delay: i * 120, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "backwards" }));
    paths.forEach((p, i) => {
      moving.push(p.animate([{ transform: "translateX(0)" }, { transform: "translateX(-1440px)" }], { duration: layers[i].dur, iterations: Infinity, easing: "linear" }));
      moving.push(p.parentNode.animate([{ transform: "translateY(-5px)" }, { transform: "translateY(5px)" }], { duration: layers[i].bob, iterations: Infinity, direction: "alternate", easing: "ease-in-out" }));
    });
  };
  // the waves run only while the footer is on screen, the tab is visible and the button is not pressed
  new IntersectionObserver((e) => { onScreen = e[e.length - 1].isIntersecting; if (onScreen) start(); sync(); }, { rootMargin: "80px 0px" }).observe(box);
  document.addEventListener("visibilitychange", sync);
  pauseButton(box, (p) => { paused = p; sync(); });
  return { ink, redraw: paint };
}

// ---- start ----------------------------------------------------------------------------------------------------
const KINDS = { price, chart, rings, tide };
function start() {
  if (typeof IntersectionObserver !== "function" || typeof ResizeObserver !== "function") return;
  const runs = [];
  for (const box of document.querySelectorAll(".bd[data-bd]")) {
    const make = KINDS[box.dataset.bd];
    if (!make) continue;
    try {
      const r = make(box);
      if (r) runs.push(r);
    } catch (e) {
      console.warn("backdrop", box.dataset.bd, e);
    }
  }
  // a font that arrives moves the words: every place is measured again and drawn again
  const relayout = () => { epoch++; for (const r of runs) r.redraw(); };
  if (document.fonts) { document.fonts.ready.then(relayout); document.fonts.addEventListener?.("loadingdone", relayout); }
  window.addEventListener("load", relayout);
  // a new theme: new colours, drawn again at once
  const recolour = () => { for (const r of runs) { r.ink.read(); r.redraw(); } };
  new MutationObserver(recolour).observe(html, { attributes: true, attributeFilter: ["data-theme", "data-tone"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", recolour);
  // the hero's moving sky: its pause button goes where the window's own was, under the window's bottom-right corner
  const sky = document.querySelector(".hero-sky");
  const win = document.querySelector(".hero__window");
  if (sky && win) {
    const move = () => {
      const b = sky.querySelector(".loop-pause");
      if (!b) return;
      b.classList.add("ui-pause--below");
      if (!win.dataset.uiPauseRoom) { win.dataset.uiPauseRoom = ""; win.style.paddingBottom = `calc(${getComputedStyle(win).paddingBottom} + 44px)`; }
      win.appendChild(b);
    };
    new MutationObserver(move).observe(sky, { childList: true });
    move();
  }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
