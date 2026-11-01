// SPDX-License-Identifier: AGPL-3.0-only
// Audit v9, high (G582): a value made private after it was written still rendered in the page's
// prose and the search box on the 30-day sign-in; the canvas replay's G567 closed the home lines
// only. Every owner screen the 30-day sign-in opens decides from the note as it is now.
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { dashboardHandler } from "../src/dashboard/server";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const H = "127.0.0.1:8796";
const ID = "people/kenji-watanabe", VALUE = "senior data analyst";

for (const how of ["page-private", "fact-private"] as const) {
  test(`on the 30-day sign-in, a value made private after it was written (${how}) shows in no prose, search or box answer (G582)`, async () => {
    process.env.PB_NOW = DEMO_NOW;
    try {
      const { root } = await makeDemoBrain();
      const t = Date.parse(DEMO_NOW);
      let at = t;
      const d = dashboardHandler(root, { port: 8796, loginKey: "k".repeat(32), now: () => new Date(at) });
      const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const req = async (method: string, path: string, fields?: Record<string, string>) => {
        const body = fields ? new URLSearchParams(fields) : undefined;
        return (await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/home`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }))).text();
      };
      at = t + 11 * 60_000;
      // Before: an everyday value shows on the 30-day sign-in.
      expect(await req("GET", `/p/${ID}`)).toContain(VALUE);
      const f = join(root, `${ID}.md`);
      const text = readFileSync(f, "utf8");
      writeFileSync(f, how === "fact-private"
        ? text.replace(/^(  role:\n(?:    .*\n)*?)(    value: senior data analyst\n)/m, "$1$2    sensitivity: private\n")
        : text.replace(/^sensitivity: \w+$/m, "sensitivity: private"));
      expect(readFileSync(f, "utf8")).not.toBe(text);
      const screens: Record<string, string> = {
        page: await req("GET", `/p/${ID}`),
        home: await req("GET", "/home?all=1"),
        memory: await req("GET", "/memory?changes=week"),
        searchName: await req("GET", "/memory?q=Kenji"),
        // The box echoes what the owner typed, so a search is checked with words that aren't the whole value.
        searchSenior: await req("GET", "/memory?q=senior"),
        searchWord: await req("GET", "/memory?q=analyst"),
        results: await req("GET", "/brain/results?q=analyst"),
      };
      const csrf = (await req("GET", "/home")).match(/name="csrf" value="([^"]+)"/)![1]!;
      screens.boxReply = await req("POST", "/say", { csrf, q: "what is Kenji Watanabe's role", from: "home" });
      screens.boxPage = await req("POST", "/say", { csrf, q: "Kenji Watanabe", from: "home" });
      screens.ask = await req("GET", "/ask");
      for (const [k, html] of Object.entries(screens)) expect([k, html.includes(VALUE)]).toEqual([k, false]);
    } finally { delete process.env.PB_NOW; }
  }, 60_000);
}
