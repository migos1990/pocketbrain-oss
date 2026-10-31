// SPDX-License-Identifier: AGPL-3.0-only
// Invariant 6 rewritten (owner, typed yes 2026-10-25, after the outside review): facts with a source
// file themselves and the owner is asked only about conflicts. The words agents read must say the
// same: the Gardener no longer told "you never change anything", the capture tool no longer
// promising "proposals, never writes".
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gardenerSteps } from "../src/tend";

const src = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");

test("the Gardener's nightly prompt says facts file themselves and it weighs conflicts", () => {
  const p = gardenerSteps.nightly("Robin");
  expect(p).not.toContain("You never change anything yourself");
  expect(p).toContain("Facts with a source file themselves");
  expect(p).toContain("you suggest the side the evidence supports");
});

test("the capture tool and orientation no longer promise proposals only", () => {
  for (const f of ["src/server.ts", "src/orientation.ts"]) {
    expect(src(f)).not.toContain("never as writes");
    expect(src(f)).toContain("only");
  }
  expect(src("src/orientation.ts")).toContain("file themselves on their page with Undo");
});

test("CLAUDE.md invariant 6 is the conflict-only rule", () => {
  const c = src("CLAUDE.md");
  expect(c).not.toContain("**Models never decide.**");
  expect(c).toContain("**Facts file themselves; the owner is asked only about conflicts");
});
