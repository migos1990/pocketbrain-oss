// SPDX-License-Identifier: AGPL-3.0-only
// The owner's text, 2026-10-24: "pocketBrain: 73 need you / A) Alert (carve_widened): gardener ...
// B) Alert (probe_gardener_rotate) ... C) Alert (source_failed): source:gmail-primary ... +68 more".
// Nearly all were stale: the source and the probes had passed since, and the rest were refusals the
// hub makes on purpose. An alert closes when its check passes again; a by-design refusal is never
// owner work; what the home page and the text count is decisions only, and the text is one line.
import { test, expect } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { openItems } from "../src/textline/items";
import { loadState } from "../src/dashboard/data";
import { overview } from "../src/dashboard/html";
import { waitingCount } from "../src/dashboard/home";
import { tick } from "../src/textline/poll";
import { fakeTransport } from "../src/textline/transport";

const T0 = "2026-10-19T10:00:00Z", T1 = "2026-10-23T10:00:00Z";
const NOW = new Date("2026-10-24T18:00:00Z");
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");

function brain(passed = true) {
  const root = makeBrain();
  writeFileSync(join(root, "rules/escalation.yaml"), "health: { url: null }\nquiet_hours: null\n");
  Bun.spawnSync(["git", "-C", root, "add", "-A"]);
  Bun.spawnSync(["git", "-C", root, "-c", "user.name=louis", "-c", "user.email=l@x", "commit", "-qm", "escalation"]);
  mkdirSync(join(root, "log", "sources"), { recursive: true });
  const alert = (a: Record<string, unknown>) => appendFileSync(join(root, "log", "alerts.jsonl"), JSON.stringify({ at: T0, ...a }) + "\n");
  alert({ agent: "source:gmail-primary", check: "source_failed", from: "HTTP 401 from the Gmail API" });
  alert({ agent: "hub", check: "probe_gardener_rotate", from: "the Gardener's key is 40 days old" });
  alert({ agent: "hub", check: "probe_warn_connections", from: "2 connections idle" });
  alert({ agent: "hub", check: "probe_hub_hung", from: "no answer for 5 min; the watchdog restarted it" });
  alert({ agent: "gardener", check: "carve_widened", from: "people/x now visible" });
  alert({ agent: "helper", check: "source_mismatch", from: "2026-10-19-helper-1.yaml: gmail:f000000000000001 doesn't say \"Dean\"" });
  alert({ agent: "helper", check: "source_held", from: "gmail:f000000000000002: reads like instructions" });
  if (passed) {
    appendFileSync(join(root, "log", "sources", "runs.jsonl"), JSON.stringify({ at: T1, source: "gmail-primary", fetched: 3, stored: [], skipped: 0, due: [] }) + "\n");
    writeFileSync(join(root, "log", "probe.json"), JSON.stringify({ gardener_rotate: { ok: true, since: T1, detail: "" }, connections: { ok: true, since: T1, detail: "" } }));
    mkdirSync(join(root, "textline"), { recursive: true });
    writeFileSync(join(root, "textline", "heartbeat"), T1);
  }
  return root;
}

test("an alert closes when its check passes again; a by-design refusal is never owner work", () => {
  expect(openItems(brain(), NOW).filter((i) => i.kind === "alert").map((i) => i.title).join(" ")).not.toMatch(/source_failed|probe_|source_mismatch|source_held/);
  // Without a pass since, the failures still wait; the refusals never do.
  const open = openItems(brain(false), NOW).filter((i) => i.kind === "alert").map((i) => i.title);
  expect(open.join(" ")).toMatch(/source_failed/);
  expect(open.join(" ")).toMatch(/probe_gardener_rotate/);
  expect(open.join(" ")).not.toMatch(/source_mismatch|source_held/);
  // The weekly carve audit's only output stays on the dashboard (safety review, 2026-10-24).
  expect(open.join(" ")).toMatch(/carve_widened/);
});

test("the home's count leaves out the hub's own alerts", () => {
  const root = brain(false);
  const html = overview(loadState(root, NOW), "x").body;
  expect(text(html)).not.toMatch(/probe|carve|_/);
  expect(waitingCount(root, NOW)).toBe(0);
});

test("the text is one line with the home page's count, never a list of alerts", async () => {
  const root = brain(false);
  write(root, { agent: "planner", id: "projects/course-a", attribute: "room", value: "Room A", as_of: "2026-10-07", sources: ["gmail:f000000000000006"] });
  write(root, { agent: "planner", id: "projects/course-a", attribute: "room", value: "Room B", as_of: "2026-10-07", sources: ["gmail:f000000000000004"] });
  const n = waitingCount(root, NOW);
  expect(n).toBeGreaterThan(0);
  let sent: string | undefined;
  for (let m = 0; m < 6 * 60 && !sent; m += 30) sent = (await tick(root, { now: new Date(NOW.getTime() + m * 60_000), transport: fakeTransport(root, true), fetch: async () => new Response("{}") })).sent?.text;
  expect(sent).toBe(`pocketBrain: ${n} waiting on you, open your home`);
});

// A leak is the one event where hours on the dashboard is the damage (safety review, 2026-10-24;
// backlog row 1): a leak tripwire or canary still texts at once, even in quiet hours, outside the count.
test("a leak or canary alert still texts at once, in one line, outside the count", async () => {
  const root = brain();
  writeFileSync(join(root, "rules/escalation.yaml"), "health: { url: null }\n");
  Bun.spawnSync(["git", "-C", root, "-c", "user.name=louis", "-c", "user.email=l@x", "commit", "-qam", "quiet hours on"]);
  appendFileSync(join(root, "log", "alerts.jsonl"), JSON.stringify({ at: new Date(NOW.getTime() - 60_000).toISOString(), agent: "helper", check: "leak_tripwire", from: "helper to steward" }) + "\n");
  const night = new Date("2026-10-25T04:00:00Z"); // midnight in Toronto
  const sent = (await tick(root, { now: night, transport: fakeTransport(root, true), fetch: async () => new Response("{}") })).sent?.text ?? "";
  expect(sent.split("\n")).toHaveLength(1);
  expect(sent).toMatch(/^pocketBrain: an assistant tried to pass on something it can't see/);
  expect(sent).not.toMatch(/leak_tripwire|helper|_/);
});
