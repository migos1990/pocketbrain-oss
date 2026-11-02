// SPDX-License-Identifier: AGPL-3.0-only
// Loading and saving brain files: one Markdown file per thing, YAML frontmatter,
// id = path without .md (memory-shape.md sections 2 and 3).
import { appendFileSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync } from "node:fs";
import { join, dirname, relative, basename } from "node:path";
import YAML from "yaml";
import { ownerToday } from "./clock";

export type Sensitivity = "public" | "personal" | "private" | "secret";
export const SENSITIVITY_ORDER: Sensitivity[] = ["public", "personal", "private", "secret"];

export type Verification = "confirmed-by-owner" | "confirmed-by-louis" /* legacy, read as confirmed-by-owner */ | "confirmed-by-co-owner" /* set by write() only: docs/household.md */ | "verified-by-source" | "self-reported" | "unverified";

export type SourceRef = string | { ref: string; via: string };

export interface FactRecord {
  value: unknown;
  as_of: string;
  as_of_approx?: boolean;
  sources: SourceRef[];
  verification: Verification;
  co_owner?: string; // with confirmed-by-co-owner: whose word (docs/household.md)
  confirmed_by?: string; // the co-owner's assistant that confirmed a value another agent wrote
  confidence?: "stated" | "inferred";
  by: string;
  recorded: string;
  last_confirmed?: string;
  sensitivity?: Sensitivity; // raises this one fact above the file's level, never lowers it
  share_with?: string[]; // if set, only these agents ever get this fact
  sender?: "unknown"; // filed from a sender no person page holds (src/sender.ts); never the address
  unseen?: boolean; // held: served to no agent until the owner has seen it (phone UI spec §7, src/seen.ts)
  kept_private?: string; // the day the owner read a held value and kept it from their assistants (src/seen.ts keepPrivate): still held, no longer waiting
  contested?: string; // a conflict waits beside this live value (disputes/<id>); readers keep using the value (G425)
  shared_by?: string; // the agent whose own write set share_with (none when the owner or the write path set it)
  review_after?: string;
  valid_to?: string;
  note?: string;
  // correction: the owner said the ended value was never right (a fix, not a change in the world).
  ended_by?: { step: number; at: string; by: string; sources?: SourceRef[]; correction?: boolean };
  // Set when the sleep pass forgets a fact nobody used past its shelf life. Not a claim that
  // the value stopped being true (that is valid_to); only that the brain stopped vouching for it.
  retired?: { at: string; by: string; why: string };
  // Set when a pulled source this fact cites changed or vanished (src/pull.ts); with review_after
  // it shows the fact as due until the source is re-read or the owner decides.
  recheck?: { why: string; ref: string; at: string };
}

export interface ListFact {
  items: FactRecord[];
}

export interface DisputedFact {
  dispute: string;
  candidates: FactRecord[];
}

export type Fact = FactRecord | ListFact | DisputedFact;

export interface Frontmatter {
  id: string;
  type: string;
  title: string;
  summary?: string; // one line under the title (src/wiki.ts)
  summary_facts?: string[]; // the facts wiki_sync wrote the summary from (view.ts summaryShown, G608)
  aliases?: string[];
  parent?: string; // the page above this one in the wiki tree (src/wiki.ts)
  area: string;
  sensitivity: Sensitivity;
  status: string;
  created: string;
  updated: string;
  by: string;
  sources?: SourceRef[];
  tags?: string[];
  legacy?: Record<string, unknown>;
  facts?: Record<string, Fact>;
  history?: Record<string, FactRecord[]>;
  [k: string]: unknown;
}

export interface Note {
  fm: Frontmatter;
  body: string;
  path: string; // relative path with .md
}

// Folders that hold content notes. rules/, inbox/, comms/, views/, import/ are not content.
export const CONTENT_DIRS = ["people", "orgs", "projects", "decisions", "notes", "money", "agents", "disputes"];

export function isList(f: Fact | undefined): f is ListFact {
  return !!f && typeof f === "object" && Array.isArray((f as ListFact).items);
}
export function isDisputed(f: Fact | undefined): f is DisputedFact {
  return !!f && typeof f === "object" && typeof (f as DisputedFact).dispute === "string";
}

