// SPDX-License-Identifier: AGPL-3.0-only
// A change to approve reads as one plain question: where it came from, what it says, and what each
// button does. No code words (rule:..., "trial agent"), no paragraph in bold (owner, 2026-10-19).
import { test, expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { putQuote } from "../src/quotes";
import { loadState } from "../src/dashboard/data";
import { overview, layout } from "../src/dashboard/html";

const page = (root: string) => layout({ root }, overview(loadState(root), "x"));
const text = (html: string) => html.replace(/<[^>]+>/g, "");
// The whole card holding `has`, its fold included.
const card = (html: string, has: string) => { const at = html.lastIndexOf('<div class="item', html.indexOf(has)); return html.slice(at, html.indexOf('<div class="item', at + 10) >>> 0); };

function labelled(root: string) {
  const file = join(root, "rules", "policy.yaml");
  const doc = YAML.parseDocument(readFileSync(file, "utf8"));
  doc.setIn(["agents", "gardener", "label"], "Gardener");
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
}

test("a fact pulled from an email asks one question, shows its words, and says what each button does", () => {
  const root = makeBrain();
  mkdirSync(join(root, "inbox"), { recursive: true });
  const rel = "2026-10-08-capture-aaaa1111.yaml";
  writeFileSync(join(root, "inbox", rel), YAML.stringify({ proposed: "2026-10-08", by: "hub", reason: "capture inbox/captures/2026-10-08-abc.md: a new fact", checks: ["capture"], capture: "inbox/captures/2026-10-08-abc.md", request: { agent: "hub", kind: "fact", id: "projects/course-a", attribute: "room", value: "B-204", as_of: "2026-10-07", sources: ["gmail:f000000000000005"], source_type: "gmail", confidence: "stated" } }));
  putQuote(root, `inbox/${rel}`, "the class moves to room B-204 from next week");
  // Asked as what keeping it does, the fact before the answers (owner's phone, 2026-10-25).
  const c = card(page(root), "from an email");
  expect(text(c)).toContain("Remember this about Course A?");
  expect(text(c)).toContain("For Course A, from an email, Oct 7");
  expect(text(c)).toContain("Room: B-204");
  expect(c).not.toContain("<b>B-204</b>");
  expect(c).toContain("the class moves to room B-204 from next week");
  // Nothing plans it, so the home counts it and it is asked here with its two taps, below the fact
  // (G705: "Waits for your own word" left the owner nowhere to go).
  expect(c.indexOf("Room: B-204")).toBeLessThan(c.indexOf("proposal-accept"));
  expect(text(c)).toContain("Yes, remember it");
  expect(text(c)).toContain("No, skip it");
  expect(c).not.toContain("capture inbox/");
});

test("a change to a fact asks to update it and names what each answer keeps", () => {
  const root = makeBrain();
  const w = write(root, { agent: "helper", id: "projects/course-a", attribute: "next_step", value: "Book the room", as_of: "2026-03-09", sources: ["gmail:f000000000000005"], verification: "verified-by-source" });
  expect(w.outcome).toBe("inbox");
  const html = page(root);
  expect(text(html)).toContain("Update Course A: next step?");
  // A contradiction settles on its own screen; Settings only links there (2026-10-27).
  expect(html).toMatch(/<a class="btn" href="\/settle\/p-[^"]+">Settle it<\/a>/);
  expect(html).not.toContain("proposal-accept");
  expect(html).not.toContain("only proposes. Approve to apply.");
  expect(html).not.toContain(">Approve</button>");
});

test("the Gardener's open question reads in plain words, without rule ids or the owner named in the third person", () => {
  const root = makeBrain();
  labelled(root);
  mkdirSync(join(root, "inbox"), { recursive: true });
  const words = "Conflict: the note says no board documents are kept, but a 2026-10-04 update adds Drive indexes of board files. rule:never-store bars board content. Robin to say which holds.";
  writeFileSync(join(root, "inbox", "2026-10-08-gardener-q.yaml"), YAML.stringify({ proposed: "2026-10-08", by: "gardener", reason: "gardener is a trial agent: propose-only", request: { agent: "gardener", kind: "fact", id: "projects/course-a", attribute: "open_question", value: words, as_of: "2026-10-08", sources: ["agent:gardener"] } }));
  const c = card(page(root), "From your assistant <span");
  expect(text(c)).toContain("Add this open question to Course A?");
  expect(c).not.toContain("rule:never-store");
  expect(c).toContain("Your never store rule");
  expect(c).toContain("You say which holds.");
  expect(c).not.toContain("<b>Conflict");
  expect(c).toMatch(/Files on |Expires unconfirmed on |Set aside on the next tick|Waits for your own word/);
  // The title is what it asks, never its reasoning (owner, 2026-10-24).
  expect(c).toMatch(/class="ct">Which holds\?/);
});
