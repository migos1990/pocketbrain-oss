// SPDX-License-Identifier: AGPL-3.0-only
// Every case runs on a throwaway copy of a brain: the synthetic fixture (committed, no real
// data) or a copy of Robin's real brain ($PB_BRAIN). Nothing ever touches the real brain.
import { cpSync, mkdtempSync, existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateGit } from "./gitenv";

export const SYNTHETIC = join(import.meta.dir, "..", "fixtures", "synthetic");
export const TODAY = process.env.PB_TODAY ?? "2026-10-08";
process.env.PB_TODAY = TODAY;

export type BrainSource = "synthetic" | "real";

export function realBrainPath(): string | undefined {
  const p = process.env.PB_BRAIN;
  return p && existsSync(join(p, "rules")) ? p : undefined;
}

const made: string[] = [];
// Every temp folder a case makes (sandboxes, hub keys, replica clones) goes under one folder for
// the run, removed on exit with the rest unless EVAL_KEEP is set: runs used to leave them behind.
if (!process.env.PB_EVAL_RUN_DIR) {
  process.env.PB_EVAL_RUN_DIR = process.env.TMPDIR = mkdtempSync(join(tmpdir(), "pb-eval-run-"));
  made.push(process.env.PB_EVAL_RUN_DIR);
}
isolateGit(process.env.PB_EVAL_RUN_DIR!);
process.on("exit", () => { if (!process.env.EVAL_KEEP) for (const d of made) try { rmSync(d, { recursive: true, force: true }); } catch {} });

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "louis@pocketbrain.local", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "louis@pocketbrain.local" };
export function sh(cwd: string, args: string[]): string {
  return Bun.spawnSync(args, { cwd, env: gitEnv }).stdout.toString().trim();
}

export function sandbox(source: BrainSource = "synthetic", patch?: (root: string) => void): string {
  const from = source === "real" ? realBrainPath() : SYNTHETIC;
  if (!from) throw new Error("real brain not available (set PB_BRAIN)");
  const root = mkdtempSync(join(tmpdir(), `pb-eval-${source}-`));
  made.push(root);
  cpSync(from, root, { recursive: true, filter: (s) => !s.includes("/.git/") && !s.endsWith("/.git") && !s.includes("/views/") });
  if (patch) patch(root);
  sh(root, ["git", "init", "-q", "-b", "main"]);
  sh(root, ["git", "add", "-A"]);
  sh(root, ["git", "commit", "-q", "-m", "eval sandbox"]);
  return root;
}

// Small helpers for patching a sandbox before its first commit.
export function appendBody(root: string, id: string, text: string) {
  const f = join(root, id + ".md");
  writeFileSync(f, readFileSync(f, "utf8").replace(/\n*$/, "\n") + text + "\n");
}
export function writeNote(root: string, id: string, text: string) {
  const f = join(root, id + ".md");
  Bun.spawnSync(["mkdir", "-p", join(f, "..")]);
  writeFileSync(f, text);
}

export function commitCount(root: string): number {
  return Number(sh(root, ["git", "rev-list", "--count", "HEAD"]) || 0);
}
