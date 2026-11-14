// SPDX-License-Identifier: AGPL-3.0-only
// See as in the owner app (plans/as-read-by.md, the owner's ask of 2026-11-14): one page as one
// assistant is given it. A row per fact, readable when that assistant's own carve holds it, one
// fixed bar when it doesn't; the count is the rows. A view of the carve, never new access: nothing
// is logged as a read, and a private value stays shut on the 30-day sign-in as on the page itself.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { loadState } from "../src/dashboard/data";
import { seeView, seePage, seeList, seeListPage, rowWords, SEE_COPY, type SeeRow } from "../src/dashboard/see";
import { carve, grantFor } from "../src/carve";
import { DEMO_NOW } from "../scripts/demo-brain";

const HELENE = "people/helene-lefebvre";
const state = async () => { process.env.PB_NOW = DEMO_NOW; const { root } = await makeDemoBrain(); return { root, s: loadState(root) }; };
const note = (s: ReturnType<typeof loadState>, id: string) => s.notes.find((n) => n.fm.id === id)!;

test("each assistant's rows on a page are what its own carve holds, and the count is the rows", async () => {
  try {
    const { s } = await state();
    const n = note(s, HELENE);
    const given = (agent: string) => { const v = seeView(s, agent, n, { fresh: true })!; expect(v.given).toBe(v.facts.filter((f) => f.given).length); expect(v.of).toBe(v.facts.length); return v; };
    const gemini = given("gemini"), claude = given("claude");
    // Gemini reads people outside work through contacts-basic: role and workplace only.
    expect(gemini.facts.filter((f) => f.given).map((f) => f.attr)).toEqual(["role"]);
    expect(gemini.of).toBe(7);
    expect(gemini.text).toBe("not");
    // Claude reads everything but the one fact kept to the owner alone.
    expect(claude.given).toBe(6);
    expect(claude.facts.find((f) => !f.given)?.attr).toBe("prefers");
    expect(claude.text).toBe("given");
    // The rows agree with the carve itself, fact by fact.
    for (const agent of ["claude", "chatgpt", "gemini"]) {
      const res = carve(s.notes, s.rules, grantFor(s.rules, agent), { flags: false });
      const vis = res.visible.get(HELENE), hidden = new Set(res.hiddenFacts.map((h) => h.key));
      for (const f of given(agent).facts) if (f.given) { expect(vis).toBeDefined(); expect(vis!.attributes === "all" || vis!.attributes.has(f.attr)).toBe(true); expect(hidden.has(`${HELENE}#${f.attr}`)).toBe(false); }
    }
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("a fact that is not given is one fixed bar: no value, and the same bar whatever is behind it", async () => {
  try {
    const { s } = await state();
    const html = seePage(s, "", "gemini", note(s, HELENE), { fresh: true })!;
    const asClaude = seePage(s, "", "claude", note(s, HELENE), { fresh: true })!;
    expect(asClaude).toContain("26 Jul");
    expect(asClaude).not.toContain("07-26");
    const bars = html.match(/<span class="bar"[^>]*><\/span>/g) ?? [];
    expect(bars.length).toBe(7); // six facts and the page's own words
    expect(new Set(bars).size).toBe(1);
    for (const kept of ["Robin's mother", "Montréal", "example.org", "07-26", "26 Jul", "hip surgery", "is moving to"]) expect(html).not.toContain(kept);
    expect(html).toContain("retired teacher");
    expect(html).toContain(`<p class="count see-count"><b>1 of 7</b>`);
    // The reader row: You goes back to the page, each assistant to its own cut, this one marked.
    expect(html).toContain(`<a href="/p/people/helene-lefebvre">${SEE_COPY.you}</a>`);
    expect(html).toContain(`<a href="/see/gemini/people/helene-lefebvre" aria-current="true">Gemini</a>`);
    expect(html).toContain(`<a href="/see/claude/people/helene-lefebvre">Claude</a>`);
    expect(html).toContain('<nav class="tabbar"');
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("a private value an assistant is given stays shut on the 30-day sign-in, as on the page", async () => {
  try {
    const { root, s0 } = await (async () => { const x = await state(); return { root: x.root, s0: x.s }; })();
    // Make one given fact private the way the owner's files would, then load again.
    const p = join(root, "people/helene-lefebvre.md");
    const text = readFileSync(p, "utf8");
    expect(text).toContain("  city:\n");
    writeFileSync(p, text.replace("  city:\n", "  city:\n    sensitivity: private\n"));
    Bun.spawnSync(["git", "commit", "-qam", "test: city is private"], { cwd: root });
    const s = loadState(root);
    expect(s0.notes.length).toBe(s.notes.length);
    const n = note(s, HELENE);
    const old = seePage(s, "", "claude", n, { fresh: false })!, fresh = seePage(s, "", "claude", n, { fresh: true })!;
    const stillGiven = seeView(s, "claude", n, { fresh: true })!.facts.find((f) => f.attr === "city")?.given;
    if (stillGiven) { expect(fresh).toContain("Montréal"); expect(old).toContain(SEE_COPY.shut); }
    expect(old).not.toContain("Montréal");
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("a page an assistant is not given says so with nothing from it; an unknown assistant gets no screen", async () => {
  try {
    const { s } = await state();
    const res = carve(s.notes, s.rules, grantFor(s.rules, "chatgpt"), { flags: false });
    const out = s.notes.find((n) => n.fm.id.startsWith("money/") && !res.visible.has(n.fm.id))!;
    const v = seeView(s, "chatgpt", out, { fresh: true })!;
    expect(v.state).toBe("not");
    expect(v.given).toBe(0);
    const html = seePage(s, "", "chatgpt", out, { fresh: true })!;
    expect(html).toContain(esc(SEE_COPY.notGiven.replace("{name}", "ChatGPT")));
    for (const f of Object.values(out.fm.facts ?? {})) { const val = (f as { value?: unknown }).value; if (typeof val === "string" && val.length > 3) expect(html).not.toContain(val); }
    expect(seeView(s, "nobody", out, { fresh: true })).toBeUndefined();
    expect(seePage(s, "", "nobody", out, { fresh: true })).toBeUndefined();
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("the assistant's whole memory: the pages given count is its carve, in part when a page is cut", async () => {
  try {
    const { s } = await state();
    for (const agent of ["claude", "chatgpt", "gemini"]) {
      const l = seeList(s, agent, { fresh: true })!;
      const res = carve(s.notes, s.rules, grantFor(s.rules, agent), { flags: false });
      const pages = l.kinds.flatMap((k) => k.pages);
      expect(l.of).toBe(pages.length);
      expect(l.given).toBe(pages.filter((p) => res.visible.has(p.id)).length);
      expect(pages.filter((p) => p.state !== "not").length).toBe(l.given);
    }
    const g = seeList(s, "gemini", { fresh: true })!;
    expect(g.given).toBeLessThan(g.of);
    expect(g.part).toBeGreaterThan(0);
    const html = seeListPage(s, "gemini", { fresh: true })!;
    expect(html).toContain(`<b>${g.given} of ${g.of}</b>`);
    expect(html).toContain('href="/see/gemini/people/helene-lefebvre"');
    expect(html).toContain('href="/who"');
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("looking as an assistant is not logged as its read", async () => {
  try {
    const { root, s } = await state();
    const log = join(root, "log/reads.jsonl"), before = existsSync(log) ? readFileSync(log, "utf8") : "";
    seePage(s, "", "gemini", note(s, HELENE), { fresh: true }); seeListPage(s, "gemini", { fresh: true });
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe(before);
  } finally { delete process.env.PB_NOW; }
}, 60_000);

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// Slice audit of this screen, 2026-11-14 (G803): the hub's own reader inside the wall has no read
// door, so there is no "what it is given" to show; the address answers like an unknown name.
test("an agent with no read door gets no See as screen", async () => {
  try {
    const { s } = await state();
    expect(s.rules.policy.agents.capture?.inside_wall).toBe(true);
    expect(seeList(s, "capture", { fresh: true })).toBeUndefined();
    expect(seeListPage(s, "capture", { fresh: true })).toBeUndefined();
    expect(seePage(s, "", "capture", note(s, HELENE), { fresh: true })).toBeUndefined();
  } finally { delete process.env.PB_NOW; }
}, 60_000);

// Slice audit (G805): a private page's own screen shows no fact count on the 30-day sign-in, so
// See as shows none either, on the page or on its row in the list.
test("a private page shows no fact counts until a fresh sign-in", async () => {
  try {
    const { s } = await state();
    const id = "money/kitchen-budget";
    const res = carve(s.notes, s.rules, grantFor(s.rules, "claude"), { flags: false });
    expect(res.visible.has(id)).toBe(true);
    const old = seePage(s, "", "claude", note(s, id), { fresh: false })!, fresh = seePage(s, "", "claude", note(s, id), { fresh: true })!;
    expect(fresh).toContain('class="count see-count"');
    expect(old).not.toContain('class="count see-count"');
    expect(old).toContain(esc(SEE_COPY.shutPage.replace("{name}", "Claude")));
    const row = (html: string) => html.match(/<li class="changed"><a href="\/see\/claude\/money\/kitchen-budget">.*?<\/li>/)![0];
    expect(row(seeListPage(s, "claude", { fresh: false })!)).not.toMatch(/\d/);
    expect(row(seeListPage(s, "claude", { fresh: true })!)).toMatch(/all of it|\d of \d facts/);
  } finally { delete process.env.PB_NOW; }
}, 60_000);

// Code review of PR 172: a typed address must not reach a page the list leaves out. A secret page
// has no See as screen until a fresh sign-in, and a conflict packet never has one.
test("a secret page and a conflict packet have no See as screen on the 30-day sign-in", async () => {
  try {
    const { root } = await state();
    const p = join(root, "people/helene-lefebvre.md");
    const text = readFileSync(p, "utf8");
    expect(text).toMatch(/^sensitivity: \w+$/m);
    writeFileSync(p, text.replace(/^sensitivity: \w+$/m, "sensitivity: secret"));
    Bun.spawnSync(["git", "commit", "-qam", "test: the page is secret"], { cwd: root });
    const s = loadState(root), n = note(s, HELENE);
    expect(n.fm.sensitivity).toBe("secret");
    expect(seePage(s, "", "claude", n, { fresh: false })).toBeUndefined();
    expect(seeView(s, "claude", n, { fresh: false })).toBeUndefined();
    expect(seePage(s, "", "claude", n, { fresh: true })).toContain("Hélène Lefebvre");
    const packet = s.notes.find((x) => x.fm.id.startsWith("disputes/"))!;
    expect(packet).toBeDefined();
    expect(seePage(s, "", "claude", packet, { fresh: true })).toBeUndefined();
  } finally { delete process.env.PB_NOW; }
}, 60_000);

// Code review of PR 172: a page given by its words and none of its facts is not "its name only".
test("a row says what the assistant gets: all, some facts, its words only, or its name only", () => {
  const row = (r: Partial<SeeRow>): SeeRow => ({ id: "x/y", title: "Y", state: "part", given: 0, of: 3, text: "not", closed: false, ...r });
  expect(rowWords(row({ state: "all", given: 3 }))).toBe(SEE_COPY.all);
  expect(rowWords(row({ given: 2 }))).toBe("2 of 3 facts");
  expect(rowWords(row({ text: "given" }))).toBe(SEE_COPY.wordsOnly);
  expect(rowWords(row({ text: "not" }))).toBe(SEE_COPY.nameOnly);
  expect(rowWords(row({ text: "none" }))).toBe(SEE_COPY.nameOnly);
  expect(rowWords(row({ given: 2, closed: true }))).toBe(SEE_COPY.partOf);
  expect(rowWords(row({ text: "given", closed: true }))).toBe(SEE_COPY.partOf);
});
