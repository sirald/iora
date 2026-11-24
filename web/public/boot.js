// First paint helpers the design kit expects before the page draws (kept in a file: the site's
// Content-Security-Policy forbids inline scripts).
// m-enter: the hero's entrance may play; m-enter-done ends it. mo-js / mo-safe: the same for the dealt moment.
document.documentElement.classList.add("m-enter");
setTimeout(() => document.documentElement.classList.add("m-enter-done"), 700);
document.documentElement.classList.add("mo-js");
setTimeout(() => document.documentElement.classList.add("mo-safe"), 2500);
