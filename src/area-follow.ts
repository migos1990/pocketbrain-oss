// SPDX-License-Identifier: AGPL-3.0-only
// A person's page follows the workplace the owner names (G664, the Oliver case): a page filed
// in an area by an org link that turned out wrong had no way to move. When the owner's own word
// sets or changes `org` on a person page, and the page sits in the area of the org it linked
// before (or had none), the page moves to the new org page's area: one owner commit naming the
// org commit (`Area-Follows:`), and a `moved` diary line whose Undo puts the old area back.
//
// Only the owner's word moves a page, so this is the owner tightening or loosening by his own
// act (invariant 4); a source, an assistant, the Gardener, filing and upkeep never call it. Only
// `area:` changes: sensitivity, share_with and by-name excludes stay as they are. The four owner
// paths (the box and the page's box in owner-say.ts, Settle in core.ts and settle-inbox.ts, the
// editor's set-fact in edit.ts) call followArea after their commit, and nothing else does.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseNote, loadBrain, linksIn, today, type Note } from "./brain";
import { commitPaths, gitRun } from "./git";
import { appendDiary, diaryRow, readDiary, type DiaryRow } from "./diary";
import { compareKey } from "./normalize";
import { isOwnerId, OWNER } from "./owner";
import { clock } from "./clock";
import { coOwnerOf, type Rules } from "./rules";
import { carve, grantFor } from "./carve";

export interface AreaMove { id: string; from: string; to: string; commit: string }

const orgValue = (n: Note | undefined): string | undefined => {
  const f = n?.fm.facts?.org as { value?: unknown; items?: unknown; candidates?: unknown } | undefined;
  return f && typeof f.value === "string" ? f.value : undefined;
};

// The org page a value names: a [[link]] by id, else the one org page carrying that name, in its
// title, one of its names ("Northwind / Brightwell" carries both) or an alias. Two pages carrying it
// name none: the page never picks one (an import's two-name page, until its split leaves one).
// A folded twin is gone, so it never counts.
function orgPage(notes: Note[], value: string | undefined): Note | undefined {
  if (!value) return undefined;
  const name = (linksIn(value)[0] ?? value).trim();
  const byId = notes.find((x) => x.fm.id === name);
  if (byId) return byId.fm.type === "org" ? byId : undefined;
  const key = compareKey(name);
  const names = (n: Note) => [String(n.fm.title ?? ""), ...((n.fm.aliases ?? []) as unknown[]).map(String)].flatMap((t) => [t, ...t.split(/\s*\/\s*/)]).map(compareKey);
  const fits = notes.filter((n) => n.fm.type === "org" && names(n).includes(key));
  return fits.length === 1 ? fits[0] : undefined;
}

// Whether a collaborator's or a co-owner's assistant would see the page in `to` and doesn't now.
function outsiderWouldGain(notes: Note[], rules: Rules, note: Note, to: string): boolean {
  const outsiders = Object.entries(rules.policy.agents ?? {}).filter(([k, a]) => !!(a as { collaborator?: unknown }).collaborator || !!coOwnerOf(rules, k)).map(([k]) => k);
  if (!outsiders.length) return false;
  const after = notes.map((n) => n === note ? { ...n, fm: { ...n.fm, area: to } } : n);
  return outsiders.some((k) => {
    const g = grantFor(rules, k);
    return !carve(notes, rules, g).visible.has(note.fm.id) && carve(after, rules, g).visible.has(note.fm.id);
  });
}

// Who last set a page's area: the newest commit that made the page (its maker, `by:`) or changed
// its area: line (that commit's author; write() sends an assistant's area change to the owner).
function areaSetByOwnerOrHub(root: string, rules: Rules, n: Note): boolean {
  for (const line of gitRun(root, ["log", "--format=%H%x00%an", "--", n.path]).out.split("\n")) {
    const [h, author] = line.split("\0");
    if (!h) continue;
    const a = noteAt(root, h, n.path), b = noteAt(root, `${h}^`, n.path);
    if (b && String(a?.fm.area ?? "") === String(b.fm.area ?? "")) continue;
    // The commit that made the page is judged by the page's own `by:`, since an accepted proposal
    // is committed as the owner and a filing save as the hub, with the assistant's chosen area.
    const who = b ? String(author ?? "") : String(a?.fm.by ?? "");
    if (isOwnerId(who, rules.policy.owner?.name)) return true;
    const agents = rules.policy.agents ?? {};
    // A page with no `by:` was written by hand or an import, never by write(), which always sets it.
    if (!who) return true;
    return !Object.keys(agents).some((k) => k.toLowerCase() === who.toLowerCase() || String((agents[k] as { label?: unknown }).label ?? "").toLowerCase() === who.toLowerCase());
  }
  return false;
}

// The note as a commit holds it, never a second load of the working tree.
function noteAt(root: string, sha: string, path: string): Note | undefined {
  const r = gitRun(root, ["show", `${sha}:${path}`]);
  if (!r.ok) return undefined;
  try { return parseNote(r.out, path); } catch { return undefined; }
}

