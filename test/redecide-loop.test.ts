// SPDX-License-Identifier: AGPL-3.0-only
// 30bfb0b4 live, 2026-11-08: one mail capture was filed by the hub 13 times in five days, once
// after nearly every hub start, each time with one commit and no line on the owner's home. At the
// start the hub put it back in the inbox as "accepted with nothing saved" (G431), because it
// compared the value word for word, while the write had found the same sentence said in other
// words already on the page (G662) and saved nothing new. The next tick filed it again. A capture
// the page holds in other words stays decided; one put back goes back once, and then waits for
// the owner, never filed by the hub again. The self-check counts any proposal the hub decided
// more than once.
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { reopenLostAccepts } from "../src/write";
import { runAuto, redecided } from "../src/filing";
import { silentFailureChecks } from "../src/probe";

const AFTER = new Date("2026-10-08T15:00:00Z");
const sh = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
const LIVE = "Grade the midterm exam for the whole class";
function brain(): string {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  const f = join(root, "projects", "course-a.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("value: Grade the midterm,", `value: "${LIVE}",`));
  mkdirSync(join(root, "inbox", "decided"), { recursive: true });
  mkdirSync(join(root, "inbox", "captures"), { recursive: true });
  writeFileSync(join(root, "inbox", "captures", "x.md"), "---\nvia: source\nsource_kind: gmail\nstatus: extracted\n---\n");
  return root;
}
const decided = (root: string, name: string, value: string) =>
  writeFileSync(join(root, "inbox", "decided", name), YAML.stringify({ proposed: "2026-10-08", by: "auto-decide", reason: "capture", checks: ["capture"], capture: "inbox/captures/x.md",
    request: { kind: "fact", agent: "steward", id: "projects/course-a", attribute: "next_step", value, as_of: "2026-10-01", sources: ["gmail:f000000000000003"], source_type: "email", confidence: "stated" },
    decided: "2026-10-08", decision: "accept", filed: "by the hub's write path with Undo; nobody approved it" }));
const commit = (root: string) => { sh(root, "add", "-A"); sh(root, "commit", "-qm", "owner: setup"); };
// What each hub start does, then the next minute's tick.
const restartAndTick = (root: string, now: Date) => { reopenLostAccepts(root); return runAuto(root, now); };

test("a capture the page holds in other words stays decided across restarts, and is never filed again", () => {
  const root = brain();
  const name = "2026-10-08-capture-reword01.yaml";
  decided(root, name, "Grade the midterm exams for the whole class");
  commit(root);
  expect(reopenLostAccepts(root)).toEqual([]);
  const filed = [0, 1, 2].flatMap((i) => restartAndTick(root, new Date(AFTER.getTime() + i * 3_600_000)));
  expect(filed.map((d) => d.key)).toEqual([]);
  expect(existsSync(join(root, "inbox", "decided", name))).toBe(true);
  expect(redecided(root, AFTER)).toEqual([]);
});

test("a capture put back as saving nothing goes back once, then waits for the owner: the hub never files it again", () => {
  const root = brain();
  const name = "2026-10-08-capture-lostval1.yaml";
  // A different value the page doesn't hold, and nothing in a conflict: put back by G431.
  decided(root, name, "Book the hall for the final exam");
  commit(root);
  expect(reopenLostAccepts(root)).toEqual([name]);
  expect(YAML.parse(readFileSync(join(root, "inbox", name), "utf8")).reopened).toBe("2026-10-08");
  const filed = [0, 1, 2].flatMap((i) => restartAndTick(root, new Date(AFTER.getTime() + i * 3_600_000)));
  expect(filed.map((d) => d.key)).toEqual([]);
  expect(existsSync(join(root, "inbox", name))).toBe(true);
});

test("a decided copy the hub already put back once is never put back again", () => {
  const root = brain();
  const name = "2026-10-08-capture-twice001.yaml";
  decided(root, name, "Book the hall for the final exam");
  const f = join(root, "inbox", "decided", name);
  writeFileSync(f, YAML.stringify({ ...YAML.parse(readFileSync(f, "utf8")), reopened: "2026-10-07" }));
  commit(root);
  expect(reopenLostAccepts(root)).toEqual([]);
  expect(existsSync(f)).toBe(true);
});

test("the self-check names a proposal the hub decided more than once, and not one it decided once or one the owner undid", () => {
  const root = brain();
  mkdirSync(join(root, "log"), { recursive: true });
  const row = (key: string, at: string, extra: Record<string, unknown> = {}) => JSON.stringify({ key, question: "q", picked: "saved it", why: "w", at, commit: "a".repeat(40), ...extra });
  writeFileSync(join(root, "log", "auto-decisions.jsonl"), [
    row("proposal:a.yaml", "2026-10-07T16:00:00.000Z"), row("proposal:a.yaml", "2026-10-08T06:00:00.000Z"), row("proposal:a.yaml", "2026-10-08T09:00:00.000Z"),
    row("proposal:b.yaml", "2026-10-08T06:00:00.000Z"),
    row("proposal:c.yaml", "2026-10-07T16:00:00.000Z", { commit: "c".repeat(40) }), JSON.stringify({ key: "proposal:c.yaml", undo_of: "c".repeat(40), at: "2026-10-07T27:00:00.000Z" }), row("proposal:c.yaml", "2026-10-08T06:00:00.000Z"),
    row("proposal:d.yaml", "2026-09-01T06:00:00.000Z"), row("proposal:d.yaml", "2026-09-02T06:00:00.000Z"),
  ].join("\n") + "\n");
  expect(redecided(root, AFTER)).toEqual([{ key: "proposal:a.yaml", times: 3 }]);
  const c = silentFailureChecks(root, AFTER).find((x) => x.name === "redecided")!;
  expect([c.ok, c.detail]).toEqual([false, "1 proposal decided by the hub more than once in the last week (most: 3 times)"]);
  expect(c.detail).not.toContain("a.yaml");
});
