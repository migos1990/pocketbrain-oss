// SPDX-License-Identifier: AGPL-3.0-only
// Browser episodes for Ask, in-place edits, model-proposed edits and Robin's editor: a real
// Chromium (Playwright) signs in through the printed link and clicks what Robin would click,
// against the live agents' server and dashboard on a throwaway brain. The model is the fake
// provider (no API keys here). Skipped when Chromium can't start.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { serve } from "../src/server";
import { issueToken } from "../src/auth";
import { serveDashboard } from "../src/dashboard/server";
import { makeModel, type ModelRequest } from "../src/model";
import { loadBrain, type FactRecord } from "../src/brain";
import { git } from "../src/git";

let pw: any;
let browser: any;
try { pw = await import("playwright"); browser = await pw.chromium.launch(); } catch { browser = undefined; }
const run = browser ? test : test.skip;
afterAll(async () => { await browser?.close(); });

function rig(fake: (r: ModelRequest) => string) {
  const root = makeBrain();
  const agents = serve(root, 0);
  const tokens: Record<string, string> = Object.fromEntries(["steward", "planner", "helper"].map((a) => [a, issueToken(root, a)]));
  const d = serveDashboard(root, { port: 0, modelFor: () => makeModel({ provider: "fake", model: "fake-1" }, { fake }) });
  const call = async (agent: string, path: string, body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${agents.port}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokens[agent]}` }, body: JSON.stringify(body) });
    return r.json() as Promise<any>;
  };
  const open = async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on("dialog", (dl: any) => dl.accept());
    await page.goto(d.loginUrl);
    return page;
  };
  const stop = () => { agents.stop(true); d.server.stop(true); };
  return { root, call, open, stop, base: new URL(d.loginUrl).origin };
}
const fact = (root: string, id: string, attr: string) => loadBrain(root).find((n) => n.fm.id === id)?.fm.facts?.[attr] as FactRecord;
const flash = async (page: any) => (await page.locator(".flash .flash-msg").textContent()).trim();

run("Ask: Robin types a question and gets an answer with the facts it used", async () => {
  const r = rig(() => "Jane Roy coordinates the course [people/jane-roy].");
  try {
    const page = await r.open();
    await page.getByRole("link", { name: "Brain" }).click();
    const box = page.getByPlaceholder("Search or ask");
    await box.fill("Jane Roy");
    // results come as you type, before anything is asked
    await page.locator("#results a.b-row", { hasText: "Jane Roy" }).first().waitFor();
    expect(page.url()).toContain("/brain?q=Jane");
    await box.fill("who is Jane Roy");
    await box.press("Enter");
    await page.waitForURL(/\/ask$/);
    expect(await page.locator("body").textContent()).toContain("Jane Roy coordinates the course");
    await page.locator(".card a[title=\"people/jane-roy\"]").first().click();
    expect(page.url()).toContain("/note/people/jane-roy");
  } finally { r.stop(); }
}, 30000);

run("Edit: Robin changes a fact on the note page; Planner reads the new value", async () => {
  const r = rig(() => "");
  try {
    const page = await r.open();
    await page.goto(`${r.base}/note/people/jane-roy`);
    await page.locator("#f-role a.b-val").click();
    await page.getByLabel("new value for role").fill("Program director");
    await page.getByLabel("new value for role").press("Enter");
    await page.waitForURL(/undo=/);
    expect(await flash(page)).toBe("Saved Role. The old value is under Earlier values.");
    expect(fact(r.root, "people/jane-roy", "role").verification).toBe("confirmed-by-owner");
    const t = await r.call("planner", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read", arguments: { id: "people/jane-roy" } } });
    expect(t.result.content[0].text).toContain("Program director");
    // Undo, then save again
    await page.getByRole("button", { name: "Undo" }).click();
    await page.waitForLoadState("load");
    expect(fact(r.root, "people/jane-roy", "role").value).toBe("Course coordinator");
    await page.locator("#f-role a.b-val").click();
    await page.getByLabel("new value for role").fill("Program director");
    await page.locator("#f-role").getByRole("button", { name: "Save" }).click();
    await page.waitForURL(/undo=/);
    // the notes text, edited in place
    await page.locator("#b-text").click();
    await page.getByLabel("notes", { exact: true }).fill("Coordinates the course. Prefers email.");
    await page.getByRole("button", { name: "Save notes" }).click();
    await page.waitForURL(/undo=/);
    expect(readFileSync(join(r.root, "people/jane-roy.md"), "utf8")).toContain("Prefers email.");
    expect(fact(r.root, "people/jane-roy", "role").value).toBe("Program director");
    // whole-note text edit
    await page.getByText("Edit file", { exact: true }).click();
    const area = page.locator("textarea[name=text]");
    await area.fill((await area.inputValue()) + "\nMet her at the October board meeting.\n");
    await page.getByRole("button", { name: "Save note" }).click();
    await page.waitForLoadState("load");
    expect(readFileSync(join(r.root, "people/jane-roy.md"), "utf8")).toContain("October board meeting");
  } finally { r.stop(); }
}, 30000);

run("Agent edit: Robin asks for a change, sees the diff, approves; discard leaves the note alone", async () => {
  const r = rig((q) => "```markdown\n" + q.prompt.match(/```markdown\n([\s\S]*?)```/)![1].replace("Course coordinator", "Associate dean") + "```");
  try {
    const page = await r.open();
    await page.goto(`${r.base}/note/people/jane-roy`);
    await page.getByLabel("What changed?").fill("Jane became associate dean");
    await page.getByRole("button", { name: "Suggest", exact: true }).click();
    await page.waitForURL(/\/proposal\//);
    expect(await page.locator("body").textContent()).toContain("Associate dean");
    expect(fact(r.root, "people/jane-roy", "role").value).toBe("Course coordinator");
    await page.getByRole("button", { name: "Discard" }).click();
    await page.waitForLoadState("load");
    expect(fact(r.root, "people/jane-roy", "role").value).toBe("Course coordinator");
    await page.getByLabel("What changed?").fill("Jane became associate dean");
    await page.getByRole("button", { name: "Suggest", exact: true }).click();
    await page.waitForURL(/\/proposal\//);
    await page.getByRole("button", { name: "Apply the change" }).click();
    await page.waitForLoadState("load");
    expect(fact(r.root, "people/jane-roy", "role").value).toBe("Associate dean");
    expect(git(r.root, ["log", "-1", "--format=%an"])).toBe("Robin");
  } finally { r.stop(); }
}, 30000);

run("Editor: Robin names Helper his editor, its write lands directly, he reverts it, then removes the editor", async () => {
  const r = rig(() => "");
  const w = (value: string) => r.call("helper", "/v1/remember", { id: "projects/course-a", attribute: "next_step", value, as_of: "2026-10-08", sources: ["gmail:f000000000000011"], verification: "verified-by-source" });
  try {
    const page = await r.open();
    await page.getByRole("link", { name: "Assistants" }).click();
    await page.getByLabel("editor").selectOption("helper");
    await page.getByRole("button", { name: "Make it my editor" }).click();
    await page.waitForLoadState("load");
    expect(await flash(page)).toContain("helper is now your editor");
    expect((await w("Send the reminder Friday")).outcome).toBe("committed");
    await page.reload();
    await page.getByRole("button", { name: "Revert" }).first().click();
    await page.waitForLoadState("load");
    expect(await flash(page)).toContain("reverted");
    expect(fact(r.root, "projects/course-a", "next_step").value).not.toBe("Send the reminder Friday");
    await page.getByRole("button", { name: "Remove editor" }).click();
    await page.waitForLoadState("load");
    expect((await w("Back to proposals")).outcome).toBe("inbox");
  } finally { r.stop(); }
}, 30000);
