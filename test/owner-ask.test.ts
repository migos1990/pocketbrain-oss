// SPDX-License-Identifier: AGPL-3.0-only
// The owner app's Ask tab as a chat (brief 2026-10-30, step 4), on the demo brain: what you asked
// and what it answered stay on Ask, oldest first, for this sign-in only and in the hub's memory
// only. After a write the turn keeps its Undo and an Open link to the page. The box's gate is
// unchanged (ownerSay decides; no model decides). A turn made right after a sign-in may hold a
// private value, so on a sign-in older than 10 minutes it isn't shown again.
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { dashboardHandler, ASK_TURNS } from "../src/dashboard/server";
import { APP_COPY } from "../src/dashboard/html-app";

const H = "127.0.0.1:8795";
async function setup() {
  const { root } = await makeDemoBrain();
  let t = Date.parse(DEMO_NOW);
  const d = dashboardHandler(root, { port: 8795, loginKey: "k".repeat(32), now: () => new Date(t) });
  const signIn = async () => {
    const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const req = async (method: string, path: string, fields?: Record<string, string>) => {
      const body = fields ? new URLSearchParams(fields) : undefined;
      const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/ask`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
      return { status: r.status, text: await r.text() };
    };
    const csrf = async () => (await req("GET", "/ask")).text.match(/name="csrf" value="([^"]+)"/)![1]!;
    const say = async (q: string) => req("POST", "/say", { csrf: await csrf(), q, from: "ask" });
    return { req, say };
  };
  return { root, signIn, later: (min: number) => { t += min * 60_000; } };
}
const turns = (html: string) => [...html.matchAll(/<p class="bubble you">([^<]*)<\/p>/g)].map((m) => m[1]);

test("Ask keeps the conversation, oldest first, with Undo and Open after a write", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { signIn } = await setup();
    const { req, say } = await signIn();
    await say("what is Isabelle Roy's role?");
    const r = await say("Product Discovery course's next step is book the exam room");
    expect(turns(r.text)).toEqual(["what is Isabelle Roy&#39;s role?", "Product Discovery course&#39;s next step is book the exam room"]);
    const a = (await req("GET", "/ask")).text;
    expect(turns(a)).toHaveLength(2);
    expect(a).toContain("Here&#39;s what I have:");
    expect(a).toContain('action="/action/diary-undo"');
    expect(a).toMatch(/<a class="open" href="\/p\/projects\/product-discovery-course">Open Product Discovery course<\/a>/);
    expect(a).not.toContain(APP_COPY.askHint);
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("the conversation is this sign-in's only, and holds the last turns", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { signIn } = await setup();
    const one = await signIn();
    for (let i = 0; i < ASK_TURNS + 2; i++) await one.say(`what is Isabelle Roy's role? ${i}`);
    const mine = turns((await one.req("GET", "/ask")).text);
    expect(mine).toHaveLength(ASK_TURNS);
    expect(mine.at(-1)).toContain(`${ASK_TURNS + 1}`);
    const other = await signIn();
    expect(turns((await other.req("GET", "/ask")).text)).toEqual([]);
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("past 10 minutes, a turn made right after the sign-in isn't shown again; a later one is", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { signIn, later } = await setup();
    const { req, say } = await signIn();
    await say("what is Isabelle Roy's role?");
    later(11);
    await say("who is Maya Chen?");
    const a = (await req("GET", "/ask")).text;
    expect(turns(a)).toEqual(["who is Maya Chen?"]);
    expect(a).toContain(APP_COPY.askOlder);
  } finally { delete process.env.PB_NOW; }
}, 60_000);
