// SPDX-License-Identifier: AGPL-3.0-only
// Source backfill (backlog 376, docs/sources-pull.md "Backfilling sources"): most facts came from
// an assistant's word or a vague pointer, so nothing can recheck them. For each such fact, search
// the mailbox for its value; a mail under the source's labels that states the value and names the
// note's subject becomes the fact's exact source (corroborate in src/pull.ts: the value never
// changes, only the ref is added and last_confirmed set). Read-only on the mailbox, nothing from a
// mail is stored, a mail more sensitive than the note is never attached, and each run is capped.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hubRole } from "./hub";
import { hasLiveSource, liveRecords } from "./health";
import { compareKey } from "./normalize";
import { loadSources, consentProblem, toItem, itemFloor, refFor, groundedIn, corroborate, withGrounding, type SourceConfig } from "./pull";
import { searchGmail } from "./google";
import { appendJsonl } from "./util";
import { loadBrain, sensitivityRank, today, type FactRecord, type Note } from "./brain";
import { loadRules } from "./rules";

type Raw = Record<string, any>;
export type Search = (cfg: SourceConfig, q: string, max: number) => Promise<Raw[]>;
export interface BackfillResult { source: string; tried: number; attached: string[]; refused?: string }

const MAX = 20;          // facts searched per run: a few Gmail calls each
const PER_FACT = 3;      // messages read per fact
const RETRY_DAYS = 30;
const SEARCHABLE = sensitivityRank("personal"); // the most sensitive value a search may carry   // a fact searched without a match waits this long before the next try

// A value worth searching for: text or a number with at least one word that isn't filler.
function searchText(r: FactRecord): string | undefined {
  const v = typeof r.value === "string" || typeof r.value === "number" ? String(r.value).trim() : undefined;
  if (!v || v.length > 120 || !/[\p{L}\p{N}]{3,}/u.test(v)) return undefined;
  return v.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
}

// A fact the backfill may search for: never a private note's or fact's value (a search sends it to
// the mail provider), and only a value with words to search by. The trust audit counts these.
export function searchable(n: Note, r: FactRecord): boolean {
  if (sensitivityRank(n.fm.sensitivity) > SEARCHABLE || (r.sensitivity && sensitivityRank(r.sensitivity) > SEARCHABLE)) return false;
  return !!searchText(r);
}

// The mail is about this note: its title, or one of its aliases, is stated in full.
const namesSubject = (n: Note, text: string) => [n.fm.title, ...(n.fm.aliases ?? [])].some((t) => typeof t === "string" && groundedIn(t, text));

const statePath = (root: string, name: string) => join(root, "log", "sources", `${name}-backfill.json`);
const daysSince = (d: string, now: string) => (Date.parse(now) - Date.parse(d)) / 86_400_000;

