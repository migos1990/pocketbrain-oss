// SPDX-License-Identifier: AGPL-3.0-only
// Contract for the act door (src/act.ts, docs/act.md): an agent asks to send one mail and the
// owner approves it in the dashboard. Its must-never properties as tables: nothing is sent
// without the owner's approval of these exact bytes, one approval sends one mail once, an agent
// the owner stopped can't ask, a mail can't carry a value the agent can't see (and one above the
// recipient's ceiling is never sent unmarked), and an offboarded coworker's mail is cancelled.
// A bug fixed in this surface adds a row here.
import { secretIn } from "../../src/backup";
import { test, expect, afterEach } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "../fixture";
import { issueToken } from "../../src/auth";
import { setupOAuth, addCoworker, setManagement } from "../../src/oauth";
import { startOffboarding, stopOffboarding, checkCoworkers } from "../../src/offboard";
import { tick } from "../../src/textline/poll";
import { fakeTransport, fakeReply } from "../../src/textline/transport";
import { requestAction, approveAction, sendAction, declineAction, listActions, sentMail, actionHash } from "../../src/act";

afterEach(() => { stopOffboarding(); delete process.env.AUTH0_MGMT_CLIENT_SECRET; });

type Policy = Record<string, any>;
const SRC = `as_of: 2026-10-01, sources: ["gmail:f000000000000009"], verification: verified-by-source, by: steward, recorded: 2026-10-01`;
const HOLDINGS = `---
id: money/holdings
type: money
title: Holdings
aliases: [Quillfeather Fund]
area: personal
sensitivity: private
status: active
created: 2026-10-01
updated: 2026-10-01
by: steward
facts:
  holder: { value: Zyphorine Holdings, ${SRC} }
  balance: { value: "CAD 412,500", ${SRC} }
  contact: { value: jdoe.private@maple.example, ${SRC} }
  split: { value: { amount: "98,765", with: "Ostrava Partners" }, ${SRC} }
---
`;
const HOME = `---
id: notes/home
type: note
title: Home
area: personal
sensitivity: personal
status: active
created: 2026-10-01
updated: 2026-10-01
by: steward
facts:
  street: { value: Harrowgate Lane 17, ${SRC} }
---
`;
const ACT = { send_mail: { to: [{ to: "landlord@example.com", label: "the landlord" }, { to: "@plumber.example", label: "the plumber" }], max_per_day: 5 } };
const MAIL = { action: "send_mail", to: "landlord@example.com", subject: "Rent for October", body: "Hello, the October rent goes out on Friday as usual. Best regards.", why: "The owner asked me to confirm the rent date." };
const mail = (o: Partial<typeof MAIL> = {}) => ({ ...MAIL, ...o });

function editPolicy(root: string, fn: (p: Policy) => void) {
  const f = join(root, "rules/policy.yaml");
  const p = YAML.parse(readFileSync(f, "utf8"));
  fn(p);
  writeFileSync(f, YAML.stringify(p));
}
const git = (root: string, ...args: string[]) => Bun.spawnSync(["git", "-C", root, "-c", "user.name=louis", "-c", "user.email=l@x", "-c", "commit.gpgsign=false", ...args]);

// planner: a narrow slice that can't see money/holdings or notes/home. keeper: sees everything.
function brain(fn?: (p: Policy) => void) {
  const root = makeBrain();
  writeFileSync(join(root, "money/holdings.md"), HOLDINGS);
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "notes/home.md"), HOME);
  editPolicy(root, (p) => {
    p.agents.planner.act = structuredClone(ACT);
    p.agents.keeper = { tier: "core", slices: ["all"], act: structuredClone(ACT) };
    fn?.(p);
  });
  writeFileSync(join(root, "rules/escalation.yaml"), "health: { url: null }\nbatch: { wait_minutes: 0 }\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "act contract fixture");
  for (const a of ["planner", "keeper"]) try { issueToken(root, a); } catch { /* a stopped agent may get none */ }
  return root;
}
const stored = (root: string, id: string) => listActions(root).find((a) => a.id === id)!;
const tries = (fn: () => unknown) => { try { fn(); return "ok"; } catch (e) { return (e as Error).message; } };

