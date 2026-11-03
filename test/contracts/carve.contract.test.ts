// SPDX-License-Identifier: AGPL-3.0-only
// Contract for src/carve.ts, the slice compiler: which notes and facts an agent's grant holds,
// and which values count as carved out. A bug fixed in carve.ts adds a row here.
import { test, expect } from "bun:test";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { makeBrain } from "../fixture";
import { loadBrain } from "../../src/brain";
import { loadRules } from "../../src/rules";
import { carve, grantFor } from "../../src/carve";
import * as core from "../../src/core";
import * as semantic from "../../src/semantic";
import { withTokenRole } from "../../src/tokenrole";
import { moreThanToday } from "../../src/consent";
import { appendFileSync } from "node:fs";

const SRC = `sources: ["gmail:f000000000000009"], verification: verified-by-source, by: steward, recorded: 2026-10-01`;
function note(root: string, id: string, fm: string, facts = "", body = "", by = "steward") {
  const p = join(root, `${id}.md`);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `---\nid: ${id}\ntitle: ${id}\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: ${by}\n${fm}\n${facts ? `facts:\n${facts}\n` : ""}---\n${body}\n`);
}
const carveFor = (root: string, agent: string, slices?: string[]) => {
  const rules = loadRules(root);
  return carve(loadBrain(root), rules, grantFor(rules, agent, slices));
};

// A brain with one note per carve rule, on top of the fixture.
function brain() {
  const root = makeBrain();
  note(root, "disputes/c-0001", "type: dispute\narea: work\nsensitivity: personal\nstatus: open");
  note(root, "projects/old-course", "type: project\narea: work\nsensitivity: personal\nstatus: merged");
  note(root, "projects/decoy", "type: project\narea: probe\nsensitivity: personal\nstatus: active");
  note(root, "projects/helper-tools", "type: project\narea: helper\nsensitivity: personal\nstatus: active", "", "Helper's own notes.", "helper");
  // G176: a note someone else put in an area named after helper is not helper's own.
  note(root, "projects/helper-handed", "type: project\narea: helper\nsensitivity: personal\nstatus: active", "", "Steward's note, area named after helper.");
  note(root, "agents/helper/profile", "type: capability\narea: helper\nsensitivity: personal\nstatus: active", "", "What helper does (written by the owner).", "owner");
  note(root, "projects/course-c", "type: project\narea: work\nsensitivity: personal\nstatus: active",
    `  next_step: { value: Book the room, as_of: 2026-10-01, ${SRC} }\n` +
    `  room_code: { value: Door 4417, as_of: 2026-10-01, sensitivity: private, ${SRC} }\n` +
    `  steward_only: { value: Ask the dean, as_of: 2026-10-01, share_with: [steward], ${SRC} }\n` +
    `  loosened: { value: Public bit, as_of: 2026-10-01, sensitivity: public, ${SRC} }`);
  note(root, "projects/garden", "type: project\narea: personal\nsensitivity: personal\nstatus: active",
    `  next_step: { value: Repaint the fence shed, as_of: 2026-10-01, ${SRC} }`);
  return root;
}

