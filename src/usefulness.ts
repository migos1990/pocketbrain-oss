// SPDX-License-Identifier: AGPL-3.0-only
// Usefulness: the one number every change must move (plans/next-level.md, revised move 1; audit
// v13 section 7, "the loop"). Questions an assistant would ask about the owner, each asked through
// that assistant's view and scored: answerable (what the answer needs is in what it got back), in
// how many tokens (characters / 4, src/context.ts), and how much of that was noise (tokens in notes
// that hold nothing the answer needs).
//
// Two doors, because assistants use both: the context pack (one call with the question as topic),
// and search then read (the search's hits, then the top three notes read by id, as an assistant
// that searches and opens notes does). The sets: the brain's evals/usefulness.yaml (written), its
// golden files evals/weekly.yaml and evals/retrieval.yaml (src/golden.ts, scripts/retrieval-bench.ts),
// and questions harvested from what assistants really asked (log/reads.jsonl), sampled again each
// month. Report-only: nothing is written or sent, and nothing asked here is logged as the
// assistant's read (previewPack, previewSearch, previewRead). The counts text names no question,
// note or value, so it can be run on a real brain and read anywhere. See docs/prove-the-loop.md.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { previewPack, previewSearch, previewRead } from "./core";
import { PACK_SHAPE, type PackShape } from "./retrieve";
import { loadBrain, isDisputed, today, type Note } from "./brain";
import { records } from "./carve";
import { loadRules } from "./rules";
import { tokensOf } from "./context";
import { readJsonl, sha256 } from "./util";
import { previewFeed, state } from "./memsync";

export type USet = "usefulness" | "weekly" | "retrieval" | "use";
export type UDoor = "pack" | "search" | "check";
// The door assistants use most comes first (CEO review, 2026-11-09: 335 memory_check calls and 203
// reads against 25 context packs in 14 days): the number to steer by is scored there.
export const DOORS: UDoor[] = ["check", "pack", "search"];
export interface UQuestion {
  id: string; q: string; set: USet;
  // What an answer needs: facts (note#attribute; the live value must be there), words it must
  // hold (says), notes it must bring (notes), and one of these notes (oneOf, the golden files' want,
  // with `attr` the fact of it that must be shown).
  facts: string[]; says: string[]; notes: string[]; oneOf: string[]; attr?: string;
  as?: string[];
}
export interface URow { id: string; agent: string; set: USet; door: UDoor; answered: boolean; pointer: boolean; tokens: number; noise: number; missing: number }
export interface UCount { asked: number; answered: number }
export interface UAgent { agent: string; door: UDoor; sets: Partial<Record<USet, UCount>>; all: UCount; pointers: number; tokens: { median: number; perAnswer: number }; noise: number }
export interface UScore { files: string[]; rows: URow[]; agents: UAgent[] }

const list = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).map(String).filter(Boolean);

// The brain's sets, in order: its own usefulness questions, then its golden files.
const SETS: [USet, string][] = [["usefulness", "usefulness.yaml"], ["weekly", "weekly.yaml"], ["retrieval", "retrieval.yaml"]];
export function usefulnessFiles(root: string): [USet, string][] {
  return SETS.map(([s, f]): [USet, string] => [s, s === "usefulness" && process.env.PB_USEFULNESS ? process.env.PB_USEFULNESS : join(root, "evals", f)]).filter(([, f]) => existsSync(f));
}

// `questions: [{ id, q, facts?, says?, notes?, as? }]`, or a golden file's `{ id, q, as, want,
// expect?, answer? }` (want: one of these notes; expect: the fact of it shown, body for its text;
// answer: words it must hold). A question that needs nothing is dropped.
export function loadUsefulness(file: string, set: USet = "usefulness"): UQuestion[] {
  const raw = YAML.parse(readFileSync(file, "utf8"));
  const qs: any[] = Array.isArray(raw?.questions) ? raw.questions : Array.isArray(raw) ? raw : [];
  return qs.map((o, i): UQuestion => {
    const expect = o?.expect != null ? String(o.expect) : undefined;
    return {
      id: String(o?.id ?? `${set[0]}${i + 1}`).replace(/[^\w-]/g, ""), q: String(o?.q ?? ""), set,
      facts: list(o?.facts), says: [...list(o?.says), ...list(o?.answer)], notes: list(o?.notes), oneOf: list(o?.want),
      ...(expect && expect !== "body" ? { attr: expect } : {}),
      ...(list(o?.as).length ? { as: list(o?.as) } : {}),
    };
  }).filter((g) => g.q && g.facts.length + g.says.length + g.notes.length + g.oneOf.length > 0);
}