export function parseNote(text: string, path: string): Note {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`${path}: missing frontmatter`);
  const fm = YAML.parse(m[1], { schema: "core" }) as Frontmatter;
  return { fm, body: m[2] ?? "", path };
}

// The restart snapshot (backlog 305): each note's parsed frontmatter, kept on disk by the hash of
// its YAML text, so a restarted hub reads JSON instead of parsing YAML again (most of a restart at
// 50k notes, docs/perf.md). Keyed by content, never by path or time: an edited note has a new hash
// and is parsed again, so a stale entry is never used. One file per brain, in .cells/ (derived,
// git-ignored, left out of backups), shared by the brain and its agents' cells. A file from
// another version of the format or of the YAML parser is dropped whole; a line that doesn't read
// is dropped alone. Only frontmatter that comes back from JSON the same is kept.
// Bump the 1 when parseNote changes how it reads YAML (its options, what it keeps).
const SNAPSHOT_HEAD = `pocketbrain-parse 1 yaml ${YAML_VERSION()}`;
type Snapshot = { file: string; entries: Map<string, string>; used: Set<string>; dirty: boolean };
const snapshots = new Map<string, Snapshot>();
let snapshotOff = !!process.env.PB_NO_PARSE_SNAPSHOT;

function YAML_VERSION(): string {
  try { return JSON.parse(readFileSync(join(dirname(require.resolve("yaml")), "..", "package.json"), "utf8")).version; } catch { return "?"; }
}

function snapshotFile(root: string): string {
  // A cell (root/.cells/<agent>) shares its brain's file.
  return basename(dirname(root)) === ".cells" ? join(dirname(root), "parse.json") : join(root, ".cells", "parse.json");
}

function snapshotFor(root: string): Snapshot {
  const file = snapshotFile(root);
  let s = snapshots.get(file);
  if (s) return s;
  s = { file, entries: new Map(), used: new Set(), dirty: false };
  snapshots.set(file, s);
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return s; }
  const lines = text.split("\n");
  if (lines[0] !== SNAPSHOT_HEAD) { s.dirty = true; return s; }
  for (let i = 1; i < lines.length; i++) {
    const tab = lines[i].indexOf("\t");
    if (tab === 44) s.entries.set(lines[i].slice(0, 44), lines[i].slice(45));
    else if (lines[i]) s.dirty = true;
  }
  for (const k of droppedKeys(file)) if (s.entries.delete(k)) s.dirty = true;
  return s;
}

// A forgotten person's frontmatter (src/forget.ts) must not live on in the cache: its keys go in
// parse.drop beside the file, which every process honours when it loads and when it saves, so a
// hub that read the note before the forget doesn't write it back. Hashes only, never the text.
const dropFile = (snapshot: string) => join(dirname(snapshot), "parse.drop");
function droppedKeys(snapshot: string): Set<string> {
  try { return new Set(readFileSync(dropFile(snapshot), "utf8").split("\n").filter((l) => l.length === 44)); } catch { return new Set(); }
}
const yamlKey = (yaml: string) => new Bun.CryptoHasher("sha256").update(yaml).digest("base64");
// `matching`: also drop every cached entry whose JSON holds one of these strings (renderings of
// the note this process can't rebuild, like an agent cell's copy from an earlier commit).
export function dropParsed(root: string, texts: string[], matching: string[] = []): void {
  const file = snapshotFile(root);
  const keys = texts.map((t) => t.match(/^---\n([\s\S]*?)\n---\n?/)?.[1]).filter((y): y is string => y !== undefined).map(yamlKey);
  const scan = (k: string, v: string) => matching.some((m) => v.includes(m)) && keys.push(k);
  try { for (const l of readFileSync(file, "utf8").split("\n")) if (l.charAt(44) === "\t") scan(l.slice(0, 44), l.slice(45)); } catch { /* no snapshot on disk */ }
  for (const [k, v] of snapshots.get(file)?.entries ?? []) scan(k, v);
  const had = droppedKeys(file), add = [...new Set(keys)].filter((k) => !had.has(k));
  if (!keys.length) return;
  mkdirSync(dirname(file), { recursive: true });
  if (add.length) appendFileSync(dropFile(file), add.join("\n") + "\n");
  const s = snapshots.get(file);
  if (s) for (const k of keys) { s.entries.delete(k); s.used.delete(k); }
  try {
    const drop = new Set(keys);
    const lines = readFileSync(file, "utf8").split("\n");
    const kept = lines.filter((l) => !drop.has(l.slice(0, 44)));
    if (kept.length !== lines.length) { writeFileSync(`${file}.${process.pid}.tmp`, kept.join("\n")); renameSync(`${file}.${process.pid}.tmp`, file); }
  } catch { /* no snapshot on disk */ }
}

