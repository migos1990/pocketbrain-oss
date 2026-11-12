// SPDX-License-Identifier: AGPL-3.0-only
// Forget a person (backlog row 330): `pocketbrain forget <people/id> --yes` takes someone out of
// the brain on request, not only out of view. One owner commit removes their note, turns every
// link to them into [[redacted]], drops their standing and any inbox item about them; the local
// traces (standing signals, the views folder, the restart cache) go too. For 14 days
// `pocketbrain forget --undo <id>` puts all of it back; after that the undo is gone.
import { test, expect, afterEach, spyOn } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { enroll } from "../src/edge";
import { useCells } from "../src/cell";
import { restoreCells } from "./cells";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { brain } from "./standing-fixture";
import { forgetPerson, undoForget, expireForgets, planForget, FORGET_UNDO_DAYS } from "../src/forget";
import { readNote, search } from "../src/core";
import { buildAll } from "../src/backup";
import { loadStanding } from "../src/standing";
import { main } from "../src/cli";
import { loadBrain, saveParseSnapshots, resetParseSnapshots } from "../src/brain";

const ID = "people/sam-roy";
afterEach(restoreCells);
const DAY = 86_400_000;
const sh = (root: string, ...a: string[]) => Bun.spawnSync(["git", "-C", root, ...a]).stdout.toString().trim();
const commitAll = (root: string, msg: string) => Bun.spawnSync(["git", "-C", root, "-c", "user.name=louis", "-c", "user.email=louis@pocketbrain.local", "commit", "-qam", msg]);

// Sam is linked from a note's body (with a label), from a fact value, and named in an inbox
// proposal; a note links a different person whose id starts the same; a journal line names Sam.
function setup() {
  const root = brain();
  writeFileSync(join(root, "people", "sam-roy-2.md"), readFileSync(join(root, "people", "sam-roy.md"), "utf8").replace("id: people/sam-roy", "id: people/sam-roy-2").replace("title: Sam Roy", "title: Sam Roy Junior").replace(/sam(\.\w+)?@example\.com/g, "junior$1@example.com"));
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "notes", "dinner.md"), `---
id: notes/dinner
type: note
title: Dinner plans
area: personal
sensitivity: personal
status: active
created: 2026-10-02
updated: 2026-10-02
by: steward
facts:
  host: { value: "[[people/sam-roy]]", as_of: 2026-10-02, sources: ["owner:2026-10-02/dashboard"], verification: confirmed-by-owner, by: owner, recorded: 2026-10-02 }
---
Dinner with [[people/sam-roy|Sam]], [[people/sam-roy#emails]] and [[people/jane-roy]]. Junior is [[people/sam-roy-2]].
`);
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "2026-10-05-steward-0a1b2c3d.yaml"), YAML.stringify({ proposed: "2026-10-05", by: "steward", reason: "new phone", request: { id: ID, attribute: "phones", value: "+15145550100" } }));
  writeFileSync(join(root, "inbox", "2026-10-05-steward-99999999.yaml"), YAML.stringify({ proposed: "2026-10-05", by: "steward", reason: "x", request: { id: "people/sam-roy-2", attribute: "phones", value: "+15145550101" } }));
  mkdirSync(join(root, "journal", "steward"), { recursive: true });
  writeFileSync(join(root, "journal", "steward", "2026-10.md"), "- 2026-10-03 Sam Roy said the dinner moved.\n");
  Bun.spawnSync(["git", "-C", root, "add", "-A"]);
  commitAll(root, "fixture: links to sam");
  // Local, never committed: the owner's traffic counts for Sam's address and a dismissed suggestion.
  mkdirSync(join(root, "log", "standing"), { recursive: true });
  writeFileSync(join(root, "log", "standing", ".gitignore"), "*\n");
  writeFileSync(join(root, "log", "standing", "contacts.json"), JSON.stringify({ "sam@example.com": { in: 3, out: 2, first: "2026-09-01", last: "2026-09-05" }, "jane@northfield.example": { in: 1, out: 0, first: "2026-09-01", last: "2026-09-01" } }));
  writeFileSync(join(root, "log", "standing", "dismissed.json"), JSON.stringify({ [ID]: { tier: "close", note_created: "2026-10-01" } }));
  buildAll(root);
  return root;
}
const tracked = (root: string) => sh(root, "ls-tree", "-r", "HEAD", "--name-only").split("\n").sort();
const fileAt = (root: string, rev: string, p: string) => sh(root, "show", `${rev}:${p}`);

