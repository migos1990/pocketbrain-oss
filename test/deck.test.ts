// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "bun:test";
import { writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { loadBrain, type FactRecord } from "../src/brain";
import { buildDeck, runAuto, undoAuto, later, autoDecisions, AUTO, runAutoByHand } from "../src/deck";
import { openItems } from "../src/textline/items";
import { git } from "../src/git";
import { recordCheckedRefs } from "../src/louis";

// Deadlines run from when git recorded the conflict or proposal, so tests use the real clock.
const NOW = new Date();
const hours = (h: number) => new Date(NOW.getTime() + h * 3_600_000);

function brain(policy = "health: { url: null }\n") {
  const root = makeBrain();
  writeFileSync(join(root, "rules/escalation.yaml"), policy);
  Bun.spawnSync(["git", "-C", root, "add", "-A"]);
  Bun.spawnSync(["git", "-C", root, "-c", "user.name=louis", "-c", "user.email=l@x", "commit", "-q", "-m", "escalation"]);
  return root;
}
const w = { agent: "planner", id: "projects/course-a", attribute: "next_step", verification: "verified-by-source" as const };
// The brain holds a value verified by the hub's own connector; a newer but weaker claim challenges it (step 6). The evidence
// favours what the brain had, so the hub may keep it when the owner doesn't answer.
function clearDispute(root: string) {
  recordCheckedRefs(root, { "gmail:f000000000000006": true }); // the hub's connector found this message
  write(root, { ...w, value: "Version A", as_of: "2026-10-06", sources: ["gmail:f000000000000006"] });
  const r = write(root, { agent: "planner", id: "projects/course-a", attribute: "next_step", value: "Version B", as_of: "2026-10-07", sources: ["gmail:f000000000000004"] });
  expect(r.outcome).toBe("disputed");
  buildDeck(root, NOW); // the hub sees it: its clock starts
  return readdirSync(join(root, "disputes")).find((f) => f.startsWith("c-"))!.replace(/\.md$/, "");
}
// Two exact sources on the same day: nobody's evidence is stronger, so only the owner picks.
function tiedDispute(root: string) {
  write(root, { ...w, value: "Version A", as_of: "2026-10-07", sources: ["gmail:f000000000000006"] });
  const r = write(root, { ...w, value: "Version B", as_of: "2026-10-07", sources: ["gmail:f000000000000004"] });
  expect(r.outcome).toBe("disputed");
  return readdirSync(join(root, "disputes")).find((f) => f.startsWith("c-"))!.replace(/\.md$/, "");
}
const fact = (root: string) => loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm.facts!.next_step as FactRecord;


test("a conflict always waits for you: the hub never settles one, however clear its evidence", () => {
  const root = brain();
  const id = clearDispute(root);
  const card = buildDeck(root, NOW).cards.find((c) => c.key === `dispute:${id}`)!;
  expect(card.auto).toBeUndefined();
  expect(card.never_auto).toMatch(/Conflicts wait for you/);
  expect(card.choices[0]).toMatchObject({ dir: "right", action: "dispute-decide", fields: { id, choice: "1" } });
  expect(card.choices[1]).toMatchObject({ dir: "left", fields: { id, choice: "2" } });
  const head = git(root, ["rev-parse", "HEAD"]);
  expect(runAuto(root, hours(24 * 365))).toEqual([]);
  expect(git(root, ["rev-parse", "HEAD"])).toBe(head);
  expect(fact(root).value).toBeUndefined(); // still disputed
});

test("undo only reverts the hub's own commits", () => {
  const root = brain();
  expect(() => undoAuto(root, "dispute:c-9999")).toThrow();
});

test("a private or money conflict is never decided by the hub", () => {
  const root = brain();
  const r = write(root, { agent: "steward", id: "money/main-bank", attribute: "bank", value: "Other Bank", as_of: "2026-10-08", sources: ["gmail:f000000000000006"], verification: "verified-by-source" });
  expect(r.outcome).toBe("disputed");
  const deck = buildDeck(root, NOW);
  const disputesCards = deck.cards.filter((c) => c.kind === "dispute");
  expect(disputesCards.length).toBe(1);
  for (const c of disputesCards) { expect(c.auto).toBeUndefined(); expect(c.never_auto).toMatch(/Private|Money/); }
  expect(runAuto(root, hours(24 * 365))).toEqual([]);
});


test("a tie never gets a plan either", () => {
  const tie = brain();
  const t = tiedDispute(tie);
  expect(buildDeck(tie, NOW).cards.find((c) => c.key === `dispute:${t}`)!.auto).toBeUndefined();
  expect(runAuto(tie, hours(24 * 365))).toEqual([]);
});

test("private and money cards show no values on the deck", () => {
  const root = brain();
  write(root, { agent: "steward", id: "money/main-bank", attribute: "bank", value: "Other Bank", as_of: "2026-10-08", sources: ["gmail:f000000000000006"], verification: "verified-by-source" });
  const c = buildDeck(root, NOW).cards.find((x) => x.kind === "dispute")!;
  expect(c.lines).toEqual([]);
  expect(c.hidden).toBeTruthy();
  expect(JSON.stringify(c)).not.toContain("Other Bank");
});

test("only an outside assistant's proposal can expire; the owner's own captures never do", () => {
  const root = brain("health: { url: null }\nauto_decide: { proposal_days: 3 }\n");
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "2026-10-08-owner-capture.yaml"), "proposed: 2026-10-08\nby: capture\nreason: extracted from your note\nrequest: { id: people/jane-roy, attribute: role, value: Dean }\n");
  Bun.spawnSync(["git", "-C", root, "add", "-A"]);
  Bun.spawnSync(["git", "-C", root, "-c", "user.name=louis", "-c", "user.email=l@x", "commit", "-qm", "capture"]);
  const key = "proposal:2026-10-08-owner-capture.yaml";
  expect(buildDeck(root, NOW).cards.find((c) => c.key === key)!.auto).toBeUndefined();
  expect(runAuto(root, hours(24 * 30))).toEqual([]);
});

