// SPDX-License-Identifier: AGPL-3.0-only
// The owner app as Louis drew it (canvas "pocketBrain app, final direction"; Louis on the clip,
// 2026-10-31: "underwhelming"; he picked home, words and polish). On the demo brain: On your mind
// shows six cards at most, the ones worth acting on, without an Undo on each (what the owner just
// said keeps its own); its sentences use a person's first name and say where they came from as the
// canvas does; a conflict says its two values when they may show on the 30-day sign-in; Settle asks
// a short question and shows the part that differs big; the page's footnotes are small numbers;
// each assistant has its own colour; the typeface is served by the hub itself.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { dashboardHandler } from "../src/dashboard/server";
import { homeView, MIND_CAP } from "../src/dashboard/home";
import { loadRules } from "../src/rules";
import { loadBrain } from "../src/brain";
import { APP_COPY, moreWords } from "../src/dashboard/html-app";

const H = "127.0.0.1:8797";
async function setup(root?: string) {
  root ??= (await makeDemoBrain()).root;
  const d = dashboardHandler(root, { port: 8797, loginKey: "k".repeat(32), now: () => new Date(DEMO_NOW) });
  const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const res = (path: string) => d.handle(new Request(`http://${H}${path}`, { headers: { host: H, cookie } }));
  return { root, res, get: async (path: string) => (await res(path)).text() };
}
const cards = (html: string) => [...html.matchAll(/<ul class="mind">([\s\S]*?)<\/ul>/g)].flatMap((m) => m[1]!.match(/<li class="card[^"]*">[\s\S]*?<\/li>/g) ?? []); // every list on the face (G625: one per kind)
const pinned = async <T>(f: () => Promise<T>) => { process.env.PB_NOW = DEMO_NOW; try { return await f(); } finally { delete process.env.PB_NOW; } };

test("On your mind shows six cards at most, none of them a routine last-contact line, and no Undo but on what you just said", () => pinned(async () => {
  const { get } = await setup();
  const home = await get("/home");
  const face = cards(home);
  expect(MIND_CAP).toBe(6);
  expect(face.length).toBe(MIND_CAP);
  expect(home).toMatch(new RegExp(`<a class="more" href="/home\\?all=1">(\\d+ more on your mind|${APP_COPY.moreAll})</a>`));
  expect(home).not.toContain("last in touch");
  for (const c of face) if (!/class="card told"/.test(c)) expect(c).not.toContain("/action/diary-undo");
  for (const c of face) expect(c).not.toContain("was:");
  // Everything is still a tap away, with its Undo.
  const all = await get("/home?all=1");
  expect(cards(all).length).toBeGreaterThan(20);
  expect(all).toContain("/action/diary-undo");
  expect(all).toContain("last in touch");
}), 60_000);

test("a memory reads like the canvas: a first name, a full stop, and where it came from in words", () => pinned(async () => {
  const { root } = await makeDemoBrain();
  const v = homeView(root, loadRules(root), loadBrain(root), new Date(DEMO_NOW), { all: true });
  const lines = [...v.since, ...v.earlier.flatMap((d) => d.lines)];
  expect(lines.map((l) => l.what)).toContain("Antoine is head TA now, not teaching assistant.");
  expect(lines.map((l) => l.what)).toContain("Diego prefers long novels nobody else has read.");
  for (const l of lines) expect(l.what).toMatch(/[.?!”]$/);
  const said = lines.map((l) => l.said);
  expect(said.some((s) => /^From (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)'s email$/.test(s ?? ""))).toBe(true);
  expect(said.some((s) => /^From today's email$/.test(s ?? ""))).toBe(true);
}), 60_000);

test("a conflict on the home says its two values, the part they share once, and what disagrees", () => pinned(async () => {
  const { get } = await setup();
  const home = await get("/home");
  const atlas = cards(home).find((c) => c.includes("Atlas launch"))!;
  expect(atlas).toContain("Next for Atlas launch: freeze the beta build on 15 October. Or 22 October?");
  expect(atlas).toMatch(/Two (emails|sources) disagree/);
}), 60_000);

test("a conflict on a page made private says no value on the home, whatever the stored conflict says", () => pinned(async () => {
  const { root } = await makeDemoBrain();
  const p = join(root, "projects/atlas-launch.md");
  writeFileSync(p, readFileSync(p, "utf8").replace(/^sensitivity: .*$/m, "").replace(/^---\n/, "---\nsensitivity: private\n"));
  const { get } = await setup(root);
  const home = await get("/home");
  expect(home).not.toContain("15 October. Or");
  expect(home).toContain("Two sources disagree on what&#39;s next for Atlas launch");
}), 60_000);

test("Settle asks a short question and shows the part that differs big", () => pinned(async () => {
  const { get } = await setup();
  const home = await get("/home");
  const href = cards(home).find((c) => c.includes("Atlas launch"))!.match(/href="(\/settle\/[^"]+)"/)![1]!;
  const s = await get(href);
  expect(s).toContain("<h1>What&#39;s next for Atlas launch?</h1>");
  const big = [...s.matchAll(/<form class="pick( first)?"[^>]*>[\s\S]*?<b>([^<]+)<\/b>/g)].map((m) => m[2]);
  expect(big.sort()).toEqual(["15 October", "22 October"]);
  expect(s).toContain("freeze the beta build on 15 October");
}), 60_000);

test("a page's footnotes are small numbers, and a person's band says what they do", () => pinned(async () => {
  const { get } = await setup();
  const p = await get("/p/people/maya-chen");
  expect(p).not.toMatch(/<sup[^>]*>\[\d+\]/);
  expect(p).toMatch(/<sup[^>]*>(<a[^>]*>)?\d+(<\/a>)?<\/sup>/);
  expect(p).toMatch(/<p class="kind">design lead at Harbourline Software · Montréal<\/p>/);
}), 60_000);

test("each assistant has its own colour, the same on its marks and on Who knows", () => pinned(async () => {
  const { get } = await setup();
  const home = await get("/home?all=1");
  const who = await get("/who");
  const markClass = (short: string) => home.match(new RegExp(`<span class="mark (c\\d)" aria-hidden="true">${short}</span>`))?.[1];
  const avClass = (short: string) => who.match(new RegExp(`<span class="av (c\\d)"[^>]*>${short}</span>`))?.[1];
  const shorts = ["Ch", "Cl", "G"];
  const colours = shorts.map(markClass);
  expect(colours.every(Boolean)).toBe(true);
  expect(new Set(colours).size).toBe(3);
  expect(shorts.map(avClass)).toEqual(colours);
}), 60_000);

test("the typeface is the hub's own file, allowed by the page's policy", () => pinned(async () => {
  const { res, get } = await setup();
  const home = await res("/home");
  expect(home.headers.get("content-security-policy")).toContain("font-src 'self'");
  expect(await home.text()).toContain("url(/font/schibsted-grotesk.woff2)");
  const f = await res("/font/schibsted-grotesk.woff2");
  expect(f.status).toBe(200);
  expect(f.headers.get("content-type")).toBe("font/woff2");
  expect(new Uint8Array(await f.arrayBuffer()).slice(0, 4)).toEqual(new TextEncoder().encode("wOF2"));
  expect(APP_COPY.more).toBe("{n} more on your mind");
}), 60_000);

test("Ask's box sits at the bottom above the tabs, as in any chat, not under the last answer", () => pinned(async () => {
  const { get } = await setup();
  const ask = await get("/ask");
  expect(ask).toContain('<main class="wrap chat">');
  expect(ask).toMatch(/<div class="pinned"><form class="box composer" data-focus-ring method="post" action="\/say">/);
}), 60_000);

test("the link to the rest counts only a small rest: over 20 is a number nobody reads (Mac, 2026-10-31)", () => {
  expect(moreWords(1)).toBe("1 more on your mind");
  expect(moreWords(20)).toBe("20 more on your mind");
  expect(moreWords(214)).toBe(APP_COPY.moreAll);
  expect(APP_COPY.moreAll).not.toMatch(/\d/);
});
