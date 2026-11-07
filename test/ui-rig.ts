// SPDX-License-Identifier: AGPL-3.0-only
// The demo brain (scripts/demo-brain.ts: about 500 facts and a replayed week) with the dashboard and
// the browser door running, and every page worth checking, for test/ui-quality.test.ts. Never the
// real brain, and never the 7-note sample: a screen designed against an empty brain looks dead
// (outside review 2026-10-29).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { serve } from "../src/server";
import { serveDashboard } from "../src/dashboard/server";
import { setAgentStatus } from "../src/dashboard/actions";
import { write } from "../src/write";
import { relayOnce, fileTransport } from "../src/relay";
import { DEMO_NOW } from "../scripts/demo-brain";

// The demo brain's own day already holds what an owner meets: three conflicts and a private value
// waiting, three assistants that read today and one that remembers something wrong (the home's
// belief radar, G496), a week of diary lines. busy adds the operator's states on Settings: an
// assistant's change to approve, a held message, an assistant set to read-only.
// The hub's clock is pinned to the demo's morning (G497): the diary, the reads and the home's
// date all fall on it, so a home screenshot shows a real day. stop() puts the clock back.
export async function uiRig(o: { busy?: boolean; ports?: [number, number] } = {}) {
  const { root, tokens, conflicts } = await makeDemoBrain();
  // Only the rig that pinned it unpins it: a second rig open at once leaves the clock alone.
  const pinned = process.env.PB_NOW === undefined;
  if (pinned) process.env.PB_NOW = DEMO_NOW;
  // Fixed ports keep the door's own address (shown in its orientation) the same in every screenshot.
  const agents = serve(root, o.ports?.[0] ?? 0);
  const d = serveDashboard(root, { port: o.ports?.[1] ?? 0 });
  const api = `http://127.0.0.1:${agents.port}`;
  const dash = new URL(d.loginUrl).origin;
  if (o.busy) {
    write(root, { agent: "gemini", id: "projects/atlas-launch", attribute: "status", value: "launch candidate", as_of: "2026-10-08", sources: ["agent:gemini/2026-10-08"], verification: "self-reported" });
    mkdirSync(join(root, "relay/incoming"), { recursive: true });
    writeFileSync(join(root, "relay/incoming/a.json"), JSON.stringify({ id: "a", from: "gemini@brain.example", to: ["relay+chatgpt@brain.example"], subject: "Kitchen", text: "What's Robin's bank?" }));
    relayOnce(root, fileTransport(root));
    setAgentStatus(root, "gemini", "read-only");
  }
  const stop = () => {
    agents.stop(true); d.server.stop(true);
    if (pinned) delete process.env.PB_NOW;
  };
  return { root, tokens, conflicts, api, dash, loginUrl: d.loginUrl, stop };
}

// Dashboard pages by path. Names become screenshot file names.
export const DASHBOARD_PAGES: [string, string][] = [
  // Settings ("/" is the owner's home since the owner app, which has its own shots; PR #6 review).
  ["overview", "/overview"],
  ["brain", "/brain"],
  ["brain-search", "/brain?q=Maya"],
  ["note", "/note/people/maya-chen"],
  ["map", "/map"],
  ["map-see-as", "/map?as=gemini&q=atlas"],
  ["map-read-as", "/map?as=gemini&read=projects/atlas-launch"],
  ["agents", "/agents"],
  ["agent", "/agent/claude"],
  ["activity", "/activity"],
  ["upkeep", "/upkeep"],
  ["digest", "/digest"],
  ["usage", "/usage"],
  ["history", "/history"],
  ["note-history", "/history/people/maya-chen"],
  ["not-found", "/nowhere"],
  ["error-flash", "/brain?err=That+note+changed+since+you+opened+it"],
  ["home", "/home"],
  ["memory", "/memory"],
  ["memory-kind", "/memory?kind=people"],
  ["memory-search", "/memory?q=Maya"],
  ["memory-changes", "/memory?changes=week"],
  ["ask", "/ask"],
  ["ask-chats", "/ask?list=1"],
  ["who", "/who"],
  ["let", "/let?key=projects%2Fproduct-discovery-course%23next_step&agent=gemini"],
  ["owner-page", "/p/people/maya-chen"],
  ["owner-project", "/p/projects/atlas-launch"],
  ["owner-page-edit", "/p/people/maya-chen?edit=1"],
  ["settle", "/settle/c-0001"],
];

// The same rig with o.busy: lists with items in them.
export const BUSY_PAGES: [string, string][] = [
  ["overview-busy", "/overview"],
  ["agents-busy", "/agents"],
  ["agent-busy", "/agent/claude"],
  ["activity-busy", "/activity"],
  ["home-busy", "/home"],
  ["who-busy", "/who"],
  ["settle-mail-busy", "/settle/m-a"],
  ["ask-busy", "/ask"],
  ["ask-chats-busy", "/ask?list=1"],
];

// What the owner types into Ask before ask-busy is checked (a conversation: a question, then a write).
export const ASK_SAYS = ["what is Isabelle Roy's role?", "Product Discovery course's next step is book the exam room", "who is Maya Chen?"];

// Browser-door pages, signed in as Gemini (the sign-in page is checked before signing in).
export const DOOR_PAGES: [string, string][] = [
  ["door-start", "/b"],
  ["door-orientation", "/b/orientation"],
  ["door-changes", "/b/changes"],
  ["door-memory-check", "/b/memory-check"],
  ["door-remember", "/b/remember"],
  ["door-search", "/b/search?q=atlas"],
  ["door-search-empty", "/b/search?q=zzzqqq"],
  ["door-not-here", "/b/nowhere"],
];