export async function sourceBackfill(root: string, name: string, opts: { max?: number; dryRun?: boolean; search?: Search } = {}): Promise<BackfillResult> {
  const out: BackfillResult = { source: name, tried: 0, attached: [] };
  const file = loadSources(root);
  const cfg = file.sources?.[name];
  if (!cfg) return { ...out, refused: `no source ${name} in rules/sources.yaml` };
  if (cfg.kind !== "gmail") return { ...out, refused: `${name}: backfill searches Gmail sources only, not ${cfg.kind}` };
  const role = hubRole(root).mode;
  if (role !== "single" && role !== "hub") return { ...out, refused: "a replica doesn't backfill; the hub does, on its own notes" };
  const search = opts.search ?? (cfg.fixture ? undefined : searchGmail);
  if (!search) return { ...out, refused: `${name}: a fixture source has nothing to search` };
  if (!opts.search) { const no = consentProblem(file.consent); if (no) return { ...out, refused: `${name} is a live source; ${no}` }; }

  const now = today();
  const sp = statePath(root, name);
  const state: { tried: Record<string, string> } = existsSync(sp) ? JSON.parse(readFileSync(sp, "utf8")) : { tried: {} };
  // Facts with no live source, newest first, each searched at most once per RETRY_DAYS.
  const todo: { n: Note; attr: string; r: FactRecord; q: string }[] = [];
  for (const n of loadBrain(root, { shared: true })) {
    if (n.fm.type === "dispute" || n.fm.status !== "active") continue;
    // A search sends the value to the mail provider: never a private note's or fact's.
    for (const { attr, r } of liveRecords(n)) {
      if (!searchable(n, r)) continue;
      const q = searchText(r)!;
      const key = `${n.fm.id}#${attr}#${compareKey(r.value)}`;
      if (hasLiveSource(r) || (state.tried[key] && daysSince(state.tried[key], now) < RETRY_DAYS)) continue;
      todo.push({ n, attr, r, q });
    }
  }
  todo.sort((a, b) => String(b.r.as_of ?? "").localeCompare(String(a.r.as_of ?? "")) || a.n.fm.id.localeCompare(b.n.fm.id));

  for (const { n, attr, r, q } of todo.slice(0, opts.max ?? MAX)) {
    out.tried++;
    const want = compareKey(r.value);
    let hit: string | undefined;
    for (const raw of await search(cfg, `"${q}"`, PER_FACT)) {
      const it = toItem("gmail", raw);
      if (!it || it.gone) continue;
      const text = [it.subject, it.from, it.text].filter(Boolean).join("\n");
      if (!groundedIn(r.value, text) || !namesSubject(n, text)) continue;
      // Never a mail more sensitive than the note or fact it would stand behind.
      const { fwd, floor } = itemFloor(cfg, it);
      const ceiling = Math.max(sensitivityRank(n.fm.sensitivity), r.sensitivity ? sensitivityRank(r.sensitivity) : -1);
      if (floor && sensitivityRank(floor) > ceiling) continue;
      const ref = refFor("gmail", it, fwd?.account ?? cfg.account);
      if (opts.dryRun) { hit = ref; break; }
      if (withGrounding(text, () => corroborate(root, n.fm.id, attr, (x) => compareKey(x.value) === want && !hasLiveSource(x), ref))) { hit = ref; break; }
    }
    if (hit) out.attached.push(`${n.fm.id}#${attr}`);
    else state.tried[`${n.fm.id}#${attr}#${want}`] = now;
  }
  if (!opts.dryRun) {
    mkdirSync(join(root, "log", "sources"), { recursive: true });
    writeFileSync(sp, JSON.stringify(state));
    // Counts only: which facts, never what a mail said.
    appendJsonl(join(root, "log", "sources", "backfill.jsonl"), { at: new Date().toISOString(), source: name, tried: out.tried, attached: out.attached.length, waiting: Math.max(0, todo.length - out.tried) });
  }
  return out;
}

// The nightly pass (src/start.ts) runs it for every Gmail source, MAX facts each (70% of the real
// brain's facts had no live source and backfill had only ever run by hand; owner, 2026-10-25: "i
// want to trust the data"). Like every scheduled job it starts report-only: a dry run that searches
// and counts what it would attach, writing nothing, until the owner runs `pocketbrain backfill on`
// (`backfill: { nightly: true }` in policy.yaml, src/ownerset.ts). A source it can't search (a
// fixture, no consent) is left out quietly; the probe already names a source that fails.
export const nightlyBackfillOn = (root: string) => ((loadRules(root).policy ?? {}) as { backfill?: { nightly?: unknown } }).backfill?.nightly === true;
export async function nightBackfill(root: string, opts: { search?: Search } = {}): Promise<{ on: boolean; results: BackfillResult[] }> {
  const on = nightlyBackfillOn(root);
  const results: BackfillResult[] = [];
  for (const [name, cfg] of Object.entries(loadSources(root).sources ?? {})) {
    if (cfg.kind !== "gmail") continue;
    const r = await sourceBackfill(root, name, { ...opts, dryRun: !on });
    if (!r.refused) results.push(r);
  }
  return { on, results };
}

// The night log's line: counts only.
export function nightBackfillLine(b: { on: boolean; results: BackfillResult[] }): string {
  if (!b.results.length) return "backfill: nothing to search";
  const each = b.results.map((r) => `${r.source} ${r.tried} searched, ${r.attached.length} ${b.on ? "now sourced" : "could get a source"}`).join("; ");
  return b.on ? `backfill: ${each}` : `backfill (report only): ${each}; pocketbrain backfill on lets it attach them`;
}
