// Vercel serverless function: the market price history of a coin, for the chart before Iora's pools existed.
// GET /api/history?coin=XLM (also BTC, ETH, SOL, AVAX, XRP, or an Iora test token such as iBTC: the coin it follows)
//   -> { ok: true, coin, source: "Kraken" | "Reflector", unit: "USD", at, candles: [[t, tf, open, high, low, close]] }
//      t: start of the candle (seconds), tf: its size (900, 3600, 14400 or 86400 s), oldest first, no overlaps:
//      15-minute candles for the last week, then 1 hour (30 days), 4 hours (120 days), 1 day (a year).
//
// Source: Kraken's public OHLC endpoint (no key; up to 720 candles per size). If Kraken cannot be reached, the
// Reflector oracle on testnet (the price Iora's pools are kept at), which keeps only about 20 hours: hourly prices
// for that time and 5-minute prices for the last 100 minutes.
//
// Privacy and limits: the browser asks only this function (same site, no new domain in the page's CSP), so Kraken
// never sees the user's IP or wallet. Each answer is kept for 5 minutes by Vercel's CDN (s-maxage) and in the
// function's memory, so Kraken is asked at most a few times per coin per 5 minutes whatever the number of users.
const lib = require("./_history-lib.cjs");

const KRAKEN = "https://api.kraken.com/0/public/OHLC";
const RPC = process.env.HISTORY_RPC_URL || "https://soroban-testnet.stellar.org";
const REFLECTOR = process.env.HISTORY_REFLECTOR || "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63"; // CEX/DEX prices, Other(SYMBOL), 14 decimals
const FRESH = 5 * 60 * 1000;
const memo = new Map(); // coin -> { at, body }

async function fromKraken(coin, now) {
  const layers = await Promise.all(
    lib.LAYERS.map(async (L) => {
      const r = await fetch(`${KRAKEN}?pair=${lib.COINS[coin]}&interval=${L.tf / 60}`, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`kraken ${r.status}`);
      return { ...L, candles: lib.krakenCandles(await r.json()) };
    }),
  );
  const candles = lib.joinLayers(layers, now);
  if (!candles.length) throw new Error("kraken: no candles");
  return { source: "Kraken", candles };
}

async function fromReflector(coin, now) {
  const sdk = await import("@stellar/stellar-sdk"); // import(): see api/convert.js
  const { rpc, Contract, TransactionBuilder, Account, Networks, xdr, nativeToScVal, scValToNative } = sdk;
  const server = new rpc.Server(RPC);
  const src = new Account("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7", "0"); // any account: only simulated
  const asset = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Other"), xdr.ScVal.scvSymbol(coin)]);
  const call = async (fn, args) => {
    const tx = new TransactionBuilder(src, { fee: "100", networkPassphrase: Networks.TESTNET }).addOperation(new Contract(REFLECTOR).call(fn, ...args)).setTimeout(30).build();
    const r = await server.simulateTransaction(tx);
    return r.error || !r.result ? null : scValToNative(r.result.retval);
  };
  const dec = Number(await call("decimals", [])) || 14;
  const asPt = (x) => (x && x.price !== undefined ? { t: Number(x.timestamp), p: Number(x.price) / 10 ** dec } : null);
  const recent = ((await call("prices", [asset, nativeToScVal(20, { type: "u32" })])) || []).map(asPt).filter(Boolean);
  const hours = [];
  for (let h = 2; h <= 20; h++) hours.push(Math.floor((now - h * 3600) / 300) * 300);
  const hourly = (await Promise.all(hours.map((t) => call("price", [asset, nativeToScVal(t, { type: "u64" })]).catch(() => null)))).map(asPt).filter(Boolean);
  const start = recent.length ? Math.min(...recent.map((x) => x.t)) : Infinity;
  const candles = [...lib.flatCandles(hourly.filter((x) => x.t + 3600 <= start), 3600), ...lib.flatCandles(recent, 300)].sort((a, b) => a[0] - b[0]);
  if (!candles.length) throw new Error("reflector: no prices");
  return { source: "Reflector", candles };
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("cache-control", "no-store");
    return res.status(405).json({ ok: false, error: "method" });
  }
  const coin = lib.coinOf(req.query && req.query.coin);
  if (!coin) {
    res.setHeader("cache-control", "public, max-age=3600");
    return res.status(404).json({ ok: false, error: "coin", coins: Object.keys(lib.COINS) });
  }
  const now = Math.floor(Date.now() / 1000);
  const m = memo.get(coin);
  let body = m && Date.now() - m.at < FRESH ? m.body : null;
  if (!body) {
    let got = null;
    try {
      got = await fromKraken(coin, now);
    } catch (e) {
      console.warn("history kraken", coin, String(e && e.message));
      // An older Kraken answer (a year long) is better than Reflector's 20 hours; Reflector only without one.
      if (m && m.body.source === "Kraken") body = m.body;
      else
        try {
          got = await fromReflector(coin, now);
        } catch (e2) {
          console.warn("history reflector", coin, String(e2 && e2.message));
        }
    }
    if (got) {
      body = { ok: true, coin, source: got.source, unit: "USD", at: now, candles: got.candles };
      memo.set(coin, { at: Date.now(), body });
    } else if (!body && m) body = m.body; // both down: the last answer, however old
  }
  if (!body) {
    res.setHeader("cache-control", "no-store");
    return res.status(503).json({ ok: false, error: "unavailable" });
  }
  // The CDN keeps it 5 minutes and may serve it up to an hour more while it asks again in the background.
  res.setHeader("cache-control", "public, max-age=60, s-maxage=300, stale-while-revalidate=3600");
  return res.status(200).json(body);
};
