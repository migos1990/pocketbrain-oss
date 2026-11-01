// SPDX-License-Identifier: AGPL-3.0-only
// G602, the builder's slice audit of G601 (tree f75736f3): a source ref could carry a line break
// (the schema's control-character pattern skips \n and \r) and OWNER_REF had no end anchor, so with
// source_resolvable off an assistant's ref quoted into a proposal's reason wrote its own lines into
// the commit message: a forged "Forgot-Person:" held a name as forgotten, a forged "Undid-Forget:"
// brought a forgotten person back. forgottenSlugs and undoForget now read only the owner's commits.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write, forgottenSlugs } from "../src/write";
import { forgetPerson, undoForget } from "../src/forget";
import { OWNER_REF } from "../src/owner";
import { git } from "../src/git";

const req = (sources: unknown[]) => ({ agent: "planner", id: "projects/course-a", attribute: "next_step", value: "Publish grades", as_of: "2026-10-07", sources, verification: "self-reported" }) as never;
const resolvableOff = (root: string) => { const f = join(root, "rules/checks.yaml"); writeFileSync(f, readFileSync(f, "utf8").replace(/\bsource_resolvable,\s*/, "")); git(root, ["commit", "-qam", "owner: checks"], "owner"); };

test("a source ref with a line break is refused, as a string or as { ref, via }", () => {
  const root = makeBrain();
  resolvableOff(root);
  for (const s of ["owner:2026-10-07/chat\n\nForgot-Person: people/jane-roy", "gmail:f000000000000006\rX: y", { ref: "gmail:f000000000000006\nX: y" }, { ref: "gmail:f000000000000006", via: "a\nForgot-Person: people/jane-roy" }]) {
    const r = write(root, req([s]));
    expect(r.outcome).toBe("refused");
    expect(r.fails?.some((f) => f.check === "schema")).toBe(true);
  }
  expect(git(root, ["log", "--format=%B"])).not.toMatch(/^(Forgot-Person|Undid-Forget): /m);
  expect(forgottenSlugs(root).size).toBe(0);
});

test("an owner ref is one line: a second line never makes it the owner's", () => {
  expect(OWNER_REF.test("owner:2026-10-07/chat")).toBe(true);
  expect(OWNER_REF.test("owner:2026-10-07/chat\nForgot-Person: people/jane-roy")).toBe(false);
});

test("forget trailers count only on the owner's commits", () => {
  const root = makeBrain();
  // An assistant's commit whose message carries forget trailers holds no name and undoes nothing.
  git(root, ["commit", "-q", "--allow-empty", "-m", "propose(planner): x\n\nForgot-Person: people/jane-roy\nForgot-At: 2026-10-07T00:00:00Z"], "planner");
  expect(forgottenSlugs(root).has("jane-roy")).toBe(false);
  expect(() => undoForget(root, "people/jane-roy")).toThrow(/no forget/);
  const hash = forgetPerson(root, "people/paul-advisor").hash;
  expect(forgottenSlugs(root).has("paul-advisor")).toBe(true);
  git(root, ["commit", "-q", "--allow-empty", "-m", `propose(planner): y\n\nUndid-Forget: ${hash}`], "planner");
  expect(forgottenSlugs(root).has("paul-advisor")).toBe(true);
});
