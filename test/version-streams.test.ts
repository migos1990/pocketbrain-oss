// SPDX-License-Identifier: AGPL-3.0-only
// The owner's phone, 2026-10-24 ("How is this a great UI experience, right?"): an app's TestFlight
// mails made a conflict of six build numbers, "Keep (1)" to "Keep (6)", each "the agent's word ·
// by instinct", under "source failed: source:gmail-primary" at the top of the page. A conflict
// between successive versions is one question about the newest; a conflict never shows more than
// two sides as buttons, the rest one tap away; and alert text is said in words.
import { test, expect } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { git } from "../src/git";
import { alert } from "../src/util";
import { loadState } from "../src/dashboard/data";
import { overview } from "../src/dashboard/html";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");
const BUILDS = [["0.17.0 (24)", "2026-10-07"], ["0.18.0 (25)", "2026-10-07"], ["0.19.0 (26)", "2026-10-07"], ["0.20.0 (27)", "2026-10-07"], ["0.20.1 (28)", "2026-10-07"], ["0.21.0 (29)", "2026-10-07"]];

function brain(values = BUILDS.map(([v]) => `${v} is ready to test on iOS and watchOS`)) {
  const root = makeBrain();
  const w = { agent: "planner", id: "projects/course-a", attribute: "status", as_of: "2026-10-07", verification: "verified-by-source" as const };
  write(root, { ...w, value: values[0], sources: ["gmail:f000000000000006"] } as never);
  expect(write(root, { ...w, value: values[1], sources: ["gmail:f000000000000004"] } as never).outcome).toBe("disputed");
  const f = join(root, "disputes", readdirSync(join(root, "disputes"))[0]);
  const [, fm, body] = readFileSync(f, "utf8").split(/^---\n/m);
  const d = YAML.parse(fm);
  for (const v of values.slice(2)) d.candidates.push({ ...d.candidates[1], value: v });
  writeFileSync(f, `---\n${YAML.stringify(d)}---\n${body}`);
  alert(root, { agent: "source:gmail-primary", check: "source_failed", from: "HTTP 401 from the Gmail API" });
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "dispute"]);
  return root;
}

test("Settings shows neither six buttons, nor the assistant's labels, nor alert text", () => {
  const root = brain();
  const html = overview(loadState(root), "x").body;
  const top = html.slice(0, html.indexOf('<details class="more"'));
  expect(top).not.toMatch(/Keep \(\d\)/);
  expect(text(top)).not.toMatch(/source:gmail|HTTP 401|agent's word|by planner/);
});

// The cold reader opened the fold (2026-10-24): the same conflict there still read "Keep (1)" ...
// "Keep (6)", "by planner", "ref". The conflicts are asked on the home now; Settings lists them in words.
test("many conflicts on Settings: no numbered buttons, no labels or refs", () => {
  const root = brain();
  // More conflicts than one day's cards, so some wait in the fold.
  for (let i = 1; i <= 7; i++) {
    const w = { agent: "planner", id: "projects/course-b", attribute: `room_${i}`, as_of: "2026-10-07", verification: "verified-by-source" as const };
    write(root, { ...w, value: `Room A-${i}`, sources: ["gmail:f000000000000006"] } as never);
    write(root, { ...w, value: `Room B-${i}`, sources: ["gmail:f000000000000004"] } as never);
  }
  const html = overview(loadState(root), "x").body;
  expect(html).not.toMatch(/>Keep \(\d\)</);
  expect(text(html)).not.toMatch(/\bby (planner|instinct|helper)\b|\bref\b|agent's word|source:gmail/);
});
