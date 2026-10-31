// SPDX-License-Identifier: AGPL-3.0-only
// Live sources that lost data (bug hunt 2026-10-15, backlog #127-#130): a Gmail first pass with
// more mail than one pass reads, a Calendar sync with more changes than one pass reads, a texts
// thread with more old rows than one query returns, and proposals pulled from any source that the
// owner could never accept. Fake Google and a temp chat.db only; every temp dir is removed after.
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { makeModel, type ModelRequest } from "../src/model";
import { useCaptureModel, captureModel } from "../src/capture";
import { pullSource } from "../src/pull";
import { decideProposal } from "../src/write";
import { useHttp, GMAIL_SCOPE, GCAL_SCOPE } from "../src/google";
import { fetchTexts, fetchText, useDiscordHttp } from "../src/feeds";

const EXTRACT = (p: string) => /exam room B-201/.test(p) ? [{ entity: "Course A", type: "project", attribute: "next_step", value: "Book the exam room B-201", quote: "book the exam room B-201" }] : [];
beforeAll(() => useCaptureModel(() => makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => JSON.stringify({ facts: EXTRACT(r.prompt) }) })));

const dirs: string[] = [];
afterAll(() => {
  useCaptureModel(); useHttp((u, i) => fetch(u, i)); useDiscordHttp((u, i) => fetch(u, i));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } });
function setup(sources: Record<string, unknown>) {
  const root = makeBrain();
  dirs.push(root);
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ consent: "2026-10-01 test", sources }));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "louis: sources");
  return root;
}
const state = (root: string, name: string) => JSON.parse(readFileSync(join(root, "log", "sources", `${name}.json`), "utf8"));
const proposals = (root: string) => existsSync(join(root, "inbox")) ? readdirSync(join(root, "inbox")).filter((f) => f.includes("-capture-")) : [];

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const b64 = (s: string) => Buffer.from(s).toString("base64url");
const gmsg = (id: string, body: string, at = Date.now()) => ({ id, labelIds: ["INBOX"], internalDate: String(at), payload: { mimeType: "text/plain", headers: [{ name: "From", value: "dean@school.example" }, { name: "To", value: "me@personal.example" }, { name: "Subject", value: "Exam" }], body: { data: b64(body) } } });

// A fake Google: tokens, and whatever `route` answers for the API calls.
let route: (u: URL) => Response | undefined = () => undefined;
beforeEach(() => {
  route = () => undefined;
  process.env.GOOGLE_CLIENT_ID = "cid"; process.env.GOOGLE_CLIENT_SECRET = "cs";
  process.env.GMAIL_REFRESH_TOKEN_PRIMARY = `m-${Math.random()}`; process.env.GCAL_REFRESH_TOKEN_PRIMARY = `c-${Math.random()}`;
  useHttp(async (url, init) => {
    const u = new URL(url);
    if (u.host === "oauth2.googleapis.com") return json({ access_token: "at", expires_in: 3600, scope: new URLSearchParams(String(init?.body)).get("refresh_token")!.startsWith("c-") ? GCAL_SCOPE : GMAIL_SCOPE });
    return route(u) ?? json({}, 404);
  });
});

// ---------- #127 Gmail first pass ----------

