// SPDX-License-Identifier: AGPL-3.0-only
// The decision deck (docs/decision-deck.md): everything that needs the owner, as cards he swipes
// through on a phone, plus the hub deciding the low-stakes ones itself when he doesn't answer.
//
// What the hub may decide alone is fixed here in code, not in a prompt or a rules file: only an
// outside assistant's proposal that is not private, money, health or legal and cites no word of
// the owner's, left unanswered, expires (rejected; the assistant can propose it again). Nothing is
// ever written on the owner's behalf. Everything else (conflicts, held mail, captures, alerts,
// rules, account notices, relayed answers) waits for the owner, however long. Each expiry is
// logged, shown in the digest, and one tap undoes it, after which the hub never decides that
// item again.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { withFileLock, lockBusy } from "./filelock";
import { join } from "node:path";
import YAML from "yaml";
import { openItems, type Item } from "./textline/items";
import { loadEscalation, type EscalationPolicy } from "./textline/policy";
import { loadBrain, sensitivityRank, today, type Note } from "./brain";
import { disputes, proposals, loadState, type DisputeRow } from "./dashboard/data";
import { OWNER } from "./owner";
import { CoreError } from "./core";
import { categoryWords, SENSITIVE_WORDS, wordsRe } from "./checks";
import { hasWord } from "./util";
import type { Rules } from "./rules";
import { logWrite } from "./write";
import { loadRules } from "./rules";
import { decideProposal } from "./write";
import { git, authorEnv } from "./git";
import { refString, schemeOf, isExactLouisRef, SCHEMES } from "./sources";
import { hubGate } from "./hub";
import { needsLook, sourceWords } from "./dashboard/browse";
import { plain } from "./dashboard/labels";
import type { Card, Choice, Line, DeckView, AutoDone } from "./dashboard/deck-types";

// The author of every commit the hub makes because the owner left a card unanswered.
export const AUTO = "auto-decide";

// Health, legal or money in the words of an item, whatever the note. Over-matching only leaves a
// card to the owner. Word edges are any letter, so accented words (santé, payé) match (G129).
// Stems: whole words in any script (checks.ts wordsRe, G129), any letters may follow (lawyers,
// therapist, médecins; G158). Over-matching only leaves a card to the owner.
const W = (words: string) => wordsRe(`(?:${words})\\p{L}*`);
const LEGAL_HEALTH = W("lawyers?|avocats?|attorneys?|solicitors?|notaires?|court|tribunal|trial|procès|legal|juridique|lawsuits?|litiges?|plaintes?|sued|police|garde à vue|prud'?hommes|chemo\\p{L}*|chimio\\p{L}*|cancer|surger|chirurgie|illness|hospital|hôpital|hosto|sick|malad\\p{L}*|doctors?|médecins?|disab\\p{L}*|handicap\\p{L}*|leave|congé|therap\\p{L}*|thérap\\p{L}*|psych\\p{L}*|depress\\p{L}*|dépress\\p{L}*|anxiety|anxiété|MRI|IRM|ICU|HIV|VIH|pregnan\\p{L}*|grossesse|enceinte|diagnos\\p{L}*|santé|health|medical|médical\\p{L}*|medication|médicament\\p{L}*|école|school|divorce|custody|arrest\\p{L}*");
const MONEY_SHAPE = W("budget|salar\\p{L}*|salaire|wages?|income|revenus?|loans?|prêts?|mortgage|hypoth\\p{L}*|rent|loyer|invoices?|factures?|price|prix|costs?|coût\\p{L}*|fees?|frais|paid|payé\\p{L}*|payments?|paiements?|paie|owe[sd]?|refunds?|rembours\\p{L}*|tax\\p{L}*|impôts?|banks?|banque|accounts?|comptes?|cards?|cartes?|IBAN|RIB|virements?|retraite|pension|insurance|assurance\\p{L}*|debt|dettes?|EUR|USD|CAD|GBP|CHF");
const AMOUNT = /[$€£¥]\s?\d|\d\s?([$€£¥]|eur|usd|cad|chf|gbp)(?!\p{L})/iu;
export function sensitiveShape(rules: Rules, ...texts: unknown[]): string | undefined {
  const t = texts.map((x) => (typeof x === "string" ? x : JSON.stringify(x ?? ""))).join(" ").replace(/_/g, " ");
  return t.normalize("NFC").match(SENSITIVE_WORDS)?.[1] ?? t.match(LEGAL_HEALTH)?.[1] ?? t.match(MONEY_SHAPE)?.[1] ?? t.match(AMOUNT)?.[0] ?? categoryWords(rules.checks).money.find((w) => hasWord(t, w));
}

