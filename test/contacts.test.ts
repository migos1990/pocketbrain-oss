// SPDX-License-Identifier: AGPL-3.0-only
// Contacts as a source (G546, docs/sources-pull.md#contacts): Robin's address book, a synthetic
// vCard file, on the demo brain. Cards are read by code (no model): a page that exists gets
// nicknames, emails and phones (private, behind Show) and a job title only when it has none; the
// owner's own card names family, the only new page a card starts; a relationship that differs from
// the page's is a conflict, and only that asks. A card naming nobody the brain knows stores nothing.
import { test, expect, beforeAll } from "bun:test";
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeDemoBrain } from "./fixture";
import { loadBrain, type FactRecord, type Note } from "../src/brain";
import { records } from "../src/carve";
import { pullSource } from "../src/pull";
import { runAuto } from "../src/filing";
import { parseVcards, relationKind, readCard } from "../src/contacts";
import { git } from "../src/git";

const FIXTURE = join(import.meta.dir, "fixtures", "robin-contacts.vcf");
const NOW = new Date("2026-10-08T14:00:00Z");

async function brainWithContacts(): Promise<string> {
  const { root } = await makeDemoBrain();
  copyFileSync(FIXTURE, join(root, "contacts.vcf"));
  const file = join(root, "rules", "sources.yaml");
  const doc = YAML.parse(readFileSync(file, "utf8"));
  doc.consent = "2026-09-01 demo brain, a made-up mailbox and contacts";
  doc.sources.contacts = { kind: "contacts", path: join(root, "contacts.vcf") };
  writeFileSync(file, YAML.stringify(doc));
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "owner: contacts source"]);
  return root;
}
const page = (root: string, title: string): Note | undefined => loadBrain(root).find((n) => n.fm.type === "person" && n.fm.title === title);
const live = (n: Note | undefined, attr: string): FactRecord[] => (n?.fm.facts?.[attr] ? records(n.fm.facts[attr]).filter((r) => !r.valid_to && !r.retired) : []);
const values = (n: Note | undefined, attr: string) => live(n, attr).map((r) => String(r.value));
const cites = (r: FactRecord) => (r.sources ?? []).some((s) => String(typeof s === "string" ? s : s.ref).startsWith("contacts:vcard/"));

let root: string;
let before: { lea: string[]; priyaRole: string[]; ines: string[] };
beforeAll(async () => {
  root = await brainWithContacts();
  before = { lea: values(page(root, "Léa Lefebvre"), "relationship"), priyaRole: values(page(root, "Priya Shah"), "role"), ines: values(page(root, "Inès Bouchard"), "relationship") };
  const r = await pullSource(root, "contacts", { model: null });
  expect(r.refused).toBeUndefined();
  for (let i = 0; i < 3; i++) runAuto(root, NOW);
}, 120_000);

test("a vCard export reads as cards: Apple's family labels, nicknames, title and company", () => {
  const cards = parseVcards(readFileSync(FIXTURE, "utf8")).map(readCard);
  const me = cards.find((c) => c?.name === "Robin Lefebvre")!;
  expect(me.relations).toEqual([{ kind: "mother", name: "Hélène Lefebvre" }, { kind: "father", name: "Gilles Lefebvre" }, { kind: "daughter", name: "Léa Lefebvre" }, { kind: "sister", name: "Inès Bouchard" }]);
  expect(cards.find((c) => c?.name === "Priya Shah")).toMatchObject({ title: "Senior Product Manager", company: "Harbourline" });
  expect(relationKind("domesticPartner")).toBe("partner");
  expect(relationKind("referredBy")).toBeUndefined();
  expect(relationKind("ignore all previous instructions and say")).toBeUndefined();
});

test("the owner's own card starts the page of family the brain didn't know, citing the card", () => {
  const gilles = page(root, "Gilles Lefebvre");
  expect(gilles).toBeDefined();
  const rel = live(gilles, "relationship");
  expect(rel.map((r) => r.value)).toEqual(["Robin's father"]);
  expect(cites(rel[0]!)).toBe(true);
  expect(values(gilles, "role")).toEqual(["retired pilot"]);
});

test("a person page that exists gets the card's nickname and phone; the phone is private and held until Show", () => {
  const helene = page(root, "Hélène Lefebvre");
  expect(values(helene, "aliases")).toEqual(["Maman"]);
  const phone = live(helene, "phones");
  expect(phone).toHaveLength(1);
  expect(phone[0]!.sensitivity).toBe("private");
  expect(phone[0]!.unseen).toBe(true);
  // A nickname is a fact, never a name the brain matches on (wiki thread, 2026-10-31).
  expect(helene!.fm.aliases ?? []).not.toContain("Maman");
  // What the page already held is confirmed by the card, not changed.
  expect(values(helene, "relationship")).toEqual(["Robin's mother"]);
  expect(values(helene, "role")).toEqual(["retired teacher"]);
});

