// SPDX-License-Identifier: AGPL-3.0-only
// Agent logs: the archive of what each assistant did and said (docs/agent-logs.md).
// An agent (or Louis, importing a vendor export) sends a conversation or activity log; it lands
// in that agent's own journal as one Markdown file per log:
//   journal/<agent>/logs/<YYYY-MM>/<date>-<hid>.md
// Rules, all in code:
// - The author comes from the token (or Louis's --as), never from the body.
// - A log is visible to Louis and its author only. journal/ is not a content folder, so no view,
//   cell, search or carve ever loads it; only this file reads it back.
// - Re-sends are idempotent: the same log_id is the same file. A longer version replaces a
//   shorter one (a conversation that grew); an equal or shorter one is a no-op.
// - Secret-shaped strings are replaced before anything touches disk.
// - Injection shapes and words of a category withheld from the author divert the log to
//   inbox/logs/ for Louis; it joins the journal only when he releases it. Consolidation and
//   read-back never see a held log.
// - Limits and retention come from policy.yaml `logs:` (Louis only).
import { sha256, alert, appendJsonl, readJsonl } from "./util";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import YAML from "yaml";
import { today } from "./brain";
import { loadRules, type Rules } from "./rules";
import { withheldWord } from "./carve";
import { findInjection, redactSecrets } from "./checks";
import { logWrite } from "./write";
import { terms, queryTerms, bm25 } from "./retrieve";
import { git } from "./git";
import { OWNER } from "./owner";

export interface LogTurn { role: string; at?: string; text: string }

export interface LogRequest {
  log_id?: string;       // the vendor's id for this conversation or run; makes re-sends idempotent
  date?: string;         // YYYY-MM-DD the log is about (default: today)
  kind?: "conversation" | "activity";
  channel?: string;      // where it happened: sms, chat, email, routine:<name>, …
  title?: string;
  turns?: LogTurn[];
  text?: string;         // instead of turns: the log as plain text
}

export type LogOutcome = "committed" | "updated" | "noop" | "held" | "refused";
export interface LogResult { outcome: LogOutcome; id?: string; file?: string; message: string; redacted?: string[]; held?: string[] }

export interface LogLimits {
  accept: boolean;       // false: this agent's logs are refused
  max_bytes: number;     // one log, after rendering
  max_per_day: number;   // logs written or updated per agent per day
  retention_days: number; // then upkeep moves the month to archive/journal/<agent>/logs/
}

export const LOG_DEFAULTS: LogLimits = { accept: true, max_bytes: 256 * 1024, max_per_day: 48, retention_days: 60 };

export function logLimits(rules: Rules, agent?: string): LogLimits {
  const p = rules.policy as unknown as { logs?: Partial<LogLimits> };
  const a = agent ? (rules.policy.agents[agent] as unknown as { logs?: Partial<LogLimits> | false } | undefined)?.logs : undefined;
  return { ...LOG_DEFAULTS, ...(p.logs ?? {}), ...(a === false ? { accept: false } : a ?? {}) };
}

export interface IngestOpts {
  via?: "mcp" | "api" | "import"; // import = Louis forwarding a vendor export
  by?: string;                     // who commits: the agent, or louis for an import
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function render(req: LogRequest): string {
  const head = req.title ? `## ${req.title.replace(/\n+/g, " ").trim()}\n\n` : "";
  if (req.turns?.length) {
    return head + req.turns.map((t) => {
      const at = t.at ? ` · ${t.at}` : "";
      return `**${t.role.replace(/[*\n]/g, "").trim() || "?"}**${at}\n${t.text.replace(/\r\n?/g, "\n").trim()}\n`;
    }).join("\n");
  }
  return head + (req.text ?? "").replace(/\r\n?/g, "\n").trim() + "\n";
}

function validate(req: LogRequest): string | undefined {
  if (req.date !== undefined && !(typeof req.date === "string" && ISO_DAY.test(req.date))) return "date must be YYYY-MM-DD";
  if (req.date && req.date > today()) return `date ${req.date} is in the future`;
  if (req.kind !== undefined && !["conversation", "activity"].includes(req.kind)) return "kind is conversation or activity";
  if (req.log_id !== undefined && (typeof req.log_id !== "string" || !req.log_id.trim() || req.log_id.length > 200)) return "log_id must be a short string";
  if (req.turns !== undefined) {
    if (!Array.isArray(req.turns)) return "turns must be a list of {role, text, at?}";
    for (const t of req.turns) if (!t || typeof t.role !== "string" || typeof t.text !== "string") return "each turn needs role and text (strings)";
  }
  if (req.text !== undefined && typeof req.text !== "string") return "text must be a string";
  for (const k of ["title", "channel"] as const) if (req[k] != null && typeof req[k] !== "string") return `${k} must be a string`;
  if (!req.turns?.length && !req.text?.trim()) return "empty log: send turns or text";
  const all = render(req);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(all)) return "control characters in the log";
  return undefined;
}

