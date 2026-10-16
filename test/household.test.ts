// SPDX-License-Identifier: AGPL-3.0-only
// Household brain (docs/household.md): a second owner for named areas. Sam's word counts like the
// owner's in the household and nowhere else; her assistant sees the household and nothing else;
// two owners' words on one fact follow the conflict rule below.
import { test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadRules } from "../src/rules";
import { loadBrain, type FactRecord } from "../src/brain";
import { carve, grantFor } from "../src/carve";
import { write } from "../src/write";
import { setFact } from "../src/dashboard/edit";
import * as core from "../src/core";
import { decideProposal } from "../src/write";
import { louisMessages } from "../src/louis";
import { askToSee, listAsks, approveAsk, askStatus } from "../src/asks";
import { sleep } from "../src/sleep";

const PICKUP = `---
id: projects/kids-pickup
type: project
title: Kids pickup
area: household
sensitivity: personal
status: active
created: 2026-10-01
updated: 2026-10-01
by: steward
facts:
  pickup_time: { value: "15:30", as_of: 2026-10-01, sources: ["owner:2026-10-01/dashboard"], verification: confirmed-by-owner, by: owner, recorded: 2026-10-01 }
---
Who picks up the kids, and when.
`;

function household(patch: (policy: any) => void = () => {}) {
  const root = makeBrain();
  const f = join(root, "rules", "policy.yaml");
  const p = YAML.parse(readFileSync(f, "utf8"));
  p.areas.household = { owner: "steward" };
  p.agents["sam-assistant"] = { tier: "core", slices: ["area:household", "area:work", "all"] };
  p.co_owners = { sam: { name: "Sam Roy", areas: ["household"], agents: ["sam-assistant"] } };
  patch(p);
  writeFileSync(f, YAML.stringify(p));
  mkdirSync(join(root, "projects"), { recursive: true });
  writeFileSync(join(root, "projects", "kids-pickup.md"), PICKUP);
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "commit", "-q", "-m", "household fixture"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
  return root;
}
const fact = (root: string, id: string, attr: string) => loadBrain(root).find((n) => n.fm.id === id)?.fm.facts?.[attr] as FactRecord & { dispute?: string; co_owner?: string };
// Sam's assistant reports "the owner told me" the way any assistant does (an owner ref); in Sam's
// areas, from Sam's own assistant, that is Sam's word.
const SAM = { agent: "sam-assistant", id: "projects/kids-pickup", attribute: "pickup_time", sources: ["owner:2026-10-08/chat"], verification: "confirmed-by-owner" as const };

// ---------- what Sam's assistant may be ----------

test("loadRules holds a co-owner's assistant to her areas, personal at most, no money", () => {
  const rules = loadRules(household());
  const a = rules.policy.agents["sam-assistant"];
  expect(a.slices).toEqual(["area:household"]);
  expect(a.max_sensitivity).toBe("personal");
  expect(a.exclude_types).toContain("money");
  expect(grantFor(rules, "sam-assistant").ceiling).toBe("personal");
});

test("a co-owner's assistant can't hold the owner's roles: loading the rules fails until fixed", () => {
  for (const patch of [
    (p: any) => { p.resolver = "sam-assistant"; },
    (p: any) => { p.owner_channel = "sam-assistant"; },
    (p: any) => { p.owner_editor = "sam-assistant"; },
    (p: any) => { p.agents["sam-assistant"].inside_wall = true; },
    (p: any) => { p.agents["sam-assistant"].role = "gardener"; },
    (p: any) => { p.areas.work.owner = "sam-assistant"; },
    (p: any) => { p.co_owners.sam.areas = ["work"]; p.areas.work = { owner: "planner" }; p.co_owners.sam.areas.push("all"); },
    (p: any) => { p.co_owners.sam.agents = ["steward"]; },
    (p: any) => { delete p.resolver; p.agents.instinct = { tier: "core", slices: [] }; p.co_owners.sam.agents = ["instinct"]; },
    (p: any) => { p.agents["sam-assistant"].collaborator = { name: "Sam Roy", until: "2027-01-01" }; },
  ]) expect(() => loadRules(household(patch))).toThrow(/co-owner/);
});

test("Sam's assistant sees the household and nothing else; the rest answers like a missing note", () => {
  const root = household();
  const rules = loadRules(root);
  const res = carve(loadBrain(root), rules, grantFor(rules, "sam-assistant"));
  expect([...res.visible.keys()].sort()).toEqual(["projects/kids-pickup"]);
  const err = (id: string) => { try { core.readNote(root, "sam-assistant", id); return ""; } catch (e) { return (e as Error).message; } };
  expect(err("projects/course-a")).toBe(err("projects/nothing-here").replace("nothing-here", "course-a"));
});

