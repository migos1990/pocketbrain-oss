// SPDX-License-Identifier: AGPL-3.0-only
// The one write function every writer goes through (architecture 0.6):
// resolve entity -> build fact_key -> run checks -> compare with the live value ->
// no-op, merge, supersede or dispute -> commit (or propose to inbox/).
import { sha256, alert } from "./util";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import YAML from "yaml";
import type { Note, FactRecord, SourceRef, Frontmatter } from "./brain";
import { loadBrain, saveNote, isList, isDisputed, slugify, today, sensitivityRank } from "./brain";
import type { Rules } from "./rules";
import { loadRules, attributeSpec, tierOf, ownerName } from "./rules";
import { runChecks, shapeFails, thirdPartySensitive, findInjection, TYPE_FOLDER, type WriteRequest, type CheckFail } from "./checks";
import { normalizeValue, compareKey } from "./normalize";
import { refString, normalizeRef, sourceRank, isExactLouisRef, schemeOf, AGENT_MEMORY_SCHEMES } from "./sources";
import { louisMessages, registerLouisMessages, checkedRefs, ownerMessagesPath } from "./louis";
import { tokenRole } from "./tokenrole";
import { carve, grantFor, records, shownWords, withheldWord, visibleFacts, factHiddenReason, withholdName, nameNeedles, type CarveResult } from "./carve";
import { needleFor, findCarried, unhide, distinctive, squash, type Needle } from "./match";
import { git, commitPaths } from "./git";
import { appendChained } from "./readlog";
import { canaryHits } from "./canary";
import { proposalCap } from "./gardener";
import { evidenceFor } from "./evidence";
import { queueIfReplica, queueOp } from "./hub";
import { decideCapture } from "./capture";
import { coOwnerOf, isOwnerWord } from "./rules";
import { OWNER, OWNER_CONFIRMED, OWNER_REF, isOwnerConfirmed, isOwnerId, ownerRef, normVerification } from "./owner";
import { sweepQuotes } from "./quotes";

// queued: made on a replica, saved as an op file for the hub to apply (src/hub.ts).
export type WriteOutcome = "noop" | "committed" | "inbox" | "refused" | "disputed" | "queued";

export interface WriteResult {
  outcome: WriteOutcome;
  fact_key?: string;
  step?: number;
  message: string;
  file?: string;
  fails?: CheckFail[];
  alert?: boolean;
}

function folderFor(type: string, agent: string): string {
  if (type === "capability") return `agents/${agent}`;
  const f = TYPE_FOLDER[type];
  if (!f) throw new Error(`unknown type ${type}`);
  return f;
}

function sourceKey(s: SourceRef): string {
  return refString(s);
}

export function writeHash(factKey: string, value: unknown, asOf: string, sources: SourceRef[]): string {
  const src = sources.map(sourceKey).sort().join(",");
  return sha256(`${factKey}\n${compareKey(value)}\n${asOf}\n${src}`);
}

// Entity resolution before create: exact title/alias match reuses the id; a near match
// (same surname, compatible first name) is ambiguous and goes to inbox.
export function resolveEntity(notes: Note[], type: string, title: string): { id?: string; ambiguous?: string[] } {
  const same = notes.filter((n) => n.fm.type === type);
  const key = compareKey(title);
  const exact = same.filter((n) => [n.fm.title, ...(n.fm.aliases ?? [])].some((t) => compareKey(t) === key));
  if (exact.length === 1) return { id: exact[0].fm.id };
  if (exact.length > 1) return { ambiguous: exact.map((n) => n.fm.id) };
  const tokens = key.split(" ");
  const near = same.filter((n) => {
    const t = compareKey(n.fm.title).split(" ");
    if (type !== "person" || t.length < 2 || tokens.length < 2) return false;
    const lastSame = t[t.length - 1] === tokens[tokens.length - 1];
    const firstCompat = t[0].startsWith(tokens[0]) || tokens[0].startsWith(t[0]);
    return lastSame && firstCompat;
  });
  if (near.length) return { ambiguous: near.map((n) => n.fm.id) };
  return {};
}

function nextDisputeId(root: string): string {
  const dir = join(root, "disputes");
  const nums = existsSync(dir) ? readdirSync(dir).map((f) => Number(f.match(/^c-(\d+)\.md$/)?.[1] ?? 0)) : [];
  return `c-${String(Math.max(0, ...nums) + 1).padStart(4, "0")}`;
}

export function logWrite(root: string, entry: Record<string, unknown>) {
  // The same chain as the read log: the last hash read from the file's end, a line torn by a
  // crash cut off first (docs/perf.md, "Crash safety").
  appendChained(join(root, "log", "writes.jsonl"), entry);
}

// git couldn't record it (src/git.ts commitPaths put the files back): say so, never "committed".
const gitDirty = (root: string, rel: string) => existsSync(join(root, ".git")) && !!Bun.spawnSync(["git", "status", "--porcelain", "--", rel], { cwd: root }).stdout.toString().trim();
const notSaved = (why: string): WriteResult => ({ outcome: "refused", message: `not saved: the brain's git couldn't commit it (${why}). Nothing changed; try again.`, fails: [{ check: "not_saved", outcome: "refuse", reason: why, fix: "try again in a moment" }] });

export const REJECT_DAYS = 30;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// What a proposal would change, ignoring its evidence and dates: the same change twice is one change.
const changeKey = (r: Partial<WriteRequest>) => JSON.stringify([r.kind ?? "fact", r.id ?? r.title ?? "", r.attribute ?? "", r.value ?? null, !!r.retract]);
// What a change is about (the fact, or the note), whatever value it proposes.
const targetKey = (r: Partial<WriteRequest>) => JSON.stringify([r.kind ?? "fact", r.id ?? r.title ?? "", r.attribute ?? ""]);

// An agent's proposals, waiting (inbox/) and answered (inbox/decided/).
export interface ProposalFile { file: string; request: WriteRequest; decided?: string; decision?: "accept" | "reject" }
export function gardenerProposals(root: string, agent: string): ProposalFile[] {
  const out: ProposalFile[] = [];
  for (const dir of ["inbox", "inbox/decided"]) {
    const d = join(root, dir);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith(".yaml"))) {
      let p: { request?: WriteRequest; decided?: string; decision?: "accept" | "reject" } = {};
      try { p = YAML.parse(readFileSync(join(d, f), "utf8")) ?? {}; } catch { continue; }
      if (p.request?.agent === agent) out.push({ file: `${dir}/${f}`, request: p.request, decided: p.decided, decision: p.decision });
    }
  }
  return out;
}

