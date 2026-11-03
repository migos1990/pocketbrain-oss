// SPDX-License-Identifier: AGPL-3.0-only
// The hub's own filing (docs/filing.md): what it decides alone, on its tick, when nobody answers.
//
// What the hub may decide alone is fixed here in code, not in a prompt or a rules file: a fact a
// capture or a source pull found files itself (auto_decide.file: all, the default), and a
// contradiction is filed as a conflict for the Gardener; an outside assistant's proposal that is
// not private, money, health or legal and cites no word of the owner's, left unanswered, expires
// (rejected; the assistant can propose it again); and a low-risk fact a calendar or mail pull
// proposed is saved, up to a daily cap. A saved fact is the source's word, committed by
// auto-decide, never the owner's. Everything else (conflicts, held mail, captures, alerts, rules,
// account notices, relayed answers) waits for the owner, however long. Each decision is logged,
// shown in the digest, and one tap undoes it, after which the hub never decides that item again.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { withFileLock, lockBusy } from "./filelock";
import { join } from "node:path";
import YAML from "yaml";
import { openItems, type Item } from "./textline/items";
import { loadEscalation, type EscalationPolicy } from "./textline/policy";
import { loadBrain, sensitivityRank, today, type Note } from "./brain";
import { proposals, loadState, type Proposal } from "./dashboard/data";
import { OWNER } from "./owner";
import { CoreError } from "./core";
import { sensitiveShape } from "./shape";
import type { Rules } from "./rules";
import { logWrite, inboxCards, forgottenName, forgottenSlugs } from "./write";
import { loadRules, attributeSpec, isOwnerWord, isGardener, tierOf } from "./rules";
import { decideProposal, resolveEntity, versionOrder, withdrawConflictSide } from "./write";
import { git, authorEnv, commitPaths, gitTime } from "./git";
import { refString, schemeOf, isExactLouisRef, SCHEMES, sourceRank, asAgentWord } from "./sources";
import { isOwnerConfirmed, normVerification, isOwnerId } from "./owner";
import { getQuote } from "./quotes";
import { renderTouchedPages } from "./wiki";
import { appendDiary, readDiary, sourceKind, type DiaryRow } from "./diary";
import { sha256 } from "./util";
import { compareKey } from "./normalize";
import { ownerDay } from "./clock";
import { isList, type FactRecord } from "./brain";
import { hubGate } from "./hub";
import { captureAgent, MAIL_FOOTER, ownerOf } from "./capture";
import { records, carve, grantFor } from "./carve";

// commits: every commit of one decision, newest first, when there is more than one (a saved fact).
export interface AutoDone { key: string; question: string; picked: string; why: string; at: string; commit: string; commits?: string[]; undone?: boolean }

// The author of every commit the hub makes because the owner left an item unanswered.
export const AUTO = "auto-decide";


const logDir = (root: string) => join(root, "log");
const AUTO_LOG = "auto-decisions.jsonl";
// When the hub first saw each item it may decide. Clocks written before the filing had its own
// name are moved over on first read, so a deadline already running keeps running.
const SEEN = "filing-seen.json";
const SEEN_BEFORE = "deck-seen.json";

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as T]; } catch { return []; } });
}
function append(root: string, file: string, row: Record<string, unknown>) {
  mkdirSync(logDir(root), { recursive: true });
  appendFileSync(join(logDir(root), file), JSON.stringify(row) + "\n");
}

// ---------- what the hub would do if nobody answers ----------

export interface Plan { choice: string; label: string; why: string; at: string; run: () => string }
export type Verdict = { plan: Plan } | { never: string };
// Plans that file a capture (fileVerdict). A brain with no text channel runs only these on the
// hub's tick: filing is the default, the other decisions (expiry, source saves) stay opt-in.
const FILED = new WeakSet<Plan>();
const filed = (v: Verdict): Verdict => { if ("plan" in v) FILED.add(v.plan); return v; };

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
  if (build?.root === root) {
    build.added ??= addedTimes(root);
    return build.added.get(rel) ?? Date.now();
  }
  const t = git(root, ["log", "--diff-filter=A", "--format=%cI", "-1", "--", rel]);
  return Date.parse(t) || Date.now();
}

// When each inbox file was last added, from one walk of the history (newest first).
function addedTimes(root: string): Map<string, number> {
  const out = new Map<string, number>();
  let at = NaN;
  for (const line of git(root, ["log", "--diff-filter=A", "--format=@%cI", "--name-only", "--", "inbox"]).split("\n")) {
    if (line.startsWith("@")) at = Date.parse(line.slice(1));
    else if (line && !out.has(line) && at) out.set(line, at);
  }
  return out;
}

// While autoSaves runs: the inbox, rules and history read once, not once per item (owner,
// 2026-10-23: 67 proposals took 2 s, two inbox reads and a git log each).
let build: { root: string; props: Map<string, Proposal>; rules: Rules; added?: Map<string, number> } | undefined;
// A second proposal of the same value for one fact is folded under its card as a twin (inboxCards),
// but it is still its own open item and is judged as its own proposal: looked up by card only, a
// twin was never found and waited as "your own material" (G600).
function withTwins(list: Proposal[], root: string): Map<string, Proposal> {
  const out = new Map(list.map((x) => [x.file, x]));
  for (const c of inboxCards(root)) for (const t of c.twins) if (!out.has(t.file)) out.set(t.file, {
    file: t.file, by: String(t.doc.by ?? "?"), reason: String(t.doc.reason ?? ""), at: t.doc.at ? String(t.doc.at) : undefined,
    request: (t.doc.request ?? {}) as Proposal["request"], unregistered: [], ...(t.doc.capture ? { capture: true as const } : {}),
  });
  return out;
}
const proposalOf = (root: string, file: string) => build?.root === root ? build.props.get(file) : withTwins(proposals(root), root).get(file);
const rulesOf = (root: string) => build?.root === root ? build.rules : loadRules(root);

