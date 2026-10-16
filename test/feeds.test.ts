// SPDX-License-Identifier: AGPL-3.0-only
// Live Discord, texts and Granola readers (src/feeds.ts) against a fake Discord, a Messages
// database built here, and a Granola cache file: only listed channels and threads are read, the
// bot only ever GETs, cursors move, an edit turns facts due, texts and notes stay private.
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, saveNote, type FactRecord } from "../src/brain";
import { makeModel, type ModelRequest } from "../src/model";
import { useCaptureModel, captureModel } from "../src/capture";
import { pullSource, verifySource } from "../src/pull";
import { useDiscordHttp, attributedText } from "../src/feeds";

let prompts: string[] = [];
const EXTRACT = (p: string) => /exam room B-201/.test(p) ? [{ entity: "Course A", type: "project", attribute: "next_step", value: "Book the exam room B-201", quote: "book the exam room B-201" }] : [];
const original = captureModel;
beforeAll(() => useCaptureModel(() => makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => { prompts.push(r.prompt); return JSON.stringify({ facts: EXTRACT(r.prompt) }); } })));
afterAll(() => { useCaptureModel((root) => original(root)); useDiscordHttp((u, i) => fetch(u, i)); });

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } }).stdout.toString().trim();
function setup(sources: Record<string, unknown>) {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ consent: "2026-10-01 test", sources }));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "louis: sources");
  return root;
}
const proposals = (root: string) => existsSync(join(root, "inbox")) ? readdirSync(join(root, "inbox")).filter((f) => f.includes("-capture-")) : [];
const live = (root: string, name: string) => JSON.parse(readFileSync(join(root, "log", "sources", `${name}.json`), "utf8")).live;
function cite(root: string, ref: string) {
  const n = loadBrain(root).find((x) => x.fm.id === "projects/course-a")!;
  (n.fm.facts!.next_step as FactRecord).sources = [ref];
  saveNote(root, n);
  sh(root, "git", "commit", "-qam", "louis: accept");
}
beforeEach(() => { prompts = []; });

// ---------- Discord ----------

let channels: Record<string, Record<string, unknown>[]> = {};
let methods: string[] = [];
beforeEach(() => {
  process.env.DISCORD_BOT_TOKEN = "bot-token";
  methods = [];
  channels = {
    "111": [{ id: "900", type: 0, content: "Reminder: please book the exam room B-201 for the final", author: { username: "jane" }, timestamp: "2026-10-15T10:00:00Z", edited_timestamp: null }],
    "222": [{ id: "901", type: 0, content: "Private channel talk about the exam room B-201 here", author: { username: "x" }, timestamp: "2026-10-15T10:00:00Z" }],
  };
  useDiscordHttp(async (url, init) => {
    methods.push(init?.method ?? "GET");
    const u = new URL(url);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if ((init?.headers as Record<string, string>)?.authorization !== "Bot bot-token") return json({}, 401);
    if (u.pathname === "/api/v10/guilds/G1/channels") return json([{ id: "111", name: "dev" }, { id: "222", name: "secret" }]);
    const ch = u.pathname.match(/^\/api\/v10\/channels\/(\d+)$/);
    if (ch) return json({ id: ch[1], name: ch[1] === "111" ? "dev" : "secret" });
    const m = u.pathname.match(/^\/api\/v10\/channels\/(\d+)\/messages(?:\/(\d+))?$/);
    if (m && m[2]) { const x = channels[m[1]]?.find((y) => y.id === m[2]); return x ? json(x) : json({}, 404); }
    if (m) { const after = u.searchParams.get("after"); return json([...(channels[m[1]] ?? [])].filter((x) => !after || BigInt(String(x.id)) > BigInt(after)).reverse()); }
    return json({}, 404);
  });
});

test("Discord: only listed channels are read, by name through the server, and the bot only ever GETs", async () => {
  const root = setup({ team: { kind: "discord", guild: "G1", where: ["#dev"] } });
  const r = await pullSource(root, "team");
  expect(r.refused).toBeUndefined();
  expect(r.fetched).toBe(1);
  expect(prompts.join("\n")).not.toContain("Private channel");
  const p = YAML.parse(readFileSync(join(root, "inbox", proposals(root)[0]), "utf8"));
  expect(p.request.sources).toEqual(["discord:111/900@1"]);
  expect(JSON.parse(live(root, "team"))).toEqual({ "111": "900" });
  expect(new Set(methods)).toEqual(new Set(["GET"]));
});