// After an owner write of `<id>#org`: move the page when its area came from the org it linked
// before. Returns the move, or undefined when nothing moves.
export function followArea(root: string, rules: Rules, factKey: string | undefined): AreaMove | undefined {
  if (!factKey || !factKey.endsWith("#org")) return undefined;
  const id = factKey.slice(0, -"#org".length);
  const notes = loadBrain(root);
  const note = notes.find((n) => n.fm.id === id);
  if (!note || note.fm.type !== "person") return undefined;
  // The owner's last change of the org (the hub's page text may follow it), and the org the page
  // had before it named this one: a value naming the same org page again (re-said, or said by id
  // once an import's split left one page) is skipped, back to the org the page's area came from.
  const changes: { sha: string; owner: boolean; before?: string; after?: string; note?: Note }[] = [];
  for (const line of gitRun(root, ["log", "-20", "--format=%H%x00%an", "--", note.path]).out.split("\n")) {
    const [h, author] = line.split("\0");
    if (!h) continue;
    const a = noteAt(root, h, note.path), b = noteAt(root, `${h}^`, note.path);
    if (orgValue(a) === orgValue(b)) continue;
    changes.push({ sha: h, owner: isOwnerId(author ?? "", rules.policy.owner?.name), before: orgValue(b), after: orgValue(a), note: a });
  }
  const last = changes[0];
  if (!last?.owner || !last.after) return undefined;
  const sha = last.sha, now = last.after, after = last.note;
  const newOrg = orgPage(notes, now);
  if (!newOrg) return undefined;
  let was = last.before;
  for (const c of changes) { was = c.before; if (orgPage(notes, was)?.fm.id !== newOrg.fm.id) break; }
  const area = String(after?.fm.area ?? "");
  if (!area) return undefined; // a page with no area isn't in any area's slice to move out of
  const oldOrg = orgPage(notes, was);
  // The area moved into is never an assistant's choice: the org page's area was set (the page made,
  // or its area: changed) by the owner or the hub's own code, never by an agent's write (security
  // review of #102: an assistant could make the org page first, in an area it reads).
  if (!areaSetByOwnerOrHub(root, rules, newOrg)) return undefined;
  const to = String(newOrg.fm.area ?? "");
  if (!to || to === area || !Object.hasOwn(rules.policy.areas ?? {}, to)) return undefined;
  // The page's area came from its old org, or it had none: anything else the owner chose.
  if (was !== undefined && String(oldOrg?.fm.area ?? "") !== area) return undefined;
  if (String(note.fm.area ?? "") !== area) return undefined;
  // A move is the owner's act for his own assistants only: one that would hand the page to someone
  // else's (a collaborator's share, a co-owner's assistant) leaves it where it is, since sharing
  // with a person is its own shown step (builder's slice audit of #102).
  if (outsiderWouldGain(notes, rules, note, to)) return undefined;
  return moveArea(root, note, area, to, sha);
}

// The page's text with its front matter's `area:` set, or undefined when the front matter has no
// `area:` line (a line in the body is never touched).
function withArea(text: string, area: string): string | undefined {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m || !/^area:[^\n]*$/m.test(m[1]!)) return undefined;
  const fm = m[1]!.replace(/^area:[^\n]*$/m, `area: ${area}`);
  return fm === m[1] ? undefined : `---\n${fm}\n---${text.slice(m[0].length)}`;
}

function moveArea(root: string, note: Note, from: string, to: string, follows: string): AreaMove | undefined {
  const file = join(root, note.path);
  const text = readFileSync(file, "utf8");
  const moved = withArea(text, to);
  if (!moved) return undefined;
  writeFileSync(file, moved);
  const at = clock().toISOString(), d = today();
  const row: DiaryRow = { ...diaryRow({ at, factKey: `${note.fm.id}#`, title: String(note.fm.title ?? note.fm.id), kind: "moved", from, to, incoming: { value: to, as_of: d, sources: [], verification: "confirmed-by-owner", by: OWNER, recorded: d } as never, rank: 5, sensitivity: note.fm.sensitivity ?? "personal" }), follows };
  const diary = appendDiary(root, row, d.slice(0, 7));
  const failed = commitPaths(root, [note.path, diary], `move ${note.fm.id} to ${to}, with its workplace\n\nArea-Follows: ${follows}\nKind: area-follows`, OWNER);
  if (failed) { writeFileSync(file, text); return undefined; }
  return { id: note.fm.id, from, to, commit: gitRun(root, ["rev-parse", "HEAD"]).out.trim() };
}

// Undo of a moved line: the old area back, as the owner; refused when the page moved again or was
// merged or forgotten away, never written to a page that isn't there.
export function undoMove(root: string, row: DiaryRow): "undone" | "changed_since" {
  const id = row.fact_key.replace(/#$/, "");
  const note = loadBrain(root).find((n) => n.fm.id === id);
  if (!note || !existsSync(join(root, note.path)) || String(note.fm.area ?? "") !== String(row.to) || typeof row.from !== "string") return "changed_since";
  const file = join(root, note.path), text = readFileSync(file, "utf8");
  const back = withArea(text, row.from);
  if (!back) return "changed_since";
  writeFileSync(file, back);
  const at = clock().toISOString(), d = today();
  const diary = appendDiary(root, { ...diaryRow({ at, factKey: row.fact_key, title: row.title, kind: "undone", from: undefined, to: undefined, incoming: { value: undefined, as_of: d, sources: [], verification: "confirmed-by-owner", by: OWNER, recorded: d } as never, rank: 5, sensitivity: row.sensitivity }), undoes: row.undo_token }, d.slice(0, 7));
  const failed = commitPaths(root, [note.path, diary], `move ${id} back to ${row.from}\n\nUndoes: ${row.follows ?? ""}\nKind: area-follows-undo`, OWNER);
  if (failed) { writeFileSync(file, text); return "changed_since"; }
  return "undone";
}

// Whether a moved line's page has been moved back (its undone row exists).
export const movedUndone = (root: string, token: string) => readDiary(root).some((r) => r.undoes === token);
