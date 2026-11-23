// Home page motion: sections that appear on scroll, number counters, the top progress line,
// a faint light that follows the mouse and a tilt on cards. None of it runs for people who prefer reduced motion.

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const fine = matchMedia("(pointer: fine)").matches;

if (!reduce) start();

function start() {
  document.body.classList.add("motion");

  // 1) Elements that appear on scroll (section headings, cards, rows), with a staggered delay
  const groups = [
    ["main section h2, main section .section-lede, .why-text > .calc, .costs-lede, .control a.more", 0],
    [".use-grid article", 90],
    [".rules > div", 90],
    [".cmp tbody tr", 70],
    [".costs tbody tr", 60],
    [".road-h li", 110],
    [".faq-list details", 50],
    [".beta-text > *, #betaform", 80],
    [".race > *", 90],
    [".risks, .road-note, .faq .more", 0],
  ];
  const seen = new Set();
  for (const [sel, step] of groups) {
    const parents = new Map();
    for (const el of document.querySelectorAll(sel)) {
      if (seen.has(el)) continue;
      seen.add(el);
      const p = el.parentElement;
      const i = parents.get(p) || 0;
      parents.set(p, i + 1);
      el.classList.add("rv");
      el.style.setProperty("--d", `${Math.min(i * step, 600)}ms`);
    }
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("rv-in");
        io.unobserve(e.target);
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
  );
  for (const el of seen) io.observe(el);

  // The roadmap line and the Iora column of the comparison table run on their own timing
  for (const el of document.querySelectorAll(".road-h, .cmp")) {
    new IntersectionObserver(
      ([e], obs) => {
        if (e.isIntersecting) {
          el.classList.add("lit");
          obs.disconnect();
        }
      },
      { threshold: 0.35 },
    ).observe(el);
  }

  // 2) Number counters: figures such as "Fee to place an order 0.018 XLM" count up from zero when they come into view
  const facts = document.querySelector(".facts");
  if (facts) {
    const items = [...facts.querySelectorAll("dd")]
      .map((dd) => {
        const m = dd.textContent.match(/^(\d+(?:\.\d+)?)(.*)$/);
        return m && { dd, to: parseFloat(m[1]), dec: (m[1].split(".")[1] || "").length, rest: m[2] };
      })
      .filter(Boolean);
    new IntersectionObserver(
      ([e], obs) => {
        if (!e.isIntersecting) return;
        obs.disconnect();
        const t0 = performance.now(), dur = 1100;
        const tick = (t) => {
          const k = Math.min(1, (t - t0) / dur), ease = 1 - Math.pow(1 - k, 3);
          for (const it of items) it.dd.textContent = (it.to * ease).toFixed(it.dec) + it.rest;
          if (k < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      { threshold: 0.5 },
    ).observe(facts);
  }

  // 3) A thin progress line at the top of the page
  const bar = document.createElement("div");
  bar.className = "scroll-progress";
  bar.setAttribute("aria-hidden", "true");
  document.body.appendChild(bar);
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const h = document.documentElement.scrollHeight - innerHeight;
      bar.style.transform = `scaleX(${h > 0 ? Math.min(1, scrollY / h) : 0})`;
      document.body.classList.toggle("scrolled", scrollY > 12);
      ticking = false;
    });
  };
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  if (!fine) return; // no mouse effects on touch screens

  // 4) A soft light inside cards that follows the mouse + a very slight tilt
  for (const card of document.querySelectorAll(".use-grid article, .rules > div, .steps li, .beta form")) {
    card.classList.add(card.matches(".steps li") ? "lift" : "glow");
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      card.style.setProperty("--mx", `${x * 100}%`);
      card.style.setProperty("--my", `${y * 100}%`);
      if (card.matches(".use-grid article, .steps li")) {
        card.style.transform = `perspective(900px) rotateX(${(0.5 - y) * 4}deg) rotateY(${(x - 0.5) * 5}deg) translateY(-3px)`;
      }
    });
    card.addEventListener("pointerleave", () => (card.style.transform = ""));
  }
}
