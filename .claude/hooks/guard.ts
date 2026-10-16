// PreToolUse guard for Claude Code sessions working in this repo (wired in .claude/settings.json).
// Prose rules in CLAUDE.md guide; this file enforces the few that must never slip:
//   1. no `git commit` or blanket `git add` on main (branch first, merge after review);
//   2. agents never edit the harness config (.claude/settings*.json) or this guard;
//   3. the real brain is never written to directly: no Edit/Write inside it, and no
//      destructive shell command (rm, git reset --hard, git clean, git push, sed -i, mv) naming it.
//      The brain changes only through the hub's write path, or by Louis's hand.
//   4. nothing under an off-limits folder is edited or destroyed (other products on the same machine).
//      The list lives outside the repo: $PB_GUARD_PATHS (colon-separated) or
//      ~/.config/pocketbrain/guard-paths (one path per line, ~ allowed);
//   5. no edit writes a secret-shaped string (API keys, tokens, private keys) into a file;
//   6. anything that touches the live hub (unloading its launchd jobs, the tunnel or its config,
//      killing the hub, its plists) asks the person first instead of running: a slip there takes
//      every agent offline. A plain restart (`launchctl kickstart -k` of com.pocketbrain.start or
//      .tunnel) and read-only `launchctl list|print` run without asking (Louis, 2026-10-15).
// Exit 2 blocks the call and shows stderr to the agent. A payload it cannot parse is blocked
// too (fail closed). The brain path comes from $PB_BRAIN or ~/.config/pocketbrain/brain.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Verdict = { block: false; ask?: true; reason?: string } | { block: true; reason: string };
type Input = { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string };

const ALLOW: Verdict = { block: false };
const deny = (reason: string): Verdict => ({ block: true, reason });
const ask = (reason: string): Verdict => ({ block: false, ask: true, reason });
// Run as a command (start of line, after ; && || | ( or $( and an optional sudo/env), not named
// in a grep or a path.
const AT = String.raw`(^|[;&|(]\s*|\$\(\s*)(sudo\s+|env\s+\S+=\S*\s+)*`;
const HUB_FREE = new RegExp(`${AT}launchctl\\s+(kickstart\\s+(-k\\s+)?[^;&|]*\\bcom\\.pocketbrain\\.(start|tunnel)|list|print)\\b[^;&|]*$`);
const LIVE_HUB: [RegExp, string][] = [
  [new RegExp(`${AT}launchctl\\b`), "launchctl manages the live hub and tunnel jobs"],
  [new RegExp(`${AT}cloudflared\\b`), "cloudflared is the live tunnel"],
  [new RegExp(`${AT}brew\\s+services\\s+\\S+\\s+cloudflared\\b`), "cloudflared is the live tunnel"],
  [new RegExp(`${AT}(pkill|killall|kill)\\b[^;&|]*(pocketbrain|cli\\.ts|cloudflared)`), "this stops the live hub or tunnel"],
];

export function brainPaths(env = process.env, home = homedir()): string[] {
  const out = new Set<string>();
  if (env.PB_BRAIN) out.add(resolve(env.PB_BRAIN));
  const conf = join(env.PB_CONFIG_DIR ?? join(home, ".config", "pocketbrain"), "brain");
  if (existsSync(conf)) {
    const p = readFileSync(conf, "utf8").trim();
    if (p) out.add(resolve(p));
  }
  out.add(join(home, "pocketbrain-brain"));
  out.add("/mnt/project-files/pocketbrain-brain");
  return [...out];
}

const inside = (file: string, dir: string) => file === dir || file.startsWith(dir + "/");
const tilde = (p: string, home: string) => (p.startsWith("~/") ? join(home, p.slice(2)) : p);

