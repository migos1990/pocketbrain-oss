// SPDX-License-Identifier: AGPL-3.0-only
// The home page on a real-shaped brain (owner, 2026-10-24: "ui still sucks", a screenshot of "42 to
// decide", an assistant's refusal printed at the top, and a Gardener question titled with its
// reasoning). The home's list is the only count (Settings has none); a refused save says what happened in the owner's words, never the text written
// for the assistant; a Gardener question's title is the question, its reasoning one tap away.
import { test, expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { git } from "../src/git";
import { loadState } from "../src/dashboard/data";
import { asked } from "./asked";
import { overview } from "../src/dashboard/html";
import { runAction } from "../src/dashboard/actions";
import { refusalWords, questionWords } from "../src/dashboard/labels";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
// The Gardener's own words, as it writes them on the owner's brain: reasoning first, the ask last
// and not as a question.
const GARDENER = [
  "The Oct 12 arrival has passed, but this item is still active, with no note of how it went. Robin to confirm check-in happened so it can close.",
  "The exam room was booked for Oct 20 and that date is gone; the booking note still reads as upcoming. Robin to say whether it moved.",
  "Two notes give different TA names for the same course, and neither cites a newer source.",
];

function brain() {
  const root = makeBrain();
  const f = join(root, "rules", "policy.yaml");
  const doc = YAML.parseDocument(readFileSync(f, "utf8").replace(/max_proposals_per_day: \d+/, "max_proposals_per_day: 200"));
  doc.setIn(["agents", "gardener", "label"], "Gardener");
  writeFileSync(f, doc.toString({ lineWidth: 0 }));
  writeFileSync(join(root, "rules", "escalation.yaml"), "auto_decide:\n  source_saves_per_day: 20\n  hold_assistants_until: 2026-10-30\n");
  git(root, ["commit", "-qam", "owner: setup"], "owner");
  mkdirSync(join(root, "inbox"), { recursive: true });
  const yaml = (name: string, body: unknown) => writeFileSync(join(root, "inbox", name), YAML.stringify(body));
  // Many Gardener open questions.
  for (let i = 0; i < 14; i++)
    yaml(`2026-10-08-gardener-q${i}.yaml`, { proposed: "2026-10-08", by: "gardener", reason: "gardener is a trial agent: propose-only", request: { agent: "gardener", kind: "fact", id: i % 2 ? "projects/course-a" : "projects/course-b", attribute: "open_question", value: `${GARDENER[i % 3]} (${i})`, as_of: "2026-10-08", sources: ["agent:gardener"] } });
  // An assistant's facts, one by one and in a group.
  for (let i = 1; i <= 8; i++)
    expect(write(root, { agent: "helper", id: "projects/course-a", attribute: `meeting_${i}`, value: `Meeting ${i} with the TA`, as_of: "2026-10-07", sources: [`gmail:f0000000000001${String(i).padStart(2, "0")}`], verification: "verified-by-source" } as never).outcome).toBe("inbox");
  // Mail facts the hub saves on its own, past the day's cap too.
  for (let i = 1; i <= 24; i++)
    yaml(`2026-10-08-capture-m${i}.yaml`, { proposed: "2026-10-08", by: "hub", reason: "capture inbox/captures/x.md: a new fact", checks: ["capture"], capture: "inbox/captures/x.md", request: { agent: "hub", kind: "fact", id: "projects/course-b", attribute: `session_${i}`, value: `Oct ${i}`, as_of: "2026-10-07", sources: [`gmail:f0000000000003${String(i).padStart(2, "0")}`], source_type: "gmail", confidence: "stated" } });
  // More assistants' facts, each its own group: more than one day's cards.
  for (const agent of ["planner", "steward", "claude"])
    for (let i = 1; i <= 3; i++)
      yaml(`2026-10-08-${agent}-${i}.yaml`, { proposed: "2026-10-08", by: agent, reason: `${agent} is a trial agent: propose-only`, request: { agent, kind: "fact", id: "projects/course-b", attribute: `${agent}_note_${i}`, value: `Note ${i}`, as_of: "2026-10-07", sources: [`gmail:f00000000000050${i}`], verification: "verified-by-source" } });
  // A proposal whose date is after today: saving it is refused by the write checks.
  // A proposal for a note that no longer exists: saving it is refused by the write checks.
  yaml("2026-10-08-helper-gone.yaml", { proposed: "2026-10-08", by: "helper", reason: "area projects is owned by planner (own_area)", request: { agent: "helper", kind: "fact", id: "projects/gone", attribute: "due", value: "Nov 3", as_of: "2026-10-07", sources: ["gmail:f000000000000402"], verification: "verified-by-source" } });
  yaml("2026-10-08-helper-future.yaml", { proposed: "2026-10-08", by: "helper", reason: "area projects is owned by planner (own_area)", request: { agent: "helper", kind: "fact", id: "projects/course-a", attribute: "due", value: "Nov 3", as_of: "2099-01-01", sources: ["gmail:f000000000000401"], verification: "verified-by-source" } });
  return root;
}

test("Settings lists what is open without a count, and says what files itself", () => {
  const root = brain();
  // During the hold on core assistants' own proposals (the hold_assistants_until the brain pins in rules/escalation.yaml): from its
  // day the planner's and steward's proposals file too, and the count below grows by them.
  const was = process.env.PB_NOW;
  process.env.PB_NOW = "2026-10-28T15:00:00Z";
  let s: ReturnType<typeof loadState>;
  try { s = loadState(root); } finally { if (was === undefined) delete process.env.PB_NOW; else process.env.PB_NOW = was; }
  const html = overview(s, "x").body;
  const h1 = text(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)![1]).trim();
  expect(h1).not.toMatch(/to decide/);
  expect(asked(root, s.now).length).toBeGreaterThan(0);
  expect(html).toContain('<h2 id="needs">Still open');
  // What the hub saves on its own is counted, not listed.
  expect(text(html)).toMatch(/24 facts from your captures and sources file on their own/);
}, 120_000);

