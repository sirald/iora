import fs from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// Stellar Wallets Kit (xBull, Albedo, Lobstr, Freighter...) kuruluysa kullanilir; yoksa yalnizca Freighter.
// BERTHLY_NO_KIT=1 ile zorla kapatilabilir (derleme sorunu olursa build-web.sh bunu kullanir).
const kitDir = resolve(import.meta.dirname, "node_modules/@creit-tech/stellar-wallets-kit");
// Varsayilan: Freighter API (Freighter ve onu taklit eden Varial gibi cuzdanlar). Coklu cuzdan penceresi
// gercek cuzdanlarla denenene kadar kapali; acmak icin IORA_KIT=1 ile derle.
const hasKit = fs.existsSync(kitDir) && process.env.IORA_KIT === "1" && !process.env.BERTHLY_NO_KIT;
const stub = resolve(import.meta.dirname, "src/kit-stub.js");

// Derleme kimligi: sayfaya gomulur ve dist/version.json'a yazilir. Acik kalan eski sayfa ikisini
// karsilastirip yeni surum yayinlandigini anlar (src/main.js staleBuild).
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
          // MetaMask modulu kiti npm adiyla (@creit.tech) arar; JSR'den kurulan ayni pakete yonlendir.
          "@creit.tech/stellar-wallets-kit": "@creit-tech/stellar-wallets-kit",
        }
      : { "swk-sdk": stub, "swk-modules": stub },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        app: resolve(import.meta.dirname, "app.html"),
        docs: resolve(import.meta.dirname, "docs.html"),
      },
    },
  },
});
