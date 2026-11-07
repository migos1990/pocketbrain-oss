// SPDX-License-Identifier: AGPL-3.0-only
// One thing, one page (docs/fold-twins.md; owner's phone, 2026-11-03, G635, G644). A writer that files a
// page into an area or level it can't see gets a new page each time, with a random suffix, so its
// reply never says a hidden page exists (G28). The hub sees everything: it folds such a twin into
// the older page with the same name, so Memory says the thing once. Only pages that are surely one
// thing fold: same folder, type, name, area and level, both active, of a kind where a name names one
// thing (projects, organisations). Two write-ups of one meeting stay upkeep's possible-duplicate line:
// each has its own prose. People have their own proposal
// (src/sameperson.ts); decisions, money and events with one name can be two (a 2025 and a 2026
// "Pick a bank"). The fold is mergeNotes, which picks no winner (a disagreement becomes a conflict
// the owner settles) and refuses what would change any assistant's view (mergeBlocked,
// brainChanges); an open conflict on either page holds the fold until it is settled. Undo takes
// back what the fold changed and keeps later writes. Nothing here is told to the writer.
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import type { Note } from "./brain";
import { loadBrain, linksIn, parseNote, saveNote } from "./brain";
import { loadRules } from "./rules";
import { compareKey } from "./normalize";
import { mergeBlocked, brainChanges, mergeNotes, planMerge } from "./merge";
import { derivedSince } from "./sameperson";
import { git, commitPaths } from "./git";
import { CoreError } from "./core";
import { appendJsonl, readJsonl } from "./util";
import { appendDiary, diaryRow, readDiary } from "./diary";
import { clock } from "./clock";
import { OWNER } from "./owner";
import { today } from "./brain";

export const FOLD_AUTHOR = "reflect";
const FOLDABLE = new Set(["project", "org"]);
const foldsFile = (root: string) => join(root, "log", "folds.jsonl");

export interface Twin { keep: string; drop: string }
// The fold log, hub state: one line per fold, and one per undo naming the fold and its own commit.
export interface FoldLine { keep?: string; drop?: string; commit?: string; undone?: string; undo_commit?: string; at: string }
export const foldLog = (root: string) => readJsonl<FoldLine>(foldsFile(root));
export interface Fold extends Twin { commit?: string; disputes: number }
export interface FoldReport { folds: Fold[]; refused: (Twin & { why: string })[]; disputes: number }

const folder = (id: string) => id.slice(0, id.lastIndexOf("/"));
// The page that stays: the plain id first (it was there before any blind writer; a blind writer's
// suffix is six hex characters with a digit, never a word like "decade"), then the one more pages
// link to (fewer repoints; the id assistants know stays), then the first made, then the id.
export const blindId = (id: string) => /-(?=[0-9a-f]*\d)[0-9a-f]{6}$/.test(id);
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

