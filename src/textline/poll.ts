// SPDX-License-Identifier: AGPL-3.0-only
// The text channel's poller. Hosted agents can't be pushed to, so something has to look:
// every cadence_minutes (5 by default) one tick on the hub
//   1. reads Louis's replies and applies them (approve, reject, later, a number),
//   2. under the server's write queue only (start), lets unanswered proposals expire (deck.ts),
//      skipping anything just answered,
//   3. gathers every open item (items.ts) and the hub's health,
//   4. applies rules/escalation.yaml (tiers, quiet hours, batching, resolver grace,
//      private and money always escalate), and
//   5. sends at most one text, through the configured transport or its fallback.
// State lives in textline/ (not committed): what was texted when, snoozes, health streaks.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { today } from "../brain";
import { loadRules } from "../rules";
import { runAction } from "../dashboard/actions";
import { answerDispute, ownerDecide, CoreError } from "../core";
import { openItems, healthChecks, heartbeatFile, type Item, type Fetch, type HealthResult } from "./items";
import { loadEscalation, inQuietHours, type EscalationPolicy, type Tier } from "./policy";
import { compose, parseReply, type Command } from "./message";
import { makeTransport, markOutbox, outbox, type TextTransport, type IncomingText } from "./transport";
import { ownerRef } from "../owner";
import { recordReexplain } from "../measure";
import { appendJsonl } from "../util";
import { declineAction } from "../act";
import { runAuto } from "../deck";

interface ItemState { first_seen: string; last_texted?: string; texted?: number; snoozed_until?: string; done?: string }
interface SentRecord { id: string; at: string; transport: string; letters: Record<string, string>; kind: "batch" | "ack" | "health" }
export interface TextState {
  items: Record<string, ItemState>;
  last_batch?: string;
  sent: SentRecord[];
  health: Record<string, { fails: number; down_since?: string; texted?: boolean }>;
  tick_errors?: number;
}

// A queued text whose items are all decided or gone stops being served and loses its words: a
// parked Instinct would otherwise keep pulling a source quote after the owner decided (G95).
export function retireAnsweredTexts(root: string, open = new Set(openItems(root).map((i) => i.key))): number {
  const queued = outbox(root).filter((m) => m.status === "queued");
  if (!queued.length) return 0;
  const sent = new Map(loadTextState(root).sent.map((s) => [s.id, s]));
  let n = 0;
  for (const m of queued) {
    const keys = Object.values(sent.get(m.id)?.letters ?? {});
    if (keys.length && !keys.some((k) => open.has(k)) && markOutbox(root, m.id, "superseded")) n++;
  }
  return n;
}

const stateFile = (root: string) => join(root, "textline", "state.json");
export function loadTextState(root: string): TextState {
  try { if (existsSync(stateFile(root))) return { items: {}, sent: [], health: {}, ...JSON.parse(readFileSync(stateFile(root), "utf8")) }; } catch { /* torn: start over */ }
  return { items: {}, sent: [], health: {} };
}
function saveState(root: string, s: TextState) {
  mkdirSync(join(root, "textline"), { recursive: true });
  s.sent = s.sent.slice(-50);
  writeFileSync(stateFile(root), JSON.stringify(s, null, 1));
}
function audit(root: string, entry: Record<string, unknown>) {
  appendJsonl(join(root, "textline", "log.jsonl"), { at: new Date().toISOString(), ...entry });
}
const minutes = (a: Date, b: string | undefined) => (b ? (a.getTime() - new Date(b).getTime()) / 60_000 : Infinity);

// `lock`: the server's write queue (src/server.ts serial). Only a tick given it lets the hub decide
// for the owner; a tick run beside the server (cron `textline once`) leaves that to the hub.
export type Lock = <T>(fn: () => T) => Promise<T>;
export interface TickOptions { now?: Date; transport?: TextTransport; fallback?: TextTransport; fetch?: Fetch; dryRun?: boolean; lock?: Lock }
export interface TickResult { auto?: string[]; applied: string[]; sent?: { text: string; via: string; keys: string[] }; acks: string[]; waiting: number; reason: string; health: HealthResult[] }

export function tierOf(p: EscalationPolicy, it: Item): Tier {
  const t = p.tiers[it.kind] ?? "normal";
  if (t === "low" && ((it.private && p.always_escalate.private) || (it.money && p.always_escalate.money))) return "normal";
  return t;
}

// ---------- replies ----------

interface Applied { line: string; changed: boolean }

