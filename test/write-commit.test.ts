// SPDX-License-Identifier: AGPL-3.0-only
// A write is only "committed" when git committed it (bug hunt 2026-10-15 A4, backlog #135).
// When the commit fails (a lock left by a crash, a full disk, a hook), the write is refused, the
// note and any dispute packet or inbox file it made are put back, and nothing new is served.
// Notes are saved through a temporary file and a rename, so a crash never leaves half a note.
import { test, expect } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { readNote } from "../src/core";
import { loadBrain, saveNote } from "../src/brain";
import { louisMessages, ownerMessagesPath } from "../src/louis";

const base = { agent: "planner", id: "projects/course-a", attribute: "next_step", as_of: "2026-10-07", sources: ["gmail:f000000000000006"], verification: "verified-by-source" as const };
const head = (root: string) => Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"]).stdout.toString().trim();
const dirty = (root: string) => Bun.spawnSync(["git", "-C", root, "status", "--short", "--", ".", ":!log"]).stdout.toString().trim();
const lock = (root: string) => writeFileSync(join(root, ".git/index.lock"), "");
const unlock = (root: string) => rmSync(join(root, ".git/index.lock"));

test("a fact write whose commit fails is refused and changes nothing", () => {
  const root = makeBrain();
  const before = head(root);
  const note = readFileSync(join(root, "projects/course-a.md"), "utf8");
  lock(root);
  const r = write(root, { ...base, value: "Book room 12" });
  unlock(root);
  expect(r.outcome).toBe("refused");
  expect(r.fails?.[0].check).toBe("not_saved");
  expect(r.message).toContain("Nothing changed");
  expect(head(root)).toBe(before);
  expect(readFileSync(join(root, "projects/course-a.md"), "utf8")).toBe(note);
  expect(dirty(root)).toBe("");
  expect(JSON.stringify(readNote(root, "planner", "projects/course-a").facts.next_step)).not.toContain("Book room 12");
  const last = readFileSync(join(root, "log/writes.jsonl"), "utf8").trim().split("\n").at(-1)!;
  expect(JSON.parse(last)).toMatchObject({ outcome: "refused", checks: ["not_saved"] });
  // The same write goes through once git works again.
  expect(write(root, { ...base, value: "Book room 12" }).outcome).toBe("committed");
});

test("a new note whose commit fails is removed again", () => {
  const root = makeBrain();
  lock(root);
  const r = write(root, { ...base, id: "projects/course-z", title: "Course Z", type: "project", area: "work", value: "Plan it" } as any);
  unlock(root);
  expect(r.outcome).toBe("refused");
  expect(r.fails?.[0].check).toBe("not_saved");
  expect(existsSync(join(root, "projects/course-z.md"))).toBe(false);
  expect(dirty(root)).toBe("");
});

test("a conflict whose commit fails leaves no dispute packet behind", () => {
  const root = makeBrain();
  lock(root);
  const r = write(root, { ...base, value: "Something else", as_of: "2026-10-07", as_of_approx: true });
  unlock(root);
  expect(r.outcome).toBe("refused");
  expect(r.fails?.[0].check).toBe("not_saved");
  expect(existsSync(join(root, "disputes")) ? readdirSync(join(root, "disputes")) : []).toEqual([]);
  expect(dirty(root)).toBe("");
});