// One card per fact (docs/capture.md): proposals for the same value of the same fact (same note,
// or type and title; same attribute; same normalized value) are shown to the owner as one card and
// answered together. Each proposer keeps its own file and gets the same answer as ever, so nothing
// an agent sees depends on what else waits in the inbox.
function sameFactKey(root: string, r: Partial<WriteRequest>, notes: Note[], rules: Rules): string | undefined {
  if ((r.kind ?? "fact") !== "fact" || r.retract || typeof r.attribute !== "string" || r.value === undefined) return undefined;
  // The note's own type when it names one: a type the agent sets is ignored by write() there.
  const type = r.id ? notes.find((n) => n.fm.id === r.id)?.fm.type : r.type;
  if (!type) return undefined;
  let value: string;
  try { value = compareKey(normalizeValue(r.value, attributeSpec(rules, type, r.attribute))); } catch { return undefined; }
  return JSON.stringify([r.id ? `id:${r.id}` : `${type}:${compareKey(String(r.title ?? ""))}`, r.attribute, value]);
}
export interface InboxDoc { by?: string; reason?: string; at?: string; request?: WriteRequest; [k: string]: unknown }
export interface InboxCard { file: string; doc: InboxDoc; twins: { file: string; doc: InboxDoc }[] }
// The inbox as the owner sees it: oldest proposal first, its twins folded into it.
export function inboxCards(root: string): InboxCard[] {
  const dir = join(root, "inbox");
  if (!existsSync(dir)) return [];
  const notes = loadBrain(root), rules = loadRules(root);
  const cards: InboxCard[] = [];
  const byKey = new Map<string, InboxCard>();
  // Oldest first, by when it was filed (not by its name, which starts with the agent's).
  const files = readdirSync(dir).filter((x) => x.endsWith(".yaml")).map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs })).sort((a, b) => a.at - b.at || a.f.localeCompare(b.f)).map((x) => x.f);
  for (const f of files) {
    let doc: InboxDoc = {};
    try { doc = (YAML.parse(readFileSync(join(dir, f), "utf8")) ?? {}) as InboxDoc; } catch { continue; }
    // An agent's proposal that cites the owner's word, or was flagged for it, is never folded into
    // another card: it keeps its own card and warning, and is answered on its own. The hub's own
    // capture of something the owner said (checks: capture, which no agent can set) folds.
    const checks = Array.isArray(doc.checks) ? doc.checks as string[] : [];
    const ownerWord = checks.includes("owner_message_registered") || (!checks.includes("capture") && (doc.request?.sources ?? []).map(refString).some(isExactLouisRef));
    const key = doc.request && !ownerWord ? sameFactKey(root, doc.request, notes, rules) : undefined;
    const card = key ? byKey.get(key) : undefined;
    if (card) { card.twins.push({ file: f, doc }); continue; }
    const fresh: InboxCard = { file: f, doc, twins: [] };
    cards.push(fresh);
    if (key) byKey.set(key, fresh);
  }
  return cards;
}

function propose(root: string, req: WriteRequest, reason: string, fails: CheckFail[]): WriteResult {
  // An agent with max_proposals_per_day (the gardener) can't flood the owner's inbox.
  const capped = proposalCap(root, loadRules(root), req.agent);
  if (capped) return { outcome: "refused", message: capped, fails: [{ check: "proposal_cap", outcome: "refuse", reason: capped, fix: "try again tomorrow" }] };
  const d = today();
  // The gardener learns the owner's answers (docs/gardener.md): while a proposal on a fact (or note)
  // waits, no other one on it is filed, and a change the owner rejected can't come back for
  // REJECT_DAYS days.
  if (loadRules(root).policy.agents[req.agent]?.role === "gardener") {
    const mine = gardenerProposals(root, req.agent), same = changeKey(req), target = targetKey(req);
    const waiting = mine.find((p) => !p.decided && targetKey(p.request) === target);
    if (waiting) return { outcome: "noop", message: `already waiting in the inbox: ${waiting.file}` };
    const since = addDays(d, -REJECT_DAYS);
    const no = mine.filter((p) => p.decision === "reject" && (p.decided ?? "") >= since && changeKey(p.request) === same).map((p) => p.decided!).sort().pop();
    if (no) {
      const why = `rejected on ${no} by ${ownerName(loadRules(root))}; don't propose it again before ${addDays(no, REJECT_DAYS)}`;
      return { outcome: "refused", message: why, fails: [{ check: "rejected_before", outcome: "refuse", reason: why, fix: "propose something else, or a different value with new evidence" }] };
    }
  }
  const h = sha256(JSON.stringify(req)).slice(0, 8);
  const rel = `inbox/${d}-${req.agent}-${h}.yaml`;
  const file = join(root, rel);
  if (existsSync(file)) return { outcome: "noop", message: `already proposed: ${rel}`, file: rel };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, YAML.stringify({ proposed: d, by: req.agent, reason, checks: fails.map((f) => f.check), evidence: evidenceFor(root, req, loadBrain(root)), request: req }, { lineWidth: 0 }));
  const unsaved = commitPaths(root, [rel], `propose(${req.agent}): ${req.id ?? req.title}#${req.attribute ?? ""}\n\n${reason}`, req.agent);
  if (unsaved) return notSaved(unsaved);
  return { outcome: "inbox", message: `proposed for review: ${reason}`, file: rel, fails };
}

// A new note's id is shown to every agent that sees the note, and an id is never scrubbed, so
// it leaves out a value carved from another agent ("Joe at <bank>" -> people/joe): bug hunt A2.
// Only values the writer is shown are left out: one carved from the writer itself stays in the id
// like any other word, so the id the writer gets back never tells it what is carved (the tripwire
// and the owner's preview handle those). The title keeps the value; each reader's carve withholds it.
function safeSlug(notes: Note[], rules: Rules, title: string, writer?: CarveResult): string {
  // Carving every agent costs; only a title that holds some stored value can need it.
  const q = squash(title);
  const holds = (v: unknown) => scalarStrings(v).some((x) => { const k = squash(x); return k.length >= 4 && q.includes(k); });
  if (!notes.some((n) => (n.fm.aliases ?? []).some(holds) || Object.values(n.fm.facts ?? {}).some((f) => records(f).some((r) => holds(r.value)))))
    return slugify(title) || `note-${sha256(title).slice(0, 6)}`;
  const own = new Set(writer?.carvedValues ?? []);
  const carved = new Set<string>();
  for (const [a, def] of Object.entries(rules.policy.agents)) {
    if (def?.inside_wall) continue;
    try { for (const v of carve(notes, rules, grantFor(rules, a), { flags: false }).carvedValues) if (!own.has(v)) carved.add(v); } catch { /* unknown slice: sees nothing */ }
  }
  const values = [...carved].sort((x, y) => y.length - x.length);
  const needles = values.filter((v) => !/^\p{L}+$/u.test(v.trim())).map((v) => needleFor(v, v)).filter((x): x is Needle => !!x).map((n) => ({ ...n, parts: [] }));
  const kept = withholdName(title, values, needles).replace(/\[withheld\]/g, " ");
  const slug = slugify(kept.replace(/\s+(at|of|from|via|with|for|in|on|de|du|chez|à)\s*[()\-,.:]*\s*$/i, ""));
  return slug || `note-${sha256(title).slice(0, 6)}`;
}

// Values the agent was never shown. Writing one means it learned it somewhere else
// (architecture 0.7, "leak tripwire on write").
// The strings a value carries: itself if a string or number, its fields if an object.
function scalarStrings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (typeof v === "number") return [String(v)];
  if (v && typeof v === "object") return Object.values(v).flatMap(scalarStrings);
  return [];
}

