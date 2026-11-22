// Soroban RPC baglantisi: hizli sunucu once, sorun olursa yedek.
//
// Stellar'in ucretsiz testnet RPC'si (soroban-testnet.stellar.org) bazi baglantilardan 1,5-5 sn'de cevap
// veriyor (8.11.2026 olcumu); Gateway'in herkese acik testnet RPC'si ayni isi ~0,15 sn'de yapiyor. Uygulama
// acilista onlarca okuma yaptigi icin bu fark sayfanin acilma suresini dogrudan belirler.
// Ilk sunucu ag hatasi verir, 429/5xx doner ya da TIMEOUT_MS icinde cevap vermezse ayni cagri siradaki
// sunucuda tekrarlanir; bir dakika sonra yeniden ilk sunucu denenir. Sozlesme hatalari (simulasyon hatasi,
// "hesap yok" gibi) gercek cevaptir: baska sunucuda tekrarlanmaz.
import { Account, Keypair, rpc, xdr } from "@stellar/stellar-sdk";

export const RPC_PRIMARY = "https://soroban-rpc.testnet.stellar.gateway.fm";
export const RPC_FALLBACK = "https://soroban-testnet.stellar.org";
const TIMEOUT_MS = 8000;
const RETRY_PRIMARY_MS = 60_000;

// Stellar SDK her istege X-Client-Name / X-Client-Version basliklarini ekler. Gateway'in tarayici (CORS) ayari
// bu basliklara izin vermedigi icin tarayici istegi hic gondermiyor; SDK de bu ag hatasini "Account not found"
// diye bildiriyordu (8.11.2026). Basliklar yalnizca bilgi amacli: RPC adreslerimize giden isteklerden cikarilir.
const rpcBases = new Set();
function stripClientHeaders(headers) {
  const h = new Headers(headers || {});
  h.delete("x-client-name");
  h.delete("x-client-version");
  return h;
}
if (typeof window !== "undefined" && typeof window.fetch === "function" && !window.__ioraRpcFetch) {
  const orig = window.fetch.bind(window);
  window.__ioraRpcFetch = true;
  window.fetch = (input, init) => {
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
      if (url && [...rpcBases].some((b) => url.startsWith(b))) {
        if (init) init = { ...init, headers: stripClientHeaders(init.headers) };
        else if (input instanceof Request) input = new Request(input, { headers: stripClientHeaders(input.headers) });
      }
    } catch {}
    return orig(input, init);
  };
}

function transient(e) {
  const status = e && e.response && e.response.status;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  return /failed to fetch|network|timeout|timed out|aborted|ECONN|socket|load failed|rpc yanit/i.test(String((e && e.message) || e));
}

// SDK'nin getAccount'u hesabin okunamadigi her durumu (ag hatasi, CORS dahil) "Account not found" diye bildirir;
// bu yuzden ilk sunucu coktugunde yedege gecilemez, imzalanacak her islem "hesap yok" hatasiyla dururdu. Ayni
// okuma burada getLedgerEntries ile yapilir: ag hatasi siradaki sunucuda denenir, gercekten olmayan hesap ise
// tek cagrida (yavas yedege gitmeden) "Account not found" doner. SDK 17.4.0'daki getAccount ile ayni okuma.
function accountKey(address) {
  return xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrPublicKey() }));
}

/** urls: denenecek RPC adresleri (sirayla). Donen nesne rpc.Server ile ayni metotlara sahiptir. */
export function makeServer(urls) {
  const list = [...new Set(urls.filter(Boolean))];
  for (const u of list) rpcBases.add(u.replace(/\/+$/, ""));
  const servers = list.map((u) => new rpc.Server(u, { allowHttp: u.startsWith("http://") }));
  let cur = 0;
  let switchedAt = 0;

  async function call(name, args) {
    if (cur !== 0 && Date.now() - switchedAt > RETRY_PRIMARY_MS) cur = 0;
    let lastErr;
    for (let i = 0; i < servers.length; i++) {
      const idx = (cur + i) % servers.length;
      let timer;
      try {
        const res = await Promise.race([
          servers[idx][name](...args),
          new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("RPC yanit vermedi (timeout)")), TIMEOUT_MS))),
        ]);
        if (idx !== cur) {
          cur = idx;
          switchedAt = Date.now();
        }
        return res;
      } catch (e) {
        lastErr = e;
        if (!transient(e)) throw e;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  async function getAccount(address) {
    const res = await call("getLedgerEntries", [accountKey(address)]);
    const entry = res && res.entries && res.entries[0];
    if (!entry || !entry.val || entry.val.type !== "account") throw new Error(`Account not found: ${address}`);
    return new Account(address, entry.val.value.seqNum.toString());
  }

  return new Proxy(
    {},
    {
      get(_, name) {
        if (name === "urls") return list;
        if (name === "getAccount") return getAccount;
        // "then" ve metot olmayan alanlar oldugu gibi doner: nesne yanlislikla await edilirse takilmasin.
        const v = servers[0][name];
        if (name === "then" || typeof name === "symbol" || (v !== undefined && typeof v !== "function")) return v;
        return (...args) => call(name, args);
      },
    },
  );
}
