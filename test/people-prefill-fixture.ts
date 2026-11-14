// SPDX-License-Identifier: AGPL-3.0-only
// The demo brain with a made-up address book read by the hub (the owner's card names a manager
// and an assistant), people with role words and no structure, a mail that claims to be the
// manager, and a class the owner said he teaches. For test/people-prefill.test.ts and pictures.
import { expect } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeDemoBrain } from "./fixture";
import { loadBrain } from "../src/brain";
import { pullSource } from "../src/pull";
import { runAuto } from "../src/filing";
import { write } from "../src/write";
import { git } from "../src/git";

const NOW = new Date("2026-10-08T14:00:00Z");
const card = (uid: string, name: string, extra = "") => `BEGIN:VCARD\nVERSION:3.0\nUID:${uid}\nFN:${name}\nN:${name.split(" ")[1]};${name.split(" ")[0]};;;\n${extra}REV:2026-09-15T12:00:00Z\nEND:VCARD\n`;
const VCF = card("robin-me", "Robin Lefebvre", "EMAIL;type=INTERNET:robin@example.org\nitem1.X-ABRELATEDNAMES:Dana Okafor\nitem1.X-ABLabel:_$!<Manager>!$_\nitem2.X-ABRELATEDNAMES:Milo Hart\nitem2.X-ABLabel:_$!<Assistant>!$_\n")
  + card("dana", "Dana Okafor", "EMAIL;type=INTERNET:dana.okafor@example.org\n")
  + card("milo", "Milo Hart", "EMAIL;type=INTERNET:milo.hart@example.org\n")
  + card("zed", "Zed Far", "TEL;type=CELL:+1 514 555 0188\n");

const head = (id: string, type: string, title: string, by = "planner") => `---\nid: ${id}\ntype: ${type}\ntitle: "${title}"\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: ${by}\n`;
const fact = (value: string, src: string, o = "verification: verified-by-source, by: planner") => `{ value: "${value}", as_of: 2026-10-05, sources: ["${src}"], ${o}, recorded: 2026-10-05 }`;
const OWNED = "verification: confirmed-by-owner, by: owner";
const commit = (root: string, m: string) => { git(root, ["add", "-A"]); git(root, ["commit", "-qm", m]); };
const page = (root: string, id: string, text: string) => { mkdirSync(join(root, id.split("/")[0]!), { recursive: true }); writeFileSync(join(root, `${id}.md`), text); };

// `resolver`: an assistant named as the brain's resolver before the address book is read, so the
// cards file as that assistant (the capture agent) and its own writes carry the same `by`.
export async function prefillBrain(o: { resolver?: string } = {}): Promise<string> {
  const root = (await makeDemoBrain()).root;
  writeFileSync(join(root, "contacts.vcf"), VCF);
  // Zed has a page before the address book is read: a card with no relation on the owner's card.
  page(root, "people/zed-far", `${head("people/zed-far", "person", "Zed Far")}facts:\n  emails: ${fact("zed@elsewhere.example", "gmail:f0000000000000e9")}\n---\n`);
  const file = join(root, "rules", "sources.yaml");
  const doc = YAML.parse(readFileSync(file, "utf8"));
  doc.consent = "2026-09-01 demo brain, a made-up mailbox and contacts";
  doc.sources.contacts = { kind: "contacts", path: join(root, "contacts.vcf") };
  writeFileSync(file, YAML.stringify(doc));
  writeFileSync(join(root, "rules", "standing.yaml"), YAML.stringify({ me: ["robin@example.org"], people: {} }));
  if (o.resolver) { const pf = join(root, "rules", "policy.yaml"); writeFileSync(pf, readFileSync(pf, "utf8") + `\nresolver: ${o.resolver}\n`); }
  commit(root, "owner: contacts source");
  expect((await pullSource(root, "contacts", { model: null })).refused).toBeUndefined();
  for (let i = 0; i < 3; i++) runAuto(root, NOW);
  const me = loadBrain(root).find((n) => n.fm.title === "Robin Lefebvre")!.fm.id;
  // People with role words and no structure, a mail that claims to be the manager, and a class.
  page(root, "people/sol-vega", `${head("people/sol-vega", "person", "Sol Vega, student")}facts:\n  role: ${fact("student of Robin, calls Robin boss", "gmail:f0000000000000a1")}\n---\nA student. Robin's manager.\n`);
  page(root, "people/ike-moss", `${head("people/ike-moss", "person", "Ike Moss")}facts:\n  relationship: ${fact("Robin's manager", "gmail:f0000000000000a2")}\n---\n`);
  page(root, "projects/prod-20410", `${head("projects/prod-20410", "project", "PROD 20410", "owner")}facts:\n  org: ${fact("North College", "owner:2026-10-05/teach-prod-20410", OWNED).replace('sources: ["owner:2026-10-05/teach-prod-20410"]', 'sources: ["owner:2026-10-05/teach-prod-20410", "gmail:f0000000000000d1", "gmail:f0000000000000d2"]')}\n---\n`);
  for (const [name, mail] of [["Ana Diaz", "d1"], ["Ben Roy", "d2"], ["Cara Lee", "d1"]] as const)
    page(root, `people/${name.toLowerCase().replace(" ", "-")}`, `${head(`people/${name.toLowerCase().replace(" ", "-")}`, "person", name)}facts:\n  emails: ${fact(`${name.split(" ")[0]!.toLowerCase()}@northcollege.example`, `gmail:f0000000000000${mail}`)}\n---\n`);
  commit(root, "planner: people and a class");
  const r = write(root, { agent: "owner", id: me, attribute: "teaches", value: "[[projects/prod-20410]]", as_of: "2026-10-05", sources: ["owner:2026-10-05/teach-prod-20410"], verification: "confirmed-by-owner" } as never, { owner: true });
  expect(r.outcome).toBe("committed");
  return root;
}
