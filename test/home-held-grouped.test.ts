// SPDX-License-Identifier: AGPL-3.0-only
// The owner's phone, 2026-10-29: "Waiting on you" opened on a wall of rows like "Apple Services
// payment: something new · from an address your pages don't hold · only you can see it yet",
// none of them a conflict. Since the owner's typed yes of 2026-11-16 (G907) a held value is no
// card on the home's face at all: one quiet line says how many there are, and the full list names
// each, uncounted, with its own Read it. Conflicts stay one row each.
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain, makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { homeView } from "../src/dashboard/home";
import { loadRules } from "../src/rules";
import { loadBrain } from "../src/brain";
import { memoryCard, APP_COPY } from "../src/dashboard/html-app";
import { dashboardHandler } from "../src/dashboard/server";

function receipts(n: number) {
  const root = makeBrain();
  for (let i = 1; i <= n; i++) writeFileSync(join(root, "money", `apple-payment-${i}.md`), `---\nid: money/apple-payment-${i}\ntype: money\ntitle: Apple Services payment\narea: personal\nsensitivity: private\nstatus: active\ncreated: 2026-10-28\nupdated: 2026-10-28\nby: steward\nfacts:\n  amount: { value: "4.99", as_of: 2026-10-28, sources: ["gmail:f00000000000002${i}"], verification: verified-by-source, by: steward, recorded: 2026-10-28, unseen: true, sender: unknown }\n---\n`);
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=steward", "-c", "user.email=s@x", "commit", "-qm", "steward: receipts"], { cwd: root });
  return root;
}
const NOW = new Date("2026-10-29T23:00:00Z");

// Held values on pages with plain names from known senders: one card per page.
function named(n: number) {
  const root = makeBrain();
  for (let i = 1; i <= n; i++) writeFileSync(join(root, "people", `held-${i}.md`), `---\nid: people/held-${i}\ntype: person\ntitle: Person ${i}\narea: personal\nsensitivity: personal\nstatus: active\ncreated: 2026-10-28\nupdated: 2026-10-28\nby: steward\nfacts:\n  prefers: { value: "tea", as_of: 2026-10-28, sources: ["gmail:f00000000000003${i}"], verification: verified-by-source, by: steward, recorded: 2026-10-28, unseen: true, sender: known }\n---\n`);
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=steward", "-c", "user.email=s@x", "commit", "-qm", "steward: held"], { cwd: root });
  return root;
}

test("held values are no card on the home's face; one quiet line counts them and the full list names each (G907)", () => {
  const root = named(5);
  const v = homeView(root, loadRules(root), loadBrain(root), NOW);
  expect(v.waiting).toEqual([]);
  expect(v.held).toBe("5 private things are held from your assistants.");
  const all = homeView(root, loadRules(root), loadBrain(root), NOW, { all: true });
  const held = all.waiting.filter((w) => /only you can see/.test(w.verb));
  expect(held.map((w) => [w.what, w.n])).toEqual([1, 2, 3, 4, 5].map((i) => [`Something new about Person ${i}.`, 0]));
  expect(held.map((w) => w.seen)).toEqual([1, 2, 3, 4, 5].map((i) => `people/held-${i}#prefers`));
});

test("a stranger's held values are never in the quiet line's count: they are guesses under their own heading", () => {
  const root = named(4);
  for (let i = 1; i <= 3; i++) writeFileSync(join(root, "money", `apple-payment-${i}.md`), `---\nid: money/apple-payment-${i}\ntype: money\ntitle: Apple Services payment\narea: personal\nsensitivity: private\nstatus: active\ncreated: 2026-10-28\nupdated: 2026-10-28\nby: steward\nfacts:\n  amount: { value: "4.99", as_of: 2026-10-28, sources: ["gmail:f00000000000002${i}"], verification: verified-by-source, by: steward, recorded: 2026-10-28, unseen: true, sender: unknown }\n---\n`);
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=steward", "-c", "user.email=s@x", "commit", "-qm", "steward: receipts"], { cwd: root });
  const v = homeView(root, loadRules(root), loadBrain(root), NOW);
  expect(v.waiting).toEqual([]);
  expect(v.held).toBe("4 private things are held from your assistants.");
  const all = homeView(root, loadRules(root), loadBrain(root), NOW, { all: true }).waiting;
  // The stranger's three are guesses (G883): one uncounted card of their own.
  expect(all.filter((w) => w.verb === "not confirmed").map((w) => [w.what, w.n, w.seen!.split("\n").length])).toEqual([["Not confirmed: 3 things only you can see.", 0, 3]]);
  // Each named row releases one value.
  expect(all.filter((w) => /only you can see/.test(w.verb)).map((w) => w.seen!.split("\n").length)).toEqual([1, 1, 1, 1]);
});

