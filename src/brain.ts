// SPDX-License-Identifier: AGPL-3.0-only
// Loading and saving brain files: one Markdown file per thing, YAML frontmatter,
// id = path without .md (memory-shape.md sections 2 and 3).
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import YAML from "yaml";

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
  aliases?: string[];
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

const FM_ORDER = [
  "id", "type", "title", "aliases", "area", "sensitivity", "status", "created", "updated", "by",
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
const PARSE_CACHE_MAX = 200_000;

function deepFreeze<T>(v: T): T {
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
        hit = { text, note: deepFreeze(parseNote(text, rel)) };
        if (parsed.size >= PARSE_CACHE_MAX) parsed.clear();
        parsed.set(file, hit);
      }
      notes.push(opts.shared ? hit.note : structuredClone(hit.note));
    }
  }
  return notes.sort((a, b) => a.fm.id.localeCompare(b.fm.id));
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
      hit = { text, note: deepFreeze(parseNote(text, rel)) };
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
  return process.env.PB_TODAY ?? new Date().toISOString().slice(0, 10);
}

// Every [[link]] in a string, without alias or anchor.
export function linksIn(text: string): string[] {
  return [...text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map((m) => m[1].trim());
}
