// SPDX-License-Identifier: AGPL-3.0-only
// Builder slice audit of claude/audit9-fixes (owner side, tree 83ea2a34, 2026-10-31; G582).
// Fails: a fact made private after its write still shows in Ask on the 30-day sign-in (about() and askProse use the page's opening prose).
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { dashboardHandler } from "../src/dashboard/server";

const H = "127.0.0.1:8789";
const ID = "projects/product-discovery-course";
test("a fact made private after its write: no stale-cookie screen shows it", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    let t = Date.parse(DEMO_NOW);
    const d = dashboardHandler(root, { port: 8789, loginKey: "k".repeat(32), now: () => new Date(t) });
    const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const req = async (m: string, p: string, f?: Record<string, string>) => (await d.handle(new Request(`http://${H}${p}`, { method: m, body: f ? new URLSearchParams(f) : undefined, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/ask`, ...(f ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }))).text();
    const csrf = (await req("GET", "/home")).match(/name="csrf" value="([^"]+)"/)![1]!;
    const f = join(root, `${ID}.md`);
    // the owner's "status" fact made private (record level), page stays personal
    writeFileSync(f, readFileSync(f, "utf8").replace(/(  status:\n    value: week 6 of 13\n)/, "$1    sensitivity: private\n"));
    t += 31 * 60_000;
    const page = await req("GET", `/p/${ID}`);
    const say = await req("POST", "/say", { csrf, q: "What about Product Discovery course?", from: "ask" });
    const ask = await req("GET", "/ask");
    const mem = await req("GET", "/memory?q=week%206");
    expect(page).not.toContain("week 6 of 13");
    expect(ask).not.toContain("week 6 of 13");
    expect(say).not.toContain("week 6 of 13");
  } finally { delete process.env.PB_NOW; }
}, 90_000);