function carvedValues(notes: Note[], rules: Rules, agent: string, res = carve(notes, rules, grantFor(rules, agent), { flags: false })): Map<string, string> {
  const out = new Map<string, string>();
  // Generic values ("account", "active", a date) aren't secrets, and the agent may legitimately
  // use them; only distinctive values it was never shown trip the wire.
  const shown = new Set<string>();
  for (const v of res.visible.values()) for (const [, f] of visibleFacts(v, res))
    for (const r of records(f)) if (typeof r.value === "string") shown.add(r.value.toLowerCase());
  const add = (val: string, from: string) => {
    const s = val.trim();
    if (distinctive(s, shown)) out.set(s, from);
  };
  for (const n of notes) {
    if (res.visible.has(n.fm.id)) continue;
    if (sensitivityRank(n.fm.sensitivity) < sensitivityRank("private") && !res.grant.exclude_types.some((t) => n.fm.id.startsWith(t + "/"))) continue;
    for (const [attr, f] of Object.entries(n.fm.facts ?? {}))
      for (const r of records(f)) for (const v of scalarStrings(r.value)) add(v, `${n.fm.id}#${attr}`);
    for (const a of n.fm.aliases ?? []) add(a, n.fm.id);
  }
  // Facts flagged sensitive or do-not-share inside notes the agent does see.
  for (const h of res.hiddenFacts) {
    if (!/^(do not share|fact is)/.test(h.reason)) continue;
    const [id, attr] = h.key.split("#");
    const f = notes.find((n) => n.fm.id === id)?.fm.facts?.[attr];
    if (f) for (const r of records(f)) for (const v of scalarStrings(r.value)) add(v, h.key);
  }
  return out;
}

