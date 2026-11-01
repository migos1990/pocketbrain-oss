// SPDX-License-Identifier: AGPL-3.0-only
// Audit v8 UX list, unchanged through v10 (G616): a page's "See also" named a linked page as
// "Mom&#39;s move". The page writer links by [[id|label]], and the label was escaped twice: once
// with the text around it, again as the link's words.
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { dashboardHandler } from "../src/dashboard/server";

test("a linked page's name with an apostrophe reads as written on the owner's page (G616)", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    const H = "127.0.0.1:8791";
    const d = dashboardHandler(root, { port: 8791, loginKey: "k".repeat(32) });
    const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const html = await (await d.handle(new Request(`http://${H}/p/people/helene-lefebvre`, { headers: { host: H, cookie } }))).text();
    expect(html).toContain('href="/p/projects/moms-move">Mom&#39;s move</a>');
    expect(html).not.toContain("&amp;#39;");
  } finally { delete process.env.PB_NOW; }
}, 60_000);
