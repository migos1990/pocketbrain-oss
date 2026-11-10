// SPDX-License-Identifier: AGPL-3.0-only
// Live Gmail pulls against a fake Gmail (src/gmail.ts): the consent line, the first listing and
// the history cursor after it, deletions turning facts due, forwarded mail keeping its account,
// a dry run that writes nothing, a token with too much scope refused, and the browser sign-in
// saving the refresh token as a key file. Nothing here reaches Google or a real model.
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, saveNote, type FactRecord } from "../src/brain";
import { makeModel, type ModelRequest } from "../src/model";
import { useCaptureModel, captureModel } from "../src/capture";
import { pullSource, verifySource, recheckDue } from "../src/pull";
import { useHttp, bodyText, connectGoogle, GMAIL_SCOPE, GCAL_SCOPE, DRIVE_SCOPE } from "../src/google";

const EXTRACT = (p: string) => /exam room B-201/.test(p) ? [{ entity: "Course A", type: "project", attribute: "next_step", value: "Book the exam room B-201", quote: "book the exam room B-201" }] : [];
beforeAll(() => useCaptureModel(() => makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => JSON.stringify({ facts: EXTRACT(r.prompt) }) })));
afterAll(() => { useCaptureModel(); useHttp((u, i) => fetch(u, i)); });

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const msg = (id: string, to: string, body: string, label = "INBOX") => ({ id, labelIds: [label], internalDate: "1760300000000", payload: { mimeType: "multipart/alternative", headers: [{ name: "Delivered-To", value: to.replace(/^.*<|>.*$/g, "") }, { name: "From", value: "dean@school.example" }, { name: "To", value: to }, { name: "Subject", value: "Exam" }], parts: [{ mimeType: "text/plain", body: { data: b64(body) } }, { mimeType: "text/html", body: { data: b64(`<p>${body}</p>`) } }] } });

