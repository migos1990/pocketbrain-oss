// SPDX-License-Identifier: AGPL-3.0-only
// A vendor's memory is prose (outside review, 2026-10-29): "prefers short answers", "likes email
// over calls". Imported, such a line keeps its words and its source as a person's `prefers` fact,
// a set, carved like any other fact. Before this, the extraction prompt offered only role, org,
// emails, phones and last_contact, and checkCandidate dropped anything else (G490).
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { makeModel, type ModelRequest } from "../src/model";
import { importMemory, readMemory } from "../src/memimport";
import { extractionPrompt } from "../src/capture";
import { loadRules } from "../src/rules";
import { loadBrain } from "../src/brain";
import { decideProposal } from "../src/write";
import { previewRead } from "../src/core";
import { renderTouchedPages } from "../src/wiki";

beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; });

// A claude.ai export's memories.json: the memory is one prose blob per account and per project.
const EXPORT = [{
  conversations_memory: "**Work context**\n\nJane Roy prefers email over phone calls.\n\nJane Roy likes agendas sent the day before.",
  project_memories: {},
  account_uuid: "3f2a9c1e-0b7d-4e55-9a10-2c6f8e4d1b23",
}];
const LINES = [
  { entity: "Jane Roy", type: "person", attribute: "prefers", value: "prefers email over phone calls", quote: "Jane Roy prefers email over phone calls" },
  { entity: "Jane Roy", type: "person", attribute: "prefers", value: "likes agendas sent the day before", quote: "Jane Roy likes agendas sent the day before" },
  // A paraphrase is not the line's own words: it never lands.
  { entity: "Jane Roy", type: "person", attribute: "prefers", value: "dislikes being phoned", quote: "Jane Roy prefers email over phone calls" },
];
const model = () => makeModel({ provider: "fake", model: "fake-1" }, { fake: (_r: ModelRequest) => JSON.stringify({ facts: LINES }) });
const inbox = (root: string) => readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml")).sort();

function exportDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pb-claudeai-"));
  writeFileSync(join(dir, "memories.json"), JSON.stringify(EXPORT));
  return dir;
}

test("G490: the extraction prompt offers prefers for a person even when checks.yaml doesn't declare it", () => {
  const root = makeBrain();
  const p = extractionPrompt("Jane Roy prefers email over phone calls.", loadRules(root), loadBrain(root), "personal");
  expect(p).toMatch(/- person: [^\n]*\bprefers\b/);
  expect(p).toContain("in the text's own words");
});

test("G490: a claude.ai memory line keeps its words and its source as a prefers fact, a set on the person's page", async () => {
  const root = makeBrain();
  // An id is not a memory line.
  expect(readMemory([exportDir()])[0].text).not.toContain("3f2a9c1e");
  const [r] = await importMemory(root, "planner", [exportDir()], model());
  expect(r.result.items.map((i) => i.status)).toEqual(["new-fact", "new-fact", "ungrounded"]);
  const files = inbox(root);
  expect(files).toHaveLength(2);
  const reqs = files.map((f) => YAML.parse(readFileSync(join(root, "inbox", f), "utf8")).request);
  expect(reqs.map((q) => q.value).sort()).toEqual(["likes agendas sent the day before", "prefers email over phone calls"]);
  for (const q of reqs) expect(q).toMatchObject({ agent: "planner", id: "people/jane-roy", attribute: "prefers", source_type: "agent_observation" });
  expect(reqs.every((q) => /^doc:capture\//.test(q.sources[0]))).toBe(true);
  // Accepting both keeps both: a second preference adds an item, it never replaces or contests the first.
  for (const f of files) expect(decideProposal(root, `inbox/${f}`, "accept").outcome).toBe("committed");
  const jane = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
  const f = jane.fm.facts!.prefers as { items: { value: string }[] };
  expect(f.items.map((i) => i.value).sort()).toEqual(["likes agendas sent the day before", "prefers email over phone calls"]);
});

test("G490: a preference is carved like any fact: a slice limited to org and role never sees it", async () => {
  const root = makeBrain();
  await importMemory(root, "planner", [exportDir()], model());
  for (const f of inbox(root)) decideProposal(root, `inbox/${f}`, "accept");
  // An assistant that reads people only through contacts-basic (org and role).
  const pol = join(root, "rules", "policy.yaml");
  writeFileSync(pol, readFileSync(pol, "utf8").replace("tiers:", "  contacts: { tier: trial, slices: [contacts-basic] }\ntiers:"));
  const see = (agent: string) => JSON.stringify(previewRead(root, agent, "people/jane-roy"));
  expect(see("steward")).toContain("prefers email over phone calls");
  const c = see("contacts");
  expect(c).toContain("Course coordinator");
  expect(c).not.toContain("prefers email over phone calls");
});

test("G490: the page writer says a person's preferences in their own words", async () => {
  const root = makeBrain();
  await importMemory(root, "planner", [exportDir()], model());
  for (const f of inbox(root)) decideProposal(root, `inbox/${f}`, "accept");
  renderTouchedPages(root, "2000-01-01T00:00:00Z");
  const text = readFileSync(join(root, "people", "jane-roy.md"), "utf8");
  expect(text).toMatch(/How Jane likes things: (likes agendas sent the day before; prefers email over phone calls|prefers email over phone calls; likes agendas sent the day before)\.\[\^pf-prefers\]/);
});
