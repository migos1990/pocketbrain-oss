// SPDX-License-Identifier: AGPL-3.0-only
// The owner-canvas re-audit (builder, 2026-10-31, G573): a family line on a page the owner made
// private since says only that something is new on a 30-day sign-in, like every other line.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { dashboardHandler } from "../src/dashboard/server";
import { setNoteSensitivity } from "../src/dashboard/edit";
import { setFamilyLinks } from "../src/ownerset";
import { linkFamily } from "../src/family";

const H = "127.0.0.1:8792";
test("a family line on a page made private since says only that something is new", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    writeFileSync(join(root, "people/jules-lefebvre.md"), "---\nid: people/jules-lefebvre\ntype: person\ntitle: Jules Lefebvre\narea: personal\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: owner\nfacts:\n  city:\n    value: Lyon\n    as_of: 2026-10-01\n    sources:\n      - owner:2026-10-01/home\n    verification: confirmed-by-owner\n---\nJules.\n");
    Bun.spawnSync(["git", "-C", root, "add", "people/jules-lefebvre.md"]); Bun.spawnSync(["git", "-C", root, "commit", "-qm", "jules", "--author", "owner <owner@x>"]);
    setFamilyLinks(root, "on");
    const r = linkFamily(root);
    expect(r.filed.length).toBeGreaterThan(0);
    let t = Date.parse(DEMO_NOW);
    const d = dashboardHandler(root, { port: 8792, loginKey: "k".repeat(32), now: () => new Date(t) });
    const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const get = async (p: string) => (await d.handle(new Request(`http://${H}${p}`, { headers: { host: H, cookie } }))).text();
    const before = await get("/home?all=1");
    expect(before).toContain("may be family");
    const id = r.filed[0]!;
    setNoteSensitivity(root, id, "private");
    t += 31 * 60_000;
    const all = await get("/home?all=1");
    expect(all).not.toContain("may be family");
  } finally { delete process.env.PB_NOW; }
}, 90_000);