// A fake Gmail: the token endpoint, profile, list, history and get.
let mail: Record<string, unknown> = {};
let history: { start: string; added: string[]; deleted: string[]; next: string } | "expired" | undefined;
let scope = GMAIL_SCOPE;
let calls: string[] = [];
// The fake Calendar: events by id, and what each sync token returns next.
let events: Record<string, Record<string, unknown>> = {};
let sync: Record<string, { items: string[]; next: string } | "expired"> = {};
// The fake Drive: files by id, each with its folder, version and text.
type DFile = { id: string; name: string; mimeType: string; parents: string[]; version: string; modifiedTime: string; text: string };
let files: Record<string, DFile> = {};
beforeEach(() => {
  calls = []; scope = GMAIL_SCOPE; history = undefined; events = {}; sync = {}; files = {};
  process.env.GDRIVE_REFRESH_TOKEN_PRIMARY = `drv-${Math.random()}`;
  process.env.GCAL_REFRESH_TOKEN_PRIMARY = `cal-${Math.random()}`;
  mail = { m1: msg("m1", "Louis <me@school.example>", "Please book the exam room B-201 for the final, thanks"), m2: msg("m2", "me@personal.example", "Lunch on Friday? Let me know when works") };
  process.env.GOOGLE_CLIENT_ID = "cid"; process.env.GOOGLE_CLIENT_SECRET = "csecret"; process.env.GMAIL_REFRESH_TOKEN_PRIMARY = `refresh-${Math.random()}`; // a fresh token per test: no cached access token
  useHttp(useHttpCurrent = async (url, init) => {
    const u = new URL(url);
    calls.push(u.pathname.split("/").slice(-1)[0]);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (u.host === "oauth2.googleapis.com") {
      const f = new URLSearchParams(String(init?.body));
      if (f.get("grant_type") === "refresh_token" && f.get("refresh_token")?.startsWith("cal-")) return json({ access_token: "at-cal", expires_in: 3600, scope: GCAL_SCOPE });
      if (f.get("grant_type") === "refresh_token" && f.get("refresh_token")?.startsWith("drv-")) return json({ access_token: "at-drv", expires_in: 3600, scope: DRIVE_SCOPE });
      if (f.get("grant_type") === "refresh_token") return f.get("refresh_token")?.startsWith("refresh-") ? json({ access_token: "at-1", expires_in: 3600, scope }) : json({ error: "invalid_grant" }, 400);
      if (f.get("grant_type") === "authorization_code") return json({ access_token: "at-2", refresh_token: "new-refresh", expires_in: 3600, scope });
    }
    if (init?.headers && (init.headers as Record<string, string>).authorization?.startsWith("Bearer at-") !== true) return json({}, 401);
    if (u.pathname === "/calendar/v3/calendars/primary") return json({ id: "me@personal.example" });
    if (u.pathname === "/drive/v3/about") return json({ user: { emailAddress: "me@personal.example" } });
    const dr = u.pathname.match(/^\/drive\/v3\/files(?:\/([^/]+))?(\/export)?$/);
    const meta = ({ text: _t, ...m }: DFile) => m;
    if (dr && dr[1]) {
      const f = files[dr[1]];
      if (!f) return json({}, 404);
      if (dr[2] || u.searchParams.get("alt") === "media") { calls.push(`read:${f.id}`); return new Response(f.text); }
      return json(meta(f));
    }
    if (dr) {
      const q = u.searchParams.get("q") ?? "";
      const folder = q.match(/'([^']+)' in parents/)?.[1], after = q.match(/modifiedTime > '([^']+)'/)?.[1];
      return json({ files: Object.values(files).filter((f) => folder && f.parents.includes(folder) && (!after || f.modifiedTime > after)).map(meta) });
    }
    const ev = u.pathname.match(/^\/calendar\/v3\/calendars\/primary\/events(?:\/(.+))?$/);
    if (ev && ev[1]) return events[ev[1]] ? json(events[ev[1]]) : json({}, 404);
    if (ev) {
      const t = u.searchParams.get("syncToken");
      if (!t) return json({ items: Object.values(events), nextSyncToken: "s1" });
      const n = sync[t];
      if (!n || n === "expired") return json({}, 410);
      return json({ items: n.items.map((id) => events[id]), nextSyncToken: n.next });
    }
    const p = u.pathname.replace("/gmail/v1/users/me/", "");
    if (p === "profile") return json({ emailAddress: "me@personal.example", historyId: "100" });
    if (p === "messages") return json({ messages: Object.keys(mail).filter((id) => !u.searchParams.get("labelIds") || (mail[id] as { labelIds: string[] }).labelIds.includes(u.searchParams.get("labelIds")!)).map((id) => ({ id })) });
    if (p === "history") {
      if (history === "expired") return json({}, 404);
      return json({ historyId: history?.next ?? "100", history: history ? [{ messagesAdded: history.added.map((id) => ({ message: { id } })), messagesDeleted: history.deleted.map((id) => ({ message: { id } })) }] : [] });
    }
    const m = p.match(/^messages\/(.+)$/);
    if (m) return mail[m[1]] ? json(mail[m[1]]) : json({}, 404);
    return json({}, 404);
  });
});

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } }).stdout.toString().trim();
function setup(consent: boolean) {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ ...(consent ? { consent: "2026-10-01 test" } : {}), sources: { mail: { kind: "gmail", account: "primary", area: "personal", forwarded: [{ to: "@school.example", account: "school", area: "school", min_sensitivity: "private" }] } } }));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "louis: sources");
  return root;
}
const state = (root: string) => JSON.parse(readFileSync(join(root, "log", "sources", "mail.json"), "utf8"));
const proposals = (root: string) => existsSync(join(root, "inbox")) ? readdirSync(join(root, "inbox")).filter((f) => f.includes("-capture-")) : [];

test("no live read without the consent line: Gmail isn't even called", async () => {
  const root = setup(false);
  const r = await pullSource(root, "mail");
  expect(r.refused).toContain("consent");
  expect(calls).toEqual([]);
});

