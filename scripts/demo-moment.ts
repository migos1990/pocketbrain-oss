#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// The demo moment, timed (docs/demo-moment.md): an assistant asks about someone over MCP, the owner
// tells the home box one thing about them, and the same question is asked again until the answer
// has it. Runs on a throwaway copy, never on the brain itself:
//   bun scripts/demo-moment.ts                                       the synthetic eval brain
//   bun scripts/demo-moment.ts --brain <brain repo> --ask "what's next with <name>" \
//       --tell "<Full Name>'s next step is <something new>" [--agent claude] [--absent <name>]
// --brain is git-cloned into a temp folder. Prints only counts, yes/no and milliseconds, never a
// value (add --show to print the Cite lines the answer carried). The same run as an eval case:
// PB_BRAIN=<brain> EVAL_DEMO_ASK=… EVAL_DEMO_TELL=… bun evals/run.ts --only demo-moment-real
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandbox } from "../evals/lib/sandbox";
import { measure, TOLD } from "../evals/cases/demo";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const src = arg("--brain");
let root: string, tmp: string | undefined;
if (src) {
  tmp = mkdtempSync(join(tmpdir(), "pb-demo-moment-"));
  root = join(tmp, "brain");
  const c = Bun.spawnSync(["git", "clone", "-q", src, root]);
  if (c.exitCode) { console.error(`git clone failed: ${c.stderr.toString().trim()}`); process.exit(2); }
} else root = sandbox("synthetic");

try {
  const r = await measure(root, { ask: arg("--ask") ?? "what's next with Jane", tell: arg("--tell") ? { q: arg("--tell")! } : TOLD, absent: arg("--absent") ?? "Zoe", agent: arg("--agent") });
  console.log(JSON.stringify(r.out));
  if (process.argv.includes("--show")) console.log(r.cites.join("\n"));
  process.exitCode = r.pass ? 0 : 1;
} finally {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}
