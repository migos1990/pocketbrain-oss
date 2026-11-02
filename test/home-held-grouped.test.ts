// SPDX-License-Identifier: AGPL-3.0-only
// The owner's phone, 2026-10-29: "Waiting on you" opened on a wall of rows like "Apple Services
// payment: something new · from an address your pages don't hold · only you can see it yet",
// none of them a conflict. Since the owner app brief (2026-10-30) each held value is its own locked
// card naming only its page, with Read it, but at most HELD_EACH of them: the rest are one line, a
// tap away. Conflicts stay one row each.
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain, makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { homeView, HELD_EACH } from "../src/dashboard/home";
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

test("held values are a locked card each, a few of them, the rest one card that counts them (Mac, 2026-10-31)", () => {
  const root = named(5);
  const v = homeView(root, loadRules(root), loadBrain(root), NOW);
  const held = v.waiting.filter((w) => /only you can see/.test(w.verb));
  expect(HELD_EACH).toBe(3);
  expect(held).toHaveLength(HELD_EACH);
  for (const w of held.slice(0, -1)) expect(w.what).toMatch(/^Something new about Person \d\.$/);
  const last = held.at(-1)!;
  expect(last.what).toBe("3 more held from your assistants.");
  // It counts and links to the full list, and releases nothing (PR #6 review): no Read it.
  expect(last.seen).toBeUndefined();
  expect(last.href).toBe("/home?all=1");
  const all = homeView(root, loadRules(root), loadBrain(root), NOW, { all: true });
  expect(all.waiting.filter((w) => w.seen)).toHaveLength(5);
  // Exactly HELD_EACH: no card that counts.
  const three = named(3);
  expect(homeView(three, loadRules(three), loadBrain(three), NOW).waiting.map((w) => w.what)).toEqual(["Person 1", "Person 2", "Person 3"].map((t) => `Something new about ${t}.`));
});

test("a stranger's held values and named ones never make two counts: the card that counts takes the rest (Mac, 2026-10-31)", () => {
  const root = named(4);
  for (let i = 1; i <= 3; i++) writeFileSync(join(root, "money", `apple-payment-${i}.md`), `---\nid: money/apple-payment-${i}\ntype: money\ntitle: Apple Services payment\narea: personal\nsensitivity: private\nstatus: active\ncreated: 2026-10-28\nupdated: 2026-10-28\nby: steward\nfacts:\n  amount: { value: "4.99", as_of: 2026-10-28, sources: ["gmail:f00000000000002${i}"], verification: verified-by-source, by: steward, recorded: 2026-10-28, unseen: true, sender: unknown }\n---\n`);
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=steward", "-c", "user.email=s@x", "commit", "-qm", "steward: receipts"], { cwd: root });
  const v = homeView(root, loadRules(root), loadBrain(root), NOW);
  const held = v.waiting.filter((w) => /only you can see/.test(w.verb));
  expect(held).toHaveLength(HELD_EACH);
  const counted = held.filter((w) => /^\d+ /.test(w.what));
  expect(counted).toHaveLength(1);
  expect(held.at(-1)).toBe(counted[0]);
  const n = (w: { what: string }) => /^(\d+) /.exec(w.what) ? Number(/^(\d+) /.exec(w.what)![1]) : 1;
  expect(held.reduce((a, w) => a + n(w), 0)).toBe(7);
  // The two named cards release one value each; the card that counts releases nothing.
  expect(held.slice(0, -1).reduce((a, w) => a + w.seen!.split("\n").length, 0)).toBe(2);
  expect(held.at(-1)!.seen).toBeUndefined();
  expect(held.map((w) => w.what).join(" ")).not.toContain("more new private things");
});

test("the card that counts the rest links to them and has no Read it: one tap never lets out values from other pages (PR #6 review)", async () => {
  const root = named(5);
  process.env.PB_NOW = NOW.toISOString();
  try {
    const H = "127.0.0.1:8798";
    const d = dashboardHandler(root, { port: 8798, loginKey: "k".repeat(32) });
    const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const html = await (await d.handle(new Request(`http://${H}/home`, { headers: { host: H, cookie } }))).text();
    const keys = [...html.matchAll(/action="\/action\/diary-seen"><input type="hidden" name="csrf" value="[^"]*"><input type="hidden" name="key" value="([^"]+)"/g)].map((m) => m[1]!);
    expect(keys).toHaveLength(HELD_EACH - 1);
    for (const k of keys) expect(k.split("\n")).toHaveLength(1);
    const at = html.indexOf("3 more held from your assistants");
    const counting = html.slice(at, html.indexOf("</li>", at));
    expect(counting).toContain('href="/home?all=1"');
    expect(counting).not.toContain("diary-seen");
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("receipts from strangers are one card that names none of them (owner's phone, 2026-10-31, G568)", () => {
  const root = receipts(5);
  const v = homeView(root, loadRules(root), loadBrain(root), NOW);
  expect(v.waiting.map((w) => w.what)).toEqual(["5 new things only you can see."]);
  expect(v.waiting[0]!.seen!.split("\n")).toHaveLength(5);
});

test("one held value keeps its own row and Show", () => {
  const root = receipts(1);
  const v = homeView(root, loadRules(root), loadBrain(root), NOW);
  expect(v.waiting).toHaveLength(1);
  expect(v.waiting[0]!.seen).toBe("money/apple-payment-1#amount");
  expect(v.waiting[0]!.what).toBe("Something new only you can see.");
});

test("each held value has one Read it on the home: its card, never its memory too (Mac, 2026-10-31, G550)", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    const H = "127.0.0.1:8797";
    const d = dashboardHandler(root, { port: 8797, loginKey: "k".repeat(32) });
    const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const html = await (await d.handle(new Request(`http://${H}/home`, { headers: { host: H, cookie } }))).text();
    const keys = [...html.matchAll(/action="\/action\/diary-seen"><input type="hidden" name="csrf" value="[^"]*"><input type="hidden" name="key" value="([^"]+)"/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.length).toBeLessThanOrEqual(HELD_EACH);
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