// Undo a fold, even after later writes (audit v11: it used to refuse once either page changed).
// It is a forward change, one commit: every file only the fold touched (and upkeep's repoints of
// links to the dropped page, and the page writer's text for these two pages) goes back as it was,
// a conflict the fold opened and nobody answered goes away, the dropped page comes back, and on
// the kept page each part the fold changed goes back unless a later write changed it again, which
// stays. It refuses, plainly, only when the dropped page itself changed since.
export function undoFold(root: string, commit: string): string {
  const f = foldLog(root) as { keep: string; drop: string; commit: string; undone?: string }[];
  const m = f.filter((x) => x.commit === commit && !x.undone).at(-1);
  if (!m || f.some((x) => x.undone === commit)) throw new CoreError(404, `no fold ${commit.slice(0, 7)} to undo`);
  const notes = loadBrain(root);
  const rel = (p: string) => p.startsWith(root) ? p.slice(root.length + 1) : p;
  const pathOf = (id: string) => { const n = notes.find((x) => x.fm.id === id); return n ? rel(n.path) : undefined; };
  const keepPath = pathOf(m.keep), dropPath = pathOf(m.drop);
  if (!keepPath || !dropPath) throw new CoreError(409, `${!keepPath ? m.keep : m.drop} is gone since the fold; nothing changed`);
  const paths = [keepPath, dropPath];
  const derived = derivedSince(root, { ...m, id: "", evidence: [], at: "" }).filter((c) => /^reflect: repoint links in /.test(git(root, ["show", "-s", "--format=%s", c]))
    || git(root, ["show", "--name-only", "--format=", c]).split("\n").filter(Boolean).every((x) => paths.includes(x)));
  const ours = new Set([m.commit, ...derived]);
  const filesOf = (c: string) => git(root, ["show", "--name-only", "--no-renames", "--format=", c]).split("\n").filter(Boolean);
  const touched = [...new Set([...ours].flatMap(filesOf))];
  const at = (rev: string, file: string): string | undefined => { const r = Bun.spawnSync(["git", "show", `${rev}:${file}`], { cwd: root }); return r.exitCode === 0 ? r.stdout.toString() : undefined; };
  const others = (file: string) => git(root, ["log", "--format=%H", `${m.commit}^..HEAD`, "--", file]).split("\n").filter((c) => c && !ours.has(c));
  if (others(dropPath).length) throw new CoreError(409, `the folded page ${m.drop} changed since the fold, so it can't come back as it was; nothing changed`);
  const changed: string[] = [];
  for (const file of touched) {
    const before = at(`${m.commit}^`, file);
    if (!others(file).length) {
      if (before === undefined) rmSync(join(root, file), { force: true }); else writeFileSync(join(root, file), before);
      changed.push(file);
    } else if (file === keepPath && before !== undefined) {
      const was = parseNote(before, file), after = parseNote(at(m.commit, file) ?? "", file);
      const now = structuredClone(notes.find((n) => n.fm.id === m.keep)!);
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      const back = (into: Record<string, unknown>, a: Record<string, unknown>, b: Record<string, unknown>, skip: string[]) => {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b), ...Object.keys(into)])) {
          if (skip.includes(k) || !same(into[k], a[k]) || same(a[k], b[k])) continue;
          if (b[k] === undefined) delete into[k]; else into[k] = structuredClone(b[k]);
        }
      };
      back(now.fm as never, after.fm as never, was.fm as never, ["facts", "history", "updated"]);
      for (const part of ["facts", "history"] as const) {
        const into = ((now.fm as Record<string, unknown>)[part] ??= {}) as Record<string, unknown>;
        back(into, ((after.fm as Record<string, unknown>)[part] ?? {}) as never, ((was.fm as Record<string, unknown>)[part] ?? {}) as never, []);
        if (!Object.keys(into).length) delete (now.fm as Record<string, unknown>)[part];
      }
      // The page writer may have written this page's text since (one of ours): its text from
      // before the fold comes back unless a person wrote it since.
      const bodies = [m.commit, ...derived].map((c) => at(c, file)).filter((t): t is string => t !== undefined).map((t) => parseNote(t, file).body);
      if (bodies.includes(now.body)) now.body = was.body;
      saveNote(root, now);
      changed.push(file);
    }
    // Any other file a later write changed (a conflict answered since, a page edited since) stays:
    // its link to the kept page still leads somewhere true.
  }
  // The home's line for this fold says Undone, whichever door undid it.
  const line = readDiary(root).find((r) => r.kind === "folded" && r.fold === m.commit);
  if (line && !readDiary(root).some((r) => r.undoes === line.undo_token)) {
    const at = clock().toISOString(), d = today();
    changed.push(appendDiary(root, { ...diaryRow({ at, factKey: line.fact_key, title: line.title, kind: "undone", from: undefined, to: undefined, incoming: { value: undefined, as_of: d, sources: [], verification: "confirmed-by-owner", by: OWNER, recorded: d } as never, rank: 5, sensitivity: line.sensitivity }), undoes: line.undo_token }, d.slice(0, 7)));
  }
  const failed = commitPaths(root, changed, `undo fold of ${m.drop} into ${m.keep}\n\nReverts ${m.commit}, keeping later writes.\nKind: fold-undo`, FOLD_AUTHOR);
  if (failed) throw new CoreError(409, `the undo wasn't saved (${failed}); nothing changed`);
  appendJsonl(foldsFile(root), { undone: m.commit, undo_commit: git(root, ["rev-parse", "HEAD"]), at: new Date().toISOString() });
  return `undid the fold of ${m.drop} into ${m.keep}`;
}
