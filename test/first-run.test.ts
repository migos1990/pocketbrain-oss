// SPDX-License-Identifier: AGPL-3.0-only
// A stranger's first run (docs/quickstart.md): init counts the owner's day in this computer's time
// zone, not the default one, and the short help lists what a newcomer needs, not the real-use bar.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { initBrain } from "../src/init";

const withTz = <T>(tz: string, f: () => T): T => {
  const was = process.env.TZ;
  process.env.TZ = tz;
  try { return f(); } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
};
const owner = (root: string) => YAML.parse(readFileSync(join(root, "rules", "policy.yaml"), "utf8")).owner;
const fresh = () => initBrain(join(mkdtempSync(join(tmpdir(), "pb-first-")), "brain"), { owner: "Sam", agent: "cursor", token: false }).root;

test("init writes this computer's time zone into owner.timezone", () => {
  expect(owner(withTz("Europe/Paris", fresh))).toEqual({ name: "Sam", timezone: "Europe/Paris" });
});

test("a computer that only says UTC, or is in the default zone already, keeps the default", () => {
  expect(owner(withTz("UTC", fresh)).timezone).toBeUndefined();
  expect(owner(withTz("America/Toronto", fresh)).timezone).toBeUndefined();
});

test("the short help names what a newcomer needs, and leaves the real-use bar to help --all", () => {
  const short = Bun.spawnSync(["bun", "src/cli.ts", "help"], { cwd: join(import.meta.dir, "..") }).stdout.toString();
  expect(short).toContain("token --revoke <agent>");
  expect(short).toContain("--kind <kind>");
  for (const cmd of ["reexplain", "  week ", "  bar ", "menubar"]) expect(short).not.toContain(cmd);
  const all = Bun.spawnSync(["bun", "src/cli.ts", "help", "--all"], { cwd: join(import.meta.dir, "..") }).stdout.toString();
  for (const cmd of ["reexplain", "menubar"]) expect(all).toContain(cmd);
});
