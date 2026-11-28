#!/usr/bin/env node
// Iora bots check (TESTNET). Looks after what otherwise fails silently, and tells the keeper heartbeat's Telegram
// chat. One check per call: systemd runs it every 5 minutes (iora-bots-check.timer). It sends no transaction.
//
//   - the price bot (iora-price-bot), the USDC borrower (iora-blend-borrower) and the multi-coin borrower
//     (iora-blend-borrower-multi): timer not active, last run failed, no successful run for too long, the price
//     bot's inventory warnings, a pool off the Reflector price for several runs in a row, a borrower's health
//     factor below MIN_HF. It reads each bot's status file (written at the end of every run by the bot's status.js)
//     and `systemctl show`.
//   - the site's faucet account (Horizon, read only): Circle USDC and XLM left.
//   - the USDC exchange contract: its Circle USDC balance, read with a simulation (nothing is signed or sent).
//
// The rules are in rules.js, what is told and when (once an hour / every 12 h, "OK" when it clears) in alerts.js,
// the reading and sending in monitor.js.
//
// Usage:  node check-bots.js
// Settings come from the environment: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID (/etc/iora/heartbeat.env), the rest
// optional (/etc/iora/monitor.env, see monitor.env.example). Without the Telegram settings the messages only go to
// stderr (the journal).
// Exit code: 0 nothing wrong (or only soft notices), 1 an alarm or a stock warning is active, 2 the check itself
// failed (also told on Telegram, at most once an hour).
import { hideToken, main, reportCrash } from "./monitor.js";

try {
  process.exitCode = await main();
} catch (e) {
  console.error(`the bots check failed: ${hideToken(e?.stack ?? e, process.env)}`);
  try {
    await reportCrash(e);
  } catch {}
  process.exitCode = 2;
}