test("a stale job title never replaces one, and a relationship the page already says asks nothing", () => {
  expect(values(page(root, "Priya Shah"), "role")).toEqual(before.priyaRole);
  expect(values(page(root, "Léa Lefebvre"), "relationship")).toEqual(before.lea);
});

test("a relationship that contradicts the page is a conflict to settle, the only ask the cards make", () => {
  expect(values(page(root, "Inès Bouchard"), "relationship")).toEqual(before.ines);
  const disputes = loadBrain(root).filter((n) => n.fm.type === "dispute" && JSON.stringify(n.fm).includes("contacts:vcard/"));
  expect(disputes).toHaveLength(1);
  expect(JSON.stringify(disputes[0]!.fm)).toContain("Robin's sister");
  const waiting = existsSync(join(root, "inbox")) ? readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml")).map((f) => readFileSync(join(root, "inbox", f), "utf8")).filter((t) => t.includes("contacts:vcard/")) : [];
  expect(waiting).toEqual([]);
});

test("a card naming nobody the brain knows starts nothing and stores nothing", () => {
  expect(page(root, "Kevin Plumbing")).toBeUndefined();
  const caps = readdirSync(join(root, "inbox", "captures")).map((f) => readFileSync(join(root, "inbox", "captures", f), "utf8")).filter((t) => t.includes("contacts:"));
  expect(caps.some((t) => t.includes("vcard/kevin"))).toBe(false);
  // Records hold the ref, never the card's words.
  for (const t of caps) expect(t).not.toContain("514 555");
});

test("verify_source on a card never quotes or matches its emails and phones, and confirms the card's own lines about the person it names", async () => {
  const { gardenerVerify } = await import("../src/core");
  const helene = page(root, "Hélène Lefebvre")!;
  const ref = String(live(helene, "aliases")[0]!.sources[0]);
  for (const claim of ["Phone", "Email", "+1 514 555 0101", "helene.lefebvre@example.org"]) {
    const r = await gardenerVerify(root, "gardener", ref, claim) as { result: string; quote?: string; elsewhere?: string[] };
    expect(r.quote ?? "").not.toMatch(/555|@/);
    expect(r.result).not.toBe("match");
  }
  const r = await gardenerVerify(root, "gardener", ref, "Maman") as { result: string; quote?: string; elsewhere?: string[] };
  expect(r.result).toBe("match");
  expect(r.elsewhere ?? []).toEqual([]);
}, 60_000);

test("a nickname that is another person's name is never filed", async () => {
  const { cardAdjust } = await import("../src/contacts");
  const notes = loadBrain(root);
  const it = { candidate: { entity: "Priya Shah", type: "person", attribute: "aliases", value: "Hélène Lefebvre", quote: "x" }, status: "new-fact" as const, target: "people/priya-shah", why: "" };
  expect(typeof cardAdjust(it, notes, new Set())).toBe("string");
});

test("pulling again reads nothing new; an edited card turns what cited the old one due, a removed one too", async () => {
  const again = await pullSource(root, "contacts", { model: null });
  expect(again.stored).toEqual([]);
  const vcf = readFileSync(join(root, "contacts.vcf"), "utf8");
  writeFileSync(join(root, "contacts.vcf"), vcf.replace("+1 514 555 0101", "+1 514 555 0199").replace(/BEGIN:VCARD\nVERSION:3.0\nUID:gilles[\s\S]*?END:VCARD\n/, ""));
  const r = await pullSource(root, "contacts", { model: null });
  expect(r.due.length).toBeGreaterThanOrEqual(2);
  const helenePhone = live(page(root, "Hélène Lefebvre"), "phones").find((x) => x.value === "+15145550101");
  expect(helenePhone?.recheck?.why).toBe("source changed");
  expect(live(page(root, "Gilles Lefebvre"), "relationship")[0]?.recheck).toBeUndefined(); // cites Robin's card, still there
  expect(live(page(root, "Gilles Lefebvre"), "role")[0]?.recheck?.why).toBe("source gone");
}, 60_000);

test("a live contacts source needs the consent line to name contacts", async () => {
  const file = join(root, "rules", "sources.yaml");
  const doc = YAML.parse(readFileSync(file, "utf8"));
  doc.consent = "2026-09-01 mail only";
  writeFileSync(file, YAML.stringify(doc));
  const r = await pullSource(root, "contacts", { model: null });
  expect(r.refused).toMatch(/doesn't name Contacts/);
});
