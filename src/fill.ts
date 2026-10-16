// SPDX-License-Identifier: AGPL-3.0-only
// Is the brain filling? (docs/sources-pull.md, "Is the brain filling?"). A brain nobody fills is a
// brain nobody consults, so this measures the capture pipeline the way the owner feels it: per
// source, how many facts it proposed, how many the owner kept or dropped, how many facts a pull
// re-confirmed without asking anyone, and the owner's minutes. The targets are the self-filling
// bet's one-week proof: 50 proposed facts a week, 85% kept, 2 owner minutes a day.
//
// Reads files and logs only: no model, nothing served to an agent, no values printed.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { today, type SourceRef } from "./brain";
import { refString } from "./sources";
import { lastDays, measures } from "./measure";
import { readJsonl } from "./util";
import { loadSources, pullRuns, SCHEME, type SourceConfig } from "./pull";

export const TARGET = { perWeek: 50, keep: 0.85, minutesPerDay: 2 };

export interface SourceFill { source: string; proposed: number; kept: number; dropped: number; open: number; confirmed: number; keepRate?: number }
export type Grade = "pass" | "fail" | "no data";
export interface Fill {
  from: string; to: string; days: number;
  sources: SourceFill[];
  total: Omit<SourceFill, "source">;
  ownerMinutes?: number;
  reviewMinutes?: number; // seconds on the deck's cards for these facts (the morning swipe), in minutes
  verdict: { volume: Grade; keep: Grade; minutes: Grade };
}

interface Proposal { proposed?: string; capture?: string; decision?: string; decided?: string; request?: { id?: string; attribute?: string; sources?: SourceRef[] } }

// The source a fact came from: the scheme of its first ref (granola, gmail, gcal, discord, imessage,
// doc for the capture mailbox and drop folder, agent for an agent's capture).
const sourceOf = (refs: SourceRef[] | undefined) => (refs?.length ? refString(refs[0]).split(":")[0] : "unknown");

function read(dir: string): Proposal[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".yaml")).flatMap((f) => {
    try { return [YAML.parse(readFileSync(join(dir, f), "utf8")) as Proposal]; } catch { return []; }
  });
}

export function fill(root: string, n = 7, end = today()): Fill {
  const days = lastDays(n, end);
  const inWindow = (d?: string) => !!d && days.includes(d.slice(0, 10));
  const rows = new Map<string, SourceFill>();
  const row = (s: string) => rows.get(s) ?? rows.set(s, { source: s, proposed: 0, kept: 0, dropped: 0, open: 0, confirmed: 0 }).get(s)!;
  // Only the capture pipeline (pulls, mailbox, drop folder, agent captures) is the brain filling
  // itself; an agent's own trial-tier proposal is not.
  const take = (p: Proposal) => !!p.capture && inWindow(p.proposed);
  for (const p of read(join(root, "inbox")).filter(take)) { const r = row(sourceOf(p.request?.sources)); r.proposed++; r.open++; }
  for (const p of read(join(root, "inbox", "decided")).filter(take)) {
    const r = row(sourceOf(p.request?.sources));
    r.proposed++;
    if (p.decision === "accept") r.kept++; else r.dropped++;
  }
  for (const e of readJsonl<{ at?: string; kind?: string; outcome?: string; source?: string }>(join(root, "log", "writes.jsonl"))) {
    if (e.kind === "source-confirm" && e.outcome === "committed" && inWindow(e.at) && e.source) row(e.source.split(":")[0]).confirmed++;
  }
  const rate = (r: { kept: number; dropped: number }) => (r.kept + r.dropped ? r.kept / (r.kept + r.dropped) : undefined);
  const sources = [...rows.values()].map((r) => ({ ...r, keepRate: rate(r) })).sort((a, b) => b.proposed - a.proposed || a.source.localeCompare(b.source));
  const sum = (k: "proposed" | "kept" | "dropped" | "open" | "confirmed") => sources.reduce((s, r) => s + r[k], 0);
  const total = { proposed: sum("proposed"), kept: sum("kept"), dropped: sum("dropped"), open: sum("open"), confirmed: sum("confirmed") };
  const keepRate = rate(total);
  const mins = measures(root, days).map((m) => m.ownerMinutes).filter((x): x is number => typeof x === "number");
  const ownerMinutes = mins.length ? mins.reduce((a, b) => a + b, 0) : undefined;
  // Timed swipes on these facts' cards (src/deck.ts recordSwipe) beat the dashboard's page-load
  // estimate: they are the review itself.
  const swipes = readJsonl<{ at?: string; day?: string; ms?: number; capture?: boolean }>(join(root, "log", "deck.jsonl")).filter((e) => e.capture && typeof e.ms === "number" && inWindow(e.day ?? e.at));
  const reviewMinutes = swipes.length ? swipes.reduce((s, e) => s + e.ms!, 0) / 60_000 : undefined;
  const graded = reviewMinutes ?? ownerMinutes;
  return {
    from: days[0], to: days.at(-1)!, days: n,
    sources, total: { ...total, ...(keepRate === undefined ? {} : { keepRate }) },
    ...(ownerMinutes === undefined ? {} : { ownerMinutes }),
    ...(reviewMinutes === undefined ? {} : { reviewMinutes }),
    verdict: {
      volume: total.proposed >= (TARGET.perWeek * n) / 7 ? "pass" : "fail",
      keep: keepRate === undefined ? "no data" : keepRate >= TARGET.keep ? "pass" : "fail",
      minutes: graded === undefined || !total.proposed ? "no data" : graded / n <= TARGET.minutesPerDay ? "pass" : "fail",
    },
  };
}

