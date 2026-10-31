// SPDX-License-Identifier: AGPL-3.0-only
// The launch site's counter: totals per day, nothing about the visitor.
import { expect, test } from "bun:test";
import { type Env, handle, type Store } from "../site/analytics.ts";

function memStore(): Store & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(k) { return data.get(k) ?? null; },
    async put(k, v) { data.set(k, v); },
  };
}

const NOW = new Date("2026-11-02T15:04:05Z");
const SCRIPT = "#!/bin/sh\necho installer\n";

function env(store = memStore()): Env & { COUNTS: ReturnType<typeof memStore> } {
  return { COUNTS: store, STATS_TOKEN: "s3cret-stats-token", INSTALL_SCRIPT_URL: "https://example.test/install.sh", SOURCE_REPO_URL: "https://git.example.test/owner/pocketbrain.git", PAGES: "/,/docs,/pricing" };
}

const fetchScript = async () => new Response(SCRIPT, { status: 200 });

const visitor = {
  "CF-Connecting-IP": "203.0.113.7",
  "X-Forwarded-For": "203.0.113.7",
  "User-Agent": "Mozilla/5.0 (Macintosh) Visitor/1.0",
  Cookie: "session=abc",
  "CF-IPCountry": "CA",
};

const hit = (body: unknown, headers: Record<string, string> = visitor) =>
  new Request("https://pocketbrain.dev/hit", { method: "POST", headers, body: JSON.stringify(body) });

const stats = async (e: Env, token = "s3cret-stats-token") =>
  handle(new Request("https://pocketbrain.dev/stats", { headers: { Authorization: `Bearer ${token}` } }), e, NOW, fetchScript);

test("a page view is counted per day and page, and nothing about the visitor is stored or set", async () => {
  const e = env();
  const r = await handle(hit({ p: "/docs?utm=x#top", r: "https://news.ycombinator.com/item?id=1" }), e, NOW, fetchScript);
  expect(r.status).toBe(204);
  expect(r.headers.get("set-cookie")).toBeNull();
  await handle(hit({ p: "/docs" }), e, NOW, fetchScript);

  const day = JSON.parse(e.COUNTS.data.get("day:2026-11-02")!);
  expect(day.views).toEqual({ "/docs": 2 });
  expect(day.from).toEqual({ "news.ycombinator.com": 1 });
  expect(day.countries).toEqual({ CA: 2 });

  const stored = [...e.COUNTS.data.entries()].flat().join("\n");
  for (const bit of ["203.0.113", "Visitor/1.0", "Macintosh", "session=abc", "utm", "item?id"]) expect(stored).not.toContain(bit);
});

test("pages outside the site's list count as other, so stray paths can't fill the store", async () => {
  const e = env();
  for (const p of ["/wp-admin.php", "/a".repeat(500), 42, null]) await handle(hit({ p }), e, NOW, fetchScript);
  await handle(hit({ p: "/pricing/" }), e, NOW, fetchScript);
  const day = JSON.parse(e.COUNTS.data.get("day:2026-11-02")!);
  expect(day.views).toEqual({ other: 4, "/pricing": 1 });
});

test("a referrer counts only as its host, and a junk or same-site one is left out", async () => {
  const e = env();
  for (const r of ["https://pocketbrain.dev/docs", "javascript:alert(1)", "not a url", `https://${"x".repeat(300)}.com/`, "https://WWW.LinkedIn.com/feed/"]) await handle(hit({ p: "/", r }), e, NOW, fetchScript);
  const day = JSON.parse(e.COUNTS.data.get("day:2026-11-02")!);
  expect(day.from).toEqual({ "linkedin.com": 1 });
});

test("the install script is served as is and each download is counted", async () => {
  const e = env();
  const r = await handle(new Request("https://pocketbrain.dev/install.sh", { headers: visitor }), e, NOW, fetchScript);
  expect(r.status).toBe(200);
  expect(await r.text()).toBe(SCRIPT);
  expect(r.headers.get("content-type")).toContain("text/plain");
  expect(r.headers.get("set-cookie")).toBeNull();
  const day = JSON.parse(e.COUNTS.data.get("day:2026-11-02")!);
  expect(day.installs).toBe(1);
  expect(JSON.stringify(day)).not.toContain("203.0.113");
});

test("/git sends git to the public source, so the installer's clone address never names the account", async () => {
  const e = env();
  const r = await handle(new Request("https://pocketbrain.dev/git/info/refs?service=git-upload-pack", { headers: visitor }), e, NOW, fetchScript);
  expect(r.status).toBe(302);
  expect(r.headers.get("location")).toBe("https://git.example.test/owner/pocketbrain.git/info/refs?service=git-upload-pack");
  expect(e.COUNTS.data.size).toBe(0);
  const off = await handle(new Request("https://pocketbrain.dev/git/info/refs"), { ...e, SOURCE_REPO_URL: "" }, NOW, fetchScript);
  expect(off.status).toBe(404);
  const near = await handle(new Request("https://pocketbrain.dev/github"), e, NOW, fetchScript);
  expect(near.status).toBe(404);
});

test("a failed script fetch is an error, not a counted install", async () => {
  const e = env();
  const r = await handle(new Request("https://pocketbrain.dev/install.sh"), e, NOW, async () => new Response("nope", { status: 502 }));
  expect(r.status).toBe(502);
  expect(e.COUNTS.data.get("day:2026-11-02")).toBeUndefined();
});

test("stats need the owner's token and give daily totals, newest first", async () => {
  const e = env();
  await handle(hit({ p: "/" }), e, new Date("2026-11-01T10:00:00Z"), fetchScript);
  await handle(hit({ p: "/" }), e, NOW, fetchScript);
  await handle(new Request("https://pocketbrain.dev/install.sh"), e, NOW, fetchScript);

  expect((await handle(new Request("https://pocketbrain.dev/stats"), e, NOW, fetchScript)).status).toBe(401);
  expect((await stats(e, "wrong")).status).toBe(401);
  expect((await stats({ ...e, STATS_TOKEN: "" }, "")).status).toBe(401);

  const r = await stats(e);
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.days.slice(0, 2)).toEqual([
    { day: "2026-11-02", views: { "/": 1 }, installs: 1, from: {}, countries: { CA: 1 } },
    { day: "2026-11-01", views: { "/": 1 }, installs: 0, from: {}, countries: { CA: 1 } },
  ]);
  expect(body.days).toHaveLength(30);
  expect(body.totals).toEqual({ views: 2, installs: 1 });
});

test("anything else is not found, and the beacon script sends no cookie and reads no id", async () => {
  const e = env();
  expect((await handle(new Request("https://pocketbrain.dev/nope"), e, NOW, fetchScript)).status).toBe(404);
  const r = await handle(new Request("https://pocketbrain.dev/count.js"), e, NOW, fetchScript);
  expect(r.status).toBe(200);
  const js = await r.text();
  expect(js).toContain("sendBeacon");
  for (const bit of ["cookie", "localStorage", "sessionStorage", "userAgent", "screen."]) expect(js).not.toContain(bit);
});
