// SPDX-License-Identifier: AGPL-3.0-only
// Pages placed in an area by a word guess (G842). Until G841 the capture path gave a new page the
// area of any page that shared one word of its title with the mail it came from: a ride receipt
// "in Montréal" went to the area of an organisation whose name carries the city, and every
// assistant reading that area read it. New pages no longer get an area that way
// (`newPageArea` in capture.ts); this finds the pages that did, so the night pass can put each one
// back in the default area, as one `moved` diary line with Undo.
//
// A page counts when the capture path made it (its `by:` is a capture agent), it sits outside the
// area the rule gives now, nothing since has moved it, nothing structural explains its area (a
// source configured with that area, a page there that it links or that links it, a page there it
// names by its whole title), and the move hands no assistant more than it reads now (`neverWider`).
// Off until the owner says so (`pocketbrain areas unguess on`, policy.yaml `areas_unguess.move`):
// a count on the night pass and `pocketbrain areas guessed` until then.
import type { Note } from "./brain";
import { loadBrain, linksIn, parseNote } from "./brain";
import { gitRun } from "./git";
import { isOwnerId } from "./owner";
import { loadRules, type Rules } from "./rules";
import { captureAgents, newPageArea } from "./capture";
import { loadSources } from "./pull";
import { moveArea, moveNeverWider, type AreaMove } from "./area-follow";
import { setRulesKeys, OwnerSetError } from "./ownerset";

export interface GuessedArea { id: string; from: string; to: string }

const PAGE_TYPES = new Set(["person", "org", "project", "decision", "money"]);



// The words a page says about itself: its title, aliases and its facts' text values.
function pageWords(n: Note): string {
  const out: string[] = [String(n.fm.title ?? ""), ...((n.fm.aliases ?? []) as unknown[]).map(String)];
  for (const f of Object.values(n.fm.facts ?? {})) {
    const recs = [f, ...(((f as { items?: unknown[] }).items ?? []) as unknown[])];
    for (const r of recs) { const v = (r as { value?: unknown } | undefined)?.value; if (typeof v === "string") out.push(v); }
  }
  return out.join("\n");
}

// Whether anyone changed the page's area after the commit that made it, or the owner made it (an
// accepted proposal, whose area the owner could edit before accepting): the owner's placement is
// never touched.
function movedSince(root: string, n: Note, rules: Rules): boolean {
  const log = gitRun(root, ["log", "--format=%H%x00%an", "--", n.path]).out.split("\n").filter(Boolean).map((l) => l.split("\0") as [string, string]);
  const areaAt = (sha: string) => { const r = gitRun(root, ["show", `${sha}:${n.path}`]); if (!r.ok) return undefined; try { return String(parseNote(r.out, n.path).fm.area ?? ""); } catch { return undefined; } };
  const made = log.at(-1);
  if (!made || isOwnerId(made[1], rules.policy.owner?.name)) return true;
  // Newest first; any later commit whose area differs from its parent's moved it.
  for (const [sha] of log.slice(0, -1)) {
    const a = areaAt(sha), b = areaAt(`${sha}^`);
    if (b !== undefined && a !== b) return true;
  }
  return false;
}

export function guessedAreas(root: string, notes: Note[] = loadBrain(root), rules: Rules = loadRules(root)): GuessedArea[] {
  const makers = new Set(captureAgents(rules).map((a) => a.toLowerCase()));
  const sourceAreas = new Set(Object.values(loadSources(root).sources ?? {}).flatMap((s) => [s?.area, ...(s?.forwarded ?? []).map((f) => f.area)]).filter((a): a is string => typeof a === "string"));
  const byId = new Map(notes.map((n) => [n.fm.id, n] as const));
  const linksOf = (n: Note) => linksIn(`${pageWords(n)}\n${n.body ?? ""}`);
  const out: GuessedArea[] = [];
  for (const n of notes) {
    const from = String(n.fm.area ?? "");
    if (!from || !PAGE_TYPES.has(n.fm.type) || n.fm.status !== "active") continue;
    const by = String(n.fm.by ?? "").toLowerCase();
    if (!by || !makers.has(by)) continue;
    if (sourceAreas.has(from)) continue;
    // An explicit link either way with a page there whose own area is grounded (not placed by the
    // capture path): a guess never explains another guess.
    const grounded = (o: Note | undefined) => !!o && o !== n && o.fm.area === from && !makers.has(String(o.fm.by ?? "").toLowerCase());
    if (linksOf(n).some((id) => grounded(byId.get(id)))) continue;
    if (notes.some((o) => grounded(o) && linksOf(o).includes(n.fm.id))) continue;
    const to = newPageArea(rules);
    if (!to || to === from) continue;
    if (!moveNeverWider(rules, n, to)) continue;
    if (movedSince(root, n, rules)) continue;
    out.push({ id: n.fm.id, from, to });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// The night pass: with the owner's switch on, each page goes back to the default area, one commit
// and one `moved` diary line each, whose Undo puts it back where it was.
export function unguessAreas(root: string, apply: boolean): { pages: GuessedArea[]; moved: AreaMove[] } {
  const notes = loadBrain(root);
  const pages = guessedAreas(root, notes);
  if (!apply) return { pages, moved: [] };
  const moved: AreaMove[] = [];
  for (const p of pages) {
    const n = notes.find((x) => x.fm.id === p.id);
    if (!n) continue;
    const m = moveArea(root, n, p.from, p.to, "word-guess", { subject: "its area was a word guess", kind: "area-unguess", author: "hub" });
    if (m) moved.push(m);
  }
  return { pages, moved };
}

export const unguessOn = (rules: Rules) => (rules.policy as { areas_unguess?: { move?: boolean } }).areas_unguess?.move === true;

// `pocketbrain areas unguess on|off`: whether the night pass moves those pages or only counts them.
export function setAreasUnguess(root: string, mode: string): string {
  if (mode !== "on" && mode !== "off") throw new OwnerSetError("areas unguess on | off");
  return setRulesKeys(root, "policy.yaml", { areas_unguess: { move: mode === "on" } }, `areas unguess ${mode}`);
}

// Pages not filed yet (src/carve.ts isUnfiled) whose source now has an area: the owner set where
// that source's pages go, so each moves there and is filed, one commit and one `moved` diary line
// each, whose Undo puts back the area and the mark. A mark that names no source, or a source still
// with no area, waits for the owner to place the page.
export interface UnfiledMove { id: string; source: string; from: string; to: string }
export function unfiledToFile(root: string, notes: Note[] = loadBrain(root)): UnfiledMove[] {
  const sources = loadSources(root).sources ?? {};
  const out: UnfiledMove[] = [];
  for (const n of notes) {
    const source = n.fm.unfiled;
    if (typeof source !== "string" || !source || n.fm.status !== "active") continue;
    const to = sources[source]?.area;
    if (typeof to !== "string" || !to) continue;
    out.push({ id: n.fm.id, source, from: String(n.fm.area ?? ""), to });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
export function fileUnfiled(root: string): AreaMove[] {
  const notes = loadBrain(root), moved: AreaMove[] = [];
  for (const p of unfiledToFile(root, notes)) {
    const n = notes.find((x) => x.fm.id === p.id);
    if (!n) continue;
    const m = moveArea(root, n, p.from, p.to, `source:${p.source}`, { subject: `filed by its source's area (${p.source})`, kind: "unfiled-lift", author: "hub", file: true });
    if (m) moved.push(m);
  }
  return moved;
}
