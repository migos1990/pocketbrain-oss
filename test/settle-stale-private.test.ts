// SPDX-License-Identifier: AGPL-3.0-only
// Audit v7, medium (G553): the settle screen hides a private conflict's sides on the 30-day sign-in,
// but Pick was allowed stale, so an old or forged form could still pick a side (or type a value) the
// owner couldn't see. A pick on a private conflict needs a fresh sign-in, like the screen.
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain, saveNote, type FactRecord } from "../src/brain";
import { write } from "../src/write";
import { ownerConflict } from "../src/core";
import { dashboardHandler } from "../src/dashboard/server";

const H = "127.0.0.1:8796";
const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
function brain(level: "personal" | "private") {
  const root = makeBrain();
  writeFileSync(join(root, "projects", "course-c.md"), `---\nid: projects/course-c\ntype: project\ntitle: Course C\narea: work\nsensitivity: ${level}\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  room: { value: "B-201", as_of: 2026-10-07, sources: ["gmail:f000000000000041"], verification: verified-by-source, by: planner, recorded: 2026-10-07 }\n---\n`);
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: course c");
  expect(write(root, { agent: "planner", id: "projects/course-c", attribute: "room", value: "C-305", as_of: "2026-10-07", sources: ["gcal:e1@e1"], verification: "self-reported" } as never, { acceptedBy: "auto-decide", contest: true }).outcome).toBe("disputed");
  const p = loadBrain(root).find((n) => n.fm.type === "dispute")!;
  p.fm.suggestion = { by: "gardener", at: new Date().toISOString(), choice: 2, sources: ["gcal:e1@e1"], why: "newer" };
  saveNote(root, p);
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "gardener: suggest");
  return { root, id: String(p.fm.id).split("/")[1]! };
}
const room = (root: string) => (loadBrain(root).find((n) => n.fm.id === "projects/course-c")!.fm.facts!.room as FactRecord).value;

async function signedIn(root: string) {
  const t = Date.now();
  let at = t;
  const d = dashboardHandler(root, { port: 8796, loginKey: "k".repeat(32), now: () => new Date(at) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
  const req = async (method: string, path: string, fields?: Record<string, string>) => {
    const body = fields ? new URLSearchParams(fields) : undefined;
    const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/home`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
    return { status: r.status, text: await r.text(), loc: r.headers.get("location") ?? "" };
  };
  const csrf = (await req("GET", "/home")).text.match(/name="csrf" value="([^"]+)"/)![1]!;
  return { req, csrf, later: (min: number) => { at = t + min * 60_000; } };
}

for (const form of [{ n: "2" }, { value: "C-999" }] as Record<string, string>[]) {
  test(`a stale ${form.n ? "pick" : "typed answer"} on a private conflict is refused; fresh, it settles (G553)`, async () => {
    const { root, id } = brain("private");
    expect(ownerConflict(root, id)?.private).toBe(true);
    const s = await signedIn(root);
    s.later(11);
    const stale = await s.req("POST", "/action/settle-pick", { csrf: s.csrf, id, ...form });
    expect(stale.status).toBe(303);
    expect(room(root)).toBe("B-201");
    expect(ownerConflict(root, id)).toBeDefined();
    s.later(0);
    await s.req("POST", "/action/settle-pick", { csrf: s.csrf, id, ...form });
    expect(room(root)).toBe(form.n ? "C-305" : "C-999");
  }, 60_000);
}

test("a pick on a conflict the screen shows still works on the 30-day sign-in (G553)", async () => {
  const { root, id } = brain("personal");
  const s = await signedIn(root);
  s.later(11);
  await s.req("POST", "/action/settle-pick", { csrf: s.csrf, id, n: "2" });
  expect(room(root)).toBe("C-305");
}, 60_000);
