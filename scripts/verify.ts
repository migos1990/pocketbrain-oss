// SPDX-License-Identifier: AGPL-3.0-only
// Verify: use the owner's app the way a thumb does, before a pull request (G985). The UI regression
// compares what each page says; nothing tapped a button, timed a tap, or looked at the picture, so
// a slow tap and a broken flow were found on the owner's phone. This boots the demo brain's
// dashboard (made-up data, never a real brain), opens it at phone width in dark mode, walks the
// flows below one tap at a time, and for each step records how long the tap took to show its
// result, a screenshot, and three faults a snapshot can't see: a page wider than the phone, an
// error in the page's console, a request the hub refused.
//   bun scripts/verify.ts [--out <dir>] [--only <flow,flow>] [--budget <ms>] [--json]
//   bun scripts/verify.ts --list           the feature map: each flow and its steps
//   bun scripts/verify.ts --for <base>     run only when the change since <base> touches the owner's screens
// Exits 1 when a step doesn't reach what it should show, a fault is seen, or a tap is over the
// budget (TAP_BUDGET_MS, on this machine and the demo brain). The screenshots are for the thread
// to look at: the skill .claude/skills/verify says how. A new owner flow gets a row in FLOWS.
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lanes } from "./lane";

export const TAP_BUDGET_MS = 1500;
export const PHONE = { width: 390, height: 844 };

// A step: what the owner does, and what must then be on the screen. `tab` and `link` and `button`
// find a control by its accessible name, as a person or a screen reader would; a string is matched
// as written, a RegExp as a pattern. `first` taps the first of several (the top row of a list).
export type Find = { role: "link" | "button" | "heading" | "status" | "textbox"; name?: string | RegExp; first?: boolean };
export type Act =
  | { open: string }
  | { tap: Find }
  | { type: string; into?: Find; then: Find };
export interface Step { does: string; act: Act; shows: Find | { url: RegExp } | { text: string | RegExp } }
export interface Flow { name: string; what: string; steps: Step[] }

