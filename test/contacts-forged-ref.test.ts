// SPDX-License-Identifier: AGPL-3.0-only
// Audit v8 (2026-10-31), write side of the contacts ref scheme (G564): an assistant forging or
// borrowing a `contacts:` ref with a verified label. The conflict order is the owner's word, then a
// verified source, then an exact one, then the newer: a card ref an assistant cites never outranks
// the owner's word, a made-up card ref changes nothing until checked, and a real card ref the hub
// read is the assistant's own word on its record, since no assistant reads the owner's address book.
import { test, expect, beforeAll } from "bun:test";
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeDemoBrain } from "./fixture";
import { loadBrain, isDisputed, type FactRecord } from "../src/brain";
import { records } from "../src/carve";
import { pullSource } from "../src/pull";
import { runAuto } from "../src/filing";
import { write } from "../src/write";
import { git } from "../src/git";

const NOW = new Date("2026-10-08T14:00:00Z");
// The demo brain with Robin's address book pulled and filed. `resolver`: claude named as the
// brain's resolver before the pull (so the cards file as claude, the capture agent) or after it.
async function cardBrain(resolver?: "before" | "after"): Promise<string> {
  const { root } = await makeDemoBrain();
  copyFileSync(join(import.meta.dir, "fixtures", "robin-contacts.vcf"), join(root, "contacts.vcf"));
  const file = join(root, "rules", "sources.yaml");
  const doc = YAML.parse(readFileSync(file, "utf8"));
  doc.consent = "2026-09-01 demo brain, a made-up mailbox and contacts";
  doc.sources.contacts = { kind: "contacts", path: join(root, "contacts.vcf") };
  writeFileSync(file, YAML.stringify(doc));
  const pf = join(root, "rules", "policy.yaml");
  const name = () => writeFileSync(pf, readFileSync(pf, "utf8") + "\nresolver: claude\n");
  if (resolver === "before") name();
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "owner: contacts source"]);
  expect((await pullSource(root, "contacts", { model: null })).refused).toBeUndefined();
  for (let i = 0; i < 3; i++) runAuto(root, NOW);
  if (resolver === "after") { name(); git(root, ["add", "-A"]); git(root, ["commit", "-qm", "owner: resolver"]); }
  return root;
}

let root: string;
beforeAll(async () => { root = await cardBrain(); }, 180_000);

const fact = (id: string, attr: string, at = root) => loadBrain(at).find((n) => n.fm.id === id)?.fm.facts?.[attr];
const liveOf = (id: string, attr: string): FactRecord | undefined => {
  const f = fact(id, attr);
  return f && !isDisputed(f) ? records(f).find((r) => !r.valid_to && !r.retired) : undefined;
};
const cardRef = (id: string, attr: string) => String(records(fact(id, attr)!)[0]!.sources[0]);
const forge = (agent: string, id: string, attribute: string, value: string, ref: string, verification = "verified-by-source") =>
  write(root, { agent, kind: "fact", id, attribute, value, as_of: "2026-10-08", sources: [ref], source_type: "document", verification, confidence: "stated" } as never);

test("a forged card ref with a verified label never outranks the owner's word: a made-up card waits, a real one is a conflict beside the owner's live value", () => {
  const H = "people/helene-lefebvre";
  const owner = liveOf(H, "relationship")!;
  expect(owner).toMatchObject({ value: "Robin's mother", by: "owner", verification: "confirmed-by-owner" });
  const real = cardRef(H, "aliases"); // Hélène's own card, read by the hub
  expect(real).toMatch(/^contacts:vcard\/helene@/);
  for (const ref of ["contacts:vcard/helene@forged0001", "contacts:people/c999", real]) {
    for (const agent of ["claude", "gemini"]) {
      const r = forge(agent, H, "relationship", "Robin's daughter", ref);
      expect(["inbox", "disputed"]).toContain(r.outcome);
      const now = liveOf(H, "relationship");
      expect(now).toMatchObject({ value: "Robin's mother", by: "owner", verification: "confirmed-by-owner" });
    }
  }
  // The same with the owner's label on a card ref: refused or left for the owner, and the hub's
  // filing tick never files it as the owner's word.
  expect(["inbox", "refused"]).toContain(forge("claude", H, "relationship", "Robin's aunt", real, "confirmed-by-owner").outcome);
  for (let i = 0; i < 3; i++) runAuto(root, NOW);
  expect(liveOf(H, "relationship")).toMatchObject({ value: "Robin's mother", by: "owner", verification: "confirmed-by-owner" });
});

