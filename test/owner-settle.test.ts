// SPDX-License-Identifier: AGPL-3.0-only
// The settle screen (phone UI spec §2.3, owner 2026-10-26): the only place that asks. One plain
// question, one row per side with its source and date, the Gardener's lean first, "Not sure, keep
// both" beside them; a pick is one diary line whose Undo opens the conflict again. A conflict the
// Gardener is still weighing doesn't wait on the owner yet.
import { test, expect } from "bun:test";
import { esc } from "../src/dashboard/html-home";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain, saveNote, type FactRecord } from "../src/brain";
import { write } from "../src/write";
import { ownerConflicts, ownerConflict, ownerDecide, ownerKeepBoth } from "../src/core";
import { readDiary } from "../src/diary";
import { undoFact } from "../src/undo";
import { homeView } from "../src/dashboard/home";
import { settlePage, question, ordered, SETTLE_COPY } from "../src/dashboard/html-settle";
import { loadRules } from "../src/rules";
import { dashboardHandler } from "../src/dashboard/server";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
function brain() {
  const root = makeBrain();
  writeFileSync(join(root, "projects", "course-c.md"), `---\nid: projects/course-c\ntype: project\ntitle: Course C\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  room: { value: "B-201", as_of: 2026-10-07, sources: ["gmail:f000000000000041"], verification: verified-by-source, by: planner, recorded: 2026-10-07 }\n---\n`);
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: course c");
  const r = write(root, { agent: "planner", id: "projects/course-c", attribute: "room", value: "C-305", as_of: "2026-10-07", sources: ["gcal:e1@e1"], verification: "self-reported" } as never, { acceptedBy: "auto-decide", contest: true });
  expect(r.outcome).toBe("disputed");
  const packet = loadBrain(root).find((n) => n.fm.type === "dispute")!;
  return { root, id: String(packet.fm.id).split("/")[1]! };
}
// The Gardener weighed it and leans to side 2.
function lean(root: string, id: string) {
  const p = loadBrain(root).find((n) => n.fm.id === `disputes/${id}`)!;
  p.fm.suggestion = { by: "gardener", at: new Date().toISOString(), choice: 2, sources: ["gcal:e1@e1"], why: "the calendar invite is the newer booking" };
  saveNote(root, p);
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "gardener: suggest");
}
const room = (root: string) => loadBrain(root).find((n) => n.fm.id === "projects/course-c")!.fm.facts!.room as FactRecord & { contested?: string };
const status = (root: string, id: string) => loadBrain(root).find((n) => n.fm.id === `disputes/${id}`)!.fm.status;

test("a conflict the Gardener is still weighing doesn't wait on the owner; once it leans, it does", () => {
  const { root, id } = brain();
  expect(ownerConflicts(root)).toHaveLength(0);
  expect(homeView(root, loadRules(root), loadBrain(root), new Date()).waiting).toHaveLength(0);
  lean(root, id);
  const w = homeView(root, loadRules(root), loadBrain(root), new Date()).waiting;
  expect(w).toEqual([{ what: "Course C's room is B-201. Or C-305?", verb: "tap to settle", href: `/settle/${id}`, meta: "Two sources disagree", parts: ["B-201", "C-305"] }]);
});

test("the screen asks one plain question, the Gardener's side first with its reason, then keep both", () => {
  const { root, id } = brain();
  lean(root, id);
  const c = ownerConflicts(root)[0]!;
  expect(question(c)).toBe("What is Course C's room?");
  expect(ordered(c).map((s) => s.value)).toEqual(["C-305", "B-201"]);
  const html = settlePage(c, "x", loadRules(root));
  expect(html).toContain("The Gardener leans this way: the calendar invite is the newer booking");
  expect(html).toContain("From calendar, 7 Oct");
  expect(html).toContain("From an email, 7 Oct");
  expect(html).toContain(SETTLE_COPY.both);
  expect(html.indexOf("C-305</b>")).toBeLessThan(html.indexOf("B-201</b>"));
});

test("a pick is one diary line, and its Undo opens the conflict again with the old value live", () => {
  const { root, id } = brain();
  lean(root, id);
  ownerDecide(root, id, 2, `settle-${id}`);
  expect(room(root).value).toBe("C-305");
  expect(status(root, id)).toBe("resolved");
  const row = readDiary(root).at(-1)!;
  expect(row).toMatchObject({ kind: "settled", fact_key: "projects/course-c#room", from: "B-201", to: "C-305", settles: id, source_word: "calendar" }); // a tap files at the side's rank (audit v4)
  const line = homeView(root, loadRules(root), loadBrain(root), new Date(), { all: true }).since.find((l) => l.token === row.undo_token)!;
  expect(line.what).toBe("You settled it: Course C's room is C-305.");
  expect(line.undo).toBe("undo");
  expect(undoFact(root, row.undo_token).outcome).toBe("undone");
  expect(room(root).value).toBe("B-201");
  expect(room(root).contested).toBe(id);
  expect(status(root, id)).toBe("open");
  expect(ownerConflicts(root).map((c) => c.id)).toEqual([id]);
});