// opts.acceptedBy: Louis (or the area owner) accepting a proposal from inbox/. The write keeps
// the proposer as `by`, skips the ownership routing, still runs every check, and the commit
// is authored by whoever accepted it.
export function write(root: string, req: WriteRequest, opts: { acceptedBy?: string } = {}): WriteResult {
  const pre = loadRules(root);
  const status = pre.policy.agents[req.agent]?.status;
  if (!opts.acceptedBy && (status === "paused" || status === "read-only"))
    return { outcome: "refused", message: `${req.agent} is ${status} by ${ownerName(pre)}; no writes`, fails: [{ check: "agent_status", outcome: "refuse", reason: status, fix: `ask ${ownerName(pre)}` }] };
  const author = opts.acceptedBy ?? req.agent;
  const extraPaths: string[] = []; // files this write changed besides the note (the owner-message registry)
  let regUndo: { rel: string; was?: string; clean: boolean } | undefined;
  const original = req;
  const rules = loadRules(root);
  if (!rules.policy.agents[req.agent]) return { outcome: "refused", message: `unknown agent ${req.agent}` };
  // A JSON client may send null for an optional field it leaves out (strict function calling
  // does): the same as leaving it out, so a null never turns a legitimate write into a refusal
  // (eval gap G23). `value` keeps its null.
  req = Object.fromEntries(Object.entries(req).filter(([k, v]) => v !== null || k === "value")) as unknown as WriteRequest;
  const shape = shapeFails(req);
  if (shape.length) {
    logWrite(root, { at: new Date().toISOString(), agent: req.agent, kind: "fact", outcome: "refused", checks: ["schema"] });
    return { outcome: "refused", message: shape.map((f) => `${f.check}: ${f.reason}. Fix: ${f.fix}`).join("\n"), fails: shape };
  }
  req = { ...req, sources: (req.sources ?? []).map((s) => (typeof s === "string" ? normalizeRef(s) : { ...s, ref: normalizeRef(s.ref) })) };
  if (req.source_type === "agent_observation") req.verification = "self-reported";
  const enabled = new Set(rules.checks.checks ?? []);
  const thirdParty = thirdPartySensitive(req);
  // Someone else's health, school, legal or money detail: kept, but private and shared only
  // with the resolver (Louis always sees everything). Forced here, so no agent can opt out.
  if (thirdParty) req = { ...req, sensitivity: sensitivityRank(req.sensitivity ?? "public") > sensitivityRank("private") ? req.sensitivity : "private", share_with: rules.policy.resolver ? [rules.policy.resolver] : [] };
  const fails = runChecks(req, enabled, ownerName(rules));
  const refusals = fails.filter((f) => f.outcome === "refuse");
  const editor = rules.policy.owner_editor === req.agent;
  const done = (r: WriteResult) => {
    // A relayed owner id whose registry commit didn't go through is taken out again unless this
    // write was saved: left on disk it would count as the owner's word with nothing recorded.
    if (regUndo && r.outcome !== "committed" && r.outcome !== "disputed") {
      const f = join(root, regUndo.rel);
      if (regUndo.was === undefined) rmSync(f, { force: true }); else writeFileSync(f, regUndo.was);
      if (regUndo.clean) git(root, ["reset", "-q", "--", regUndo.rel]);
    }
    logWrite(root, { at: new Date().toISOString(), agent: req.agent, kind: req.kind ?? "fact", key: r.fact_key ?? req.id, outcome: r.outcome, step: r.step, checks: (r.fails ?? []).map((f) => f.check), ...(editor ? { as: "owner_editor" } : {}) });
    return r;
  };
  if (refusals.length) {
    return done({ outcome: "refused", message: refusals.map((f) => `${f.check}: ${f.reason}. Fix: ${f.fix}`).join("\n"), fails: refusals });
  }
  // On a replica, everything past the plain checks needs the hub's copy: queue it as an op.
  if (!opts.acceptedBy) { const q = queueIfReplica(root, original); if (q) return done(q); }
  const notes = loadBrain(root);
  // A value already stored in this fact (and visible to the writer) can't add an instruction that
  // isn't there: replaying it doesn't go back to the owner for its wording (eval gap G12). Its
  // title, text and refs are still checked.
  const stored = () => {
    const n = req.id && req.attribute ? notes.find((x) => x.fm.id === req.id) : undefined;
    const f = n?.fm.facts?.[req.attribute!];
    if (!f) return false;
    if (!rules.policy.agents[req.agent]?.inside_wall) {
      const res = carve(notes, rules, grantFor(rules, req.agent));
      if (!res.visible.has(n!.fm.id) || res.hiddenFacts.some((h) => h.key === `${n!.fm.id}#${req.attribute}`)) return false;
    }
    return records(f).some((r) => !r.valid_to && compareKey(r.value) === compareKey(req.value));
  };
  const rest = () => !findInjection(`${req.text ?? ""}\n${req.title ?? ""}\n${(req.sources ?? []).map(refString).join("\n")}`);
  const toInbox = fails.filter((f) => f.outcome === "inbox" && !(f.check === "injection_shapes" && rest() && stored()));
  if (toInbox.length) return done(propose(root, req, toInbox.map((f) => `${f.check}: ${f.reason}`).join("; "), toInbox));

  // Leak tripwire.
  const raw = `${typeof req.value === "string" ? req.value : JSON.stringify(req.value ?? "")} ${req.text ?? ""} ${req.title ?? ""}`;
  const text = unhide(raw).toLowerCase();
  const own = carve(notes, rules, grantFor(rules, req.agent), { flags: false });
  // The attribute name and the source refs land in other agents' views too (eval gap G22).
  // Not lower-cased: findCarried decodes base64 first and folds case itself, as the relay does (G113).
  const carried = unhide(`${raw} ${req.attribute ?? ""} ${(req.sources ?? []).map(refString).join(" ")}`);
  const common = shownWords(own);
  // A canary (src/canary.ts) the writer's carve doesn't show, in any field: a leak, whatever its level.
  // The agent sees an ordinary leak refusal; only the owner's alert says it was a canary.
  const canary = canaryHits(root, unhide(JSON.stringify(req)), new Set(own.visible.keys()))[0];
  if (canary) {
    const r = done({ outcome: "refused", alert: true, message: `leak_tripwire: the write contains a value ${req.agent} was never shown. ${ownerName(rules).replace(/^the/, "The")} is alerted.`, fails: [{ check: "leak_tripwire", outcome: "refuse", reason: "a value this agent was never shown", fix: "don't relay carved-out facts" }] });
    alert(root, { agent: req.agent, check: "canary", from: canary.id });
    return r;
  }
  const needles = [...carvedValues(notes, rules, req.agent, own)].map(([v, from]) => needleFor(v, from, common)).filter((n): n is Needle => !!n);
  const hit = findCarried(carried, needles);
  if (hit) {
    const from = hit.from;
    // Which hidden note and fact matched goes to the owner's alert only: naming it to the writer
    // would confirm where a guessed value lives (eval gap G165).
    const r = done({ outcome: "refused", alert: true, message: `leak_tripwire: the write contains a value ${req.agent} was never shown. ${ownerName(rules).replace(/^the/, "The")} is alerted.`, fails: [{ check: "leak_tripwire", outcome: "refuse", reason: "a value this agent was never shown", fix: "don't relay carved-out facts" }] });
    alert(root, { agent: req.agent, check: "leak_tripwire", from });
    return r;
  }
  // A title is every reader's to see and the id is built from it, so a title carrying any value
  // carved from the writer (hidden by attribute, name or slice too, not only flagged facts) is a
  // leak: refused, and a guess can't be read back as "[withheld]" (slice audit of G56).
  if (req.title && !rules.policy.agents[req.agent]?.inside_wall) {
    const t = unhide(req.title);
    if (withholdName(t, own.carvedValues, nameNeedles(own)) !== t) {
      const r = done({ outcome: "refused", alert: true, message: `leak_tripwire: the title contains a value ${req.agent} was never shown. ${ownerName(rules).replace(/^the/, "The")} is alerted.`, fails: [{ check: "leak_tripwire", outcome: "refuse", reason: "title", fix: "don't relay carved-out facts" }] });
      alert(root, { agent: req.agent, check: "leak_tripwire", from: `title of a ${req.type ?? "note"} write` });
      return r;
    }
  }
  // A value holding a word the writer's reads show only as [withheld] (a fact carved by name,
  // attribute or slice inside a note it sees; the value wire above covers private and do-not-share
  // ones). Writing it back means the agent knows the word: the same matcher as the title wire and
  // the same refusal, so a guess at the hidden part is never confirmed by replaced_value, dated, or
  // merged as the same value (G188).
  if (!rules.policy.agents[req.agent]?.inside_wall && scalarStrings(req.value).some((v) => { const u = unhide(v); return withholdName(u, own.carvedValues, nameNeedles(own)) !== u; })) {
    const r = done({ outcome: "refused", alert: true, message: `leak_tripwire: the write contains a value ${req.agent} was never shown. ${ownerName(rules).replace(/^the/, "The")} is alerted.`, fails: [{ check: "leak_tripwire", outcome: "refuse", reason: "a value this agent was never shown", fix: "don't relay carved-out facts" }] });
    alert(root, { agent: req.agent, check: "leak_tripwire", from: "a withheld part of a value" });
    return r;
  }


  // Withheld categories: an agent that isn't given a type (money) writing its words (TFSA,
  // salary) goes to Louis instead of the brain. Words can be innocent, so this diverts, not refuses.
  if (!opts.acceptedBy) {
    const hit = withheldWord(rules, req.agent, text);
    if (hit) {
      const [t, w] = hit.split(": ");
      alert(root, { agent: req.agent, check: "withheld_category", from: hit });
      const fail: CheckFail = { check: "withheld_category", outcome: "inbox", reason: `mentions "${w}"; ${t} isn't shared with ${req.agent}`, fix: "The owner decides" };
      return done({ ...propose(root, req, `${fail.check}: ${fail.reason}`, [fail]), alert: true });
    }
  }

  if ((req.kind ?? "fact") === "journal") return done(writeJournal(root, req));

  const tier = tierOf(rules, req.agent);

  // Resolve the entity. A note the writer can't see is treated as missing, so a write can't
  // be used to probe what exists outside its carve.
  const seesAll = !!(opts.acceptedBy || rules.policy.agents[req.agent]?.inside_wall);
  const writerCarve = seesAll ? undefined : own;
  const visibleToWriter = writerCarve?.visible;
  const writerSees = (id: string) => seesAll || visibleToWriter!.has(id);
  let note = req.id && writerSees(req.id) ? notes.find((n) => n.fm.id === req.id) : undefined;
  if (!note && !req.id) {
    // Matching by title only looks at notes the writer can see, so the reply never names others.
    // It matches the names the writer is shown (carve copies, carved values [withheld]), so a guess
    // at a withheld word in a title can't be confirmed by landing on the existing note.
    const shown = writerCarve ? [...writerCarve.visible.values()].map((v) => v.note) : notes;
    const r = resolveEntity(shown, req.type!, req.title!);
    if (r.ambiguous) return done(propose(root, req, `new or same as ${r.ambiguous.join(" / ")}?`, []));
    if (r.id && writerSees(r.id)) note = notes.find((n) => n.fm.id === r.id);
  }
  if (!note && req.id && !req.title) return done({ outcome: "refused", message: `no note ${req.id}; give title, type and area to create it` });
  // An agent putting back a value the brain already replaced or forgot, on nothing but its own
  // word, is answering from a stale memory (docs/memory-sync.md): refused with that reason, so it
  // doesn't become a dispute the owner settles. A checkable source makes it a real change.
  if (note && req.attribute && !req.retract && !opts.acceptedBy && !editor && (req.sources ?? []).length
    && (req.sources ?? []).every((x) => AGENT_MEMORY_SCHEMES.has(schemeOf(refString(x)) ?? ""))) {
    const key = compareKey(req.value);
    const f = note.fm.facts?.[req.attribute];
    const live = f ? records(f).filter((r) => !r.retired && !r.valid_to).map((r) => compareKey(r.value)) : [];
    const hist = note.fm.history?.[req.attribute] ?? [];
    const gone = hist.find((r) => compareKey(r.value) === key && (r.ended_by || r.retired));
    // Only for a fact the writer may see, now and before, under memsync's fact-level rules:
    // otherwise the refusal would confirm and date a guessed value of a hidden fact.
    const v = writerCarve?.visible.get(note.fm.id);
    const hidden = !seesAll && (!v || !!factHiddenReason(v, req.attribute, { items: [...(f ? records(f) : []), ...hist] }, writerCarve!.grant, rules));
    if (gone && !live.includes(key) && !hidden) {
      const when = gone.ended_by?.at ?? gone.retired?.at ?? "earlier";
      const fail: CheckFail = { check: "replaced_value", outcome: "refuse", reason: `the brain replaced this value on ${when}; your own memory is stale`, fix: "read the note (or call memory_check) and keep a pointer, not this value; cite a checkable source if it really changed back" };
      return done({ outcome: "refused", message: `${fail.check}: ${fail.reason}. Fix: ${fail.fix}`, fails: [fail] });
    }
  }

  const area = note?.fm.area ?? req.area;
  if (!area) return done({ outcome: "refused", message: "new entity needs an area" });
  // A co-owner's assistant in the co-owner's own areas (docs/household.md) writes there like the
  // area owner; anywhere else it is refused, never proposed: it has no say outside them. That
  // includes asking to move a note out of them (G149), checked before the owner's area-change step.
  const co = coOwnerOf(rules, req.agent);
  const coRefuse = (a: string) => done({ outcome: "refused", message: `co_owner_area: ${req.agent} writes only in ${co!.areas.join(", ")}`, fails: [{ check: "co_owner_area", outcome: "refuse", reason: `area ${a}`, fix: `write in ${co!.areas.join(", ")}` }] });
  if (co && req.area && !co.areas.includes(req.area)) return coRefuse(req.area);
  if (note && req.area && req.area !== note.fm.area)
    return done(propose(root, req, `area change ${note.fm.area} -> ${req.area} needs the owner (area_change_needs_louis)`, []));
  const owner = rules.policy.areas[area]?.owner ?? (area === req.agent ? req.agent : undefined);
  const coHere = !!co && co.areas.includes(area);
  if (co && !coHere) return coRefuse(area);
  // Louis's editor writes where he would: no trial or area-owner routing (the checks above still ran).
  if (!opts.acceptedBy && !editor && tier.writes === "propose") {
    // A trial proposal that claims the owner's word says so, so the owner sees the claim before
    // accepting (accepting registers the cited id as theirs).
    const claimed = (req.sources ?? []).map(refString).filter(isExactLouisRef);
    const reg = claimed.length ? louisMessages(root) : new Set<string>();
    const unknown = claimed.filter((r) => !reg.has(r));
    if (unknown.length || (isOwnerConfirmed(normVerification(req.verification)) && !claimed.length)) {
      const fail: CheckFail = { check: "owner_message_registered", outcome: "inbox", reason: `cites ${unknown.join(", ") || "no message"} as the owner's word, not in the owner's registry`, fix: "The owner accepts it from the inbox, which registers the id" };
      return done(propose(root, req, `${req.agent} is a trial agent: propose-only; ${fail.check}: ${fail.reason}`, [fail]));
    }
    return done(propose(root, req, `${req.agent} is a trial agent: propose-only`, []));
  }
  // "The owner told me" from a co-owner's assistant in her areas is the co-owner's word.
  // Not when the owner accepts it from the inbox: that is his word, and he has read it.
  const coWord = coHere && !opts.acceptedBy && isOwnerConfirmed(normVerification(req.verification));
  if (!opts.acceptedBy && !editor && !coHere && owner !== req.agent) return done(propose(root, req, `area ${area} is owned by ${owner ?? "nobody"} (own_area)`, []));

  const d = today();
  if (!note) {
    const type = req.type!;
    const folder = folderFor(type, req.agent);
    const slug = safeSlug(notes, rules, req.title!, writerCarve);
    let id = `${folder}/${slug}`;
    let n = 2;
    // A collision with a note the writer can't see gets a random suffix, so "-2" never tells
    // it that a hidden note with that name exists.
    if (notes.some((x) => x.fm.id === id && !writerSees(x.fm.id))) id = `${id}-${sha256(id + Date.now() + Math.random()).slice(0, 6)}`;
    while (notes.some((x) => x.fm.id === id)) id = `${folder}/${slug}-${n++}`;
    const fm: Frontmatter = {
      id, type, title: req.title!, area,
      sensitivity: rules.checks.types?.[type]?.sensitivity ?? "personal",
      status: "active", created: d, updated: d, by: req.agent, sources: req.sources,
    };
    note = { fm, body: "", path: id + ".md" };
  }

  const attr = req.attribute!;
  const factKey = `${note.fm.id}#${attr}`;
  // A fact the writer's carve hides (share_with, per-fact sensitivity, attribute carve) is never
  // changed by it: no supersede, no merge, no dispute. A retire answers like a missing fact, and
  // any other write waits for the owner with one fixed reply, so the outcome never says whether
  // the value matched, was older or was owner-confirmed (bug hunt A1, eval gap G55).
  // A fact the writer itself shared away (share_with set by its own write, `shared_by`) is still its
  // own: when every live record is the writer's and none is owner-confirmed, the write goes on as
  // usual (invariant 4's flags stay sticky). A share_with the owner or another agent set, or the
  // owner's word on the value, keeps it out of reach (rebase audit of G55).
  const hiddenWhy = writerCarve && note.fm.facts?.[attr] !== undefined ? writerCarve.hiddenFacts.find((h) => h.key === factKey)?.reason : undefined;
  const ownOnly = !!hiddenWhy?.startsWith("do not share") && records(note.fm.facts![attr]).every((r) => r.by === req.agent && r.shared_by === req.agent && !isOwnerConfirmed(r.verification) && !(r.sources ?? []).some((s) => OWNER_REF.test(refString(s))));
  if (hiddenWhy && !ownOnly) {
    if (req.retract) return done({ outcome: "refused", fact_key: factKey, message: "nothing live to retract" });
    return done(propose(root, req, `the owner decides ${factKey} (not_in_your_view)`, []));
  }
  const spec = attributeSpec(rules, note.fm.type, attr);
  const value = normalizeValue(req.value, spec);
  if (req.sensitivity && sensitivityRank(req.sensitivity) < sensitivityRank(note.fm.sensitivity))
    return done({ outcome: "refused", fact_key: `${note.fm.id}#${req.attribute}`, message: `sensitivity_only_raises: the file is ${note.fm.sensitivity}; a fact can be raised above it, never lowered`, fails: [{ check: "sensitivity_only_raises", outcome: "refuse", reason: "lowering", fix: "only the owner lowers a level, by editing the file" }] });
  const incoming: FactRecord = {
    value,
    ...(req.sensitivity && req.sensitivity !== note.fm.sensitivity ? { sensitivity: req.sensitivity } : {}),
    ...(req.share_with ? { share_with: req.share_with, ...(thirdParty ? {} : { shared_by: req.agent }) } : {}),
    as_of: req.as_of!,
    ...(req.as_of_approx ? { as_of_approx: true } : {}),
    // A co-owner's word is recorded as her assistant's, never as an owner ref: other code reads
    // owner refs as the owner's own word.
    sources: coWord ? [...req.sources!.filter((x) => !isExactLouisRef(refString(x))).filter((x) => refString(x) !== `agent:${req.agent}`), `agent:${req.agent}`] : req.sources!,
    ...(coWord
      ? { verification: "confirmed-by-co-owner" as const, co_owner: co!.id }
      : { verification: normVerification(req.verification) ?? "self-reported" }),
    ...(req.confidence === "inferred" ? { confidence: "inferred" as const } : {}),
    by: req.agent,
    recorded: d,
  };
  const facts = (note.fm.facts ??= {});
  const live = facts[attr];
  const hist = (note.fm.history ??= {});
  // Flags are sticky: once a fact is marked sensitive or do-not-share, an agent's write
  // can tighten that but never loosen it. Only Louis loosens, by editing the file.
  const liveRecs = live ? records(live) : [];
  const stickySens = liveRecs.map((r) => r.sensitivity).filter(Boolean).sort((a, b) => sensitivityRank(b) - sensitivityRank(a))[0];
  const stickyShare = liveRecs.map((r) => r.share_with).filter((l): l is string[] => !!l).reduce<string[] | undefined>((a, l) => (a ? a.filter((x) => l.includes(x)) : l), undefined);
  if (stickySens && sensitivityRank(stickySens) > sensitivityRank(incoming.sensitivity ?? note.fm.sensitivity)) incoming.sensitivity = stickySens;
  if (stickyShare) incoming.share_with = incoming.share_with ? incoming.share_with.filter((a) => stickyShare.includes(a)) : stickyShare;
  if (stickyShare && !req.share_with) {
    const by = liveRecs.find((r) => r.share_with)?.shared_by;
    if (by) incoming.shared_by = by; else delete incoming.shared_by;
  }
  if (liveRecs.length && (req.sensitivity || req.share_with)) {
    let tightened = false;
    for (const r of liveRecs) {
      if (incoming.sensitivity && sensitivityRank(incoming.sensitivity) > sensitivityRank(r.sensitivity ?? note.fm.sensitivity)) { r.sensitivity = incoming.sensitivity; tightened = true; }
      if (incoming.share_with && JSON.stringify(r.share_with) !== JSON.stringify(incoming.share_with)) { r.share_with = incoming.share_with; if (incoming.shared_by) r.shared_by = incoming.shared_by; else delete r.shared_by; tightened = true; }
    }
    if (tightened && liveRecs.some((r) => compareKey(r.value) === compareKey(value))) {
      note.fm.updated = d;
      saveNote(root, note);
      const unsaved = commitPaths(root, [note.fm.id + ".md"], `${req.agent}: ${factKey} flagged ${incoming.sensitivity ?? ""}${incoming.share_with ? ` share_with ${incoming.share_with.join(",")}` : ""}`, author);
      if (unsaved) return done(notSaved(unsaved));
      return done({ outcome: "committed", fact_key: factKey, message: `flag tightened: ${incoming.sensitivity ?? note.fm.sensitivity}${incoming.share_with ? `, only ${incoming.share_with.join(", ")}` : ""}` });
    }
  }
  const hash = writeHash(factKey, value, incoming.as_of, incoming.sources);
  // A retired record (sleep.ts) doesn't make a re-assert a no-op: saying it again revives it.
  const seen = [...(live ? records(live) : []), ...(hist[attr] ?? []).filter((r) => !r.retired)].some((r) => writeHash(factKey, r.value, r.as_of, r.sources) === hash);
  if (seen) return done({ outcome: "noop", fact_key: factKey, message: "same write already recorded (write_hash)" });

  // Louis's word must be his: a cited Louis message id has to be in his registry (G1), or
  // the write waits for him. Replays of what is already stored stopped above as no-ops.
  if (!opts.acceptedBy && !coWord) {
    const reg = louisMessages(root);
    const claimed = incoming.sources.map(refString).filter(isExactLouisRef);
    let unknown = claimed.filter((r) => !reg.has(r));
    // The agent that reads Louis's texts records them as it goes, below private; each new id
    // is listed in the digest so a forged one is visible.
    const channel = rules.policy.owner_channel ?? rules.policy.louis_channel ?? rules.policy.resolver;
    // A reader token never does (G18): its citations wait for the owner like any agent's.
    if (unknown.length && req.agent === channel && tokenRole(req.agent) !== "reader" && sensitivityRank(incoming.sensitivity ?? note.fm.sensitivity) < sensitivityRank("private")) {
      // If the registry's own commit didn't go through, it rides with the note's commit, so a
      // failed write puts it back too: an id left registered would count as the owner's word.
      const regRel = ownerMessagesPath(root), regClean = !gitDirty(root, regRel);
      const regWas = existsSync(join(root, regRel)) ? readFileSync(join(root, regRel), "utf8") : undefined;
      registerLouisMessages(root, unknown, `relayed by ${req.agent} for ${factKey}`, `${req.agent}-for-louis`);
      if (gitDirty(root, regRel) && (!regClean || regWas !== readFileSync(join(root, regRel), "utf8"))) {
        regUndo = { rel: regRel, was: regWas, clean: regClean };
        if (regClean) extraPaths.push(regRel);
      }
      unknown = [];
    }
    if (unknown.length || (isOwnerConfirmed(incoming.verification) && !claimed.length)) {
      const fail: CheckFail = { check: "owner_message_registered", outcome: "inbox", reason: `cites ${unknown.join(", ") || "no message"} as the owner's word, not in the owner's registry`, fix: "The owner accepts it from the inbox, which registers the id" };
      return done(propose(root, req, `${fail.check}: ${fail.reason}`, [fail]));
    }
  }

  // Where a connector checks sources, a ref it found missing is refused, and a ref it hasn't
  // checked yet can't change an existing fact until it has (G2). New facts go in either way.
  const checked = checkedRefs(root);
  if (checked && !opts.acceptedBy) {
    const exact = incoming.sources.map(refString).filter((r) => /^(gmail|gmail-thread|gcal):/.test(r));
    const missing = exact.filter((r) => checked.get(r) === false);
    if (missing.length) return done({ outcome: "refused", fact_key: factKey, message: `source_exists: ${missing.join(", ")} not found by the connector`, fails: [{ check: "source_exists", outcome: "refuse", reason: missing.join(", "), fix: "cite a message that exists" }] });
    const unchecked = exact.filter((r) => !checked.has(r));
    if (live && unchecked.length && incoming.verification === "verified-by-source") {
      const fail: CheckFail = { check: "source_exists", outcome: "inbox", reason: `${unchecked.join(", ")} not checked yet`, fix: "upkeep --live checks it; the owner can accept meanwhile" };
      return done(propose(root, req, `${fail.check}: ${fail.reason}`, [fail]));
    }
  }

  // The owner's word, or a co-owner's in the co-owner's own areas (docs/household.md): both rank
  // as the owner's. A co-owner label anywhere else, or on a record its agent didn't write, is
  // worth no more than its sources.
  const ownerWord = (r: FactRecord) => isOwnerWord(rules, note!.fm.area, r);
  const rank = (r: FactRecord) => ownerWord(r) ? 5 : r.verification === "confirmed-by-co-owner" ? Math.min(sourceRank(r), 2) : sourceRank(r);
  const merge = spec.merge ?? "replace";
  let step: number | undefined;
  let msg = "";
  let disputed = false;

  const mergeSources = (r: FactRecord) => {
    const have = new Set(r.sources.map(sourceKey));
    const added = incoming.sources.filter((s) => !have.has(sourceKey(s)));
    r.sources.push(...added);
    // Another writer's evidence in it: the sharing agent no longer holds this record alone (G55).
    if (r.by !== req.agent) delete r.shared_by;
    r.last_confirmed = d;
    if (incoming.as_of < r.as_of && !incoming.as_of_approx) r.as_of = incoming.as_of;
    // The owner's own word on the same value a co-owner set takes the record over (G148), so it
    // stays the owner's word after the note leaves her areas or she stops being a co-owner. Not a
    // vaguer value (step 3): the owner never said her more precise one.
    if (rank(incoming) > rank(r) || (r.co_owner && !incoming.co_owner && ownerWord(incoming) && compareKey(r.value) === compareKey(incoming.value))) {
      r.verification = incoming.verification;
      if (incoming.co_owner) { r.co_owner = incoming.co_owner; r.confirmed_by = incoming.by; } else { delete r.co_owner; delete r.confirmed_by; }
    }
    return added.length;
  };

  if (req.retract) {
    if (!live || isDisputed(live)) return done({ outcome: "refused", fact_key: factKey, message: "nothing live to retract" });
    // An owner's word (or a co-owner's in her area) is taken back only by an owner's word; anyone
    // else's retract waits for the owner, as a value change would open a dispute (step 6).
    const target = isList(live) ? live.items.find((i) => compareKey(i.value) === compareKey(value) && !i.valid_to) : live as FactRecord;
    if (target && ownerWord(target) && !ownerWord(incoming)) {
      const fail: CheckFail = { check: "owner_word_retract", outcome: "inbox", reason: `${factKey} is the owner's word; only the owner takes it back`, fix: "The owner decides from the inbox" };
      return done(propose(root, req, `${fail.check}: ${fail.reason}`, [fail]));
    }
    if (isList(live)) {
      const it = live.items.find((i) => compareKey(i.value) === compareKey(value) && !i.valid_to);
      if (!it) return done({ outcome: "noop", fact_key: factKey, message: "item not present" });
      it.valid_to = incoming.as_of;
      it.ended_by = { step: 0, at: d, by: req.agent, sources: incoming.sources };
    } else {
      (hist[attr] ??= []).push({ ...(live as FactRecord), valid_to: incoming.as_of, ended_by: { step: 0, at: d, by: req.agent, sources: incoming.sources } });
      delete facts[attr];
    }
    msg = "retracted";
  } else if (!live) {
    facts[attr] = merge === "set" || merge === "append" ? { items: [incoming] } : incoming;
    msg = "new fact";
  } else if (isDisputed(live)) {
    const same = live.candidates.find((c) => compareKey(c.value) === compareKey(value));
    if (same) mergeSources(same); else live.candidates.push(incoming);
    disputed = true;
    msg = `added to open dispute ${live.dispute}`;
  } else if (isList(live)) {
    const keyOf = (v: unknown) => spec.item_key && v && typeof v === "object" ? String((v as Record<string, unknown>)[spec.item_key]) : compareKey(v);
    const match = live.items.find((i) => keyOf(i.value) === keyOf(value) && !i.valid_to);
    if (match && merge !== "append") {
      if (compareKey(match.value) === compareKey(value)) {
        if (!mergeSources(match)) return done({ outcome: "noop", fact_key: factKey, message: "item already recorded" });
        step = 1; msg = "same item, sources merged";
      } else {
        // same item key, different content (e.g. session 6 moved to two different dates)
        // Both items stay in the list, marked with the same dispute id.
        const id = openDispute(root, note, attr, [match, incoming], 7);
        (match as FactRecord & { dispute?: string }).dispute = id;
        live.items.push({ ...incoming, dispute: id } as FactRecord);
        disputed = true; step = 7; msg = `item ${keyOf(value)} disputed (${id})`;
      }
    } else {
      live.items.push(incoming); step = 2; msg = "item added (set)";
    }
  } else {
    const cur = live as FactRecord;
    // The owner's word comes first in the conflict order (G163): an assistant's value never
    // replaces a live owner-confirmed one, not even as a more precise date or a max/min value.
    // It goes to the owner as a step 6 dispute, like the contradiction below.
    const overOwner = ownerWord(cur) && !ownerWord(incoming);
    const ownerDispute = () => {
      const id = openDispute(root, note, attr, [cur, incoming], 6);
      facts[attr] = { dispute: id, candidates: [cur, incoming] }; disputed = true; step = 6;
      msg = `contradicts a fact the owner confirmed: disputed (${id})`;
    };
    if (compareKey(cur.value) === compareKey(value)) {
      mergeSources(cur); step = 1; msg = "same value: sources merged, last_confirmed bumped";
    } else if (merge === "max" || merge === "min") {
      const newer = merge === "max" ? String(value) > String(cur.value) : String(value) < String(cur.value);
      if (!newer) return done({ outcome: "noop", fact_key: factKey, step: 2, message: `${merge}: older value ignored` });
      if (overOwner) ownerDispute();
      else {
        (hist[attr] ??= []).push({ ...cur, valid_to: incoming.as_of, ended_by: { step: 2, at: d, by: req.agent } });
        facts[attr] = incoming; step = 2; msg = `${merge}: newer value kept`;
      }
    } else {
      const a = String(cur.value), b = String(value);
      const rNew = rank(incoming), rOld = rank(cur);
      const supersede = (s: number, why: string) => {
        (hist[attr] ??= []).push({ ...cur, valid_to: incoming.as_of, ended_by: { step: s, at: d, by: req.agent } });
        facts[attr] = incoming; step = s; msg = why;
      };
      if (/^\d{4}/.test(a) && /^\d{4}/.test(b) && (a.startsWith(b) || b.startsWith(a))) {
        if (b.length > a.length) { if (overOwner) ownerDispute(); else supersede(3, "more precise value kept"); }
        else { mergeSources(cur); step = 3; msg = "vaguer value recorded as a source"; }
      } else if (overOwner) {
        ownerDispute();
      } else if (rNew < 1 && incoming.sources.length && incoming.sources.every((x) => refString(x).startsWith("agent-relay:"))) {
        // A value only relayed by another agent never replaces anything (architecture 0.7
        // rule 5): the live value stays and the claim waits in the inbox for evidence.
        return done(propose(root, req, "relayed_only: another agent's word can't replace a live fact; cite the original source", []));
      } else if (isOwnerId(opts.acceptedBy) && rNew >= rOld && incoming.as_of >= cur.as_of) {
        // The owner accepting a proposal is their latest word, even on the same day as the
        // value it replaces (a new brain's day-one facts), so it settles instead of disputing.
        supersede(4, "The owner accepted a newer value");
      } else if (incoming.as_of > cur.as_of && !incoming.as_of_approx && rNew >= rOld) {
        supersede(4, `real change over time: superseded value as of ${cur.as_of}`);
      } else if (rNew > rOld && (incoming.as_of >= cur.as_of || cur.as_of_approx)) {
        supersede(5, `stronger source (${rNew} > ${rOld})`);
      } else {
        const s = rNew < rOld && incoming.as_of > cur.as_of ? 6 : 7;
        const id = openDispute(root, note, attr, [cur, incoming], s);
        facts[attr] = { dispute: id, candidates: [cur, incoming] }; disputed = true; step = s;
        msg = `conflict (step ${s}): disputed (${id}); goes to the owner's digest`;
      }
    }
  }

  note.fm.updated = d;
  if (note.fm.history && Object.keys(note.fm.history).length === 0) delete note.fm.history;
  saveNote(root, note);
  const unsaved = commitPaths(root, [note.fm.id + ".md", ...(existsSync(join(root, "disputes")) ? ["disputes"] : []), ...extraPaths], `${req.agent}: ${factKey} (${msg})${opts.acceptedBy ? `, accepted by ${opts.acceptedBy}` : ""}`, author);
  if (unsaved) return done(notSaved(unsaved));
  return done({ outcome: disputed ? "disputed" : "committed", fact_key: factKey, step, message: msg, file: note.fm.id + ".md" });
}

