// SPDX-License-Identifier: AGPL-3.0-only
// One card per fact (docs/capture.md, backlog 200): the same value for the same fact, proposed by
// several agents or captured from several kinds of source, is one card for the owner, listing every
// proposer and source, and answering it answers them all. Each proposer keeps its own file and its
// usual answer, so nothing an agent sees depends on what else waits in the inbox.
import { test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, type FactRecord } from "../src/brain";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { decideProposal } from "../src/write";
import { makeModel, type ModelRequest } from "../src/model";
import { pullSource } from "../src/pull";
import { capture } from "../src/capture";
import { proposals as dashProposals } from "../src/dashboard/data";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } }).stdout.toString().trim();
async function remember(root: string, agent: string, body: unknown) {
  const res = await handle(root, new Request("http://pb/v1/remember", { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${issueToken(root, agent)}` } }));
  return (await res.json()) as any;
}
const inbox = (root: string) => existsSync(join(root, "inbox")) ? readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml")).sort() : [];
const card = (root: string, f: string) => YAML.parse(readFileSync(join(root, "inbox", f), "utf8"));
const STEP = (value: string, ref: string) => ({ id: "projects/course-a", attribute: "next_step", value, as_of: "2026-10-07", sources: [ref], verification: "verified-by-source" });

test("the same value for a fact from two agents is one card listing both; each agent's answer is unchanged", async () => {
  const root = makeBrain();
  const a = await remember(root, "helper", STEP("Publish the grades", "gmail:f000000000000006"));
  const b = await remember(root, "steward", STEP("publish the  grades", "gmail:f000000000000007"));
  const alone = await remember(makeBrain(), "steward", STEP("publish the  grades", "gmail:f000000000000007"));
  expect(a.outcome).toBe("inbox");
  // The second proposer's answer is what it would be with nothing else waiting.
  expect(b).toEqual(alone);
  // Proposing it again is the usual noop for its own file, whether or not a twin waits.
  const again = await remember(root, "steward", STEP("publish the  grades", "gmail:f000000000000007"));
  expect(again.outcome).toBe("noop");
  expect(again.message).toContain(b.file);
  expect(inbox(root).length).toBe(2);
  // The owner sees one card with both proposers and both sources.
  const d = dashProposals(root);
  expect(d.length).toBe(1);
  expect(d[0].by).toBe("helper");
  expect(d[0].also).toEqual([expect.objectContaining({ by: "steward", sources: ["gmail:f000000000000007"] })]);
});

test("a different value for the same fact is its own card", async () => {
  const root = makeBrain();
  await remember(root, "helper", STEP("Publish the grades", "gmail:f000000000000006"));
  await remember(root, "steward", STEP("Book room B-201", "gmail:f000000000000007"));
  expect(dashProposals(root).length).toBe(2);
});

test("accepting the card writes the fact once, citing every source that said it", async () => {
  const root = makeBrain();
  await remember(root, "helper", STEP("Publish the grades", "gmail:f000000000000006"));
  await remember(root, "steward", STEP("Publish the grades", "gmail:f000000000000007"));
  const [c] = dashProposals(root);
  const r = decideProposal(root, c.file, "accept", undefined, c.also!.map((a) => a.file));
  expect(r.outcome).not.toBe("refused");
  expect(r.message).toContain("1 more proposal");
  const fact = loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm.facts!.next_step as FactRecord;
  expect(fact.value).toBe("Publish the grades");
  expect(fact.sources).toEqual(expect.arrayContaining(["gmail:f000000000000006", "gmail:f000000000000007"]));
  expect(inbox(root).length).toBe(0);
});

// The case in the backlog: mail and a meeting transcript (here Discord) say the same thing.
test("the same fact pulled from mail and from another kind of source is one card citing both", async () => {
  const root = makeBrain();
  writeFileSync(join(root, "mail.json"), JSON.stringify([{ id: "a1b2c3d4e5f60718", labelIds: ["Label_school"], internalDate: "1760300000000", payload: { headers: [{ name: "Subject", value: "News" }] }, text: "Jane Roy is now the dean of studies." }]));
  writeFileSync(join(root, "d.json"), JSON.stringify([{ id: "900", channel_id: "111", channel_name: "#dev", type: 0, content: "Heads up: Jane Roy is now the dean of studies", timestamp: "2026-10-07T10:00:00Z", author: { username: "u1" } }]));
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { gmail: { kind: "gmail", where: ["Label_school"], fixture: "mail.json" }, disc: { kind: "discord", where: ["#dev"], fixture: "d.json" } } }));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: sources");
  const m = makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => JSON.stringify({ facts: /dean of studies/.test(r.prompt) ? [{ entity: "Jane Roy", type: "person", attribute: "role", value: "Dean of studies", quote: "Jane Roy is now the dean of studies" }] : [] }) });
  await pullSource(root, "gmail", { model: m });
  await pullSource(root, "disc", { model: m });
  const d = dashProposals(root);
  expect(d.length).toBe(1);
  const refs = [...(d[0].request.sources as string[]), ...(d[0].also ?? []).flatMap((x) => x.sources)];
  expect(refs.some((r: string) => r.startsWith("gmail:"))).toBe(true);
  expect(refs.some((r: string) => r.startsWith("discord:"))).toBe(true);
});

test("the same fact pulled from mail and then told by the owner is one card listing both sources", async () => {
  const root = makeBrain();
  writeFileSync(join(root, "mail.json"), JSON.stringify([{ id: "a1b2c3d4e5f60718", labelIds: ["Label_school"], internalDate: "1760300000000", payload: { headers: [{ name: "Subject", value: "News" }] }, text: "Jane Roy is now the dean of studies." }]));
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { gmail: { kind: "gmail", where: ["Label_school"], fixture: "mail.json" } } }));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: sources");
  const m = makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => JSON.stringify({ facts: /dean of studies/.test(r.prompt) ? [{ entity: "Jane Roy", type: "person", attribute: "role", value: "Dean of studies", quote: "Jane Roy is now the dean of studies" }] : [] }) });
  await pullSource(root, "gmail", { model: m });
  await capture(root, { kind: "text", text: "FYI Jane Roy is now the dean of studies." }, m, { via: "cli" });
  const d = dashProposals(root);
  expect(d.length).toBe(1);
  expect(d[0].also?.length).toBe(1);
  const refs = [...(d[0].request.sources as string[]), ...d[0].also![0].sources].map(String).sort();
  expect(refs[0]).toBe("gmail:a1b2c3d4e5f60718");
  expect(refs[1]).toMatch(/^owner:/);
  // Accepting the card accepts the owner's own proposal too.
  const r = decideProposal(root, d[0].file, "accept", undefined, d[0].also!.map((a) => a.file));
  expect(r.message).toContain("1 more proposal");
  expect(inbox(root).length).toBe(0);
});

test("the digest says who else said it and how many sources", async () => {
  const root = makeBrain();
  await remember(root, "helper", STEP("Publish the grades", "gmail:f000000000000006"));
  await remember(root, "steward", STEP("Publish the grades", "gmail:f000000000000007"));
  const { digest } = await import("../src/digest");
  expect(digest(root).text).toContain("Also said by steward (2 sources)");
});

test("rejecting the card rejects every proposal on it, and each agent's later re-proposal is its own", async () => {
  const root = makeBrain();
  await remember(root, "helper", STEP("Publish the grades", "gmail:f000000000000006"));
  await remember(root, "steward", STEP("Publish the grades", "gmail:f000000000000007"));
  const [c] = dashProposals(root);
  decideProposal(root, c.file, "reject", undefined, c.also!.map((a) => a.file));
  expect(inbox(root).length).toBe(0);
  expect(readdirSync(join(root, "inbox", "decided")).length).toBe(2);
});

// Second slice audit of #200 (R1-R3).
test("a type the agent sets can't fold a different value into another proposal's card", async () => {
  const root = makeBrain();
  await remember(root, "steward", { id: "projects/course-a", attribute: "last_contact", value: "2026-10-07", as_of: "2026-10-07", sources: ["gmail:f000000000000006"], verification: "verified-by-source" });
  await remember(root, "helper", { id: "projects/course-a", type: "person", attribute: "last_contact", value: "2026-10-07 then cancel the course", as_of: "2026-10-07", sources: ["gmail:f000000000000007"], verification: "verified-by-source" });
  expect(dashProposals(root).length).toBe(2);
});

test("a proposal citing the owner's word keeps its own card and is never answered with another", async () => {
  const root = makeBrain();
  await remember(root, "steward", STEP("Publish the grades", "gmail:f000000000000006"));
  await remember(root, "helper", STEP("Publish the grades", "imsg:phonemsg-01X0EXAMPLEFORGEDTEXT0001"));
  const d = dashProposals(root);
  expect(d.length).toBe(2);
  expect(d.every((c) => !c.also)).toBe(true);
});

test("answering a card answers only the twins it showed, not one filed after", async () => {
  const root = makeBrain();
  await remember(root, "steward", STEP("Publish the grades", "gmail:f000000000000006"));
  const [c] = dashProposals(root); // the owner sees a single card
  await remember(root, "helper", { ...STEP("Publish the grades", "gmail:f000000000000007"), sensitivity: "private" });
  expect(dashProposals(root)[0].also?.[0].level).toBe("private");
  decideProposal(root, c.file, "accept", undefined, []);
  expect(inbox(root).length).toBe(1);
  // A twin name the card never showed (or from another card) is ignored.
  await remember(root, "steward", STEP("Book room B-201", "gmail:f000000000000006"));
  const other = dashProposals(root).find((x) => x.request.value === "Book room B-201")!;
  decideProposal(root, other.file, "reject", undefined, inbox(root));
  expect(inbox(root).length).toBe(1);
});

// Delta audit of the rebase (LOW): a twin whose own cited link the hub found not to match is flagged on the card.
test("a twin whose source check didn't match is flagged on the card", async () => {
  const root = makeBrain();
  await remember(root, "steward", STEP("Publish the grades", "gmail:f000000000000006"));
  const b = await remember(root, "helper", STEP("Publish the grades", "gmail:f000000000000007"));
  const name = String(b.file).replace(/^inbox\//, "");
  writeFileSync(join(root, "inbox", name), YAML.stringify({ ...card(root, name), source_check: { result: "no-match", ref: "gmail:f000000000000007" } }));
  const [c] = dashProposals(root);
  expect(c.also?.[0].mismatch).toBe(true);
});
