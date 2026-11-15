// SPDX-License-Identifier: AGPL-3.0-only
// Odd lines found recording the identity demo on the demo brain (2026-11-15). One total for one
// memory on every screen (G888); the memory exam says what it counted, in words, when it counted
// nothing (G889); a comma sits against its word in a table and on the memory-fix card (G901).
import { test, expect, afterAll } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { loadState } from "../src/dashboard/data";
import { agentPage, overview } from "../src/dashboard/html";
import { seeList } from "../src/dashboard/see";
import { browsable } from "../src/dashboard/browse";
import { assistantViews } from "../src/dashboard/home-beliefs";
import { previewNewAgent, addAgent } from "../src/addagent";
import { propose } from "../src/consent";
import { serveDashboard } from "../src/dashboard/server";
import { askToSee } from "../src/asks";
import { git } from "../src/git";

let browser: any;
try { browser = await (await import("playwright")).chromium.launch(); } catch { browser = undefined; }
const run = browser ? test : test.skip;
afterAll(async () => { await browser?.close(); });

test("one memory has one total: the review page, the assistant's page, See as and Who knows agree", async () => {
  const { root } = await makeDemoBrain();
  const s = loadState(root);
  // A conflict packet is the memory's own bookkeeping, never a page.
  const packets = s.notes.filter((n) => n.fm.id.startsWith("disputes/")).length;
  expect(packets).toBeGreaterThan(0);
  const pages = browsable(s).length;
  expect(pages).toBe(s.notes.length - packets);
  expect(previewNewAgent(root, { agent: "notebook", slices: ["area:work"] }).total).toBe(pages);
  expect(agentPage(s, "c", "gemini")!.body).toContain(` of ${pages}</b> notes`);
  expect(seeList(s, "gemini")!.of).toBe(pages);
  for (const v of assistantViews(root, s.rules, s.notes)) expect(v.of).toBe(pages);
  expect((await propose(root, "gemini", "my work projects")).total).toBe(pages);
}, 60000);

test("the memory exam says in words what it has not seen yet, and counts an ask to see as one", async () => {
  const { root } = await makeDemoBrain();
  appendFileSync(join(root, "rules", "policy.yaml"), "\nask_to_see: true\n");
  git(root, ["commit", "-qam", "ask to see on"]);
  addAgent(root, { agent: "notebook", slices: ["area:work"] });
  await askToSee(root, "notebook", { what: "Mom's move in December", why: "plan the week" });
  const body = agentPage(loadState(root), "c", "notebook")!.body;
  const exam = body.slice(body.indexOf('id="exam"'), body.indexOf("</dl>", body.indexOf('id="exam"')));
  expect(exam).not.toContain("n/a");
  expect(exam).not.toContain("0 of 0");
  expect(exam).toContain("<dt>Read before writing</dt><dd>no writes yet</dd>");
  expect(exam).toContain("<dt>Memory in sync</dt><dd>not asked yet</dd>");
  expect(exam).toContain("<dt>Asked you to see a page</dt><dd>1 time</dd>");
  expect(exam).toContain("<dt>Reads refused</dt><dd>0 for pages outside its view, 0 leak alerts</dd>");
}, 60000);

test("the memory-fix card puts no space before its semicolon", async () => {
  const { root } = await makeDemoBrain();
  const s = loadState(root);
  s.memsync.push({ id: "c1", agent: "gemini", key: "people/isabelle-roy#role", kind: "fix", about: "Isabelle Roy: role", wrong: "designer", right: "engineer", state: "proposed", at: s.now.toISOString(), from: {} } as never);
  const body = overview(s, "c").body.replace(/<[^>]+>/g, "");
  expect(body).toContain("for Isabelle Roy: role; your brain says engineer.");
  expect(body).not.toMatch(/ [;,.] /);
}, 60000);

run("a comma in a table cell is as wide as a comma anywhere else", async () => {
  const { root } = await makeDemoBrain();
  const d = serveDashboard(root, { port: 0 });
  try {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" })).newPage();
    await page.goto(d.loginUrl);
    await page.goto(new URL("/agent/gemini", page.url()).href);
    await page.evaluate("document.fonts.ready");
    // The same cell, with and without what the stylesheet sets for figures.
    const w = await page.evaluate(`(() => {
      const td = document.querySelector("td:not(.num)");
      const width = (plain) => { const s = document.createElement("span"); s.textContent = ","; if (plain) s.style.fontVariantNumeric = "normal"; td.appendChild(s); const w = s.getBoundingClientRect().width; s.remove(); return w; };
      return { cell: width(false), text: width(true) };
    })()`);
    expect(w.cell).toBe(w.text);
  } finally { d.server.stop(true); }
}, 60000);
