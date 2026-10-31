// SPDX-License-Identifier: AGPL-3.0-only
// Browser episodes for the owner dashboard, nothing mocked: each one starts the agents' live
// server and the dashboard on a throwaway brain, signs in through the printed login link in a
// real Chromium (Playwright), clicks what Robin would click, then checks the brain repo and
// what the agents get on their next call. Scored n/a when the dashboard or Playwright is
// missing, so backfill on older commits stays safe.
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPB, SRC } from "../lib/pb";
import { sandbox, sh, TODAY } from "../lib/sandbox";
import { ok, na, type Case, type Result } from "../lib/case";

const pb = await loadPB();
const has = (f: string) => existsSync(join(SRC, f));
const server = has("server.ts") ? await import(join(SRC, "server.ts")) : undefined;
const auth = has("auth.ts") ? await import(join(SRC, "auth.ts")) : undefined;
const dash = has("dashboard/server.ts") ? await import(join(SRC, "dashboard/server.ts")) : undefined;

// Playwright: the project's own copy if installed, else PLAYWRIGHT_MODULE, else a global one.
async function playwright(): Promise<any> {
  for (const m of ["playwright", "playwright-core", process.env.PLAYWRIGHT_MODULE, "/opt/node-tools/node_modules/playwright/index.mjs"]) {
    if (!m) continue;
    try { const mod = await import(m); if (mod.chromium) return mod; } catch {}
  }
}
const pw = await playwright();

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const p = s.port; s.stop(true); return p;
}