// ---------- Sam's word ----------

test("Sam's word on a household fact commits directly, marked as hers", () => {
  const root = household();
  const r = write(root, { ...SAM, value: "16:00", as_of: "2026-10-05" });
  expect(r.outcome).toBe("committed"); // no area-owner routing for a co-owner in her own area
  const f = fact(root, "projects/kids-pickup", "pickup_time");
  expect(f).toMatchObject({ value: "16:00", verification: "confirmed-by-co-owner", co_owner: "sam", sources: ["agent:sam-assistant"] });
  // Her message is not the owner's: nothing lands in the owner's registry, and no owner ref is stored.
  expect(JSON.stringify(f)).not.toContain("owner:2026-10-08");
  expect(existsSync(join(root, "rules", "owner-messages.yaml")) && readFileSync(join(root, "rules", "owner-messages.yaml"), "utf8").includes("2026-10-08/chat")).toBe(false);
  // Louis's older word went to history with who replaced it.
  const h = loadBrain(root).find((n) => n.fm.id === "projects/kids-pickup")!.fm.history!.pickup_time[0];
  expect(h).toMatchObject({ value: "15:30", ended_by: { step: 4, by: "sam-assistant" } });
});

test("only a co-owner's own assistant speaks for a co-owner; nobody can write the label itself", () => {
  const root = household();
  // Louis's own channel saying "the owner told me" is Louis's word (registered, as before), never Sam's.
  write(root, { ...SAM, agent: "steward", value: "16:00", as_of: "2026-10-05" });
  expect(fact(root, "projects/kids-pickup", "pickup_time")).toMatchObject({ verification: "confirmed-by-owner" });
  expect(fact(root, "projects/kids-pickup", "pickup_time").co_owner).toBeUndefined();
  // The co-owner label is set by the write path only.
  const r = write(root, { ...SAM, verification: "confirmed-by-co-owner" as never, value: "16:00", as_of: "2026-10-05" });
  expect(r.outcome).toBe("refused");
  expect(JSON.stringify(r)).toContain("schema");
  expect(fact(root, "projects/kids-pickup", "pickup_time").verification).toBe("confirmed-by-owner");
});

test("Sam's word never lands outside her areas", () => {
  const root = household();
  // A new note she names in the work area: refused, not proposed.
  const r = write(root, { ...SAM, id: undefined, title: "Sam's work plan", type: "project", area: "work", attribute: "next_step", value: "x", as_of: "2026-10-08" } as never);
  expect(r.outcome).toBe("refused");
  expect(loadBrain(root).some((n) => n.fm.title === "Sam's work plan")).toBe(false);
  // A note she can't see answers like a missing one.
  const hidden = write(root, { ...SAM, id: "projects/course-a", attribute: "next_step", value: "x", as_of: "2026-10-08" });
  const missing = write(root, { ...SAM, id: "projects/nothing-here", attribute: "next_step", value: "x", as_of: "2026-10-08" });
  expect(hidden.message).toBe(missing.message.replace("nothing-here", "course-a"));
});

// ---------- the two-owner conflict rule ----------

test("between the two owners the newer word holds, either way round", () => {
  const root = household();
  write(root, { ...SAM, value: "16:00", as_of: "2026-10-05" });
  // Louis changes it again the next day: his newer word replaces hers.
  setFact(root, "projects/kids-pickup", "pickup_time", "16:15", "2026-10-08");
  const f = fact(root, "projects/kids-pickup", "pickup_time");
  expect(f).toMatchObject({ value: "16:15", verification: "confirmed-by-owner" });
  expect(f.co_owner).toBeUndefined();
});

test("the two owners saying different things the same day is a dispute, not a winner", () => {
  const root = household();
  write(root, { ...SAM, value: "16:00", as_of: "2026-10-01" }); // same day as Louis's 15:30
  const f = fact(root, "projects/kids-pickup", "pickup_time");
  expect(f.dispute).toBeDefined();
});

test("an assistant's value never replaces either owner's word", () => {
  const root = household();
  write(root, { ...SAM, value: "16:00", as_of: "2026-10-05" });
  const r = write(root, { agent: "steward", id: "projects/kids-pickup", attribute: "pickup_time", value: "17:00", as_of: "2026-10-07", sources: ["gmail:f000000000000006"], verification: "verified-by-source" });
  expect(r.outcome).toBe("disputed");
  expect(fact(root, "projects/kids-pickup", "pickup_time").dispute).toBeDefined(); // held for the owners, not replaced
});