test("forget takes the person out of notes, links, standing, inbox and views in one owner commit", () => {
  const root = setup();
  expect(readNote(root, "steward", ID)).toBeDefined();
  const before = sh(root, "rev-parse", "HEAD");
  const r = forgetPerson(root, ID, { now: Date.parse("2026-10-08T12:00:00Z") });

  // One commit, by the owner, saying what it is.
  expect(sh(root, "rev-list", "--count", `${before}..HEAD`)).toBe("1");
  expect(sh(root, "log", "-1", "--format=%ae")).toMatch(/^(owner|louis)@/);
  expect(sh(root, "log", "-1", "--format=%B")).toContain(`Forgot-Person: ${ID}`);
  expect(r.hash).toBe(sh(root, "rev-parse", "HEAD"));

  // The note is gone and answers like one that never existed.
  expect(existsSync(join(root, `${ID}.md`))).toBe(false);
  expect(() => readNote(root, "steward", ID)).toThrow();
  expect(search(root, "steward", "Sam Roy").map((h) => h.id)).not.toContain(ID);

  // Every link to Sam, label or anchor included, is [[redacted]]; the look-alike id is untouched.
  const dinner = readFileSync(join(root, "notes", "dinner.md"), "utf8");
  expect(dinner).not.toContain("people/sam-roy]");
  expect(dinner).not.toContain("people/sam-roy|");
  expect(dinner).not.toContain("people/sam-roy#");
  expect(dinner).toContain('host: { value: "[[redacted]]"');
  expect(dinner).toContain("Dinner with [[redacted]], [[redacted]] and [[people/jane-roy]]. Junior is [[people/sam-roy-2]].");

  // Standing, the inbox proposal about Sam, the local signals: gone; Sam Junior's are kept.
  expect(loadStanding(root).people[ID]).toBeUndefined();
  expect(loadStanding(root).people["people/jane-roy"]).toBeDefined();
  expect(existsSync(join(root, "inbox", "2026-10-05-steward-0a1b2c3d.yaml"))).toBe(false);
  expect(existsSync(join(root, "inbox", "2026-10-05-steward-99999999.yaml"))).toBe(true);
  const contacts = JSON.parse(readFileSync(join(root, "log", "standing", "contacts.json"), "utf8"));
  expect(Object.keys(contacts)).toEqual(["jane@northfield.example"]);
  expect(JSON.parse(readFileSync(join(root, "log", "standing", "dismissed.json"), "utf8"))[ID]).toBeUndefined();

  // Views (current and every dated snapshot) no longer hold the name or the id.
  const views = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? views(join(dir, e.name)) : [join(dir, e.name)]);
  for (const f of views(join(root, "views"))) {
    const t = readFileSync(f, "utf8");
    expect(t.includes(ID + "\"") || t.includes(ID + "]") || t.includes("sam@example.com")).toBe(false);
  }

  // What it couldn't take out is said, never hidden: the journal line, the logs, git history, backups.
  expect(r.leftovers.join("\n")).toContain("journal/steward/2026-10.md");
  expect(r.message).toMatch(/backups made before/i);
  expect(r.message).toMatch(/14 days/);
});

test("the restart cache drops every version of the note, and a hub that read it earlier doesn't write it back", () => {
  const root = setup();
  resetParseSnapshots({ off: false });
  const yamlOf = (text: string) => text.match(/^---\n([\s\S]*?)\n---/)![1];
  const key = new Bun.CryptoHasher("sha256").update(yamlOf(readFileSync(join(root, `${ID}.md`), "utf8"))).digest("base64");
  loadBrain(root);
  saveParseSnapshots();
  const cache = join(root, ".cells", "parse.json");
  expect(readFileSync(cache, "utf8")).toContain(key);
  // A second process (the running hub) holds the old entry in memory.
  const stale = readFileSync(cache, "utf8");
  forgetPerson(root, ID, { now: Date.parse("2026-10-08T12:00:00Z") });
  expect(readFileSync(cache, "utf8")).not.toContain(key);
  writeFileSync(cache, stale); // as if that hub saved its memory after the forget
  resetParseSnapshots();
  loadBrain(root);
  saveParseSnapshots();
  expect(readFileSync(cache, "utf8")).not.toContain(key);
  expect(readFileSync(join(root, ".cells", "parse.drop"), "utf8")).toContain(key);
  resetParseSnapshots({ off: !!process.env.PB_NO_PARSE_SNAPSHOT });
});

