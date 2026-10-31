// SPDX-License-Identifier: AGPL-3.0-only
// The Memory Passport conformance suite against a server in another language (outside review,
// 2026-10-29, G492): conformance/reference_server.py, Python standard library only, over real HTTP.
// A spec with implementations in two languages that pass the same suite is a standard, not a format.
import { test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { runConformance, type Fixture } from "../conformance/suite";
import { loadFixture } from "../conformance/reference-server";

const fx = loadFixture() as unknown as Fixture;
const procs: { kill(): void }[] = [];
afterAll(() => { for (const p of procs) p.kill(); });

async function start(): Promise<{ url: string; full: string; limited: string; resolver: string; waiting: string }> {
  const p = Bun.spawn(["python3", "-I", join(import.meta.dir, "..", "conformance", "reference_server.py"), "0"], { stdout: "pipe", stderr: "inherit" });
  procs.push(p);
  const reader = p.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("the Python server exited before it printed its tokens");
    text += new TextDecoder().decode(value);
  }
  return JSON.parse(text.split("\n")[0]!);
}

test("G492: the Python server passes every conformance check, none skipped", async () => {
  const s = await start();
  const results = await runConformance((path, init) => fetch(`${s.url}${path}`, init), fx,
    { name: fx.agents.full.name, token: s.full }, { name: fx.agents.limited.name, token: s.limited }, { resolver: s.resolver, waiting: s.waiting });
  expect(results.filter((r) => !r.ok).map((r) => `${r.id}: ${r.detail}`)).toEqual([]);
  expect(results.filter((r) => r.skipped).map((r) => r.id)).toEqual([]);
  expect(results.length).toBeGreaterThanOrEqual(34);
}, 60_000);

test("G492: the Python server shares no code with pocketBrain: standard library only", async () => {
  const src = await Bun.file(join(import.meta.dir, "..", "conformance", "reference_server.py")).text();
  const imports = [...src.matchAll(/^(?:import|from) ([\w.]+)/gm)].flatMap((m) => m[1]!.split(",")).map((x) => x.trim().split(".")[0]);
  const STDLIB = new Set(["hashlib", "hmac", "json", "re", "secrets", "sys", "threading", "time", "datetime", "http", "pathlib", "urllib"]);
  expect(imports.filter((i) => !STDLIB.has(i!))).toEqual([]);
});
