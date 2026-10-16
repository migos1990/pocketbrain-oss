// SPDX-License-Identifier: AGPL-3.0-only
// History pages: a note's facts over time, every save with who made it, the note as it was,
// and what changed this week. All read from git; the only buttons are the undos that exist.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { makeModel, type ModelRequest } from "../src/model";
import { dashboardHandler } from "../src/dashboard/server";
import { git } from "../src/git";
import { noteSaves, actorOf } from "../src/dashboard/history";

const H = "127.0.0.1:8791";

function setup(fake: (req: ModelRequest) => string = () => "No model in this test.", maxSensitivity: "personal" | "private" = "personal") {
  const root = makeBrain();
  const tok = { helper: issueToken(root, "helper"), planner: issueToken(root, "planner"), steward: issueToken(root, "steward") };
  const prompts: ModelRequest[] = [];
  const d = dashboardHandler(root, { port: 8791, loginKey: "k".repeat(32), modelFor: () => makeModel({ provider: "fake", model: "fake-1", max_sensitivity: maxSensitivity }, { fake: (r) => { prompts.push(r); return fake(r); } }) });
  let cookie = "";
  const req = async (method: string, path: string, fields?: Record<string, string>) => {
    const body = fields ? new URLSearchParams(fields) : undefined;
    const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}${path.startsWith("/action") ? "/brain" : path}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
    const loc = r.headers.get("location") ?? "";
    return { status: r.status, text: await r.text(), loc, ok: decodeURIComponent(loc.match(/ok=([^&]*)/)?.[1] ?? ""), err: decodeURIComponent(loc.match(/err=([^&]*)/)?.[1] ?? "") };
  };
  const login = async () => { const r = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } })); cookie = r.headers.get("set-cookie")!.split(";")[0]; };
  const csrf = async () => (await req("GET", "/brain")).text.match(/name="csrf" value="([^"]+)"/)![1];
  const post = async (path: string, fields: Record<string, string> = {}) => req("POST", path, { csrf: await csrf(), ...fields });
  const agent = async (who: keyof typeof tok, method: string, path: string, body?: unknown) => {
    const r = await handle(root, new Request(`http://pb${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${tok[who]}` } }));
    const text = await r.text(); let json: any; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };
  return { root, req, post, login, agent, prompts };
}

test("a note's history shows each value with who saved it, and opens the note as it was", async () => {
  const { root, login, post, req, agent } = setup();
  await login();
  // the planner (an assistant) changes the next step, then Robin changes it again from the dashboard
  const w = await agent("planner", "POST", "/v1/remember", { id: "projects/course-a", attribute: "next_step", value: "Send the syllabus", as_of: "2026-10-08", sources: ["gmail:f000000000000006"], verification: "verified-by-source" });
  expect(w.json.outcome).toBe("committed");
  const e = await post("/action/fact-set", { id: "projects/course-a", attribute: "next_step", value: "Book the room" });
  expect(e.ok).toContain("Saved");

  const saves = noteSaves(root, "projects/course-a");
  expect(saves.map((s) => s.actor)).toEqual(["owner", "planner", "owner"]);
  expect(saves[1].changes).toContainEqual(expect.objectContaining({ type: "changed", attr: "next_step", to: "Send the syllabus" }));

  const h = await req("GET", "/history/projects/course-a");
  expect(h.status).toBe(200);
  expect(h.text).toContain("Facts over time");
  expect(h.text).toContain("Book the room");
  expect(h.text).toContain("Send the syllabus");
  expect(h.text).toContain("from an email");
  expect(h.text).toMatch(/Planbot|planner/);
  // no commit hash on screen: only inside hidden form fields for the undo buttons
  const visible = h.text.replace(/<input type="hidden"[^>]*>/g, "").replace(/<[^>]+>/g, " ");
  for (const s of saves) expect(visible).not.toContain(s.hash.slice(0, 7));
  // Robin's own edit has its Undo; the planner's save can be undone too (commit-revert)
  expect(h.text).toContain('action="/action/owner-undo"');
  expect(h.text).toContain('action="/action/commit-revert"');

  // the note as it was right after the planner's save
  const at = h.text.match(/href="\/history\/projects\/course-a\?at=([^"]+)"/g)!;
  expect(at.length).toBeGreaterThan(0);
  const snap = await req("GET", `/history/projects/course-a?at=v${saves[1].v}`);
  expect(snap.status).toBe(200);
  expect(snap.text).toContain("As it was on");
  expect(snap.text).toContain("Send the syllabus");
  expect(snap.text).toContain("Since then");
  // a moment before the note existed
  expect((await req("GET", "/history/projects/course-a?at=1999-01-01")).status).toBe(404);

  // undo from the history page puts the planner's value back and marks the save undone
  const csrf = h.text.match(/name="csrf" value="([^"]+)"/)![1];
  const hash = h.text.match(/action="\/action\/owner-undo"><input type="hidden" name="csrf" value="[^"]+"><input type="hidden" name="hash" value="([0-9a-f]+)"/)![1];
  const u = await req("POST", "/action/owner-undo", { csrf, hash });
  expect(u.ok).toContain("undone");
  const after = await req("GET", "/history/projects/course-a");
  expect(after.text).toContain(">undone<");
});

