// SPDX-License-Identifier: AGPL-3.0-only
// Routines that may do the same job (owner, 2026-11-03: "maybe there's a way to flag overlapping
// things agents do?"; G641). Two active routines that run on their own, read the same source and do
// the same kind of job are one hint for the owner. Code only, never a model; never merged, never a
// card to settle, and the Gardener sees a count, never a page.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { saveNote, type Note } from "../src/brain";
import { git } from "../src/git";
import { findOverlaps } from "../src/overlap";
import { upkeep } from "../src/upkeep";
import { memoryPage, type MemoryView } from "../src/dashboard/html-app";

const rec = (value: string) => ({ value, as_of: "2026-10-01", sources: ["agent:helper"], by: "helper", recorded: "2026-10-01" });
const routine = (id: string, title: string, schedule: string, tools: string[], status = "active"): Note => ({
  fm: { id, type: "capability", title, area: "personal", sensitivity: "personal", created: "2026-10-01", updated: "2026-10-01", by: "helper",
    facts: { status: rec(status), schedule: rec(schedule), tools: { items: tools.map(rec) } } } as never, body: "", path: "" });

const SET: Note[] = [
  routine("agents/helper/bill-alerts", "Critical email and bill alerts", "Each incoming email", ["Gmail", "push notifications"]),
  routine("agents/scout/inbox-watch", "Inbox alert monitor", "Hourly or event-based", ["Gmail", "Google Calendar"]),
  routine("agents/helper/morning-digest", "Daily digest", "Daily 7:00", ["Gmail", "Calendar"]),
  routine("agents/scout/morning-brief", "Morning brief digest", "Daily morning", ["Google Workspace (Calendar, Gmail)"]),
  routine("agents/helper/drafts", "Email drafting", "On request", ["Gmail"]),
  routine("agents/scout/drafts-too", "Draft replies", "On request", ["Gmail"]),
  routine("agents/helper/old-alerts", "Old bill alerts", "Each incoming email", ["Gmail"], "retired"),
  routine("agents/scout/discord-alerts", "Discord alerts", "Scheduled", ["Discord"]),
];

test("routines that run on their own, read one source and do one kind of job are grouped", () => {
  const groups = findOverlaps(SET).map((g) => g.ids.slice().sort());
  expect(groups).toContainEqual(["agents/helper/bill-alerts", "agents/scout/inbox-watch"]);
  expect(groups).toContainEqual(["agents/helper/morning-digest", "agents/scout/morning-brief"]);
  // On-request work is the owner asking, not a routine; a retired routine runs no more; a different
  // source is a different job.
  expect(groups.flat()).not.toContain("agents/helper/drafts");
  expect(groups.flat()).not.toContain("agents/helper/old-alerts");
  expect(groups.flat()).not.toContain("agents/scout/discord-alerts");
  expect(groups).toHaveLength(2);
  const g = findOverlaps(SET).find((x) => x.ids.includes("agents/helper/morning-digest"))!;
  expect(g.sources).toContain("Gmail");
});

test("the Gardener's finding is a count under a key that is no page's id", () => {
  const root = makeBrain();
  for (const n of SET) saveNote(root, n);
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "routines"]);
  const u = upkeep(root, { run: "t" });
  const f = u.findings.filter((x) => x.rule === "routine-overlap");
  expect(f).toHaveLength(1);
  expect(f[0]!.key).toBe("routine-overlap");
  expect(f[0]!.kind).toBe("review");
  for (const n of SET) { expect(f[0]!.detail).not.toContain(n.fm.id); expect(f[0]!.detail).not.toContain(String(n.fm.title)); }
});

test("the routines list says which may do the same job, linking each", () => {
  const pages = SET.map((n) => ({ id: n.fm.id, title: String(n.fm.title), area: "personal" }));
  const v: MemoryView = { pages: pages.length, people: 0, name: "Sam", kinds: [], week: [], kind: { label: "Routines", pages, folder: "agents" }, overlaps: findOverlaps(SET) };
  const html = memoryPage(v);
  const block = html.match(/<div class="overlaps">([\s\S]*?)<\/div>/)?.[1] ?? "";
  expect(block).toContain("may do the same job");
  expect(block).toContain('href="/p/agents/helper/bill-alerts"');
  expect(block).toContain('href="/p/agents/scout/inbox-watch"');
  expect(block).toContain("Gmail");
});

test("a routine's own page names the others that may do the same job", async () => {
  const { loadState } = await import("../src/dashboard/data");
  const { ownerPage } = await import("../src/dashboard/html-page");
  const root = makeBrain();
  for (const n of SET) saveNote(root, n);
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "routines"]);
  const s = loadState(root);
  const html = ownerPage(s, "t", s.notes.find((n) => n.fm.id === "agents/helper/bill-alerts")!, []);
  expect(html).toContain("May do the same job");
  expect(html).toContain('href="/p/agents/scout/inbox-watch"');
  const alone = ownerPage(s, "t", s.notes.find((n) => n.fm.id === "agents/helper/drafts")!, []);
  expect(alone).not.toContain("May do the same job");
});

test("three routines that do one job read as all, not both", () => {
  const three = [...SET, routine("agents/third/mail-watch", "Mail alert watch", "Every hour", ["Gmail"])];
  const pages = three.map((n) => ({ id: n.fm.id, title: String(n.fm.title), area: "personal" }));
  const html = memoryPage({ pages: pages.length, people: 0, name: "Sam", kinds: [], week: [], kind: { label: "Routines", pages, folder: "agents" }, overlaps: findOverlaps(three) });
  expect(html).toContain("all run on their own");
  expect(html).toContain("both run on their own");
});
