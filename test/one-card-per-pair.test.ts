// SPDX-License-Identifier: AGPL-3.0-only
// The owner's phone, 2026-11-03 (G669): one project showed three conflict cards, one per field,
// all from the same two emails, and each opened on much the same thing. Conflicts on one page from
// the same pair of sources are one card that names its fields and still counts each question; a
// pick on one goes straight to the next on that card, and the last goes home.
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain, saveNote } from "../src/brain";
import { write } from "../src/write";
import { ownerConflicts } from "../src/core";
import { homeView, waitingCount } from "../src/dashboard/home";
import { loadRules } from "../src/rules";
import { dashboardHandler } from "../src/dashboard/server";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
const rec = (v: string, ref: string) => `{ value: "${v}", as_of: 2026-10-07, sources: ["${ref}"], verification: verified-by-source, by: planner, recorded: 2026-10-07 }`;

// Course C holds three facts from one email; a second email disagrees with all three, and a calendar
// invite disagrees with its fourth. The Gardener has weighed every one, so all wait on the owner.
function brain() {
  const root = makeBrain();
  const A = "gmail:f000000000000041", B = "gmail:f000000000000042";
  writeFileSync(join(root, "projects", "course-c.md"), `---\nid: projects/course-c\ntype: project\ntitle: Course C\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  room: ${rec("B-201", A)}\n  status: ${rec("on track", A)}\n  next_step: ${rec("Book the lab", A)}\n  start_time: ${rec("9:00", "gmail:f000000000000043")}\n---\n`);
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: course c");
  for (const [attribute, value, ref] of [["room", "C-305", B], ["status", "late", B], ["next_step", "Send the syllabus", B], ["start_time", "10:00", "gmail:f000000000000044"]]) {
    const r = write(root, { agent: "planner", id: "projects/course-c", attribute, value, as_of: "2026-10-07", sources: [ref], verification: "verified-by-source" } as never, { acceptedBy: "auto-decide", contest: true });
    expect([attribute, r.outcome, (r as { message?: string }).message]).toEqual([attribute, "disputed", expect.anything()]);
  }
  for (const p of loadBrain(root).filter((n) => n.fm.type === "dispute")) {
    p.fm.suggestion = { by: "gardener", at: new Date().toISOString(), choice: 2, sources: ["gmail:f000000000000042"], why: "the newer email" };
    saveNote(root, p);
  }
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "gardener: suggest");
  return root;
}

test("conflicts on one page from the same two sources are one card that names its fields and counts each", () => {
  const root = brain();
  const open = ownerConflicts(root);
  expect(open).toHaveLength(4);
  const w = homeView(root, loadRules(root), loadBrain(root), new Date()).waiting.filter((x) => x.href.startsWith("/settle/"));
  // The three from the two emails are one card; the third email's is its own.
  expect(w).toHaveLength(2);
  const pair = w.find((x) => x.n === 3)!;
  expect(pair.what).toBe("3 things about Course C disagree: its room, its status and what's next.");
  expect(pair.meta).toBe("Two emails disagree");
  const ids = open.filter((c) => c.attr !== "start_time").map((c) => c.id);
  expect(pair.href).toBe(`/settle/${ids[0]}`);
  expect(w.find((x) => x !== pair)!.what).toBe("Course C's start time is 9:00. Or 10:00?");
  // Each question still counts: the big number is unchanged.
  expect(waitingCount(root)).toBe(4);
});

test("a pick on a card's question goes to its next one, and the last goes home", async () => {
  const root = brain();
  const ids = ownerConflicts(root).filter((c) => c.attr !== "start_time").map((c) => c.id);
  const H = "127.0.0.1:8793";
  const d = dashboardHandler(root, { port: 8793, loginKey: "k".repeat(32) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
  const req = async (method: string, path: string, fields?: Record<string, string>) => {
    const body = fields ? new URLSearchParams(fields) : undefined;
    const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/home`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
    return { status: r.status, text: await r.text(), loc: r.headers.get("location") ?? "" };
  };
  const pg = await req("GET", `/settle/${ids[0]}`);
  const csrf = pg.text.match(/name="csrf" value="([^"]+)"/)![1]!;
  const first = await req("POST", "/action/settle-pick", { csrf, id: ids[0]!, n: "2" });
  expect(first.loc).toStartWith(`/settle/${ids[1]}?ok=`);
  const second = await req("POST", "/action/settle-both", { csrf, id: ids[1]! });
  expect(second.loc).toStartWith(`/settle/${ids[2]}?ok=`);
  const last = await req("POST", "/action/settle-pick", { csrf, id: ids[2]!, n: "2" });
  expect(last.loc).toStartWith("/home?ok=");
  expect(waitingCount(root)).toBe(1);
}, 30_000);
