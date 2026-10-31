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
export const FIXTURE_MAIL = [...Array.from({ length: 255 }, (_, i) => `gmail:f0000000000000${(i + 1).toString(16).padStart(2, "0")}`), "gmail:a1b2c3d4e5f60718", "gmail:1a0e88a496d9705a"];

export function makeBrain(opts: { git?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "pb-test-"));
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  // The fixture's mailbox: messages the hub has read, so citing them passes the always-on source
  // check (src/louis.ts checkedRefs, G417). Any other mail id a test cites is one the hub never read.
  mkdirSync(join(root, "log"), { recursive: true });
  writeFileSync(join(root, "log", "refs-checked.jsonl"), FIXTURE_MAIL.map((ref) => JSON.stringify({ ref, ok: true })).join("\n") + "\n");
  if (opts.git !== false) {
    const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
    run(["init", "-q", "-b", "main"]);
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "fixture"]);
  }
  process.env.PB_TODAY = "2026-10-08";
  return root;
}

// The demo brain (scripts/demo-brain.ts, outside review 2026-10-29): about 500 facts of a made-up
// life and a replayed week on top, the brain the owner's screens and the UI tests are designed
// against. The week is replayed once per test run and copied for each caller, git history and all.
// Its clock is the replay's last day: PB_TODAY is set to it, as makeBrain() does for the sample.
let demo: Promise<{ dir: string; tokens: Record<string, string>; conflicts: string[] }> | undefined;
export async function makeDemoBrain(): Promise<{ root: string; tokens: Record<string, string>; conflicts: string[] }> {
  const { copyBase, replayWeek, DEMO_DAY } = await import("../scripts/demo-brain");
  demo ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-demo-"));
    copyBase(dir);
    return { dir, ...(await replayWeek(dir)) };
  })();
  const d = await demo;
  const root = mkdtempSync(join(tmpdir(), "pb-test-"));
  Bun.spawnSync(["cp", "-a", `${d.dir}/.`, root]);
  process.env.PB_TODAY = DEMO_DAY;
  return { root, tokens: { ...d.tokens }, conflicts: [...d.conflicts] };
}
