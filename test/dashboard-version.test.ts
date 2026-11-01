// SPDX-License-Identifier: AGPL-3.0-only
// Use-it check, 2026-11-01: after a deploy the owner could not tell from the dashboard which
// version was running; no page showed it. Settings now ends with the release number from
// package.json and the short sha of the code the hub started on (G620).
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { dashboardHandler } from "../src/dashboard/server";
import { codeAtStart } from "../src/util";

const H = "127.0.0.1:8796";
test("Settings names the running version and the code it started on", async () => {
  const root = makeBrain();
  const d = dashboardHandler(root, { port: 8796, loginKey: "k".repeat(32) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
  const page = await (await d.handle(new Request(`http://${H}/overview`, { headers: { host: H, cookie } }))).text();
  const version = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version as string;
  expect(page).toContain(`pocketBrain ${version}`);
  const sha = codeAtStart().slice(0, 7);
  if (sha) expect(page).toContain(`code ${sha}`);
  // The home, the owner's first screen, stays free of it: Settings is where it lives.
  const home = await (await d.handle(new Request(`http://${H}/home`, { headers: { host: H, cookie } }))).text();
  expect(home).not.toContain(`pocketBrain ${version}`);
});
