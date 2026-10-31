// SPDX-License-Identifier: AGPL-3.0-only
// PostToolUse hook (wired in .claude/settings.json): after an edit to the access core, remind
// the session of what the laws require before merge. It never blocks; it adds context.
import { ACCESS_CORE, PROMPTS } from "../../scripts/gate";

export function reminder(file: string): string | undefined {
  if (ACCESS_CORE.test(file)) return "You edited the access core. Before merge: a failing-first test, `bun evals/run.ts --ci`, and the slice audit (skill pocketbrain-slice-audit or agent slice-auditor).";
  if (PROMPTS.test(file)) return "You edited a prompt or agent instruction. Before merge: a passing `bun evals/run.ts --llm --only agents` run recorded with `bun scripts/gate.ts record` (one session runs these; queue it in eval-queue.md).";
}

if (import.meta.main) {
  try {
    const input = JSON.parse(await Bun.stdin.text());
    const msg = reminder(String(input.tool_input?.file_path ?? ""));
    if (msg) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: msg } }));
  } catch {}
}
