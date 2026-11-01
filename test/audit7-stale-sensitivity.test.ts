// SPDX-License-Identifier: AGPL-3.0-only
// Audit v7, high (G551): a page or fact made private or secret after its value was written still
// showed that value on the home, the page's Changed list and the Let sheet, because the line took
// its sensitivity from the diary row written back then. A line re-derives it from the note now.
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { dashboardHandler } from "../src/dashboard/server";
import { markAgents } from "../src/dashboard/marks";
import { loadRules } from "../src/rules";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const H = "127.0.0.1:8795";
const ID = "people/kenji-watanabe", VALUE = "senior data analyst";
type How = "page-private" | "page-secret" | "fact-private";
async function screens(how: How, later = 0) {
  const { root } = await makeDemoBrain();
  const f = join(root, `${ID}.md`);
  let text = readFileSync(f, "utf8");
  expect(text).toContain(VALUE);
  text = how === "fact-private"
    ? text.replace(/^(  role:\n(?:    .*\n)*?)(    value: senior data analyst\n)/m, "$1$2    sensitivity: private\n")
    : text.replace(/^sensitivity: \w+$/m, `sensitivity: ${how === "page-secret" ? "secret" : "private"}`);
  writeFileSync(f, text);
  const t = Date.parse(DEMO_NOW);
  let at = t;
  const d = dashboardHandler(root, { port: 8795, loginKey: "k".repeat(32), now: () => new Date(at) });
  const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  at = t + later * 60_000;
  const get = async (p: string) => (await d.handle(new Request(`http://${H}${p}`, { headers: { host: H, cookie } }))).text();
  const lets = await Promise.all(markAgents(loadRules(root)).map((a) => get(`/let?key=${encodeURIComponent(`${ID}#role`)}&agent=${encodeURIComponent(a.agent)}`)));
  return { text, home: await get("/home?all=1"), page: await get(`/p/${ID}`), lets };
}

for (const how of ["page-private", "page-secret", "fact-private"] as How[]) {
  for (const later of [0, 11]) {
    test(`a value written before its ${how.replace("-", " ")} change stays hidden on the home, the page and the Let sheet (${later ? "30-day" : "fresh"} sign-in, G551)`, async () => {
      process.env.PB_NOW = DEMO_NOW;
      try {
        const s = await screens(how, later);
        if (how === "fact-private") expect(s.text).toContain("sensitivity: private");
        expect(s.home).not.toContain(VALUE);
        // Right after a sign-in the page itself opens a private value (html-page.ts); its Changed list never does.
        if (later) expect(s.page).not.toContain(VALUE);
        else expect(s.page.slice(s.page.indexOf('class="changed"'))).not.toContain(VALUE);
        for (const l of s.lets) expect(l).not.toContain(VALUE);
      } finally { delete process.env.PB_NOW; }
    }, 60_000);
  }
}

test("an Ask answer given on the 30-day sign-in hides once its page is private (G551)", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    const t = Date.parse(DEMO_NOW);
    let at = t;
    const d = dashboardHandler(root, { port: 8795, loginKey: "k".repeat(32), now: () => new Date(at) });
    const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const req = async (method: string, path: string, fields?: Record<string, string>) => {
      const body = fields ? new URLSearchParams(fields) : undefined;
      return (await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/ask`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }))).text();
    };
    at = t + 11 * 60_000;
    const csrf = (await req("GET", "/ask")).match(/name="csrf" value="([^"]+)"/)![1]!;
    await req("POST", "/say", { csrf, q: "what is Kenji Watanabe's role", from: "ask" });
    expect(await req("GET", "/ask")).toContain(VALUE);
    const f = join(root, `${ID}.md`);
    writeFileSync(f, readFileSync(f, "utf8").replace(/^sensitivity: \w+$/m, "sensitivity: private"));
    expect(await req("GET", "/ask")).not.toContain(VALUE);
  } finally { delete process.env.PB_NOW; }
}, 60_000);
