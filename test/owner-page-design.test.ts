// SPDX-License-Identifier: AGPL-3.0-only
// The page and the settle screen in the owner app's design (brief 2026-10-30, Person and Settle
// boards; audit v7 found them still the old design under the new tabs), on the demo brain: a page
// opens on a band in its area's tint with its name, kind and sources, then its prose, its open
// question as a card, What changed, and who sees it as chips; the tab bar is under it. Settle says
// where the question sits ("1 of 3"), its page and area, one question, the sides, Not sure, and the
// box. What each shows and when is unchanged.
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { dashboardHandler } from "../src/dashboard/server";
import { PAGE_COPY } from "../src/dashboard/html-page";
import { SETTLE_COPY } from "../src/dashboard/html-settle";
import { APP_COPY } from "../src/dashboard/html-app";
import { esc } from "../src/dashboard/html-home";

const H = "127.0.0.1:8798";
async function setup() {
  const { root } = await makeDemoBrain();
  const d = dashboardHandler(root, { port: 8798, loginKey: "k".repeat(32), now: () => new Date(DEMO_NOW) });
  const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  return async (path: string) => (await d.handle(new Request(`http://${H}${path}`, { headers: { host: H, cookie } }))).text();
}
const tabOn = (html: string, name: string) => new RegExp(`<nav class="tabbar"[\\s\\S]*aria-current="page">[\\s\\S]*?${name}</a>`).test(html);

test("a person's page: a band in its area's tint, its prose, what changed, who sees it, under the tab bar", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const get = await setup();
    const p = await get("/p/people/hannah-becker");
    expect(p).toMatch(/<header class="band t-work">/);
    expect(p).toContain(`<a href="/memory">‹ ${PAGE_COPY.back}</a>`);
    expect(p).toContain('<span class="face" aria-hidden="true">HB</span>');
    expect(p).toMatch(/<h1>Hannah Becker<\/h1><p class="kind">person · \d+ sources?<\/p>/);
    expect(p).toContain('<span class="chip">Work</span>');
    expect(p).toContain(`<h2 class="sec">${PAGE_COPY.changed}</h2>`);
    expect(p).toMatch(/<div class="seen"><b>Who sees Hannah<\/b>(<span>[^<]+<\/span>)+<\/div>/);
    expect(tabOn(p, APP_COPY.tabMemory)).toBe(true);
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("a project's open question is a card: what's next, and two sources disagreeing opens Settle", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const get = await setup();
    const p = await get("/p/projects/atlas-launch");
    const card = p.match(/<a class="project" href="(\/settle\/[^"]+)">([\s\S]*?)<\/a>/);
    expect(card).not.toBeNull();
    expect(card![2]).toContain(`${PAGE_COPY.next} `);
    expect(card![2]).toContain(esc(PAGE_COPY.disagree));
    const s = await get(card![1]!);
    expect(s).toContain(`<a href="/home">‹ ${SETTLE_COPY.back}</a>`);
    expect(s).toMatch(/<span>\d of 3<\/span>/);
    expect(s).toMatch(/<p class="where"><span class="dot a-work" aria-hidden="true"><\/span>Atlas launch · Work<\/p>/);
    expect(s).toMatch(new RegExp(`<p class="sub">(${esc(SETTLE_COPY.sub)}|${esc(SETTLE_COPY.held)})</p>`.replace(/[?.]/g, "\\$&")));
    expect(s.match(/<form class="pick( first)?" method="post" action="\/action\/settle-pick">/g)?.length).toBe(2);
    expect(s).toContain('<form class="pick both" method="post" action="/action/settle-both">');
    expect(s).toContain(`<p class="tell">${SETTLE_COPY.orTell}</p>`);
    expect(tabOn(s, APP_COPY.tabMind)).toBe(true);
  } finally { delete process.env.PB_NOW; }
}, 60_000);
