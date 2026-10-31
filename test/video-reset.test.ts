// SPDX-License-Identifier: AGPL-3.0-only
// The hackathon video's reset (scripts/video-reset.ts) rebuilds Robin's brain (a President's) the same way every take.
import { markSeen } from "../src/seen";
import { test, expect } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { join } from "node:path";
import { loadBrain } from "../src/brain";
import { loadRules } from "../src/rules";
import { carve, grantFor } from "../src/carve";
import * as core from "../src/core";
import { queueAftercheck, drainAftercheck } from "../src/aftercheck";
import type { Model } from "../src/model";

// The reset reads the real clock, like a take: no pinned PB_NOW or PB_TODAY from other tests.
const env = () => { const e: Record<string, string | undefined> = { ...process.env }; delete e.PB_NOW; delete e.PB_TODAY; return e; };
const run = (dir: string, ...more: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "..", "scripts", "video-reset.ts"), "--no-serve", ...more], { env: { ...env(), PB_VIDEO_DIR: dir } });

test("video reset --no-tripwire: the gardener's night happens, but no daytime attempt, no pause, no alert until --tripwire", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-video-"));
  const r = run(dir, "--no-tripwire");
  expect(r.exitCode).toBe(0);
  const brain = join(dir, "brain");
  expect(readdirSync(join(brain, "inbox")).filter((f) => f.includes("-gardener-")).length).toBe(2);
  expect(loadRules(brain).policy.agents.gardener.status).not.toBe("paused");
  const alerts = join(brain, "log", "alerts.jsonl");
  expect(existsSync(alerts) ? readFileSync(alerts, "utf8") : "").not.toContain("gardener_hours");
  // --tripwire sets it off later, on the brain as it is (the 1:25 shot).
  const trip = Bun.spawnSync(["bun", join(import.meta.dir, "..", "scripts", "video-reset.ts"), "--tripwire"], { env: { ...env(), PB_VIDEO_DIR: dir } });
  expect(trip.stdout.toString()).toContain("refused, outside its hours; paused");
  expect(loadRules(brain).policy.agents.gardener.status).toBe("paused");
  expect(readFileSync(alerts, "utf8")).toContain("gardener_hours");
});

test("video reset: Robin's brain, two gardener proposals and a duplicate meeting found, gardener paused, relay message held, same tokens on the next take", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-video-"));
  const first = run(dir);
  expect(first.exitCode).toBe(0);
  const brain = join(dir, "brain");
  expect(readdirSync(join(brain, "inbox")).filter((f) => f.includes("-gardener-")).length).toBe(2);
  expect(first.stdout.toString()).toContain("upkeep found possible-duplicate notes/exec-staff-recap");
  expect(first.stdout.toString()).toContain("retire notes/hiring-freeze decision -> inbox");
  const rules = loadRules(brain);
  expect(rules.policy.agents.gardener.status).toBe("paused");
  expect(readFileSync(join(brain, "log", "alerts.jsonl"), "utf8")).toContain("gardener_hours");
  expect(first.stdout.toString()).toContain("relay: town -> claude: held");
  const notes = loadBrain(brain);
  const sees = (a: string) => [...carve(notes, rules, grantFor(rules, a)).visible.keys()];
  for (const a of ["claude", "town", "claude-code", "alice"]) {
    expect(sees(a)).not.toContain("notes/board-feedback");
    expect(sees(a)).not.toContain("notes/acquisition-talks");
    expect(sees(a)).not.toContain("money/exec-comp");
    expect(sees(a)).not.toContain("notes/personnel-sales");
  }
  expect(sees("claude")).toContain("notes/exec-staff");
  expect(sees("claude")).not.toContain("notes/1on1-theo");
  expect(sees("town")).toContain("notes/1on1-theo");
  expect(sees("claude")).toContain("projects/board-prep");
  expect(sees("claude")).not.toContain("projects/reorg");
  expect(sees("town")).toContain("projects/vp-sales-hire");
  expect(sees("town")).not.toContain("projects/board-prep");
  expect(sees("claude-code").sort()).toEqual(["notes/1on1-priya", "people/priya-nair", "projects/platform-roadmap"]);
  expect(sees("alice")).toEqual(["projects/q4-launch"]);
  expect(notes.some((n) => n.fm.id === "money/main-bank" || n.fm.id === "projects/course-a")).toBe(false);
  const town = readFileSync(join(dir, "tokens", "town.txt"), "utf8");
  const second = run(dir);
  expect(second.exitCode).toBe(0);
  expect(readFileSync(join(dir, "tokens", "town.txt"), "utf8")).toBe(town);
  expect(second.stdout.toString()).not.toContain("new token");
  expect(existsSync(join(dir, "keep", "rules", "tokens.yaml"))).toBe(true);
}, 60_000);

