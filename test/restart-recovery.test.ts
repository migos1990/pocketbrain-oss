// SPDX-License-Identifier: AGPL-3.0-only
// Restart recovery (backlog row 253): a hub killed in the middle of a job that saves interim state
// (launchd kickstart, power cut) must find that state again when it starts. The job finishes on
// the next pass or is surfaced to the owner; it is never silently lost. Each test leaves on disk
// exactly what a kill -9 at the named point leaves (a job whose model call never returns, then the
// process "dies": its promise is dropped), then runs the next pass as a restarted hub would.
import { test, expect, afterAll } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { makeModel, type Model, type ModelRequest } from "../src/model";
import { useCaptureModel, captureModel, extractPending, readCapture, storeCapture } from "../src/capture";
import { pullSource } from "../src/pull";
import { appendChained } from "../src/readlog";
import { loadBrain, saveNote } from "../src/brain";
import * as ms from "../src/memsync";
import { askToSee, listAsks, pollAsks, restartAsks, type Approver } from "../src/asks";
import { appendFileSync } from "node:fs";
import * as core from "../src/core";
import { pendingChecks, queueAftercheck, requeueMissed } from "../src/aftercheck";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } }).stdout.toString().trim();
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterAll(() => useCaptureModel());
// A model call that never returns: the hub is killed while it waits.
const hung = (): Model => ({ config: { provider: "fake", model: "hung" } as Model["config"], complete: () => new Promise(() => {}) });
const extracting = (seen: string[]) => makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => {
  seen.push(r.prompt);
  return JSON.stringify({ facts: /exam room B-201/.test(r.prompt) ? [{ entity: "Course A", type: "project", attribute: "next_step", value: "Book the exam room B-201", quote: "book the exam room B-201" }] : [] });
} });
const proposals = (root: string) => existsSync(join(root, "inbox")) ? readdirSync(join(root, "inbox")).filter((f) => f.includes("-capture-")) : [];
const captures = (root: string) => existsSync(join(root, "inbox", "captures")) ? readdirSync(join(root, "inbox", "captures")).filter((f) => f.endsWith(".md")) : [];

function pullBrain() {
  const root = makeBrain();
  writeFileSync(join(root, "slack.json"), JSON.stringify([{ team: "T1", channel: "C9", channel_name: "#course-a", ts: "1760300000.000100", user: "U1", text: "Could someone book the exam room B-201 for the final" }]));
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { "slack-work": { kind: "slack", where: ["#course-a"], area: "work", fixture: "slack.json" } } }));
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-qm", "louis: sources");
  return root;
}

test("pull: killed during extraction, the next pull extracts the item instead of calling it a duplicate", async () => {
  const root = pullBrain();
  void pullSource(root, "slack-work", { model: hung() });
  await pause(300);
  expect(captures(root).length).toBe(1); // the interim record a kill leaves behind
  // The restarted hub's capture pass runs first: it must not mark the item done from a record
  // that holds only the ref (the text stays in the source).
  const seenByCapture: string[] = [];
  await extractPending(root, extracting(seenByCapture));
  expect(seenByCapture.length).toBe(0);
  const seen: string[] = [];
  const r = await pullSource(root, "slack-work", { model: extracting(seen) });
  expect(r.refused).toBeUndefined();
  expect(seen.some((p) => p.includes("exam room B-201"))).toBe(true);
  expect(proposals(root).length).toBe(1);
  expect(captures(root).length).toBe(1);
  expect(readCapture(root, `inbox/captures/${captures(root)[0]}`).status).toBe("extracted");
});

// ---------- memsync: a correction stuck between two log lines ----------

