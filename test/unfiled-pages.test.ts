// SPDX-License-Identifier: AGPL-3.0-only
// A page not filed yet (follow-up to G841, coordinator ruling 2026-11-15): a new page whose area
// came only from the default has no evidence about who may read it, so no assistant reads it
// because it reads personal. Only a slice that would read it in every area does (all, or every area
// listed), or one that lists it by id; area, type and tag slices do not. The mark lifts when the
// source gets an area (the page moves there, with Undo) or the owner moves it.
import { test, expect, afterAll } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { git } from "../src/git";
import { loadBrain } from "../src/brain";
import { loadRules } from "../src/rules";
import { carve, grantFor } from "../src/carve";
import { capture } from "../src/capture";
import { readNote, search } from "../src/core";
import { makeModel, type ModelRequest } from "../src/model";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const fakeModel = (facts: unknown[]) => makeModel({ provider: "fake", model: "fake-1" }, { fake: (_r: ModelRequest) => JSON.stringify({ facts }) });

// Areas work (first) and personal; "home" reads only area:personal, "people" reads people anywhere.
function brain(): string {
  const root = makeBrain();
  roots.push(root);
  const policy = join(root, "rules", "policy.yaml");
  writeFileSync(policy, readFileSync(policy, "utf8")
    .replace("  helper: {", "  home: { tier: core, slices: [area:personal] }\n  people: { tier: core, slices: [people-any] }\n  every: { tier: core, slices: [area:personal, area:work] }\n  helper: {"));
  const slices = join(root, "rules", "slices.yaml");
  writeFileSync(slices, readFileSync(slices, "utf8").replace("slices:\n", "slices:\n  people-any:\n    types: [people]\n"));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "rules"]);
  return root;
}
const unfiledPage = (root: string, mark = "true") => {
  writeFileSync(join(root, "people/marco-bellini.md"), `---\nid: people/marco-bellini\ntype: person\ntitle: Marco Bellini\narea: personal\nsensitivity: personal\nstatus: active\ncreated: 2026-10-02\nupdated: 2026-10-02\nby: steward\nunfiled: ${mark}\nfacts:\n  role:\n    value: driver\n    as_of: 2026-10-02\n    sources: [gmail:f000000000000901]\n    verification: verified-by-source\n    by: steward\n    recorded: 2026-10-02\n---\n`);
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "page"]);
};
const sees = (root: string, agent: string) => carve(loadBrain(root), loadRules(root), grantFor(loadRules(root), agent)).visible.has("people/marco-bellini");

test("a page from a capture with no source area is proposed with the not-filed-yet mark", async () => {
  const root = brain();
  const r = await capture(root, { kind: "text", text: "Your driver Marco Bellini is on his way." }, fakeModel([
    { entity: "Marco Bellini", type: "person", attribute: "role", value: "driver", quote: "Your driver Marco Bellini" },
  ]));
  const p = YAML.parse(readFileSync(join(root, r.items[0].proposal!), "utf8"));
  expect(p.request.area).toBe("personal");
  expect(p.request.unfiled).toBeTruthy();
});

test("a page not filed yet is read only by a slice that reads every area, never through personal, a type or a tag", () => {
  const root = brain();
  unfiledPage(root);
  expect(sees(root, "home")).toBe(false);
  expect(sees(root, "people")).toBe(false);
  expect(sees(root, "steward")).toBe(true);
  expect(sees(root, "every")).toBe(true);
  // Hidden answers like missing.
  const missing = (() => { try { return JSON.stringify(readNote(root, "home", "people/nobody-here")); } catch (e) { return String((e as Error).message).replace("nobody-here", "X"); } })();
  const hidden = (() => { try { return JSON.stringify(readNote(root, "home", "people/marco-bellini")); } catch (e) { return String((e as Error).message).replace("marco-bellini", "X"); } })();
  expect(hidden).toBe(missing);
  expect(search(root, "home", "Marco Bellini").map((h) => h.id)).not.toContain("people/marco-bellini");
  // The same page without the mark: personal reads it as before.
  unfiledPage(root, "false");
  expect(sees(root, "home")).toBe(true);
});