test("first pass lists recent mail, later passes read Gmail's history; a deleted message turns its facts due", async () => {
  const root = setup(true);
  const r = await pullSource(root, "mail");
  expect(r.refused).toBeUndefined();
  expect(r.fetched).toBe(2);
  expect(r.proposals).toBe(1);
  expect(state(root).live).toBe("100");
  const p = YAML.parse(readFileSync(join(root, "inbox", proposals(root)[0]), "utf8"));
  expect(p.request.sources).toEqual(["gmail:primary/m1"]);
  expect(p.request.sensitivity).toBe("private"); // forwarded from the school account
  // Accept it, so a fact cites m1.
  const n = loadBrain(root).find((x) => x.fm.id === "projects/course-a")!;
  (n.fm.facts!.next_step as FactRecord).sources = ["gmail:primary/m1"];
  saveNote(root, n);
  sh(root, "git", "commit", "-qam", "louis: accept");
  // Next pass: history says m3 arrived and m1 was deleted.
  mail.m3 = msg("m3", "me@personal.example", "Short note about nothing much at all today");
  history = { start: "100", added: ["m3"], deleted: ["m1"], next: "105" };
  calls = [];
  const r2 = await pullSource(root, "mail");
  expect(calls).toContain("history");
  expect(calls).not.toContain("messages"); // no listing once a cursor exists
  expect(r2.due).toEqual(["projects/course-a.md"]);
  expect(state(root).live).toBe("105");
  expect((loadBrain(root).find((x) => x.fm.id === "projects/course-a")!.fm.facts!.next_step as FactRecord).recheck?.why).toBe("source gone");
});

test("an expired history cursor falls back to listing the last week", async () => {
  const root = setup(true);
  await pullSource(root, "mail");
  history = "expired";
  calls = [];
  const r = await pullSource(root, "mail");
  expect(r.refused).toBeUndefined();
  expect(calls).toContain("messages");
});

test("a dry run reads and extracts but writes nothing, and shows each item's account and area", async () => {
  const root = setup(true);
  const head = sh(root, "git", "rev-parse", "HEAD");
  const r = await pullSource(root, "mail", { dryRun: true });
  expect(r.preview!.length).toBe(2);
  const school = r.preview!.find((p) => p.ref === "gmail:primary/m1")!;
  expect(school).toMatchObject({ account: "school", area: "school", floor: "private" });
  expect(school.facts[0]).toMatchObject({ entity: "Course A", attribute: "next_step", value: "Book the exam room B-201" });
  expect(sh(root, "git", "rev-parse", "HEAD")).toBe(head);
  expect(sh(root, "git", "status", "--porcelain")).toBe("");
  expect(existsSync(join(root, "log", "sources"))).toBe(false);
  expect(proposals(root)).toEqual([]);
});

test("a token carrying more than read-only Gmail is refused, and the failure never prints the token", async () => {
  const root = setup(true);
  scope = `${GMAIL_SCOPE} https://www.googleapis.com/auth/gmail.send`;
  const r = await pullSource(root, "mail");
  expect(r.refused).toContain("more than read-only");
  expect(calls).not.toContain("messages");
  process.env.GMAIL_REFRESH_TOKEN_PRIMARY = "revoked-token";
  scope = GMAIL_SCOPE;
  const r2 = await pullSource(root, "mail");
  expect(r2.refused).toContain("refused the Gmail token");
  expect(readFileSync(join(root, "log", "alerts.jsonl"), "utf8")).not.toContain("revoked-token");
});

test("bodyText prefers text/plain and strips HTML otherwise", () => {
  expect(bodyText({ mimeType: "text/html", body: { data: b64("<style>x{}</style><p>Hello&nbsp;there</p><br>Bye") } })).toBe("Hello there\nBye");
});

test("connect saves the refresh token as a private key file, and refuses another account than the source's address", async () => {
  process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-keys-"));
  try {
    const wrong = await connectGoogle({ kind: "gmail", account: "primary", address: "someone-else@example.com" });
    const st = new URL(wrong.url).searchParams.get("state")!, redirect = new URL(wrong.url).searchParams.get("redirect_uri")!;
    expect(new URL(wrong.url).searchParams.get("scope")).toBe(GMAIL_SCOPE);
    const failed = wrong.done.catch((e) => String(e.message));
    await fetch(`${redirect}?state=${st}&code=abc`);
    expect(await failed).toContain("isn't this source's address");
    expect(existsSync(join(process.env.PB_CONFIG_DIR, "keys", "GMAIL_REFRESH_TOKEN_PRIMARY"))).toBe(false);

    const ok = await connectGoogle({ kind: "gmail", account: "primary", address: "me@personal.example" });
    const u = new URL(ok.url);
    await fetch(`${u.searchParams.get("redirect_uri")}?state=${u.searchParams.get("state")}&code=abc`);
    expect(await ok.done).toBe("GMAIL_REFRESH_TOKEN_PRIMARY");
    const f = join(process.env.PB_CONFIG_DIR, "keys", "GMAIL_REFRESH_TOKEN_PRIMARY");
    expect(readFileSync(f, "utf8").trim()).toBe("new-refresh");
    expect(statSync(f).mode & 0o077).toBe(0);
  } finally { delete process.env.PB_CONFIG_DIR; }
});

