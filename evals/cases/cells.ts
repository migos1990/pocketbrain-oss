// SPDX-License-Identifier: AGPL-3.0-only
// Per-agent cells (src/cell.ts): each outside agent's reads are answered from a directory that
// holds only its slice. Checked with the independent leak oracle, not with carve.ts: a cell
// must hold no carved value, no id of a note hidden from the agent, and no other agent's name,
// and every read through the cell must match the hub path. Runs on the synthetic brain and,
// with PB_BRAIN, on a copy of the real one (reports name agents and counts, never values).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { SRC, loadPB } from "../lib/pb";
import { realBrainPath, sandbox } from "../lib/sandbox";
import { forbiddenFor, findLeaks } from "../lib/oracle";
import { ok, na, type Case, type Result } from "../lib/case";

const cell = existsSync(join(SRC, "cell.ts")) ? await import(join(SRC, "cell.ts")) : undefined;
const core = existsSync(join(SRC, "core.ts")) ? await import(join(SRC, "core.ts")) : undefined;
const pb = await loadPB();


const files = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? files(p) : [p]; });
const outside = (root: string) => Object.entries(pb.rules.loadRules(root).policy.agents as Record<string, any>).filter(([, a]) => !a.inside_wall).map(([n]) => n);

async function noLeak(root: string): Promise<Result> {
  cell.buildCells(root);
  const agents = outside(root);
  const all = pb.brain.loadBrain(root);
  const allAgents = Object.keys(pb.rules.loadRules(root).policy.agents);
  const bad: string[] = [];
  let scanned = 0;
  for (const a of agents) {
    const dir = cell.cellDir(root, a);
    const text = files(dir).map((f) => relative(dir, f) + "\n" + readFileSync(f, "utf8")).join("\n");
    scanned += text.length;
    const leaks = findLeaks(text, await forbiddenFor(root, a));
    if (leaks.length) bad.push(`${a}: ${leaks.length} carved value(s) (${[...new Set(leaks.map((l) => l.from))].slice(0, 3).join(", ")})`);
    // Ids of notes the agent can't see: whatever the hub's own view for it leaves out.
    const view = core.contextPack(root, a);
    const hidden = all.map((n: any) => n.fm.id as string).filter((id) => !view.includes(id) && !text.includes(`id: ${id}\n`));
    const named = hidden.filter((id) => new RegExp(`(^|[^\\w/-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w/-]|$)`).test(text));
    if (named.length) bad.push(`${a}: names ${named.length} hidden note id(s) (${named.slice(0, 3).join(", ")})`);
    // Its policy and cell metadata name no other agent (notes it may see can mention them).
    const meta = ["rules/policy.yaml", "cell.json"].map((f) => join(dir, f)).filter(existsSync).map((f) => readFileSync(f, "utf8")).join("\n");
    const others = allAgents.filter((o) => o !== a && new RegExp(`\\b${o}\\b`, "i").test(meta));
    if (others.length) bad.push(`${a}: its policy names ${others.join(", ")}`);
  }
  return ok(bad.length === 0, bad.length ? bad.join("; ") : `${agents.length} cells clean (${Math.round(scanned / 1024)} KB scanned)`);
}

// A cell drops who wrote a fact and who else may see it (by design: it shouldn't know other
// agents exist), so those two fields are left out of the comparison; everything else must match.
const norm = (v: unknown) => JSON.stringify(v, (k, x) => (k === "by" || k === "share_with" ? undefined : x));

function sameAsHub(root: string, topics: string[]): Result {
  const agents = outside(root);
  const diffs: string[] = [];
  let compared = 0;
  const both = (fn: () => unknown) => {
    cell.useCells(false); let hub: unknown, viaCell: unknown;
    try { hub = fn(); } catch (e) { hub = `error: ${(e as Error).message}`; }
    cell.useCells(true);
    try { viaCell = fn(); } catch (e) { viaCell = `error: ${(e as Error).message}`; }
    cell.useCells(false);
    compared++;
    return norm(hub) === norm(viaCell);
  };
  try {
    for (const a of agents) {
      if (!both(() => core.contextPack(root, a))) diffs.push(`${a} context_pack`);
      for (const t of topics) {
        if (!both(() => core.search(root, a, t, 20))) diffs.push(`${a} search "${t}"`);
        if (!both(() => core.contextPack(root, a, t))) diffs.push(`${a} context_pack "${t}"`);
      }
      // Every note id in the brain, visible or not: hidden ones must be refused the same way.
      for (const id of pb.brain.loadBrain(root).map((n: any) => n.fm.id as string)) if (!both(() => core.readNote(root, a, id))) diffs.push(`${a} read ${id}`);
    }
  } finally { cell.useCells(false); }
  return ok(diffs.length === 0, diffs.length ? `${diffs.length} differ: ${diffs.slice(0, 5).join(", ")}` : `${compared} reads identical`);
}

const ready = () => (!cell ? "no cells at this commit" : !core ? "no core at this commit" : undefined);
const TOPICS = ["session 6", "Jane", "bank", "room", "next step", "compensation", "course"];

export function cellCases(): Case[] {
  const real = () => realBrainPath() ? undefined : "PB_BRAIN not set";
  return [
    { id: "cell-no-leak", dimension: "carving", kind: "attack", title: "each agent's cell holds no carved value, no hidden note id and no other agent", run: async () => ready() ? na(ready()!) : noLeak(sandbox()) },
    { id: "cell-matches-hub", dimension: "carving", title: "every read through a cell matches the hub path (context, search, read)", run: async () => ready() ? na(ready()!) : sameAsHub(sandbox(), TOPICS) },
    { id: "cell-real-no-leak", dimension: "carving", kind: "attack", source: "real", title: "real brain: each agent's cell holds no carved value, no hidden note id and no other agent", run: async () => ready() || real() ? na((ready() ?? real())!) : noLeak(sandbox("real")) },
    { id: "cell-real-matches-hub", dimension: "carving", source: "real", title: "real brain: reads through cells match the hub path", run: async () => ready() || real() ? na((ready() ?? real())!) : sameAsHub(sandbox("real"), ["course", "meeting", "next step", "decision"]) },
  ];
}
