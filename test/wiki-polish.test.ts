// SPDX-License-Identifier: AGPL-3.0-only
// The Mac's phone pass after file-everything went live, 2026-10-25: "Filed for you" said nothing
// (its explanation was inside the closed fold), "Show it" read as a label with a big gap under it,
// "Changed this week" was all "hub updated …" (source checks, not changes, and no reason), and a
// fact about the owner was dropped because the owner had no page yet. Temp brains removed after.
import { test, expect, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { git } from "../src/git";
import { logWrite } from "../src/write";
import { loadBrain } from "../src/brain";
import { loadRules } from "../src/rules";
import { asked, weigh } from "./asked";
import { staleWhy } from "../src/golden";
import { loadState } from "../src/dashboard/data";
import { recentChanges } from "../src/dashboard/browse";
import { checkCandidate, sweepOwnerProposals } from "../src/capture";
import { setOwnerAliases, suggestOwnerName, ownerSpellings, ownerNameReport } from "../src/ownerset";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const brain = () => { const r = makeBrain(); roots.push(r); return r; };
const text = (h: string) => h.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("Changed this week lists changes with a reason, never source checks", () => {
  const root = brain();
  const at = (h: number) => new Date(Date.UTC(2026, 9, 7, h)).toISOString();
  logWrite(root, { at: at(1), agent: "hub", kind: "source-confirm", key: "people/jane-roy#role", outcome: "committed", source: "gmail:f000000000000001" });
  logWrite(root, { at: at(2), agent: "hub", kind: "source-due", key: "projects/course-a#status", outcome: "committed", why: "recheck" });
  logWrite(root, { at: at(3), agent: "planner", kind: "fact", key: "people/jane-roy#role", outcome: "committed", step: 6 });
  logWrite(root, { at: at(4), agent: "owner", kind: "owner-edit", key: "projects/course-b#status", outcome: "committed", step: 6 });
  logWrite(root, { at: at(5), agent: "gardener", kind: "fact", key: "projects/course-a#next_step", outcome: "committed", step: 6 });
  const s = loadState(root);
  s.now = new Date(Date.UTC(2026, 9, 8));
  const c = recentChanges(s);
  expect(c.map((x) => `${x.id}#${x.attr}`).sort()).toEqual(["people/jane-roy#role", "projects/course-a#next_step", "projects/course-b#status"]);
  const why = Object.fromEntries(c.map((x) => [x.id, x.why]));
  expect(why["people/jane-roy"]).toBe("filed from an email");
  expect(why["projects/course-b"]).toBe("edited by you");
  expect(why["projects/course-a"]).toMatch(/^tidied by /);
});

const fact = (entity: string) => ({ entity, type: "person", attribute: "org", value: "Northwind", quote: `Congratulate ${entity} for 6 years at Northwind` });
const withOwner = (owner: string) => {
  const root = brain();
  const p = join(root, "rules", "policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace("owner: { name: Robin }", `owner: ${owner}`));
  git(root, ["commit", "-qam", "owner"]);
  return root;
};

test("a fact about an owner with no page starts the owner's own page, named without credentials", () => {
  const root = withOwner("{ name: Robin, aliases: [Robin Lake] }");
  const r = checkCandidate(fact("Robin Lake, M.Sc.") as never, "Congratulate Robin Lake, M.Sc. for 6 years at Northwind", loadBrain(root), loadRules(root));
  expect(r.status).toBe("new-note");
  expect(r.candidate.entity).toBe("Robin Lake");
});

test("a new person page is never titled with credentials", () => {
  const root = brain();
  const r = checkCandidate(fact("Ada Fox, PhD") as never, "Congratulate Ada Fox, PhD for 6 years at Northwind", loadBrain(root), loadRules(root));
  expect(r.status).toBe("new-note");
  expect(r.candidate.entity).toBe("Ada Fox");
});

const propose = (root: string, name: string, title: string) => {
  mkdirSync(join(root, "inbox"), { recursive: true });
  // By the capture agent (the fixture's resolver), as a pull's proposals are.
  writeFileSync(join(root, "inbox", name), YAML.stringify({ proposed: "2026-10-07", by: "steward", reason: "capture x: no person called it yet", checks: ["capture"], capture: "inbox/captures/x.md", new_note: "people/…",
    request: { agent: "steward", kind: "fact", title, type: "person", area: "work", attribute: "org", value: "Northwind", as_of: "2026-10-07", sources: ["gmail:f000000000000902"], source_type: "gmail", confidence: "stated" } }));
};

test("the owner sweep moves old owner proposals onto one page name, and leaves others alone", () => {
  const root = withOwner("{ name: Robin, aliases: [Robin Lake] }");
  propose(root, "2026-10-07-capture-a.yaml", "Robin Lake, M.Sc.");
  propose(root, "2026-10-07-capture-b.yaml", "Lake, Robin");
  propose(root, "2026-10-07-capture-c.yaml", "Robin Fox");
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "old"]);
  expect(sweepOwnerProposals(root)).toEqual({ moved: 2, onPage: 0 });
  const title = (f: string) => (YAML.parse(readFileSync(join(root, "inbox", f), "utf8")) as { request: { title: string } }).request.title;
  expect(title("2026-10-07-capture-a.yaml")).toBe("Robin Lake");
  expect(title("2026-10-07-capture-b.yaml")).toBe("Robin Lake");
  expect(title("2026-10-07-capture-c.yaml")).toBe("Robin Fox");
  expect((YAML.parse(readFileSync(join(root, "inbox", "2026-10-07-capture-a.yaml"), "utf8")) as { request: { area: string } }).request.area).toBe("personal");
  expect(git(root, ["status", "--porcelain"]).trim()).toBe("");
  expect(sweepOwnerProposals(root)).toEqual({ moved: 0, onPage: 0 });
});