function openDispute(root: string, note: Note, attr: string, candidates: FactRecord[], step: number): string {
  const id = nextDisputeId(root);
  const d = today();
  const packet: Note = {
    fm: {
      id: `disputes/${id}`, type: "dispute", title: `${note.fm.id}#${attr}`, area: note.fm.area,
      sensitivity: note.fm.sensitivity, status: "open", created: d, updated: d, by: "write-path",
      fact_key: `${note.fm.id}#${attr}`, step, candidates,
    } as Frontmatter,
    body: `Conflict on \`${note.fm.id}#${attr}\`, reached step ${step} of architecture 0.6.\n\n${candidates
      .map((c, i) => `${i + 1}. ${typeof c.value === "object" ? JSON.stringify(c.value) : c.value} (as of ${c.as_of}, ${c.verification}, by ${c.by}, ${c.sources.map(refString).join(", ")})`)
      .join("\n")}\n\nThe owner answers with the number; the reply becomes a confirmed-by-owner fact.\n`,
    path: "",
  };
  saveNote(root, packet);
  return id;
}

function writeJournal(root: string, req: WriteRequest): WriteResult {
  const d = today();
  const rel = `journal/${req.agent}/${d.slice(0, 7)}.md`;
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  const line = `- ${d}: ${(req.text ?? String(req.value ?? "")).replace(/\n+/g, " ")} (${(req.sources ?? []).map(refString).join(", ")})`;
  const existing = existsSync(file) ? readFileSync(file, "utf8") : `# ${req.agent} journal, ${d.slice(0, 7)}\n\n`;
  if (existing.includes(line)) return { outcome: "noop", message: "journal line already there" };
  writeFileSync(file, existing + line + "\n");
  const unsaved = commitPaths(root, [rel], `${req.agent}: journal`, req.agent);
  if (unsaved) return notSaved(unsaved);
  return { outcome: "committed", message: "journal line added", file: rel };
}