const logDir = (root: string) => join(root, "log");
const AUTO_LOG = "auto-decisions.jsonl";
const DECK_LOG = "deck.jsonl";
const LATER = "deck-later.json";
const SEEN = "deck-seen.json";

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as T]; } catch { return []; } });
}
function append(root: string, file: string, row: Record<string, unknown>) {
  mkdirSync(logDir(root), { recursive: true });
  appendFileSync(join(logDir(root), file), JSON.stringify(row) + "\n");
}
const short = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const val = (v: unknown) => short(typeof v === "object" ? JSON.stringify(v) : String(v ?? ""), 120);
const day = (iso: string) => iso.slice(0, 10);
const titleOf = (n: Note) => String(n.fm.title ?? n.fm.id);

// ---------- what the hub would do if nobody answers ----------

export interface Plan { choice: string; label: string; why: string; at: string; run: () => string }
export type Verdict = { plan: Plan } | { never: string };

const NEVER: Record<string, string> = {
  mail: "Mail between assistants leaves only on your word.",
  capture: "A held capture is released only on your word.",
  "held-answer": "A relayed answer on a private fact needs your own confirmation.",
  alert: "Alerts are yours to look at.",
  rules: "Only you change the rules.",
  usage: "Spending is yours to decide.",
  upkeep: "Upkeep contradictions wait for you.",
};

const privateLevel = (levels: (string | undefined)[]) => levels.some((s) => s && sensitivityRank(s as never) >= sensitivityRank("private"));

// The owner took a decision back: that item is his from then on.
function autoOff(root: string, key: string): boolean {
  return readJsonl<{ key: string; undo_of?: string }>(join(logDir(root), AUTO_LOG)).some((r) => r.key === key && r.undo_of);
}

// When git first recorded a file: the clock a deadline runs from (dates in packets are days only).
function recordedAt(root: string, rel: string): number {
  const t = git(root, ["log", "--diff-filter=A", "--format=%cI", "-1", "--", rel]);
  return Date.parse(t) || Date.now();
}

// When the hub first saw an item it may decide. A deadline never starts before that, so an item
// older than this code, or one that only just became decidable, still gets its full notice (G85).
function seenMap(root: string): Record<string, string> {
  const f = join(logDir(root), SEEN);
  try { return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {}; } catch { return {}; }
}
function saveSeen(root: string, m: Record<string, string>) {
  mkdirSync(logDir(root), { recursive: true });
  writeFileSync(join(logDir(root), SEEN), JSON.stringify(m, null, 1));
}
function firstSeen(root: string, key: string, now: Date): number {
  const m = seenMap(root);
  if (!m[key]) { m[key] = now.toISOString(); saveSeen(root, m); }
  return Date.parse(m[key]) || now.getTime();
}
// While an item can't be decided (deciding is off, its assistant is paused, ...), its clock is
// cleared, so once it can be it gets the full notice again rather than going at once (G157).
function unsee(root: string, key: string) {
  const m = seenMap(root);
  if (m[key]) { delete m[key]; saveSeen(root, m); }
}
const from = (root: string, key: string, rel: string, now: Date) => Math.max(recordedAt(root, rel), firstSeen(root, key, now));

export function verdict(root: string, it: Item, p: EscalationPolicy, ctx: { notes: Note[]; disputes: DisputeRow[] }, now = new Date()): Verdict {
  const v = judge(root, it, p, ctx, now);
  if ("never" in v) unsee(root, it.key);
  return v;
}

