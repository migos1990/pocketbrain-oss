// SPDX-License-Identifier: AGPL-3.0-only
// The hub's filing step takes a file lock shared by every process on this brain (backlog
// #263): the hub's tick, `pocketbrain filing now` by hand, or a second copy of either. While one
// holds it, another decides nothing; a lock left by a dead process is taken over.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { runAuto, runAutoByHand } from "../src/filing";
import { weigh } from "./asked";
import { openItems } from "../src/textline/items";
import { withFileLock, lockPath } from "../src/filelock";

const NOW = new Date();
const days = (d: number) => new Date(NOW.getTime() + d * 86_400_000);
function brain() {
  const root = makeBrain();
  writeFileSync(join(root, "rules/escalation.yaml"), "health: { url: null }\nauto_decide: { proposal_days: 3 }\n");
  Bun.spawnSync(["git", "-C", root, "add", "-A"]);
  Bun.spawnSync(["git", "-C", root, "-c", "user.name=louis", "-c", "user.email=l@x", "commit", "-qm", "setup"]);
  write(root, { agent: "helper", id: "people/jane-roy", attribute: "role", value: "Associate dean", as_of: "2026-10-07", sources: ["gmail:1a0e88a496d9705a"] });
  weigh(root, NOW); // the clock starts now
  return root;
}
const head = (root: string) => Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"]).stdout.toString().trim();
// A live process that isn't this one, holding the lock as another pocketbrain would.
function heldByOther(root: string) {
  const p = Bun.spawn(["sleep", "30"]);
  writeFileSync(lockPath(root, "decide"), JSON.stringify({ pid: p.pid, at: new Date().toISOString() }));
  return p;
}

test("while another live process holds the lock, the hub's tick decides nothing and a hand run is refused", async () => {
  const root = brain(), before = head(root);
  const other = heldByOther(root);
  try {
    expect(runAuto(root, days(4))).toEqual([]);
    expect(head(root)).toBe(before);
    expect(openItems(root).some((i) => i.kind === "proposal")).toBe(true);
    const r = await runAutoByHand(root, days(4), () => Promise.reject(new Error("no hub")));
    expect("refused" in r && r.refused).toContain("another pocketbrain process is deciding");
  } finally { other.kill(); }
  // Released: the next tick decides, once.
  await other.exited;
  expect(runAuto(root, days(4)).length).toBe(1);
  expect(runAuto(root, days(4))).toEqual([]);
});

test("a lock left by a process that died is taken over, and the lock is gone after a run", () => {
  const root = brain();
  writeFileSync(lockPath(root, "decide"), JSON.stringify({ pid: 2 ** 22 + 12345, at: new Date().toISOString() }));
  expect(runAuto(root, days(4)).length).toBe(1);
  expect(existsSync(lockPath(root, "decide"))).toBe(false);
});

test("withFileLock: busy returns undefined without running, an error inside still releases it, a garbled lock is stale", () => {
  const root = makeBrain();
  expect(withFileLock(root, "x", () => withFileLock(root, "x", () => "inner"))).toBeUndefined();
  expect(() => withFileLock(root, "x", () => { throw new Error("boom"); })).toThrow("boom");
  expect(withFileLock(root, "x", () => 7)).toBe(7);
  writeFileSync(lockPath(root, "x"), "not json");
  expect(withFileLock(root, "x", () => 8)).toBe(8);
  expect(readFileSync(join(root, ".git", "HEAD"), "utf8")).toContain("ref:");
});

test("race: four processes run the filing step at once on one brain; exactly one decides", async () => {
  const root = brain(), at = days(4).toISOString();
  const script = `const { runAuto } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "filing.ts"))}); console.log(JSON.stringify(runAuto(${JSON.stringify(root)}, new Date(${JSON.stringify(at)})).map((d) => d.key)));`;
  const ps = [0, 1, 2, 3].map(() => Bun.spawn(["bun", "-e", script], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" }));
  const outs = await Promise.all(ps.map(async (p) => { await p.exited; return new Response(p.stdout).text(); }));
  const decided = outs.flatMap((o) => { try { return JSON.parse(o.trim().split("\n").pop() || "[]"); } catch { return []; } });
  expect(decided.length).toBe(1);
  const log = join(root, "log", "auto-decisions.jsonl");
  if (existsSync(log)) expect(readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length).toBe(1);
}, 30_000);
