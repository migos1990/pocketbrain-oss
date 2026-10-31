// SPDX-License-Identifier: AGPL-3.0-only
// 0.2.0 live, 2026-10-30: two assistant proposals asked to move a page to another area along with
// their fact. The filing tick planned "saved it", but write() handed each back to the inbox
// (area_change_needs_louis) and the save was refused, every day (755 refused-save lines). No path
// ever moved a page's area, not even the owner's yes. Now a yes to such a proposal, the hub's or
// the owner's, files its fact by the usual rules where the page is: an assistant never moves a page.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain, type FactRecord } from "../src/brain";
import { runAuto } from "../src/filing";
import { write, decideProposal } from "../src/write";

const AFTER = new Date("2026-10-30T15:00:00Z");
const sh = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
function brain(): string {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "owner: setup");
  return root;
}
const course = (root: string) => loadBrain(root).find((n) => n.fm.id === "projects/course-a")!;
const ask = (root: string) => {
  const r = write(root, { agent: "planner", id: "projects/course-a", attribute: "room", value: "B-201", as_of: "2026-10-07", sources: ["gmail:f000000000000041"], area: "personal" } as never);
  expect(r.outcome).toBe("inbox");
  return String(r.file);
};

test("the hub's tick files an assistant's fact that asked to move its page, and the page stays put", () => {
  const root = brain();
  const area = course(root).fm.area;
  ask(root);
  const done = runAuto(root, AFTER);
  expect(done.map((d) => d.picked)).toEqual(["saved it"]);
  expect((course(root).fm.facts!.room as FactRecord).value).toBe("B-201");
  expect(course(root).fm.area).toBe(area);
  expect(readFileSync(join(root, "log", "auto-decisions-errors.jsonl"), { flag: "a+" }).toString()).toBe("");
});

test("the owner's yes files it too, never loops back into the inbox", () => {
  const root = brain();
  const file = ask(root);
  const r = decideProposal(root, file, "accept");
  expect(r.outcome).toBe("committed");
  expect((course(root).fm.facts!.room as FactRecord).value).toBe("B-201");
});

// The detector: a save refused twice under the same code is never planned again until other code
// runs, however old the refusals; once under other code, it is tried again (G407).
test("a save refused twice under this code isn't tried again the next day", async () => {
  const { failedSaves, FILING_CODE } = await import("../src/filing");
  const root = brain();
  const { mkdirSync, appendFileSync } = await import("node:fs");
  mkdirSync(join(root, "log"), { recursive: true });
  const line = (key: string, at: string, code: string) => appendFileSync(join(root, "log", "auto-decisions-errors.jsonl"), JSON.stringify({ at, key, error: "refused", code }) + "\n");
  line("proposal:a.yaml", "2026-10-20T00:00:00Z", FILING_CODE); line("proposal:a.yaml", "2026-10-21T00:00:00Z", FILING_CODE);
  line("proposal:b.yaml", "2026-10-20T00:00:00Z", FILING_CODE);
  line("proposal:c.yaml", "2026-10-20T00:00:00Z", "other"); line("proposal:c.yaml", "2026-10-21T00:00:00Z", "other");
  expect([...failedSaves(root, AFTER)].sort()).toEqual(["proposal:a.yaml"]);
});

// 6ebb09f7 live, 2026-10-30: the two real proposals named their page by title, not id, so G519's
// check (which looked the page up by id) never saw the area move and the save was refused again.
test("a proposal naming its page by title files too, and the page stays put", () => {
  const root = brain();
  const area = course(root).fm.area;
  const r = write(root, { agent: "planner", type: "project", title: "Course A", attribute: "room", value: "B-201", as_of: "2026-10-07", sources: ["gmail:f000000000000041"], area: "personal" } as never);
  expect(r.outcome).toBe("inbox");
  expect(runAuto(root, AFTER).map((d) => d.picked)).toEqual(["saved it"]);
  expect((course(root).fm.facts!.room as FactRecord).value).toBe("B-201");
  expect(course(root).fm.area).toBe(area);
});
