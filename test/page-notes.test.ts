// SPDX-License-Identifier: AGPL-3.0-only
// The owner, 2026-11-07: "I should be able to edit the information. That edit should be saved, so
// in memory you know that I made the manual change … a reference note that says this was manually
// edited", and comments "that need to be then digested". On a page, a sentence the box catches no
// fact in can be kept as the owner's note, dated (G719); the page's own notes can be edited by hand
// right after a sign-in (G718); the page says "Edited by you on <day>." and the night writer keeps
// them. Nothing is asked: the count of what waits doesn't move.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { dashboardHandler } from "../src/dashboard/server";
import { PAGE_COPY } from "../src/dashboard/html-page";
import { ownerAsks } from "../src/waiting";
import { git } from "../src/git";
import { renderTouchedPages } from "../src/wiki";

const ID = "people/camille-lefebvre", P = `/p/${ID}`;
const H = "127.0.0.1:8793";
async function setup() {
  const { root } = await makeDemoBrain();
  const at = { t: Date.parse(DEMO_NOW) };
  const d = dashboardHandler(root, { port: 8793, loginKey: "k".repeat(32), now: () => new Date(at.t) });
  const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const req = async (method: string, path: string, fields?: Record<string, string>) => {
    const body = fields ? new URLSearchParams(fields) : undefined;
    const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}${P}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
    return { status: r.status, text: await r.text(), loc: r.headers.get("location") ?? "" };
  };
  const csrf = async () => (await req("GET", P)).text.match(/name="csrf" value="([^"]+)"/)![1]!;
  return { root, at, req, csrf };
}
const file = (root: string) => readFileSync(join(root, `${ID}.md`), "utf8");
const lastKind = (root: string) => git(root, ["log", "-1", "--format=%B"]);

test("G719 a sentence on a page that files no fact can be kept as the owner's note, dated", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const s = await setup();
    const asks = ownerAsks(s.root).total;
    const said = "we laughed a lot over lunch";
    const r = await s.req("POST", "/say", { csrf: await s.csrf(), q: said, page: ID });
    expect(r.text).toContain(PAGE_COPY.keepNote);
    expect(r.text).toContain('action="/action/page-note"');
    const k = await s.req("POST", "/action/page-note", { csrf: await s.csrf(), id: ID, text: said });
    expect(k.loc).toStartWith(P);
    expect(file(s.root)).toMatch(/## Your notes\n[\s\S]*You, 8 Oct: we laughed a lot over lunch/);
    expect(lastKind(s.root)).toMatch(/^owner: keep a note on[\s\S]*Kind: owner-page-note/);
    const page = (await s.req("GET", P)).text;
    expect(page).toContain("we laughed a lot over lunch");
    expect(page).toContain("Edited by you on 8 Oct.");
    expect(ownerAsks(s.root).total).toBe(asks);
    // An empty note, or one for a page that isn't there, is refused.
    expect((await s.req("POST", "/action/page-note", { csrf: await s.csrf(), id: ID, text: "  " })).loc).toContain("err=");
    expect((await s.req("POST", "/action/page-note", { csrf: await s.csrf(), id: "people/nobody-here", text: "x" })).loc).toContain("err=");
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("G718 the page's own notes are edited by hand right after a sign-in, and the night writer keeps them", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const s = await setup();
    const form = (await s.req("GET", `${P}?edit=1`)).text;
    expect(form).toContain('action="/action/page-notes-save"');
    expect(form).toContain('<form class="notes"');
    const r = await s.req("POST", "/action/page-notes-save", { csrf: await s.csrf(), id: ID, text: "Met at the spring offsite.\nPrefers mornings." });
    expect(r.loc).toStartWith(P);
    expect(file(s.root)).toContain("## Your notes\nMet at the spring offsite.\nPrefers mornings.");
    expect(lastKind(s.root)).toMatch(/^owner: edit your notes on[\s\S]*Kind: owner-page-edit/);
    expect((await s.req("GET", P)).text).toContain("Edited by you on 8 Oct.");
    // The band's Edit opens this, not the file editor.
    expect((await s.req("GET", P)).text).toContain(`href="${P}?edit=1"`);
    // The night writer keeps what the owner wrote.
    renderTouchedPages(s.root, "2000-01-01T00:00:00Z");
    expect(file(s.root)).toContain("Met at the spring offsite.\nPrefers mornings.");
    // Clearing the box takes the notes away.
    await s.req("POST", "/action/page-notes-save", { csrf: await s.csrf(), id: ID, text: "" });
    expect(file(s.root)).not.toContain("## Your notes");
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("G718 past a fresh sign-in, the editor isn't shown and a save is refused", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const s = await setup();
    const csrf = await s.csrf();
    s.at.t += 20 * 60_000;
    const form = (await s.req("GET", `${P}?edit=1`)).text;
    expect(form).not.toContain('<form class="notes"');
    expect(form).toContain('action="/action/sign-in-again"');
    const before = file(s.root);
    await s.req("POST", "/action/page-notes-save", { csrf, id: ID, text: "x" });
    expect(file(s.root)).toBe(before);
  } finally { delete process.env.PB_NOW; }
}, 90_000);