test("borrowing the owner's real card ref, a core assistant can't replace what the card said: it is a conflict, never a newer verified update", () => {
  const G = "people/gilles-lefebvre";
  const card = liveOf(G, "relationship")!;
  expect(card).toMatchObject({ value: "Robin's father", by: "capture" });
  const robinCard = String(card.sources[0]);
  expect(robinCard).toMatch(/^contacts:vcard\/robin-me@/);
  const r = forge("claude", G, "relationship", "Robin's uncle", robinCard);
  expect(r.outcome).not.toBe("committed");
  const f = fact(G, "relationship")!;
  const vals = isDisputed(f) ? f.candidates.map((c) => c.value) : records(f).filter((x) => !x.valid_to && !x.retired).map((x) => x.value);
  expect(vals).toContain("Robin's father");
  // Neither the live value nor a history row says the card said "uncle" on the card's authority.
  for (const x of isDisputed(f) ? f.candidates : records(f)) if (x.value === "Robin's uncle") expect(x.by).toBe("claude");
  // A made-up card ref changes nothing until checked.
  const g2 = forge("claude", G, "role", "airline CEO", "contacts:vcard/gilles@deadbeef");
  expect(g2.outcome).toBe("inbox");
  expect(liveOf(G, "role")?.value).toBe("retired pilot");
});

// Slice audit of abb3479e: the first fix read "the hub's" as "written by the capture agent", and a
// brain whose resolver is an assistant files its cards as that assistant; naming one after the
// pull demoted the cards already filed. Either way the borrowed ref must not replace the card.
for (const when of ["before", "after"] as const) {
  test(`with claude named resolver ${when} the pull, borrowing the owner's card ref still can't replace what the card said`, async () => {
    const at = await cardBrain(when);
    // Filed as claude, the new page's id may carry a suffix (write.ts newId): found by its title.
    const G = loadBrain(at).find((n) => n.fm.type === "person" && n.fm.title === "Gilles Lefebvre")!.fm.id;
    const card = records(fact(G, "relationship", at)!).find((x) => !x.valid_to && !x.retired)!;
    expect(card.value).toBe("Robin's father");
    expect(card.by).toBe(when === "before" ? "claude" : "capture");
    const r = write(at, { agent: "claude", kind: "fact", id: G, attribute: "relationship", value: "Robin's uncle", as_of: "2026-10-08", sources: [String(card.sources[0])], source_type: "document", verification: "verified-by-source", confidence: "stated" } as never);
    expect(r.outcome).not.toBe("committed");
    const f = fact(G, "relationship", at)!;
    const live = isDisputed(f) ? f.candidates.map((c) => c.value) : records(f).filter((x) => !x.valid_to && !x.retired).map((x) => x.value);
    expect(live).toContain("Robin's father");
    if (!isDisputed(f)) expect(live).not.toContain("Robin's uncle");
  }, 180_000);
}

// Audit v9 (2026-10-31; G581): G564 demoted a borrowed card ref for ranking only, so the record the
// write stored still said verified-by-source and the sender check (sender.ts, sameperson.ts
// trustedAddresses) took the planted address as one the brain vouches for.
test("a borrowed card ref never makes an assistant's address a trusted sender", async () => {
  const { senderStanding } = await import("../src/sender");
  const H = "people/helene-lefebvre";
  const real = cardRef(H, "aliases");
  expect(senderStanding(root, "helene.lefebvre@example.org")).toBe("known");
  for (const agent of ["claude", "gemini"]) {
    const evil = `second-${agent}@evil.example`;
    expect(senderStanding(root, evil)).toBe("unknown");
    forge(agent, H, "emails", evil, real);
    for (let i = 0; i < 3; i++) runAuto(root, NOW);
    expect(senderStanding(root, evil)).toBe("unknown");
    const f = fact(H, "emails");
    for (const x of f && !isDisputed(f) ? records(f) : []) {
      if (JSON.stringify(x.value).includes(evil)) expect(x.verification).not.toBe("verified-by-source");
    }
  }
  // The card's own address stays known: the hub filed it.
  expect(senderStanding(root, "helene.lefebvre@example.org")).toBe("known");
});

test("a record saved before G581 that an assistant vouched with a card ref alone is not a trusted address", async () => {
  const { trustedAddresses } = await import("../src/sameperson");
  const { loadRules } = await import("../src/rules");
  const rules = loadRules(root);
  const H = loadBrain(root).find((n) => n.fm.id === "people/helene-lefebvre")!;
  const real = cardRef(H.fm.id, "aliases");
  const planted = (by: string) => ({ ...H, fm: { ...H.fm, facts: { emails: { items: [{ value: "old-plant@evil.example", as_of: "2026-10-01", sources: [real], verification: "verified-by-source", by }] } } } }) as never;
  expect([...trustedAddresses(planted("claude"), rules).keys()]).not.toContain("email:old-plant@evil.example");
  expect([...trustedAddresses(planted("capture"), rules).keys()]).toContain("email:old-plant@evil.example");
});
