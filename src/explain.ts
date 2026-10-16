// SPDX-License-Identifier: AGPL-3.0-only
// `pocketbrain explain <agent> [topic]`: the audit answer for one agent. For a topic, every
// matching note in the whole brain, whether the agent's slice holds it and why (which slice
// rule, which sensitivity or do-not-share flag), each fact in or out and why, and who was
// handed it (log/reads.jsonl). Without a topic, the shape of the slice and what the agent
// read. Louis's command only: it names notes and values outside the agent's slice, so it is
// never served to an agent (no MCP tool, no API route).
//
// "In" and "out" are today's rules. Reads are history: a read of a note that is out today
// means the rules changed since, and is shown as such rather than hidden.
import type { Note, FactRecord } from "./brain";
import { loadBrain, today, isDisputed, isList } from "./brain";
import { loadRules, attributeSpec, type Rules } from "./rules";
import { carve, grantFor, records, type CarveResult, type Grant } from "./carve";
import { factFreshness } from "./freshness";
import { refString } from "./sources";
import { buildIndex, rank } from "./retrieve";
import { readEntries, specificReads, verifyChain, type ReadEntry } from "./readlog";
import { join } from "node:path";
import { OWNER } from "./owner";

const show = (v: unknown, n = 70) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const day = (iso: string) => iso.slice(0, 10);

// Everything, as Louis sees it: used to find what a topic matches before asking about one agent.
function everything(notes: Note[], rules: Rules): CarveResult {
  const all: Grant = { agent: OWNER, slices: ["all"], exclude_types: [], exclude: [], ceiling: "secret" };
  return carve(notes, rules, all);
}

function flags(r: FactRecord, note: Note): string {
  const out: string[] = [];
  if (r.sensitivity && r.sensitivity !== note.fm.sensitivity) out.push(r.sensitivity);
  if (r.share_with) out.push(`only ${r.share_with.join(", ") || "the owner"}`);
  return out.length ? ` {${out.join("; ")}}` : "";
}

function readsLine(id: string, agent: string, byNote: Map<string, ReadEntry[]>, inNow: boolean): string[] {
  const es = byNote.get(id) ?? [];
  if (!es.length) return ["  read by: nobody (no specific read in the log)"];
  const per = new Map<string, ReadEntry[]>();
  for (const e of es) (per.get(e.agent) ?? per.set(e.agent, []).get(e.agent)!).push(e);
  const order = [...per.keys()].sort((a, b) => (a === agent ? -1 : b === agent ? 1 : a.localeCompare(b)));
  const lines = [`  read by: ${order.map((a) => {
    const xs = per.get(a)!;
    const ops = new Map<string, number>();
    for (const x of xs) ops.set(x.op, (ops.get(x.op) ?? 0) + 1);
    return `${a} ${xs.length}x (${[...ops].map(([o, n]) => `${o} ${n}`).join(", ")}; last ${day(xs.at(-1)!.at)})`;
  }).join("; ")}`];
  const mine = per.get(agent);
  if (mine && !inNow) lines.push(`  ! ${agent} was handed this note (last ${day(mine.at(-1)!.at)}) but it is out today: the rules changed since, or something to look into.`);
  return lines;
}