test("Gmail: a first pass with more mail than one pass reads keeps going until every message is read, then follows history", async () => {
  const ids = Array.from({ length: 250 }, (_, i) => "18c2f3a4b5d6" + i.toString(16).padStart(4, "0"));
  const read = new Set<string>();
  let historyFrom: string | undefined;
  route = (u) => {
    const p = u.pathname.replace("/gmail/v1/users/me/", "");
    if (p === "profile") return json({ historyId: "500" });
    if (p === "messages") { const start = Number(u.searchParams.get("pageToken") ?? 0); return json({ messages: ids.slice(start, start + 100).map((id) => ({ id })), ...(start + 100 < ids.length ? { nextPageToken: String(start + 100) } : {}) }); }
    if (p === "history") { historyFrom = u.searchParams.get("startHistoryId") ?? undefined; return json({ historyId: "500", history: [] }); }
    const m = p.match(/^messages\/(.+)$/);
    if (m) { read.add(m[1]); return json(gmsg(m[1], `Message ${m[1]} talks about the project plan in detail`)); }
  };
  const root = setup({ mail: { kind: "gmail", account: "primary", max_per_day: 1000 } });
  const passes = [];
  for (let i = 0; i < 4; i++) passes.push(await pullSource(root, "mail"));
  expect(passes.map((r) => r.refused)).toEqual([undefined, undefined, undefined, undefined]);
  expect(passes[0].more).toBe(true);
  expect(read.size).toBe(250);
  // Once the listing is done the cursor is the historyId from before it started, so nothing that
  // arrived during the listing is skipped.
  expect(state(root, "mail").live).toBe("500");
  expect(historyFrom).toBe("500");
}, 60_000);

// ---------- #128 Calendar ----------

test("Calendar: more than one pass of changed events is read over the next passes instead of the same first ones forever", async () => {
  const iso = (d: number) => new Date(Date.now() + d * 864e5).toISOString();
  let changed: Record<string, unknown>[] = [];
  route = (u) => {
    if (!u.pathname.startsWith("/calendar/v3/calendars/primary/events")) return;
    if (!u.searchParams.get("syncToken")) return json({ items: [], nextSyncToken: "s1" });
    return json({ items: changed, nextSyncToken: "s2" });
  };
  const root = setup({ cal: { kind: "gcal", account: "primary", max_per_day: 1000 } });
  await pullSource(root, "cal");
  changed = Array.from({ length: 250 }, (_, i) => ({ id: `e${i}`, etag: '"1"', status: "confirmed", updated: iso(0), summary: `Meeting ${i}`, start: { dateTime: iso(2) }, description: `Discuss the budget line ${i} with the whole team` }));
  const passes = [];
  for (let i = 0; i < 4; i++) passes.push(await pullSource(root, "cal"));
  expect(Object.keys(state(root, "cal").seen).length).toBe(250);
  expect(passes.map((r) => r.more)).toEqual([true, true, undefined, undefined]);
  expect(JSON.parse(state(root, "cal").live)).toEqual({ primary: "s2" });
  // A changed event (new etag) is read again on a later pass, not skipped as already seen.
  changed = [{ ...changed[7], etag: '"2"', description: "Please book the exam room B-201 for the budget review" }];
  const r = await pullSource(root, "cal");
  expect(r.fetched).toBe(1);
  expect(state(root, "cal").seen.e7).toBe("2");
}, 60_000);

test("Calendar: a first sync with more than one pass of recent events reads the rest on the next pass", async () => {
  const iso = (d: number) => new Date(Date.now() + d * 864e5).toISOString();
  const all = Array.from({ length: 150 }, (_, i) => ({ id: `f${i}`, etag: '"1"', status: "confirmed", updated: iso(0), summary: `Meeting ${i}`, start: { dateTime: iso(2) }, description: `Discuss the budget line ${i} with the whole team` }));
  route = (u) => {
    if (!u.pathname.startsWith("/calendar/v3/calendars/primary/events")) return;
    if (!u.searchParams.get("syncToken")) return json({ items: all, nextSyncToken: "s1" });
    return json({ items: [], nextSyncToken: "s1" });
  };
  const root = setup({ cal: { kind: "gcal", account: "primary", max_per_day: 1000 } });
  const r1 = await pullSource(root, "cal");
  expect(r1.more).toBe(true);
  await pullSource(root, "cal");
  expect(Object.keys(state(root, "cal").seen).length).toBe(150);
  expect(JSON.parse(state(root, "cal").live)).toEqual({ primary: "s1" });
}, 60_000);

// ---------- #129 texts ----------

