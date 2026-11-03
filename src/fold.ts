// SPDX-License-Identifier: AGPL-3.0-only
// One thing, one page (docs/fold-twins.md; owner's phone, 2026-11-03, G635). A writer that files a
// page into an area or level it can't see gets a new page each time, with a random suffix, so its
// reply never says a hidden page exists (G28). The hub sees everything: it folds such a twin into
// the older page with the same name, so Memory says the thing once. Only pages that are surely one
// thing fold: same folder, type, name, area and level, both active, of a kind where a name names one
// thing (projects, organisations). Two write-ups of one meeting stay upkeep's possible-duplicate line:
// each has its own prose. People have their own proposal
// (src/sameperson.ts); decisions, money and events with one name can be two (a 2025 and a 2026
// "Pick a bank"). The fold is mergeNotes, which picks no winner (a disagreement becomes a conflict
// the owner settles) and refuses what would change any assistant's view (mergeBlocked,
// brainChanges); an open conflict on either page holds the fold until it is settled. Undo reverts
// the fold while neither page changed since. Nothing here is told to the writer.
import { join } from "node:path";
import type { Note } from "./brain";
import { loadBrain, linksIn } from "./brain";
import { loadRules } from "./rules";
import { compareKey } from "./normalize";
import { mergeBlocked, brainChanges, mergeNotes, planMerge } from "./merge";
import { derivedSince } from "./sameperson";
import { git, gitRun, authorEnv } from "./git";
import { hubGate } from "./hub";
import { CoreError } from "./core";
import { appendJsonl, readJsonl } from "./util";

export const FOLD_AUTHOR = "reflect";
const FOLDABLE = new Set(["project", "org"]);
const foldsFile = (root: string) => join(root, "log", "folds.jsonl");

export interface Twin { keep: string; drop: string }
export interface Fold extends Twin { commit?: string; disputes: number }
export interface FoldReport { folds: Fold[]; refused: (Twin & { why: string })[]; disputes: number }

const folder = (id: string) => id.slice(0, id.lastIndexOf("/"));
// The page that stays: the plain id first (it was there before any blind writer; a blind writer's
// suffix is six hex characters with a digit, never a word like "decade"), then the one more pages
// link to (fewer repoints; the id assistants know stays), then the first made, then the id.
const blindId = (id: string) => /-(?=[0-9a-f]*\d)[0-9a-f]{6}$/.test(id);
function keeper(notes: Note[]): (a: Note, b: Note) => number {
  const inbound = new Map<string, number>();
  for (const n of notes) for (const t of new Set(linksIn(n.body ?? ""))) inbound.set(t, (inbound.get(t) ?? 0) + 1);
  return (a, b) => Number(blindId(a.fm.id)) - Number(blindId(b.fm.id)) || (inbound.get(b.fm.id) ?? 0) - (inbound.get(a.fm.id) ?? 0) || String(a.fm.created).localeCompare(String(b.fm.created)) || a.fm.id.localeCompare(b.fm.id);
}

// Every page that folds into an older one, oldest kept first.
export function findTwins(notes: Note[]): Twin[] {
  const groups = new Map<string, Note[]>();
  for (const n of notes) {
    if (n.fm.status !== "active" || !FOLDABLE.has(n.fm.type) || n.fm.merged_into) continue;
    const k = [folder(n.fm.id), n.fm.type, compareKey(n.fm.title), n.fm.area ?? "", n.fm.sensitivity ?? ""].join("\0");
    groups.set(k, [...(groups.get(k) ?? []), n]);
  }
  const older = keeper(notes);
  return [...groups.values()].filter((g) => g.length > 1).flatMap((g) => { const [keep, ...rest] = [...g].sort(older); return rest.map((d) => ({ keep: keep!.fm.id, drop: d.fm.id })); });
}

// An open conflict that names either page holds the fold: the owner settles it first, so one fact
// never waits twice (once as the conflict, once as the fold's own).
// The reason names the conflicts by id (slugs, never values) for the owner's dry run; upkeep's
// finding only counts held folds and never shows it.
function openConflict(notes: Note[], t: Twin): string | undefined {
  const on = (k: unknown) => typeof k === "string" && [t.keep, t.drop].some((id) => k.startsWith(`${id}#`));
  const ids = notes.filter((n) => n.fm.type === "dispute" && n.fm.status === "open" && (on(n.fm.fact_key) || on((n.fm as { other_key?: string }).other_key))).map((n) => n.fm.id);
  return ids.length ? `settle ${ids.join(", ")} first (an open conflict on one of the pages); it folds on the next night after` : undefined;
}