function judge(root: string, it: Item, p: EscalationPolicy, ctx: { notes: Note[]; disputes: DisputeRow[] }, now: Date): Verdict {
  const a = p.auto_decide;
  if (NEVER[it.kind]) return { never: NEVER[it.kind] };
  if (a.off) return { never: "Deciding for you is turned off (auto_decide in rules/escalation.yaml)." };
  if (it.private) return { never: "Private: only you decide this." };
  if (it.money) return { never: "Money: only you decide this." };
  if (autoOff(root, it.key)) return { never: "You undid the hub's decision on this, so it waits for you." };
  // A conflict always waits for the owner. Every conflict that reaches him is one the conflict
  // order couldn't settle, and the hub can check that a cited message exists but not that it says
  // what the side claims, so any pick it made would rest on the agents' own word (G78, G126-G128).
  if (it.kind === "dispute") return { never: "Conflicts wait for you: the hub can't check that a source says what a side claims." };
  if (it.kind === "proposal") {
    // Only an outside assistant's proposal expires; captures, imports and the hub's own nights are
    // the owner's material and wait for him.
    const pr = proposals(root).find((x) => x.file === it.ref);
    const by = pr?.by ?? "";
    const rules = loadRules(root);
    const agent = rules.policy.agents[by];
    if (!pr || !agent || agent.inside_wall) return { never: "It came from your own material, so it waits for you." };
    if (agent.status && agent.status !== "active") return { never: `${by} is ${agent.status}, so this waits for you.` };
    // Something that cites the owner's word, or reads like health, legal or money, waits (G83).
    const r = pr.request as { id?: string; title?: string; attribute?: string; value?: unknown; text?: string; sources?: unknown[] };
    const refs = (Array.isArray(r.sources) ? r.sources : []).map((x) => refString(x as never));
    if (/owner_message_registered/.test(pr.reason) || refs.some((x) => isExactLouisRef(x) || SCHEMES[schemeOf(x) ?? ""] === "louis"))
      return { never: "It cites your own word, so only you can keep or drop it." };
    if (sensitiveShape(rules, r.id, r.title, r.attribute, r.value, r.text)) return { never: "It looks like health, legal or money, so only you decide it." };
    const at = new Date(from(root, it.key, `inbox/${it.ref}`, now) + a.proposal_days * 86_400_000).toISOString();
    return { plan: { choice: "reject", label: "lets it expire", why: `nobody confirmed it in ${a.proposal_days} days; the assistant can propose it again`, at, run: () => {
      const r = decideProposal(root, it.ref, "reject", AUTO);
      if (r.outcome === "refused") throw new CoreError(409, r.message);
      return `expired ${it.ref}`;
    } } };
  }
  return { never: "Only you decide this." };
}

// Run every plan whose time has come. Returns what was decided. Safe to call every tick.
// `skip`: items the owner answered in this tick, even with a reply that couldn't apply (G159).
// Under a file lock every process on this brain shares (src/filelock.ts, #263): while another
// one is deciding, this call decides nothing and the next tick tries again.
export function runAuto(root: string, now = new Date(), skip: ReadonlySet<string> = new Set()): AutoDone[] {
  return withFileLock(root, "decide", () => decideNow(root, now, skip)) ?? [];
}

function decideNow(root: string, now: Date, skip: ReadonlySet<string>): AutoDone[] {
  const p = loadEscalation(root);
  if (p.auto_decide.off) { saveSeen(root, {}); return []; }
  try { hubGate(root, ["commit"]); } catch { return []; } // a replica never decides
  const notes = loadBrain(root);
  const ctx = { notes, disputes: disputes(notes) };
  const done: AutoDone[] = [];
  for (const it of openItems(root, now)) {
    if (skip.has(it.key)) continue;
    const v = verdict(root, it, p, ctx, now);
    if (!("plan" in v) || Date.parse(v.plan.at) > now.getTime()) continue;
    const mine = () => git(root, ["log", "-1", "--format=%H", `--author=${AUTO}@pocketbrain.local`]);
    const before = mine();
    try { v.plan.run(); } catch (e) { append(root, AUTO_LOG.replace(".jsonl", "-errors.jsonl"), { at: now.toISOString(), key: it.key, error: String((e as Error).message ?? e) }); continue; }
    const commit = mine(); // the hub's own commit, even if another write landed meanwhile
    if (!commit || commit === before) continue;
    const row: AutoDone = { key: it.key, question: it.title, picked: v.plan.label, why: v.plan.why, at: now.toISOString(), commit };
    append(root, AUTO_LOG, row as unknown as Record<string, unknown>);
    done.push(row);
  }
  return done;
}

