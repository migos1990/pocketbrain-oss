// SPDX-License-Identifier: AGPL-3.0-only
// The owner's pages at scale (backlog #295): every long list shows a page at a time with links to
// the others, and the page state is kept between requests until the brain or rules change. The
// timings at 10k notes are rows in scripts/perf.ts (docs/perf.md).
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { dashboardHandler } from "../src/dashboard/server";
import { loadState } from "../src/dashboard/data";
import { write } from "../src/write";
import { paged, pager } from "../src/dashboard/paging";

const H = "127.0.0.1:8788";

async function signedIn(root: string) {
  const d = dashboardHandler(root, { port: 8788, loginKey: "k".repeat(32) });
  const cookie = (await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }))).headers.get("set-cookie")!.split(";")[0];
  return async (path: string) => { const r = await d.handle(new Request(`http://${H}${path}`, { headers: { host: H, cookie } })); return { status: r.status, text: await r.text() }; };
}

const course = (root: string, i: number) => readFileSync(join(root, "projects/course-a.md"), "utf8")
  .replace("id: projects/course-a", `id: projects/bulk-${String(i).padStart(4, "0")}`).replace("title: Course A", `title: Bulk course ${String(i).padStart(4, "0")}`);

test("a page cuts a list into pages, clamps the page asked for, and links only to pages that exist", () => {
  const items = Array.from({ length: 450 }, (_, i) => i);
  expect(paged(items, 1).rows).toEqual(items.slice(0, 200));
  expect(paged(items, 3).rows).toEqual(items.slice(400));
  expect(paged(items, 99).page).toBe(3);
  expect(paged(items, Number("junk")).page).toBe(1);
  const html = pager(paged(items, 2), (n) => `/x?page=${n}`, "reads");
  expect(html).toContain("201–400 of 450 reads");
  expect(html).toContain('href="/x?page=1"');
  expect(html).toContain('href="/x?page=3"');
  expect(pager(paged(items.slice(0, 10), 1), (n) => `/x?page=${n}`)).toBe("");
});

test("activity shows a year of reads a page at a time, newest first", async () => {
  const root = makeBrain();
  mkdirSync(join(root, "log"), { recursive: true });
  appendFileSync(join(root, "log", "reads.jsonl"), Array.from({ length: 450 }, (_, i) => JSON.stringify({ at: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T10:${String(i % 60).padStart(2, "0")}:00Z`, agent: "helper", op: "search", q: `query-${i}`, ids: [] }) + "\n").join(""));
  const get = await signedIn(root);
  const one = await get("/activity");
  expect(one.text).toContain("1–200 of 450 reads");
  expect(one.text).toContain('href="/activity?page=2"');
  expect(one.text).toContain("query-449");
  expect(one.text).not.toContain('query-0"');
  const last = await get("/activity?page=3");
  expect(last.text).toContain("401–450 of 450 reads");
  expect(last.text).toContain('query-0"');
  expect(last.text).not.toContain('rel="next"');
});

test("Needs you and an assistant's notes go a page at a time", async () => {
  const root = makeBrain();
  mkdirSync(join(root, "inbox"), { recursive: true });
  // Each reads like money: sixty single proposals, a page at a time.
  for (let i = 0; i < 60; i++) writeFileSync(join(root, "inbox", `2026-10-0${1 + (i % 7)}-helper-${String(i).padStart(4, "0")}.yaml`), YAML.stringify({ proposed: "2026-10-07", by: "helper", reason: "helper is a trial agent: propose-only", checks: [], request: { agent: "helper", id: "projects/course-a", attribute: `fee_${i}`, value: `Lab fee $${i}`, as_of: "2026-10-07", sources: ["gmail:f000000000000003"], sensitivity: "private" } }));
  for (let i = 0; i < 250; i++) writeFileSync(join(root, "projects", `bulk-${String(i).padStart(4, "0")}.md`), course(root, i));
  const get = await signedIn(root);
  const home = await get("/overview");
  expect(home.text).toMatch(/Still open \(60\)/);
  expect(home.text).toMatch(/1–50 of \d+ open/);
  expect(home.text).toContain('href="/overview?page=2"');
  expect((await get("/overview?page=2")).text).toMatch(/51–\d+ of \d+ open/);
  const agent = await get("/agent/planner");
  expect(agent.text).toMatch(/1–200 of \d+ notes/);
  expect(agent.text).toContain('href="/agent/planner?page=2"');
  expect((await get("/agent/planner?page=2")).text).toContain("Bulk course 0249");
});

test("the page state keeps each carve until the brain changes, and a write shows at once", () => {
  const root = makeBrain();
  const a = loadState(root), b = loadState(root);
  expect(b.carves.get("planner")).toBe(a.carves.get("planner"));
  write(root, { agent: "planner", id: "projects/course-a", attribute: "room", value: "B-201", as_of: "2026-10-08", sources: ["gmail:f000000000000004"] });
  const c = loadState(root);
  expect(c.carves.get("planner")).not.toBe(a.carves.get("planner"));
  expect(c.carves.get("planner")!.visible.get("projects/course-a")!.note.fm.facts?.room).toBeDefined();
});

test("an assistant's page, once the page state is built, reads no note, rules or log file again and runs no git (backlog #318)", async () => {
  const fs = await import("node:fs");
  const { spyOn } = await import("bun:test");
  const { agentPage } = await import("../src/dashboard/html");
  const root = makeBrain();
  mkdirSync(join(root, "log"), { recursive: true });
  appendFileSync(join(root, "log", "reads.jsonl"), Array.from({ length: 30 }, (_, i) => JSON.stringify({ at: `2026-10-0${1 + (i % 7)}T10:00:00Z`, agent: "planner", op: "search", q: `query-${i}`, ids: ["projects/course-a"] }) + "\n").join(""));
  write(root, { agent: "planner", id: "projects/course-a", attribute: "room", value: "B-201", as_of: "2026-10-08", sources: ["gmail:f000000000000004"] });
  const s = loadState(root);
  const first = agentPage(s, "x", "planner")!.body;
  const read = spyOn(fs, "readFileSync"), spawn = spyOn(Bun, "spawnSync");
  try {
    expect(agentPage(s, "x", "planner")!.body).toBe(first);
    expect(read.mock.calls.map((c) => String(c[0]).replace(root, ""))).toEqual([]);
    expect(spawn.mock.calls.length).toBe(0);
  } finally { read.mockRestore(); spawn.mockRestore(); }
  // What it read and wrote is on the page, from the state's own logs.
  expect(first).toContain("query-29");
  expect(first).toMatch(/1 write in 30 days/);
});

test("an assistant's page shows a new read and a new write at once, though the figures are kept between minutes (#318)", async () => {
  const root = makeBrain();
  mkdirSync(join(root, "log"), { recursive: true });
  const get = await signedIn(root);
  expect((await get("/agent/helper")).text).not.toContain("zebra-crossing");
  appendFileSync(join(root, "log", "reads.jsonl"), JSON.stringify({ at: "2026-10-08T10:00:00Z", agent: "helper", op: "search", q: "zebra-crossing", ids: [] }) + "\n");
  expect((await get("/agent/helper")).text).toContain("zebra-crossing");
});