// Louis's answer to a proposal in inbox/: accept applies it through the write path,
// reject records the decision. Either way the proposal file moves to inbox/decided/.
// Answering a card answers its twins too (one card per fact): each one is decided as if the owner
// had answered it alone, through its own request and every write check, in the order they came in.
// `shown`: the twins the owner saw on the card. Only those are answered, and only while they are
// still that card's twins; one filed after the card was drawn waits for its own answer.
export function decideProposal(root: string, file: string, decision: "accept" | "reject", by = OWNER, shown: string[] = []): WriteResult {
  const name = file.split("/").pop()!;
  const now = new Set(inboxCards(root).find((c) => c.file === name)?.twins.map((t) => t.file) ?? []);
  const twins = [...new Set(shown.map((t) => t.split("/").pop()!))].filter((t) => now.has(t));
  const r = decideOne(root, file, decision, by);
  if (r.outcome === "refused" || !twins.length) return r;
  const more = twins.map((t) => decideOne(root, t, decision, by));
  const done = more.filter((x) => decision === "reject" ? x.outcome !== "refused" : ["committed", "disputed", "noop"].includes(x.outcome)).length;
  const waiting = more.filter((x) => x.outcome !== "refused" && !["committed", "disputed", "noop"].includes(x.outcome)).length;
  const left = more.filter((x) => x.outcome === "refused");
  return { ...r, message: `${r.message}; ${decision === "accept" ? "accepted" : "rejected"} ${done} more proposal(s) of the same value${decision === "accept" && waiting ? `, ${waiting} filed again for review` : ""}${left.length ? `, ${left.length} left in the inbox (refused: ${left.map((x) => x.message).join("; ")})` : ""}` };
}

