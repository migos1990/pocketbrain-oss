// SPDX-License-Identifier: AGPL-3.0-only
// Everything the owner dashboard shows, read straight from the brain folder. Nothing here
// writes; actions.ts does. The dashboard is Louis's, so it sees the whole brain, uncarved.
import { state as memsyncState, type Correction } from "../memsync";
import type { Evidence } from "../evidence";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { inboxCards } from "../write";
import type { WriteRequest } from "../checks";
import { refString, isExactLouisRef } from "../sources";
import { loadBrain, today, type Note, type FactRecord } from "../brain";
import { heldCaptures } from "../capture";
import { loadRules, type Rules } from "../rules";
import { carve, grantFor, countFacts, type CarveResult } from "../carve";
import { git } from "../git";
import { readJsonl } from "../util";
import { louisMessages } from "../louis";
import { isOwnerId } from "../owner";
import { tokenInfo } from "../auth";
import { loadOAuth } from "../oauth";
import { listAsks, type Ask } from "../asks";
import { exam, type ExamRow } from "../exam";
import { ownerLocal, ownerToday } from "../clock";

export type Row = Record<string, unknown>;

// A log is parsed again only when its size or time changed: a year of reads is tens of thousands
// of lines. Every caller gets the same arrays: read them, and sort or reverse a copy.
const logs = new Map<string, { stamp: string; rows: Row[] }>();
export const jsonl = (file: string): Row[] => {
  const stamp = existsSync(file) ? (({ size, mtimeMs }) => `${size}:${mtimeMs}`)(statSync(file)) : "";
  const hit = logs.get(file);
  if (hit && hit.stamp === stamp) return hit.rows;
  const rows = readJsonl(file);
  logs.set(file, { stamp, rows });
  return rows;
};

function frontmatter(text: string): { fm: Row; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  return m ? { fm: (YAML.parse(m[1]) ?? {}) as Row, body: m[2] } : { fm: {}, body: text };
}

// unregistered: exact owner message ids the request cites that aren't in the owner's registry.
// Accepting registers them as the owner's word, so the card says so whatever route filed it
// (trial, area ownership, a conflict), not only when the reason names the registry check. A
// capture's proposal cites the capture itself, which code made, so it never counts.
// evidence: written by the hub (src/evidence.ts); source_check: the hub's own check of a cited link (src/pull.ts).
export interface Proposal { file: string; by: string; reason: string; at?: string; request: Row; evidence?: Evidence; source_check?: { result: string; ref: string; quote?: string }; capture?: true; also?: { file: string; by: string; sources: string[]; level?: string; mismatch?: boolean }[]; unregistered: string[] }
export interface HeldMessage { id: string; day: string; from: string; to: string; subject: string; at: string; reasons: string[]; text: string; verdict: string }
export interface DisputeRow { id: string; fact_key: string; status: string; created: string; sensitivity?: string; candidates: FactRecord[]; escalated?: Row; suggestion?: Row; answer?: Row; body: string; gardener_first?: string; gardener_seen?: string }
export interface UpkeepRun { run: string; escalate: string[]; autoFix: string[]; review: string[]; undone: boolean }
export interface AgentRow {
  name: string; label: string; tier: string; transport: string; status: string; tokens: number; issued?: string;
  signins: number; // connections through the sign-in service (Auth0) bound to this agent; Revoke cuts them too
  notes: number; facts: number; flags: number; reads24: number; writes24: number; lastSeen?: string;
  resolver: boolean; slices: string[];
}

export function outsideAgents(rules: Rules): string[] {
  return Object.entries(rules.policy.agents).filter(([, a]) => !a.inside_wall).map(([k]) => k);
}

// A twin's level, shown on the card when it differs from the card's own (sensitivity, share_with).
function levelOf(r: Partial<WriteRequest> | undefined, lead: Partial<WriteRequest> | undefined): { level?: string } {
  const say = (x: Partial<WriteRequest> | undefined) => [x?.sensitivity ?? "", ...(x?.share_with ?? []).map((a) => `only ${a}`)].filter(Boolean).join(", ");
  const mine = say(r);
  return mine !== say(lead) ? { level: mine || "normal" } : {};
}

