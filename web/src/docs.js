import "./landing.css";
import "./docs.css";
import "./skin.css";

// Fabrika adresini derleme anindaki gercek degerle guncelle.
const f = import.meta.env?.VITE_FACTORY;
const el = document.getElementById("addr-factory");
if (f && el) el.textContent = f;
// Satis kasasi fabrikasi kuruluysa satirini goster
const fs = import.meta.env?.VITE_FACTORY_SELL;
const row = document.getElementById("row-factory-sell");
// Tek kasali surumde (surum 7) alim ve satim ayni fabrikadir: ikinci satir gosterilmez.
if (fs && fs !== f && row) {
  document.getElementById("addr-factory-sell").textContent = fs;
  row.hidden = false;
} else if (row) row.hidden = true;

// Adreslerin yanina kopyala dugmesi
for (const code of document.querySelectorAll(".addr code")) {
  const b = document.createElement("button");
  b.className = "copy";
  b.type = "button";
  b.textContent = "Copy";
  b.onclick = async () => {
    try {
      await navigator.clipboard.writeText(code.textContent.trim());
      b.textContent = "Copied";
      setTimeout(() => (b.textContent = "Copy"), 1500);
    } catch {}
  };
  code.after(b);
}

// Kenar menusunde okunan bolumu isaretle
const links = [...document.querySelectorAll("#toc a")];
const byId = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      links.forEach((a) => a.classList.remove("active"));
      byId.get(e.target.id)?.classList.add("active");
    }
  },
  { rootMargin: "-20% 0px -70% 0px" },
);
for (const id of byId.keys()) {
  const s = document.getElementById(id);
  if (s) io.observe(s);
}

// Konu filtresi
const input = document.getElementById("toc-filter");
input?.addEventListener("input", () => {
  const q = input.value.trim().toLowerCase();
  for (const a of links) a.parentElement.classList.toggle("hide", q && !a.textContent.toLowerCase().includes(q));
  for (const g of document.querySelectorAll(".toc-group")) {
    const list = g.nextElementSibling;
    const any = [...list.children].some((li) => !li.classList.contains("hide"));
    g.classList.toggle("hide", !any);
    list.classList.toggle("hide", !any);
  }
});
