// SPDX-License-Identifier: AGPL-3.0-only
// The Mac's read-only check 2026-11-08: 0 of the first 15 people pages showed a Last met line. A
// page can hold its address in any email-shaped attribute ("email" as well as "emails"), and as
// a mail's From line ("Name <address>") or in capitals; each must match the guest it is (G739).
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { loadState } from "../src/dashboard/data";
import { ownerPage } from "../src/dashboard/html-page";
import { DEMO_NOW, DEMO_DAY } from "../scripts/demo-brain";
import { toUpcoming, saveUpcoming } from "../src/upcoming";

const ev = (id: string, summary: string, start: string, guests: string[]) =>
  ({ id, etag: `"${id}1"`, summary, start: { dateTime: `${start}T15:00:00Z` }, attendees: [{ email: "robin@example.org", self: true }, ...guests.map((email) => ({ email }))] });
const rec = (v: string) => `{ value: "${v}", as_of: 2026-09-05, sources: ["gmail:f0000000000000a1"], verification: verified-by-source, by: steward, recorded: 2026-09-05 }`;
function person(root: string, slug: string, title: string, facts: string) {
  writeFileSync(join(root, "people", `${slug}.md`), `---\nid: people/${slug}\ntype: person\ntitle: ${title}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-09-01\nupdated: 2026-09-05\nby: steward\nfacts:\n${facts}---\n`);
}

test("G739 a page's address in any email-shaped attribute, as a From line or in capitals, ties the meeting", async () => {
  const { root } = await makeDemoBrain();
  person(root, "zed-quinn", "Zed Quinn", `  email: ${rec("Zed.Quinn@Example.org")}\n`);
  person(root, "yara-lund", "Yara Lund", `  emails:\n    items:\n      - ${rec("Yara Lund <yara@example.org>")}\n`);
  saveUpcoming(root, "calendar", [ev("m1", "Budget sync", "2026-10-02", ["zed.quinn@example.org"]), ev("m2", "Weekly", "2026-10-05", ["YARA@example.org"])].flatMap((e) => toUpcoming(e, "calendar") ?? []), DEMO_DAY);
  process.env.PB_NOW = DEMO_NOW;
  try {
    const s = loadState(root);
    const html = (id: string) => ownerPage(s, "", s.notes.find((x) => x.fm.id === id)!, [], { fresh: true });
    expect(html("people/zed-quinn")).toContain("Last met 2 Oct");
    expect(html("people/yara-lund")).toContain("Last met 5 Oct");
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("G739 the north star reports how many people pages show Last met and how many past meetings tie no page", async () => {
  const { detectors } = await import("../scripts/north-star");
  const { loadBrain } = await import("../src/brain");
  const { root } = await makeDemoBrain();
  person(root, "zed-quinn", "Zed Quinn", `  email: ${rec("Zed.Quinn@Example.org")}\n`);
  saveUpcoming(root, "calendar", [ev("m1", "Budget sync", "2026-10-02", ["zed.quinn@example.org"]), ev("m3", "Intro call", "2026-10-03", ["nobody@elsewhere.example"])].flatMap((e) => toUpcoming(e, "calendar") ?? []), DEMO_DAY);
  const d = detectors(root, loadBrain(root), DEMO_DAY);
  expect(d.last_met).toBeGreaterThanOrEqual(1);
  expect(d.guest_meetings).toBe(2);
  expect(d.guest_meetings_untied).toBe(1);
}, 60_000);

// Only 6 of 47 real people pages hold an address (the Mac, 2026-11-09), so a guest rarely ties by
// address. The name on the invite (its display name, or an address shaped first.last) ties the
// meeting as a guess, and the line says so; never a silent match (G746).
test("G746 a guest's name on the invite ties the meeting as a guess, said as one", async () => {
  const { root } = await makeDemoBrain();
  person(root, "zed-quinn", "Zed Quinn", `  city: ${rec("Laval")}\n`);
  person(root, "yara-lund", "Yara Lund", `  city: ${rec("Laval")}\n`);
  person(root, "xia-moe", "Xia Moe", `  email: ${rec("xia@example.org")}\n`);
  const guest = (email: string, displayName?: string) => ({ email, ...(displayName ? { displayName } : {}) });
  const raw = [
    { ...ev("m1", "Budget sync", "2026-10-02", []), attendees: [{ email: "robin@example.org", self: true }, guest("zq@north.example", "Zed Quinn")] },
    { ...ev("m2", "Weekly", "2026-10-05", []), attendees: [{ email: "robin@example.org", self: true }, guest("yara.lund@south.example")] },
    { ...ev("m3", "Intro", "2026-10-06", []), attendees: [{ email: "robin@example.org", self: true }, guest("xia@example.org", "Xia Moe")] },
  ];
  saveUpcoming(root, "calendar", raw.flatMap((e) => toUpcoming(e, "calendar") ?? []), DEMO_DAY);
  const file = (await import("node:fs")).readFileSync((await import("../src/upcoming")).upcomingFile(root), "utf8");
  expect(file).not.toContain("Zed");
  expect(file).not.toContain("yara");
  process.env.PB_NOW = DEMO_NOW;
  try {
    const s = loadState(root);
    const html = (id: string) => ownerPage(s, "", s.notes.find((x) => x.fm.id === id)!, [], { fresh: true });
    expect(html("people/zed-quinn")).toContain("Last met 2 Oct, by the name on the invite");
    expect(html("people/yara-lund")).toContain("Last met 5 Oct, by the name on the invite");
    // An address the page holds is sure: no hedge.
    expect(html("people/xia-moe")).toContain("Last met 6 Oct");
    expect(html("people/xia-moe")).not.toContain("by the name on the invite");
  } finally { delete process.env.PB_NOW; }
}, 60_000);
