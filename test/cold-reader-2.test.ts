// SPDX-License-Identifier: AGPL-3.0-only
// The cold reader on the overview (2026-10-24, screenshots only, 3/5 sure): "Add this to TECH 101
// fall 2026?" over "Status: active" ("add what?"); two "Keep Beta testers: …" with nothing to pick
// from; "the hub" and "Seen them"; "Everything else waiting (13)" under a 5.
import { test, expect } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { git } from "../src/git";
import { loadState } from "../src/dashboard/data";
import { overview } from "../src/dashboard/html";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");

test("a new fact is asked with its value in the question", () => {
  const root = makeBrain();
  expect(write(root, { agent: "helper", id: "projects/course-a", attribute: "status", value: "active", as_of: "2026-10-07", sources: ["gmail:f000000000000101"], verification: "verified-by-source" } as never).outcome).toBe("inbox");
  const words = text(overview(loadState(root), "x").body);
  expect(words).toMatch(/Save “active” as Course A ?'s status\?/);
});

test("the home page's other lines say what they are", () => {
  const root = makeBrain();
  mkdirSync(join(root, "log"), { recursive: true });
  appendFileSync(join(root, "log", "alerts.jsonl"), JSON.stringify({ at: new Date().toISOString(), agent: "hub", check: "probe_disk", from: "x" }) + "\n");
  for (let i = 1; i <= 9; i++) write(root, { agent: "helper", id: "projects/course-a", attribute: `meeting_${i}`, value: `Meeting ${i}`, as_of: "2026-10-07", sources: [`gmail:f0000000000001${String(i).padStart(2, "0")}`], verification: "verified-by-source" } as never);
  const words = text(overview(loadState(root), "x").body);
  expect(words).not.toMatch(/\bthe hub\b|Seen them|Everything else waiting/);
});

