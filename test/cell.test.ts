// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, afterEach } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain, saveNote, type Note } from "../src/brain";
import * as core from "../src/core";
import { changeStats } from "../src/core";
import { useCells, buildCell, buildCells, cellDir } from "../src/cell";
import { write } from "../src/write";
import { saveNoteText } from "../src/dashboard/edit";

afterEach(() => useCells(false));

const AGENTS = ["steward", "planner", "helper"];
const both = <T>(fn: () => T): [T, T] => {
  useCells(false); const hub = fn();
  useCells(true); const cell = fn();
  useCells(false);
  return [hub, cell];
};
// The only line allowed to differ: a cell knows how many notes it holds, not the brain's size.
const sameView = (s: string) => s; // neither path tells an agent how big the whole brain is
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));

test("an agent reads exactly the same through its cell as through the hub", () => {
  const root = makeBrain();
  for (const agent of AGENTS) {
    const [hub, cell] = both(() => core.contextPack(root, agent));
    expect(sameView(cell), agent).toBe(sameView(hub));
    for (const q of ["course", "bank", "jane", "advisor", "grades"]) {
      const [h, c] = both(() => core.search(root, agent, q));
      expect(c, `${agent} ${q}`).toEqual(h);
    }
    for (const id of ["people/jane-roy", "people/paul-advisor", "projects/course-a", "projects/course-b", "money/main-bank", "decisions/2026-09-01-pick-bank"]) {
      // A cell drops who wrote each fact (it names other agents); everything else matches.
      const [h, c] = both(() => { try { return JSON.parse(JSON.stringify(core.readNote(root, agent, id), (k, v) => k === "by" ? undefined : v)); } catch (e) { return (e as Error).message; } });
      expect(c, `${agent} ${id}`).toEqual(h);
    }
    const [h, c] = both(() => core.contextPack(root, agent, "course"));
    expect(c).toBe(h);
  }
});

test("a cell holds nothing outside the agent's slice, and no other agent", () => {
  const root = makeBrain();
  buildCells(root);
  const dir = cellDir(root, "helper");
  const all = files(dir).map((f) => relative(dir, f) + "\n" + readFileSync(f, "utf8")).join("\n");
  expect(all).not.toContain("Maple Trust Bank");
  expect(all).not.toContain("money/");
  expect(all).not.toMatch(/\b(steward|planner)\b/i);
  // Steward's cell has the bank; Helper's cell doesn't even have the folder.
  expect(readFileSync(join(cellDir(root, "steward"), "money/main-bank.md"), "utf8")).toContain("Maple Trust Bank");
});

