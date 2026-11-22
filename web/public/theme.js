// Applies the saved theme before first paint and handles the theme toggle.
// Kept in a file (not inline) so the site can forbid inline scripts in its Content-Security-Policy.
(function () {
  try { var t = localStorage.getItem("berthly-theme"); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest(".theme-toggle");
    if (!b) return;
    var r = document.documentElement;
    var cur = r.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    var next = cur === "dark" ? "light" : "dark";
    r.dataset.theme = next;
    try { localStorage.setItem("berthly-theme", next); } catch (e) {}
  });
})();
