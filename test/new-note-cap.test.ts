// SPDX-License-Identifier: AGPL-3.0-only
// Fewer new-note proposals from a source (backlog 396): one mail source proposed 74 new notes in a
// week, one per sender or thread, and buried the deck. A pulled source now proposes at most
// new_notes_per_day new notes a day (default 3); the rest wait in inbox/held, out of the deck,
// until the next day's share (or the owner asks for more, `pocketbrain inbox more`). Facts about notes that exist are
// never held, and a second fact about a new note goes where its first one went.
import { test, expect, afterEach } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { pullSource } from "../src/pull";
import { makeModel, type ModelRequest } from "../src/model";
import { inboxCards } from "../src/write";
import { releaseHeld, heldCount } from "../src/capture";

const NAMES = ["Marie Tremblay", "Luc Gagnon", "Sophie Roy", "Paul Ouellet", "Anne Cote", "Hugo Martin"];
// The fake model reads the message back: "<Name> is the <role>" -> one role fact about <Name>.
const model = makeModel({ provider: "fake", model: "f" }, { fake: (r: ModelRequest) => {
  const facts = [...r.prompt.matchAll(/([A-Z][a-z]+ [A-Z][a-z]+) is the ([a-z ]+?)(?:\.|\n|$)/g)].map((m) => ({ type: "person", entity: m[1], attribute: "role", value: m[2], quote: `${m[1]} is the ${m[2]}` }));
  return JSON.stringify({ facts });
} });
const msg = (i: number, text: string) => ({ team: "T1", channel: "C9", channel_name: "#c", ts: `${1760000000 + i}`, user: "U1", text });
const today = process.env.PB_TODAY;
afterEach(() => { if (today === undefined) delete process.env.PB_TODAY; else process.env.PB_TODAY = today; });
function brain(extra: Record<string, unknown> = {}) {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { s: { kind: "slack", area: "work", ...extra } } }));
  return root;
}
const open = (root: string) => readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml")).map((f) => YAML.parse(readFileSync(join(root, "inbox", f), "utf8")));
const held = (root: string) => existsSync(join(root, "inbox", "held")) ? readdirSync(join(root, "inbox", "held")).filter((f) => f.endsWith(".yaml")) : [];

test("a source proposes at most 3 new notes a day; the rest are held out of the deck", async () => {
  const root = brain();
  process.env.PB_TODAY = "2026-10-15";
  await pullSource(root, "s", { fetch: () => NAMES.map((n, i) => msg(i, `${n} is the lab instructor.`)), model });
  const newNotes = open(root).filter((p) => p.new_note);
  expect(new Set(newNotes.map((p) => p.request.title)).size).toBe(3);
  expect(held(root).length).toBe(3);
  expect(heldCount(root)).toBe(3);
  expect(inboxCards(root).length).toBe(3);
});

test("a fact about a note that exists is never held, whatever the count", async () => {
  const root = brain({ new_notes_per_day: 1 });
  process.env.PB_TODAY = "2026-10-15";
  await pullSource(root, "s", { fetch: () => [...NAMES.slice(0, 3).map((n, i) => msg(i, `${n} is the lab instructor.`)), msg(9, "Jane Roy is the program director.")], model });
  expect(open(root).filter((p) => p.request.id === "people/jane-roy").length).toBe(1);
  expect(open(root).filter((p) => p.new_note).length).toBe(1);
  expect(held(root).length).toBe(2);
});

test("the cap is per day across pulls, and a second fact about a held note is held with it", async () => {
  const root = brain({ new_notes_per_day: 2 });
  process.env.PB_TODAY = "2026-10-15";
  await pullSource(root, "s", { fetch: () => [msg(1, "Marie Tremblay is the lab instructor."), msg(2, "Luc Gagnon is the tutor.")], model });
  await pullSource(root, "s", { fetch: () => [msg(3, "Sophie Roy is the dean."), msg(4, "Sophie Roy is the dean of studies.")], model });
  expect(open(root).filter((p) => p.new_note).length).toBe(2);
  expect(held(root).length).toBe(2);
  // The next day's share takes the held one first (two facts, one new note), then Hugo Martin.
  process.env.PB_TODAY = "2026-10-16";
  await pullSource(root, "s", { fetch: () => [msg(5, "Hugo Martin is the coach.")], model });
  expect(new Set(open(root).filter((p) => p.new_note).map((p) => p.request.title))).toEqual(new Set(["Marie Tremblay", "Luc Gagnon", "Sophie Roy", "Hugo Martin"]));
  expect(held(root).length).toBe(0);
});

