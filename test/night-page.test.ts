// SPDX-License-Identifier: AGPL-3.0-only
// While you slept (`/night`, owner's ask of 2026-11-14): the morning page is the diary's rows of
// the owner's night, as the home says them and with the home's Undo; never what the owner did
// themselves, never a row outside the night; a private value says only that something is new; a
// quiet night says so; a fact taken back overnight is under Tidied with its Undo; what it could
// not decide is the home's own conflicts, and the rest that waits is one counted link to the home.
import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { loadState } from "../src/dashboard/data";
import { nightView, nightPage, nightCount, nightOf, NIGHT_COPY } from "../src/dashboard/night";
import { homeWaiting } from "../src/dashboard/home";
import { write } from "../src/write";
import { retire } from "../src/core";
import { beat } from "../src/heartbeat";
import { DEMO_NOW } from "../scripts/demo-brain";

// The demo's morning is 2026-10-08 14:00Z, 10:00 in Toronto. Its night ran 23:00Z to 11:00Z.
const NIGHT = "2026-10-08T07:30:00Z", EVENING = "2026-10-07T22:30:00Z", MORNING = "2026-10-08T12:30:00Z";
const at = <T>(now: string, fn: () => T): T => { const was = process.env.PB_NOW; process.env.PB_NOW = now; try { return fn(); } finally { if (was === undefined) delete process.env.PB_NOW; else process.env.PB_NOW = was; } };
const fact = (root: string, agent: string, id: string, attribute: string, value: string, extra: Record<string, unknown> = {}) =>
  write(root, { agent, id, attribute, value, as_of: "2026-10-08", sources: [`agent:${agent}/2026-10-08`], verification: "self-reported", ...extra } as never);

test("the night is the owner's evening to morning, by the owner's clock", async () => {
  const { root } = await makeDemoBrain();
  const rules = loadState(root).rules, n = nightOf(rules, new Date(DEMO_NOW));
  expect(n.day).toBe("2026-10-08");
  expect(n.has("2026-10-07T23:00:00Z")).toBe(true);   // 19:00 the evening before
  expect(n.has("2026-10-07T22:59:00Z")).toBe(false);  // 18:59
  expect(n.has("2026-10-08T10:59:00Z")).toBe(true);   // 06:59
  expect(n.has("2026-10-08T11:00:00Z")).toBe(false);  // 07:00
  // Before the morning it is the night so far, and nothing after now.
  const early = nightOf(rules, new Date("2026-10-08T08:00:00Z"));
  expect(early.has("2026-10-08T07:00:00Z")).toBe(true);
  expect(early.has("2026-10-08T09:00:00Z")).toBe(false);
}, 60_000);

