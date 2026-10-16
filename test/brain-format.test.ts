// SPDX-License-Identifier: AGPL-3.0-only
// The brain's format number (backlog 227): a hub refuses a brain newer than it knows with one clear
// line and touches nothing, an older brain is migrated only after a dry run on a copy worked, and
// the release rollback path (a newer release migrated the brain, then the Mac went back to the
// old tag) ends in a clean stop, not a corrupted brain or a guess.
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { FORMAT, FORMAT_FILE, brainFormat, formatProblem, migrate, renderMigrate, type Migration } from "../src/format";
import { git } from "../src/git";
import { initBrain } from "../src/init";
import * as bk from "../src/backup";

const APP = join(import.meta.dir, "..");
const cli = (root: string, ...a: string[]) => {
  const r = Bun.spawnSync(["bun", "src/cli.ts", ...a], { cwd: APP, env: { ...process.env, PB_BRAIN: root }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const snapshot = (root: string) => ({ head: git(root, ["rev-parse", "HEAD"]), status: git(root, ["status", "--porcelain", "--untracked-files=all"]), top: readdirSync(root).sort().join(",") });

// A made-up next format: every person note gets a `format_note` line in its frontmatter.
const toTwo: Migration = {
  to: 2, what: "people notes say they were migrated",
  run: (root) => readdirSync(join(root, "people")).filter((f) => f.endsWith(".md")).map((f) => {
    const p = join(root, "people", f);
    writeFileSync(p, readFileSync(p, "utf8").replace(/^---\n/, "---\nformat_note: migrated\n"));
    return `people/${f}`;
  }),
};

test("a new brain carries its format; a brain from before the FORMAT file is format 1; a garbled one is refused, not guessed", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "pb-fmt-")), "brain");
  const r = initBrain(dir, { owner: "Sam", text: [], token: false });
  expect(readFileSync(join(r.root, FORMAT_FILE), "utf8")).toBe(`pocketbrain-brain/${FORMAT}\n`);
  expect(git(r.root, ["status", "--porcelain"])).toBe(""); // committed with the rest of init
  const old = makeBrain();
  expect(brainFormat(old)).toBe(1);
  expect(formatProblem(old)).toBeUndefined();
  writeFileSync(join(old, FORMAT_FILE), "two\n");
  expect(() => brainFormat(old)).toThrow(/won't guess/);
  expect(cli(old, "bar").code).toBe(1);
});

test("a brain newer than this code: every command stops with one line saying what to run, and nothing is read or written", () => {
  const root = makeBrain();
  writeFileSync(join(root, FORMAT_FILE), `pocketbrain-brain/${FORMAT + 1}\n`);
  git(root, ["add", FORMAT_FILE]); git(root, ["commit", "-q", "-m", "a newer release migrated it"]);
  const before = snapshot(root);
  for (const args of [["bar"], ["start", "--port", "0"], ["serve", "--port", "0"], ["digest"], ["migrate", "--apply"]]) {
    const r = cli(root, ...args);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`this brain is format ${FORMAT + 1}`);
    expect(r.err).toContain(`reads formats up to ${FORMAT}`);
    expect(snapshot(root)).toEqual(before);
  }
  expect(cli(root, "bar").err).toContain("bun scripts/deploy.ts unhold");
  expect(cli(root, "version").code).toBe(0); // still says which version it is
});

