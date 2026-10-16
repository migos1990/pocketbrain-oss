// SPDX-License-Identifier: AGPL-3.0-only
// A small fake brain with the same shape as the real one. No real data.
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

// The fictional sample brain in examples/brain is the test fixture too: one copy, no real data.
const EXAMPLE = join(import.meta.dir, "..", "examples", "brain");
function files(dir = EXAMPLE, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, files(dir, r)); else out[r] = readFileSync(join(dir, r), "utf8");
  }
  return out;
}
const FILES = files();

export function makeBrain(opts: { git?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "pb-test-"));
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  if (opts.git !== false) {
    const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
    run(["init", "-q", "-b", "main"]);
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "fixture"]);
  }
  process.env.PB_TODAY = "2026-10-08";
  return root;
}
