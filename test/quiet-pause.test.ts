// SPDX-License-Identifier: AGPL-3.0-only
// Mac 2026-11-08/09: one assistant stopped reading on 4 Nov, and the self-check's `connections`
// line repeated "its token or connection may need a reconnect" with nothing to do about it; the
// early-warning lines (filed_lines, source_cap) reached the owner as alerts and as Mac
// notifications from the watchdog, though their docs call them early warnings (G747). The quiet
// line now says what to do (reconnect, or pause it), a paused assistant drops out of the line and
// the counts with nothing deleted and comes back on resume, and only a promoted check can notify:
// a check the probe doesn't list as notifying (a new detector) is recorded and shown, never sent.
import { test, expect } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { selfChecks, record, jobChecks, NOTIFY, REPORT_ONLY } from "../src/probe";
import { setAgentStatus } from "../src/dashboard/actions";
import { quietAssistants, quietWords } from "../src/quiet";
import { loadRules } from "../src/rules";
import { watchdogTick } from "../src/watchdog";
import { issueToken } from "../src/auth";

const NOW = new Date("2026-11-09T18:00:00Z");
const alerts = (root: string) => existsSync(join(root, "log", "alerts.jsonl")) ? readFileSync(join(root, "log", "alerts.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).check as string) : [];
function quietBrain(): string {
  const root = makeBrain();
  mkdirSync(join(root, "log"), { recursive: true });
  // planner read most days until 4 Nov, then nothing.
  const reads = Array.from({ length: 10 }, (_, i) => JSON.stringify({ at: new Date(Date.parse("2026-11-04T12:00:00Z") - i * 86_400_000).toISOString(), agent: "planner", note: "projects/course-a" }));
  writeFileSync(join(root, "log", "reads.jsonl"), reads.join("\n") + "\n");
  return root;
}
const connections = (root: string) => selfChecks(root, NOW).find((c) => c.name === "connections");

test("the quiet-assistant line says what to do: reconnect it, or pause it", () => {
  const root = quietBrain();
  const c = connections(root)!;
  expect(c.ok).toBe(false);
  expect(quietWords({ agent: "planner", last: "2026-11-04T12:00:00.000Z", days: 5, usualHours: 24 })).toBe("Last read 5 days ago; it used to read about every day. Reconnect it, or pause it on its page in Settings if you don't use it now");
  expect(c.detail).toBe("planner hasn't read the brain since 2026-11-04: reconnect it, or pause it if you don't use it now (Pause on its page in Settings, or pocketbrain agent pause planner)");
});

test("a paused assistant drops out of the line and the counts, nothing is deleted, and resume brings it back", () => {
  const root = quietBrain();
  issueToken(root, "planner");
  const reads = readFileSync(join(root, "log", "reads.jsonl"), "utf8"), tokens = readFileSync(join(root, "rules", "tokens.yaml"), "utf8");
  expect(quietAssistants(root, loadRules(root), NOW).map((q) => q.agent)).toContain("planner");
  setAgentStatus(root, "planner", "paused");
  expect(connections(root)).toBeUndefined();
  expect(quietAssistants(root, loadRules(root), NOW).map((q) => q.agent)).not.toContain("planner");
  expect(readFileSync(join(root, "log", "reads.jsonl"), "utf8")).toBe(reads);
  expect(readFileSync(join(root, "rules", "tokens.yaml"), "utf8")).toBe(tokens);
  expect(loadRules(root).policy.agents.planner?.slices).toEqual(["area:work", "contacts-basic"]);
  setAgentStatus(root, "planner", "active");
  expect(connections(root)?.ok).toBe(false);
  expect(quietAssistants(root, loadRules(root), NOW).map((q) => q.agent)).toContain("planner");
});

test("only a promoted check notifies: an early warning or a check no one promoted is recorded, never alerted", () => {
  const root = makeBrain();
  const fresh = record(root, [
    { name: "disk", ok: false, detail: "100 MB free" },
    { name: "filed_lines", ok: false, warn: true, detail: "1 filing left no line" },
    { name: "brand_new_detector", ok: false, detail: "something" },
  ], NOW);
  expect(fresh.map((c) => c.name)).toEqual(["disk", "filed_lines", "brand_new_detector"]);
  expect(alerts(root)).toEqual(["probe_disk"]);
  const probe = JSON.parse(readFileSync(join(root, "log", "probe.json"), "utf8"));
  expect(Object.keys(probe).sort()).toEqual(["brand_new_detector", "disk", "filed_lines"]);
});

test("the watchdog's Mac notification is for promoted checks only", async () => {
  const root = quietBrain();
  // A filing with no diary line: filed_lines, an early warning, fails beside connections.
  writeFileSync(join(root, "log", "auto-decisions.jsonl"), JSON.stringify({ key: "proposal:x.yaml", question: "q", picked: "saved it", why: "w", at: new Date(NOW.getTime() - 3_600_000).toISOString(), commit: "a".repeat(40) }) + "\n");
  expect(jobChecks(root, NOW).filter((c) => !c.ok).map((c) => c.name)).toEqual(expect.arrayContaining(["connections", "filed_lines"]));
  const said: string[] = [];
  await watchdogTick(root, { url: "http://127.0.0.1:8787", run: () => ({ code: 0, out: "" }), uid: 501, fetch: (async () => new Response("{}")) as unknown as typeof fetch, platform: "darwin", now: NOW, notify: (t) => said.push(t), tailscale: () => ({ code: 1, out: "" }) });
  expect(said.some((t) => t.includes("hasn't read the brain"))).toBe(true);
  expect(said.some((t) => t.includes("left no line"))).toBe(false);
});

test("every check the probe can raise is either promoted or report-only, never both", () => {
  const src = readdirSync(join(import.meta.dir, "..", "src")).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(import.meta.dir, "..", "src", f), "utf8")).join("\n");
  const named = new Set([...src.matchAll(/\{ ?name: "([a-z_]+)", ok:/g)].map((m) => m[1]!));
  for (const n of named) expect([n, NOTIFY.has(n) || REPORT_ONLY.has(n)]).toEqual([n, true]);
  for (const n of NOTIFY) expect([n, REPORT_ONLY.has(n)]).toEqual([n, false]);
  for (const n of ["filed_lines", "source_cap", "tailnet", "auto_saves"]) expect(REPORT_ONLY.has(n)).toBe(true);
});