// When the hub first saw an item it may decide. A deadline never starts before that, so an item
// older than this code, or one that only just became decidable, still gets its full notice (G85).
function seenMap(root: string): Record<string, string> {
  const f = join(logDir(root), SEEN);
  const before = join(logDir(root), SEEN_BEFORE);
  if (!existsSync(f) && existsSync(before)) try { renameSync(before, f); } catch { /* read-only: start fresh */ }
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

export function verdict(root: string, it: Item, p: EscalationPolicy, ctx: { notes: Note[] }, now = new Date()): Verdict {
  const v = judge(root, it, p, ctx, now);
  if ("never" in v) unsee(root, it.key);
  return v;
}

// Something that cites the owner's word (an owner ref, or the owner's label) waits for the owner (G83).
const CITES_OWNER = "It cites your own word, so only you can keep or drop it.";
function citesOwner(pr: Proposal): boolean {
  const r = pr.request as { sources?: unknown[]; verification?: unknown };
  const refs = (Array.isArray(r.sources) ? r.sources : []).map((x) => refString(x as never));
  return /owner_message_registered/.test(pr.reason) || isOwnerConfirmed(r.verification) || refs.some((x) => isExactLouisRef(x) || SCHEMES[schemeOf(x) ?? ""] === "louis");
}

// The write path's whole reason for a write its assistant can't see all of (write.ts, invariant 3),
// matched end to end: a reason carrying assistant or sender text (an area name, a quoted value)
// can't say it (G598 slice audit F1). Ids and attributes are schema-checked, so no space or bracket.
export const heldByAccess = (reason: unknown) => /^the owner decides [^\s()#]+#[^\s()#]+ \(not_in_your_view\)$/.test(String(reason ?? ""));
const FORGOTTEN = "You forgot someone by this name, so only you decide it.";
// Owner-facing only: never shown to the assistant, which got the write path's one fixed reply.
const NOT_IN_VIEW = "The assistant can't see all of that page, so only you decide it.";
function judge(root: string, it: Item, p: EscalationPolicy, ctx: { notes: Note[] }, now: Date): Verdict {
  const a = p.auto_decide;
  if (NEVER[it.kind]) return { never: NEVER[it.kind] };
  if (a.off) return { never: "Deciding for you is turned off (auto_decide in rules/escalation.yaml)." };
  // Filing everything (auto_decide.file: all) covers private and money facts too: they land at
  // their own tier, and no line about them carries a value.
  // Only the owner's own channel and the source pulls (the capture agent's proposals): another
  // agent allowed to capture keeps its own rule (slice audit 2026-10-25).
  if (it.kind === "proposal" && a.file === "all" && !autoOff(root, it.key)) {
    const pr = proposalOf(root, it.ref);
    // An assistant's open question or take-back is not a fact, and only a conflict asks the owner
    // (outside review v5, midday: 4 of the Gardener's sat as asks with no way out). Set aside at
    // once, with a diary line and Undo; the assistant can raise it again.
    if (pr && !isOwnerId(pr.by) && !captured(root, pr.file) && (pr.request.attribute === "open_question" || pr.request.retract)) return filed(setAside(root, it, pr, now));
    // The write handed this one to the owner because the assistant can't see all of the page or
    // the fact (invariant 3, "not_in_your_view"). The hub's yes is weighed as that assistant's write
    // again and hands back the same proposal, so a plan to save it failed every minute (G598).
    if (pr && heldByAccess(pr.reason)) return { never: NOT_IN_VIEW };
    // A write check sent it to the owner (an instruction-shaped value, a source the hub can't
    // open, a claimed approval): the hub's yes is weighed as the assistant's write again and the
    // check hands it back, so a plan to save it failed every minute (G599). It waits for the owner.
    if (pr) { const c = ownerChecks(root, pr.file); if (c) return { never: c }; }
    // A new page for a name the owner forgot never files itself again: one an older forget left in
    // the inbox, reopened with no writer, read its writer from the request after G601 (slice audit F1).
    if (pr && !pr.request.id && typeof pr.request.title === "string" && forgottenName(pr.request.title, forgottenSlugs(root))) return { never: FORGOTTEN };
    if (pr && (pr.by === captureAgent(rulesOf(root)) || isOwnerId(pr.by)) && captured(root, pr.file)) return filed(fileVerdict(root, it, pr, ctx.notes, now));
    // An assistant's proposal that says it is the owner's word waits for the owner, whatever tier
    // the assistant is: once the hold on core assistants' proposals ended (2026-10-30) a forged
    // owner ref filed as a conflict side ranked as the owner's word (rt-dash-routed-forged-owner-ref).
    if (pr && !isOwnerId(pr.by) && !captured(root, pr.file) && citesOwner(pr)) return { never: CITES_OWNER };
    // The capture agent's own fact about the owner, written as an assistant (G409), lands on the
    // owner's page like a capture: the owner is never asked about himself. Only while that agent
    // is active, and never a private, money, health or legal one; other assistants still ask (G410).
    if (pr && pr.by === captureAgent(rulesOf(root)) && !isOwnerId(pr.by) && !it.private && !it.money && quietAboutOwner(root, pr, ctx.notes)) return filed(fileVerdict(root, it, pr, ctx.notes, now));
    // The Gardener's proposals from its trial tier, once the owner made it a core writer (audit v4,
    // 2026-10-26: 4 stranded as "your own material"): they file as its writes now do, never a
    // private or money one, and only its facts.
    const rules = rulesOf(root);
    if (pr && isGardener(rules, pr.by) && (rules.policy.agents[pr.by]?.status ?? "active") === "active" && tierOf(rules, pr.by).writes === "direct" && (pr.request.kind ?? "fact") === "fact" && !it.private && !it.money) return filed(fileVerdict(root, it, pr, ctx.notes, now));
    // Any other proposal of a core assistant (the capture agent writing as one, a core writer
    // outside its area or above its level): while the owner holds them (auto_decide.
    // hold_assistants_until in rules/escalation.yaml), held until that day with a diary line saying
    // so; then, or with no hold, it files by the rules above: on its page with Undo, a private one
    // under the serving hold, a different value as a conflict to settle.
    // A core assistant's own memory, imported (`memsync import`, or its memory_dump), is its word
    // as surely as its remember would be, so it files the same way (G587: claude.ai's 22 were left
    // to expire, as only the capture agent's and the owner's captured proposals filed).
    if (pr && !isOwnerId(pr.by) && (!captured(root, pr.file) || importedBy(root, pr.file, pr.by)) && (pr.request.kind ?? "fact") === "fact" && coreAssistant(rules, pr.by)) return filed(holdUntilEnd(fileVerdict(root, it, pr, ctx.notes, now), rules, now, a.hold_assistants_until));
  }
  if (it.private) return { never: "Private: only you decide this." };
  if (it.money) return { never: "Money: only you decide this." };
  if (autoOff(root, it.key)) return { never: "You undid the hub's decision on this, so it waits for you." };
  // A conflict always waits for the owner. Every conflict that reaches him is one the conflict
  // order couldn't settle, and the hub can check that a cited message exists but not that it says
  // what the side claims, so any pick it made would rest on the agents' own word (G78, G126-G128).
  if (it.kind === "dispute") return { never: "Conflicts wait for you: the hub can't check that a source says what a side claims." };
  if (it.kind === "proposal") {
    const pr = proposalOf(root, it.ref);
    const kind = pr && pulledFrom(root, pr.file, pr.request.sources);
    if (pr && kind) return saveVerdict(root, it, pr, kind, a, ctx.notes, now);
    // Only an outside assistant's proposal expires; captures, imports and the hub's own nights are
    // the owner's material and wait for him.
    const by = pr?.by ?? "";
    const rules = rulesOf(root);
    const agent = rules.policy.agents[by];
    if (!pr || !agent || agent.inside_wall) return { never: "It came from your own material, so it waits for you." };
    if (agent.status && agent.status !== "active") return { never: `${by} is ${agent.status}, so this waits for you.` };
    // Something that cites the owner's word, or reads like health, legal or money, waits (G83).
    const r = pr.request as { id?: string; title?: string; attribute?: string; value?: unknown; text?: string; sources?: unknown[] };
    if (citesOwner(pr)) return { never: CITES_OWNER };
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

// ---------- held until a day: a core assistant's own proposals ----------

// The hold on core assistants' own proposals (standing decision: held until after the finals of
// 2026-10-29) is the owner's setting, auto_decide.hold_assistants_until in rules/escalation.yaml,
// never a date in code (re-audit 2026-10-30, G531). From that day they file by the usual rules.
export const SET_ASIDE = "set it aside";
// Proposal file -> when its plan runs: held until its day, left to expire, set aside next tick.
// byAmbiguity: a proposal by a name that fits a page the brain has as well as a new one; the hub
// never guesses which, so it waits on Settings, never the home (G603).
// byCapture: an assistant's own capture citing a source, about a person, that waits for the owner by
// the source-save rule (not the capture agent's or the owner's): kept waiting under the scope freeze
// and counted on its own line, never an ask (coordinator, 2026-11-01; G600).
export interface Queues { held: Map<string, string>; expiring: Map<string, string>; setAside: Map<string, string>; byCapture: Set<string>; byAmbiguity: Set<string> }
export const newQueues = (): Queues => ({ held: new Map(), expiring: new Map(), setAside: new Map(), byCapture: new Set(), byAmbiguity: new Set() });
const HELD_DATED = new WeakSet<Plan>();

// Active, and one the owner lets write: a core tier, inside the wall, or the capture agent.
function coreAssistant(rules: Rules, by: string): boolean {
  const agent = rules.policy.agents[by];
  if (!agent || (agent.status && agent.status !== "active")) return false;
  return !!agent.inside_wall || by === captureAgent(rules) || tierOf(rules, by).writes === "direct";
}

// The first hour of the owner's day `day`.
function startOfDay(rules: Rules, day: string): Date {
  const t0 = Date.parse(`${day}T00:00:00Z`) - 14 * 3_600_000;
  for (let h = 0; h < 40; h++) { const t = new Date(t0 + h * 3_600_000); if (ownerDay(rules, t) === day) return t; }
  return new Date(`${day}T00:00:00Z`);
}

function holdUntilEnd(v: Verdict, rules: Rules, now: Date, until?: string): Verdict {
  if (!("plan" in v) || !until || ownerDay(rules, now) >= until) return v;
  const at = new Date(Math.max(Date.parse(v.plan.at), startOfDay(rules, until).getTime())).toISOString();
  const plan: Plan = { ...v.plan, at, why: `${v.plan.why.replace(/; Undo takes it back out$/, "")}, once the hold on your assistants' own proposals ends; Undo takes it back out` };
  HELD_DATED.add(plan);
  return { plan };
}

const factKeyOf = (r: { id?: string; title?: string; type?: string; attribute?: string }) => `${r.id ?? `${r.type ?? "note"}/${String(r.title ?? "new").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`}#${r.attribute ?? "note"}`;

// A diary row about a proposal: never its value (a held one may be private).
function proposalRow(root: string, pr: ReturnType<typeof proposals>[number], kind: "held" | "set_aside", now: Date, extra: Partial<DiaryRow> = {}): DiaryRow {
  const r = pr.request as { id?: string; title?: string; type?: string; attribute?: string; sources?: unknown[]; verification?: string; confidence?: string; sensitivity?: string };
  const key = factKeyOf(r);
  const note = r.id ? loadBrain(root).find((n) => n.fm.id === r.id) : undefined;
  const at = now.toISOString();
  return {
    at, fact_key: key, title: String(note?.fm.title ?? r.title ?? key.split("#")[0]), kind,
    source_word: sourceKind({ sources: (r.sources ?? []) as FactRecord["sources"], verification: (r.verification ?? "self-reported") as FactRecord["verification"] }),
    by: pr.by, confidence: r.confidence === "inferred" ? "inferred" : "stated", rank: 9, sources: (r.sources ?? []).length,
    sensitivity: (r.sensitivity ?? "normal") as DiaryRow["sensitivity"], undo_token: sha256(`${key}\n${at}\n${pr.file}\n${kind}`).slice(0, 16), ref: pr.file, ...extra,
  };
}

function setAside(root: string, it: Item, pr: ReturnType<typeof proposals>[number], now: Date): Verdict {
  const what = pr.request.retract ? "a take-back from an assistant changes nothing on its own (models suggest, never delete)" : "an open question is not a fact, and only a conflict asks you";
  return { plan: { choice: "reject", label: SET_ASIDE, why: `${what}; Undo brings it back`, at: now.toISOString(), run: () => {
    const res = decideProposal(root, it.ref, "reject", AUTO);
    if (res.outcome === "refused") throw new CoreError(409, res.message);
    const rules = rulesOf(root);
    const rel = appendDiary(root, proposalRow(root, pr, "set_aside", now), ownerDay(rules, now).slice(0, 7));
    commitPaths(root, [rel], `${AUTO}: set aside ${it.ref}\n\nWhy: ${what}; the assistant can raise it again.\nKind: diary`, AUTO);
    return `set aside ${it.ref}`;
  } } };
}

// One diary line per held proposal, the first tick it is held: what waits and the day it files.
function noteHeld(root: string, held: ReturnType<typeof proposals>, now: Date): void {
  const until = loadEscalation(root).auto_decide.hold_assistants_until;
  if (!held.length || !until) return;
  const have = new Set(readDiary(root).filter((r) => r.kind === "held" && r.ref).map((r) => r.ref!));
  const fresh = held.filter((pr) => !have.has(pr.file));
  if (!fresh.length) return;
  const rules = rulesOf(root);
  let rel = "";
  for (const pr of fresh) rel = appendDiary(root, proposalRow(root, pr, "held", now, { until }), ownerDay(rules, now).slice(0, 7));
  const n = fresh.length;
  commitPaths(root, [rel], `hub: ${n} assistant proposal${n === 1 ? "" : "s"} held until ${until}\n\nWhy: you hold your assistants' own proposals until ${until}; ${n === 1 ? "it files" : "they file"} that day by the usual rules (a different value goes to settle).\nKind: diary`, "hub");
}

// ---------- saved for you: low-risk facts from the calendar and mail (backlog 393) ----------

const SAVED = "saved it";
// What a save run returns when the write opened a conflict instead (decideNow logs it as one).
const HELD_RUN = "held as a conflict";
// What a conflict plan's run returns when the write updated the value instead.
const UPDATED_RUN = "updated it";
// What a run returns when the write handed the yes back as a new proposal (a write check it fails):
// nothing was filed, so the row never says it was (audit v11 finding 8; G650).
const HANDED_BACK = "handed back";
// An accept's outcome as a run says it: refused throws (logged as a failed save), a conflict is
// held, a proposal handed back is said as one; anything else is what the plan says it did.
function accepted(res: { outcome: string; message?: string }, ok: string): string {
  if (res.outcome === "refused") throw new CoreError(409, res.message ?? "refused");
  if (res.outcome === "disputed") return HELD_RUN;
  // A noop is a fact already held word for word (a confirmation), unless it is propose()'s own
  // "already proposed": the same proposal handed back again.
  if (res.outcome === "inbox" || (res.outcome === "noop" && /^already proposed: /.test(res.message ?? ""))) return HANDED_BACK;
  return ok;
}
export const CONFLICT = "held it as a conflict";
// What the row says when the hub's yes came back as a proposal (HANDED_BACK).
const LEFT = "left it for you";
// What the hub did with a source older than the owner's word: history, the owner's value stays.
const KEPT = "kept your word";
// The pulls whose facts the hub may save: what the owner's calendar and mailboxes say about his
// projects and plans. Every other source (texts, transcripts, chat, documents) waits for him.
const SAVE_KINDS: Record<string, string> = { gcal: "calendar", gmail: "mail", mail: "mail" };

// "calendar" or "mail" when a pull of that kind proposed this: only proposeItem (src/capture.ts)
// writes a `capture:` field, and a pulled item's only ref is its own message or event.
function pulledFrom(root: string, file: string, sources: unknown): string | undefined {
  let doc: { capture?: unknown } | null;
  try { doc = YAML.parse(readFileSync(join(root, "inbox", file), "utf8")); } catch { return undefined; }
  if (typeof doc?.capture !== "string") return undefined;
  const kinds = new Set((Array.isArray(sources) ? sources : []).map((x) => SAVE_KINDS[schemeOf(refString(x as never)) ?? ""] ?? ""));
  return kinds.size === 1 && !kinds.has("") ? [...kinds][0] : undefined;
}

// The hub's save of a proposal. A value its writer was never shown (leak_tripwire) already
// alerted the owner: the proposal is dropped, so the alert is the one thing that asks (Mac,
// 2026-10-27; G454). Any other refusal stays open and is logged as a failed save.
function saveRun(root: string, ref: string): string {
  const res = decideProposal(root, ref, "accept", AUTO, [], { hold: true });
  if (res.outcome === "refused" && res.fails?.some((f) => f.check === "leak_tripwire")) {
    const drop = decideProposal(root, ref, "reject", AUTO);
    if (drop.outcome === "refused") throw new CoreError(409, drop.message);
    return `dropped ${ref}: the owner is alerted`;
  }
  return accepted(res, `saved ${ref}`);
}

// Facts saved today, the owner's day: the cap counts them, undone or not.
function savedToday(root: string, rules: Rules, now: Date): number {
  const d = ownerDay(rules, now);
  return readJsonl<AutoDone & { undo_of?: string }>(join(logDir(root), AUTO_LOG)).filter((r) => !r.undo_of && r.picked === SAVED && ownerDay(rules, r.at) === d).length;
}
// The first hour at which the owner's day has turned.
function nextDay(rules: Rules, now: Date): Date {
  const d = ownerDay(rules, now);
  for (let h = 1; h <= 25; h++) { const t = new Date(Math.ceil(now.getTime() / 3_600_000) * 3_600_000 + (h - 1) * 3_600_000); if (ownerDay(rules, t) !== d) return t; }
  return new Date(now.getTime() + 86_400_000);
}

const ABOUT_PERSON = "It's about a person, so only you decide it.";
// A new page by a name that fits a page the brain has too (the write asks "new or same as …?"):
// the hub never guesses which (G603).
const AMBIGUOUS = "Its name fits more than one note, so you decide where it goes.";
function saveVerdict(root: string, it: Item, pr: ReturnType<typeof proposals>[number], kind: string, a: EscalationPolicy["auto_decide"], notes: Note[], now: Date): Verdict {
  const rules = rulesOf(root);
  const r = pr.request as { id?: string; title?: string; type?: string; attribute?: string; value?: unknown; text?: string; retract?: boolean; sources?: unknown[] };
  const refs = (Array.isArray(r.sources) ? r.sources : []).map((x) => refString(x as never));
  const wait = (why: string): Verdict => ({ never: why });
  if (a.source_saves_per_day <= 0) return wait("It could be saved for you, but that is off until you turn it on (auto_decide: { source_saves_per_day: 20 } in rules/escalation.yaml).");
  if (/owner_message_registered/.test(pr.reason) || refs.some((x) => isExactLouisRef(x) || SCHEMES[schemeOf(x) ?? ""] === "louis")) return wait("It cites your own word, so only you can keep or drop it.");
  const note = r.id ? notes.find((n) => n.fm.id === r.id) : undefined;
  if (r.type === "person" || note?.fm.type === "person" || /^people\//.test(String(r.id ?? ""))) return wait(ABOUT_PERSON);
  // A new note is saved by name, and the save sees every note: a name that now matches a person,
  // money or private note would land the fact there.
  const named = !r.id && r.title ? notes.filter((n) => compareKey(String(n.fm.title ?? "")) === compareKey(r.title!)) : [];
  if (named.some((n) => n.fm.type === "person" || n.fm.type === "money" || sensitivityRank(n.fm.sensitivity) >= sensitivityRank("private")))
    return wait("Its name matches a private, money or person note, so only you decide it.");
  if (/the model inferred it/.test(pr.reason)) return wait("The source doesn't name what it's about, so only you decide it.");
  if (r.retract || r.attribute === "open_question") return wait("Only new or newer facts are saved for you; this waits for you.");
  if (sensitiveShape(rules, r.id, r.title, r.attribute, r.value, r.text, getQuote(root, pr.file))) return wait("It looks like health, legal or money, so only you decide it.");
  const cur = note && r.attribute ? note.fm.facts?.[r.attribute] : undefined;
  const recs = (cur && typeof cur === "object" && !isList(cur as never) && "candidates" in (cur as object)) ? (cur as { candidates: FactRecord[] }).candidates : cur ? (isList(cur as never) ? (cur as unknown as FactRecord[]) : [cur as FactRecord]) : [];
  if (recs.some((x) => x && isOwnerConfirmed(normVerification(x.verification)))) return wait("It changes a value you confirmed, so only you decide it.");
  // A newer value from the same kind of source replaces it; over another kind it would be a
  // conflict, which is the owner's to settle.
  const live = recs.filter((x) => x && !x.retired && !x.valid_to);
  if (live.some((x) => compareKey(x.value) !== compareKey(r.value) && !(x.sources ?? []).length || (x.sources ?? []).some((y) => SAVE_KINDS[schemeOf(refString(y)) ?? ""] !== kind)))
    return wait("It changes a value another kind of source gave, so only you decide it.");
  // Only a newer one: two values of the same day are a conflict.
  const asOf = String((r as { as_of?: unknown }).as_of ?? "");
  if (live.some((x) => compareKey(x.value) !== compareKey(r.value) && !(asOf > String(x.as_of ?? "")))) return wait("It disagrees with a value of the same day or newer, so only you decide it.");
  const why = `a ${kind} fact, not about a person, money or anything private; Undo takes it back out`;
  const run = () => {
    // If the fact changed since this was weighed, the write's conflict waits for the Gardener beside
    // the live value, and the row says so (owner's re-audit, 2026-10-25: c-0008; G425).
    return saveRun(root, it.ref);
  };
  const cap = a.source_saves_per_day;
  if (savedToday(root, rules, now) >= cap) return { plan: { choice: "accept", label: SAVED, why: `${why}; today's ${cap} a day are saved, so it goes tomorrow`, at: nextDay(rules, now).toISOString(), run } };
  return { plan: { choice: "accept", label: SAVED, why, at: new Date(Math.min(now.getTime(), from(root, it.key, `inbox/${it.ref}`, now))).toISOString(), run } };
}

// ---------- file everything: only a conflict asks (owner, 2026-10-25) ----------

// Only proposeItem (src/capture.ts) writes a `capture:` field: a capture's or a source pull's fact.
function quietAboutOwner(root: string, pr: { by: string; file: string; request: unknown }, notes: Note[]): boolean {
  const rules = rulesOf(root);
  const status = rules.policy.agents[pr.by]?.status;
  if (status && status !== "active") return false;
  const r = pr.request as { id?: string; title?: string; type?: string; attribute?: string; value?: unknown; text?: string; sensitivity?: string; sources?: unknown[] };
  if (privateLevel([r.sensitivity]) || sensitiveShape(rules, r.id, r.title, r.attribute, r.value, r.text)) return false;
  if ((r.sources ?? []).map((x) => refString(x as never)).some((x) => isExactLouisRef(x) || SCHEMES[schemeOf(x) ?? ""] === "louis")) return false;
  const note = r.id ? notes.find((n) => n.fm.id === r.id) : undefined;
  if ((note?.fm.type ?? r.type) !== "person") return false;
  const self = ownerOf(rules, notes, String(note?.fm.title ?? r.title ?? ""));
  return !!self && (!r.id || self.page === r.id);
}

// The write checks that send a proposal to the owner (outcome "inbox" in src/checks.ts), as the
// write path recorded them in the proposal file's checks list, never read from its reason.
const OWNER_CHECKS: Record<string, string> = {
  injection_shapes: "It reads like an instruction to an assistant, so only you decide it.",
  link_only_source: "Its only source is a link the hub can't open, so only you decide it.",
  approval_needs_message_id: "It claims your approval without your message on record, so only you decide it.",
  // A hub yes is weighed as the assistant's write, and it is never given this category: the same
  // check hands it back each time (G650).
  withheld_category: "It names something this assistant isn't given, so only you decide it.",
};
function ownerChecks(root: string, file: string): string | undefined {
  try {
    const c = (YAML.parse(readFileSync(join(root, "inbox", file), "utf8")) as { checks?: unknown })?.checks;
    return Array.isArray(c) ? c.map((x) => OWNER_CHECKS[String(x)]).find(Boolean) : undefined;
  } catch { return undefined; }
}

function captured(root: string, file: string): boolean {
  try { return typeof (YAML.parse(readFileSync(join(root, "inbox", file), "utf8")) as { capture?: unknown })?.capture === "string"; } catch { return false; }
}

// A proposal from an assistant's imported memory: its capture was stored `via: import` by that same
// assistant (src/memimport.ts, memsync's memory_dump), never a mail, a drop or another agent's.
function importedBy(root: string, file: string, by: string): boolean {
  try {
    const rel = (YAML.parse(readFileSync(join(root, "inbox", file), "utf8")) as { capture?: unknown })?.capture;
    if (typeof rel !== "string" || !/^inbox\/captures\/[^/]+\.md$/.test(rel)) return false;
    const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(root, rel), "utf8"))?.[1];
    const c = fm ? YAML.parse(fm) as { via?: unknown; by?: unknown } : undefined;
    return c?.via === "import" && c?.by === by;
  } catch { return false; }
}

// With auto_decide.file: all, a fact a capture or a pull found files itself on the next tick, on a
// person's page, a new page or a private one alike, with Undo, and no daily cap. It waits only
// when it isn't simply a new fact: a different value for one the brain holds (unless it is a newer
// one from the same kind of source, which is an update), a value the owner confirmed, a fact
// already in conflict, or a retirement. Never a value in a reason: these show on the overview.
// The notes a writer's by-title write resolves over (write(): its carve copies, or every note for an
// agent inside the wall).
function writerShown(rules: Rules, notes: Note[], agent: string): Note[] {
  if (rules.policy.agents[agent]?.inside_wall) return notes;
  return [...carve(notes, rules, grantFor(rules, agent), { flags: false }).visible.values()].map((v) => v.note);
}
function fileVerdict(root: string, it: Item, pr: ReturnType<typeof proposals>[number], notes: Note[], now: Date): Verdict {
  const rules = rulesOf(root);
  const r = pr.request as { id?: string; title?: string; type?: string; attribute?: string; value?: unknown; retract?: boolean; sources?: unknown[]; as_of?: string };
  const wait = (why: string): Verdict => ({ never: why });
  if (r.retract || r.attribute === "open_question") return wait("Only new facts file themselves; this one waits for you.");
  // Quoted from a mail's footer (who it was sent to, how to unsubscribe): not a fact, dropped with
  // Undo, so the proposals made before footers were skipped leave the owner's list too (G405).
  const q = isOwnerId(pr.by) ? undefined : getQuote(root, `inbox/${it.ref}`);
  if (q && MAIL_FOOTER.test(q)) return { plan: { choice: "reject", label: "dropped it", why: "it came from a mail's footer, not a fact; Undo brings it back", at: now.toISOString(), run: () => {
    const res = decideProposal(root, it.ref, "reject", AUTO);
    if (res.outcome === "refused") throw new CoreError(409, res.message);
    return `dropped ${it.ref}`;
  } } };
  // A new page is saved by name: a note that now has that name is where it would land (the write
  // path resolves it the same way), so it is weighed against that note.
  // Only the notes the writer is shown, as write() resolves a by-title write for the hub's yes: a
  // namesake it can't see is not where the fact lands (audit v11 finding 8; G650).
  const named = !r.id && r.title && r.type ? resolveEntity(writerShown(rules, notes, String((r as { agent?: string }).agent ?? pr.by)), r.type, String((r as { title?: string }).title)) : undefined;
  if (named?.ambiguous) return wait(AMBIGUOUS);
  const id = r.id ?? named?.id;
  const note = id ? notes.find((n) => n.fm.id === id) : undefined;
  const cur = note && r.attribute ? note.fm.facts?.[r.attribute] : undefined;
  if (cur && typeof cur === "object" && !isList(cur as never) && "candidates" in (cur as object)) return wait("This fact is already in conflict, so you decide it.");
  const live = cur ? records(cur as never).filter((x) => x && !x.retired && !x.valid_to) : [];
  const spec = attributeSpec(rules, String(note?.fm.type ?? r.type ?? ""), String(r.attribute ?? ""));
  // A list of values (merge: set or append) takes another item beside the ones it holds: only an
  // item with the same key and other content contradicts one. A card's second address on a page
  // where the owner gave one waited as an ask that never filed (audit v8, 2026-10-31; G565).
  const listed = cur && isList(cur as never) && (spec.merge === "set" || spec.merge === "append");
  const keyOf = (v: unknown) => spec.item_key && v && typeof v === "object" ? String((v as Record<string, unknown>)[spec.item_key]) : undefined;
  const differs = (x: FactRecord) => compareKey(x.value) !== compareKey(r.value) && (!listed || (keyOf(x.value) !== undefined && keyOf(x.value) === keyOf(r.value)));
  // The owner's word, or a co-owner's in their own area (isOwnerWord, as the write path weighs it):
  // the write path decides (audit v4, 2026-10-26: asking here first meant a capture never reached
  // "older sources never re-ask"). A source dated before the owner's word goes to history and asks
  // nothing; any other different value is a conflict, asked at once (write(): ownerDispute).
  const ownerWords = live.filter((x) => differs(x) && (isOwnerConfirmed(normVerification(x.verification)) || (note && isOwnerWord(rules, note.fm.area, x))));
  const older = ownerWords.length > 0 && ownerWords.every((x) => x.as_of && r.as_of && String(r.as_of).slice(0, 10) < String(x.as_of).slice(0, 10));
  if (older) return { plan: { choice: "accept", label: KEPT, why: "an older source than your word: kept as history, your value stays; Undo takes it back out", at: now.toISOString(), run: () => {
    return accepted(decideProposal(root, it.ref, "accept", AUTO), `kept ${it.ref}`);
  } } };
  const askOwner = ownerWords.length > 0;
  // A sender no person page holds files a private or money fact under the serving hold (G420,
  // G429, G454): decideProposal saves it unseen, marked unknown sender, so it waits for the
  // owner's Show on the home instead of as a card.
  const merge = spec.merge ?? "replace";
  // A different value for one the brain holds is a conflict: filed as one (both sides kept, with
  // Undo), and it waits for the Gardener's nightly pass before it asks (owner, 2026-10-25: "ask me
  // only conflicts caught by the gardener"; G416). Money, health and legal ones ask the same day.
  // On a page with a private fact the write path hands a conflict back to the owner (write():
  // contest on a private record), so it waits here with the reason instead of being called held
  // (north-star replay, 2026-10-26: logged "held it as a conflict", then lost; G431).
  const privateRec = Object.values(note?.fm.facts ?? {}).some((f) => records(f as never).some((x) => x?.sensitivity && sensitivityRank(x.sensitivity) >= sensitivityRank("private")));
  const conflict: Verdict = privateRec ? wait("Two sources disagree about a page that holds a private fact, so you decide it.") : { plan: { choice: "accept", label: CONFLICT, why: "two sources disagree; the Gardener weighs it tonight, then you decide; Undo takes it back out", at: now.toISOString(), run: () => {
    // The write decides, and the row says what it did: a newer value from as strong a source is
    // an update by its rule, never logged as a conflict nobody holds (outside review v3; G438).
    return accepted(decideProposal(root, it.ref, "accept", AUTO, [], { contest: true }), UPDATED_RUN);
  } } };
  if (askOwner) return conflict;
  // A conflict already waits beside the live value (G425): a different value joins it.
  if (cur && typeof cur === "object" && !isList(cur as never) && (cur as FactRecord).contested && compareKey((cur as FactRecord).value) !== compareKey(r.value)) return conflict;
  // Dated ahead (a mail saying what changes on 1 December): filed today it would end the current
  // value now (slice audit, G406), so you say when.
  if (merge === "replace" && live.some(differs) && String(r.as_of ?? "").slice(0, 10) > today()) return wait("It says what changes on a later date, so you decide when it takes over.");
  if (merge === "replace" && live.some(differs)) {
    const kinds = new Set((r.sources ?? []).map((y) => schemeOf(refString(y as never)) ?? ""));
    // Only what the hub pulled itself updates this way; an assistant's word for what a mail says is
    // weighed by the write as a conflict side (G536).
    // An assistant's imported memory is its word, never an update of what a source said (G587 F2).
    const update = captured(root, pr.file) && !importedBy(root, pr.file, pr.by) && live.filter(differs).every((x) => (x.sources ?? []).length && (x.sources ?? []).every((y) => kinds.has(schemeOf(refString(y)) ?? "")) && String(r.as_of ?? "") > String(x.as_of ?? ""));
    if (!update) return conflict;
  }
  // A run of values (merge: latest): the write keeps the newer one and moves the other to history,
  // but only from a source at least as strong and on another date or with a higher number; any
  // other different value opens a conflict there, so it waits here instead of being called saved.
  if (merge === "latest" && live.some(differs)) {
    const mine = sourceRank({ sources: (importedBy(root, pr.file, pr.by) ? asAgentWord(r.sources ?? [], pr.by) : r.sources ?? []) as FactRecord["sources"], verification: (r as { verification?: FactRecord["verification"] }).verification ?? "self-reported", confidence: (r as { confidence?: FactRecord["confidence"] }).confidence });
    const steps = live.filter(differs).every((x) => sourceRank(x) <= mine && (String(r.as_of ?? "") !== String(x.as_of ?? "") || versionOrder(String(r.value), String(x.value)) !== 0));
    if (!steps) return conflict;
  }
  const why = `${note ? "filed on its page" : "filed as a new page"}; Undo takes it back out`;
  const run = () => {
    // If the fact changed since this was weighed, the write's conflict waits for the Gardener beside
    // the live value, and the row says so (owner's re-audit, 2026-10-25: c-0008; G425).
    return saveRun(root, it.ref);
  };
  return { plan: { choice: "accept", label: SAVED, why, at: now.toISOString(), run } };
}

// The proposals the hub will save on its own (a plan to save, today or once the day's cap turns):
// the overview says how many and doesn't ask them (owner, 2026-10-24: 43 cards he couldn't decide
// on). Empty where nothing decides: deciding off, saves off, or a replica.
// `queues`, when given, also gets the proposals held until the owner's hold ends, those an outside
// assistant left to expire, and those set aside on the next tick: queues with a day, never asks
// (north-star --brain counts them apart).
export function autoSaves(root: string, now = new Date(), state?: ReturnType<typeof loadState>, queues?: Queues): Set<string> {
  const out = new Set<string>();
  const p = loadEscalation(root);
  if (p.auto_decide.off || (p.auto_decide.source_saves_per_day <= 0 && p.auto_decide.file !== "all")) return out;
  try { hubGate(root, ["commit"]); } catch { return out; }
  state ??= loadState(root);
  const ctx = { notes: state.notes };
  build = { root, props: withTwins(state.proposals, root), rules: state.rules };
  // A save that failed in the last day, under this code, is asked, not hidden: it may never go
  // through on its own. An older one, or one under other code, is tried again (G404, G407).
  const failed = failedSaves(root, now);
  try {
    for (const it of openItems(root, now)) {
      if (it.kind !== "proposal" || failed.has(it.key) || autoOff(root, it.key)) continue;
      const v = verdict(root, it, p, ctx, now);
      if ("plan" in v && HELD_DATED.has(v.plan)) queues?.held.set(it.ref, v.plan.at);
      else if ("plan" in v && (v.plan.label === SAVED || v.plan.label === CONFLICT)) out.add(it.ref);
      else if ("plan" in v && v.plan.label === SET_ASIDE) queues?.setAside.set(it.ref, v.plan.at);
      else if ("plan" in v && v.plan.choice === "reject") queues?.expiring.set(it.ref, v.plan.at);
      else if ("never" in v && v.never === AMBIGUOUS) queues?.byAmbiguity.add(it.ref);
      else if ("never" in v && v.never === ABOUT_PERSON) {
        const pr = proposalOf(root, it.ref);
        if (pr && !isOwnerId(pr.by) && pr.by !== captureAgent(build!.rules) && captured(root, pr.file)) queues?.byCapture.add(it.ref);
      }
    }
  } finally { build = undefined; }
  return out;
}

// The saves refused in the last day: the next try waits a day, so the error log grows by at most
// one line a day for each.
let failedMemo: { tag: string; keys: Set<string> } | undefined;
export function failedSaves(root: string, now: Date): Set<string> {
  // Read once per pass, not once per item: kept while the log and the minute are the same.
  const f = join(logDir(root), AUTO_LOG.replace(".jsonl", "-errors.jsonl"));
  const st = existsSync(f) ? statSync(f) : undefined;
  const tag = `${root}|${st?.size ?? 0}|${st?.mtimeMs ?? 0}|${Math.floor(now.getTime() / 60_000)}`;
  if (failedMemo?.tag === tag) return failedMemo.keys;
  failedMemo = { tag, keys: failedSavesRead(root, now) };
  return failedMemo.keys;
}
// A refusal recorded by other code is tried again at once: a deploy may carry the fix (G407). The
// code is the app's commit (its package version without git), so a restart alone retries nothing.
export const FILING_CODE: string = (() => {
  const app = join(import.meta.dir, "..");
  try { const sha = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: app }).stdout.toString().trim(); if (sha) return sha; } catch { /* no git */ }
  try { return String(JSON.parse(readFileSync(join(app, "package.json"), "utf8")).version); } catch { return "unknown"; }
})();
// Refused twice under this code, it isn't tried again until other code runs: a rule that refuses
// it once refuses it every day (0.2.0 live, 2026-10-30: 755 refused-save lines; G519). It waits
// as a card and the auto_saves check says so.
function failedSavesRead(root: string, now: Date): Set<string> {
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const mine = readJsonl<{ key: string; at?: string; code?: string }>(join(logDir(root), AUTO_LOG.replace(".jsonl", "-errors.jsonl"))).filter((r) => r.code === FILING_CODE);
  const times = new Map<string, number>();
  for (const r of mine) times.set(r.key, (times.get(r.key) ?? 0) + 1);
  return new Set(mine.filter((r) => String(r.at ?? "") >= since || times.get(r.key)! >= 2).map((r) => r.key));
}

// Run every plan whose time has come. Returns what was decided. Safe to call every tick.
// `skip`: items the owner answered in this tick, even with a reply that couldn't apply (G159).
// Under a file lock every process on this brain shares (src/filelock.ts, #263): while another
// one is deciding, this call decides nothing and the next tick tries again.
export function runAuto(root: string, now = new Date(), skip: ReadonlySet<string> = new Set(), opts: { filingOnly?: boolean } = {}): AutoDone[] {
  return withFileLock(root, "decide", () => decideNow(root, now, skip, !!opts.filingOnly)) ?? [];
}

function decideNow(root: string, now: Date, skip: ReadonlySet<string>, filingOnly: boolean): AutoDone[] {
  const p = loadEscalation(root);
  if (p.auto_decide.off) { saveSeen(root, {}); return []; }
  try { hubGate(root, ["commit"]); } catch { return []; } // a replica never decides
  const ctx = { notes: [] as Note[] };
  // Read fresh after every decision: two proposals on one fact in one tick are weighed one after
  // the other, never both against the same old value (owner's re-audit, 2026-10-25; G425).
  let dirty = true;
  const done: AutoDone[] = [];
  const held: ReturnType<typeof proposals> = [];
  const began = new Date(Date.now() - 1000).toISOString(); // git's clock, for the page text below
  const failed = failedSaves(root, now);
  for (const it of openItems(root, now)) {
    if (skip.has(it.key) || failed.has(it.key)) continue;
    if (dirty) { ctx.notes = loadBrain(root); dirty = false; }
    const v = verdict(root, it, p, ctx, now);
    if ("plan" in v && HELD_DATED.has(v.plan) && Date.parse(v.plan.at) > now.getTime()) { const pr = proposalOf(root, it.ref); if (pr) held.push(pr); continue; }
    if (!("plan" in v) || Date.parse(v.plan.at) > now.getTime() || (filingOnly && !FILED.has(v.plan))) continue;
    const mine = () => git(root, ["log", "-1", "--format=%H", `--author=${AUTO}@pocketbrain.local`]);
    const before = mine();
    let ran = "";
    try { ran = v.plan.run(); dirty = true; } catch (e) { append(root, AUTO_LOG.replace(".jsonl", "-errors.jsonl"), { at: now.toISOString(), key: it.key, error: String((e as Error).message ?? e), code: FILING_CODE }); continue; }
    const commit = mine(); // the hub's own commit, even if another write landed meanwhile
    if (!commit || commit === before) continue;
    // A save is two commits (the fact, then the answered proposal); Undo reverts both.
    const all = git(root, ["log", "--format=%H", `--author=${AUTO}@pocketbrain.local`, ...(before ? [`${before}..HEAD`] : [])]).split("\n").filter(Boolean);
    const said = ran === HELD_RUN ? (v.plan.label === CONFLICT ? { picked: CONFLICT, why: v.plan.why } : { picked: CONFLICT, why: "the fact changed before it was saved, so it waits as a conflict for the Gardener; Undo takes it back out" })
      : ran === HANDED_BACK ? { picked: LEFT, why: "the write's checks handed it back, so it waits for you; Undo takes the hub's yes back out" }
      : ran === UPDATED_RUN ? { picked: SAVED, why: "a newer value from as strong a source, so the write updated it; Undo takes it back out" } : { picked: v.plan.label, why: v.plan.why };
    const row: AutoDone = { key: it.key, question: it.title, ...said, at: now.toISOString(), commit, ...(all.length > 1 ? { commits: all } : {}) };
    append(root, AUTO_LOG, row as unknown as Record<string, unknown>);
    done.push(row);
  }
  noteHeld(root, held, now);
  // The pages it filed onto get their text now, not at night (outside review v5, midday: pages
  // with facts and no lead until the night run). A failure leaves it to the night run.
  if (done.some((d) => d.picked !== SET_ASIDE && !/^lets it expire|^dropped/.test(d.picked))) try { renderTouchedPages(root, began); } catch { /* the night run writes it */ }
  return done;
}

// `pocketbrain filing now`: the same step by hand, but only when no hub is running here. The hub
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

// Undo one auto-decision: revert its commit as the owner. The item comes back to the owner and the
// hub never decides it again.
export function undoAuto(root: string, key: string): string {
  const row = readJsonl<AutoDone & { undo_of?: string }>(join(logDir(root), AUTO_LOG)).filter((r) => r.key === key && !r.undo_of).at(-1);
  if (!row) throw new CoreError(404, "the hub made no decision on that");
  if (autoDecisions(root, 3650).find((r) => r.commit === row.commit)?.undone) return "already undone";
  // Newest first: a saved fact's answered proposal, then the fact itself.
  const commits = row.commits?.length ? row.commits : [row.commit];
  if (commits.some((c) => !/^[0-9a-f]{40}$/.test(c))) throw new CoreError(400, "bad commit");
  // A capture held as a conflict: its side is taken back out of the conflict, even after the
  // Gardener suggested a side or another value joined (a revert would fail there).
  const held = row.picked === CONFLICT ? heldConflictOf(root, commits) : undefined;
  if (held) {
    for (const c of commits) if (git(root, ["log", "-1", "--format=%ae", c]) !== `${AUTO}@pocketbrain.local`) throw new CoreError(403, "only the hub's own decisions are undone here");
    hubGate(root, ["commit"]);
    const why = withdrawConflictSide(root, held.id, held.file);
    if (why) throw new CoreError(409, `${why}; decide it on its page instead`);
    append(root, AUTO_LOG, { key, undo_of: row.commit, at: new Date().toISOString() });
    logWrite(root, { at: new Date().toISOString(), agent: OWNER, kind: "owner-edit", key, outcome: "committed", step: 6, undo_of: row.commit });
    return "Undone. It waits for you now.";
  }
  // Only a commit the hub made on the owner's behalf, never anyone else's.
  for (const c of commits) if (git(root, ["log", "-1", "--format=%ae", c]) !== `${AUTO}@pocketbrain.local`) throw new CoreError(403, "only the hub's own decisions are undone here");
  hubGate(root, ["revert"]);
  const revert = (cs: string[]) => {
    const r = Bun.spawnSync(["git", "revert", "--no-edit", ...cs], { cwd: root, env: authorEnv(root, OWNER) });
    if (r.exitCode !== 0) Bun.spawnSync(["git", "revert", "--abort"], { cwd: root });
    return r.exitCode === 0;
  };
  const since = gitTime(git(root, ["log", "-1", "--format=%cI", commits.at(-1)!]));
  if (!revert(commits)) {
    // The page text the hub wrote since on those pages (the filing tick writes it, G462) goes back
    // first, then is written again from the facts as they are after the Undo.
    const files = [...new Set(commits.flatMap((c) => git(root, ["show", "--name-only", "--format=", c]).split("\n").filter((p) => p.endsWith(".md"))))];
    const text = files.length ? git(root, ["log", "--format=%H", "--author=hub@pocketbrain.local", "--grep=^Kind: page-writer", `${commits[0]}..HEAD`, "--", ...files]).split("\n").filter(Boolean) : [];
    if (!text.length || !revert([...text, ...commits])) throw new CoreError(409, "something changed it since; decide it on its page instead");
  }
  // A clean revert takes out the fact but not the page text the hub wrote from it after (re-audit
  // 2026-10-30, G527: the page went on saying the undone value): the text is written again from
  // the facts as they are now, whichever way the revert went.
  try { renderTouchedPages(root, since); } catch { /* the night run writes it */ }
  append(root, AUTO_LOG, { key, undo_of: row.commit, at: new Date().toISOString() });
  logWrite(root, { at: new Date().toISOString(), agent: OWNER, kind: "owner-edit", key, outcome: "committed", step: 6, undo_of: row.commit });
  return "Undone. It waits for you now.";
}

// The conflict a CONFLICT decision opened and the proposal it answered, from its own commits.
function heldConflictOf(root: string, commits: string[]): { id: string; file: string } | undefined {
  const added = commits.flatMap((c) => git(root, ["show", "--name-status", "--no-renames", "--format=", c]).split("\n")).map((l) => l.split("\t"));
  const id = added.find(([st, p]) => st === "A" && /^disputes\/c-\d+\.md$/.test(p ?? ""))?.[1]?.slice(9, -3);
  const file = added.find(([st, p]) => st === "A" && /^inbox\/decided\/[^/]+\.ya?ml$/.test(p ?? ""))?.[1]?.split("/").pop();
  return id && file ? { id, file } : undefined;
}

// One line per auto-decision, for the digest.
export function autoDigestLines(root: string, since: string): string[] {
  return autoDecisions(root, 3650).filter((r) => r.at >= since).map((r) => `- ${r.undone ? "(undone) " : ""}${r.question}: the hub ${r.picked}, because ${r.why}. Undo on the overview.`);
}
