// SPDX-License-Identifier: AGPL-3.0-only
// One guess, then proposals only (audit v12, G680; the owner's choice, 2026-11-06). A trusted
// assistant's write commits, so a write refused for carrying a value it was never shown answers
// differently from one that commits, and each refusal would confirm a guess. After the first such
// refusal the hub puts that assistant on proposals only: every later write goes to the owner's
// inbox like a trial assistant's (a guess and a miss alike, src/write.ts proposesAnyway), and a
// journal line is refused whatever it says, until the owner lets it write again (Settings, or
// `pocketbrain write-hold clear <agent>`). One line per change in log/write-holds.jsonl.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appendJsonl, readJsonl } from "./util";

const FILE = ["log", "write-holds.jsonl"] as const;
interface HoldEvent { ev: "held" | "cleared"; agent: string; at: string; by?: string }

function events(root: string): HoldEvent[] {
  const f = join(root, ...FILE);
  return existsSync(f) ? readJsonl<HoldEvent>(f) : [];
}

// Each held assistant and the day its hold began, oldest first.
export function heldWriters(root: string): { agent: string; at: string }[] {
  const on = new Map<string, string>();
  for (const e of events(root)) { if (e.ev === "held") { if (!on.has(e.agent)) on.set(e.agent, e.at); } else if (e.ev === "cleared") on.delete(e.agent); }
  return [...on].map(([agent, at]) => ({ agent, at }));
}

export const writesHeld = (root: string, agent: string) => heldWriters(root).some((h) => h.agent === agent);

export function holdWrites(root: string, agent: string, now = new Date()) {
  if (!writesHeld(root, agent)) appendJsonl(join(root, ...FILE), { ev: "held", agent, at: now.toISOString() });
}

export function clearWriteHold(root: string, agent: string, by = "owner", now = new Date()): string {
  if (!writesHeld(root, agent)) return `${agent} isn't on proposals only`;
  appendJsonl(join(root, ...FILE), { ev: "cleared", agent, at: now.toISOString(), by });
  return `${agent} writes again: its facts file as before`;
}
