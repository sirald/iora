// Applies the saved theme before first paint and handles the theme button.
// Kept in a file (not inline) so the site can forbid inline scripts in its Content-Security-Policy.
(function () {
  var root = document.documentElement;
  var dark = function () {
    return root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  };
  var paint = function () {
    root.dataset.tone = dark() ? "dark" : "light";
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.content = dark() ? "#080d1a" : "#f4f6fa";
  };
  try { var t = localStorage.getItem("berthly-theme"); if (t === "dark" || t === "light") root.dataset.theme = t; } catch (e) {}
  paint();
  document.addEventListener("DOMContentLoaded", paint);
  window.addEventListener("load", function () { setTimeout(paint, 0); });
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-theme-toggle]");
    if (!b) return;
    var next = dark() ? "light" : "dark";
    root.dataset.theme = next;
    paint();
    try { localStorage.setItem("berthly-theme", next); } catch (e) {}
  });
})();