test("verify_source reads one live message by id; forwarded school mail gives no quote above a personal ceiling", async () => {
  const root = setup(true);
  const yes = await verifySource(root, "gardener", "gmail:primary/m2", "Lunch on Friday", 40, "personal");
  expect(yes).toMatchObject({ result: "match", quote: "Lunch on Friday?" });
  const school = await verifySource(root, "gardener", "gmail:primary/m1", "book the exam room B-201", 40, "personal");
  expect(school.result).toBe("match");
  expect(school.quote).toBeUndefined();
  // Not in the mailbox (deleted): the source is gone, not unreachable.
  expect(await verifySource(root, "gardener", "gmail:primary/nope", "x", 40)).toMatchObject({ result: "no-match", why: expect.stringContaining("source gone") });
  expect(calls).not.toContain("messages"); // one get per check, never a listing
});

test("a live mail deleted from the mailbox turns the facts citing it due as source gone on the night pass", async () => {
  const root = setup(true);
  const n = loadBrain(root).find((x) => x.fm.id === "projects/course-a")!;
  n.fm.facts!.next_step = { value: "Book the exam room B-201", as_of: "2026-10-07", sources: ["gmail:primary/m9"], verification: "verified-by-source", by: "planner" } as FactRecord;
  saveNote(root, n);
  sh(root, "git", "commit", "-qam", "louis: fact from a mail");
  const r = await recheckDue(root);
  expect(r.due).toContain("projects/course-a#next_step");
  const f = loadBrain(root).find((x) => x.fm.id === "projects/course-a")!.fm.facts!.next_step as FactRecord;
  expect(f).toMatchObject({ value: "Book the exam room B-201", verification: "unverified", recheck: { why: "source gone", ref: "gmail:primary/m9" } });
});

const iso = (days: number) => new Date(Date.now() + days * 864e5).toISOString();
function calRoot() {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ consent: "2026-10-01 test", sources: { cal: { kind: "gcal", account: "primary" } } }));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "louis: sources");
  return root;
}

test("Calendar: the first sync keeps recent and coming events only, later syncs read changes, a cancelled event turns its facts due", async () => {
  const root = calRoot();
  events = {
    e1: { id: "e1", etag: '"7"', status: "confirmed", updated: iso(-1), summary: "Final exam", start: { dateTime: iso(5) }, description: "Please book the exam room B-201 for the final" },
    old: { id: "old", etag: '"1"', status: "confirmed", updated: "2020-01-01T00:00:00Z", summary: "Old", start: { dateTime: "2020-01-02T10:00:00Z" }, description: "Please book the exam room B-201 back then" },
  };
  const r = await pullSource(root, "cal");
  expect(r.refused).toBeUndefined();
  expect(r.fetched).toBe(1); // the 2020 event is never read
  const p = YAML.parse(readFileSync(join(root, "inbox", proposals(root)[0]), "utf8"));
  expect(p.request.sources).toEqual(["gcal:e1@7"]);
  expect(JSON.parse(JSON.parse(readFileSync(join(root, "log", "sources", "cal.json"), "utf8")).live)).toEqual({ primary: "s1" });
  const n = loadBrain(root).find((x) => x.fm.id === "projects/course-a")!;
  (n.fm.facts!.next_step as FactRecord).sources = ["gcal:e1@7"];
  saveNote(root, n);
  sh(root, "git", "commit", "-qam", "louis: accept");
  events.e1 = { ...events.e1, status: "cancelled", etag: '"8"' };
  sync = { s1: { items: ["e1"], next: "s2" } };
  const r2 = await pullSource(root, "cal");
  expect(r2.due).toEqual(["projects/course-a.md"]);
  expect(JSON.parse(JSON.parse(readFileSync(join(root, "log", "sources", "cal.json"), "utf8")).live)).toEqual({ primary: "s2" });
});

