// Access gate, part 1: runs in <head> so the app stays hidden until the ticket is checked.
// Testnet uygulamasina erisim: davet kodu veya izinli cuzdan (kontrol sunucuda, api/access.js).
// GATE = false yapilirsa uygulama herkese acilir.
(function () {
  var GATE = true;
  var html = document.documentElement;
  if (!GATE) return;
  var token = null;
  try { token = localStorage.getItem("iora-access"); } catch (e) {}
  if (!token) { html.classList.add("app-closed"); return; }
  // Bilet sunucuda dogrulanana kadar uygulama gizli kalir; dogrulanamazsa kapi kapanir.
  html.classList.add("app-pending");
  window.__ioraSub = null;
  fetch("/api/access", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: token }), cache: "no-store" })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      html.classList.remove("app-pending");
      if (j.ok) {
        window.__ioraSub = j.sub || "code";
        window.dispatchEvent(new Event("iora:checked"));
        window.dispatchEvent(new Event("iora:open"));
      } else {
        try { localStorage.removeItem("iora-access"); } catch (e) {}
        html.classList.add("app-closed");
      }
    })
    .catch(function () {
      html.classList.remove("app-pending");
      html.classList.add("app-closed");
    });
})();
