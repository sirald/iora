import fs from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// Stellar Wallets Kit (xBull, Albedo, Lobstr, Varial...) is used if installed; otherwise Varial (Freighter) only.
// BERTHLY_NO_KIT=1 forces it off (build-web.sh uses this if the build has a problem).
const kitDir = resolve(import.meta.dirname, "node_modules/@creit-tech/stellar-wallets-kit");
// Default: the Freighter API (Varial, formerly Freighter). The multi-wallet window stays
// off until it has been tried with real wallets; build with IORA_KIT=1 to turn it on.
const hasKit = fs.existsSync(kitDir) && process.env.IORA_KIT === "1" && !process.env.BERTHLY_NO_KIT;
const stub = resolve(import.meta.dirname, "src/kit-stub.js");

// Build id: embedded in the page and written to dist/version.json. A page left open compares the two
// and learns that a new version was published (src/main.js staleBuild).
const BUILD_ID = String(Date.now());
const versionFile = {
  name: "iora-version-file",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build: BUILD_ID }) });
  },
};

export default defineConfig({
  define: { global: "globalThis", __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [versionFile],
  server: { port: 5173, strictPort: true },
  resolve: {
    alias: hasKit
      ? {
          "swk-sdk": "@creit-tech/stellar-wallets-kit/sdk",
          "swk-modules": "@creit-tech/stellar-wallets-kit/modules/utils",
          // The MetaMask module looks for the kit under its npm name (@creit.tech); point it to the same package installed from JSR.
          "@creit.tech/stellar-wallets-kit": "@creit-tech/stellar-wallets-kit",
        }
      : { "swk-sdk": stub, "swk-modules": stub },
  },
  build: {
    rollupOptions: {
      input: {
        // The landing page is not built by Vite: it is a static page in public/ (index.html, page.css, page.js,
        // kit/, fonts/) and is copied to dist/ as it is.
        app: resolve(import.meta.dirname, "app.html"),
        docs: resolve(import.meta.dirname, "docs.html"),
      },
    },
  },
});
