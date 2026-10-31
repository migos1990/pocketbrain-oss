// SPDX-License-Identifier: AGPL-3.0-only
// Silent failures the outside review found (2026-10-25, G421): a fact that couldn't file itself
// became a card with no reason and no alert; a source over its daily cap showed only in CLI
// output; the calendar pull read nothing 299 times in a row and nobody could tell broken from
// quiet. Each is now a self-check (src/probe.ts): one alert when it turns failing, closed by
// itself when the check passes again. Details carry counts and check names, never a value.
import { test, expect, afterEach } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { selfChecks } from "../src/probe";
import { useFreeDisk } from "../src/textline/items";

const NOW = new Date("2026-10-08T12:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const line = (root: string, file: string, e: Record<string, unknown>) => { mkdirSync(join(root, file, ".."), { recursive: true }); appendFileSync(join(root, file), JSON.stringify(e) + "\n"); };
const byName = (root: string) => Object.fromEntries(selfChecks(root, NOW).map((c) => [c.name, c]));
afterEach(() => { useFreeDisk(() => 50_000); delete process.env.PB_UPCOMING_DIR; });

test("failed auto-saves in the last day are an alert naming the refusal, never the value", () => {
  const root = makeBrain();
  expect(byName(root).auto_saves).toBeUndefined();
  line(root, "log/auto-decisions-errors.jsonl", { at: ago(3), key: "proposal:inbox/a.yaml", error: "as_of_not_future: 2026-12-01 Secret Value", code: "x" });
  line(root, "log/auto-decisions-errors.jsonl", { at: ago(2), key: "proposal:inbox/b.yaml", error: "source_exists: gmail:abc not found", code: "x" });
  line(root, "log/auto-decisions-errors.jsonl", { at: ago(50), key: "proposal:inbox/c.yaml", error: "old_one: x", code: "x" });
  const c = byName(root).auto_saves;
  expect(c.ok).toBe(false);
  expect(c.detail).toContain("2 facts couldn't file themselves");
  expect(c.detail).toContain("as_of_not_future");
  expect(c.detail).toContain("source_exists");
  expect(c.detail).not.toContain("Secret");
  expect(c.detail).not.toContain("old_one");
  expect(c.detail).not.toContain("gmail:abc");
});

test("no failed save in the last day: the check passes, so its alert closes", () => {
  const root = makeBrain();
  line(root, "log/auto-decisions-errors.jsonl", { at: ago(30), key: "proposal:inbox/a.yaml", error: "x_y: z", code: "x" });
  expect(byName(root).auto_saves.ok).toBe(true);
});

test("a source that hit its daily cap today is a warning that says how many wait", () => {
  const root = makeBrain();
  line(root, "log/sources/runs.jsonl", { at: ago(5), source: "mail", fetched: 40, stored: [], skipped: 0, due: [] });
  expect(byName(root).source_cap.ok).toBe(true);
  line(root, "log/sources/runs.jsonl", { at: ago(1), source: "mail", fetched: 40, stored: [], skipped: 12, due: [], capped: true, deferred: 12 });
  const c = byName(root).source_cap;
  expect(c.ok).toBe(false);
  expect(c.warn).toBe(true);
  expect(c.detail).toContain("mail");
  expect(c.detail).toContain("12");
});

test("a calendar pull that read nothing for 3 days while the calendar shows events it never saw is broken", () => {
  const root = makeBrain();
  process.env.PB_UPCOMING_DIR = join(root, ".up");
  writeFileSync(join(root, "rules/sources.yaml"), "consent: x\nsources:\n  cal:\n    kind: gcal\n    upcoming: true\n");
  for (const h of [100, 80, 60, 40, 20, 1]) line(root, "log/sources/runs.jsonl", { at: ago(h), source: "cal", fetched: 0, stored: [], skipped: 0, due: [] });
  line(root, "log/sources/runs.jsonl", { at: ago(120), source: "cal", fetched: 4, stored: [], skipped: 0, due: [] });
  writeFileSync(join(root, "log/sources/cal.json"), JSON.stringify({ seen: { known1: "1", rec2: "1" } }));
  const { saveUpcoming } = require("../src/upcoming");
  const ev = (id: string) => ({ id, version: "1", summary: "Meeting", start: "2026-10-10T10:00:00Z", source: "cal" });
  saveUpcoming(root, "cal", [ev("known1"), ev("rec2_20261010T100000Z")], "2026-10-08");
  expect(byName(root).calendar_pull.ok).toBe(true); // quiet: every coming event was seen
  saveUpcoming(root, "cal", [ev("known1"), ev("rec2_20261010T100000Z"), ev("new1"), ev("new2")], "2026-10-08");
  const c = byName(root).calendar_pull;
  expect(c.ok).toBe(false);
  expect(c.detail).toContain("cal");
  expect(c.detail).toContain("2 coming events");
  expect(c.detail).not.toContain("Meeting");
});

// Audit v6 (2026-10-30): a save refused twice under the same code is parked until other code runs
// (G519), so no new error line comes; after 24 hours the check went green while the fact still
// waited. A parked save keeps the check failing for as long as its proposal is open (G538).
test("a save parked after two refusals keeps the check failing past the day, while it is open", async () => {
  const { FILING_CODE } = await import("../src/filing");
  const root = makeBrain();
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "p.yaml"), "proposed: 2026-10-01\n");
  for (const h of [80, 79]) line(root, "log/auto-decisions-errors.jsonl", { at: ago(h), key: "proposal:p.yaml", error: "area_change_needs_louis: x", code: FILING_CODE });
  for (const h of [80, 79]) line(root, "log/auto-decisions-errors.jsonl", { at: ago(h), key: "proposal:gone.yaml", error: "other_one: x", code: FILING_CODE });
  line(root, "log/auto-decisions-errors.jsonl", { at: ago(78), key: "proposal:once.yaml", error: "once_only: x", code: FILING_CODE });
  writeFileSync(join(root, "inbox", "once.yaml"), "proposed: 2026-10-01\n");
  const c = byName(root).auto_saves;
  expect(c.ok).toBe(false);
  expect(c.detail).toContain("1 fact parked");
  expect(c.detail).toContain("area_change_needs_louis");
  expect(c.detail).not.toContain("other_one");
  expect(c.detail).not.toContain("once_only");
  // Answered, it closes.
  rmSync(join(root, "inbox", "p.yaml"));
  expect(byName(root).auto_saves.ok).toBe(true);
});
