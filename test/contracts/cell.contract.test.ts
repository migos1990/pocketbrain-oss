// SPDX-License-Identifier: AGPL-3.0-only
// Contract for src/cell.ts: an agent's cell holds its carved slice and nothing else, and reads
// through it answer like the hub. A bug fixed in cell.ts adds a row here.
import { test, expect, afterEach, spyOn } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { makeBrain } from "../fixture";
import { loadBrain } from "../../src/brain";
import { loadRules } from "../../src/rules";
import * as rulesModule from "../../src/rules";
const realLoadRules = rulesModule.loadRules;
import { carve, grantFor } from "../../src/carve";
import { useCells, buildCell, buildCells, cellDir, cellsDir, cellInfo, cellGeneration, freshCell, startCells, buildReaderCell, readerCellDir } from "../../src/cell";
import { restoreCells } from "../cells";
import * as core from "../../src/core";
import { handle } from "../../src/server";
import { issueToken, revokeTokens } from "../../src/auth";

afterEach(restoreCells);

const SRC = `sources: ["gmail:f000000000000009"], verification: verified-by-source, by: steward, recorded: 2026-10-01`;
function note(root: string, id: string, fm: string, facts = "", body = "") {
  const p = join(root, `${id}.md`);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `---\nid: ${id}\ntitle: ${id}\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: steward\n${fm}\n${facts ? `facts:\n${facts}\n` : ""}---\n${body}\n`);
}
const git = (root: string, args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
const policy = (root: string, from: string, to: string) => {
  const p = join(root, "rules/policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace(from, to));
};
const files = (dir: string) => readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name))).sort();
const cellText = (root: string, agent: string) => files(cellDir(root, agent)).map((f) => f + "\n" + readFileSync(join(cellDir(root, agent), f), "utf8")).join("\n");

// The fixture plus a note that carries every kind of thing a cell must strip.
function brain() {
  const root = makeBrain();
  note(root, "projects/course-c", "type: project\narea: work\nsensitivity: personal\nstatus: active\nsuperseded_by: money/main-bank",
    `  next_step: { value: Book the room, as_of: 2026-10-01, share_with: [planner, helper, steward], ${SRC} }\n` +
    `  room_code: { value: Door 4417, as_of: 2026-10-01, sensitivity: private, ${SRC} }`,
    "Pay via Maple Trust Bank, see [[money/main-bank]] and [[projects/course-a]].");
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "course-c"]);
  return root;
}

test("contract cell: a cell holds exactly the agent's carve, note for note (invariant 10)", () => {
  const root = brain();
  buildCells(root);
  const rules = loadRules(root), notes = loadBrain(root);
  for (const agent of ["steward", "planner", "helper", "gardener"]) {
    const want = [...carve(notes, rules, grantFor(rules, agent)).visible.keys()].map((id) => `${id}.md`).sort();
    const held = files(cellDir(root, agent)).filter((f) => !f.startsWith("rules/") && f !== "cell.json");
    expect(held, agent).toEqual(want);
  }
});

