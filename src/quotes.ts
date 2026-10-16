// SPDX-License-Identifier: AGPL-3.0-only
// Words quoted from a source, kept only while the owner decides (docs/sources-pull.md, "Facts, not
// copies"). A pulled item's text never goes in the brain; the few words a proposal was drawn from
// help the owner keep or drop it, so they wait beside the open proposal, outside git (in the
// repo's .git folder, which nothing commits), and are deleted when the proposal is decided. The
// proposal file, its decided copy, commits and logs never hold them.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { git } from "./git";

export const QUOTE_MAX = 200;

// Inside the git folder, which nothing commits: .git itself, or the folder a worktree's .git file
// points to. A brain that isn't a git repo commits nothing, so a plain folder will do.
function dir(root: string): string {
  const g = join(root, ".git");
  if (!existsSync(g)) return join(root, ".pb-quotes");
  if (statSync(g).isDirectory()) return join(g, "pb-quotes");
  const to = readFileSync(g, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
  return to ? join(resolve(root, to), "pb-quotes") : join(root, ".pb-quotes");
}
// One file per proposal. (Branches before G98 also wrote `.check` files; the sweep removes them.)
const file = (root: string, proposal: string) => join(dir(root), `${proposal.split("/").pop()}.quote`);

export function putQuote(root: string, proposal: string, text: string) {
  const d = dir(root);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  // A brain that isn't a git repo keeps them in its tree: nothing may stage them (G94).
  if (d === join(root, ".pb-quotes") && !existsSync(join(d, ".gitignore"))) writeFileSync(join(d, ".gitignore"), "*\n");
  writeFileSync(file(root, proposal), text.slice(0, QUOTE_MAX), { mode: 0o600 });
}

export function getQuote(root: string, proposal: string): string | undefined {
  const f = file(root, proposal);
  return existsSync(f) ? readFileSync(f, "utf8") : undefined;
}

// Deletes the quotes of every proposal no longer waiting in inbox/ (decided, forgotten, moved).
export function sweepQuotes(root: string): number {
  const d = dir(root);
  if (!existsSync(d)) return 0;
  const open = new Set(existsSync(join(root, "inbox")) ? readdirSync(join(root, "inbox")) : []);
  let n = 0;
  for (const f of readdirSync(d)) if (!f.startsWith(".") && !open.has(f.replace(/\.(quote|check)$/, ""))) { rmSync(join(d, f), { force: true }); n++; }
  return n;
}

// Proposals made before quotes moved out of git kept them at the end of the committed reason. Moves
// an open one's quote beside it and strips it from the open and decided files, in one commit. Git
// history still holds the old lines; only a history scrub removes them (docs/sources-pull.md).
const LEGACY = /;?\s*quote: "(.*)"$/;
export function migrateLegacyQuotes(root: string): number {
  const changed: string[] = [];
  for (const sub of ["inbox", join("inbox", "decided")]) {
    const d = join(root, sub);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith(".yaml"))) {
      const path = join(d, f);
      const text = readFileSync(path, "utf8");
      if (!text.includes("quote: ")) continue;
      let p: { capture?: string; reason?: string };
      try { p = YAML.parse(text) ?? {}; } catch { continue; }
      const m = p.capture && typeof p.reason === "string" ? p.reason.match(LEGACY) : null;
      if (!m) continue;
      if (sub === "inbox" && !getQuote(root, f)) putQuote(root, f, m[1].replace(/\\"/g, '"'));
      writeFileSync(path, YAML.stringify({ ...p, reason: p.reason!.replace(LEGACY, "") }, { lineWidth: 0 }));
      changed.push(join(sub, f));
    }
  }
  if (changed.length) {
    git(root, ["add", "--", ...changed]);
    git(root, ["commit", "-q", "-m", `quotes: moved ${changed.length} source quote(s) out of proposal files (facts, not copies)\n\nAgent: hub\nKind: upkeep`], "hub");
  }
  return changed.length;
}
