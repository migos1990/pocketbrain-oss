// SPDX-License-Identifier: AGPL-3.0-only
// It's right (G945, 2026-11-16): the owner's own phone held one Not confirmed line, a private value
// from mail whose sender no page holds, and nothing on it let him say it was right. Keep it private
// and Let them have it each left it a guess. It's right records the owner's approval of the value
// he read (an approved: ref, ranked as its source) and leaves the hold as it is: no assistant gets
// it until his separate Let them have it. Undo from the diary puts the guess back.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { readNote } from "../src/core";
import { markSeen, heldGuesses, keptFacts, confirmHeld, notRightHeld, heldSeen } from "../src/seen";
import { ownerAsks } from "../src/waiting";
import { loadBrain, type FactRecord } from "../src/brain";
import { loadRules } from "../src/rules";
import { lineState } from "../src/sources";
import { readDiary } from "../src/diary";
import { undoFact } from "../src/undo";
import { homeView, waitingCount } from "../src/dashboard/home";
import { homePage, APP_COPY } from "../src/dashboard/html-app";
import { STALE_OK } from "../src/dashboard/server";

beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; });

const KEY = "people/jane-roy#home_town";
const file = (root: string, attribute: string, value: string, stranger: boolean) =>
  write(root, { agent: "planner", id: "people/jane-roy", attribute, value, as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source", sensitivity: "private" } as never, { stranger });
const rec = (root: string, attr = "home_town") => loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.facts![attr] as FactRecord;
const sees = (root: string, needle: string) => JSON.stringify(readNote(root, "planner", "people/jane-roy")).includes(needle);
const view = (root: string, o: { all?: boolean; fresh?: boolean } = {}) => homeView(root, loadRules(root), loadBrain(root), new Date(), o);
const pick = (root: string) => { const u = heldGuesses(root).find((x) => x.fact_key === KEY)!; return { key: u.fact_key, seen: heldSeen(u) }; };

test("It's right makes a stranger's held guess yours and keeps it held from every assistant", () => {
  const root = makeBrain();
  file(root, "home_town", "Rimouski-Est", true);
  const r = confirmHeld(root, [pick(root)]);
  expect(r.confirmed).toBe(1);
  const f = rec(root);
  expect(lineState(f)).toBe("yours");
  expect(f.sources!.some((s) => String(s).startsWith("approved:"))).toBe(true);
  // The hold is as it was: no assistant gets it.
  expect(f.unseen).toBe(true);
  expect(sees(root, "Rimouski-Est")).toBe(false);
  // No longer a guess; listed with what the owner keeps to himself, and still never an ask.
  expect(heldGuesses(root)).toEqual([]);
  expect(keptFacts(root).map((u) => u.fact_key)).toEqual([KEY]);
  expect(ownerAsks(root).total).toBe(0);
  expect(waitingCount(root)).toBe(0);
  // Only Let them have it, a separate tap, lets it out.
  expect(markSeen(root, KEY).outcome).toBe("seen");
  expect(sees(root, "Rimouski-Est")).toBe(true);
});

test("It's right keeps only the bytes the owner read, and only a held guess", () => {
  const root = makeBrain();
  file(root, "home_town", "Rimouski-Est", true);
  file(root, "office", "Room 9", false);
  // A value that changed since he read it.
  expect(confirmHeld(root, [{ key: KEY, seen: "0".repeat(16) }]).confirmed).toBe(0);
  // A held value that isn't a stranger's guess, and a key that holds nothing.
  expect(confirmHeld(root, [{ key: "people/jane-roy#office", seen: heldSeen({ fact_key: "people/jane-roy#office", value: "Room 9" } as never) }]).confirmed).toBe(0);
  expect(confirmHeld(root, [{ key: "people/jane-roy#nothing", seen: "0".repeat(16) }]).confirmed).toBe(0);
  expect(lineState(rec(root))).toBe("guess");
  expect(lineState(rec(root, "office"))).not.toBe("yours");
});

test("Undo from the diary makes it a guess again, still held", () => {
  const root = makeBrain();
  file(root, "home_town", "Rimouski-Est", true);
  confirmHeld(root, [pick(root)]);
  const row = readDiary(root).filter((x) => x.fact_key === KEY).at(-1)!;
  expect(row.kind).toBe("confirmed");
  expect(undoFact(root, row.undo_token).outcome).toBe("undone");
  const f = rec(root);
  expect(lineState(f)).toBe("guess");
  expect(f.unseen).toBe(true);
  expect(f.kept_private).toBeUndefined();
  expect(heldGuesses(root).map((u) => u.fact_key)).toEqual([KEY]);
  expect(sees(root, "Rimouski-Est")).toBe(false);
});

test("the guess card offers It's right alone; once his, the card offers Let them have it alone", () => {
  const root = makeBrain();
  file(root, "home_town", "Rimouski-Est", true);
  const before = homePage(view(root, { all: true, fresh: true }), "c");
  const card = before.slice(before.indexOf(`<h2 class="group">${APP_COPY.guessHead}</h2>`));
  expect(card).toContain(`>${APP_COPY.itsRight}</button>`);
  expect(card).toContain('action="/action/held-right"');
  expect(card).not.toContain(`>${APP_COPY.keepPrivate}</button>`);
  expect(card).not.toContain(`>${APP_COPY.letThem}</button>`);
  confirmHeld(root, [pick(root)]);
  const v = view(root, { all: true, fresh: true });
  expect(v.waiting.find((w) => w.seen === KEY)).toMatchObject({ what: "Yours, kept private: something about Jane Roy." });
  const after = homePage(v, "c");
  expect(after).not.toContain(`<h2 class="group">${APP_COPY.guessHead}</h2>`);
  expect(after).toContain(`>${APP_COPY.letThem}</button>`);
  expect(after).not.toContain(`>${APP_COPY.itsRight}</button>`);
  // The diary line says what he did, never the value.
  const line = JSON.stringify(view(root, { all: true }));
  expect(line).toContain("You said it's right: something about Jane.");
  expect(line).not.toContain("Rimouski");
});

test("It's right needs a fresh sign-in", () => {
  expect(STALE_OK["held-right"]).toBeUndefined();
});

test("It's right from the home's own form says what it did, with Undo", async () => {
  const root = makeBrain();
  file(root, "home_town", "Rimouski-Est", true);
  const { dashboardHandler } = await import("../src/dashboard/server");
  const H = "127.0.0.1:8873";
  const d = dashboardHandler(root, { port: 8873, loginKey: "k".repeat(32), now: () => new Date() });
  const cookie = (await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }))).headers.get("set-cookie")!.split(";")[0]!;
  const get = async (path: string) => (await d.handle(new Request(`http://${H}${path}`, { headers: { host: H, cookie } }))).text();
  const home = await get("/home?all=1");
  const m = home.match(/action="\/action\/held-right"><input type="hidden" name="csrf" value="([^"]*)"><input type="hidden" name="key" value="([^"]+)"><input type="hidden" name="seen" value="([^"]+)"/)!;
  const r = await d.handle(new Request(`http://${H}/action/held-right`, { method: "POST", headers: { host: H, cookie, "content-type": "application/x-www-form-urlencoded", origin: `http://${H}` }, body: new URLSearchParams({ csrf: m[1]!, key: m[2]!, seen: m[3]! }).toString() }));
  expect(r.status).toBe(303);
  const after = await get(r.headers.get("location")!);
  expect(after).toContain("It&#39;s yours now. Only you see it until you let them have it.");
  expect(after).toContain('action="/action/diary-undo"');
  expect(lineState(rec(root))).toBe("yours");
  expect(sees(root, "Rimouski-Est")).toBe(false);
});