test("Calendar: an expired sync token starts a fresh sync instead of failing", async () => {
  const root = calRoot();
  events = { e1: { id: "e1", etag: '"7"', status: "confirmed", updated: iso(-1), summary: "Lunch", start: { dateTime: iso(1) }, description: "Lunch with the team at noon downtown" } };
  await pullSource(root, "cal");
  sync = { s1: "expired" };
  const r = await pullSource(root, "cal");
  expect(r.refused).toBeUndefined();
});

test("Calendar: verify_source reads one event; connect checks the primary calendar's owner", async () => {
  const root = calRoot();
  events = { e1: { id: "e1", etag: '"7"', status: "confirmed", updated: iso(-1), summary: "Final exam", start: { dateTime: iso(5) }, description: "Room B-201" } };
  expect((await verifySource(root, "gardener", "gcal:e1@7", "Final exam in room B-201", 40)).result).toBe("match");
  process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-keys-"));
  try {
    const c = await connectGoogle({ kind: "gcal", account: "primary", address: "me@personal.example" });
    const u = new URL(c.url);
    expect(u.searchParams.get("scope")).toBe(GCAL_SCOPE);
    scope = GCAL_SCOPE;
    await fetch(`${u.searchParams.get("redirect_uri")}?state=${u.searchParams.get("state")}&code=abc`);
    expect(await c.done).toBe("GCAL_REFRESH_TOKEN_PRIMARY");
  } finally { delete process.env.PB_CONFIG_DIR; }
});

const DOC = "application/vnd.google-apps.document";
function driveRoot(where: string[] | null = ["F1"]) {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ consent: "2026-10-01 test, Drive too", sources: { docs: { kind: "gdoc", account: "primary", ...(where ? { where } : {}) } } }));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "louis: sources");
  return root;
}

test("Drive: only listed folders are read, Google Docs as text, other files skipped; a new version turns its facts due", async () => {
  const root = driveRoot();
  files = {
    d1: { id: "d1", name: "Exam plan", mimeType: DOC, parents: ["F1"], version: "3", modifiedTime: iso(-1), text: "Please book the exam room B-201 for the final" },
    d2: { id: "d2", name: "Elsewhere", mimeType: DOC, parents: ["F2"], version: "1", modifiedTime: iso(-1), text: "Please book the exam room B-201 for the final" },
    p1: { id: "p1", name: "Scan", mimeType: "application/pdf", parents: ["F1"], version: "1", modifiedTime: iso(-1), text: "%PDF" },
    old: { id: "old", name: "Old", mimeType: DOC, parents: ["F1"], version: "9", modifiedTime: "2020-01-01T00:00:00.000Z", text: "Please book the exam room B-201 back then" },
  };
  const r = await pullSource(root, "docs");
  expect(r.refused).toBeUndefined();
  expect(r.fetched).toBe(1);
  expect(calls.filter((c) => c.startsWith("read:"))).toEqual(["read:d1"]); // never d2 (other folder), the PDF or the 2020 doc
  const p = YAML.parse(readFileSync(join(root, "inbox", proposals(root)[0]), "utf8"));
  expect(p.request.sources).toEqual(["gdoc:d1@3"]);
  const n = loadBrain(root).find((x) => x.fm.id === "projects/course-a")!;
  (n.fm.facts!.next_step as FactRecord).sources = ["gdoc:d1@3"];
  saveNote(root, n);
  sh(root, "git", "commit", "-qam", "louis: accept");
  files.d1 = { ...files.d1, version: "4", modifiedTime: iso(0), text: "The exam moved; no room needed yet" };
  const r2 = await pullSource(root, "docs");
  expect(r2.due).toEqual(["projects/course-a.md"]);
});

test("Drive: a live source with no folders listed is refused, never the whole Drive", async () => {
  const root = driveRoot(null);
  files = { d1: { id: "d1", name: "Exam plan", mimeType: DOC, parents: ["F1"], version: "3", modifiedTime: iso(-1), text: "Please book the exam room B-201 for the final" } };
  const r = await pullSource(root, "docs");
  expect(r.refused).toContain("where:");
  expect(calls.filter((c) => c.startsWith("read:"))).toEqual([]);
});

