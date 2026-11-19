// SPDX-License-Identifier: AGPL-3.0-only
// The Mac can run the required `test` check when GitHub's own runners can't (2026-11-09: every PR
// run failed at startup with no job, PR 143 among them). ci/mac-runner-plan.md, docs/release.md
// "When GitHub's runners are down". The Mac holds the real brain, so the switch is narrow: the repo
// variable PB_RUNNER picks the runner, only in the private repo, never for a fork's PR, and the
// jobs that hold a deploy key or publish stay on GitHub's runners (G751).
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testFiles, shard } from "../scripts/test-shard";
import YAML from "yaml";

const ROOT = join(import.meta.dir, "..");
const wf = (f: string) => YAML.parse(readFileSync(join(ROOT, ".github", "workflows", f), "utf8"));
const ci = wf("ci.yml");

test("G751: test, e2e and conformance run on the Mac only when PB_RUNNER is set, in the private repo, for a branch of its own", () => {
  for (const job of ["suite", "suite-plain", "suite-cells", "test", "e2e", "conformance"]) {
    const on = String(ci.jobs[job]["runs-on"]);
    expect(on).toContain("vars.PB_RUNNER");
    expect(on).toContain("fromJSON(vars.PB_RUNNER)");
    expect(on).toContain("vars.PB_RUNNER && github.event.repository.private && ");
    expect(on).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(on).toMatch(/\|\| 'ubuntu-24.04' \}\}$/);
  }
});

test("G751: a fork's review, publishing and the public copy never run on the Mac", () => {
  expect(ci.jobs["outside-pr"]["runs-on"]).toBe("ubuntu-24.04");
  // The cold install starts a hub of its own: never on the Mac that runs the real one, and the private
  // repo spends no macOS minutes on it (only the public repo's run is on a Mac).
  expect(ci.jobs["cold-install"]["runs-on"]).toBe("ubuntu-24.04");
  expect(ci.jobs["cold-install-mac"]).toMatchObject({ if: "${{ !github.event.repository.private }}", "runs-on": "macos-latest" });
  for (const f of ["release.yml", "public-sync.yml", "docs-live.yml"]) for (const [name, j] of Object.entries(wf(f).jobs as Record<string, { "runs-on"?: string; uses?: string }>)) {
    if (j.uses) continue; // release.yml calls ci.yml, which keeps its own rule above
    expect(`${f} ${name} ${j["runs-on"]}`).toBe(`${f} ${name} ubuntu-24.04`);
  }
});

test("G751: the Linux-only steps have a macOS twin, and the Mac's gitleaks is pinned by its own checksum", () => {
  const steps = ci.jobs.suite.steps as { name?: string; run?: string; if?: string }[];
  const apt = steps.find((s) => s.run?.includes("apt-get"))!;
  expect(apt.if).toBe("runner.os == 'Linux'");
  const leaks = steps.find((s) => s.name === "gitleaks")!.run!;
  expect(leaks).toContain("gitleaks_8.21.2_darwin_arm64.tar.gz");
  expect(leaks).toContain("cad3de5dc9a4d5447d967a70a4d49499c557f04db028274cc324f9ff983f6502");
  expect(leaks).toContain("5bc41815076e6ed6ef8fbecc9d9b75bcae31f39029ceb55da08086315316e3ba");
  expect(leaks).toContain("shasum -a 256 -c");
  // On the Mac, age comes from the runner user's own install (the hand step), checked, never sudo.
  const mac = steps.find((s) => s.if === "runner.os == 'macOS'" && s.run?.includes("age"))!;
  expect(mac.run).not.toContain("sudo");
});

test("G958: no workflow runs on a floating Linux label: ubuntu-latest moved to 26.04 under us and Playwright refused it", () => {
  // 2026-11-16, main run on bdbd2381: `bunx playwright install --with-deps chromium` failed with
  // "Playwright does not support chromium on ubuntu26.04-x64" when ubuntu-latest moved to 26.04,
  // and no test ran. A Linux runner is named by its version; moving it is a change of its own.
  // cold-install-mac stays on macos-latest: public repo only, no Playwright, not a required check.
  const dir = join(ROOT, ".github", "workflows");
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    const text = readFileSync(join(dir, f), "utf8");
    expect(`${f}: ${text.match(/ubuntu-latest/g)?.length ?? 0}`).toBe(`${f}: 0`);
    for (const m of text.matchAll(/\b(?:ubuntu|windows)-[a-z]+\b/g)) expect(`${f}: ${m[0]}`).toBe(`${f}: (a version)`);
    expect((text.match(/macos-latest/g) ?? []).length).toBeLessThanOrEqual(f === "ci.yml" ? 1 : 0);
  }
});

