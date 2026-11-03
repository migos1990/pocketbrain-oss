// SPDX-License-Identifier: AGPL-3.0-only
// Data on a screen reads in context (owner's phone, 2026-11-03: "some data needs to be
// contextualized more or merged together"; G634). Three shapes from his screenshots:
// 1. Held values on the home said one sentence per value ("Notes app subscription's amount is
//    CAD 6.20." "…'s due is 9 Nov 2026." "…'s status is will renew."): one thing, one sentence.
// 2. A model-written review paragraph (pay figures and all) was read out on the home as a fact:
//    prose is a note on its page, never a line on the home.
// 3. Memory listed the same name twice, and "X", "X, Fall 2026", "X: exam due…" as strangers:
//    one row per name, and a name's own pages sit under it.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { APP_COPY, memoryPage, type MemoryView } from "../src/dashboard/html-app";
import { factSentence, pageSentences } from "../src/dashboard/home";

const W = (root: string, attribute: string, value: string) =>
  write(root, { agent: "planner", id: "people/jane-roy", attribute, value, as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source", sensitivity: "private" } as never);

async function home(root: string, port: number, path = "/home") {
  const { dashboardHandler, flashOf } = await import("../src/dashboard/server");
  const H = `127.0.0.1:${port}`;
  const d = dashboardHandler(root, { port, loginKey: "k".repeat(32), now: () => new Date("2026-10-08T14:00:00Z") });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
  const get = async (p: string) => (await d.handle(new Request(`http://${H}${p}`, { headers: { host: H, cookie } }))).text();
  const post = async (p: string, fields: Record<string, string>) => {
    const r = await d.handle(new Request(`http://${H}${p}`, { method: "POST", body: new URLSearchParams(fields), headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/home`, "content-type": "application/x-www-form-urlencoded" } }));
    return flashOf(r.headers.get("location") ?? "");
  };
  return { html: await get(path), get, post };
}
const looks = (html: string) => [...html.matchAll(/<ul class="look">([\s\S]*?)<\/ul>/g)].flatMap((m) => [...m[1]!.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((x) => x[1]!.replace(/&#39;/g, "'")));

test("a thing's held values read as one sentence, the amount first and its status bare", async () => {
  const root = makeBrain();
  W(root, "status", "will renew");
  W(root, "due", "9 Nov 2026");
  W(root, "amount", "CAD 6.20");
  const { html } = await home(root, 8861);
  const l = looks(html);
  expect(l).toEqual(["Jane Roy comes to CAD 6.20, is due 9 Nov 2026 and will renew."]);
  expect(html).not.toContain("status is will renew");
});

test("one held status or amount says itself, never \"status is will renew\"", () => {
  const notes = new Map();
  expect(factSentence("money/x", "Notes app subscription", "status", "will renew", notes)).toBe("Notes app subscription will renew.");
  expect(factSentence("money/x", "Music service payment", "amount", "CAD 17.23", notes)).toBe("Music service payment comes to CAD 17.23.");
  expect(factSentence("money/x", "Music service payment", "status", "paid", notes)).toBe("Music service payment is paid.");
  // Anything else keeps its sentence, and a page's other values follow as "Its … is …".
  expect(pageSentences([{ page: "money/x", title: "Gym", attr: "amount", value: "CAD 40" }, { page: "money/x", title: "Gym", attr: "plan", value: "Family" }], notes)).toEqual(["Gym comes to CAD 40. Its plan is Family."]);
  expect(factSentence("people/jane-roy", "Jane Roy", "fee", "1200 dollars a year", notes)).toBe("Jane Roy's fee is 1200 dollars a year.");
});

test("a review paragraph is a note on its page, never read out on the home", async () => {
  const root = makeBrain();
  const review = "This note holds the full pay breakdown (base, bonus, share vesting, total around CAD 430K) and is filed under area personal. Pay details like these usually belong in the private tier.";
  W(root, "sensitivity_review", review);
  W(root, "amount", "CAD 125.00");
  const { html } = await home(root, 8862);
  expect(html).not.toContain("430K");
  expect(html).not.toContain("pay breakdown");
  expect(looks(html)).toEqual(["Jane Roy comes to CAD 125.00 and has a longer sensitivity review note on its page."]);
  expect(factSentence("people/jane-roy", "Jane Roy", "sensitivity_review", review, new Map())).toBe("Jane Roy has a longer sensitivity review note on its page.");
});

test("let out together, the done line says one sentence per thing", async () => {
  const root = makeBrain();
  W(root, "amount", "CAD 6.20");
  W(root, "status", "paid");
  const { html, post } = await home(root, 8863);
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1]!;
  const ok = (await post("/action/diary-seen", { csrf, key: "people/jane-roy#amount\npeople/jane-roy#status" })).ok!;
  expect(ok).toBe("Jane Roy comes to CAD 6.20 and is paid. Your assistants get them now.");
});

test("three held values on one page read as one line on its card", async () => {
  const root = makeBrain();
  W(root, "amount", "CAD 6.20");
  W(root, "status", "paid");
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "fee", value: "12 dollars", as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source", sensitivity: "private" } as never);
  const { html } = await home(root, 8864);
  // One page here: the card names it, and its line holds all three.
  expect(looks(html)).toHaveLength(1);
});

test("pageSentences keeps pages apart and in the order they came", () => {
  const s = pageSentences([
    { page: "money/a", title: "Music service payment", attr: "amount", value: "CAD 17.23" },
    { page: "money/b", title: "Phone plan", attr: "amount", value: "CAD 0.12" },
    { page: "money/a", title: "Music service payment", attr: "status", value: "paid" },
  ], new Map());
  expect(s).toEqual(["Music service payment comes to CAD 17.23 and is paid.", "Phone plan comes to CAD 0.12."]);
});

const view = (titles: string[]): MemoryView => ({ pages: titles.length, people: 0, name: "Sam", kinds: [], week: [], kind: { label: "Projects", pages: titles.map((t, i) => ({ id: `projects/p${i}`, title: t })) } });
const rowsOf = (html: string) => [...html.matchAll(/<b>([^<]*)<\/b>/g)].map((m) => m[1]!.replace(/&#39;/g, "'").replace(/&amp;/g, "&"));

test("Memory says a name once: two pages with one name are one row that says so", () => {
  const html = memoryPage(view(["Garden planning", "Garden planning", "Family recipes"]));
  expect(rowsOf(html).filter((t) => t === "Garden planning")).toHaveLength(1);
  expect(html).toContain(APP_COPY.sameName.replace("{n}", "2"));
  // The row opens a search for that name, which lists both pages.
  expect(html).toContain('href="/memory?q=Garden%20planning"');
});

test("Memory folds a name's own pages under it: a course, its term, its exam", () => {
  const html = memoryPage(view(["Course B12", "Course B12, Fall 2026", "Course B12: midterm due by Oct 9, 2026", "Course design platform"]));
  // The parent row first, its pages nested under it by what follows the name.
  const nest = html.match(/<ul class="rows sub">([\s\S]*?)<\/ul>/)?.[1] ?? "";
  expect(rowsOf(nest)).toEqual(["Fall 2026", "midterm due by Oct 9, 2026"]);
  // A different name that starts the same way stays its own row.
  expect(rowsOf(html.replace(nest, ""))).toEqual(["Course B12", "Course design platform"]);
});

test("a page under a page under a name sits under the name, never dropped", () => {
  const html = memoryPage(view(["Course", "Course, Fall 2026", "Course, Fall 2026: exam due"]));
  const nest = html.match(/<ul class="rows sub">([\s\S]*?)<\/ul>/)?.[1] ?? "";
  expect(rowsOf(nest)).toEqual(["Fall 2026", "Fall 2026: exam due"]);
});

test("Memory groups three or more pages that lead with one name under that name", () => {
  const html = memoryPage(view(["Hosting invoice IN-1", "Hosting purchase", "Streamly Monthly plan", "Streamly subscription", "Streamly Welcome back offer (iPhone)", "Streamly Welcome back offer (web)", "Disney+ Premium (Monthly) subscription"]));
  const nest = html.match(/<ul class="rows sub">([\s\S]*?)<\/ul>/)?.[1] ?? "";
  expect(rowsOf(nest)).toEqual(["Monthly plan", "subscription", "Welcome back offer (iPhone)", "Welcome back offer (web)"]);
  expect(rowsOf(html)[0]).toBe("Hosting invoice IN-1");
  expect(rowsOf(html)).toContain("Streamly");
  // Two that share a lead word only are left as they are.
  expect(html).not.toMatch(/<b>Hosting<\/b>/);
});

test("Memory's dots say what they mean: a key names each area shown, and each dot says its area to a screen reader", () => {
  const html = memoryPage({ ...view([]), kind: { label: "Projects", pages: [{ id: "projects/a", title: "Garden planning", area: "personal" }, { id: "projects/b", title: "Course B12", area: "teaching" }, { id: "projects/c", title: "Loose page" }] } });
  const key = html.match(/<p class="key">([\s\S]*?)<\/p>/)?.[1] ?? "";
  expect(key).toContain("Personal");
  expect(key).toContain("Teaching");
  expect(key).toContain("No area");
  // Only the areas on the screen: no work page here, so no Work in the key.
  expect(key).not.toContain("Work");
  expect(html).toContain('<span class="sr">Personal</span>');
});