test("the mark lifts when its source gets an area: the page moves there, filed, and Undo puts back both", async () => {
  const root = brain();
  unfiledPage(root, "mail-home");
  const { fileUnfiled } = await import("../src/area-guess");
  const { readDiary } = await import("../src/diary");
  const { undoFact } = await import("../src/undo");
  // No sources.yaml line yet, or one with no area: nothing moves.
  writeFileSync(join(root, "rules/sources.yaml"), "sources:\n  mail-home: { kind: gmail }\n");
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "sources"]);
  expect(fileUnfiled(root)).toEqual([]);
  writeFileSync(join(root, "rules/sources.yaml"), "sources:\n  mail-home: { kind: gmail, area: work }\n");
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "sources: area"]);
  expect(fileUnfiled(root).map((m) => m.to)).toEqual(["work"]);
  const n = loadBrain(root).find((x) => x.fm.id === "people/marco-bellini")!;
  expect([n.fm.area, n.fm.unfiled]).toEqual(["work", undefined]);
  expect(sees(root, "planner")).toBe(true);
  const row = readDiary(root).find((r) => r.kind === "moved" && r.fact_key === "people/marco-bellini#")!;
  expect(undoFact(root, row.undo_token!).outcome).toBe("undone");
  const back = loadBrain(root).find((x) => x.fm.id === "people/marco-bellini")!;
  expect([back.fm.area, back.fm.unfiled]).toEqual(["personal", "mail-home"]);
  expect(sees(root, "home")).toBe(false);
});

test("an agent's own write may ask its new page not filed yet, but never names a source to move it by", async () => {
  const root = brain();
  const { write } = await import("../src/write");
  const r = write(root, { agent: "steward", title: "Dana Okafor", type: "person", area: "personal", attribute: "role", value: "neighbour", as_of: "2026-10-02", sources: ["gmail:f000000000000902"], verification: "verified-by-source", unfiled: "mail-home" });
  expect(r.outcome).toBe("committed");
  const n = loadBrain(root).find((x) => x.fm.title === "Dana Okafor")!;
  expect(n.fm.unfiled).toBe(true);
});

