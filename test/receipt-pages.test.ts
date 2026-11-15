// SPDX-License-Identifier: AGPL-3.0-only
// The owner's phone, 2026-10-29: receipts (Apple order, Apple Services payment) had become money
// pages held for the owner's Show, before G506 stopped no-reply mail being read. The owner left it
// to us ("i trust u") and upkeep set them aside by a word in the title (G511). The title decides
// nothing now (G862), and without it the rule is the machine-mail rule (G668), which waits for the
// owner's switch: so there is one step, off until `pocketbrain machine-mail on`, and until then a
// held page stays behind Show whatever it is called and whoever sent its mail.
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain, saveNote, today, type FactRecord } from "../src/brain";
import { appendDiary, diaryRow, shownValue } from "../src/diary";
import { commitPaths } from "../src/git";
import { clock, ownerDay } from "../src/clock";
import { loadRules } from "../src/rules";
import { upkeep } from "../src/upkeep";
import { readDiary } from "../src/diary";
import { undoFact } from "../src/undo";
import { unseenFacts } from "../src/seen";
import { machineFacts, setAsideBefore } from "../src/receipt-pages";
import { recordMachineMail, machineMail } from "../src/louis";
import { setMachineMailAside } from "../src/ownerset";

const page = (root: string, slug: string, title: string, fact: string) => writeFileSync(join(root, "money", `${slug}.md`), `---\nid: money/${slug}\ntype: money\ntitle: ${title}\narea: personal\nsensitivity: private\nstatus: active\ncreated: 2026-10-28\nupdated: 2026-10-28\nby: steward\nfacts:\n  ${fact}\n---\n`);
const held = (v: string, n: number, extra = "unseen: true, sender: unknown") => `amount: { value: "${v}", as_of: 2026-10-28, sources: ["gmail:f00000000000003${n}"], verification: verified-by-source, by: steward, recorded: 2026-10-28, ${extra} }`;

function brain() {
  const root = makeBrain();
  page(root, "apple-order-mtflmn7mfq", "Apple order MTFLMN7MFQ", held("12.99", 1));
  page(root, "apple-services-payment", "Apple Services payment", held("4.99", 2));
  page(root, "apple-services-payment-order-mm9qw597z1a0", "Apple Services payment (Order MM9QW597Z1a0)", held("4.99", 3));
  page(root, "gift-for-sam", "Gift for Sam", held("40", 4));
  page(root, "phone-plan-invoice", "Phone plan invoice", held("55", 5, "sender: unknown"));
  // G862: what the page is called decides nothing. A landlord's own mail about a bill is no receipt;
  // a shop's machine mail is one whatever its page is called.
  page(root, "billing-dispute-with-landlord", "Billing dispute with landlord", held("300", 7));
  page(root, "riverside-co-op", "Riverside Co-op", held("18.20", 8));
  // The hub saw these were machine-sent (a no-reply address, bulk headers).
  recordMachineMail(root, [1, 2, 3, 5, 8].map((n) => `gmail:f00000000000003${n}`));
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=steward", "-c", "user.email=s@x", "commit", "-qm", "steward: held"], { cwd: root });
  return root;
}

const HELD = ["money/apple-order-mtflmn7mfq", "money/apple-services-payment", "money/apple-services-payment-order-mm9qw597z1a0", "money/billing-dispute-with-landlord", "money/gift-for-sam", "money/riverside-co-op"];
const KEPT = ["money/billing-dispute-with-landlord", "money/gift-for-sam"];

// The reviewer's finding on the first cut of G862: with the title words gone, the always-on step
// reached every page the owner's machine-mail switch governs, with the switch off.
test("with the owner's switch off nothing is set aside, whatever a page is called: upkeep only counts (G862)", () => {
  const root = brain();
  const r = upkeep(root, { run: "reflect-receipts-off" });
  expect(unseenFacts(root).map((u) => u.page).sort()).toEqual(HELD);
  expect(readDiary(root).filter((x) => x.why === "receipt" || x.why === "machine")).toHaveLength(0);
  expect(r.findings.find((f) => f.rule === "machine-mail")?.detail).toContain("4 held facts on 4 pages came only from machine mail");
});