test("Drive: verify_source reads a doc in a listed folder, refuses one outside without reading it; connect checks the Drive account", async () => {
  const root = driveRoot();
  files = {
    d1: { id: "d1", name: "Exam plan", mimeType: DOC, parents: ["F1"], version: "3", modifiedTime: iso(-1), text: "Final exam in room B-201" },
    d2: { id: "d2", name: "Elsewhere", mimeType: DOC, parents: ["F2"], version: "1", modifiedTime: iso(-1), text: "Final exam in room B-201" },
  };
  expect((await verifySource(root, "gardener", "gdoc:d1@3", "Final exam in room B-201", 40)).result).toBe("match");
  calls = [];
  expect((await verifySource(root, "gardener", "gdoc:d2@1", "Final exam in room B-201", 40)).result).not.toBe("match");
  expect(calls.filter((c) => c.startsWith("read:"))).toEqual([]);
  process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-keys-"));
  try {
    const c = await connectGoogle({ kind: "gdoc", account: "primary", address: "me@personal.example" });
    const u = new URL(c.url);
    expect(u.searchParams.get("scope")).toBe(DRIVE_SCOPE);
    scope = DRIVE_SCOPE;
    await fetch(`${u.searchParams.get("redirect_uri")}?state=${u.searchParams.get("state")}&code=abc`);
    expect(await c.done).toBe("GDRIVE_REFRESH_TOKEN_PRIMARY");
  } finally { delete process.env.PB_CONFIG_DIR; }
});

test("Drive: a consent line that doesn't name Drive reads nothing (Gmail and Calendar consent isn't Drive consent)", async () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ consent: "2026-10-01 Gmail and Calendar read-only", sources: { docs: { kind: "gdoc", account: "primary", where: ["F1"] } } }));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "louis: sources");
  files = { d1: { id: "d1", name: "Exam plan", mimeType: DOC, parents: ["F1"], version: "3", modifiedTime: iso(-1), text: "Final exam in room B-201" } };
  expect((await pullSource(root, "docs")).refused).toContain("Drive");
  expect((await verifySource(root, "gardener", "gdoc:d1@3", "Final exam in room B-201", 40)).result).not.toBe("match");
  expect(calls).toEqual([]);
});

// ---------- red team 2026-10-15 (evals/gaps.ts G41) ----------

// 100 unsolicited messages outside the allowlist arrive ahead of a labelled one.
function flood(honourLabel: boolean) {
  const junk = Array.from({ length: 100 }, (_, i) => `junk${String(i).padStart(3, "0")}`);
  for (const id of junk) mail[id] = msg(id, "me@personal.example", "Limited offer just for you today friend");
  mail.school1 = msg("school1", "me@personal.example", "Please book the exam room B-201 for the final", "Label_school");
  const ids = [...junk, "school1"];
  const fetched: string[] = [];
  const inner = useHttpCurrent;
  useHttp(async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/history")) {
      calls.push("history");
      const label = u.searchParams.get("labelId");
      const list = honourLabel && label ? ids.filter((id) => (mail[id] as { labelIds: string[] }).labelIds.includes(label)) : ids;
      return new Response(JSON.stringify({ historyId: "200", history: [{ messagesAdded: list.map((id) => ({ message: { id } })) }] }), { status: 200 });
    }
    const m = u.pathname.match(/\/messages\/(.+)$/);
    if (m) fetched.push(m[1]);
    return inner!(url, init);
  });
  return fetched;
}
let useHttpCurrent: ((url: string, init?: RequestInit) => Promise<Response>) | undefined;

test("G41: Gmail history asks only for the allowlisted labels, so 100 unlisted messages are never fetched", async () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ consent: "2026-10-01", sources: { mail: { kind: "gmail", account: "primary", where: ["Label_school"] } } }));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "louis: sources");
  mkdirSync(join(root, "log", "sources"), { recursive: true });
  writeFileSync(join(root, "log", "sources", "mail.json"), JSON.stringify({ live: "100", seen: {} }));
  const fetched = flood(true);
  const r = await pullSource(root, "mail");
  expect(r.refused).toBeUndefined();
  expect(fetched).toEqual(["school1"]);
  expect(r.proposals).toBe(1);
});

