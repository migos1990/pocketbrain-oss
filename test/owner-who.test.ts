// SPDX-License-Identifier: AGPL-3.0-only
// The owner app's Who knows tab as cards (brief 2026-10-30, step 5), on the demo brain: your memory
// in numbers (pages, people, what it learned this week, the last backup), then one card per
// assistant: its letter, how often it read today, how many pages it sees (a link to See as), a
// trial assistant's badge, what its own memory has wrong with Fix, and what it asked folded away.
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { dashboardHandler } from "../src/dashboard/server";
import { APP_COPY } from "../src/dashboard/html-app";
import { esc } from "../src/dashboard/html-home";
import { ONLY_YOU } from "../src/dashboard/home";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const H = "127.0.0.1:8794";
async function who(o: { secret?: string[]; later?: number } = {}) {
  const { root } = await makeDemoBrain();
  for (const id of o.secret ?? []) { const f = join(root, `${id}.md`); writeFileSync(f, readFileSync(f, "utf8").replace(/^sensitivity: \w+$/m, "sensitivity: secret")); }
  const t = Date.parse(DEMO_NOW);
  let at = t;
  const d = dashboardHandler(root, { port: 8794, loginKey: "k".repeat(32), now: () => new Date(at) });
  const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  at = t + (o.later ?? 0) * 60_000;
  return (await d.handle(new Request(`http://${H}/who`, { headers: { host: H, cookie } }))).text();
}
const cards = (html: string) => [...html.matchAll(/<li class="agent">([\s\S]*?)<\/li><!--agent-->/g)].map((m) => m[1]!);

test("Who knows: your memory in numbers, then a card per assistant", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const w = await who();
    expect(w).toMatch(/<section class="numbers" aria-labelledby="mem">[\s\S]*<b>\d+<\/b><span>pages<\/span>[\s\S]*<b>\d+<\/b><span>people<\/span>[\s\S]*<b>\d+<\/b><span>learned this week<\/span>/);
    expect(w).toMatch(new RegExp(`${APP_COPY.backupNone}|Backed up `));
    expect(w).toContain('<a class="top-link" href="/overview">Settings</a>');
    const cs = cards(w);
    expect(cs).toHaveLength(3);
    const claude = cs.find((c) => c.includes("<b>Claude</b>"))!;
    expect(claude).toMatch(/<span class="av c\d" aria-hidden="true">Cl<\/span>/);
    expect(claude).toContain("Read your brain 6 times today");
    expect(claude).toMatch(/<a class="see" href="[^"]+">See as<\/a>/);
    expect(claude).toMatch(/Sees (\d+ pages|all your pages)/);
    expect(claude).toMatch(/<details><summary>What it asked today \(\d+\)<\/summary>/);
    const gemini = cs.find((c) => c.includes("<b>Gemini</b>"))!;
    expect(gemini).toContain(`<span class="badge">${APP_COPY.trial}</span>`);
    expect(gemini).toContain(APP_COPY.trialWhy);
    expect(gemini).toContain(esc(APP_COPY.readNot));
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("a page made secret after an assistant read it is named on Who knows only right after a sign-in (builder's audit, low)", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const secret = ["people/isabelle-roy", "people/ben-carter"];
    const lines = (html: string) => cards(html).join("\n");
    // Fresh: the owner may see the names, as on Memory.
    const fresh = lines(await who({ secret }));
    expect(fresh).toContain("Ben Carter");
    // Past 10 minutes: the lines stay, the secret pages' names don't.
    const stale = lines(await who({ secret, later: 11 }));
    expect(stale).not.toContain("Isabelle Roy");
    expect(stale).not.toContain("Ben Carter");
    expect(stale).not.toContain("isabelle-roy");
    expect(stale).not.toContain("ben-carter");
    expect(stale).toContain(`Pinecrest pilot, ${ONLY_YOU}`);
    expect(stale).toContain("Three-month Pinecrest pilot");
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("what an assistant typed shows on Who knows only right after a sign-in; later, the page it got (G545)", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const fresh = cards(await who()).join("\n");
    expect(fresh).toContain("asked about “Pinecrest pilot”");
    const stale = cards(await who({ later: 11 })).map((c) => c.slice(c.indexOf("<details>"))).join("\n");
    expect(stale).not.toMatch(/[“”]/);
    expect(stale).toContain("asked about Pinecrest pilot");
    expect(stale).not.toContain("Mom&#39;s move”");
  } finally { delete process.env.PB_NOW; }
}, 60_000);
