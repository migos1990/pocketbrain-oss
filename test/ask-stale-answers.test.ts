// SPDX-License-Identifier: AGPL-3.0-only
// G637: the owner asked on the phone more than 10 minutes after signing in, and Ask showed nothing
// but "Earlier answers here show again right after you sign in.": every answer about a page with a
// private or held fact was hidden, even the one just given (built for the older sign-in, so it
// holds nothing private) and the one that says to sign in again. Now an answer made on the older
// sign-in shows; one made on a fresh sign-in and hidden later says so in place, with the tap.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { dashboardHandler } from "../src/dashboard/server";

const H = "127.0.0.1:8789";
const ID = "projects/product-discovery-course";
const OLD = "Earlier answers here show again right after you sign in.";

async function rig() {
  const { root } = await makeDemoBrain();
  let t = Date.parse(DEMO_NOW);
  const d = dashboardHandler(root, { port: 8789, loginKey: "k".repeat(32), now: () => new Date(t) });
  const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const req = async (m: string, p: string, f?: Record<string, string>) => (await d.handle(new Request(`http://${H}${p}`, { method: m, body: f ? new URLSearchParams(f) : undefined, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/ask`, ...(f ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }))).text();
  const csrf = (await req("GET", "/home")).match(/name="csrf" value="([^"]+)"/)![1]!;
  const f = join(root, `${ID}.md`);
  // One fact on the page is private (record level); the page stays personal.
  writeFileSync(f, readFileSync(f, "utf8").replace(/(  status:\n    value: week 6 of 13\n)/, "$1    sensitivity: private\n"));
  return { req, csrf, f, later: (min: number) => { t += min * 60_000; } };
}

test("an answer given on an older sign-in shows on Ask, with nothing private in it", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { req, csrf, later } = await rig();
    later(31);
    const said = await req("POST", "/say", { csrf, q: "What about Product Discovery course?", from: "ask" });
    expect(said).not.toContain(OLD);
    expect(said).toContain("What about Product Discovery course?");
    expect(said).toMatch(/class="bubble answer"|class="bubble" role="status"/);
    expect(said).not.toContain("week 6 of 13");
    // A private page: the answer that says to sign in again shows, with its tap.
    const priv = await req("POST", "/say", { csrf, q: "What about Household taxes?", from: "ask" });
    expect(priv).toContain("That shows only right after you sign in");
    expect(priv).toContain('action="/action/sign-in-again"');
    expect(priv).not.toContain(OLD);
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("an answer given on a fresh sign-in, hidden later, says so in place with the tap", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { req, csrf, later } = await rig();
    const fresh = await req("POST", "/say", { csrf, q: "What about Product Discovery course?", from: "ask" });
    expect(fresh).toContain("week 6 of 13");
    later(31);
    const ask = await req("GET", "/ask");
    expect(ask).not.toContain("week 6 of 13");
    expect(ask).not.toContain(OLD);
    expect(ask).toContain("Sign in again to see this answer.");
    expect(ask).toContain('action="/action/sign-in-again"');
    // What was asked isn't repeated either: the owner may have typed the value.
    expect(ask).not.toContain("What about Product Discovery course?");
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("an answer from an older sign-in hides once another fact on its page turns private", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { req, csrf, f, later } = await rig();
    later(31);
    const said = await req("POST", "/say", { csrf, q: "What about Product Discovery course?", from: "ask" });
    expect(said).not.toContain(OLD);
    // Every other fact on the page is made private after the answer was given.
    writeFileSync(f, readFileSync(f, "utf8").replace(/^(    value: (?!week 6).*)$/gm, "$1\n    sensitivity: private"));
    const ask = await req("GET", "/ask");
    expect(ask).toContain("Sign in again to see this answer.");
    expect(ask).not.toContain("What about Product Discovery course?");
  } finally { delete process.env.PB_NOW; }
}, 90_000);
