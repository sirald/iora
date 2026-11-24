// Iora landing: the interest calculator (the only script of the page's own).
// What a waiting order earns: an order book pays nothing, a vault earns the rate the visitor sets.
const calc = document.getElementById("calc");
if (calc) {
  const $ = (id) => document.getElementById(id);
  const num = (v, d = 2) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const update = () => {
    // The size slider grows exponentially: 100 USDC -> 1,000,000 USDC (positions 0..100), rounded to two significant digits.
    const raw = 100 * Math.pow(10, Number($("c-amount").value) / 25);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)) - 1);
    const amount = Math.round(raw / mag) * mag;
    const days = Number($("c-days").value);
    const rate = Number($("c-apy").value) / 100;
    const earned = (amount * rate * days) / 365;
    $("c-amount-v").textContent = `${num(amount, 0)} USDC`;
    $("c-days-v").textContent = `${days} day${days === 1 ? "" : "s"}`;
    $("c-apy-v").textContent = `${num(rate * 100, 1)}% a year`;
    $("c-earn").textContent = `+${num(earned)} USDC`;
    // The bar: interest relative to the order's size, scaled to the sliders' highest values (15% for 180 days).
    const share = (rate * days) / 365 / ((0.15 * 180) / 365);
    $("c-bar").style.setProperty("--k", (0.04 + 0.96 * share).toFixed(3));
  };
  calc.addEventListener("input", update);
  calc.addEventListener("submit", (e) => e.preventDefault());
  update();
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
