// SPDX-License-Identifier: AGPL-3.0-only
// A seeded throwaway brain with the dashboard and the browser door running, and every page worth
// checking, for test/ui-quality.test.ts. Never the real brain.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { serve } from "../src/server";
import { issueToken } from "../src/auth";
import { serveDashboard } from "../src/dashboard/server";
import { setAgentStatus } from "../src/dashboard/actions";
import { write } from "../src/write";
import { relayOnce, fileTransport } from "../src/relay";

// busy: the states an owner meets on a real day: a change to approve, a held message, an agent set
// to read-only, reads in the log. Without it, every list shows its empty state.
export async function uiRig(o: { busy?: boolean; ports?: [number, number] } = {}) {
  const root = makeBrain();
  // The browser door is per agent; helper uses it.
  const p = join(root, "rules/policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace(/^  helper: \{ /m, "  helper: { browser: true, "));
  const tokens = Object.fromEntries(["steward", "planner", "helper"].map((a) => [a, issueToken(root, a)])) as Record<string, string>;
  // Fixed ports keep the door's own address (shown in its orientation) the same in every screenshot.
  const agents = serve(root, o.ports?.[0] ?? 0);
  const d = serveDashboard(root, { port: o.ports?.[1] ?? 0 });
  const api = `http://127.0.0.1:${agents.port}`;
  const dash = new URL(d.loginUrl).origin;
  if (o.busy) {
    write(root, { agent: "helper", id: "projects/course-a", attribute: "next_step", value: "grade the final projects", as_of: "2026-10-07", sources: ["gmail:f000000000000006"], verification: "verified-by-source" });
    mkdirSync(join(root, "relay/incoming"), { recursive: true });
    writeFileSync(join(root, "relay/incoming/a.json"), JSON.stringify({ id: "a", from: "helper@brain.example", to: ["relay+planner@brain.example"], subject: "Course A", text: "What's Robin's bank?" }));
    relayOnce(root, fileTransport(root));
    setAgentStatus(root, "planner", "read-only");
    for (const topic of ["course", "Jane Roy", "advisor"]) await fetch(`${api}/v1/context?topic=${encodeURIComponent(topic)}`, { headers: { authorization: `Bearer ${tokens.steward}` } });
  }
  const stop = () => { agents.stop(true); d.server.stop(true); };
  return { root, tokens, api, dash, loginUrl: d.loginUrl, stop };
}

// Dashboard pages by path. Names become screenshot file names.
export const DASHBOARD_PAGES: [string, string][] = [
  ["overview", "/"],
  ["brain", "/brain"],
  ["brain-search", "/brain?q=Jane"],
  ["note", "/note/people/jane-roy"],
  ["map", "/map"],
  ["agents", "/agents"],
  ["agent", "/agent/steward"],
  ["activity", "/activity"],
  ["upkeep", "/upkeep"],
  ["digest", "/digest"],
  ["usage", "/usage"],
  ["history", "/history"],
  ["note-history", "/history/people/jane-roy"],
  ["not-found", "/nowhere"],
  ["error-flash", "/brain?err=That+note+changed+since+you+opened+it"],
];

// The same rig with o.busy: lists with items in them.
export const BUSY_PAGES: [string, string][] = [
  ["overview-busy", "/"],
  ["agents-busy", "/agents"],
  ["agent-busy", "/agent/steward"],
  ["activity-busy", "/activity"],
];

// Browser-door pages, signed in as helper (the sign-in page is checked before signing in).
export const DOOR_PAGES: [string, string][] = [
  ["door-start", "/b"],
  ["door-orientation", "/b/orientation"],
  ["door-changes", "/b/changes"],
  ["door-memory-check", "/b/memory-check"],
  ["door-remember", "/b/remember"],
  ["door-search", "/b/search?q=course"],
  ["door-search-empty", "/b/search?q=zzzqqq"],
  ["door-not-here", "/b/nowhere"],
];
