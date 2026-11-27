// Pure network logic for wallets (no DOM, no wallet calls), so it can be tested on its own.
// Wallets do not let a website switch their network. Some sign for the network named in the request anyway
// (they never need switching); the others must be switched by the user, and the app then waits for it.

export const TESTNET = "Test SDF Network ; September 2015";
export const PUBLIC = "Public Global Stellar Network ; September 2015";
export const FUTURENET = "Test SDF Future Network ; October 2022";

/**
 * What each wallet can do (ids are Stellar Wallets Kit module ids; "varial" is the Freighter-API wallet path).
 *   testnet      "yes" | "no" | "unknown"   does the wallet work on testnet at all
 *   byRequest    true: it signs for the network passed in the request (networkPassphrase), whatever it shows
 *   query        it can tell the app its current network (getNetwork)
 *   steps        how the user switches it to testnet (shown only when it must be switched)
 *   warn         said when it connects (a wallet that cannot be told which network to sign for)
 * Sources: see web-network-switch.md (Varial/Freighter docs and source, the kit's module source, the wallets' docs).
 * Freighter is now called Varial (same wallet, same API); the kit's module id is "freighter" (2.7) or "varial" (2.8+).
 */
export const WALLETS = Object.freeze({
  varial: {
    name: "Varial",
    testnet: "yes",
    byRequest: false,
    query: true,
    steps: ["Open Varial and click your account name at the top left.", "Click the settings (gear) icon, then <b>Network</b>.", "Choose <b>Test Net</b>."],
  },
  freighter: {
    name: "Freighter",
    testnet: "yes",
    byRequest: false,
    query: true,
    steps: ["Open Freighter (the extension icon in your browser bar).", "Click the network name at the top (it says <i>Main Net</i>).", "Choose <b>Test Net</b>."],
  },
  albedo: { name: "Albedo", testnet: "yes", byRequest: true, query: false, steps: [] },
  xbull: { name: "xBull", testnet: "yes", byRequest: true, query: false, steps: [] },
  // Rabet takes the network with each signing request, but what it does on a mismatch is not documented: not labelled.
  rabet: { name: "Rabet", testnet: "yes", byRequest: false, query: false, steps: ["Open Rabet.", "Open its network menu.", "Choose <b>Testnet</b>."] },
  hana: { name: "Hana", testnet: "unknown", byRequest: false, query: false, steps: ["Open Hana Wallet.", "Open its network setting.", "Choose <b>Testnet</b>."] },
  // LOBSTR cannot be told which network to sign for (the kit drops it), and its testnet support is not documented.
  lobstr: {
    name: "LOBSTR",
    testnet: "unknown",
    byRequest: false,
    query: false,
    steps: [],
    warn: "LOBSTR can't be told to sign for testnet, so it may not work with Iora during the testnet beta.",
  },
});
const UNKNOWN = Object.freeze({ name: "", testnet: "unknown", byRequest: false, query: false, steps: ["Open your wallet's settings.", "Find its network setting.", "Choose <b>Testnet</b>."] });

/** The capabilities of a wallet by its id (or product name); an unknown wallet gets the careful default. */
export function capabilityOf(id) {
  const k = String(id || "").toLowerCase().replace(/[^a-z]/g, "");
  return WALLETS[k] || (k.startsWith("xbull") ? WALLETS.xbull : k.startsWith("hana") ? WALLETS.hana : k.startsWith("freighter") ? WALLETS.freighter : k.startsWith("varial") ? WALLETS.varial : UNKNOWN);
}
/** Wallets that work on testnet without switching anything (listed first, with a label, in the wallet picker). */
export const noSwitchIds = () => Object.entries(WALLETS).filter(([, w]) => w.byRequest && w.testnet === "yes").map(([id]) => id);
/** Wallets to suggest instead of one without testnet. */
export const SUGGESTED = ["Varial (Freighter)", "xBull", "Albedo"];

/**
 * The network a wallet reports, against the one the app needs:
 *   "ok" | "wrong" | "unknown" (no answer, an error, or the wallet cannot tell: never a reason to block).
 * `answer`: { network?, networkPassphrase?, error? } as getNetwork / getNetworkDetails / WatchWalletChanges give it.
 */
export function networkState(answer, need = TESTNET) {
  if (!answer || answer.error) return "unknown";
  if (answer.networkPassphrase) return answer.networkPassphrase === need ? "ok" : "wrong";
  const n = String(answer.network || "").toUpperCase();
  if (!n) return "unknown";
  if (need === TESTNET) return n === "TESTNET" ? "ok" : "wrong";
  if (need === PUBLIC) return n === "PUBLIC" || n === "MAINNET" ? "ok" : "wrong";
  return "unknown";
}
/** A readable name for the network a wallet is on. */
export function networkName(answer) {
  const p = answer && answer.networkPassphrase;
  if (p === PUBLIC) return "Mainnet";
  if (p === FUTURENET) return "Futurenet";
  if (p === TESTNET) return "Testnet";
  const n = String((answer && answer.network) || "").toUpperCase();
  if (/PUBLIC|MAIN/.test(n)) return "Mainnet";
  if (/FUTURE/.test(n)) return "Futurenet";
  if (n === "TESTNET") return "Testnet";
  return n ? n.charAt(0) + n.slice(1).toLowerCase() : "another network";
}
/** Must the app check (and possibly wait for) the wallet's network before asking it to sign? */
export const mustCheck = (cap) => !cap.byRequest && cap.testnet !== "no";

/**
 * Transactions waiting for the wallet to be switched. `wait()` gives a promise that resolves to true when the
 * network becomes right (the transaction then continues by itself), or false if the user cancels / it times out.
 */
export function createNetWait() {
  let waiters = [];
  const settle = (v) => {
    const w = waiters;
    waiters = [];
    for (const r of w) r(v);
    return w.length;
  };
  return {
    wait() {
      return new Promise((resolve) => waiters.push(resolve));
    },
    get waiting() {
      return waiters.length;
    },
    /** Feed every network reading here; "ok" releases the waiting transactions. Returns how many continued. */
    update(state) {
      return state === "ok" ? settle(true) : 0;
    },
    /** The user went on anyway ("I already switched"): the wallet has the last word. */
    proceed() {
      return settle(true);
    },
    cancel() {
      return settle(false);
    },
  };
}