function decideOne(root: string, file: string, decision: "accept" | "reject", by: string): WriteResult {
  const rel = file.startsWith("inbox/") ? file : `inbox/${file}`;
  const path = join(root, rel);
  if (!existsSync(path)) return { outcome: "refused", message: `no proposal ${rel}` };
  const p = YAML.parse(readFileSync(path, "utf8")) as { request: WriteRequest; decided?: string };
  // On a replica, Louis's answer is queued as a signed op; the hub applies it on the next sync.
  const q = queueOp(root, "inbox", by, { file: rel, decision }, `${decision} ${rel}`);
  if (q) return q;
  let r: WriteResult = { outcome: "noop", message: "rejected" };
  if (decision === "accept") {
    // Louis accepting is his word (G11): the accepted value carries his acceptance as a
    // source, so it settles instead of coming back to him as a dispute.
    const req = isOwnerId(by)
      ? { ...p.request, sources: [...(p.request.sources ?? []), ownerRef(today(), `inbox/${rel.split("/").pop()}`)], verification: OWNER_CONFIRMED as WriteRequest["verification"] }
      : p.request;
    r = write(root, req, { acceptedBy: by });
    if (r.outcome === "refused") return r;
    // Louis accepting is his word: the Louis message ids it cites become his.
    // Not a co-owner's assistant's: its "owner" refs are the co-owner's messages (docs/household.md).
    if (isOwnerId(by) && !coOwnerOf(loadRules(root), p.request.agent)) registerLouisMessages(root, (p.request.sources ?? []).map(refString).filter(isExactLouisRef), `accepted ${rel.split("/").pop()}`);
  }
  const destRel = `inbox/decided/${rel.split("/").pop()!}`;
  const dest = join(root, destRel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, YAML.stringify({ ...p, decided: today(), decision, by }, { lineWidth: 0 }));
  rmSync(path);
  // Only the proposal's two paths; if git can't record the answer, both go back (src/git.ts) and
  // the proposal waits to be answered again. An accepted fact is already committed above.
  const unsaved = commitPaths(root, [rel, destRel], `inbox: ${decision} ${rel.split("/").pop()}`, by);
  if (unsaved) return { ...notSaved(unsaved), message: `${decision === "accept" && r.outcome !== "noop" ? "the fact is saved, but " : ""}the answer wasn't recorded: the proposal is still in the inbox, answer it again (${unsaved})` };
  sweepQuotes(root); // the source's words go with the recorded decision (src/quotes.ts)
  return { ...r, message: `${decision}ed: ${r.message}` };
}

