// SPDX-License-Identifier: AGPL-3.0-only
// The one write function every writer goes through (architecture 0.6):
// resolve entity -> build fact_key -> run checks -> compare with the live value ->
// no-op, merge, supersede or dispute -> commit (or propose to inbox/).
import { sensitiveShape } from "./shape";
import { sha256, alert } from "./util";
import { clock } from "./clock";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import YAML from "yaml";
import type { Note, FactRecord, SourceRef, Frontmatter, Sensitivity } from "./brain";
import { loadBrain, parseNote, saveNote, isList, isDisputed, slugify, today, sensitivityRank } from "./brain";
import type { Rules } from "./rules";
import { loadRules, attributeSpec, tierOf, ownerName, captureAgentName } from "./rules";
import { runChecks, shapeFails, thirdPartySensitive, findInjection, speaksToReader, isPreference, TYPE_FOLDER, type WriteRequest, type CheckFail } from "./checks";
import { normalizeValue, compareKey } from "./normalize";
import { refString, normalizeRef, sourceRank, isExactLouisRef, schemeOf, isApprovedRef, AGENT_MEMORY_SCHEMES, asAgentWord } from "./sources";
import { louisMessages, registerLouisMessages, checkedRefs, ownerMessagesPath } from "./louis";
import { tokenRole } from "./tokenrole";
import { carve, grantFor, records, shownWords, withheldWord, visibleFacts, factHiddenReason, withholdName, nameNeedles, HELD_REASON, type CarveResult } from "./carve";
import { needleFor, findCarried, unhide, distinctive, squash, type Needle } from "./match";
import { git, commitPaths } from "./git";
import { appendChained } from "./readlog";
import { canaryHits } from "./canary";
import { proposalCap } from "./gardener";
import { evidenceFor } from "./evidence";
import { queueIfReplica, queueOp } from "./hub";
import { decideCapture } from "./capture";
import { coOwnerOf, isOwnerWord } from "./rules";
import { OWNER, OWNER_CONFIRMED, OWNER_REF, isOwnerConfirmed, isOwnerId, ownerRef, approvedRef, normVerification } from "./owner";
import { keepQuote, sweepQuotes } from "./quotes";
import { hubReadRefs } from "./pull";
import { appendDiary, diaryRow, shownValue, type DiaryKind } from "./diary";
import { captureSender, unknownSenderWait } from "./sender";

// Refs to an item the hub can read at its source (src/pull.ts fetchOne): checked, and ranked as
// exact only once read (G417, G441). A gmail-thread: ref is never read, so it never counts.
const HUB_READS = /^(gmail|gmail-thread|gcal|mail|imessage|granola|gdoc|discord|contacts):/;

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
// A person's name without what decorates it: "Dr. Jane Roy, PhD, M.Sc." is Jane Roy (owner's phone,
// 2026-10-25: a name with ", M.Sc." became a new note). Only named degrees and certifications go,
// and only after a name of two words or more: a generational suffix (Jr., Sr.), an initial or a
// given name tells two people apart (slice audits 2026-10-25: "John Smith, Jr." landed on "John
// Smith, Sr.", "Roy, J." on "Roy, K.", "Li, Ba" on "Li, Ma"). A degree that is also a given name
// (Ma, Ba, Med, Ing, Ca, Rn) goes only when dotted or in capitals ("Jane Roy, MA").
const CREDENTIALS = new Set(["msc", "bsc", "mba", "emba", "phd", "dphil", "mphil", "md", "dds", "jd", "llb", "llm", "eng", "peng",
  "cpa", "cfa", "cma", "cga", "cissp", "cism", "cisa", "crisc", "ccsp", "oscp", "pmp", "frcpc", "mfa", "msw"]);
const NAMELIKE = new Set(["ma", "ba", "med", "ing", "ca", "rn"]);
export const isCredential = (w: string) => {
  const k = w.toLowerCase().replace(/\./g, "");
  return CREDENTIALS.has(k) || (NAMELIKE.has(k) && (w.includes(".") || w === w.toUpperCase()));
};
// A title before a name; a person's key leaves it out. "M." is left in: it can be an initial
// ("M. Dupont" may be Marc Dupont), so it keeps two names apart (slice audit 2026-10-25).
export const HONORIFIC = /^(dr|mr|mrs|ms|mx|mme|mlle|prof|monsieur|madame|mademoiselle|miss)\.?\s+/i;
// Titles of a kind, "M." (the French "Mr", with its dot) among them: two titled names match when
// their titles are of the same kind and the rest is the same name ("M. Lake" is "Mr Lake", never
// "Mme Lake"; owner's phone, 2026-10-31; G547).
const TITLED = /^(mr|mrs|ms|mme|mlle|monsieur|madame|mademoiselle|miss|m(?=\.))\.?\s+/i;
const TITLE_KIND: Record<string, "m" | "f"> = { mr: "m", m: "m", monsieur: "m", mrs: "f", ms: "f", mme: "f", mlle: "f", madame: "f", mademoiselle: "f", miss: "f" };
export const titleKind = (name: unknown): "m" | "f" | undefined => typeof name === "string" ? TITLE_KIND[TITLED.exec(name.trim())?.[1]?.toLowerCase() ?? ""] : undefined;
// The name after its title, as a key: "M. Lake" and "Monsieur Lake" are both "lake".
export const untitledKey = (name: unknown): string => typeof name === "string" ? personKey(name.trim().replace(TITLED, "")) : personKey(name);
// Two names that each carry a title of the same kind, the rest the same. A titled full name
// ("M. Robin Lake") is that name untitled too; a titled surname alone is not ("M. Dupont" isn't "Dupont").
export const sameTitled = (a: unknown, b: unknown): boolean => !!titleKind(a) && titleKind(a) === titleKind(b) && untitledKey(a) === untitledKey(b);
// The person pages naming someone with this surname by a full name ("Alain Lake" for "lake").
export const sharingSurname = (notes: Note[], surname: string): Note[] => notes.filter((n) => n.fm.type === "person" && !["archived", "merged", "superseded"].includes(String(n.fm.status)) && [n.fm.title, ...(n.fm.aliases ?? [])].some((t) => { const w = untitledKey(t).split(" "); return w.length >= 2 && w.at(-1) === surname; }));
export function stripCredentials(name: string): string {
  const parts = name.split(",").map((x) => x.trim());
  const words = (n: number) => parts.slice(0, n).join(" ").split(/\s+/).filter(Boolean).length;
  let keep = parts.length;
  while (keep > 1 && words(keep - 1) >= 2 && parts[keep - 1].split(/\s+/).every(isCredential)) keep--;
  return parts.slice(0, keep).join(", ");
}
export function personKey(name: unknown): string {
  if (typeof name !== "string") return compareKey(name);
  return compareKey(stripCredentials(name).replace(HONORIFIC, ""));
}

