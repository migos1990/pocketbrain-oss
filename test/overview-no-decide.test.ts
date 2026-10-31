// SPDX-License-Identifier: AGPL-3.0-only
// After the delete (2026-10-27) Settings still listed every waiting proposal with Save / Don't save,
// so it was a second place to decide. Nothing is decided there now: a proposal that contradicts a
// value links to its settle screen, the rest are held until after the finals (standing decision),
// and a fact page's "two answers disagree" opens /settle, not the overview.
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { dashboardHandler } from "../src/dashboard/server";
import { inboxConflicts } from "../src/settle-inbox";
import { loadBrain, saveNote } from "../src/brain";

const H = "127.0.0.1:8796";
async function settings(root: string) {
  const d = dashboardHandler(root, { port: 8796, loginKey: "k".repeat(32) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
  const get = async (p: string) => (await d.handle(new Request(`http://${H}${p}`, { headers: { host: H, cookie } }))).text();
  return get;
}

test("Settings decides nothing: a contradiction links to its settle screen, the rest are held", async () => {
  const root = makeBrain();
  const w = write(root, { agent: "helper", id: "projects/course-a", attribute: "next_step", value: "Book the room", as_of: "2026-03-09", sources: ["gmail:f000000000000005"], verification: "verified-by-source" });
  expect(w.outcome).toBe("inbox");
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "2026-10-08-new.yaml"), YAML.stringify({ proposed: "2026-10-08", by: "helper", reason: "helper is a trial agent: propose-only", request: { agent: "helper", kind: "fact", id: "projects/course-a", attribute: "room", value: "B-204", as_of: "2026-10-07", sources: ["gmail:f000000000000009"], verification: "verified-by-source" } }));
  const html = await (await settings(root))("/overview");
  expect(html).not.toContain('action="/action/proposal-accept"');
  expect(html).not.toContain('action="/action/proposal-reject"');
  const id = inboxConflicts(root)[0]!.id;
  expect(html).toContain(`<a class="btn" href="/settle/${id}">Settle it</a>`);
  expect(html).toMatch(/(Files on|Expires unconfirmed on) [A-Z][a-z]{2} \d+[^<]*Nothing to decide now\./);
  expect(html).not.toContain("Held until after the finals");
});

test("a fact in dispute opens its settle screen from the edit page", async () => {
  const root = makeBrain();
  const n = loadBrain(root).find((x) => x.fm.id === "projects/course-a")!;
  n.fm.facts!.room = { dispute: "c-7", candidates: [{ value: "B-201", as_of: "2026-10-01", sources: ["gmail:f000000000000001"], verification: "verified-by-source", by: "planner", recorded: "2026-10-01" }, { value: "C-305", as_of: "2026-10-02", sources: ["gmail:f000000000000002"], verification: "verified-by-source", by: "helper", recorded: "2026-10-02" }] } as never;
  saveNote(root, n);
  const get = await settings(root);
  const html = await get("/note/projects/course-a");
  expect(html).toContain("two answers disagree");
  expect(html).not.toContain("Settle it on the overview");
  expect(html).toContain('<a href="/settle/c-7">Settle it</a>');
});

// Use-it on e3d36b14: a live conflict keeps its value (`contested`, G425), so the edit page showed the
// value with no way to the settle screen.
test("a value a conflict waits beside links to its settle screen from the edit page", async () => {
  const root = makeBrain();
  writeFileSync(join(root, "projects", "course-c.md"), `---\nid: projects/course-c\ntype: project\ntitle: Course C\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  room: { value: "B-201", as_of: 2026-10-07, sources: ["gmail:f000000000000041"], verification: verified-by-source, by: planner, recorded: 2026-10-07 }\n---\n`);
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "commit", "-qm", "owner: course c"], { cwd: root });
  const r = write(root, { agent: "planner", id: "projects/course-c", attribute: "room", value: "C-305", as_of: "2026-10-07", sources: ["gcal:e1@e1"], verification: "self-reported" } as never, { acceptedBy: "auto-decide", contest: true });
  expect(r.outcome).toBe("disputed");
  const id = (loadBrain(root).find((n) => n.fm.id === "projects/course-c")!.fm.facts!.room as { contested?: string }).contested!;
  expect(id).toMatch(/^c-/);
  const html = await (await settings(root))("/note/projects/course-c");
  expect(html).toContain(`<a href="/settle/${id}">Settle it</a>`);
});