// What a kill between two log lines leaves: the first line, not the second.
const logged = (root: string, e: Record<string, unknown>) => appendChained(join(root, "log", "memsync.jsonl"), { at: new Date().toISOString(), ...e });
const OLD = { as_of: "2026-06-01", sources: ["gmail:f000000000000009"], verification: "verified-by-source" as const, by: "planner", recorded: "2026-06-01" };
function driftBrain() {
  process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-"));
  const root = makeBrain();
  const jane = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
  jane.fm.history = { role: [{ value: "Teaching assistant", ...OLD }] };
  saveNote(root, jane);
  return root;
}
function memoryFile(root: string) {
  const dir = mkdtempSync(join(tmpdir(), "pb-mem-"));
  const f = join(dir, "people.md");
  writeFileSync(f, "Jane Roy\n- role: Teaching assistant\n");
  const p = join(root, "rules", "policy.yaml");
  const pol = YAML.parse(readFileSync(p, "utf8"));
  pol.agents.planner.memory = { files: [dir] };
  writeFileSync(p, YAML.stringify(pol));
  const [found] = ms.scan(root, "planner");
  return { f, id: found.correction! };
}
const corr = (root: string, id: string) => ms.state(root).corrections.find((c) => c.id === id)!;

test("memsync: killed after an agent applied a fix but before its recheck was asked, the next pass asks it", () => {
  const root = driftBrain();
  const [q] = ms.quiz(root, "helper", 1, ["people/jane-roy#role"]);
  ms.memoryReply(root, "helper", { answers: [{ id: q.id, answer: "Teaching assistant" }] });
  const id = ms.state(root).corrections[0].id;
  ms.approve(root, id);
  ms.memoryCheck(root, "helper"); // delivered
  logged(root, { ev: "applied", id }); // the hub stopped before quiz(..., [key], id)
  expect(ms.state(root).quizzes.filter((x) => x.recheck === id)).toHaveLength(0);
  ms.resumeCorrections(root);
  const re = ms.state(root).quizzes.filter((x) => x.recheck === id && x.state === "open");
  expect(re).toHaveLength(1);
  ms.resumeCorrections(root); // a second pass asks nothing more
  expect(ms.state(root).quizzes.filter((x) => x.recheck === id)).toHaveLength(1);
  ms.memoryReply(root, "helper", { answers: [{ id: re[0].id, answer: "Course coordinator" }] });
  expect(corr(root, id).state).toBe("verified");
});

test("memsync: killed after the owner approved a memory-file fix but before the file was written, the next pass writes it", () => {
  const root = driftBrain();
  const { f, id } = memoryFile(root);
  logged(root, { ev: "approved", id, issued: new Date().toISOString(), signature: "x" }); // stopped before applyFile
  expect(readFileSync(f, "utf8")).toContain("Teaching assistant");
  ms.resumeCorrections(root);
  expect(readFileSync(f, "utf8")).toBe("Jane Roy\n- role: Course coordinator\n");
  expect(corr(root, id).state).toBe("verified");
});

test("memsync: killed after the file was written but before it was logged, the next pass verifies it instead of calling it changed", () => {
  const root = driftBrain();
  const { f, id } = memoryFile(root);
  logged(root, { ev: "approved", id, issued: new Date().toISOString(), signature: "x" });
  writeFileSync(`${f}.pb-bak-${id}`, readFileSync(f, "utf8"));
  writeFileSync(f, "Jane Roy\n- role: Course coordinator\n"); // written; "applied" never logged
  ms.resumeCorrections(root);
  expect(corr(root, id).state).toBe("verified");
  expect(readFileSync(f, "utf8")).toBe("Jane Roy\n- role: Course coordinator\n");
});

// ---------- ask_to_see: the phone push sent, its ref never logged ----------

const MOM = `---
id: people/mom
type: person
title: Mom
area: personal
sensitivity: private
status: active
created: 2026-10-01
updated: 2026-10-01
by: steward
facts:
  appointment: { value: "Cardiology, Oct 14 at 9:30", as_of: 2026-10-01, sources: ["gcal:evt-fake-1"], verification: verified-by-source, by: steward, recorded: 2026-10-01 }
---
Mom's appointments.
`;

