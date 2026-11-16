// SPDX-License-Identifier: AGPL-3.0-only
// The owner's home, 2026-11-15: 4 asks, 1 a contradiction; the other 3 were private values filed
// from mail whose sender no page holds. Such a value is a guess (G868), and the home asks only on
// a conflict: it stays held from every assistant and waits for nothing. The full list still names
// it, uncounted, with the same Let them have it (G883).
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { readNote } from "../src/core";
import { markSeen, keepPrivate, unseenFacts, heldGuesses, keptFacts } from "../src/seen";
import { ownerAsks } from "../src/waiting";
import { loadBrain, type FactRecord } from "../src/brain";
import { loadRules } from "../src/rules";
import { homeView, waitingCount } from "../src/dashboard/home";
import { homePage, APP_COPY } from "../src/dashboard/html-app";

beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; });

const KEY = "people/jane-roy#home_town";
const file = (root: string, attribute: string, value: string, stranger: boolean) =>
  write(root, { agent: "planner", id: "people/jane-roy", attribute, value, as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source", sensitivity: "private" } as never, { stranger });
const rec = (root: string, attr: string) => loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.facts![attr] as FactRecord;
const sees = (root: string, needle: string) => JSON.stringify(readNote(root, "planner", "people/jane-roy")).includes(needle);
const view = (root: string, o: { all?: boolean; fresh?: boolean } = {}) => homeView(root, loadRules(root), loadBrain(root), new Date(), o);

test("a private value from a sender no page holds is held, and is not an ask", () => {
  const root = makeBrain();
  expect(file(root, "home_town", "Rimouski-Est", true).outcome).toBe("committed");
  // Held as before: marked, and no assistant gets it.
  expect(rec(root, "home_town")).toMatchObject({ unseen: true, sender: "unknown" });
  expect(sees(root, "Rimouski-Est")).toBe(false);
  // It waits for nothing: not in the one counted list, not on the home's face.
  expect(unseenFacts(root)).toEqual([]);
  expect(heldGuesses(root).map((u) => u.fact_key)).toEqual([KEY]);
  const a = ownerAsks(root);
  expect({ serving: a.serving, by: a.by, total: a.total, guesses: a.guesses }).toEqual({ serving: 0, by: {}, total: 0, guesses: 1 });
  expect(waitingCount(root)).toBe(0);
  expect(view(root).waiting).toEqual([]);
});

test("the full list names it, uncounted, never its value on an old sign-in; Let them have it still works", () => {
  const root = makeBrain();
  file(root, "home_town", "Rimouski-Est", true);
  const row = view(root, { all: true }).waiting.find((w) => w.seen === KEY)!;
  expect(row).toMatchObject({ n: 0, what: "Not confirmed: something about Jane Roy.", verb: "not confirmed", stranger: true });
  expect(JSON.stringify(row)).not.toContain("Rimouski");
  const html = homePage(view(root, { all: true }), "c");
  expect(html).toContain(`<h2 class="group">${APP_COPY.guessHead}</h2>`);
  expect(html).not.toContain("Rimouski");
  // Read first, then the same two choices as any held value.
  const fresh = homePage(view(root, { all: true, fresh: true }), "c");
  expect(fresh).toContain("Rimouski-Est");
  expect(fresh).toContain(`>${APP_COPY.letThem}</button>`);
  expect(fresh).toContain(`>${APP_COPY.keepPrivate}</button>`);
  expect(markSeen(root, KEY).outcome).toBe("seen");
  expect(rec(root, "home_town").unseen).toBeUndefined();
  expect(heldGuesses(root)).toEqual([]);
  expect(view(root, { all: true }).waiting.some((w) => w.seen === KEY)).toBe(false);
});

test("Keep it private moves it to the kept list, still held", () => {
  const root = makeBrain();
  file(root, "home_town", "Rimouski-Est", true);
  expect(keepPrivate(root, KEY).outcome).toBe("kept");
  expect(heldGuesses(root)).toEqual([]);
  expect(keptFacts(root).map((u) => u.fact_key)).toEqual([KEY]);
  expect(sees(root, "Rimouski-Est")).toBe(false);
});

test("a held value from a sender a page holds is held the same and asks nothing either (G907); it is not a guess", () => {
  const root = makeBrain();
  file(root, "home_town", "Rimouski-Est", true);
  file(root, "office", "Room 9", false);
  expect(unseenFacts(root).map((u) => u.fact_key)).toEqual(["people/jane-roy#office"]);
  expect(ownerAsks(root).by).toEqual({});
  expect(waitingCount(root)).toBe(0);
  expect(view(root).waiting).toEqual([]);
  const all = view(root, { all: true }).waiting;
  expect(all.map((w) => [w.seen, w.verb, w.n])).toEqual([["people/jane-roy#office", "only you can see it yet", 0], [KEY, "not confirmed", 0]]);
});

test("the north star and the home still count one list", async () => {
  const { measure } = await import("../scripts/north-star");
  const root = makeBrain();
  file(root, "home_town", "Rimouski-Est", true);
  file(root, "office", "Room 9", false);
  const now = new Date();
  const m = measure(root, new Date(now.getTime() - 86_400_000).toISOString(), now);
  expect({ asks: m.asks, home: m.home_asks, held: m.private_held, guesses: m.guess_held }).toEqual({ asks: 0, home: 0, held: 1, guesses: 1 });
}, 60_000);

// Review of #200: a guess card whose group spans pages links to the full list, which the held
// heading also takes; it showed under both headings.
test("guesses on several pages are one card, under Not confirmed only", () => {
  const root = makeBrain();
  for (const id of ["money/fee-a", "money/fee-b"]) {
    writeFileSync(join(root, `${id}.md`), `---\nid: ${id}\ntype: money\ntitle: A fee\narea: personal\nsensitivity: private\nstatus: active\ncreated: 2026-10-05\nupdated: 2026-10-05\nby: planner\nfacts:\n  amount: { value: "4.99", as_of: 2026-10-05, sources: ["gmail:f000000000000021"], verification: verified-by-source, by: planner, recorded: 2026-10-05, unseen: true, sender: unknown }\n---\n`);
  }
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=planner", "-c", "user.email=p@x", "commit", "-qm", "planner: fees"], { cwd: root });
  const v = view(root, { all: true });
  expect(v.waiting.map((w) => [w.what, w.href])).toEqual([["Not confirmed: 2 things only you can see.", "/home?all=1"]]);
  const html = homePage(v, "c");
  expect(html.split('<span class="what">Not confirmed: 2 things only you can see.').length - 1).toBe(1);
  expect(html).not.toContain(APP_COPY.heldHead);
});