test("G41: when unlisted messages still come back, they are marked seen and the pull moves past them", async () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ consent: "2026-10-01", sources: { mail: { kind: "gmail", account: "primary", where: ["Label_school"] } } }));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "louis: sources");
  mkdirSync(join(root, "log", "sources"), { recursive: true });
  writeFileSync(join(root, "log", "sources", "mail.json"), JSON.stringify({ live: "100", seen: {} }));
  const fetched = flood(false);
  let proposed = 0;
  for (let pass = 0; pass < 3 && !proposed; pass++) proposed += (await pullSource(root, "mail")).proposals ?? 0;
  expect(proposed).toBe(1);
  expect(fetched.filter((id) => id === "junk000").length).toBe(1); // each unlisted message is read once at most
});

test("G41: Calendar with more than 100 changed events moves past the ones it has seen instead of re-reading them", async () => {
  const root = calRoot();
  await pullSource(root, "cal"); // full sync of an empty calendar: sync token s1
  events = {};
  for (let i = 0; i < 100; i++) events[`j${i}`] = { id: `j${i}`, etag: '"1"', status: "confirmed", updated: iso(-1) };
  events.real = { id: "real", etag: '"3"', status: "confirmed", updated: iso(-1), summary: "Final exam", start: { dateTime: iso(5) }, description: "Please book the exam room B-201 for the final" };
  sync = { s1: { items: Object.keys(events), next: "s2" } };
  let proposed = 0;
  for (let pass = 0; pass < 3 && !proposed; pass++) proposed += (await pullSource(root, "cal")).proposals ?? 0;
  expect(proposed).toBe(1);
});

// Mac 2026-11-09: the calendar_pull check said "1 coming events were never read, the pull is
// broken". It wasn't broken: an event made in July for December 19 was past the first sync's
// 60-day window, and the sync token only returns what changes after it, so an unedited event that
// time brings into the window was never read. Same for a weekly series whose first meeting is
// older than the window. Each pass now reads the coming events the pull never saw (G744).
test("G744: a coming event the first sync left out (too far ahead, or an old series) is read once it's in the coming 60 days", async () => {
  const root = calRoot();
  process.env.PB_TODAY = iso(0).slice(0, 10); // the cache's day and Google's now are the same clock here
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ consent: "2026-10-01 test", sources: { cal: { kind: "gcal", account: "primary", upcoming: true } } }));
  sh(root, "git", "commit", "-qam", "louis: upcoming");
  events = {
    later: { id: "later", etag: '"4"', status: "confirmed", updated: "2026-07-17T00:00:00Z", summary: "Course A final", start: { dateTime: iso(70) }, description: "Please book the exam room B-201 for the final" },
    weekly: { id: "weekly", etag: '"2"', status: "confirmed", updated: "2025-09-01T00:00:00Z", summary: "Course A sync", start: { dateTime: "2025-09-02T15:00:00Z" }, recurrence: ["RRULE:FREQ=WEEKLY"], description: "Weekly sync on Course A with the team" },
  };
  const r1 = await pullSource(root, "cal");
  expect(r1.fetched).toBe(0); // neither is recent or within the first sync's window
  // Weeks pass: the final is now 50 days off, unedited, so the sync token never returns it. The
  // coming-events cache lists it, and the weekly series' next meeting as an instance.
  events.later = { ...events.later, start: { dateTime: iso(50) } };
  sync = { s1: { items: [], next: "s1" } };
  const r2 = await pullSource(root, "cal", { upcoming: () => [events.later, { ...events.weekly, id: "weekly_20261117T150000Z", start: { dateTime: iso(8) }, recurrence: undefined }] });
  const r3 = await pullSource(root, "cal", { upcoming: () => [events.later] });
  expect(r2.fetched + r3.fetched).toBe(2);
  const st = JSON.parse(readFileSync(join(root, "log", "sources", "cal.json"), "utf8"));
  expect(Object.keys(st.seen).sort()).toEqual(["later", "weekly"]);
  expect(proposals(root).length).toBe(1); // the final's words reached the model like any event's
  // Read once: the next pass fetches neither again.
  calls = [];
  await pullSource(root, "cal", { upcoming: () => [events.later] });
  expect(calls.filter((c) => c === "later" || c === "weekly")).toEqual([]);
});