const pct = (x?: number) => (x === undefined ? "no decisions yet" : `keep ${Math.round(x * 100)}%`);

export function renderFill(f: Fill): string {
  const v = f.verdict;
  const lines = [`Is the brain filling? ${f.from} to ${f.to}: volume ${v.volume}, keep ${v.keep}, owner minutes ${v.minutes}`];
  lines.push(`  targets: ${Math.round((TARGET.perWeek * f.days) / 7)} proposed, ${TARGET.keep * 100}% kept, ${TARGET.minutesPerDay} owner minutes a day`);
  if (!f.sources.length) {
    lines.push("", "Nothing reached the brain from a source in this window. Check `pocketbrain sources` (is a consent line in rules/sources.yaml, is anything listed?) and `pocketbrain doctor`.");
    return lines.join("\n");
  }
  lines.push("");
  for (const s of f.sources) lines.push(`${s.source}: ${s.proposed} proposed, ${s.kept} kept, ${s.dropped} dropped, ${s.open} open, ${s.confirmed} re-confirmed (${pct(s.keepRate)})`);
  const t = f.total;
  lines.push(`all: ${t.proposed} proposed, ${t.kept} kept, ${t.dropped} dropped, ${t.open} open, ${t.confirmed} re-confirmed (${pct(t.keepRate)})${f.ownerMinutes === undefined ? "" : `; ${f.ownerMinutes} owner minutes`}${f.reviewMinutes === undefined ? "" : `; ${f.reviewMinutes.toFixed(1)} min on the deck`}`);
  const worst = f.sources.filter((s) => s.keepRate !== undefined && s.keepRate < TARGET.keep && s.kept + s.dropped >= 5);
  if (worst.length) lines.push("", `Dropped too often: ${worst.map((s) => s.source).join(", ")}. Narrow what that source reads in rules/sources.yaml before it costs more taps.`);
  return lines.join("\n");
}

// ---------- silent sources (the postmortem law: a pull that quietly stops looks like a quiet week) ----------
// Once the owner gave the consent line, every listed source should keep producing something: a
// proposal or a re-confirmed fact. One that has done neither for 72 hours (silent_after_hours per
// source; 0 turns it off), after being watched that long, is silent. Counts and names only, like the rest of this file.
export const SILENT_HOURS = 72;
export interface Silence { watched: string[]; silent: { source: string; last?: string; hours: number }[] }

// The ref prefixes a source's facts carry (refFor in src/pull.ts), forwarded accounts included.
function prefixes(cfg: SourceConfig): string[] {
  const accounts = [cfg.account, ...(cfg.forwarded ?? []).map((f) => f.account)];
  if (cfg.kind === "gmail") return accounts.map((a) => (a ? `gmail:${a}/` : "gmail:"));
  if (cfg.kind === "mail") return accounts.map((a) => `mail:${a ?? "mail"}/`);
  return [`${SCHEME[cfg.kind]}:`];
}

export function silentSources(root: string, now = new Date()): Silence | undefined {
  const file = loadSources(root);
  const sources = Object.entries(file.sources ?? {});
  if (!file.consent || !sources.length) return undefined;
  const runs = pullRuns(root);
  const proposals = [...read(join(root, "inbox")), ...read(join(root, "inbox", "decided"))].filter((p) => p.capture && p.proposed);
  const confirms = readJsonl<{ at?: string; kind?: string; outcome?: string; source?: string }>(join(root, "log", "writes.jsonl")).filter((e) => e.kind === "source-confirm" && e.outcome === "committed" && e.at && e.source);
  const out: Silence = { watched: [], silent: [] };
  for (const [name, cfg] of sources) {
    // A channel that is quiet by nature can wait longer, or not be watched (0).
    const hours = cfg.silent_after_hours ?? SILENT_HOURS;
    if (!(hours > 0)) continue;
    const cutoff = now.getTime() - hours * 3_600_000;
    const mine = runs.filter((r) => r.source === name);
    // Watched only after its first pass is 72 hours old: a source added yesterday isn't silent yet.
    if (!mine.length || Date.parse(mine[0].at) > cutoff) continue;
    out.watched.push(name);
    const pre = prefixes(cfg);
    const ours = (ref: string) => pre.some((x) => ref.startsWith(x));
    // A proposal carries a date only; it counts to the end of that day.
    const times = [
      ...mine.filter((r) => (r.proposals ?? 0) + (r.confirmed ?? 0) > 0).map((r) => r.at),
      ...proposals.filter((p) => (p.request?.sources ?? []).some((r) => ours(refString(r)))).map((p) => `${p.proposed!.slice(0, 10)}T23:59:59Z`),
      ...confirms.filter((e) => ours(e.source!)).map((e) => e.at!),
    ].sort();
    const last = times.at(-1);
    if (!last || Date.parse(last) < cutoff) out.silent.push({ source: name, hours, ...(last ? { last: last.slice(0, 10) } : {}) });
  }
  return out;
}

