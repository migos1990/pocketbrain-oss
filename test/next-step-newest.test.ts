// SPDX-License-Identifier: AGPL-3.0-only
// `pocketbrain next-steps newest` (docs/wiki.md, "Facts that follow each other"): one owner command
// that marks next_step `merge: latest` in rules/checks.yaml, so a newer next step from the calendar
// files itself over an older one from mail instead of waiting as a conflict card.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, type FactRecord } from "../src/brain";
import { makeModel, type ModelRequest } from "../src/model";
import { pullSource } from "../src/pull";
import { runAuto } from "../src/filing";
import { setNextStepNewest } from "../src/ownerset";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
const textOf = (p: string) => p.match(/<<<\n([\s\S]*?)\n>>>/)?.[1] ?? "";
const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => JSON.stringify({ facts: [...textOf(r.prompt).matchAll(/^(.+?) \((\w+)\) (\w+): (.+)$/gm)].map(([line, entity, type, attribute, value]) => ({ entity, type, attribute, value, quote: line })) }) });
const event = (id: string, line: string) => ({ id, etag: `"${id}"`, summary: "Planning", start: { dateTime: "2026-10-20T10:00:00Z" }, description: line, updated: "2026-10-07T00:00:00Z", calendar: "primary" });
const git = (root: string, ...a: string[]) => sh(root, "git", ...a).stdout.toString().trim();
const checks = (root: string) => YAML.parse(readFileSync(join(root, "rules", "checks.yaml"), "utf8"));

// Course C holds a next step from mail; the calendar then proposes a newer one.
async function withCourse(verification: string) {
  const root = brain();
  writeFileSync(join(root, "c.json"), JSON.stringify([event("e1", "Course C (project) next_step: Book the exam room B-201")]));
  await pullSource(root, "cal", { model });
  writeFileSync(join(root, "projects", "course-c.md"), `---\nid: projects/course-c\ntype: project\ntitle: Course C\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  next_step: { value: Write the exam, as_of: 2026-10-01, sources: ["gmail:f000000000000031"], verification: ${verification}, by: planner, recorded: 2026-10-01 }\n---\n`);
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "course c");
  return root;
}

function brain() {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { cal: { kind: "gcal", fixture: "c.json" } } }));
  writeFileSync(join(root, "c.json"), "[]");
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: sources");
  return root;
}

test("next-steps newest: a newer calendar next step that was a conflict files itself, the old one kept in history", async () => {
  const root = await withCourse("self-reported");
  const now = new Date();

  const before = readFileSync(join(root, "rules", "checks.yaml"), "utf8");
  expect(setNextStepNewest(root)).toBe("rules/checks.yaml: next_step keeps the newest (1 kind)");
  const after = readFileSync(join(root, "rules", "checks.yaml"), "utf8");
  // Only that line changed: shelf life and every other key as they were.
  expect(after).toBe(before.replace("next_step: { merge: replace, shelf_life: 14d }", "next_step: { merge: latest, shelf_life: 14d }"));
  expect(git(root, "log", "-1", "--format=%s")).toBe("owner: next_step keeps the newest (1 kind) (rules/checks.yaml)");

  const done = runAuto(root, now);
  expect(done.length).toBe(1);
  const n = loadBrain(root).find((x) => x.fm.id === "projects/course-c")!;
  expect((n.fm.facts!.next_step as FactRecord).value).toBe("Book the exam room B-201");
  expect(n.fm.history!.next_step!.map((h) => h.value)).toEqual(["Write the exam"]);
});

// G425: an unchecked id, however new, never replaces a next step the hub checked at its source;
// it waits beside the live value for the Gardener, and readers keep the checked one.
test("next-steps newest: a newer unchecked next step waits beside one the hub checked; the checked one stays live", async () => {
  const root = await withCourse("verified-by-source");
  setNextStepNewest(root);
  expect(runAuto(root, new Date()).map((d) => d.picked)).toEqual(["held it as a conflict"]);
  const f = loadBrain(root).find((x) => x.fm.id === "projects/course-c")!.fm.facts!.next_step as FactRecord;
  expect(f.value).toBe("Write the exam");
  expect(f.contested).toBeTruthy();
});

test("next-steps newest: a newer value from a weaker source than the held one is a conflict, never called saved", async () => {
  const root = await withCourse("verified-by-source");
  setNextStepNewest(root);
  const f = join(root, "inbox", readdirSync(join(root, "inbox")).find((x) => x.endsWith(".yaml"))!);
  const d = YAML.parse(readFileSync(f, "utf8"));
  d.request.confidence = "inferred";
  writeFileSync(f, YAML.stringify(d)); sh(root, "git", "commit", "-qam", "inferred");
  expect(runAuto(root, new Date()).map((x) => x.picked)).toEqual(["held it as a conflict"]);
  expect((loadBrain(root).find((x) => x.fm.id === "projects/course-c")!.fm.facts!.next_step as { contested?: string }).contested).toBeTruthy();
});

test("next-steps newest: run twice says so and commits nothing; a kind without next_step is left alone", () => {
  const root = brain();
  const p = join(root, "rules", "checks.yaml");
  const c = checks(root);
  c.types.course = { attributes: { next_step: { merge: "replace", shelf_life: "7d" } } };
  writeFileSync(p, YAML.stringify(c)); sh(root, "git", "commit", "-qam", "owner: course");
  expect(setNextStepNewest(root)).toBe("rules/checks.yaml: next_step keeps the newest (2 kinds)");
  const t = checks(root).types;
  expect([t.project.attributes.next_step, t.course.attributes.next_step]).toEqual([{ merge: "latest", shelf_life: "14d" }, { merge: "latest", shelf_life: "7d" }]);
  expect(t.person.attributes.next_step).toBeUndefined();
  const head = git(root, "rev-parse", "HEAD");
  expect(setNextStepNewest(root)).toBe("rules/checks.yaml already has next_step keeps the newest");
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
});

test("next-steps newest from the CLI: prints the line; a replica is told to run it on the hub", () => {
  const CLI = join(import.meta.dir, "..", "src", "cli.ts");
  const cli = (root: string) => Bun.spawnSync(["bun", CLI, "next-steps", "newest"], { env: { ...process.env, PB_BRAIN: root } });
  const root = brain();
  const r = cli(root);
  expect([r.exitCode, r.stdout.toString().trim()]).toEqual([0, "rules/checks.yaml: next_step keeps the newest (1 kind)"]);
  const rep = brain();
  writeFileSync(join(rep, "rules", "hub.yaml"), "hub: laptop\nepoch: 1\nreplicas:\n  laptop: {}\n  home: {}\n");
  sh(rep, "git", "add", "-A"); sh(rep, "git", "commit", "-qm", "owner: hub");
  process.env.PB_REPLICA = "home";
  try { const x = cli(rep); expect([x.exitCode, x.stderr.toString()]).toEqual([1, expect.stringContaining("on the hub")]); } finally { delete process.env.PB_REPLICA; }
  expect(checks(rep).types.project.attributes.next_step.merge).toBe("replace");
});