export function proposals(root: string): Proposal[] {
  // One card per fact: proposals of the same value are one card; the others are listed under also.
  let reg: Set<string> | undefined;
  return inboxCards(root).map(({ file, doc: p, twins }) => {
    const request = (p.request ?? {}) as Row;
    const cited = (p as Row).capture || isOwnerId(String(p.by)) ? [] : ((request.sources as unknown[] | undefined) ?? []).map((x) => refString(x as string)).filter(isExactLouisRef);
    reg ??= cited.length ? louisMessages(root) : undefined;
    return {
      // No by (reopened before G601): the request's agent, which the server set from the token.
      file, by: String(p.by ?? request.agent ?? "?"), reason: String(p.reason ?? ""), at: p.at ? String(p.at) : undefined, request, unregistered: cited.filter((r) => !reg!.has(r)),
      ...((p as Row).capture ? { capture: true as const } : {}), ...(p.evidence ? { evidence: p.evidence as Evidence } : {}), ...(p.source_check ? { source_check: p.source_check as Proposal["source_check"] } : {}),
      ...(twins.length ? { also: twins.map((t) => ({ file: t.file, by: String(t.doc.by ?? "?"), ...((t.doc as Row).source_check && ((t.doc as Row).source_check as { result?: string }).result !== "match" ? { mismatch: true } : {}), sources: (t.doc.request?.sources ?? []).map((x) => refString(x)), ...levelOf(t.doc.request, p.request) })) } : {}),
    };
  });
}

export function comms(root: string): HeldMessage[] {
  const dir = join(root, "comms");
  if (!existsSync(dir)) return [];
  const out: HeldMessage[] = [];
  for (const day of readdirSync(dir).sort()) for (const f of readdirSync(join(dir, day)).filter((x) => x.endsWith(".md")).sort()) {
    const { fm, body } = frontmatter(readFileSync(join(dir, day, f), "utf8"));
    out.push({ id: f.replace(/\.md$/, ""), day, from: String(fm.from ?? "?"), to: String(fm.to ?? "?"), subject: String(fm.subject ?? ""), at: String(fm.at ?? day), reasons: (fm.reasons as string[]) ?? [], text: body.trim(), verdict: String(fm.verdict ?? "") });
  }
  return out;
}

export function disputes(notes: Note[]): DisputeRow[] {
  return notes.filter((n) => n.fm.type === "dispute").map((n) => ({
    id: n.fm.id.split("/")[1], fact_key: String(n.fm.fact_key), status: String(n.fm.status), created: String(n.fm.created ?? ""),
    sensitivity: n.fm.sensitivity, candidates: (n.fm.candidates ?? []) as FactRecord[],
    escalated: n.fm.escalated as Row | undefined, suggestion: n.fm.suggestion as Row | undefined, answer: n.fm.answer as Row | undefined, body: n.body,
    ...(typeof n.fm.gardener_first === "string" ? { gardener_first: n.fm.gardener_first } : {}),
    ...(typeof n.fm.gardener_seen === "string" ? { gardener_seen: n.fm.gardener_seen } : {}),
  })).sort((a, b) => a.id.localeCompare(b.id));
}

export function upkeepRuns(root: string): UpkeepRun[] {
  const dir = join(root, "inbox", "reflect");
  if (!existsSync(dir)) return [];
  const undone = new Set(git(root, ["log", "--format=%s", "--grep", "^undo reflect-"]).split("\n").map((s) => s.match(/^undo (\S+):/)?.[1]).filter(Boolean));
  return readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse().map((f) => {
    const text = readFileSync(join(dir, f), "utf8");
    const section = (title: string) => (text.split(`## ${title}`)[1] ?? "").split("\n## ")[0].split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
    const run = f.replace(/\.md$/, "");
    return { run, escalate: [...section("Escalated to the owner"), ...section("Escalated to Louis")], autoFix: section("Fixed automatically"), review: section("To review"), undone: undone.has(run) };
  });
}

export function latestDigest(root: string): { file?: string; text?: string } {
  const dir = join(root, "digest");
  const f = existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(".md")).sort().at(-1) : undefined;
  return f ? { file: f, text: readFileSync(join(dir, f), "utf8") } : {};
}

export interface State {
  root: string; now: Date; rules: Rules; notes: Note[];
  reads: Row[]; writes: Row[]; alerts: Row[];
  proposals: Proposal[]; held: HeldMessage[]; mail: HeldMessage[]; disputes: DisputeRow[];
  upkeep: UpkeepRun[]; agents: AgentRow[]; carves: Map<string, CarveResult>;
  asks: Ask[]; captures: ReturnType<typeof heldCaptures>;
  memsync: Correction[]; // corrections waiting for the owner, and ones an agent couldn't apply
  exams: Map<string, ExamRow>; // the memory exam over the last 7 days (src/exam.ts)
  version: string; // the notes, rules and day the carves were made from (versionKey)
  key: string; // pageKey: work that reads only the commit, rules, logs and minute is kept under it
  dayKey: string; // the same without the minute (the day instead), for work that reads only files and the day
  hourKey: string; // the same with the hour: the memory exam, whose day-long grace an hour doesn't move much
}

