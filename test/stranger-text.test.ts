// SPDX-License-Identifier: AGPL-3.0-only
// What a stranger's agent reads when a write is refused, and what a handed-over brain tells its
// new owner, lists only public names: never the original owner's name or the ref schemes named
// after one person's assistants. Those old names are still accepted, just not advertised.
import { test, expect } from "bun:test";
import { runChecks, type WriteRequest } from "../src/checks";
import { SCHEMES, PUBLIC_SCHEMES } from "../src/sources";

const base: WriteRequest = { agent: "planner", id: "projects/course-a", attribute: "next_step", value: "Publish grades", as_of: "2026-10-07", sources: ["gmail:f000000000000006"], verification: "verified-by-source" };
const PRIVATE = /\blouis\b|instinct|town/i;
const said = (req: Partial<WriteRequest>) => runChecks({ ...base, ...req }, new Set()).map((f) => `${f.reason} ${f.fix}`).join("\n");

test("refusals list only public names", () => {
  const texts = [
    said({ sources: ["nosuch:1"] }), // source_resolvable: the scheme list
    said({ verification: "sure" as WriteRequest["verification"] }), // schema: the verification list
    said({ source_type: "rumour" }), // schema: the source type list
    said({ source_type: "owner_message", sources: ["gmail:f000000000000006"] }), // source_matches_type: what to cite
  ];
  for (const t of texts) expect(t.length).toBeGreaterThan(0);
  for (const t of texts) expect(t).not.toMatch(PRIVATE);
});

test("the old names still work", () => {
  expect(said({ sources: ["instinct-mem:note-1"], source_type: "agent_observation", verification: "self-reported" })).not.toContain("isn't a known ref shape");
  expect(said({ verification: "confirmed-by-louis", sources: ["louis:2026-10-07/grades"] })).not.toContain("unknown");
  expect(said({ source_type: "louis_message", sources: ["louis:2026-10-07/grades"] })).not.toContain("unknown");
  for (const s of PUBLIC_SCHEMES) expect(s in SCHEMES).toBe(true);
});

test("a handed-over brain tells the new owner to cite owner:, not the old owner's name", async () => {
  const src = await Bun.file(new URL("../src/handover.ts", import.meta.url)).text();
  const guide = src.slice(src.indexOf("## Known limits"));
  expect(guide).not.toMatch(/`louis:/);
});
