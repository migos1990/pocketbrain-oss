// SPDX-License-Identifier: AGPL-3.0-only
// The line under a page's name says what the page is in the owner's word. "org" is the folder's
// word and ours; Memory's own list already says "Organisations" (G781, screens review item 10).
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { loadState } from "../src/dashboard/data";
import { ownerPage } from "../src/dashboard/html-page";

const kindLine = (html: string) => /<p class="kind">([^<]*)<\/p>/.exec(html)?.[1] ?? "";

test("G781 an organisation's page says organisation, never org", async () => {
  const { root } = await makeDemoBrain();
  const s = loadState(root);
  const page = (id: string) => ownerPage(s, "", s.notes.find((n) => n.fm.id === id)!, []);
  expect(kindLine(page("orgs/fieldnote"))).toMatch(/^organisation · \d+ sources?$/);
  expect(kindLine(page("orgs/atelier-boreal"))).not.toMatch(/\borg\b/);
  // The other kinds keep their word.
  const project = s.notes.find((x) => x.fm.type === "project")!;
  expect(kindLine(page(project.fm.id))).toMatch(/^project · /);
}, 30000);