// What assistants really asked: each context_pack or search topic in the reads log, with the notes
// that answered it: those the assistant then read by id within ten minutes if any (what it went to
// get), else the first note the pack gave then. One per topic, sampled by the month: the same set
// all month, another the next.
const FOLLOW_MS = 10 * 60_000;
export function harvest(root: string, opts: { n?: number; day?: string } = {}): UQuestion[] {
  const n = opts.n ?? 10, month = (opts.day ?? today()).slice(0, 7);
  const f = join(root, "log", "reads.jsonl");
  if (!n || !existsSync(f)) return [];
  type R = { at: string; agent: string; op: string; ids?: string[]; q?: unknown };
  const rows = readJsonl<R>(f);
  const by = new Map<string, UQuestion>();
  rows.forEach((r, i) => {
    if ((r.op !== "context_pack" && r.op !== "search") || typeof r.q !== "string" || !r.q.trim()) return;
    const t = Date.parse(r.at);
    const after = rows.slice(i + 1).filter((x) => x.agent === r.agent && x.op === "read" && Date.parse(x.at) >= t && Date.parse(x.at) - t <= FOLLOW_MS).flatMap((x) => x.ids ?? []);
    const notes = after.length ? [...new Set(after)] : (r.ids ?? []).slice(0, 1);
    if (!notes.length) return;
    const key = r.q.trim().toLowerCase();
    if (!by.has(key)) by.set(key, { id: `use-${sha256(key).slice(0, 8)}`, q: r.q.trim(), set: "use", facts: [], says: [], notes, oneOf: [] });
  });
  return [...by.values()].sort((a, b) => sha256(`${month}:${a.q}`).localeCompare(sha256(`${month}:${b.q}`))).slice(0, n);
}

const flat = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
const valuesOf = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(valuesOf) : v && typeof v === "object" ? valuesOf((v as { value?: unknown }).value) : v == null ? [] : [String(v)]);
type Notes = Map<string, Note>;
const liveValues = (notes: Notes, id: string, attr: string) => {
  const f = notes.get(id)?.fm.facts?.[attr];
  const live = f ? records(f).filter((r) => !r.valid_to && !r.retired) : [];
  // Two ways a conflict is stored: the fact's own dispute, or a `contested:` key on a live record
  // (the conflict waits in disputes/ beside the value, G425). Either way the value is not current.
  return { f, contested: isDisputed(f) || live.some((r) => !!r.contested), vals: live.flatMap((r) => valuesOf(r.value)).map(flat).filter(Boolean) };
};