// The leak oracle (evals/lib/oracle.ts) works the rule out from rules/ alone. Checked here against
// the carve on the built-in slices as the rules loader makes them (all and area:<x>, each kept as
// slices.yaml redefines it) and on each form of the mark (proof thread's read, 2026-11-15).
test("the leak oracle and the carve agree on a page not filed yet, built-in slices redefined or not, every form of the mark", async () => {
  const { carvedFor } = await import("../evals/lib/oracle");
  const root = brain();
  const policy = join(root, "rules", "policy.yaml");
  writeFileSync(policy, readFileSync(policy, "utf8").replace("  helper: {", "  narrowall: { tier: core, slices: [all] }\n  typedwork: { tier: core, slices: [area:personal, area:work] }\n  byid: { tier: core, slices: [area:personal, one-page] }\n  helper: {"));
  const cases = (all: string, work: string) => {
    const slices = join(root, "rules", "slices.yaml");
    writeFileSync(slices, readFileSync(join(root, "rules", "slices.yaml"), "utf8").replace(/\n  # t-start[\s\S]*# t-end/, "")
      .replace("slices:\n", `slices:\n  # t-start\n  one-page:\n    include: [people/marco-bellini]\n${all}${work}  # t-end\n`));
    git(root, ["add", "-A"]); git(root, ["commit", "-qm", "slices"]);
  };
  const agents = ["home", "people", "every", "steward", "narrowall", "typedwork", "byid"];
  const verdicts = async () => {
    const out: Record<string, [boolean, boolean]> = {};
    for (const a of agents) out[a] = [sees(root, a), !(await carvedFor(root, a)).carved.some((c) => c.id === "people/marco-bellini" && c.whole)];
    return out;
  };
  for (const [all, work] of [["", ""], ["  all:\n    areas: [personal]\n", "  area:work:\n    types: [people]\n"]]) {
    cases(all, work);
    for (const mark of ["true", "mail-home", "false", '""']) {
      unfiledPage(root, mark);
      const v = await verdicts();
      for (const a of agents) expect([a, mark, all !== "", v[a][1]]).toEqual([a, mark, all !== "", v[a][0]]);
      const filed = mark === "false" || mark === '""';
      // Redefined, `all` names one area and area:work selects by type: neither reads every area.
      expect([mark, v.home[0], v.every[0], v.narrowall[0], v.typedwork[0], v.byid[0]]).toEqual([mark, filed, filed || all === "", filed || all === "", filed || all === "", true]);
    }
  }
});

// Slice audit 2026-11-15: an assistant's proposal could carry a source name in its mark, and the
// owner's or the hub's accept kept it, so the night pass would later move the page to an area the
// assistant picked. Only the hub's own capture proposal names a source; an accepted assistant
// proposal is marked true.
test("an assistant's proposal naming a source in its mark is filed with the mark true, whoever accepts it", async () => {
  const { write, decideProposal } = await import("../src/write");
  const { fileUnfiled } = await import("../src/area-guess");
  for (const by of ["owner", "auto-decide"]) {
    const root = brain();
    writeFileSync(join(root, "rules/sources.yaml"), "sources:\n  mail-home: { kind: gmail, area: personal }\n");
    git(root, ["add", "-A"]); git(root, ["commit", "-qm", "sources"]);
    const r = write(root, { agent: "helper", title: "Rita Moreau", type: "person", area: "work", attribute: "role", value: "courier", as_of: "2026-10-02", sources: ["gmail:f000000000000903"], verification: "verified-by-source", unfiled: "mail-home" });
    expect(r.outcome).toBe("inbox");
    const file = (r as { proposal?: string; file?: string }).proposal ?? (r as { file?: string }).file ?? (r as { message: string }).message.match(/inbox\/\S+\.yaml/)![0];
    const d = decideProposal(root, file, "accept", by);
    expect([by, d.outcome]).toEqual([by, "committed"]);
    const n = loadBrain(root).find((x) => x.fm.title === "Rita Moreau")!;
    expect([by, n.fm.unfiled, n.fm.area]).toEqual([by, true, "work"]);
    expect(fileUnfiled(root)).toEqual([]);
  }
});

// Security review, 2026-11-15: a slice with only a filter (a level, an attribute list, a date) and
// no area counted as reading every area, so it let the grant's area:personal read a page not filed
// yet in full. Only slices that read their areas whole count toward every area; a filter-only slice
// still reads the page itself, under its own filter.
test("a filter-only slice never lets an area slice read a page not filed yet", async () => {
  const { carvedFor } = await import("../evals/lib/oracle");
  const root = brain();
  const policy = join(root, "rules", "policy.yaml");
  writeFileSync(policy, readFileSync(policy, "utf8").replace("  helper: {", "  pubplus: { tier: core, slices: [area:personal, public-only] }\n  roleplus: { tier: core, slices: [area:personal, roles-only] }\n  helper: {"));
  const slices = join(root, "rules", "slices.yaml");
  writeFileSync(slices, readFileSync(slices, "utf8").replace("slices:\n", "slices:\n  public-only:\n    max_sensitivity: public\n  roles-only:\n    only_attributes: [title]\n"));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "slices"]);
  unfiledPage(root);
  for (const a of ["pubplus", "roleplus"]) {
    const res = carve(loadBrain(root), loadRules(root), grantFor(loadRules(root), a));
    const v = res.visible.get("people/marco-bellini");
    const role = !!v && (v.attributes === "all" || v.attributes.has("role")) && !res.hiddenFacts.some((h) => h.key === "people/marco-bellini#role");
    expect([a, role]).toEqual([a, false]);
    const out = (await carvedFor(root, a)).carved.some((c) => c.id === "people/marco-bellini" && c.whole);
    // The oracle never calls the page out where the carve serves it (that would be a false leak).
    expect([a, "oracle never stricter", out && !!v]).toEqual([a, "oracle never stricter", false]);
  }
});

// Slice audit of the delta, 2026-11-15: a slice that lists pages and also filters (include with a
// level) reads every page under its filter in every area (sliceRejects), so it reads a page not
// filed yet under that filter, like any slice with no area of its own; carve and oracle agree.
test("a slice of a list plus a level reads a page not filed yet under its level, like any slice with no area", async () => {
  const { carvedFor } = await import("../evals/lib/oracle");
  const root = brain();
  const policy = join(root, "rules", "policy.yaml");
  writeFileSync(policy, readFileSync(policy, "utf8").replace("  helper: {", "  listlevel: { tier: core, slices: [list-level] }\n  listlow: { tier: core, slices: [list-low] }\n  helper: {"));
  const slices = join(root, "rules", "slices.yaml");
  writeFileSync(slices, readFileSync(slices, "utf8").replace("slices:\n", "slices:\n  list-level:\n    include: [people/someone-else]\n    max_sensitivity: personal\n  list-low:\n    include: [people/someone-else]\n    max_sensitivity: public\n"));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "slices"]);
  unfiledPage(root);
  expect(sees(root, "listlevel")).toBe(true);
  expect(sees(root, "listlow")).toBe(false);
  for (const a of ["listlevel", "listlow"]) {
    const out = (await carvedFor(root, a)).carved.some((c) => c.id === "people/marco-bellini" && c.whole);
    expect([a, out && sees(root, a)]).toEqual([a, false]);
  }
});
