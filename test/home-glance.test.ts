// SPDX-License-Identifier: AGPL-3.0-only
// What is still open, on Settings (owner, 2026-10-24: "same feedback as always ... the UI isn't
// clear enough for me to decide what to do"): no count (the home's list is the only one); what
// changes a value he has comes first; a Gardener question is its first sentence; and what the hub
// will save on its own (auto_decide source saves) isn't listed at all.
import { test, expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { git } from "../src/git";
import { loadState } from "../src/dashboard/data";
import { overview } from "../src/dashboard/html";
import { FILING_CODE } from "../src/filing";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

function brain() {
  const root = makeBrain();
  const f = join(root, "rules", "policy.yaml");
  const doc = YAML.parseDocument(readFileSync(f, "utf8").replace(/max_proposals_per_day: \d+/, "max_proposals_per_day: 100"));
  doc.setIn(["agents", "gardener", "label"], "Gardener");
  writeFileSync(f, doc.toString({ lineWidth: 0 }));
  writeFileSync(join(root, "rules", "escalation.yaml"), "auto_decide:\n  source_saves_per_day: 20\n");
  git(root, ["add", "-A"], "owner");
  git(root, ["commit", "-qm", "owner: setup"], "owner");
  const req = (agent: string, id: string, attribute: string, value: string, src: string) =>
    expect(write(root, { agent, id, attribute, value, as_of: "2026-10-07", sources: [src], verification: "verified-by-source" } as never).outcome).toBe("inbox");
  for (let i = 1; i <= 6; i++) req("helper", "projects/course-a", `meeting_${i}`, `Meeting ${i} with the TA about the grading rubric and the room booking for the final week`, `gmail:f0000000000001${String(i).padStart(2, "0")}`);
  req("helper", "projects/course-a", "next_step", "Book the exam room", "gmail:f000000000000201"); // changes a value he has
  // A Gardener question: reasoning first, then what it asks.
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "2026-10-08-gardener-q.yaml"), YAML.stringify({ proposed: "2026-10-08", by: "gardener", reason: "gardener is a trial agent: propose-only", request: { agent: "gardener", kind: "fact", id: "projects/course-a", attribute: "open_question", value: "Did the Oct 12 check-in happen? The booking note says two guests arrived Oct 12, but the Oct 15 mail still asks who they are. Robin to say which holds.", as_of: "2026-10-08", sources: ["agent:gardener"] } }));
  // Calendar facts the hub saves on its own: never asked on the home page.
  for (let i = 1; i <= 3; i++) writeFileSync(join(root, "inbox", `2026-10-08-capture-cal${i}.yaml`), YAML.stringify({ proposed: "2026-10-08", by: "hub", reason: "capture inbox/captures/x.md: a new fact", checks: ["capture"], capture: "inbox/captures/x.md", request: { agent: "hub", kind: "fact", id: "projects/course-b", attribute: `session_${i}`, value: `Oct ${10 + i}`, as_of: "2026-10-07", sources: [`gcal:evt1.cal${i}`], source_type: "gcal", confidence: "stated" } }));
  return root;
}

test("Settings lists what is still open, risky first, without a count, and leaves out what the hub saves itself", () => {
  const root = brain();
  const html = overview(loadState(root), "x").body;
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)![1];
  expect(text(h1)).not.toMatch(/to decide/);
  // Only what is open before the fold: no assistant switches or real-use bar.
  const fold = html.indexOf('<details class="more"');
  expect(html.slice(0, fold)).not.toContain("Revoke access");
  expect(html.slice(0, fold)).not.toContain("Real-use bar");
  // What the hub saves on its own is said once, not listed.
  expect(text(html)).toContain("3 facts from your captures and sources file on their own");
  expect(text(html)).not.toContain("Session 1");
  // The question first, then the update, then what only adds.
  const words = text(html);
  const q = words.indexOf("Did the Oct 12 check-in happen?"), upd = words.indexOf("Book the exam room"), add = words.indexOf("Meeting 1 with the TA");
  expect(q).toBeGreaterThan(-1);
  expect(upd).toBeGreaterThan(q);
  expect(add).toBeGreaterThan(upd);
  // An update is never cut off; it settles on its own screen (2026-10-27).
  expect(html).toContain(`<div class="fact">now <b>Book the exam room</b> <span class="was">(was Grade the midterm)</span></div>`);
  expect(html).toMatch(/href="\/settle\/p-[^"]+">Settle it</);
  expect(html).not.toContain("proposal-accept");
}, 60_000);

// Failed within the day under this code: an older failure, or other code's, is tried again (G404, G407).
test("a save that failed is listed on Settings, not hidden", () => {
  const root = brain();
  mkdirSync(join(root, "log"), { recursive: true });
  writeFileSync(join(root, "log", "auto-decisions-errors.jsonl"), JSON.stringify({ at: new Date().toISOString(), key: "proposal:2026-10-08-capture-cal2.yaml", error: "refused", code: FILING_CODE }) + "\n");
  const html = overview(loadState(root), "x").body;
  expect(text(html)).toContain("2 facts from your captures and sources file on their own");
  expect(html).toContain("Session 2");
}, 60_000);