test("with the owner's page there, the sweep points old proposals at it", () => {
  const root = withOwner("{ name: Robin, aliases: [Robin Lake] }");
  writeFileSync(join(root, "people", "robin-lake.md"), `---\nid: people/robin-lake\ntype: person\ntitle: Robin Lake\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: owner\nfacts: {}\n---\n`);
  propose(root, "2026-10-07-capture-a.yaml", "Robin Lake, M.Sc.");
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "old"]);
  expect(sweepOwnerProposals(root)).toEqual({ moved: 1, onPage: 1 });
  const req = (YAML.parse(readFileSync(join(root, "inbox", "2026-10-07-capture-a.yaml"), "utf8")) as { request: Record<string, unknown>; new_note?: string });
  expect(req.request.id).toBe("people/robin-lake");
  expect(req.request.title).toBeUndefined();
});

test("the owner's full name: suggested from the open proposals, set as an alias, kept local", () => {
  const root = withOwner("{ name: Robin, timezone: America/Toronto }");
  propose(root, "2026-10-07-capture-a.yaml", "Robin Lake, M.Sc.");
  propose(root, "2026-10-07-capture-b.yaml", "Robin Lake");
  propose(root, "2026-10-07-capture-c.yaml", "Robin Fox");
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "old"]);
  expect(suggestOwnerName(root)).toBe("Robin Lake");
  const out = setOwnerAliases(root, "Robin Lake");
  // What it prints never holds the name: the Mac thread may run it.
  expect(out).not.toMatch(/Lake/);
  const owner = loadRules(root).policy.owner!;
  expect(owner.name).toBe("Robin");
  expect(owner.timezone).toBe("America/Toronto");
  expect(owner.aliases).toEqual(["Robin Lake"]);
  expect(() => setOwnerAliases(root, "Lake")).toThrow();
  expect(() => setOwnerAliases(root, "Sam Lake")).toThrow();
  expect(readdirSync(join(root, "inbox")).length).toBeGreaterThan(0);
});

// Slice audit of G401 (G402): the name suggestion and the sweep trust only the capture agent's
// proposals, one sighting or a son's "Jr." never names the owner, and the owner's page sits in the
// owner's personal area, not one a mail's words point to.
const proposeBy = (root: string, name: string, title: string, by: string) => {
  propose(root, name, title);
  const f = join(root, "inbox", name), d = YAML.parse(readFileSync(f, "utf8"));
  d.by = by; d.request.agent = by;
  writeFileSync(f, YAML.stringify(d));
};

