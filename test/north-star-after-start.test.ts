// SPDX-License-Identifier: AGPL-3.0-only
// Audit v4: the real brain's north star ran only when someone set PB_NORTH_STAR_BRAIN. The hub now
// measures it once per code version after it starts (so after every deploy), report-only, counts
// only, in log/north-star.json.
import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { northStarAfterStart, codeVersion } from "../src/probe";

test("the hub records the real brain's north star once per code version, without an alert", async () => {
  const root = makeBrain();
  const runs: string[][] = [];
  const spawn = async (cmd: string[]) => { runs.push(cmd); return { exit: 1, out: JSON.stringify({ pass: false, asks: 23, not_conflict: 20, home_asks: 3 }) + "\n", err: "" }; };
  const r = await northStarAfterStart(root, { code: "aaaa111", spawn });
  expect(runs.length).toBe(1);
  expect(runs[0]).toContain("--brain");
  expect(runs[0]).toContain(root);
  expect(runs[0]).toContain("--json");
  expect(r?.counts).toEqual({ pass: false, asks: 23, not_conflict: 20, home_asks: 3 });
  expect(JSON.parse(readFileSync(join(root, "log", "north-star.json"), "utf8")).code).toBe("aaaa111");
  // The same code again: nothing runs. New code (a deploy): it runs again.
  expect(await northStarAfterStart(root, { code: "aaaa111", spawn })).toBeUndefined();
  expect(runs.length).toBe(1);
  await northStarAfterStart(root, { code: "bbbb222", spawn });
  expect(runs.length).toBe(2);
  // Report-only: nothing reaches the owner as an alert.
  const alerts = join(root, "log", "alerts.jsonl");
  expect(existsSync(alerts) ? readFileSync(alerts, "utf8") : "").not.toContain("north");
});

test("a run that prints no counts is kept with its error line", async () => {
  const root = makeBrain();
  const r = await northStarAfterStart(root, { code: "cccc333", spawn: async () => ({ exit: 2, out: "", err: "boom\n--brain <path to a brain>\n" }) });
  expect(r?.counts).toBeUndefined();
  expect(r?.error).toBe("--brain <path to a brain>");
});

test("the real script prints counts only, no page names, with --json", () => {
  const root = makeBrain();
  const r = Bun.spawnSync(["bun", "scripts/north-star.ts", "--brain", root, "--json"], { stdout: "pipe", stderr: "pipe" });
  const c = JSON.parse(r.stdout.toString().trim());
  expect(Object.keys(c).sort()).toEqual(["asks", "asks_by_kind", "assistant_expiring", "assistant_held", "held_by_access", "home_asks", "not_conflict", "pages", "pages_beyond_hub", "pages_ok", "pages_quoted", "pass", "share"]);
  expect(r.stdout.toString()).not.toMatch(/people\/|projects\//);
  expect(codeVersion()).toMatch(/^[0-9a-f]{40}$/);
});

test("/health answers the running hub's own code sha, the one deploy go verifies", async () => {
  const { handle } = await import("../src/server");
  const root = makeBrain();
  const h = await (await handle(root, new Request("http://127.0.0.1/health"))).json() as { ok: boolean; code?: string };
  expect(h).toEqual({ ok: true, code: codeVersion() });
});

test("northStarFor runs once per code and otherwise returns the record kept for that code", async () => {
  const { northStarFor } = await import("../src/probe");
  const root = makeBrain();
  let n = 0;
  const spawn = async () => { n++; return { exit: 0, out: JSON.stringify({ pass: true, asks: 2 }) + "\n", err: "" }; };
  expect((await northStarFor(root, "dddd444", { spawn }))?.counts).toEqual({ pass: true, asks: 2 });
  expect((await northStarFor(root, "dddd444", { spawn }))?.counts).toEqual({ pass: true, asks: 2 });
  expect(n).toBe(1);
  expect(await northStarFor(root, "eeee555", { spawn: async () => ({ exit: 2, out: "", err: "x" }) })).toMatchObject({ code: "eeee555", error: "x" });
});

test("/health names the running sha only to a loopback caller: never through the public door or a proxy", async () => {
  const { handle } = await import("../src/server");
  const root = makeBrain();
  const health = async (url: string, headers: Record<string, string> = {}) => await (await handle(root, new Request(url, { headers }))).json() as { ok: boolean; code?: string };
  expect((await health("http://localhost:8787/health")).code).toBe(codeVersion());
  expect((await health("http://[::1]:8787/health")).code).toBe(codeVersion());
  expect(await health("https://brain.example/health")).toEqual({ ok: true });
  // The tunnel connects from loopback; its headers give it away even with a loopback Host.
  expect(await health("http://127.0.0.1:8787/health", { "cf-connecting-ip": "203.0.113.9" })).toEqual({ ok: true });
  expect(await health("http://127.0.0.1:8787/health", { "x-forwarded-for": "100.64.0.2" })).toEqual({ ok: true });
  expect(await health("http://127.0.0.1:8787/health", { forwarded: "for=203.0.113.9" })).toEqual({ ok: true });
});