// The hub applies an inbox answer queued on a replica: a proposal (inbox/*.yaml) or a held
// capture (inbox/captures/*.md). Answered already on the hub (or elsewhere) is a no-op.
export function applyInboxOp(root: string, by: string, payload: Record<string, unknown>): WriteResult {
  const file = String(payload.file ?? "");
  const decision = String(payload.decision ?? "");
  if (!/^inbox\/(captures\/)?[A-Za-z0-9._-]+\.(ya?ml|md)$/.test(file)) return { outcome: "refused", message: `not an inbox item: ${file}` };
  if (!isOwnerId(by)) return { outcome: "refused", message: "only the owner answers inbox items" };
  if (file.startsWith("inbox/captures/")) {
    if (decision !== "release" && decision !== "discard") return { outcome: "refused", message: `a held capture takes release or discard, not ${decision}` };
    return decideCapture(root, file, decision);
  }
  if (decision !== "accept" && decision !== "reject") return { outcome: "refused", message: `a proposal takes accept or reject, not ${decision}` };
  if (!existsSync(join(root, file))) {
    const done = join(root, "inbox", "decided", file.split("/").pop()!);
    return existsSync(done) ? { outcome: "noop", message: `${file} was already answered` } : { outcome: "refused", message: `no proposal ${file}` };
  }
  return decideProposal(root, file, decision, by);
}