// What came back, split into notes: the pack's `### Title \`id\`` blocks, or one block per note
// read. The head (and a search's hit list) is the first block.
const blocksOf = (text: string) => text.split(/\n(?=### )/);
const blockId = (b: string) => b.match(/^### .*`([^`]+)`\s*$/m)?.[1];

// One question against what one door gave back. A fact counts when every value of its live records
// is there (a list: every live item) and, for a fact two sources contest, when no line serves it as
// current. A note counts only when it came back as a note (its own `### Title \`id\`` block, whole
// or as its facts); an id named on a link, a Connected line or the also line is a pointer, not an
// answer: `pointer` says the question would count if pointers did. Noise: the share of tokens in
// notes that hold nothing the answer needs.
export function answers(root: string, q: UQuestion, got: string, notes: Notes = new Map(loadBrain(root, { shared: true }).map((x) => [x.fm.id, x]))): { answered: boolean; pointer: boolean; missing: number; noise: number } {
  const text = flat(got);
  const blocks = blocksOf(got);
  const came = new Map(blocks.slice(1).map((b) => [blockId(b) ?? "", b] as const));
  const named = (id: string) => got.includes(`\`${id}\``);
  const needles: string[] = [];
  let missing = 0, pointed = 0;
  for (const k of q.facts) {
    const at = k.lastIndexOf("#"), id = k.slice(0, at), attr = k.slice(at + 1);
    const { contested, vals } = liveValues(notes, id, attr);
    needles.push(...vals);
    const ok = vals.length > 0 && (contested ? vals.some((v) => text.includes(v)) && !new RegExp(`\\*\\*${attr}\\*\\* \\[current\\]`).test(got) : vals.every((v) => text.includes(v)));
    if (!ok) { missing++; if (named(id)) pointed++; }
  }
  for (const w of q.says) { needles.push(flat(w)); if (!text.includes(flat(w))) missing++; }
  const ids = [...q.notes, ...q.oneOf];
  for (const id of q.notes) if (!came.has(id)) { missing++; if (named(id)) pointed++; }
  if (q.oneOf.length) {
    const shown = (id: string) => !q.attr || liveValues(notes, id, q.attr).vals.some((v) => flat(came.get(id) ?? "").includes(v));
    const hit = q.oneOf.find((id) => came.has(id) && shown(id));
    if (!hit) { missing++; if (q.oneOf.some(named)) pointed++; }
    if (q.attr) for (const id of q.oneOf) needles.push(...liveValues(notes, id, q.attr).vals);
  }
  const total = tokensOf(got);
  const useful = blocks.filter((b, i) => i > 0 && (ids.includes(blockId(b) ?? "") || needles.some((n) => flat(b).includes(n)))).reduce((s, b) => s + tokensOf(b), 0);
  return { answered: missing === 0, pointer: missing > 0 && missing === pointed, missing, noise: total ? Math.round(100 * (1 - useful / total)) / 100 : 0 };
}

// Search then read, as an assistant using those tools gets it: the hit list as the server sends
// it, then the top three hits read by id, each under its own heading.
const READS = 3;
function searchDoor(root: string, agent: string, q: string): string {
  const hits = previewSearch(root, agent, q, 20);
  const reads = hits.slice(0, READS).map((h) => { try { return `### ${h.title} \`${h.id}\`\n${previewRead(root, agent, h.id).markdown}`; } catch { return ""; } }).filter(Boolean);
  return [JSON.stringify(hits, null, 2), ...reads].join("\n");
}
// memory_check, then read, as assistants mostly use the brain (the reads and calls logs): the
// change feed the agent's next memory_check would hand it, then up to three of the notes it points
// to, those sharing the most words with the question. The feed doesn't depend on the question, so
// this says how often what assistants already read answers what they get asked.
function checkDoor(root: string, agent: string, q: string, s: ReturnType<typeof state>): string {
  const items = previewFeed(root, agent, s);
  if (!items.length) return "";
  const words = new Set(q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
  const shared = (t: string) => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => words.has(w)).length;
  const ids = [...new Set(items.map((i) => i.key.split("#")[0]!))].map((id) => ({ id, n: shared(items.filter((i) => i.key.startsWith(`${id}#`)).map((i) => i.about).join(" ")) }))
    .filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, READS);
  const reads = ids.map(({ id }) => { try { const r = previewRead(root, agent, id); return `### ${r.title ?? id} \`${id}\`\n${r.markdown}`; } catch { return ""; } }).filter(Boolean);
  return [JSON.stringify({ changes: { items } }, null, 2), ...reads].join("\n");
}
function ask(root: string, agent: string, door: UDoor, q: string, s: ReturnType<typeof state>): string {
  try { return door === "pack" ? previewPack(root, agent, q) : door === "search" ? searchDoor(root, agent, q) : checkDoor(root, agent, q, s); } catch { return ""; }
}

// The assistants scored: every agent in policy.yaml but the hub's own readers, the Gardener and a
// paused one.
export function assistants(root: string): string[] {
  const rules = loadRules(root);
  return Object.entries(rules.policy.agents).filter(([, a]) => !a.inside_wall && a.role !== "gardener" && a.status !== "paused").map(([id]) => id);
}

const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]!; };

