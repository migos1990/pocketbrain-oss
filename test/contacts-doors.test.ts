// SPDX-License-Identifier: AGPL-3.0-only
// Audit v8 (2026-10-31), read side of the contacts source (G562): a card-filed email and phone,
// read back through every agent door (MCP, the API, the view, the relay) before and after the
// owner taps Show. Before Show no agent gets them, not even one whose grant reaches private. After
// Show only an agent whose grant reaches private gets them; a personal-ceiling grant still doesn't,
// the relay still holds a message carrying them to that agent, and who_is matches the address for
// nobody (a card never makes an address trusted).
import { test, expect, beforeAll } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeDemoBrain } from "./fixture";
import { loadBrain, type FactRecord } from "../src/brain";
import { records, carve, grantFor } from "../src/carve";
import { loadRules } from "../src/rules";
import { renderView } from "../src/view";
import { pullSource } from "../src/pull";
import { runAuto } from "../src/filing";
import { markSeen } from "../src/seen";
import { checkBetween, loadRelayConfig } from "../src/relay";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { git } from "../src/git";

const NOW = new Date("2026-10-08T14:00:00Z");
const HELENE = "people/helene-lefebvre";
const PHONE = ["+15145550101", "514 555 0101", "5145550101", "555 0101", "5550101"];
const NEW_EMAIL = "maman.lefebvre@example.net";
const EMAIL = [NEW_EMAIL];
const leaks = (s: string, needles: string[]) => needles.filter((x) => s.includes(x));

let root: string;
let tokens: Record<string, string>;
beforeAll(async () => {
  ({ root } = await makeDemoBrain());
  // Hélène's page already holds one address, the owner's word; the card adds a second one.
  const vcf = readFileSync(join(import.meta.dir, "fixtures", "robin-contacts.vcf"), "utf8");
  writeFileSync(join(root, "contacts.vcf"), vcf.replace("EMAIL;type=INTERNET:helene.lefebvre@example.org\n", `EMAIL;type=INTERNET:helene.lefebvre@example.org\nEMAIL;type=INTERNET:${NEW_EMAIL}\n`));
  const file = join(root, "rules", "sources.yaml");
  const doc = YAML.parse(readFileSync(file, "utf8"));
  doc.consent = "2026-09-01 demo brain, a made-up mailbox and contacts";
  doc.sources.contacts = { kind: "contacts", path: join(root, "contacts.vcf") };
  writeFileSync(file, YAML.stringify(doc));
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "owner: contacts source"]);
  const r = await pullSource(root, "contacts", { model: null });
  expect(r.refused).toBeUndefined();
  for (let i = 0; i < 3; i++) runAuto(root, NOW);
  tokens = { claude: issueToken(root, "claude"), chatgpt: issueToken(root, "chatgpt"), gemini: issueToken(root, "gemini") };
}, 180_000);

const live = (attr: string): FactRecord[] => {
  const n = loadBrain(root).find((x) => x.fm.id === HELENE);
  return n?.fm.facts?.[attr] ? records(n.fm.facts[attr]).filter((r) => !r.valid_to && !r.retired) : [];
};

