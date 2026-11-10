// SPDX-License-Identifier: AGPL-3.0-only
// Next-level move 1: the brain reads its own pages every night, so the owner is not the proofreader.
// 91 of 150 gaps were wording the owner found on his phone, each fixed by one more special case.
// One set of class rules runs over every page as the owner sees it; each rule is proven here by
// the bad sentence an old gap reported and a clean twin it must pass. Output is counts by rule and
// page kind, never a name, title or value; report-only, it notifies no one (G750).
import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";

const page = (o: { title?: string; kind?: string; chips?: string[]; prose?: string; refs?: string }) =>
  `<main class="wrap page"><header class="band"><div class="head"><div><h1>${o.title ?? "Maya Chen"}</h1>${o.kind ? `<p class="kind">${o.kind}</p>` : ""}</div></div>` +
  `<div class="chips">${(o.chips ?? []).map((c) => `<span class="chip">${c}</span>`).join("")}</div></header>` +
  `<div class="prose">${o.prose ?? ""}<h2>References</h2><ol class="b-refs">${o.refs ?? `<li id="fn-1"><span title="gmail:000000000000d005">Email, 10 Aug 2026</span></li>`}</ol></div></main>`;

// [rule, the bad page an old gap reported (made-up names), its clean twin]
const CASES: [string, string, string][] = [
  ["template-slot", page({ prose: "<p>Last met {day}, by the name on the invite.</p>" }), page({ prose: "<p>Last met 2 Oct, by the name on the invite.</p>" })],
  ["template-slot", page({ prose: "<p>Maya works at undefined.</p>" }), page({ prose: "<p>Maya works at Harbourline.</p>" })],
  // Phone checks 2026-10-26: a link shown with its brackets, raw footnote markers in a summary.
  ["raw-markup", page({ prose: "<p>Maya works at [[Town]].</p>" }), page({ prose: `<p>Maya works at <a href="/p/orgs/town">Town</a>.</p>` })],
  ["raw-markup", page({ prose: "<p>Maya leads design.[^1]</p>" }), page({ prose: `<p>Maya leads design.<sup><a href="#fn-1">1</a></sup></p>` })],
  // Mac check 2026-10-26: source ids in a page's own text.
  ["raw-markup", page({ prose: "<p>Maya declined the offer (Gmail 1a0b2c3d4e5f6a7b).</p>" }), page({ prose: "<p>Maya declined the offer.</p>" })],
  ["raw-markup", page({ prose: "<p>See notion: 0f1e2d3c4b5a69788796a5b4c3d2e1f0.</p>" }), page({ prose: "<p>See the planning notes.</p>" })],
  // A conflict's page in the demo brain: an id for a name and code quotes in a sentence.
  ["raw-markup", page({ title: "projects/atlas-launch#next_step", prose: "<p>Conflict on `projects/atlas-launch#next_step`.</p>" }), page({ title: "Atlas launch: what's next", prose: "<p>Two sources disagree about what's next.</p>" })],
  // Outside review v3 and a phone check, 2026-10-26: the writer's fallback sentence, an attribute's label read as English.
  ["label-sentence", page({ title: "Atelier for the kitchen", prose: "<p>The chose of Atelier for the kitchen is Atelier.</p>" }), page({ title: "Atelier for the kitchen", prose: "<p>You chose Atelier.</p>" })],
  ["label-sentence", page({ title: "Atlas beta scope", prose: "<p>On Atlas beta scope, the why: offline mode needs another month.</p>" }), page({ title: "Atlas beta scope", prose: "<p>Why: offline mode needs another month.</p>" })],
  ["label-sentence", page({ title: "Dana Ruiz", prose: "<p>Relationship of Dana Ruiz: sent Robin a request for feedback.</p>" }), page({ title: "Dana Ruiz", prose: "<p>Dana sent you a request for feedback.</p>" })],
  // Audit v13 (2026-11-09): a free-text value spliced into a template built for a short noun phrase.
  ["label-sentence", page({ title: "North College", prose: "<p>North College's what it is is A French-language university.</p>" }), page({ title: "North College", prose: "<p>North College is a French-language university.</p>" })],
  ["label-sentence", page({ title: "Sparkly", prose: "<p>Sparkly's kind is dating app.</p>" }), page({ title: "Sparkly", prose: "<p>Sparkly's city is Montréal.</p>" })],
  ["spliced-value", page({ title: "Atlas beta scope", prose: "<p>Atlas beta scope is Robin is done with the iOS builds for now.</p>" }), page({ title: "Atlas beta scope", prose: "<p>Atlas beta scope is settled.</p>" })],
  ["spliced-value", page({ prose: "<p>Maya works as Former colleague; collaborator on Atlas at Pinecrest Labs.</p>" }), page({ prose: "<p>Maya works as a designer at Pinecrest Labs; she joined in May.</p>".replace("; she joined in May", "") })],
  ["spliced-value", page({ prose: "<p>Due for Re: Fwd: Q4 offsite agenda (final v2): 2 Nov.</p>" }), page({ prose: "<p>The offsite agenda is due 2 Nov.</p>" })],
  ["spliced-value", page({ prose: "<p>Next for Atlas: can we move the review?.</p>" }), page({ prose: "<p>Next for Atlas: move the review.</p>" })],
  ["spliced-value", page({ prose: "<p>Mei Lin is the student, team lead for group A at Lakeshore College.</p>" }), page({ prose: "<p>Mei Lin is a student at Lakeshore College.</p>" })],
  ["template-slot", page({ prose: "<p>Billing migration is completed. Next for Billing migration: None: migration completed.</p>" }), page({ prose: "<p>Billing migration is completed.</p>" })],
  // A machine date in a sentence the hub wrote (the source's own words may keep theirs).
  ["machine-date", page({ prose: "<p>Decided on 2026-08-30 for the Kitchen renovation.</p>" }), page({ prose: "<p>Decided on 30 Aug 2026 for the Kitchen renovation.</p>", refs: `<li><details><summary>What the source said</summary><blockquote>met on 2026-10-07</blockquote></details></li>` })],
  // The same opener three times running reads as a list written as prose.
  ["repeated-opener", page({ prose: "<p>See also Atlas. See also Kenji Watanabe. See also Weekly review.</p>" }), page({ prose: "<p>See also Atlas, Kenji Watanabe and Weekly review.</p>" })],
  // Mac use-it check 2026-10-31: two lines say the same thing.
  ["said-twice", page({ prose: "<p>Maya works with you on Atlas.</p><p>Maya works with you on Atlas.</p>" }), page({ prose: "<p>Maya works with you on Atlas.</p><p>Maya leads design.</p>" })],
  // Louis 2026-10-31: the page's full name opens sentence after sentence.
  ["full-name-again", page({ prose: "<p>Maya Chen's role is design lead. Maya Chen works at Harbourline. Maya Chen works with you on Atlas.</p>" }), page({ prose: "<p>Maya Chen is design lead at Harbourline. Maya works with you on Atlas.</p>" })],
  // G729–G737: a chip that repeats the line under the name.
  ["chip-repeats", page({ kind: "design lead at Harbourline Software", chips: ["Harbourline Software"] }), page({ kind: "design lead at Harbourline Software", chips: ["Work"] })],
  ["chip-repeats", page({ kind: "analyst at Option Voisins", chips: ["OV"] }), page({ kind: "analyst at Option Voisins", chips: ["Personal"] })],
  ["doubled", page({ prose: "<p>Maya works at Harbourline..</p>" }), page({ prose: "<p>Maya is still deciding…</p>" })],
  ["doubled", page({ prose: "<p>Maya leads the the design team.</p>" }), page({ prose: "<p>Maya leads the design team.</p>" })],
  ["doubled", page({ prose: "<p>Maya leads design , and research.</p>" }), page({ prose: "<p>Maya leads design, and research.</p>" })],
  // Mac use-it check 2026-10-31: a heading or a quote with nothing under it.
  ["empty-section", page({ prose: "<h2>Notes</h2><h2>Related</h2><p>Atlas.</p>" }), page({ prose: "<h2>Notes</h2><p>Atlas.</p>" })],
  ["empty-section", page({ refs: `<li><details><summary>What the source said</summary><blockquote> </blockquote></details></li>` }), page({ refs: `<li><details><summary>What the source said</summary><blockquote>Maya leads design.</blockquote></details></li>` })],
  ["no-source", page({ prose: "<p>Maya leads design. (No source given.)</p>" }), page({ prose: "<p>Maya leads design.</p>" })],
  // Use-it check 2026-10-31: a bare web address inside a sentence.
  ["bare-url", page({ prose: "<p>Harbourline's website is https://harbourline.example/about.</p>" }), page({ prose: `<p>Harbourline's website is <a href="https://harbourline.example/about">harbourline.example</a>.</p>` })],
  // A paragraph that stops mid-clause.
  ["cut-off", page({ prose: "<p>Maya is on Atlas launch with</p>" }), page({ prose: "<p>Maya is on Atlas launch with Kenji.</p>" })],
  ["cut-off", page({ prose: "<p>Maya leads design and,</p>" }), page({ prose: "<p>Maya leads design and research.</p>" })],
];