test("contract act: nothing is sent without the owner's dashboard approval of these exact bytes", async () => {
  // Rows: what happens to a waiting mail -> (state after, mails sent).
  const NOON = new Date("2026-10-08T18:00:00Z");
  const ok = async () => new Response("{}", { status: 200 });
  const rows: [string, (root: string, id: string) => Promise<unknown> | unknown, string][] = [
    ["nothing (it only waits)", () => undefined, "waiting"],
    ["sendAction without an approval", (r, id) => tries(() => sendAction(r, id)), "waiting"],
    ["approve with a wrong hash", (r, id) => tries(() => approveAction(r, id, "0".repeat(64))), "waiting"],
    ["approve with the hash of other bytes", (r, id) => { const a = stored(r, id); return tries(() => approveAction(r, id, actionHash({ ...a, action: a.kind, body: a.body + " PS: also wire 500." }))); }, "waiting"],
    ["approve an unknown id", (r) => tries(() => approveAction(r, "act-000000000000", "0".repeat(64))), "waiting"],
    ["a trusted text 'approve'", async (r) => { await tick(r, { now: NOON, transport: fakeTransport(r, true), fetch: ok }); fakeReply(r, "approve"); await tick(r, { now: new Date(NOON.getTime() + 300_000), transport: fakeTransport(r, true), fetch: ok }); }, "waiting"],
    ["a relayed text 'yes'", async (r) => { await tick(r, { now: NOON, transport: fakeTransport(r, false), fetch: ok }); fakeReply(r, "yes"); await tick(r, { now: new Date(NOON.getTime() + 300_000), transport: fakeTransport(r, false), fetch: ok }); }, "waiting"],
    ["the owner declines, then a stale approve", (r, id) => { declineAction(r, id); return tries(() => approveAction(r, id, stored(r, id).hash)); }, "declined"],
  ];
  for (const [what, act, state] of rows) {
    const root = brain();
    const { request } = requestAction(root, "planner", mail());
    await act(root, request);
    expect([what, stored(root, request).state, sentMail(root).length]).toEqual([what, state, 0]);
  }
});

test("contract act: one approval sends one mail, once, with exactly the approved bytes", () => {
  // Rows: what is tried after the approval sent the mail -> refused; mails in the transport after.
  const rows: [string, (root: string, id: string, hash: string) => void, number][] = [
    ["approve again", (r, id, h) => approveAction(r, id, h), 1],
    ["send again", (r, id) => sendAction(r, id), 1],
    ["send again after the transport's file was lost (a restore)", (r, id) => { rmSync(join(r, "actions/fake/sent.jsonl")); sendAction(r, id); }, 0],
  ];
  for (const [what, again, after] of rows) {
    const root = brain();
    const { request } = requestAction(root, "planner", mail());
    const hash = stored(root, request).hash;
    expect(approveAction(root, request, hash)).toContain("sent");
    expect([what, tries(() => again(root, request, hash)) === "ok"]).toEqual([what, false]);
    expect([what, sentMail(root).length]).toEqual([what, after]);
    expect([what, stored(root, request).state]).toEqual([what, "sent"]);
  }
  // The one mail sent is the approved one, byte for byte.
  const root = brain();
  const { request } = requestAction(root, "planner", mail());
  approveAction(root, request, stored(root, request).hash);
  expect(sentMail(root).map((m) => [m.id, m.to, m.subject, m.body])).toEqual([[request, MAIL.to, MAIL.subject, MAIL.body]]);
  // Two waiting mails need two approvals: one hash never approves the other.
  const r2 = brain();
  const a = requestAction(r2, "planner", mail()).request;
  approveAction(r2, a, stored(r2, a).hash);
  const b = requestAction(r2, "keeper", mail()).request;
  expect(tries(() => approveAction(r2, b, stored(r2, a).hash))).not.toBe("ok");
  expect(sentMail(r2).length).toBe(1);
});