// Plain JSON data only: no number JSON can't hold, no key that names a prototype.
function jsonSafe(v: unknown): boolean {
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v) && !Object.is(v, -0);
  if (Array.isArray(v)) return v.every(jsonSafe);
  if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    for (const [k, x] of Object.entries(v as object)) if (k === "__proto__" || k === "constructor" || k === "prototype" || !jsonSafe(x)) return false;
    return true;
  }
  return false;
}

function snapshotParse(root: string, text: string, path: string): Note {
  if (snapshotOff) return parseNote(text, path);
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`${path}: missing frontmatter`);
  const s = snapshotFor(root);
  const key = yamlKey(m[1]);
  const kept = s.entries.get(key);
  if (kept !== undefined) {
    try {
      const fm = JSON.parse(kept);
      if (fm && typeof fm === "object" && !Array.isArray(fm)) { s.used.add(key); return { fm, body: m[2] ?? "", path }; }
    } catch { /* parsed again below */ }
  }
  const fm = YAML.parse(m[1], { schema: "core" }) as Frontmatter;
  if (fm && typeof fm === "object" && jsonSafe(fm)) {
    s.entries.set(key, JSON.stringify(fm));
    s.used.add(key);
    s.dirty = true;
    scheduleSnapshotSave();
  }
  return { fm, body: m[2] ?? "", path };
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let exitHooked = false;
function scheduleSnapshotSave() {
  if (!exitHooked) { exitHooked = true; process.on("exit", saveParseSnapshots); }
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = undefined; saveParseSnapshots(); }, 300_000);
  saveTimer.unref?.();
}

// Written on exit (and when serve is stopped, src/cli.ts) and, for a running hub, at most every
// five minutes: a 50k brain's file is about 60 MB. Entries this process used are kept;
// the rest only while the file stays under twice that plus 10k, so notes that went away drop out.
export function saveParseSnapshots(): void {
  for (const s of snapshots.values()) {
    if (!s.dirty) continue;
    s.dirty = false;
    const keep = s.entries.size > 2 * s.used.size + 10_000 ? [...s.used] : [...s.entries.keys()];
    const drop = droppedKeys(s.file);
    const out = [SNAPSHOT_HEAD];
    for (const k of keep) { const v = s.entries.get(k); if (v !== undefined && !drop.has(k)) out.push(`${k}\t${v}`); }
    try {
      const dir = dirname(s.file);
      if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, ".gitignore"), "*\n"); }
      const tmp = `${s.file}.${process.pid}.tmp`;
      writeFileSync(tmp, out.join("\n") + "\n");
      renameSync(tmp, s.file);
    } catch { /* a read-only brain just parses again next time */ }
  }
}

// Tests: forget what this process loaded, as a restart would, or stop using the snapshot.
export function resetParseSnapshots(o: { off?: boolean } = {}): void {
  snapshots.clear();
  parsed.clear();
  if (o.off !== undefined) snapshotOff = o.off;
}

const FM_ORDER = [
  "id", "type", "title", "summary", "aliases", "parent", "area", "sensitivity", "status", "created", "updated", "by",
  "decided_on", "options", "supersedes", "superseded_by", "merged_into", "verification",
  "sources", "tags", "legacy", "facts", "history",
];

export function serializeNote(note: Note): string {
  const ordered: Record<string, unknown> = {};
  for (const k of FM_ORDER) if (note.fm[k] !== undefined) ordered[k] = note.fm[k];
  for (const k of Object.keys(note.fm)) if (!(k in ordered) && note.fm[k] !== undefined) ordered[k] = note.fm[k];
  const yaml = YAML.stringify(ordered, { lineWidth: 0, aliasDuplicateObjects: false });
  const body = note.body.replace(/^\n+/, "");
  return `---\n${yaml}---\n${body.endsWith("\n") || body === "" ? body : body + "\n"}`;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory() || (e.isSymbolicLink() && statSync(p).isDirectory())) out.push(...walk(p));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