test("a quiet night says so in one line; what waits is the home's own list", async () => {
  try {
    process.env.PB_NOW = DEMO_NOW;
    const { root } = await makeDemoBrain();
    const s = loadState(root), now = new Date(DEMO_NOW);
    const v = nightView(root, s.rules, s.notes, now);
    expect(v.groups).toEqual([]);
    expect(nightCount(v)).toBe(0);
    expect(v.waiting.map((w) => w.what)).toEqual(homeWaiting(root, now).map((w) => w.what));
    const html = nightPage(v, "");
    expect(html).toContain(NIGHT_COPY.quiet);
    expect(html).toContain('href="/settle/c-0001"');
    expect(html).not.toContain('class="night-n"');
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("the page lists what the night changed, with Undo, and nothing the owner did or the day did", async () => {
  try {
    const { root } = await makeDemoBrain();
    at(EVENING, () => fact(root, "claude", "people/maya-chen", "prefers", "tea over coffee"));               // 18:30: the day before the night
    at(NIGHT, () => fact(root, "claude", "people/isabelle-roy", "prefers", "calls before nine"));           // 03:30: the night
    at(NIGHT, () => write(root, { agent: "claude", id: "people/aisha-rahman", attribute: "prefers", value: "walking meetings", as_of: "2026-10-08", sources: ["owner:2026-10-08/chat"], verification: "confirmed-by-owner" } as never, { owner: true }));
    at(MORNING, () => fact(root, "claude", "people/ben-carter", "prefers", "short agendas"));             // 08:30: the day
    beat(root, "night", { ok: true, ms: 11 * 60_000, now: new Date("2026-10-08T07:41:00Z") });
    process.env.PB_NOW = DEMO_NOW;
    const s = loadState(root), now = new Date(DEMO_NOW);
    const log = join(root, "log", "reads.jsonl"), before = existsSync(log) ? readFileSync(log, "utf8") : "";
    const v = nightView(root, s.rules, s.notes, now);
    const said = v.groups.flatMap((g) => g.lines.map((l) => l.what)).join("\n");
    expect(said).toContain("calls before nine");
    expect(said).not.toContain("tea over coffee");
    expect(said).not.toContain("walking meetings");
    expect(said).not.toContain("short agendas");
    expect(v.groups.map((g) => g.key)).toEqual(["learned"]);
    expect(v.counts.learned).toBe(1);
    expect(nightCount(v)).toBe(1);
    expect(v.ran).toEqual({ time: "3:41", took: "11 minutes" });
    const html = nightPage(v, "tok");
    expect(html).toContain("The night pass ran at 3:41 and took 11 minutes.");
    expect(html).toContain('action="/action/diary-undo"');
    expect(html).toContain(`<h2>${NIGHT_COPY.learned}</h2>`);
    expect(html).not.toContain(NIGHT_COPY.quiet);
    expect(html).toContain('<nav class="tabbar"');
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe(before);
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("a private value learned overnight says only that something is new", async () => {
  try {
    const { root } = await makeDemoBrain();
    at(NIGHT, () => fact(root, "claude", "people/isabelle-roy", "salary", "91,400 dollars a year"));
    process.env.PB_NOW = DEMO_NOW;
    const s = loadState(root);
    const html = nightPage(nightView(root, s.rules, s.notes, new Date(DEMO_NOW)), "");
    expect(html).not.toContain("91,400");
    expect(html).not.toContain("91400");
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("a fact taken back overnight is under Tidied; the tiles count what the page lists", async () => {
  try {
    const { root } = await makeDemoBrain();
    at("2026-10-07T12:00:00Z", () => write(root, { agent: "claude", id: "people/ben-carter", attribute: "nickname", value: "Benny", as_of: "2026-10-07", sources: ["agent:claude/2026-10-07"], verification: "self-reported" } as never));
    at(NIGHT, () => fact(root, "claude", "people/isabelle-roy", "prefers", "calls before nine"));
    expect(at(NIGHT, () => retire(root, "claude", { id: "people/ben-carter", attribute: "nickname", value: "Benny", as_of: "2026-10-08", sources: ["agent:claude/2026-10-08"] })).outcome).toBe("committed");
    process.env.PB_NOW = DEMO_NOW;
    const s = loadState(root), v = nightView(root, s.rules, s.notes, new Date(DEMO_NOW));
    expect(v.groups.map((g) => [g.key, g.lines.length])).toEqual([["learned", 1], ["tidied", 1]]);
    expect(v.counts).toEqual({ learned: 1, tidied: 1, waiting: 3 }); // the held private value is no ask (G907)
    expect(v.ran).toBeUndefined(); // no night pass on record: the page says nothing about one
    const html = nightPage(v, "tok");
    expect(html).toContain(`<h2>${NIGHT_COPY.tidied}</h2>`);
    expect(html).not.toContain('class="night-ran"');
    expect(html.match(/href="\/settle\//g)?.length).toBe(3);
    expect(html).not.toContain(NIGHT_COPY.elsewhereOne); // the three conflicts are all that waits (G907)
  } finally { delete process.env.PB_NOW; }
}, 60_000);