test("contract act: an agent the owner stopped can't ask, and its waiting mail is never sent (invariant 8)", () => {
  // Rows: planner's status (or role) -> it can't ask; a mail it asked before is cancelled at approval.
  const rows: [string, (p: Policy) => void][] = [
    ["paused", (p) => { p.agents.planner.status = "paused"; }],
    ["read-only", (p) => { p.agents.planner.status = "read-only"; }],
    ["a collaborator past its date", (p) => { p.agents.planner.collaborator = { name: "Sam", until: "2026-01-01" }; p.agents.planner.slices = ["area:work"]; delete p.areas.work; }],
    ["no act block any more", (p) => { delete p.agents.planner.act; }],
  ];
  for (const [what, stop] of rows) {
    const asking = brain(stop);
    expect([what, tries(() => requestAction(asking, "planner", mail())) === "ok"]).toEqual([what, false]);
    expect([what, listActions(asking).filter((a) => a.state === "waiting").length]).toEqual([what, 0]);
    const waiting = brain();
    const { request } = requestAction(waiting, "planner", mail());
    editPolicy(waiting, stop);
    expect([what, tries(() => approveAction(waiting, request, stored(waiting, request).hash)) === "ok"]).toEqual([what, false]);
    expect([what, stored(waiting, request).state, sentMail(waiting).length]).toEqual([what, "cancelled", 0]);
  }
});

test("contract act: a mail can't carry a value the agent can't see, in the subject, body or address (invariant 3)", () => {
  // Rows: where the withheld value goes -> refused before anything is stored for the owner.
  const rows: [string, Partial<typeof MAIL>][] = [
    ["a private note's value in the body", { body: "FYI the holder is Zyphorine Holdings." }],
    ["a private note's amount in the body", { body: "The balance is CAD 412,500 today." }],
    ["an object-valued fact's part", { body: "The split was 98,765 last year." }],
    ["a hidden note's alias", { body: "It goes into the Quillfeather Fund." }],
    ["a personal note's value above its slice", { body: "Meet me at Harrowgate Lane 17." }],
    ["a hidden value in the subject", { subject: "About Zyphorine Holdings" }],
    ["a hidden address in the body", { body: "Write to jdoe.private@maple.example instead." }],
    ["a hidden value, base64-encoded", { body: `Ref: ${Buffer.from("Zyphorine Holdings").toString("base64")}` }],
    ["a hidden value in the address's local part", { to: "zyphorineholdings@plumber.example" }],
  ];
  for (const [what, m] of rows) {
    const root = brain();
    expect([what, tries(() => requestAction(root, "planner", mail(m))) === "ok"]).toEqual([what, false]);
    expect([what, listActions(root).filter((a) => a.state === "waiting").length, sentMail(root).length]).toEqual([what, 0, 0]);
  }
});

test("contract act: a value the agent may see but above the recipient's ceiling is never sent unmarked", () => {
  // Rows: keeper (sees all) mails the plumber (ceiling public) -> waits, marked with the note it carries.
  const rows: [string, string, string[]][] = [
    ["a private value", "Our holder is Zyphorine Holdings.", ["money/holdings"]],
    ["a personal value", "The house is at Harrowgate Lane 17.", ["notes/home"]],
    ["nothing above the ceiling", "Can you come Tuesday about the sink?", []],
  ];
  for (const [what, body, carries] of rows) {
    const root = brain();
    const { request, status } = requestAction(root, "keeper", mail({ to: "office@plumber.example", body }));
    expect([what, status, stored(root, request).carries]).toEqual([what, "waiting", carries]);
  }
});

