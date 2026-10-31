// SPDX-License-Identifier: AGPL-3.0-only
// The pre-push hook runs the suite from inside git, which exports GIT_DIR (and friends) to hooks.
// Test fixtures that run git would then write into the pushing repo itself, so the hook drops them first.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const hook = readFileSync(join(import.meta.dir, "..", ".githooks", "pre-push"), "utf8");

test("pre-push clears git's hook environment before running anything", () => {
  const lines = hook.split("\n");
  const first = lines.findIndex((l) => /^\s*(bun|bunx|git)\b/.test(l));
  const unset = lines.findIndex((l) => /^\s*unset\b/.test(l));
  expect(unset).toBeGreaterThan(-1);
  expect(unset).toBeLessThan(first);
  const prefix = lines.slice(0, unset + 1).join("\n") + '\necho "${GIT_DIR-none}|${GIT_WORK_TREE-none}|${GIT_INDEX_FILE-none}"\n';
  const out = Bun.spawnSync(["sh", "-c", prefix], { env: { ...process.env, GIT_DIR: "/x/.git", GIT_WORK_TREE: "/x", GIT_INDEX_FILE: "/x/.git/index" } });
  expect(out.stdout.toString().trim()).toBe("none|none|none");
});

// Audit v4: "the gate blocks, but nothing automated runs the gate". The hook runs the north star on
// every push, and the gate's rules on a push to main.
test("pre-push runs the north star, and the gate's rules against main's old tip on a push to main", () => {
  expect(hook).toMatch(/^bun scripts\/north-star\.ts$/m);
  expect(hook).toContain('bun scripts/gate.ts "$rsha" --no-run');
  const loop = hook.slice(hook.indexOf("refs=$(cat)"));
  const run = (stdin: string) => Bun.spawnSync(["sh", "-c", loop.replace(/^\s*bunx? .*$/gm, (l) => l.includes("gate.ts") ? 'echo "gate $rsha"' : ":")], { stdin: new TextEncoder().encode(stdin) }).stdout.toString().trim();
  const z = "0".repeat(40), a = "a".repeat(40), b = "b".repeat(40);
  expect(run(`refs/heads/main ${b} refs/heads/main ${a}\n`)).toBe(`gate ${a}`);
  expect(run(`refs/heads/x ${b} refs/heads/x ${a}\n`)).toBe("");
  expect(run(`refs/heads/main ${b} refs/heads/main ${z}\n`)).toBe("");
});

// The release job's own push (release.yml: the tag, then refs/heads/release) runs on a runner with
// none of the suite's tools; it points only at a main commit that passed all of this already, so the
// hook lets exactly that through and checks every other push in full (G541).
test("pre-push lets a tag or the release branch at a commit on origin/main through, and nothing else", () => {
  const dir = Bun.spawnSync(["mktemp", "-d"]).stdout.toString().trim();
  const g = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: dir }).stdout.toString().trim();
  g("init", "-q"); g("commit", "-q", "--allow-empty", "-m", "one");
  const onMain = g("rev-parse", "HEAD");
  g("update-ref", "refs/remotes/origin/main", onMain);
  g("tag", "-a", "v1", "-m", "v1");
  const tagObj = g("rev-parse", "v1");
  g("commit", "-q", "--allow-empty", "-m", "two");
  const off = g("rev-parse", "HEAD");
  const head = hook.slice(0, hook.indexOf("bun test\n"));
  const run = (stdin: string) => Bun.spawnSync(["sh", "-c", head + "echo FULL"], { cwd: dir, stdin: new TextEncoder().encode(stdin) }).stdout.toString().trim().split("\n").at(-1);
  const z = "0".repeat(40);
  expect(run(`refs/tags/v1 ${tagObj} refs/tags/v1 ${z}\n`)).toMatch(/nothing to check again/);
  expect(run(`refs/heads/x ${onMain} refs/heads/release ${z}\n`)).toMatch(/nothing to check again/);
  expect(run(`refs/tags/v2 ${off} refs/tags/v2 ${z}\n`)).toBe("FULL");
  expect(run(`refs/heads/x ${off} refs/heads/release ${z}\n`)).toBe("FULL");
  expect(run(`refs/tags/v1 ${tagObj} refs/tags/v1 ${z}\nrefs/heads/main ${onMain} refs/heads/main ${z}\n`)).toBe("FULL");
  expect(run("")).toBe("FULL");
  Bun.spawnSync(["rm", "-rf", dir]);
});
