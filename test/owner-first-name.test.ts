// SPDX-License-Identifier: AGPL-3.0-only
// A shop's mail greets its customer by first name and names itself (owner's phone, 2026-11-16: a
// page for "a" person with the owner's first name, "works at" the shop and "customer of" it).
// G976: the owner's first name alone is never a new page and never lands a fact on any page: on the
// owner's own mail it is most likely the owner, and a namesake can't be told apart, so it's a guess.
// G977: the organisation that sent an item is never, from that item alone, the workplace or the
// "how you know" of anyone but the sender. Invented names and an invented shop; temp brains removed.
import { test, expect, afterAll } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain } from "../src/brain";
import { loadRules } from "../src/rules";
import { checkCandidate } from "../src/capture";
import { makeModel, type ModelRequest } from "../src/model";
import { pullSource } from "../src/pull";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } });
const OWNER_PAGE = `---\nid: people/robin-lake\ntype: person\ntitle: Robin Lake\narea: personal\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: owner\nfacts: {}\n---\n`;
const brain = (owner = "{ name: Robin Lake }", page = true) => {
  const root = makeBrain(); roots.push(root);
  const p = join(root, "rules", "policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace("owner: { name: Robin }", `owner: ${owner}`));
  if (page) writeFileSync(join(root, "people", "robin-lake.md"), OWNER_PAGE);
  return root;
};
const ctx = (root: string) => ({ notes: loadBrain(root), rules: loadRules(root) });
const SHOP = "Bramblewood Electronics <hello@shop.bramblewood.example>";
const TEXT = "Hi Robin, your pickup order from Bramblewood Electronics is ready. Thanks for being a customer of Bramblewood Electronics.";
const cand = (entity: string, attribute: string, value: string, quote = TEXT) => ({ entity, type: "person", attribute, value, quote }) as never;

test("G976: the owner's first name alone starts no page", () => {
  const root = brain();
  const { notes, rules } = ctx(root);
  const r = checkCandidate(cand("Robin", "org", "Bramblewood Electronics"), TEXT, notes, rules);
  expect(r.status).not.toBe("new-note");
  expect(r.target).toBeUndefined();
  expect(r.why).toMatch(/your own first name/);
});

test("G976: the same with a one-word owner name, and with no page of the owner's yet", () => {
  for (const [owner, page] of [["{ name: Robin }", false], ["{ name: Robin Lake }", false], ["{ name: 'Robin Lake, M.Sc.' }", true]] as const) {
    const root = brain(owner, page);
    const { notes, rules } = ctx(root);
    const r = checkCandidate(cand("Robin", "relationship", "customer of Bramblewood Electronics"), TEXT, notes, rules);
    expect([owner, r.status]).toEqual([owner, "unsupported"]);
  }
});

test("G976: a page already titled with the owner's first name alone gets nothing more", () => {
  const root = brain();
  writeFileSync(join(root, "people", "robin.md"), OWNER_PAGE.replace("people/robin-lake", "people/robin").replace("title: Robin Lake", "title: Robin").replace("by: owner", "by: hub"));
  const { notes, rules } = ctx(root);
  const r = checkCandidate(cand("Robin", "org", "Bramblewood Electronics"), TEXT, notes, rules);
  expect(r.status).toBe("unsupported");
  expect(r.target).toBeUndefined();
});

test("G976: another first name, and the owner's full name, still file as before", () => {
  const root = brain();
  const { notes, rules } = ctx(root);
  const t = "Kim joined Tallgrass Studio last week.";
  expect(checkCandidate(cand("Kim", "org", "Tallgrass Studio", t), t, notes, rules).status).toBe("new-note");
  const full = "Robin Lake joined Tallgrass Studio last week.";
  expect(checkCandidate(cand("Robin Lake", "org", "Tallgrass Studio", full), full, notes, rules).target).toBe("people/robin-lake");
  // A namesake with a surname is someone else's page, as before.
  const other = "Robin Fox joined Tallgrass Studio last week.";
  expect(checkCandidate(cand("Robin Fox", "org", "Tallgrass Studio", other), other, notes, rules).status).toBe("new-note");
});

test("G977: the shop that sent the mail is not the workplace or the 'how you know' of whom it writes to", () => {
  const root = brain();
  const { notes, rules } = ctx(root);
  const text = "Robin Lake, your pickup order from Bramblewood Electronics is ready, thanks for being a customer. Kim Osei at Bramblewood Electronics packed it.";
  for (const [entity, attr, value] of [["Robin Lake", "org", "Bramblewood Electronics"], ["Robin Lake", "relationship", "customer of Bramblewood Electronics"], ["Kim Osei", "org", "Bramblewood Electronics"], ["Robin Lake", "role", "customer at Bramblewood"]] as const) {
    const r = checkCandidate(cand(entity, attr, value, text), text, notes, rules, "", { sender: SHOP });
    expect([entity, attr, r.status]).toEqual([entity, attr, "unsupported"]);
    expect(r.why).toMatch(/sent/);
  }
  // Named only by its mail domain: the same.
  const r = checkCandidate(cand("Robin Lake", "org", "Bramblewood", text), text, notes, rules, "", { sender: "Orders <orders@bramblewood.example>" });
  expect(r.status).toBe("unsupported");
  // Facts that don't tie anyone to the sender still file.
  const t2 = "Robin Lake, your pickup at Bramblewood Electronics is on 2026-11-20. Kim Osei now works at Tallgrass Studio.";
  expect(checkCandidate(cand("Kim Osei", "org", "Tallgrass Studio", t2), t2, notes, rules, "", { sender: SHOP }).status).toBe("new-note");
});

test("G977: the sender's own workplace from their own mail still files", () => {
  const root = brain();
  const { notes, rules } = ctx(root);
  const text = "Hello, this is Kim Osei from Bramblewood Electronics. I lead the repair desk now.";
  const r = checkCandidate(cand("Kim Osei", "org", "Bramblewood Electronics", text), text, notes, rules, "", { sender: "Kim Osei <kim@bramblewood.example>" });
  expect(r.status).toBe("new-note");
});

// End to end: a shop's mail that none of the machine-mail signs catch (a plain sender address, no
// list headers) reaches the model, and nothing about "Robin" or the shop's tie is filed.
test("G976, G977: a pulled shop mail files no page for the owner's first name and no tie to the shop", async () => {
  const root = brain();
  const MAIL = [{ id: "b7c8d9e0f1a2b3c4", labelIds: ["INBOX"], internalDate: "1791000000000", payload: { headers: [{ name: "Subject", value: "Your order is ready" }, { name: "From", value: SHOP }, { name: "To", value: "Robin <robin@home.example>" }] }, text: TEXT }];
  writeFileSync(join(root, "f.json"), JSON.stringify(MAIL));
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { mail: { kind: "gmail", where: ["INBOX"], fixture: "f.json" } } }));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: sources");
  const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: (_r: ModelRequest) => JSON.stringify({ facts: [
    { entity: "Robin", type: "person", attribute: "org", value: "Bramblewood Electronics", quote: "your pickup order from Bramblewood Electronics is ready" },
    { entity: "Robin", type: "person", attribute: "relationship", value: "customer of Bramblewood Electronics", quote: "Thanks for being a customer of Bramblewood Electronics" },
    { entity: "Robin Lake", type: "person", attribute: "org", value: "Bramblewood Electronics", quote: "your pickup order from Bramblewood Electronics is ready" },
  ] }) });
  await pullSource(root, "mail", { model });
  const props = existsSync(join(root, "inbox")) ? readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml")) : [];
  expect(props).toEqual([]);
  const notes = loadBrain(root);
  expect(notes.filter((n) => n.fm.type === "person" && n.fm.title === "Robin")).toEqual([]);
  expect(notes.find((n) => n.fm.id === "people/robin-lake")!.fm.facts).toEqual({});
});