function act(root: string, p: EscalationPolicy, st: TextState, it: Item, c: Command, msg: IncomingText, trusted: boolean, now: Date): Applied {
  const s = (st.items[it.key] ??= { first_seen: now.toISOString() });
  const relayedOnly = (what: string) => ({ line: `${what} needs your own phone or the dashboard, not a relayed reply`, changed: false });
  const via = `text-${msg.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60)}`;
  if (c.verb === "later") { s.snoozed_until = new Date(now.getTime() + p.snooze_hours * 3_600_000).toISOString(); return { line: `later (${p.snooze_hours}h)`, changed: false }; }
  try {
    switch (it.kind) {
      case "proposal":
        if (c.verb === "approve" || c.verb === "ok") {
          if (!trusted && it.private) return relayedOnly("approving a private change");
          return { line: `approved: ${runAction({ root }, "proposal-accept", { file: it.ref })}`, changed: true };
        }
        if (c.verb === "reject") return { line: runAction({ root }, "proposal-reject", { file: it.ref }), changed: true };
        break;
      case "mail":
        if (c.verb === "approve" || c.verb === "ok") {
          if (!trusted) return relayedOnly("releasing held mail");
          return { line: runAction({ root }, "mail-release", { id: it.ref }), changed: true };
        }
        if (c.verb === "reject") return { line: runAction({ root }, "mail-drop", { id: it.ref }), changed: true };
        break;
      case "capture":
        if (c.verb === "approve" || c.verb === "ok") {
          if (!trusted) return relayedOnly("releasing a held capture");
          return { line: runAction({ root }, "capture-release", { file: it.ref }), changed: true };
        }
        if (c.verb === "reject") return { line: runAction({ root }, "capture-discard", { file: it.ref }), changed: true };
        break;
      case "held-answer":
        if (c.verb === "approve" || c.verb === "ok") {
          if (!trusted) return relayedOnly("confirming a relayed answer");
          return { line: runAction({ root }, "dispute-confirm", { id: it.ref }), changed: true };
        }
        if (c.verb === "reject") return { line: runAction({ root }, "dispute-reject", { id: it.ref }), changed: true };
        break;
      // An agent's mail (src/act.ts): approved in the dashboard only, never by text, trusted or
      // relayed (red team H1, M4). A reply quoting its code may reject it or put it off (G146,
      // applyReply); ok, yes or approve change nothing.
      case "action":
        if (c.verb === "reject") return { line: declineAction(root, it.ref, via), changed: true };
        return { line: `a mail is approved in the dashboard only; reply reject ${it.code} to drop it`, changed: false };
      case "dispute": {
        if (c.verb === "reject") return { line: "no change; reply a number, or decide in the dashboard", changed: false };
        const choice = c.verb === "pick" ? c.choice : it.suggested;
        if (!choice) return { line: "which one? reply 1 or 2", changed: false };
        if (trusted) return { line: ownerDecide(root, it.ref, choice, via), changed: true };
        // Relayed by the resolver: the same path as Instinct's own /answer. Private facts are
        // held there until Louis confirms them himself.
        const resolver = loadRules(root).policy.resolver;
        if (!resolver) return relayedOnly("a dispute answer");
        const r = answerDispute(root, resolver, it.ref, { choice, message_id: ownerRef(today(), via) });
        return { line: r.status === "answer-held" ? `${it.ref}: noted, held until you confirm it in the dashboard` : `${it.ref}: settled (${choice})`, changed: true };
      }
      default: // alert, upkeep, rules, health: information; ok clears it
        if (c.verb === "ok" || c.verb === "approve") { s.done = now.toISOString(); return { line: "ok, cleared", changed: false }; }
        if (c.verb === "reject") return { line: "still open; act in the dashboard", changed: false };
    }
  } catch (e) {
    if (e instanceof CoreError) return { line: `couldn't: ${e.message}`, changed: false };
    throw e;
  }
  return { line: `"${c.verb}" doesn't fit this one`, changed: false };
}

