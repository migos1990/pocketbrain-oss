// SPDX-License-Identifier: AGPL-3.0-only
// One way to copy a live brain folder, .git and all, for migrate's dry run (src/format.ts) and the
// restore drill (src/backup.ts). Git keeps working while the copy runs (the owner's own commands,
// an editor's git, a background `git maintenance run --auto`), so the walk lists a folder and then
// finds an entry gone (G931, G968). A git lock file (`*.lock` under .git) only marks a git
// command that is running or died, so it is never copied. Anything else that vanishes between its
// folder's listing and its read (a loose object packed away, a ref rewritten) means the copy saw
// the brain mid-change: it is thrown away and started again, a few times, then refused with one
// sentence. A copy is never handed back with a real file quietly missing.
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface CopyBrainOptions {
  // Leave out these paths under the brain (and all below them), relative to it.
  skip?: string[];
  // Called with each path before it is read, the brain itself first on every pass. For tests.
  onEntry?: (path: string) => void;
  tries?: number;
}

export class BrainCopyError extends Error {}

const gone = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";

// True for a git lock file: never copied.
export function isGitLock(root: string, path: string): boolean {
  return path.startsWith(join(root, ".git") + sep) && path.endsWith(".lock");
}

export function copyBrain(root: string, to: string, o: CopyBrainOptions = {}): void {
  const skip = new Set((o.skip ?? []).map((p) => join(root, p)));
  const tries = o.tries ?? 3;
  let missing = "";
  for (let i = 0; i < tries; i++) {
    rmSync(to, { recursive: true, force: true });
    missing = "";
    const walk = (src: string, dst: string): void => {
      if (missing) return;
      o.onEntry?.(src);
      if (skip.has(src) || isGitLock(root, src)) return;
      try {
        const st = lstatSync(src);
        if (st.isDirectory()) {
          mkdirSync(dst, { recursive: true, mode: st.mode & 0o7777 });
          for (const name of readdirSync(src).sort()) walk(join(src, name), join(dst, name));
        } else if (st.isSymbolicLink()) symlinkSync(readlinkSync(src), dst);
        else copyFileSync(src, dst);
      } catch (e) {
        if (!gone(e)) throw e;
        if (src === root) throw new BrainCopyError(`${root} isn't there to copy`);
        missing = relative(root, src).split(sep).join("/");
      }
    };
    walk(root, to);
    if (!missing) return;
  }
  rmSync(to, { recursive: true, force: true });
  throw new BrainCopyError(`the brain kept changing while it was copied (${missing} went away mid-copy); nothing was changed, run it again`);
}
