// SPDX-License-Identifier: AGPL-3.0-only
// The real-bar meter (backlog 215): consecutive days of use, days since the last hand fix, and the
// restore drill, as the digest line and an Overview tile. Hand fixes the hub can see are counted
// without the owner logging them: an edit committed to the brain outside pocketBrain, a hand
// restart of the hub, and the owner-run repair commands.
import { test, expect } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { bar, lastDays, measures, noteStart, noteStop, recordDrill, recordFix } from "../src/measure";
import { loadState } from "../src/dashboard/data";
import { overview } from "../src/dashboard/html";
import { deployOnce, type Effects } from "../scripts/deploy";

const line = (root: string, file: string, e: Record<string, unknown>) => { mkdirSync(join(root, file, ".."), { recursive: true }); appendFileSync(join(root, file), JSON.stringify(e) + "\n"); };
const used = (root: string, days: string[]) => { for (const d of days) line(root, "log/reads.jsonl", { at: `${d}T12:00:00Z`, agent: "planner", op: "context_pack", ids: ["*"] }); };
const fixes = (root: string) => existsSync(join(root, "log", "fixes.jsonl")) ? readFileSync(join(root, "log", "fixes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];

// A commit made the way a person makes one: their own git identity, on a given day.
function handCommit(root: string, at: string, msg: string, email = "me@example.org") {
  writeFileSync(join(root, `hand-${at.slice(0, 10)}.md`), "edited in a text editor\n");
  const env = { ...process.env, GIT_AUTHOR_NAME: "me", GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: "me", GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
  Bun.spawnSync(["git", "add", "-A"], { cwd: root, env });
  Bun.spawnSync(["git", "commit", "-q", "-m", msg], { cwd: root, env });
}

test("an edit committed to the brain by hand is a hand fix; pocketBrain's own commits and the first commit aren't", () => {
  const root = makeBrain();
  used(root, lastDays(10, "2026-10-20"));
  handCommit(root, "2026-10-17T15:00:00Z", "fix a typo in the dentist note");
  handCommit(root, "2026-10-18T15:00:00Z", "owner: something the hub would write", "owner@pocketbrain.local");
  const [m] = measures(root, ["2026-10-17"]);
  expect(m.fixes).toBe(1);
  expect(m.fixesWhat[0]).toMatch(/^hand edit: [0-9a-f]{7} fix a typo in the dentist note$/);
  expect(measures(root, ["2026-10-18"])[0].fixes).toBe(0);
  const b = bar(root, "2026-10-20");
  expect(b.days).toBe(3); // 18th to 20th
  expect(b.lastBreak?.date).toBe("2026-10-17");
  expect(bar(makeBrain(), "2026-10-20").lastBreak?.why ?? "").not.toContain("hand edit"); // the fixture's own first commit
});

test("days since the last hand fix, from the fix log and the hub's own detection, in the digest line", () => {
  const root = makeBrain();
  used(root, lastDays(10, "2026-10-20"));
  expect(bar(root, "2026-10-20").sinceFix).toBeUndefined();
  expect(bar(root, "2026-10-20").text).toContain("no hand fix yet");
  line(root, "log/fixes.jsonl", { at: "2026-10-12T09:00:00Z", what: "re-pasted the standing instruction", via: "cli" });
  handCommit(root, "2026-10-16T15:00:00Z", "fix a typo");
  line(root, "log/fixes.jsonl", { at: "2026-10-22T09:00:00Z", what: "after the end date", via: "cli" });
  const b = bar(root, "2026-10-20");
  expect(b.sinceFix).toMatchObject({ days: 4, date: "2026-10-16" });
  expect(b.text).toContain("4 days since the last hand fix");
  expect(b.text).not.toContain("last break 2026-10-16"); // the same fix isn't named twice
  used(root, ["2026-10-21"]);
  expect(bar(root, "2026-10-21").text).toContain("5 days since the last hand fix");
});

test("a self-check warning doesn't break the streak; a failing probe check does", () => {
  const root = makeBrain();
  used(root, lastDays(5, "2026-10-20"));
  line(root, "log/alerts.jsonl", { at: "2026-10-18T03:00:00Z", agent: "hub", check: "probe_warn_fill", from: "quiet source" });
  expect(bar(root, "2026-10-20").days).toBe(5);
  line(root, "log/alerts.jsonl", { at: "2026-10-19T03:00:00Z", agent: "hub", check: "probe_digest", from: "late" });
  expect(bar(root, "2026-10-20").days).toBe(1);
});

test("a hand restart of the hub is a hand fix; a reboot, an update, a crash or the menu's restart (already logged) aren't counted again", () => {
  const at = (t: string) => new Date(`2026-10-18T${t}:00Z`);
  const boot = at("00:00");
  // First start: nothing to compare with.
  const root = makeBrain();
  expect(noteStart(root, { now: at("01:00"), bootAt: boot })).toBeUndefined();
  // Stopped by a signal, started again on the same boot, no update: by hand.
  noteStop(root, "SIGTERM", at("02:00"));
  expect(noteStart(root, { now: at("02:01"), bootAt: boot })).toBe("the hub was restarted by hand");
  expect(fixes(root)).toMatchObject([{ at: "2026-10-18T02:01:00.000Z", what: "the hub was restarted by hand", via: "auto:restart" }]);
  // The machine rebooted in between.
  noteStop(root, "SIGTERM", at("03:00"));
  expect(noteStart(root, { now: at("03:05"), bootAt: at("03:02") })).toBeUndefined();
  // The updater restarted it to take a release.
  noteStop(root, "SIGTERM", at("04:00"));
  expect(noteStart(root, { now: at("04:01"), bootAt: boot, planned: at("03:59") })).toBeUndefined();
  // It crashed and launchd brought it back: no stop line, so no hand restart (the probe sees outages).
  expect(noteStart(root, { now: at("05:00"), bootAt: boot })).toBeUndefined();
  // The menu's Restart hub logged its own fix just before.
  noteStop(root, "SIGTERM", new Date(Date.now() - 1000));
  recordFix(root, "restarted the hub from the menu", "auto:menubar");
  expect(noteStart(root, { now: new Date(Date.now() + 1000), bootAt: new Date(0) })).toBeUndefined();
  expect(fixes(root).length).toBe(2);
});

test("a restart onto new code is an update, not a hand fix, whoever ran the kickstart", () => {
  const at = (t: string) => new Date(`2026-10-18T${t}:00Z`);
  const root = makeBrain();
  noteStart(root, { now: at("01:00"), bootAt: at("00:00"), build: "0.1.0@aaa1111" });
  noteStop(root, "SIGTERM", at("02:00"));
  expect(noteStart(root, { now: at("02:01"), bootAt: at("00:00"), build: "0.1.0@bbb2222" })).toBeUndefined(); // pulled a commit, then kickstart
  noteStop(root, "SIGTERM", at("03:00"));
  expect(noteStart(root, { now: at("03:01"), bootAt: at("00:00"), build: "0.1.0@bbb2222" })).toBe("the hub was restarted by hand"); // same code
  expect(fixes(root).length).toBe(1);
});

test("the updater leaves a mark before it restarts the hub, so the start isn't taken for a hand restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-deploy-mark-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
  const sh = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd, env });
  const origin = join(dir, "origin"), app = join(dir, "app");
  sh(dir, "init", "-q", "-b", "main", origin);
  writeFileSync(join(origin, "VERSION"), "0.1.0\n");
  sh(origin, "add", "-A"); sh(origin, "commit", "-q", "-m", "0.1.0"); sh(origin, "tag", "-a", "v0.1.0", "-m", "0.1.0"); sh(origin, "branch", "release");
  sh(dir, "clone", "-q", origin, app); sh(app, "checkout", "-q", "--detach", "v0.1.0");
  writeFileSync(join(origin, "VERSION"), "0.1.1\n");
  sh(origin, "commit", "-qam", "0.1.1"); sh(origin, "tag", "-a", "v0.1.1", "-m", "0.1.1"); sh(origin, "branch", "-f", "release", "v0.1.1");
  let markedFirst = false;
  const mark = join(dir, "deploy.restart");
  const fx: Effects = { install: () => true, restart: () => { markedFirst = existsSync(mark); return true; }, healthy: async () => true, log: () => {} };
  const s = await deployOnce({ app, fx, state: join(dir, "deploy.json"), hold: join(dir, "deploy.hold"), now: () => new Date("2026-10-18T04:00:00Z") });
  expect(s.status).toBe("deployed");
  expect(markedFirst).toBe(true);
  expect(readFileSync(mark, "utf8").trim()).toBe("2026-10-18T04:00:00.000Z");
});