test("G982, G1001: the suites run side by side, each in two parts, and the required `test` check is green only when every suite job succeeded", () => {
  const runs = (job: string) => (ci.jobs[job].steps as { run?: string }[]).map((s) => s.run ?? "").filter((r) => /\bbun test\b/.test(r));
  // The plain suite is its own job in two parts (G1001); `suite` keeps the scans, the rules and the evals.
  expect(runs("suite").length).toBe(0);
  expect(runs("suite-plain").length).toBe(1);
  expect(runs("suite-plain")[0]).toStartWith("bun test");
  expect(ci.jobs["suite-plain"].strategy.matrix.part).toEqual([1, 2]);
  expect(ci.jobs["suite-plain"].needs).toBeUndefined();
  expect(runs("suite-cells").length).toBe(1);
  expect(runs("suite-cells")[0]).toStartWith("PB_CELLS=1 bun test");
  // The cells suite is two jobs, a part of the test files each (test/test-shard.test.ts); `needs`
  // on a matrix job is success only when every part succeeded.
  expect(ci.jobs["suite-cells"].strategy.matrix.part).toEqual([1, 2]);
  expect(ci.jobs.suite.needs).toBeUndefined();
  expect(ci.jobs["suite-cells"].needs).toBeUndefined();
  const t = ci.jobs.test;
  expect(t.needs).toEqual(["suite", "suite-plain", "suite-cells"]);
  // Without always(), a failed suite leaves `test` skipped, and GitHub counts a skipped required check as passed.
  expect(t.if).toBe("always()");
  const step = t.steps[0] as { env: Record<string, string>; run: string };
  expect(step.env).toEqual({ SUITE: "${{ needs.suite.result }}", PLAIN: "${{ needs.suite-plain.result }}", CELLS: "${{ needs.suite-cells.result }}" });
  const verdict = (suite: string, plain: string, cells: string) => Bun.spawnSync(["bash", "-e", "-c", step.run], { env: { ...process.env, SUITE: suite, PLAIN: plain, CELLS: cells } }).exitCode;
  expect(verdict("success", "success", "success")).toBe(0);
  for (const bad of ["failure", "cancelled", "skipped", ""]) {
    expect(verdict(bad, "success", "success")).not.toBe(0);
    expect(verdict("success", bad, "success")).not.toBe(0);
    expect(verdict("success", "success", bad)).not.toBe(0);
  }
  // Each suite job installs what its tests need, with the lockfile frozen.
  for (const job of ["suite-plain", "suite-cells"]) {
    const all = (ci.jobs[job].steps as { run?: string }[]).map((s) => s.run ?? "").join("\n");
    expect(all).toContain("bun install --frozen-lockfile");
    expect(all).toContain("playwright install --with-deps chromium");
    expect(all).toContain("apt-get install -y openssh-client age");
  }
  // A skipped browser suite looks like a pass: the part of the plain suite that holds the UI
  // regression counts its screenshots, and the other part passes that step without counting.
  const plain = ci.jobs["suite-plain"].steps as { name?: string; run?: string; env?: Record<string, string> }[];
  expect(plain.find((s) => s.run?.startsWith("bun test"))!.env).toEqual({ PB_UI_SHOT_DIR: "ui-shots" });
  const ran = plain.find((s) => s.name === "the UI regression ran")!.run!;
  const files = testFiles(ROOT), holds = [1, 2].filter((p) => shard(files, p, 2).includes("./test/ui-regression.test.ts"));
  expect(holds.length).toBe(1);
  const count = (part: number, shots: number, standIn?: string) => {
    const dir = mkdtempSync(join(tmpdir(), "pb-ci-shots-"));
    mkdirSync(join(dir, "test", "ui"), { recursive: true }); mkdirSync(join(dir, "ui-shots")); mkdirSync(join(dir, "scripts"));
    for (let i = 0; i < 3; i++) writeFileSync(join(dir, "test", "ui", `p${i}.aria.yml`), "");
    for (let i = 0; i < shots; i++) writeFileSync(join(dir, "ui-shots", `p${i}.png`), "");
    // The step asks the shard script which files its part holds: here a stand-in that prints the real part.
    writeFileSync(join(dir, "scripts", "test-shard.ts"), standIn ?? `console.log(${JSON.stringify(shard(files, part, 2).join(" "))});`);
    return Bun.spawnSync(["bash", "-e", "-c", ran.replaceAll("${{ matrix.part }}", String(part))], { cwd: dir, env: process.env }).exitCode;
  };
  expect(count(holds[0]!, 3)).toBe(0);
  expect(count(holds[0]!, 2)).not.toBe(0);
  expect(count(holds[0]!, 0)).not.toBe(0);
  expect(count(3 - holds[0]!, 0)).toBe(0);
  // G1003: a part list that can't be read fails the step in either part, instead of both parts
  // saying the UI regression is in the other one.
  for (const part of [1, 2]) {
    expect(count(part, 3, "process.exit(1);")).not.toBe(0);
    expect(count(part, 3, "")).not.toBe(0);
  }
});
