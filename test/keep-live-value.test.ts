// SPDX-License-Identifier: AGPL-3.0-only
// Owner's re-audit, 2026-10-25: a capture that contradicts a held value froze the fact. The live
// value was replaced by { dispute, candidates }, so every assistant read "disputed, use neither" for
// up to 36 hours while the conflict waited for the Gardener. Now the live value stays on the page
// and for every reader; the conflict waits beside it (`contested`, a side field naming the packet)
// until someone picks (G425).
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain, isDisputed, type FactRecord } from "../src/brain";
import { write } from "../src/write";
import { ownerDecide } from "../src/core";
import { carve, grantFor } from "../src/carve";
import { loadRules } from "../src/rules";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
function brain() {
  const root = makeBrain();
  writeFileSync(join(root, "projects", "course-c.md"), `---\nid: projects/course-c\ntype: project\ntitle: Course C\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  room: { value: "B-201", as_of: 2026-10-07, sources: ["gmail:f000000000000041"], verification: verified-by-source, by: planner, recorded: 2026-10-07 }\n---\n`);
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: course c");
  return root;
}
const room = (root: string) => loadBrain(root).find((n) => n.fm.id === "projects/course-c")!.fm.facts!.room;
const contest = (root: string, value: string, src = "gcal:e1@e1") =>
  write(root, { agent: "planner", id: "projects/course-c", attribute: "room", value, as_of: "2026-10-07", sources: [src], verification: "self-reported" } as never, { acceptedBy: "auto-decide", contest: true });

test("a contradiction held for the Gardener keeps the live value for every reader, the conflict beside it", () => {
  const root = brain();
  const r = contest(root, "C-305");
  expect(r.outcome).toBe("disputed");
  const f = room(root);
  expect(isDisputed(f)).toBe(false);
  expect((f as FactRecord).value).toBe("B-201");
  expect((f as FactRecord & { contested?: string }).contested).toMatch(/^c-/);
  const packet = loadBrain(root).find((n) => n.fm.type === "dispute")!;
  expect((packet.fm.candidates as FactRecord[]).map((c) => c.value)).toEqual(["B-201", "C-305"]);
  expect(typeof packet.fm.gardener_first).toBe("string");
  // An assistant reading the note sees the live room, not "disputed".
  const rules = loadRules(root);
  const v = carve(loadBrain(root), rules, grantFor(rules, "steward")).visible.get("projects/course-c")!;
  expect(JSON.stringify(v.note.fm.facts?.room)).toContain("B-201");
  // A second contradiction joins the same conflict; the live value still stands.
  expect(contest(root, "D-110", "gcal:e2@e2").outcome).toBe("disputed");
  expect(loadBrain(root).filter((n) => n.fm.type === "dispute")).toHaveLength(1);
  expect((room(root) as FactRecord).value).toBe("B-201");
  // The owner's pick replaces it, and the marker goes.
  ownerDecide(root, (f as FactRecord & { contested: string }).contested, 2);
  const after = room(root) as FactRecord & { contested?: string };
  expect(after.value).toBe("C-305");
  expect(after.contested).toBeUndefined();
});

// Owner's re-audit, 2026-10-25: two proposals on one fact in one tick were both weighed against the
// same old note, so the second opened a conflict the Gardener never held and the log said "saved".
test("two captures on one fact in one tick: the first is saved, the second waits beside it as a held conflict", async () => {
  const YAML = (await import("yaml")).default;
  const { makeModel } = await import("../src/model");
  const { pullSource } = await import("../src/pull");
  const { runAuto } = await import("../src/filing");
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { cal: { kind: "gcal", fixture: "c.json" } } }));
  writeFileSync(join(root, "projects", "course-c.md"), `---\nid: projects/course-c\ntype: project\ntitle: Course C\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n---\n`);
  const ev = (id: string, line: string) => ({ id, etag: `"${id}"`, summary: "Planning", start: { dateTime: "2026-10-20T10:00:00Z" }, description: line, updated: "2026-10-07T00:00:00Z", calendar: "primary" });
  writeFileSync(join(root, "c.json"), JSON.stringify([ev("e1", "Course C (project) next_step: Book room B-201"), ev("e2", "Course C (project) next_step: Book room C-305")]));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: course c");
  const textOf = (p: string) => p.match(/<<<\n([\s\S]*?)\n>>>/)?.[1] ?? "";
  const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: (q: { prompt: string }) => JSON.stringify({ facts: [...textOf(q.prompt).matchAll(/^(.+?) \((\w+)\) (\w+): (.+)$/gm)].map(([line, entity, type, attribute, value]) => ({ entity, type, attribute, value, quote: line })) }) });
  await pullSource(root, "cal", { model });
  const done = runAuto(root, new Date());
  expect(done.map((d) => d.picked).sort()).toEqual(["held it as a conflict", "saved it"]);
  const f = loadBrain(root).find((n) => n.fm.id === "projects/course-c")!.fm.facts!.next_step as FactRecord;
  expect(isDisputed(f)).toBe(false);
  expect(f.contested).toMatch(/^c-/);
  const packet = loadBrain(root).find((n) => n.fm.type === "dispute")!;
  expect(typeof packet.fm.gardener_first).toBe("string");
});