function applyReply(root: string, p: EscalationPolicy, st: TextState, open: Map<string, Item>, msg: IncomingText, trusted: boolean, now: Date, answered: Set<string>): string {
  // "re: <agent> <what>": the owner had to explain something to an agent again (first-week.md).
  // Only a log line, never a brain change, so a relayed reply may record it too.
  const re = msg.text.trim().match(/^re:\s*([a-z0-9_-]+)\s+([\s\S]+)$/i);
  if (re) {
    audit(root, { reply: msg.id, trusted, reexplain: re[1].toLowerCase() });
    try { return recordReexplain(root, re[1], re[2], trusted ? "text" : "text-relayed"); } catch (e) { return `couldn't: ${(e as Error).message}`; }
  }
  const cmds = parseReply(msg.text);
  const batches = st.sent.filter((x) => Object.keys(x.letters).length);
  const target = (msg.in_reply_to && batches.find((x) => x.id === msg.in_reply_to)) || batches.at(-1);
  audit(root, { reply: msg.id, trusted, parsed: !!cmds, answers: target?.id });
  if (!cmds) return `Didn't get "${msg.text.slice(0, 30)}". Reply like: A approve, B 2, later.`;
  // A code needs no batch (G146), so only a reply with no code stops here.
  if (!target && !cmds.some((c) => c.code)) return "Nothing is waiting on you.";
  const letters = target ? Object.keys(target.letters) : [];
  const out: string[] = [];
  let askedWhich = false;
  for (const c of cmds) {
    // A code names one waiting mail, whichever text it came in (G146). It never falls back to a
    // letter: a code that matches nothing does nothing.
    if (c.code) {
      if (c.letter) out.push(`${c.letter.toUpperCase()} ignored: a code names the mail`);
      const it = [...open.values()].find((i) => i.kind === "action" && i.code === c.code);
      if (!it) { out.push(`${c.code}: no waiting mail with that code`); continue; }
      const r = act(root, p, st, it, c, msg, trusted, now);
      out.push(`${c.code}: ${r.line}`);
      if (r.changed) open.delete(it.key);
      continue;
    }
    // No letter: fine when the text had one item, or for later/ok/reject meant for all.
    const which = c.letter ? [c.letter] : letters.length === 1 || ["later", "ok"].includes(c.verb) ? letters : [];
    if (!which.length) { out.push(`${c.verb}: which one? Start with the letter, e.g. "A ${c.verb === "pick" ? c.choice : c.verb}"`); continue; }
    if (!target) { out.push("Nothing is waiting on you."); continue; }
    for (const L of which) {
      const key = target.letters[L];
      if (!key) { out.push(`${L}: no such item`); continue; }
      const it = open.get(key);
      answered.add(key);
      if (!it) { if (c.letter || which.length === 1) out.push(`${L}: already handled`); continue; }
      // A letter or a bare reply may be meant for an older text (replies carry no thread on SMS or
      // iMessage), so it never rejects or puts off a mail: that needs the mail's code (G146).
      if (it.kind === "action" && (c.verb === "reject" || c.verb === "later")) {
        if (!askedWhich) out.push("Which mail? Reply reject <code> or later <code>, with the code from the text.");
        askedWhich = true;
        continue;
      }
      const r = act(root, p, st, it, c, msg, trusted, now);
      out.push(`${letters.length > 1 ? `${L}: ` : ""}${r.line}`);
      if (r.changed) open.delete(key);
    }
  }
  return out.join("\n");
}

// ---------- one tick ----------