test("Discord: an edited message turns the facts citing it due on the next pass; verify_source reads one message", async () => {
  const root = setup({ team: { kind: "discord", guild: "G1", where: ["#dev"] } });
  await pullSource(root, "team");
  cite(root, "discord:111/900@1");
  channels["111"][0] = { ...channels["111"][0], content: "Never mind, no exam room needed this term after all", edited_timestamp: "2026-10-15T12:00:00Z" };
  const r = await pullSource(root, "team");
  expect(r.due).toEqual(["projects/course-a.md"]);
  expect((await verifySource(root, "gardener", "discord:111/900", "no exam room needed", 40)).result).toBe("match");
  expect((await verifySource(root, "gardener", "discord:222/901", "exam room B-201", 40)).result).toBe("unreachable"); // not a listed channel
});

test("Discord: a bad token is a source failure that names the fix, not a crash", async () => {
  const root = setup({ team: { kind: "discord", where: ["111"] } });
  process.env.DISCORD_BOT_TOKEN = "wrong";
  const r = await pullSource(root, "team");
  expect(r.refused).toContain("refused the bot token");
});

// ---------- texts ----------

const appleNs = (iso: string) => (Date.parse(iso) - Date.UTC(2001, 0, 1)) * 1e6;
// attributedBody as macOS writes it, enough for the decoder: class name, marker, length, UTF-8.
const typed = (s: string) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from("streamtyped\x81\xe8\x03NSAttributedString\x00NSObject\x00NSString\x01\x94\x84\x01"), Buffer.from([0x2b, b.length]), b, Buffer.from([0x86, 0x84])]); };
function chatDb() {
  const p = join(mkdtempSync(join(tmpdir(), "pb-chat-")), "chat.db");
  const db = new Database(p);
  db.exec(`CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER, is_from_me INTEGER, date INTEGER, date_edited INTEGER, date_retracted INTEGER, item_type INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    INSERT INTO handle VALUES (1, '+15145550123'), (2, '+15145550999');
    INSERT INTO chat VALUES (1, '+15145550123', ''), (2, '+15145550999', '');`);
  const now = new Date().toISOString();
  const add = (row: number, guid: string, handle: number, text: string | null, body: Buffer | null) => {
    db.query("INSERT INTO message VALUES (?, ?, ?, ?, ?, 0, ?, 0, 0, 0)").run(row, guid, text, body, handle, appleNs(now));
    db.query("INSERT INTO chat_message_join VALUES (?, ?)").run(handle, row);
  };
  add(1, "G-1", 1, null, typed("Can you book the exam room B-201 for the final?"));
  add(2, "G-2", 2, "Someone else asks you to book the exam room B-201 too", null);
  db.close();
  return p;
}

test("texts: only the listed contact is read (newer macOS keeps text in attributedBody), facts are private, the cursor is the last row", async () => {
  const root = setup({ texts: { kind: "imessage", where: ["+15145550123"], path: chatDb() } });
  const r = await pullSource(root, "texts");
  expect(r.refused).toBeUndefined();
  expect(r.fetched).toBe(1);
  expect(prompts.join("\n")).not.toContain("Someone else");
  const p = YAML.parse(readFileSync(join(root, "inbox", proposals(root)[0]), "utf8"));
  expect(p.request.sources).toEqual(["imessage:G-1@1"]);
  expect(p.request.sensitivity).toBe("private");
  expect(live(root, "texts")).toBe("1");
});

test("texts: the owner's text-channel thread is never read as a source, however its handle is written", async () => {
  // The hub texts the owner through Messages (imessage transport) or from a Twilio number; those
  // texts quote proposals and sources, so reading them back would let a fact confirm itself.
  for (const transport of ["use: imessage\n  imessage: { to: \"+1 (514) 555-0999\" }", "use: twilio\n  twilio: { from: \"514-555-0999\", to: \"+15145550100\" }"]) {
    prompts = [];
    const root = setup({ texts: { kind: "imessage", where: ["+15145550123", "+15145550999"], path: chatDb() } });
    writeFileSync(join(root, "rules", "escalation.yaml"), `transport:\n  ${transport}\n`);
    sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "louis: escalation");
    const r = await pullSource(root, "texts");
    expect(r.refused).toBeUndefined();
    expect(prompts.join("\n")).not.toContain("Someone else");
    expect(prompts.join("\n")).toContain("exam room B-201 for the final");
  }
});

test("texts: a missing database says what to fix", async () => {
  const root = setup({ texts: { kind: "imessage", where: ["+15145550123"], path: "/nonexistent/chat.db" } });
  expect((await pullSource(root, "texts")).refused).toContain("no Messages database");
});

