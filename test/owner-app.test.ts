// SPDX-License-Identifier: AGPL-3.0-only
// The owner app's four tabs (brief 2026-10-30, step 1): On your mind (/home), Memory, Ask and Who
// knows, each with the same four-item tab bar, on the demo brain. Under each memory on the home, one
// mark per assistant from its own carve (src/dashboard/marks.ts): filled when it gets the fact,
// dashed when it doesn't; a value still held for the owner's Read it shows a lock, never marks.
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { dashboardHandler } from "../src/dashboard/server";
import { loadBrain } from "../src/brain";
import { loadRules } from "../src/rules";
import { marksFor } from "../src/dashboard/marks";
import { carve, grantFor } from "../src/carve";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_COPY } from "../src/dashboard/html-app";
import { esc } from "../src/dashboard/html-home";

const H = "127.0.0.1:8793";
async function setup() {
  const { root } = await makeDemoBrain();
  const d = dashboardHandler(root, { port: 8793, loginKey: "k".repeat(32) });
  const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const req = async (method: string, path: string, fields?: Record<string, string>) => {
    const body = fields ? new URLSearchParams(fields) : undefined;
    const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/home`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
    return { status: r.status, text: await r.text() };
  };
  return { root, req };
}
const held = (k: string, marks: { name: string; holds: boolean }[]) => [k, marks.filter((m) => m.holds).map((m) => m.name)];

test("a mark per assistant comes from its own carve: work for all three, teaching not for Gemini, money only for Claude", async () => {
  const { root } = await makeDemoBrain();
  const of = marksFor(loadRules(root), loadBrain(root));
  expect(of("projects/atlas-launch#status").map((m) => m.name)).toEqual(["ChatGPT", "Claude", "Gemini"]);
  expect(held("atlas", of("projects/atlas-launch#status"))).toEqual(["atlas", ["ChatGPT", "Claude", "Gemini"]]);
  expect(held("course", of("projects/product-discovery-course#next_step"))).toEqual(["course", ["ChatGPT", "Claude"]]);
  expect(held("kitchen", of("money/kitchen-budget#total"))).toEqual(["kitchen", ["Claude"]]);
  // A short name each, two letters where two assistants start the same.
  expect(of("projects/atlas-launch#status").map((m) => m.short)).toEqual(["Ch", "Cl", "G"]);
}, 60_000);

test("four tabs, the same bar on each, the open one marked", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { req } = await setup();
    const tabs: [string, string][] = [["/home", APP_COPY.tabMind], ["/memory", APP_COPY.tabMemory], ["/ask", APP_COPY.tabAsk], ["/who", APP_COPY.tabWho]];
    for (const [path, name] of tabs) {
      const r = await req("GET", path);
      expect(r.status).toBe(200);
      for (const [p] of tabs) expect(r.text).toContain(`href="${p}"`);
      expect(r.text).toMatch(new RegExp(`<a href="${path}" aria-current="page"[^>]*>[\\s\\S]*?${name}</a>`));
      expect(r.text.match(/aria-current="page"/g)).toHaveLength(1);
    }
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("On your mind: the box, memories with their marks, held values locked; the assistants live on Who knows", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { req } = await setup();
    const home = (await req("GET", "/home")).text;
    expect(home).toContain(`<h1>${APP_COPY.mind}</h1>`);
    expect(home).toContain(`placeholder="${esc(APP_COPY.box)}"`);
    expect(home).toContain('<span class="sr">Known by ');
    expect(home).toMatch(/class="mark( [a-z0-9]+)?" aria-hidden="true">G</);
    expect(home).toContain('class="mark not"');
    // Hélène's private value waits for the owner: a lock and no marks; on this fresh sign-in its
    // value with Keep it private and Let them have it (G630).
    expect(home).toContain(APP_COPY.onlyYou);
    expect(home).toContain(`>${APP_COPY.letThem}</button>`);
    expect(home).toContain(`>${APP_COPY.keepPrivate}</button>`);
    expect(home).not.toContain(APP_COPY.assistants);
    const who = (await req("GET", "/who")).text;
    expect(who).toContain(APP_COPY.assistants);
    expect(who).toContain('href="/overview"');
    expect(who).toContain("<b>Claude</b>");
    expect(who).toContain("Read your brain 6 times today");
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("Memory: kinds with counts, a kind's pages and a search, by title only", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { req } = await setup();
    const m = (await req("GET", "/memory")).text;
    expect(m).toContain('href="/memory?kind=people"');
    expect(m).toMatch(/<b>\d+<\/b><span>People<\/span>/);
    expect(m).toContain(APP_COPY.changedPages);
    expect((await req("GET", "/memory?kind=people")).text).toContain('href="/p/people/maya-chen"');
    const s = (await req("GET", "/memory?q=Maya")).text;
    expect(s).toContain('href="/p/people/maya-chen"');
    expect((await req("GET", "/memory?q=42%2C000")).text).not.toContain("42,000 CAD");
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("Ask: the same box, and its answer comes back on Ask", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { req } = await setup();
    const a = (await req("GET", "/ask")).text;
    const csrf = a.match(/name="csrf" value="([^"]+)"/)![1]!;
    expect(a).toContain('action="/say"');
    const r = await req("POST", "/say", { csrf, q: "what is Isabelle Roy's role?", from: "ask" });
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/<a href="\/ask" aria-current="page"/);
    expect(r.text).toContain("Isabelle Roy&#39;s role is ");
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("a fact an assistant gets only as [withheld] is a dashed mark, not a filled one (slice audit, 2026-10-30)", async () => {
  const { root } = await makeDemoBrain();
  const rules = loadRules(root);
  const cut = (agent: string) => carve(loadBrain(root), rules, grantFor(rules, agent), { flags: false }).carvedValues;
  // A value carved from ChatGPT (money is not its type) that Claude is given.
  const carved = cut("chatgpt").find((v) => /\p{L}/u.test(v) && v.length > 3 && !cut("claude").includes(v))!;
  expect(carved).toBeDefined();
  // Put by hand on the test copy: no writer may file a value it was never shown (the tripwire), yet
  // a page's own text or an import can hold one.
  const file = join(root, "projects/atlas-launch.md");
  writeFileSync(file, readFileSync(file, "utf8").replace(/^facts:\n/m, `facts:\n  budget_note:\n    value: ${JSON.stringify(`paid from ${carved}`)}\n    as_of: 2026-10-07\n    sources:\n      - owner:2026-10-07/home\n    verification: confirmed-by-owner\n`));
  const of = marksFor(loadRules(root), loadBrain(root));
  expect(of("projects/atlas-launch#budget_note").find((m) => m.agent === "claude")!.holds).toBe(true);
  expect(of("projects/atlas-launch#budget_note").find((m) => m.agent === "chatgpt")!.holds).toBe(false);
}, 60_000);
