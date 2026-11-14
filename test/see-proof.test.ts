// SPDX-License-Identifier: AGPL-3.0-only
// The tested line on See as (docs/slice-proof.md, "For a screen or a page that shows the line"):
// the last finished nightly run as it is, with its day and what it was run on. Nothing before the
// first run; a night with a leak reads as a leak, never an older clean night; a run that didn't
// finish is never a result. The word "proof" is not on the screen.
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { loadState } from "../src/dashboard/data";
import { seePage, seeListPage, SEE_COPY } from "../src/dashboard/see";
import { sliceProofLine, type SliceProof } from "../src/slice-proof";
import { DEMO_NOW } from "../scripts/demo-brain";

const run = (at: string, o: Partial<SliceProof> = {}): SliceProof => ({ at, code: "abc1234", memories: 300, doors: ["mcp", "api", "browser"], leaks: 0, pages: 2800, facts: 9000, readers: 1200, answers: 50000, seeds: { from: 7000, to: 7299 }, failed_seeds: [], ms: 1, ...o });
const put = (root: string, runs: SliceProof[]) => { mkdirSync(join(root, "log"), { recursive: true }); writeFileSync(join(root, "log", "slice-proof.jsonl"), runs.map((r) => JSON.stringify(r)).join("\n") + (runs.length ? "\n" : "")); };
const screens = (root: string) => { const s = loadState(root); return [seeListPage(s, "gemini", { fresh: true })!, seePage(s, "", "gemini", s.notes.find((n) => n.fm.id === "people/helene-lefebvre")!, { fresh: true })!]; };

test("See as shows the last finished nightly run as it is, with its day, and nothing before the first", async () => {
  try {
    process.env.PB_NOW = DEMO_NOW;
    const { root } = await makeDemoBrain();
    for (const html of screens(root)) { expect(html).not.toContain('class="tested"'); expect(html).not.toContain(SEE_COPY.tested); }

    // A run that didn't finish is no result: still nothing.
    put(root, [run("2026-10-06T08:10:00Z", { error: "timed out" })]);
    for (const html of screens(root)) expect(html).not.toContain('class="tested"');

    // Two clean nights, then a broken one: the last finished run, its day in the owner's zone, the streak.
    put(root, [run("2026-10-06T08:10:00Z"), run("2026-10-07T08:10:00Z"), run("2026-10-08T08:10:00Z", { error: "timed out" })]);
    const clean = sliceProofLine(run(""));
    expect(clean).toBe("300 memories, 3 doors, 0 leaks");
    for (const html of screens(root)) {
      expect(html).toContain(`<b>${clean}</b>`);
      expect(html).toContain("7 Oct 2026");
      expect(html).toContain(SEE_COPY.testedOn);
      expect(html.toLowerCase()).not.toContain("proof");
      expect(html.toLowerCase()).not.toContain("proven");
    }
    // A night that didn't finish ends the run of clean nights (sliceProofStreak): no streak is claimed.
    expect(screens(root)[0]).not.toContain("No leak for");
    put(root, [run("2026-10-06T08:10:00Z"), run("2026-10-07T08:10:00Z")]);
    expect(screens(root)[0]).toContain("No leak for 2 nights.");
    expect(screens(root)[1]).not.toContain("No leak for");

    // A night with a leak is shown as a leak, with what a leak here means; no streak.
    put(root, [run("2026-10-06T08:10:00Z"), run("2026-10-07T08:10:00Z", { leaks: 1, failed_seeds: [7042] })]);
    for (const html of screens(root)) {
      expect(html).toContain("<b>300 memories, 3 doors, 1 leak</b>");
      expect(html).toContain(SEE_COPY.testedLeak);
      expect(html).not.toContain("0 leaks");
      expect(html).not.toContain("No leak for");
      expect(html).not.toContain("7042");
    }
  } finally { delete process.env.PB_NOW; }
}, 60_000);
