// SPDX-License-Identifier: AGPL-3.0-only
// `<command> --help` explains the command and does nothing else (a stranger checking flags
// on `start` used to launch the hub in the foreground).
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { main } from "../src/cli";

const run = (args: string[]) => {
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  let code: number;
  try { code = main(args); } finally { console.log = log; }
  return { code, text: out.join("\n") };
};

test("start --help prints its usage lines and starts nothing", () => {
  const root = makeBrain();
  const r = run(["start", "--help", "--brain", root]);
  expect(r.code).toBe(0);
  expect(r.text).toContain("start [--port 8787]");
  expect(r.text).not.toContain("listening");
});

test("--help on a command with no usage line points at help --all", () => {
  const r = run(["no-such-command", "--help"]);
  expect(r.code).toBe(0);
  expect(r.text).toContain("pocketbrain help --all");
});

test("init prints the standing instruction the quickstart tells you to paste", () => {
  const dir = `${require("node:os").tmpdir()}/pb-init-${Date.now()}`;
  const r = run(["init", dir, "--name", "Sam"]);
  expect(r.code).toBe(0);
  expect(r.text).toContain("paste this once into its own custom instructions");
  expect(r.text).toContain("call context_pack");
});
