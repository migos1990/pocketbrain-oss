// SPDX-License-Identifier: AGPL-3.0-only
// Request budget on the dashboard (backlog 267): each agent's page shows its requests in the last
// minute and writes in the last hour against its budget, per token role, so a looping agent is
// visible before it hits 429. The counts live in the hub's memory: a dashboard run on its own
// says so instead of showing zeros.
import { test, expect, beforeEach } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { resetBudgets, spend, budgetUse, markServing } from "../src/budget";
import { dashboardHandler } from "../src/dashboard/server";

beforeEach(() => resetBudgets());

const H = "127.0.0.1:8793";
async function page(root: string, path: string) {
  const d = dashboardHandler(root, { port: 8793, loginKey: "k".repeat(32) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0];
  return (await d.handle(new Request(`http://${H}${path}`, { headers: { host: H, cookie } }))).text();
}
const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("budgetUse counts the last minute's requests and the last hour's writes against each role's cap", () => {
  const root = makeBrain();
  const now = Date.parse("2026-10-16T12:00:00Z");
  for (let i = 0; i < 5; i++) spend(root, "planner", "request", now - i * 1000);
  spend(root, "planner", "request", now - 90_000); // over a minute ago: not counted
  for (let i = 0; i < 3; i++) spend(root, "planner", "write", now - i * 600_000);
  spend(root, "planner", "write", now - 2 * 3_600_000); // over an hour ago
  spend(root, "planner", "request", now, { role: "resolver" });
  spend(root, "helper", "request", now);
  const use = budgetUse(root, "planner", { now });
  expect(use).toEqual([
    { requests: 5, writes: 3, requests_per_minute: 120, writes_per_hour: 300 },
    { role: "resolver", requests: 1, writes: 0, requests_per_minute: 1200, writes_per_hour: 3000 },
  ]);
  // An agent with nothing counted yet still has its plain row, at zero.
  expect(budgetUse(root, "steward", { now })).toEqual([{ requests: 0, writes: 0, requests_per_minute: 120, writes_per_hour: 300 }]);
  // Another brain served by the same process doesn't count here.
  expect(budgetUse(makeBrain(), "planner", { now })[0].requests).toBe(0);
});

test("the agent's page shows its live counts against its budget, and marks one close to the cap", async () => {
  const root = makeBrain();
  const file = join(root, "rules", "policy.yaml");
  const p = YAML.parse(readFileSync(file, "utf8"));
  p.agents.planner.budget = { requests_per_minute: 10 };
  writeFileSync(file, YAML.stringify(p));
  markServing(root);
  const now = Date.now();
  for (let i = 0; i < 9; i++) spend(root, "planner", "request", now);
  spend(root, "planner", "write", now);
  const t = plain(await page(root, "/agent/planner"));
  expect(t).toContain("9 of 10 requests in the last minute");
  expect(t).toContain("1 of 300 writes in the last hour");
  expect(await page(root, "/agent/planner")).toMatch(/class="[^"]*hot[^"]*"[^>]*>9 of 10 requests/);
  const h = plain(await page(root, "/agent/helper"));
  expect(h).toContain("0 of 120 requests in the last minute");
});

test("a dashboard that doesn't serve the agents says the counts are the hub's, not zero", async () => {
  const root = makeBrain();
  const t = plain(await page(root, "/agent/planner"));
  expect(t).toContain("counted by the hub");
  expect(t).not.toContain("0 of 120 requests");
});