test("one sighting, a Jr. or another agent's proposals never name the owner", () => {
  const one = withOwner("{ name: Robin }");
  propose(one, "2026-10-07-capture-a.yaml", "Robin Fox");
  expect(suggestOwnerName(one)).toBeUndefined();
  const son = withOwner("{ name: Robin }");
  propose(son, "2026-10-07-capture-a.yaml", "Robin Lake Jr.");
  propose(son, "2026-10-07-capture-b.yaml", "Robin Lake Jr.");
  expect(suggestOwnerName(son)).toBeUndefined();
  const agent = withOwner("{ name: Robin }");
  proposeBy(agent, "2026-10-07-capture-a.yaml", "Robin Evil", "helper");
  proposeBy(agent, "2026-10-07-capture-b.yaml", "Robin Evil", "helper");
  expect(suggestOwnerName(agent)).toBeUndefined();
});

test("the sweep moves only the capture agent's proposals", () => {
  const root = withOwner("{ name: Robin, aliases: [Robin Lake] }");
  proposeBy(root, "2026-10-07-capture-a.yaml", "Robin Lake, M.Sc.", "helper");
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "old"]);
  expect(sweepOwnerProposals(root)).toEqual({ moved: 0, onPage: 0 });
});

test("the owner's new page lands in the personal area", async () => {
  const root = withOwner("{ name: Robin, aliases: [Robin Lake] }");
  const { capture } = await import("../src/capture");
  const { makeModel } = await import("../src/model");
  const line = "Congratulate Robin Lake, M.Sc. for 6 years at Northwind on the course project";
  const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: () => JSON.stringify({ facts: [{ entity: "Robin Lake, M.Sc.", type: "person", attribute: "org", value: "Northwind", quote: line }] }) });
  await capture(root, { kind: "text", text: line }, model);
  const found = readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml")).map((f) => YAML.parse(readFileSync(join(root, "inbox", f), "utf8")) as { request: { title?: string; area?: string } });
  const own = found.find((p) => p.request.title === "Robin Lake");
  expect(own?.request.area).toBe("personal");
});

// Mac, after file-all went on (2026-10-25 15:19Z): the home page's five were two "is status
// still right?" checks, two new notes and a Gardener card whose reason named someone's health
// detail in the open; none was a conflict (G403).
test("a freshness check is never asked: it stays in the Brain's To recheck, file all on or not", () => {
  const root = brain();
  const before = asked(root).length;
  const f = join(root, "people", "jane-roy.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("role: { value: Course coordinator, as_of: 2026-09-01", "role: { value: Course coordinator, as_of: 2026-01-01"));
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: ask }\n");
  git(root, ["add", "-A"]); git(root, ["commit", "-qam", "old role"]);
  expect(asked(root).length).toBe(before);
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  git(root, ["commit", "-qam", "file all"]);
  expect(asked(root).length).toBe(before);
});

test("an assistant's reason that reads like health, money or legal stays behind Show it", () => {
  const root = brain();
  mkdirSync(join(root, "inbox"), { recursive: true });
  const why = "A student's insurance claim for a diagnosis sits in this course note; it should be private";
  writeFileSync(join(root, "inbox", "2026-10-07-gardener-s1.yaml"), YAML.stringify({ proposed: "2026-10-07", by: "gardener", reason: why,
    request: { agent: "gardener", kind: "fact", id: "projects/course-a", attribute: "notes", value: "Sensitivity looks wrong; review it", as_of: "2026-10-07", sources: ["agent:gardener"], source_type: "agent_observation", confidence: "stated" } }));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "gardener"]);
  const item = asked(root).find((c) => c.key.includes("gardener-s1"))!;
  expect(item).toBeTruthy();
  expect(item.title).not.toMatch(/insurance|diagnosis/);
});

test("with file all on, the owner's own capture files itself too", async () => {
  const root = brain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  propose(root, "2026-10-07-capture-o.yaml", "Ada Fox");
  const f = join(root, "inbox", "2026-10-07-capture-o.yaml"), d = YAML.parse(readFileSync(f, "utf8"));
  d.by = "owner"; d.request.agent = "owner"; writeFileSync(f, YAML.stringify(d));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "own capture"]);
  const { autoSaves } = await import("../src/filing");
  expect(autoSaves(root).has("2026-10-07-capture-o.yaml")).toBe(true);
});