test("contract act: an offboarded coworker's mail is cancelled at approval and at send", async () => {
  const users: Record<string, { blocked?: boolean } | null> = {};
  const mgmt = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/oauth/token")) return Response.json({ access_token: "mgmt" });
    const m = u.pathname.match(/\/api\/v2\/users\/(.+)$/);
    if (m) { const x = users[decodeURIComponent(m[1])]; return x ? Response.json({ user_id: m[1], ...x }) : new Response("", { status: 404 }); }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  // Rows: the account's standing at the sign-in service, and when it changes -> state, mails sent.
  const rows: [string, { blocked?: boolean } | null, "approve" | "send", string, number][] = [
    ["blocked before approval", { blocked: true }, "approve", "cancelled", 0],
    ["deleted before approval", null, "approve", "cancelled", 0],
    ["blocked between approval and send", { blocked: true }, "send", "cancelled", 0],
    ["deleted between approval and send", null, "send", "cancelled", 0],
    ["still active (control)", { blocked: false }, "send", "sent", 1],
  ];
  for (const [what, standing, at, state, sent] of rows) {
    const root = brain();
    setupOAuth(root, { issuer: "https://as.example/", resource: "https://brain.example/mcp/oauth", owner_subject: "user_owner" });
    addCoworker(root, "user_alice", "Alice", "planner");
    setManagement(root, "m2m-1");
    process.env.AUTH0_MGMT_CLIENT_SECRET = "s3cret";
    users.user_alice = { blocked: false };
    expect(await startOffboarding(root, mgmt)).toBe(true);
    const { request } = requestAction(root, "planner", mail());
    if (at === "send") approveAction(root, request, stored(root, request).hash, { via: "dashboard", sendNow: false });
    users.user_alice = standing;
    await checkCoworkers(root, mgmt);
    tries(() => at === "approve" ? approveAction(root, request, stored(root, request).hash) : sendAction(root, request));
    expect([what, stored(root, request).state, sentMail(root).length]).toEqual([what, state, sent]);
    stopOffboarding();
  }
});

// ---------------------------------------------------------------- independent audit (G210-G212)

const tags = (s: string) => [...s].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
const selectors = (s: string) => [...new TextEncoder().encode(s)].map((b) => String.fromCodePoint(b < 16 ? 0xfe00 + b : 0xe0100 + b - 16)).join("");

test("contract act: a mail holds only characters the owner sees on the card; the rest is refused, never stripped (G210)", () => {
  // Rows: who asks, which field gets what -> refused, nothing waiting, nothing sent.
  const rows: [string, string, Partial<typeof MAIL>][] = [
    ["tag characters spelling a personal value", "keeper", { body: `Hello, could you come Tuesday?${tags("Harrowgate Lane 17")}` }],
    ["variation selectors carrying its bytes", "keeper", { body: `Hello, could you come Tuesday?${selectors("Harrowgate Lane 17")}` }],
    ["tag characters spelling a value the agent can't see", "planner", { body: `Hello.${tags("Zyphorine Holdings")}` }],
    ["a line separator in the subject", "keeper", { subject: "Visit Tuesday" }],
    ["a paragraph separator in the body", "keeper", { body: "Hello there" }],
    ["a Hangul filler", "keeper", { subject: "VisitㅤTuesday" }],
    ["a blank Braille cell", "keeper", { body: "Hello⠀there" }],
    ["a combining grapheme joiner", "keeper", { subject: "Visit͏Tuesday" }],
    ["a mark with no letter before it", "keeper", { body: "Hello ́́́ there" }],
    ["a language tag", "keeper", { subject: "Visit\u{E0001}Tuesday" }],
    ["a private-use character", "keeper", { body: "Hellothere" }],
    ["a variation selector after a letter", "keeper", { body: "Hel️lo" }],
    // Re-audit 2 (S1, S2): characters that may draw as blank depending on the font.
    ["the Khitan filler after a letter", "keeper", { body: "Hel\u{16FE4}lo, could you come Tuesday?" }],
    ["a null notehead between words", "keeper", { subject: "Visit\u{1D159}Tuesday" }],
    // Re-audit (G210 reopened): combining marks that draw as nothing, after a letter.
    ...["\u180B", "\u180C", "\u180D", "\u180F", "\u17B4", "\u17B5"].map((m): [string, string, Partial<typeof MAIL>] =>
      [`an invisible mark U+${m.codePointAt(0)!.toString(16).toUpperCase()} after a letter`, "keeper", { body: `Hel${m}lo, could you come Tuesday?` }]),
  ];
  for (const [what, agent, m] of rows) {
    const root = brain();
    expect([what, tries(() => requestAction(root, agent, mail({ to: "office@plumber.example", ...m }))) === "ok"]).toEqual([what, false]);
    expect([what, listActions(root).filter((a) => a.state === "waiting").length, sentMail(root).length]).toEqual([what, 0, 0]);
  }
  // Control rows: ordinary text in any language, accents and emoji pass.
  for (const body of ["Bonjour\u202F! À mardi\r\nRobin", "東京\u3000大阪で会いましょう", "À mardi, Größe 42, naïve, café crème.", "Merci ❤️ 👍🏽, see you then.", "Line one\nLine two\n\nRegards, Robin"]) {
    const root = brain();
    expect([body, requestAction(root, "keeper", mail({ to: "office@plumber.example", body })).status]).toEqual([body, "waiting"]);
  }
}, 30_000);