test("video reset: a kept ask-to-see file adds to the never-list, it can't make deals askable", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-video-"));
  mkdirSync(join(dir, "keep"), { recursive: true });
  writeFileSync(join(dir, "keep", "ask-to-see.yaml"), "approver: dashboard\nnever: [money]\n");
  expect(run(dir).exitCode).toBe(0);
  const ats = loadRules(join(dir, "brain")).policy.ask_to_see as { never: string[]; max_per_day: number };
  expect(ats.never.sort()).toEqual(["deals", "money"]);
  expect(ats.max_per_day).toBe(50);
});

test("video brain: Priya's Claude Code writes a teammate's medical leave, the keywords miss it, Jev makes it private", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-video-"));
  expect(run(dir).exitCode).toBe(0);
  const brain = join(dir, "brain");
  const r = await core.remember(brain, "claude-code", { id: "projects/platform-roadmap", attribute: "staffing", value: "Sam Ortiz, the lead architect, is out two weeks in November for chemo; keep it quiet", as_of: "2026-01-05", source_type: "email", sources: ["gmail:f000000000000009"], verification: "verified-by-source" });
  expect(r.outcome).toBe("committed");
  const sees = () => { const rules = loadRules(brain); const c = carve(loadBrain(brain), rules, grantFor(rules, "claude-code")); return c.visible.has("projects/platform-roadmap") && !c.hiddenFacts.some((h) => h.key === "projects/platform-roadmap#staffing"); };
  // "chemo" is health-shaped, so the hub holds it from every assistant until the owner has seen it
  // (phone UI spec §7); the owner's Show lets it serve, and Jev's check still makes it private.
  expect(sees()).toBe(false);
  markSeen(brain, r.fact_key!);
  expect(sees()).toBe(true);
  queueAftercheck(brain, "claude-code", r.fact_key);
  const jev: Model = { config: { provider: "typesafe", model: "jev-latest", max_sensitivity: "personal" }, complete: async () => { throw new Error("unused"); }, decide: async () => ({ answers: { third_party_sensitive: { type: "noul", noul: 0.95 }, category: { type: "choice", choice: "health", confidence: 0.9 } }, provider: "typesafe", model: "jev-test" }) } as unknown as Model;
  const a = await drainAftercheck(brain, { conflicts: null, classify: jev });
  expect(a.raised).toHaveLength(1);
  expect(sees()).toBe(false);
  expect(Bun.spawnSync(["git", "log", "-1", "--format=%an %s"], { cwd: brain }).stdout.toString()).toContain("made private: projects/platform-roadmap#staffing");
});

test("video reset: with Alice kept as a coworker, the hub asks Auth0 about her every 5 seconds, and the checklist says whether she's blocked", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-video-"));
  mkdirSync(join(dir, "keep", "rules"), { recursive: true });
  writeFileSync(join(dir, "keep", "rules", "oauth.yaml"), YAML.stringify({ issuer: "https://example.us.auth0.com/", resource: "https://demo.example/mcp/oauth", owner_subject: "auth0|owner", coworkers: { "auth0|alice": { name: "Alice", agent: "alice" } } }));
  const r = run(dir);
  expect(r.exitCode).toBe(0);
  expect(YAML.parse(readFileSync(join(dir, "brain", "rules", "oauth.yaml"), "utf8")).coworker_check_s).toBe(5);
  expect(r.stdout.toString()).toContain("Alice leaving (offboarding): can't check");
});
