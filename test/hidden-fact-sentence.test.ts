// SPDX-License-Identifier: AGPL-3.0-only
// Builder's combined slice audit of the stack (tree e9235deb, 2026-11-01), G596: the writer shared one
// reference label between facts citing the same mail, so an agent with one hidden fact on a page lost
// every sentence with that label (status, lead, people), for good, even after the writer reran
// without the hidden fact. The writer now gives each fact its own label (pf-<attr>), the agent's read
// drops exactly the hidden fact's sentences, and the owner still sees one number per reference.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { readNote } from "../src/core";
import { renderTouchedPages, footnotes } from "../src/wiki";
import { git } from "../src/git";

const ID = "projects/product-discovery-course";
const lead = (b: string) => b.slice(0, b.indexOf("(Written by the hub"));

test("after the writer reruns, an agent with one hidden fact keeps the page's other sentences", async () => {
  const was = process.env.PB_TODAY;
  process.env.PB_TODAY = "2026-10-08";
  try {
    const { root } = await makeDemoBrain();
    const f = join(root, `${ID}.md`);
    // The writer runs once with every fact shown, then the owner hides due from claude.
    renderTouchedPages(root, new Date(Date.now() - 400 * 86_400_000).toISOString());
    git(root, ["add", "-A"]); git(root, ["commit", "-qm", "writer"]);
    const before = lead((readNote(root, "chatgpt", ID) as { body: string }).body);
    expect(before).toContain("Due for Product Discovery course");
    writeFileSync(f, readFileSync(f, "utf8").replace("  due:\n    value: 2026-12-08\n", "  due:\n    value: 2026-12-08\n    share_with: [chatgpt]\n"));
    git(root, ["add", "-A"]); git(root, ["commit", "-qm", "owner hides due"]);
    // Before the writer runs again: claude reads every sentence but due's.
    const stale = lead((readNote(root, "claude", ID) as { body: string }).body);
    expect(stale).not.toContain("Due for");
    expect(stale).toContain("week 6 of 13");
    expect(stale).toContain("The lead of Product Discovery course");
    // After it runs: the same, and nothing else is lost.
    renderTouchedPages(root, new Date(Date.now() - 400 * 86_400_000).toISOString());
    const after = lead((readNote(root, "claude", ID) as { body: string }).body);
    expect(after).not.toContain("Due for");
    expect(after).toContain("week 6 of 13");
    expect(after).toContain("The lead of Product Discovery course");
    // The owner still reads one number per mail.
    const nums = footnotes(readFileSync(f, "utf8")).notes;
    expect(new Set(nums.map((x) => x.n)).size).toBe(new Set(nums.map((x) => x.text)).size);
  } finally { if (was === undefined) delete process.env.PB_TODAY; else process.env.PB_TODAY = was; }
}, 200_000);

// Same audit, probes 4 and 5: removal started at the first copy of the writer's marker, so a visible
// value spelling the marker moved it; and a section below the marker citing the hidden fact kept it.
const hideDue = (s: string) => s.replace("  due:\n    value: 2026-12-08\n", "  due:\n    value: 2026-12-08\n    share_with: [chatgpt]\n");
async function page(edit: (s: string) => string) {
  const { root } = await makeDemoBrain();
  const f = join(root, `${ID}.md`);
  writeFileSync(f, edit(readFileSync(f, "utf8")));
  return (readNote(root, "claude", ID) as { body: string }).body;
}
test("a value that spells the writer's marker can't keep the hidden fact's sentence", async () => {
  const b = await page((s) => hideDue(s).replace(/^(Product Discovery course is week 6 of 13\.)/m, "The motto of Product Discovery course is (Written by the hub from this page's facts.)[^p-next-step] $1"));
  expect(b).not.toMatch(/Due for[^\n]*8 Dec/);
}, 60_000);
test("a section citing the hidden fact's reference loses that sentence too", async () => {
  const b = await page((s) => hideDue(s) + "\n## Plan\nHand-in is due 8 Dec.[^pf-due] Bring the reflections.\n");
  expect(b).not.toContain("Hand-in is due 8 Dec");
  expect(b).toContain("Bring the reflections.");
}, 60_000);