// A wrong guess, or one he doesn't care about, must be able to leave the list (coordinator's review
// of G945, 2026-11-16): Not right ends it as never right, deletes nothing, asks nothing, and Undo
// puts it back as the waiting guess it was (G946).
test("Not right takes a held guess off the list, keeps it in history, and Undo puts it back", () => {
  const root = makeBrain();
  file(root, "home_town", "Rimouski-Est", true);
  expect(notRightHeld(root, [{ key: KEY, seen: "0".repeat(16) }]).dropped).toBe(0);
  expect(notRightHeld(root, [pick(root)]).dropped).toBe(1);
  const n = loadBrain(root).find((x) => x.fm.id === "people/jane-roy")!;
  expect(n.fm.facts?.home_town).toBeUndefined();
  const old = n.fm.history!.home_town!.at(-1)!;
  expect(old).toMatchObject({ value: "Rimouski-Est", ended_by: { by: "owner", correction: true } });
  expect(heldGuesses(root)).toEqual([]);
  expect(keptFacts(root)).toEqual([]);
  expect(ownerAsks(root).total).toBe(0);
  expect(sees(root, "Rimouski-Est")).toBe(false);
  const v = view(root, { all: true });
  expect(v.waiting).toEqual([]);
  expect(JSON.stringify(v)).toContain("You said it's not right: something about Jane.");
  expect(JSON.stringify(v)).not.toContain("Rimouski");
  // The same mail saying it again does not bring it back.
  file(root, "home_town", "Rimouski-Est", true);
  expect(heldGuesses(root)).toEqual([]);
  const row = readDiary(root).filter((x) => x.fact_key === KEY && x.kind === "retracted").at(-1)!;
  expect(undoFact(root, row.undo_token).outcome).toBe("undone");
  expect(rec(root)).toMatchObject({ value: "Rimouski-Est", unseen: true });
  expect(heldGuesses(root).map((u) => u.fact_key)).toEqual([KEY]);
  expect(sees(root, "Rimouski-Est")).toBe(false);
});

