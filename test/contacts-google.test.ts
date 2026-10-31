// SPDX-License-Identifier: AGPL-3.0-only
// Google Contacts as a live source (G546) against a fake People API: its own read-only scope, the
// sync token after the first listing, an expired token listing again, a deleted card turning its
// facts due, and a token carrying more than contacts.readonly refused. Nothing reaches Google.
import { test, expect, afterAll, beforeEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, type FactRecord } from "../src/brain";
import { records } from "../src/carve";
import { pullSource } from "../src/pull";
import { runAuto } from "../src/filing";
import { useHttp, fetchContacts, CONTACTS_SCOPE, tokenKey } from "../src/google";
import { git } from "../src/git";

afterAll(() => useHttp((u, i) => fetch(u, i)));

let scope = CONTACTS_SCOPE;
let calls: string[] = [];
let cards: Record<string, Record<string, unknown>> = {};
let next: { token: string; items: string[]; deleted?: string[] } | "expired" | undefined;
const card = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ resourceName: `people/${id}`, etag: `%Eg${id}/v1+`, names: [{ displayName: name }], metadata: { sources: [{ updateTime: "2026-09-01T00:00:00Z" }] }, ...extra });

beforeEach(() => {
  scope = CONTACTS_SCOPE; calls = []; cards = {}; next = undefined;
  process.env.GOOGLE_CLIENT_ID = "id"; process.env.GOOGLE_CLIENT_SECRET = "secret";
  process.env[tokenKey("primary", "contacts")] = `ct-${Math.random()}`;
  useHttp(async (url) => {
    const u = new URL(url);
    calls.push(`${u.pathname}${u.searchParams.get("syncToken") ? ` sync=${u.searchParams.get("syncToken")}` : ""}`);
    if (u.host === "oauth2.googleapis.com") return Response.json({ access_token: "at", expires_in: 3600, scope });
    if (u.pathname === "/v1/people/me/connections") {
      const s = u.searchParams.get("syncToken");
      if (s) {
        if (next === "expired") return new Response(JSON.stringify({ error: { status: "FAILED_PRECONDITION" } }), { status: 400 });
        const n = next!;
        return Response.json({ connections: [...n.items.map((i) => cards[i]), ...(n.deleted ?? []).map((i) => ({ resourceName: `people/${i}`, metadata: { deleted: true } }))], nextSyncToken: n.token });
      }
      return Response.json({ connections: Object.values(cards), nextSyncToken: "s1" });
    }
    return new Response("", { status: 404 });
  });
});

function brain(consent = "2026-09-01 mail, calendar and contacts") {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ consent, sources: { contacts: { kind: "contacts", account: "primary" } } }));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "owner: contacts"]);
  return root;
}
const person = (root: string) => loadBrain(root).filter((n) => n.fm.type === "person");

test("the first pass lists every card, then the sync token reads only what changed; a deleted card turns its facts due", async () => {
  const root = brain();
  const someone = person(root)[0]!;
  cards.a = card("a", String(someone.fm.title), { nicknames: [{ value: "Zed" }] });
  cards.b = card("b", "Nobody The Brain Knows", { phoneNumbers: [{ value: "+1 514 555 0111" }] });
  const r1 = await pullSource(root, "contacts", { model: null });
  expect(r1.refused).toBeUndefined();
  expect(r1.stored).toHaveLength(1);
  runAuto(root, new Date());
  const aliases = records(loadBrain(root).find((n) => n.fm.id === someone.fm.id)!.fm.facts!.aliases) as FactRecord[];
  expect(aliases.map((r) => r.value)).toEqual(["Zed"]);
  // The etag's "/" and "+" never reach a ref.
  expect(String(aliases[0]!.sources[0])).toBe("contacts:people/a@_Ega_v1_");
  expect(person(root).some((n) => n.fm.title === "Nobody The Brain Knows")).toBe(false);

  next = { token: "s2", items: [], deleted: ["a"] };
  const r2 = await pullSource(root, "contacts", { model: null });
  expect(calls.filter((c) => c.includes("connections")).at(-1)).toBe("/v1/people/me/connections sync=s1");
  expect(r2.due).toHaveLength(1);
  const after = records(loadBrain(root).find((n) => n.fm.id === someone.fm.id)!.fm.facts!.aliases) as FactRecord[];
  expect(after[0]!.recheck?.why).toBe("source gone");
});

test("an expired sync token lists the address book again; cards already read are skipped", async () => {
  const root = brain();
  cards.a = card("a", String(person(root)[0]!.fm.title), { nicknames: [{ value: "Zed" }] });
  await pullSource(root, "contacts", { model: null });
  next = "expired";
  const r = await pullSource(root, "contacts", { model: null });
  expect(r.refused).toBeUndefined();
  expect(r.stored).toEqual([]);
  expect(calls.filter((c) => c.includes("connections")).slice(-2)).toEqual(["/v1/people/me/connections sync=s1", "/v1/people/me/connections"]);
});

test("a token carrying more than contacts.readonly is refused, and so is a consent line that doesn't name contacts", async () => {
  scope = `${CONTACTS_SCOPE} https://www.googleapis.com/auth/contacts`;
  await expect(fetchContacts({ kind: "contacts", account: "primary" })).rejects.toThrow(/more than read-only/);
  scope = CONTACTS_SCOPE;
  const r = await pullSource(brain("2026-09-01 mail and calendar"), "contacts", { model: null });
  expect(r.refused).toMatch(/doesn't name Contacts/);
});

test("a model reading mail never files a nickname or, where checks.yaml doesn't declare it, a relationship: only a card's line does", async () => {
  const { makeModel } = await import("../src/model");
  const root = makeBrain();
  const who = String(person(root)[0]!.fm.title);
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { mail: { kind: "gmail", fixture: "m.json" } } }));
  writeFileSync(join(root, "m.json"), JSON.stringify([{ id: "m1", labelIds: ["INBOX"], internalDate: "1791000000000", payload: { headers: [{ name: "Subject", value: "Hi" }] }, text: `Everyone calls ${who} Zed these days, and ${who} is my cousin now.` }]));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "owner: mail"]);
  const declared = !!loadBrain(root) && (await import("../src/rules")).loadRules(root).checks.types?.person?.attributes?.relationship;
  const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: () => JSON.stringify({ facts: [
    { entity: who, type: "person", attribute: "aliases", value: "Zed", quote: `calls ${who} Zed` },
    { entity: who, type: "person", attribute: "relationship", value: "my cousin", quote: `${who} is my cousin` },
  ] }) });
  await pullSource(root, "mail", { model });
  runAuto(root, new Date());
  const p = loadBrain(root).find((n) => n.fm.title === who)!;
  expect(p.fm.facts?.aliases).toBeUndefined();
  if (!declared) expect(JSON.stringify(p.fm.facts?.relationship ?? "")).not.toContain("my cousin");
});
