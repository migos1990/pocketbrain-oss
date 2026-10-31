// SPDX-License-Identifier: AGPL-3.0-only
// The owner's phone, 2026-10-29: receipts (Apple order, Apple Services payment) had become money
// pages held for the owner's Show, before G506 stopped no-reply mail being read. The owner left it
// to us ("i trust u"): upkeep sets those aside once, a diary line each with Undo. Only a page whose
// title reads like a receipt and whose every live fact is still held from an unknown sender; any
// other held page stays behind Show.
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain } from "../src/brain";
import { upkeep } from "../src/upkeep";
import { readDiary } from "../src/diary";
import { undoFact } from "../src/undo";
import { unseenFacts } from "../src/seen";
import { receiptPages } from "../src/receipt-pages";

const page = (root: string, slug: string, title: string, fact: string) => writeFileSync(join(root, "money", `${slug}.md`), `---\nid: money/${slug}\ntype: money\ntitle: ${title}\narea: personal\nsensitivity: private\nstatus: active\ncreated: 2026-10-28\nupdated: 2026-10-28\nby: steward\nfacts:\n  ${fact}\n---\n`);
const held = (v: string, n: number, extra = "unseen: true, sender: unknown") => `amount: { value: "${v}", as_of: 2026-10-28, sources: ["gmail:f00000000000003${n}"], verification: verified-by-source, by: steward, recorded: 2026-10-28, ${extra} }`;

function brain() {
  const root = makeBrain();
  page(root, "apple-order-mtflmn7mfq", "Apple order MTFLMN7MFQ", held("12.99", 1));
  page(root, "apple-services-payment", "Apple Services payment", held("4.99", 2));
  page(root, "apple-services-payment-order-mm9qw597z1a0", "Apple Services payment (Order MM9QW597Z1a0)", held("4.99", 3));
  page(root, "gift-for-sam", "Gift for Sam", held("40", 4));
  page(root, "phone-plan-invoice", "Phone plan invoice", held("55", 5, "sender: unknown"));
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=steward", "-c", "user.email=s@x", "commit", "-qm", "steward: held"], { cwd: root });
  return root;
}

test("only receipt-titled pages held from an unknown sender are set aside", async () => {
  const root = brain();
  expect(receiptPages(loadBrain(root)).sort()).toEqual(["money/apple-order-mtflmn7mfq", "money/apple-services-payment", "money/apple-services-payment-order-mm9qw597z1a0"]);
  upkeep(root);
  expect(unseenFacts(root).map((u) => u.page)).toEqual(["money/gift-for-sam"]);
  const rows = readDiary(root).filter((r) => r.why === "receipt");
  expect(rows).toHaveLength(3);
  expect(rows.every((r) => r.kind === "retracted")).toBe(true);
  expect(Bun.spawnSync(["git", "log", "-1", "--format=%an%x00%B", "--grep=^Kind: receipts"], { cwd: root }).stdout.toString()).toMatch(/^hub\0[\s\S]*^Why: \S/m);
  const { homeView } = await import("../src/dashboard/home");
  const { loadRules } = await import("../src/rules");
  const v = homeView(root, loadRules(root), loadBrain(root), new Date(), { all: true });
  // A money page's name stays off the home: the line says a receipt was set aside (re-audit, G573).
  expect(v.since.map((l) => l.what)).toContain("A receipt was set aside; receipts aren't facts.");
  expect(v.since.map((l) => l.what).join(" ")).not.toMatch(/Apple/);
  expect(v.waiting.map((w) => w.what).join(" ")).not.toMatch(/Apple/);
  // Once: a second upkeep finds nothing.
  upkeep(root);
  expect(readDiary(root).filter((r) => r.why === "receipt")).toHaveLength(3);
});

test("Undo brings a receipt back, held as it was", () => {
  const root = brain();
  upkeep(root);
  const row = readDiary(root).find((r) => r.why === "receipt" && r.fact_key === "money/apple-order-mtflmn7mfq#amount")!;
  expect(undoFact(root, row.undo_token).outcome).toBe("undone");
  expect(unseenFacts(root).map((u) => u.page).sort()).toEqual(["money/apple-order-mtflmn7mfq", "money/gift-for-sam"]);
});

// Real-brain north star after 0.2.0 (2026-10-30): the set-aside receipt pages counted as pages
// touched that day, each failing pages_ok. A page with no live fact left has nothing to write a
// page from: it isn't counted.
test("a page whose facts were all set aside isn't counted in the north star's pages", async () => {
  const { measure } = await import("../scripts/north-star");
  const root = brain();
  upkeep(root);
  const now = new Date();
  const m = measure(root, new Date(now.getTime() - 86_400_000).toISOString(), now);
  const before = measure(brain(), new Date(now.getTime() - 86_400_000).toISOString(), now);
  expect(m.pages).toBe(before.pages - 3); // the 3 set-aside receipt pages
});

// Audit v6 (2026-10-30): the rule read the page's title, so a person named Bill Harper, held from
// a sender the brain doesn't know, was set aside as a receipt, and again on every upkeep after
// Undo. A receipt is a money page whose every live fact came from mail; never a person's page,
// whatever its name, and a page set aside once is never set aside again (G537).
test("a person named like a receipt is never set aside, and Undo holds for good", () => {
  const root = brain();
  writeFileSync(join(root, "people", "bill-harper.md"), `---\nid: people/bill-harper\ntype: person\ntitle: Bill Harper\narea: personal\nsensitivity: private\nstatus: active\ncreated: 2026-10-28\nupdated: 2026-10-28\nby: steward\nfacts:\n  ${held("Room 4", 6).replace("amount:", "office:")}\n---\n`);
  page(root, "bill-payment-by-text", "Bill payment", `amount: { value: "9", as_of: 2026-10-28, sources: ["agent:steward"], verification: self-reported, by: steward, recorded: 2026-10-28, unseen: true, sender: unknown }`);
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=steward", "-c", "user.email=s@x", "commit", "-qm", "steward: held"], { cwd: root });
  const ids = receiptPages(loadBrain(root));
  expect(ids).not.toContain("people/bill-harper");
  expect(ids).not.toContain("money/bill-payment-by-text"); // not from mail
  upkeep(root);
  const row = readDiary(root).find((r) => r.why === "receipt" && r.fact_key === "money/apple-order-mtflmn7mfq#amount")!;
  expect(undoFact(root, row.undo_token).outcome).toBe("undone");
  upkeep(root);
  upkeep(root);
  expect(readDiary(root).filter((r) => r.why === "receipt")).toHaveLength(3);
  expect(unseenFacts(root).map((u) => u.page).sort()).toEqual(["money/apple-order-mtflmn7mfq", "money/bill-payment-by-text", "money/gift-for-sam", "people/bill-harper"]);
});