test("with the switch on, pages held from machine mail are set aside by their sender, never their title (G862)", async () => {
  const root = brain();
  expect(machineFacts(loadBrain(root), machineMail(root)).map((f) => f.id).sort()).toEqual(HELD.filter((id) => !KEPT.includes(id)));
  // No mail the hub saw was machine-sent: nothing is set aside.
  expect(machineFacts(loadBrain(root), new Set())).toEqual([]);
  setMachineMailAside(root, "on");
  upkeep(root);
  // A landlord's own mail titled "Billing dispute" stays; a shop's machine mail goes under any name.
  expect(unseenFacts(root).map((u) => u.page).sort()).toEqual(KEPT);
  expect(readDiary(root).filter((r) => r.why === "receipt")).toHaveLength(0);
  const rows = readDiary(root).filter((r) => r.why === "machine");
  expect(rows).toHaveLength(4);
  expect(rows.every((r) => r.kind === "retracted")).toBe(true);
  expect(Bun.spawnSync(["git", "log", "-1", "--format=%an%x00%B", "--grep=^Kind: machine-mail"], { cwd: root }).stdout.toString()).toMatch(/^hub\0[\s\S]*^Why: \S/m);
  const { homeView } = await import("../src/dashboard/home");
  const { loadRules } = await import("../src/rules");
  const v = homeView(root, loadRules(root), loadBrain(root), new Date(), { all: true });
  // A money page's name stays off the home (re-audit, G573).
  expect(v.since.map((l) => l.what).join(" ")).not.toMatch(/Apple|Riverside/);
  expect(v.waiting.map((w) => w.what).join(" ")).not.toMatch(/Apple|Riverside/);
  // Once: a second upkeep finds nothing.
  upkeep(root);
  expect(readDiary(root).filter((r) => r.why === "machine")).toHaveLength(4);
});

// G537 held for the old step only: the machine-mail step set an undone fact aside again the next
// night (G867). One memory of what was set aside, for both.
test("Undo brings a set-aside fact back held as it was, and it is never set aside again (G537, G867)", () => {
  const root = brain();
  setMachineMailAside(root, "on");
  upkeep(root);
  const row = readDiary(root).find((r) => r.why === "machine" && r.fact_key === "money/apple-order-mtflmn7mfq#amount")!;
  expect(undoFact(root, row.undo_token).outcome).toBe("undone");
  upkeep(root);
  upkeep(root);
  expect(readDiary(root).filter((r) => r.why === "machine")).toHaveLength(4);
  expect(unseenFacts(root).map((u) => u.page).sort()).toEqual(["money/apple-order-mtflmn7mfq", ...KEPT]);
});

// A page the old always-on step set aside (a diary line with why "receipt", the fact in history):
// its Undo still brings the fact back held, and the one step that remains leaves the page alone.
test("an old receipt line still undoes, and its page is never set aside again", () => {
  const root = brain();
  const n = loadBrain(root).find((x) => x.fm.id === "money/riverside-co-op")!;
  const rec = n.fm.facts!.amount as FactRecord;
  (n.fm.history ??= {}).amount = [{ ...rec, valid_to: today(), ended_by: { step: 0, at: today(), by: "hub" } }];
  delete n.fm.facts!.amount;
  saveNote(root, n);
  const rules = loadRules(root);
  const rel = appendDiary(root, { ...diaryRow({ at: clock().toISOString(), factKey: "money/riverside-co-op#amount", title: "Riverside Co-op", kind: "retracted", from: shownValue(rec), to: undefined, incoming: rec, acceptedBy: "hub", rank: 9, sensitivity: "private" }), why: "receipt" }, ownerDay(rules, clock()).slice(0, 7));
  commitPaths(root, [n.path, rel], "hub: set aside 1 receipt page\n\nKind: receipts", "hub");
  const row = readDiary(root).find((r) => r.why === "receipt")!;
  expect(setAsideBefore([row]).has("money/riverside-co-op")).toBe(true);
  expect(undoFact(root, row.undo_token).outcome).toBe("undone");
  expect((loadBrain(root).find((x) => x.fm.id === "money/riverside-co-op")!.fm.facts!.amount as FactRecord).unseen).toBe(true);
  setMachineMailAside(root, "on");
  upkeep(root);
  upkeep(root);
  expect(unseenFacts(root).map((u) => u.page).sort()).toEqual([...KEPT, "money/riverside-co-op"]);
  expect(readDiary(root).filter((r) => r.why === "machine")).toHaveLength(3);
});

