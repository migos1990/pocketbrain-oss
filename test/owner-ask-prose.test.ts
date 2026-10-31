// SPDX-License-Identifier: AGPL-3.0-only
// Ask answers in prose (audit v7, 2026-10-31: Ask answered with a list of facts): a question about
// a page shows that page's own opening prose with its links, and what it cites under it as chips
// (the page, the pages it names, how many sources), worked out when Ask is drawn. The box's gate
// is unchanged: ownerSay decides, and nothing new is read.
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { dashboardHandler } from "../src/dashboard/server";

const H = "127.0.0.1:8793";
async function setup() {
  const { root } = await makeDemoBrain();
  const d = dashboardHandler(root, { port: 8793, loginKey: "k".repeat(32), now: () => new Date(DEMO_NOW) });
  const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const req = async (method: string, path: string, fields?: Record<string, string>) => {
    const body = fields ? new URLSearchParams(fields) : undefined;
    const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/ask`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
    return r.text();
  };
  const csrf = async () => (await req("GET", "/ask")).match(/name="csrf" value="([^"]+)"/)![1]!;
  return { root, req, say: async (q: string) => req("POST", "/say", { csrf: await csrf(), q, from: "ask" }) };
}

test("a question about a page answers with the page's prose, its links and what it cites", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { req, say } = await setup();
    await say("who is Maya Chen?");
    const a = await req("GET", "/ask");
    const answer = a.match(/<div class="bubble answer"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    expect(answer).toBeDefined();
    expect(answer).toContain("Maya Chen is the design lead at");
    expect(answer).toContain('<a href="/p/orgs/harbourline">Harbourline Software</a>');
    expect(answer).not.toMatch(/\[\^|Written by the hub|Here&#39;s what I have/);
    const cites = answer!.match(/<p class="cites">([\s\S]*?)<\/p>/)![1]!;
    expect(cites).toContain('<a href="/p/people/maya-chen">Maya Chen</a>');
    expect(cites).toMatch(/>\d+ sources?<\/a>/);
  } finally { delete process.env.PB_NOW; }
}, 60_000);