export async function tick(root: string, opts: TickOptions = {}): Promise<TickResult> {
  const now = opts.now ?? new Date();
  const p = loadEscalation(root);
  const st = loadTextState(root);
  const primary = opts.transport ?? makeTransport(root, p.transport.use, p.transport);
  const fallback = opts.fallback ?? (p.transport.fallback && p.transport.fallback !== p.transport.use ? safeMake(root, p) : undefined);
  mkdirSync(join(root, "textline"), { recursive: true });
  writeFileSync(heartbeatFile(root), now.toISOString());
  const res: TickResult = { applied: [], acks: [], waiting: 0, reason: "", health: [] };

  const send = async (text: string, kind: SentRecord["kind"], letters: Record<string, string> = {}, prefer?: TextTransport): Promise<string | undefined> => {
    if (opts.dryRun) return "dry-run";
    const id = `t-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${st.sent.length}`;
    const order = [prefer ?? primary, ...(prefer && prefer !== primary ? [primary] : []), ...(fallback ? [fallback] : [])];
    for (const t of order) {
      // Skip a stale Instinct only when something else can send; with no fallback the text
      // still queues, so Instinct sends it when it's back (and the digest lists it meanwhile).
      if (t.stale?.(now) && order.indexOf(t) < order.length - 1) { audit(root, { skip: t.name, why: "not pulled recently" }); continue; }
      const r = await t.send({ id, text, at: now.toISOString() });
      audit(root, { sent: id, via: t.name, ok: r.ok, detail: r.detail, kind });
      if (r.ok) {
        // A fallback took over: don't let Instinct send the stale copies later.
        if (t !== primary && primary.name === "instinct") for (const m of outbox(root).filter((x) => x.status === "queued")) markOutbox(root, m.id, "superseded");
        st.sent.push({ id, at: now.toISOString(), transport: t.name, letters, kind });
        return t.name;
      }
    }
    return undefined;
  };

  // 1. Replies, from the primary and (if Louis answered a fallback text) the fallback.
  const pol = loadRules(root).policy;
  const channelStatus = pol.agents[pol.owner_channel ?? pol.louis_channel ?? pol.resolver ?? ""]?.status;
  const open = new Map(openItems(root, now).map((i) => [i.key, i]));
  const answered = new Set<string>();
  for (const t of [primary, ...(fallback ? [fallback] : [])]) {
    for (const msg of await t.replies()) {
      // Louis's kill switch on the relaying agent holds here too.
      if (!t.trusted && channelStatus && channelStatus !== "active") { audit(root, { reply: msg.id, ignored: `relaying agent is ${channelStatus}` }); continue; }
      const ack = applyReply(root, p, st, open, msg, t.trusted, now, answered);
      res.applied.push(ack);
      if (await send(ack, "ack", {}, t)) res.acks.push(ack);
    }
  }

  // 2. Proposals the owner left past their deadline expire (src/deck.ts), skipping anything he just
  // answered, and only inside the server's write queue.
  res.auto = [];
  if (!opts.dryRun && opts.lock) res.auto = (await opts.lock(() => runAuto(root, now, answered))).map((d) => d.key);

  // 3. Open items and health.
  const items = openItems(root, now);
  retireAnsweredTexts(root, new Set(items.map((i) => i.key)));
  const checks = await healthChecks(root, p, { fetch: opts.fetch, now });
  res.health = checks;
  for (const h of checks) {
    if (h.check === "server") audit(root, { health: "server", ok: h.ok });
    const hs = (st.health[h.check] ??= { fails: 0 });
    if (h.ok) {
      if (hs.texted && hs.down_since) await send(`pocketBrain: recovered. ${h.detail}.`, "health");
      st.health[h.check] = { fails: 0 };
      continue;
    }
    hs.fails += 1;
    hs.down_since ??= now.toISOString();
    if (hs.fails >= p.health.failures_before_text)
      items.unshift({ key: `health:${h.check}:${hs.down_since}`, kind: "health", ref: h.check, private: false, money: false, verbs: ["ok", "later"], title: `Hub: ${h.detail} (since ${hs.down_since.slice(11, 16)}Z)` });
  }

  // 3. Bookkeeping: forget what closed, note what's new.
  const keys = new Set(items.map((i) => i.key));
  for (const k of Object.keys(st.items)) if (!keys.has(k)) delete st.items[k];
  // An item's own timestamp counts only when it has a time (a bare date would skip the wait).
  for (const it of items) st.items[it.key] ??= { first_seen: it.at && it.at.includes("T") && it.at < now.toISOString() ? it.at : now.toISOString() };

  const due = items.filter((it) => {
    const s = st.items[it.key];
    if (s.done) return false;
    if (s.snoozed_until && s.snoozed_until > now.toISOString()) return false;
    if (s.last_texted && minutes(now, s.last_texted) < p.remind_after_hours * 60) return false;
    // Instinct tries first (architecture 0.6), unless the item must go to Louis anyway.
    if (it.waiting_on_resolver && minutes(now, s.first_seen) < p.resolver_grace_minutes) return false;
    return true;
  });
  const urgent = due.filter((i) => tierOf(p, i) === "urgent");
  const normal = due.filter((i) => tierOf(p, i) === "normal");
  const low = due.filter((i) => tierOf(p, i) === "low");
  res.waiting = urgent.length + normal.length;

  // 4. Decide.
  let go = false;
  if (urgent.length) { go = true; res.reason = `${urgent.length} urgent`; }
  else if (!normal.length) res.reason = low.length ? `${low.length} low only; they ride along` : "nothing needs you";
  else if (inQuietHours(p, now)) { res.reason = "quiet hours"; audit(root, { quiet_held: normal.map((i) => i.key) }); }
  else if (minutes(now, st.last_batch) < p.batch.min_gap_minutes) res.reason = `last text ${Math.round(minutes(now, st.last_batch))} min ago`;
  else {
    const oldest = Math.max(...normal.map((i) => minutes(now, st.items[i.key].first_seen)));
    if (oldest >= p.batch.wait_minutes || normal.length >= p.batch.max_wait_count) { go = true; res.reason = `${normal.length} batched`; }
    else res.reason = `batching (${normal.length} waiting, oldest ${Math.round(oldest)} min)`;
  }
  if (go) {
    const rank = (i: Item) => (tierOf(p, i) === "urgent" ? 0 : i.private || i.money ? 1 : tierOf(p, i) === "normal" ? 2 : 3);
    const list = [...urgent, ...normal, ...low].sort((a, b) => rank(a) - rank(b) || st.items[a.key].first_seen.localeCompare(st.items[b.key].first_seen));
    const c = compose(list, { maxItems: p.batch.max_items, maxChars: p.batch.max_chars });
    const via = await send(c.text, "batch", c.letters);
    if (via) audit(root, { batch: via, items: list.length, urgent: urgent.length });
    if (via) {
      for (const k of Object.values(c.letters)) { const s = st.items[k]; s.last_texted = now.toISOString(); s.texted = (s.texted ?? 0) + 1; }
      if (normal.length || low.length) st.last_batch = now.toISOString();
      for (const h of urgent.filter((i) => i.kind === "health")) st.health[h.ref].texted = true;
      res.sent = { text: c.text, via, keys: Object.values(c.letters) };
    } else res.reason += "; every transport failed";
  }
  if (!opts.dryRun) saveState(root, st);
  return res;
}