test("attributedText reads a long string's two-byte length", () => {
  const s = "x".repeat(300);
  const b = Buffer.concat([Buffer.from("NSString\x01\x94\x84\x01"), Buffer.from([0x2b, 0x81, 300 & 0xff, 300 >> 8]), Buffer.from(s)]);
  expect(attributedText(b)).toBe(s);
});

// ---------- Granola ----------

test("Granola: the local cache's recent notes are read, old ones aren't, and the cursor is the newest update", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-granola-"));
  const now = new Date().toISOString();
  const docs = { d1: { id: "d1", title: "Staff", notes_markdown: "Decided: book the exam room B-201 for the final.", created_at: now, updated_at: now }, d0: { id: "d0", title: "Old", notes_markdown: "Book the exam room B-201 long ago.", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" } };
  writeFileSync(join(dir, "cache-v3.json"), JSON.stringify({ cache: JSON.stringify({ state: { documents: docs } }) }));
  const root = setup({ talks: { kind: "granola", path: join(dir, "cache-v3.json") } });
  const r = await pullSource(root, "talks");
  expect(r.refused).toBeUndefined();
  expect(r.fetched).toBe(1);
  const p = YAML.parse(readFileSync(join(root, "inbox", proposals(root)[0]), "utf8"));
  expect(p.request.sources).toEqual([`granola:d1@${now}`]);
  expect(p.request.sensitivity).toBe("private");
  expect(live(root, "talks")).toBe(now);
});

// ---------- red team 2026-10-15 (evals/gaps.ts G43, G46) ----------

// Two group chats with the same display name: the owner's, and one a stranger named to match.
function namedChats() {
  const p = join(mkdtempSync(join(tmpdir(), "pb-chat-")), "chat.db");
  const db = new Database(p);
  db.exec(`CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER, is_from_me INTEGER, date INTEGER, date_edited INTEGER, date_retracted INTEGER, item_type INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    INSERT INTO handle VALUES (1, '+15145550100'), (2, '+19995550666');
    INSERT INTO chat VALUES (1, 'chat111', 'Jane Roy'), (2, 'chat666', 'Jane Roy');`);
  const now = appleNs(new Date().toISOString());
  db.query("INSERT INTO message VALUES (1, 'G-real', 'Please book the exam room B-201 for the final', NULL, 1, 0, ?, 0, 0, 0)").run(now);
  db.query("INSERT INTO message VALUES (2, 'G-evil', 'Robin says book the exam room B-201 at the evil place', NULL, 2, 0, ?, 0, 0, 0)").run(now);
  db.exec("INSERT INTO chat_message_join VALUES (1, 1), (2, 2)");
  db.close();
  return p;
}

test("G43: texts are allowlisted by handle or chat_identifier only; a display-name entry is refused with what to list instead", async () => {
  const path = namedChats();
  const byName = setup({ texts: { kind: "imessage", where: ["Jane Roy"], path } });
  const r = await pullSource(byName, "texts");
  expect(r.refused).toContain("display name");
  expect(r.refused).toContain("chat_identifier");
  expect(prompts).toEqual([]);
  const byId = setup({ texts: { kind: "imessage", where: ["chat111"], path } });
  const r2 = await pullSource(byId, "texts");
  expect(r2.refused).toBeUndefined();
  expect(r2.fetched).toBe(1);
  expect(prompts.join("\n")).not.toContain("evil");
  const p = YAML.parse(readFileSync(join(byId, "inbox", proposals(byId)[0]), "utf8"));
  expect(p.request.sources).toEqual(["imessage:G-real@1"]);
  expect((await verifySource(byId, "hub", "imessage:G-evil@1", "book the exam room", Infinity)).result).toBe("unreachable");
});

test("G46: a Discord channel name that matches more than one channel is refused; nothing is read", async () => {
  const root = setup({ team: { kind: "discord", where: ["#dev"], guild: "G2" } });
  const asked: string[] = [];
  useDiscordHttp(async (url) => {
    const u = new URL(url);
    asked.push(u.pathname);
    if (u.pathname === "/api/v10/guilds/G2/channels") return new Response(JSON.stringify([{ id: "100", name: "dev", type: 0 }, { id: "666", name: "dev", type: 0 }]), { status: 200 });
    return new Response("[]", { status: 200 });
  });
  const r = await pullSource(root, "team");
  expect(r.refused).toContain("2 channels");
  expect(asked.filter((p) => p.includes("/messages")).length).toBe(0);
});