test("a proposal whose commit fails leaves no inbox file behind", () => {
  const root = makeBrain();
  lock(root);
  const r = write(root, { ...base, agent: "helper", value: "Publish grades" });
  unlock(root);
  expect(r.outcome).toBe("refused");
  expect(r.fails?.[0].check).toBe("not_saved");
  expect(readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml"))).toEqual([]);
  expect(dirty(root)).toBe("");
});

test("a tightened flag whose commit fails is refused and the note is put back", () => {
  const root = makeBrain();
  const note = readFileSync(join(root, "projects/course-a.md"), "utf8");
  lock(root);
  const r = write(root, { ...base, value: "Grade the midterm", as_of: "2026-10-01", sources: ["gmail:f000000000000003"], sensitivity: "private" } as any);
  unlock(root);
  expect(r.outcome).toBe("refused");
  expect(r.fails?.[0].check).toBe("not_saved");
  expect(readFileSync(join(root, "projects/course-a.md"), "utf8")).toBe(note);
  expect(dirty(root)).toBe("");
});

test("an owner message id the texts agent relays is not left registered when the commit fails", () => {
  const root = makeBrain();
  const id = "imsg:phonemsg-01M5LOUISREALTEXTQQQQQQQQ01";
  lock(root);
  const r = write(root, { ...base, agent: "steward", id: "people/paul-advisor", attribute: "role", value: "Retired advisor", as_of: "2026-10-08", sources: [id], verification: "confirmed-by-louis" } as any);
  unlock(root);
  expect(r.outcome).toBe("refused");
  expect(louisMessages(root).has(id)).toBe(false);
  expect(dirty(root)).toBe("");
});

const RELAYED = "imsg:phonemsg-01M5LOUISREALTEXTQQQQQQQQ01";
const relay = (sources: string[]) => ({ ...base, agent: "steward", id: "people/paul-advisor", attribute: "role", value: "Retired advisor", as_of: "2026-10-08", sources, verification: "confirmed-by-louis" }) as any;

test("a relayed owner id is taken out again when the write is refused for another reason after it", () => {
  const root = makeBrain();
  mkdirSync(join(root, "log"), { recursive: true });
  appendFileSync(join(root, "log/refs-checked.jsonl"), JSON.stringify({ ref: "gmail:f000000000000009", ok: false, at: "x" }) + "\n");
  lock(root);
  const r = write(root, relay([RELAYED, "gmail:f000000000000009"]));
  unlock(root);
  expect(r.outcome).not.toBe("committed");
  expect(louisMessages(root).has(RELAYED)).toBe(false);
  expect(dirty(root)).toBe("");
});

test("with the registry already edited by hand, a failed write keeps the owner's edit and drops only the relayed id", () => {
  const root = makeBrain();
  const f = join(root, ownerMessagesPath(root));
  const mine = "# owner note\nmessages:\n  - id: imsg:phonemsg-OWNERTYPEDTHISONE\n    added: 2026-10-15\n";
  writeFileSync(f, mine);
  lock(root);
  expect(write(root, relay([RELAYED])).outcome).toBe("refused");
  unlock(root);
  expect(louisMessages(root).has(RELAYED)).toBe(false);
  expect(readFileSync(f, "utf8")).toBe(mine);
});

test("a replica refused by the hub gate leaves the note as it was, nothing staged", () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules/hub.yaml"), "hub: home\nepoch: 1\nreplicas:\n  home: {}\n  laptop: {}\n");
  Bun.spawnSync(["git", "-C", root, "add", "rules/hub.yaml"]);
  Bun.spawnSync(["git", "-C", root, "-c", "user.name=owner", "-c", "user.email=o@x", "commit", "-qm", "hub"]);
  Bun.spawnSync(["git", "-C", root, "config", "pocketbrain.replica", "laptop"]);
  const note = readFileSync(join(root, "projects/course-a.md"), "utf8");
  expect(() => write(root, { ...base, value: "Book room 12" }, { acceptedBy: "owner" })).toThrow(/replica/);
  expect(readFileSync(join(root, "projects/course-a.md"), "utf8")).toBe(note);
  expect(dirty(root)).toBe("");
});

test("a write commits only its own files, never what else happened to be staged", () => {
  const root = makeBrain();
  writeFileSync(join(root, "scratch.txt"), "unrelated\n");
  Bun.spawnSync(["git", "-C", root, "add", "scratch.txt"]);
  expect(write(root, { ...base, value: "Book room 12" }).outcome).toBe("committed");
  const files = Bun.spawnSync(["git", "-C", root, "show", "--name-only", "--format=", "HEAD"]).stdout.toString().trim().split("\n");
  // The owner's diary line rides with the change (docs/owner-home.md).
  expect(files).toEqual(["diary/2026-10.jsonl", "projects/course-a.md"]);
  expect(dirty(root)).toBe("A  scratch.txt");
});

test("saveNote replaces the note in one step and leaves no temporary file", () => {
  const root = makeBrain();
  const n = loadBrain(root).find((x) => x.fm.id === "projects/course-a")!;
  n.body = "Rewritten.\n";
  saveNote(root, n);
  expect(readFileSync(join(root, "projects/course-a.md"), "utf8")).toContain("Rewritten.");
  expect(readdirSync(join(root, "projects")).filter((f) => !f.endsWith(".md"))).toEqual([]);
});

