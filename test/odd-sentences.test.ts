// SPDX-License-Identifier: AGPL-3.0-only
// Odd sentences the nightly read counted on real pages, by family, each reproduced on made-up
// pages (G1002): a question's page was its machine packet, a routine's chip said its assistant
// again, a date or a web address written into a page's text was shown as typed, and the deploy
// line said only the total. Every page here is invented.
import { test, expect, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { loadState } from "../src/dashboard/data";
import { ownerPage } from "../src/dashboard/html-page";
import { ownerKeepBoth } from "../src/core";
import { asPageRead, pageReadLine, pageReadOf, readPage, readPages, type PageRead } from "../src/proofread";

let root = "";
beforeAll(async () => { root = (await makeDemoBrain()).root; }, 120_000);
const now = new Date(DEMO_NOW);
const page = (id: string, fresh = true) => { const s = loadState(root, now); return ownerPage(s, "", s.notes.find((n) => n.fm.id === id)!, [], { fresh }); };
const words = (html: string) => html.replace(/<(style|script)[\s\S]*?<\/\1>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const note = (path: string, text: string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); };

test("a question's page is the question in words, never its packet", () => {
  const html = page("disputes/c-0001");
  expect(readPage(html)).toEqual([]);
  const t = words(html);
  expect(html).toMatch(/<h1>What(?:'|&#39;)s next for Atlas launch\?<\/h1>/);
  expect(t).not.toContain("projects/atlas-launch#next_step");
  expect(t).not.toMatch(/`|step 7|self-reported|confirmed-by-owner|\d{4}-\d{2}-\d{2}/);
  expect(t).toContain("freeze the beta build on 15 October");
  expect(t).toContain("freeze the beta build on 22 October");
  // It leads to the one screen that asks, and offers no box, edit or who-sees of its own.
  expect(html).toContain('href="/settle/c-0001"');
  expect(html).not.toContain('action="/say"');
  expect(html).not.toContain('action="/action/note-sensitivity"');
  expect(html).not.toContain("?edit=1");
});

test("a question's sides stay shut on the 30-day sign-in when they are private", () => {
  note("disputes/c-0901.md", `---\nid: disputes/c-0901\ntype: dispute\ntitle: people/maya-chen#salary\narea: work\nsensitivity: private\nstatus: open\nfact_key: people/maya-chen#salary\ncreated: 2026-10-07\nupdated: 2026-10-07\nby: hub\ncandidates:\n  - value: ninety-one thousand\n    as_of: 2026-10-06\n    sources: [gmail:00000000000a1]\n    by: capture\n  - value: ninety-four thousand\n    as_of: 2026-10-07\n    sources: [gmail:00000000000a2]\n    by: capture\n---\nConflict on \`people/maya-chen#salary\`.\n`);
  const shut = words(page("disputes/c-0901", false));
  expect(shut).not.toContain("ninety-one");
  expect(shut).not.toContain("ninety-four");
  expect(words(page("disputes/c-0901", true))).toContain("ninety-one thousand");
  expect(readPage(page("disputes/c-0901", false))).toEqual([]);
});

test("a settled question says so and no longer leads to the settle screen", () => {
  ownerKeepBoth(root, "c-0002");
  const html = page("disputes/c-0002");
  expect(readPage(html)).toEqual([]);
  expect(html).not.toContain('href="/settle/c-0002"');
  expect(words(html)).toContain("You kept both");
});

test("a chip never says again what the name or the line under it says", () => {
  note("agents/claude/morning-sweep.md", `---\nid: agents/claude/morning-sweep\ntype: capability\ntitle: Morning sweep\narea: claude\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: owner\n---\nSorts the night's mail before breakfast.\n`);
  const routine = page("agents/claude/morning-sweep");
  expect(routine).toMatch(/<p class="kind">Claude(?:'|&#39;)s routine/);
  expect(routine).not.toContain('class="chip"');
  expect(readPage(routine)).toEqual([]);
  note("notes/work-shoes.md", `---\nid: notes/work-shoes\ntype: note\ntitle: Work shoes to resole\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: owner\n---\nTwo pairs wait at the cobbler.\n`);
  expect(page("notes/work-shoes")).not.toContain('class="chip"');
  // A chip that says something new stays, and a word that only contains it doesn't count.
  note("notes/homework-club.md", `---\nid: notes/homework-club\ntype: note\ntitle: Homework club rota\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: owner\n---\nThursdays are covered until spring.\n`);
  const club = page("notes/homework-club");
  expect(club).toContain('<span class="chip">Work</span>');
  expect(readPage(club)).toEqual([]);
});

test("a date, a web address and leftover marks written into a page's text read as words", () => {
  note("notes/boiler.md", `---\nid: notes/boiler\ntype: note\ntitle: Boiler service\narea: personal\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: owner\n---\nThe engineer came on 2026-03-04 and again on 2025-11-20. The manual is at https://www.heat-and-flue.example/manuals/b40?page=2&lang=en. Keep the **pressure** near \`1.5\` bar.\n`);
  const html = page("notes/boiler");
  expect(readPage(html)).toEqual([]);
  const t = words(html);
  expect(t).toContain("came on 4 Mar and again on 20 Nov 2025.");
  expect(html).toContain('<a href="https://www.heat-and-flue.example/manuals/b40?page=2&amp;lang=en" rel="noopener noreferrer nofollow" target="_blank">heat-and-flue.example</a>.');
  expect(html).toContain("<strong>pressure</strong>");
  expect(t).toContain("near 1.5 bar");
  // A day inside a web address stays part of the address (code review of PR 246).
  note("notes/minutes.md", `---\nid: notes/minutes\ntype: note\ntitle: Committee minutes\narea: personal\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: owner\n---\nPosted at https://hall.example/minutes?d=2026-03-04#p_2026-03-05 after the 2026-03-04 sitting.\n`);
  const minutes = page("notes/minutes");
  expect(minutes).toContain('<a href="https://hall.example/minutes?d=2026-03-04#p_2026-03-05" rel="noopener noreferrer nofollow" target="_blank">hall.example</a> after the 4 Mar sitting.');
  // A page's name in a link and a source's own words are left as they are.
  expect(page("decisions/2026-08-30-kitchen-contractor")).toContain('href="/p/projects/kitchen-renovation"');
  expect(readPage(page("decisions/2026-08-30-kitchen-contractor"))).toEqual([]);
});

test("the deploy line says which rules and which kinds of page, and takes only names the code knows", () => {
  const { read, ms } = readPages(root, now);
  const r = pageReadOf(read, ms);
  expect(Object.values(r.by_kind).every((k) => Object.keys(k).length > 0)).toBe(true);
  const a: PageRead = { pages: 40, failed: 0, odd: 5, odd_pages: 4, by_rule: { doubled: 2, "machine-date": 3 }, by_kind: { project: { "machine-date": 3 }, org: { doubled: 2 } }, median_ms: 22, p95_ms: 60, max_ms: 90, slow: 0 };
  expect(pageReadLine(a)).toContain("by rule: machine-date 3, doubled 2; by kind of page: project 3 (machine-date 3), org 2 (doubled 2)");
  expect(pageReadLine(a, a)).toContain("by rule: machine-date 3, doubled 2; by kind of page: project 3 (machine-date 3), org 2 (doubled 2)");
  // A kind or a rule the code doesn't define is dropped: a brain's own word can't ride on the line.
  const odd = asPageRead({ ...a, by_kind: { project: { "machine-date": 3, "people/someone": 1 }, "a made-up kind": { doubled: 2 }, org: "words" } });
  expect(odd?.by_kind).toEqual({ project: { "machine-date": 3 } });
  // A reading printed by older code has no kinds, and is still a reading.
  const { by_kind: _k, ...old } = a;
  expect(asPageRead(old)?.by_kind).toEqual({});
  expect(pageReadLine(asPageRead(old)!)).not.toContain("by kind");
  // It reads every page of the demo brain, about five seconds on a slow machine: its own limit, not
  // bun's five-second default, which the pre-push hook's plain `bun test` runs under (G1020).
}, 60_000);