test("what changed this week lists saves by day with who made them", async () => {
  const { login, post, req, agent } = setup();
  await login();
  await agent("planner", "POST", "/v1/remember", { id: "projects/course-a", attribute: "next_step", value: "Send the syllabus", as_of: "2026-10-08", sources: ["gmail:f000000000000006"], verification: "verified-by-source" });
  await post("/action/fact-set", { id: "people/jane-roy", attribute: "role", value: "Program director" });
  const r = await req("GET", "/history");
  expect(r.status).toBe(200);
  expect(r.text).toContain("What changed this week");
  expect(r.text).toContain("Today");
  expect(r.text).toContain("Jane Roy");
  expect(r.text).toContain("You changed role");
  expect(r.text).toContain("<s>Course coordinator</s> to Program director");
  expect(r.text).toContain('href="/history/projects/course-a"');
  // the Brain tab and the note link here
  expect((await req("GET", "/brain")).text).toContain('href="/history"');
  expect((await req("GET", "/note/people/jane-roy")).text).toContain('href="/history/people/jane-roy"');
  expect((await req("GET", "/history/people/nobody")).status).toBe(404);
});

test("who saved: pocketBrain's own commits name the agent; anything else is the owner's", () => {
  expect(actorOf({ author: "planner", email: "planner@pocketbrain.local" })).toBe("planner");
  expect(actorOf({ author: "Robin", email: "owner@pocketbrain.local" })).toBe("owner");
  expect(actorOf({ author: "louis", email: "louis@pocketbrain.local" })).toBe("owner");
  expect(actorOf({ author: "robin", email: "robin@example.com" })).toBe("owner");
});

test("going back in time: a note or the whole brain on a date, and an old value restored as a new save", async () => {
  const { root, login, post, req } = setup();
  await login();
  const env = (d: string) => { process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = d; };
  try {
    env("2026-10-05T12:00:00");
    await post("/action/fact-set", { id: "people/jane-roy", attribute: "role", value: "Program director" });
    env("2026-10-07T12:00:00");
    await post("/action/fact-set", { id: "people/jane-roy", attribute: "role", value: "Dean" });
  } finally { delete process.env.GIT_AUTHOR_DATE; delete process.env.GIT_COMMITTER_DATE; }

  // a bare date is the end of that day
  const day = await req("GET", "/history/people/jane-roy?at=2026-10-06");
  expect(day.status).toBe(200);
  expect(day.text).toContain("Program director");
  expect(day.text).toContain("changed since");
  expect(day.text).toContain('name="at"');
  // the whole brain on that date
  const brain = await req("GET", "/history?at=2026-10-06");
  expect(brain.status).toBe(200);
  expect(brain.text).toContain("Your brain on 6 Oct 2026");
  expect(brain.text).toContain("Role: Program director");
  expect(brain.text).toContain('href="/history/people/jane-roy?at=2026-10-06"');
  expect((await req("GET", "/history?at=1999-01-01")).status).toBe(404);

  // Restore goes through the ordinary edit: a new save by the owner, nothing rewritten
  const before = git(root, ["rev-list", "--count", "HEAD"]);
  const csrf = day.text.match(/name="csrf" value="([^"]+)"/)![1];
  expect(day.text).toContain('action="/action/fact-set"');
  const r = await req("POST", "/action/fact-set", { csrf, id: "people/jane-roy", attribute: "role", value: "Program director" });
  expect(r.ok).toContain("Saved");
  expect(Number(git(root, ["rev-list", "--count", "HEAD"]))).toBe(Number(before) + 1);
  const h = await req("GET", "/history/people/jane-roy");
  expect(h.text).toContain("<s>Dean</s> to <b>Program director</b>");
});
