// Iora sozlesmelerini guncel SDK ile testnet'e kurar (CLI 28 ucretleri sisirdigi icin).
//   DEV_SECRET=... node deploy.js
// 1) kasa ve fabrika wasm'larini yukler  2) yeni fabrikayi kurar  3) testnet/factory.env'i gunceller
//
//   DEV_SECRET=... node deploy.js --sell
// Satis fabrikasi: AYNI kasa kontrati, tokenlar ters (XLM yatirilir, Blend'de faiz kazanir, USDC alinir).
// Mevcut kasa wasm'i (testnet/factory.env VAULT_WASM_HASH) kullanilir; kontrat kodu degismez.
// Sonuc testnet/factory-sell.env'e yazilir; alim fabrikasi (factory.env) degismez.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Address,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}
const { USDC, XLM, POOL, ROUTER } = readEnv(path.join(root, "testnet/addr.env"));
const PASS = Networks.TESTNET;
const server = new rpc.Server("https://soroban-testnet.stellar.org");
const HORIZON = "https://horizon-testnet.stellar.org";
if (!process.env.DEV_SECRET) {
  console.error("DEV_SECRET yok");
  process.exit(1);
}
const kp = Keypair.fromSecret(process.env.DEV_SECRET);
const me = kp.publicKey();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function feeOf(hash) {
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch(`${HORIZON}/transactions/${hash}`);
      if (r.ok) return (Number((await r.json()).fee_charged) / 1e7).toFixed(4);
    } catch {}
    await sleep(2000);
  }
  return "?";
}

async function run(label, op) {
  const account = await server.getAccount(me);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASS })
    .addOperation(op)
    .setTimeout(180)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`${label}: gonderilemedi`);
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const r = await server.getTransaction(sent.hash);
    if (r.status === "SUCCESS") {
      console.log(`${label.padEnd(30)} ucret ${await feeOf(sent.hash)} XLM`);
      return r.returnValue ? scValToNative(r.returnValue) : undefined;
    }
    if (r.status === "FAILED") throw new Error(`${label}: agda basarisiz ${sent.hash}`);
  }
  throw new Error(`${label}: zaman asimi`);
}

async function upload(file) {
  const wasm = fs.readFileSync(path.join(root, "wasm", file));
  const hash = crypto.createHash("sha256").update(wasm).digest();
  try {
    await run(`yukle ${file}`, Operation.uploadContractWasm({ wasm }));
  } catch (e) {
    // Ayni wasm daha once yuklendiyse simulasyon hata verebilir; hash yine gecerlidir.
    console.log(`yukle ${file}: ${e.message.split("\n")[0]} (zaten yuklu olabilir)`);
  }
  return hash;
}

// Surum 7: tek, cok varlikli kasa ve tek fabrika (alim/satis ayrimi yok). "--v7" ile kurulur.
const V9 = process.argv.includes("--v9"); // version 9: uncapped vault list (chain per bucket), vault `forget`; same constructor as 8
const V8 = process.argv.includes("--v8") || V9; // surum 8: izinli token listesi, ara token uzerinden dolum
const V7 = process.argv.includes("--v7") || V8;
const SELL = process.argv.includes("--sell");
// Ek pazar: "--market SYM TOKEN". Kasa XLM yatirir (Blend'de faiz kazanir) ve TOKEN alir. Ayni kasa kodu kullanilir.
const MI = process.argv.indexOf("--market");
const MARKET = MI > 0 ? { sym: String(process.argv[MI + 1] || ""), token: String(process.argv[MI + 2] || "") } : null;
if (MARKET && (!/^[A-Za-z0-9]{1,12}$/.test(MARKET.sym) || !/^C[A-Z2-7]{55}$/.test(MARKET.token))) {
  console.error("Kullanim: node deploy.js --market SEMBOL TOKEN_ADRESI");
  process.exit(1);
}

/**
 * Iki fabrikayi birbirine "kardes" olarak tanitir (surum 4). Kasalar zincirleme emrin hedefini buradan
 * dogrular. Her fabrikada yalnizca bir kez ayarlanabilir; daha once ayarlandiysa hata verir ve atlanir.
 */
async function linkSiblings(buy, sell) {
  for (const [from, to, label] of [
    [buy, sell, "alim -> satis"],
    [sell, buy, "satis -> alim"],
  ]) {
    try {
      await run(
        `kardes fabrika (${label})`,
        Operation.invokeContractFunction({ contract: from, function: "set_sibling", args: [new Address(to).toScVal()] }),
      );
    } catch (e) {
      console.log(`UYARI kardes fabrika (${label}) ayarlanamadi: ${e.message.split("\n")[0]}`);
      console.log("  Zincirleme emir (al, sonra sat) bu fabrikanin kasalarinda calismaz. Iki fabrikayi birlikte yeniden kurun.");
    }
  }
}

