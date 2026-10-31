// SPDX-License-Identifier: AGPL-3.0-only
// G184 after main's one-command kinds: `connect <agent> --kind …`, `add --kind …` and init's
// Claude Code step make a token in the terminal, so they pass the same terminal gate as `connect`,
// `invite` and `edge enroll`: a narrow trial agent alone, a wider one only with the owner's
// one-time code. A refused kind changes nothing: no token, no browser door, no claude mcp add,
// no ~/.claude/CLAUDE.md.
import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { main } from "../src/cli";
import { runAction } from "../src/dashboard/actions";

function run(root: string, ...args: string[]) {
  const out: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { out.push(a.join(" ")); };
  let code: number;
  try { code = main([...args, "--brain", root]); } finally { console.log = log; console.error = err; }
  return { code, out: out.join("\n") };
}
const tokens = (root: string, agent: string) => {
  const f = join(root, "rules/tokens.yaml");
  return existsSync(f) ? ((YAML.parse(readFileSync(f, "utf8"))?.agents?.[agent] ?? []) as unknown[]) : [];
};
const policy = (root: string) => YAML.parse(readFileSync(join(root, "rules/policy.yaml"), "utf8")).agents;

// A fake `claude` on PATH that records its calls, and a HOME of our own for ~/.claude/CLAUDE.md.
function withFakeClaude<T>(fn: (calls: string, home: string) => T): T {
  const bin = mkdtempSync(join(tmpdir(), "pb-bin-")), home = mkdtempSync(join(tmpdir(), "pb-home-"));
  const calls = join(bin, "calls.log");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$@" >> "${calls}"\nexit 0\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const old = { PATH: process.env.PATH, HOME: process.env.HOME };
  process.env.PATH = `${bin}:${old.PATH}`;
  process.env.HOME = home;
  try { return fn(calls, home); } finally { process.env.PATH = old.PATH; process.env.HOME = old.HOME; }
}

test("G184: connect <wide agent> --kind claude-code|town|browser mints nothing from a shell and changes nothing", () => {
  const root = makeBrain();
  withFakeClaude((calls, home) => {
    for (const kind of ["claude-code", "town", "browser"]) {
      const r = run(root, "connect", "steward", "--kind", kind);
      expect([kind, r.code, /pb_[A-Za-z0-9]+_[A-Za-z0-9_-]{20,}/.test(r.out)]).toEqual([kind, 1, false]);
      expect(r.out).toContain("One-time code");
      expect(r.out).toContain(`connect steward --kind ${kind} --code <code>`);
    }
    expect(tokens(root, "steward")).toEqual([]);
    expect(policy(root).steward.browser).toBeUndefined();
    expect(existsSync(calls)).toBe(false);
    expect(existsSync(join(home, ".claude", "CLAUDE.md"))).toBe(false);
  });
});

test("G184: connect <wide agent> --kind … works with the owner's one-time code, once", () => {
  const root = makeBrain();
  const code = runAction({ root }, "token-code", { agent: "steward" }).match(/[0-9A-Z]{5}-[0-9A-Z]{5}/)![0];
  const r = run(root, "connect", "steward", "--kind", "town", "--code", code);
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/pb_[A-Za-z0-9]+_[A-Za-z0-9_-]{20,}/);
  expect(tokens(root, "steward").length).toBe(1);
  const again = run(root, "connect", "steward", "--kind", "town", "--code", code);
  expect(again.code).toBe(1);
  expect(tokens(root, "steward").length).toBe(1);
});

test("G184, G241: add --kind with a reach wider than the terminal may mint for is refused before anything is granted", () => {
  const root = makeBrain();
  withFakeClaude((calls, home) => {
    for (const kind of ["town", "claude-code", "browser"]) {
      const agent = `wide-${kind.replace(/[^a-z]/g, "")}`;
      const r = run(root, "add", agent, "--kind", kind, "--slices", "area:personal,area:work,contacts-basic", "--yes");
      expect([kind, r.code, /pb_[A-Za-z0-9]+_[A-Za-z0-9_-]{20,}/.test(r.out)]).toEqual([kind, 1, false]);
      expect(r.out).toContain("Nothing granted");
      expect(policy(root)[agent]).toBeUndefined();
      expect(tokens(root, agent)).toEqual([]);
    }
    expect(existsSync(calls)).toBe(false);
    expect(existsSync(join(home, ".claude", "CLAUDE.md"))).toBe(false);
  });
});

test("G184, G241: add --kind's own preset stays inside the gate, so the one-command flow still mints", () => {
  const root = makeBrain();
  withFakeClaude((calls) => {
    const r = run(root, "add", "cc2", "--kind", "claude-code", "--yes");
    expect(r.code).toBe(0);
    expect(policy(root).cc2.slices).toEqual(["area:work", "contacts-basic"]);
    expect(tokens(root, "cc2").length).toBe(1);
    expect(readFileSync(calls, "utf8")).toContain("mcp add");
  });
});

test("G184: src/cli.ts makes no token except through the terminal gate", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8");
  expect(src.match(/\bissueToken\s*\(/g) ?? []).toEqual([]);
  expect(src).not.toMatch(/import\s*\{[^}]*\bissueToken\b[^}]*\}\s*from\s*"\.\/auth"/);
});
