// SPDX-License-Identifier: AGPL-3.0-only
// What still waits for the owner, for tests: the open items (src/textline/items.ts) of one kind,
// minus the proposals the hub files on its own (src/filing.ts autoSaves). The old deck's cards were
// these; with the deck gone (outside review v5) a test asks this instead.
import { openItems, type Item } from "../src/textline/items";
import { autoSaves, failedSaves, verdict, newQueues } from "../src/filing";
import { loadBrain } from "../src/brain";
import { loadEscalation } from "../src/textline/policy";

export function asked(root: string, now = new Date(), kind?: Item["kind"]): Item[] {
  // A proposal held until its day (auto_decide.hold_assistants_until in rules/escalation.yaml) is a queue, not an ask.
  const queues = newQueues();
  const saves = autoSaves(root, now, undefined, queues);
  return openItems(root, now).filter((i) => (!kind || i.kind === kind) && !(i.kind === "proposal" && (saves.has(i.ref) || queues.held.has(i.ref))));
}

// What the hub would do with each open item, keyed by item: its plan (choice, when, why) or why it
// never decides it. Weighing an item starts its notice clock, as the old deck's build did.
export interface Weighed { auto?: { choice: string; at: string; why: string }; never_auto?: string }
export function weigh(root: string, now = new Date()): Map<string, Weighed> {
  const notes = loadBrain(root);
  const ctx = { notes };
  const p = loadEscalation(root);
  const out = new Map<string, Weighed>();
  const failed = failedSaves(root, now);
  for (const it of openItems(root, now)) {
    const v = verdict(root, it, p, ctx, now);
    // A save the hub tried and couldn't make isn't promised again (owner's phone, 2026-10-25).
    if ("plan" in v && failed.has(it.key)) out.set(it.key, { never_auto: "pocketBrain couldn't file this on its own, so it waits for you." });
    else out.set(it.key, "plan" in v ? { auto: { choice: v.plan.choice, at: v.plan.at, why: v.plan.why } } : { never_auto: v.never });
  }
  return out;
}
