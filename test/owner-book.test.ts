// SPDX-License-Identifier: AGPL-3.0-only
// The owner's own page reads like the first page of a book about them (Louis, 2026-11-03;
// plans/owner-page-wiki.md): under its prose, what's new, what they are on right now, who matters
// to them and what waits on them, every page a link. Owner-only, on the owner's own page only; a
// private page's title shows only right after a sign-in (invariant 16), and what waits is the
// home's own count (count rule v2).
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { loadState } from "../src/dashboard/data";
import { ownerPage, PAGE_COPY } from "../src/dashboard/html-page";
import { waitingCount } from "../src/dashboard/home";
import { setStanding } from "../src/standing";
import { gitRun } from "../src/git";

const OWNER = "people/robin-lefebvre";
const section = (html: string, head: string) => {
  const i = html.indexOf(`>${head}</h2>`);
  if (i < 0) return "";
  const j = html.indexOf("<h2", i + 1);
  return html.slice(i, j < 0 ? undefined : j);
};
const page = (root: string, id: string, fresh = false) => { const s = loadState(root); return ownerPage(s, "t", s.notes.find((n) => n.fm.id === id)!, [], { fresh }); };

test("the owner's own page has what's new, right now, who matters and what waits, each a link", async () => {
  const { root } = await makeDemoBrain();
  setStanding(root, "people/helene-lefebvre", "inner");
  setStanding(root, "people/maya-chen", "close");
  const html = page(root, OWNER);
  const news = section(html, PAGE_COPY.bookNew);
  expect(news).toMatch(/<li>.*href="\/p\/[^"]+"/);
  const now = section(html, PAGE_COPY.bookNow);
  expect(now).toContain('href="/p/projects/atlas-launch"');
  const matters = section(html, PAGE_COPY.bookMatters);
  expect(matters.indexOf('href="/p/people/helene-lefebvre"')).toBeGreaterThan(-1);
  expect(matters.indexOf('href="/p/people/helene-lefebvre"')).toBeLessThan(matters.indexOf('href="/p/people/maya-chen"'));
  const waits = section(html, PAGE_COPY.bookWaiting);
  const n = waitingCount(root);
  expect(n).toBeGreaterThan(0);
  expect(waits).toContain(`${n} things wait for you`);
  expect(waits).toContain('href="/home"');
  // Anyone else's page has none of it.
  const maya = page(root, "people/maya-chen");
  for (const h of [PAGE_COPY.bookNew, PAGE_COPY.bookNow, PAGE_COPY.bookMatters, PAGE_COPY.bookWaiting]) expect(maya).not.toContain(`>${h}</h2>`);
}, 60_000);

test("a private project or person is named on the owner's page only right after a sign-in", async () => {
  const { root } = await makeDemoBrain();
  setStanding(root, "people/maya-chen", "inner");
  for (const p of ["projects/atlas-launch.md", "people/maya-chen.md"]) {
    const f = join(root, p);
    writeFileSync(f, readFileSync(f, "utf8").replace(/^sensitivity: \w+$/m, "sensitivity: private"));
  }
  gitRun(root, ["add", "-A"]); gitRun(root, ["commit", "-qm", "owner: private"]);
  const shut = page(root, OWNER);
  expect(section(shut, PAGE_COPY.bookNow)).not.toContain("atlas-launch");
  expect(shut).not.toContain('href="/p/people/maya-chen"');
  const open = page(root, OWNER, true);
  expect(section(open, PAGE_COPY.bookNow)).toContain("atlas-launch");
  expect(section(open, PAGE_COPY.bookMatters)).toContain('href="/p/people/maya-chen"');
}, 60_000);