/**
 * Surum 7 kurulumu: iora_vault.wasm yuklenir, iora_factory.wasm kurulur. Dolum ucreti ust sinirlari alinan
 * tokene gore bir tabloda verilir (XLM alinirken 0,02 XLM, USDC alinirken 0,003 USDC; ortam degiskenleriyle
 * degisir). Alim ve satim ayni fabrikayi kullandigi icin factory-sell.env ayni adresi tasir.
 */
/** Zincirden okuma (islem gondermeden). Basarisizsa null. */
async function simRead(contract, fn, args) {
  try {
    const account = await server.getAccount(me);
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASS })
      .addOperation(Operation.invokeContractFunction({ contract, function: fn, args }))
      .setTimeout(60)
      .build();
    const sim = await server.simulateTransaction(tx);
    return sim.result && sim.result.retval ? scValToNative(sim.result.retval) : null;
  } catch {
    return null;
  }
}

async function mainV7() {
  console.log(`kurulum hesabi: ${me} (surum ${V8 ? 8 : 7}: tek kasa)`);
  // USDC karsisinda islem goren diger coinler (testnet/pairs.env PAIRS=SEMBOL:token,...)
  const PAIRS = V8
    ? String(readEnv(path.join(root, "testnet/pairs.env")).PAIRS || "")
        .split(",")
        .map((x) => x.trim().split(":"))
        .filter((p) => p.length === 2 && /^C[A-Z2-7]{55}$/.test(p[1]) && p[1] !== USDC && p[1] !== XLM)
    : [];
  const symOf = Object.fromEntries([[XLM, "XLM"], [USDC, "USDC"], ...PAIRS.map(([s, t]) => [t, s])]);
  const vaultHash = await upload("iora_vault.wasm");
  const factoryHash = await upload("iora_factory.wasm");
  console.log(`kasa wasm hash: ${vaultHash.toString("hex")}`);
  const addr = (a) => new Address(a).toScVal();
  const usdcFee = BigInt(process.env.EXEC_FEE_USDC_UNITS || 30_000);
  const feeList = [
    [XLM, BigInt(process.env.EXEC_FEE_XLM_UNITS || 200_000)],
    [USDC, usdcFee],
  ];
  // Diger coinlerde ust sinir, USDC ust sinirinin o coindeki karsiligidir (kurulum anindaki havuz fiyatiyla).
  for (const [sym, tok] of PAIRS) {
    const q = await simRead(ROUTER, "router_get_amounts_out", [
      nativeToScVal(usdcFee, { type: "i128" }),
      xdr.ScVal.scvVec([addr(USDC), addr(tok)]),
    ]);
    const cap = Array.isArray(q) && q.length ? BigInt(q[q.length - 1]) : 0n;
    if (cap > 0n) feeList.push([tok, cap]);
    else console.log(`UYARI ${sym}: fiyat okunamadi, bu coin alinirken dolum ucreti olmayacak`);
  }
  const fees = feeList
    .filter(([, v]) => v > 0n)
    // Soroban'da harita anahtarlari sirali olmalidir (sozlesme adresinin ham baytlarina gore).
    .sort((a, b) => Buffer.compare(Buffer.from(StrKey.decodeContract(a[0])), Buffer.from(StrKey.decodeContract(b[0]))));
  const feeMap = xdr.ScVal.scvMap(fees.map(([t, v]) => new xdr.ScMapEntry({ key: addr(t), val: nativeToScVal(v, { type: "i128" }) })));
  console.log(`dolum ucreti ust sinirlari: ${fees.map(([t, v]) => `${symOf[t]} alirken ${Number(v) / 1e7}`).join(", ")}`);
  const tokens = [USDC, XLM, ...PAIRS.map(([, t]) => t)];
  if (V8) console.log(`izinli tokenlar: ${tokens.map((t) => symOf[t]).join(", ")}`);
  const factory = await run(
    "fabrika kurulumu",
    Operation.createCustomContract({
      address: new Address(me),
      wasmHash: factoryHash,
      salt: crypto.randomBytes(32),
      constructorArgs: [addr(me), nativeToScVal(vaultHash, { type: "bytes" }), addr(POOL), addr(ROUTER), feeMap, ...(V8 ? [xdr.ScVal.scvVec(tokens.map(addr))] : [])],
    }),
  );
  if (!factory || !String(factory).startsWith("C")) throw new Error(`fabrika adresi alinamadi: ${factory}`);
  const envFile = path.join(root, "testnet/factory.env");
  fs.writeFileSync(envFile, `FACTORY=${factory}\nVAULT_WASM_HASH=${vaultHash.toString("hex")}\nVAULT_V=${V9 ? 9 : V8 ? 8 : 7}\n`);
  fs.writeFileSync(path.join(root, "testnet/factory-sell.env"), `FACTORY_SELL=${factory}\n`);
  console.log(`FACTORY=${factory}`);
  console.log(`testnet/factory.env ve factory-sell.env guncellendi (tek fabrika, VAULT_V=${V9 ? 9 : V8 ? 8 : 7})`);
}

