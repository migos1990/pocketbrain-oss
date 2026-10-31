// SPDX-License-Identifier: AGPL-3.0-only
// Facts that change over time (backlog 403, docs/wiki.md "Facts that change over time"): an
// attribute declared `merge: latest` (and version/build names by default) keeps the newest value
// with the earlier ones in history. Same-day or approximate-date values never open a dispute; an
// older value goes to history; the owner's word still can't be replaced by an assistant.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { loadBrain } from "../src/brain";
import { attributeSpec, loadRules } from "../src/rules";
import { lifeOf } from "../src/freshness";
import { recordCheckedRefs } from "../src/louis";

const B = "projects/course-b";
let n = 0;
const src = () => `gmail:f0000000000001${String(++n).padStart(2, "0")}`;
// Each value cites a message the hub has read (the always-on source check, G417).
const put = (root: string, attribute: string, value: string, as_of: string, extra: Record<string, unknown> = {}) => {
  const ref = src();
  recordCheckedRefs(root, { [ref]: true });
  return write(root, { agent: "planner", id: B, attribute, value, as_of, sources: [ref], verification: "verified-by-source", ...extra });
};
const facts = (root: string) => loadBrain(root).find((x) => x.fm.id === B)!.fm;

test("same-day build numbers: the newest is kept, the earlier one goes to history, no dispute", () => {
  const root = makeBrain();
  expect(put(root, "build", "41", "2026-10-06").outcome).toBe("committed");
  const r = put(root, "build", "42", "2026-10-06");
  expect(r.outcome).toBe("committed");
  const fm = facts(root);
  expect((fm.facts!.build as { value: string }).value).toBe("42");
  expect(fm.history!.build!.map((h) => h.value)).toEqual(["41"]);
});

test("an approximate date doesn't open a dispute either", () => {
  const root = makeBrain();
  put(root, "version", "1.2", "2026-10-01");
  const r = put(root, "version", "1.3", "2026-10-01", { as_of_approx: true });
  expect(r.outcome).toBe("committed");
  expect((facts(root).facts!.version as { value: string }).value).toBe("1.3");
});

test("an older value is recorded in history, the current one stays", () => {
  const root = makeBrain();
  put(root, "build", "42", "2026-10-06");
  const r = put(root, "build", "40", "2026-10-02");
  expect(r.outcome).toBe("committed");
  const fm = facts(root);
  expect((fm.facts!.build as { value: string }).value).toBe("42");
  expect(fm.history!.build!.map((h) => h.value)).toEqual(["40"]);
  put(root, "build", "40", "2026-10-02");
  expect(facts(root).history!.build!.map((h) => h.value)).toEqual(["40"]);
  expect(facts(root).history!.build![0].sources.length).toBe(2);
});

