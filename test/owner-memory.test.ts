// SPDX-License-Identifier: AGPL-3.0-only
// The owner app's Memory tab as the wiki (brief 2026-10-30, step 3), on the demo brain: how much the
// memory holds, kinds as tinted tiles with their counts, a search, and the pages that changed this
// week, each with its area, what changed in attribute words (never a value), where from and the day.
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { dashboardHandler } from "../src/dashboard/server";
import { loadBrain } from "../src/brain";
import { APP_COPY } from "../src/dashboard/html-app";

const H = "127.0.0.1:8796";
async function setup() {
  const { root } = await makeDemoBrain();
  let t = Date.parse(DEMO_NOW);
  const d = dashboardHandler(root, { port: 8796, loginKey: "k".repeat(32), now: () => new Date(t) });
  const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const get = async (path: string) => (await d.handle(new Request(`http://${H}${path}`, { headers: { host: H, cookie } }))).text();
  return { root, get, later: (min: number) => { t += min * 60_000; } };
}
const rowsOf = (html: string) => [...html.matchAll(/<li class="changed"><a href="\/p\/([^"]+)">([\s\S]*?)<\/a><\/li>/g)].map((m) => ({ id: m[1]!, html: m[2]! }));
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

test("Memory: how much it holds, kinds as tiles in the areas' tints, and five changed pages with All changes", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { get } = await setup();
    const m = await get("/memory");
    expect(m).toMatch(/<p class="day">\d+ pages · \d+ people<\/p>/);
    expect(m).toContain(`placeholder="${APP_COPY.searchHint}"`);
    expect(m).toMatch(/<a class="tile t-work" href="\/memory\?kind=people">/);
    expect(m).toMatch(/<a class="tile t-personal" href="\/memory\?kind=projects">/);
    expect(m).toMatch(/<a class="tile t-teaching" href="\/memory\?kind=orgs">/);
    // The other kinds share the fourth tile, one link each.
    expect(m).toMatch(/<div class="tile rest">[\s\S]*href="\/memory\?kind=money"[\s\S]*href="\/memory\?kind=decisions"[\s\S]*?<\/div>/);
    expect(m).toContain(`<h2>${APP_COPY.changedPages}</h2>`);
    const rows = rowsOf(m);
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.html).toMatch(/<span class="dot (a-work|a-teaching|a-personal|a-none)" aria-hidden="true"><\/span>/);
      expect(text(r.html)).toMatch(/· (you said|from an email|from calendar|from your \w+).* (today|Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/);
    }
    expect(m).toContain(`<a class="more" href="/memory?changes=week">${APP_COPY.allChanges}</a>`);
    expect(rowsOf(await get("/memory?changes=week")).length).toBeGreaterThan(5);
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("a changed page says what changed in attribute words, never a value, and a private or held one says only something new", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root, get } = await setup();
    const rows = rowsOf(await get("/memory?changes=week"));
    const notes = new Map(loadBrain(root).map((n) => [n.fm.id, n]));
    const values = (id: string) => JSON.stringify(notes.get(id)?.fm.facts ?? {}).match(/"value":"([^"]{5,})"/g)?.map((v) => v.slice(9, -1)) ?? [];
    for (const r of rows) for (const v of values(r.id)) expect(text(r.html)).not.toContain(v);
    // Hélène's private value waits for Read it: her row names nothing about it.
    const helene = rows.find((r) => r.id === "people/helene-lefebvre")!;
    expect(text(helene.html)).toContain(APP_COPY.somethingNew);
  } finally { delete process.env.PB_NOW; }
}, 60_000);
