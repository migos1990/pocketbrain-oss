// SPDX-License-Identifier: AGPL-3.0-only
// One clock (backlog 273, src/clock.ts): per-day rules count the owner's day (owner.timezone),
// not UTC's. In Toronto the UTC day turns at 20:00 (EDT), so each case straddles that.
import { test, expect, afterEach, beforeEach, setSystemTime } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadRules } from "../src/rules";
import { ownerClock, ownerDay, ownerToday } from "../src/clock";
import { check, record, resetBudgets } from "../src/budget";
import { dueJobs } from "../src/start";
import { verifySource } from "../src/pull";

beforeEach(() => resetBudgets());
afterEach(() => { delete process.env.PB_NOW; });
const EVENING = "2026-10-16T23:30:00Z"; // 19:30 in Toronto, Oct 16
const LATER = "2026-10-17T00:30:00Z";   // 20:30 in Toronto, still Oct 16 (UTC says Oct 17)
const NIGHT = "2026-10-17T03:30:00Z";   // 23:30 in Toronto, still Oct 16
const NEXT = "2026-10-17T04:30:00Z";    // 00:30 in Toronto, Oct 17
const alerts = (root: string, check: string) => { const f = join(root, "log", "alerts.jsonl"); return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l.includes(`"${check}"`)).length : 0; };
function tz(root: string, zone: string) {
  const f = join(root, "rules", "policy.yaml");
  const doc = YAML.parseDocument(readFileSync(f, "utf8"));
  doc.setIn(["owner", "timezone"], zone);
  writeFileSync(f, doc.toString());
}

test("the owner's day, hour and weekday come from owner.timezone, and a bad zone falls back to the default", () => {
  const root = makeBrain();
  tz(root, "America/Toronto");
  expect(ownerClock(loadRules(root), new Date(NIGHT))).toEqual({ day: "2026-10-16", hour: 23, dow: 5 });
  expect(ownerDay(loadRules(root), NEXT)).toBe("2026-10-17");
  tz(root, "Europe/Paris");
  expect(ownerDay(loadRules(root), EVENING)).toBe("2026-10-17");
  tz(root, "Not/AZone");
  expect(ownerDay(loadRules(root), NIGHT)).toBe("2026-10-16");
});

test("the request budget alerts once per owner day: not again at 20:30 Toronto, again after midnight there", () => {
  const root = makeBrain();
  tz(root, "America/Toronto");
  const f = join(root, "rules", "policy.yaml");
  writeFileSync(f, readFileSync(f, "utf8") + "budget: { requests_per_minute: 1 }\n");
  const over = (iso: string) => { const now = Date.parse(iso); record(root, "planner", "request", { now }); return check(root, "planner", "request", { now }); };
  expect(over(EVENING)).toBeGreaterThan(0);
  expect(over(LATER)).toBeGreaterThan(0);
  expect(over(NIGHT)).toBeGreaterThan(0);
  expect(alerts(root, "request_budget")).toBe(1);
  expect(over(NEXT)).toBeGreaterThan(0);
  expect(alerts(root, "request_budget")).toBe(2);
});

test("the night pass and digest run once per owner day: nothing new at 23:30 Toronto", () => {
  const root = makeBrain();
  tz(root, "America/Toronto");
  expect(dueJobs(root, new Date("2026-10-16T07:05:00Z"))).toEqual(["night"]);   // 03:05 Toronto
  expect(dueJobs(root, new Date("2026-10-16T11:05:00Z"))).toEqual(["digest"]);  // 07:05 Toronto
  expect(dueJobs(root, new Date(NIGHT))).toEqual([]);                            // 23:30 Toronto, UTC says the 17th
  expect(dueJobs(root, new Date(NEXT))).toEqual([]);                             // 00:30 Toronto: before 03:00
  expect(dueJobs(root, new Date("2026-10-17T07:05:00Z"))).toEqual(["night"]);
});