test("not sure, keep both: nothing changes, the live value stops waiting and nothing asks", () => {
  const { root, id } = brain();
  lean(root, id);
  ownerKeepBoth(root, id);
  expect(room(root).value).toBe("B-201");
  expect(room(root).contested).toBeUndefined();
  expect(status(root, id)).toBe("kept-both");
  expect(ownerConflicts(root)).toHaveLength(0);
});

test("the dashboard: /settle/<id> shows the rows; a tap settles and goes back to the home (G631); a typed value is the owner's word", async () => {
  const H = "127.0.0.1:8793";
  const { root, id } = brain();
  lean(root, id);
  const d = dashboardHandler(root, { port: 8793, loginKey: "k".repeat(32) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
  const req = async (method: string, path: string, fields?: Record<string, string>) => {
    const body = fields ? new URLSearchParams(fields) : undefined;
    const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/home`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
    return { status: r.status, text: await r.text(), loc: r.headers.get("location") ?? "" };
  };
  const pg = await req("GET", `/settle/${id}`);
  expect(pg.status).toBe(200);
  expect(pg.text).toContain("What is Course C&#39;s room?");
  const csrf = pg.text.match(/name="csrf" value="([^"]+)"/)![1]!;
  const typed = await req("POST", "/action/settle-pick", { csrf, id, value: "110" });
  expect(typed.status).toBe(303);
  expect(typed.loc).toStartWith("/home?ok=");
  expect(room(root).value).toBe("110"); // a typed number is a value, never a side's number
  expect(room(root).verification).toBe("confirmed-by-owner");
  const gone = await req("GET", `/settle/${id}`);
  expect(gone.text).toContain(SETTLE_COPY.gone);
});

// The Mac's use-it check (2026-10-26): both real conflicts were still with the Gardener, so every
// /settle link said "Nothing to settle". A held one opens too, says the Gardener looks tonight, and
// can be answered now; home lists it quietly under the Gardener, never as waiting on you.
test("a conflict the Gardener hasn't weighed yet opens, says so, and can be answered now", async () => {
  const { root, id } = brain();
  const c = ownerConflict(root, id)!;
  expect(c.held).toBe(true);
  expect(settlePage(c, "x", loadRules(root))).toContain(esc(SETTLE_COPY.held));
  const v = homeView(root, loadRules(root), loadBrain(root), new Date());
  expect(v.waiting).toHaveLength(0);
  expect(v.gardener).toEqual([{ what: "Course C's room is B-201. Or C-305?", verb: "the Gardener looks tonight", href: `/settle/${id}`, meta: "Two sources disagree", parts: ["B-201", "C-305"] }]);
  ownerDecide(root, id, 2, `settle-${id}`);
  expect(room(root).value).toBe("C-305");
});

// The Mac's second check (2026-10-26): a real conflict showed 6 near-identical rows. The same value
// from several sources is one row that counts them; past two rows the third choice keeps them all.
test("the same value from several sources is one row with a count; past two rows, keep them all", () => {
  const { root, id } = brain();
  lean(root, id);
  const p = loadBrain(root).find((n) => n.fm.id === `disputes/${id}`)!;
  const cands = p.fm.candidates as FactRecord[];
  p.fm.candidates = [...cands, { ...cands[1]!, sources: ["gcal:e2@e2"] }, { ...cands[1]!, value: "c-305 ", sources: ["gcal:e3@e3"] }, { ...cands[0]!, value: "D-110", sources: ["gmail:f000000000000042"] }];
  saveNote(root, p);
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "more sides");
  const c = ownerConflict(root, id)!;
  expect(c.sides.map((s) => [s.value, s.sources])).toEqual([["B-201", 1], ["C-305", 3], ["D-110", 1]]);
  const html = settlePage(c, "x", loadRules(root));
  expect(html).toContain("From calendar, 7 Oct · 3 sources");
  expect(html).toContain(SETTLE_COPY.all);
  expect(html).not.toContain(SETTLE_COPY.both);
});

// Audit v4 (2026-10-26): a tap on a side was saved as the owner's word (rank 5), so a tap on the
// Gardener's lean outranked every later email. A tap files at the side's own rank, with the tap
// recorded (approved:); only a typed value is the owner's word.
test("a tap on a side keeps that side's rank; it is not the owner's word", async () => {
  const { sourceRank } = await import("../src/sources");
  const { isOwnerConfirmed } = await import("../src/owner");
  const { root, id } = brain();
  lean(root, id);
  ownerDecide(root, id, 2, `settle-${id}`);
  const r = room(root);
  expect(r.value).toBe("C-305");
  expect(isOwnerConfirmed(r.verification)).toBe(false);
  expect(r.verification).toBe("self-reported");
  expect(sourceRank(r)).toBeLessThan(5);
  expect(r.sources.map(String)).toContain("gcal:e1@e1");
  expect(r.sources.map(String).some((s) => s.startsWith(`approved:`))).toBe(true);
  expect(status(root, id)).toBe("resolved");
});

// The UTC clock in the next month while the owner's day is still in the last one (the hours each
// month boundary that UTC and Toronto differ; main's CI on 2026-11-01): the settle's row is in the
// owner's month's diary file, and its Undo still finds the settle.
test("a pick's Undo opens the conflict again when the clock is in the next month and the owner's day isn't", () => {
  const { root, id } = brain();
  lean(root, id);
  const was = process.env.PB_NOW;
  process.env.PB_NOW = "2026-11-01T02:00:00Z"; // makeBrain pins the owner's day to 2026-10-08
  try {
    ownerDecide(root, id, 2, `settle-${id}`);
    // The settle's own row: lean() above wrote the conflict's row at the real clock, which sorts
    // after PB_NOW once the real time passes it.
    const row = readDiary(root).filter((r) => r.kind === "settled").at(-1)!;
    expect(row.at.slice(0, 7)).not.toBe(process.env.PB_TODAY!.slice(0, 7));
    expect(undoFact(root, row.undo_token).outcome).toBe("undone");
    expect(room(root).value).toBe("B-201");
    expect(status(root, id)).toBe("open");
  } finally { if (was === undefined) delete process.env.PB_NOW; else process.env.PB_NOW = was; }
});

// Audit v9 (2026-10-31; G583): on the 30-day sign-in Settle printed a conflict whose live record is
// private (only the sides were weighed), and money-shaped values the home card withholds.
test("a conflict whose live record is private, or whose values are shaped like money, shows its sides only after a fresh sign-in (G583)", () => {
  const { root, id } = brain();
  lean(root, id);
  expect(ownerConflicts(root)[0]!.private).toBeUndefined();
  // The live record made private after the conflict opened.
  const n = loadBrain(root).find((x) => x.fm.id === "projects/course-c")!;
  (n.fm.facts!.room as FactRecord).sensitivity = "private";
  saveNote(root, n);
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: room private");
  expect(ownerConflicts(root)[0]!.private).toBe(true);
  // Money-shaped values on an everyday page.
  const m = brain();
  writeFileSync(join(m.root, "projects", "flat.md"), `---\nid: projects/flat\ntype: project\ntitle: Flat\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  next_step: { value: "pay the deposit of $1,200", as_of: 2026-10-07, sources: ["gmail:f000000000000042"], verification: verified-by-source, by: planner, recorded: 2026-10-07 }\n---\n`);
  sh(m.root, "git", "add", "-A"); sh(m.root, "git", "commit", "-qm", "owner: flat");
  expect(write(m.root, { agent: "planner", id: "projects/flat", attribute: "next_step", value: "pay the deposit of $1,350", as_of: "2026-10-07", sources: ["gcal:e2@e2"], verification: "self-reported" } as never, { acceptedBy: "auto-decide", contest: true }).outcome).toBe("disputed");
  const flat = loadBrain(m.root).filter((x) => x.fm.type === "dispute").find((x) => x.fm.fact_key === "projects/flat#next_step")!;
  const fid = String(flat.fm.id).split("/")[1]!;
  lean(m.root, fid);
  expect(ownerConflict(m.root, fid)!.private).toBe(true);
});

// Builder's audit of G590, 2026-11-01: Undo took the newest commit under diary/ whose count of
// the settle's token changed, so a later diary row carrying that token (a value naming it) made
// Undo answer Undone while putting back nothing. It takes the commit that added the settle line.
test("a pick's Undo finds the settle's own commit, not a later diary row that names its token", () => {
  const { root, id } = brain();
  lean(root, id);
  ownerDecide(root, id, 2, `settle-${id}`);
  const row = readDiary(root).at(-1)!;
  write(root, { agent: "planner", id: "projects/course-c", attribute: "status_note", value: `ref ${row.undo_token}`, as_of: "2026-10-07", sources: ["gcal:e2@e2"], verification: "self-reported" } as never, {});
  expect(readDiary(root).filter((r) => JSON.stringify(r).includes(row.undo_token)).length).toBeGreaterThan(1);
  expect(undoFact(root, row.undo_token).outcome).toBe("undone");
  expect(room(root).value).toBe("B-201");
  expect(status(root, id)).toBe("open");
});