const APPLE = Date.UTC(2001, 0, 1);
function chatDb(oldRows: number, recentRows: number) {
  const dir = mkdtempSync(join(tmpdir(), "pb-chat-"));
  dirs.push(dir);
  const p = join(dir, "chat.db");
  const db = new Database(p);
  db.exec(`CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT); CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER, is_from_me INTEGER, date INTEGER, date_edited INTEGER, date_retracted INTEGER, item_type INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    INSERT INTO handle VALUES (1,'+15145550123'); INSERT INTO chat VALUES (1,'+15145550123','');`);
  const add = (row: number, at: number) => { db.query("INSERT INTO message VALUES (?,?,?,NULL,1,0,?,0,0,0)").run(row, `G-${row}`, `text number ${row} about the plan`, (at - APPLE) * 1e6); db.query("INSERT INTO chat_message_join VALUES (1,?)").run(row); };
  let row = 0;
  for (let i = 0; i < oldRows; i++) add(++row, Date.parse("2025-01-01T00:00:00Z"));
  for (let i = 0; i < recentRows; i++) add(++row, Date.now() - 3600e3);
  db.close();
  return { path: p, db: (f: (d: Database) => void) => { const d = new Database(p); try { f(d); } finally { d.close(); } }, last: () => row };
}

test("texts: a thread with more old rows than one query reads its recent texts on the first pass, and new texts after", () => {
  const chat = chatDb(600, 3);
  const cfg = { kind: "imessage" as const, where: ["+15145550123"], path: chat.path };
  const r1 = fetchTexts(cfg);
  expect(r1.items.map((x) => x.guid)).toEqual(["G-601", "G-602", "G-603"]);
  expect(r1.cursor).toBe("603");
  chat.db((d) => { d.query("INSERT INTO message VALUES (604,'G-604','a brand new text arrives today',NULL,1,0,?,0,0,0)").run((Date.now() - APPLE) * 1e6); d.query("INSERT INTO chat_message_join VALUES (1,604)").run(); });
  const r2 = fetchTexts(cfg, r1.cursor, (id) => ["G-601", "G-602", "G-603"].includes(id));
  // The re-read window (for edits and unsends) brings back only rows already seen, never the old thread.
  expect(r2.items.map((x) => x.guid)).toEqual(["G-601", "G-602", "G-603", "G-604"]);
  expect(r2.cursor).toBe("604");
});

test("texts: a first pass with nothing recent still moves the cursor past the old thread", () => {
  const chat = chatDb(600, 0);
  const cfg = { kind: "imessage" as const, where: ["+15145550123"], path: chat.path };
  const r1 = fetchTexts(cfg);
  expect(r1.items).toEqual([]);
  expect(r1.cursor).toBe("600");
  const r2 = fetchTexts(cfg, r1.cursor, () => false);
  expect(r2.items).toEqual([]);
});

test("texts: more recent texts than one query returns are read over the next passes", () => {
  const chat = chatDb(10, 700);
  const cfg = { kind: "imessage" as const, where: ["+15145550123"], path: chat.path };
  const seen = new Set<string>();
  let cur: string | undefined;
  for (let i = 0; i < 3; i++) { const r = fetchTexts(cfg, cur, (id) => seen.has(id)); r.items.forEach((x) => seen.add(String(x.guid))); cur = r.cursor; }
  expect(seen.size).toBe(700);
  expect(cur).toBe("710");
});

test("texts: verify_source finds a recent text in a long thread, and never a text outside the listed threads", () => {
  const chat = chatDb(600, 1);
  chat.db((d) => { d.exec("INSERT INTO handle VALUES (2,'+15145550999')"); d.query("INSERT INTO message VALUES (700,'G-700','someone else entirely',NULL,2,0,?,0,0,0)").run((Date.now() - APPLE) * 1e6); });
  const cfg = { kind: "imessage" as const, where: ["+15145550123"], path: chat.path };
  expect(fetchText(cfg, "G-601")?.text).toBe("text number 601 about the plan");
  expect(fetchText(cfg, "G-700")).toBeUndefined();
});

