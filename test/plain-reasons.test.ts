// SPDX-License-Identifier: AGPL-3.0-only
// Why a proposal waits, in words on Settings (new-user phone run, 2026-10-24:
// "Why it waits: area work is owned by planner (own_area)").
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadState } from "../src/dashboard/data";
import { overview } from "../src/dashboard/html";

test("a write outside an assistant's own area says who looks after it, never the code word", () => {
  const root = makeBrain();
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "2026-10-08-helper-area.yaml"), YAML.stringify({ proposed: "2026-10-08", by: "helper", reason: "area projects is owned by planner (own_area)", request: { agent: "helper", kind: "fact", id: "projects/course-a", attribute: "room", value: "B-204", as_of: "2026-10-07", sources: ["gmail:f000000000000005"] } }));
  const html = overview(loadState(root), "x").body;
  expect(html).not.toContain("own_area");
  expect(html).toContain("planner looks after projects, so it waits for you.");
}, 60_000);
