// SPDX-License-Identifier: AGPL-3.0-only
// A home line decides what it may say from the page as it is now, not from the diary row it was
// written from (owner-canvas slice audit, 2026-10-31; audit v7's rule): a page the owner made
// private after its change says only "Something new about …" on a sign-in older than 10 minutes,
// on the face and on the full list, with neither value nor what it was. The same holds for a fact
// whose live record was made private.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { dashboardHandler } from "../src/dashboard/server";
import { setNoteSensitivity } from "../src/dashboard/edit";
import { homeView } from "../src/dashboard/home";
import { loadRules } from "../src/rules";
import { loadBrain } from "../src/brain";

const H = "127.0.0.1:8795";
test("a page raised to private after its change: the home on a 30-day sign-in names it and nothing more", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    let t = Date.parse(DEMO_NOW);
    const d = dashboardHandler(root, { port: 8795, loginKey: "k".repeat(32), now: () => new Date(t) });
    const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const get = async (p: string) => (await d.handle(new Request(`http://${H}${p}`, { headers: { host: H, cookie } }))).text();
    expect(await get("/home?all=1")).toContain("head TA");
    setNoteSensitivity(root, "people/antoine-lavoie", "private");
    expect(readFileSync(join(root, "people/antoine-lavoie.md"), "utf8")).toMatch(/^sensitivity: private$/m);
    t += 31 * 60_000;
    for (const page of [await get("/home?all=1"), await get("/home")]) {
      expect(page).not.toContain("head TA");
      expect(page).not.toContain("teaching assistant");
    }
    expect(await get("/home?all=1")).toContain("Something new about Antoine");
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("a fact whose live record was made private says no value either", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    const f = join(root, "people/antoine-lavoie.md");
    const text = readFileSync(f, "utf8");
    const m = text.match(/^( +)role:\n((?:\1 .*\n)*)/m);
    expect(m).not.toBeNull();
    writeFileSync(f, text.replace(m![0], `${m![0]}${m![1]}  sensitivity: private\n`));
    const v = homeView(root, loadRules(root), loadBrain(root), new Date(DEMO_NOW), { all: true });
    const lines = [...v.since, ...v.earlier.flatMap((x) => x.lines)];
    expect(lines.map((l) => l.what).join("\n")).not.toContain("head TA");
    expect(lines.some((l) => l.what === "Something new about Antoine." && l.attr === "role")).toBe(true);
  } finally { delete process.env.PB_NOW; }
}, 60_000);