// Audit v6 (2026-10-30): the old rule read the page's title, so a person named Bill Harper, held
// from a sender the brain doesn't know, was set aside as a receipt. Mail the hub did not see as a
// machine's stays, whatever its page is called, and so does a fact that cites no mail. (A person
// page's fact from machine mail is set aside under the switch like any other; its page stays.)
test("mail from a person on a page named like a receipt, and a fact that cites no mail, stay", () => {
  const root = brain();
  writeFileSync(join(root, "people", "bill-harper.md"), `---\nid: people/bill-harper\ntype: person\ntitle: Bill Harper\narea: personal\nsensitivity: private\nstatus: active\ncreated: 2026-10-28\nupdated: 2026-10-28\nby: steward\nfacts:\n  ${held("Room 4", 6).replace("amount:", "office:")}\n---\n`);
  page(root, "bill-payment-by-text", "Bill payment", `amount: { value: "9", as_of: 2026-10-28, sources: ["agent:steward"], verification: self-reported, by: steward, recorded: 2026-10-28, unseen: true, sender: unknown }`);
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=steward", "-c", "user.email=s@x", "commit", "-qm", "steward: held"], { cwd: root });
  setMachineMailAside(root, "on");
  upkeep(root);
  expect(unseenFacts(root).map((u) => u.page).sort()).toEqual(["money/bill-payment-by-text", ...KEPT, "people/bill-harper"]);
});

// Real-brain north star after 0.2.0 (2026-10-30): the set-aside receipt pages counted as pages
// touched that day, each failing pages_ok. A page with nothing left has nothing to write a page
// from: it isn't counted.
test("a page whose facts were all set aside isn't counted in the north star's pages", async () => {
  const { measure } = await import("../scripts/north-star");
  // A person page is kept when its last fact is set aside (the money pages go with theirs), so it
  // is the one that pins "emptied isn't counted" (G520).
  const withPerson = () => {
    const root = brain();
    writeFileSync(join(root, "people", "pat-quill.md"), `---\nid: people/pat-quill\ntype: person\ntitle: Pat Quill\narea: personal\nsensitivity: private\nstatus: active\ncreated: 2026-10-28\nupdated: 2026-10-28\nby: steward\nfacts:\n  ${held("Room 4", 9).replace("amount:", "office:")}\n---\n`);
    recordMachineMail(root, ["gmail:f000000000000039"]);
    Bun.spawnSync(["git", "add", "-A"], { cwd: root });
    Bun.spawnSync(["git", "-c", "user.name=steward", "-c", "user.email=s@x", "commit", "-qm", "steward: held"], { cwd: root });
    return root;
  };
  const root = withPerson();
  setMachineMailAside(root, "on");
  upkeep(root);
  const kept = loadBrain(root).find((n) => n.fm.id === "people/pat-quill")!;
  expect(Object.keys(kept.fm.facts ?? {})).toHaveLength(0);
  const now = new Date();
  const m = measure(root, new Date(now.getTime() - 86_400_000).toISOString(), now);
  const before = measure(withPerson(), new Date(now.getTime() - 86_400_000).toISOString(), now);
  expect(m.pages).toBe(before.pages - 5); // 4 money pages gone with their facts, 1 person page emptied
});