test("with cells on: plain-text names are listed, every cached rendering goes, the edge reader's cells go", () => {
  const root = setup();
  const dinner = join(root, "notes", "dinner.md");
  writeFileSync(dinner, readFileSync(dinner, "utf8") + "Sam Roy can be reached at sam@example.com.\n");
  commitAll(root, "a plain-text mention");
  resetParseSnapshots({ off: false });
  useCells(true);
  for (const a of ["steward", "planner", "helper"]) { search(root, a, "Sam Roy"); try { readNote(root, a, ID); } catch { /* not in this view */ } }
  saveParseSnapshots();
  const cache = join(root, ".cells", "parse.json");
  const holds = () => readFileSync(cache, "utf8").split("\n").filter((l) => l.includes(`"id":"${ID}"`) || l.includes('"sam@example.com"'));
  expect(holds().length).toBeGreaterThan(1); // the brain's copy and at least one cell's rendering
  mkdirSync(join(root, ".cells", ".edge-reader", "steward", "people"), { recursive: true });
  writeFileSync(join(root, ".cells", ".edge-reader", "steward", "people", "sam-roy.md"), readFileSync(join(root, `${ID}.md`), "utf8"));

  expect(planForget(root, ID).named).toContain("notes/dinner"); // Sam Roy Junior is listed too: a name can be shared
  const r = forgetPerson(root, ID, { now: Date.parse("2026-10-08T12:00:00Z") });
  expect(r.message).toContain("notes/dinner");
  expect(holds()).toEqual([]);
  expect(existsSync(join(root, ".cells", ".edge-reader"))).toBe(false);
  for (const a of ["steward", "planner", "helper"]) expect(() => readNote(root, a, ID)).toThrow();
  saveParseSnapshots();
  expect(holds()).toEqual([]);
  resetParseSnapshots({ off: !!process.env.PB_NO_PARSE_SNAPSHOT });
});

test("with an agent enrolled for the edge, the result says to publish again", () => {
  const root = setup();
  process.env.PB_CONFIG_DIR = join(mkdtempSync(join(tmpdir(), "pb-edge-home-")), "keys");
  try {
    expect(forgetPerson(setup(), ID).message).not.toContain("edge publish");
    enroll(root, "steward");
    expect(forgetPerson(root, ID).message).toContain("edge publish");
  } finally { delete process.env.PB_CONFIG_DIR; }
});

test("undo within 14 days puts back every file and local trace exactly as it was", () => {
  const root = setup();
  const pre = tracked(root);
  const preHead = sh(root, "rev-parse", "HEAD");
  const localBefore = ["contacts.json", "dismissed.json"].map((f) => readFileSync(join(root, "log", "standing", f), "utf8"));
  const t = Date.parse("2026-10-08T12:00:00Z");
  forgetPerson(root, ID, { now: t });
  undoForget(root, ID, { now: t + (FORGET_UNDO_DAYS - 1) * DAY });
  expect(tracked(root)).toEqual(pre);
  for (const p of pre) expect(fileAt(root, "HEAD", p)).toBe(fileAt(root, preHead, p));
  expect(["contacts.json", "dismissed.json"].map((f) => JSON.parse(readFileSync(join(root, "log", "standing", f), "utf8")))).toEqual(localBefore.map((x) => JSON.parse(x)));
  expect(readNote(root, "steward", ID)).toBeDefined();
  expect(sh(root, "log", "-1", "--format=%ae")).toMatch(/^(owner|louis)@/);
  // Once undone, there is nothing left to undo.
  expect(() => undoForget(root, ID, { now: t + 2 * DAY })).toThrow(/no forget/);
});

test("after 14 days the undo is gone: refused, and the night's cleanup drops what it kept", () => {
  const root = setup();
  const t = Date.parse("2026-10-08T12:00:00Z");
  forgetPerson(root, ID, { now: t });
  expect(() => undoForget(root, ID, { now: t + (FORGET_UNDO_DAYS + 1) * DAY })).toThrow(/14 days/);
  expect(expireForgets(root, t + 2 * DAY)).toBe(0);
  expect(expireForgets(root, t + (FORGET_UNDO_DAYS + 1) * DAY)).toBe(1);
  expect(existsSync(join(root, ".git", "pb-forget")) ? readdirSync(join(root, ".git", "pb-forget")) : []).toEqual([]);
});

test("refused: not a person, no such note, an open dispute about them, a later edit undo can't reverse", () => {
  const root = setup();
  expect(() => forgetPerson(root, "projects/course-a")).toThrow(/person/);
  expect(() => forgetPerson(root, "people/nobody")).toThrow(/no person note/);
  expect(() => forgetPerson(root, "people/../rules/policy")).toThrow();
  const sam = join(root, `${ID}.md`);
  writeFileSync(sam, readFileSync(sam, "utf8").replace(/  emails: \{ items: \[.*\] \}\n/, '  emails: { dispute: disputes/x, candidates: [] }\n'));
  commitAll(root, "a dispute");
  expect(() => forgetPerson(root, ID)).toThrow(/dispute/);

  const r2 = setup();
  const t = Date.parse("2026-10-08T12:00:00Z");
  forgetPerson(r2, ID, { now: t });
  const dinner = join(r2, "notes", "dinner.md");
  writeFileSync(dinner, readFileSync(dinner, "utf8").replace("Dinner with [[redacted]]", "Lunch with [[redacted]]"));
  commitAll(r2, "owner edits the same line");
  expect(() => undoForget(r2, ID, { now: t + DAY })).toThrow(/changed since/);
  expect(sh(r2, "status", "--porcelain", "--untracked-files=no")).toBe("");
});