// `pocketbrain deck auto`: the same step by hand, but only when no hub is running here. The hub
// decides inside its own write queue (start), and a second process deciding beside it could
// commit between the hub's writes.
export async function runAutoByHand(root: string, now = new Date(), fetch: (u: string) => Promise<Response> = (u) => globalThis.fetch(u, { signal: AbortSignal.timeout(2000) })): Promise<{ done: AutoDone[] } | { refused: string }> {
  const url = loadEscalation(root).health.url ?? "http://127.0.0.1:8787/health";
  try { await fetch(url); return { refused: "the hub is running: it decides on its own tick (pocketbrain start)" }; } catch { /* not running: safe to decide here */ }
  if (lockBusy(root, "decide")) return { refused: "another pocketbrain process is deciding right now; try again in a minute" };
  return { done: runAuto(root, now) };
}

export function autoDecisions(root: string, days = 7, now = new Date()): AutoDone[] {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const rows = readJsonl<AutoDone & { undo_of?: string }>(join(logDir(root), AUTO_LOG));
  const undone = new Map(rows.filter((r) => r.undo_of).map((r) => [r.undo_of!, r.at]));
  return rows.filter((r) => !r.undo_of && r.at >= since).map((r) => ({ ...r, undone: undone.has(r.commit) ? true : undefined })).reverse();
}

// Undo one auto-decision: revert its commit as the owner. The item comes back to the deck and the
// hub never decides it again.
export function undoAuto(root: string, key: string): string {
  const row = readJsonl<AutoDone & { undo_of?: string }>(join(logDir(root), AUTO_LOG)).filter((r) => r.key === key && !r.undo_of).at(-1);
  if (!row) throw new CoreError(404, "the hub made no decision on that");
  if (autoDecisions(root, 3650).find((r) => r.commit === row.commit)?.undone) return "already undone";
  if (!/^[0-9a-f]{40}$/.test(row.commit)) throw new CoreError(400, "bad commit");
  // Only a commit the hub made on the owner's behalf, never anyone else's.
  const email = git(root, ["log", "-1", "--format=%ae", row.commit]);
  if (email !== `${AUTO}@pocketbrain.local`) throw new CoreError(403, "only the hub's own decisions are undone here");
  hubGate(root, ["revert"]);
  const r = Bun.spawnSync(["git", "revert", "--no-edit", row.commit], { cwd: root, env: authorEnv(root, OWNER) });
  if (r.exitCode !== 0) {
    Bun.spawnSync(["git", "revert", "--abort"], { cwd: root });
    throw new CoreError(409, "something changed it since; decide it on its page instead");
  }
  append(root, AUTO_LOG, { key, undo_of: row.commit, at: new Date().toISOString() });
  logWrite(root, { at: new Date().toISOString(), agent: OWNER, kind: "owner-edit", key, outcome: "committed", step: 6, undo_of: row.commit });
  return "Undone. It is back in your deck and waits for you.";
}

// ---------- later, and the owner's own pace ----------

function laterMap(root: string): Record<string, string> {
  const f = join(logDir(root), LATER);
  try { return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {}; } catch { return {}; }
}