test("G750 each rule finds the sentence an old gap reported, and passes its clean twin", async () => {
  const { readPage, RULES } = await import("../src/proofread");
  for (const [rule, bad, good] of CASES) {
    expect({ rule, hits: readPage(bad).filter((h) => h === rule).length > 0 }).toEqual({ rule, hits: true });
    expect({ rule, clean: readPage(good) }).toEqual({ rule, clean: [] });
  }
  // About ten class rules, not one per gap.
  expect(RULES.length).toBeLessThanOrEqual(14);
  expect(new Set(CASES.map((c) => c[0]))).toEqual(new Set(RULES));
});

test("G750 the nightly read covers every page as the owner sees it, counts by rule and kind, and names nothing", async () => {
  const { proofread, readProofread } = await import("../src/proofread");
  const { readBeat } = await import("../src/heartbeat");
  const { root } = await makeDemoBrain();
  const before = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString();
  const r = proofread(root, new Date(DEMO_NOW));
  const { loadBrain } = await import("../src/brain");
  const notes = loadBrain(root).filter((n) => n.fm.type !== "hub");
  expect(r.pages).toBe(notes.length);
  // The writer no longer reads a label as English (G773), so the read finds none; the decision
  // pages' machine dates it still finds.
  expect(r.by_rule["label-sentence"] ?? 0).toBe(0);
  expect(r.by_kind.decision?.["machine-date"] ?? 0).toBeGreaterThan(0);
  expect(r.odd_pages).toBeGreaterThan(0);
  // Kept for the north star and doctor, and names nothing: no page id, title or value in the record.
  const kept = readFileSync(join(root, "log", "proofread.json"), "utf8");
  expect(readProofread(root)?.pages).toBe(r.pages);
  for (const n of notes) {
    expect(kept.includes(n.fm.id)).toBe(false);
    if (String(n.fm.title ?? "").length > 3) expect(kept.includes(String(n.fm.title))).toBe(false);
  }
  // Report-only: no commit, no card, no ask; a heartbeat says it ran.
  expect(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString()).toBe(before);
  expect(existsSync(join(root, "inbox", "proofread"))).toBe(false);
  expect(readBeat(root, "proofread")?.ok).toBe(true);
}, 120_000);

test("G750 the north star and the night pass carry the read, report-only", async () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "start.ts"), "utf8");
  expect(src).toMatch(/runJob\(root, "proofread"/);
  const { proofreadLine } = await import("../src/proofread");
  expect(proofreadLine({ at: DEMO_NOW, pages: 40, odd_pages: 3, by_rule: { "label-sentence": 4, doubled: 1 }, by_kind: {} }))
    .toBe("nightly read: 5 odd sentences on 3 of 40 pages (label-sentence 4, doubled 1) (reported, not in pass)");
  expect(proofreadLine({ at: DEMO_NOW, pages: 40, odd_pages: 0, by_rule: {}, by_kind: {} }))
    .toBe("nightly read: no odd sentence on 40 pages (reported, not in pass)");
});
