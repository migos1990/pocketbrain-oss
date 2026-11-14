// SPDX-License-Identifier: AGPL-3.0-only
// The slice check, outside the test runner (docs/slice-proof.md): N made-up memories, each read as
// every one of its assistants through every door (test/carve-check.ts), each answer checked against
// the leak oracle. The hub runs it every night (src/slice-proof.ts); by hand:
//   bun scripts/slice-proof.ts                      300 memories, a line of counts
//   bun scripts/slice-proof.ts --cases 50 --from 7000 --json
// Exit 0 when nothing leaked, 1 when something did, 2 when the run broke.
// It makes its brains in a temp folder of its own and never reads PB_BRAIN or any brain on disk.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const num = (flag: string, d: number) => { const i = args.indexOf(flag); const v = i >= 0 ? Number(args[i + 1]) : d; return Number.isInteger(v) && v >= 0 ? v : d; };
const json = args.includes("--json");
const cases = Math.max(1, num("--cases", 300)), from = num("--from", 7_000);

// The run's own world, set before any pocketBrain code loads: temp brains, home, config, caches and
// git settings all inside one folder, removed at the end (as test/setup.ts does for a test run).
const run = mkdtempSync(join(tmpdir(), "pb-slice-proof-"));
for (const k of Object.keys(process.env)) if (/^PB_/.test(k)) delete process.env[k];
Object.assign(process.env, { TMPDIR: run, HOME: join(run, "home"), PB_TEST_RUN_DIR: run, PB_CONFIG_DIR: join(run, "config"), PB_MODEL_DIR: join(run, "models"), PB_VECTOR_DIR: join(run, "vectors"), PB_UPCOMING_DIR: join(run, "upcoming"), PB_TODAY: "2026-10-08" });
for (const d of ["home", "config"]) mkdirSync(join(run, d));
process.on("exit", () => { try { rmSync(run, { recursive: true, force: true }); } catch { /* best effort */ } });

const t0 = Date.now();
const out: { memories: number; doors: string[]; leaks: number; pages: number; facts: number; readers: number; answers: number; seeds: { from: number; to: number }; failed_seeds: number[]; ms: number; error?: string } =
  { memories: 0, doors: [], leaks: 0, pages: 0, facts: 0, readers: 0, answers: 0, seeds: { from, to: from + cases - 1 }, failed_seeds: [], ms: 0 };
try {
  const { isolateGit } = await import("../evals/lib/gitenv");
  isolateGit(run);
  const { useCells } = await import("../src/cell");
  const { check, brainOf, report, DOORS } = await import("../test/carve-check");
  out.doors = [...DOORS];
  for (let seed = from; seed < from + cases; seed++) {
    const g = await brainOf(seed);
    // As the hub serves (cells on, invariant 10) on even seeds, and from the brain itself on odd
    // ones, so both read paths are read every night.
    useCells(seed % 2 === 0);
    const c = await check(g);
    out.memories++; out.pages += c.pages; out.facts += c.facts; out.readers += c.readers; out.answers += c.answers;
    if (c.findings.length) { out.leaks++; out.failed_seeds.push(seed); if (!json) console.error(report(g, c.findings)); }
    rmSync(g.root, { recursive: true, force: true });
    if (!json && out.memories % 25 === 0) console.error(`${out.memories}/${cases}`);
  }
} catch (e) {
  out.error = (e as Error).message.slice(0, 300);
}
out.ms = Date.now() - t0;
if (json) console.log(JSON.stringify(out));
else console.log(out.error ? `slice check broke: ${out.error}` : `${out.memories} memories, ${out.doors.length} doors, ${out.leaks} leak(s); ${out.readers} assistants and tokens, ${out.pages} pages, ${out.answers} answers read, ${Math.round(out.ms / 1000)} s${out.failed_seeds.length ? `; replay: CARVE_SEED=${out.failed_seeds[0]} bun test test/carve-property.test.ts` : ""}`);
process.exit(out.error ? 2 : out.leaks ? 1 : 0);