// Mac, 2026-10-25 15:24Z: every auto-save after file-all went on (684 tries) was refused by
// as_of_not_future: a mail or calendar fact dated after today. Accepting it by hand already saves
// it as of today (G383); filing it must too, and a save refused before the fix is tried again (G404).
test("with file all on, a fact dated after today files as of today", async () => {
  const root = brain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  propose(root, "2026-10-07-capture-f.yaml", "Ada Fox");
  const f = join(root, "inbox", "2026-10-07-capture-f.yaml"), d = YAML.parse(readFileSync(f, "utf8"));
  d.request.as_of = "2099-01-01"; d.request.source_type = "email"; writeFileSync(f, YAML.stringify(d));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "future"]);
  const { runAuto } = await import("../src/filing");
  expect(runAuto(root).map((x) => x.key)).toEqual(["proposal:2026-10-07-capture-f.yaml"]);
  const page = readdirSync(join(root, "people")).find((x) => x.startsWith("ada-fox"))!;
  expect(readFileSync(join(root, "people", page), "utf8")).not.toContain("2099-01-01");
});

test("a save that failed more than a day ago is tried again", async () => {
  const root = brain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  propose(root, "2026-10-07-capture-g.yaml", "Ada Fox");
  const f = join(root, "inbox", "2026-10-07-capture-g.yaml"), d = YAML.parse(readFileSync(f, "utf8"));
  d.request.source_type = "email"; writeFileSync(f, YAML.stringify(d));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "g"]);
  mkdirSync(join(root, "log"), { recursive: true });
  const now = new Date();
  writeFileSync(join(root, "log", "auto-decisions-errors.jsonl"), JSON.stringify({ at: new Date(now.getTime() - 2 * 86_400_000).toISOString(), key: "proposal:2026-10-07-capture-g.yaml", error: "as_of_not_future: x" }) + "\n");
  const { autoSaves } = await import("../src/filing");
  expect(autoSaves(root, now).has("2026-10-07-capture-g.yaml")).toBe(true);
  // Refused an hour ago by other code (a deploy since): tried again at once, as the fix may be in
  // the new code (Mac, 2026-10-25 16:46Z: 4 saves refused before G404 went live
  // stayed cards for a day) (G407).
  writeFileSync(join(root, "log", "auto-decisions-errors.jsonl"), JSON.stringify({ at: new Date(now.getTime() - 3600_000).toISOString(), key: "proposal:2026-10-07-capture-g.yaml", error: "as_of_not_future: x", code: "0ld0c0d" }) + "\n");
  expect(autoSaves(root, now).has("2026-10-07-capture-g.yaml")).toBe(true);
  // Refused by this code: asked for a day, restart or not.
  const { FILING_CODE } = await import("../src/filing");
  writeFileSync(join(root, "log", "auto-decisions-errors.jsonl"), JSON.stringify({ at: new Date(now.getTime() - 3600_000).toISOString(), key: "proposal:2026-10-07-capture-g.yaml", error: "as_of_not_future: x", code: FILING_CODE }) + "\n");
  expect(autoSaves(root, now).has("2026-10-07-capture-g.yaml")).toBe(false);
  // The card no longer promises to file it.
  const w = weigh(root, now).get("proposal:2026-10-07-capture-g.yaml")!;
  expect(w.auto).toBeUndefined();
  expect(w.never_auto).toMatch(/couldn't file/);
});

test("on the home page too, an assistant's sensitive reason is one tap away", async () => {
  const root = brain();
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "2026-10-07-gardener-s2.yaml"), YAML.stringify({ proposed: "2026-10-07", by: "gardener", reason: "A student's insurance claim for a diagnosis sits in this course note; it should be private",
    request: { agent: "gardener", kind: "fact", id: "projects/course-a", attribute: "notes", value: "Sensitivity looks wrong", as_of: "2026-10-07", sources: ["agent:gardener"], source_type: "agent_observation", confidence: "stated" } }));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "gardener"]);
  const { overview } = await import("../src/dashboard/html");
  const html = overview(loadState(root), "x").body;
  expect(html).toMatch(/diagnosis/);
  expect(text(html.replace(/<details[\s\S]*?<\/details>/g, ""))).not.toMatch(/insurance|diagnosis/);
});

// Owner's phone, 2026-10-25 15:26Z ("still weird asks"): "Remember this as a new note, '<owner>'?"
// with Emails: <his own address>, quoted from an airline mail's footer ("Ce courriel vous a été
// envoyé par … à <address>"). A footer is not a fact: never proposed, and an open one is dropped
// by the hub with Undo (G405).
test("a fact quoted from a mail's footer is not proposed", () => {
  const root = brain();
  const quote = "Ce courriel vous a été envoyé par Northwind Air à ada.fox@example.org";
  const r = checkCandidate({ entity: "Ada Fox", type: "person", attribute: "emails", value: "ada.fox@example.org", quote } as never, `Votre vol est confirmé.\n${quote}`, loadBrain(root), loadRules(root));
  expect(r.status).toBe("unsupported");
  expect(r.why).toMatch(/footer/);
});