export function resolveEntity(notes: Note[], type: string, title: string): { id?: string; ambiguous?: string[] } {
  const same = notes.filter((n) => n.fm.type === type);
  const k = type === "person" ? personKey : compareKey;
  const key = k(title);
  const kind = type === "person" ? titleKind(title) : undefined;
  // A titled surname alone ("Monsieur Lake") is another title's page ("M. Lake") only while no
  // other page names someone with that surname: the owner's "M. Lake" is not their father's
  // "Monsieur Lake" (builder's slice audit of b532242). Written exactly as the page's name, it is.
  const lone = !!kind && !untitledKey(title).includes(" ");
  const kin = lone ? sharingSurname(same, untitledKey(title)) : [];
  const exact = same.filter((n) => [n.fm.title, ...(n.fm.aliases ?? [])].some((t) => (k(t) === key && !(kind && titleKind(t) && titleKind(t) !== kind))
    || (!!kind && sameTitled(title, t) && (!lone || kin.every((x) => x === n)))
    || (!!kind && !lone && !titleKind(t) && k(t) === untitledKey(title))));
  if (exact.length === 1) return { id: exact[0].fm.id };
  if (exact.length > 1) return { ambiguous: exact.map((n) => n.fm.id) };
  const tokens = key.split(" ");
  const near = same.filter((n) => {
    const t = k(n.fm.title).split(" ");
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
// Each note's type by id, built once per notes array: a lookup per inbox card was a scan of the brain.
const typeIndex = new WeakMap<Note[], Map<string, string>>();
function typesOf(notes: Note[]): Map<string, string> {
  let m = typeIndex.get(notes);
  if (!m) { typeIndex.set(notes, (m = new Map())); for (const n of notes) if (!m.has(n.fm.id)) m.set(n.fm.id, n.fm.type); } // the first, as find() gave
  return m;
}
function sameFactKey(root: string, r: Partial<WriteRequest>, notes: Note[], rules: Rules): string | undefined {
  if ((r.kind ?? "fact") !== "fact" || r.retract || typeof r.attribute !== "string" || r.value === undefined) return undefined;
  // The note's own type when it names one: a type the agent sets is ignored by write() there.
  const type = r.id ? typesOf(notes).get(r.id) : r.type;
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
  // Read only, so the shared parse cache: a full copy of 10k notes took seconds per page (#295).
  const notes = loadBrain(root, { shared: true }), rules = loadRules(root);
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
  writeFileSync(file, YAML.stringify({ proposed: d, by: req.agent, reason, checks: fails.map((f) => f.check), evidence: evidenceFor(root, req, loadBrain(root, { shared: true })), request: req }, { lineWidth: 0 }));
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
// `contest`: a contradiction is a conflict, never a replacement (a capture filed for the owner
// under file: all; the owner settles it on the settle screen, docs/owner-home.md "Settle"); its packet is marked
// `gardener_first`, so it waits for the Gardener's pass before it asks the owner.
// The owner's own word from their text box (src/owner-say.ts, phone UI spec §4): `owner: true` with
// agent OWNER, in-process only (no door passes it; an agent's identity comes from its token). The
// owner writes as a core writer who sees everything, saved as their own (acceptedBy OWNER), through
// every check and the same conflict order.
const OWNER_AS_WRITER = { tier: "core", slices: ["all"], inside_wall: true, max_sensitivity: "private" } as const;
const withOwner = (r: Rules): Rules => ({ ...r, policy: { ...r.policy, agents: { ...r.policy.agents, [OWNER]: OWNER_AS_WRITER as never } } });

export function write(root: string, req: WriteRequest, opts: { acceptedBy?: string; contest?: boolean; hold?: boolean; owner?: boolean; stranger?: boolean; pulled?: boolean } = {}): WriteResult {
  const asOwner = opts.owner === true && req.agent === OWNER;
  if (opts.owner && !asOwner) return { outcome: "refused", message: "owner: only the owner's own word" };
  if (asOwner) opts = { ...opts, acceptedBy: OWNER, contest: false };
  const pre = asOwner ? withOwner(loadRules(root)) : loadRules(root);
  // The hub's filing yes (filing.ts AUTO) to a proposal it did not pull itself is nobody's
  // approval: the write is weighed as the proposer's own, with its carve, its kill switch and its
  // withheld types; only a person's yes (the owner's, an area owner's) sees past them (G536, G539).
  const hubYes = opts.acceptedBy === "auto-decide" && !opts.pulled;
  const status = pre.policy.agents[req.agent]?.status;
  if ((!opts.acceptedBy || hubYes) && (status === "paused" || status === "read-only")) {
    // Logged like any refusal, so a paused agent's attempts show up in its activity.
    logWrite(root, { at: clock().toISOString(), agent: req.agent, kind: req.kind ?? "fact", key: typeof req.id === "string" ? req.id.slice(0, 200) : undefined, outcome: "refused", checks: ["agent_status"] });
    return { outcome: "refused", message: `${req.agent} is ${status} by ${ownerName(pre)}; no writes`, fails: [{ check: "agent_status", outcome: "refuse", reason: status, fix: `ask ${ownerName(pre)}` }] };
  }
  const author = opts.acceptedBy ?? req.agent;
  const extraPaths: string[] = []; // files this write changed besides the note (the owner-message registry)
  let regUndo: { rel: string; was?: string; clean: boolean } | undefined;
  const original = req;
  const rules = asOwner ? withOwner(loadRules(root)) : loadRules(root);
  if (!rules.policy.agents[req.agent]) return { outcome: "refused", message: `unknown agent ${req.agent}` };
  // A JSON client may send null for an optional field it leaves out (strict function calling
  // does): the same as leaving it out, so a null never turns a legitimate write into a refusal
  // (eval gap G23). `value` keeps its null.
  req = Object.fromEntries(Object.entries(req).filter(([k, v]) => v !== null || k === "value")) as unknown as WriteRequest;
  const shape = shapeFails(req);
  if (shape.length) {
    logWrite(root, { at: clock().toISOString(), agent: req.agent, kind: "fact", outcome: "refused", checks: ["schema"] });
    return { outcome: "refused", message: shape.map((f) => `${f.check}: ${f.reason}. Fix: ${f.fix}`).join("\n"), fails: shape };
  }
  req = { ...req, sources: (req.sources ?? []).map((s) => (typeof s === "string" ? normalizeRef(s) : { ...s, ref: normalizeRef(s.ref) })) };
  if (req.source_type === "agent_observation") req.verification = "self-reported";
  // approved: is the hub's record of the owner's tap (decideOne below); no writer cites one itself,
  // or an assistant could show "you approved" on its own claim (slice audit 2026-10-25, G424).
  if (!isOwnerId(opts.acceptedBy) && req.sources!.some((s) => isApprovedRef(refString(s)))) {
    logWrite(root, { at: clock().toISOString(), agent: req.agent, kind: req.kind ?? "fact", key: typeof req.id === "string" ? req.id.slice(0, 200) : undefined, outcome: "refused", checks: ["approved_ref"] });
    return { outcome: "refused", message: "approved_ref: an approved: ref records the owner's tap; only the hub adds it. Fix: cite where the fact came from", fails: [{ check: "approved_ref", outcome: "refuse", reason: "cites approved:", fix: "cite where the fact came from" }] };
  }
  const enabled = new Set(rules.checks.checks ?? []);
  const thirdParty = thirdPartySensitive(req);
  // Someone else's health, school, legal or money detail: kept, but private and shared only
  // with the resolver (Louis always sees everything). Forced here, so no agent can opt out.
  if (thirdParty) req = { ...req, sensitivity: sensitivityRank(req.sensitivity ?? "public") > sensitivityRank("private") ? req.sensitivity : "private", share_with: rules.policy.resolver ? [rules.policy.resolver] : [] };
  const fails = runChecks(req, enabled, ownerName(rules));
  // A value written to the assistant reading it is an order: only the owner files one (G526), under
  // any attribute's name (audit v7, G554: the same order under notes or working_style was served).
  if (!isOwnerId(opts.acceptedBy) && !req.retract && speaksToReader(req.attribute, req.value))
    fails.push({ check: "injection_shapes", outcome: "inbox", reason: `the ${isPreference(req.attribute) ? "preference" : "value"} tells the assistant reading it what to do`, fix: "a fact says how things are; the owner reviews this one" });
  // An id naming an assistant is refused for a new note only (G598): a note the writer sees by that
  // id (an org page the owner made) takes the write. Weighed once the notes are loaded below, before
  // any inbox return, and a hidden one counts as missing, so it answers exactly like a new id
  // (invariant 3; G598 slice audit F2: a new one tripping an inbox check became an ask the owner
  // could only reject, which the hub retried every minute).
  const agentInId = fails.find((f) => f.check === "no_agent_in_ids");
  const refusals = fails.filter((f) => f.outcome === "refuse" && f !== agentInId);
  const editor = rules.policy.owner_editor === req.agent;
  const done = (r: WriteResult) => {
    // A relayed owner id whose registry commit didn't go through is taken out again unless this
    // write was saved: left on disk it would count as the owner's word with nothing recorded.
    if (regUndo && r.outcome !== "committed" && r.outcome !== "disputed") {
      const f = join(root, regUndo.rel);
      if (regUndo.was === undefined) rmSync(f, { force: true }); else writeFileSync(f, regUndo.was);
      if (regUndo.clean) git(root, ["reset", "-q", "--", regUndo.rel]);
    }
    logWrite(root, { at: clock().toISOString(), agent: req.agent, kind: req.kind ?? "fact", key: r.fact_key ?? req.id, outcome: r.outcome, step: r.step, checks: (r.fails ?? []).map((f) => f.check), ...(editor ? { as: "owner_editor" } : {}) });
    return r;
  };
  if (refusals.length) {
    return done({ outcome: "refused", message: refusals.map((f) => `${f.check}: ${f.reason}. Fix: ${f.fix}`).join("\n"), fails: refusals });
  }
  // On a replica, everything past the plain checks needs the hub's copy: queue it as an op.
  if (!opts.acceptedBy) { const q = queueIfReplica(root, original); if (q) return done(q); }
  // Read shared and frozen (src/brain.ts): a copy of every note per write took most of a write at
  // 10k notes (docs/perf.md). The one note this write changes is copied below (`mine`).
  const notes = loadBrain(root, { shared: true });
  const mine = (n: Note | undefined) => n && structuredClone(n);
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
  if (agentInId) {
    const n = notes.find((x) => x.fm.id === req.id);
    const sees = !!n && ((!!opts.acceptedBy && !hubYes) || !!rules.policy.agents[req.agent]?.inside_wall || carve(notes, rules, grantFor(rules, req.agent), { flags: false }).visible.has(n.fm.id));
    if (!sees) return done({ outcome: "refused", message: `${agentInId.check}: ${agentInId.reason}. Fix: ${agentInId.fix}`, fails: [agentInId] });
  }
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
  if (!opts.acceptedBy || hubYes) {
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
  const seesAll = !!((opts.acceptedBy && !hubYes) || rules.policy.agents[req.agent]?.inside_wall);
  const writerCarve = seesAll ? undefined : own;
  const visibleToWriter = writerCarve?.visible;
  const writerSees = (id: string) => seesAll || visibleToWriter!.has(id);
  let note = req.id && writerSees(req.id) ? mine(notes.find((n) => n.fm.id === req.id)) : undefined;
  if (!note && !req.id) {
    // Matching by title only looks at notes the writer can see, so the reply never names others.
    // It matches the names the writer is shown (carve copies, carved values [withheld]), so a guess
    // at a withheld word in a title can't be confirmed by landing on the existing note.
    const shown = writerCarve ? [...writerCarve.visible.values()].map((v) => v.note) : notes;
    const r = resolveEntity(shown, req.type!, req.title!);
    if (r.ambiguous) return done(propose(root, req, `new or same as ${r.ambiguous.join(" / ")}?`, []));
    if (r.id && writerSees(r.id)) note = mine(notes.find((n) => n.fm.id === r.id));
  }
  if (!note && req.id && !req.title) return done({ outcome: "refused", message: `no note ${req.id}; give title, type and area to create it` });
  // An agent putting back a value the brain already replaced or forgot, on nothing but its own
  // word, is answering from a stale memory (docs/memory-sync.md): refused with that reason, so it
  // doesn't become a dispute the owner settles. A checkable source makes it a real change.
  if (note && req.attribute && !req.retract && !opts.acceptedBy && !editor && (req.sources ?? []).length
    && (req.sources ?? []).every((x) => AGENT_MEMORY_SCHEMES.has(schemeOf(refString(x)) ?? ""))) {
    // As the write stores it (normalized, a name linked as [[id|label]] or [[label]]): its label.
    const spec = attributeSpec(loadRules(root), note.fm.type, req.attribute);
    const plain = (v: unknown) => { let x = v; try { x = normalizeValue(v as never, spec); } catch { /* as written */ } return compareKey(typeof x === "string" ? x.replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, "$1") : x); };
    const key = plain(req.value);
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
  // A proposal that also asked to move its page to another area: a yes to it, the hub's or the
  // owner's, files the fact where the page is. No path moves a page's area, so the write handed it
  // back to the inbox and the hub's save was refused every day (0.2.0 live, 2026-10-30; G519). Here,
  // where the page is found by id or by title, not before (6ebb09f7 live: two found by title; G522).
  if (note && req.area && req.area !== note.fm.area && opts.acceptedBy) { const { area: _moved, ...rest } = req; req = rest as WriteRequest; }
  else if (note && req.area && req.area !== note.fm.area)
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
  // Outside its own areas a full agent's fact files itself too (owner's outside review, 2026-10-25:
  // "nobody approves facts"): a new fact lands, and a different value for a held one is a conflict
  // that waits for the Gardener (contest), never a replacement. On a private note, or one above,
  // it still waits for the owner, as does a fact that claims the owner's word (G422).
  const outside = !opts.acceptedBy && !editor && !coHere && owner !== req.agent;
  const claimsOwner = isOwnerConfirmed(normVerification(req.verification)) || (req.sources ?? []).some((x) => OWNER_REF.test(refString(x)) || isExactLouisRef(refString(x)));
  if (outside && (claimsOwner || sensitivityRank(note?.fm.sensitivity ?? (rules.checks.types?.[req.type ?? ""]?.sensitivity ?? "personal")) >= sensitivityRank("private") || (req.sensitivity && sensitivityRank(req.sensitivity) >= sensitivityRank("private"))))
    return done(propose(root, req, `area ${area} is owned by ${owner ?? "nobody"} (own_area)`, []));
  // Taking a fact back is never filed from outside: it waits for the owner (slice audit of G422).
  if (outside && req.retract) return done(propose(root, req, `area ${area} is owned by ${owner ?? "nobody"} (own_area)`, []));
  if (outside) opts = { ...opts, contest: true };
  // The hub's filing yes (filing.ts AUTO) to an assistant's own proposal is nobody's approval: a
  // different value from outside the writer's areas is weighed as its own write's would be. Else
  // any area named on a remember made the write a proposal (area change), the hub's yes dropped the
  // area (G519) and skipped the contest above, and an assistant's contradiction filed as an update
  // (audit v6, 2026-10-30; G536). A source the hub pulled itself (`pulled`: a capture) keeps its
  // own filing rules; a new fact still files as the hub's yes always filed it.
  else if (hubYes && !editor && !coHere && owner !== req.agent) opts = { ...opts, contest: true };

  const d = today();
  if (!note) {
    const type = req.type!;
    const folder = folderFor(type, req.agent);
    const slug = safeSlug(notes, rules, req.title!, writerCarve);
    let id = `${folder}/${slug}`;
    let n = 2;
    // A writer that can't see every note gets a random suffix on every new note, so a name
    // taken by a note it can't see answers exactly like a fresh one (G28; the owner can change
    // this default). Anyone who sees everything keeps plain names.
    if (!rules.policy.agents[req.agent]?.inside_wall) do id = `${folder}/${slug}-${sha256(id + Date.now() + Math.random()).slice(0, 6)}`; while (notes.some((x) => x.fm.id === id));
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
  // Outside its areas, on a note where the writer can't see everything (an attribute its slice
  // leaves out, a fact shared away or above its level, a private record), every write waits for
  // the owner with the same reply, set or not, so filing never tells it whether a hidden fact
  // exists (slice audit of G422).
  if (opts.contest) {
    const v = writerCarve?.visible.get(note.fm.id);
    const hidden = writerCarve && (writerCarve.hiddenFacts.some((h) => h.key.startsWith(`${note!.fm.id}#`)) || (v && factHiddenReason(v, attr, { items: [] }, writerCarve.grant, rules)));
    const privateRec = Object.values(note.fm.facts ?? {}).some((f) => records(f).some((r) => r.sensitivity && sensitivityRank(r.sensitivity) >= sensitivityRank("private")));
    if (hidden || privateRec) return done(propose(root, req, `the owner decides ${factKey} (not_in_your_view)`, []));
  }
  let hiddenWhy = writerCarve && note.fm.facts?.[attr] !== undefined ? writerCarve.hiddenFacts.find((h) => h.key === factKey)?.reason : undefined;
  // A value held for the owner's eyes (spec §7) is still its writer's to update, while every live
  // record is that writer's own: it knows the value, so nothing about it leaks.
  const ownHeld = hiddenWhy === HELD_REASON && records(note.fm.facts![attr]).filter((r) => !r.valid_to && !r.retired).every((r) => r.by === req.agent);
  if (ownHeld) hiddenWhy = undefined;
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
  const before = structuredClone(shownValue(live)); // for the owner's diary row (src/diary.ts)
  const refsBefore = new Set(live && !isDisputed(live) ? records(live).flatMap((r) => (r.sources ?? []).map(refString)) : []);
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
  // The only serving hold (phone UI spec §7, owner 2026-10-26): an assistant's private, money-,
  // health- or legal-shaped value is saved but served to no agent (carve.ts factHiddenReason) until
  // the owner has seen it (src/seen.ts). The owner's own word, or a value they accepted, never waits.
  if (!isOwnerId(opts.acceptedBy) && (sensitivityRank(incoming.sensitivity ?? note.fm.sensitivity) >= sensitivityRank("private") || note.fm.type === "money" || /^money\//.test(note.fm.id) || !!sensitiveShape(rules, attr, value))) incoming.unseen = true;
  // A private or money fact from a sender no person page holds (G420, G429): held the same way, and
  // marked so the owner's home says where it came from (G454). Never the address.
  if (opts.stranger) { incoming.unseen = true; incoming.sender = "unknown"; }
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
  // Every path but the owner's own accept, the hub's filing included (audit v3 2026-10-26; G441).
  if (!isOwnerId(opts.acceptedBy)) {
    const exact = incoming.sources.map(refString).filter((r) => HUB_READS.test(r));
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
  // An item of a kind the hub reads counts as an exact source once the hub has read it; until then
  // it is the writer's word, so a made-up mail id outranks nothing (G441).
  // A contact card is read by the hub alone and no assistant reads the owner's address book, so a
  // card ref is the hub's only on what the hub pulled: borrowing the owner's card ref, a core
  // assistant replaced the card's "Robin's father" with "Robin's uncle" (audit v8, 2026-10-31;
  // G564). The incoming value counts it only when this write files a pull (`pulled`), whoever the
  // capture agent is, since a brain whose resolver is an assistant files cards as that assistant
  // (slice audit of abb3479e); a held record counts it when the capture agent or an inside-wall
  // agent wrote it, so naming a resolver later doesn't demote the cards already filed.
  const read = hubReadRefs(root), hub = captureAgentName(rules.policy);
  const readFor = (x: string, r: FactRecord) => read.has(x) && (!x.startsWith("contacts:") || (r === incoming ? !!opts.pulled : r.by === hub || !!(r.by && rules.policy.agents[r.by]?.inside_wall)));
  const asRead = (r: FactRecord): FactRecord => {
    const refs = (r.sources ?? []).map(refString);
    const unread = refs.filter((x) => HUB_READS.test(x) && !readFor(x, r));
    if (!unread.length) return r;
    const sources = (r.sources ?? []).map((x) => unread.includes(refString(x)) ? `agent:${r.by ?? "unknown"}` : x);
    const anyRead = refs.some((x) => HUB_READS.test(x) && readFor(x, r));
    return { ...r, sources, ...(r.verification === "verified-by-source" && !anyRead ? { verification: "self-reported" } : {}) } as FactRecord;
  };
  // What a borrowed card ref is worth is stored, not only ranked: the record kept "verified-by-
  // source", and the sender check (sameperson.ts trustedAddresses) took an address an assistant
  // planted on a person's page, citing that person's real card, as one the brain vouches for, so its
  // mail filed as a known sender's (audit v9, 2026-10-31; G581). The owner's own accept keeps it.
  // Only a card ref's own demotion is stored: a mail id the connector hasn't checked yet keeps its
  // label until it has (the checked-refs rule, G2; rt-person-forged-source).
  const inRefs = incoming.sources.map(refString);
  const cardOnly = inRefs.some((x) => x.startsWith("contacts:") && !readFor(x, incoming)) && !inRefs.some((x) => HUB_READS.test(x) && !x.startsWith("contacts:"));
  if (!isOwnerId(opts.acceptedBy) && cardOnly && incoming.verification === "verified-by-source" && asRead(incoming).verification !== "verified-by-source") incoming.verification = "self-reported";
  const rank = (r: FactRecord) => ownerWord(r) ? 5 : r.verification === "confirmed-by-co-owner" ? Math.min(sourceRank(asRead(r)), 2) : sourceRank(asRead(r));
  const merge = spec.merge ?? "replace";
  let step: number | undefined;
  let msg = "";
  let disputed = false;
  let keptOwner = false; // an older source than the owner's word: history, no conflict (spec §4.6)
  // `hold`: a hub save whose write still opens a conflict (the fact changed since it was weighed):
  // the conflict waits for the Gardener beside the live value, like a contested one (G425).
  const held = opts.contest || opts.hold ? clock().toISOString() : undefined;

  const mergeSources = (r: FactRecord) => {
    // Ranked before the incoming refs join it: an owner's exact message ref would otherwise lift
    // the record to rank 5 first and keep its old verification, so the owner confirming a value
    // (one side of an open dispute, or any same value) never became the owner's word (G277). Only
    // the owner's word is compared that way; any other label must outrank the merged record, so a
    // weaker label riding in on an owner ref never replaces a stronger one (G306).
    const before = rank(r);
    const have = new Set(r.sources.map(sourceKey));
    const added = incoming.sources.filter((s) => !have.has(sourceKey(s)));
    r.sources.push(...added);
    // Another writer's evidence in it: the sharing agent no longer holds this record alone (G55).
    if (r.by !== req.agent) delete r.shared_by;
    // Fresh means checked, not repeated (outside review 2026-10-25, G418): only new evidence the hub
    // read at its source, or the owner's word, moves last_confirmed. An assistant saying it again,
    // citing what the record already cites, an item the hub never read, or an owner-looking ref
    // that is not a message in the owner's registry, doesn't.
    if (added.some((x) => checked.get(refString(x)) === true || (isExactLouisRef(refString(x)) && (isOwnerId(opts.acceptedBy) || louisMessages(root).has(refString(x)))))) r.last_confirmed = d;
    if (incoming.as_of < r.as_of && !incoming.as_of_approx) r.as_of = incoming.as_of;
    // The owner's own word on the same value a co-owner set takes the record over (G148), so it
    // stays the owner's word after the note leaves her areas or she stops being a co-owner. Not a
    // vaguer value (step 3): the owner never said her more precise one.
    if ((ownerWord(incoming) ? rank(incoming) > before : rank(incoming) > rank(r)) || (r.co_owner && !incoming.co_owner && ownerWord(incoming) && compareKey(r.value) === compareKey(incoming.value))) {
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
    joinPacket(root, live.dispute, same ?? incoming);
    disputed = true;
    msg = `added to open dispute ${live.dispute}`;
  } else if (isList(live)) {
    const keyOf = (v: unknown) => spec.item_key && v && typeof v === "object" ? String((v as Record<string, unknown>)[spec.item_key]) : compareKey(v);
    // The same item first: confirming either side of a disputed item merges into that side (G305).
    const match = live.items.find((i) => compareKey(i.value) === compareKey(value) && !i.valid_to) ?? live.items.find((i) => keyOf(i.value) === keyOf(value) && !i.valid_to);
    if (match && merge !== "append") {
      if (compareKey(match.value) === compareKey(value)) {
        if (!mergeSources(match)) return done({ outcome: "noop", fact_key: factKey, message: "item already recorded" });
        step = 1; msg = "same item, sources merged";
        // A side of an open item dispute: its packet carries the merged side too (G305).
        const open = (match as FactRecord & { dispute?: string }).dispute;
        if (open) { joinPacket(root, open, match); disputed = true; msg = `added to open dispute ${open}`; }
      } else {
        // same item key, different content (e.g. session 6 moved to two different dates)
        // Both items stay in the list, marked with the same dispute id.
        // Held for the Gardener, the live item stays as it is and the other waits in the packet
        // (owner's re-audit, 2026-10-25: a held conflict froze the fact; G425).
        const pending = (match as FactRecord).contested;
        if (held && pending && packetOpen(root, pending)) { joinPacket(root, pending, incoming); disputed = true; step = 7; msg = `added to open dispute ${pending}`; }
        else if (held) {
          const id = openDispute(root, note, attr, [match, incoming], 7, held);
          (match as FactRecord).contested = id;
          disputed = true; step = 7; msg = `item ${keyOf(value)} disputed, live item kept (${id})`;
        } else {
        const id = openDispute(root, note, attr, [match, incoming], 7, held);
        (match as FactRecord & { dispute?: string }).dispute = id;
        live.items.push({ ...incoming, dispute: id } as FactRecord);
        disputed = true; step = 7; msg = `item ${keyOf(value)} disputed (${id})`;
        }
      }
    } else {
      live.items.push(incoming); step = 2; msg = "item added (set)";
    }
  } else {
    const cur = live as FactRecord;
    // The owner's word comes first in the conflict order (G163): an assistant's value never
    // replaces a live owner-confirmed one, not even as a more precise date or a max/min value.
    // It goes to the owner as a step 6 dispute, like the contradiction below.
    // The owner's own yes on a change to their word is theirs to make: it settles below.
    const overOwner = ownerWord(cur) && !ownerWord(incoming) && !isOwnerId(opts.acceptedBy);
    // A conflict that waits keeps the live value for every reader, the packet beside it
    // (`contested`); a second contradiction joins that packet (owner's re-audit, 2026-10-25: a held
    // conflict served "disputed, use neither" for up to 36 hours; G425).
    const beside = (s: number, why: string, hold?: string) => {
      const pending = cur.contested && packetOpen(root, cur.contested) ? cur.contested : undefined;
      if (pending) { joinPacket(root, pending, incoming); disputed = true; step = s; msg = `added to open dispute ${pending}; live value kept`; return; }
      const id = openDispute(root, note, attr, [(({ contested: _, ...c }) => c)(cur), incoming], s, hold);
      facts[attr] = { ...cur, contested: id }; disputed = true; step = s;
      msg = `${why}: disputed (${id}); live value kept`;
    };
    const ownerDispute = () => {
      // Older sources never re-ask (phone UI spec §4.6, owner 2026-10-26): a source dated a day or
      // more before the owner's word is what the owner already corrected. It goes to history as
      // superseded, no conflict; the diary says it once a day. A same-day or later source still asks
      // (a same-day source may be newer than the owner's word).
      if (cur.as_of && incoming.as_of && !incoming.as_of_approx && String(incoming.as_of) < String(cur.as_of)) {
        const hs = (hist[attr] ??= []);
        const known = hs.find((h) => !h.retired && compareKey(h.value) === compareKey(value) && h.ended_by?.step === 6);
        if (known) mergeSources(known);
        else hs.push({ ...incoming, valid_to: cur.as_of, ended_by: { step: 6, at: d, by: req.agent } });
        keptOwner = true; step = 6; msg = "older than the owner's word: kept as history";
        return;
      }
      // The owner's word is never held for the Gardener: it asks at once, and stays live meanwhile.
      beside(6, "contradicts a fact the owner confirmed");
    };
    if (compareKey(cur.value) === compareKey(value)) {
      mergeSources(cur); step = 1; msg = "same value: sources merged";
    } else if (cur.contested && packetOpen(root, cur.contested) && !ownerWord(incoming)) {
      // A conflict already waits beside this value: another value joins it; nothing replaces the
      // live one until someone picks (G425).
      beside(7, "joins the waiting conflict");
    } else if (merge === "latest" && !(opts.contest && rank(incoming) < rank(cur)) && streamStep(cur, incoming, value, rank, ownerWord, hist[attr] ?? []) !== undefined) {
      // A run of values over time (backlog 403): a later value, or on the same day a higher
      // version, becomes current; an earlier one joins history. Never a dispute. Anything else
      // (a weaker source, the owner's word, a relayed value, a same-day value with no order)
      // takes the ladder below (slice audit of 5141347c).
      const hs = (hist[attr] ??= []);
      if (streamStep(cur, incoming, value, rank, ownerWord, hs) === "newer") {
        hs.push({ ...cur, valid_to: incoming.as_of, ended_by: { step: 2, at: d, by: req.agent } });
        facts[attr] = incoming;
      } else {
        // Same reply whether or not the value was already there: an assistant never learns
        // which earlier values the note holds. Retired records don't count (they are revived
        // by the ladder's usual path, never merged into).
        const known = hs.find((h) => !h.retired && compareKey(h.value) === compareKey(value));
        if (known) mergeSources(known);
        else {
          const next = [cur, ...hs.filter((h) => !h.retired)].map((h) => String(h.as_of)).filter((a) => a > incoming.as_of).sort()[0] ?? cur.as_of;
          hs.push({ ...incoming, valid_to: next, ended_by: { step: 2, at: d, by: req.agent } });
          hs.sort((a, b) => String(a.as_of).localeCompare(String(b.as_of)));
        }
      }
      step = 2; msg = "latest: value recorded";
    } else if (merge === "max" || merge === "min") {
      const newer = merge === "max" ? String(value) > String(cur.value) : String(value) < String(cur.value);
      if (!newer) return done({ outcome: "noop", fact_key: factKey, step: 2, message: `${merge}: older value ignored` });
      if (overOwner) ownerDispute();
      else if (opts.contest && rank(incoming) < rank(cur)) {
        // From outside its areas a weaker source never moves a max/min value (slice audit of G422).
        const id = openDispute(root, note, attr, [cur, incoming], 7, held);
        facts[attr] = { dispute: id, candidates: [cur, incoming] }; disputed = true; step = 7;
        msg = `contradiction held for the Gardener: disputed (${id})`;
      } else {
        (hist[attr] ??= []).push({ ...cur, valid_to: incoming.as_of, ended_by: { step: 2, at: d, by: req.agent } });
        facts[attr] = incoming; step = 2; msg = `${merge}: newer value kept`;
      }
    } else {
      const a = String(cur.value), b = String(value);
      const rNew = rank(incoming), rOld = rank(cur);
      // The hub's filing tick files a newer value as an update when every value it replaces came
      // from the same kind of source (fileVerdict: the calendar updating what the calendar said).
      // The write agrees even when the older one was found in its email (verified-by-source):
      // before, every newer email about such a fact opened a conflict filing had called an update
      // (demo, 2026-10-30; G513). An assistant's own newer claim still challenges a verified value.
      const sameKindNewer = (c: FactRecord, n: FactRecord) => {
        // filing.ts AUTO, on what the hub pulled itself: never an assistant's word for what a mail says (G536).
        if (opts.acceptedBy !== "auto-decide" || opts.contest || !opts.pulled) return false;
        const kinds = new Set((n.sources ?? []).map((x) => schemeOf(refString(x))));
        return !!(c.sources ?? []).length && (c.sources ?? []).every((x) => kinds.has(schemeOf(refString(x)))) && rank({ ...c, verification: n.verification }) <= rank(n);
      };
      const supersede = (s: number, why: string) => {
        (hist[attr] ??= []).push({ ...cur, valid_to: incoming.as_of, ended_by: { step: s, at: d, by: req.agent } });
        facts[attr] = incoming; step = s; msg = why;
      };
      // Contested (a capture filed as a conflict): a more or less precise date is a conflict too,
      // never a silent replacement under "held it as a conflict" (slice audit of G416).
      if (!opts.contest && /^\d{4}/.test(a) && /^\d{4}/.test(b) && (a.startsWith(b) || b.startsWith(a))) {
        if (b.length > a.length) { if (overOwner) ownerDispute(); else supersede(3, "more precise value kept"); }
        else { mergeSources(cur); step = 3; msg = "vaguer value recorded as a source"; }
      } else if (overOwner) {
        ownerDispute();
      } else if (isOwnerId(req.agent) && isOwnerConfirmed(normVerification(incoming.verification)) && isOwnerConfirmed(normVerification(cur.verification))) {
        // Two of the owner's own words, the new one typed by the owner (audit v5, midday: "chair last
        // week" after "dean" opened a conflict between them; G461): one dated before the live word
        // is an earlier value, kept as history; otherwise the latest thing they said is their word
        // now. Never a co-owner's or an assistant's write: those keep the ladder below.
        if (cur.as_of && incoming.as_of && String(incoming.as_of) < String(cur.as_of)) {
          const hs = (hist[attr] ??= []);
          const known = hs.find((h) => !h.retired && compareKey(h.value) === compareKey(value));
          if (known) mergeSources(known);
          else { hs.push({ ...incoming, valid_to: cur.as_of, ended_by: { step: 4, at: d, by: req.agent } }); hs.sort((x, y) => String(x.as_of).localeCompare(String(y.as_of))); }
          keptOwner = true; step = 4; msg = "the owner's earlier word: kept as history";
        } else supersede(4, "the owner's newer word");
      } else if (rNew < 1 && incoming.sources.length && incoming.sources.every((x) => refString(x).startsWith("agent-relay:"))) {
        // A value only relayed by another agent never replaces anything (architecture 0.7
        // rule 5): the live value stays and the claim waits in the inbox for evidence.
        return done(propose(root, req, "relayed_only: another agent's word can't replace a live fact; cite the original source", []));
      } else if (opts.contest && !(incoming.as_of > cur.as_of && !incoming.as_of_approx && rNew >= rOld)) {
        // From outside its areas only a real change over time (newer, as strong a source) files as
        // an update, as a capture's does (fileVerdict); anything else is a conflict for the Gardener.
        beside(7, "contradiction held for the Gardener", held);
      } else if (isOwnerId(opts.acceptedBy) && incoming.as_of >= cur.as_of) {
        // The owner accepting a proposal is their latest choice, even on the same day as the
        // value it replaces (a new brain's day-one facts), so it settles instead of disputing,
        // whatever the rank of the source it cites.
        supersede(4, "The owner accepted a newer value");
      } else if (incoming.as_of > cur.as_of && !incoming.as_of_approx && (rNew >= rOld || sameKindNewer(cur, incoming))) {
        supersede(4, `real change over time: superseded value as of ${cur.as_of}`);
      } else if (rNew > rOld && (incoming.as_of >= cur.as_of || cur.as_of_approx)) {
        supersede(5, `stronger source (${rNew} > ${rOld})`);
      } else {
        const s = rNew < rOld && incoming.as_of > cur.as_of ? 6 : 7;
        if (held) beside(s, "conflict held for the Gardener", held);
        else {
        const id = openDispute(root, note, attr, [cur, incoming], s, held);
        facts[attr] = { dispute: id, candidates: [cur, incoming] }; disputed = true; step = s;
        msg = `conflict (step ${s}): disputed (${id}); goes to the owner's digest`;
        }
      }
    }
  }

  note.fm.updated = d;
  if (note.fm.history && Object.keys(note.fm.history).length === 0) delete note.fm.history;
  saveNote(root, note);
  // One diary row per fact change, in this same commit (phone UI spec §6); merged sources add none.
  const after = shownValue(facts[attr]);
  // The hub filing a value the page already held still leaves one line (6e15f795 live, 2026-10-30:
  // two filings left none; G524): "confirmed", naming the sources it added, which Undo takes out.
  const sameValue = JSON.stringify(before) === JSON.stringify(after);
  const kind: DiaryKind | undefined = disputed ? "conflict" : keptOwner ? "kept" : req.retract ? "retracted" : before === undefined ? "new"
    : sameValue ? (opts.acceptedBy === "auto-decide" ? "confirmed" : undefined) : isList(facts[attr]) ? "item_added" : "changed";
  const added = kind === "confirmed" ? [...new Set(records(facts[attr]!).flatMap((r) => (r.sources ?? []).map(refString)))].filter((x) => !refsBefore.has(x)) : [];
  if (kind) extraPaths.push(appendDiary(root, { ...diaryRow({ at: clock().toISOString(), factKey, title: String(note.fm.title ?? note.fm.id), kind, from: kind === "confirmed" ? undefined : before, to: kind === "retracted" ? undefined : kind === "item_added" || kind === "conflict" || kind === "kept" ? value : after, incoming, acceptedBy: opts.acceptedBy, rank: rank(incoming), sensitivity: incoming.sensitivity ?? note.fm.sensitivity }), ...(kind === "confirmed" ? { added } : {}) }, d.slice(0, 7)));
  const unsaved = commitPaths(root, [note.fm.id + ".md", ...(existsSync(join(root, "disputes")) ? ["disputes"] : []), ...extraPaths], `${req.agent}: ${factKey} (${msg})${opts.acceptedBy ? `, accepted by ${opts.acceptedBy}` : ""}`, author);
  if (unsaved) return done(notSaved(unsaved));
  return done({ outcome: disputed ? "disputed" : "committed", fact_key: factKey, step, message: msg, file: note.fm.id + ".md" });
}

// Where a value of a `merge: latest` attribute goes, or undefined for the ordinary ladder:
// "newer" (current) when it is dated later, or the same day with a higher version number;
// "older" (history) when dated earlier. Only a source at least as strong as the live one, never
// over or as the owner's word, never a value only another agent relayed.
function streamStep(cur: FactRecord, incoming: FactRecord, value: unknown, rank: (r: FactRecord) => number, ownerWord: (r: FactRecord) => boolean, hs: FactRecord[]): "newer" | "older" | undefined {
  // A value the hub checked against its source outranks a raw exact id: a newer unchecked value is a
  // conflict for the Gardener (it waits beside the live one), never a silent replacement (owner's
  // re-audit, 2026-10-25: the STREAM_PEER cap let a raw id replace a verified next step; G425).
  if (ownerWord(cur) || ownerWord(incoming) || rank(incoming) < rank(cur)) return undefined;
  if (incoming.sources.length && incoming.sources.every((x) => refString(x).startsWith("agent-relay:"))) return undefined;
  if (incoming.as_of > cur.as_of) return "newer";
  if (incoming.as_of < cur.as_of) return hs.some((h) => h.retired && compareKey(h.value) === compareKey(value)) ? undefined : "older";
  const order = versionOrder(String(value), String(cur.value));
  return order > 0 ? "newer" : order < 0 ? "older" : undefined;
}

// Compares the numbers in two values in order ("0.21.0 (29)" > "0.20.1 (28)"); 0 when either
// has none or they are the same.
export function versionOrder(a: string, b: string): number {
  const na = a.match(/\d+/g)?.map(Number) ?? [], nb = b.match(/\d+/g)?.map(Number) ?? [];
  if (!na.length || !nb.length) return 0;
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const x = na[i] ?? -1, y = nb[i] ?? -1;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

// One numbered side in a packet's body.
const sideLine = (n: number, c: FactRecord) => `${n}. ${typeof c.value === "object" ? JSON.stringify(c.value) : c.value} (as of ${c.as_of}, ${c.verification}, by ${c.by}, ${c.sources.map(refString).join(", ")})`;

function openDispute(root: string, note: Note, attr: string, candidates: FactRecord[], step: number, held?: string): string {
  const id = nextDisputeId(root);
  const d = today();
  const packet: Note = {
    fm: {
      id: `disputes/${id}`, type: "dispute", title: `${note.fm.id}#${attr}`, area: note.fm.area,
      sensitivity: note.fm.sensitivity, status: "open", created: d, updated: d, by: "write-path",
      fact_key: `${note.fm.id}#${attr}`, step, candidates, ...(held ? { gardener_first: held } : {}),
    } as Frontmatter,
    body: `Conflict on \`${note.fm.id}#${attr}\`, reached step ${step} of architecture 0.6.\n\n${candidates
      .map((c, i) => sideLine(i + 1, c))
      .join("\n")}\n\nThe owner answers with the number; the reply becomes a confirmed-by-owner fact.\n`,
    path: "",
  };
  saveNote(root, packet);
  return id;
}

// A side added to an open dispute joins its packet too (G277): the owner answers among every side,
// and the resolver's checks (louisOnly, the evidence's rank) see an owner's or co-owner's word that
// arrived after the packet was written, so that packet goes to the owner. A value already there is
// replaced in place (its number stays), carrying the merged sources and verification.
// Its numbered line rewritten too, so the body the owner and the resolver read matches it (G306).
// Lines go in through replacer functions: an agent's value is text, never a $-pattern (G306).
// A packet still waiting for an answer (a stale `contested` marker is ignored and replaced).
function packetOpen(root: string, id: string): boolean {
  const file = join(root, "disputes", `${id}.md`);
  if (!existsSync(file)) return false;
  return ["open", "escalated"].includes(String(parseNote(readFileSync(file, "utf8"), `disputes/${id}.md`).fm.status));
}

function joinPacket(root: string, id: string, side: FactRecord) {
  const file = join(root, "disputes", `${id}.md`);
  if (!existsSync(file)) return;
  const p = parseNote(readFileSync(file, "utf8"), `disputes/${id}.md`);
  const fm = p.fm as Frontmatter & { origin?: string; candidates?: FactRecord[] };
  if (fm.origin === "contradiction" || !["open", "escalated"].includes(String(fm.status))) return;
  const { dispute: _, ...rec } = side as FactRecord & { dispute?: string };
  const cands = (fm.candidates ??= []);
  const i = cands.findIndex((c) => compareKey(c.value) === compareKey(rec.value));
  if (i >= 0) {
    cands[i] = rec;
    const at = new RegExp(`^${i + 1}\\. .*$`, "m");
    if (at.test(p.body)) p.body = p.body.replace(at, () => sideLine(i + 1, rec));
  } else {
    cands.push(rec);
    const line = `${sideLine(cands.length, rec)}; added while open`;
    p.body = /\n\nThe owner answers/.test(p.body) ? p.body.replace(/\n\nThe owner answers/, () => `\n${line}\n\nThe owner answers`) : `${p.body.trimEnd()}\n${line}\n`;
  }
  fm.updated = today();
  saveNote(root, p);
}

// Undo of a capture the hub filed as a conflict (G416): its side leaves the conflict and the
// proposal goes back to the inbox. With one side left the fact is that side again and the conflict
// closes; with more (others joined meanwhile) it stays open with theirs. One commit, the hub's on
// the owner's Undo: the owner took the capture back, not chose the value left (G426).
// Works after the Gardener suggested a side or another write joined, where a revert can't.
export function withdrawConflictSide(root: string, id: string, file: string): string | undefined {
  const rel = `disputes/${id}.md`, f = join(root, rel);
  const decided = `inbox/decided/${file}`, back = `inbox/${file}`;
  if (!existsSync(f) || !existsSync(join(root, decided))) return "the conflict or its proposal is gone";
  const p = parseNote(readFileSync(f, "utf8"), rel);
  const fm = p.fm as Frontmatter & { candidates?: FactRecord[]; fact_key?: string };
  if (!["open", "escalated"].includes(String(fm.status))) return "it was decided since";
  const prop = YAML.parse(readFileSync(join(root, decided), "utf8")) as { request: WriteRequest; decided?: unknown; decision?: unknown; by?: unknown };
  const mine = new Set((prop.request.sources ?? []).map((x) => refString(x as SourceRef)));
  const cands = fm.candidates ?? [];
  const i = cands.findIndex((c) => compareKey(c.value) === compareKey(prop.request.value) && (c.sources ?? []).some((x) => mine.has(refString(x))));
  if (i < 0) return "its side is no longer in the conflict";
  const [noteId, attr] = String(fm.fact_key).split("#");
  const note = loadBrain(root).find((n) => n.fm.id === noteId);
  const cur = note?.fm.facts?.[attr] as (FactRecord & { dispute?: string; candidates?: FactRecord[] }) | undefined;
  // The live value a held conflict waited beside (G425), or a fact marked disputed (older packets).
  const besideIt = !!cur && !isList(cur as never) && cur.contested === id;
  if (!note || !cur || isList(cur as never) || (cur.dispute !== id && !besideIt)) return "the fact changed since";
  const rest = cands.filter((_, j) => j !== i);
  const was = { packet: readFileSync(f, "utf8"), note: readFileSync(join(root, `${noteId}.md`), "utf8"), decided: readFileSync(join(root, decided), "utf8") };
  if (rest.length === 1) {
    const { dispute: _, contested: _c, ...only } = (besideIt ? cur : rest[0]) as FactRecord & { dispute?: string };
    note.fm.facts![attr] = only;
    Object.assign(fm, { status: "resolved", resolution: { by: "hub", at: today(), value: only.value, note: "undone by the owner: the capture's side was taken back; the other side stands as it was" } });
  } else {
    if (!besideIt) note.fm.facts![attr] = { dispute: id, candidates: rest } as never;
    fm.candidates = rest;
  }
  fm.updated = note.fm.updated = today();
  saveNote(root, note); saveNote(root, p);
  const { decided: _d, decision: _x, by: _b, ...open } = prop;
  writeFileSync(join(root, back), YAML.stringify(open, { lineWidth: 0 }));
  rmSync(join(root, decided));
  const unsaved = commitPaths(root, [`${noteId}.md`, rel, decided, back], `hub: undo conflict ${id} (${file} back in the inbox)\n\nKind: inbox\nAsked-by: owner`, "hub");
  if (unsaved) {
    writeFileSync(f, was.packet); writeFileSync(join(root, `${noteId}.md`), was.note); writeFileSync(join(root, decided), was.decided); rmSync(join(root, back), { force: true });
    return `git couldn't record it (${unsaved})`;
  }
  return undefined;
}

// A Yes tap from before G424 was saved as the owner's word: an owner:<date>/inbox/<proposal> ref and
// confirmed-by-owner, so a newer email bowed to an assistant's tapped claim as if the owner had typed
// it. Each becomes what a tap is now (decideOne): an approved: ref, the record ranked as the source it
// cites, with the proposal's own verification (a claimed owner word without an owner message
// dropped, ownerClaim). A record that also cites the owner's own word (a registered message, an
// answer to a conflict) keeps confirmed-by-owner. Facts and history on every page, and conflict
// packets' sides. One hub commit with a why. Run at the hub's start (src/start.ts). Returns the fact keys.
const OLD_TAP = /^(?:owner|louis):(\d{4}-\d{2}-\d{2})\/inbox\/([^/]+\.ya?ml)$/;
export function rankOldTaps(root: string): string[] {
  const out = new Set<string>(), files: string[] = [];
  const asked = (file: string): WriteRequest | undefined => {
    const f = join(root, "inbox", "decided", file);
    try { return existsSync(f) ? (YAML.parse(readFileSync(f, "utf8")) ?? {}).request : undefined; } catch { return undefined; }
  };
  const fix = (r: FactRecord): boolean => {
    const taps = (r.sources ?? []).map(refString).map((x) => OLD_TAP.exec(x)).filter((m): m is RegExpExecArray => !!m);
    if (!taps.length) return false;
    r.sources = (r.sources ?? []).map((x) => { const m = OLD_TAP.exec(refString(x)); return m ? approvedRef(m[1], `inbox/${m[2]}`) : x; });
    const ownWord = (r.sources ?? []).map(refString).some((x) => !isApprovedRef(x) && isExactLouisRef(x));
    if (isOwnerConfirmed(normVerification(r.verification)) && !ownWord) {
      const req = asked(taps[0][2]);
      r.verification = (req ? { ...req, ...ownerClaim(req) }.verification : undefined) ?? "self-reported";
      if (isOwnerConfirmed(normVerification(r.verification))) r.verification = "self-reported";
    }
    return true;
  };
  for (const note of loadBrain(root)) {
    let changed = false;
    const each = (attr: string, list: FactRecord[]) => { for (const r of list) if (r && typeof r === "object" && fix(r)) { out.add(`${note.fm.id}#${attr}`); changed = true; } };
    for (const [attr, f] of Object.entries(note.fm.facts ?? {})) each(attr, isDisputed(f) ? f.candidates : records(f));
    for (const [attr, h] of Object.entries(note.fm.history ?? {})) each(attr, h ?? []);
    const sides = (note.fm as { candidates?: FactRecord[] }).candidates;
    if (note.fm.type === "dispute" && Array.isArray(sides)) each(String((note.fm as { fact_key?: string }).fact_key ?? "packet").split("#").pop()!, sides);
    if (changed) { saveNote(root, note); files.push(note.path); }
  }
  if (!files.length) return [];
  const keys = [...out];
  const unsaved = commitPaths(root, files, `hub: ${keys.length} fact(s) approved by a tap before G424 rank as their source\n\nWhy: a Yes tap is an approval, not the owner's word (owner's choice 2026-10-25); taps from before G424 were saved as his word, so newer evidence bowed to an assistant's tapped claim. The owner's typed word is unchanged.\nKind: upkeep\nFact-Keys: ${keys.join(", ")}`, "hub");
  return unsaved ? [] : keys;
}

// Facts a held conflict froze before G425 ({ dispute, candidates } while it waited for the
// Gardener): the live value comes back for every reader, the packet beside it (`contested`). The
// live value is the packet's first side, the one the fact held when the conflict opened. Only
// packets still open and held for the Gardener (gardener_first); one hub commit with a why. Run at
// the hub's start (src/start.ts). Returns the fact keys put back.
export function unfreezeHeld(root: string): string[] {
  const out: string[] = [], files: string[] = [];
  for (const note of loadBrain(root)) {
    let changed = false;
    for (const [attr, f] of Object.entries(note.fm.facts ?? {})) {
      if (!isDisputed(f)) continue;
      const rel = `disputes/${f.dispute}.md`;
      if (!existsSync(join(root, rel))) continue;
      const p = parseNote(readFileSync(join(root, rel), "utf8"), rel).fm as Frontmatter & { gardener_first?: unknown; candidates?: FactRecord[] };
      if (!["open", "escalated"].includes(String(p.status)) || typeof p.gardener_first !== "string") continue;
      const first = (p.candidates ?? [])[0] ?? f.candidates[0];
      if (!first) continue;
      const { dispute: _d, contested: _c, ...live } = first as FactRecord & { dispute?: string };
      note.fm.facts![attr] = { ...live, contested: f.dispute };
      out.push(`${note.fm.id}#${attr}`); changed = true;
    }
    if (changed) { saveNote(root, note); files.push(`${note.fm.id}.md`); }
  }
  if (!files.length) return out;
  const unsaved = commitPaths(root, files, `hub: live values back beside ${out.length} held conflict(s)\n\nWhy: a conflict waiting for the Gardener froze these facts, so every reader got neither value; each keeps the value it had, with the conflict beside it (G425).\nKind: upkeep\nFact-Keys: ${out.join(", ")}`, "hub");
  return unsaved ? [] : out;
}

// Captures the hub accepted with nothing saved (before G431: a conflict on a page with a private
// fact was handed back by the write as the same proposal, and decideOne answered it accepted; the
// real brain lost 3 on 2026-10-25). One is lost when the hub accepted it and its value is nowhere on
// the page it named: not live, not in history (retired included), not in any conflict packet. Each
// goes back to the inbox, where filing now waits for the owner on it; so does a new page that was
// never made. Not an older max or min the write ignores by design, nor a page named by id that is
// gone. One hub commit with a why. Run at the hub's start (src/start.ts).
export function reopenLostAccepts(root: string): string[] {
  const dir = join(root, "inbox", "decided");
  if (!existsSync(dir)) return [];
  const notes = loadBrain(root);
  const packets = notes.filter((n) => n.fm.type === "dispute");
  const out: string[] = [], paths: string[] = [], keys: string[] = [];
  // Proposals already waiting (a write that filed one again under another name): never a twin card.
  const waiting = readdirSync(join(root, "inbox")).filter((x) => x.endsWith(".yaml")).map((x) => { try { return (YAML.parse(readFileSync(join(root, "inbox", x), "utf8")) ?? {}).request as WriteRequest | undefined; } catch { return undefined; } });
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".yaml")).sort()) {
    let p: { request?: WriteRequest; decision?: string; by?: string; capture?: unknown };
    try { p = YAML.parse(readFileSync(join(dir, f), "utf8")) ?? {}; } catch { continue; }
    const req = p.request;
    if (p.decision !== "accept" || p.by !== "auto-decide" || typeof p.capture !== "string" || !req?.attribute || req.retract || existsSync(join(root, "inbox", f))) continue;
    const id = req.id ?? (req.title && req.type ? resolveEntity(notes, req.type, String(req.title)).id : undefined);
    const note = id ? notes.find((n) => n.fm.id === id) : undefined;
    // A new page that was never made is lost too (a forgotten person's inbox files went with them);
    // a page named by id that is gone now was merged or forgotten, so it stays decided.
    if (!note) {
      if (req.id || !req.title || !req.type || waiting.some((w) => w && !w.id && w.title === req.title && w.attribute === req.attribute)) continue;
      const { decided: _d, decision: _x, by: _b, ...open } = p as Record<string, unknown>;
      writeFileSync(join(root, "inbox", f), YAML.stringify(open, { lineWidth: 0 }));
      rmSync(join(dir, f));
      out.push(f); paths.push(`inbox/${f}`, `inbox/decided/${f}`); keys.push(`${req.type}:${req.title}#${req.attribute}`);
      continue;
    }
    // As the write stores it (normalized, a name linked as [[id|label]] or [[label]]): its label.
    const spec = attributeSpec(loadRules(root), note.fm.type, req.attribute);
    const plain = (v: unknown) => { let x = v; try { x = normalizeValue(v as never, spec); } catch { /* as written */ } return compareKey(typeof x === "string" ? x.replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, "$1") : x); };
    const key = plain(req.value);
    const cur = note.fm.facts?.[req.attribute];
    const held = [...(cur ? (isDisputed(cur) ? cur.candidates : records(cur)) : []), ...(note.fm.history?.[req.attribute] ?? [])];
    const fk = `${note.fm.id}#${req.attribute}`;
    const inPacket = packets.some((d) => (d.fm as { fact_key?: string }).fact_key === fk && ((d.fm as { candidates?: FactRecord[] }).candidates ?? []).some((c) => plain(c.value) === key));
    if (inPacket || held.some((r) => r && plain(r.value) === key)) continue;
    // A max or min the write ignores by design (an older last contact): not lost.
    const live = cur && !isDisputed(cur) && !isList(cur) ? cur as FactRecord : undefined;
    if (live && (spec.merge === "max" || spec.merge === "min")) {
      let v: unknown = req.value; try { v = normalizeValue(req.value as never, spec); } catch { /* as written */ }
      if (spec.merge === "max" ? !(String(v) > String(live.value)) : !(String(v) < String(live.value))) continue;
    }
    if (waiting.some((w) => w && w.attribute === req.attribute && (w.id ?? w.title) === (req.id ?? req.title) && plain(w.value) === key)) continue;
    const { decided: _d, decision: _x, by: _b, ...open } = p as Record<string, unknown>;
    writeFileSync(join(root, "inbox", f), YAML.stringify(open, { lineWidth: 0 }));
    rmSync(join(dir, f));
    out.push(f); paths.push(`inbox/${f}`, `inbox/decided/${f}`); keys.push(fk);
  }
  if (!out.length) return out;
  const unsaved = commitPaths(root, paths, `hub: ${out.length} accepted capture(s) with nothing saved back in the inbox\n\nWhy: the hub answered these accepted while the write handed them back to the owner, so nothing was saved, held or asked (G431); each waits for the owner now.\nKind: inbox\nFact-Keys: ${[...new Set(keys)].join(", ")}`, "hub");
  return unsaved ? [] : out; // git couldn't: commitPaths put both paths back as HEAD holds them
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
export function decideProposal(root: string, file: string, decision: "accept" | "reject", by = OWNER, shown: string[] = [], opts: { contest?: boolean; hold?: boolean } = {}): WriteResult {
  const name = file.split("/").pop()!;
  const now = new Set(inboxCards(root).find((c) => c.file === name)?.twins.map((t) => t.file) ?? []);
  const twins = [...new Set(shown.map((t) => t.split("/").pop()!))].filter((t) => now.has(t));
  const r = decideOne(root, file, decision, by, opts);
  if (r.outcome === "refused" || !twins.length) return r;
  const more = twins.map((t) => decideOne(root, t, decision, by, opts));
  const done = more.filter((x) => decision === "reject" ? x.outcome !== "refused" : ["committed", "disputed", "noop"].includes(x.outcome)).length;
  const waiting = more.filter((x) => x.outcome !== "refused" && !["committed", "disputed", "noop"].includes(x.outcome)).length;
  const left = more.filter((x) => x.outcome === "refused");
  return { ...r, message: `${r.message}; ${decision === "accept" ? "accepted" : "rejected"} ${done} more proposal(s) of the same value${decision === "accept" && waiting ? `, ${waiting} filed again for review` : ""}${left.length ? `, ${left.length} left in the inbox (refused: ${left.map((x) => x.message).join("; ")})` : ""}` };
}

// A proposal that claims the owner's word but cites no owner message: the tap approves the value,
// it doesn't make the claim true, so the claim is dropped (an owner message it cites stays, and
// accepting registers it as theirs).
const ownerClaim = (r: WriteRequest): Partial<WriteRequest> =>
  isOwnerConfirmed(normVerification(r.verification)) && !(r.sources ?? []).map(refString).some(isExactLouisRef) ? { verification: "self-reported" } : {};

function decideOne(root: string, file: string, decision: "accept" | "reject", by: string, opts: { contest?: boolean; hold?: boolean } = {}): WriteResult {
  const rel = file.startsWith("inbox/") ? file : `inbox/${file}`;
  const path = join(root, rel);
  if (!existsSync(path)) return { outcome: "refused", message: `no proposal ${rel}` };
  const p = YAML.parse(readFileSync(path, "utf8")) as { request: WriteRequest; decided?: string };
  // On a replica, Louis's answer is queued as a signed op; the hub applies it on the next sync.
  const q = queueOp(root, "inbox", by, { file: rel, decision }, `${decision} ${rel}`);
  if (q) return q;
  let r: WriteResult = { outcome: "noop", message: "rejected" };
  // A proposal file never brings its own approved: ref (one put there by hand, or by a journal
  // line): the only one is the one this accept adds (G424).
  p.request = { ...p.request, sources: (p.request.sources ?? []).filter((x) => !isApprovedRef(refString(x))) };
  // The hub's own accept of a stranger's private or money fact (G429) files under the serving hold
  // (G454): saved, served to no assistant until the owner taps Show, marked unknown sender.
  const stranger = decision === "accept" && by === "auto-decide" ? !!strangerWaits(root, p) : false;
  if (decision === "accept") {
    // The owner accepting settles the proposal (G11) but is an approval, not their own word
    // (owner's choice 2026-10-25, outside review): the value carries an approved: ref and ranks as
    // the source it cites, so a tap never lifts an assistant's claim to the top. A yes is as of
    // today, so a proposal dated after today is saved dated today (G383), not refused by as_of_not_future.
    const asOf = p.request.as_of && String(p.request.as_of).slice(0, 10) > today() ? { as_of: today() } : {};
    // A capture filed by auto-decide too (G404, Mac 2026-10-25: 684 refused saves of mail and
    // calendar facts dated after today): what the source said is known as of today. An assistant's
    // proposal is still redated only by the owner's yes.
    const req = isOwnerId(by)
      ? { ...p.request, ...asOf, sources: [...(p.request.sources ?? []), approvedRef(today(), `inbox/${rel.split("/").pop()}`)], ...ownerClaim(p.request) }
      : typeof (p as { capture?: unknown }).capture === "string" && by === "auto-decide" ? { ...p.request, ...asOf } : p.request;
    // `pulled` is for what the hub read itself or the owner gave it (a source pull, the CLI, the drop
    // folder, the mailbox). An assistant's imported memory is that assistant's word: the hub's yes
    // is weighed as its own write, its carve included (G587 slice audit F1, F2).
    // Its refs are kept as the assistant's word too, so the stored record ranks as one (F2).
    const capRel = (p as { capture?: unknown }).capture;
    const via = typeof capRel === "string" ? captureVia(root, capRel) : undefined;
    const imported = typeof capRel === "string" && via === "import" && typeof p.request.agent === "string";
    const sent = imported ? { ...req, sources: asAgentWord(req.sources ?? [], String(p.request.agent)) } : req;
    r = write(root, sent, { acceptedBy: by, contest: opts.contest, hold: opts.hold, stranger, pulled: typeof capRel === "string" && via !== "import" });
    if (r.outcome === "refused") return r;
    // The write handed it back to the owner as this very proposal (a conflict on a page with a
    // private fact): it stays in the inbox, never answered as accepted with nothing saved (G431).
    if (r.outcome === "noop" && r.file === rel) return { outcome: "refused", message: `the owner decides this one; it stays in the inbox (${r.message})`, fails: [{ check: "owner_decides", outcome: "refuse", reason: r.message, fix: "the owner answers it on the settle screen" }] };
    // Louis accepting is his word: the Louis message ids it cites become his.
    // Not a co-owner's assistant's: its "owner" refs are the co-owner's messages (docs/household.md).
    if (isOwnerId(by) && !coOwnerOf(loadRules(root), p.request.agent)) registerLouisMessages(root, (p.request.sources ?? []).map(refString).filter(isExactLouisRef), `accepted ${rel.split("/").pop()}`);
  }
  const destRel = `inbox/decided/${rel.split("/").pop()!}`;
  const dest = join(root, destRel);
  mkdirSync(dirname(dest), { recursive: true });
  // Filed by the hub's write path, not approved: nobody looked at it, and Undo in "Filed for you"
  // takes it back out (outside review v3, 2026-10-26).
  const how = decision === "accept" && by === "auto-decide" ? { filed: "by the hub's write path with Undo; nobody approved it" } : {};
  writeFileSync(dest, YAML.stringify({ ...p, decided: today(), decision, by, ...how }, { lineWidth: 0 }));
  rmSync(path);
  // Only the proposal's two paths; if git can't record the answer, both go back (src/git.ts) and
  // the proposal waits to be answered again. An accepted fact is already committed above.
  // The hub filing what the page already said word for word still leaves its line, in this commit
  // (G524): the owner's home shows every filing.
  const lines: string[] = [];
  if (decision === "accept" && by === "auto-decide" && r.outcome === "noop" && r.fact_key) {
    const at = clock().toISOString(), id = r.fact_key.slice(0, r.fact_key.lastIndexOf("#"));
    const note = loadBrain(root).find((n) => n.fm.id === id);
    const live = note?.fm.facts?.[r.fact_key.slice(r.fact_key.lastIndexOf("#") + 1)];
    if (note && live && !isDisputed(live)) {
      const incoming = { ...p.request, as_of: String(p.request.as_of ?? today()), sources: (p.request.sources ?? []) as FactRecord["sources"], by: p.request.agent, recorded: today() } as unknown as FactRecord;
      lines.push(appendDiary(root, { ...diaryRow({ at, factKey: r.fact_key, title: String(note.fm.title ?? note.fm.id), kind: "confirmed", from: undefined, to: shownValue(live), incoming, acceptedBy: by, rank: sourceRank(incoming), sensitivity: (p.request.sensitivity as Sensitivity | undefined) ?? note.fm.sensitivity }), added: [] }, today().slice(0, 7)));
    }
  }
  const unsaved = commitPaths(root, [rel, destRel, ...lines], `inbox: ${decision} ${rel.split("/").pop()}`, by);
  if (unsaved) return { ...notSaved(unsaved), message: `${decision === "accept" && r.outcome !== "noop" ? "the fact is saved, but " : ""}the answer wasn't recorded: the proposal is still in the inbox, answer it again (${unsaved})` };
  // A filed fact keeps its source's words for the owner's page (G451); every other quote goes.
  if (decision === "accept") keepQuote(root, rel, (p.request.sources ?? []).map(refString));
  sweepQuotes(root); // the source's words go with the recorded decision (src/quotes.ts)
  return { ...r, message: `${decision}ed: ${r.message}` };
}

// How a capture reached the hub (its frontmatter `via`), or undefined when it can't be read.
function captureVia(root: string, rel: string): string | undefined {
  try {
    const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(root, rel), "utf8"))?.[1];
    const via = fm ? (YAML.parse(fm) as { via?: unknown })?.via : undefined;
    return typeof via === "string" ? via : undefined;
  } catch { return undefined; }
}

// Why a pulled fact from an unknown sender waits for the owner (src/sender.ts): private or money,
// by the request or the page it would land on. undefined: a known sender, no sender, or not private.
function strangerWaits(root: string, p: { request: WriteRequest; capture?: unknown }): string | undefined {
  const sender = captureSender(root, p);
  if (sender !== "unknown") return undefined;
  const req = p.request;
  const notes = loadBrain(root);
  const id = req.id ?? (req.title && req.type ? resolveEntity(notes, req.type, String(req.title)).id : undefined);
  const note = id ? notes.find((n) => n.fm.id === id) : undefined;
  const rank = (s: unknown) => typeof s === "string" ? sensitivityRank(s as never) : -1;
  const sensitive = [req.sensitivity, note?.fm.sensitivity].some((s) => rank(s) >= sensitivityRank("private")) || note?.fm.type === "money" || req.type === "money" || /^money\//.test(String(id ?? "")) || !!thirdPartySensitive(req);
  return unknownSenderWait(sender, { sensitive });
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