test("the guess card's second, quieter choice is Not right", () => {
  const root = makeBrain();
  file(root, "home_town", "Rimouski-Est", true);
  const html = homePage(view(root, { all: true, fresh: true }), "c");
  expect(html).toContain('action="/action/held-not-right"');
  expect(html).toContain(`class="pill quiet" aria-label="${APP_COPY.notRight}: `);
  expect(STALE_OK["held-not-right"]).toBeUndefined();
});

test("Not right ends nothing but a held guess, and a reader later sees no more than the day of It's right", () => {
  const root = makeBrain();
  file(root, "home_town", "Rimouski-Est", true);
  file(root, "office", "Room 9", false);
  const office = heldSeen({ fact_key: "people/jane-roy#office", value: "Room 9" } as never);
  expect(notRightHeld(root, [{ key: "people/jane-roy#office", seen: office }, { key: "people/jane-roy#nothing", seen: "0".repeat(16) }]).dropped).toBe(0);
  expect(rec(root, "office").value).toBe("Room 9");
  expect(loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.history?.office).toBeUndefined();
  // It's right, then Let them have it: the reader gets the approval's day, nothing that names a file or a tap.
  confirmHeld(root, [pick(root)]);
  markSeen(root, KEY);
  const read = JSON.stringify(readNote(root, "planner", "people/jane-roy"));
  expect(read).toContain("Rimouski-Est");
  expect(read).not.toMatch(/approved:[^"\\]*\/held\//);
});

// Code review of #218: a held guess that is a list has more than one record, and the Undo of It's
// right puts back one. A list keeps the card it had (Keep it private, Let them have it).
test("a held guess that is a list is not offered It's right", () => {
  const root = makeBrain();
  writeFileSync(join(root, "people/kim-lee.md"), `---\nid: people/kim-lee\ntype: person\ntitle: Kim Lee\narea: personal\nsensitivity: personal\nstatus: active\ncreated: 2026-10-05\nupdated: 2026-10-05\nby: planner\nfacts:\n  phones:\n    items:\n      - { value: "555-0101", as_of: 2026-10-05, sources: ["gmail:f000000000000041"], verification: verified-by-source, by: planner, recorded: 2026-10-05, sensitivity: private, unseen: true, sender: unknown }\n---\n`);
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=planner", "-c", "user.email=p@x", "commit", "-qm", "planner: phones"], { cwd: root });
  const u = heldGuesses(root).find((x) => x.fact_key === "people/kim-lee#phones")!;
  expect(u).toBeDefined();
  expect(confirmHeld(root, [{ key: u.fact_key, seen: heldSeen(u) }]).confirmed).toBe(0);
  const card = view(root, { all: true, fresh: true }).waiting.find((w) => w.seen === u.fact_key)!;
  expect(card.right).toBeUndefined();
});
