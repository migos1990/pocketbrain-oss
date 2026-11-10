// SPDX-License-Identifier: AGPL-3.0-only
// A page that isn't there, in the owner app (G780, screens review 2026-11-10). A link to a page
// since renamed or forgotten opened the Settings side's error: "No note people/x (it may have been
// forgotten or renamed)", "Open the dashboard's Brain page", no tabs. The owner app says it in its
// own words, with its four tabs, and sends the owner to Memory.
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { dashboardHandler } from "../src/dashboard/server";
import { ownerErrorHtml, ownerError } from "../src/owner-errors";
import { esc } from "../src/dashboard/html";

const H = "127.0.0.1:8793";
async function setup() {
  const { root } = await makeDemoBrain();
  const d = dashboardHandler(root, { port: 8793, loginKey: "k".repeat(32) });
  const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  return async (path: string) => {
    const r = await d.handle(new Request(`http://${H}${path}`, { headers: { host: H, cookie } }));
    return { status: r.status, text: await r.text() };
  };
}

const words = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ");

test("a page that isn't there is said in the owner app's words, with its tabs and a way to Memory", async () => {
  const get = await setup();
  const r = await get("/p/people/nobody-here");
  expect(r.status).toBe(404);
  expect(r.text).toContain(ownerErrorHtml("app.no-page", {}, esc));
  // The owner's words: no "note", no id, no "dashboard", no Brain page.
  expect(words(r.text)).not.toMatch(/\bnote\b|nobody-here|dashboard|Brain page/i);
  // The app's own four tabs, Memory marked, and the fix is a link to Memory.
  expect(r.text).toContain('<nav class="tabbar"');
  expect(r.text).toMatch(/<a href="\/memory" aria-current="page">/);
  expect(r.text).toMatch(/<p>Open <a href="\/memory">Memory<\/a>, and search for it\.<\/p>/);
}, 60_000);

test("a Let sheet with nothing left to decide never says its page is missing", async () => {
  const get = await setup();
  // Gemini already gets this fact (a work project), and the page is there: the old answer was "No note projects/atlas-launch".
  for (const path of ["/let?key=projects%2Fatlas-launch%23status&agent=gemini", "/let?key=people%2Fnobody-here%23role&agent=gemini"]) {
    const r = await get(path);
    expect(r.status).toBe(404);
    expect(r.text).toContain(ownerErrorHtml("app.let-gone", {}, esc));
    expect(words(r.text)).not.toMatch(/\bnote\b|atlas-launch|nobody-here|dashboard|Brain page/i);
    expect(r.text).toMatch(/<a href="\/home" aria-current="page">/);
  }
}, 60_000);

test("the line reads as one plain sentence and its fix", () => {
  expect(ownerError("app.no-page")).toBe("That page isn't in your memory any more: it may have been renamed or forgotten. Fix: open Memory, and search for it.");
});
