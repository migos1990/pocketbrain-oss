// SPDX-License-Identifier: AGPL-3.0-only
// What the public copy leaves out (scripts/public-exclude.txt), for the tests that run in both repos:
// a doc may name a left-out path, or a name only a left-out file reads, and stay true in the public
// copy, where those files are gone.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const lines = readFileSync(join(import.meta.dir, "..", "scripts", "public-exclude.txt"), "utf8").split("\n").map((l) => l.trim());
export const excludedPaths = lines.filter((l) => l && !l.startsWith("#"));
export const isExcluded = (p: string) => excludedPaths.some((e) => (e.endsWith("/") ? p.startsWith(e) : p === e));
// `# names: A B` lines: secret and variable names that only a left-out file reads.
export const excludedNames = lines.filter((l) => l.startsWith("# names:")).flatMap((l) => l.slice(8).trim().split(/\s+/)).filter(Boolean);
