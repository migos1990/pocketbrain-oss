// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from "bun:test";
import { check, offLimitPaths } from "../.claude/hooks/guard";

const brains = ["/Users/x/pocketbrain-brain"];
const bash = (command: string, branch = "claude/x") => check({ tool_name: "Bash", tool_input: { command } }, { branch, brains });
const write = (file_path: string) => check({ tool_name: "Write", tool_input: { file_path }, cwd: "/Users/x/pocketbrain" }, { brains });

describe("guard: commits on main", () => {
  test("commit and blanket add on main are blocked", () => {
    expect(bash("git commit -m x", "main").block).toBe(true);
    expect(bash("git add -A && git commit -m x", "main").block).toBe(true);
    expect(bash("git add .; echo hi", "main").block).toBe(true);
  });
  test("narrow add on main, and commits on a branch, pass", () => {
    expect(bash("git add src/x.ts", "main").block).toBe(false);
    expect(bash("git commit -m x").block).toBe(false);
    expect(bash("git merge --no-ff claude/x", "main").block).toBe(false);
  });
});

describe("guard: harness config", () => {
  test("settings and the guard itself cannot be edited", () => {
    expect(write(".claude/settings.json").block).toBe(true);
    expect(write("/Users/x/pocketbrain/.claude/settings.local.json").block).toBe(true);
    expect(write(".claude/hooks/guard.ts").block).toBe(true);
    expect(write("src/server.ts").block).toBe(false);
  });
});

describe("guard: the real brain", () => {
  test("no direct edits inside the brain", () => {
    expect(write("/Users/x/pocketbrain-brain/notes/a.md").block).toBe(true);
    expect(write("../pocketbrain-brain/rules/policy.yaml").block).toBe(true);
    expect(write("/Users/x/pocketbrain-brain-copy/a.md").block).toBe(false);
  });
  test("destructive shell commands naming the brain are blocked, reads pass", () => {
    expect(bash("rm -rf /Users/x/pocketbrain-brain/log").block).toBe(true);
    expect(bash("git -C /Users/x/pocketbrain-brain reset --hard HEAD~1").block).toBe(true);
    expect(bash("cd /Users/x/pocketbrain-brain && git push origin main").block).toBe(true);
    expect(bash("git clone /Users/x/pocketbrain-brain /tmp/b && ls /tmp/b").block).toBe(false);
    expect(bash("rm -rf /tmp/b").block).toBe(false);
  });
});

test("guard fails closed on a payload without a tool name", () => {
  expect(check({}, { brains }).block).toBe(true);
});

import { reminder } from "../.claude/hooks/after-edit";
test("after-edit reminds on the access core and prompts only", () => {
  expect(reminder("/r/src/carve.ts")).toMatch(/slice audit/);
  expect(reminder("/r/src/orientation.ts")).toMatch(/--only agents/);
  expect(reminder("/r/src/digest.ts")).toBeUndefined();
});

describe("guard: off-limits folders and secrets", () => {
  const off = (c: Parameters<typeof check>[0]) => check(c, { branch: "claude/x", brains, offLimits: ["/Users/x/other-product"] });
  test("off-limits folders can't be edited or destroyed, reads pass", () => {
    expect(off({ tool_name: "Write", tool_input: { file_path: "/Users/x/other-product/.claude/settings.json" } }).block).toBe(true);
    expect(off({ tool_name: "Bash", tool_input: { command: "rm -rf /Users/x/other-product/node_modules" } }).block).toBe(true);
    expect(off({ tool_name: "Bash", tool_input: { command: "cat /Users/x/other-product/CLAUDE.md" } }).block).toBe(false);
  });
  test("the off-limits list is read from outside the repo", () => {
    expect(offLimitPaths({ PB_GUARD_PATHS: "/a:~/b", PB_CONFIG_DIR: "/nonexistent" }, "/Users/x")).toEqual(["/a", "/Users/x/b"]);
  });
  test("secret-shaped text is never written to a file", () => {
    const key = "sk-" + "ant-" + "a".repeat(40);
    const edit = (new_string: string) => check({ tool_name: "Edit", tool_input: { file_path: "src/x.ts", new_string } }, { brains });
    expect(edit(`const k = "${key}";`).block).toBe(true);
    expect(check({ tool_name: "Write", tool_input: { file_path: "a.md", content: "-----BEGIN OPENSSH " + "PRIVATE KEY-----" } }, { brains }).block).toBe(true);
    expect(edit("const k = process.env.ANTHROPIC_API_KEY;").block).toBe(false);
  });
});

describe("guard: the live hub asks first", () => {
  const verdict = (command: string) => bash(command);
  test("launchd, the tunnel and killing the hub ask the person before running", () => {
    for (const c of ["launchctl bootout gui/501 ~/Library/LaunchAgents/com.pocketbrain.tunnel.plist", "launchctl unload ~/Library/LaunchAgents/com.pocketbrain.start.plist", "launchctl kickstart -k gui/501/com.other.thing", "cloudflared tunnel run pocketbrain", "pkill -f 'cli.ts start'", "brew services restart cloudflared", "launchctl kickstart -k gui/501/com.pocketbrain.start && launchctl bootout gui/501/com.pocketbrain.tunnel"])
      expect(verdict(c)).toMatchObject({ block: false, ask: true });
    for (const file_path of ["/Users/x/Library/LaunchAgents/com.pocketbrain.start.plist", "/Users/x/.cloudflared/config.yml"])
      expect(check({ tool_name: "Write", tool_input: { file_path } }, { brains })).toMatchObject({ block: false, ask: true });
  });
  test("a plain restart of the hub or tunnel runs without asking (owner's choice)", () => {
    for (const c of ["launchctl kickstart -k gui/$(id -u)/com.pocketbrain.start", "launchctl kickstart -k gui/501/com.pocketbrain.tunnel", "sudo launchctl list | grep pocketbrain", "launchctl print gui/501/com.pocketbrain.start", "launchctl kickstart -k gui/501/com.pocketbrain.start && sleep 2 && curl -s http://127.0.0.1:8787/health"])
      expect(verdict(c)).toEqual({ block: false });
  });
  test("reading hub logs, health checks and tests don't ask", () => {
    for (const c of ["tail -n 50 ~/Library/Logs/pocketbrain.log", "curl -s http://127.0.0.1:8787/health", "bun test test/start.test.ts", "grep launchctl src/start.ts"])
      expect(verdict(c)).toEqual({ block: false });
  });
});
