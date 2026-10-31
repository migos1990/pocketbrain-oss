// SPDX-License-Identifier: AGPL-3.0-only
// Words quoted from a source, kept only while the owner decides (docs/sources-pull.md, "Facts, not
// copies"). A pulled item's text never goes in the brain; the few words a proposal was drawn from
// help the owner keep or drop it, so they wait beside the open proposal, outside git (in the
// repo's .git folder, which nothing commits), and are deleted when the proposal is decided. The
// proposal file, its decided copy, commits and logs never hold them.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { createHash } from "node:crypto";
import { git } from "./git";
import { loadBrain, isDisputed, isList, type Note, type FactRecord } from "./brain";
import { normalizeRef } from "./sources";

export const QUOTE_MAX = 200;

// Inside the git folder, which nothing commits: .git itself, or the folder a worktree's .git file
// points to. A brain that isn't a git repo commits nothing, so a plain folder will do.
// `name` is the file or folder there (pb-quotes, pb-held, ...); a plain folder gets a dot name.
export function gitSide(root: string, name: string): string {
  const g = join(root, ".git");
  if (!existsSync(g)) return join(root, `.${name}`);
  if (statSync(g).isDirectory()) return join(g, name);
  const to = readFileSync(g, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
  return to ? join(resolve(root, to), name) : join(root, `.${name}`);
}
const dir = (root: string) => gitSide(root, "pb-quotes");
// One file per proposal. (Branches before G98 also wrote `.check` files; the sweep removes them.)
const file = (root: string, proposal: string) => join(dir(root), `${proposal.split("/").pop()}.quote`);

export function putQuote(root: string, proposal: string, text: string) {
  const d = dir(root);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  // A brain that isn't a git repo keeps them in its tree: nothing may stage them (G94).
  if (d === join(root, ".pb-quotes") && !existsSync(join(d, ".gitignore"))) writeFileSync(join(d, ".gitignore"), "*\n");
  writeFileSync(file(root, proposal), text.slice(0, QUOTE_MAX), { mode: 0o600 });
}

export function getQuote(root: string, proposal: string): string | undefined {
  const f = file(root, proposal);
  return existsSync(f) ? readFileSync(f, "utf8") : undefined;
}

// Deletes the quotes of every proposal no longer waiting in inbox/ (decided, forgotten, moved).
export function sweepQuotes(root: string): number {
  const d = dir(root);
  if (!existsSync(d)) return 0;
  // Held proposals (inbox/held, src/capture.ts) are still waiting: their quotes stay.
  const open = new Set(["inbox", join("inbox", "held")].flatMap((d) => existsSync(join(root, d)) ? readdirSync(join(root, d)) : []));
  let n = 0;
  for (const f of readdirSync(d)) if (!f.startsWith(".") && !open.has(f.replace(/\.(quote|check)$/, ""))) { rmSync(join(d, f), { force: true }); n++; }
  return n;
}

// Proposals made before quotes moved out of git kept them at the end of the committed reason. Moves
// an open one's quote beside it and strips it from the open and decided files, in one commit. Git
// history still holds the old lines; only a history scrub removes them (docs/sources-pull.md).
const LEGACY = /;?\s*quote: "(.*)"$/;
export function migrateLegacyQuotes(root: string): number {
  const changed: string[] = [];
  for (const sub of ["inbox", join("inbox", "decided")]) {
    const d = join(root, sub);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith(".yaml"))) {
      const path = join(d, f);
      const text = readFileSync(path, "utf8");
      if (!text.includes("quote: ")) continue;
      let p: { capture?: string; reason?: string };
      try { p = YAML.parse(text) ?? {}; } catch { continue; }
      const m = p.capture && typeof p.reason === "string" ? p.reason.match(LEGACY) : null;
      if (!m) continue;
      if (sub === "inbox" && !getQuote(root, f)) putQuote(root, f, m[1].replace(/\\"/g, '"'));
      writeFileSync(path, YAML.stringify({ ...p, reason: p.reason!.replace(LEGACY, "") }, { lineWidth: 0 }));
      changed.push(join(sub, f));
    }
  }
  if (changed.length) {
    git(root, ["add", "--", ...changed]);
    git(root, ["commit", "-q", "-m", `quotes: moved ${changed.length} source quote(s) out of proposal files (facts, not copies)\n\nAgent: hub\nKind: upkeep`], "hub");
  }
  return changed.length;
}

// ---------- held originals (G243) ----------
// A held message or handoff is committed redacted (G201), so the owner's release would forward
// the redacted text. When redaction changed it, the sender's original waits here, outside git
// (mode 600), until the owner decides: release uses it, and release or drop deletes it.
const heldDir = (root: string) => gitSide(root, "pb-held");
const heldFile = (root: string, key: string) => join(heldDir(root), `${key.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
export function putHeld(root: string, key: string, original: Record<string, string>) {
  const d = heldDir(root);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  if (d === join(root, ".pb-held") && !existsSync(join(d, ".gitignore"))) writeFileSync(join(d, ".gitignore"), "*\n");
  writeFileSync(heldFile(root, key), JSON.stringify(original), { mode: 0o600 });
}
export function getHeld(root: string, key: string): Record<string, string> | undefined {
  const f = heldFile(root, key);
  try { return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined; } catch { return undefined; }
}
export function dropHeld(root: string, key: string) {
  rmSync(heldFile(root, key), { force: true });
}
// Every original still waiting, by file name (the relay's sweep, sweepHeldComms in relay.ts, G285;
// a handoff's original is dropped when it is delivered, finished or dropped, not swept).
export function listHeld(root: string): { file: string; data: Record<string, string> }[] {
  const d = heldDir(root);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".json")).flatMap((file) => {
    try { return [{ file, data: JSON.parse(readFileSync(join(d, file), "utf8")) }]; } catch { return []; }
  });
}
export function dropHeldFile(root: string, file: string) {
  rmSync(join(heldDir(root), file.replace(/[^A-Za-z0-9_.-]/g, "_")), { force: true });
}

// ---------- kept quotes (G451) ----------
// The owner's choice (2026-10-27): when a pulled or captured fact files, the words it was drawn
// from are kept instead of deleted, still outside git and at most QUOTE_MAX characters, keyed by
// the source item (one file per item, named by a hash of its ref). Only the owner's own page reads
// them, under a reference they tap (src/dashboard/html-page.ts); no carve, assistant tool, log,
// digest or commit does. The words go when no fact, history line or conflict cites the item.
// In the brain folder, not in .git (audit v5, midday: the backup carries untracked files, never
// .git's own, so quotes kept there were lost with the machine): `.pb-kept-quotes/`, owner-only
// (0700, files 0600), ignored by git, so the encrypted backup holds it and no commit ever does.
const KEPT = ".pb-kept-quotes";
const moved = new Set<string>();
function keptDir(root: string): string {
  const d = join(root, KEPT);
  if (!moved.has(root)) {
    moved.add(root);
    // Quotes kept by an older hub inside .git move here, once.
    const old = gitSide(root, "pb-kept-quotes");
    if (old !== d && existsSync(old)) {
      mkdirSync(d, { recursive: true, mode: 0o700 });
      for (const f of readdirSync(old)) if (f.endsWith(".quote") && !existsSync(join(d, f))) { writeFileSync(join(d, f), readFileSync(join(old, f)), { mode: 0o600 }); }
      rmSync(old, { recursive: true, force: true });
    }
    if (existsSync(d) && !existsSync(join(d, ".gitignore"))) writeFileSync(join(d, ".gitignore"), "*\n");
  }
  return d;
}
// One source item, whatever part of it a ref points at: kept words are filed by it.
export const itemRef = (ref: string) => normalizeRef(ref).replace(/@[^@/]*$/, "");
const keptName = (ref: string) => `${createHash("sha256").update(itemRef(ref)).digest("hex").slice(0, 32)}.quote`;

// Called as an accepted proposal is recorded, before its open quote is swept.
export function keepQuote(root: string, proposal: string, refs: string[]) {
  const q = getQuote(root, proposal);
  if (q !== undefined) keepWords(root, refs, q);
}

// The words a source item gave, kept by the item: an accepted proposal's quote, or the sentence
// the hub found a fact's value in when it read the item (src/pull.ts recheckFacts).
export function keepWords(root: string, refs: string[], q: string) {
  const keep = refs.filter((r) => /^[a-z][a-z-]*:/.test(r) && !/^(owner|approved|agent):/.test(r));
  if (!q.trim() || !keep.length) return;
  const d = keptDir(root);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  if (!existsSync(join(d, ".gitignore"))) writeFileSync(join(d, ".gitignore"), "*\n");
  // One item can give several facts, each drawn from its own words: all are kept, the latest last.
  for (const r of keep) {
    const had = keptQuotes(root, r).filter((x) => x !== q.slice(0, QUOTE_MAX));
    writeFileSync(join(d, keptName(r)), JSON.stringify([...had, q.slice(0, QUOTE_MAX)].slice(-KEPT_PER_ITEM)), { mode: 0o600 });
  }
}
const KEPT_PER_ITEM = 5;

export function keptQuotes(root: string, ref: string): string[] {
  const f = join(keptDir(root), keptName(ref));
  try { const v = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : []; return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
}

// Deletes the words of every source item no record in the brain cites any more. Returns how many.
export function sweepKeptQuotes(root: string, notes: Note[] = loadBrain(root)): number {
  const d = keptDir(root);
  if (!existsSync(d)) return 0;
  const cited = new Set<string>();
  const add = (r: FactRecord) => { for (const s of r.sources ?? []) cited.add(keptName(typeof s === "string" ? s : s.ref)); };
  for (const n of notes) {
    for (const r of (Array.isArray(n.fm.candidates) ? n.fm.candidates : []) as FactRecord[]) add(r); // a conflict packet's sides
    for (const f of Object.values(n.fm.facts ?? {})) (isDisputed(f) ? f.candidates : isList(f) ? f.items : [f as FactRecord]).forEach(add);
    for (const h of Object.values(n.fm.history ?? {})) for (const r of (Array.isArray(h) ? h : []) as FactRecord[]) add(r);
  }
  let n = 0;
  for (const f of readdirSync(d)) if (f.endsWith(".quote") && !cited.has(f)) { rmSync(join(d, f), { force: true }); n++; }
  return n;
}