// After G744 a coming event is read once it is within 60 days; one made long ago for a date
// further out, or an old series, still waits until then. A one-off resync reads the whole
// calendar again for every coming event or live series not read yet, with a dry run that only
// counts and writes nothing (G748).
test("G748: a calendar resync counts first and writes nothing, then reads every coming event and live series the pull never read", async () => {
  const { resyncCalendar } = await import("../src/pull");
  const root = calRoot();
  events = {
    far: { id: "far", etag: '"3"', status: "confirmed", updated: "2026-07-17T00:00:00Z", summary: "Course A final", start: { dateTime: iso(120) }, description: "Please book the exam room B-201 for the final" },
    series: { id: "series", etag: '"2"', status: "confirmed", updated: "2025-09-01T00:00:00Z", summary: "Course A sync", start: { dateTime: "2025-09-02T15:00:00Z" }, recurrence: ["RRULE:FREQ=WEEKLY"], description: "Weekly sync on Course A with the team" },
    ended: { id: "ended", etag: '"2"', status: "confirmed", updated: "2025-01-01T00:00:00Z", summary: "Old series", start: { dateTime: "2025-01-02T15:00:00Z" }, recurrence: ["RRULE:FREQ=WEEKLY;UNTIL=20250301T000000Z"], description: "An old weekly that ended" },
    past: { id: "past", etag: '"1"', status: "confirmed", updated: "2025-01-01T00:00:00Z", summary: "Old", start: { dateTime: "2025-01-02T10:00:00Z" }, description: "Long ago" },
  };
  await pullSource(root, "cal"); // the first sync: none of them is recent or within 60 days
  const before = readFileSync(join(root, "log", "sources", "cal.json"), "utf8");
  const dry = await resyncCalendar(root, "cal", { dryRun: true });
  expect(dry).toMatchObject({ source: "cal", listed: 4, unread: 2, coming: 1, series: 1 });
  expect(readFileSync(join(root, "log", "sources", "cal.json"), "utf8")).toBe(before);
  expect(proposals(root)).toEqual([]);
  const r = await resyncCalendar(root, "cal");
  expect(r.refused).toBeUndefined();
  expect(r.fetched).toBe(2);
  const st = JSON.parse(readFileSync(join(root, "log", "sources", "cal.json"), "utf8"));
  expect(Object.keys(st.seen).sort()).toEqual(["far", "series"]);
  expect(proposals(root).length).toBe(1);
  // Done once, nothing is left: a second dry run counts none.
  expect((await resyncCalendar(root, "cal", { dryRun: true })).unread).toBe(0);
  // Only a calendar source.
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ consent: "2026-10-01 test", sources: { cal: { kind: "gcal", account: "primary" }, mail: { kind: "gmail", account: "primary" } } }));
  expect((await resyncCalendar(root, "mail", { dryRun: true })).refused).toContain("calendar");
});

// Code review on G748: an event already under way (it started before now and ends later), or an
// all-day event dated today, is still coming: the resync keeps it.
test("G748: a resync keeps an unread event that is under way and an all-day event dated today", async () => {
  const { resyncCalendar } = await import("../src/pull");
  const root = calRoot();
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  events = {
    now: { id: "now", etag: '"1"', status: "confirmed", updated: "2025-01-01T00:00:00Z", summary: "Workshop", start: { dateTime: new Date(Date.now() - 2 * 36e5).toISOString() }, end: { dateTime: new Date(Date.now() + 2 * 36e5).toISOString() }, description: "Workshop under way" },
    today: { id: "today", etag: '"1"', status: "confirmed", updated: "2025-01-01T00:00:00Z", summary: "Retreat", start: { date: day(Date.now()) }, end: { date: day(Date.now() + 864e5) }, description: "All-day retreat" },
  };
  const dry = await resyncCalendar(root, "cal", { dryRun: true });
  expect(dry).toMatchObject({ unread: 2, coming: 2, series: 0 });
});