function walkMd(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkMd(p));
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

export interface LogFile { rel: string; fm: Record<string, unknown>; body: string; held: boolean; archived: boolean }

function parseLog(root: string, file: string): LogFile | undefined {
  const m = readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return undefined;
  const rel = relative(root, file);
  return { rel, fm: YAML.parse(m[1]) ?? {}, body: m[2] ?? "", held: rel.startsWith("inbox/"), archived: rel.startsWith("archive/") };
}

// Every log file of one agent (or all agents), wherever it is: journal, held, archived.
export function listLogs(root: string, agent?: string, where: { held?: boolean; archived?: boolean } = {}): LogFile[] {
  const agents = agent ? [agent] : [...new Set([join(root, "journal"), join(root, "archive", "journal")].flatMap((d) => existsSync(d) ? readdirSync(d) : []))];
  const files = agents.flatMap((a) => [
    ...walkMd(join(root, "journal", a, "logs")),
    ...(where.archived ? walkMd(join(root, "archive", "journal", a, "logs")) : []),
  ]);
  if (where.held) files.push(...walkMd(join(root, "inbox", "logs")).filter((f) => !agent || f.split("/").pop()!.startsWith(`${agent}-`)));
  return files.map((f) => parseLog(root, f)).filter((l): l is LogFile => !!l && (!agent || l.fm.agent === agent)).sort((a, b) => a.rel.localeCompare(b.rel));
}

function countToday(root: string, agent: string): number {
  const d = today();
  return readJsonl<{ agent?: string; day?: string; outcome: string }>(join(root, "log", "logs.jsonl"))
    .filter((e) => e.agent === agent && e.day === d && ["committed", "updated", "held"].includes(e.outcome)).length;
}

function record(root: string, entry: Record<string, unknown>) {
  appendJsonl(join(root, "log", "logs.jsonl"), { at: new Date().toISOString(), day: today(), ...entry });
}