// "Later" hides a card for snooze_hours. It never moves the hub's own deadline.
export function later(root: string, key: string, now = new Date()): string {
  if (!/^[a-z-]+:[A-Za-z0-9._#\/:-]{1,200}$/.test(key)) throw new CoreError(400, "bad card");
  const p = loadEscalation(root);
  const m = laterMap(root);
  for (const [k, until] of Object.entries(m)) if (until < now.toISOString()) delete m[k];
  m[key] = new Date(now.getTime() + p.snooze_hours * 3_600_000).toISOString();
  mkdirSync(logDir(root), { recursive: true });
  writeFileSync(join(logDir(root), LATER), JSON.stringify(m, null, 1));
  return `Later: back in ${p.snooze_hours} h.`;
}

// One answered card and the time it took. A fact a pull or capture proposed is marked `capture`:
// those seconds are the owner's review minutes that `pocketbrain fill` grades (src/fill.ts).
export function recordSwipe(root: string, key: string, ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return;
  const file = key.match(/^proposal-(?:accept|reject):([A-Za-z0-9._-]+\.yaml)$/)?.[1];
  const capture = !!file && [join(root, "inbox", "decided", file), join(root, "inbox", file)].some((f) => { try { return existsSync(f) && !!(YAML.parse(readFileSync(f, "utf8")) as { capture?: unknown })?.capture; } catch { return false; } });
  append(root, DECK_LOG, { at: new Date().toISOString(), day: today(), key: short(key, 200), ms: Math.min(Math.round(ms), 600_000), ...(capture ? { capture: true } : {}) });
}

function stats(root: string, now: Date) {
  const rows = readJsonl<{ at: string; key?: string; ms?: number; zero?: boolean }>(join(logDir(root), DECK_LOG));
  const today = day(now.toISOString());
  const swipes = rows.filter((r) => r.key && day(r.at) === today);
  const zeroDays = new Set(rows.filter((r) => r.zero).map((r) => day(r.at)));
  let streak = 0;
  for (let d = new Date(now); ; d = new Date(d.getTime() - 86_400_000)) {
    const k = day(d.toISOString());
    if (zeroDays.has(k)) streak++;
    else if (k !== today) break; // today still counts as open until the deck is cleared
    if (streak > 365) break;
  }
  return { cleared_today: swipes.length, seconds_today: Math.round(swipes.reduce((s, r) => s + (r.ms ?? 0), 0) / 1000), streak };
}

// ---------- cards ----------

const URGENT = new Set(["alert", "rules", "usage"]);
const TAG: Record<string, string> = { dispute: "Conflict", proposal: "New fact", mail: "Held mail", capture: "Held capture", "held-answer": "Your answer?", alert: "Alert", rules: "Rules changed", usage: "Account", upkeep: "Upkeep", fact: "Still true?" };

const isCapture = (root: string, file: string) => { try { return !!(YAML.parse(readFileSync(join(root, "inbox", file), "utf8")) as { capture?: unknown })?.capture; } catch { return false; } };

const later_ = (key: string): Choice => ({ id: "later", label: "Later", action: "deck-later", fields: { key }, dir: "up", tone: "neutral" });

function cardFor(it: Item, v: Verdict, ctx: { notes: Note[]; disputes: DisputeRow[] }, root: string): Card {
  const base = { key: it.key, kind: it.kind as Card["kind"], tag: TAG[it.kind] ?? it.kind, ...("plan" in v ? { auto: { choice: v.plan.choice, at: v.plan.at, why: v.plan.why } } : { never_auto: v.never }) };
  if (it.kind === "dispute") {
    const d = ctx.disputes.find((x) => x.id === it.ref)!;
    const [id, attr] = d.fact_key.split("#");
    const note = ctx.notes.find((n) => n.fm.id === id);
    const shut = it.private || it.money;
    const lines: Line[] = shut ? [] : d.candidates.map((c, i) => ({ label: `${i + 1}`, value: val(c.value), meta: [sourceWords(c.sources), c.as_of, c.by].filter(Boolean).join(" · ") }));
    const w = "plan" in v ? Number(v.plan.choice.split("-")[1]) - 1 : 0;
    const other = d.candidates.findIndex((_, i) => i !== w);
    const pick = (i: number, dir: Choice["dir"]): Choice => ({ id: `pick-${i + 1}`, label: shut ? `Keep side ${i + 1}` : `Keep ${short(val(d.candidates[i].value), 28)}`, action: "dispute-decide", fields: { id: d.id, choice: String(i + 1) }, dir, tone: "neutral" });
    const choices = [pick(w, "right"), ...(other >= 0 ? [pick(other, "left")] : []), ...d.candidates.map((_, i) => i).filter((i) => i !== w && i !== other).map((i) => pick(i, "tap")), later_(it.key)];
    return { ...base, question: `Which is right: ${note ? titleOf(note) : id}, ${plain(attr)}?`, lines, ...(shut ? { hidden: `${it.money ? "Money" : "Private"}: the values show on the fact's page.` } : {}), choices, href: `/note/${id}#f-${attr}` };
  }
  if (it.kind === "proposal") {
    const pr = proposals(root).find((x) => x.file === it.ref);
    const r = (pr?.request ?? {}) as { id?: string; title?: string; attribute?: string; value?: unknown; text?: string; sources?: unknown[]; as_of?: string; sensitivity?: string };
    const shut = it.private || it.money || privateLevel([r.sensitivity]);
    // The morning swipe: a fact a pull or capture proposed shows where it came from and the words
    // it came from, so keeping it takes a glance.
    const pulled = !!pr && isCapture(root, pr.file);
    const quote = pulled ? pr!.reason.match(/; quote: "([\s\S]*)"$/)?.[1] : undefined;
    const from = pulled ? refString((r.sources?.[0] ?? "") as never).split(":")[0] || "a source" : "";
    const lines: Line[] = shut ? [] : [
      ...(r.attribute ? [{ label: plain(r.attribute), value: val(r.value) }] : r.text ? [{ label: "Text", value: val(r.text) }] : r.value !== undefined ? [{ label: "Value", value: val(r.value) }] : []),
      ...(r.sources?.length ? [{ label: "Source", value: sourceWords(r.sources as never), meta: r.as_of }] : []),
      ...(quote ? [{ label: "Quote", value: short(quote, 200) }] : pr?.reason ? [{ label: "Why it waits", value: short(pr.reason, 160) }] : []),
    ];
    const edit: Choice[] = pulled && !shut && r.id && r.attribute ? [{ id: "edit", label: "Fix it", action: "", fields: {}, dir: "tap", tone: "neutral", href: `/note/${r.id}#f-${r.attribute}` }] : [];
    return { ...base, ...(pulled ? { tag: `From ${from}` } : {}), question: pulled ? `Keep this for ${shut ? `a ${it.money ? "money" : "private"} note` : r.id ?? r.title ?? "your brain"}?` : `${pr?.by ?? "An assistant"} wants to add this to ${shut ? `a ${it.money ? "money" : "private"} note` : r.id ?? r.title ?? "your brain"}. Keep it?`, lines, ...(shut ? { hidden: "The value shows in the dashboard's Needs you." } : {}),
      choices: [{ id: "accept", label: "Keep it", action: "proposal-accept", fields: { file: it.ref }, dir: "right", tone: "good" }, { id: "reject", label: "Drop it", action: "proposal-reject", fields: { file: it.ref }, dir: "left", tone: "bad" }, later_(it.key), ...edit], href: "/#needs" };
  }
  if (it.kind === "held-answer") return { ...base, question: it.title, lines: [], hidden: it.private ? "Private: the value shows on the conflict's page." : undefined,
    choices: [{ id: "confirm", label: "Yes, that's my answer", action: "dispute-confirm", fields: { id: it.ref }, dir: "right", tone: "good" }, { id: "reject", label: "No", action: "dispute-reject", fields: { id: it.ref }, dir: "left", tone: "bad" }, later_(it.key)] };
  if (it.kind === "mail") return { ...base, question: it.title, lines: [], hidden: "The message itself shows only in the dashboard.",
    choices: [{ id: "release", label: "Send it", action: "mail-release", fields: { id: it.ref }, dir: "right", tone: "good" }, { id: "drop", label: "Drop it", action: "mail-drop", fields: { id: it.ref }, dir: "left", tone: "bad" }, later_(it.key)], href: "/#needs" };
  if (it.kind === "capture") return { ...base, question: it.title, lines: [], hidden: "Its words show only in the dashboard.",
    choices: [{ id: "release", label: "Let it in", action: "capture-release", fields: { file: it.ref }, dir: "right", tone: "good" }, { id: "discard", label: "Throw it away", action: "capture-discard", fields: { file: it.ref }, dir: "left", tone: "bad" }, later_(it.key)], href: "/#needs" };
  // Alerts, rules, account notices, upkeep: look, then say you saw it.
  return { ...base, question: it.title, lines: [], choices: [{ id: "open", label: "Look", action: "", fields: {}, dir: "right", tone: "neutral", href: "/" }, later_(it.key)] };
}

function factCards(root: string, limit: number): Card[] {
  const s = loadState(root);
  const rules = loadRules(root);
  const shut = (x: { note: Note; attr: string; value: unknown }) => {
    const rec = x.note.fm.facts?.[x.attr] as { sensitivity?: string } | undefined;
    return privateLevel([x.note.fm.sensitivity, rec?.sensitivity]) || x.note.fm.type === "money" || /^money\//.test(String(x.note.fm.id)) || (x.note.fm.tags ?? []).includes("finance") || !!sensitiveShape(rules, x.attr, x.value);
  };
  return needsLook(s, limit).filter((x) => !shut(x)).map((x) => {
    const key = `fact:${x.note.fm.id}#${x.attr}`;
    return {
      key, kind: "fact", tag: TAG.fact, question: `${titleOf(x.note)}: is ${plain(x.attr)} still right?`,
      lines: [{ label: plain(x.attr), value: val(x.value), meta: `last checked ${x.checked}` }],
      choices: [
        { id: "confirm", label: "Still true", action: "fact-confirm", fields: { id: x.note.fm.id, attribute: x.attr }, dir: "right", tone: "good" },
        { id: "change", label: "Change it", action: "", fields: {}, dir: "left", tone: "neutral", href: `/note/${x.note.fm.id}#f-${x.attr}` },
        later_(key),
      ],
      never_auto: "Nothing happens if you skip it; it just stays marked as old.",
      href: `/note/${x.note.fm.id}#f-${x.attr}`,
    } satisfies Card;
  });
}

export function buildDeck(root: string, now = new Date(), opts: { facts?: number } = {}): DeckView {
  const p = loadEscalation(root);
  const notes = loadBrain(root);
  const ctx = { notes, disputes: disputes(notes) };
  const hidden = laterMap(root);
  const live = (k: string) => !(hidden[k] && hidden[k] > now.toISOString());
  const items = openItems(root, now).filter((i) => live(i.key));
  const cards = items.map((it) => cardFor(it, verdict(root, it, p, ctx, now), ctx, root));
  const rank = (c: Card) => (URGENT.has(c.kind) ? 0 : c.auto ? 1 : 2);
  cards.sort((a, b) => rank(a) - rank(b) || (a.auto && b.auto ? a.auto.at.localeCompare(b.auto.at) : 0));
  cards.push(...factCards(root, opts.facts ?? 8).filter((c) => live(c.key)));
  if (!cards.length) {
    const rows = readJsonl<{ at: string; zero?: boolean }>(join(logDir(root), DECK_LOG));
    if (!rows.some((r) => r.zero && day(r.at) === day(now.toISOString()))) append(root, DECK_LOG, { at: now.toISOString(), zero: true });
  }
  return { cards, ...stats(root, now), auto: autoDecisions(root, 7, now) };
}

// One line per auto-decision, for the digest.
export function autoDigestLines(root: string, since: string): string[] {
  return autoDecisions(root, 3650).filter((r) => r.at >= since).map((r) => `- ${r.undone ? "(undone) " : ""}${r.question}: the hub ${r.picked}, because ${r.why}. Undo in the deck.`);
}