test("the verify_source daily cap counts the owner's day", async () => {
  const root = makeBrain();
  tz(root, "America/Toronto");
  writeFileSync(join(root, "mail.json"), JSON.stringify([{ id: "a1b2c3d4e5f60718", labelIds: ["L"], internalDate: "1760300000000", payload: { headers: [{ name: "Subject", value: "x" }] }, text: "Publish the grades by Friday." }]));
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { gmail: { kind: "gmail", where: ["L"], fixture: "mail.json" } } }));
  process.env.PB_NOW = EVENING;
  expect((await verifySource(root, "gardener", "gmail:a1b2c3d4e5f60718", "Publish the grades", 1)).result).toBe("match");
  process.env.PB_NOW = LATER;
  expect((await verifySource(root, "gardener", "gmail:a1b2c3d4e5f60718", "Publish the grades", 1)).result).toBe("unreachable");
  process.env.PB_NOW = NEXT;
  expect((await verifySource(root, "gardener", "gmail:a1b2c3d4e5f60718", "Publish the grades", 1)).result).toBe("match");
});

test("the handoff cap counts the owner's day: the 21st at 20:30 Toronto is held, the next morning's isn't", async () => {
  const { handOff } = await import("../src/handoff");
  const root = makeBrain();
  tz(root, "America/Toronto");
  const pinned = process.env.PB_TODAY; // the fixture pins today(); the folder follows it when pinned
  delete process.env.PB_TODAY;
  const job = { to: "helper", task: "Draft the midterm reminder for Course A.", next_step: "Send the draft to the owner." };
  process.env.PB_NOW = "2026-10-20T23:30:00Z";
  for (let i = 0; i < 20; i++) await handOff(root, "planner", { ...job, task: `${job.task} (${i})` });
  process.env.PB_NOW = "2026-10-21T00:30:00Z";
  await handOff(root, "planner", job);
  const { readdirSync } = await import("node:fs");
  const held = () => readdirSync(join(root, "handoffs"), { recursive: true }).map(String).filter((f) => f.endsWith(".md")).map((f) => readFileSync(join(root, "handoffs", f), "utf8")).filter((t) => t.includes("tasks today already")).length;
  expect(held()).toBe(1);
  // Filed under the owner's day: all 21 under the 20th, none under the UTC 21st.
  expect(readdirSync(join(root, "handoffs"))).toEqual(["2026-10-20"]);
  process.env.PB_NOW = "2026-10-21T11:30:00Z";
  await handOff(root, "planner", { ...job, task: "Next morning's task." });
  expect(held()).toBe(1);
  if (pinned) process.env.PB_TODAY = pinned;
});

test("today() is the owner's day in the zone of the last policy read, so dates on facts and decisions match", async () => {
  const { ownerToday } = await import("../src/clock");
  const { loadRules } = await import("../src/rules");
  const root = makeBrain();
  loadRules(root);
  expect(ownerToday(new Date(EVENING))).toBe("2026-10-16");
  expect(ownerToday(new Date(LATER))).toBe("2026-10-16"); // 20:30 in Toronto, the 17th in UTC
  tz(root, "Europe/Paris");
  loadRules(root);
  expect(ownerToday(new Date(EVENING))).toBe("2026-10-17");
  tz(root, "America/Toronto");
  loadRules(root);
});

test("backlog 343: at 21:00 in Toronto an agent's as_of of that day is today, not the future; the next day's is refused", async () => {
  const { runChecks } = await import("../src/checks");
  const { today } = await import("../src/brain");
  const root = makeBrain();
  loadRules(root);
  const pinned = process.env.PB_TODAY;
  delete process.env.PB_TODAY;
  try {
    process.env.PB_NOW = "2026-10-17T01:00:00Z"; // 21:00 in Toronto, Oct 16
    expect(today()).toBe("2026-10-16");
    const req = (as_of: string) => ({ agent: "planner", id: "projects/course-a", attribute: "next_step", value: "Grade the midterm", as_of, sources: ["gmail:a1b2c3d4e5f60718"], verification: "verified-by-source" as const, confidence: "stated" as const });
    expect(runChecks(req("2026-10-16"), new Set(["as_of_not_future"]))).toEqual([]);
    expect(runChecks(req("2026-10-17"), new Set(["as_of_not_future"])).map((f) => f.check)).toEqual(["as_of_not_future"]);
  } finally { if (pinned !== undefined) process.env.PB_TODAY = pinned; }
});