export function ingestLog(root: string, agent: string, raw: Record<string, unknown>, opts: IngestOpts = {}): LogResult {
  const rules = loadRules(root);
  const a = rules.policy.agents[agent];
  const by = opts.by ?? agent;
  const via = opts.via ?? "api";
  const done = (r: LogResult) => {
    record(root, { agent, via, by, id: r.id, outcome: r.outcome, held: r.held });
    if (r.outcome !== "refused") logWrite(root, { at: new Date().toISOString(), agent: by, kind: "log", key: r.id, outcome: r.outcome, checks: r.held ?? [] });
    return r;
  };
  if (!a) return { outcome: "refused", message: `unknown agent ${agent}` };
  if (via !== "import" && (a.status === "paused" || a.status === "read-only")) return done({ outcome: "refused", message: `${agent} is ${a.status} by the owner; no writes` });
  const limits = logLimits(rules, agent);
  if (!limits.accept) return done({ outcome: "refused", message: `The owner doesn't take logs from ${agent} (policy.yaml logs)` });

  const { agent: _ignored, ...rest } = raw;
  const req = rest as LogRequest;
  const bad = validate(req);
  if (bad) return done({ outcome: "refused", message: `${bad}. Send {log_id, date, kind, channel, title, turns: [{role, at, text}]} or text.` });

  // Secrets never reach disk, not even in a log (write-quality 3): replace them in place.
  const redacted: string[] = [];
  const clean = (s: string) => { const r = redactSecrets(s); redacted.push(...r.found); return r.text; };
  const body = clean(render(req));
  const title = req.title ? clean(req.title.replace(/\n+/g, " ").trim()).slice(0, 200) : undefined;
  const bytes = Buffer.byteLength(body);
  if (bytes > limits.max_bytes) return done({ outcome: "refused", message: `log is ${Math.ceil(bytes / 1024)} KB, over the ${Math.round(limits.max_bytes / 1024)} KB limit. Send it in parts with log_id <id>#1, <id>#2…` });

  const date = req.date ?? today();
  const hid = sha256(`${agent}\n${req.log_id ?? `${date}\n${body}`}`).slice(0, 12);
  const prior = listLogs(root, agent, { held: true, archived: true }).find((l) => l.fm.hid === hid);
  const hash = sha256(body);
  if (prior) {
    if (prior.fm.sha256 === hash) return done({ outcome: "noop", id: hid, file: prior.rel, message: "already archived" });
    if (prior.body.length >= body.length && prior.body.startsWith(body.trimEnd())) return done({ outcome: "noop", id: hid, file: prior.rel, message: "a longer version is already archived" });
    if (prior.archived) return done({ outcome: "refused", id: hid, message: "that log is past retention and archived; send it with a new log_id" });
  }
  // Louis importing an export is not rate-limited; an agent is.
  if (via !== "import" && countToday(root, agent) >= limits.max_per_day) return done({ outcome: "refused", message: `over ${limits.max_per_day} logs today (policy.yaml logs.max_per_day); send one log per day or per conversation` });

  // Always-on checks. The log is still kept, but held for Louis.
  const held: string[] = [];
  const why = findInjection(`${title ?? ""}\n${body}`);
  if (why) held.push(`injection_shapes: the log ${why}`);
  const w = withheldWord(rules, agent, `${title ?? ""}\n${body}`);
  if (w) held.push(`withheld_category: mentions "${w.split(": ")[1]}"; ${w.split(": ")[0]} isn't shared with ${agent}`);

  const month = date.slice(0, 7);
  const home = `journal/${agent}/logs/${month}/${date}-${hid}.md`;
  const holdAt = `inbox/logs/${agent}-${date}-${hid}.md`;
  // A held re-send leaves the archived version where it is until Louis releases the new one.
  const rel = held.length ? holdAt : prior && !prior.held ? prior.rel : home;
  const fm: Record<string, unknown> = {
    id: (held.length ? home : rel).replace(/\.md$/, ""), type: "log", agent, hid,
    ...(req.log_id ? { log_id: req.log_id } : {}),
    kind: req.kind ?? "conversation", ...(req.channel ? { channel: String(req.channel).slice(0, 80) } : {}),
    ...(title ? { title } : {}), date,
    received: new Date().toISOString(), ...(prior ? { first_received: prior.fm.first_received ?? prior.fm.received } : {}),
    // Who vouches for the text: the agent's own account, or a vendor export Louis forwarded.
    fidelity: via === "import" ? "export" : "self-reported", via,
    turns: req.turns?.length ?? 0, bytes, sha256: hash,
    ...(redacted.length ? { redacted } : {}),
    ...(held.length ? { held } : {}),
  };
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), `---\n${YAML.stringify(fm, { lineWidth: 0 })}---\n${body}`);
  const paths = [rel];
  if (prior && prior.rel !== rel && (prior.held || !held.length)) { git(root, ["rm", "-q", "--cached", prior.rel]); Bun.spawnSync(["rm", join(root, prior.rel)]); paths.push(prior.rel); }
  git(root, ["add", "-A", ...paths]);
  git(root, ["commit", "-q", "-m", `${by}: ${held.length ? "hold" : prior ? "update" : "archive"} log ${hid} (${agent}, ${date})${held.length ? `\n\n${held.join("\n")}` : ""}`], by);

  if (held.length) {
    alert(root, { agent, check: "log_held", from: `${held.map((h) => h.split(":")[0]).join(", ")} in ${rel}` });
    return done({ outcome: "held", id: hid, file: rel, held, redacted: redacted.length ? redacted : undefined, message: "kept, but held for the owner: it joins your journal when the owner releases it" });
  }
  return done({ outcome: prior ? "updated" : "committed", id: hid, file: rel, redacted: redacted.length ? redacted : undefined, message: prior ? "log updated (longer version)" : "log archived" });
}

// Louis's answer to a held log: release moves it into the author's journal; drop deletes it
// (git keeps the history).
export function decideLog(root: string, file: string, decision: "release" | "drop", by = OWNER): string {
  const rel = file.startsWith("inbox/logs/") ? file : `inbox/logs/${file}`;
  const path = join(root, rel);
  if (!existsSync(path)) return `no held log ${rel}`;
  const l = parseLog(root, path)!;
  const agent = String(l.fm.agent);
  if (decision === "drop") {
    git(root, ["rm", "-q", rel]);
    git(root, ["commit", "-q", "-m", `${by}: drop held log ${l.fm.hid} (${agent})`], by);
    record(root, { agent, by, id: l.fm.hid, outcome: "dropped" });
    return `dropped ${rel}`;
  }
  const { held, ...fm } = l.fm;
  const dest = `${String(fm.id)}.md`;
  // An earlier version of the same log in the journal is replaced by the released one.
  const older = listLogs(root, agent).filter((x) => x.fm.hid === l.fm.hid && x.rel !== dest).map((x) => x.rel);
  for (const o of older) { git(root, ["rm", "-q", "--cached", o]); Bun.spawnSync(["rm", join(root, o)]); }
  mkdirSync(dirname(join(root, dest)), { recursive: true });
  writeFileSync(join(root, dest), `---\n${YAML.stringify({ ...fm, released: { by, at: today(), was: held } }, { lineWidth: 0 })}---\n${l.body}`);
  git(root, ["rm", "-q", "--cached", rel]);
  Bun.spawnSync(["rm", path]);
  git(root, ["add", "-A", dest, ...older]);
  git(root, ["commit", "-q", "-m", `${by}: release held log ${l.fm.hid} into ${agent}'s journal`], by);
  record(root, { agent, by, id: l.fm.hid, outcome: "released" });
  return `released into ${dest}`;
}