test("migrate: the dry run changes nothing; --apply runs the same steps in place as one owner commit", () => {
  const root = makeBrain();
  const before = snapshot(root);
  const dry = migrate(root, { migrations: [toTwo], code: 2 });
  expect(dry).toMatchObject({ from: 1, to: 2, applied: false });
  expect(dry.steps[0].did.length).toBeGreaterThan(0);
  expect(snapshot(root)).toEqual(before);
  expect(renderMigrate(dry)).toContain("dry run (nothing changed)");
  const done = migrate(root, { apply: true, migrations: [toTwo], code: 2 });
  expect(done).toMatchObject({ from: 1, to: 2, applied: true });
  expect(done.steps).toEqual(dry.steps);
  expect(brainFormat(root)).toBe(2);
  expect(git(root, ["status", "--porcelain"])).toBe("");
  expect(git(root, ["log", "-1", "--format=%ae%n%B"])).toMatch(/^owner@pocketbrain\.local\nowner: migrate brain format 1 to 2\n[\s\S]*Kind: migrate/);
  expect(readFileSync(join(root, "people", readdirSync(join(root, "people")).find((f) => f.endsWith(".md"))!), "utf8")).toContain("format_note: migrated");
  expect(migrate(root, { migrations: [toTwo], code: 2 }).steps).toEqual([]); // already there
  // Undo is a git revert, back to format 1.
  git(root, ["revert", "--no-edit", "HEAD"], "owner");
  expect(brainFormat(root)).toBe(1);
});

test("a step that fails or breaks the brain fails the dry run, and the brain is left as it was", () => {
  const root = makeBrain();
  const before = snapshot(root);
  const throws: Migration = { to: 2, what: "throws", run: () => { throw new Error("step blew up"); } };
  expect(() => migrate(root, { apply: true, migrations: [throws], code: 2 })).toThrow(/dry run failed, the brain is unchanged at format 1: step blew up/);
  const breaks: Migration = { to: 2, what: "breaks the rules", run: (r) => { writeFileSync(join(r, "rules", "policy.yaml"), "agents: [not: {a map\n"); return ["rules/policy.yaml"]; } };
  expect(() => migrate(root, { apply: true, migrations: [breaks], code: 2 })).toThrow(/dry run failed/);
  expect(() => migrate(root, { apply: true, migrations: [], code: 2 })).toThrow(/no migration to format 2/);
  expect(snapshot(root)).toEqual(before);
  expect(YAML.parse(readFileSync(join(root, "rules", "policy.yaml"), "utf8")).agents).toBeDefined();
});

test("the rollback path: a newer release migrates, the Mac goes back to the old tag, the old hub stops cleanly, the newer one runs again", () => {
  const root = makeBrain();
  // The newer release (format 2) starts and migrates the brain.
  migrate(root, { apply: true, migrations: [toTwo], code: 2 });
  const migrated = snapshot(root);
  // Its health check fails, so the updater checks out the old tag (format 1) and restarts it.
  const old = cli(root, "start", "--port", "0");
  expect(old.code).toBe(1);
  expect(old.err).toContain("this brain is format 2");
  expect(snapshot(root)).toEqual(migrated); // nothing half-written by code that predates the layout
  // A fixed newer release reads it as is.
  expect(formatProblem(root, 2)).toBeUndefined();
});

test("migrate on a brain already at this format says so and changes nothing", () => {
  const root = makeBrain();
  const r = cli(root, "migrate");
  expect(r.code).toBe(0);
  expect(r.out).toContain(`brain format 1: nothing to migrate`);
});

// Builder's slice audit of batch 24: backups and the scripts that load a brain check the format too.
test("backup and drill stop on a newer brain with the format line; restore refuses a newer backup and leaves no folder", async () => {
  const root = makeBrain();
  writeFileSync(join(root, FORMAT_FILE), `pocketbrain-brain/${FORMAT + 1}\n`);
  git(root, ["add", FORMAT_FILE]); git(root, ["commit", "-q", "-m", "a newer release migrated it"]);
  const before = snapshot(root);
  for (const args of [["backup"], ["drill"]]) {
    const r = cli(root, ...args);
    expect(r.code, args[0]).toBe(1);
    expect(r.err, args[0]).toContain(`this brain is format ${FORMAT + 1}`);
  }
  expect(snapshot(root)).toEqual(before);
  // A backup made by a newer release, restored by this one.
  const keys = mkdtempSync(join(tmpdir(), "pb-fmt-keys-"));
  Bun.spawnSync(["age-keygen", "-o", join(keys, "id")]);
  const pub = Bun.spawnSync(["age-keygen", "-y", join(keys, "id")]).stdout.toString().trim();
  const b = bk.backup(root, { dest: mkdtempSync(join(tmpdir(), "pb-fmt-dest-")), recipients: [pub], record: false, rotate: false });
  const to = join(mkdtempSync(join(tmpdir(), "pb-fmt-to-")), "brain");
  await expect(bk.restore(b.file, { to, identity: { text: readFileSync(join(keys, "id"), "utf8") } })).rejects.toThrow(`this brain is format ${FORMAT + 1}`);
  expect(existsSync(to)).toBe(false);
});