// The digest's headline for the self-filling brain: the week's numbers against the targets, and any
// silent source by name. Undefined until a source is set up.
export function fillLine(root: string, now = new Date()): string | undefined {
  const quiet = silentSources(root, now);
  const f = fill(root, 7);
  if (!quiet && !f.sources.length) return undefined;
  const t = f.total;
  const keep = t.keepRate === undefined ? "nothing decided yet" : `${Math.round(t.keepRate * 100)}% kept`;
  const silent = quiet?.silent.length ? `; silent: ${quiet.silent.map((s) => `${s.source} (${s.hours}h)`).join(", ")}` : "";
  return `- Filling: ${t.proposed} proposed in 7 days (target ${TARGET.perWeek}), ${keep}, ${t.confirmed} re-confirmed${silent}`;
}

// ---------- fill quality, for the week report (backlog #219) ----------
// Per source, the cards the owner decided in the window: accepted, accepted but then edited by
// hand (the owner changed that fact's value, or marked it never right, on or after the decision:
// a "Still true", a note-text or a sensitivity edit doesn't count), and rejected. Acceptance counts
// only clean accepts, since an edited card cost the owner a fix. Owner time isn't kept per card,
// so seconds per card is the window's owner minutes over every card decided in it.
export const ACCEPT_FLOOR = 0.7, MIN_DECISIONS = 5;
export interface SourceQuality { source: string; accepted: number; edited: number; rejected: number; acceptance?: number }
export interface FillQuality { sources: SourceQuality[]; decided: number; secondsPerCard?: number }

export function fillQuality(root: string, n = 7, end = today()): FillQuality {
  const days = lastDays(n, end);
  const inWindow = (d?: string) => !!d && days.includes(String(d).slice(0, 10));
  const edits = readJsonl<{ at?: string; kind?: string; op?: string; key?: string }>(join(root, "log", "writes.jsonl")).filter((e) => e.kind === "owner-edit" && (e.op === "set" || e.op === "never-right") && e.key);
  const rows = new Map<string, SourceQuality>();
  for (const p of read(join(root, "inbox", "decided")).filter((p) => !!p.capture && inWindow(p.decided ?? p.proposed))) {
    const src = sourceOf(p.request?.sources);
    const r = rows.get(src) ?? rows.set(src, { source: src, accepted: 0, edited: 0, rejected: 0 }).get(src)!;
    if (p.decision !== "accept") { r.rejected++; continue; }
    r.accepted++;
    const id = p.request?.id, key = id && p.request?.attribute ? `${id}#${p.request.attribute}` : id;
    const since = String(p.decided ?? p.proposed ?? "");
    if (key && edits.some((e) => e.key === key && String(e.at).slice(0, 10) >= since)) r.edited++;
  }
  const sources = [...rows.values()].map((r) => ({ ...r, ...(r.accepted + r.rejected ? { acceptance: (r.accepted - r.edited) / (r.accepted + r.rejected) } : {}) }))
    .sort((a, b) => b.accepted + b.rejected - (a.accepted + a.rejected) || a.source.localeCompare(b.source));
  const decided = sources.reduce((s, r) => s + r.accepted + r.rejected, 0);
  const mins = measures(root, days).map((m) => m.ownerMinutes).filter((x): x is number => typeof x === "number");
  const minutes = mins.length ? mins.reduce((a, b) => a + b, 0) : undefined;
  return { sources, decided, ...(decided && minutes !== undefined ? { secondsPerCard: Math.round((minutes * 60) / decided) } : {}) };
}

export function fillQualityLines(q: FillQuality): string[] {
  const out = ["## Fill quality", ""];
  if (!q.decided) return [...out, "No source proposals decided this week.", ""];
  for (const s of q.sources) out.push(`- ${s.source}: ${s.accepted} accepted, ${s.edited} edited, ${s.rejected} rejected (${Math.round((s.acceptance ?? 0) * 100)}% accepted)`);
  out.push(`- Your time: ${q.secondsPerCard === undefined ? "no minutes logged" : `about ${q.secondsPerCard} s per card`} over ${q.decided} card(s)`);
  for (const s of q.sources.filter((s) => s.accepted + s.rejected >= MIN_DECISIONS && (s.acceptance ?? 0) < ACCEPT_FLOOR))
    out.push(`- **Turn down ${s.source}: ${Math.round((s.acceptance ?? 0) * 100)}% accepted** over ${s.accepted + s.rejected} cards (under ${ACCEPT_FLOOR * 100}%). Narrow what it reads (\`where:\`) or lower its \`max_per_day\` in rules/sources.yaml, before reviewing it stops being worth your time.`);
  return [...out, ""];
}
