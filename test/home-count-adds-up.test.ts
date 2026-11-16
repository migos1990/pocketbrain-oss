// SPDX-License-Identifier: AGPL-3.0-only
// The owner's phone, 2026-11-01 (G625): "3 things wait for you" over a done notice, two Read it cards
// and "9 new things only you can see": the owner couldn't tell which three, or what to do. The big
// number counts each thing that waits (the number waitingCount gives the digest and the north star),
// each kind sits under a heading that says what to do, and a done notice is not a card.
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { homeView, waitingCount } from "../src/dashboard/home";
import { loadRules } from "../src/rules";
import { loadBrain } from "../src/brain";
import { homePage, APP_COPY } from "../src/dashboard/html-app";

const NOW = new Date("2026-10-29T23:00:00Z");
function named(n: number) {
  const root = makeBrain();
  for (let i = 1; i <= n; i++) writeFileSync(join(root, "people", `held-${i}.md`), `---\nid: people/held-${i}\ntype: person\ntitle: Person ${i}\narea: personal\nsensitivity: personal\nstatus: active\ncreated: 2026-10-28\nupdated: 2026-10-28\nby: steward\nfacts:\n  prefers: { value: "tea", as_of: 2026-10-28, sources: ["gmail:f00000000000003${i}"], verification: verified-by-source, by: steward, recorded: 2026-10-28, unseen: true, sender: known }\n---\n`);
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=steward", "-c", "user.email=s@x", "commit", "-qm", "steward: held"], { cwd: root });
  return root;
}
const big = (html: string) => Number(/<p class="count"><b>(\d+)<\/b>/.exec(html)?.[1] ?? 0);

test("the big number counts only what waits: held values are in neither it nor waitingCount (G907)", () => {
  const root = named(7);
  const v = homeView(root, loadRules(root), loadBrain(root), NOW);
  const html = homePage(v, "c");
  expect(waitingCount(root, NOW)).toBe(0);
  expect(big(html)).toBe(0);
  expect(html).toContain("7 private things are held from your assistants.");
});

test("on the full list held values sit under a heading that says what they are and what to do, with no number; an older sign-in offers Read it (G630, G907)", () => {
  const root = named(5);
  const face = homePage(homeView(root, loadRules(root), loadBrain(root), NOW), "c");
  expect(face).not.toContain(APP_COPY.heldHead);
  const html = homePage(homeView(root, loadRules(root), loadBrain(root), NOW, { all: true }), "c");
  expect(html).toContain(`<h2 class="group">${APP_COPY.heldHead}</h2>`);
  expect(html).toContain(APP_COPY.heldHint);
  expect(html.split(`>${APP_COPY.readIt}</button>`).length - 1).toBe(5);
  expect(html).not.toContain(`>${APP_COPY.letThem}<`);
});

test("what was just done reads as done, not as a card that asks", () => {
  const root = named(1);
  const html = homePage(homeView(root, loadRules(root), loadBrain(root), NOW), "c", { flash: "Person 1 prefers tea. Your assistants get it now.", done: true });
  expect(html).toMatch(/class="done" role="status">/);
  expect(html).not.toContain('<p class="bubble" role="status">Person 1');
});