test("contract cell: a cell names no other agent and holds nothing carved (invariant 10)", () => {
  const root = brain();
  buildCells(root);
  const helper = cellText(root, "helper");
  const rows: [pattern: RegExp, present: boolean][] = [
    [/\b(steward|planner|gardener)\b/i, false], // fact `by`, share_with and policy name only helper
    [/^by:/m, false],
    [/share_with:\s*\[?\s*-?\s*helper\s*\]?/, true],
    [/money\/main-bank|money\//, false], // links and superseded_by to hidden notes
    [/superseded_by: redacted/, true],
    [/Pay via \[withheld\], see \[\[redacted\]\] and \[\[projects\/course-a\]\]/, true],
    [/Maple Trust Bank|Door 4417|room_code/, false], // carved values and hidden facts
    [/history:|legacy:/, false],
  ];
  for (const [p, present] of rows) expect(p.test(helper), String(p)).toBe(present);
  // The cell's own policy: this agent alone, at its own ceiling, owning no areas.
  const pol = readFileSync(join(cellDir(root, "helper"), "rules/policy.yaml"), "utf8");
  expect(pol).toContain("max_sensitivity: personal");
  expect(pol).toMatch(/areas: \{\}/);
  expect(readFileSync(join(cellsDir(root), ".gitignore"), "utf8")).toBe("*\n"); // derived, never committed
});

test("contract cell: through the cell a hidden note answers like a missing one, as on the hub (invariant 3)", () => {
  const root = brain();
  const read = (id: string) => { try { core.readNote(root, "helper", id); return "found"; } catch (e) { return (e as Error).message; } };
  const rows: [hidden: string, missing: string][] = [
    ["money/main-bank", "money/no-such"],
    ["decisions/2026-09-01-pick-bank", "decisions/2026-09-02-no-such"],
    ["people/paul-advisor", "people/no-such"],
  ];
  for (const on of [false, true]) {
    useCells(on);
    for (const [hidden, missing] of rows) {
      expect(read(hidden), `${on} ${hidden}`).not.toBe("found");
      expect(read(hidden).replace(hidden, "X"), `${on} ${hidden}`).toBe(read(missing).replace(missing, "X"));
    }
  }
});

test("contract cell: kill switches and missing grants hold with cells on (invariant 8)", () => {
  const root = brain();
  useCells(true);
  core.contextPack(root, "helper"); // the cell exists
  policy(root, "helper: { tier: trial,", "helper: { status: paused, tier: trial,");
  const rows: [what: string, fn: () => unknown, err: string][] = [
    ["paused agent reads its built cell", () => core.readNote(root, "helper", "projects/course-a"), "paused"],
    ["paused agent searches", () => core.search(root, "helper", "course"), "paused"],
    ["unknown agent gets no cell", () => buildCell(root, "nobody"), "nobody has no grant"],
  ];
  for (const [what, fn, err] of rows) expect(fn, what).toThrow(err);
});

test("contract cell: a stale cell is rebuilt before it's read, a current one is not", () => {
  const root = brain();
  freshCell(root, "planner");
  const rows: [what: string, change: () => void, slices: string[] | undefined, rebuilt: boolean][] = [
    ["nothing changed", () => {}, undefined, false],
    ["brain committed", () => { note(root, "projects/course-d", "type: project\narea: work\nsensitivity: personal\nstatus: active"); git(root, ["add", "-A"]); git(root, ["commit", "-qm", "d"]); }, undefined, true],
    ["slices narrowed (OpenFGA)", () => {}, ["contacts-basic"], true],
  ];
  // "Rebuilt" means brought up to date: after a commit the cell may be updated in place
  // (affectedBy), so the test reads the cell's build number and commit, not a wiped directory.
  for (const [what, change, slices, rebuilt] of rows) {
    change();
    const gen = cellGeneration(cellDir(root, "planner"));
    const { info } = freshCell(root, "planner", slices);
    expect(cellGeneration(cellDir(root, "planner")) !== gen, what).toBe(rebuilt);
    expect(info.brain_commit, what).toBe(git(root, ["rev-parse", "--short", "HEAD"]).stdout.toString().trim());
    if (slices) expect(info.slices, what).toEqual(slices);
  }
});

// Narrowings that take the full-rebuild path (slice audit of claude/read-after-write): after each,
// the narrowed note is gone from the cell, a read answers exactly as for a missing id, and the
// cell is byte for byte what a fresh build makes.
test("contract cell: a narrowing (by-name exclude, a sensitivity raise) leaves the cell as a fresh build would", () => {
  const read = (root: string, id: string) => { try { core.readNote(root, "helper", id); return "found"; } catch (e) { return (e as Error).message.replaceAll(id, "<id>"); } };
  const rows: [what: string, narrow: (root: string) => void][] = [
    ["by-name exclude", (root) => policy(root, "helper: { tier: trial, slices: [area:work, contacts-basic], exclude_types: [money] }", "helper: { tier: trial, slices: [area:work, contacts-basic], exclude_types: [money], exclude: [people/jane-roy] }")],
    ["sensitivity raised to secret", (root) => { const p = join(root, "people/jane-roy.md"); writeFileSync(p, readFileSync(p, "utf8").replace("sensitivity: personal", "sensitivity: secret")); }],
  ];
  for (const [what, narrow] of rows) {
    const root = brain();
    useCells(true);
    buildCells(root);
    expect(existsSync(join(cellDir(root, "helper"), "people/jane-roy.md")), what).toBe(true);
    expect(read(root, "people/jane-roy"), what).toBe("found");
    narrow(root);
    git(root, ["add", "-A"]); git(root, ["commit", "-qm", "louis: narrow"]);
    buildCell(root, "helper");
    expect(existsSync(join(cellDir(root, "helper"), "people/jane-roy.md")), what).toBe(false);
    expect(read(root, "people/jane-roy"), what).toBe(read(root, "people/no-such-person"));
    const updated = cellText(root, "helper");
    buildCells(root);
    expect(updated, what).toBe(cellText(root, "helper"));
    useCells(false);
  }
});

test("contract cell: a revoked agent's cell stays until it leaves the policy, but no token reaches it", async () => {
  const root = brain();
  useCells(true);
  const tok = issueToken(root, "helper");
  const get = async () => (await handle(root, new Request("http://pb/v1/notes/projects%2Fcourse-a", { headers: { authorization: `Bearer ${tok}` } }))).status;
  expect(await get()).toBe(200);
  revokeTokens(root, "helper");
  buildCells(root);
  expect(await get()).toBe(401);
});

// A restart (launchd kickstart, an auto-update) must answer fast at 50k notes, so the hub keeps
// current cells on disk instead of rebuilding them all at start (backlog row 217). A cell built
// by other code (an upgrade that changed how cells are scrubbed) is never served: rebuilt first.
test("contract cell: at start, current cells are kept, removed agents' cells go, and a cell built by other code is rebuilt", () => {
  const root = brain();
  buildCells(root);
  const marker = (agent: string) => join(cellDir(root, agent), "marker");
  for (const a of ["planner", "helper"]) { writeFileSync(marker(a), "x"); buildReaderCell(root, a); }
  policy(root, "  helper: { tier: trial, slices: [area:work, contacts-basic], exclude_types: [money] }\n", "");
  startCells(root);
  expect(existsSync(cellDir(root, "helper"))).toBe(false);
  // The sealed edge's reader cells follow the same rule (G249).
  expect(existsSync(readerCellDir(root, "planner"))).toBe(true);
  expect(existsSync(readerCellDir(root, "helper"))).toBe(false);
  expect(existsSync(marker("planner"))).toBe(true); // not rebuilt at start
  freshCell(root, "planner");
  expect(existsSync(marker("planner"))).toBe(true); // current: served as is
  const f = join(cellDir(root, "planner"), "cell.json");
  writeFileSync(f, readFileSync(f, "utf8").replace(/"code": "[^"]*"/, '"code": "older-build"'));
  freshCell(root, "planner");
  expect(existsSync(marker("planner"))).toBe(false); // built by other code: rebuilt before a read
});

test("contract cell: at start, an uncommitted note edit drops the kept cells, so a raised note isn't served from an old cell", () => {
  const root = brain();
  buildCells(root);
  expect(existsSync(join(cellDir(root, "planner"), "projects/course-a.md"))).toBe(true);
  // The owner raises a note by hand and restarts the hub without committing.
  const p = join(root, "projects/course-a.md");
  writeFileSync(p, readFileSync(p, "utf8").replace(/^sensitivity: \w+$/m, "sensitivity: secret"));
  startCells(root);
  freshCell(root, "planner");
  expect(existsSync(join(cellDir(root, "planner"), "projects/course-a.md"))).toBe(false);
});

test("contract cell: a torn cell.json (a crash mid-write) means no cell: the next read builds it", () => {
  const root = brain();
  buildCells(root);
  const f = join(cellDir(root, "planner"), "cell.json");
  writeFileSync(f, readFileSync(f, "utf8").slice(0, 20));
  expect(cellInfo(root, "planner")).toBeUndefined();
  expect(freshCell(root, "planner").info.agent).toBe("planner");
});

test("contract cell: removing an agent from policy removes its cell", () => {
  const root = brain();
  buildCells(root);
  expect(cellInfo(root, "helper")?.agent).toBe("helper");
  policy(root, "  helper: { tier: trial, slices: [area:work, contacts-basic], exclude_types: [money] }\n", "");
  buildCells(root);
  expect(cellInfo(root, "helper")).toBeUndefined();
  expect(existsSync(cellDir(root, "helper"))).toBe(false);
});

test("contract cell: a rules edit during a build never leaves the cell stamped as current (G106)", () => {
  const root = makeBrain();
  useCells(true);
  const p = join(root, "rules", "policy.yaml");
  const before = readFileSync(p, "utf8");
  const after = before.replace("exclude_types: [money] }\n  # Keeps", "exclude_types: [money], exclude: [projects/course-a] }\n  # Keeps");
  expect(after).not.toBe(before);
  // The owner's editor saves rules/ right after the build has read them.
  const spy = spyOn(rulesModule, "loadRules").mockImplementation((r: string) => { const out = realLoadRules(r); writeFileSync(p, after); return out; });
  try { buildCell(root, "planner"); } finally { spy.mockRestore(); }
  // The cell was carved from the old rules, so the next read must rebuild it and apply the exclude.
  const outcome = () => { try { core.readNote(root, "planner", "projects/course-a"); return "served"; } catch (e) { return (e as Error).message; } };
  expect(outcome()).not.toBe("served");
});

test("contract cell: an uncommitted fact-level exclude vanishes after two builds and comes back on revert", () => {
  const root = brain();
  useCells(true);
  buildCell(root, "planner");
  expect(cellText(root, "planner")).toContain("Book the room");
  const p = join(root, "rules", "policy.yaml");
  const orig = readFileSync(p, "utf8");
  const edited = orig.replace("exclude_types: [money] }\n  # Keeps", "exclude_types: [money], exclude: [projects/course-c#next_step] }\n  # Keeps");
  expect(edited).not.toBe(orig);
  writeFileSync(p, edited);
  freshCell(root, "planner"); freshCell(root, "planner");
  expect(cellText(root, "planner")).not.toContain("Book the room");
  writeFileSync(p, orig);
  freshCell(root, "planner");
  expect(cellText(root, "planner")).toContain("Book the room");
});

test("contract cell: a link to a merged note holds the note it became while that is in the slice, and no id once it leaves, also updated in place (G266)", () => {
  const root = makeBrain();
  policy(root, "helper: { tier: trial, slices: [area:work, contacts-basic]", "helper: { tier: trial, slices: [area:work]");
  note(root, "people/p-77", "type: person\narea: work\nsensitivity: personal\nstatus: merged\nmerged_into: people/jane-roy");
  note(root, "projects/lunch", "type: project\narea: work\nsensitivity: personal\nstatus: active\nsuperseded_by: people/p-77", "", "See [[people/p-77]].");
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "x"]);
  useCells(true);
  core.readNote(root, "helper", "projects/lunch");
  const file = () => readFileSync(join(cellDir(root, "helper"), "projects/lunch.md"), "utf8");
  expect(file()).toContain("See [[people/jane-roy]].");
  expect(file()).toContain("superseded_by: people/jane-roy");
  const f = join(root, "people/jane-roy.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("area: work", "area: personal"));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "y"]);
  expect(core.readNote(root, "helper", "projects/lunch").body).toBe("See [[redacted]].\n");
  expect(file()).not.toContain("jane-roy");
  expect(file()).not.toContain("p-77");
});

// The in-place update trusts only a cell this code built, judged by that cell's own cell.json:
// a reader cell (G249) built by other code is rebuilt from nothing, whatever the agent's own cell says.
test("contract cell: a reader cell is never updated in place on the agent cell's code stamp", () => {
  const root = brain();
  buildCell(root, "planner");
  const { dir } = buildReaderCell(root, "planner");
  const f = join(dir, "cell.json");
  writeFileSync(f, readFileSync(f, "utf8").replace(/"code": "[^"]*"/, '"code": "old"'));
  writeFileSync(join(dir, "marker"), "x");
  const p = join(root, "projects/course-a.md");
  writeFileSync(p, readFileSync(p, "utf8").replace("title: Course A", "title: Course A renamed"));
  git(root, ["commit", "-qam", "rename"]);
  buildReaderCell(root, "planner");
  expect(existsSync(join(dir, "marker"))).toBe(false);
  expect(readFileSync(join(dir, "projects/course-a.md"), "utf8")).toContain("Course A renamed");
});

test("contract cell: the owner's context budget holds with cells on, for everyone and per agent (G309)", () => {
  const root = brain();
  policy(root, "\nagents:", "\ncontext_budget: { context_pack: 900, whats_new: 700 }\nagents:");
  policy(root, "helper: { tier: trial,", "helper: { tier: trial, context_budget: { context_pack: 340 },");
  useCells(true);
  const { contextBudget } = require("../../src/context");
  core.contextPack(root, "helper"); // builds the cell
  const r = realLoadRules(cellDir(root, "helper"));
  expect(contextBudget(r, "helper")).toMatchObject({ context_pack: 340, whats_new: 700 });
  const p = core.contextPack(root, "helper");
  expect(p).toMatch(/over your context budget of 340 tokens/);
  const reads = readFileSync(join(root, "log", "reads.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.op === "context_pack");
  expect(reads.at(-1).cut).toBeGreaterThan(0);
  // A cell names no other agent: the budget copied in is this agent's own and the global one.
  expect(cellText(root, "helper")).not.toMatch(/planner|steward/);
});

test("contract cell: a page's parent outside the slice and a carved value in its summary never reach the cell (wiki, docs/wiki.md)", () => {
  const root = makeBrain();
  const f = join(root, "people", "jane-roy.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("aliases: [Jane]", "aliases: [Jane]\nsummary: Banks with Maple Trust Bank.\nparent: money/main-bank"));
  buildCell(root, "helper");
  const helper = cellText(root, "helper");
  expect(helper).toContain("Jane Roy");
  expect(helper).not.toContain("money/main-bank");
  expect(helper).not.toContain("Maple Trust");
});

// ---- sealed cells at the edge (src/edge.ts) ----
// Semgrep 2026-10-31 (G588): AES-GCM opened with any tag length, so a sealed bundle whose tag was
// cut to 4 bytes still opened under Node: a forgery in about 2^32 tries. Bun's crypto happens to
// refuse a short tag, so the hub's runtime was not open, but the code relied on it. Every GCM cipher
// in edge.ts names authTagLength 16 and open() refuses any other length itself.
test("every AES-GCM cipher in edge.ts fixes its tag at 16 bytes, and open() checks the length itself", () => {
  const src = readFileSync(join(import.meta.dir, "..", "..", "src", "edge.ts"), "utf8");
  const calls = src.split("\n").filter((l) => /create(?:Dec|C)ipheriv\(\s*"aes-256-gcm"/.test(l));
  expect(calls.length).toBeGreaterThanOrEqual(2);
  for (const c of calls) expect([c, /authTagLength:\s*16\b/.test(c)]).toEqual([c, true]);
  expect(src).toMatch(/tag\.length !== 16/);
});
test("a sealed edge cell never opens with a tag cut short, and opens with its full tag", async () => {
  const { mkdtempSync, readFileSync: read } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { enroll, publish, openBundle } = await import("../../src/edge");
  const was = process.env.PB_CONFIG_DIR;
  process.env.PB_CONFIG_DIR = join(mkdtempSync(join(tmpdir(), "pb-edge-home-")), "keys");
  try {
    const root = makeBrain();
    const token = enroll(root, "steward");
    const out = mkdtempSync(join(tmpdir(), "pb-edge-out-"));
    publish(root, out);
    const b = JSON.parse(read(join(out, "steward.json"), "utf8"));
    expect(openBundle(b, token)).toBeDefined();
    for (const n of [4, 8, 12, 15]) {
      const cut = structuredClone(b);
      for (const k of Object.keys(cut.wraps)) cut.wraps[k].tag = Buffer.from(cut.wraps[k].tag, "base64").subarray(0, n).toString("base64");
      expect([n, openBundle(cut, token)]).toEqual([n, undefined]);
      const cells = structuredClone(b);
      for (const k of Object.keys(cells.cells)) cells.cells[k].tag = Buffer.from(cells.cells[k].tag, "base64").subarray(0, n).toString("base64");
      expect([n, openBundle(cells, token)]).toEqual([n, undefined]);
    }
  } finally { if (was === undefined) delete process.env.PB_CONFIG_DIR; else process.env.PB_CONFIG_DIR = was; }
});

// PR 30 slice audit (G607 through cells): a note's cell file states another page's fact (the
// writer's members, sources and See also sentences). When that fact turns hidden, the incremental
// update rebuilt only the page that holds it, so the org's cell kept the sentence. A note linking a
// note whose hidden facts changed is rebuilt too.
test("contract cell: another page's fact turning hidden reaches every cell file that states it", () => {
  useCells(true);
  const root = makeBrain();
  note(root, "people/ana-diaz", "type: person\narea: work\nsensitivity: personal", `  org: { value: "[[orgs/north-college]]", as_of: 2026-10-05, ${SRC} }`);
  note(root, "orgs/north-college", "type: org\narea: work\nsensitivity: personal", "", "[[people/ana-diaz|Ana Diaz]] works at North College.[^p-at-ana-diaz]\n\n[^p-at-ana-diaz]: Email, 2026-10-05 (gmail:f000000000000009)");
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "louis: fixture"]);
  const body = () => (core.readNote(root, "helper", "orgs/north-college") as { body?: string }).body ?? "";
  expect(body()).toContain("works at North College");
  const p = join(root, "people/ana-diaz.md");
  writeFileSync(p, readFileSync(p, "utf8").replace("as_of: 2026-10-05,", "as_of: 2026-10-05, share_with: [steward],"));
  git(root, ["commit", "-qam", "louis: keep ana's org to the steward"]);
  expect(body()).not.toContain("works at North College");
  expect(body()).not.toContain("gmail:f000000000000009");
});

test("contract cell: a next step the calendar serves after the cell was built is scrubbed like the cell's text (G765)", async () => {
  const { pullSource } = await import("../../src/pull");
  const YAML = (await import("yaml")).default;
  const root = makeBrain();
  const f = join(root, "projects", "course-a.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("value: Grade the midterm, as_of: 2026-10-01", "value: Grade the midterm by 2026-10-05, as_of: 2026-10-01"));
  writeFileSync(join(root, "cal.json"), JSON.stringify([{ id: "next1", etag: '"2"', status: "confirmed", summary: "Course A fees with Maple Trust Bank", start: { dateTime: "2026-10-14T18:30:00-04:00" } }]));
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { cal: { kind: "gcal", fixture: "cal.json", upcoming: true } } }));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "calendar"]);
  useCells(true);
  buildCells(root);
  await pullSource(root, "cal", { model: null });
  const helper = JSON.stringify(core.readNote(root, "helper", "projects/course-a"));
  expect(helper).toContain("(from the calendar)");
  expect(helper).not.toContain("Maple Trust");
  expect(JSON.stringify(core.readNote(root, "steward", "projects/course-a"))).toContain("Course A fees with Maple Trust Bank");
});