// Follow-ups from the slice audit (pocketbrain-app-reviews/one-clock-slice-audit.md).
test("G286: a share runs to the end of its last day on the owner's clock, not until 20:00 Toronto", () => {
  const root = makeBrain();
  const pinned = process.env.PB_TODAY;
  delete process.env.PB_TODAY;
  try {
    const f = join(root, "rules", "policy.yaml");
    const doc = YAML.parseDocument(readFileSync(f, "utf8"));
    doc.setIn(["agents", "alice"], doc.createNode({ tier: "trial", slices: ["area:work"], collaborator: { name: "Alice", until: "2026-10-16" } }, { flow: true }));
    writeFileSync(f, doc.toString());
    setSystemTime(new Date("2026-10-17T01:00:00Z")); // 21:00 on the 16th in Toronto
    expect(loadRules(root).policy.agents.alice.status).not.toBe("paused");
    setSystemTime(new Date("2026-10-17T04:30:00Z")); // 00:30 on the 17th: over
    expect(loadRules(root).policy.agents.alice.status).toBe("paused");
  } finally { setSystemTime(); if (pinned) process.env.PB_TODAY = pinned; }
});

test("G286: a relay send that keeps failing alerts once per owner day, not again after 20:00 Toronto", async () => {
  const { relayOnce, agentMailTransport, loadRelayConfig } = await import("../src/relay");
  const { readJsonl } = await import("../src/util");
  const root = makeBrain();
  // A local stand-in for AgentMail that refuses every send (as in test/relay-failures.test.ts).
  const srv = Bun.spawn(["bun", "-e", `const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => { const u = new URL(r.url);
    if (r.method === "GET" && u.pathname.endsWith("/messages")) return Response.json({ messages: [{ message_id: "m1" }] });
    if (r.method === "GET") return Response.json({ from: "planner@brain.example", to: ["relay+helper@brain.example"], subject: "Course A", text: "Draft the reminder please", timestamp: "2026-10-16T20:00:00Z" });
    if (u.pathname.endsWith("/send")) return Response.json({ name: "RateLimitError" }, { status: 429 });
    return Response.json({ ok: true }); } }); console.log("port " + s.port);`], { stdout: "pipe" });
  const reader = srv.stdout.getReader();
  let seen = "";
  while (!/port \d+/.test(seen)) seen += new TextDecoder().decode((await reader.read()).value);
  const url = `http://127.0.0.1:${seen.match(/port (\d+)/)![1]}/v0`;
  try {
    setSystemTime(new Date("2026-10-16T23:30:00Z")); // 19:30 Toronto
    relayOnce(root, agentMailTransport(loadRelayConfig(root), "k", url));
    setSystemTime(new Date("2026-10-17T00:30:00Z")); // 20:30 Toronto, the 17th in UTC
    relayOnce(root, agentMailTransport(loadRelayConfig(root), "k", url));
    expect(readJsonl<{ check: string }>(join(root, "log", "alerts.jsonl")).filter((a) => a.check === "relay_failed").length).toBe(1);
  } finally { setSystemTime(); srv.kill(); }
});

test("G287: today() follows the pinned clock, and the zone of the brain whose rules were read", () => {
  const a = makeBrain(), b = makeBrain();
  tz(b, "Asia/Tokyo");
  const t = "2026-10-16T20:00:00Z"; // 16:00 in Toronto, 05:00 on the 17th in Tokyo
  process.env.PB_NOW = t;
  loadRules(a);
  expect(ownerToday()).toBe("2026-10-16"); // PB_NOW, not the machine's clock
  loadRules(b);
  expect(ownerToday()).toBe("2026-10-17");
  loadRules(a); // one process serves one brain: reading its rules puts its zone back
  expect(ownerToday()).toBe("2026-10-16");
});
