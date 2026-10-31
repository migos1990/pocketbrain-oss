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

function receipts(n: number) {
  const root = makeBrain();
  for (let i = 1; i <= n; i++) writeFileSync(join(root, "money", `apple-payment-${i}.md`), `---\nid: money/apple-payment-${i}\ntype: money\ntitle: Apple Services payment\narea: personal\nsensitivity: private\nstatus: active\ncreated: 2026-10-28\nupdated: 2026-10-28\nby: steward\nfacts:\n  amount: { value: "4.99", as_of: 2026-10-28, sources: ["gmail:f00000000000002${i}"], verification: verified-by-source, by: steward, recorded: 2026-10-28, unseen: true, sender: unknown }\n---\n`);
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=steward", "-c", "user.email=s@x", "commit", "-qm", "steward: receipts"], { cwd: root });
  return root;
}
const NOW = new Date("2026-10-29T23:00:00Z");

test("held values are a locked card each, a few of them, with the rest one tap away", () => {
  const root = receipts(5);
  const v = homeView(root, loadRules(root), loadBrain(root), NOW);
  const held = v.waiting.filter((w) => /only you can see/.test(w.verb));
  expect(HELD_EACH).toBe(3);
  expect(held.filter((w) => w.seen)).toHaveLength(3);
  for (const w of held.filter((w) => w.seen)) expect(w.what).toBe("Something new about Apple Services payment");
  const rest = held.filter((w) => !w.seen);
  expect(rest).toHaveLength(1);
  expect(rest[0]!.what).toBe("2 more new private things");
  expect(rest[0]!.href).toBe("/home?all=1");
  const all = homeView(root, loadRules(root), loadBrain(root), NOW, { all: true });
  expect(all.waiting.filter((w) => w.seen)).toHaveLength(5);
  // Exactly HELD_EACH: no "more" line.
  const three = receipts(3);
  expect(homeView(three, loadRules(three), loadBrain(three), NOW).waiting.filter((w) => w.seen)).toHaveLength(3);
  expect(homeView(three, loadRules(three), loadBrain(three), NOW).waiting.filter((w) => !w.seen)).toHaveLength(0);
});

test("one held value keeps its own row and Show", () => {
  const root = receipts(1);
  const v = homeView(root, loadRules(root), loadBrain(root), NOW);
  expect(v.waiting).toHaveLength(1);
  expect(v.waiting[0]!.seen).toBe("money/apple-payment-1#amount");
});

test("a held value's memory is locked with its own Read it, naming only its page", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    const v = homeView(root, loadRules(root), loadBrain(root), new Date(DEMO_NOW), { all: true });
    const line = [...v.since, ...v.earlier.flatMap((d) => d.lines)].find((l) => l.held)!;
    expect(line.what).toBe("Something new about Hélène Lefebvre");
    const html = memoryCard(line, "c");
    expect(html).toContain('action="/action/diary-seen"');
    expect(html).toContain(`name="key" value="${line.key}"`);
    expect(html).toContain(APP_COPY.readIt);
    expect(html).not.toMatch(/marks|Known by/);
  } finally { delete process.env.PB_NOW; }
}, 60_000);
