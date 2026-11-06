// SPDX-License-Identifier: AGPL-3.0-only
// One heartbeat ledger for every scheduled job (next-level R4, G691, G692): each job leaves its last
// run, outcome and time; the home says one line only when a job is late or failing; doctor, the
// week report and `pocketbrain jobs` read the same ledger.
import { test, expect } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { beat, readBeat, ledger, lateJobs, lateLine } from "../src/heartbeat";
import { recordJob, runJob } from "../src/start";
import { homeView } from "../src/dashboard/home";
import { homePage } from "../src/dashboard/html-app";
import { jobsSection } from "../src/dashboard/html";
import { loadRules } from "../src/rules";
import { loadBrain } from "../src/brain";
import { doctor } from "../src/doctor";
import { offsiteCopy } from "../src/offsite";
import { watchdogTick } from "../src/watchdog";

const H = 3_600_000;
const at = (iso: string) => new Date(iso);

test("a job's beat keeps when it ran, whether it worked and how long; a failure keeps the last good run (G691)", () => {
  const root = makeBrain();
  beat(root, "night", { ok: true, ms: 1234, now: at("2026-11-01T08:00:00Z") });
  beat(root, "night", { ok: false, error: "upkeep threw", now: at("2026-11-02T08:00:00Z") });
  const b = readBeat(root, "night")!;
  expect(b).toMatchObject({ job: "night", ok: false, error: "upkeep threw", ok_at: "2026-11-01T08:00:00.000Z", at: "2026-11-02T08:00:00.000Z" });
  // One file per job, so two processes beating at once never lose each other's line.
  beat(root, "watchdog", { ok: true });
  expect(readdirSync(join(root, "log", "heartbeats")).sort()).toEqual(["night.json", "watchdog.json"]);
  // A name that isn't a plain job name is never a path.
  beat(root, "../../etc", { ok: true });
  expect(ledger(root).map((x) => x.job)).toEqual(["night", "watchdog"]);
});

test("late means past the job's cadence since its last good run; failing means its last run failed; a job that never ran is neither", () => {
  const root = makeBrain();
  const now = at("2026-11-06T12:00:00Z");
  expect(lateJobs(root, now)).toEqual([]);
  beat(root, "night", { ok: true, now: new Date(now.getTime() - 50 * H) });
  beat(root, "digest", { ok: true, now: new Date(now.getTime() - 5 * H) });
  beat(root, "offsite", { ok: false, error: "can't list the folder", now: new Date(now.getTime() - 2 * H) });
  const late = lateJobs(root, now);
  expect(late.map((l) => [l.job, l.why])).toEqual([["night", "late"], ["offsite", "failed"]]);
  expect(lateLine(late, now)).toBe("Your night pass has not run for 2 days, and 1 more job is behind. Settings has the details.");
  expect(lateLine([], now)).toBeUndefined();
});

test("the home says one line only when a job is late, and it adds nothing to the count", () => {
  const root = makeBrain();
  const now = at("2026-11-06T12:00:00Z");
  const rules = loadRules(root), notes = loadBrain(root);
  beat(root, "night", { ok: true, now: new Date(now.getTime() - 2 * H) });
  const calm = homeView(root, rules, notes, now);
  expect(calm.late).toBeUndefined();
  expect(homePage(calm, "c")).not.toContain('class="late"');
  beat(root, "night", { ok: true, now: new Date(now.getTime() - 60 * H) });
  const v = homeView(root, rules, notes, now);
  expect(v.late).toBe("Your night pass has not run for 2 days. Settings has the details.");
  expect(v.waiting.length).toBe(calm.waiting.length);
  const html = homePage(v, "c");
  expect(html).toContain('<a class="late" role="status" href="/overview#jobs">Your night pass has not run for 2 days. Settings has the details.</a>');
  // Settings lists it with when it last worked.
  const s = jobsSection(root, now);
  expect(s).toContain('id="jobs"');
  expect(s).toContain("Night pass hasn&#39;t run for 2 days");
  expect(s).toContain("0 of 1 scheduled job on time");
});

test("the hub's daily jobs, the offsite copy and the watchdog all beat into the ledger (G692)", async () => {
  const root = makeBrain();
  expect(await runJob(root, "digest", () => "ok")).toBe("ok");
  expect(readBeat(root, "digest")?.ok).toBe(true);
  expect(readBeat(root, "digest")?.ms).toBeGreaterThanOrEqual(0);
  recordJob(root, "pull", new Error("sources.yaml doesn't parse"));
  expect(readBeat(root, "pull")).toMatchObject({ ok: false, error: "sources.yaml doesn't parse" });
  // The Sunday drill's runner leaves its beat to the child, which knows why it failed.
  recordJob(root, "drill", undefined);
  expect(readBeat(root, "drill")).toBeUndefined();
  const hang = () => new Promise<{ code: number; out: string }>(() => {});
  await offsiteCopy(root, "/nowhere", { from: join(root, "log"), timeoutMs: 50, run: hang });
  expect(readBeat(root, "offsite")?.ok).toBe(false);
  await watchdogTick(root, { url: "http://127.0.0.1:9", run: () => ({ code: 0, out: "" }), uid: 501, platform: "linux", fetch: (async () => new Response("ok")) as unknown as typeof fetch });
  expect(readBeat(root, "watchdog")?.ok).toBe(true);
});

test("doctor names each late or failing job, and says all are on time when they are", async () => {
  const root = makeBrain();
  beat(root, "digest", { ok: true });
  expect((await doctor(root, { offline: true })).some((f) => f.area === "jobs" && f.level === "ok" && /all 1 scheduled job/.test(f.text))).toBe(true);
  beat(root, "housekeeping", { ok: true, now: new Date(Date.now() - 72 * H) });
  const late = (await doctor(root, { offline: true })).filter((f) => f.area === "jobs" && f.level === "warn");
  expect(late.map((f) => f.text)).toEqual([expect.stringContaining("nightly housekeeping hasn't run for 3 days")]);
  expect(existsSync(join(root, "log", "heartbeats", "housekeeping.json"))).toBe(true);
});
