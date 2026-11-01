// SPDX-License-Identifier: AGPL-3.0-only
// The owner app in Two inks (the owner's pick of three design directions, 2026-10-31): newsprint
// paper, black text, two spot inks. The pair is two tokens, so another pair is one change; neither
// ink carries small text; items are split by rules, buttons are underlined words, tabs are words;
// On your mind counts what waits in the marker ink and highlights the values that disagree; a
// person's page prints the surname in the headline ink and what links here as one sentence.
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { dashboardHandler } from "../src/dashboard/server";
import { APP_CSS, INKS, DARK_INKS, TWO_INKS_LIGHT, TWO_INKS_DARK, FONT_PATH, marked } from "../src/dashboard/html-app";

const H = "127.0.0.1:8796";
async function setup() {
  const { root } = await makeDemoBrain();
  const d = dashboardHandler(root, { port: 8796, loginKey: "k".repeat(32), now: () => new Date(DEMO_NOW) });
  const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const res = (path: string) => d.handle(new Request(`http://${H}${path}`, { headers: { host: H, cookie } }));
  return { res, get: async (path: string) => (await res(path)).text() };
}
const pinned = async <T>(f: () => Promise<T>) => { process.env.PB_NOW = DEMO_NOW; try { return await f(); } finally { delete process.env.PB_NOW; } };

// WCAG relative luminance and contrast.
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

test("the two inks are two tokens: each colour is written once, so another pair is one change", () => {
  expect(INKS).toEqual({ headline: "#0078BF", marker: "#FF48B0" });
  expect(DARK_INKS).toEqual({ headline: "#FFE800", marker: "#FF48B0" });
  // An ink's colour appears only where a token is set: nowhere else in the stylesheet.
  for (const hex of new Set([...Object.values(INKS), ...Object.values(DARK_INKS)])) expect(APP_CSS.split(hex).length - 1).toBe(APP_CSS.split(`-ink:${hex};`).length - 1);
  expect(APP_CSS).toContain(`--headline-ink:${INKS.headline};--marker-ink:${INKS.marker};`);
  expect(APP_CSS).toContain(`--headline-ink:${DARK_INKS.headline};--marker-ink:${DARK_INKS.marker};`);
  // No colour of the old look is left.
  expect(APP_CSS).not.toMatch(/#4338ca|#f6f6f9|999px/i);
});

test("text reads: black text and grey on paper pass AA in light and dark, the headline ink only large, the marker ink never as text", () => {
  for (const [t, inks] of [[TWO_INKS_LIGHT, INKS], [TWO_INKS_DARK, DARK_INKS]] as const) {
    expect(contrast(t.text, t.paper)).toBeGreaterThanOrEqual(7);
    expect(contrast(t.muted, t.paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(inks.headline, t.paper)).toBeGreaterThanOrEqual(3); // large text only
    expect(contrast(t.onHeadline, inks.headline)).toBeGreaterThanOrEqual(4.5); // footnote numbers, Send
    expect(contrast(t.onMarker, inks.marker)).toBeGreaterThanOrEqual(4.5); // the count, the current tab
  }
  // The dark look is variant E: near-black paper, nothing blended.
  expect(TWO_INKS_DARK.paper).toBe("#121212");
  expect(APP_CSS).toMatch(/:root\[data-theme="dark"\]\{color-scheme:dark;[^}]*--blend:normal;/);
  expect(TWO_INKS_LIGHT.text).toBe("#141414");
  expect(APP_CSS).not.toMatch(/(^|[;{])color:var\(--marker-ink\)/);
});

test("the typeface is Schibsted Grotesk, the hub's own file", () => pinned(async () => {
  const { res } = await setup();
  expect(FONT_PATH).toBe("/font/schibsted-grotesk.woff2");
  expect(APP_CSS).toContain('font-family:"Schibsted Grotesk"');
  const f = await res(FONT_PATH);
  expect(f.status).toBe(200);
  expect(new Uint8Array(await f.arrayBuffer()).slice(0, 4)).toEqual(new TextEncoder().encode("wOF2"));
  expect((await res("/font/plus-jakarta-sans.woff2")).status).not.toBe(200);
}), 60_000);

test("On your mind: the headline, how many things wait in the marker ink, the values that disagree highlighted, word tabs", () => pinned(async () => {
  const { get } = await setup();
  const home = await get("/home");
  expect(home).toMatch(/<header class="top"><p class="day"><span>[^<]+<\/span><a class="me" href="\/who">Robin[^<]*<\/a><\/p><h1>On your mind<\/h1><\/header><p class="count"><b>\d+<\/b><span>things? waits? for you<\/span><\/p>/);
  expect(home).toContain("Next for Atlas launch: freeze the beta build on <mark>15 October</mark>. Or <mark>22 October</mark>?");
  expect(home).toMatch(/<nav class="tabbar" aria-label="Tabs"><a href="\/home" aria-current="page">On your mind<\/a><a href="\/memory">Memory<\/a><a href="\/ask">Ask<\/a><a href="\/who">Who knows<\/a><\/nav>/);
  expect(home).not.toContain("<svg aria-hidden=\"true\" width=\"24\"");
}), 60_000);

test("the highlighter marks each part after the last, and escapes the rest", () => {
  expect(marked("A <b> 15 October. Or 22 October?", ["15 October", "22 October"])).toBe("A &lt;b&gt; <mark>15 October</mark>. Or <mark>22 October</mark>?");
  expect(marked("Grace is x. Or y?", ["missing", "y"])).toBe("Grace is x. Or <mark>y</mark>?");
  expect(marked("plain")).toBe("plain");
});

test("a person's page: the surname in the headline ink, the role between rules, no monogram, what links here as a sentence", () => pinned(async () => {
  const { get } = await setup();
  const p = await get("/p/people/maya-chen");
  expect(p).toContain("<h1>Maya <span>Chen</span></h1>");
  expect(p).not.toContain('class="face"');
  expect(p).toMatch(/<h2 class="sec">Mentioned on<\/h2><p class="links">(<a href="\/p\/[^"]+">[^<]+<\/a>, )*<a href="\/p\/[^"]+">[^<]+<\/a>\.<\/p>/);
  const project = await get("/p/projects/atlas-launch");
  expect(project).toContain("<h1>Atlas launch</h1>");
}), 60_000);