function noteBlock(n: Note, agent: string, res: CarveResult, rules: Rules, now: string, byNote: Map<string, ReadEntry[]>, onlyAttr?: string): string[] {
  const id = n.fm.id;
  const v = res.visible.get(id);
  const lines: string[] = [];
  const head = `${id} (${n.fm.type}, area ${n.fm.area}, ${n.fm.sensitivity}${n.fm.status !== "active" ? `, ${n.fm.status}` : ""})`;
  if (!v) {
    lines.push(`OUT  ${head}`, `  why: ${res.excluded.find((e) => e.id === id)?.reason ?? "not in the slice"}`);
  } else {
    lines.push(`IN   ${head}`, `  why: ${v.slices.map((s) => (s === "own" ? `its own area (${n.fm.area})` : `slice ${s}`)).join(", ")}; body ${v.body ? "shown" : "hidden"}`);
  }
  const hidden = new Map(res.hiddenFacts.filter((h) => h.key.startsWith(id + "#")).map((h) => [h.key.slice(id.length + 1), h.reason]));
  for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
    if (onlyAttr && attr !== onlyAttr) continue;
    const fr = factFreshness(f, attributeSpec(rules, n.fm.type, attr), now);
    const verdict = !v ? "out" : hidden.has(attr) ? `OUT (${hidden.get(attr)})` : "IN";
    const recs = isDisputed(f) ? f.candidates : isList(f) ? f.items.filter((i) => !i.valid_to) : records(f);
    const label = isDisputed(f) ? `disputed ${f.dispute}` : fr;
    lines.push(`  ${attr}: ${verdict} [${label}]`);
    for (const r of recs) lines.push(`    - ${show(r.value)} (as of ${r.as_of}; ${r.verification}; by ${r.by}; ${(r.sources ?? []).map(refString).join(", ")})${flags(r, n)}`);
  }
  // Ended values, from every path: retired by an agent or Louis (the retire tool: an end date
  // and a source), superseded by the conflict steps, or forgotten by the sleep pass (no end
  // date: nobody used it). All kept, none shown to agents, all listed here.
  const ended = (attr: string, r: FactRecord) => `  ${attr} (ended, never shown to agents): ${show(r.value)} ${r.retired
    ? `forgotten ${r.retired.at} by ${r.retired.by} (sleep pass): ${r.retired.why}`
    : `ended ${r.valid_to ?? "?"}${r.ended_by ? `, ${r.ended_by.step ? `superseded at conflict step ${r.ended_by.step}` : "retired"} by ${r.ended_by.by} on ${r.ended_by.at}${r.ended_by.sources?.length ? ` citing ${r.ended_by.sources.map(refString).join(", ")}` : ""}` : ""}`}`;
  for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
    if ((onlyAttr && attr !== onlyAttr) || !isList(f)) continue;
    for (const it of f.items.filter((i) => i.valid_to)) lines.push(ended(attr, it));
  }
  for (const [attr, rs] of Object.entries(n.fm.history ?? {})) {
    if (onlyAttr && attr !== onlyAttr) continue;
    for (const r of rs) lines.push(ended(attr, r));
  }
  for (const fl of res.flags.filter((x) => x.id === id)) lines.push(`  preview flag: ${fl.detail}`);
  lines.push(...readsLine(id, agent, byNote, !!v));
  return lines;
}

// What the agent went looking for: its searches (with how many hits) and the notes it asked for
// and didn't get. A hidden note and a missing one answered the agent alike; here they don't.
// A read (note id) or a why (note id#attribute) of something hidden from the agent.
function hiddenAsk(asked: string, res: CarveResult): string | undefined {
  const [id, attr] = [asked.split("#")[0].replace(/\.md$/, ""), asked.split("#")[1]];
  if (res.excluded.some((x) => x.id === id)) return `**hidden from it** (it was told "no ${attr ? "fact" : "note"}")`;
  if (attr && res.hiddenFacts.some((h) => h.key === `${id}#${attr}`)) return '**hidden from it** (it was told "no fact")';
  return undefined;
}

function lookedFor(es: ReadEntry[], res: CarveResult): string[] {
  const searches = es.filter((e) => e.q);
  const refused = es.filter((e) => e.asked);
  if (!searches.length && !refused.length) return [];
  return [`## What ${es[0].agent} looked for`,
    ...searches.slice(-10).map((e) => `- ${day(e.at)} ${e.op} "${e.q}": ${(e.ids ?? []).length} result(s)`),
    ...refused.slice(-10).map((e) => `- ${day(e.at)} asked for ${e.asked}: ${hiddenAsk(e.asked!, res) ?? "doesn't exist"}`),
    ""];
}

