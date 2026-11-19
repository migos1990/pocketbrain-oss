// SPDX-License-Identifier: AGPL-3.0-only
// The verify walk (scripts/verify.ts, G985): what blocks is decided by code, the feature map is
// the one in the docs, and one flow really runs: a phone-wide dark page, a typed search, a tap.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLOWS, PHONE, TAP_BUDGET_MS, problems, slowestTap, touchesScreens, type Flow, type StepResult } from "../scripts/verify";

const flows: Flow[] = [{ name: "f", what: "w", steps: [
  { does: "open", act: { open: "/home" }, shows: { text: "x" } },
  { does: "tap", act: { tap: { role: "button", name: "Go" } }, shows: { text: "y" } },
] }];
const r = (n: number, over: Partial<StepResult> = {}): StepResult => ({ flow: "f", n, does: n === 1 ? "open" : "tap", ms: 100, ok: true, faults: [], ...over });

test("a clean walk has no problems", () => {
  expect(problems([r(1), r(2)], flows)).toEqual([]);
});

test("a slow tap blocks; a slow page load by address does not", () => {
  expect(problems([r(1, { ms: 9000 }), r(2)], flows)).toEqual([]);
  expect(problems([r(1), r(2, { ms: TAP_BUDGET_MS + 1 })], flows)).toEqual([`f step 2 (tap): the tap took ${TAP_BUDGET_MS + 1} ms to show its result, over ${TAP_BUDGET_MS} ms`]);
  expect(problems([r(1), r(2, { ms: 900 })], flows, 500)).toHaveLength(1);
});

test("a step that didn't show its result, a fault on a step that did, and a step that never ran all block", () => {
  expect(problems([r(1), r(2, { ok: false, faults: ["Timeout"] })], flows)).toEqual(["f step 2 (tap): didn't reach what it should show: Timeout"]);
  expect(problems([r(1, { faults: ["the page is 12px wider than the phone", "500 from /home"] }), r(2)], flows)).toEqual([
    "f step 1 (open): the page is 12px wider than the phone", "f step 1 (open): 500 from /home"]);
  expect(problems([r(1)], flows)).toEqual(["f: 1 of 2 steps ran"]);
  expect(problems([], flows)).toEqual(["f: 0 of 2 steps ran"]);
});

test("the trigger is the ui lane: an owner screen runs it, a backend file does not", () => {
  expect(touchesScreens(["src/dashboard/html-home.ts", "src/write.ts"])).toBe(true);
  expect(touchesScreens(["src/browser.ts"])).toBe(true);
  expect(touchesScreens(["src/write.ts", "docs/filing.md", "scripts/gate.ts"])).toBe(false);
});

test("the feature map: phone width, every flow starts by opening a page, and the docs list each flow", () => {
  expect(PHONE.width).toBe(390);
  const doc = readFileSync(join(import.meta.dir, "..", "docs", "ui-quality.md"), "utf8");
  const names = FLOWS.map((f) => f.name);
  expect(new Set(names).size).toBe(names.length);
  for (const f of FLOWS) {
    expect("open" in f.steps[0].act).toBe(true);
    expect(f.steps.some((s) => !("open" in s.act))).toBe(true);
    expect(doc).toContain(`| \`${f.name}\` | ${f.what} |`);
  }
  const rows = doc.split("\n").filter((l) => /^\| `[a-z-]+` \| /.test(l));
  expect(rows).toHaveLength(FLOWS.length);
});

test("the skill and the list say the same flows", () => {
  const out = Bun.spawnSync(["bun", "scripts/verify.ts", "--list"], { cwd: join(import.meta.dir, ".."), stdout: "pipe" });
  expect(out.exitCode).toBe(0);
  for (const f of FLOWS) expect(out.stdout.toString()).toContain(`${f.name}: ${f.what}`);
  expect(readFileSync(join(import.meta.dir, "..", ".claude", "skills", "verify", "SKILL.md"), "utf8")).toContain("bun scripts/verify.ts --for origin/main");
});

test("one flow really runs on the demo brain: typed, tapped, timed, a picture per step", async () => {
  const out = mkdtempSync(join(tmpdir(), "pb-verify-test-"));
  // The budget is wide here: this run shares the machine with the whole suite, and the budget's own
  // rule is tested above.
  const p = Bun.spawn(["bun", "scripts/verify.ts", "--only", "memory", "--budget", "60000", "--json", "--out", out], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const text = await new Response(p.stdout).text();
  expect(await p.exited).toBe(0);
  const got = JSON.parse(text.trim().split("\n").at(-1)!) as { results: StepResult[]; problems: string[] };
  expect(got.problems).toEqual([]);
  expect(got.results.map((x) => x.ok)).toEqual([true, true, true]);
  expect(readdirSync(out).sort()).toEqual(["memory-1.png", "memory-2.png", "memory-3.png"]);
  expect(existsSync(join(out, "memory-3.png"))).toBe(true);
}, 120_000);

test("a flow name that doesn't exist is refused, not passed, also beside one that does; so is a budget that isn't a number", () => {
  const run = (...a: string[]) => Bun.spawnSync(["bun", "scripts/verify.ts", ...a], { cwd: join(import.meta.dir, ".."), stderr: "pipe", stdout: "pipe" });
  expect(run("--only", "nope").exitCode).toBe(2);
  const mixed = run("--only", "memory,nope");
  expect(mixed.exitCode).toBe(2);
  expect(mixed.stderr.toString()).toContain("no such flow: nope");
  expect(run("--only", "memory", "--budget", "fast").exitCode).toBe(2);
  expect(run("--only", "memory", "--budget", "--json").exitCode).toBe(2);
  expect(run("--only", "memory", "--budget", "0").exitCode).toBe(2);
}, 60_000);

test("the slowest tap leaves out page loads by address", () => {
  expect(slowestTap([r(1, { ms: 9000 }), r(2, { ms: 240 })], flows)).toBe(240);
  expect(slowestTap([r(1, { ms: 9000 })], flows)).toBe(0);
});

test("--for sees an edit that isn't committed yet", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-verify-for-"));
  const g = (...a: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@x", ...a], { stdout: "pipe" });
  g("init", "-q", "-b", "main"); mkdirSync(join(dir, "src", "dashboard"), { recursive: true });
  writeFileSync(join(dir, "src", "dashboard", "home.ts"), "a\n"); writeFileSync(join(dir, "notes.md"), "a\n");
  g("add", "-A"); g("commit", "-qm", "base"); g("branch", "base");
  writeFileSync(join(dir, "notes.md"), "b\n"); g("commit", "-qam", "docs only");
  const run = () => Bun.spawnSync(["bun", join(import.meta.dir, "..", "scripts", "verify.ts"), "--for", "base", "--only", "nope"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  // Nothing the owner sees changed: not run, exit 0, before the flow name is even read.
  expect(run().stdout.toString()).toContain("not run");
  expect(run().exitCode).toBe(0);
  // The same checkout with a screen edited and not committed: it goes on (and here stops at the flow name).
  writeFileSync(join(dir, "src", "dashboard", "home.ts"), "b\n");
  expect(run().exitCode).toBe(2);
  // A new screen file not yet added counts too.
  g("checkout", "-q", "--", "src/dashboard/home.ts"); writeFileSync(join(dir, "src", "dashboard", "new.ts"), "x\n");
  expect(run().exitCode).toBe(2);
}, 60_000);