async function mcp(agent: string, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await handle(root, new Request("http://pb/mcp", { method: "POST", headers: { authorization: `Bearer ${tokens[agent]}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }));
  return await res.text();
}
async function api(agent: string, path: string): Promise<string> {
  const res = await handle(root, new Request(`http://pb${path}`, { headers: { authorization: `Bearer ${tokens[agent]}` } }));
  return await res.text();
}

// Everything an agent can get through each door, as text, keyed by door.
async function doors(agent: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  out["mcp read"] = await mcp(agent, "read", { id: HELENE });
  for (const q of ["Hélène", "514 555", "example.org", "phones", "emails"]) {
    out[`mcp search ${q}`] = await mcp(agent, "search", { query: q });
    out[`mcp context_pack ${q}`] = await mcp(agent, "context_pack", { topic: q });
  }
  out["mcp whats_new"] = await mcp(agent, "whats_new", {});
  out["api note"] = await api(agent, `/v1/notes/${HELENE}`);
  out["api context"] = await api(agent, `/v1/context?topic=${encodeURIComponent("Hélène Lefebvre")}`);
  const rules = loadRules(root), notes = loadBrain(root);
  out["view"] = renderView(notes, rules, carve(notes, rules, grantFor(rules, agent)), root);
  return out;
}
async function leaked(agent: string): Promise<string[]> {
  const out: string[] = [];
  for (const [door, text] of Object.entries(await doors(agent))) for (const x of leaks(text, [...PHONE, ...EMAIL])) out.push(`${door}: ${x}`);
  return out;
}
// The relay's own checks, the same for mail and `relay --check` (src/relay.ts checkBetween), without
// the hook's alert bookkeeping, so one held message doesn't hold the sender's next ones here.
const relay = (from: string, to: string, text: string) => checkBetween(loadBrain(root), loadRules(root), loadRelayConfig(root), "t", from, to, text);
const whoMatches = async (agent: string, address: string) => (await mcp(agent, "who_is", { address })).includes(HELENE);

const cite = (r: FactRecord) => (r.sources ?? []).map((s) => String(typeof s === "string" ? s : s.ref));

test("the card filed Hélène's new email and phone private and unseen, citing the card; the owner's address is untouched", () => {
  const owners = live("emails").filter((r) => r.value === "helene.lefebvre@example.org");
  expect(owners).toHaveLength(1);
  expect(owners[0]!.by).toBe("owner");
  expect(owners[0]!.unseen).toBeUndefined();
  for (const attr of ["phones", "emails"]) {
    const recs = live(attr).filter((r) => r.value !== "helene.lefebvre@example.org");
    expect(recs).toHaveLength(1);
    expect(recs[0]!.sensitivity).toBe("private");
    expect(recs[0]!.unseen).toBe(true);
    expect(cite(recs[0]!)).toEqual([expect.stringMatching(/^contacts:vcard\//)]);
  }
});

test("before Show: no door gives any agent the card's email or phone, and who_is matches neither", async () => {
  for (const agent of ["claude", "chatgpt", "gemini"]) {
    expect({ agent, leaked: await leaked(agent) }).toEqual({ agent, leaked: [] });
    expect(await whoMatches(agent, NEW_EMAIL)).toBe(false);
    expect(await whoMatches(agent, "+15145550101")).toBe(false);
  }
  // A message carrying the phone to any agent is held: the value is hidden from each of them.
  for (const to of ["claude", "chatgpt", "gemini"]) {
    const from = to === "claude" ? "chatgpt" : "claude";
    for (const [text, attr] of [["Hélène's cell is +15145550101", "phones"], [`write to her at ${NEW_EMAIL}`, "emails"]] as const) {
      const v = relay(from, to, text);
      expect(v.deliver).toBe(false);
      expect(v.reasons.join(" ")).toContain(`which ${to} can't see (${HELENE}#${attr})`);
    }
  }
}, 120_000);

test("after Show: agents whose grant reaches private get them; a personal-ceiling grant still gets nothing", async () => {
  expect(markSeen(root, `${HELENE}#phones`).outcome).toBe("seen");
  expect(markSeen(root, `${HELENE}#emails`).outcome).toBe("seen");
  expect(live("phones")[0]!.unseen).toBeUndefined();
  expect(live("phones")[0]!.sensitivity).toBe("private");
  // claude (core, all) and chatgpt (core, area:personal among its slices) reach private on
  // Hélène's personal-area page; gemini is a trial agent, personal at most.
  const rules = loadRules(root);
  expect([grantFor(rules, "claude").ceiling, grantFor(rules, "chatgpt").ceiling, grantFor(rules, "gemini").ceiling]).toEqual(["private", "private", "personal"]);
  for (const agent of ["claude", "chatgpt"]) {
    const c = await doors(agent);
    expect(leaks(c["mcp read"]!, PHONE).length).toBeGreaterThan(0);
    expect(leaks(c["mcp read"]!, EMAIL)).toEqual(EMAIL);
    expect(leaks(c["api note"]!, EMAIL)).toEqual(EMAIL);
    expect(leaks(c["view"]!, PHONE).length).toBeGreaterThan(0);
    // Seen is not trusted: a card's address names nobody to who_is (src/standing.ts addressesIn
    // reads trusted records only).
    expect(await whoMatches(agent, NEW_EMAIL)).toBe(false);
    expect(await whoMatches(agent, "+15145550101")).toBe(false);
    // The relay delivers it now; it held it before Show.
    const v = relay("gemini", agent, `Hélène's cell is +15145550101, mail ${NEW_EMAIL}`);
    expect(v.reasons).toEqual([]);
    expect(v.deliver).toBe(true);
  }
  // gemini: still nothing through any door, and the relay still holds both to it.
  expect(await leaked("gemini")).toEqual([]);
  expect(await whoMatches("gemini", NEW_EMAIL)).toBe(false);
  expect(await whoMatches("gemini", "+15145550101")).toBe(false);
  for (const [text, attr] of [["Hélène's cell is +15145550101", "phones"], [`mail her at ${NEW_EMAIL}`, "emails"]] as const)
    expect(relay("claude", "gemini", text).reasons.join(" ")).toContain(`which gemini can't see (${HELENE}#${attr})`);
}, 120_000);