test("ask_to_see: killed after the ask was logged but before its phone push was, the restarted hub sends the push again", async () => {
  const root = makeBrain();
  writeFileSync(join(root, "people/mom.md"), MOM);
  appendFileSync(join(root, "rules/policy.yaml"), "\nask_to_see: { never: [money] }\n");
  const pushes: string[] = [];
  let answer: "waiting" | "approved" = "waiting";
  const guardian: Approver = { name: "guardian", async start(_r, a) { pushes.push(a.id); return { ref: `req-${pushes.length}` }; }, async poll() { return { state: answer, by: "owner" }; } };
  // A first ask, by a hub that then dies inside the push: its own run writes the "asked" line.
  const hung: Approver = { ...guardian, start: () => new Promise(() => {}) };
  void askToSee(root, "helper", { what: "Mom's appointment", why: "book a taxi" }, hung);
  await pause(100);
  const [a] = listAsks(root);
  expect(a.candidates.length).toBe(1);
  expect(a.ref).toBeUndefined();
  // This hub is still waiting on its own push: no second one.
  await pollAsks(root, guardian);
  expect(pushes).toHaveLength(0);
  // The restart: the same log, read by a new process.
  restartAsks();
  await pollAsks(root, guardian);
  expect(pushes).toEqual([a.id]);
  expect(listAsks(root)[0].ref).toBe("req-1");
  await pollAsks(root, guardian);
  expect(pushes).toHaveLength(1); // once
  answer = "approved";
  await pollAsks(root, guardian);
  expect(listAsks(root)[0].state).toBe("approved");
});

// ---------- aftercheck: the write committed, its check never queued ----------

test("aftercheck: killed between a write's commit and its queue line, the night queues the check", () => {
  const root = makeBrain();
  // core.remember commits; the server queues the check right after (rememberThenCheck). Stop between.
  const r = core.remember(root, "planner", { id: "projects/course-a", attribute: "next_step", value: "Post the slides", as_of: "2026-10-08", sources: ["gmail:f000000000000006"], verification: "verified-by-source" });
  expect(r.outcome).toBe("committed");
  expect(pendingChecks(root)).toHaveLength(0);
  expect(requeueMissed(root)).toEqual([r.fact_key!]);
  expect(pendingChecks(root).map((p) => p.key)).toEqual([r.fact_key!]);
  expect(requeueMissed(root)).toEqual([]); // once
  // A write whose check was queued, as the server does, is left alone.
  const r2 = core.remember(root, "planner", { id: "projects/course-a", attribute: "next_room", value: "B-201", as_of: "2026-10-08", sources: ["gmail:f000000000000007"], verification: "verified-by-source" });
  queueAftercheck(root, "planner", r2.fact_key);
  expect(requeueMissed(root)).toEqual([]);
});

// ---------- capture extraction: already resumes; pinned here ----------

test("capture: killed during extraction, or after its proposal but before it was marked done, the next pass finishes it once", async () => {
  const root = makeBrain();
  const s = storeCapture(root, { kind: "text", text: "Reminder: book the exam room B-201 for the final." }, { via: "mail", by: "steward" });
  expect(s.outcome).toBe("stored");
  void extractPending(root, hung());
  await pause(100);
  expect(readCapture(root, s.file!).status).toBe("pending"); // a kill here leaves it pending
  const seen: string[] = [];
  await extractPending(root, extracting(seen));
  expect(readCapture(root, s.file!).status).toBe("extracted");
  expect(proposals(root)).toHaveLength(1);
  // Killed after the proposal was written but before the status line: the next pass redoes it
  // and the proposal merges into the one already waiting.
  const raw = readFileSync(join(root, s.file!), "utf8");
  expect(raw).toMatch(/^status: extracted$/m);
  writeFileSync(join(root, s.file!), raw.replace(/^status: extracted$/m, "status: pending"));
  await extractPending(root, extracting(seen));
  expect(readCapture(root, s.file!).status).toBe("extracted");
  expect(proposals(root)).toHaveLength(1);
});