test("with file all on, an open proposal quoted from a footer is dropped, with Undo", async () => {
  const root = brain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  propose(root, "2026-10-07-capture-h.yaml", "Ada Fox");
  const { putQuote } = await import("../src/quotes");
  putQuote(root, "inbox/2026-10-07-capture-h.yaml", "This email was sent to ada.fox@example.org. Unsubscribe");
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "h"]);
  const { runAuto } = await import("../src/filing");
  const done = runAuto(root);
  expect(done.map((d) => d.key)).toEqual(["proposal:2026-10-07-capture-h.yaml"]);
  expect(done[0].why).toMatch(/footer/);
  expect(readdirSync(join(root, "people")).some((x) => x.startsWith("ada-fox"))).toBe(false);
});

// Slice audit of G404/G405 (G406): a value dated ahead replacing a current one waits (filing it as
// of today would end the current value now); the owner's own words about unsubscribing are kept.
test("with file all on, a value dated ahead that replaces a current one waits for you", async () => {
  const root = brain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  propose(root, "2026-10-07-capture-k.yaml", "Jane Roy");
  const f = join(root, "inbox", "2026-10-07-capture-k.yaml"), d = YAML.parse(readFileSync(f, "utf8"));
  d.request = { ...d.request, id: "people/jane-roy", attribute: "role", value: "Dean", as_of: "2099-12-01", sources: ["gmail:f000000000000001"], source_type: "email" };
  delete d.request.title; delete d.request.type; delete d.request.area; delete d.new_note;
  writeFileSync(f, YAML.stringify(d));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "k"]);
  const { autoSaves } = await import("../src/filing");
  expect(autoSaves(root).has("2026-10-07-capture-k.yaml")).toBe(false);
  expect(weigh(root).get("proposal:2026-10-07-capture-k.yaml")!.never_auto).toMatch(/later date/);
});

test("the owner's own words about unsubscribing are a fact, not a footer", () => {
  const root = brain();
  const quote = "I'm going to unsubscribe from the gym, it ends Nov 30";
  const r = checkCandidate({ entity: "Ada Fox", type: "person", attribute: "org", value: "the gym", quote } as never, quote, loadBrain(root), loadRules(root));
  expect(r.why ?? "").not.toMatch(/footer/);
});

// Mac, 2026-10-25 16:48Z: `me name --suggested` found no name: the two owner proposals spelled
// the name two ways from one mail. Spellings that are one name once accents, case, credentials,
// order and initials are set aside count as one (G408).
test("two spellings of the owner's name count as one name", () => {
  const root = withOwner("{ name: Robin }");
  propose(root, "2026-10-07-capture-a.yaml", "LAKE Robin");
  propose(root, "2026-10-07-capture-b.yaml", "Robin Lake, M.Sc. (Northwind)");
  propose(root, "2026-10-07-capture-c.yaml", "Robin Fox");
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "old"]);
  expect(suggestOwnerName(root)).toBe("Robin Lake");
  expect(ownerSpellings(root)).toEqual(["Robin Lake", "LAKE Robin"]);
  setOwnerAliases(root, "Robin Lake", ownerSpellings(root));
  expect(sweepOwnerProposals(root)).toEqual({ moved: 2, onPage: 0 });
  // An initial keeps a name apart (G399): "Robin J. Lake" is not two sightings of Robin Lake.
  const apart = withOwner("{ name: Robin }");
  propose(apart, "2026-10-07-capture-a.yaml", "Robin J. Lake");
  propose(apart, "2026-10-07-capture-b.yaml", "Robin K. Lake");
  git(apart, ["add", "-A"]); git(apart, ["commit", "-qm", "old"]);
  expect(suggestOwnerName(apart)).toBeUndefined();
  // A note in brackets naming family is someone else.
  const kin = withOwner("{ name: Robin, aliases: [Robin Lake] }");
  expect(checkCandidate(fact("Robin Lake (son)") as never, "Congratulate Robin Lake (son) for 6 years at Northwind", loadBrain(kin), loadRules(kin)).candidate.entity).not.toBe("Robin Lake");
  // Word order is a name's own: "Lake Robin" (no capitals, no comma) is someone else; a cousin too.
  const swap = withOwner("{ name: Robin }");
  propose(swap, "2026-10-07-capture-a.yaml", "Robin Lake");
  propose(swap, "2026-10-07-capture-b.yaml", "Lake Robin");
  propose(swap, "2026-10-07-capture-c.yaml", "Dr. Robin Lake");
  git(swap, ["add", "-A"]); git(swap, ["commit", "-qm", "old"]);
  expect(ownerSpellings(swap)).toEqual(["Robin Lake"]);
  expect(checkCandidate(fact("Robin Lake (cousin)") as never, "Congratulate Robin Lake (cousin) for 6 years at Northwind", loadBrain(kin), loadRules(kin)).candidate.entity).not.toBe("Robin Lake");
  // Why not, in counts only.
  const why = ownerNameReport(apart);
  expect(why).toMatch(/names holding yours 2 \(sightings 1, 1\)/);
  expect(why).not.toMatch(/Lake/);
});

