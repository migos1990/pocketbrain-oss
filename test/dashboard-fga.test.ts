// SPDX-License-Identifier: AGPL-3.0-only
// The dashboard's live view of the FGA store (src/dashboard/html-fga.ts) and the video reset's local
// OpenFGA setup when no server is running.
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { loadState } from "../src/dashboard/data";
import { fgaGrid, fgaPage } from "../src/dashboard/html-fga";
import type { FgaClient } from "../src/fga";

const env = () => { const e: Record<string, string | undefined> = { ...process.env }; delete e.PB_NOW; delete e.PB_TODAY; return e; };
const reset = (dir: string, ...flags: string[]) =>
  Bun.spawnSync(["bun", join(import.meta.dir, "..", "scripts", "video-reset.ts"), "--no-serve", ...flags], { env: { ...env(), PB_VIDEO_DIR: dir, PB_VIDEO_FGA_URL: "http://127.0.0.1:1" } });

test("the FGA page lists each assistant's slices by name, live from the store, and says when FGA can't be reached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-fga-page-"));
  expect(reset(dir).exitCode).toBe(0);
  const brain = join(dir, "brain");
  const s = loadState(brain);
  expect(await fgaGrid(s)).toContain("FGA is off");
  writeFileSync(join(brain, "rules", "fga.yaml"), YAML.stringify({ api_url: "http://127.0.0.1:1", store_id: "01TEST" }));
  const fake = { readAll: async () => [
    { user: "agent:claude", relation: "reader", object: "slice:area__strategy" },
    { user: "agent:town", relation: "reader", object: "slice:area__org" },
  ] } as unknown as FgaClient;
  const grid = await fgaGrid(s, fake);
  expect(grid).toContain("Maya&#39;s claude.ai");
  expect(grid).toContain("slice:area__strategy");                 // the raw object, which the 0158 take looks for
  expect(grid).toContain("2 relationships");
  expect(await fgaGrid(s, { readAll: async () => [] } as unknown as FgaClient)).toContain("no assistant gets any slice");
  expect(await fgaGrid(s)).toContain("fails closed");             // nothing listens on port 1
  const page = await fgaPage(s);
  expect(page.body).toContain("Second lock: FGA");
  expect(page.body).toContain("01TEST");
});

test("--local-fga with no OpenFGA running turns FGA off for the take instead of failing", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-fga-reset-"));
  const r = reset(dir, "--local-fga");
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toContain("FGA is OFF for this take");
  expect(existsSync(join(dir, "brain", "rules", "fga.yaml"))).toBe(false);
});