test("owner-run repair commands log themselves as hand fixes", () => {
  const root = makeBrain();
  const cli = (...a: string[]) => Bun.spawnSync(["bun", "src/cli.ts", ...a], { cwd: join(import.meta.dir, ".."), env: { ...process.env, PB_BRAIN: root }, stdout: "pipe", stderr: "pipe" });
  expect(cli("hub", "replay").exitCode).toBe(0);
  expect(fixes(root)).toMatchObject([{ what: "ran pocketbrain hub replay by hand", via: "auto:hub-replay" }]);
  expect(cli("bar").exitCode).toBe(0); // reading isn't repairing
  expect(fixes(root).length).toBe(1);
});

test("the Overview has a real-use bar tile: days of use, days since the last hand fix, the restore drill", () => {
  const root = makeBrain();
  used(root, lastDays(6, "2026-10-20"));
  line(root, "log/fixes.jsonl", { at: "2026-10-14T09:00:00Z", what: "re-pasted the standing instruction", via: "cli" });
  const page = () => overview(loadState(root, new Date("2026-10-20T12:00:00Z")), "csrf").body;
  expect(page()).toContain("Real-use bar");
  expect(page()).toMatch(/Day 6<\/b> of 14/);
  expect(page()).toMatch(/6 days<\/b> since the last hand fix/);
  expect(page()).toContain("re-pasted the standing instruction");
  expect(page()).toContain("Restore drill: not run yet");
  recordDrill(root, true);
  expect(page()).toMatch(/Restore drill passed \d{4}-\d\d-\d\d/);
});
