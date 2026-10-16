// SPDX-License-Identifier: AGPL-3.0-only
// v1 identity is the git author: every write is a commit under the writer's name.
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { hubGate } from "./hub";

// Anything that makes a commit passes the hub gate first (src/hub.ts): with rules/hub.yaml set,
// only the hub commits brain changes and a replica only its own op files.
const COMMITS = new Set(["commit", "merge", "revert", "cherry-pick", "am", "rebase"]);

// The code calls the owner "owner" ("louis" in brains started before the rename). Their commits
// carry the name from rules/policy.yaml `owner.name`, or "owner" when there is none. A brain
// whose owner is Louis keeps the author "louis", so its history reads the same before and after.
function ownerAuthor(root: string): string | undefined {
  try {
    const name = (YAML.parse(readFileSync(join(root, "rules", "policy.yaml"), "utf8")) as { owner?: { name?: unknown } })?.owner?.name;
    return typeof name === "string" && name.trim() ? name.trim() : undefined;
  } catch { return undefined; }
}

// The environment that makes `author` the author and committer of a git command.
export function authorEnv(root: string, author?: string): Record<string, string | undefined> {
  const env = { ...process.env };
  if (author) {
    const isOwner = author === "louis" || author === "owner";
    const owner = isOwner ? ownerAuthor(root) : undefined;
    const legacy = isOwner && (author === "louis" || owner?.toLowerCase() === "louis");
    const name = legacy ? "louis" : owner ?? author;
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = name;
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = `${legacy ? "louis" : author}@pocketbrain.local`;
  }
  return env;
}

// A lock left by a git command that was killed (a crash or kill -9 of the hub mid-commit) would
// stop every later commit. The hub's own git commands take seconds, so a lock older than this
// is stale and removed; a younger one may belong to a command still running and is left alone.
export const STALE_LOCK_MS = 60_000;
// A ref lock (refs/heads/<branch>.lock, HEAD.lock, packed-refs.lock) left the same way stops every
// commit with "cannot lock ref", so those are cleared by the same rule.
export function clearStaleLock(root: string): boolean {
  const g = join(root, ".git");
  const refLocks = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? refLocks(join(dir, e.name)) : e.name.endsWith(".lock") ? [join(dir, e.name)] : []);
    } catch { return []; }
  };
  let cleared = false;
  for (const f of [join(g, "index.lock"), join(g, "HEAD.lock"), join(g, "packed-refs.lock"), ...refLocks(join(g, "refs"))]) {
    try {
      if (Date.now() - statSync(f).mtimeMs <= STALE_LOCK_MS) continue;
      rmSync(f, { force: true });
      cleared = true;
    } catch { /* no such lock */ }
  }
  return cleared;
}

export function git(root: string, args: string[], author?: string): string {
  return gitRun(root, args, author).out;
}

export function gitRun(root: string, args: string[], author?: string): { ok: boolean; out: string; err: string } {
  if (!existsSync(join(root, ".git"))) return { ok: false, out: "", err: "not a git repo" };
  if (COMMITS.has(args[0])) hubGate(root, args);
  if (COMMITS.has(args[0]) || args[0] === "add") clearStaleLock(root);
  // A commit never stops for git's own gc; the night pass packs instead (src/growth.ts).
  const quiet = COMMITS.has(args[0]) ? ["-c", "gc.auto=0", "-c", "maintenance.auto=false"] : [];
  const r = Bun.spawnSync(["git", ...quiet, ...args], { cwd: root, env: authorEnv(root, author) });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

// Stage and commit `paths` as `author`. When git can't (a fresh lock held by another command,
// a full disk), the files go back to what HEAD holds, so a write that wasn't saved is reported
// as such and leaves nothing behind for a later commit to sweep up. Returns why, or undefined.
export function commitPaths(root: string, paths: string[], message: string, author?: string): string | undefined {
  if (!existsSync(join(root, ".git"))) return undefined; // a brain without git (tests, cells) saves files only
  const add = gitRun(root, ["add", "-A", "--", ...paths]);
  // Only this write's own paths go in the commit, never whatever else was staged; a path with
  // no change (an empty disputes/) is left out so the pathspec can't fail on it.
  const staged = add.ok ? Bun.spawnSync(["git", "diff", "--cached", "--name-only", "--no-renames", "--", ...paths], { cwd: root }).stdout.toString().split("\n").filter(Boolean) : [];
  if (add.ok && !staged.length) return undefined;
  let commit: ReturnType<typeof gitRun>;
  // A replica's hub gate throws before the commit: the files still go back before it propagates.
  try { commit = add.ok ? gitRun(root, ["commit", "-q", "-m", message, "--", ...staged], author) : add; }
  catch (e) { putBack(root, paths); throw e; }
  if (commit.ok || /nothing (added )?to commit/.test(commit.out + commit.err)) return undefined;
  putBack(root, paths);
  return (commit.err || commit.out || "git commit failed").split("\n")[0].slice(0, 200);
}

function putBack(root: string, paths: string[]) {
  gitRun(root, ["reset", "-q", "--", ...paths]);
  const status = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=all", "--", ...paths], { cwd: root }).stdout.toString();
  const changed = status.split("\n").filter(Boolean).map((l) => l.slice(3));
  for (const p of changed) {
    const head = Bun.spawnSync(["git", "show", `HEAD:${p}`], { cwd: root });
    if (head.exitCode === 0) writeFileSync(join(root, p), head.stdout); else rmSync(join(root, p), { force: true });
  }
}

// The last commit, or the last that touched `path`. Finding the latter walks history, which a
// year of commits made slow on every cell build, so it is remembered while the path's tree is
// the same: a path changed and changed back keeps naming the older commit, with the same content.
const pathCommits = new Map<string, { tree: string; commit: string }>();
export function headCommit(root: string, path?: string): string {
  if (!path) return git(root, ["log", "-1", "--format=%h"]) || "uncommitted";
  const tree = gitRun(root, ["rev-parse", `HEAD:${path}`]);
  const hit = pathCommits.get(`${root}\0${path}`);
  if (tree.ok && hit && hit.tree === tree.out) return hit.commit;
  const commit = git(root, ["log", "-1", "--format=%h", "--", path]) || "uncommitted";
  if (tree.ok) pathCommits.set(`${root}\0${path}`, { tree: tree.out, commit });
  return commit;
}