// G810 (found by the nightly slice check, seeds 7042, 7238 and 7288): the agent's own cell holds
// text scrubbed for the agent, and a link by title is gone from it by then, so a reader token's
// narrower carve over that cell could not tell which page a sentence names.
test("contract cell: a reader token reads from a cell carved for it, so a page above its ceiling is not named by the pages that link it (G810)", async () => {
  const root = brain();
  const ref = `as_of: 2026-10-01, ${SRC}`;
  mkdirSync(join(root, "money"), { recursive: true });
  writeFileSync(join(root, "money/quellmere-fund.md"), `---\nid: money/quellmere-fund\ntype: money\ntitle: Quellmere Fund\narea: work\nsensitivity: private\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: steward\nfacts:\n  balance: { value: "CAD 7,731.20", ${ref} }\n---\n`);
  writeFileSync(join(root, "projects/course-q.md"), `---\nid: projects/course-q\ntype: project\ntitle: Course Q\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: steward\nfacts:\n  partner: { value: "[[Quellmere Fund]]", ${ref} }\n---\nThe partner of Course Q is Quellmere Fund.\n`);
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "fund"]);
  const read = async (token: string) => JSON.stringify(await (await handle(root, new Request("http://pb/v1/notes/projects%2Fcourse-q", { headers: { authorization: `Bearer ${token}` } }))).json());
  const full = issueToken(root, "steward"), reader = issueToken(root, "steward", "reader");
  useCells(false);
  const want = { full: (await read(full)).includes("Quellmere"), reader: (await read(reader)).includes("Quellmere") };
  expect(want).toEqual({ full: true, reader: false });
  useCells(true);
  // The agent's own token first, so its cell is built and current when the reader token reads.
  expect({ full: (await read(full)).includes("Quellmere"), reader: (await read(reader)).includes("Quellmere") }).toEqual(want);
  // Each reads its own folder: the reader's holds nothing above its ceiling.
  expect(existsSync(join(cellDir(root, "steward"), "money/quellmere-fund.md"))).toBe(true);
  expect(files(readerCellDir(root, "steward")).some((f) => readFileSync(join(readerCellDir(root, "steward"), f), "utf8").includes("Quellmere"))).toBe(false);
  // Through its cell the page above the ceiling answers like one that isn't there (invariant 3).
  const miss = async (id: string) => { const r = await handle(root, new Request(`http://pb/v1/notes/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${reader}` } })); return [r.status, (await r.text()).split(id).join("ID")]; };
  expect(await miss("money/quellmere-fund")).toEqual(await miss("money/nothing-here"));
});