export function explainAgent(root: string, agent: string, topic?: string, opts: { now?: string; limit?: number } = {}): { ok: boolean; lines: string[] } {
  const now = opts.now ?? today();
  const rules = loadRules(root);
  const a = rules.policy.agents[agent];
  if (!a) return { ok: false, lines: [`${agent} isn't in rules/policy.yaml`] };
  const notes = loadBrain(root);
  const grant = grantFor(rules, agent);
  const res = carve(notes, rules, grant);
  const entries = readEntries(root);
  const byNote = specificReads(entries);
  const chain = verifyChain(join(root, "log", "reads.jsonl"));
  const pulls = entries.filter((e) => e.agent === agent && (e.ids ?? []).includes("*"));

  const lines = [
    `# ${agent}${a.inside_wall ? " (inside the wall: sees everything)" : ""}`,
    `slices: ${grant.slices.join(", ") || "(none)"}; ceiling: ${grant.ceiling}${grant.exclude_types.length ? `; not shared: ${grant.exclude_types.join(", ")}` : ""}${grant.exclude.length ? `; excluded by name: ${grant.exclude.length}` : ""}; tier ${a.tier}${a.status && a.status !== "active" ? `; ${a.status.toUpperCase()} by you` : ""}`,
    `holds ${res.visible.size} of ${notes.length} notes; ${res.hiddenFacts.length} fact(s) held back inside notes it holds`,
    chain.broken
      ? `! read log: chain broken at line ${chain.broken} (${chain.why}). The "read by" lines below can't be trusted past that point.`
      : `read log: ${chain.entries} entries, chain intact${chain.unchained ? ` (${chain.unchained} older lines from before the chain)` : ""}`,
    `whole-view pulls by ${agent}: ${pulls.length}${pulls.length ? ` (last ${day(pulls.at(-1)!.at)}); each one included every note that was in at the time` : ""}`,
    "",
  ];

  if (!topic) {
    const g = new Map<string, number>();
    for (const h of res.hiddenFacts) g.set(h.reason, (g.get(h.reason) ?? 0) + 1);
    if (g.size) lines.push("## Facts held back", ...[...g].map(([r, n]) => `- ${r}: ${n}`), "");
    const out = new Map<string, number>();
    for (const e of res.excluded) { const k = e.reason.startsWith("no slice") ? "outside its slices" : e.reason; out.set(k, (out.get(k) ?? 0) + 1); }
    if (out.size) lines.push("## Notes out", ...[...out].sort((x, y) => y[1] - x[1]).map(([r, n]) => `- ${r}: ${n}`), "");
    const mine = entries.filter((e) => e.agent === agent);
    const count = new Map<string, number>();
    for (const e of mine) for (const id of e.ids ?? []) if (id !== "*") count.set(id, (count.get(id) ?? 0) + 1);
    lines.push(`## What ${agent} read (${mine.length} requests)`, ...[...count].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([id, n]) => `- ${id}: ${n}x${res.visible.has(id) ? "" : " (out today)"}`), "");
    lines.push(...lookedFor(mine, res));
    const odd = [...count.keys()].filter((id) => !res.visible.has(id));
    if (odd.length) lines.push(`! ${odd.length} note(s) ${agent} was handed are out today: ${odd.join(", ")}. Rules changed since, or something to look into.`, "");
    if (res.flags.length) lines.push(`## Preview flags (${res.flags.length})`, ...res.flags.slice(0, 10).map((f) => `- ${f.id}: ${f.detail}`), "");
    return { ok: true, lines };
  }

  // A topic is a note id, a fact key, or words.
  const [tid, tattr] = topic.split("#");
  let targets: Note[] = notes.filter((n) => n.fm.id === tid);
  if (!targets.length) {
    const hits = rank(buildIndex(everything(notes, rules), rules, now), topic, opts.limit ?? 8);
    targets = hits.map((h) => notes.find((n) => n.fm.id === h.id)!).filter(Boolean);
  }
  const words = topic.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const related = (e: ReadEntry) => (e.q && words.some((w) => e.q!.toLowerCase().includes(w))) || (e.asked && (e.asked.replace(/\.md$/, "") === tid || words.some((w) => e.asked!.toLowerCase().includes(w))));
  const tried = lookedFor(entries.filter((e) => e.agent === agent && related(e)), res);
  if (!targets.length) { lines.push(`Nothing in the brain matches "${topic}".`, "", ...tried); return { ok: true, lines }; }
  const inCount = targets.filter((n) => res.visible.has(n.fm.id)).length;
  lines.push(`## "${topic}": ${targets.length} note(s) in the brain, ${inCount} in ${agent}'s slice`, "");
  if (tried.length) lines.push(...tried);
  for (const n of targets) {
    const block = noteBlock(n, agent, res, rules, now, byNote, n.fm.id === tid ? tattr : undefined);
    lines.push(...block, "");
  }
  return { ok: true, lines };
}
