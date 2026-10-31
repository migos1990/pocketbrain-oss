// SPDX-License-Identifier: AGPL-3.0-only
// Outside review v5: the owner is asked only about conflicts. The decision deck, the spot check and
// the old Ask page are gone; Settings (/overview) is a page behind Who knows, not a tab bar; who
// sees a page is changed on that page itself. The owner app (brief 2026-10-30) brought back a tab
// bar of its own, four owner tabs, and Ask among them is only the home's box (owner-app.test.ts).
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { dashboardHandler } from "../src/dashboard/server";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { write } from "../src/write";
import { loadBrain } from "../src/brain";
import { openItems } from "../src/textline/items";
import { loadEscalation } from "../src/textline/policy";
import { verdict } from "../src/filing";

const H = "127.0.0.1:8797";
async function signedIn() {
  const root = makeBrain();
  const d = dashboardHandler(root, { port: 8797, loginKey: "k".repeat(32) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
  const get = (path: string) => d.handle(new Request(`http://${H}${path}`, { headers: { host: H, cookie } }));
  const home = await (await get("/home")).text();
  const csrf = home.match(/name="csrf" value="([^"]+)"/)![1];
  const post = (path: string, f: Record<string, string>) => d.handle(new Request(`http://${H}${path}`, {
    method: "POST", body: new URLSearchParams({ csrf, ...f }),
    headers: { host: H, cookie, origin: `http://${H}`, "content-type": "application/x-www-form-urlencoded" },
  }));
  return { root, get, post };
}

test("the deck, the spot check and the old Ask are gone: each answers 404", async () => {
  const { get, post } = await signedIn();
  for (const p of ["/deck", "/spot"]) expect((await get(p)).status, p).toBe(404);
  expect((await post("/ask", { q: "who is Jane Roy" })).status).toBe(404);
});

test("no page has a tab bar: Home and Settings only, and Settings links the pages behind it", async () => {
  const { get } = await signedIn();
  const over = await (await get("/overview")).text();
  const nav = over.match(/<nav aria-label="Pages">([\s\S]*?)<\/nav>/)![1];
  expect([...nav.matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map((m) => m[1])).toEqual(["Home", "Settings"]);
  expect(over).not.toMatch(/class="navmore"|to decide today|href="\/deck"|href="\/spot"/);
  for (const href of ["/brain", "/agents", "/map", "/people", "/history"]) expect(over).toContain(`href="${href}"`);
});

test("who sees a page is changed on the page itself", async () => {
  const { get } = await signedIn();
  const page = await (await get("/p/people/jane-roy")).text();
  expect(page).toContain('action="/action/note-hide"');
  // The old note page is only the edit page now, behind "Edit this page" under Details.
  expect(page.match(/<details id="who">[\s\S]*?<\/details><\/details>|<details id="who">[\s\S]*?<\/details>/)![0]).not.toContain('href="/note/');
});

// Outside audit v5: src/filing.ts was the deleted src/deck.ts under a new name, still exporting
// DECK_CODE and keeping its clocks in log/deck-seen.json. Only the hub's filing is left, named as such.
test("no deck is left in the code: filing exports no deck name, and no src file says deck", async () => {
  const filing = await import("../src/filing");
  expect(Object.keys(filing).filter((k) => /deck/i.test(k))).toEqual([]);
  // A deck as a patio, in the French-English word map, is not the decision deck; the filing still
  // reads its clocks' old file name once, to move them (below).
  const ALLOWED = new Set(["src/lexicon.ts"]);
  const OLD_STATE: Record<string, string> = { "src/filing.ts": '"deck-seen.json"' };
  const src = join(import.meta.dir, "..", "src");
  const hits = readdirSync(src, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(join(src, ".."), join(e.parentPath, e.name)))
    .filter((f) => !ALLOWED.has(f) && /deck/i.test(f + "\n" + readFileSync(join(src, "..", f), "utf8").split(OLD_STATE[f] ?? "\0").join("")));
  expect(hits).toEqual([]);
});

test("a deadline already running in the old log/deck-seen.json keeps running, under the filing's own name", () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules/escalation.yaml"), "health: { url: null }\nauto_decide: { proposal_days: 3 }\n");
  Bun.spawnSync(["git", "-C", root, "add", "-A"]);
  Bun.spawnSync(["git", "-C", root, "-c", "user.name=louis", "-c", "user.email=l@x", "commit", "-q", "-m", "escalation"]);
  const r = write(root, { agent: "helper", id: "people/jane-roy", attribute: "role", value: "Associate dean", as_of: "2026-10-07", sources: ["gmail:1a0e88a496d9705a"], verification: "verified-by-source" });
  expect(r.outcome).toBe("inbox");
  const it = openItems(root).find((i) => i.kind === "proposal")!;
  // The hub first saw it two days from now (a clock the old code wrote): it expires 3 days after that.
  const seen = new Date(Date.now() + 2 * 86_400_000);
  mkdirSync(join(root, "log"), { recursive: true });
  writeFileSync(join(root, "log", "deck-seen.json"), JSON.stringify({ [it.key]: seen.toISOString() }));
  const notes = loadBrain(root);
  const v = verdict(root, it, loadEscalation(root), { notes }, new Date());
  expect("plan" in v && v.plan.at).toBe(new Date(seen.getTime() + 3 * 86_400_000).toISOString());
  expect(existsSync(join(root, "log", "filing-seen.json"))).toBe(true);
  expect(existsSync(join(root, "log", "deck-seen.json"))).toBe(false);
});
