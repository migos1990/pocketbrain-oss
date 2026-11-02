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

test("the big number counts every thing that waits, the same number waitingCount gives", () => {
  const root = named(7);
  const v = homeView(root, loadRules(root), loadBrain(root), NOW);
  const html = homePage(v, "c");
  expect(waitingCount(root, NOW)).toBe(7);
  expect(big(html)).toBe(7);
});

test("held values sit under a heading that says what they are and what Show it does", () => {
  const root = named(5);
  const html = homePage(homeView(root, loadRules(root), loadBrain(root), NOW), "c");
  expect(html).toContain(`<h2 class="group">${APP_COPY.heldHead} <b>5</b></h2>`);
  expect(html).toContain(APP_COPY.heldHint);
  expect(html).toContain(`>${APP_COPY.showIt}</button>`);
  expect(html).not.toContain(">Read it<");
  // The card that counts the rest says they are more of the same.
  expect(html).toContain("3 more held from your assistants.");
  expect(html).not.toContain("only you can see.");
});

test("what was just done reads as done, not as a card that asks", () => {
  const root = named(1);
  const html = homePage(homeView(root, loadRules(root), loadBrain(root), NOW), "c", { flash: "Person 1 prefers tea. Your assistants get it now.", done: true });
  expect(html).toMatch(/<p class="done" role="status">/);
  expect(html).not.toContain('<p class="bubble" role="status">Person 1');
});