function safeMake(root: string, p: EscalationPolicy): TextTransport | undefined {
  try { return makeTransport(root, p.transport.fallback!, p.transport); } catch { return undefined; }
}

// The routine: one tick every cadence_minutes. A tick that throws is retried next time; three
// in a row and the poller texts about itself, since a silent poller is the worst failure.
export function watch(root: string, opts: { log?: (s: string) => void; lock?: Lock } = {}) {
  const log = opts.log ?? ((s: string) => console.log(s));
  let errors = 0;
  const run = async () => {
    try {
      const r = await tick(root, { lock: opts.lock });
      errors = 0;
      log(`${new Date().toISOString()} ${r.sent ? `texted via ${r.sent.via}: ${r.sent.keys.length} item(s)` : r.reason}${r.acks.length ? `; ${r.acks.length} repl(ies) applied` : ""}`);
    } catch (e) {
      errors += 1;
      log(`${new Date().toISOString()} tick failed (${errors}): ${(e as Error).message}`);
      if (errors === 3) {
        const p = loadEscalation(root);
        for (const use of [p.transport.fallback, p.transport.use].filter(Boolean) as TextTransport["name"][]) {
          try { if ((await makeTransport(root, use as never, p.transport).send({ id: `err-${Date.now()}`, text: `pocketBrain: the text poller is failing (${(e as Error).message.slice(0, 80)}). Check the hub.`, at: new Date().toISOString() })).ok) break; } catch { /* try the next */ }
        }
      }
    }
  };
  run();
  return setInterval(run, loadEscalation(root).cadence_minutes * 60_000);
}

// Run from a machine other than the hub (a replica, or Louis's laptop when the hub is the
// home box): the hub can't text about its own death, so this watches it from outside.
export async function watchdog(stateDir: string, url: string, transport: TextTransport, opts: { fetch?: Fetch; now?: Date; failuresBeforeText?: number } = {}) {
  const now = opts.now ?? new Date();
  const f = opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, "watchdog.json");
  const s: { fails: number; down_since?: string; texted?: boolean } = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { fails: 0 };
  let ok = false;
  try { ok = (await f(url, { signal: AbortSignal.timeout(8000) })).ok; } catch { ok = false; }
  let sent: string | undefined;
  if (ok) {
    if (s.texted) sent = `pocketBrain hub is back (${url}).`;
    Object.assign(s, { fails: 0, down_since: undefined, texted: false });
  } else {
    s.fails += 1;
    s.down_since ??= now.toISOString();
    if (s.fails >= (opts.failuresBeforeText ?? 2) && !s.texted) { sent = `pocketBrain hub isn't answering since ${s.down_since.slice(11, 16)}Z (${url}). Agents fall back to their snapshots. Reply ok.`; s.texted = true; }
  }
  if (sent) await transport.send({ id: `wd-${now.getTime()}`, text: sent, at: now.toISOString() });
  writeFileSync(file, JSON.stringify(s));
  return { ok, sent };
}