// The same for journal lines and inbox answers (backlog #182).
import { decideProposal } from "../src/write";

test("a journal line whose commit fails is refused and taken out again", () => {
  const root = makeBrain();
  lock(root);
  const r = write(root, { agent: "planner", kind: "journal", text: "Met the dean about room 12", sources: ["gmail:f000000000000006"] } as any);
  unlock(root);
  expect(r.outcome).toBe("refused");
  expect(r.fails?.[0].check).toBe("not_saved");
  expect(dirty(root)).toBe("");
  expect(write(root, { agent: "planner", kind: "journal", text: "Met the dean about room 12", sources: ["gmail:f000000000000006"] } as any).outcome).toBe("committed");
});

test("an inbox answer whose commit fails is refused, and the proposal stays in the inbox to answer again", () => {
  for (const decision of ["reject", "accept"] as const) {
    const root = makeBrain();
    const p = write(root, { ...base, agent: "helper", value: "Publish grades" });
    expect(p.outcome).toBe("inbox");
    const name = p.file!.split("/").pop()!;
    // Fail only the inbox commit: a hook that refuses commits touching inbox/decided.
    writeFileSync(join(root, ".git/hooks/pre-commit"), "#!/bin/sh\ngit diff --cached --name-only | grep -q '^inbox/decided/' && { echo 'hook says no' >&2; exit 1; }\nexit 0\n", { mode: 0o755 });
    const r = decideProposal(root, p.file!, decision);
    rmSync(join(root, ".git/hooks/pre-commit"));
    expect(r.outcome).toBe("refused");
    expect(r.message).toContain("still in the inbox");
    expect(existsSync(join(root, p.file!))).toBe(true);
    expect(existsSync(join(root, "inbox/decided", name))).toBe(false);
    expect(dirty(root)).toBe("");
    const again = decideProposal(root, p.file!, decision);
    expect(again.outcome).not.toBe("refused");
    expect(existsSync(join(root, "inbox/decided", name))).toBe(true);
    expect(dirty(root)).toBe("");
  }
});

test("an accept whose inbox commit fails keeps the fact once; answering again is a noop for the fact", () => {
  const root = makeBrain();
  const p = write(root, { ...base, agent: "helper", value: "Publish grades" });
  writeFileSync(join(root, ".git/hooks/pre-commit"), "#!/bin/sh\ngit diff --cached --name-only | grep -q '^inbox/decided/' && exit 1\nexit 0\n", { mode: 0o755 });
  const r = decideProposal(root, p.file!, "accept");
  rmSync(join(root, ".git/hooks/pre-commit"));
  expect(r.message).toContain("the fact is saved");
  const log = Bun.spawnSync(["git", "-C", root, "log", "-1", "--format=%an", "--", "projects/course-a.md"]).stdout.toString().trim();
  expect(log).toBe("Robin"); // the fact went in as the owner's accept
  const once = () => (readFileSync(join(root, "projects/course-a.md"), "utf8").match(/Publish grades/g) ?? []).length;
  expect(once()).toBe(1);
  decideProposal(root, p.file!, "accept");
  expect(once()).toBe(1);
  expect(dirty(root)).toBe("");
});

test("a journal line is committed as its agent, and a failed second line leaves the month file as it was", () => {
  const root = makeBrain();
  const line = (text: string) => write(root, { agent: "planner", kind: "journal", text, sources: ["gmail:f000000000000006"] } as any);
  const first = line("Met the dean about room 12");
  expect(first.outcome).toBe("committed");
  expect(Bun.spawnSync(["git", "-C", root, "log", "-1", "--format=%an"]).stdout.toString().trim()).toBe("planner");
  const month = readdirSync(join(root, "journal/planner"))[0];
  const before = readFileSync(join(root, "journal/planner", month), "utf8");
  lock(root);
  expect(line("Booked room 14 instead").outcome).toBe("refused");
  unlock(root);
  expect(readFileSync(join(root, "journal/planner", month), "utf8")).toBe(before);
  expect(dirty(root)).toBe("");
});