test("the owner asks for more: held proposals move into the deck, oldest first", async () => {
  const root = brain({ new_notes_per_day: 1 });
  process.env.PB_TODAY = "2026-10-15";
  await pullSource(root, "s", { fetch: () => NAMES.slice(0, 4).map((n, i) => msg(i, `${n} is the lab instructor.`)), model });
  expect(heldCount(root)).toBe(3);
  expect(releaseHeld(root, 2)).toBe(2);
  expect(heldCount(root)).toBe(1);
  expect(open(root).filter((p) => p.new_note).length).toBe(3);
  expect(Bun.spawnSync(["git", "status", "--porcelain", "--", "inbox"], { cwd: root }).stdout.toString().trim()).toBe("");
});

// Owner's rule (2026-10-25): a cap that parks facts out of sight is another queue; "a page cap is a
// queue: held items file next day, never a card". Audit v4 (2026-10-26): releasing only the next
// day's share let the backlog grow (12 held new pages on the real brain, counted as asks). Every new
// note held on an earlier day moves into the inbox on the next pull, so the hub files it that tick;
// only today's overflow waits, for one day.
test("held new notes all move into the inbox on the next day's pull, as the hub with a why; none waits two days", async () => {
  const root = brain({ new_notes_per_day: 2 });
  process.env.PB_TODAY = "2026-10-15";
  await pullSource(root, "s", { fetch: () => NAMES.slice(0, 5).map((n, i) => msg(i, `${n} is the lab instructor.`)), model });
  expect(heldCount(root)).toBe(3);
  process.env.PB_TODAY = "2026-10-16";
  await pullSource(root, "s", { fetch: () => [msg(7, "Hugo Martin is the coach.")], model });
  expect(heldCount(root)).toBe(0);
  expect(new Set(open(root).filter((p) => p.new_note).map((p) => p.request.title)).size).toBe(6);
  const log = Bun.spawnSync(["git", "log", "--format=%an%x1f%B%x1e", "--grep=held new note"], { cwd: root }).stdout.toString().split("\x1e").filter((x) => x.trim())[0] ?? "";
  expect(log.trim().split("\x1f")[0]).toBe("hub");
  expect(log).toMatch(/^Why: /m);
});

// Mac, 2026-10-27 04:0xZ: north-star read held 13 a few minutes after the owner's midnight. The
// notes held late on 10-26 counted as stuck before 10-27's first pull of the source had run. A held
// note waits past its day only once a pull of the next day had its chance to move it, or once a
// whole day has gone by with no pull at all.
test("just after midnight, yesterday's held notes are a queue until the source's first pull of the day", async () => {
  const root = brain({ new_notes_per_day: 2 });
  process.env.PB_TODAY = "2026-10-15";
  await pullSource(root, "s", { fetch: () => NAMES.slice(0, 5).map((n, i) => msg(i, `${n} is the lab instructor.`)), model });
  expect(heldCount(root)).toBe(3);
  expect(heldCount(root, { stuck: true })).toBe(0);
  process.env.PB_TODAY = "2026-10-16"; // midnight passed; no pull yet today
  expect(heldCount(root, { stuck: true })).toBe(0);
  process.env.PB_TODAY = "2026-10-17"; // a whole day went by with no pull of s
  expect(heldCount(root, { stuck: true })).toBe(3);
  await pullSource(root, "s", { fetch: () => [], model });
  expect(heldCount(root, { stuck: true })).toBe(0);
  expect(heldCount(root)).toBe(0);
});
