// SPDX-License-Identifier: AGPL-3.0-only
// The usefulness number (src/usefulness.ts, docs/prove-the-loop.md#usefulness): how many questions
// each assistant can answer from what it gets back, in how many tokens, and how much of it is noise.
//
//   bun scripts/usefulness.ts                      the demo brain and its twenty questions
//   bun scripts/usefulness.ts --compare <json>     ...and the change from a saved run
//   bun scripts/usefulness.ts --save <json>        ...and save this run (evals/baselines/usefulness.json)
//   bun scripts/usefulness.ts --brain <path>       a real brain, read-only, counts only
//   ... --shapes                                   also the pack in three shapes side by side, per assistant
//   ... --lost                                     also each question eight whole notes answer and today's
//                                                  pack doesn't: set, place in it, where its note was and is
//
// A real brain is never touched: it is cloned into a temporary folder (with its reads log, for the
// questions assistants really asked), measured there, and the clone deleted. Its output is counts
// only, no question, note, name or value, so it can be relayed. It also prints which doors the
// assistants used in the last 14 days (counts per tool), since a pack nobody calls answers nothing.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreUsefulness, countsText, detailText, compareShapes, shapesText, lostToWide, lostText, type UAgent } from "../src/usefulness";
import { readJsonl } from "../src/util";

const argv = process.argv.slice(2);
const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const SET = join(import.meta.dir, "..", "evals", "fixtures", "usefulness-demo.yaml");

async function demo(): Promise<string> {
  const { copyBase, replayWeek, DEMO_NOW, DEMO_DAY } = await import("./demo-brain");
  process.env.PB_NOW = DEMO_NOW; process.env.PB_TODAY = DEMO_DAY;
  const dir = mkdtempSync(join(tmpdir(), "pb-useful-"));
  copyBase(dir);
  // Each assistant checked in once before the week (its first memory_check takes what it knows),
  // so the memory_check door has a feed to score on the demo, as it has on a brain in use.
  const { memoryCheck } = await import("../src/memsync");
  const { assistants } = await import("../src/usefulness");
  for (const a of assistants(dir)) memoryCheck(dir, a);
  await replayWeek(dir);
  return dir;
}

function clone(brain: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pb-useful-real-"));
  const c = Bun.spawnSync(["git", "clone", "--quiet", "--no-hardlinks", brain, dir], { stdout: "pipe", stderr: "pipe" });
  if (c.exitCode !== 0) throw new Error(`can't clone the brain (${c.stderr.toString().trim().split("\n").at(-1)})`);
  // The reads and memory-sync logs aren't in git: copied, so the questions assistants asked can be
  // harvested and the memory_check door sees each assistant's feed.
  mkdirSync(join(dir, "log"), { recursive: true });
  for (const f of ["reads.jsonl", "memsync.jsonl"]) if (existsSync(join(brain, "log", f))) copyFileSync(join(brain, "log", f), join(dir, "log", f));
  return dir;
}

// Calls per tool in the 14 days up to the last one logged (log/calls.jsonl, else the reads log's ops): counts only.
function doorUse(brain: string): string {
  const n = new Map<string, number>();
  const calls = join(brain, "log", "calls.jsonl"), reads = join(brain, "log", "reads.jsonl");
  const rows = existsSync(calls) ? readJsonl<{ at?: string; tool?: string; route?: string }>(calls).map((r) => ({ at: r.at, k: r.tool ?? r.route }))
    : existsSync(reads) ? readJsonl<{ at?: string; op?: string }>(reads).map((r) => ({ at: r.at, k: r.op })) : [];
  // The 14 days up to the last call logged, so a brain not used lately still says what was used.
  const since = Math.max(0, ...rows.map((r) => Date.parse(r.at ?? "") || 0)) - 14 * 86_400_000;
  for (const r of rows) if (r.k && r.at && Date.parse(r.at) >= since) n.set(r.k, (n.get(r.k) ?? 0) + 1);
  const top = [...n].sort((a, b) => b[1] - a[1]).slice(0, 8).filter(([k]) => /^[\w/.-]+$/.test(k));
  return `doors used in 14 days: ${top.map(([k, v]) => `${k} ${v}`).join(", ") || "none logged"}`;
}

const key = (a: UAgent) => `${a.agent}/${a.door}`;
function compare(now: UAgent[], file: string): string {
  if (!existsSync(file)) return `no saved run at ${file}`;
  const was = new Map((JSON.parse(readFileSync(file, "utf8")) as UAgent[]).map((a) => [key(a), a]));
  const d = (x: number) => (x > 0 ? `+${x}` : `${x}`);
  return ["change from the saved run:", ...now.map((a) => {
    const w = was.get(key(a));
    return w ? `  ${a.agent} by ${a.door}: answered ${d(a.all.answered - w.all.answered)}, median tokens ${d(a.tokens.median - w.tokens.median)}, noise ${d(a.noise - w.noise)} points` : `  ${a.agent} by ${a.door}: new`;
  })].join("\n");
}

const brain = arg("--brain");
const root = brain ? clone(brain) : await demo();
try {
  const s = scoreUsefulness(root, brain ? {} : { file: SET });
  console.log(brain ? countsText(s) : argv.includes("--detail") ? detailText(s) : countsText(s));
  if (brain) console.log(doorUse(brain));
  if (argv.includes("--shapes")) console.log(shapesText(compareShapes(root, brain ? {} : { file: SET })));
  if (argv.includes("--lost")) console.log(lostText(lostToWide(root, brain ? {} : { file: SET })));
  const cmp = arg("--compare");
  if (cmp) console.log(compare(s.agents, cmp));
  const save = arg("--save");
  if (save) writeFileSync(save, JSON.stringify(s.agents, null, 2) + "\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