class Rig {
  root: string; browser: any; agents: any; agentsUrl: string; dash: any; dashUrl: string; loginUrl: string; page: any; ctx: any;
  tokens: Record<string, string> = {}; dialogs: string[] = []; acceptDialogs = true;
  constructor(root: string) {
    this.root = root;
    this.agents = server.serve(root, 0);
    this.agentsUrl = `http://127.0.0.1:${this.agents.port}`;
    for (const a of ["steward", "planner", "helper"]) this.tokens[a] = auth.issueToken(root, a);
    const d = dash.serveDashboard(root, { port: freePort() });
    this.dash = d.server; this.loginUrl = d.loginUrl; this.dashUrl = new URL(d.loginUrl).origin;
  }
  async open() {
    this.browser = await pw.chromium.launch();
    this.ctx = await this.browser.newContext();
    this.page = await this.ctx.newPage();
    this.page.on("dialog", (dl: any) => { this.dialogs.push(dl.message()); this.acceptDialogs ? dl.accept() : dl.dismiss(); });
    await this.page.goto(this.loginUrl);
    // Sign-in lands on the home; these cases read the old overview, now at /overview.
    await this.page.goto(new URL("/overview", this.page.url()).href);
    return this.page;
  }
  async stop() { try { await this.browser?.close(); } catch {} this.agents.stop(true); this.dash.stop(true); }
  async call(agent: string, method: string, path: string, body?: unknown) {
    const r = await fetch(this.agentsUrl + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${this.tokens[agent]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json: any; try { json = JSON.parse(text); } catch {}
    return { status: r.status, text, json };
  }
  async tool(agent: string, name: string, args: Record<string, unknown>) {
    const r = await this.call(agent, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const text = r.json?.result?.content?.[0]?.text ?? r.json?.error?.message ?? "";
    let json: any; try { json = JSON.parse(text); } catch {}
    return { status: r.status, text, json, isError: !!r.json?.result?.isError || !!r.json?.error };
  }
  // Click a button inside the "needs you" item (or agent row) that contains `within`.
  async click(within: string, label: string, scope = ".item") {
    const item = this.page.locator(scope, { hasText: within }).first();
    await item.getByRole("button", { name: label, exact: true }).click();
    await this.page.waitForLoadState("load");
  }
  lastCommit() { return sh(this.root, ["git", "log", "-1", "--format=%an|%s"]); }
  // The home's "two sources disagree on what's next for …" row: how many, and settle it by picking a side.
  async waiting() {
    await this.page.goto(new URL("/home", this.page.url()).href);
    return this.page.locator("li", { hasText: /two sources disagree on what.s next for/i }).count();
  }
  async settle(side: string) {
    const n = await this.waiting();
    await this.page.locator("li", { hasText: /two sources disagree on what.s next for/i }).first().getByRole("link").click();
    await this.page.waitForLoadState("load");
    await this.page.locator("form.pick button", { hasText: side }).first().click();
    await this.page.waitForLoadState("load");
    return n;
  }
}

async function episode(fn: (r: Rig) => Promise<Result>): Promise<Result> {
  if (!server || !auth || !dash) return na("no dashboard at this commit");
  if (!pw) return na("Playwright not installed (add it, or set PLAYWRIGHT_MODULE)");
  const r = new Rig(sandbox());
  try { return await fn(r); }
  catch (e) { return ok(false, `episode threw: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }
  finally { await r.stop(); }
}

const steps = (xs: [string, boolean][]): Result => {
  const failed = xs.filter(([, p]) => !p).map(([s]) => s);
  return ok(failed.length === 0, failed.length ? `failed at: ${failed.join("; ")}` : `${xs.length} steps ok`);
};
const fact = (root: string, id: string, attr: string) => pb.brain.loadBrain(root).find((n: any) => n.fm.id === id)?.fm.facts?.[attr];
const PROPOSAL = { id: "projects/course-a", attribute: "next_step", value: "Send students the session 6 reminder", as_of: TODAY, sources: ["agent:helper"], verification: "self-reported" };

// Planner forwards Jane's personal phone (shared with Planner only) to Helper: the relay holds it.
function heldMessage(root: string) {
  const cfg = pb.relay.loadRelayConfig(root);
  const [lo, d] = cfg.relay_address.split("@");
  mkdirSync(join(root, "relay", "incoming"), { recursive: true });
  writeFileSync(join(root, "relay", "incoming", "h1.json"), JSON.stringify({ id: "h1", from: cfg.agents.planner, to: [`${lo}+helper@${d}`], subject: "Jane's contact", text: "For the reminder, Jane's cell is +15145550199." }));
  const v = pb.relay.relayOnce(root, pb.relay.fileTransport(root));
  return { held: v[0]?.deliver === false, out: join(root, "relay", "outgoing", cfg.agents.helper.toLowerCase(), "h1.json") };
}

export const dashboardCases: Case[] = [
  { id: "dash-approve-proposal", dimension: "e2e", kind: "benign", title: "Helper proposes over MCP; Robin approves it in the dashboard; Planner reads it on its next call", run: () => episode(async (r) => {
    const w = await r.tool("helper", "remember", PROPOSAL);
    const page = await r.open();
    // Settings decides nothing (2026-10-27): a contradiction waits on the home and settles on its screen.
    const shown = await r.settle(PROPOSAL.value);
    const t = await r.tool("planner", "read", { id: "projects/course-a" });
    return steps([
      ["proposal went to the inbox", w.json?.outcome === "inbox"],
      ["dashboard lists it", shown === 1],
      ["committed by the owner", /^(louis|owner)\|/.test(r.lastCommit())],
      ["fact is the proposed value", fact(r.root, "projects/course-a", "next_step")?.value === PROPOSAL.value],
      ["gone from needs-you", (await r.waiting()) === 0],
      ["Planner reads it", /session 6 reminder/.test(t.text)],
    ]);
  }) },
  { id: "dash-reject-proposal", dimension: "e2e", kind: "benign", title: "Robin rejects a proposal; the fact keeps its old value", run: () => episode(async (r) => {
    const before = fact(r.root, "projects/course-a", "next_step")?.value;
    await r.tool("helper", "remember", PROPOSAL);
    await r.open();
    await r.settle(String(before));
    return steps([["value unchanged", fact(r.root, "projects/course-a", "next_step")?.value === before], ["inbox emptied", !readdirSync(join(r.root, "inbox")).some((f) => f.endsWith(".yaml"))]]);
  }) },
  // A held message is a question on the home with its own settle screen (owner's third read, 2026-10-29:
  // Settings, which decides nothing, still had Release and Drop).
  { id: "dash-release-held", dimension: "e2e", kind: "benign", title: "The relay holds a message; Robin lets it through from its settle screen on the home; Helper gets it", run: () => episode(async (r) => {
    if (!pb.relay) return na("no relay at this commit");
    const h = heldMessage(r.root);
    await r.open();
    await r.page.goto(`${r.dashUrl}/home`);
    const shown = await r.page.locator('a[href="/settle/m-h1"]').count();
    await r.page.goto(`${r.dashUrl}/settle/m-h1`);
    await r.page.getByRole("button", { name: /Let it through/ }).click();
    await r.page.waitForURL(/\/home/);
    return steps([
      ["relay held it", h.held],
      ["home lists it", shown === 1],
      ["delivered to Helper", existsSync(h.out)],
      ["off the home", (await r.page.locator('a[href="/settle/m-h1"]').count()) === 0],
    ]);
  }) },
  { id: "dash-release-cancelled", dimension: "e2e", kind: "benign", title: "Opening a held message and going back home without answering leaves it held", run: () => episode(async (r) => {
    if (!pb.relay) return na("no relay at this commit");
    const h = heldMessage(r.root);
    await r.open();
    await r.page.goto(`${r.dashUrl}/settle/m-h1`);
    await r.page.getByRole("link", { name: /Home/ }).click();
    await r.page.waitForURL(/\/home/);
    return steps([["not delivered", !existsSync(h.out)], ["still on the home", (await r.page.locator('a[href="/settle/m-h1"]').count()) === 1]]);
  }) },
  { id: "dash-drop-held", dimension: "e2e", kind: "benign", title: "Robin keeps a held message back from its settle screen; it is never delivered", run: () => episode(async (r) => {
    if (!pb.relay) return na("no relay at this commit");
    const h = heldMessage(r.root);
    await r.open();
    await r.page.goto(`${r.dashUrl}/settle/m-h1`);
    await r.page.getByRole("button", { name: /Don't send it/ }).click();
    await r.page.waitForURL(/\/home/);
    const day = readdirSync(join(r.root, "comms"))[0];
    return steps([["not delivered", !existsSync(h.out)], ["recorded as dropped", /verdict: dropped/.test(readFileSync(join(r.root, "comms", day, "h1.md"), "utf8"))]]);
  }) },
  { id: "dash-decide-dispute", dimension: "e2e", kind: "benign", title: "A tie opens a dispute; Robin keeps candidate 2 on the settle screen; it settles at that side's rank, his tap recorded", run: () => episode(async (r) => {
    const w = await r.tool("planner", "remember", { id: "people/jane-roy", attribute: "role", value: "Program director", as_of: "2026-09-01", sources: ["gmail:f00000000000000f"], verification: "verified-by-source" });
    const d = pb.brain.loadBrain(r.root).find((n: any) => n.fm.type === "dispute");
    const pick = d?.fm.candidates?.[1]?.value;
    await r.open();
    // A conflict is settled on its own screen (outside review v5): one row per side, a tap picks it.
    await r.page.goto(`${r.dashUrl}/settle/${encodeURIComponent(String(d?.fm.id ?? "").replace(/^disputes\//, ""))}`);
    await r.page.locator("form.pick button", { hasText: String(pick) }).first().click();
    await r.page.waitForLoadState("load");
    const f = fact(r.root, "people/jane-roy", "role");
    const m = await r.tool("helper", "read", { id: "people/jane-roy" });
    return steps([
      ["dispute opened", w.json?.outcome === "disputed" && !!d],
      ["fact is candidate 2", pick !== undefined && f?.value === pick],
      // A tap on a side files it at its own rank with the tap recorded; only typed words are his (audit v4).
      ["settled by Robin's tap", !f?.dispute && (f?.sources ?? []).some((x: unknown) => String(x).startsWith("approved:")) && !["confirmed-by-owner", "confirmed-by-louis"].includes(String(f?.verification))],
      ["Helper sees the settled value", m.text.includes(String(pick))],
    ]);
  }) },
  { id: "dash-kill-switch", dimension: "e2e", kind: "benign", title: "Pause cuts Planner off at once, read-only lets it read but not write, resume restores it; Helper is unaffected", run: () => episode(async (r) => {
    const write = () => r.tool("planner", "remember", { id: "projects/course-a", attribute: "next_step", value: `Post the session 6 reminder ${Math.random().toString(36).slice(2, 6)}`, as_of: TODAY, sources: ["gmail:f000000000000011"], verification: "verified-by-source" });
    const read = () => r.tool("planner", "read", { id: "projects/course-a" });
    await r.open();
    await r.page.goto(r.dashUrl + "/agents");
    const row = "tr";
    await r.click("planner", "Pause", row);
    const pausedRead = await read(), pausedApi = await r.call("planner", "GET", "/v1/search?q=Jane"), museOk = await r.tool("helper", "read", { id: "projects/course-a" });
    await r.click("planner", "Read-only", row);
    const roRead = await read(), roWrite = await write();
    await r.click("planner", "Resume", row);
    const backWrite = await write();
    return steps([
      ["pause asked to confirm", r.dialogs.some((m) => /Pause planner/.test(m))],
      ["paused: MCP read refused", pausedRead.isError || pausedRead.status === 403],
      ["paused: API refused", pausedApi.status === 403],
      ["Helper unaffected", !museOk.isError && /course/i.test(museOk.text)],
      ["read-only: reads work", !roRead.isError && /course/i.test(roRead.text)],
      ["read-only: writes refused", roWrite.isError || roWrite.status === 403 || roWrite.json?.outcome !== "committed"],
      ["resumed: writes work", backWrite.json?.outcome === "committed"],
      ["each switch is an owner commit", sh(r.root, ["git", "log", "-E", "--author=^(louis|owner) ", "--grep=Kind: kill-switch", "--format=%h"]).trim().split("\n").filter(Boolean).length === 3],
    ]);
  }) },
  { id: "dash-revoke-tokens", dimension: "e2e", kind: "benign", title: "Revoking Planner's tokens from the dashboard cuts it off on its next call", run: () => episode(async (r) => {
    const before = await r.call("planner", "GET", "/v1/search?q=Jane");
    await r.open();
    await r.page.goto(r.dashUrl + "/agents");
    await r.click("planner", "Revoke access", "tr");
    const after = await r.call("planner", "GET", "/v1/search?q=Jane"), helper = await r.call("helper", "GET", "/v1/search?q=Jane");
    return steps([["works before", before.status === 200], ["asked to confirm", r.dialogs.some((m) => /Revoke every (access key|way) planner/.test(m))], ["refused after", after.status === 401], ["Helper unaffected", helper.status === 200]]);
  }) },
  { id: "dash-escapes-agent-text", dimension: "e2e", kind: "benign", title: "Markup inside an agent's proposal is shown as text, never rendered", run: () => episode(async (r) => {
    await r.tool("helper", "remember", { ...PROPOSAL, value: 'Reminder <b id="pb-markup">bold</b> draft' });
    const page = await r.open();
    const listed = await page.locator(".item", { hasText: ": next step?" }).count();
    return steps([["proposal listed", listed === 1], ["markup not rendered", (await page.locator("#pb-markup").count()) === 0], ["shown as text", (await page.content()).includes("&lt;b id=")]]);
  }) },
  { id: "dash-owner-only", dimension: "e2e", kind: "benign", title: "The dashboard refuses no session, a wrong login key, another Host, and actions without the session's CSRF token", run: () => episode(async (r) => {
    const noSession = await fetch(r.dashUrl + "/");
    const badKey = await fetch(r.dashUrl + "/login?key=nope", { redirect: "manual" });
    const badHost = await fetch(r.dashUrl + "/", { headers: { host: "evil.example" } });
    const page = await r.open();
    const cookie = (await r.ctx.cookies()).map((c: any) => `${c.name}=${c.value}`).join("; ");
    const noCsrf = await fetch(r.dashUrl + "/action/agent-status", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "agent=planner&status=paused", redirect: "manual" });
    const csrf = await page.locator('input[name="csrf"]').first().getAttribute("value");
    const crossOrigin = await fetch(r.dashUrl + "/action/agent-status", { method: "POST", headers: { cookie, origin: "http://evil.example", "content-type": "application/x-www-form-urlencoded" }, body: `csrf=${csrf}&agent=planner&status=paused`, redirect: "manual" });
    const status = pb.rules.loadRules(r.root).policy.agents.planner?.status ?? "active";
    const cookieFlags = (await r.ctx.cookies())[0] ?? {};
    return steps([
      ["no session: 401", noSession.status === 401],
      ["wrong key: 403", badKey.status === 403],
      ["other Host: 421", badHost.status === 421],
      ["no CSRF: 403", noCsrf.status === 403],
      ["cross-origin: 403", crossOrigin.status === 403],
      ["Planner still active", status === "active"],
      ["session cookie HttpOnly + SameSite=Strict", cookieFlags.httpOnly === true && cookieFlags.sameSite === "Strict"],
    ]);
  }) },
];
