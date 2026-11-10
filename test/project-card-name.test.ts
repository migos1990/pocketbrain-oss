// SPDX-License-Identifier: AGPL-3.0-only
// The card under a page's prose (what's next, and a conflict's way to Settle) sits on that page, so
// it never says the page's name again as a heading of its own (G782, screens review item 12).
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { loadState } from "../src/dashboard/data";
import { ownerPage, PAGE_COPY } from "../src/dashboard/html-page";
import { DEMO_NOW } from "../scripts/demo-brain";

test("G782 the page's card leads with what's next, not with the page's own name", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    const s = loadState(root);
    const html = ownerPage(s, "", s.notes.find((n) => n.fm.id === "projects/atlas-launch")!, []);
    const card = html.match(/<(a|div) class="project"[^>]*>([\s\S]*?)<\/\1>/)?.[2] ?? "";
    expect(card).toStartWith(`<span class="nm">${PAGE_COPY.next} `);
    expect(card).not.toContain(">Atlas launch<");
    expect(card).toContain(PAGE_COPY.disagree);
  } finally { delete process.env.PB_NOW; }
}, 30000);