// Mac, 2026-10-25 17:41Z: the two owner cards were an assistant's proposals ("Start a note, …"),
// not the mail pull's, so the name guess skipped them and file-all left them as cards. A core
// assistant's proposals name the owner too, and under file all its fact about the owner lands on
// the owner's page; a trial agent's and the Gardener's still don't, unless it is the capture agent
// (G409). A degree after the name without a comma is set aside too.
const assistantNote = (root: string, name: string, title: string, by: string) => {
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", name), YAML.stringify({ proposed: "2026-10-07", by, reason: "new note",
    request: { agent: by, kind: "fact", title, type: "person", area: "work", attribute: "org", value: "Northwind", as_of: "2026-10-07", sources: [`agent:${by}`], source_type: "agent_observation", confidence: "stated" } }));
};

test("a core assistant's proposals name the owner; a trial agent's don't", () => {
  const root = withOwner("{ name: Robin }");
  assistantNote(root, "2026-10-07-steward-a.yaml", "Robin Lake", "steward");
  assistantNote(root, "2026-10-07-steward-b.yaml", "Robin Lake M.Sc.", "steward");
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "old"]);
  expect(suggestOwnerName(root)).toBe("Robin Lake");
  const trial = withOwner("{ name: Robin }");
  assistantNote(trial, "2026-10-07-helper-a.yaml", "Robin Lake", "helper");
  assistantNote(trial, "2026-10-07-helper-b.yaml", "Robin Lake", "helper");
  git(trial, ["add", "-A"]); git(trial, ["commit", "-qm", "old"]);
  expect(suggestOwnerName(trial)).toBeUndefined();
});

// These two run during the hold on core assistants' own proposals (the hold_assistants_until the brain pins in rules/escalation.yaml):
// from its day those file by the usual rules (test/assistant-hold.test.ts), so they pin a day before it.
const DURING_HOLD = new Date("2026-10-28T15:00:00Z");

test("with file all on, a core assistant's fact about the owner files on the owner's page; about anyone else it still asks", async () => {
  const root = withOwner("{ name: Robin, aliases: [Robin Lake] }");
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all, hold_assistants_until: 2026-10-30 }\n");
  assistantNote(root, "2026-10-07-steward-a.yaml", "Robin Lake", "steward");
  assistantNote(root, "2026-10-07-steward-b.yaml", "Ada Fox", "steward");
  assistantNote(root, "2026-10-07-helper-a.yaml", "Robin Lake", "helper");
  // Another value, so it isn't answered as a twin of the steward's.
  const hf = join(root, "inbox", "2026-10-07-helper-a.yaml"), hd = YAML.parse(readFileSync(hf, "utf8"));
  hd.request.value = "Southwind"; writeFileSync(hf, YAML.stringify(hd));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "old"]);
  expect(sweepOwnerProposals(root).moved).toBe(1);
  const { autoSaves } = await import("../src/filing");
  const saves = autoSaves(root, DURING_HOLD);
  expect(saves.has("2026-10-07-steward-a.yaml")).toBe(true);
  expect(saves.has("2026-10-07-steward-b.yaml")).toBe(false);
  expect(saves.has("2026-10-07-helper-a.yaml")).toBe(false);
});

