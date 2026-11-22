// Ana sayfa canlandirmasi: fiyat bir su seviyesi gibi limite iner, samandira ustunde yuzer, faiz sayaci artar.
// Hareket CSS'tedir (skin.css, th-*); bu dosya sayaci su seviyesi animasyonunun saatine baglar ve her turda
// farkli bir ornek emir gosterir (tutar, bekleme suresi, limit). Tamamen yerel; zincire baglanmaz.
// Faiz ornek oranla hesaplanir: tutar x %6 x gun / 365. Dolan miktar: tutar / limit.
const tide = document.getElementById("th-tide");
const val = document.getElementById("th-val");
const cap = document.getElementById("th-cap");
const limitLabel = document.getElementById("th-limit-label");
const filled = document.getElementById("th-filled");
const PERIOD = 12000; // skin.css'teki th-tide suresi (ms)
const RATE = 0.06;
const SIZES = [5000, 10000, 25000, 50000, 100000, 250000];
const LIMITS = [0.135, 0.14, 0.145, 0.15, 0.155, 0.16];
const n0 = (v) => v.toLocaleString("en-US", { maximumFractionDigits: 0 });
const n2 = (v) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pick = (list, not) => {
  let x;
  do x = list[Math.floor(Math.random() * list.length)];
  while (list.length > 1 && x === not);
  return x;
};

let order = { size: 100000, days: 30, limit: 0.15 };
function show(o) {
  if (cap) cap.textContent = `Earning while a ${n0(o.size)} USDC order waits ${o.days} days`;
  if (limitLabel) limitLabel.textContent = `YOUR LIMIT · ${o.limit.toFixed(3)}`;
  if (filled) filled.textContent = `ORDER FILLED · ${n0(o.size / o.limit)} XLM`;
}
const earned = (o) => (o.size * RATE * o.days) / 365;

if (tide && val) {
  show(order);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    val.textContent = "+" + n2(earned(order));
  } else {
    const t0 = performance.now();
    let cycle = 0;
    const tick = () => {
      let t = performance.now() - t0;
      try {
        const an = tide.getAnimations ? tide.getAnimations()[0] : null;
        if (an && typeof an.currentTime === "number") t = an.currentTime;
      } catch {}
      const c = Math.floor(t / PERIOD);
      if (c !== cycle) {
        // Yeni tur: farkli bir ornek emir (etiket gorunmezken degisir)
        cycle = c;
        order = { size: pick(SIZES, order.size), days: 7 + Math.floor(Math.random() * 54), limit: pick(LIMITS, order.limit) };
        show(order);
      }
      const p = (t % PERIOD) / PERIOD;
      val.textContent = "+" + n2(earned(order) * Math.min(1, p / 0.75));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}
