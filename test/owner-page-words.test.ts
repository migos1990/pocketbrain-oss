// SPDX-License-Identifier: AGPL-3.0-only
// The Mac's look at the live canvas, 2026-10-31, as the owner would see it: a page's heading ran
// into its first line; its references showed "What the source said" rows that read as labels with
// nothing under them; a page with a long title was cut to its first word in the box and in Who
// sees; Who knows named assistants in lowercase.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { dashboardHandler } from "../src/dashboard/server";
import { PAGE_COPY, PAGE_CSS } from "../src/dashboard/html-page";
import { esc } from "../src/dashboard/html-home";

const H = "127.0.0.1:8796";
async function setup(edit?: (root: string) => void) {
  const { root } = await makeDemoBrain();
  edit?.(root);
  const d = dashboardHandler(root, { port: 8796, loginKey: "k".repeat(32), now: () => new Date(DEMO_NOW) });
  const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  return { root, get: async (p: string) => (await d.handle(new Request(`http://${H}${p}`, { headers: { host: H, cookie } }))).text() };
}
const pinned = async <T>(f: () => Promise<T>) => { process.env.PB_NOW = DEMO_NOW; try { return await f(); } finally { delete process.env.PB_NOW; } };
const fill = (t: string, name: string) => t.replace("{name}", name);

test("a page's text keeps its paragraphs, its line breaks and its headings", () => pinned(async () => {
  const { get } = await setup((root) => {
    const p = join(root, "projects/atlas-launch.md");
    const [, fm, body] = readFileSync(p, "utf8").match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/)!;
    writeFileSync(p, `${fm}# Launch strategy\nNext: freeze the beta build.\nThen the press kit.\n\nA second paragraph.\n\n${body}`);
  });
  const prose = (await get("/p/projects/atlas-launch")).match(/<div class="prose">([\s\S]*?)<\/div>/)![1]!;
  expect(prose).toContain("<h2>Launch strategy</h2><p>Next: freeze the beta build.<br>Then the press kit.</p><p>A second paragraph.</p>");
  expect(prose).not.toMatch(/strategy\s*Next/);
}), 60_000);

test("a source's words fold under a reference that says it opens", () => pinned(async () => {
  const { get } = await setup();
  // Maya's page cites mail: the owner's own page cites only his own notes since G624.
  const page = await get("/p/people/maya-chen");
  expect(page).toContain('<details class="quote"><summary>');
  expect(page).not.toMatch(/<blockquote>\s*<\/blockquote>/);
  expect(PAGE_CSS).toMatch(/details\.quote summary::before\{content:"\+"/);
  expect(PAGE_CSS).toMatch(/details\.quote\[open\] summary::before\{content:"−"/);
}), 60_000);

test("a page's box and Who sees name a person by first name and anything else by its whole title", () => pinned(async () => {
  const { get } = await setup();
  const project = await get("/p/projects/atlas-launch");
  expect(project).toContain(`placeholder="${esc(fill(PAGE_COPY.box, "Atlas launch"))}"`);
  expect(project).toContain(`<b>${esc(fill(PAGE_COPY.whoName, "Atlas launch"))}</b>`);
  const person = await get("/p/people/maya-chen");
  expect(person).toContain(`placeholder="${esc(fill(PAGE_COPY.box, "Maya"))}"`);
  expect(person).toContain(`<b>${esc(fill(PAGE_COPY.whoName, "Maya"))}</b>`);
}), 60_000);

test("Who knows names each assistant as a name, never its lowercase id", () => pinned(async () => {
  // The owner's own policy names none of them (the Mac's brain): no label: lines.
  const { get } = await setup((root) => { const p = join(root, "rules/policy.yaml"); writeFileSync(p, readFileSync(p, "utf8").replace(/ label: [^,}]+,/g, "")); });
  const who = await get("/who");
  const names = [...who.matchAll(/<li class="agent">[\s\S]*?<div class="t"><b>([^<]+)<\/b>/g)].map((m) => m[1]!);
  expect(names.length).toBeGreaterThan(1);
  for (const n of names) expect(n).toMatch(/^\p{Lu}/u);
  expect(names).toContain("ChatGPT");
}), 60_000);
