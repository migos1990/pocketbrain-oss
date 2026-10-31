// SPDX-License-Identifier: AGPL-3.0-only
// The owner app's Tell flow (brief 2026-10-30, step 2), on the demo brain: what the owner just told
// leads the mind, drawn as just told, with its marks; a dashed mark opens a sheet (/let) that asks
// "Let Gemini know this?" and offers what the owner alone may do: the whole area (on Settings, behind
// a fresh sign-in) or keep it from that assistant. Nothing on the sheet widens a view by itself.
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { dashboardHandler } from "../src/dashboard/server";
import { loadRules } from "../src/rules";
import { APP_COPY } from "../src/dashboard/html-app";

const H = "127.0.0.1:8798";
async function setup() {
  const { root } = await makeDemoBrain();
  const d = dashboardHandler(root, { port: 8798, loginKey: "k".repeat(32) });
  const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const req = async (method: string, path: string, fields?: Record<string, string>, referer = `http://${H}/home`) => {
    const body = fields ? new URLSearchParams(fields) : undefined;
    const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
    return { status: r.status, text: await r.text(), loc: r.headers.get("location") ?? "" };
  };
  const csrf = async () => (await req("GET", "/home")).text.match(/name="csrf" value="([^"]+)"/)![1]!;
  return { root, req, csrf };
}
const KEY = "projects/product-discovery-course#next_step";
const LET = `/let?key=${encodeURIComponent(KEY)}&agent=gemini`;

test("what the owner just told leads the mind, drawn as just told, with its marks", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { req, csrf } = await setup();
    const said = await req("POST", "/say", { csrf: await csrf(), q: "Product Discovery course's next step is book the exam room" });
    expect(said.status).toBe(200);
    // The waiting conflicts come first; the told line leads the memories.
    const told = said.text.match(/<li class="card told">([\s\S]*?)<\/li>/)![1]!;
    expect(told).toContain("Product Discovery course");
    expect(told).toContain(APP_COPY.justSaid);
    expect(told).toContain(`href="${LET.replace(/&/g, "&amp;")}"`);
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("a dashed mark is a link to its sheet; a filled one is not", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { req } = await setup();
    const home = (await req("GET", "/home")).text;
    expect(home).toMatch(/<a class="mark not" href="\/let\?key=[^"]+&amp;agent=gemini" aria-label="Let Gemini know this\?">G<\/a>/);
    expect(home).not.toMatch(/<a class="mark" /);
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("the sheet asks, offers the area on Settings and Keep it from, and keeping it from the assistant goes home", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root, req, csrf } = await setup();
    const sheet = await req("GET", LET);
    expect(sheet.status).toBe(200);
    expect(sheet.text).toContain("Let Gemini know this?");
    expect(sheet.text).toContain("Gemini doesn&#39;t get your teaching pages.");
    expect(sheet.text).toMatch(/<a class="choice" href="\/agent\/gemini">[\s\S]*Everything in teaching[\s\S]*?\d+ pages/);
    expect(sheet.text).toContain('name="agent" value="gemini"');
    expect(sheet.text).toContain('action="/action/note-hide"');
    expect(sheet.text).toContain("Keep it from Gemini");
    // An assistant that already gets it has no sheet, nor does a page or an assistant there isn't.
    expect((await req("GET", `/let?key=${encodeURIComponent(KEY)}&agent=claude`)).status).toBe(404);
    expect((await req("GET", `/let?key=${encodeURIComponent("people/nobody#role")}&agent=gemini`)).status).toBe(404);
    expect((await req("GET", `/let?key=${encodeURIComponent(KEY)}&agent=gardener`)).status).toBe(404);
    const kept = await req("POST", "/action/note-hide", { csrf: await csrf(), id: "projects/product-discovery-course", agent: "gemini", from: "let" }, `http://${H}/let`);
    expect(kept.status).toBe(303);
    expect(kept.loc).toStartWith("/home?ok=");
    expect(loadRules(root).policy.agents.gemini!.exclude).toContain("projects/product-discovery-course");
  } finally { delete process.env.PB_NOW; }
}, 60_000);