// The feature map: what the owner can do in the app, in the owner's words. Each flow starts from a
// fresh copy of the demo brain's morning, so one flow's taps never change another's screens.
export const FLOWS: Flow[] = [
  { name: "home", what: "Open the app on what waits for you", steps: [
    { does: "open On your mind", act: { open: "/home" }, shows: { role: "heading", name: "On your mind" } },
    { does: "open everything else on your mind", act: { tap: { role: "link", name: "Everything else on your mind" } }, shows: { url: /\/home\?all=1/ } },
  ] },
  { name: "settle", what: "Settle a question, then take it back", steps: [
    { does: "open On your mind", act: { open: "/home" }, shows: { role: "heading", name: /^To settle 3/ } },
    { does: "tap Settle on the first question", act: { tap: { role: "link", name: /^Settle:/, first: true } }, shows: { url: /\/settle\// } },
    { does: "tap the first answer", act: { tap: { role: "button", name: /From an? /, first: true } }, shows: { text: /^Settled:/ } },
    { does: "tap Undo on the settled line", act: { tap: { role: "button", name: /^Undo: Settled:/ } }, shows: { role: "heading", name: /^To settle 3/ } },
  ] },
  { name: "tell", what: "Tell your memory something, then undo it", steps: [
    { does: "open On your mind", act: { open: "/home" }, shows: { role: "textbox", name: "Tell your memory something" } },
    { does: "type a change and tap Send", act: { type: "Maya Chen's role is head of design", then: { role: "button", name: "Send" } }, shows: { text: /^Noted:/ } },
    { does: "tap Undo under the answer", act: { tap: { role: "button", name: "Undo", first: true } }, shows: { text: /undid|Undone/ } },
  ] },
  { name: "page", what: "Open a page from a line on the home", steps: [
    { does: "open On your mind", act: { open: "/home" }, shows: { role: "heading", name: "Lately" } },
    { does: "tap the first line under Lately", act: { tap: { role: "link", name: /Antoine is head TA now/ } }, shows: { url: /\/p\/people\/antoine-lavoie/ } },
    { does: "tap back to On your mind", act: { tap: { role: "link", name: "On your mind", first: true } }, shows: { role: "heading", name: "On your mind" } },
  ] },
  { name: "memory", what: "Find a person in your memory", steps: [
    { does: "tap the Memory tab", act: { open: "/memory" }, shows: { role: "heading", name: "Memory" } },
    { does: "type a name and tap Search", act: { type: "Maya", into: { role: "textbox", name: "Search your memory" }, then: { role: "button", name: "Search" } }, shows: { role: "heading", name: /^Found for/ } },
    { does: "tap the person", act: { tap: { role: "link", name: /Maya Chen$/, first: true } }, shows: { role: "heading", name: "Maya Chen" } },
  ] },
  { name: "ask", what: "Ask about someone", steps: [
    { does: "tap the Ask tab", act: { open: "/ask" }, shows: { role: "textbox", name: "Tell your memory something" } },
    { does: "type a question and tap Send", act: { type: "who is Maya Chen?", then: { role: "button", name: "Send" } }, shows: { text: /Maya Chen is|Maya is/ } },
  ] },
  { name: "see-as", what: "See your memory as one assistant does", steps: [
    { does: "tap the Who knows tab", act: { open: "/who" }, shows: { role: "heading", name: "Who knows" } },
    { does: "tap See as on the first assistant", act: { tap: { role: "link", name: "See as", first: true } }, shows: { url: /\/see\/chatgpt/ } },
  ] },
  { name: "let", what: "Let an assistant have one thing it doesn't get", steps: [
    { does: "open On your mind", act: { open: "/home" }, shows: { role: "heading", name: "Lately" } },
    { does: "tap the assistant's mark on a line it doesn't get", act: { tap: { role: "link", name: "Let Gemini know this?", first: true } }, shows: { url: /\/let\?/ } },
  ] },
];

export interface StepResult { flow: string; n: number; does: string; ms: number; ok: boolean; faults: string[]; shot?: string }

// What blocks: a step that didn't show its result, a fault on the screen, a tap over the budget.
// Opening a page by its address is a page load, not a tap, and has no budget. Pure, so it is tested.
export function problems(results: StepResult[], flows: Flow[], budget = TAP_BUDGET_MS): string[] {
  const out: string[] = [];
  for (const r of results) {
    const step = flows.find((f) => f.name === r.flow)?.steps[r.n - 1];
    const where = `${r.flow} step ${r.n} (${r.does})`;
    if (!r.ok) out.push(`${where}: didn't reach what it should show${r.faults.length ? `: ${r.faults.join("; ")}` : ""}`);
    else for (const f of r.faults) out.push(`${where}: ${f}`);
    if (r.ok && step && !("open" in step.act) && r.ms > budget) out.push(`${where}: the tap took ${Math.round(r.ms)} ms to show its result, over ${budget} ms`);
  }
  for (const f of flows) {
    const got = results.filter((r) => r.flow === f.name).length;
    if (got < f.steps.length) out.push(`${f.name}: ${got} of ${f.steps.length} steps ran`);
  }
  return out;
}

// The slowest tap: steps that open a page by its address are loads, not taps, and don't count.
export function slowestTap(results: StepResult[], flows: Flow[]): number {
  return Math.max(0, ...results.filter((r) => { const st = flows.find((f) => f.name === r.flow)?.steps[r.n - 1]; return !!st && !("open" in st.act); }).map((r) => r.ms));
}

export function table(results: StepResult[]): string {
  return results.map((r) => `${r.ok && !r.faults.length ? "ok  " : "FAIL"} ${String(Math.round(r.ms)).padStart(5)} ms  ${r.flow} ${r.n}: ${r.does}${r.shot ? `  [${r.shot}]` : ""}`).join("\n");
}

// Does this change touch what the owner sees? The same lanes a pull request is sorted into.
export const touchesScreens = (paths: string[]) => lanes(paths).includes("ui");

/* eslint-disable @typescript-eslint/no-explicit-any */
const find = (page: any, f: Find) => { const l = page.getByRole(f.role, f.name === undefined ? {} : { name: f.name, exact: typeof f.name === "string" }); return f.first ? l.first() : l; };

// The demo brain's morning is built once a run (the replayed week takes seconds); each flow walks
// its own copy.
let morning: string | undefined;
async function freshBrain(): Promise<string> {
  const { copyBase, replayWeek } = await import("./demo-brain");
  if (!morning) { morning = mkdtempSync(join(tmpdir(), "pb-verify-morning-")); copyBase(morning); await replayWeek(morning); }
  const root = mkdtempSync(join(tmpdir(), "pb-verify-"));
  cpSync(morning, root, { recursive: true });
  return root;
}

async function walk(browser: any, flow: Flow, out: string): Promise<StepResult[]> {
  const { DEMO_DAY, DEMO_NOW } = await import("./demo-brain");
  const { serveDashboard } = await import("../src/dashboard/server");
  const root = await freshBrain();
  process.env.PB_TODAY = DEMO_DAY; process.env.PB_NOW = DEMO_NOW; process.env.TZ = "UTC";
  const d = serveDashboard(root, { port: 0 });
  const origin = new URL(d.loginUrl).origin;
  const ctx = await browser.newContext({ viewport: PHONE, colorScheme: "dark", hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const seen: string[] = [];
  page.on("console", (m: any) => { if (m.type() === "error") seen.push(`console error: ${String(m.text()).slice(0, 160)}`); });
  page.on("pageerror", (e: any) => seen.push(`script error: ${String(e.message).slice(0, 160)}`));
  page.on("response", (r: any) => { if (r.status() >= 400 && !r.url().endsWith("/favicon.ico")) seen.push(`${r.status()} from ${new URL(r.url()).pathname}`); });
  const results: StepResult[] = [];
  try {
    await page.goto(d.loginUrl);
    for (const [i, step] of flow.steps.entries()) {
      seen.length = 0;
      const t = performance.now();
      let ok = true; const faults: string[] = [];
      try {
        const a = step.act;
        if ("open" in a) await page.goto(origin + a.open);
        else if ("tap" in a) await find(page, a.tap).tap({ timeout: 10_000 });
        else { await (a.into ? find(page, a.into) : page.getByRole("textbox").first()).fill(a.type, { timeout: 10_000 }); await find(page, a.then).tap({ timeout: 10_000 }); }
        const s = step.shows;
        if ("url" in s) await page.waitForURL(s.url, { timeout: 10_000 });
        else if ("text" in s) await page.getByText(s.text).first().waitFor({ state: "visible", timeout: 10_000 });
        else await find(page, s).first().waitFor({ state: "visible", timeout: 10_000 });
      } catch (e) { ok = false; faults.push(String((e as Error).message).split("\n")[0].slice(0, 200)); }
      const ms = performance.now() - t;
      await page.waitForLoadState("load").catch(() => {});
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth).catch(() => 0);
      if (wide > 0) faults.push(`the page is ${wide}px wider than the phone`);
      faults.push(...seen);
      const shot = `${flow.name}-${i + 1}.png`;
      await page.screenshot({ path: join(out, shot), fullPage: true }).catch(() => {});
      results.push({ flow: flow.name, n: i + 1, does: step.does, ms, ok, faults, shot });
      if (!ok) break;
    }
  } finally {
    await ctx.close();
    d.server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
  return results;
}

async function main(argv: string[]): Promise<number> {
  const opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes("--list")) {
    for (const f of FLOWS) { console.log(`${f.name}: ${f.what}`); f.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s.does}`)); }
    return 0;
  }
  const base = opt("--for");
  if (base) {
    const sh = (a: string[]) => Bun.spawnSync(["git", ...a], { stdout: "pipe" }).stdout.toString().trim();
    const mb = sh(["merge-base", base, "HEAD"]);
    // Committed changes since the base, and what isn't committed yet: the edit being made counts.
    const paths = mb ? [sh(["diff", "--name-only", "--no-renames", mb]), sh(["ls-files", "--others", "--exclude-standard"])].join("\n").split("\n").filter(Boolean) : [];
    // Unsure means run: no merge base, or no changed file listed, taps through everything.
    if (mb && paths.length && !touchesScreens(paths)) { console.log(`verify: nothing the owner sees changed since ${base} (${paths.length} files, none in the ui lane); not run`); return 0; }
  }
  const only = opt("--only")?.split(",");
  const unknown = (only ?? []).filter((n) => !FLOWS.some((f) => f.name === n));
  if (only && (unknown.length || !only.length)) { console.error(`no such flow: ${unknown.join(", ")}; the flows are ${FLOWS.map((f) => f.name).join(", ")}`); return 2; }
  const flows = only ? FLOWS.filter((f) => only.includes(f.name)) : FLOWS;
  const budget = Number(opt("--budget") ?? TAP_BUDGET_MS);
  if (!Number.isFinite(budget) || budget <= 0) { console.error("--budget takes milliseconds, a number above 0"); return 2; }
  const out = opt("--out") ?? mkdtempSync(join(tmpdir(), "pb-verify-shots-"));
  mkdirSync(out, { recursive: true });
  let pw: any;
  try { pw = await import("playwright"); } catch { console.error("verify: Playwright isn't installed here (bun install)"); return 2; }
  let browser: any;
  try { browser = await pw.chromium.launch(); } catch (e) { console.error(`verify: Chromium can't start: ${String((e as Error).message).split("\n")[0]}`); return 2; }
  const results: StepResult[] = [];
  try { for (const f of flows) results.push(...await walk(browser, f, out)); } finally { await browser.close(); if (morning) rmSync(morning, { recursive: true, force: true }); }
  const bad = problems(results, flows, budget);
  if (argv.includes("--json")) console.log(JSON.stringify({ out, budget, results, problems: bad }));
  else {
    console.log(table(results));
    console.log(`\nscreenshots (390 wide, dark): ${out}`);
    for (const b of bad) console.log(`✗ ${b}`);
    console.log(bad.length ? `VERIFY FAILED: ${bad.length} problem${bad.length === 1 ? "" : "s"}` : `VERIFY OK: ${results.length} steps in ${flows.length} flows, slowest tap ${Math.round(slowestTap(results, flows))} ms; now look at each screenshot`);
  }
  return bad.length ? 1 : 0;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
