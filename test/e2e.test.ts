// SPDX-License-Identifier: AGPL-3.0-only
// The full-stack regression's own parts (scripts/e2e.ts): what is masked, how a change is reported,
// and that the saved answers cover every door and step. The full run is `bun scripts/e2e.ts` (CI job e2e).
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalize, compare, noteIds, invariants, DOORS, STEPS, type Step } from "../scripts/e2e";

test("only what changes between runs is masked", () => {
  expect(normalize("file inbox/2026-10-08-muse-3fa9c2e1.yaml on 127.0.0.1:41234 at 2026-10-15T21:03:22.120Z key pb_AbCdEf123456 client client_Xy12Ab34Cd")).toBe("file inbox/2026-10-08-muse-HASH.yaml on 127.0.0.1:PORT at TIMESTAMP key pb_TOKEN client client_ID");
  // Numbers that are answers stay: a phone, a date, an all-digit id.
  expect(normalize("+15145550100 as of 2026-09-01 gmail:1234567890")).toBe("+15145550100 as of 2026-09-01 gmail:1234567890");
});

test("a read that starts naming another note is a change even when its first lines are the same", () => {
  const read = (notes: string[]): Step => ({ step: "read", status: 200, says: "# context", notes });
  expect(compare({ browser: [read(["projects/course-a"])] }, { browser: [read(["projects/course-a"])] })).toEqual([]);
  const d = compare({ browser: [read(["projects/course-a"])] }, { browser: [read(["money/main-bank", "projects/course-a"])] });
  expect(d.length).toBe(1);
  expect(d[0]).toContain("browser read");
  expect(d[0]).toContain("money/main-bank");
  expect(compare({ oauth: [read([])] }, {})[0]).toContain("now   (none)");
  expect(noteIds("see `projects/course-a` and [[people/jane-roy]], not money/main-bank")).toEqual(["money/main-bank", "people/jane-roy", "projects/course-a"]);
});

test("invariants catch a leak even when it was saved as the expected answer", () => {
  const ok: Step[] = [
    { step: "read", status: 200, says: "x", notes: ["projects/course-a"] },
    { step: "hidden", status: 200, says: "error: no note money/main-bank in your view" },
    { step: "g74", status: 200, says: "no withheld value or hidden id (beliefs fix exit 0)" },
    { step: "paused", status: 403, says: "x" },
    { step: "revoked", status: 401, says: "x" },
  ];
  expect(invariants({ mcp: ok })).toEqual([]);
  const bad = ok.map((s) => s.step === "g74" ? { ...s, says: "LEAKS: money/main-bank#bank (exact)" } : s.step === "paused" ? { ...s, status: 200 } : s);
  expect(invariants({ oauth: bad })).toEqual(["oauth g74: memory sync hands over money/main-bank#bank (exact)", "oauth paused: answered 200, not 403"]);
});

test("the saved answers cover every door and every step, and keep the slice shut", () => {
  const saved0 = JSON.parse(readFileSync(join(import.meta.dir, "e2e", "doors.json"), "utf8")) as Record<string, Step[]>;
  expect(invariants(saved0)).toEqual([]);
  const saved = JSON.parse(readFileSync(join(import.meta.dir, "e2e", "doors.json"), "utf8")) as Record<string, Step[]>;
  expect(Object.keys(saved).sort()).toEqual([...DOORS].sort());
  for (const door of DOORS) {
    const by = Object.fromEntries(saved[door].map((s) => [s.step, s]));
    expect(saved[door].map((s) => s.step)).toEqual([...STEPS]);
    expect(by.read.notes).not.toContain("money/main-bank");
    expect(by.hidden.says).toContain("no note money/main-bank in your view");
    expect(by.paused.status).toBe(403);
    expect(by.revoked.status).toBe(401);
    expect(by.held.says).toContain("inbox");
  }
});