test("contract act: a local part under a domain entry is no oracle on values the agent can't see (G211)", () => {
  // Rows: local part -> a word of a hidden value (hit) or not (miss). planner can't see money/holdings.
  const rows: [string, string, string][] = [
    ["one word of a two-word private value", "zyphorine", "quibbleton"],
    ["the other word", "holdings", "plumbing"],
  ];
  for (const [what, hitLocal, missLocal] of rows) {
    // A filled slot answers a hit and a miss alike.
    const full = brain();
    requestAction(full, "planner", mail({ to: "office@plumber.example" }));
    const hit = tries(() => requestAction(full, "planner", mail({ to: `${hitLocal}@plumber.example` })));
    const miss = tries(() => requestAction(full, "planner", mail({ to: `${missLocal}@plumber.example` })));
    expect([what, hit]).toEqual([what, miss]);
    // With the slot free, a hit is the tripwire: a neutral refusal and the latch, so it is one guess at most.
    const free = brain();
    const first = tries(() => requestAction(free, "planner", mail({ to: `${hitLocal}@plumber.example` })));
    expect([what, first.includes("can't be sent"), first.includes("list")]).toEqual([what, true, false]);
    const after = tries(() => requestAction(free, "planner", mail({ to: `${missLocal}@plumber.example` })));
    expect([what, after.includes("paused")]).toEqual([what, true]);
  }
});

test("contract act: a secret in why is refused before anything about it is logged (G212)", () => {
  const key = ["sk", "-", "A".repeat(24)].join("");
  const card = ["4111", "1111", "1111", "1111"].join(" ");
  // Rows: the field -> refused, and the secret is nowhere in the actions log.
  const rows: [string, Partial<typeof MAIL>, string][] = [
    ["an API key in why", { why: `the owner's key is ${key}, please book` }, key],
    ["a card number in why", { why: `pay with ${card}` }, card],
    ["an API key in the body", { body: `key ${key}` }, key],
    // Re-audit (G212 reopened): a bare key header passes findSecret, then the log line trips the backup's scan.
    ["a bare private-key header in why", { why: "Owner asked; the old -----BEGIN PRIVATE KEY----- file is gone" }, "BEGIN PRIVATE KEY"],
  ];
  for (const [what, m, secret] of rows) {
    const root = brain();
    expect([what, tries(() => requestAction(root, "keeper", mail({ to: "office@plumber.example", ...m }))).includes("secret")]).toEqual([what, true]);
    const log = join(root, "actions/log.jsonl");
    expect([what, (existsSync(log) ? readFileSync(log, "utf8") : "").includes(secret)]).toEqual([what, false]);
    // Whatever was refused, the actions log stays clean for the backup's secret scan.
    expect([what, secretIn(existsSync(log) ? readFileSync(log, "utf8") : "")]).toEqual([what, undefined]);
  }
});