// A dry run says what would fold and how many conflicts the folds would open; apply folds them.
export function foldTwins(root: string, opts: { apply: boolean; run?: string }): FoldReport {
  const out: FoldReport = { folds: [], refused: [], disputes: 0 };
  const planned = new Map<string, Note>();
  for (const t of findTwins(loadBrain(root))) {
    const notes = loadBrain(root), rules = loadRules(root);
    const keep = notes.find((n) => n.fm.id === t.keep), drop = notes.find((n) => n.fm.id === t.drop);
    if (!keep || !drop || keep.fm.status !== "active" || drop.fm.status !== "active") continue;
    // A dry run of three or more twins weighs each against the kept page as the earlier ones left it.
    const kept = planned.get(t.keep) ?? keep;
    const held = openConflict(notes, t) ?? (mergeBlocked(rules, kept, drop, undefined, notes) ?? brainChanges(rules, notes, kept, drop));
    if (held) { out.refused.push({ ...t, why: held }); continue; }
    const plan = planMerge(kept, drop, () => "c-fold-check");
    const disputes = plan.r.disputes.length;
    if (!opts.apply) { planned.set(t.keep, plan.keep); out.folds.push({ ...t, disputes }); out.disputes += disputes; continue; }
    const r = mergeNotes(root, t.keep, t.drop, FOLD_AUTHOR);
    if (!r.ok) { out.refused.push({ ...t, why: r.message }); continue; }
    const commit = git(root, ["rev-parse", "HEAD"]);
    appendJsonl(foldsFile(root), { keep: t.keep, drop: t.drop, commit, disputes: r.disputes.length, at: new Date().toISOString(), ...(opts.run ? { run: opts.run } : {}) });
    out.folds.push({ ...t, commit, disputes: r.disputes.length });
    out.disputes += r.disputes.length;
  }
  return out;
}

// Undo a fold while neither page changed since (the same rule as a person merge's Undo): upkeep's
// own link repoints and the page writer's text go back with it.
export function undoFold(root: string, commit: string): string {
  const f = readJsonl<{ keep: string; drop: string; commit: string; undone?: string }>(foldsFile(root));
  const m = f.filter((x) => x.commit === commit && !x.undone).at(-1);
  if (!m || f.some((x) => x.undone === commit)) throw new CoreError(404, `no fold ${commit.slice(0, 7)} to undo`);
  const notes = loadBrain(root);
  const paths = [m.keep, m.drop].map((id) => notes.find((n) => n.fm.id === id)?.path).filter((x): x is string => !!x).map((p) => p.startsWith(root) ? p.slice(root.length + 1) : p);
  // Only what was derived from this fold: upkeep's repoints of links to the dropped page, and the
  // page writer's text for these two pages (never another page's text written the same night).
  const derived = derivedSince(root, { ...m, id: "", evidence: [], at: "" }).filter((c) => /^reflect: repoint links in /.test(git(root, ["show", "-s", "--format=%s", c]))
    || git(root, ["show", "--name-only", "--format=", c]).split("\n").filter(Boolean).every((f) => paths.includes(f)));
  const later = git(root, ["log", "--format=%H", `${m.commit}..HEAD`, "--", ...paths]).split("\n").filter((c) => c && !derived.includes(c));
  if (later.length) throw new CoreError(409, `${m.keep} or ${m.drop} changed since the fold (${later.map((c) => c.slice(0, 7)).join(", ")}); undo those first or fix it by hand`);
  hubGate(root, ["revert"]);
  const r = Bun.spawnSync(["git", "revert", "--no-commit", ...derived, m.commit], { cwd: root, env: authorEnv(root, FOLD_AUTHOR) });
  if (r.exitCode !== 0) { Bun.spawnSync(["git", "revert", "--abort"], { cwd: root }); throw new CoreError(409, "a later change touched the same lines; undo it in git by hand"); }
  const done = gitRun(root, ["commit", "-q", "-m", `undo fold of ${m.drop} into ${m.keep}\n\nReverts ${m.commit}.`], FOLD_AUTHOR);
  if (!done.ok) { Bun.spawnSync(["git", "revert", "--abort"], { cwd: root }); Bun.spawnSync(["git", "reset", "-q", "--merge"], { cwd: root }); throw new CoreError(409, `the undo wasn't saved (${done.err || done.out}); nothing changed`); }
  Bun.spawnSync(["git", "revert", "--quit"], { cwd: root });
  appendJsonl(foldsFile(root), { undone: m.commit, at: new Date().toISOString() });
  return `undid the fold of ${m.drop} into ${m.keep}`;
}