// ---------- reading back ----------

export interface LogHit { id: string; agent: string; date: string; title?: string; channel?: string; score: number; match: string; held?: boolean; archived?: boolean }

// BM25 (the same scorer as note search) over log turns. `agent` limits it to that agent's
// own journal (what an agent may read back); without it, Louis's view: every agent,
// held and archived included.
export function searchLogs(root: string, q: string, opts: { agent?: string; limit?: number } = {}): LogHit[] {
  const owner = !opts.agent;
  const logs = listLogs(root, opts.agent, { held: owner, archived: owner });
  const docs = logs.map((l) => {
    const chunks = l.body.split(/\n(?=\*\*[^*\n]+\*\*)|\n{2,}/).map((c) => c.trim()).filter(Boolean);
    const ctf = chunks.map((c) => { const m = new Map<string, number>(); for (const t of terms(c)) m.set(t, (m.get(t) ?? 0) + 1); return m; });
    const tf = new Map<string, number>();
    for (const t of terms(String(l.fm.title ?? ""))) tf.set(t, (tf.get(t) ?? 0) + 3);
    for (const m of ctf) for (const [t, n] of m) tf.set(t, (tf.get(t) ?? 0) + n);
    return { l, chunks, ctf, tf, len: [...tf.values()].reduce((a, b) => a + b, 0) };
  });
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const idx = { docs, df };
  const avgdl = docs.reduce((a, d) => a + d.len, 0) / Math.max(1, docs.length);
  const qt = queryTerms(q);
  if (!qt.length) return [];
  const hits: LogHit[] = [];
  for (const d of docs) {
    const s = bm25(d.tf, d.len, avgdl, qt, idx);
    if (!s) continue;
    const best = d.ctf.map((m, i) => ({ i, s: bm25(m, [...m.values()].reduce((a, b) => a + b, 0), avgdl / Math.max(1, d.chunks.length), qt, idx) })).sort((a, b) => b.s - a.s)[0];
    const fm = d.l.fm;
    hits.push({ id: String(fm.hid), agent: String(fm.agent), date: String(fm.date), title: fm.title as string | undefined, channel: fm.channel as string | undefined, score: Number(s.toFixed(3)),
      match: (d.chunks[best?.i ?? 0] ?? "").replace(/\s+/g, " ").slice(0, 200), ...(d.l.held ? { held: true } : {}), ...(d.l.archived ? { archived: true } : {}) });
  }
  return hits.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date)).slice(0, opts.limit ?? 20);
}

// One log by its id. With `agent`, only that agent's own journal; anything else (another
// agent's log, a held or archived one) answers like a missing one.
export function readLog(root: string, id: string, opts: { agent?: string } = {}): { id: string; meta: Record<string, unknown>; text: string } | undefined {
  const owner = !opts.agent;
  const l = listLogs(root, opts.agent, { held: owner, archived: owner }).find((x) => x.fm.hid === id);
  if (!l) return undefined;
  const { sha256: _s, ...meta } = l.fm;
  return { id, meta: { ...meta, file: owner ? l.rel : undefined }, text: l.body };
}

// Upkeep: months of logs past retention move to archive/journal/<agent>/logs/. Returns the moved paths.
// `ok` lets upkeep skip a month Louis undid before.
export function archiveOldLogs(root: string, now = today(), ok: (key: string) => boolean = () => true): string[] {
  const rules = loadRules(root);
  const moved: string[] = [];
  const jdir = join(root, "journal");
  if (!existsSync(jdir)) return moved;
  for (const agent of readdirSync(jdir)) {
    const ldir = join(jdir, agent, "logs");
    if (!existsSync(ldir)) continue;
    const keep = logLimits(rules, agent).retention_days;
    for (const month of readdirSync(ldir)) {
      if (!/^\d{4}-\d{2}$/.test(month)) continue;
      const end = new Date(`${month}-01T00:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
      const age = (Date.parse(`${now}T00:00:00Z`) - end.getTime()) / 86400000;
      if (age <= keep || !ok(`journal/${agent}/logs/${month}`)) continue;
      const dest = join(root, "archive", "journal", agent, "logs", month);
      mkdirSync(dirname(dest), { recursive: true });
      if (existsSync(dest)) { for (const f of readdirSync(join(ldir, month))) renameSync(join(ldir, month, f), join(dest, f)); Bun.spawnSync(["rmdir", join(ldir, month)]); }
      else renameSync(join(ldir, month), dest);
      moved.push(`journal/${agent}/logs/${month}`);
    }
  }
  return moved;
}
