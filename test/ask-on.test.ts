// SPDX-License-Identifier: AGPL-3.0-only
// Turning ask-to-see on or off is configuration, not a hand fix (stranger rehearsal #3, N2):
// `pocketbrain ask on|off` edits only rules/policy.yaml's ask_to_see and commits as the owner, so
// the real-use bar's hand-edit count (handEdits, src/measure.ts) skips it. A raw hand edit to
// rules/ still counts.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { handEdits } from "../src/measure";
import { loadRules } from "../src/rules";
import { askPolicy } from "../src/asks";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const cli = (root: string, ...a: string[]) => {
  const r = Bun.spawnSync(["bun", CLI, ...a], { env: { ...process.env, PB_BRAIN: root } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const git = (root: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root }).stdout.toString().trim();
const policy = (root: string) => readFileSync(join(root, "rules", "policy.yaml"), "utf8");

test("ask on writes ask_to_see as the owner, keeps the rest of policy.yaml, and isn't a hand edit", () => {
  const root = makeBrain();
  const before = policy(root);
  const r = cli(root, "ask", "on", "--never", "money,health", "--max-per-day", "3");
  expect(r.code).toBe(0);
  expect(askPolicy(loadRules(root))).toMatchObject({ approver: "dashboard", never: ["money", "health"], max_per_day: 3 });
  const rest = YAML.parse(policy(root)); delete rest.ask_to_see;
  const old = YAML.parse(before); delete old.ask_to_see;
  expect(rest).toEqual(old);
  expect(git(root, "show", "--name-only", "--format=", "HEAD")).toBe("rules/policy.yaml");
  expect(handEdits(root)).toEqual([]);
  // A second flag keeps the first ones.
  expect(cli(root, "ask", "on", "--max-per-day", "4").code).toBe(0);
  expect(askPolicy(loadRules(root))).toMatchObject({ never: ["money", "health"], max_per_day: 4 });
  expect(cli(root, "ask", "off").code).toBe(0);
  expect(askPolicy(loadRules(root))).toBeUndefined();
  expect(handEdits(root)).toEqual([]);
  // The same change typed by hand still resets the bar.
  writeFileSync(join(root, "rules", "policy.yaml"), policy(root).replace("ask_to_see: false", "ask_to_see: true"));
  git(root, "-c", "user.name=robin", "-c", "user.email=r@x", "commit", "-qam", "ask_to_see by hand");
  expect(handEdits(root).map((e) => e.what)).toEqual(["hand edit: " + git(root, "log", "-1", "--format=%h") + " ask_to_see by hand"]);
});

test("ask on refuses a value that isn't one, and guardian without an application", () => {
  const root = makeBrain(), head = git(root, "rev-parse", "HEAD");
  expect(cli(root, "ask", "on", "--approver", "sms").code).toBe(2);
  expect(cli(root, "ask", "on", "--max-per-day", "0").code).toBe(2);
  expect(cli(root, "ask", "on", "--max-per-day", "lots").code).toBe(2);
  expect(cli(root, "ask", "on", "--never", "money;rm -rf").code).toBe(2);
  expect(cli(root, "ask", "on", "--approver", "guardian").code).toBe(2);
  expect(cli(root, "ask", "on", "--client-id", "not an id").code).toBe(2);
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
  expect(cli(root, "ask", "on", "--approver", "guardian", "--client-id", "AbCdEf0123456789").code).toBe(0);
  expect(askPolicy(loadRules(root))).toMatchObject({ approver: "guardian", guardian: { client_id: "AbCdEf0123456789" } });
});