export function scoreUsefulness(root: string, opts: { file?: string; agents?: string[]; harvest?: number; day?: string; doors?: UDoor[] } = {}): UScore {
  const files: [USet, string][] = opts.file ? (existsSync(opts.file) ? [["usefulness", opts.file]] : []) : usefulnessFiles(root);
  const written = files.flatMap(([set, f]) => loadUsefulness(f, set));
  const used = harvest(root, { n: opts.harvest ?? 10, day: opts.day });
  const notes: Notes = new Map(loadBrain(root, { shared: true }).map((x) => [x.fm.id, x]));
  const agents = opts.agents ?? assistants(root), doors = opts.doors ?? DOORS;
  const rows: URow[] = [];
  const sync = state(root);
  for (const door of doors) for (const agent of agents) for (const q of [...written, ...used]) {
    // A written question names who it is for; a harvested one is asked of every assistant.
    if (q.as && !q.as.includes(agent)) continue;
    const got = ask(root, agent, door, q.q, sync);
    const a = answers(root, q, got, notes);
    rows.push({ id: q.id, agent, set: q.set, door, answered: a.answered, pointer: a.pointer, tokens: tokensOf(got), noise: a.noise, missing: a.missing });
  }
  const per = doors.flatMap((door) => agents.map((agent): UAgent => {
    const mine = rows.filter((r) => r.agent === agent && r.door === door);
    const count = (xs: URow[]): UCount => ({ asked: xs.length, answered: xs.filter((r) => r.answered).length });
    const sets: Partial<Record<USet, UCount>> = {};
    for (const s of new Set(mine.map((r) => r.set))) sets[s] = count(mine.filter((r) => r.set === s));
    const got = mine.filter((r) => r.answered);
    return {
      agent, door, sets, all: count(mine), pointers: mine.filter((r) => r.pointer).length,
      tokens: { median: median(mine.map((r) => r.tokens)), perAnswer: got.length ? Math.round(mine.reduce((s, r) => s + r.tokens, 0) / got.length) : 0 },
      noise: got.length ? Math.round(100 * got.reduce((s, r) => s + r.noise, 0) / got.length) : 0,
    };
  }));
  return { files: files.map(([, f]) => f), rows, agents: per };
}

