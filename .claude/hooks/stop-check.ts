// Stop hook (wired in .claude/settings.json): before a session ends its turn, if code changed,
// the typecheck must pass. Deterministic and quick; the full gate is the merge-gate skill.
// Blocks once (exit 2 with the errors); if Claude is already continuing from this hook, it lets go.
const input = JSON.parse(await Bun.stdin.text().catch(() => "{}") || "{}");
if (input.stop_hook_active) process.exit(0);
const run = (cmd: string[]) => Bun.spawnSync(cmd, { cwd: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), stdout: "pipe", stderr: "pipe" });
const changed = run(["git", "status", "--porcelain", "--", "src", "test", "scripts", "evals"]).stdout.toString().trim();
if (!changed) process.exit(0);
const tsc = run(["bun", "run", "typecheck"]);
if (tsc.exitCode !== 0) {
  console.error("Typecheck fails on your changes; fix before finishing:\n" + (tsc.stdout.toString() + tsc.stderr.toString()).slice(-3000));
  process.exit(2);
}