test("a declared latest attribute works the same; undeclared ordinary attributes still dispute", () => {
  const root = makeBrain();
  const p = join(root, "rules/checks.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace("      next_step: { merge: replace, shelf_life: 14d }", "      next_step: { merge: replace, shelf_life: 14d }\n      price: { merge: latest }"));
  Bun.spawnSync(["git", "commit", "-qam", "rules"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
  put(root, "price", "$40", "2026-10-06");
  expect(put(root, "price", "$45", "2026-10-06").outcome).toBe("committed");
  put(root, "venue", "Room 101", "2026-10-06");
  expect(put(root, "venue", "Room 202", "2026-10-06").outcome).toBe("disputed");
});

test("an assistant's newer value never replaces the owner's word: still a dispute", () => {
  const root = makeBrain();
  put(root, "build", "41", "2026-10-06");
  const p = join(root, `${B}.md`);
  writeFileSync(p, readFileSync(p, "utf8").replace(/(build:.*?)gmail:f\d+(.*?)verified-by-source/s, "$1owner:2026-10-06/approval$2confirmed-by-owner"));
  Bun.spawnSync(["git", "commit", "-qam", "owner"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
  expect((facts(root).facts!.build as { verification: string }).verification).toBe("confirmed-by-owner");
  expect(put(root, "build", "42", "2026-10-07").outcome).toBe("disputed");
});

test("version and build default to latest, and read as changing over time", () => {
  const rules = loadRules(makeBrain());
  expect(attributeSpec(rules, "project", "build").merge).toBe("latest");
  expect(attributeSpec(rules, "project", "role").merge).toBeUndefined();
  const life = lifeOf({ value: "42", as_of: "2026-10-06", sources: [], verification: "verified-by-source", by: "planner" } as never, attributeSpec(rules, "project", "version"), false);
  expect(life).toEqual({ kind: "latest" });
});

test("a value only relayed by another assistant still waits in the inbox", () => {
  const root = makeBrain();
  put(root, "build", "41", "2026-10-06");
  const r = write(root, { agent: "planner", id: B, attribute: "build", value: "42", as_of: "2026-10-07", sources: ["agent-relay:helper/2026-10-07"], verification: "unverified" });
  expect(r.message).toContain("relayed_only");
  expect((facts(root).facts!.build as { value: string }).value).toBe("41");
});

test("a merge kind this hub doesn't know is read as replace: a same-day change still disputes", () => {
  // What an older hub does with `merge: latest`: rules are never validated against the kinds, so
  // the line is harmless before the hub that understands it is running.
  const root = makeBrain();
  const p = join(root, "rules/checks.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace("      next_step: { merge: replace, shelf_life: 14d }", "      next_step: { merge: replace, shelf_life: 14d }\n      venue: { merge: someday-kind }"));
  Bun.spawnSync(["git", "commit", "-qam", "rules"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
  expect(put(root, "venue", "Room 101", "2026-10-06").outcome).toBe("committed");
  expect(put(root, "venue", "Room 202", "2026-10-07").outcome).toBe("committed");
  expect(put(root, "venue", "Room 303", "2026-10-07").outcome).toBe("disputed");
});

// Slice audit of 5141347c: the cases below each changed a fact the ladder had sent to the owner.
const live = (root: string) => (facts(root).facts!.build as { value?: string; dispute?: string });

test("fs-weaker-newer: a weaker newer value doesn't replace a stronger one", () => {
  const root = makeBrain();
  put(root, "build", "42", "2026-10-06");
  const r = write(root, { agent: "planner", id: B, attribute: "build", value: "17", as_of: "2026-10-07", sources: [src()], confidence: "inferred" } as never);
  expect(r.outcome).toBe("disputed");
});

test("fs-owner-older: the owner's word dated earlier never goes quietly to history", () => {
  const root = makeBrain();
  put(root, "build", "42", "2026-10-06");
  const r = write(root, { agent: "planner", id: B, attribute: "build", value: "40", as_of: "2026-10-05", sources: ["owner:2026-10-05/approval"], verification: "confirmed-by-owner" } as never, { acceptedBy: "louis" });
  expect(r.message).not.toContain("latest");
  expect(facts(root).history?.build?.some((h) => h.verification === "confirmed-by-owner" && h.value === "40" && h.ended_by?.step === 2) ?? false).toBe(false);
});

test("fs-same-day-stale: on the same day the higher build stays current, a value with no order disputes", () => {
  const root = makeBrain();
  put(root, "build", "42", "2026-10-06");
  expect(put(root, "build", "41", "2026-10-06").outcome).toBe("committed");
  expect(live(root).value).toBe("42");
  expect(facts(root).history!.build!.map((h) => h.value)).toEqual(["41"]);
  expect(put(root, "build", "43 ready to test", "2026-10-06").outcome).toBe("committed");
  expect(live(root).value).toBe("43 ready to test");
  expect(put(root, "build", "beta", "2026-10-06").outcome).toBe("disputed");
});

test("fs-person-build: the default names are a project's only", () => {
  const rules = loadRules(makeBrain());
  expect(attributeSpec(rules, "person", "build").merge).toBeUndefined();
  expect(attributeSpec(rules, "note", "version").merge).toBeUndefined();
});

test("fs-history-oracle: an earlier value gets the same reply whether or not history holds it", () => {
  const root = makeBrain();
  put(root, "build", "42", "2026-10-06");
  const first = put(root, "build", "40", "2026-10-02");
  const again = put(root, "build", "40", "2026-10-02");
  const fresh = put(root, "build", "39", "2026-10-01");
  expect([first, again, fresh].map((r) => [r.outcome, r.message])).toEqual([["committed", "latest: value recorded"], ["committed", "latest: value recorded"], ["committed", "latest: value recorded"]]);
});

test("fs-between: an earlier value ends where the next one begins", () => {
  const root = makeBrain();
  put(root, "build", "40", "2026-10-01");
  put(root, "build", "42", "2026-10-06");
  put(root, "build", "41", "2026-10-03");
  const h = facts(root).history!.build!;
  expect(h.map((x) => [x.value, x.valid_to])).toEqual([["40", "2026-10-06"], ["41", "2026-10-06"]]);
});
