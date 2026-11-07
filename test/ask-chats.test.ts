// SPDX-License-Identifier: AGPL-3.0-only
// The owner, 2026-11-07: "like many apps right now, there should be a way of having multiple
// sessions … starting a new thread, and seeing previous threads … keeping the context within each
// session." Ask keeps chats (G716): New chat starts one, Earlier chats lists them, each keeps its
// own context, and they stay across sign-ins and restarts, on the hub only (outside git), each
// with Delete. A chat's label on an older sign-in never shows what was typed (G717).
import { test, expect } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { dashboardHandler } from "../src/dashboard/server";
import { APP_COPY } from "../src/dashboard/html-app";
import { gitSide } from "../src/quotes";
import { git } from "../src/git";

const H = "127.0.0.1:8794";
function handler(root: string, at: { t: number }) {
  const d = dashboardHandler(root, { port: 8794, loginKey: "k".repeat(32), now: () => new Date(at.t) });
  return async () => {
    const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const req = async (method: string, path: string, fields?: Record<string, string>) => {
      const body = fields ? new URLSearchParams(fields) : undefined;
      const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/ask`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
      return { status: r.status, text: await r.text(), loc: r.headers.get("location") ?? "" };
    };
    const page = async (p = "/ask") => (await req("GET", p)).text;
    const csrf = async () => (await page()).match(/name="csrf" value="([^"]+)"/)![1]!;
    // The box on a chat's page carries that chat; t is "new" on a new chat.
    const chatOf = (html: string) => html.match(/name="t" value="([^"]+)"/)?.[1];
    const say = async (q: string, t?: string) => req("POST", "/say", { csrf: await csrf(), q, from: "ask", ...(t ? { t } : {}) });
    return { req, page, csrf, say, chatOf };
  };
}
const turns = (html: string) => [...html.matchAll(/<p class="bubble you">([^<]*)<\/p>/g)].map((m) => m[1]);
const chats = (html: string) => [...html.matchAll(/<a class="chat" href="\/ask\?t=([0-9a-f]{16})"/g)].map((m) => m[1]);
const dir = (root: string) => gitSide(root, "pb-ask");

test("G716 a chat stays across sign-ins and a restart, kept outside git", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    const at = { t: Date.parse(DEMO_NOW) };
    const one = await handler(root, at)();
    await one.say("who is camille");
    await one.say("is she my daughter?");
    // Another sign-in, and a restarted dashboard, open on the same chat.
    expect(turns(await (await handler(root, at)()).page())).toEqual(["who is camille", "is she my daughter?"]);
    const files = readdirSync(dir(root));
    expect(files).toHaveLength(1);
    expect(statSync(join(dir(root), files[0]!)).mode & 0o777).toBe(0o600);
    expect(git(root, ["status", "--porcelain"])).not.toContain("pb-ask");
    expect(git(root, ["log", "--all", "--format=%H", "--", "*pb-ask*"])).toBe("");
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("G716 New chat starts its own context; Earlier chats lists them; each keeps its own", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    const at = { t: Date.parse(DEMO_NOW) };
    const s = await handler(root, at)();
    await s.say("who is camille");
    const first = s.chatOf(await s.page())!;
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    // A new chat: empty, with the hint, and its box says it is new.
    const fresh = await s.page("/ask?t=new");
    expect(turns(fresh)).toEqual([]);
    expect(fresh).toContain(APP_COPY.askHint);
    expect(s.chatOf(fresh)).toBe("new");
    expect(await s.page()).toContain(`href="/ask?t=new"`);
    // In the new chat, "she" names nobody: it doesn't carry the other chat's page.
    at.t += 60_000;
    const r = await s.say("is she my daughter?", "new");
    expect(r.text.slice(r.text.indexOf("is she my daughter?"))).not.toContain("Camille");
    const second = s.chatOf(r.text)!;
    expect(second).not.toBe(first);
    // Ask opens the newest chat; the list has both, newest first.
    expect(turns(await s.page())).toEqual(["is she my daughter?"]);
    expect(chats(await s.page("/ask?list=1"))).toEqual([second, first]);
    // Back in the first chat, a follow-up is about Camille, hours later too.
    at.t += 5 * 3_600_000;
    const back = await s.say("how old is she?", first);
    // The first turn was made right after the sign-in, so it is hidden now (G637); it still counts.
    expect(turns(back.text)).toEqual(["how old is she?"]);
    expect(back.text).toContain(APP_COPY.askHidden);
    expect(back.text.slice(back.text.indexOf("how old is she?"))).toContain("Camille");
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("G716 Delete takes a chat away; an unknown chat opens nothing", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    const at = { t: Date.parse(DEMO_NOW) };
    const s = await handler(root, at)();
    await s.say("who is camille");
    const id = s.chatOf(await s.page())!;
    const del = await s.req("POST", "/action/ask-delete", { csrf: await s.csrf(), t: id });
    expect(del.loc).toStartWith("/ask");
    expect(readdirSync(dir(root))).toEqual([]);
    expect(turns(await s.page())).toEqual([]);
    expect(turns(await s.page(`/ask?t=${"0".repeat(16)}`))).toEqual([]);
    expect(chats(await s.page("/ask?list=1"))).toEqual([]);
    // A chat id that isn't 16 hex characters never names a file.
    expect((await s.req("POST", "/say", { csrf: await s.csrf(), q: "who is camille", from: "ask", t: "../../x" })).status).toBeLessThan(500);
    expect(existsSync(join(dir(root), "..", "..", "x.json"))).toBe(false);
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("G717 on an older sign-in a chat's label never says what was typed; its pages' titles do", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    const at = { t: Date.parse(DEMO_NOW) };
    const s = await handler(root, at)();
    await s.say("who is camille");
    expect(await s.page("/ask?list=1")).toContain(">who is camille<");
    at.t += 20 * 60_000; // past FRESH_MINUTES
    const list = await s.page("/ask?list=1");
    expect(list).not.toContain("who is camille");
    expect(list).toContain("Camille Lefebvre");
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("G716 a chat untouched for 90 days is dropped", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    const at = { t: Date.parse(DEMO_NOW) };
    const s = await handler(root, at)();
    await s.say("who is camille");
    at.t += 91 * 86_400_000;
    const later = await handler(root, at)();
    expect(chats(await later.page("/ask?list=1"))).toEqual([]);
    expect(readdirSync(dir(root))).toEqual([]);
  } finally { delete process.env.PB_NOW; }
}, 90_000);

// Review of #130: chats are kept 90 days, so the list spans a new year; a chat from last year
// says its year.
test("G716 a chat from last year says its year in Earlier chats", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    const at = { t: Date.parse(DEMO_NOW) };
    const s = await handler(root, at)();
    await s.say("who is camille");
    expect(await s.page("/ask?list=1")).toContain("<small>8 Oct · ");
    process.env.PB_NOW = "2027-01-02T14:00:00Z";
    at.t = Date.parse(process.env.PB_NOW);
    expect(await (await handler(root, at)()).page("/ask?list=1")).toContain("<small>8 Oct 2026 · ");
  } finally { delete process.env.PB_NOW; }
}, 90_000);
