// SPDX-License-Identifier: AGPL-3.0-only
// "See as" (backlog #313): the owner searches and opens notes on the dashboard exactly as one
// assistant would get them (same carve, ranking and [withheld] marks), without it counting as
// that assistant's read.
import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { search, readNote, previewSearch, previewRead, CoreError } from "../src/core";
import { loadRules } from "../src/rules";
import { carve, grantFor } from "../src/carve";
import { loadBrain } from "../src/brain";
import { dashboardHandler } from "../src/dashboard/server";
import { setAgentStatus } from "../src/dashboard/actions";

const reads = (root: string) => { const f = join(root, "log", "reads.jsonl"); return existsSync(f) ? readFileSync(f, "utf8") : ""; };
const agents = (root: string) => Object.entries(loadRules(root).policy.agents).filter(([, a]) => !a.inside_wall).map(([n]) => n);
const err = (f: () => unknown) => { try { f(); return ""; } catch (e) { return e instanceof CoreError ? `${e.status} ${e.message}` : String(e); } };

test("preview search and read give exactly what the agent gets, and leave no read behind", () => {
  const root = makeBrain();
  const ids = loadBrain(root).map((n) => n.fm.id);
  for (const agent of agents(root)) {
    const before = reads(root);
    const visible = [...carve(loadBrain(root), loadRules(root), grantFor(loadRules(root), agent)).visible.keys()];
    const shown = { search: ["Jane", "bank", "course", "Maple Trust"].map((q) => previewSearch(root, agent, q)), read: ids.map((id) => err(() => previewRead(root, agent, id)) || previewRead(root, agent, id)) };
    expect(reads(root)).toBe(before);
    const real = { search: ["Jane", "bank", "course", "Maple Trust"].map((q) => search(root, agent, q)), read: ids.map((id) => err(() => readNote(root, agent, id)) || readNote(root, agent, id)) };
    expect(shown, agent).toEqual(real);
    // A hidden note answers like a missing one, in the preview too.
    expect(err(() => previewRead(root, agent, "people/nobody-at-all"))).toBe("404 no note people/nobody-at-all in your view");
    for (const id of ids.filter((i) => !visible.includes(i))) expect(err(() => previewRead(root, agent, id))).toBe(`404 no note ${id} in your view`);
  }
});

test("a paused assistant's preview says so, as its own reads would", () => {
  const root = makeBrain();
  setAgentStatus(root, "planner", "paused");
  expect(err(() => previewSearch(root, "planner", "course"))).toBe(err(() => search(root, "planner", "course")));
  expect(err(() => previewSearch(root, "planner", "course"))).toStartWith("403 ");
});

async function dash(root: string) {
  const H = "127.0.0.1:8795";
  const d = dashboardHandler(root, { port: 8795, loginKey: "k".repeat(32) });
  const cookie = (await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }))).headers.get("set-cookie")!.split(";")[0];
  return async (path: string, withCookie = true) => {
    const r = await d.handle(new Request(`http://${H}${path}`, { headers: { host: H, ...(withCookie ? { cookie } : {}) } }));
    return { status: r.status, text: await r.text() };
  };
}

test("the map's 'as' view searches and opens notes as that assistant, with its [withheld] marks, and logs no read", async () => {
  const root = makeBrain();
  const get = await dash(root);
  // Find a note helper sees only in part, so the page must show its [withheld] marks.
  const part = loadBrain(root).map((n) => n.fm.id).find((id) => { try { return previewRead(root, "helper", id).markdown.includes("[withheld]"); } catch { return false; } });
  expect(part).toBeTruthy();
  const before = reads(root);
  const hits = previewSearch(root, "helper", "course");
  expect(hits.length).toBeGreaterThan(0);
  const s = await get(`/map?as=helper&q=course`);
  expect(s.status).toBe(200);
  for (const h of hits) expect(s.text).toContain(`/map?as=helper&amp;read=${encodeURIComponent(h.id)}`);
  const r = await get(`/map?as=helper&read=${encodeURIComponent(part!)}`);
  expect(r.text).toContain("[withheld]");
  const md = previewRead(root, "helper", part!).markdown;
  expect(r.text).toContain(md.split("\n").find((l) => l.includes("[withheld]"))!.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"));
  // A note outside helper's view reads exactly like a missing one.
  const hidden = loadBrain(root).map((n) => n.fm.id).find((id) => { try { previewRead(root, "helper", id); return false; } catch { return true; } })!;
  expect((await get(`/map?as=helper&read=${encodeURIComponent(hidden)}`)).text).toContain(`no note ${hidden} in your view`);
  expect(reads(root)).toBe(before);
  // Without the owner's sign-in nothing is shown.
  const anon = await get(`/map?as=helper&q=course`, false);
  expect(anon.text).not.toContain("/map?as=helper&amp;read=");
});

test("no agent door reaches the preview: only the owner's dashboard calls it", () => {
  const src = (f: string) => readFileSync(join(import.meta.dir, "..", "src", f), "utf8");
  for (const f of ["server.ts", "browser.ts", "edge.ts", "cell.ts"]) expect(src(f), f).not.toMatch(/previewSearch|previewRead/);
});
