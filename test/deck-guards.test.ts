// SPDX-License-Identifier: AGPL-3.0-only
// What must keep the hub from deciding on its own (docs/decision-deck.md): the red team's
// attacks on auto-decide (gaps G78–G89, G126–G131) and the slice audit's missing cases.
import { test, expect } from "bun:test";
import { writeFileSync, readFileSync, readdirSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { loadBrain, type FactRecord } from "../src/brain";
import { buildDeck, runAuto, undoAuto, verdict, sensitiveShape } from "../src/deck";
import { openItems, type Item } from "../src/textline/items";
import { loadEscalation } from "../src/textline/policy";
import { compose } from "../src/textline/message";
import { loadRules } from "../src/rules";
import { checkNewAgent } from "../src/addagent";
import { recordCheckedRefs } from "../src/louis";
import { revokeTokens } from "../src/auth";
import { disputes } from "../src/dashboard/data";
import { git } from "../src/git";
import { addShare } from "../src/share";
import { issueToken } from "../src/auth";
import { propose as proposeConsent } from "../src/consent";
import { thirdPartySensitive } from "../src/checks";

const NOW = new Date();
const days = (d: number) => new Date(NOW.getTime() + d * 86_400_000);
const commit = (root: string, m: string) => {
  Bun.spawnSync(["git", "-C", root, "add", "-A"]);
  Bun.spawnSync(["git", "-C", root, "-c", "user.name=louis", "-c", "user.email=l@x", "commit", "-qm", m]);
};
// rogue: a second direct writer in the work area (the owner's editor), as in the red team's scripts.
function brain(esc = "health: { url: null }\nauto_decide: { proposal_days: 3 }\n") {
  const root = makeBrain();
  writeFileSync(join(root, "rules/escalation.yaml"), esc);
  const pol = join(root, "rules/policy.yaml");
  writeFileSync(pol, readFileSync(pol, "utf8").replace(/^agents:\n/m, "owner_editor: rogue\nagents:\n  rogue: { tier: core, slices: [area:work] }\n"));
  commit(root, "setup");
  return root;
}
const setStatus = (root: string, agent: string, status: string) => {
  const pol = join(root, "rules/policy.yaml");
  writeFileSync(pol, readFileSync(pol, "utf8").replace(new RegExp(`^(  ${agent}: \\{)`, "m"), `$1 status: ${status},`));
  commit(root, `${status} ${agent}`);
};
const room = (root: string) => loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm.facts!.room as FactRecord & { candidates?: FactRecord[] };
const lastDispute = (root: string) => readdirSync(join(root, "disputes")).filter((f) => f.startsWith("c-")).sort().at(-1)!.replace(/\.md$/, "");
const card = (root: string, key: string, at = NOW) => buildDeck(root, at).cards.find((c) => c.key === key);
const set = (root: string, value: string, as_of: string, sources: string[], x: Record<string, unknown> = {}, agent = "planner") =>
  write(root, { agent, id: "projects/course-a", attribute: "room", value, as_of, sources, ...x });
const checked = (root: string, ...refs: string[]) => recordCheckedRefs(root, Object.fromEntries(refs.map((r) => [r, true])));
// A helper's proposal: an outside assistant's, so the only kind of item that can expire.
const propose = (root: string, attribute = "role", value: unknown = "Associate dean") =>
  write(root, { agent: "helper", id: "people/jane-roy", attribute, value, as_of: "2026-10-07", sources: ["gmail:1a0e88a496d9705a"] });
const proposalKey = (root: string) => openItems(root).find((i) => i.kind === "proposal")!.key;
// Whatever an assistant does to a conflict, the hub never settles it: the card has no plan, a year
// of ticks changes nothing, and the fact stays in conflict.
function neverSettled(root: string) {
  const id = lastDispute(root);
  expect(card(root, `dispute:${id}`)!.auto).toBeUndefined();
  const head = git(root, ["rev-parse", "HEAD"]);
  expect(runAuto(root, NOW)).toEqual([]);
  expect(runAuto(root, days(365))).toEqual([]);
  expect(git(root, ["rev-parse", "HEAD"])).toBe(head);
  expect(room(root).candidates?.length).toBeGreaterThanOrEqual(2);
}

// ---------- red team 2026-10-15: conflicts ----------

test("G78 G126 a side the agent marked verified, citing a made-up or merely existing message, never wins by timeout", () => {
  const made = brain();
  set(made, "Room 999 (planted)", "2026-10-06", ["gmail:dead00000000beef"], { verification: "verified-by-source" });
  set(made, "Room 12", "2026-10-07", ["gmail:f000000000000004"]);
  neverSettled(made);
  const real = brain(); // the message exists (the hub's connector found it) but says nothing about rooms
  checked(real, "gmail:f000000000000006");
  set(real, "Room 999 (planted)", "2026-10-06", ["gmail:f000000000000006"], { verification: "verified-by-source" });
  set(real, "Room 12", "2026-10-07", ["gmail:f000000000000004"]);
  neverSettled(real);
});

test("G79 G80 G127 evidence pumped into a side, before or after the conflict opened, or a backdated challenger, never settles it", () => {
  const pump = brain();
  set(pump, "Room A", "2026-10-07", ["gmail:f000000000000006"]);
  set(pump, "Room B", "2026-10-07", ["gmail:f000000000000004"]);
  checked(pump, "gmail:0123456789abcdef");
  set(pump, "Room A", "2026-10-07", ["gmail:0123456789abcdef"], { verification: "verified-by-source" }, "rogue");
  neverSettled(pump);
  const before = brain();
  checked(before, "gmail:f000000000000006");
  set(before, "Room A", "2026-10-06", ["gmail:f000000000000006"]);
  set(before, "Room A", "2026-10-06", ["notion:abc"], { verification: "verified-by-source" }, "rogue");
  set(before, "Room B", "2026-10-07", ["gmail:f000000000000004"]);
  setStatus(before, "rogue", "paused");
  neverSettled(before);
  const back = brain();
  set(back, "Room A", "2026-10-07", ["gmail:f000000000000006"]);
  set(back, "Room B", "2026-10-07", ["gmail:f000000000000004"]);
  set(back, "Room B", "2001-01-01", ["notion:abc"], {}, "rogue");
  neverSettled(back);
});

test("G81 G131 a paused, revoked or removed writer, or none at all, never lets the hub settle a conflict", () => {
  for (const how of ["paused", "revoked", "removed", "active"]) {
    const root = brain();
    checked(root, "gmail:f000000000000006");
    set(root, "Room A", "2026-10-06", ["gmail:f000000000000006"], { verification: "verified-by-source" });
    set(root, "Room B", "2026-10-07", ["gmail:f000000000000004"]);
    set(root, "Room A", "2026-10-08", ["gmail:f000000000000006"], { verification: "verified-by-source" }, "rogue");
    if (how === "paused") setStatus(root, "rogue", "paused");
    if (how === "revoked") revokeTokens(root, "rogue");
    if (how === "removed") {
      const pol = join(root, "rules/policy.yaml");
      writeFileSync(pol, readFileSync(pol, "utf8").replace(/^owner_editor: rogue\n/m, "").replace(/^  rogue: .*\n/m, ""));
      commit(root, "remove rogue");
    }
    neverSettled(root);
  }
});

test("G82 G128 a side citing the owner's texts, or a planted side dated today, never wins by timeout", () => {
  const owner = brain();
  checked(owner, "gmail:f000000000000006");
  set(owner, "Room A", "2026-10-06", ["gmail:f000000000000006"], { verification: "verified-by-source" });
  set(owner, "Room B (Robin texted it)", "2026-10-07", ["imsg:2026-10-07..2026-10-07"]);
  neverSettled(owner);
  const dated = brain();
  checked(dated, "gmail:f000000000000004");
  set(dated, "Room 999 (planted)", "2026-10-08", ["gmail:dead00000000beef"]);
  set(dated, "Room 12", "2026-10-07", ["gmail:f000000000000004"], { verification: "verified-by-source" });
  neverSettled(dated);
});

test("G84 G130 health, legal, money or share_with conflicts are never settled either", () => {
  const root = brain();
  checked(root, "gmail:f000000000000006");
  set(root, "Room A", "2026-10-06", ["gmail:f000000000000006"], { verification: "verified-by-source", share_with: ["planner"] });
  set(root, "Room B", "2026-10-07", ["gmail:f000000000000004"]);
  neverSettled(root);
});

// ---------- red team: proposals and the rest ----------

test("G83 a proposal citing the owner's word, or about health, never expires", () => {
  const root = brain();
  expect(write(root, { agent: "helper", id: "projects/course-a", attribute: "room", value: "Room C (Robin said)", as_of: "2026-10-07", sources: ["imsg:phonemsg-ABCDEFGHIJKLMNOPQRSTUV"] }).outcome).toBe("inbox");
  expect(write(root, { agent: "helper", id: "projects/course-a", attribute: "medical_leave", value: "Approved until December", as_of: "2026-10-07", sources: ["gmail:f000000000000006"] }).outcome).toBe("inbox");
  const props = buildDeck(root, NOW).cards.filter((c) => c.kind === "proposal");
  expect(props.length).toBe(2);
  for (const c of props) expect(c.auto).toBeUndefined();
  expect(runAuto(root, days(30))).toEqual([]);
});

test("G84 G129 health, legal and money words match in French, with accents, and in common English", () => {
  const rules = loadRules(makeBrain());
  for (const t of ["Arrêt jusqu'en décembre (santé)", "rendez-vous à l'école", "facture payé", "IRM lundi", "chimio jeudi", "voir le notaire", "virement IBAN", "therapist on Tuesday", "MRI booked", "call the attorney", "insurance renewal", "EUR 4500", "4500 €", "grossesse", "congé maternité"])
    expect(sensitiveShape(rules, t)).toBeTruthy();
  for (const t of ["Room 12", "Grade the midterm", "Hall B210", "Session 6 moved to Thursday"]) expect(sensitiveShape(rules, t)).toBeUndefined();
  const root = brain();
  propose(root, "note", "Arrêt jusqu'en décembre (santé)");
  expect(card(root, proposalKey(root))!.auto).toBeUndefined();
});

test("G85 a proposal older than the deck gets its full notice from the first time the hub sees it", () => {
  const root = brain();
  propose(root);
  const old = new Date(NOW.getTime() - 21 * 86_400_000).toISOString();
  Bun.spawnSync(["git", "-C", root, "-c", "user.name=louis", "-c", "user.email=l@x", "commit", "--amend", "-q", "--no-edit", "--date", old], { env: { ...process.env, GIT_COMMITTER_DATE: old } });
  const key = proposalKey(root);
  expect(runAuto(root, NOW)).toEqual([]); // first tick: the clock starts now
  expect(Date.parse(card(root, key)!.auto!.at)).toBeGreaterThanOrEqual(NOW.getTime() + 3 * 86_400_000 - 60_000);
  expect(runAuto(root, days(2))).toEqual([]);
  expect(runAuto(root, days(4)).map((d) => d.key)).toEqual([key]);
});

test("G86 undo of an expired proposal works after later writes to the same note", () => {
  const root = brain();
  propose(root);
  const key = proposalKey(root);
  buildDeck(root, NOW);
  expect(runAuto(root, days(4)).length).toBe(1);
  expect(write(root, { agent: "planner", id: "people/jane-roy", attribute: "office", value: "B210", as_of: "2026-10-08", sources: ["gmail:f000000000000005"] }).outcome).not.toBe("refused");
  expect(undoAuto(root, key)).toContain("Undone");
  expect(openItems(root).some((i) => i.key === key)).toBe(true);
});

test("G87 'Still true?' cards never show a private or money fact", () => {
  const root = brain();
  const f = join(root, "projects/course-a.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("verification: verified-by-source, by: planner", "verification: verified-by-source, sensitivity: private, by: planner"));
  commit(root, "private fact");
  const was = process.env.PB_TODAY;
  process.env.PB_TODAY = "2028-01-01";
  const d = buildDeck(root, new Date("2028-01-01T12:00:00Z"));
  process.env.PB_TODAY = was;
  expect(d.cards.some((c) => c.key === "fact:projects/course-a#next_step")).toBe(false);
  expect(d.cards.some((c) => c.kind === "fact")).toBe(true); // other stale facts still come
});

test("G88 the deck link is gone from texts until the phone door lands", () => {
  const root = brain("health: { url: null }\ndeck_url: https://mac.tail1234.ts.net/deck\n");
  set(root, "Room A", "2026-10-06", ["gmail:f000000000000006"]);
  set(root, "Room B", "2026-10-07", ["gmail:f000000000000004"]);
  expect(compose(openItems(root), { maxItems: 5, maxChars: 480 }).text).not.toContain("Swipe:");
  expect(compose(openItems(root), { maxItems: 5, maxChars: 480, link: "https://mac.tail1234.ts.net/deck" } as never).text).not.toContain("ts.net");
});

test("G89 no assistant may be named auto-decide, the hub's own name", () => {
  const root = makeBrain();
  const pol = join(root, "rules/policy.yaml");
  writeFileSync(pol, readFileSync(pol, "utf8").replace(/^agents:\n/m, "agents:\n  auto-decide: { tier: trial, slices: [area:work] }\n"));
  expect(() => loadRules(root)).toThrow(/auto-decide/);
  expect(() => checkNewAgent(loadRules(makeBrain()), { agent: "auto-decide", slices: ["area:work"] } as never)).toThrow(/auto-decide/);
});

// ---------- slice audit 2026-10-15 ----------

test("held mail, captures, relayed answers, alerts, rules, spending, upkeep and conflicts never get a plan", () => {
  const root = brain();
  set(root, "Room A", "2026-10-07", ["gmail:f000000000000006"]);
  set(root, "Room B", "2026-10-07", ["gmail:f000000000000004"]);
  const notes = loadBrain(root);
  const ctx = { notes, disputes: disputes(notes) };
  for (const kind of ["mail", "capture", "held-answer", "alert", "rules", "usage", "upkeep", "dispute"]) {
    const it = { key: `${kind}:x`, kind, title: "x", private: false, money: false, verbs: [], ref: kind === "dispute" ? lastDispute(root) : "x" } as unknown as Item;
    expect("never" in verdict(root, it, loadEscalation(root), ctx, NOW)).toBe(true);
  }
});

test("private or money proposals are never expired", () => {
  const root = brain();
  write(root, { agent: "helper", id: "projects/course-a", attribute: "room_note", value: "x", as_of: "2026-10-07", sources: ["gmail:f000000000000006"], sensitivity: "private" });
  write(root, { agent: "helper", id: "money/main-bank", attribute: "branch", value: "Downtown", as_of: "2026-10-07", sources: ["gmail:f000000000000006"] });
  for (const c of buildDeck(root, NOW).cards.filter((x) => x.kind === "proposal")) expect(c.auto).toBeUndefined();
  const head = git(root, ["rev-parse", "HEAD"]);
  expect(runAuto(root, days(365))).toEqual([]);
  expect(git(root, ["rev-parse", "HEAD"])).toBe(head);
});

test("undo refuses a commit the hub didn't make", () => {
  const root = brain();
  mkdirSync(join(root, "log"), { recursive: true });
  appendFileSync(join(root, "log/auto-decisions.jsonl"), JSON.stringify({ key: "proposal:x.yaml", commit: git(root, ["rev-parse", "HEAD"]), at: NOW.toISOString() }) + "\n");
  const head = git(root, ["rev-parse", "HEAD"]);
  expect(() => undoAuto(root, "proposal:x.yaml")).toThrow(/only the hub's own/);
  expect(git(root, ["rev-parse", "HEAD"])).toBe(head);
});

test("a replica never decides and never undoes", () => {
  const hubMode = (root: string) => {
    writeFileSync(join(root, "rules/hub.yaml"), "hub: home\nepoch: 1\nreplicas: { home: {}, laptop: {} }\n");
    commit(root, "hub mode");
    Bun.spawnSync(["git", "-C", root, "config", "--local", "pocketbrain.replica", "laptop"]);
  };
  const root = brain();
  propose(root);
  const key = proposalKey(root);
  buildDeck(root, NOW);
  expect(runAuto(root, days(4)).length).toBe(1);
  hubMode(root);
  expect(() => undoAuto(root, key)).toThrow(/replica/);
  const r2 = brain();
  propose(r2);
  buildDeck(r2, NOW);
  hubMode(r2);
  const head = git(r2, ["rev-parse", "HEAD"]);
  expect(runAuto(r2, days(365))).toEqual([]);
  expect(git(r2, ["rev-parse", "HEAD"])).toBe(head);
});

// ---------- red team 2026-10-16 ----------

test("G156 auto_decide written as a word, not a map, means off", () => {
  for (const v of ["off", "false", "no", "true", "on", "[]"]) {
    const root = brain(`health: { url: null }\nauto_decide: ${v}\n`);
    expect(loadEscalation(root).auto_decide.off).toBe(true);
  }
  expect(loadEscalation(brain("health: { url: null }\n")).auto_decide.off).toBe(false);
});

test("G157 a proposal that couldn't expire gets its full notice again once it can", () => {
  const root = brain();
  propose(root);
  const key = proposalKey(root);
  expect(runAuto(root, NOW)).toEqual([]); // first seen now
  setStatus(root, "helper", "paused");
  expect(runAuto(root, days(10))).toEqual([]);
  const pol = join(root, "rules/policy.yaml");
  writeFileSync(pol, readFileSync(pol, "utf8").replace(/^(  helper: \{) status: paused,/m, "$1"));
  commit(root, "resume helper");
  expect(runAuto(root, days(11))).toEqual([]); // back: a fresh 3 days, not at once
  expect(runAuto(root, days(15)).map((d) => d.key)).toEqual([key]);
});

test("G157 turning auto-decide off and on again restarts the notice", () => {
  const root = brain();
  propose(root);
  const key = proposalKey(root);
  expect(runAuto(root, NOW)).toEqual([]);
  const esc = join(root, "rules/escalation.yaml");
  writeFileSync(esc, "health: { url: null }\nauto_decide: { off: true, proposal_days: 3 }\n");
  buildDeck(root, days(10));
  expect(runAuto(root, days(10))).toEqual([]);
  writeFileSync(esc, "health: { url: null }\nauto_decide: { proposal_days: 3 }\n");
  expect(runAuto(root, days(11))).toEqual([]);
  expect(runAuto(root, days(15)).map((d) => d.key)).toEqual([key]);
});

test("G158 plurals and the people of health and law count: lawyers, doctors, medications, therapist", () => {
  const rules = loadRules(makeBrain());
  for (const t of ["lawyers", "doctors", "medications", "therapist", "surgeries", "hospitals", "attorneys", "notaires", "médecins", "avocates", "diagnoses", "psychiatrist", "illnesses", "lawsuits", "pregnancies", "invoices", "mortgages", "salaries", "loans", "insurances", "courts", "trials"])
    expect(sensitiveShape(rules, t)).toBeTruthy();
});

// ---------- slice audit 2026-10-16: every door a name comes in by ----------

test("no share, token or consent proposal can use the hub's own name", async () => {
  const root = brain();
  const before = readFileSync(join(root, "rules/policy.yaml"), "utf8");
  expect(() => addShare(root, { agent: "auto-decide", name: "Jo", slices: ["area:work"], days: 7 } as never)).toThrow(/auto-decide/);
  expect(() => issueToken(root, "auto-decide")).toThrow(/isn't an outside agent/);
  await expect(proposeConsent(root, "auto-decide", "help with my course")).rejects.toThrow(/auto-decide/);
  expect(readFileSync(join(root, "rules/policy.yaml"), "utf8")).toBe(before);
});

test("auto_decide settings: proposal_days is at least 3, a bad number keeps 14, a list means off", () => {
  expect(loadEscalation(brain("health: { url: null }\nauto_decide: { proposal_days: 1 }\n")).auto_decide).toEqual({ off: false, proposal_days: 3 });
  expect(loadEscalation(brain("health: { url: null }\nauto_decide: { proposal_days: x }\n")).auto_decide.proposal_days).toBe(14);
  expect(loadEscalation(brain("health: { url: null }\nauto_decide: [a]\n")).auto_decide.off).toBe(true);
});

test("the shared health and school words still make a person's fact private", () => {
  for (const value of ["diagnosis in May", "special education plan", "dette de 2000"]) expect(thirdPartySensitive({ agent: "planner", id: "people/jane-roy", attribute: "note", value } as never)).toBeTruthy();
  expect(thirdPartySensitive({ agent: "planner", id: "people/jane-roy", attribute: "note", value: "likes tea" } as never)).toBeUndefined();
});