test("the home's face releases nothing: its line only links to the full list, where each value has its own Read it (PR #6 review)", async () => {
  const root = named(5);
  process.env.PB_NOW = NOW.toISOString();
  try {
    const H = "127.0.0.1:8798";
    const d = dashboardHandler(root, { port: 8798, loginKey: "k".repeat(32) });
    const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const keysOf = (html: string) => [...html.matchAll(/action="\/action\/diary-seen"><input type="hidden" name="csrf" value="[^"]*"><input type="hidden" name="key" value="([^"]+)"/g)].map((m) => m[1]!);
    const html = await (await d.handle(new Request(`http://${H}/home`, { headers: { host: H, cookie } }))).text();
    expect(keysOf(html)).toEqual([]);
    expect(html).toContain('<a class="late" role="status" href="/home?all=1">5 private things are held from your assistants.</a>');
    const all = await (await d.handle(new Request(`http://${H}/home?all=1`, { headers: { host: H, cookie } }))).text();
    const keys = keysOf(all);
    expect(keys).toHaveLength(5);
    for (const k of keys) expect(k.split("\n")).toHaveLength(1);
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("receipts from strangers are one card that names none of them (owner's phone, 2026-10-31, G568)", () => {
  const root = receipts(5);
  // Guesses since G883: nothing on the home's face, one uncounted card on the full list.
  expect(homeView(root, loadRules(root), loadBrain(root), NOW).waiting).toEqual([]);
  const v = homeView(root, loadRules(root), loadBrain(root), NOW, { all: true });
  expect(v.waiting.map((w) => w.what)).toEqual(["Not confirmed: 5 things only you can see."]);
  expect(v.waiting[0]!.seen!.split("\n")).toHaveLength(5);
});

test("one held value keeps its own row and Show", () => {
  const root = receipts(1);
  const v = homeView(root, loadRules(root), loadBrain(root), NOW, { all: true });
  expect(v.waiting).toHaveLength(1);
  expect(v.waiting[0]!.seen).toBe("money/apple-payment-1#amount");
  expect(v.waiting[0]!.what).toBe("Not confirmed: something only you can see.");
});

test("each held value has one Read it on the full list: its card, never its memory too (Mac, 2026-10-31, G550)", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    const H = "127.0.0.1:8797";
    const d = dashboardHandler(root, { port: 8797, loginKey: "k".repeat(32) });
    const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const keysOf = (html: string) => [...html.matchAll(/action="\/action\/diary-seen"><input type="hidden" name="csrf" value="[^"]*"><input type="hidden" name="key" value="([^"]+)"/g)].map((m) => m[1]);
    // None on the face (G907); on the full list, one each.
    expect(keysOf(await (await d.handle(new Request(`http://${H}/home`, { headers: { host: H, cookie } }))).text())).toEqual([]);
    const keys = keysOf(await (await d.handle(new Request(`http://${H}/home?all=1`, { headers: { host: H, cookie } }))).text());
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
    // Its memory further down keeps the lock, naming only its page.
    const v = homeView(root, loadRules(root), loadBrain(root), new Date(DEMO_NOW), { all: true });
    const line = [...v.since, ...v.earlier.flatMap((x) => x.lines)].find((l) => l.held)!;
    expect(line.what).toBe("Something new about Hélène.");
    const card = memoryCard(line, "c");
    expect(card).toContain(APP_COPY.onlyYou);
    expect(card).not.toContain("diary-seen");
  } finally { delete process.env.PB_NOW; }
}, 60_000);

// Audit v9 (2026-10-31; G585): held cards still named "Visa statement" and "Manulife claim" from a
// known sender on an ordinary page: G568 hid a page name for a stranger's mail or a money page, and
// the shape check missed statements, claims and card brands. The name is withheld by its shape.
test("a held card never names a page shaped like a statement or a claim, whoever sent it (G585)", () => {
  const root = makeBrain();
  const titles = ["Visa statement", "Manulife claim", "Desjardins relevé", "Mastercard alert", "Sun Life réclamation"];
  titles.forEach((title, i) => { const slug = `held-shape-${i}`; writeFileSync(join(root, "projects", `${slug}.md`), `---\nid: projects/${slug}\ntype: project\ntitle: ${title}\narea: personal\nsensitivity: personal\nstatus: active\ncreated: 2026-10-28\nupdated: 2026-10-28\nby: steward\nfacts:\n  next_step: { value: "read it", as_of: 2026-10-28, sources: ["gmail:f00000000000004${i}"], verification: verified-by-source, by: steward, recorded: 2026-10-28, unseen: true, sender: known }\n---\n`); });
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=steward", "-c", "user.email=s@x", "commit", "-qm", "steward: held"], { cwd: root });
  const v = homeView(root, loadRules(root), loadBrain(root), NOW, { all: true });
  const said = JSON.stringify(v.waiting);
  expect(v.waiting.length).toBeGreaterThan(0);
  for (const t of titles) expect([t, said.includes(t)]).toEqual([t, false]);
  // A plain name from a known sender still says its page (the first test above).
});