// PB_NOW pins the clock in tests, as in core.ts; only the operator sets the environment.
// Each agent's carve, kept while the brain's notes, the rules and the day are the same. The page
// state used to load and carve 10k notes on every request: about 11 s a page (backlog #295).
// The notes come shared and frozen from the parse cache (src/brain.ts), so an unchanged file is
// the same object and a changed one is a new object: a note's identity is its version.
const carveCache = new Map<string, { key: string; res: CarveResult; facts: number }>();
const noteIds = new WeakMap<Note, number>();
let nextNoteId = 0;
function versionKey(rules: Rules, notes: Note[]): string {
  const ids = notes.map((n) => noteIds.get(n) ?? (noteIds.set(n, ++nextNoteId), nextNoteId));
  return `${today()}\n${JSON.stringify(rules)}\n${ids.join(",")}`;
}
let carvesMadeCount = 0;
// How many carves the dashboard has made since the process started; tests read it (backlog #320).
export const carvesMade = () => carvesMadeCount;
function cachedCarve(root: string, name: string, key: string, notes: Note[], rules: Rules): CarveResult {
  const hit = carveCache.get(`${root}\0${name}`);
  if (hit && hit.key === key) return hit.res;
  carvesMadeCount++;
  const res = carve(notes, rules, grantFor(rules, name));
  carveCache.set(`${root}\0${name}`, { key, res, facts: countFacts(res) });
  return res;
}

// The inbox's and rules' files with their sizes and times: proposals are re-read only when one changed.
// rules/ too: a card reads files loadRules doesn't hold (the owner's message registry).
function inboxKey(root: string): string {
  return ["inbox", "rules"].map((d) => join(root, d)).map((dir) => existsSync(dir) ? readdirSync(dir).map((f) => { const st = statSync(join(dir, f)); return `${f}:${st.size}:${st.mtimeMs}`; }).join("|") : "").join("\n");
}