export function offLimitPaths(env = process.env, home = homedir()): string[] {
  const out = (env.PB_GUARD_PATHS ?? "").split(":").filter(Boolean);
  const f = join(env.PB_CONFIG_DIR ?? join(home, ".config", "pocketbrain"), "guard-paths");
  if (existsSync(f)) out.push(...readFileSync(f, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
  return out.map((p) => resolve(tilde(p, home)));
}
const names = (cmd: string, dir: string, home = homedir()) => cmd.includes(dir) || (dir.startsWith(home + "/") && cmd.includes("~" + dir.slice(home.length)));
// Shapes only, never values. Tests build matching strings at run time.
const SECRET = [
  /sk-ant-[A-Za-z0-9_-]{20,}/, /sk-[A-Za-z0-9]{32,}/, /gh[pousr]_[A-Za-z0-9]{30,}/, /github_pat_[A-Za-z0-9_]{30,}/,
  /AKIA[0-9A-Z]{16}/, /xox[abprs]-[A-Za-z0-9-]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bpb_[A-Za-z0-9]{32,}\b/,
];

export function check(input: Input, opts: { branch?: string; brains: string[]; offLimits?: string[] }): Verdict {
  const tool = input.tool_name;
  if (!tool) return deny("guard could not read the tool call; failing closed.");
  const ti = input.tool_input ?? {};

  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit") {
    const raw = String(ti.file_path ?? ti.notebook_path ?? "");
    if (!raw) return deny("guard could not find the file path; failing closed.");
    const file = resolve(input.cwd ?? process.cwd(), raw);
    if (/\/\.claude\/(settings(\.local)?\.json|hooks\/guard\.ts)$/.test(file))
      return deny(`${raw} is the harness config; only Louis changes it.`);
    const brain = opts.brains.find((b) => inside(file, b));
    if (brain) return deny(`${raw} is inside the real brain (${brain}). Write through the hub (remember/capture), or test on a git clone in a temp dir.`);
    const off = (opts.offLimits ?? []).find((d) => inside(file, d));
    if (off) return deny(`${raw} is in an off-limits folder (${off}); pocketBrain sessions never change it.`);
    if (/\/Library\/LaunchAgents\/com\.pocketbrain\.[^/]*$/.test(file)) return ask(`${raw} is a live hub launchd job; the person approves this edit.`);
    if (/\/\.cloudflared\//.test(file)) return ask(`${raw} is the live tunnel's config; the person approves this edit.`);
    const text = [ti.content, ti.new_string, ...(Array.isArray(ti.edits) ? ti.edits.map((e: any) => e?.new_string) : [])].filter(Boolean).join("\n");
    if (SECRET.some((re) => re.test(text))) return deny(`the text written to ${raw} looks like a secret (key or token). Secrets live in ~/.config/pocketbrain/keys or 1Password, never in files.`);
    return ALLOW;
  }

  if (tool === "Bash") {
    const cmd = String(ti.command ?? "");
    const commitOrBlanketAdd =
      /(^|[;&|(]|\s)git\s+([^;&|]*\s)?(commit|add\s+(-A|--all|\.))(\s|[;&|)]|$)/;
    if (commitOrBlanketAdd.test(cmd) && (opts.branch === "main" || opts.branch === "master"))
      return deny(`this commits on ${opts.branch}. Switch to a branch first (git switch -c claude/<name>); a narrow \`git add <path>\` is fine.`);
    const destructive = /(^|[;&|(]|\s)(rm|mv|sed\s+-i|git\s+(-C\s+\S+\s+)?(reset\s+--hard|clean|push|checkout\s+--|restore))\b/;
    if (destructive.test(cmd)) {
      const brain = opts.brains.find((b) => cmd.includes(b) || cmd.includes(b.replace(homedir(), "~")));
      if (brain) return deny(`destructive command on the real brain (${brain}). Use a clone, or ask Louis.`);
      const off = (opts.offLimits ?? []).find((d) => names(cmd, d));
      if (off) return deny(`destructive command naming an off-limits folder (${off}).`);
    }
    // Each command in a chain on its own, so a free restart can't carry an unload along.
    const hub = cmd.split(/;|&&|\|\||\|/).map((p) => p.trim()).filter((p) => !HUB_FREE.test(p))
      .flatMap((p) => LIVE_HUB.filter(([re]) => re.test(p)))[0];
    if (hub) return ask(`${hub[1]}; the person approves this before it runs.`);
    return ALLOW;
  }
  return ALLOW;
}

function currentBranch(cwd?: string): string | undefined {
  const r = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: cwd ?? process.cwd(), stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : undefined;
}

if (import.meta.main) {
  let input: Input;
  try {
    input = JSON.parse(await Bun.stdin.text());
  } catch {
    console.error("BLOCKED: guard could not parse the tool call; failing closed.");
    process.exit(2);
  }
  const v = check(input, { branch: process.env.GUARD_TEST_BRANCH ?? currentBranch(input.cwd), brains: brainPaths(), offLimits: offLimitPaths() });
  if (v.block) {
    console.error(`BLOCKED: ${v.reason} (.claude/hooks/guard.ts)`);
    process.exit(2);
  }
  if (v.ask) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: `${v.reason} (.claude/hooks/guard.ts)` } }));
}
