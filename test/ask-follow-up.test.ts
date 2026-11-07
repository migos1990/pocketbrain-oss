// SPDX-License-Identifier: AGPL-3.0-only
// The owner's phone, 2026-11-06: on Ask he asked "who is emma?", then "is she my daughter?", and
// Ask answered the second as if it had never heard the first. A follow-up on the same Ask screen
// that names nobody ("she", "her", "they") is about the page the last answer was about; a question
// that names someone is about them, whatever came before (plans/ask-sessions.md, first slice).
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { ownerSay } from "../src/owner-say";
import { dashboardHandler } from "../src/dashboard/server";

const CAMILLE = "people/camille-lefebvre";

test("a follow-up that names nobody is about the page the last answer was about", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    const ask = (q: string, follows?: string) => ownerSay(root, q, { fresh: true, from: "ask", ...(follows ? { follows } : {}) });
    expect(ask("who is camille").page).toBe(CAMILLE);
    expect(ask("is she my daughter?", CAMILLE).page).toBe(CAMILLE);
    expect(ask("how old is she", CAMILLE).text).toContain("Camille");
    // A name wins over what came before.
    expect(ask("what about julie", CAMILLE).page).toBe("people/julie-tran");
    // With nothing before, a bare "she" still names nobody.
    expect(ask("is she my daughter?").page).toBeUndefined();
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("on the Ask screen, the second question carries the first one's page", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    const H = "127.0.0.1:8789";
    const d = dashboardHandler(root, { port: 8789, loginKey: "k".repeat(32), now: () => new Date(DEMO_NOW) });
    const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const req = async (m: string, p: string, f?: Record<string, string>) => (await d.handle(new Request(`http://${H}${p}`, { method: m, body: f ? new URLSearchParams(f) : undefined, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/ask`, ...(f ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }))).text();
    const csrf = (await req("GET", "/ask")).match(/name="csrf" value="([^"]+)"/)![1]!;
    await req("POST", "/say", { csrf, q: "who is camille", from: "ask" });
    const second = await req("POST", "/say", { csrf, q: "is she my daughter?", from: "ask" });
    const after = second.slice(second.indexOf("is she my daughter?"));
    expect(after).not.toContain("Nothing on that yet");
    expect(after).toContain("Camille");
    // Review of #122: a question that found nothing in between doesn't lose who it was about.
    await req("POST", "/say", { csrf, q: "what's the weather in Lisbon?", from: "ask" });
    const third = await req("POST", "/say", { csrf, q: "how old is she?", from: "ask" });
    expect(third.slice(third.indexOf("how old is she?"))).toContain("Camille");
  } finally { delete process.env.PB_NOW; }
}, 90_000);
