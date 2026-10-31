// SPDX-License-Identifier: AGPL-3.0-only
// What the Gardener couldn't do (docs/gardener.md, "What it couldn't do"): a night can go by with
// no source to check facts against, or with cleanup never scheduled, and only doctor notices.
// Each blind spot names the one owner step that fixes it. The week report lists them all; the
// digest tells the owner once, then again a week later if it still holds. Counts and names of
// steps only: nothing from a note.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { today } from "./brain";
import { loadRules, gardeners } from "./rules";
import { gardenerConfig, nightMode } from "./gardener";
import { loadSources, recheckCandidates } from "./pull";
import { verifyLog } from "./evidence";
import { readJsonl } from "./util";

export type BlindKind = "no-sources" | "no-checks" | "no-config";
export interface BlindSpot { kind: BlindKind; what: string; fix: string }

const DAY = 86_400_000;
const daysAgo = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) - n * DAY).toISOString().slice(0, 10);

export function blindSpots(root: string, now = today()): BlindSpot[] {
  const rules = loadRules(root);
  const live = gardeners(rules).filter((g) => rules.policy.agents[g]?.status !== "paused");
  if (!live.length) return [];
  const out: BlindSpot[] = [];
  const sources = Object.keys(loadSources(root).sources ?? {});
  if (!sources.length) out.push({ kind: "no-sources", what: "The Gardener can't check any fact against its source: no source is connected, so nothing gets re-confirmed or caught when it changes.", fix: "Add a source (Gmail or Calendar) to rules/sources.yaml, then `pocketbrain sources connect <name>` (docs/sources-pull.md)." });
  else {
    // Sources, and facts waiting to be checked, but not one check in a week: the reads are failing.
    // A read that failed (unreachable) isn't a check: a lapsed sign-in fails every night's read.
    const since = daysAgo(now, 6);
    const checks = existsSync(verifyLog(root)) ? readJsonl<{ at?: string; result?: string }>(verifyLog(root)).filter((e) => String(e.at ?? "").slice(0, 10) >= since && e.result !== "unreachable").length : 0;
    const waiting = checks ? 0 : recheckCandidates(root).length;
    if (!checks && waiting) out.push({ kind: "no-checks", what: `The Gardener checked no fact at its source this week, though ${waiting} source item${waiting === 1 ? "" : "s"} wait${waiting === 1 ? "s" : ""} to be checked.`, fix: "Run `pocketbrain doctor`: a source's sign-in has likely lapsed (`pocketbrain sources connect <name>`)." });
  }
  if (nightMode(root) === "managed" && !gardenerConfig(root)) out.push({ kind: "no-config", what: "Session cleanup and token rotation have never run for the managed Gardener: rules/gardener.yaml is missing.", fix: "`pocketbrain gardener setup` writes it (docs/gardener.md)." });
  return out;
}

// The week report's lines.
export function blindSpotLines(root: string, now = today()): string[] {
  const b = blindSpots(root, now);
  return b.length ? ["What the Gardener couldn't do:", ...b.map((x) => `- ${x.what} ${x.fix}`), ""] : [];
}

// The digest's: each blind spot once, then again after RETELL_DAYS while it holds. The missing
// gardener.yaml is left out there: the hub's own check already says it every day.
export const RETELL_DAYS = 7;
const toldFile = (root: string) => join(root, "log", "gardener", "blind-told.json");
export function blindSpotNews(root: string, now = today()): string[] {
  const f = toldFile(root);
  let told: Record<string, string> = {};
  try { told = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {}; } catch { told = {}; }
  const due = blindSpots(root, now).filter((b) => b.kind !== "no-config" && (!told[b.kind] || told[b.kind] <= daysAgo(now, RETELL_DAYS)));
  if (!due.length) return [];
  for (const b of due) told[b.kind] = now;
  mkdirSync(join(root, "log", "gardener"), { recursive: true });
  writeFileSync(f, JSON.stringify(told, null, 2) + "\n");
  return due.map((b) => `- **Gardener blind spot**: ${b.what} ${b.fix}`);
}
