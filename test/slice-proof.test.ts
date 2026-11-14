// SPDX-License-Identifier: AGPL-3.0-only
// The nightly slice check (src/slice-proof.ts, scripts/slice-proof.ts, docs/slice-proof.md): the
// line, the record, the heartbeat, and the script itself on a few made-up memories.
import { test, expect } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { makeBrain } from "./fixture";
import { sliceProofNight, sliceProofLine, sliceProofStreak, sliceProofs, lastSliceProof, seedsFor, type SliceProof } from "../src/slice-proof";
import { readBeat, lateJobs } from "../src/heartbeat";

const child = (line: string, exit = 0) => () => ({ exited: Promise.resolve(exit), stdout: new Response(line + "\n").body, kill: () => {} });
const result = (over: Partial<SliceProof> = {}) => JSON.stringify({ memories: 300, doors: ["mcp", "api", "browser"], leaks: 0, pages: 2890, facts: 9000, readers: 1400, answers: 120000, failed_seeds: [], ms: 1, ...over });

test("slice proof: the line says memories, doors and leaks, in the same words everywhere", () => {
  const rows: [Pick<SliceProof, "memories" | "doors" | "leaks">, string][] = [
    [{ memories: 300, doors: ["mcp", "api", "browser"], leaks: 0 }, "300 memories, 3 doors, 0 leaks"],
    [{ memories: 1, doors: ["mcp"], leaks: 1 }, "1 memory, 1 door, 1 leak"],
    [{ memories: 12000, doors: ["mcp", "api", "browser"], leaks: 2 }, "12,000 memories, 3 doors, 2 leaks"],
  ];
  for (const [p, line] of rows) expect(sliceProofLine(p)).toBe(line);
});

test("slice proof: every night reads memories no other night read", () => {
  const a = seedsFor("2026-11-14"), b = seedsFor("2026-11-15");
  expect(a.to - a.from + 1).toBe(300);
  expect(b.from).toBeGreaterThan(a.to);
  expect(seedsFor("2026-11-14")).toEqual(a);
  // Clear of the seeds `bun test` and the frozen fixtures use (7,000 and up).
  expect(a.from).toBeGreaterThan(1_000_000);
});

test("slice proof: a clean night is one dated record and a good heartbeat; nothing else is written to the brain", async () => {
  const root = makeBrain();
  const before = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: root }).stdout.toString();
  let cmd: string[] = [];
  const said = await sliceProofNight(root, { day: "2026-11-14", spawn: (c) => { cmd = c; return child(result())(); }, now: () => new Date("2026-11-14T08:40:00Z") });
  expect(said).toBe("slice check: 300 memories, 3 doors, 0 leaks (120,000 answers read)");
  expect(cmd.slice(1)).toEqual([join(import.meta.dir, "..", "scripts", "slice-proof.ts"), "--json", "--from", String(seedsFor("2026-11-14").from), "--cases", "300"]);
  const p = lastSliceProof(root)!;
  expect({ at: p.at, memories: p.memories, doors: p.doors, leaks: p.leaks, seeds: p.seeds }).toEqual({ at: "2026-11-14T08:40:00.000Z", memories: 300, doors: ["mcp", "api", "browser"], leaks: 0, seeds: seedsFor("2026-11-14") });
  expect(readBeat(root, "slice_proof")?.ok).toBe(true);
  // log/ is not in the brain's git: the brain itself is as it was.
  expect(Bun.spawnSync(["git", "status", "--porcelain"], { cwd: root }).stdout.toString().split("\n").filter((l) => !/ log\//.test(l)).join("\n")).toBe(before);
});

test("slice proof: a night that leaked fails its heartbeat, so the home says so, and ends the streak", async () => {
  const root = makeBrain();
  const now = () => new Date("2026-11-14T08:40:00Z");
  await sliceProofNight(root, { day: "2026-11-12", spawn: child(result()), now });
  await sliceProofNight(root, { day: "2026-11-13", spawn: child(result()), now });
  expect(sliceProofStreak(sliceProofs(root))).toMatchObject({ nights: 2, memories: 600 });
  const said = await sliceProofNight(root, { day: "2026-11-14", spawn: child(result({ leaks: 2, failed_seeds: [1020301, 1020377] }), 1), now });
  expect(said).toContain("300 memories, 3 doors, 2 leaks");
  const b = readBeat(root, "slice_proof")!;
  expect([b.ok, b.error]).toEqual([false, expect.stringContaining("seeds 1020301, 1020377")]);
  expect(lateJobs(root, now()).map((l) => [l.job, l.why])).toContainEqual(["slice_proof", "failed"]);
  expect(sliceProofStreak(sliceProofs(root)).nights).toBe(0);
  expect(lastSliceProof(root)!.leaks).toBe(2); // the line shows the leak; it is never hidden behind an older clean night
});

test("slice proof: a run that broke or never ended is never a result", async () => {
  const root = makeBrain();
  const rows: [string, Parameters<typeof sliceProofNight>[1]][] = [
    ["no result line", { spawn: child("", 2) }],
    ["the script's own error", { spawn: child(JSON.stringify({ memories: 3, doors: ["mcp"], leaks: 0, error: "the browser door didn't sign ava in" }), 2) }],
    ["a run cut short", { spawn: child(result({ memories: 1 })) }],
    ["a run that read nothing", { spawn: child(result({ answers: 0 })) }],
    ["a run through no door", { spawn: child(result({ doors: [] })) }],
    ["a child that never ends", { spawn: () => ({ exited: new Promise<number>(() => {}), stdout: null, kill: () => {} }), timeoutMs: 20 }],
  ];
  for (const [what, o] of rows) {
    const said = await sliceProofNight(root, { day: "2026-11-14", ...o });
    expect([what, said.startsWith("slice check: didn't finish")]).toEqual([what, true]);
    expect([what, readBeat(root, "slice_proof")?.ok]).toEqual([what, false]);
  }
  expect(lastSliceProof(root)).toBeUndefined();
  expect(sliceProofs(root).every((p) => !!p.error)).toBe(true);
});

test("slice proof: the script reads made-up memories through three doors and prints one line of counts", async () => {
  const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "scripts", "slice-proof.ts"), "--json", "--from", "7000", "--cases", "1"], { env: { PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? "", HOME: process.env.HOME ?? "" } });
  const out = JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!);
  expect({ exit: r.exitCode, memories: out.memories, doors: out.doors, leaks: out.leaks, error: out.error }).toEqual({ exit: 0, memories: 1, doors: ["mcp", "api", "browser"], leaks: 0, error: undefined });
  expect(out.answers).toBeGreaterThan(200);
  // It names no brain but its own: the script never reads PB_BRAIN or a path argument.
  expect(readFileSync(join(import.meta.dir, "..", "scripts", "slice-proof.ts"), "utf8")).not.toMatch(/process\.env\.PB_BRAIN|--brain/);
}, 120_000);
