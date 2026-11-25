// Access gate, part 1: runs in <head>, before the page is drawn.
// Access to the testnet app: invite code or allowed wallet (checked on the server, api/access.js).
// With GATE = false the app is open to everyone.
(function () {
  var GATE = true;
  var html = document.documentElement;
  if (!GATE) return;
  var token = null;
  try { token = localStorage.getItem("iora-access"); } catch (e) {}
  if (!token) { html.classList.add("app-closed"); return; }
  // A ticket is "<payload>.<signature>"; the payload says who it is for and when it ends. A ticket that reads as
  // valid opens the app at once and the server checks the signature in the background, so a returning visitor does
  // not look at an empty page while that request is on its way (0.2-0.7 s, measured 25 Nov 2026). If the server
  // rejects it, the gate closes. A ticket that cannot be read waits for the server, as before.
  var sub = null;
  try {
    var p = JSON.parse(atob(token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")));
    if (p && typeof p.exp === "number" && p.exp > Date.now() && p.sub) sub = String(p.sub);
  } catch (e) {}
  window.__ioraSub = sub;
  if (!sub) html.classList.add("app-pending");
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
        window.__ioraSub = null;
        html.classList.add("app-closed");
      }
    })
    .catch(function () {
      // The server could not be reached. A ticket that read as valid keeps the app open (this is an entry gate, not
      // a security boundary); one that could not be read closes the gate, as before.
      html.classList.remove("app-pending");
      if (!sub) html.classList.add("app-closed");
    });
})();