// The pack's shape, side by side (G768): each assistant's questions through context_pack shaped as
// eight whole notes (the pack before G768), as three whole and five named on a line, and as today's
// shape, scored strictly with pointers apart, and the median tokens of each. Counts only.
export const SHAPES: Record<string, PackShape> = { "eight whole": { whole: 8, brief: 0, also: 0 }, "three whole, five named": { whole: 3, brief: 0, also: 5 }, today: PACK_SHAPE, "today, no weaker fourth to sixth": { ...PACK_SHAPE, floor: true } };
export interface UShape { agent: string; shape: string; asked: number; answered: number; pointers: number; median: number }
export function compareShapes(root: string, opts: { file?: string; agents?: string[]; harvest?: number; day?: string; shapes?: Record<string, PackShape> } = {}): UShape[] {
  const files: [USet, string][] = opts.file ? (existsSync(opts.file) ? [["usefulness", opts.file]] : []) : usefulnessFiles(root);
  const qs = [...files.flatMap(([set, f]) => loadUsefulness(f, set)), ...harvest(root, { n: opts.harvest ?? 10, day: opts.day })];
  const notes: Notes = new Map(loadBrain(root, { shared: true }).map((x) => [x.fm.id, x]));
  const out: UShape[] = [];
  for (const agent of opts.agents ?? assistants(root)) for (const [shape, sh] of Object.entries(opts.shapes ?? SHAPES)) {
    const mine = qs.filter((q) => !q.as || q.as.includes(agent)).map((q) => {
      let got = ""; try { got = previewPack(root, agent, q.q, sh); } catch { /* scored as nothing */ }
      return { a: answers(root, q, got, notes), tokens: tokensOf(got) };
    });
    out.push({ agent, shape, asked: mine.length, answered: mine.filter((m) => m.a.answered).length, pointers: mine.filter((m) => m.a.pointer).length, median: median(mine.map((m) => m.tokens)) });
  }
  return out;
}
// Which questions eight whole notes answer strictly and today's shape doesn't, as each question's
// set and place in it, where the answer sat in the eight (1-based; 0 when it took several notes)
// and where that note is now: whole, facts only, named on a line, or absent. Never the question.
export interface ULost { agent: string; set: USet; index: number; at: number; now: string; missing: number }
export function lostToWide(root: string, opts: { file?: string; agents?: string[]; harvest?: number; day?: string } = {}): ULost[] {
  const files: [USet, string][] = opts.file ? (existsSync(opts.file) ? [["usefulness", opts.file]] : []) : usefulnessFiles(root);
  const qs = [...files.flatMap(([set, f]) => loadUsefulness(f, set)), ...harvest(root, { n: opts.harvest ?? 10, day: opts.day })];
  const notes: Notes = new Map(loadBrain(root, { shared: true }).map((x) => [x.fm.id, x]));
  const out: ULost[] = [];
  for (const agent of opts.agents ?? assistants(root)) for (const q of qs) {
    if (q.as && !q.as.includes(agent)) continue;
    const pack = (sh?: PackShape) => { try { return previewPack(root, agent, q.q, sh); } catch { return ""; } };
    const wide = pack(SHAPES["eight whole"]), cur = pack();
    const a = answers(root, q, cur, notes);
    if (a.answered || !answers(root, q, wide, notes).answered) continue;
    const wb = blocksOf(wide), at = wb.findIndex((b, i) => i > 0 && answers(root, q, `${wb[0]}\n${b}`, notes).answered);
    const id = at > 0 ? blockId(wb[at]!) : undefined, mine = id ? blocksOf(cur).find((b, i) => i > 0 && blockId(b) === id) : undefined;
    const now = !id ? "several" : mine ? (mine.includes("(Its facts only here;") ? "facts only" : "whole") : cur.includes(`\`${id}\``) ? "named on a line" : "absent";
    out.push({ agent, set: q.set, index: qs.filter((x) => x.set === q.set).indexOf(q) + 1, at: Math.max(0, at), now, missing: a.missing });
  }
  return out;
}
export function lostText(xs: ULost[]): string {
  return xs.length ? ["answered by eight whole notes, not by today's pack:", ...xs.map((l) => `  ${l.agent} ${l.set} #${l.index}: was note ${l.at || "several"}; now ${l.now}, ${l.missing} part${l.missing === 1 ? "" : "s"} missing`)].join("\n") : "nothing eight whole notes answer is lost";
}

export function shapesText(xs: UShape[]): string {
  return ["context pack by shape (answered strictly, then only pointed to, median tokens):", ...xs.map((x) => `  ${x.agent}, ${x.shape}: ${x.answered}/${x.asked} answered, ${x.pointers} pointed to, median ${x.median} tokens`)].join("\n");
}

const DOOR_WORDS: Record<UDoor, string> = { pack: "context pack", search: "search, then read 3", check: "memory_check, then read 3" };
// One line per assistant and door: counts, tokens and noise only, never a question, a note or a value.
export function countsText(s: UScore): string {
  if (!s.rows.length) return "Usefulness: no questions (add evals/usefulness.yaml to the brain; docs/prove-the-loop.md#usefulness)";
  return ["Usefulness: questions an assistant can answer from what it gets back, the tokens it reads, and the share of them that is noise",
    "The number to steer by is the first line per assistant: the door assistants use most (memory_check, then read). Printed only, never a merge block.",
    ...s.agents.filter((a) => a.all.asked).map((a) => `  ${a.agent} by ${DOOR_WORDS[a.door]}: ${a.all.answered}/${a.all.asked} answered (${Object.entries(a.sets).map(([k, v]) => `${k} ${v!.answered}/${v!.asked}`).join(", ")}), ${a.pointers} more only pointed to; median ${a.tokens.median} tokens, ${a.tokens.perAnswer || "-"} per answer, ${a.noise}% noise`),
  ].join("\n");
}

// The owner's own view adds which question ids missed (ids are the set's own labels).
export function detailText(s: UScore): string {
  return [countsText(s), ...s.rows.filter((r) => !r.answered).map((r) => `  missed ${r.agent} ${r.door} ${r.id} (${r.set}): ${r.missing} part${r.missing === 1 ? "" : "s"} not there, ${r.tokens} tokens`)].join("\n");
}
