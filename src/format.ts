// SPDX-License-Identifier: AGPL-3.0-only
// The brain's format number (backlog 227). A release that changes how the brain is laid out
// raises FORMAT and adds a migration; the brain carries its number in the FORMAT file at its
// root ("pocketbrain-brain/<n>"). A brain with no FORMAT file is format 1, what every brain
// before this file was.
//   - A brain newer than this code knows (a release went back after a newer one migrated it) is
//     refused by every command with one line saying what to run. Nothing is read or written, so
//     an old hub stops cleanly instead of half-understanding a layout it predates.
//   - An older brain is migrated: first on a copy (the dry run), and only when every step worked
//     there and the copy still loads, in place, as one owner commit (Kind: migrate) that git can
//     revert. `pocketbrain migrate` shows the dry run; `--apply` runs it; `start` and `serve`
//     apply it by themselves, so an update that needs one doesn't wait for the owner's hands.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitRun } from "./git";
import { loadRules } from "./rules";
import { loadBrain } from "./brain";
import { OWNER } from "./owner";

export const FORMAT = 1;
export const FORMAT_FILE = "FORMAT";
const PREFIX = "pocketbrain-brain/";

// One step from format to-1 to `to`. `run` changes files under the brain it is given and
// returns what it did, one line per change; it never commits (migrate does, once).
export interface Migration { to: number; what: string; run(root: string): string[] }
export const MIGRATIONS: Migration[] = [];

export class FormatError extends Error {}

export function brainFormat(root: string): number {
  const f = join(root, FORMAT_FILE);
  if (!existsSync(f)) return 1;
  const t = readFileSync(f, "utf8").trim();
  const n = t.startsWith(PREFIX) ? Number(t.slice(PREFIX.length)) : NaN;
  if (!Number.isInteger(n) || n < 1) throw new FormatError(`${f} reads "${t.slice(0, 40)}", not ${PREFIX}<number>; pocketBrain won't guess the brain's format`);
  return n;
}

export const formatLine = (n: number) => `${PREFIX}${n}\n`;

const version = () => { try { return `v${JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version}`; } catch { return "this version"; } };

// What stands between this code and the brain: undefined when they match.
export function formatProblem(root: string, code = FORMAT): { kind: "newer" | "older"; brain: number; text: string } | undefined {
  const n = brainFormat(root);
  if (n > code) return { kind: "newer", brain: n, text: `this brain is format ${n}; pocketBrain ${version()} reads formats up to ${code}. Nothing was read or changed. Run a release that knows format ${n} (on the Mac: bun scripts/deploy.ts unhold, then bun scripts/deploy.ts run); see docs/release.md, "Brain format"` };
  if (n < code) return { kind: "older", brain: n, text: `this brain is format ${n}; pocketBrain ${version()} needs format ${code}. See what changes: pocketbrain migrate; then: pocketbrain migrate --apply (start does this by itself)` };
  return undefined;
}

export interface MigrateResult { from: number; to: number; steps: { to: number; what: string; did: string[] }[]; applied: boolean; commit?: string }

function runSteps(root: string, steps: Migration[]): MigrateResult["steps"] {
  const out: MigrateResult["steps"] = [];
  for (const m of steps) {
    const did = m.run(root);
    writeFileSync(join(root, FORMAT_FILE), formatLine(m.to));
    out.push({ to: m.to, what: m.what, did });
  }
  // The migrated brain must still load; a step that broke it fails here, on the copy.
  loadRules(root);
  loadBrain(root);
  return out;
}

// The dry run always comes first: every step on a copy of the brain. Only when it succeeded are
// the steps run on the brain itself (with apply), and committed as one owner commit.
export function migrate(root: string, o: { apply?: boolean; migrations?: Migration[]; code?: number } = {}): MigrateResult {
  const code = o.code ?? FORMAT, all = o.migrations ?? MIGRATIONS;
  const from = brainFormat(root);
  if (from > code) throw new FormatError(formatProblem(root, code)!.text);
  const steps = all.filter((m) => m.to > from && m.to <= code).sort((a, b) => a.to - b.to);
  for (let n = from + 1; n <= code; n++) if (!steps.some((m) => m.to === n)) throw new FormatError(`no migration to format ${n} in this pocketBrain; the brain stays at format ${from}`);
  if (!steps.length) return { from, to: from, steps: [], applied: false };
  const copy = mkdtempSync(join(tmpdir(), "pb-migrate-"));
  let dry: MigrateResult["steps"];
  try {
    cpSync(root, copy, { recursive: true });
    try { dry = runSteps(copy, steps); } catch (e) { throw new FormatError(`dry run failed, the brain is unchanged at format ${from}: ${(e as Error).message}`); }
  } finally { rmSync(copy, { recursive: true, force: true }); }
  if (!o.apply) return { from, to: code, steps: dry, applied: false };
  const done = runSteps(root, steps);
  git(root, ["add", "-A", "--", ".", ":!log", ":!digest"]);
  const c = gitRun(root, ["commit", "-q", "-m", `owner: migrate brain format ${from} to ${code}\n\n${done.map((s) => `${s.to}: ${s.what}`).join("\n")}\n\nKind: migrate`], OWNER);
  if (!c.ok && !/nothing (added )?to commit/.test(c.out + c.err)) throw new FormatError(`migrated in place but couldn't commit: ${(c.err || c.out).split("\n")[0]}`);
  return { from, to: code, steps: done, applied: true, commit: git(root, ["log", "-1", "--format=%h"]) };
}

export function renderMigrate(r: MigrateResult): string {
  if (!r.steps.length) return `brain format ${r.from}: nothing to migrate`;
  return [`${r.applied ? "migrated" : "dry run (nothing changed)"}: brain format ${r.from} to ${r.to}${r.commit ? ` in ${r.commit}` : ""}`,
    ...r.steps.flatMap((s) => [`  ${s.to}: ${s.what}`, ...s.did.map((d) => `     ${d}`)]),
    ...(r.applied ? [] : ["apply: pocketbrain migrate --apply"])].join("\n");
}