test("contract carve: a note is in or out of a grant for exactly these reasons (invariant 1)", () => {
  const root = brain();
  const rows: [agent: string, id: string, expected: "in" | RegExp][] = [
    ["helper", "people/jane-roy", "in"],
    ["helper", "money/main-bank", /type money not shared/], // exclude_types
    ["helper", "decisions/2026-09-01-pick-bank", /above helper's ceiling/], // tier ceiling
    ["helper", "people/paul-advisor", /excluded tag/], // slice exclude_tags
    ["helper", "projects/helper-tools", "in"], // an agent always sees what it wrote in its own area
    ["helper", "agents/helper/profile", "in"], // ...and its own capability notes, whoever wrote them
    ["helper", "projects/helper-handed", /no slice selects it/], // G176: an area named after it isn't its own
    ["helper", "projects/garden", /no slice selects it/],
    ["nobody", "projects/course-a", /no slices granted/], // an agent not in policy holds nothing
    ["steward", "money/main-bank", "in"],
    ["steward", "disputes/c-0001", /conflict packet/], // even slice `all` never gets a dispute
    ["steward", "projects/old-course", /status merged/], // merge pointers never go out
    ["steward", "projects/decoy", /probe area/], // `all` never reaches the probe area
  ];
  const cache = new Map<string, ReturnType<typeof carveFor>>();
  for (const [agent, id, expected] of rows) {
    if (!cache.has(agent)) cache.set(agent, carveFor(root, agent));
    const res = cache.get(agent)!;
    if (expected === "in") expect(res.visible.has(id), `${agent} ${id}`).toBe(true);
    else {
      expect(res.visible.has(id), `${agent} ${id}`).toBe(false);
      expect(res.excluded.find((e) => e.id === id)?.reason, `${agent} ${id}`).toMatch(expected);
    }
  }
});

test("contract carve: per-fact flags only hide, never reveal (invariant 4)", () => {
  const root = brain();
  const rows: [agent: string, key: string, hidden: RegExp | false][] = [
    ["helper", "projects/course-c#next_step", false],
    ["helper", "projects/course-c#room_code", /fact is private/], // fact sensitivity above ceiling
    ["planner", "projects/course-c#room_code", false], // planner's ceiling is private
    ["planner", "projects/course-c#steward_only", /only steward/], // share_with not naming the agent
    ["steward", "projects/course-c#steward_only", false],
    ["helper", "projects/course-c#loosened", false], // a "public" fact is shown...
  ];
  for (const [agent, key, hidden] of rows) {
    const h = carveFor(root, agent).hiddenFacts.find((x) => x.key === key);
    if (hidden) expect(h?.reason, `${agent} ${key}`).toMatch(hidden);
    else expect(h, `${agent} ${key}`).toBeUndefined();
  }
  // ...but a fact flagged public never lifts its note over the ceiling or out of an excluded type.
  note(root, "money/main-bank", "type: money\narea: personal\nsensitivity: private\nstatus: active", `  bank: { value: Maple Trust Bank, as_of: 2026-10-04, sensitivity: public, ${SRC} }`);
  expect(carveFor(root, "helper").visible.has("money/main-bank")).toBe(false);
  expect(carveFor(root, "nobody").visible.has("money/main-bank")).toBe(false);
});

test("contract carve: only_attributes narrows facts and drops the body unless bodies: true", () => {
  const root = brain();
  const res = carveFor(root, "helper", ["contacts-basic"]);
  const jane = res.visible.get("people/jane-roy")!;
  expect(jane.body).toBe(false);
  expect(res.hiddenFacts.find((h) => h.key === "people/jane-roy#phones")?.reason).toBe("attribute not in slice");
  expect(res.hiddenFacts.find((h) => h.key === "people/jane-roy#role")).toBeUndefined();
});

test("contract carve: a reader token caps the ceiling below private, whatever the agent's own", () => {
  const root = brain();
  const rows: [role: "reader" | undefined, sees: boolean][] = [[undefined, true], ["reader", false]];
  for (const [role, sees] of rows)
    expect(withTokenRole("steward", role, () => carveFor(root, "steward")).visible.has("money/main-bank"), String(role)).toBe(sees);
});

test("contract carve: an unknown slice name fails closed, it never widens or empties silently", () => {
  const root = brain();
  expect(() => carveFor(root, "helper", ["area:work", "no-such-slice"])).toThrow("unknown slice(s): no-such-slice");
});

test("contract carve: values carved out on purpose are listed for scrubbing; others are a known limit", () => {
  const root = brain();
  const rows: [agent: string, value: string, carved: boolean][] = [
    ["helper", "Maple Trust Bank", true], // fact of an excluded type
    ["helper", "via the bank app > Cards > Replace", true],
    ["helper", "Door 4417", true], // a hidden fact's value
    ["planner", "Ask the dean", true], // share_with hides it, so it's carved
    ["steward", "Maple Trust Bank", false], // shown to the agent: nothing to scrub
    // Known limit: a note merely outside the agent's areas isn't carved, so its values aren't scrubbed.
    ["planner", "Repaint the fence shed", false],
  ];
  for (const [agent, value, carved] of rows)
    expect(carveFor(root, agent).carvedValues.includes(value), `${agent} ${value}`).toBe(carved);
  // Known limit: short values (< 4 chars) and stop words ("open", "done") are never carved.
  note(root, "projects/course-c", "type: project\narea: work\nsensitivity: personal\nstatus: active",
    `  code: { value: Q7, as_of: 2026-10-01, sensitivity: private, ${SRC} }\n  state: { value: open, as_of: 2026-10-01, sensitivity: private, ${SRC} }`);
  const res = carveFor(root, "helper");
  expect(res.hiddenFacts.map((h) => h.key)).toEqual(expect.arrayContaining(["projects/course-c#code", "projects/course-c#state"]));
  expect(res.carvedValues).not.toContain("Q7");
  expect(res.carvedValues).not.toContain("open");
});

test("contract carve: a hidden note answers exactly like a missing one (invariant 3)", () => {
  const root = brain();
  const same = (hidden: string, missing: string, f: (id: string) => string) =>
    expect(f(hidden).replace(hidden, "X")).toBe(f(missing).replace(missing, "X"));
  const read = (agent: string) => (id: string) => { try { core.readNote(root, agent, id); return "found"; } catch (e) { return (e as Error).message; } };
  const rows: [agent: string, hidden: string, missing: string][] = [
    ["helper", "money/main-bank", "money/no-such"], // excluded type
    ["helper", "decisions/2026-09-01-pick-bank", "decisions/2026-09-02-no-such"], // above ceiling
    ["helper", "people/paul-advisor", "people/no-such"], // outside every slice
    ["steward", "disputes/c-0001", "disputes/c-9999"], // never in any view
    ["steward", "projects/decoy", "projects/no-such"], // probe decoy
  ];
  for (const [agent, hidden, missing] of rows) {
    expect(read(agent)(hidden), `${agent} ${hidden}`).not.toBe("found");
    same(hidden, missing, read(agent));
  }
  // Search: a hidden note's title answers exactly as it would if the note were titled with a word
  // that's nowhere. Related words (the word map) may still find visible notes, but never because
  // of the hidden one. (Removing the note instead would also lift the scrub of its bank name from
  // the prose of notes Helper sees.)
  const renamed = brain();
  const f = join(renamed, "money/main-bank.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("title: Main bank", "title: Zzyzx nowhere"));
  expect(core.search(root, "helper", "Main bank")).toEqual(core.search(renamed, "helper", "Main bank"));
  expect(core.search(root, "helper", "Zzyzx nowhere")).toEqual(core.search(root, "helper", "Qqvwx elsewhere"));
});

// G367: the same with semantic search on (a stub embedder, every view's vectors computed first):
// the meaning ranking runs over the asker's own view, so the hidden note still answers like one
// titled with a word that's nowhere, for its title and for words near it in meaning.
test("contract carve: with semantic search on, a hidden note answers exactly like a missing one (invariant 3)", async () => {
  const dim = (w: string) => { let h = 7; for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 32; };
  const stub: semantic.Embedder = { id: "stub", embed: async (xs) => xs.map((x) => { const v = new Float32Array(32); for (const w of x.toLowerCase().split(/[^a-z]+/).filter(Boolean)) v[dim(w)] += 1; const n = Math.hypot(...v) || 1; return v.map((y) => y / n); }) };
  semantic.useEmbedder(stub);
  try {
    const root = brain();
    const renamed = brain();
    const f = join(renamed, "money/main-bank.md");
    writeFileSync(f, readFileSync(f, "utf8").replace("title: Main bank", "title: Zzyzx nowhere"));
    await core.vectorsReady(root);
    await core.vectorsReady(renamed);
    for (const q of ["Main bank", "bank", "course money budget", "Zzyzx nowhere"]) {
      const o = { vector: (await stub.embed([q]))[0] };
      expect(core.search(root, "helper", q, 20, {}, o), q).toEqual(core.search(renamed, "helper", q, 20, {}, o));
      expect(core.contextPack(root, "helper", q, o), q).toEqual(core.contextPack(renamed, "helper", q, o));
    }
    expect(core.search(root, "helper", "bank", 20, {}, { vector: (await stub.embed(["bank"]))[0] }).length).toBeGreaterThan(0);
  } finally { semantic.useEmbedder(undefined); }
});

// G179: "only tighten" (the CLI's carve --confirm and consent --apply) compares what the agent would
// receive, not just note ids: a scrub it loses or a fact a slice held back is a widening.
test("contract carve: only-tighten counts every widening, a lost scrub and an unhidden fact included", () => {
  const root = brain();
  appendFileSync(join(root, "rules/slices.yaml"), "  work-no-phones:\n    areas: [work]\n    exclude_attributes: [phones]\n  work-nob:\n    areas: [work]\n    exclude: [projects/course-b]\n");
  const rows: [agent: string, slices: string[], excludeTypes: string[], widens: boolean][] = [
    ["planner", ["area:work", "contacts-basic"], ["money"], false], // today's slice
    ["planner", ["area:work"], ["money"], false], // fewer notes
    ["planner", ["area:work", "contacts-basic"], [], true], // money values no longer scrubbed from prose (G179a)
    ["helper", ["area:work", "contacts-basic", "area:personal"], ["money"], true], // more notes
    ["planner", ["work-nob"], [], true], // G228: money no longer left out, though no note shows more today
    ["planner", ["work-nob"], ["money"], false],
  ];
  const widens = (agent: string, slices: string[], ex: string[]) => Object.values(moreThanToday(loadBrain(root), loadRules(root), agent, { slices, exclude_types: ex })).some((n) => (Array.isArray(n) ? n.length : n) > 0);
  for (const [agent, slices, ex, w] of rows) expect(widens(agent, slices, ex), `${agent} ${slices} -${ex}`).toBe(w);
  // A slice-level exclude_attributes (G179b): today work-no-phones, then area:work shows the phones.
  const pol = join(root, "rules/policy.yaml");
  writeFileSync(pol, readFileSync(pol, "utf8").replace("helper: { tier: trial, slices: [area:work, contacts-basic]", "helper: { tier: trial, slices: [work-no-phones]"));
  expect(widens("helper", ["area:work"], ["money"])).toBe(true);
  expect(widens("helper", ["work-no-phones"], ["money"])).toBe(false);
});

// G248: a new slice must be covered by one of today's, at least as narrow on every selector;
// today's notes can't prove it (no finance-tagged note today doesn't mean none tomorrow).
test("contract carve: only-tighten decides a slice swap on selectors, not on today's notes", () => {
  const root = brain();
  appendFileSync(join(root, "rules/slices.yaml"), [
    "  w-notag: { areas: [work], exclude_tags: [finance] }", "  w-personal: { areas: [work], max_sensitivity: personal }",
    "  w-projects: { areas: [work], types: [projects] }", "  w-recent: { areas: [work], since: 2026-09-01 }",
    "  w-tagged: { areas: [work], tags: [teaching] }", "  w-a: { include: [projects/course-a] }", "  w-plain: { areas: [work] }", ""].join("\n"));
  const pol = join(root, "rules/policy.yaml");
  const set = (slices: string) => writeFileSync(pol, readFileSync(pol, "utf8").replace(/planner: \{ tier: core, aliases: \[Planbot\], slices: \[[^\]]*\]/, `planner: { tier: core, aliases: [Planbot], slices: [${slices}]`));
  const loose = (to: string) => moreThanToday(loadBrain(root), loadRules(root), "planner", { slices: [to], exclude_types: ["money"] }).loosened.some((l) => l.includes(`${to} is wider`));
  const rows: [today: string, to: string, wider: boolean][] = [
    ["w-notag", "w-plain", true], ["w-personal", "w-plain", true], ["w-projects", "w-plain", true],
    ["w-recent", "w-plain", true], ["w-tagged", "w-plain", true], ["w-a", "w-plain", true],
    ["w-plain", "w-notag", false], ["w-plain", "w-personal", false], ["w-plain", "w-projects", false],
    ["w-plain", "w-recent", false], ["w-plain", "w-tagged", false], ["w-plain", "w-plain", false],
    ["area:work, contacts-basic", "contacts-basic", false], ["w-plain", "area:personal", true],
  ];
  for (const [today, to, wider] of rows) { set(today); expect(loose(to), `${today} -> ${to}`).toBe(wider); }
  // all covers every slice.
  expect(moreThanToday(loadBrain(root), loadRules(root), "steward", { slices: ["w-plain"], exclude_types: [] }).loosened).toEqual([]);
});

test("contract carve: share_with on any record hides the fact, not only on the first (G170)", () => {
  const root = brain();
  note(root, "projects/course-d", "type: project\narea: work\nsensitivity: personal\nstatus: active",
    `  rooms: { items: [{ value: Room A, as_of: 2026-10-01, ${SRC} }, { value: Room Secret, as_of: 2026-10-01, share_with: [steward], ${SRC} }] }\n` +
    `  nickname: { dispute: c-0002, candidates: [{ value: Kiki, as_of: 2026-10-01, share_with: [planner, steward], ${SRC} }, { value: Hidden Name, as_of: 2026-10-01, share_with: [steward], ${SRC} }] }`);
  const res = carveFor(root, "planner");
  for (const key of ["projects/course-d#rooms", "projects/course-d#nickname"])
    expect(res.hiddenFacts.find((h) => h.key === key)?.reason, key).toMatch(/only steward/);
  expect(carveFor(root, "steward").hiddenFacts.find((h) => h.key.startsWith("projects/course-d#"))).toBeUndefined();
  expect(JSON.stringify(core.readNote(root, "planner", "projects/course-d"))).not.toMatch(/Room Secret|Hidden Name/);
});

test("contract carve: a merged note's names stay carved unless the note it merged into shows them (G204)", () => {
  const root = brain();
  note(root, "people/j-roy", "type: person\narea: work\nsensitivity: private\nstatus: merged\nmerged_into: people/jane-roy\naliases: [Jaybird Nightshade, Jane]");
  const res = carveFor(root, "helper");
  expect(res.carvedValues).toContain("Jaybird Nightshade");
  expect(res.carvedValues).not.toContain("Jane"); // shown as Jane Roy's alias, so not a secret here
});

test("contract carve: a merged note's values stay carved while the note it merged into is kept out on purpose (G217)", () => {
  const root = brain();
  note(root, "people/sam-lee", "type: person\narea: personal\nsensitivity: private\nstatus: active");
  note(root, "people/sam-lee-2", "type: person\narea: personal\nsensitivity: personal\nstatus: merged\nmerged_into: people/sam-lee",
    `  home_address: { value: 12 Hidden Lane, as_of: 2026-10-01, ${SRC} }`);
  // helper's ceiling (personal) keeps the private target out; steward sees it, where the value shows.
  expect(carveFor(root, "helper", ["area:work"]).carvedValues).toContain("12 Hidden Lane");
  expect(carveFor(root, "steward").carvedValues).not.toContain("12 Hidden Lane");
});

test("contract carve: a merged note is carved like the active note at the end of its chain of merges (G246)", () => {
  const root = brain();
  note(root, "people/jay-roy", "type: person\naliases: [Jaybird Roy]\narea: work\nsensitivity: personal\nstatus: merged\nmerged_into: people/j-roy-b");
  note(root, "people/j-roy-b", "type: person\naliases: [Jaybird Roy]\narea: work\nsensitivity: personal\nstatus: merged\nmerged_into: people/jane-roy");
  // jane-roy shows Jaybird Roy to planner only once the merges have put it there.
  const f = join(root, "people/jane-roy.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("aliases: [Jane]", "aliases: [Jane, Jaybird Roy]"));
  expect(carveFor(root, "planner").carvedValues).not.toContain("Jaybird Roy");
  // A chain that loops never resolves to a shown note: its names stay carved.
  note(root, "people/loop-a", "type: person\naliases: [Loopy Larkspur]\narea: work\nsensitivity: personal\nstatus: merged\nmerged_into: people/loop-b");
  note(root, "people/loop-b", "type: person\narea: work\nsensitivity: personal\nstatus: merged\nmerged_into: people/loop-a");
  expect(carveFor(root, "planner").carvedValues).toContain("Loopy Larkspur");
});

test("contract carve: a merged note is carved like the note it merged into; merely out of slice carves nothing (G227)", () => {
  const root = brain();
  note(root, "people/sam-lee", "type: person\narea: personal\nsensitivity: personal\nstatus: active");
  note(root, "people/sam-lee-2", "type: person\naliases: [Samwise Leeward]\narea: personal\nsensitivity: personal\nstatus: merged\nmerged_into: people/sam-lee",
    `  home_address: { value: 12 Hidden Lane, as_of: 2026-10-01, ${SRC} }`);
  const out = carveFor(root, "helper", ["area:work"]).carvedValues; // neither note is in helper's slices
  expect(out).not.toContain("12 Hidden Lane");
  expect(out).not.toContain("Samwise Leeward");
});

test("contract carve: names: false (the merge backstop, G261) skips only the title copies; what is carved is the same", () => {
  const root = brain();
  const rules = loadRules(root), notes = loadBrain(root);
  for (const agent of ["planner", "helper"]) {
    const full = carve(notes, rules, grantFor(rules, agent), { flags: false });
    const bare = carve(notes, rules, grantFor(rules, agent), { flags: false, names: false });
    expect(bare.carvedValues).toEqual(full.carvedValues);
    expect([...bare.visible.keys()]).toEqual([...full.visible.keys()]);
    expect(bare.hiddenFacts).toEqual(full.hiddenFacts);
  }
});

test("contract carve: the names pass tries only values whose first words a name holds, with the same result (G265 backstop speed)", () => {
  const root = brain();
  note(root, "money/acct", "type: money\narea: personal\nsensitivity: private\nstatus: active\naliases: [Maple Trust Bank, Café Roy, +1 514 555 0199]");
  for (const [id, t] of [["projects/t1", "Lunch at Maple-Trust Bank"], ["projects/t2", "Café Roy dinner"], ["projects/t3", "Call +1 514 555 0199"], ["projects/t4", "Maple syrup"]] as const)
    note(root, id, `type: project\narea: work\nsensitivity: personal\nstatus: active\naliases: [${t}]`);
  const res = carveFor(root, "helper");
  const shown = (id: string) => res.visible.get(id)!.note.fm.aliases![0];
  expect(shown("projects/t1")).not.toContain("Maple-Trust Bank");
  expect(shown("projects/t2")).toBe("[withheld] dinner");
  expect(shown("projects/t3")).not.toContain("514 555 0199");
  expect(shown("projects/t4")).toBe("Maple syrup");
});

// The incremental carve (docs/perf.md) remembers each frozen note's place per grant. A narrowing
// that changes the note, or the grant, must never leave a remembered answer standing.
test("contract carve: a remembered carve narrows exactly like a cold one", () => {
  const root = makeBrain({ git: false });
  const warm = () => { const rules = loadRules(root); return carve(loadBrain(root, { shared: true }), rules, grantFor(rules, "helper"), { flags: false }); };
  const cold = () => { const rules = loadRules(root); return carve(structuredClone(loadBrain(root)), rules, grantFor(rules, "helper"), { flags: false }); };
  const seen = (r: ReturnType<typeof carve>) => JSON.stringify([[...r.visible.keys()], r.hiddenFacts, r.carvedValues]);
  expect(warm().visible.has("people/jane-roy")).toBe(true);
  const p = join(root, "people/jane-roy.md");
  writeFileSync(p, readFileSync(p, "utf8").replace("sensitivity: personal", "sensitivity: private"));
  expect(warm().visible.has("people/jane-roy")).toBe(false);
  expect(seen(warm())).toBe(seen(cold()));
  writeFileSync(p, readFileSync(p, "utf8").replace("sensitivity: private", "sensitivity: personal"));
  warm();
  const policy = join(root, "rules/policy.yaml");
  writeFileSync(policy, readFileSync(policy, "utf8").replace("helper: { tier: trial, slices: [area:work, contacts-basic], exclude_types: [money] }", "helper: { tier: trial, slices: [area:work, contacts-basic], exclude_types: [money], exclude: [people/jane-roy#role] }"));
  expect(warm().hiddenFacts.map((h) => h.key)).toContain("people/jane-roy#role");
  expect(seen(warm())).toBe(seen(cold()));
});

test("contract carve: a remembered carve follows an edit to the own slice (slice audit F1)", () => {
  const root = makeBrain({ git: false });
  const warm = () => { const rules = loadRules(root); return carve(loadBrain(root, { shared: true }), rules, grantFor(rules, "helper"), { flags: false }); };
  const p = join(root, "people/jane-roy.md");
  writeFileSync(p, readFileSync(p, "utf8").replace("area: work", "area: helper").replace(/^by: planner$/m, "by: helper"));
  expect(warm().visible.get("people/jane-roy")?.slices).toContain("own");
  expect(warm().hiddenFacts.map((h) => h.key)).not.toContain("people/jane-roy#role");
  const slices = join(root, "rules/slices.yaml");
  writeFileSync(slices, readFileSync(slices, "utf8") + "  own:\n    exclude_attributes: [role]\n");
  expect(warm().hiddenFacts.map((h) => h.key)).toContain("people/jane-roy#role");
});

// Phone UI spec §7 (owner 2026-10-26): a value held for the owner's eyes reaches no agent, not even
// one granted everything; once seen it serves like any other.
test("must never: a value marked unseen reaches any agent's carve", () => {
  const root = makeBrain();
  note(root, "projects/held", "type: project\narea: work\nsensitivity: personal\nstatus: active",
    `  fee: { value: 900 a term, as_of: 2026-10-01, unseen: true, ${SRC} }\n  room: { value: B-12, as_of: 2026-10-01, ${SRC} }`);
  for (const agent of ["steward", "planner"]) {
    const res = carveFor(root, agent);
    expect(res.hiddenFacts.find((h) => h.key === "projects/held#fee")?.reason).toBe("waiting for the owner to see it");
    expect(res.hiddenFacts.some((h) => h.key === "projects/held#room")).toBe(false);
  }
});

// Builder's slice audits of claude/family-links (b532242, b1619f30; G546): the hub's family fact
// on a page never carries the ref of a fact some reader of that fact can't read, however it is
// hidden: share_with, held unseen, an exclude by name, or a slice's exclude_attributes.
test("contract carve: a hub-made family fact carries no ref of a fact its readers can't read (G546)", async () => {
  const { linkFamily } = await import("../../src/family");
  const hiders: { name: string; fact: string; policy?: (s: string) => string; slices?: (s: string) => string }[] = [
    { name: "share_with", fact: "share_with: [steward]" },
    { name: "unseen", fact: "unseen: true" },
    { name: "exclude by name", fact: "", policy: (s) => s.replace("exclude_types: [money] }", `exclude_types: [money], exclude: ["people/alain-lake#hidden"] }`) },
    { name: "slice exclude_attributes", fact: "", policy: (s) => s.replace("helper: { tier: trial, slices: [area:work, contacts-basic], exclude_types: [money] }", "helper: { tier: trial, slices: [nohidden], exclude_types: [money] }"), slices: (s) => s.replace("slices:\n", "slices:\n  nohidden:\n    areas: [work]\n    exclude_attributes: [hidden]\n    max_sensitivity: personal\n") },
  ];
  for (const h of hiders) {
    const root = makeBrain();
    const pol = join(root, "rules", "policy.yaml");
    writeFileSync(pol, (h.policy ?? ((s: string) => s))(readFileSync(pol, "utf8").replace("owner: { name: Robin }", "owner: { name: Robin, aliases: [Robin Lake] }")) + "family_links: true\n");
    if (h.slices) { const sl = join(root, "rules", "slices.yaml"); writeFileSync(sl, h.slices(readFileSync(sl, "utf8"))); }
    const page = (slug: string, title: string, more = "") => writeFileSync(join(root, "people", `${slug}.md`), `---\nid: people/${slug}\ntype: person\ntitle: ${title}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-28\nupdated: 2026-10-28\nby: steward\nfacts:\n  city: { value: Lyon, as_of: 2026-10-28, sources: ["gmail:f000000000000042"], verification: verified-by-source, by: steward, recorded: 2026-10-28 }\n${more}---\n`);
    page("robin-lake", "Robin Lake");
    page("alain-lake", "Alain Lake", `  hidden: { value: Sekrit, as_of: 2026-10-28, sources: ["url:https://clinic.example/hidden-ref"], verification: verified-by-source, by: steward, recorded: 2026-10-28${h.fact ? `, ${h.fact}` : ""} }\n`);
    Bun.spawnSync(["git", "add", "-A"], { cwd: root }); Bun.spawnSync(["git", "-c", "user.name=steward", "-c", "user.email=s@x", "commit", "-qm", "steward: pages"], { cwd: root });
    linkFamily(root);
    const fam = loadBrain(root).find((n) => n.fm.id === "people/alain-lake")!.fm.facts?.family as { sources?: unknown[] } | undefined;
    expect(JSON.stringify(fam?.sources ?? []), h.name).not.toContain("hidden-ref");
  }
});

// Builder's slice audit of da6497e0 (F6, G546): a tightening after the family link is filed holds
// at once for every reader: the family fact copied no ref of the tightened fact.
test("contract carve: a fact tightened after the family link leaves no ref of it on the page (G546)", async () => {
  const { linkFamily } = await import("../../src/family");
  const { saveNote } = await import("../../src/brain");
  const root = makeBrain();
  const pol = join(root, "rules", "policy.yaml");
  writeFileSync(pol, readFileSync(pol, "utf8").replace("owner: { name: Robin }", "owner: { name: Robin, aliases: [Robin Lake] }") + "family_links: true\n");
  const page = (slug: string, title: string, more = "") => writeFileSync(join(root, "people", `${slug}.md`), `---\nid: people/${slug}\ntype: person\ntitle: ${title}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-28\nupdated: 2026-10-28\nby: steward\nfacts:\n  city: { value: Lyon, as_of: 2026-10-28, sources: ["gmail:f000000000000042"], verification: verified-by-source, by: steward, recorded: 2026-10-28 }\n${more}---\n`);
  page("robin-lake", "Robin Lake");
  page("alain-lake", "Alain Lake", `  diagnosis: { value: Sekrit, as_of: 2026-10-28, sources: ["url:https://clinic.example/later-hidden"], verification: verified-by-source, by: steward, recorded: 2026-10-28 }\n`);
  Bun.spawnSync(["git", "add", "-A"], { cwd: root }); Bun.spawnSync(["git", "-c", "user.name=steward", "-c", "user.email=s@x", "commit", "-qm", "steward: pages"], { cwd: root });
  expect(linkFamily(root).filed).toEqual(["people/alain-lake"]);
  const n = loadBrain(root).find((x) => x.fm.id === "people/alain-lake")!;
  (n.fm.facts!.diagnosis as { share_with?: string[] }).share_with = ["steward"];
  saveNote(root, n);
  for (const agent of ["planner", "helper"]) expect(JSON.stringify(core.readNote(root, agent, "people/alain-lake")), agent).not.toContain("later-hidden");
});

test("contract carve: a by-name exclude hides the page's twins too, same folder, type, title and area (G657)", () => {
  const root = makeBrain();
  const page = (id: string, title: string, area: string) => {
    mkdirSync(join(root, "projects"), { recursive: true });
    writeFileSync(join(root, `${id}.md`), `---\nid: ${id}\ntype: project\ntitle: ${title}\narea: ${area}\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: steward\nfacts:\n  place: { value: Quellmoor slipway, ${SRC} }\n---\nAbout ${title}.\n`);
  };
  page("projects/harbour-refit", "Harbour refit", "work");
  page("projects/harbour-refit-2", "Harbour  REFIT ", "work"); // a twin: case and spacing differ
  page("projects/harbour-refit-3", "Harbour refit", "personal"); // another area: not a twin
  page("projects/harbour-paint", "Harbour paint", "work");
  const p = join(root, "rules/policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace("planner: { tier: core, aliases: [Planbot], slices: [area:work, contacts-basic]", "planner: { tier: core, aliases: [Planbot], slices: [area:work, area:personal, contacts-basic], exclude: [projects/harbour-refit]"));
  const rules = loadRules(root);
  // Rows: id -> excluded reason (undefined = visible), cold carve and remembered carve alike.
  const rows: [string, string | undefined][] = [
    ["projects/harbour-refit", "excluded by name"],
    ["projects/harbour-refit-2", "excluded by name"],
    ["projects/harbour-refit-3", undefined],
    ["projects/harbour-paint", undefined],
  ];
  const frozen = loadBrain(root).map((n) => Object.freeze(n));
  for (const res of [carve(loadBrain(root), rules, grantFor(rules, "planner")), carve(frozen, rules, grantFor(rules, "planner"), { flags: false })])
    for (const [id, reason] of rows) expect([id, res.excluded.find((e) => e.id === id)?.reason, res.visible.has(id)]).toEqual([id, reason, !reason]);
});

test("must never: an agent's own new page tells it whether a same-title page kept from it by name exists (G657, slice audit F1)", () => {
  const seen = (hidden: boolean) => {
    const root = makeBrain();
    const p = join(root, "rules/policy.yaml");
    writeFileSync(p, readFileSync(p, "utf8").replace("planner: { tier: core, aliases: [Planbot], slices: [area:work, contacts-basic]", "planner: { tier: core, aliases: [Planbot], slices: [area:work, contacts-basic], exclude: [projects/harbour-refit]"));
    if (hidden) {
      mkdirSync(join(root, "projects"), { recursive: true });
      writeFileSync(join(root, "projects/harbour-refit.md"), `---\nid: projects/harbour-refit\ntype: project\ntitle: Harbour refit\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: steward\nfacts:\n  place: { value: Quellmoor slipway, ${SRC} }\n---\nAbout Harbour refit.\n`);
    }
    const r = core.remember(root, "planner", { title: "Harbour refit", type: "project", area: "work", attribute: "budget_note", value: "Ask the yard for a quote", as_of: "2026-10-08", sources: ["gmail:f000000000000044"], verification: "verified-by-source" } as never);
    const hits = core.search(root, "planner", "Harbour refit").map((h) => h.title);
    return { outcome: r.outcome, hits };
  };
  expect(seen(true)).toEqual(seen(false));
  expect(seen(false).hits).toEqual(["Harbour refit"]);
});
