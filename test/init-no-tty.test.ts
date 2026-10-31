// SPDX-License-Identifier: AGPL-3.0-only
// init without a real terminal (backlog 389): piped, CI or some IDE terminals can't be asked
// questions. Plain `pocketbrain init` there says why it stopped and both ways on: the flags, or
// the same questions answered one per line on stdin with --interview.
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");
const init = (args: string[], stdin: string) => {
  const dir = mkdtempSync(join(tmpdir(), "pb-init-tty-"));
  const r = Bun.spawnSync(["bun", "src/cli.ts", "init", join(dir, "brain"), ...args], { cwd: APP, stdin: new TextEncoder().encode(stdin), env: { ...process.env, PB_CONFIG_DIR: mkdtempSync(join(tmpdir(), "pb-cfg-")) } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString(), root: join(dir, "brain") };
};

test("with no terminal and nothing given, init says there is no terminal and how to go on", () => {
  const r = init([], "");
  expect(r.code).toBe(2);
  expect(r.out).toMatch(/no terminal/i);
  expect(r.out).toContain("--name");
  expect(r.out).toContain("--interview");
  expect(existsSync(r.root)).toBe(false);
});

test("the answers piped in with --interview make the brain, one per line", () => {
  const r = init(["--interview"], "Robin\n" + "\n".repeat(14));
  expect(r.code).toBe(0);
  expect(r.out).toContain("Your brain is ready");
  expect(existsSync(join(r.root, "rules", "policy.yaml"))).toBe(true);
});
