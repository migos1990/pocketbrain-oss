// SPDX-License-Identifier: AGPL-3.0-only
// Which lane a change is in, from the files it touches, so build threads can specialize and a
// reviewer knows what to look at: ui (dashboard, browser door, their snapshots), backend (the rest
// of src/ and its tests), evals, harness (CI, hooks, scripts), docs. Conservative: a file no rule
// knows is "other", never quietly backend.
//   bun scripts/lane.ts [base]     the lanes of HEAD's changes since base (default main)
import { relative } from "node:path";

export type Lane = "ui" | "backend" | "evals" | "harness" | "docs" | "other";

const RULES: [Lane, RegExp][] = [
  ["ui", /^src\/dashboard\/|^src\/browser\.ts$|^test\/(ui\/|ui-regression|dashboard|browser)/],
  ["backend", /^src\/|^test\/|^package\.json$|^bun\.lock$|^tsconfig\.json$|^knip\.json$|^examples\/(brain|seed)\//],
  ["evals", /^evals\//],
  ["harness", /^\.github\/|^\.githooks\/|^\.claude\/|^scripts\/|^install\.sh$/],
  ["docs", /^docs\/|^[A-Z][A-Z_-]*\.md$/],
];

export function laneOf(path: string): Lane {
  return RULES.find(([, re]) => re.test(path))?.[0] ?? "other";
}

export function lanes(paths: string[]): Lane[] {
  const order: Lane[] = ["ui", "backend", "evals", "harness", "docs", "other"];
  const got = new Set(paths.map(laneOf));
  return order.filter((l) => got.has(l));
}

if (import.meta.main) {
  const base = Bun.argv[2] ?? "main";
  const sh = (a: string[]) => Bun.spawnSync(["git", ...a], { stdout: "pipe" }).stdout.toString().trim();
  const mb = sh(["merge-base", base, "HEAD"]);
  const paths = sh(["diff", "--name-only", "--no-renames", mb, "HEAD"]).split("\n").filter(Boolean).map((p) => relative(".", p));
  const got = lanes(paths);
  console.log(`Lane: ${got.join(", ") || "none"}`);
  for (const l of got) console.log(`  ${l}: ${paths.filter((p) => laneOf(p) === l).slice(0, 5).join(", ")}${paths.filter((p) => laneOf(p) === l).length > 5 ? ", …" : ""}`);
}