test("texts: a pull over a long thread with today's text proposes from it", async () => {
  const chat = chatDb(600, 0);
  chat.db((d) => { d.query("INSERT INTO message VALUES (601,'G-601','Can you book the exam room B-201 for the final?',NULL,1,0,?,0,0,0)").run((Date.now() - APPLE) * 1e6); d.query("INSERT INTO chat_message_join VALUES (1,601)").run(); });
  const root = setup({ texts: { kind: "imessage", where: ["+15145550123"], path: chat.path } });
  const r = await pullSource(root, "texts");
  expect(r.refused).toBeUndefined();
  expect(r.proposals).toBe(1);
  expect(state(root, "texts").live).toBe("601");
}, 60_000);

// ---------- #130 pulled proposals can be accepted ----------

const ID = "18c2f3a4b5d6e7f8";
for (const account of ["primary", undefined]) {
  test(`a proposal pulled from Gmail (${account ? "with" : "without"} an account) can be accepted`, async () => {
    if (!account) process.env.GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN_PRIMARY;
    route = (u) => {
      const p = u.pathname.replace("/gmail/v1/users/me/", "");
      if (p === "profile") return json({ historyId: "100" });
      if (p === "messages") return json({ messages: [{ id: ID }] });
      if (p === `messages/${ID}`) return json(gmsg(ID, "Please book the exam room B-201 for the final, thanks"));
    };
    const root = setup({ mail: { kind: "gmail", ...(account ? { account } : {}) } });
    const r = await pullSource(root, "mail");
    expect(r.proposals).toBe(1);
    const file = proposals(root)[0];
    expect(YAML.parse(readFileSync(join(root, "inbox", file), "utf8")).request.source_type).toBe("email");
    const d = decideProposal(root, file, "accept");
    expect(d.message).not.toContain("refused");
    expect(d.outcome).toBe("committed");
    delete process.env.GMAIL_REFRESH_TOKEN;
  }, 60_000);
}

test("proposals pulled from Calendar, texts and Granola can be accepted too", async () => {
  route = (u) => {
    if (!u.pathname.startsWith("/calendar/v3/calendars/primary/events")) return;
    return json({ items: [{ id: "ev1", etag: '"3"', status: "confirmed", updated: new Date().toISOString(), summary: "Final exam", start: { dateTime: new Date(Date.now() + 864e5).toISOString() }, description: "Please book the exam room B-201 for the final" }], nextSyncToken: "s1" });
  };
  const chat = chatDb(0, 0);
  chat.db((d) => { d.query("INSERT INTO message VALUES (1,'G-1','Can you book the exam room B-201 for the final?',NULL,1,0,?,0,0,0)").run((Date.now() - APPLE) * 1e6); d.query("INSERT INTO chat_message_join VALUES (1,1)").run(); });
  const gdir = mkdtempSync(join(tmpdir(), "pb-granola-"));
  dirs.push(gdir);
  const gpath = join(gdir, "cache-v3.json");
  writeFileSync(gpath, JSON.stringify({ cache: JSON.stringify({ state: { documents: { d1: { id: "d1", title: "Exam prep", notes_markdown: "We agreed to book the exam room B-201 for the final", created_at: new Date().toISOString(), updated_at: new Date().toISOString() } } } }) }));
  const srcs = { cal: { kind: "gcal", account: "primary" }, texts: { kind: "imessage", where: ["+15145550123"], path: chat.path }, notes: { kind: "granola", path: gpath } };
  for (const [name, cfg] of Object.entries(srcs)) {
    const root = setup({ [name]: cfg });
    const r = await pullSource(root, name);
    expect([name, r.refused, r.proposals]).toEqual([name, undefined, 1]);
    const d = decideProposal(root, proposals(root)[0], "accept");
    expect([name, d.outcome, d.message]).toEqual([name, "committed", d.message]);
  }
}, 60_000);