test("a committed write shows up in the cells; the kill switch still holds", () => {
  const root = makeBrain();
  useCells(true);
  core.contextPack(root, "helper"); // builds the cell
  const r = write(root, { agent: "planner", id: "projects/course-a", attribute: "next_step", value: "Post the slides", as_of: "2026-10-08", sources: ["gmail:f000000000000006"], verification: "verified-by-source" });
  expect(r.outcome).toBe("committed");
  expect(core.readNote(root, "helper", "projects/course-a").markdown).toContain("Post the slides");
  const p = join(root, "rules/policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace("helper: { tier: trial,", "helper: { status: paused, tier: trial,"));
  expect(() => core.search(root, "helper", "course")).toThrow("paused");
});

// Cells are updated in place when a write leaves the carve's scrub key alone (docs/perf.md).
// Whatever the writes, the cell must hold exactly what a full build from nothing would.
test("a cell updated in place after writes is byte for byte a fresh build", () => {
  const root = makeBrain();
  useCells(true);
  buildCells(root);
  const snap = (agent: string) => Object.fromEntries(files(cellDir(root, agent)).filter((f) => !f.endsWith("cell.json")).map((f) => [relative(cellDir(root, agent), f), readFileSync(f, "utf8")]));
  const steps: Parameters<typeof write>[1][] = [
    { agent: "planner", id: "projects/course-a", attribute: "next_step", value: "Publish grades", as_of: "2026-10-07", sources: ["gmail:f000000000000006"], verification: "verified-by-source" },
    { agent: "steward", id: "people/jane-roy", attribute: "role", value: "Program director", as_of: "2026-10-08", sources: ["gmail:f000000000000007"], verification: "verified-by-source" },
    // A fact only some agents see: its value becomes carved for the others.
    { agent: "steward", id: "people/jane-roy", attribute: "salary", value: "CAD 98765", as_of: "2026-10-08", sources: ["gmail:f000000000000008"], verification: "verified-by-source", sensitivity: "private" },
    { agent: "steward", id: "projects/course-b", attribute: "next_step", value: "Ask Jane about CAD 98765", as_of: "2026-10-08", sources: ["gmail:f000000000000009"], verification: "verified-by-source" },
  ];
  for (const w of steps) {
    expect(["committed", "inbox"]).toContain(write(root, w).outcome);
    const updated: Record<string, Record<string, string>> = {};
    for (const agent of AGENTS) { core.search(root, agent, "course"); updated[agent] = snap(agent); }
    buildCells(root); // from nothing
    for (const agent of AGENTS) expect(updated[agent], `${agent} after ${w.attribute}`).toEqual(snap(agent));
  }
});

// Slice audit of the scale branch, finding (a): a rebuild that leaves cell.json the same (an
// uncommitted edit, a forced buildCells) must still reach the next read, not a cached carve.
test("a forced cell rebuild reaches the next read even when cell.json is unchanged", () => {
  const root = makeBrain();
  useCells(true);
  buildCells(root);
  expect(JSON.stringify(core.readNote(root, "planner", "projects/course-a"))).toContain("Grade the midterm");
  const f = join(root, "projects/course-a.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("Grade the midterm", "Grade the final"));
  buildCell(root, "planner");
  const after = JSON.stringify(core.readNote(root, "planner", "projects/course-a"));
  expect(after).toContain("Grade the final");
  expect(after).not.toContain("Grade the midterm");
});

// Finding (b): an in-place update that fails partway must not leave the next update trusting
// what it thinks the cell holds. Here the note is changed, the update dies after writing it,
// and the note is put back exactly as it was: the cell must hold the original again.
test("a cell update that fails partway is rebuilt in full next time", () => {
  const root = makeBrain();
  useCells(true);
  buildCells(root);
  const f = join(root, "projects/course-a.md");
  const original = readFileSync(f, "utf8");
  const cellNote = join(cellDir(root, "planner"), "projects/course-a.md");
  const fresh = readFileSync(cellNote, "utf8");
  writeFileSync(f, original.replace("Grade the midterm", "Grade the final"));
  const policy = join(cellDir(root, "planner"), "rules", "policy.yaml");
  rmSync(policy); mkdirSync(policy); // the update writes the notes, then fails on this
  expect(() => buildCell(root, "planner")).toThrow();
  rmSync(policy, { recursive: true });
  writeFileSync(f, original);
  buildCell(root, "planner");
  expect(readFileSync(cellNote, "utf8")).toBe(fresh);
});

test("an uncommitted rules edit applies in cells exactly as on the plain path (bug hunt A5)", () => {
  const root = makeBrain();
  useCells(true);
  core.readNote(root, "planner", "projects/course-a"); // builds the cell
  const p = join(root, "rules", "policy.yaml");
  const before = readFileSync(p, "utf8");
  const after = before.replace("exclude_types: [money] }\n  # Keeps", "exclude_types: [money], exclude: [projects/course-a] }\n  # Keeps");
  expect(after).not.toBe(before);
  writeFileSync(p, after);
  const outcome = () => { try { core.readNote(root, "planner", "projects/course-a"); return "served"; } catch (e) { return (e as Error).message; } };
  const cell = outcome();
  useCells(false);
  expect(cell).toBe(outcome());
  expect(cell).not.toBe("served");
});

// Owner edits made straight to the files (as the dashboard's editor or a hand edit would), each
// a different way a cell's rendering can change without the note itself changing.
const edit = (root: string, id: string, fn: (n: Note) => void) => { const n = loadBrain(root).find((x) => x.fm.id === id)!; fn(n); saveNote(root, n); };
const fact = (value: string, extra: Record<string, unknown> = {}) => ({ value, as_of: "2026-10-08", sources: ["gmail:f000000000000008"], verification: "verified-by-source", by: "owner", recorded: "2026-10-08", ...extra });
const cellFiles = (root: string, agent: string) => Object.fromEntries(files(cellDir(root, agent)).filter((f) => !f.endsWith("cell.json")).map((f) => [relative(cellDir(root, agent), f), readFileSync(f, "utf8")]));

// docs/perf.md: a value newly carved out for an agent used to rebuild its whole cell (seconds
// at 10k notes). Now only the notes that can show it are written again.
test("a newly carved value rewrites only the cell notes that can show it", () => {
  const root = makeBrain();
  useCells(true);
  buildCells(root);
  const dir = cellDir(root, "helper");
  const inode = () => Object.fromEntries(files(dir).filter((f) => f.endsWith(".md")).map((f) => [relative(dir, f), statSync(f).ino]));
  // Mentioned first, carved out after: the note that mentions it doesn't change itself.
  edit(root, "projects/course-b", (n) => { n.body += "\nAsk Jane about Zanzibar.\n"; });
  buildCell(root, "helper");
  const before = inode();
  // One word: only the exact pass withholds it (no disguised-value needle).
  edit(root, "people/jane-roy", (n) => { (n.fm.facts as Record<string, unknown>).codename = fact("Zanzibar", { sensitivity: "private" }); });
  buildCell(root, "helper");
  const after = inode();
  expect(Object.keys(after).filter((f) => after[f] !== before[f]).sort()).toEqual(["people/jane-roy.md", "projects/course-b.md"]);
  expect(readFileSync(join(dir, "projects/course-b.md"), "utf8")).toContain("Ask Jane about [withheld].");
  const updated = cellFiles(root, "helper");
  buildCells(root);
  expect(updated).toEqual(cellFiles(root, "helper"));
});

test("cells updated in place, and reads from them, match a fresh build through every kind of change", () => {
  const root = makeBrain();
  useCells(true);
  buildCells(root);
  for (const agent of AGENTS) core.search(root, agent, "course");
  const steps: [string, () => void][] = [
    ["prose mentioning values not yet carved", () => {
      edit(root, "projects/course-a", (n) => { n.body += "\nZanzibar is the room. Élodie Marchand-Lefebvre helps with grading. See [[projects/course-b]].\n"; });
      edit(root, "projects/course-b", (n) => { n.body += "\nAsk ébène first.\n- Budget line 98 765 for Jane\n"; });
    }],
    ["a private fact (a carved value)", () => edit(root, "people/jane-roy", (n) => { (n.fm.facts as Record<string, unknown>).salary = fact("CAD 98765", { sensitivity: "private" }); })],
    ["a one-word value", () => edit(root, "people/jane-roy", (n) => { (n.fm.facts as Record<string, unknown>).codename = fact("Zanzibar", { sensitivity: "private" }); })],
    ["a one-word value that starts with a non-ASCII letter", () => edit(root, "people/paul-advisor", (n) => { (n.fm.facts as Record<string, unknown>).nickname = fact("Ébène", { sensitivity: "private" }); })],
    ["a value that starts with a non-ASCII letter", () => edit(root, "people/paul-advisor", (n) => { (n.fm.facts as Record<string, unknown>).partner = fact("Élodie Marchand-Lefebvre", { sensitivity: "private" }); })],
    ["a linked note leaves the view", () => edit(root, "projects/course-b", (n) => { n.fm.sensitivity = "secret"; })],
    ["and comes back", () => edit(root, "projects/course-b", (n) => { n.fm.sensitivity = "personal"; })],
    ["the carved value is dropped", () => edit(root, "people/jane-roy", (n) => { delete (n.fm.facts as Record<string, unknown>).salary; })],
  ];
  for (const [what, step] of steps) {
    step();
    for (const agent of AGENTS) buildCell(root, agent);
    const updated = Object.fromEntries(AGENTS.map((a) => [a, cellFiles(root, a)]));
    const reads = (agent: string) => [core.contextPack(root, agent), core.contextPack(root, agent, "course"), ...["course", "jane", "budget", "grading", "elodie", "zanzibar", "room", "ebene"].map((q) => JSON.stringify(core.search(root, agent, q)))];
    const served = Object.fromEntries(AGENTS.map((a) => [a, reads(a)]));
    buildCells(root); // from nothing
    for (const agent of AGENTS) {
      expect(updated[agent], `${agent} after ${what}`).toEqual(cellFiles(root, agent));
      const [hub] = both(() => reads(agent));
      expect(served[agent], `${agent} reads after ${what}`).toEqual(hub);
    }
    useCells(true);
  }
}, 30_000);

// Slice audit of claude/read-after-write: a disguised value that only shows once the exact pass
// has put "[withheld]" into a line (it splits a base64 run, or removes a stray "%" that stopped
// the line decoding) must still withhold that line when its needle is added later.
test("a value encoded next to an already withheld one is withheld after an in-place update", () => {
  for (const [line, first, second] of [
    ["line TWFyY2hhbmRMZWZlYnZyZSEh/Zanzibar", "Zanzibar", "Marchand Lefebvre"],
    ["%4D%61%72%63%68%61%6E%64%4C%65%66%65%62%76%72%65 50% off", "50% off", "Marchand Lefebvre"],
  ]) {
    const root = makeBrain();
    useCells(true);
    buildCells(root);
    edit(root, "people/jane-roy", (n) => { (n.fm.facts as Record<string, unknown>).codename = fact(first, { sensitivity: "private" }); });
    edit(root, "projects/course-b", (n) => { n.body += `\n${line}\n`; });
    buildCell(root, "helper");
    edit(root, "people/paul-advisor", (n) => { (n.fm.facts as Record<string, unknown>).partner = fact(second, { sensitivity: "private" }); });
    buildCell(root, "helper");
    const updated = cellFiles(root, "helper");
    buildCells(root);
    expect(updated["projects/course-b.md"], line).toBe(cellFiles(root, "helper")["projects/course-b.md"]);
    expect(updated["projects/course-b.md"]).toMatch(/^\[withheld\]$/m);
  }
});

// G222 / G231: what a note's date and the change feed tell an agent, through the hub and its cell.
// course-a gets a fact only steward sees; hidden writes land after a visible one.
const git = (root: string, args: string[], date?: string, author = "steward") =>
  Bun.spawnSync(["git", ...args], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: "a@x", GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: "a@x", ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) } });
function hiddenWrites(hiddenOn: string[]): string {
  const root = makeBrain();
  const f = join(root, "projects/course-a.md");
  const text = readFileSync(f, "utf8");
  writeFileSync(f, text.replace("Grade the midterm", "Grade the final").replace("\nfacts:\n", `\nfacts:\n  review_plan: { value: Reorder the quiz, as_of: 2026-09-01, share_with: [steward], sources: ["gmail:f000000000000003"], verification: verified-by-source, by: steward, recorded: 2026-09-01 }\n`));
  git(root, ["commit", "-qam", "seed\n\nprojects/course-a#next_step"], "2026-10-02T10:00:00Z");
  let cur = readFileSync(f, "utf8");
  for (const d of hiddenOn) {
    cur = cur.replace(/updated: \S+/, `updated: ${d}`).replace(/review_plan: \{ value: [^,]*, as_of: \S+,/, `review_plan: { value: Reorder the quiz, as_of: ${d},`);
    writeFileSync(f, cur);
    git(root, ["commit", "-qam", `hidden\n\nprojects/course-a#review_plan`], `${d}T10:00:00Z`);
  }
  return root;
}

test("a write to a hidden fact doesn't move the updated date an agent is shown, hub or cell", () => {
  const meta = (root: string) => {
    const n = core.readNote(root, "helper", "projects/course-a");
    return [n.updated, n.markdown.split("\n")[1], core.contextPack(root, "helper", "course").split("\n").filter((l) => l.includes("area work · updated")).join("|")];
  };
  const [a, b] = [hiddenWrites(["2026-10-07"]), hiddenWrites(["2026-10-07", "2026-10-08"])];
  for (const on of [false, true]) {
    useCells(on);
    const [x, y] = [meta(a), meta(b)];
    expect(x, `cells ${on}`).toEqual(y);
    expect(x[0], `cells ${on}`).not.toMatch(/2026-10-0[78]/);
    expect(x[1], `cells ${on}`).not.toMatch(/2026-10-0[78]/);
    expect(core.readNote(a, "steward", "projects/course-a").updated).toBe("2026-10-07");
  }
});

test("whats_new and changes_since date a note by the newest commit that changed something the agent sees", () => {
  const root = hiddenWrites(["2026-10-07"]);
  for (const on of [false, true]) {
    useCells(on);
    const w = core.whatsNew(root, "helper", "2026-10-01T00:00:00Z");
    const c = w.changes.find((x) => x.id === "projects/course-a")!;
    expect(c.at, `cells ${on}`).toStartWith("2026-10-02");
    expect(c.attrs_changed).toEqual(["next_step"]);
  }
  // changes_since (gardener): a note whose only new commits touched hidden facts isn't listed
  const only = hiddenWrites(["2026-10-07"]);
  const g = core.changesSince(only, "gardener", "2026-10-03T00:00:00Z");
  expect(g.changes.map((x) => x.id)).not.toContain("projects/course-a");
});

// G231 again: commits with no fact trailer (the dashboard's text editor) and a visible fact's
// retirement (it leaves the note's facts) are judged by what they changed, not by their message.
test("an owner text edit of a hidden fact doesn't date the note; retiring a visible fact is announced", () => {
  const at = (d: string) => { process.env.GIT_AUTHOR_DATE = d; process.env.GIT_COMMITTER_DATE = d; };
  try {
    for (const on of [false, true]) {
      useCells(on);
      const root = makeBrain();
      const ref = { sources: ["gmail:f000000000000003"], verification: "verified-by-source" };
      at("2026-10-02T10:00:00Z");
      write(root, { agent: "planner", id: "projects/course-a", attribute: "next_step", value: "Grade final", as_of: "2026-10-02", ...ref } as never);
      at("2026-10-07T10:00:00Z");
      write(root, { agent: "planner", id: "projects/course-a", attribute: "review_plan", value: "Reorder", as_of: "2026-10-07", share_with: ["steward"], ...ref } as never);
      at("2026-10-09T10:00:00Z");
      const f = join(root, "projects/course-a.md");
      saveNoteText(root, "projects/course-a", readFileSync(f, "utf8").replace("value: Reorder", "value: Reorder again"));
      const feed = (agent: string) => (agent === "gardener" ? core.changesSince(root, agent, "2020-01-01T00:00:00Z").changes : core.whatsNew(root, agent, "2020-01-01T00:00:00Z").changes).find((c) => c.id === "projects/course-a");
      expect(feed("helper")?.at, `helper cells ${on}`).toStartWith("2026-10-02");
      expect(feed("gardener")?.at, `gardener cells ${on}`).toStartWith("2026-10-02");
      expect(feed("helper")?.by).not.toBe("owner");
      // a hand commit with no trailer at all is judged by the facts it changed
      at("2026-10-09T12:00:00Z");
      writeFileSync(f, readFileSync(f, "utf8").replace("value: Reorder again", "value: Reorder thrice"));
      git(root, ["commit", "-qam", "hand edit"], "2026-10-09T12:00:00Z", "robin");
      expect(feed("helper")?.at, `hand edit cells ${on}`).toStartWith("2026-10-02");
      // a trailer naming a visible fact that this commit didn't change falls back to the diff
      writeFileSync(f, readFileSync(f, "utf8").replace("value: Reorder thrice", "value: Reorder 4"));
      git(root, ["commit", "-qam", "oops projects/course-a#next_step"], "2026-10-09T13:00:00Z", "robin");
      expect(feed("helper")?.at, `stray trailer cells ${on}`).toStartWith("2026-10-02");
      at("2026-10-10T10:00:00Z");
      core.retire(root, "planner", { id: "projects/course-a", attribute: "next_step", reason: "done", as_of: "2026-10-08", ...ref } as never);
      for (const agent of ["helper", "gardener"]) {
        const c = feed(agent);
        expect(c?.at, `${agent} cells ${on}`).toStartWith("2026-10-10");
        expect(c?.attrs_changed, `${agent} cells ${on}`).toEqual(["next_step"]);
      }
    }
  } finally { delete process.env.GIT_AUTHOR_DATE; delete process.env.GIT_COMMITTER_DATE; useCells(false); }
});

test("a change-feed read that fails or is cut short isn't remembered as 'nothing changed'", () => {
  const root = hiddenWrites(["2026-10-07"]);
  const ask = () => core.whatsNew(root, "helper", "2026-10-01T00:00:00Z").changes.find((c) => c.id === "projects/course-a");
  try {
    changeStats.truncate = 40; // output ends inside the first header
    expect(ask()).toBeUndefined(); // no fact is named for a version that wasn't read
    changeStats.truncate = 0;
    expect(ask()).toBeUndefined();
  } finally { changeStats.truncate = undefined; }
  expect(ask()?.at).toStartWith("2026-10-02"); // read again, and judged by its facts
});