async function main() {
  if (V7) return mainV7();
  console.log(`kurulum hesabi: ${me}${SELL ? " (satis fabrikasi: XLM -> USDC)" : MARKET ? ` (ek pazar: XLM -> ${MARKET.sym})` : ""}`);
  const known = readEnv(path.join(root, "testnet/factory.env")).VAULT_WASM_HASH;
  if (MARKET && !known) throw new Error("once ana fabrikalar kurulmali (testnet/factory.env yok)");
  const vaultHash = (SELL || MARKET) && known ? Buffer.from(known, "hex") : await upload("order_vault.wasm");
  const factoryHash = await upload("vault_factory.wasm");
  console.log(`kasa wasm hash: ${vaultHash.toString("hex")}`);

  const addr = (a) => new Address(a).toScVal();
  // Dolum ucreti (surum 5): dolumu yapana dolum basina odenebilecek AZAMI tutar, kasanin ALDIGI token
  // cinsinden (7 ondalik). Yalnizca limitten iyi gelen kisimdan kesilir; kurulumdan sonra degistirilemez.
  // Varsayilan bir dolumun ag masrafina yakin: alim kasasinda 0,02 XLM, satis kasasinda 0,003 USDC.
  // Ek pazarlarda (gostermelik) ucret yok.
  const execFee = MARKET
    ? 0n
    : SELL
      ? BigInt(process.env.EXEC_FEE_USDC_UNITS || 30_000)
      : BigInt(process.env.EXEC_FEE_XLM_UNITS || 200_000);
  console.log(`dolum ucreti (azami, dolum basina): ${Number(execFee) / 1e7} ${MARKET ? MARKET.sym : SELL ? "USDC" : "XLM"}`);
  const factory = await run(
    "fabrika kurulumu",
    Operation.createCustomContract({
      address: new Address(me),
      wasmHash: factoryHash,
      salt: crypto.randomBytes(32),
      constructorArgs: [
        addr(me), // guardian
        nativeToScVal(vaultHash, { type: "bytes" }),
        // Kasa "usdc" alanindaki tokeni yatirir/Blend'e koyar, "xlm" alanindakini alir.
        addr(SELL || MARKET ? XLM : USDC),
        addr(MARKET ? MARKET.token : SELL ? USDC : XLM),
        addr(POOL),
        addr(ROUTER),
        nativeToScVal(execFee, { type: "i128" }),
      ],
    }),
  );
  if (!factory || !String(factory).startsWith("C")) throw new Error(`fabrika adresi alinamadi: ${factory}`);

  if (MARKET) {
    // testnet/markets.env: MARKETS=SEMBOL:token:fabrika,... (arayuz ve keeper buradan okur)
    const file = path.join(root, "testnet/markets.env");
    const old = String(readEnv(file).MARKETS || "").split(",").filter(Boolean).filter((x) => x.split(":")[0] !== MARKET.sym);
    old.push(`${MARKET.sym}:${MARKET.token}:${factory}`);
    fs.writeFileSync(file, `MARKETS=${old.join(",")}\n`);
    console.log(`PAZAR ${MARKET.sym} FABRIKA=${factory}`);
    console.log("testnet/markets.env guncellendi");
    return;
  }
  if (SELL) {
    const sellFile = path.join(root, "testnet/factory-sell.env");
    fs.writeFileSync(sellFile, `FACTORY_SELL=${factory}\n`);
    console.log(`FACTORY_SELL=${factory}`);
    console.log("testnet/factory-sell.env yazildi (alim fabrikasi degismedi)");
    const buy = readEnv(path.join(root, "testnet/factory.env")).FACTORY;
    if (buy) await linkSiblings(buy, String(factory));
    return;
  }
  const envFile = path.join(root, "testnet/factory.env");
  if (fs.existsSync(envFile)) fs.copyFileSync(envFile, path.join(root, "testnet/factory.v1.env"));
  // VAULT_V: arayuz bu surume gore cagri imzalarini secer (scripts/build-web.sh okur).
  fs.writeFileSync(envFile, `FACTORY=${factory}\nVAULT_WASM_HASH=${vaultHash.toString("hex")}\nVAULT_V=5\n`);
  console.log(`FACTORY=${factory}`);
  console.log("testnet/factory.env guncellendi (eskisi factory.v1.env)");
}

main().catch((e) => {
  console.error(`HATA: ${e.message}`);
  process.exit(1);
});