// Parsed notes by file, reused while the file's text is unchanged. YAML parsing was most of a
// read on a large brain (docs/perf.md). The text is compared in full, so an edit is never
// missed, and each caller gets its own copy, since the write path edits the notes it loads.
// Read-only callers (cell builds, a cell's snapshot) pass `shared` and get the cached notes
// themselves, frozen, so a mutation throws instead of reaching other readers: copying 10k notes
// took a quarter of a second per load.
const parsed = new Map<string, { text: string; note: Note }>();
// The hub's notes plus every agent's cell: at 50k notes and four agents, about 220k files. A cache
// smaller than that is cleared on every pass and each read parses everything again (docs/perf.md).
const PARSE_CACHE_MAX = 1_000_000;

export function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x); }
  return v;
}

export function loadBrain(root: string, opts: { shared?: boolean } = {}): Note[] {
  const notes: Note[] = [];
  for (const d of CONTENT_DIRS) {
    for (const file of walk(join(root, d))) {
      const rel = relative(root, file);
      const text = readFileSync(file, "utf8");
      let hit = parsed.get(file);
      if (!hit || hit.text !== text || hit.note.path !== rel) {
        hit = { text, note: deepFreeze(snapshotParse(root, text, rel)) };
        if (parsed.size >= PARSE_CACHE_MAX) parsed.clear();
        parsed.set(file, hit);
      }
      notes.push(opts.shared ? hit.note : structuredClone(hit.note));
    }
  }
  return notes.sort((a, b) => a.fm.id.localeCompare(b.fm.id));
}

// A note from text read elsewhere (an old version from git, src/dashboard/history.ts): the cached,
// frozen note when the file at `rel` was parsed from exactly this text, else a fresh parse. Most
// of a past day's brain is the same text as today's files (backlog #295).
export function parseShared(root: string, rel: string, text: string): Note {
  const hit = parsed.get(join(root, rel));
  return hit && hit.text === text && hit.note.path === rel ? hit.note : deepFreeze(parseNote(text, rel));
}

// `notes` (loaded shared from `root`) with the files at `paths` read again: added, changed or,
// when gone, dropped. For a cell whose changed files are known (src/cell.ts).
export function reloadNotes(root: string, notes: Note[], paths: string[]): Note[] {
  if (!paths.length) return notes;
  const gone = new Set(paths);
  const out = notes.filter((n) => !gone.has(n.path));
  for (const rel of gone) {
    const file = join(root, rel);
    if (!CONTENT_DIRS.includes(rel.split("/")[0]) || !rel.endsWith(".md") || !existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    let hit = parsed.get(file);
    if (!hit || hit.text !== text || hit.note.path !== rel) {
      hit = { text, note: deepFreeze(snapshotParse(root, text, rel)) };
      if (parsed.size >= PARSE_CACHE_MAX) parsed.clear();
      parsed.set(file, hit);
    }
    out.push(hit.note);
  }
  return out.sort((a, b) => a.fm.id.localeCompare(b.fm.id));
}

export function saveNote(root: string, note: Note) {
  const file = join(root, note.fm.id + ".md");
  mkdirSync(dirname(file), { recursive: true });
  // Written beside and renamed over: a crash mid-write leaves the old note or the new one, never
  // half of one (a note that doesn't parse stops every read).
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, serializeNote(note));
  renameSync(tmp, file);
  note.path = note.fm.id + ".md";
}

export function sensitivityRank(s: Sensitivity | undefined): number {
  return SENSITIVITY_ORDER.indexOf(s ?? "personal");
}

export function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70)
    .replace(/-+$/, "");
}

export function today(): string {
  return process.env.PB_TODAY ?? ownerToday(); // the owner's day (src/clock.ts)
}

// Every [[link]] in a string, without alias or anchor.
export function linksIn(text: string): string[] {
  return [...text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map((m) => m[1].trim());
}
