// SPDX-License-Identifier: AGPL-3.0-only
// Audit v11, the owner screens' wrong readings left from the v8 list: every line on a page, the
// home and Settings reads as a sentence in the owner's words. No role said as a verb ("Hélène
// Lefebvre retired teacher."), no attribute code name ("org is now"), no "Next for Ben: owe Ben…"
// for the owner's own to-do, assistants named as names on Who sees, Details in words and dates as
// a person writes them, and Settings' "Filed for you" without fact keys or ISO dates.
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { dashboardHandler } from "../src/dashboard/server";
import { renderTouchedPages } from "../src/wiki";

const H = "127.0.0.1:8789";
const text = (html: string) => html.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/g, " ").replace(/<[^>]*>/g, " ").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

async function rig() {
  const { root } = await makeDemoBrain();
  const d = dashboardHandler(root, { port: 8789, loginKey: "k".repeat(32), now: () => new Date(DEMO_NOW) });
  const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const req = async (m: string, p: string, f?: Record<string, string>) => (await d.handle(new Request(`http://${H}${p}`, { method: m, body: f ? new URLSearchParams(f) : undefined, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/home`, ...(f ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }))).text();
  const csrf = (await req("GET", "/home")).match(/name="csrf" value="([^"]+)"/)![1]!;
  return { root, req, csrf };
}

test("a role that starts like a verb is said as a role on the page", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { req } = await rig();
    const p = text(await req("GET", "/p/people/helene-lefebvre"));
    expect(p).not.toContain("Lefebvre retired teacher.");
    expect(p).toMatch(/H[ée]l[èe]ne(?: Lefebvre)?(?:'s role is| is) (?:a )?retired teacher/);
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("a new workplace reads as where someone works, never 'org is now'", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { req, csrf } = await rig();
    const said = text(await req("POST", "/say", { csrf, q: "Maya Chen works at Acme" }));
    expect(said).not.toMatch(/\borg\b/);
    const home = text(await req("GET", "/home"));
    expect(home).not.toContain("org is now");
    expect(home).toContain("Maya works at Acme now");
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("the owner's own to-do on a page reads 'You owe Ben…', never 'Next for Ben: owe Ben…'", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root, req, csrf } = await rig();
    await req("POST", "/say", { csrf, q: "I owe Ben the sample" });
    renderTouchedPages(root, "2000-01-01T00:00:00Z");
    const p = text(await req("GET", "/p/people/ben-carter"));
    expect(p).toContain("owe Ben the sample");
    expect(p).not.toMatch(/Next for Ben[^:]*: owe/);
    expect(p).toContain("You owe Ben the sample");
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("Who sees names each assistant as a name, Details say attributes and dates in words", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { req } = await rig();
    const html = await req("GET", "/p/people/maya-chen");
    const chips = html.match(/<div class="seen">([\s\S]*?)<\/div>/)![1]!;
    for (const name of chips.matchAll(/<span>([^<]+)<\/span>/g)) expect(name[1]!).toMatch(/^[A-Z]/);
    const dl = html.match(/<dl>([\s\S]*?)<\/dl>/)![1]!;
    expect(dl).not.toMatch(/<dt>org<\/dt>/);
    expect(dl).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    expect(dl).not.toMatch(/<dt>[a-z]/);
    // A day said once: "Last contact 7 Oct 2026", not "7 Oct 2026 since 7 Oct 2026".
    expect(text(dl)).not.toMatch(/(\d{1,2} [A-Z][a-z]{2} \d{4}) since \1/);
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("Settings' Filed for you names pages and facts in words, with no fact key or ISO date", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { req } = await rig();
    const html = await req("GET", "/overview");
    const filed = html.split("Filed for you this week")[1]?.split("<h2")[0] ?? "";
    expect(filed.length).toBeGreaterThan(0);
    const t = text(filed);
    expect(t).not.toMatch(/[a-z]+\/[a-z0-9-]+#[a-z_]+/);
    expect(t).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    expect(t).not.toMatch(/ = /);
  } finally { delete process.env.PB_NOW; }
}, 90_000);
