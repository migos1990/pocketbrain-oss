// SPDX-License-Identifier: AGPL-3.0-only
// What waits on the owner, one counted list (G626): the north star's asks and the owner's home
// count the same items. Every open decision the hub won't file on its own (src/textline/items.ts
// openItems, less src/filing.ts autoSaves and its queues), the other cards that wait for a tap, a
// capture held past its day, and each value the serving hold keeps until the owner taps Show it
// (src/seen.ts), and a question about a class the owner may teach (src/teaching.ts, G715). The
// home lists conflicts, held mail, held values and the teaching questions itself; the rest wait on
// Settings, and the home counts them under one heading that links there.
// What counts here is the owner's to change (scripts/north-star.ts head); G626 rests on the
// owner's "i trust u" of 2026-11-02 00:18Z and the coordinator's pick of option 1, as G618 did.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { openItems, type Item } from "./textline/items";
import { autoSaves, newQueues, heldByAccess, type Queues } from "./filing";
import { heldCount } from "./capture";
import { inboxConflicts } from "./settle-inbox";
import { unseenFacts } from "./seen";
import { waitingTeachAsks } from "./teaching";
import { waitingLinkAsks } from "./dangling";

const DECISIONS = new Set(["dispute", "proposal", "held-answer"]);
// Cards that ask for a tap but aren't a fact decision: held mail, a capture, an upkeep run, rules, spend.
const OTHER_ASKS = new Set(["mail", "capture", "upkeep", "rules", "usage"]);
// Kinds the home lists itself; a proposal it lists only when it is a conflict (settle-inbox.ts).
const ON_HOME = new Set(["dispute", "mail"]);

export interface OwnerAsks {
  by: Record<string, number>; // each ask under its kind, a held proposal under its rule's name
  waiting: Item[]; // the decisions (disputes, proposals, held answers) that ask
  other: Item[]; // the other cards that ask
  stuck: number; // captures held past their day
  serving: number; // values the serving hold keeps for Show it
  teach: number; // questions about a class the owner may teach, answered on the home
  link: number; // questions about a fact linking a page the brain doesn't have, answered on the home (G749)
  total: number;
  settings: number; // asks the home doesn't list itself: they wait on Settings
  queues: Queues;
  homeConflicts: Set<string>;
  byAccess: Set<string>;
}

const reasonOf = (root: string, file: string): string => {
  try { return String((YAML.parse(readFileSync(join(root, "inbox", file), "utf8")) as { reason?: unknown }).reason ?? ""); } catch { return ""; }
};
export const changesHeld = (root: string, file: string) => /\bchanges \S+ from\b/.test(reasonOf(root, file));

// `now` is when the hub would file (autoSaves); `later` is when the items are read, so a conflict
// the Gardener holds for the night counts once its fallback releases it (the north star reads 36 h on).
export function ownerAsks(root: string, now = new Date(), later = now): OwnerAsks {
  const items = openItems(root, later);
  const queues = newQueues();
  const saves = autoSaves(root, now, undefined, queues);
  const homeConflicts = new Set(inboxConflicts(root).map((c) => c.file));
  const byAccess = new Set(items.filter((i) => i.kind === "proposal" && !homeConflicts.has(i.ref) && !changesHeld(root, i.ref) && heldByAccess(reasonOf(root, i.ref))).map((i) => i.ref));
  const waiting = items.filter((i) => DECISIONS.has(i.kind) && !(i.kind === "proposal" && (saves.has(i.ref) || queues.held.has(i.ref) || queues.expiring.has(i.ref) || queues.setAside.has(i.ref))));
  // A proposal the home lists as a conflict is asked there, as a conflict, whatever rule held it (G622).
  const heldBy = (ref: string) => homeConflicts.has(ref) ? undefined : byAccess.has(ref) ? "held_by_access" : queues.byCapture.has(ref) ? "held_by_capture" : queues.byAmbiguity.has(ref) ? "held_by_ambiguity" : undefined;
  const by: Record<string, number> = {};
  for (const i of waiting) { const k = (i.kind === "proposal" && heldBy(i.ref)) || i.kind; by[k] = (by[k] ?? 0) + 1; }
  const other = items.filter((i) => OTHER_ASKS.has(i.kind));
  for (const i of other) by[i.kind] = (by[i.kind] ?? 0) + 1;
  const stuck = heldCount(root, { stuck: true });
  if (stuck) by.held = stuck;
  const serving = unseenFacts(root).length;
  if (serving) by.held_by_serving = serving;
  const teach = waitingTeachAsks(root).length;
  if (teach) by.teach = teach;
  const link = waitingLinkAsks(root).length;
  if (link) by.link = link;
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  const onHome = [...waiting, ...other].filter((i) => ON_HOME.has(i.kind) || (i.kind === "proposal" && homeConflicts.has(i.ref))).length + serving + teach + link;
  return { by, waiting, other, stuck, serving, teach, link, total, settings: total - onHome, queues, homeConflicts, byAccess };
}