test("a hand-written co-owner verification by anyone else counts for nothing in a conflict", () => {
  const root = household();
  // An agent outside the co-owner list that slipped the label onto a fact (a hand edit, an import).
  const f = join(root, "projects", "kids-pickup.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("verification: confirmed-by-owner, by: owner", "verification: confirmed-by-co-owner, by: planner"));
  const r = write(root, { agent: "steward", id: "projects/kids-pickup", attribute: "pickup_time", value: "17:00", as_of: "2026-10-07", sources: ["gmail:f000000000000006"], verification: "verified-by-source" });
  expect(r.outcome).toBe("committed");
  expect(fact(root, "projects/kids-pickup", "pickup_time").value).toBe("17:00"); // not shielded as an owner's word
});

// ---------- slice audit findings (docs/household.md) ----------

test("the resolver can't settle a dispute against a co-owner's word: it goes to the owners", () => {
  const root = household();
  write(root, { ...SAM, value: "16:00", as_of: "2026-10-05" });
  write(root, { agent: "steward", id: "projects/kids-pickup", attribute: "pickup_time", value: "17:00", as_of: "2026-10-05", sources: ["gmail:f000000000000006"], verification: "verified-by-source" });
  const id = fact(root, "projects/kids-pickup", "pickup_time").dispute!;
  expect(id).toBeDefined();
  let status = 0;
  try { core.resolveDispute(root, "steward", id, { value: "17:00", as_of: "2026-10-07", sources: ["gmail:f000000000000007"] }); } catch (e) { status = (e as core.CoreError).status; }
  expect(status).toBe(403);
});

test("the owner accepting a co-owner assistant's proposal is his word, and her message never enters his registry", () => {
  const root = household((p) => { p.agents["sam-assistant"].tier = "trial"; });
  expect(write(root, { ...SAM, value: "16:00", as_of: "2026-10-05" }).outcome).toBe("inbox");
  const file = readdirSync(join(root, "inbox")).find((f) => f.endsWith(".yaml"))!;
  expect(decideProposal(root, file, "accept").outcome).toBe("committed");
  expect(louisMessages(root).has("owner:2026-10-08/chat")).toBe(false);
  const f = fact(root, "projects/kids-pickup", "pickup_time");
  expect(f).toMatchObject({ value: "16:00", verification: "confirmed-by-owner" });
  expect(f.co_owner).toBeUndefined();
});

test("slices.yaml can't redefine a co-owner's area slice to widen her reads", () => {
  const root = household();
  const f = join(root, "rules", "slices.yaml");
  const y = YAML.parse(readFileSync(f, "utf8")) ?? {};
  y.slices = { ...(y.slices ?? {}), "area:household": { areas: ["household", "work", "personal"] } };
  writeFileSync(f, YAML.stringify(y));
  expect(() => loadRules(root)).toThrow(/co-owner/);
});

test("ask to see never offers a co-owner's assistant anything past her limits", async () => {
  const approver = { name: "test", start: async () => ({}), poll: async () => ({ state: "waiting" as const }) };
  for (const what of ["main bank account", "Course A next step", "Jane Roy"]) {
    const root = household((p) => { p.ask_to_see = true; });
    await askToSee(root, "sam-assistant", { what, why: "planning" }, approver);
    expect(listAsks(root).at(-1)!.candidates).toEqual([]);
  }
});

test("her confirmation of a value an assistant wrote is her word: a later assistant value disputes it", () => {
  const root = household();
  write(root, { agent: "steward", id: "projects/kids-pickup", attribute: "next_step", value: "Pick up at 16:30", as_of: "2026-10-05", sources: ["gmail:f000000000000006"], verification: "verified-by-source" });
  write(root, { ...SAM, attribute: "next_step", value: "Pick up at 16:30", as_of: "2026-10-05" }); // she confirms it
  expect(fact(root, "projects/kids-pickup", "next_step")).toMatchObject({ verification: "confirmed-by-co-owner", confirmed_by: "sam-assistant" });
  const r = write(root, { agent: "steward", id: "projects/kids-pickup", attribute: "pickup_time", value: "17:40", as_of: "2026-10-05", sources: ["gmail:f000000000000007"], verification: "verified-by-source" });
  expect(r.outcome).toBe("disputed");
});

test("the nightly pass puts a co-owner's old word up for review instead of forgetting it", async () => {
  const root = household();
  write(root, { ...SAM, attribute: "next_step", value: "Buy the school supplies", as_of: "2026-10-05" });
  const out = await sleep(root, { now: "2027-06-01", steps: { forget: true, consolidate: false } });
  expect(out.retired.map((x) => x.key)).not.toContain("projects/kids-pickup#next_step");
  expect(out.review.map((x) => x.key)).toContain("projects/kids-pickup#next_step");
});

test("a trial co-owner assistant's write outside her areas is refused, not proposed", () => {
  const root = household((p) => { p.agents["sam-assistant"].tier = "trial"; });
  const r = write(root, { ...SAM, id: undefined, title: "Sam's work plan", type: "project", area: "work", attribute: "next_step", value: "x", as_of: "2026-10-05" } as never);
  expect(r.outcome).toBe("refused");
  expect(existsSync(join(root, "inbox")) ? readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml")) : []).toEqual([]);
});

test("a co-owner's assistant named after another area can't read that area", () => {
  // carve shows an agent every note whose area carries its name; her limits must hold anyway.
  expect(() => loadRules(household((p) => { p.agents.work = { tier: "core", slices: ["area:household"] }; p.co_owners.sam.agents = ["work"]; }))).toThrow(/co-owner/);
});

test("her assistant can't retract the owner's word without her word; with it, it can", () => {
  const root = household();
  const r = write(root, { agent: "sam-assistant", id: "projects/kids-pickup", attribute: "pickup_time", value: "15:30", as_of: "2026-10-08", sources: ["agent:sam-assistant"], verification: "self-reported", retract: true });
  expect(r.outcome).not.toBe("committed");
  expect(fact(root, "projects/kids-pickup", "pickup_time")).toMatchObject({ value: "15:30", verification: "confirmed-by-owner" });
  const r2 = write(root, { ...SAM, value: "15:30", as_of: "2026-10-08", retract: true });
  expect(r2.outcome).toBe("committed");
  expect(fact(root, "projects/kids-pickup", "pickup_time")).toBeUndefined();
});

test("an approved read is rechecked against her limits when it is handed over", async () => {
  const approver = { name: "test", start: async () => ({}), poll: async () => ({ state: "waiting" as const }) };
  const root = household((p) => { p.ask_to_see = true; p.agents["sam-assistant"].slices = ["area:household"]; });
  const f = join(root, "projects", "school-forms.md");
  writeFileSync(f, "---\nid: projects/school-forms\ntype: project\ntitle: School forms\narea: household\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: steward\n---\nForms for the school trip.\n");
  // Hidden from her assistant by name, so it is something she can ask for.
  const pf = join(root, "rules", "policy.yaml");
  const p = YAML.parse(readFileSync(pf, "utf8")); p.agents["sam-assistant"].exclude = ["projects/school-forms"]; writeFileSync(pf, YAML.stringify(p));
  Bun.spawnSync(["git", "add", "-A"], { cwd: root }); Bun.spawnSync(["git", "commit", "-qm", "forms"], { cwd: root });
  const ask = await askToSee(root, "sam-assistant", { what: "school forms", why: "trip" }, approver);
  expect(listAsks(root).at(-1)!.candidates.map((c) => c.id)).toContain("projects/school-forms");
  approveAsk(root, ask.request, "projects/school-forms");
  // The owner moves it to work before she reads it: the approval no longer holds for her.
  writeFileSync(f, readFileSync(f, "utf8").replace("area: household", "area: work"));
  Bun.spawnSync(["git", "commit", "-qam", "moved"], { cwd: root });
  let status = 0;
  try { await askStatus(root, "sam-assistant", ask.request, approver); } catch (e: any) { status = e.status; }
  expect(status).toBe(410);
});

test("the owner's word retracts hers (docs drift 2026-10-16)", () => {
  const root = household();
  expect(write(root, { ...SAM, value: "16:00", as_of: "2026-10-08" }).outcome).toBe("committed");
  const r = write(root, { agent: "steward", id: "projects/kids-pickup", attribute: "pickup_time", value: "16:00", as_of: "2026-10-08", sources: ["owner:2026-10-08/dashboard"], verification: "confirmed-by-owner", retract: true });
  expect(r.outcome).toBe("committed");
  expect(fact(root, "projects/kids-pickup", "pickup_time")).toBeUndefined();
});

test("the owner's vaguer date never takes over her more precise one (slice audit of the G148 fix)", () => {
  const root = household();
  expect(write(root, { ...SAM, attribute: "school_trip", value: "2026-11-05", as_of: "2026-10-08" }).outcome).toBe("committed");
  write(root, { agent: "steward", id: "projects/kids-pickup", attribute: "school_trip", value: "2026-11", as_of: "2026-10-08", sources: ["owner:2026-10-08/dashboard"], verification: "confirmed-by-owner" });
  expect(fact(root, "projects/kids-pickup", "school_trip")).toMatchObject({ value: "2026-11-05", verification: "confirmed-by-co-owner", co_owner: "sam" });
});
