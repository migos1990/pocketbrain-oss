// SPDX-License-Identifier: AGPL-3.0-only
// Settling ends the question (owner's phone, 2026-11-02: "you click on one or two, but like one
// should then disappear"). A pick on the settle screen goes back to On your mind: the question is
// gone, the number is one less, and one quiet line says what was settled, with Undo, and whether
// anything is left to settle. Letting a held value out says it the same way, with Undo (G631).
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain, saveNote } from "../src/brain";
import { write } from "../src/write";
import { dashboardHandler, flashOf } from "../src/dashboard/server";
import { HOME_COPY } from "../src/dashboard/html-home";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
function brain() {
  const root = makeBrain();
  writeFileSync(join(root, "projects", "course-c.md"), `---\nid: projects/course-c\ntype: project\ntitle: Course C\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  room: { value: "B-201", as_of: 2026-10-07, sources: ["gmail:f000000000000041"], verification: verified-by-source, by: planner, recorded: 2026-10-07 }\n---\n`);
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: course c");
  const r = write(root, { agent: "planner", id: "projects/course-c", attribute: "room", value: "C-305", as_of: "2026-10-07", sources: ["gcal:e1@e1"], verification: "self-reported" } as never, { acceptedBy: "auto-decide", contest: true });
  expect(r.outcome).toBe("disputed");
  // The Gardener weighed it, so it waits on the owner.
  const p = loadBrain(root).find((n) => n.fm.type === "dispute")!;
  p.fm.suggestion = { by: "gardener", at: new Date().toISOString(), choice: 2, sources: ["gcal:e1@e1"], why: "the calendar invite is the newer booking" };
  saveNote(root, p);
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "gardener: suggest");
  return { root, id: String(loadBrain(root).find((n) => n.fm.type === "dispute")!.fm.id).split("/")[1]! };
}
async function dash(root: string, port: number) {
  const H = `127.0.0.1:${port}`;
  const d = dashboardHandler(root, { port, loginKey: "k".repeat(32) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
  return async (method: string, path: string, fields?: Record<string, string>) => {
    const body = fields ? new URLSearchParams(fields) : undefined;
    const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/home`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
    return { status: r.status, text: await r.text(), loc: r.headers.get("location") ?? "" };
  };
}
const big = (html: string) => Number(/<p class="count"><b>(\d+)<\/b>/.exec(html)?.[1] ?? 0);
const csrfOf = (html: string) => html.match(/name="csrf" value="([^"]+)"/)![1]!;

test("a pick goes back to On your mind: the question is gone, the number drops, one line says it with Undo", async () => {
  const { root, id } = brain();
  const req = await dash(root, 8861);
  const before = await req("GET", "/home");
  const n = big(before.text);
  expect(before.text).toContain(`/settle/${id}`);
  const page = await req("GET", `/settle/${id}`);
  const picked = await req("POST", "/action/settle-pick", { csrf: csrfOf(page.text), id, n: "2" });
  expect(picked.status).toBe(303);
  expect(picked.loc).toStartWith("/home?");
  expect(flashOf(picked.loc).ok).toBe("Settled: Course C's room is C-305. Nothing else to settle.");
  const after = await req("GET", picked.loc);
  expect(after.text).not.toContain(`/settle/${id}`);
  expect(big(after.text)).toBe(n - 1);
  const done = after.text.match(/class="done" role="status">[\s\S]*?<\/div>/)?.[0] ?? "";
  expect(done).toContain("Settled: Course C&#39;s room is C-305.");
  expect(done).toContain('action="/action/diary-undo"');
  expect(done).toContain(`>${HOME_COPY.undo}</button>`);
  // Undo opens the question again.
  const token = done.match(/name="token" value="([^"]+)"/)![1]!;
  await req("POST", "/action/diary-undo", { csrf: csrfOf(after.text), token });
  expect((await req("GET", "/home")).text).toContain(`/settle/${id}`);
});

test("Not sure, keep both also leaves the screen with a line that says so", async () => {
  const { root, id } = brain();
  const req = await dash(root, 8862);
  const page = await req("GET", `/settle/${id}`);
  const both = await req("POST", "/action/settle-both", { csrf: csrfOf(page.text), id });
  expect(both.loc).toStartWith("/home?");
  expect(flashOf(both.loc).ok).toBe("Kept both. I won't ask again unless something newer comes in. Nothing else to settle.");
  expect((await req("GET", both.loc)).text).not.toContain(`/settle/${id}`);
});

test("letting a held value out says it with Undo, which holds it again", async () => {
  const root = makeBrain();
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "fee", value: "1200 dollars a year", as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source", sensitivity: "private" } as never);
  const req = await dash(root, 8863);
  const home = await req("GET", "/home");
  const shown = await req("POST", "/action/diary-seen", { csrf: csrfOf(home.text), key: "people/jane-roy#fee" });
  const after = (await req("GET", shown.loc)).text;
  const done = after.match(/class="done" role="status">[\s\S]*?<\/div>/)?.[0] ?? "";
  expect(done).toContain("Jane Roy&#39;s fee is 1200 dollars a year.");
  expect(done).toContain('action="/action/diary-undo"');
});
