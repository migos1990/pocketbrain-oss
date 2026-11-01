// SPDX-License-Identifier: AGPL-3.0-only
// What the filing tick does with a pulled item for a list beside the owner's own items (G565; the
// slice audit of claude/audit8-contacts asked for the item_key side). In a set, another item files
// beside the owner's; an item with the same item_key and other content contradicts the owner's and
// waits for the owner, as write() would mark it.
import { test, expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { runAuto } from "../src/filing";
import { loadBrain } from "../src/brain";

const NOW = new Date("2026-10-28T15:00:00Z");
const sh = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
const OWNER_ITEM = `{ value: { session: 6, date: 2026-11-04 }, as_of: 2026-10-02, sources: ["owner:2026-10-02/notes"], verification: confirmed-by-owner, by: owner, recorded: 2026-10-02 }`;

function pulled(attr: string, value: unknown, holds: string): string {
  const root = makeBrain();
  const f = join(root, "projects", "course-a.md");
  // The page also holds a private fact: there filing used to hand any different value back to the
  // owner as a disagreement, and a new item never filed (G565).
  writeFileSync(f, readFileSync(f, "utf8").replace("verification: verified-by-source, by: planner", "verification: verified-by-source, sensitivity: private, by: planner").replace("\n---\n", `\n  ${attr}: { items: [${holds}] }\n---\n`));
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  mkdirSync(join(root, "inbox", "captures"), { recursive: true });
  writeFileSync(join(root, "inbox", "captures", "m.md"), "Session moved.\n");
  writeFileSync(join(root, "inbox", "2026-10-12-capture-m1.yaml"), YAML.stringify({ proposed: "2026-10-12", by: "steward", reason: "capture inbox/captures/m.md: a new item", checks: ["capture"], capture: "inbox/captures/m.md", request: { agent: "steward", kind: "fact", id: "projects/course-a", attribute: attr, value, as_of: "2026-10-12", sources: ["gmail:f000000000000012"], verification: "self-reported" } }));
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "capture: stored");
  return root;
}
const items = (root: string, attr: string) => ((loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm.facts![attr] as { items: { value: unknown; valid_to?: string }[] }).items).filter((i) => !i.valid_to).map((i) => i.value);

test("a pulled item with another item_key files beside the owner's item", () => {
  const root = pulled("schedule_changes", { session: 7, date: "2026-11-11" }, OWNER_ITEM);
  expect(runAuto(root, NOW).map((d) => d.picked)).toEqual(["saved it"]);
  expect(items(root, "schedule_changes")).toEqual([{ session: 6, date: "2026-11-04" }, { session: 7, date: "2026-11-11" }]);
});

test("a pulled item with the owner's item_key and another date doesn't file over the owner's", () => {
  const root = pulled("schedule_changes", { session: 6, date: "2026-11-18" }, OWNER_ITEM);
  const done = runAuto(root, NOW).map((d) => d.picked);
  expect(done).not.toContain("saved it");
  expect(items(root, "schedule_changes")).toContainEqual({ session: 6, date: "2026-11-04" });
});
