// SPDX-License-Identifier: AGPL-3.0-only
// The owner's phone, 2026-10-24 ("How am I supposed to select when there's like three options that I
// can't even read on my phone? ... it's really not clear what I'm being asked to do"): a next step
// written three ways showed "Which is right: Cabin (rental host), next step?" over a row of buttons
// "Keep Clear up whether Suzanne an…", "Keep Reply to the Airbnb thread …", "See all 3" running past
// the screen's edge, and three cut lines. A conflict asks one question about the newest, shows it in
// full, answers with two stacked buttons, and keeps the others, in full, one tap away. Conflicts are
// asked on the home's settle screen now (outside review v5); the dashboard's CSS still stacks buttons.
import { test, expect } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { git } from "../src/git";
import { loadState } from "../src/dashboard/data";
import { overview, CSS } from "../src/dashboard/html";

const STEPS = [
  "Clear up whether Suzanne and Darquise are the hosts or the cleaners before the next booking",
  "Reply to the Airbnb thread from Alena and Vladimir about the late check-out on Oct 26",
  "Send the drafted (not yet sent) reply to Alena and Vladimir confirming the check-out time",
];
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");

function brain() {
  const root = makeBrain();
  const w = { id: "projects/course-a", attribute: "next_step", as_of: "2026-10-07", verification: "verified-by-source" as const };
  write(root, { ...w, agent: "planner", value: STEPS[0], sources: ["gmail:f000000000000006"] } as never);
  expect(write(root, { ...w, agent: "planner", value: STEPS[1], sources: ["gmail:f000000000000004"] } as never).outcome).toBe("disputed");
  const f = join(root, "disputes", readdirSync(join(root, "disputes"))[0]);
  const [, fm, body] = readFileSync(f, "utf8").split(/^---\n/m);
  const d = YAML.parse(fm);
  d.candidates[1].by = "helper"; // a second assistant wrote it
  d.candidates.push({ ...d.candidates[1], value: STEPS[2], as_of: "2026-10-08" });
  writeFileSync(f, `---\n${YAML.stringify(d)}---\n${body}`);
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "three next steps"]);
  return root;
}

test("on a phone, buttons stack and no line is cut or runs past the edge", () => {
  expect(CSS).not.toMatch(/\.one\{[^}]*nowrap/);
  expect(CSS).not.toMatch(/\.rows li>span:first-child\{[^}]*ellipsis/);
  expect(CSS).toMatch(/\.glance \.btns\{[^}]*flex-direction:column/);
});

test("the conflict is asked once, on the home: Settings doesn't list it with its own buttons", async () => {
  const root = brain();
  const top = text(overview(loadState(root), "x").body);
  for (const s of STEPS) expect(top).not.toContain(s);
  const { waitingCount } = await import("../src/dashboard/home");
  expect(waitingCount(root, new Date())).toBe(1);
});
