// SPDX-License-Identifier: AGPL-3.0-only
// What waits and why, as counts only (never a value, a name or a subject):
//   bun scripts/filing-counts.ts [brain]   (default ~/pocketbrain-brain)
// Read-only. Run it before and after a change to the capture pipeline to see how many open
// proposals a source made, how many would start a new note, how many add to a page that exists,
// how many are about the owner, and why the hub's filing left each one open.
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { loadState } from "../src/dashboard/data";
import { autoSaves, verdict, failedSaves } from "../src/filing";
import { sensitiveShape } from "../src/shape";
import { openItems, GARDENER_WAIT_H } from "../src/textline/items";
import { existsSync } from "node:fs";
import { ownerOf, ownerTitle } from "../src/capture";
import { loadEscalation } from "../src/textline/policy";
import { compareKey } from "../src/normalize";
import { sourceRank } from "../src/sources";
import { attributeSpec } from "../src/rules";
import type { FactRecord } from "../src/brain";

const root = process.argv[2] ?? join(homedir(), "pocketbrain-brain");
const s = loadState(root);
// The owner as the capture pipeline knows them: a full name of theirs, or their page (ownerOf).
const isOwner = (name: unknown) => typeof name === "string" && !!name && !!ownerOf(s.rules, s.notes, name);
const pulled = (file: string) => { try { return typeof (YAML.parse(readFileSync(join(root, "inbox", file), "utf8")) as { capture?: unknown })?.capture === "string"; } catch { return false; } };
const c: Record<string, number> = {};
const add = (k: string) => { c[k] = (c[k] ?? 0) + 1; };
for (const p of s.proposals) {
  const r = p.request as { id?: string; title?: string; type?: string; attribute?: string; value?: unknown; text?: string };
  add("open proposals");
  if (!pulled(p.file)) { add("  from an assistant"); continue; }
  add("  from a source pull or capture");
  const note = r.id ? s.notes.find((n) => n.fm.id === r.id) : undefined;
  add(note ? "    adds to a page that exists" : "    would start a new note");
  if (r.type === "person" || note?.fm.type === "person") add("    about a person");
  if (isOwner(note?.fm.title ?? r.title)) add("    about the owner");
  if (/the model inferred it/.test(p.reason)) add("    subject guessed");
  if (sensitiveShape(s.rules, r.id, r.title, r.attribute, r.value, r.text)) add("    reads like money, health or legal");
}
// Why each open proposal is still open: the hub's own fixed words (never a value), and for a save
// that failed, the names of the write checks that refused it.
const esc = loadEscalation(root);
const errs = join(root, "log", "auto-decisions-errors.jsonl");
const failed = new Map<string, string>();
const stuck = failedSaves(root, new Date());
if (existsSync(errs)) for (const l of readFileSync(errs, "utf8").split("\n").filter(Boolean)) { try { const e = JSON.parse(l) as { key: string; error?: string }; failed.set(e.key, [...String(e.error ?? "").matchAll(/(?:^|\n)([a-z_]+): /g)].map((m) => m[1]).join("+") || "other"); } catch { /* torn line */ } }
for (const it of openItems(root, new Date())) {
  if (it.kind !== "proposal") continue;
  // Only a refusal the hub still honours (this code, the last day): an older one is retried.
  if (failed.has(it.key) && stuck.has(it.key)) { add(`  open because: a save failed (${failed.get(it.key)})`); continue; }
  const v = verdict(root, it, esc, { notes: s.notes });
  add(`  open because: ${"plan" in v ? `planned (${v.plan.label})` : v.never}`);
  // A different value: how the held value compares (source strength, date, merge rule), counts only.
  const pr = s.proposals.find((x) => x.file === it.ref);
  const r = pr?.request as { id?: string; title?: string; type?: string; attribute?: string; value?: unknown; sources?: unknown[]; as_of?: string; verification?: string } | undefined;
  const note = r ? s.notes.find((n) => n.fm.id === r.id) ?? (r.title && r.type ? s.notes.find((n) => n.fm.type === r.type && compareKey(String(n.fm.title)) === compareKey(String(r.title))) : undefined) : undefined;
  const held = note && r?.attribute ? note.fm.facts?.[r.attribute] as FactRecord | undefined : undefined;
  if (r && held && typeof held === "object" && "value" in held && compareKey(held.value) !== compareKey(r.value)) {
    const mine = sourceRank({ sources: (r.sources ?? []) as FactRecord["sources"], verification: (r.verification ?? "self-reported") as FactRecord["verification"] });
    const theirs = sourceRank(held);
    const merge = attributeSpec(s.rules, String(note!.fm.type), r.attribute!).merge ?? "replace";
    add(`    different value (${merge}): held source ${theirs > mine ? "stronger" : theirs === mine ? "as strong" : "weaker"}, held ${String(held.as_of) < String(r.as_of ?? "") ? "older" : String(held.as_of) === String(r.as_of ?? "") ? "same day" : "newer"}${String(r.as_of ?? "").slice(0, 10) > new Date().toISOString().slice(0, 10) ? ", new one dated ahead" : ""}${held.verification === "verified-by-source" ? ", held one rechecked" : ""}`);
  }
}
// Conflicts filed from a capture (G416): how many wait for the Gardener, how many it suggested a
// side on, how many reached the owner's home (and of those, how many only through the 36-hour fallback).
const shown = new Set(openItems(root, new Date()).filter((i) => i.kind === "dispute").map((i) => i.ref));
for (const d of s.disputes.filter((x) => x.gardener_first && x.status === "open")) {
  add("conflicts filed from a capture");
  if (d.suggestion) add("  the Gardener suggested a side");
  add(shown.has(d.id) ? "  asked on the home" : "  waiting for the Gardener");
  if (shown.has(d.id) && !d.suggestion && Date.now() - Date.parse(d.gardener_first!) >= GARDENER_WAIT_H * 3600_000) add("    after 36 hours");
}
c["auto-saves planned"] = autoSaves(root).size;
c["source_saves_per_day"] = loadEscalation(root).auto_decide.source_saves_per_day;
c["owner has a person page"] = ownerOf(s.rules, s.notes, ownerTitle(s.rules) ?? "")?.page ? 1 : 0;
for (const [k, v] of Object.entries(c)) console.log(`${k}: ${v}`);
