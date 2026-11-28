// Which problems the Iora bots check tells, and when. No network, no files: check-bots.js passes the previous
// state in and writes the next one out.
//
// - A new problem is told at once (after its delayMin, if it has one).
// - The same alarm at most every ALARM_REPEAT_MIN (60 min); a stock or soft warning at most every STOCK_REPEAT_H
//   (12 h).
// - When a problem that was told clears: one "OK (was: ...)" line. An alarm that comes back after that is told again
//   at once (as keeper/monitor/check-heartbeat.sh does). A stock or soft warning that comes back is not told again
//   before its 12 h are over, so a balance or a connection that flaps around its limit does not flood the chat.
// - Keys under `unknown` (not checked this time) keep their state; keys under `ignore` are dropped silently.
// - If the message could not be delivered, the state for failState is written instead: the same lines are tried
//   again on the next run.
//
// State: { items: { KEY: { key, level, title, text, delayMin, since, lastSent, told, present } } }
//   since: when the problem started (ms); lastSent: when it was last told (ms); told: told since it started;
//   present: seen on the last run (false: only remembered for the repeat window).

export const TAG = { alarm: "ALARM", stock: "LOW", soft: "NOTE" };
const MAX_MESSAGE = 3800; // Telegram takes 4096 characters

export function step(prev, problems, { unknown = [], ignore = [] } = {}, now, cfg) {
  const old = prev && prev.items && typeof prev.items === "object" ? prev.items : {};
  const under = (prefixes, key) => prefixes.some((p) => key.startsWith(p));
  const repeatMs = (level) => (level === "alarm" ? cfg.alarmRepeatMin * 60e3 : cfg.stockRepeatH * 3600e3);
  const ripe = (it) => now - it.since >= (it.delayMin ?? 0) * 60e3;
  const ok = {}; // the next state when the message is delivered
  const fail = {}; // ... when it is not
  const send = [];
  const recovered = [];
  const active = [];
  const pending = [];

  for (const p of problems) {
    if (ok[p.key]) continue; // the first problem with a key wins
    const o = old[p.key];
    const going = !!(o && o.present);
    const it = {
      key: p.key,
      level: p.level,
      title: p.title,
      text: p.text,
      delayMin: p.delayMin ?? 0,
      since: going && Number.isFinite(o.since) ? o.since : now,
      // an alarm that cleared starts afresh; a stock / soft warning remembers when it was last told
      lastSent: o && Number.isFinite(o.lastSent) && (going || p.level !== "alarm") ? o.lastSent : null,
      told: going && !!o.told,
      present: true,
    };
    if (!ripe(it)) {
      pending.push(it);
      ok[p.key] = fail[p.key] = it;
      continue;
    }
    active.push(it);
    if (it.lastSent === null || now - it.lastSent >= repeatMs(it.level)) {
      send.push(it);
      ok[p.key] = { ...it, lastSent: now, told: true };
      fail[p.key] = it;
    } else {
      ok[p.key] = fail[p.key] = it;
    }
  }

  for (const [key, o] of Object.entries(old)) {
    if (ok[key] || !o || typeof o !== "object") continue;
    if (under(ignore, key)) continue;
    if (under(unknown, key)) {
      ok[key] = fail[key] = o;
      if (o.present && Number.isFinite(o.since) && ripe(o)) active.push({ ...o, carried: true });
      continue;
    }
    const remember = o.level !== "alarm" && Number.isFinite(o.lastSent) && now - o.lastSent < repeatMs(o.level);
    if (o.present) {
      // it cleared
      if (o.told) recovered.push(o);
      const mem = remember ? { ...o, present: false, told: false } : null;
      if (mem) ok[key] = mem;
      if (o.told) fail[key] = o; // the "OK" line was not delivered: it is said next time
      else if (mem) fail[key] = mem;
    } else if (remember) {
      ok[key] = fail[key] = o;
    }
  }

  return {
    send,
    recovered,
    active,
    pending,
    state: { items: ok },
    failState: { items: fail },
    exitCode: active.some((i) => i.level !== "soft") ? 1 : 0,
  };
}

/** The Telegram message for a step, or null when there is nothing to tell. */
export function message(plan, host) {
  const lines = [...plan.send.map((i) => `${TAG[i.level] ?? i.level} ${i.text}`), ...plan.recovered.map((i) => `OK (was: ${i.title})`)];
  if (lines.length === 0) return null;
  const head = plan.send.some((i) => i.level === "alarm") ? "ALARM" : plan.send.length > 0 ? "WARNING" : "recovered";
  const text = `[Iora bots] ${head} on ${host}\n${lines.join("\n")}`;
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 4)}\n...` : text;
}

/** One line per problem for the journal (every run). */
export function summary(plan) {
  const lines = [
    ...plan.active.map((i) => `${TAG[i.level] ?? i.level}${i.carried ? " (not checked this time)" : ""} ${i.text}`),
    ...plan.pending.map((i) => `WAIT ${i.text} (told if it lasts ${i.delayMin} min)`),
  ];
  return lines.length ? lines.join("\n") : "OK: no problems";
}
