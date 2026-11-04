// SPDX-License-Identifier: AGPL-3.0-only
// G649: on the owner's phone, "who is my wife" answered "Nothing on that yet" while "who is julie"
// answered "How you know Julie …: <owner>'s wife." A question about one of the owner's own people
// by their role finds them through the pages' relationship facts ("Robin's mother"). And "test" on
// Ask answered with the text box's write hint ("Try 'Ana works at Bay Institute'"), not as Ask.
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { ownerSay } from "../src/owner-say";

test("who is my <role> finds the owner's own people by their relationship", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    const ask = (q: string) => ownerSay(root, q, { fresh: true, from: "ask" });
    expect(ask("who is my mother").page).toBe("people/helene-lefebvre");
    expect(ask("Who's my mom?").page).toBe("people/helene-lefebvre");
    expect(ask("who is my niece").page).toBe("people/camille-lefebvre");
    // "Robin's former manager" is not the manager.
    expect(ask("who is my boss").page).toBe("people/priya-shah");
    expect(ask("who is my wife").page).toBe("people/jordan-ellis");
    const kids = ask("who are my kids");
    expect(kids.text).toContain("Léa Lefebvre");
    expect(kids.text).toContain("Theo Lefebvre");
    expect(kids.text).not.toContain("Camille");
    // Nobody with that role: Ask says so, it doesn't guess.
    expect(ask("who is my grandfather").kind).toBe("say.no-match");
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("a word Ask can't place answers in Ask's voice, not the write box's hint", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    const r = ownerSay(root, "test", { fresh: true, from: "ask" });
    expect(r.text).not.toContain("Ana works at Bay Institute");
    expect(r.text).toMatch(/nothing/i);
    // On the home, the write box's hint stays.
    expect(ownerSay(root, "test", { fresh: true }).text).toContain("Ana works at Bay Institute");
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("Ask's page answers a role question and a stray word in its own voice", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    const { dashboardHandler } = await import("../src/dashboard/server");
    const H = "127.0.0.1:8789";
    const d = dashboardHandler(root, { port: 8789, loginKey: "k".repeat(32), now: () => new Date(DEMO_NOW) });
    const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const req = async (m: string, p: string, f?: Record<string, string>) => (await d.handle(new Request(`http://${H}${p}`, { method: m, body: f ? new URLSearchParams(f) : undefined, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/ask`, ...(f ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }))).text();
    const csrf = (await req("GET", "/home")).match(/name="csrf" value="([^"]+)"/)![1]!;
    await req("POST", "/say", { csrf, q: "test", from: "ask" });
    const page = await req("POST", "/say", { csrf, q: "who are my kids", from: "ask" });
    expect(page).not.toContain("Ana works at Bay Institute");
    expect(page).toContain("I have nothing on that.");
    expect(page).toContain("Your kids: Léa Lefebvre and Theo Lefebvre.");
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("a stale-sign-in turn naming several people hides once one of them turns private", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { dashboardHandler } = await import("../src/dashboard/server");
    const H = "127.0.0.1:8789";
    let t = Date.parse(DEMO_NOW);
    const d = dashboardHandler(root, { port: 8789, loginKey: "k".repeat(32), now: () => new Date(t) });
    const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const req = async (m: string, p: string, f?: Record<string, string>) => (await d.handle(new Request(`http://${H}${p}`, { method: m, body: f ? new URLSearchParams(f) : undefined, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/ask`, ...(f ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }))).text();
    const csrf = (await req("GET", "/home")).match(/name="csrf" value="([^"]+)"/)![1]!;
    t += 31 * 60_000;
    expect(await req("POST", "/say", { csrf, q: "who are my kids", from: "ask" })).toContain("Your kids: Léa Lefebvre and Theo Lefebvre.");
    const f = join(root, "people/theo-lefebvre.md");
    writeFileSync(f, readFileSync(f, "utf8").replace(/^sensitivity: personal$/m, "sensitivity: private"));
    const ask = await req("GET", "/ask");
    expect(ask).not.toContain("Theo Lefebvre");
    expect(ask).toContain("Sign in again to see this answer.");
    // A page forgotten after the answer: its name isn't shown again either.
    writeFileSync(f, readFileSync(f, "utf8").replace(/^sensitivity: private$/m, "sensitivity: personal"));
    expect(await req("POST", "/say", { csrf, q: "who are my kids", from: "ask" })).toContain("Your kids: Léa Lefebvre and Theo Lefebvre.");
    (await import("node:fs")).rmSync(join(root, "people/lea-lefebvre.md"));
    expect(await req("GET", "/ask")).not.toContain("Léa Lefebvre");
  } finally { delete process.env.PB_NOW; }
}, 60_000);
