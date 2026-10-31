// SPDX-License-Identifier: AGPL-3.0-only
// Launch gates for a non-developer owner, in a real Chromium: the dashboard speaks in plain
// words (code names only on hover), and each agent's page shows what it looked for, from the
// read log. Agents act through the live server; skipped when Chromium can't start.
import { test, expect, afterAll } from "bun:test";
import { makeBrain } from "./fixture";
import { serve } from "../src/server";
import { issueToken } from "../src/auth";
import { serveDashboard } from "../src/dashboard/server";

let browser: any;
try { browser = await (await import("playwright")).chromium.launch(); } catch { browser = undefined; }
const run = browser ? test : test.skip;
afterAll(async () => { await browser?.close(); });

function rig() {
  const root = makeBrain();
  const agents = serve(root, 0);
  const tokens: Record<string, string> = Object.fromEntries(["steward", "planner", "helper"].map((a) => [a, issueToken(root, a)]));
  const d = serveDashboard(root, { port: 0 });
  const mcp = async (agent: string, name: string, args: Record<string, unknown>) => {
    const r = await fetch(`http://127.0.0.1:${agents.port}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokens[agent]}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    return r.json() as Promise<any>;
  };
  const remember = (agent: string, value: string) => fetch(`http://127.0.0.1:${agents.port}/v1/remember`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokens[agent]}` }, body: JSON.stringify({ id: "projects/course-a", attribute: "next_step", value, as_of: "2026-10-08", sources: ["gmail:f000000000000011"], verification: "verified-by-source" }) }).then((r) => r.json() as Promise<any>);
  const open = async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(d.loginUrl);
    await page.goto(new URL("/overview", page.url()).href);
    return page;
  };
  return { root, mcp, remember, open, stop: () => { agents.stop(true); d.server.stop(true); } };
}

// Visible text only: what the owner reads, not what a hover shows.
const visible = (page: any) => page.locator("main").innerText() as Promise<string>;
const CODE_WORDS = /money\/main-bank|leak_tripwire|context_pack|no_secret_shapes|injection_shapes|verified-by-source|confirmed-by-owner|projects\/course-a|people\/jane-roy|#next_step|\bcommitted\b|\bnoop\b/;

run("Plain words: the owner reads labels, and the code names are one hover away", async () => {
  const r = rig();
  try {
    await r.mcp("helper", "context_pack", {});
    await r.mcp("helper", "search", { query: "course" });
    expect((await r.remember("helper", "Paid via Maple Trust Bank")).outcome).toBe("refused"); // the leak tripwire
    expect((await r.remember("steward", "Send the reminder Friday")).outcome).toBeDefined();
    const page = await r.open();
    for (const path of ["/overview", "/agents", "/activity", "/agent/helper", "/brain", "/note/projects/course-a"]) {
      await page.goto(new URL(path, page.url()).href);
      const text = await visible(page);
      expect(text.match(CODE_WORDS)?.[0] ?? `none on ${path}`).toBe(`none on ${path}`);
    }
    // Alerts are listed on Activity; the home page only counts them (owner, 2026-10-24).
    await page.goto(new URL("/activity", page.url()).href);
    const trip = page.locator('span[title="leak_tripwire"]').first();
    expect(await trip.innerText()).toBe("tried to repeat something it can't see");
    await page.goto(new URL("/activity", page.url()).href);
    expect(await page.locator('span[title="context_pack"]').first().innerText()).toBe("loaded its notes");
    expect(await page.locator('td > span[title="projects/course-a"]').first().innerText()).toBe("Course A");
    // the filter still sends the code name
    await page.locator('select[name="op"]').selectOption({ label: "searched" });
    await page.waitForURL(/op=search/);
    expect(await page.locator('select[name="op"] option:checked').innerText()).toBe("searched");
  } finally { r.stop(); }
}, 30000);

run("What it looked for: searches with what they found, and notes asked for and not given", async () => {
  const r = rig();
  try {
    await r.mcp("helper", "search", { query: "course reminders" });
    await r.mcp("helper", "search", { query: "zebra migration" });
    await r.mcp("helper", "search", { query: "Zebra migration" });
    const hidden = await r.mcp("helper", "read", { id: "money/main-bank" });
    const missing = await r.mcp("helper", "read", { id: "people/nobody-at-all" });
    // the agent got the same answer for both
    expect(hidden.result.content[0].text.replace("money/main-bank", "X")).toBe(missing.result.content[0].text.replace("people/nobody-at-all", "X"));
    await r.mcp("planner", "search", { query: "planner only words" });

    const page = await r.open();
    await page.getByRole("link", { name: "Assistants" }).click();
    await page.getByRole("link", { name: "helper" }).first().click();
    await page.getByRole("link", { name: "what it looked for" }).click();
    const section = page.locator("#looked-for ~ .card");
    const text = await section.allInnerTexts().then((t: string[]) => t.join("\n"));
    expect(text).toContain('"course reminders"');
    expect(text).toMatch(/"zebra migration" 2 times\s+searched\s+nothing/i);
    expect(text).not.toContain("planner only words");
    // the owner sees the difference the agent couldn't
    const rows = page.locator("#looked-for ~ .card tr");
    expect(await rows.filter({ hasText: "hidden from it" }).locator('span[title="money/main-bank"]').count()).toBe(1);
    expect(await rows.filter({ hasText: "doesn't exist" }).locator('span[title="people/nobody-at-all"]').count()).toBe(1);
    expect(await page.locator("main").innerText()).toContain("1 that found nothing");
    // read-only: no form in the section
    expect(await page.locator("#looked-for ~ .card form").count()).toBe(0);
  } finally { r.stop(); }
}, 30000);