// Slice audit of G409 (G410): only the capture agent's own fact about the owner files without a
// card, and only while it is active and the fact isn't private, money, health or legal; another
// core assistant (it may be kept to its own area) still asks.
test("an assistant's fact about the owner that is sensitive, from a paused agent or another assistant still asks", async () => {
  const root = withOwner("{ name: Robin, aliases: [Robin Lake] }");
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all, hold_assistants_until: 2026-10-30 }\n");
  assistantNote(root, "2026-10-07-steward-a.yaml", "Robin Lake", "steward");
  const sf = join(root, "inbox", "2026-10-07-steward-a.yaml"), sd = YAML.parse(readFileSync(sf, "utf8"));
  sd.request.attribute = "notes"; sd.request.value = "Diagnosis: a heart condition"; writeFileSync(sf, YAML.stringify(sd));
  assistantNote(root, "2026-10-07-planner-a.yaml", "Robin Lake", "planner");
  const pf = join(root, "inbox", "2026-10-07-planner-a.yaml"), pd = YAML.parse(readFileSync(pf, "utf8"));
  pd.request.value = "Eastwind"; writeFileSync(pf, YAML.stringify(pd));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "old"]);
  const { autoSaves } = await import("../src/filing");
  expect(autoSaves(root, DURING_HOLD).has("2026-10-07-steward-a.yaml")).toBe(false);
  expect(autoSaves(root, DURING_HOLD).has("2026-10-07-planner-a.yaml")).toBe(false);
  const paused = withOwner("{ name: Robin, aliases: [Robin Lake] }");
  writeFileSync(join(paused, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all, hold_assistants_until: 2026-10-30 }\n");
  const pp = join(paused, "rules", "policy.yaml");
  writeFileSync(pp, readFileSync(pp, "utf8").replace("steward: { tier: core,", "steward: { tier: core, status: paused,"));
  assistantNote(paused, "2026-10-07-steward-a.yaml", "Robin Lake", "steward");
  git(paused, ["add", "-A"]); git(paused, ["commit", "-qm", "old"]);
  expect(autoSaves(paused, DURING_HOLD).has("2026-10-07-steward-a.yaml")).toBe(false);
});


// Mac, 2026-10-25 17:47Z: "Remember this as a new note, '<course>'?" for a course whose page
// exists: the write would land on that page, so the card says so (G411).
test("a proposal whose name is an existing page asks about that page, not a new note", async () => {
  const root = brain();
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: ask }\n");
  writeFileSync(join(root, "inbox", "2026-10-07-capture-n.yaml"), YAML.stringify({ proposed: "2026-10-07", by: "steward", reason: "capture inbox/captures/x.md: next step", checks: ["capture"], capture: "inbox/captures/x.md",
    request: { agent: "steward", kind: "fact", title: "Course A", type: "project", area: "work", attribute: "next_step", value: "Prepare session 3", as_of: "2026-10-07", sources: ["gcal:abcn"], source_type: "calendar", confidence: "stated" } }));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "n"]);
  expect(asked(root).some((c) => c.key === "proposal:2026-10-07-capture-n.yaml")).toBe(true);
  const { overview } = await import("../src/dashboard/html");
  const html = text(overview(loadState(root), "x").body);
  expect(html).not.toMatch(/new note, “?"?Course A/);
  expect(html).toMatch(/Remember this about Course A/);
});

// Audit v4 follow-up (2026-10-27): with file all on, the real brain still asked 2 freshness
// questions, "Past its date?" and "Still the plan?". Neither is a conflict, so neither is a card
// (G452); the golden set's reason says no card asks.
test("a past date or an old next step is never asked, file all on or not", () => {
  const root = brain();
  const f = join(root, "projects", "course-a.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("value: Grade the midterm, as_of: 2026-10-01", "value: Grade the midterm by 2026-10-05, as_of: 2026-09-01"));
  const c = join(root, "projects", "course-b.md");
  writeFileSync(c, readFileSync(c, "utf8").replace("by: planner\n---", "by: planner\nfacts:\n  next_step: { value: Write the exam, as_of: 2026-08-01, sources: [\"gmail:f000000000000004\"], verification: verified-by-source, by: planner, recorded: 2026-08-01 }\n---"));
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: ask }\n");
  git(root, ["add", "-A"]); git(root, ["commit", "-qam", "old steps"]);
  expect(asked(root)).toEqual([]);
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  git(root, ["commit", "-qam", "file all"]);
  expect(asked(root)).toEqual([]);
  expect(staleWhy(root, "projects/course-a", "next_step")).toContain("nothing asks");
});
