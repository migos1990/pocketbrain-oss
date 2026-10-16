// SPDX-License-Identifier: AGPL-3.0-only
// Who read what (backlog #277): per agent per day, the notes it opened and searched for, from the
// read log, with one 'unusual' line when an agent reads far outside its usual areas. Owner only.
import { test, expect } from "bun:test";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { appendChained } from "../src/readlog";
import { readsByDay, readsReport } from "../src/whoread";
import { main } from "../src/cli";
import { whatItRead } from "../src/dashboard/html-lookedfor";
import { loadBrain } from "../src/brain";

const log = (root: string, at: string, agent: string, op: string, ids: string[], extra: Record<string, string> = {}) =>
  appendChained(join(root, "log", "reads.jsonl"), { at, agent, op, ids, ...extra });

// Five days of planner reading work notes, then a day of personal and money notes.
function history(root: string) {
  for (const d of ["01", "02", "03", "04", "05"]) {
    log(root, `2026-10-${d}T15:00:00.000Z`, "planner", "read", ["projects/course-a"]);
    log(root, `2026-10-${d}T15:05:00.000Z`, "planner", "search", ["projects/course-b", "people/jane-roy"], { q: "course rooms" });
  }
  log(root, "2026-10-06T15:00:00.000Z", "planner", "read", ["money/main-bank"]);
  log(root, "2026-10-06T15:01:00.000Z", "planner", "read", ["decisions/2026-09-01-pick-bank"]);
  log(root, "2026-10-06T15:02:00.000Z", "planner", "search", ["people/paul-advisor", "projects/course-a"], { q: "advisor" });
  log(root, "2026-10-06T15:03:00.000Z", "planner", "context_pack", ["*"]);
  log(root, "2026-10-06T15:04:00.000Z", "planner", "read", [], { asked: "people/nobody" });
  log(root, "2026-10-06T15:05:00.000Z", "helper", "read", ["money/main-bank"]);
}

test("each day lists the notes the agent was handed, its searches with hits, whole-view pulls and misses", () => {
  const root = makeBrain();
  history(root);
  const days = readsByDay(root, "planner", { days: 30, today: "2026-10-06" });
  expect(days.map((d) => d.day)).toEqual(["2026-10-06", "2026-10-05", "2026-10-04", "2026-10-03", "2026-10-02", "2026-10-01"]);
  const d = days[0];
  expect(d.notes.map((n) => n.id).sort()).toEqual(["decisions/2026-09-01-pick-bank", "money/main-bank", "people/paul-advisor", "projects/course-a"]);
  expect(d.notes.find((n) => n.id === "money/main-bank")?.area).toBe("personal");
  expect(d.searches).toEqual([{ op: "search", q: "advisor", hits: 2 }]);
  expect(d.whole).toBe(1);
  expect(d.asked).toBe(1);
  expect(readsByDay(root, "helper", { days: 30, today: "2026-10-06" }).map((x) => x.notes.map((n) => n.id))).toEqual([["money/main-bank"]]);
});

test("a day mostly outside the agent's usual areas carries one unusual line; a normal day or a new agent doesn't", () => {
  const root = makeBrain();
  history(root);
  const [today, normal] = readsByDay(root, "planner", { days: 30, today: "2026-10-06" });
  expect(today.unusual).toEqual({ outside: ["decisions/2026-09-01-pick-bank", "money/main-bank", "people/paul-advisor"], areas: ["personal"], of: 4 });
  expect(normal.unusual).toBeUndefined();
  // helper has no history before that day: nothing to compare with, so no flag
  expect(readsByDay(root, "helper", { days: 30, today: "2026-10-06" })[0].unusual).toBeUndefined();
  const text = readsReport(root, "planner", { days: 30, today: "2026-10-06" });
  expect(text).toContain("unusual: 3 of 4 notes outside its usual areas (personal)");
});

test("days follow the owner's timezone, and a deleted note still shows, as gone", () => {
  const root = makeBrain();
  log(root, "2026-10-06T02:00:00.000Z", "planner", "read", ["projects/course-a"]); // 22:00 the 5th in Toronto
  log(root, "2026-10-06T03:00:00.000Z", "planner", "read", ["projects/old-course"]);
  const days = readsByDay(root, "planner", { days: 7, today: "2026-10-06", tz: "America/Toronto" });
  expect(days.map((d) => d.day)).toEqual(["2026-10-05"]);
  expect(days[0].notes.find((n) => n.id === "projects/old-course")?.area).toBe("(gone)");
  expect(readsByDay(root, "planner", { days: 7, today: "2026-10-06", tz: "UTC" }).map((d) => d.day)).toEqual(["2026-10-06"]);
});

test("words an agent searched for can't forge lines or escapes in the owner's terminal", () => {
  const root = makeBrain();
  log(root, "2026-10-06T15:00:00.000Z", "planner", "search", [], { q: "rooms\n2026-10-06  helper read money/main-bank\u001b[2J\u0085x" });
  const text = readsReport(root, "planner", { days: 7, today: "2026-10-06" });
  expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  expect(text.split("\n").filter((l) => l.includes("helper read")).every((l) => l.includes("rooms"))).toBe(true);
});

test("pocketbrain reads <agent> prints the days; an unknown agent is an error", async () => {
  const root = makeBrain();
  history(root);
  const out: string[] = [], err: string[] = [];
  const [log0, err0] = [console.log, console.error];
  console.log = (s: string) => out.push(String(s)); console.error = (s: string) => err.push(String(s));
  process.env.PB_TODAY = "2026-10-06";
  try {
    expect(await main(["reads", "planner", "--days", "2", "--brain", root])).toBe(0);
    expect(await main(["reads", "nobody", "--brain", root])).toBe(2);
    expect(await main(["reads", "planner", "--json", "--days", "1", "--brain", root])).toBe(0);
  } finally { console.log = log0; console.error = err0; }
  const text = out.join("\n");
  expect(text).toContain("2026-10-06");
  expect(text).toContain("2026-10-05");
  expect(text).not.toContain("2026-10-04");
  expect(JSON.parse(out[out.length - 1])[0].day).toBe("2026-10-06");
  expect(err.join("\n")).toMatch(/no agent nobody/);
});

test("the dashboard's agent page shows the days, with the unusual line, escaped", () => {
  const root = makeBrain();
  history(root);
  log(root, "2026-10-06T16:00:00.000Z", "planner", "read", ["projects/<b>x</b>"]);
  process.env.PB_TODAY = "2026-10-06";
  const html = whatItRead({ root, notes: loadBrain(root) }, "planner");
  expect(html).toContain("What it read, day by day");
  expect(html).toContain("Unusual: 4 of 5 notes outside its usual areas ((gone), personal).");
  expect(html).not.toContain("<b>x</b>");
  expect(html).toContain("pocketbrain reads planner");
  expect(whatItRead({ root, notes: loadBrain(root) }, "steward")).toContain("Nothing read in the last 7 days.");
});

test("owner only: no agent door imports it", () => {
  for (const f of ["server.ts", "core.ts", "browser.ts", "orientation.ts", "cell.ts", "edge.ts"])
    expect(require("node:fs").readFileSync(join(import.meta.dir, "..", "src", f), "utf8")).not.toContain("whoread");
});