test("the scripts that read a real brain check its format first", () => {
  const root = makeBrain();
  writeFileSync(join(root, FORMAT_FILE), `pocketbrain-brain/${FORMAT + 1}\n`);
  for (const script of ["scripts/gardener-audit.ts", "scripts/usage-day.ts"]) {
    const r = Bun.spawnSync(["bun", script, "--brain", root, "--no-ant"], { cwd: APP, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode, script).toBe(1);
    expect(r.stderr.toString(), script).toContain(`this brain is format ${FORMAT + 1}`);
  }
});

// Backlog 274: a frozen copy of the brain as each past format laid it out, in
// test/fixtures/brain-formats/<n>/. It is never edited after its format ships (examples/brain moves
// on; these don't), so a release that changes the layout is tested against real old brains.
const FIXTURES = join(import.meta.dir, "fixtures", "brain-formats");
const cpFixture = (n: number) => {
  const { cpSync } = require("node:fs");
  const root = mkdtempSync(join(tmpdir(), `pb-fmt${n}-`));
  cpSync(join(FIXTURES, String(n)), root, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" };
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "fixture"]]) Bun.spawnSync(["git", ...a], { cwd: root, env });
  return root;
};

test("every format this code knows has a frozen fixture brain, and none for a format it does not know yet", () => {
  for (let n = 1; n <= FORMAT; n++) expect(existsSync(join(FIXTURES, String(n))), `test/fixtures/brain-formats/${n}`).toBe(true);
  expect(existsSync(join(FIXTURES, String(FORMAT + 1)))).toBe(false); // a fixture is added with its format, not before
  // Format 1 is the layout from before the FORMAT file: the fixture has none.
  expect(existsSync(join(FIXTURES, "1", FORMAT_FILE))).toBe(false);
  for (let n = 2; n <= FORMAT; n++) expect(brainFormat(join(FIXTURES, String(n)))).toBe(n);
});

test("each past layout round-trips: migrated to this format, it loads, every note survives a save unchanged, and agents read it", () => {
  const { loadBrain, saveNote } = require("../src/brain");
  const { loadRules } = require("../src/rules");
  const { readNote } = require("../src/core");
  for (let n = 1; n <= FORMAT; n++) {
    const root = cpFixture(n);
    const before = loadBrain(root).length;
    expect(before).toBeGreaterThan(0);
    const dry = cli(root, "migrate");
    expect(dry.code, dry.err).toBe(0);
    migrate(root, { apply: true });
    expect(brainFormat(root)).toBe(FORMAT);
    expect(formatProblem(root)).toBeUndefined();
    loadRules(root);
    const notes = loadBrain(root);
    expect(notes.length).toBe(before);
    // Load, save, load: the format keeps every field of every note.
    const was = JSON.stringify(notes.map((x: any) => [x.fm, x.body]));
    for (const x of notes) saveNote(root, x);
    expect(JSON.stringify(loadBrain(root).map((x: any) => [x.fm, x.body]))).toBe(was);
    // The agent door reads it.
    expect(readNote(root, "planner", "projects/course-a").id).toBe("projects/course-a");
  }
});