// The brain's commit, read from .git without running git (a spawn per page was most of a page).
function headOf(root: string): string {
  try {
    const head = readFileSync(join(root, ".git", "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return head;
    const ref = join(root, ".git", head.slice(5));
    if (existsSync(ref)) return readFileSync(ref, "utf8").trim();
    const packed = join(root, ".git", "packed-refs");
    return existsSync(packed) ? `${head}:${statSync(packed).mtimeMs}` : head;
  } catch { return ""; }
}

// What the owner's page figures read: the brain's commit, the rules, every log and rules file's
// size and time, and the minute. Work that reads only these (the memory exam, the real-use bar, git
// history) is kept while they stay the same (backlog #295).
export function pageKey(root: string, now: Date, rulesKey = ""): string {
  const stamps = (dir: string) => existsSync(dir) ? readdirSync(dir).map((f) => { const st = statSync(join(dir, f)); return `${f}:${st.size}:${st.mtimeMs}`; }).join("|") : "";
  return `${now.toISOString().slice(0, 16)}\n${headOf(root)}\n${rulesKey}\n${stamps(join(root, "log"))}\n${stamps(join(root, "rules"))}`;
}

const KEPT_MAX = 64;
const kept = new Map<string, { key: string; value: unknown }>();
export function keptFor<T>(root: string, name: string, key: string, fn: () => T): T {
  const hit = kept.get(`${root}\0${name}`);
  if (hit && hit.key === key) return hit.value as T;
  const value = fn();
  kept.delete(`${root}\0${name}`);
  kept.set(`${root}\0${name}`, { key, value });
  // One entry per note history or day opened: the oldest go past KEPT_MAX.
  for (const k of kept.keys()) { if (kept.size <= KEPT_MAX) break; kept.delete(k); }
  return value;
}

class LazyCarves extends Map<string, CarveResult> {
  constructor(private make: (name: string) => CarveResult | undefined) { super(); }
  override get(name: string): CarveResult | undefined {
    if (!super.has(name)) { const res = this.make(name); if (res) super.set(name, res); }
    return super.get(name);
  }
  override has(name: string): boolean { return this.get(name) !== undefined; }
}

export function loadState(root: string, now = process.env.PB_NOW ? new Date(process.env.PB_NOW) : new Date()): State {
  const rules = loadRules(root);
  // Read only: the dashboard's edits load their own copy (src/dashboard/edit.ts).
  const notes = loadBrain(root, { shared: true });
  const version = versionKey(rules, notes);
  const key = pageKey(root, now, JSON.stringify(rules));
  const rest = key.slice(key.indexOf("\n"));
  const dayKey = `${now.toISOString().slice(0, 10)}${rest}`, hourKey = `${now.toISOString().slice(0, 13)}${rest}`;
  const reads = jsonl(join(root, "log", "reads.jsonl"));
  const writes = jsonl(join(root, "log", "writes.jsonl"));
  const alerts = jsonl(join(root, "log", "alerts.jsonl"));
  const mail = comms(root);
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const tokens = tokenInfo(root);
  const oauth = loadOAuth(root);
  const signins = (name: string) => Object.values(oauth?.clients ?? {}).filter((v) => v.agent === name).length
    + Object.values(oauth?.machines ?? {}).filter((v) => v.agent === name).length
    + Object.values(oauth?.coworkers ?? {}).filter((v) => v.agent === name).reduce((n, v) => n + Object.keys(v.clients ?? {}).length, 0);
  // Carves are made when a page first asks for one, not for every page: after a write each carve is
  // made again (about 1 s at 10k notes), and history, the brain's lists and most pages
  // never look at one (backlog #320). Only get() is lazy: nothing iterates the map.
  const outside = new Set(outsideAgents(rules));
  const carves = new LazyCarves((name) => (outside.has(name) ? cachedCarve(root, name, version, notes, rules) : undefined));
  const agents: AgentRow[] = [...outside].map((name) => {
    const a = rules.policy.agents[name];
    const mine = (rows: Row[]) => rows.filter((r) => r.agent === name);
    const last = [...mine(reads), ...mine(writes)].map((r) => String(r.at)).sort().at(-1);
    const row = {
      name, label: a.label ?? name, tier: a.tier, transport: a.transport ?? "paste", status: a.status ?? "active",
      tokens: tokens[name]?.length ?? 0, issued: tokens[name]?.map((t) => t.issued).sort().at(-1), signins: signins(name),
      reads24: mine(reads).filter((r) => String(r.at) >= since).length,
      writes24: mine(writes).filter((r) => String(r.at) >= since).length,
      lastSeen: last, resolver: rules.policy.resolver === name, slices: grantFor(rules, name).slices,
    } as AgentRow;
    // What the carve counts, carved on first use.
    Object.defineProperties(row, {
      notes: { enumerable: true, get: () => carves.get(name)!.visible.size },
      facts: { enumerable: true, get: () => (carves.get(name), carveCache.get(`${root}\0${name}`)!.facts) },
      flags: { enumerable: true, get: () => carves.get(name)!.flags.length },
    });
    return row;
  });
  return {
    root, now, rules, notes, reads, writes, alerts,
    proposals: keptFor(root, "proposals", `${version}\n${inboxKey(root)}`, () => proposals(root)), mail, held: mail.filter((m) => m.verdict === "held"),
    disputes: disputes(notes), upkeep: upkeepRuns(root), agents, carves, asks: listAsks(root), captures: heldCaptures(root),
    memsync: memsyncState(root).corrections.filter((c) => ["proposed", "needs-hand", "still-wrong"].includes(c.state)),
    exams: new Map(keptFor(root, "exam", hourKey, () => exam(root)).map((r) => [r.agent, r])),
    key, dayKey, hourKey, version,
  };
}

// Reads and writes per agent per day, oldest first, for the activity chart.
export function activityByDay(s: State, days = 7): { day: string; counts: Record<string, number> }[] {
  const out: { day: string; counts: Record<string, number> }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = ownerToday(new Date(s.now.getTime() - i * 86_400_000));
    out.push({ day, counts: Object.fromEntries(s.agents.map((a) => [a.name, 0])) });
  }
  const index = new Map(out.map((d, i) => [d.day, i]));
  for (const r of [...s.reads, ...s.writes]) {
    const i = index.get(ownerLocal(String(r.at)).slice(0, 10));
    const a = String(r.agent);
    if (i !== undefined && a in out[i].counts) out[i].counts[a]++;
  }
  return out;
}
