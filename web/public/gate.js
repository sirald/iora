// Access gate, part 2: the invite code form and the wallet check.
(function () {
  var html = document.documentElement;
  var msg = document.getElementById("gate-msg");
  var waitingWallet = false;
  var lastAddress = null;
  function say(t, ok) { msg.textContent = t; msg.className = "gate-msg" + (ok ? " ok" : ""); }
  function open(token, sub) {
    try { localStorage.setItem("iora-access", token); } catch (e) {}
    window.__ioraSub = sub;
    html.classList.remove("app-closed");
    window.dispatchEvent(new Event("iora:open"));
  }
  // Cuzdanla alinan bilet o cuzdana aittir: baska bir cuzdan baglanirsa kapi yeniden kapanir.
  function lock(text) {
    try { localStorage.removeItem("iora-access"); } catch (e) {}
    window.__ioraSub = null;
    html.classList.add("app-closed");
    say(text);
  }
  function bound() {
    var s = window.__ioraSub;
    if (s && s !== "code" && lastAddress && lastAddress !== s)
      lock("This access was given to a different wallet. Connect that wallet or use an invite code.");
  }
  window.addEventListener("iora:checked", bound);
  function ask(body) {
    return fetch("/api/access", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .catch(function () { return { ok: false, error: "network" }; });
  }
  document.getElementById("gate-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var code = document.getElementById("gate-code").value.trim();
    if (!code) { say("Enter your invite code."); return; }
    var btn = document.getElementById("gate-go");
    btn.disabled = true; say("Checking…", true);
    ask({ code: code }).then(function (j) {
      btn.disabled = false;
      if (j.ok && j.token) { say("Welcome in.", true); open(j.token, "code"); }
      else say(j.error === "network" ? "Could not reach the server. Try again." : "That code is not valid.");
    });
  });
  document.getElementById("gate-wallet").addEventListener("click", function () {
    waitingWallet = true; say("");
    var c = document.getElementById("connect");
    if (c && !document.body.classList.contains("connected")) c.click();
    else if (lastAddress) window.dispatchEvent(new CustomEvent("iora:wallet", { detail: lastAddress }));
  });
  // main.js cuzdan baglaninca (veya zaten bagliysa) adresi bildirir
  window.addEventListener("iora:wallet", function (e) {
    var address = e.detail;
    if (!address) return;
    lastAddress = address;
    var wasLocked = false;
    if (!html.classList.contains("app-closed")) { bound(); wasLocked = html.classList.contains("app-closed"); }
    if (!html.classList.contains("app-closed")) return;
    say("Checking your wallet…", true);
    ask({ address: address }).then(function (j) {
      if (j.ok && j.token) { say("Welcome in.", true); open(j.token, address); }
      else if (waitingWallet || wasLocked) say(wasLocked ? "This access was given to a different wallet. Connect that wallet or use an invite code." : "This wallet is not on the beta list yet. Use an invite code or join the beta.");
      else say("");
    });
  });
})();