// Owner's re-audit, 2026-10-25: the digest printed held conflicts with both values and "Answer with
// the number", bypassing the Gardener's hold.
test("the digest skips a conflict the Gardener holds, and lists one beside the owner's word without freezing it", async () => {
  const { digest } = await import("../src/digest");
  const root = brain();
  contest(root, "C-305");
  expect(digest(root).text).not.toContain("C-305");
  // A conflict with the owner's word asks at once, from its packet, the owner's value still live.
  const r2 = makeBrain();
  writeFileSync(join(r2, "projects", "course-c.md"), `---\nid: projects/course-c\ntype: project\ntitle: Course C\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  room: { value: "B-201", as_of: 2026-10-01, sources: ["owner:2026-10-01/msg-1"], verification: confirmed-by-owner, by: owner, recorded: 2026-10-01 }\n---\n`);
  sh(r2, "git", "add", "-A"); sh(r2, "git", "commit", "-qm", "owner: c");
  expect(write(r2, { agent: "planner", id: "projects/course-c", attribute: "room", value: "C-305", as_of: "2026-10-07", sources: ["gmail:f000000000000042"], verification: "verified-by-source" } as never).outcome).toBe("disputed");
  expect((room(r2) as FactRecord).value).toBe("B-201");
  expect(digest(r2).text).toMatch(/Dispute c-0001[^\n]*C-305/);
});

// Owner's re-audit, 2026-10-25: STREAM_PEER made a raw exact id a peer of a value the hub checked
// against its source, so a newer unchecked capture silently replaced a verified next step.
test("in a run of values a newer unchecked value never replaces a checked one: it waits beside it", () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "checks.yaml"), readFileSync(join(root, "rules", "checks.yaml"), "utf8").replace(/^(\s*next_step:\s*\{[^}]*?)merge:\s*\w+/m, "$1merge: latest"));
  writeFileSync(join(root, "projects", "course-c.md"), `---\nid: projects/course-c\ntype: project\ntitle: Course C\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  next_step: { value: "Grade the midterm", as_of: 2026-10-01, sources: ["gmail:f000000000000041"], verification: verified-by-source, by: planner, recorded: 2026-10-01 }\n---\n`);
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: c");
  const { attributeSpec } = require("../src/rules");
  expect(attributeSpec(loadRules(root), "project", "next_step").merge).toBe("latest");
  const r = write(root, { agent: "planner", id: "projects/course-c", attribute: "next_step", value: "Write the exam", as_of: "2026-10-07", sources: ["gcal:e1@e1"], verification: "self-reported" } as never, { acceptedBy: "auto-decide", contest: true });
  expect(r.outcome).toBe("disputed");
  const f = loadBrain(root).find((n) => n.fm.id === "projects/course-c")!.fm.facts!.next_step as FactRecord;
  expect(f.value).toBe("Grade the midterm");
  expect(f.contested).toMatch(/^c-/);
});

// Owner's re-audit, 2026-10-25: the early release read log/reads.jsonl, which the brain's git and
// backups don't keep; after a restore every held conflict waited the full 36 hours.
test("a Gardener pass that read a held conflict is stamped on its packet, so the release survives losing the local log", async () => {
  const { rmSync } = await import("node:fs");
  const { gardenerDisputes, listDisputes } = await import("../src/core");
  const root = brain();
  contest(root, "C-305");
  expect(listDisputes(root, "steward")).toEqual([]);
  gardenerDisputes(root, "gardener");
  rmSync(join(root, "log", "reads.jsonl"), { force: true });
  expect(listDisputes(root, "steward").map((d) => d.fact_key)).toEqual(["projects/course-c#room"]);
  const packet = loadBrain(root).find((n) => n.fm.type === "dispute")!;
  expect(typeof packet.fm.gardener_seen).toBe("string");
  expect(sh(root, "git", "status", "--porcelain", "disputes").stdout.toString()).toBe("");
  expect(sh(root, "git", "log", "-1", "--format=%B").stdout.toString()).toMatch(/^Why: \S/m);
  expect(sh(root, "git", "log", "-1", "--format=%B").stdout.toString()).toMatch(/^Why: the Gardener read c-\d+ \(projects\/course-c#room\)/m);
});

// Facts an older hub froze (the G416 shape) on the owner's real brain since 17:38 on 2026-10-25:
// the hub's start puts the live value back beside the waiting packet, as one hub commit with a why.
test("a fact frozen by an older hub gets its live value back at start, the conflict beside it", async () => {
  const { unfreezeHeld } = await import("../src/write");
  const root = brain();
  contest(root, "C-305");
  const id = (room(root) as FactRecord & { contested: string }).contested;
  // Rewrite it into the frozen shape an older hub left on disk.
  const p = join(root, "projects", "course-c.md");
  const packet = loadBrain(root).find((n) => n.fm.type === "dispute")!;
  const frozen = `  room: { dispute: ${id}, candidates: ${JSON.stringify(packet.fm.candidates)} }\n`;
  writeFileSync(p, readFileSync(p, "utf8").replace(/  room:[\s\S]*?\n(?=---)/, frozen));
  sh(root, "git", "commit", "-qam", "older hub");
  expect(isDisputed(room(root))).toBe(true);
  expect(unfreezeHeld(root)).toEqual(["projects/course-c#room"]);
  const f = room(root) as FactRecord & { contested?: string };
  expect(f.value).toBe("B-201");
  expect(f.contested).toBe(id);
  expect(sh(root, "git", "log", "-1", "--format=%an%n%B").stdout.toString()).toMatch(/^hub\n[\s\S]*^Why: /m);
  expect(unfreezeHeld(root)).toEqual([]);
});
