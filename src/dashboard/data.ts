// SPDX-License-Identifier: AGPL-3.0-only
// Everything the owner dashboard shows, read straight from the brain folder. Nothing here
// writes; actions.ts does. The dashboard is Louis's, so it sees the whole brain, uncarved.
import { state as memsyncState, type Correction } from "../memsync";
import type { Evidence } from "../evidence";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { inboxCards } from "../write";
import type { WriteRequest } from "../checks";
import { refString, isExactLouisRef } from "../sources";
import { loadBrain, type Note, type FactRecord } from "../brain";
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

export type Row = Record<string, unknown>;

export const jsonl = (file: string): Row[] => readJsonl(file);

function frontmatter(text: string): { fm: Row; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  return m ? { fm: (YAML.parse(m[1]) ?? {}) as Row, body: m[2] } : { fm: {}, body: text };
}

// unregistered: exact owner message ids the request cites that aren't in the owner's registry.
// Accepting registers them as the owner's word, so the card says so whatever route filed it
// (trial, area ownership, a conflict), not only when the reason names the registry check. A
// capture's proposal cites the capture itself, which code made, so it never counts.
// evidence: written by the hub (src/evidence.ts); source_check: the hub's own check of a cited link (src/pull.ts).
export interface Proposal { file: string; by: string; reason: string; at?: string; request: Row; evidence?: Evidence; source_check?: { result: string; ref: string; quote?: string }; also?: { file: string; by: string; sources: string[]; level?: string; mismatch?: boolean }[]; unregistered: string[] }
export interface HeldMessage { id: string; day: string; from: string; to: string; subject: string; at: string; reasons: string[]; text: string; verdict: string }
export interface DisputeRow { id: string; fact_key: string; status: string; created: string; sensitivity?: string; candidates: FactRecord[]; escalated?: Row; answer?: Row; body: string }
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
      file, by: String(p.by ?? "?"), reason: String(p.reason ?? ""), at: p.at ? String(p.at) : undefined, request, unregistered: cited.filter((r) => !reg!.has(r)),
      ...(p.evidence ? { evidence: p.evidence as Evidence } : {}), ...(p.source_check ? { source_check: p.source_check as Proposal["source_check"] } : {}),
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
    escalated: n.fm.escalated as Row | undefined, answer: n.fm.answer as Row | undefined, body: n.body,
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
}

// PB_NOW pins the clock in tests, as in core.ts; only the operator sets the environment.
export function loadState(root: string, now = process.env.PB_NOW ? new Date(process.env.PB_NOW) : new Date()): State {
  const rules = loadRules(root);
  const notes = loadBrain(root);
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
  const carves = new Map<string, CarveResult>();
  const agents: AgentRow[] = outsideAgents(rules).map((name) => {
    const a = rules.policy.agents[name];
    const res = carve(notes, rules, grantFor(rules, name));
    carves.set(name, res);
    const mine = (rows: Row[]) => rows.filter((r) => r.agent === name);
    const last = [...mine(reads), ...mine(writes)].map((r) => String(r.at)).sort().at(-1);
    return {
      name, label: a.label ?? name, tier: a.tier, transport: a.transport ?? "paste", status: a.status ?? "active",
      tokens: tokens[name]?.length ?? 0, issued: tokens[name]?.map((t) => t.issued).sort().at(-1), signins: signins(name),
      notes: res.visible.size, facts: countFacts(res), flags: res.flags.length,
      reads24: mine(reads).filter((r) => String(r.at) >= since).length,
      writes24: mine(writes).filter((r) => String(r.at) >= since).length,
      lastSeen: last, resolver: rules.policy.resolver === name, slices: res.grant.slices,
    };
  });
  return {
    root, now, rules, notes, reads, writes, alerts,
    proposals: proposals(root), mail, held: mail.filter((m) => m.verdict === "held"),
    disputes: disputes(notes), upkeep: upkeepRuns(root), agents, carves, asks: listAsks(root), captures: heldCaptures(root),
    memsync: memsyncState(root).corrections.filter((c) => ["proposed", "needs-hand", "still-wrong"].includes(c.state)),
    exams: new Map(exam(root).map((r) => [r.agent, r])),
  };
}

// Reads and writes per agent per day, oldest first, for the activity chart.
export function activityByDay(s: State, days = 7): { day: string; counts: Record<string, number> }[] {
  const out: { day: string; counts: Record<string, number> }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(s.now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day, counts: Object.fromEntries(s.agents.map((a) => [a.name, 0])) });
  }
  const index = new Map(out.map((d, i) => [d.day, i]));
  for (const r of [...s.reads, ...s.writes]) {
    const i = index.get(String(r.at).slice(0, 10));
    const a = String(r.agent);
    if (i !== undefined && a in out[i].counts) out[i].counts[a]++;
  }
  return out;
}
