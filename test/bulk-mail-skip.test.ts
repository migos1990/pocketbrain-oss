// SPDX-License-Identifier: AGPL-3.0-only
// The owner's phone, 2026-10-25: a social network's "congratulate <owner> for 6 years" notification
// became a card. Mail sent to a list (List-Unsubscribe, List-Id, Precedence bulk or list), mail a
// machine sent (Auto-Submitted), and Gmail's Promotions, Social and Forums tabs are never read for
// facts: marked seen, never sent to the model. `skip_bulk: false` on a source reads them again.
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { makeModel, type ModelRequest } from "../src/model";
import { pullSource } from "../src/pull";

const sent: string[] = [];
const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => { sent.push(r.prompt); return JSON.stringify({ facts: [] }); } });
const mail = (id: string, headers: Record<string, string>, labels = ["INBOX"]) => ({ id, labelIds: labels, internalDate: "1791000000000", payload: { headers: [{ name: "Subject", value: `Note ${id}` }, ...Object.entries(headers).map(([name, value]) => ({ name, value }))] }, text: `Hello, this is message ${id} with enough words to be read for facts today.` });
function brain(extra: Record<string, unknown> = {}) {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { mail: { kind: "gmail", fixture: "m.json", ...extra } } }));
  writeFileSync(join(root, "m.json"), JSON.stringify([
    mail("a000000000000001", { From: "Jane Roy <jane@school.example>" }),
    mail("a000000000000002", { From: "Network <notifications-noreply@social.example>", "List-Unsubscribe": "<https://social.example/u>" }),
    mail("a000000000000003", { From: "News <news@shop.example>", "List-Id": "<news.shop.example>" }),
    mail("a000000000000004", { From: "Bot <bot@x.example>", Precedence: "bulk" }),
    mail("a000000000000005", { From: "Robot <robot@x.example>", "Auto-Submitted": "auto-generated" }),
    mail("a000000000000006", { From: "Shop <hi@shop.example>" }, ["INBOX", "CATEGORY_PROMOTIONS"]),
  ]));
  return root;
}

test("list, bulk, machine-sent and Promotions/Social/Forums mail never reaches the model", async () => {
  sent.length = 0;
  const r = await pullSource(brain(), "mail", { model });
  expect(sent.length).toBe(1);
  expect(sent[0]).toContain("message a000000000000001");
  expect(r.skipped).toBeGreaterThanOrEqual(5);
});

test("skip_bulk: false reads them again", async () => {
  sent.length = 0;
  await pullSource(brain({ skip_bulk: false }), "mail", { model });
  expect(sent.length).toBe(6);
});

// The owner's phone, 2026-10-29: "Waiting on you" was a wall of Apple Services payment and Apple
// order rows. Receipts come from a no-reply address with none of the list headers above; a
// no-reply, receipts, orders, billing or notifications sender is a machine too.
test("receipts and other no-reply mail never reach the model", async () => {
  sent.length = 0;
  const root = makeBrain();
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { mail: { kind: "gmail", fixture: "m.json" } } }));
  writeFileSync(join(root, "m.json"), JSON.stringify([
    mail("b000000000000001", { From: "Apple <no_reply@email.apple.example>" }),
    mail("b000000000000002", { From: "Shop <do-not-reply@shop.example>" }),
    mail("b000000000000003", { From: "Orders <orders@store.example>" }),
    mail("b000000000000004", { From: "receipts@pay.example" }),
    mail("b000000000000005", { From: "Billing <billing+eu@cloud.example>" }, ["INBOX", "CATEGORY_UPDATES"]),
    mail("b000000000000006", { From: "Jane Roy <jane@school.example>" }),
  ]));
  const r = await pullSource(root, "mail", { model });
  expect(sent.length).toBe(1);
  expect(sent[0]).toContain("message b000000000000006");
  expect(r.skipped).toBeGreaterThanOrEqual(5);
});
