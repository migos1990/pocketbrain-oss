// SPDX-License-Identifier: AGPL-3.0-only
// /b/changes' look-back links count from the hub's clock, which PB_NOW pins in tests (as in
// src/dashboard/data.ts and src/core.ts), not straight from the wall clock.
import { test, expect, afterEach } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";

afterEach(() => { delete process.env.PB_NOW; });

test("/b/changes' look-back links count from PB_NOW", async () => {
  const root = makeBrain();
  const p = join(root, "rules/policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace(/^  helper: \{ /m, "  helper: { browser: true, "));
  const token = issueToken(root, "helper");
  const login = await handle(root, new Request("http://pb/b/login", { method: "POST", body: new URLSearchParams({ agent: "helper", password: token }), headers: { "content-type": "application/x-www-form-urlencoded" } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  process.env.PB_NOW = "2024-03-10T23:30:00Z";
  const page = await (await handle(root, new Request("http://pb/b/changes", { headers: { cookie } }))).text();
  expect(page).toContain("since=2024-03-03T00%3A00%3A00Z\">Last 7 days");
  expect(page).toContain("since=2024-02-09T00%3A00%3A00Z\">Last 30 days");
});
