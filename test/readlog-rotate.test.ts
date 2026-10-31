// SPDX-License-Identifier: AGPL-3.0-only
// The read log stops growing forever (backlog row 324). Housekeeping moves whole months older than
// the window every reader needs (120 days: forgetting looks back 90, the week report 8 weeks) into
// log/reads-archive/YYYY-MM.jsonl. The archives and the live file are still one hash chain, so a
// removed or edited line anywhere shows; `explain` and the forgetting start date still see it all.
import { test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { appendChained, verifyChain, verifyReadLog, rotateReadLog, readEntries, readLogStart, READ_LOG_KEEP_DAYS } from "../src/readlog";
import { housekeeping } from "../src/growth";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const DAY = 86_400_000;
const live = (root: string) => join(root, "log", "reads.jsonl");
const archive = (root: string) => join(root, "log", "reads-archive");

// Four reads a day for `days` days, ending yesterday.
function history(root: string, days: number, opts: { skip?: (d: number) => boolean } = {}) {
  for (let d = days; d >= 1; d--) {
    if (opts.skip?.(d)) continue;
    for (let k = 0; k < 4; k++) appendChained(live(root), { at: new Date(NOW - d * DAY + k * 3_600_000).toISOString(), agent: k % 2 ? "planner" : "helper", op: "search", ids: [`notes/n${d}`], q: `day ${d}` });
  }
}
const lines = (f: string) => readFileSync(f, "utf8").split("\n").filter(Boolean);

test("old months move to the archive; the live file keeps the window and the chain holds across both", () => {
  const root = makeBrain();
  history(root, 400);
  const before = readEntries(root, { all: true });
  const r = rotateReadLog(root, { now: NOW });
  expect(r.moved).toBeGreaterThan(0);
  // Whole months only, named by month, oldest first.
  const months = readdirSync(archive(root)).filter((f) => f.endsWith(".jsonl")).sort();
  expect(months[0]).toBe("2025-09.jsonl");
  for (const m of months) for (const l of lines(join(archive(root), m))) expect(JSON.parse(l).at.slice(0, 7)).toBe(m.slice(0, 7));
  // Every line within the window stays live; nothing in the live file is from an archived month.
  const first = JSON.parse(lines(live(root))[0]).at;
  expect(Date.parse(first)).toBeLessThanOrEqual(NOW - READ_LOG_KEEP_DAYS * DAY);
  expect(first.slice(0, 7) > months.at(-1)!.slice(0, 7)).toBe(true);
  // Nothing lost or reordered, the chain verifies end to end, and the live file alone starts mid-chain.
  expect(readEntries(root, { all: true })).toEqual(before);
  expect(readEntries(root).length).toBe(lines(live(root)).length);
  expect(verifyReadLog(root)).toEqual({ entries: before.length, unchained: 0 });
  expect(verifyChain(live(root)).why).toBe("the start of the log is missing");
  // Appends continue the chain, and a second pass the same day has nothing to move.
  appendChained(live(root), { at: new Date(NOW).toISOString(), agent: "planner", op: "search", ids: [], q: "today" });
  expect(verifyReadLog(root).broken).toBeUndefined();
  expect(rotateReadLog(root, { now: NOW }).moved).toBe(0);
  // The archive is git-ignored like the live log, but backups carry it (untracked files go in).
  expect(Bun.spawnSync(["git", "-C", root, "check-ignore", "-q", `log/reads-archive/${months[0]}`]).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "-C", root, "ls-files", "--others"]).stdout.toString()).toContain(`log/reads-archive/${months[0]}`);
});

test("a removed or edited archived line, or a missing month, breaks the chain", () => {
  const root = makeBrain();
  history(root, 300);
  rotateReadLog(root, { now: NOW });
  const months = readdirSync(archive(root)).filter((f) => f.endsWith(".jsonl")).sort();
  const mid = join(archive(root), months[1]);
  const text = readFileSync(mid, "utf8");
  writeFileSync(mid, lines(mid).slice(1).join("\n") + "\n");
  expect(verifyReadLog(root).broken).toBeDefined();
  writeFileSync(mid, text.replace('"day ', '"dax '));
  expect(verifyReadLog(root).why).toBe("the line was edited");
  writeFileSync(mid, text);
  expect(verifyReadLog(root).broken).toBeUndefined();
  rmSync(join(archive(root), months.at(-1)!));
  expect(verifyReadLog(root).why).toBe("a line before it was removed or changed");
  rmSync(archive(root), { recursive: true });
  expect(verifyReadLog(root).why).toBe("the start of the log is missing");
});

test("a broken chain is never rotated: the evidence stays where it was", () => {
  const root = makeBrain();
  history(root, 300);
  const all = lines(live(root));
  all[10] = all[10].replace('"day ', '"dax ');
  writeFileSync(live(root), all.join("\n") + "\n");
  const r = rotateReadLog(root, { now: NOW });
  expect(r.moved).toBe(0);
  expect(r.skipped).toContain("chain");
  expect(existsSync(archive(root))).toBe(false);
  expect(lines(live(root))).toEqual(all);
});

test("a pass cut off after writing the archive is finished by the next one, with no line twice", () => {
  const root = makeBrain();
  history(root, 300);
  const original = readFileSync(live(root), "utf8");
  rotateReadLog(root, { now: NOW });
  const after = readEntries(root, { all: true });
  // As if it stopped before the live file was replaced: the archived lines are still live too.
  writeFileSync(live(root), original);
  expect(verifyReadLog(root).broken).toBeUndefined();
  expect(readEntries(root, { all: true })).toEqual(after);
  rotateReadLog(root, { now: NOW });
  expect(readEntries(root, { all: true })).toEqual(after);
  expect(verifyReadLog(root)).toEqual({ entries: after.length, unchained: 0 });
});

test("the last line always stays live, so a quiet log still chains its next read", () => {
  const root = makeBrain();
  history(root, 400, { skip: (d) => d < 200 });
  rotateReadLog(root, { now: NOW });
  expect(lines(live(root)).length).toBeGreaterThanOrEqual(1);
  appendChained(live(root), { at: new Date(NOW).toISOString(), agent: "planner", op: "search", ids: [] });
  expect(verifyReadLog(root).broken).toBeUndefined();
});

test("forgetting still sees when the log began, after its first months are archived", () => {
  const root = makeBrain();
  // Read daily a year ago, then nothing for months, then again lately: the live file starts late.
  history(root, 400, { skip: (d) => d < 300 && d > 30 });
  rotateReadLog(root, { now: NOW });
  expect(Date.parse(JSON.parse(lines(live(root))[0]).at)).toBeGreaterThan(NOW - 90 * DAY);
  expect(readLogStart(root)!.slice(0, 10)).toBe(new Date(NOW - 400 * DAY).toISOString().slice(0, 10));
});

test("the night's housekeeping archives the read log and says so", () => {
  const root = makeBrain();
  history(root, 300);
  const prev = process.env.PB_NOW;
  process.env.PB_NOW = new Date(NOW).toISOString();
  try {
    expect(housekeeping(root, { logDir: join(root, "no-hub-logs") })).toMatch(/archived \d+ read-log line\(s\)/);
  } finally { if (prev === undefined) delete process.env.PB_NOW; else process.env.PB_NOW = prev; }
  expect(existsSync(archive(root))).toBe(true);
});
