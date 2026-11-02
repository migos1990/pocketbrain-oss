// SPDX-License-Identifier: AGPL-3.0-only
// A held value is read before it is let out (owner's phone, 2026-11-02: "I don't know what I'm
// showing"). On a fresh sign-in the home's held card says the value, then offers two separate
// choices: let the assistants have it, or keep it private. On an older sign-in the card says no
// value and offers only Read it (a sign-in again, Face ID in the app); Show is never the only way to
// read it. The done line names the fact in a sentence, one full stop (G630).
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { readNote } from "../src/core";
import { markSeen, unseenFacts } from "../src/seen";
import { APP_COPY } from "../src/dashboard/html-app";

const W = (root: string, attribute: string, value: string) =>
  write(root, { agent: "planner", id: "people/jane-roy", attribute, value, as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source", sensitivity: "private" } as never);
const sees = (root: string, needle: string) => JSON.stringify(readNote(root, "planner", "people/jane-roy")).includes(needle);

async function dash(root: string, port: number) {
  const { dashboardHandler, flashOf } = await import("../src/dashboard/server");
  const H = `127.0.0.1:${port}`;
  let at = Date.parse("2026-10-08T14:00:00Z");
  const d = dashboardHandler(root, { port, loginKey: "k".repeat(32), now: () => new Date(at) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
  const req = async (method: string, path: string, fields?: Record<string, string>) => {
    const body = fields ? new URLSearchParams(fields) : undefined;
    const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/home`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
    return { status: r.status, text: await r.text(), loc: r.headers.get("location") ?? "" };
  };
  return { req, flashOf, later: (min: number) => { at += min * 60_000; } };
}
// The held group's first card (the home's memories below it can be warn cards too).
const card = (html: string) => html.split(APP_COPY.heldHead)[1]?.match(/<li class="card warn">[\s\S]*?<\/div><\/li>/)?.[0] ?? "";
const csrfOf = (html: string) => html.match(/name="csrf" value="([^"]+)"/)![1]!;

test("on a fresh sign-in the held card says the value, with Let them have it and Keep it private apart", async () => {
  const root = makeBrain();
  W(root, "fee", "1200 dollars a year");
  const { req } = await dash(root, 8851);
  const c = card((await req("GET", "/home")).text);
  expect(c).toContain("<li>Jane Roy&#39;s fee is 1200 dollars a year.</li>");
  expect(c).toContain(APP_COPY.letThem);
  expect(c).toContain(APP_COPY.keepPrivate);
  expect(c).toContain('action="/action/diary-keep"');
});

test("a kept value on the full list, on a fresh sign-in, says it and offers only Let them have it", async () => {
  const root = makeBrain();
  W(root, "fee", "1200 dollars a year");
  const { req } = await dash(root, 8855);
  const csrf = csrfOf((await req("GET", "/home")).text);
  await req("POST", "/action/diary-keep", { csrf, key: "people/jane-roy#fee" });
  const html = (await req("GET", "/home?all=1")).text;
  const kept = html.slice(html.indexOf("Kept private: something about Jane Roy."));
  const c = kept.slice(0, kept.indexOf("</li></ul>") > 0 ? kept.indexOf("</div></li>") : undefined);
  expect(c).toContain("Jane Roy&#39;s fee is 1200 dollars a year.");
  expect(c).toContain(APP_COPY.letThem);
  expect(c).not.toContain(APP_COPY.keepPrivate);
  // Nothing waits: no count, and the kept value sits under its own heading with no number.
  expect(html).not.toContain('<p class="count">');
  expect(html).toContain(`<h2 class="group">${APP_COPY.keptHead}</h2>`);
  expect(html).not.toContain(APP_COPY.heldHead);
});

test("on an older sign-in the card says no value and offers Read it, never Show as the only way in", async () => {
  const root = makeBrain();
  W(root, "fee", "1200 dollars a year");
  const { req, later } = await dash(root, 8852);
  later(30);
  const html = (await req("GET", "/home")).text;
  const c = card(html);
  expect(html).not.toContain("1200");
  expect(c).toContain(APP_COPY.readIt);
  expect(c).toContain('action="/action/sign-in-again"');
  expect(c).not.toContain('action="/action/diary-seen"');
});

test("Keep it private leaves it held from every assistant and takes it off what waits", async () => {
  const root = makeBrain();
  W(root, "fee", "1200 dollars a year");
  const { req, flashOf, later } = await dash(root, 8853);
  later(30); // keeping a thing back runs on the 30-day sign-in
  const csrf = csrfOf((await req("GET", "/home")).text);
  const kept = await req("POST", "/action/diary-keep", { csrf, key: "people/jane-roy#fee" });
  expect(kept.status).toBe(303);
  expect(flashOf(kept.loc).ok).toBe(APP_COPY.keptPrivate);
  expect(unseenFacts(root)).toHaveLength(0);
  expect(sees(root, "1200 dollars")).toBe(false);
  expect(card((await req("GET", kept.loc)).text)).toBe("");
  // The owner can still let it out later: the full list shows it, uncounted, with Let them have it
  // and no second Keep it private (review of #60).
  const all = (await req("GET", "/home?all=1")).text;
  expect(all).toContain("Kept private: something about Jane Roy.");
  expect(all).toContain('action="/action/sign-in-again"');
  expect(markSeen(root, "no-hash-key").outcome).toBe("not_found");
  expect(markSeen(root, "people/jane-roy#fee").outcome).toBe("seen");
  expect(sees(root, "1200 dollars")).toBe(true);
});

test("the done line names the fact in a sentence with one full stop", async () => {
  const root = makeBrain();
  W(root, "kind", "insurance.");
  const { req, flashOf } = await dash(root, 8854);
  const csrf = csrfOf((await req("GET", "/home")).text);
  const shown = await req("POST", "/action/diary-seen", { csrf, key: "people/jane-roy#kind" });
  const ok = flashOf(shown.loc).ok!;
  expect(ok).not.toContain("..");
  expect(ok).not.toContain("'s kind");
  expect(ok).toBe("Jane Roy is filed under insurance. Your assistants get it now.");
});