// Slice audit of G810: `edge publish` runs in another process and builds a reader's cell into the
// same folder under its own slices. The hub's next build, under the narrower slices OpenFGA
// confirms, updated that folder in place from its own memory of what it had written, so the wider
// build's extra notes stayed on disk under a cell.json naming the narrow slices.
test("contract cell: a cell another process built wider is built again from nothing, never updated in place (G810)", () => {
  const root = brain();
  const narrow = ["area:work"];
  const first = freshCell(root, "steward", narrow, "reader");
  const before = files(first.dir).filter((f) => f.endsWith(".md") && !f.startsWith("rules/"));
  // What a second process does: this process keeps its memory of the narrow build.
  const child = Bun.spawnSync(["bun", "-e", `import { buildReaderCell } from ${JSON.stringify(join(import.meta.dir, "../../src/cell.ts"))}; console.log(buildReaderCell(${JSON.stringify(root)}, "steward").info.notes);`], { env: process.env });
  expect(Number(child.stdout.toString().trim())).toBeGreaterThan(first.info.notes);
  const again = freshCell(root, "steward", narrow, "reader");
  expect(again.info.slices).toEqual(narrow);
  expect(files(again.dir).filter((f) => f.endsWith(".md") && !f.startsWith("rules/"))).toEqual(before);
});