test("a paused or read-only assistant's proposal never expires", () => {
  for (const status of ["paused", "read-only"]) {
    const root = brain("health: { url: null }\nauto_decide: { proposal_days: 3 }\n");
    write(root, { agent: "helper", id: "people/jane-roy", attribute: "role", value: "Associate dean", as_of: "2026-10-07", sources: ["gmail:1a0e88a496d9705a"], verification: "verified-by-source" });
    buildDeck(root, NOW);
    const pol = join(root, "rules/policy.yaml");
    writeFileSync(pol, readFileSync(pol, "utf8").replace(/^(  helper: \{)/m, `$1 status: ${status},`));
    Bun.spawnSync(["git", "-C", root, "-c", "user.name=louis", "-c", "user.email=l@x", "commit", "-qam", status]);
    const head = git(root, ["rev-parse", "HEAD"]);
    expect(runAuto(root, new Date(Date.now() + 365 * 86_400_000))).toEqual([]);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(head);
    for (const c of buildDeck(root, NOW).cards.filter((x) => x.kind === "proposal")) expect(c.never_auto).toContain(status);
  }
});

test("auto_decide off accepts yes as well as true", () => {
  const { loadEscalation } = require("../src/textline/policy");
  for (const v of ["true", "yes", "on"]) expect(loadEscalation(brain(`auto_decide: { off: ${v} }\n`)).auto_decide.off).toBe(true);
});

test("held mail, alerts and rules never get a deadline", () => {
  const root = brain();
  const deck = buildDeck(root, NOW);
  for (const c of deck.cards.filter((x) => ["mail", "alert", "rules", "capture", "usage"].includes(x.kind))) expect(c.auto).toBeUndefined();
});

test("an unanswered proposal expires after proposal_days; undo brings it back, and the hub never expires it again", () => {
  const root = brain("health: { url: null }\nauto_decide: { proposal_days: 3 }\n");
  const r = write(root, { agent: "helper", id: "people/jane-roy", attribute: "role", value: "Associate dean", as_of: "2026-10-07", sources: ["gmail:1a0e88a496d9705a"], verification: "verified-by-source" });
  expect(r.outcome).toBe("inbox");
  const key = openItems(root).find((i) => i.kind === "proposal")!.key;
  // A proposal's clock starts when it was filed (wall time) and the hub first saw it.
  const filed = Date.now();
  expect(buildDeck(root, new Date(filed)).cards.find((c) => c.key === key)!.auto?.choice).toBe("reject");
  expect(runAuto(root, new Date(filed + 2 * 86_400_000))).toEqual([]);
  expect(runAuto(root, new Date(filed + 4 * 86_400_000)).map((d) => d.key)).toContain(key);
  expect(openItems(root).some((i) => i.key === key)).toBe(false);
  expect(git(root, ["log", "-1", "--format=%ae%n%B"])).toContain(`${AUTO}@pocketbrain.local`);
  expect(autoDecisions(root, 3650, new Date(filed + 4 * 86_400_000))[0]).toMatchObject({ key });
  expect(undoAuto(root, key)).toContain("Undone");
  expect(openItems(root).some((i) => i.key === key)).toBe(true);
  expect(runAuto(root, new Date(filed + 60 * 86_400_000))).toEqual([]);
  const card = buildDeck(root, new Date(filed + 60 * 86_400_000)).cards.find((c) => c.key === key)!;
  expect(card.never_auto).toContain("undid");
  expect(autoDecisions(root, 3650, new Date(filed + 60 * 86_400_000))[0].undone).toBe(true);
});

test("auto_decide: { off: true } turns it all off", () => {
  const root = brain("health: { url: null }\nauto_decide: { off: true, proposal_days: 3 }\n");
  write(root, { agent: "helper", id: "people/jane-roy", attribute: "role", value: "Associate dean", as_of: "2026-10-07", sources: ["gmail:1a0e88a496d9705a"] });
  expect(buildDeck(root, NOW).cards.find((c) => c.kind === "proposal")!.auto).toBeUndefined();
  expect(runAuto(root, hours(24 * 365))).toEqual([]);
});

test("later hides a card for snooze_hours but never moves the hub's deadline", () => {
  const root = brain("health: { url: null }\nauto_decide: { proposal_days: 3 }\n");
  write(root, { agent: "helper", id: "people/jane-roy", attribute: "role", value: "Associate dean", as_of: "2026-10-07", sources: ["gmail:1a0e88a496d9705a"] });
  const key = openItems(root).find((i) => i.kind === "proposal")!.key;
  const before = buildDeck(root, NOW).cards.find((c) => c.key === key)!.auto!.at;
  later(root, key, NOW);
  expect(buildDeck(root, hours(1)).cards.some((c) => c.key === key)).toBe(false);
  expect(buildDeck(root, hours(5)).cards.find((c) => c.key === key)!.auto!.at).toBe(before);
});

test("stale facts come as 'still true?' cards; private ones never do", () => {
  const root = brain();
  const deck = buildDeck(root, new Date("2028-01-01T12:00:00Z"));
  const facts = deck.cards.filter((c) => c.kind === "fact");
  for (const c of facts) {
    expect(c.choices[0]).toMatchObject({ action: "fact-confirm", dir: "right" });
    expect(c.auto).toBeUndefined();
    expect(c.key.startsWith("fact:money/")).toBe(false);
  }
});

// ---------- wiring: dashboard, phone host, text channel, digest ----------

import { dashboardHandler } from "../src/dashboard/server";
import { tick } from "../src/textline/poll";
import { fakeTransport, fakeReply } from "../src/textline/transport";
import { digest } from "../src/digest";
import { existsSync, readFileSync } from "node:fs";

function dash(root: string) {
  const KEY = "k".repeat(32);
  const d = dashboardHandler(root, { port: 8788, loginKey: KEY });
  let cookie = "";
  const req = (host: string, path: string, init: RequestInit = {}) => d.handle(new Request(`http://${host}${path}`, { ...init, headers: { host, cookie, ...(init.headers as Record<string, string> ?? {}) } }));
  const login = async (host = "127.0.0.1:8788") => { cookie = (await req(host, `/login?key=${KEY}`)).headers.get("set-cookie")!.split(";")[0]; };
  return { req, login };
}

test("the deck page lists the cards with their deadline and posts back through the usual actions", async () => {
  const root = brain();
  const id = clearDispute(root);
  const { req, login } = dash(root);
  await login();
  const r = await req("127.0.0.1:8788", "/deck");
  expect(r.status).toBe(200);
  expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
  const html = await r.text();
  expect(html).toContain("Which is right");
  expect(html).toContain(`dispute:${id}`);
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
  const post = (action: string, fields: Record<string, string>) => req("127.0.0.1:8788", `/action/${action}`, { method: "POST", body: new URLSearchParams({ csrf, ...fields }), headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://127.0.0.1:8788", referer: "http://127.0.0.1:8788/deck" } });
  const later_ = await post("deck-later", { key: `dispute:${id}`, deck_ms: "2400" });
  expect(later_.headers.get("location")).toContain("ok=");
  expect(await (await req("127.0.0.1:8788", "/deck")).text()).not.toContain(`dispute:${id}`);
  const log = () => (existsSync(join(root, "log/deck.jsonl")) ? readFileSync(join(root, "log/deck.jsonl"), "utf8") : "");
  expect(log()).not.toContain('"ms":2400'); // Later isn't an answer
  expect((await post("dispute-decide", { id: "c-9999", choice: "1", deck_ms: "1300" })).headers.get("location")).toContain("err=");
  expect(log()).not.toContain('"ms":1300'); // nor is a failed one
  expect((await post("dispute-decide", { id, choice: "1", deck_ms: "3100" })).headers.get("location")).toContain("ok=");
  expect(log()).toContain('"ms":3100');
});

test("undo of a hub decision works from the dashboard, and only for the hub's own commits", async () => {
  const root = brain("health: { url: null }\nauto_decide: { proposal_days: 3 }\n");
  write(root, { agent: "helper", id: "people/jane-roy", attribute: "role", value: "Associate dean", as_of: "2026-10-07", sources: ["gmail:1a0e88a496d9705a"] });
  const key = openItems(root).find((i) => i.kind === "proposal")!.key;
  buildDeck(root, NOW);
  expect(runAuto(root, hours(24 * 30)).map((d) => d.key)).toContain(key);
  const { req, login } = dash(root);
  await login();
  const html = await (await req("127.0.0.1:8788", "/deck")).text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
  const post = (k: string) => req("127.0.0.1:8788", "/action/owner-undo-auto", { method: "POST", body: new URLSearchParams({ csrf, key: k }), headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://127.0.0.1:8788" } });
  expect((await post(key)).headers.get("location")).toContain("ok=");
  expect(openItems(root).some((i) => i.key === key)).toBe(true);
  expect((await post("proposal:none.yaml")).headers.get("location")).toContain("err=");
});

test("the text channel's tick runs the hub's decisions, and the digest lists them", async () => {
  const root = brain("health: { url: null }\nauto_decide: { proposal_days: 3 }\n");
  write(root, { agent: "helper", id: "people/jane-roy", attribute: "role", value: "Associate dean", as_of: "2026-10-07", sources: ["gmail:1a0e88a496d9705a"] });
  const key = openItems(root).find((i) => i.kind === "proposal")!.key;
  buildDeck(root, NOW);
  const r = await tick(root, { now: hours(24 * 30), transport: fakeTransport(root, true), fetch: async () => new Response("{}"), lock: inline });
  expect(r.auto).toContain(key);
  const dg = digest(root, new Date(0).toISOString());
  expect(dg.text).toContain("Undo in the deck");
});

// The server's write queue stands in for `serial` here; start passes the real one.
const inline = <T>(fn: () => T) => Promise.resolve(fn());

test("a tick outside the server's write queue never decides for the owner", async () => {
  const root = brain("health: { url: null }\nauto_decide: { proposal_days: 3 }\n");
  write(root, { agent: "helper", id: "people/jane-roy", attribute: "role", value: "Associate dean", as_of: "2026-10-07", sources: ["gmail:1a0e88a496d9705a"] });
  buildDeck(root, NOW);
  const r = await tick(root, { now: hours(24 * 30), transport: fakeTransport(root, true), fetch: async () => new Response("{}") });
  expect(r.auto).toEqual([]);
  expect(openItems(root).some((i) => i.kind === "proposal")).toBe(true);
});

test("deck auto by hand refuses while the hub is running", async () => {
  const root = brain("health: { url: null }\nauto_decide: { proposal_days: 3 }\n");
  write(root, { agent: "helper", id: "people/jane-roy", attribute: "role", value: "Associate dean", as_of: "2026-10-07", sources: ["gmail:1a0e88a496d9705a"] });
  buildDeck(root, NOW);
  const up = await runAutoByHand(root, hours(24 * 30), async () => new Response("{}"));
  expect("refused" in up).toBe(true);
  expect(openItems(root).some((i) => i.kind === "proposal")).toBe(true);
  const down = await runAutoByHand(root, hours(24 * 30), async () => { throw new Error("ECONNREFUSED"); });
  expect("done" in down && down.done.length).toBe(1);
});

test("G159 an owner's reply that couldn't apply isn't overruled by the hub in the same tick", async () => {
  const root = brain("health: { url: null }\nauto_decide: { proposal_days: 3 }\n");
  write(root, { agent: "helper", id: "people/jane-roy", attribute: "role", value: "Associate dean", as_of: "2026-10-07", sources: ["gmail:1a0e88a496d9705a"] });
  const key = openItems(root).find((i) => i.kind === "proposal")!.key;
  const noon = new Date("2026-10-08T18:00:00Z");
  const t = fakeTransport(root, true);
  await tick(root, { now: noon, transport: t, fetch: async () => new Response("{}"), lock: inline }); // batching
  const first = await tick(root, { now: new Date(noon.getTime() + 4 * 3_600_000), transport: t, fetch: async () => new Response("{}"), lock: inline });
  expect(first.sent?.keys ?? first.reason).toContain(key);
  fakeReply(root, "2"); // a conflict's answer: doesn't fit a proposal, changes nothing
  const r = await tick(root, { now: new Date(noon.getTime() + 30 * 86_400_000), transport: t, fetch: async () => new Response("{}"), lock: inline });
  expect(r.applied.join(" ")).toMatch(/doesn't fit/);
  expect(r.auto).not.toContain(key);
  expect(openItems(root).some((i) => i.key === key)).toBe(true);
});
