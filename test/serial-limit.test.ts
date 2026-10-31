// SPDX-License-Identifier: AGPL-3.0-only
// One job in the hub's write queue (serial(), src/server.ts) that never finishes held every later
// write on every door (architecture review A3, backlog 404, gap G389; the Messages hang was one such job).
// Past its time limit the queue moves on: the job's caller gets an error, the hub logs it and
// alerts once, and doors and /health keep answering.
import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { handle, serial } from "../src/server";
import { issueToken } from "../src/auth";

const alerts = (root: string) => existsSync(join(root, "log", "alerts.jsonl")) ? readFileSync(join(root, "log", "alerts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];

test("a job that hangs in the write queue is let go at its limit; writes, reads and /health go on", async () => {
  const root = makeBrain();
  const tok = issueToken(root, "steward");
  const call = (method: string, path: string, body?: unknown) => handle(root, new Request(`http://pb${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${tok}` } }));
  expect((await call("GET", "/health")).status).toBe(200); // the hub knows its brain
  const hung = serial(() => new Promise<never>(() => {}), { name: "test-hang", limitMs: 100 });
  const t0 = Date.now();
  const w = await call("POST", "/v1/remember", { id: "projects/course-a", attribute: "next_step", value: "Publish grades", as_of: "2026-10-07", sources: ["gmail:f000000000000006"], verification: "verified-by-source" });
  expect(w.status).toBe(200);
  expect(Date.now() - t0).toBeLessThan(5000);
  await expect(hung).rejects.toThrow("test-hang");
  expect((await call("GET", "/health")).status).toBe(200);
  const a = alerts(root).filter((x) => x.check === "job_timeout");
  expect(a.length).toBe(1);
  expect(a[0].from).toContain("test-hang");
  // The same job hanging again the same day is logged, not alerted again.
  await serial(() => new Promise<never>(() => {}), { name: "test-hang", limitMs: 50 }).catch(() => undefined);
  expect(alerts(root).filter((x) => x.check === "job_timeout").length).toBe(1);
  expect(readFileSync(join(root, "log", "jobs.jsonl"), "utf8").trim().split("\n").length).toBeGreaterThanOrEqual(2);
});