test("a Gardener question's title is the question; its reasoning stays folded", () => {
  expect(questionWords(GARDENER[0])).toBe("Confirm check-in happened so it can close?");
  expect(questionWords(GARDENER[1])).toBe("It moved?");
  expect(questionWords("Robin to say which holds.")).toBe("Which holds?");
  expect(questionWords("Did the Oct 12 check-in happen? The booking note says so.")).toBe("Did the Oct 12 check-in happen?");
  expect(questionWords(GARDENER[2])).toBeUndefined();

  const root = brain();
  const html = overview(loadState(root), "x").body;
  const words = text(html);
  // Never a Gardener sentence as a title, anywhere on the page.
  expect(html).not.toMatch(/class="ct">The Oct 12 arrival has passed/);
  expect(words).toContain("Confirm check-in happened so it can close?");
  // "Why it asks" is folded.
  expect(html).not.toMatch(/<details open><summary>Why it asks/);
}, 120_000);

test("a refused save is said in the owner's words, never the text written for the assistant", () => {
  const root = brain();
  let msg = "";
  // A future date is no refusal for the owner (G383, test/accept-future.test.ts); a note gone is.
  try { runAction({ root }, "proposal-accept", { file: "2026-10-08-helper-gone.yaml" }); } catch (e) { msg = (e as Error).message; }
  expect(msg).not.toBe("");
  expect(msg).not.toMatch(/as_of|send it again|Fix:|due, next_step|give title|pathspec|git/);
  expect(msg).toMatch(/^Not saved/);
  // Any write refusal that still reaches a page is turned into owner words.
  const raw = "as_of_not_future: as_of 2026-10-25 is after today, 2026-10-24, on the brain's clock. Fix: as_of is when it became true, 2026-10-24 at the latest: send it again with that date, and put future dates in the value (due, next_step)";
  expect(refusalWords(raw)).not.toMatch(/as_of|send it again|Fix:/);
  expect(refusalWords(raw)).toMatch(/^Not saved/);
  expect(refusalWords("Saved all 3.")).toBe("Saved all 3.");
}, 120_000);

// The owner's framing (2026-10-24): one portable memory of himself for many assistants, so the
// home page says what the memory is before what it asks.
test("the home page opens with the memory itself: its facts, what changed, and how far to trust it", () => {
  const root = brain();
  const s = loadState(root);
  const html = overview(s, "x").body;
  const facts = s.notes.reduce((n, x) => n + Object.keys(x.fm.facts ?? {}).length, 0);
  const lede = text(html.slice(html.indexOf("</h1>"), html.indexOf('<div class="card">')));
  expect(lede.replace(" :", ":")).toContain(`Your memory: ${facts} facts, `);
  expect(lede).toMatch(/\d+ changed this week\. (Nothing needs a look|\d+ needs? a look)\./);
  expect(html).not.toContain('href="/spot"');
  expect(html).toContain('href="/brain"');
}, 120_000);

test("a suggestion says it's from one of your assistants", () => {
  const root = brain();
  const words = text(overview(loadState(root), "x").body);
  expect(words).toMatch(/From your assistant (Gardener|helper|planner|steward|claude)/);
  expect(words).not.toMatch(/From (Gardener|helper|planner|steward|claude)\b/);
}, 120_000);

// The owner's page says "assistant", never "agent" (live page 2026-10-24: "the agent's word" 8 times).
test("no plain label on an owner page says agent", async () => {
  const { plain } = await import("../src/dashboard/labels");
  for (const code of ["self-reported", "injection_shapes", "no_agent_in_ids", "agent_status", "relay"]) expect(plain(code)).not.toMatch(/\bagents?\b/i);
  expect(plain("self-reported")).toBe("an assistant said so");
});
