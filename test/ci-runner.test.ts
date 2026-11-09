// SPDX-License-Identifier: AGPL-3.0-only
// The Mac can run the required `test` check when GitHub's own runners can't (2026-11-09: every PR
// run failed at startup with no job, PR 143 among them). ci/mac-runner-plan.md, docs/release.md
// "When GitHub's runners are down". The Mac holds the real brain, so the switch is narrow: the repo
// variable PB_RUNNER picks the runner, only in the private repo, never for a fork's PR, and the
// jobs that hold a deploy key or publish stay on GitHub's runners (G751).
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

const ROOT = join(import.meta.dir, "..");
const wf = (f: string) => YAML.parse(readFileSync(join(ROOT, ".github", "workflows", f), "utf8"));
const ci = wf("ci.yml");

test("G751: test, e2e and conformance run on the Mac only when PB_RUNNER is set, in the private repo, for a branch of its own", () => {
  for (const job of ["test", "e2e", "conformance"]) {
    const on = String(ci.jobs[job]["runs-on"]);
    expect(on).toContain("vars.PB_RUNNER");
    expect(on).toContain("fromJSON(vars.PB_RUNNER)");
    expect(on).toContain("vars.PB_RUNNER && github.event.repository.private && ");
    expect(on).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(on).toMatch(/\|\| 'ubuntu-latest' \}\}$/);
  }
});

test("G751: a fork's review, publishing and the public copy never run on the Mac", () => {
  expect(ci.jobs["outside-pr"]["runs-on"]).toBe("ubuntu-latest");
  for (const f of ["release.yml", "public-sync.yml", "docs-live.yml"]) for (const [name, j] of Object.entries(wf(f).jobs as Record<string, { "runs-on"?: string; uses?: string }>)) {
    if (j.uses) continue; // release.yml calls ci.yml, which keeps its own rule above
    expect(`${f} ${name} ${j["runs-on"]}`).toBe(`${f} ${name} ubuntu-latest`);
  }
});

test("G751: the Linux-only steps have a macOS twin, and the Mac's gitleaks is pinned by its own checksum", () => {
  const steps = ci.jobs.test.steps as { name?: string; run?: string; if?: string }[];
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