test("the CLI shows the plan, prose mentions included, and changes nothing without --yes", () => {
  const root = setup();
  const dinner = join(root, "notes", "dinner.md");
  writeFileSync(dinner, readFileSync(dinner, "utf8") + "Call Sam Roy first.\n");
  commitAll(root, "a plain-text mention");
  const head = sh(root, "rev-parse", "HEAD");
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => { said.push(a.join(" ")); });
  const plan = planForget(root, ID);
  expect(plan.links).toEqual(["notes/dinner"]);
  expect(plan.inbox).toEqual(["inbox/2026-10-05-steward-0a1b2c3d.yaml"]);
  expect(plan.standing).toBe(true);
  expect(main(["forget", ID, "--brain", root])).toBe(1);
  log.mockRestore();
  expect(said.join("\n")).toMatch(/plain text.*notes\/dinner/);
  expect(sh(root, "rev-parse", "HEAD")).toBe(head);
  expect(main(["forget", ID, "--brain", root, "--yes"])).toBe(0);
  expect(existsSync(join(root, `${ID}.md`))).toBe(false);
  expect(main(["forget", "--undo", ID, "--brain", root])).toBe(0);
  expect(existsSync(join(root, `${ID}.md`))).toBe(true);
});

// Audit v13 (G763): Ask's chats (owner-only files beside the brain's git, src/ask-threads.ts) outlived
// a forget: the chat still named the person and what was said about them, and the leftovers list
// never looked there. A forget now deletes every chat that names them and says how many.
test("G763 forget deletes the Ask chats that name the person, and only those", async () => {
  const { addTurn, listChats } = await import("../src/ask-threads");
  const root = setup();
  const now = Date.parse("2026-10-08T12:00:00Z");
  const a = addTurn(root, undefined, { q: "who is Sam Roy?", a: "Sam Roy is a contractor." }, now - 3000);
  addTurn(root, a.id, { q: "and his email?", a: "sam@example.com" }, now - 2000);
  const byId = addTurn(root, undefined, { q: "open people/sam-roy", a: "Here." }, now - 1500);
  const other = addTurn(root, undefined, { q: "what is next for Course A?", a: "Grade the midterm." }, now - 1000);
  const r = forgetPerson(root, ID, { now });
  const left = listChats<{ q: string; a: string }>(root, now);
  expect(left.map((c) => c.id)).toEqual([other.id]);
  expect(JSON.stringify(left).toLowerCase()).not.toContain("sam roy");
  expect(left.some((c) => c.id === byId.id)).toBe(false);
  expect(r.message).toContain("2 Ask chat(s) that named them were deleted");
  // The undo puts the brain back; a deleted chat stays deleted, and the undo says so.
  expect(undoForget(root, ID, { now: now + DAY })).toMatch(/Ask chats? deleted with the forget (is|are) not brought back/);
  expect(listChats(root, now + DAY).map((c) => c.id)).toEqual([other.id]);
});

test("G763 a forget with no chat about the person says nothing of chats", () => {
  const root = setup();
  const r = forgetPerson(root, ID, { now: Date.parse("2026-10-08T12:00:00Z") });
  expect(r.message).not.toContain("Ask chat");
});

// Code review of G763: a name is matched as whole words, so a chat about something that only
// holds the name's letters ("balsam Royce") is not deleted, and it could never be brought back.
test("G763 a chat that only holds the name's letters inside other words is kept", async () => {
  const { addTurn, listChats } = await import("../src/ask-threads");
  const root = setup();
  const now = Date.parse("2026-10-08T12:00:00Z");
  const keep = addTurn(root, undefined, { q: "where is the balsam Royce order?", a: "At the depot." }, now - 2000);
  const gone = addTurn(root, undefined, { q: "what did Sam Roy's team say?", a: "Nothing yet." }, now - 1000);
  forgetPerson(root, ID, { now });
  const left = listChats(root, now).map((c) => c.id);
  expect(left).toContain(keep.id);
  expect(left).not.toContain(gone.id);
});
