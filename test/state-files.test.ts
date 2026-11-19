// SPDX-License-Identifier: AGPL-3.0-only
// G1015: the hub's own state files are replaced whole or not at all. log/start-state.json and
// log/watchdog.json were written in place: a crash or a full disk mid-write left half a file, which
// reads as empty, so the day's jobs ran again (a second digest) and a recorded job failure was forgotten.
import { test, expect } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";

test("G1015 a state file whose write fails keeps what it held, and a write that works leaves no temp file", async () => {
  const { writeWhole } = await import("../src/util");
  const root = makeBrain();
  const f = join(root, "log", "start-state.json");
  mkdirSync(join(root, "log"), { recursive: true });
  writeFileSync(f, JSON.stringify({ night: "2026-10-08" }));
  // The write can't be made: something sits where its temp file goes (a full disk fails the same step).
  mkdirSync(`${f}.${process.pid}.tmp`);
  expect(() => writeWhole(f, JSON.stringify({ night: "2026-10-09", digest: "2026-10-09" }))).toThrow();
  expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ night: "2026-10-08" });
  const { rmdirSync } = await import("node:fs");
  rmdirSync(`${f}.${process.pid}.tmp`);
  writeWhole(f, JSON.stringify({ night: "2026-10-09" }));
  expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ night: "2026-10-09" });
  expect(readdirSync(join(root, "log")).filter((x) => x.endsWith(".tmp"))).toEqual([]);
});

test("G1015 the daily jobs' state and the watchdog's state are never written in place", () => {
  for (const file of ["start.ts", "watchdog.ts"]) {
    const src = readFileSync(join(import.meta.dir, "..", "src", file), "utf8");
    expect({ file, inPlace: src.split("\n").filter((l) => /writeFileSync\(stateFile\(/.test(l)).length }).toEqual({ file, inPlace: 0 });
    expect(src).toContain("writeWhole(stateFile(");
  }
});
