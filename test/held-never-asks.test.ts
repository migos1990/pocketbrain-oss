// SPDX-License-Identifier: AGPL-3.0-only
// The owner's typed yes, 2026-11-16 01:23Z: "an assistant's private fact stays held without
// becoming a Home ask" (G907). Every private fact an assistant filed was one tap for the owner,
// counted on the home beside real conflicts. The hold is a privacy gate, not a question: the value
// stays held from every assistant exactly as before, waits for nothing, is counted nowhere, and
// the full list still names it with Read it, Let them have it and Keep it private. The home's
// face says one quiet line that such values exist, so none is ever out of the owner's reach.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { readNote } from "../src/core";
import { markSeen, keepPrivate, unseenFacts, keptFacts } from "../src/seen";
import { ownerAsks } from "../src/waiting";
import { loadBrain, type FactRecord } from "../src/brain";
import { loadRules } from "../src/rules";
import { homeView, waitingCount } from "../src/dashboard/home";
import { homePage, APP_COPY } from "../src/dashboard/html-app";

beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; });

const KEY = "people/jane-roy#office";
const file = (root: string, attribute: string, value: string) =>
  write(root, { agent: "planner", id: "people/jane-roy", attribute, value, as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source", sensitivity: "private" } as never);
const rec = (root: string, attr: string) => loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.facts![attr] as FactRecord;
const sees = (root: string, needle: string) => JSON.stringify(readNote(root, "planner", "people/jane-roy")).includes(needle);
const view = (root: string, o: { all?: boolean; fresh?: boolean } = {}) => homeView(root, loadRules(root), loadBrain(root), new Date(), o);

test("an assistant's private value is held from every assistant and is not an ask", () => {
  const root = makeBrain();
  expect(file(root, "office", "Room 9").outcome).toBe("committed");
  // Held exactly as before.
  expect(rec(root, "office").unseen).toBe(true);
  expect(sees(root, "Room 9")).toBe(false);
  expect(unseenFacts(root).map((u) => u.fact_key)).toEqual([KEY]);
  // It waits for nothing: in no counted list, not a card on the home's face.
  const a = ownerAsks(root);
  expect({ by: a.by, total: a.total, settings: a.settings, serving: a.serving }).toEqual({ by: {}, total: 0, settings: 0, serving: 1 });
  expect(waitingCount(root)).toBe(0);
  expect(view(root).waiting).toEqual([]);
});

test("the home's face says one quiet line that leads to the full list, never a value or a count of asks", () => {
  const root = makeBrain();
  file(root, "office", "Room 9");
  file(root, "phone", "514 555 0199");
  const v = view(root);
  expect(v.held).toBe("2 private things are held from your assistants.");
  const html = homePage(v, "c");
  expect(html).toContain(`<a class="late" role="status" href="/home?all=1">2 private things are held from your assistants.</a>`);
  expect(html).not.toContain("Room 9");
  expect(html).not.toContain(APP_COPY.heldHead);
  // One of them: singular.
  const one = makeBrain();
  file(one, "office", "Room 9");
  expect(view(one).held).toBe("1 private thing is held from your assistants.");
  // None: no line.
  expect(view(makeBrain()).held).toBeUndefined();
});

test("the full list names each one, uncounted, with the same Read it, Let them have it and Keep it private", () => {
  const root = makeBrain();
  file(root, "office", "Room 9");
  const row = view(root, { all: true }).waiting.find((w) => w.seen === KEY)!;
  expect(row).toMatchObject({ n: 0, verb: "only you can see it yet" });
  expect(JSON.stringify(row)).not.toContain("Room 9");
  const html = homePage(view(root, { all: true }), "c");
  // Its heading carries no count: nothing waits.
  expect(html).toContain(`<h2 class="group">${APP_COPY.heldHead}</h2>`);
  expect(html).not.toContain("Room 9");
  const fresh = homePage(view(root, { all: true, fresh: true }), "c");
  expect(fresh).toContain("Room 9");
  expect(fresh).toContain(`>${APP_COPY.letThem}</button>`);
  expect(fresh).toContain(`>${APP_COPY.keepPrivate}</button>`);
  // Let them have it serves it; the line and the row go.
  expect(markSeen(root, KEY).outcome).toBe("seen");
  expect(sees(root, "Room 9")).toBe(true);
  expect(view(root).held).toBeUndefined();
  expect(view(root, { all: true }).waiting.some((w) => w.seen === KEY)).toBe(false);
});

test("Keep it private takes it off the quiet line and keeps it held", () => {
  const root = makeBrain();
  file(root, "office", "Room 9");
  expect(keepPrivate(root, KEY).outcome).toBe("kept");
  expect(view(root).held).toBeUndefined();
  expect(keptFacts(root).map((u) => u.fact_key)).toEqual([KEY]);
  expect(sees(root, "Room 9")).toBe(false);
});

test("the north star counts none of them as asks and prints them on their own line", async () => {
  const { measure } = await import("../scripts/north-star");
  const root = makeBrain();
  file(root, "office", "Room 9");
  const now = new Date();
  const m = measure(root, new Date(now.getTime() - 86_400_000).toISOString(), now);
  expect({ asks: m.asks, home: m.home_asks, by: m.asks_by_kind, held: m.private_held }).toEqual({ asks: 0, home: 0, by: {}, held: 1 });
}, 60_000);
