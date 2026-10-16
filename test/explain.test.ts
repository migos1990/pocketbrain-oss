// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { write } from "../src/write";
import { verifyChain } from "../src/readlog";
import * as core from "../src/core";
import { explainAgent } from "../src/explain";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const explain = (root: string, ...args: string[]) => {
  const r = Bun.spawnSync(["bun", CLI, "explain", ...args, "--brain", root], { env: { ...process.env, PB_TODAY: "2026-10-08" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};
// A contact in Robin's personal area: Helper gets only role and org through contacts-basic.
function withContact(root: string) {
  writeFileSync(join(root, "people/sam-lee.md"), `---
id: people/sam-lee
type: person
title: Sam Lee
area: personal
sensitivity: personal
status: active
created: 2026-10-01
updated: 2026-10-01
by: steward
facts:
  role: { value: Landlord, as_of: 2026-09-01, sources: ["gmail:f000000000000011"], verification: verified-by-source, by: steward, recorded: 2026-10-01 }
  phones: { items: [{ value: "+15145550111", as_of: 2026-09-01, sources: ["gmail:f000000000000011"], verification: verified-by-source, by: steward, recorded: 2026-10-01 }] }
---
`);
  return root;
}
async function get(root: string, token: string, path: string) {
  return (await handle(root, new Request(`http://pb${path}`, { headers: { authorization: `Bearer ${token}` } }))).status;
}

test("E2E: after Planner searches and reads through the API, explain shows what's in, what's out and why, and who read it", async () => {
  const root = makeBrain();
  const planner = issueToken(root, "planner"), helper = issueToken(root, "helper");
  expect(await get(root, planner, "/v1/search?q=course")).toBe(200);
  expect(await get(root, planner, "/v1/notes/projects%2Fcourse-a")).toBe(200);
  expect(await get(root, helper, "/v1/context")).toBe(200);
  expect(await get(root, planner, "/v1/notes/money%2Fmain-bank")).toBe(404);

  const r = explain(root, "planner", "Maple Trust bank");
  expect(r.code).toBe(0);
  expect(r.out).toContain("read log: 4 entries, chain intact"); // the 404 is logged as what planner looked for
  expect(r.out).toContain("asked for money/main-bank: **hidden from it**");
  expect(r.out).toContain("whole-view pulls by planner: 0");
  expect(r.out).toMatch(/OUT {2}money\/main-bank .*\n {2}why: type money not shared/);
  expect(r.out).toMatch(/IN {3}projects\/course-b .*\n {2}why: slice area:work; body shown/);
  expect(r.out).toContain("preview flag: mentions \"Maple Trust Bank\"");

  const a = explain(root, "planner", "projects/course-a");
  expect(a.out).toMatch(/read by: planner 2x \(search 1, read_note 1|read by: planner 2x \(search 1, read 1/);
  expect(a.out).toContain("next_step: IN [current]");
  // The 404 left no trace of the hidden note in planner's reads.
  expect(explain(root, "planner", "money/main-bank").out).toContain("read by: nobody");
});

test("fact level: an attribute outside the slice and a do-not-share flag each say why", () => {
  const root = withContact(makeBrain());
  const helper = explain(root, "helper", "people/sam-lee");
  expect(helper.out).toContain("role: IN");
  expect(helper.out).toContain("phones: OUT (attribute not in slice)");
  expect(write(root, { agent: "planner", kind: "fact", id: "people/jane-roy", attribute: "role", value: "Course coordinator", as_of: "2026-09-01", sources: ["gmail:f000000000000001"], verification: "verified-by-source", share_with: ["steward"] }).outcome).toBe("committed");
  const t = explain(root, "planner", "people/jane-roy#role");
  expect(t.out).toContain("role: OUT (do not share (only steward))");
  expect(t.out).toContain("{only steward}");
  expect(t.out).not.toContain("phones:");
  expect(explain(root, "steward", "people/jane-roy#role").out).toContain("role: IN");
});

test("a read of a note that's out today is called out; an edited read log is caught", async () => {
  const root = makeBrain();
  const planner = issueToken(root, "planner");
  await get(root, planner, "/v1/notes/projects%2Fcourse-a");
  const p = join(root, "rules/policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace("exclude_types: [money] }", "exclude_types: [money], exclude: [projects/course-a] }"));
  expect(explain(root, "planner", "projects/course-a").out).toContain("! planner was handed this note");
  expect(explain(root, "planner").out).toContain("are out today: projects/course-a");

  const log = join(root, "log/reads.jsonl");
  expect(verifyChain(log).broken).toBeUndefined();
  writeFileSync(log, readFileSync(log, "utf8").replace('"agent":"planner"', '"agent":"helper"'));
  expect(explain(root, "planner").out).toContain("! read log: chain broken at line 1 (the line was edited)");
});

test("no topic: the shape of the slice; an unknown agent is refused", () => {
  const root = withContact(makeBrain());
  const r = explain(root, "helper");
  expect(r.out).toContain("slices: area:work, contacts-basic; ceiling: personal; not shared: money; tier trial");
  expect(r.out).toContain("## Facts held back\n- attribute not in slice: 1");
  expect(explain(root, "nobody").code).toBe(1);
});

test("explain lists ended values from every path: an agent's retire with its source, and a forgotten one", async () => {
  const root = makeBrain();
  const planner = issueToken(root, "planner");
  const r = await handle(root, new Request("http://pb/v1/retire", { method: "POST", headers: { authorization: `Bearer ${planner}` },
    body: JSON.stringify({ id: "people/jane-roy", attribute: "role", value: "Course coordinator", as_of: "2026-10-05", sources: ["gmail:f000000000000012"] }) }));
  expect(r.status).toBe(200);
  expect(explain(root, "planner", "people/jane-roy#role").out).toContain("role (ended, never shown to agents): Course coordinator ended 2026-10-05, retired by planner on 2026-10-08 citing gmail:f000000000000012");
});

test("explain shows what an agent went looking for, including the hidden note it was told doesn't exist", () => {
  const root = makeBrain();
  core.search(root, "helper", "bank");
  expect(() => core.readNote(root, "helper", "money/main-bank")).toThrow("no note");
  expect(() => core.readNote(root, "helper", "money/nothing-here")).toThrow("no note");
  const out = explainAgent(root, "helper", "bank").lines.join("\n");
  expect(out).toContain("## What helper looked for");
  expect(out).toContain('search "bank": 0 result(s)');
  expect(out).toContain("asked for money/main-bank: **hidden from it**");
  const all = explainAgent(root, "helper").lines.join("\n");
  expect(all).toContain("asked for money/nothing-here: doesn't exist");
});
