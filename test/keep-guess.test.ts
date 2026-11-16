// SPDX-License-Identifier: AGPL-3.0-only
// Keep a guess with one tap (owner's yes, 2026-11-16; plan instant-value F2, G941): a "Not confirmed"
// line on the home (an outside assistant's save that would expire) is kept with one tap, or all of a
// page's at once. A kept line is the owner's approval (the existing accept: an approved: ref, ranked
// as the source it cites), so the page says it as theirs and every assistant whose slice reaches it
// gets it. Undo takes it back. Only a line the home showed, as the home showed it, is kept.
import { test, expect, setDefaultTimeout, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { proposalSeen } from "../src/write";
import { commitPaths } from "../src/git";
import { OWNER } from "../src/owner";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { initBrain } from "../src/init";
import { handle } from "../src/server";
import { loadBrain } from "../src/brain";
import { loadRules } from "../src/rules";
import { records } from "../src/carve";
import { lineState } from "../src/sources";
import { previewRead, previewSearch } from "../src/core";
import { readDiary } from "../src/diary";
import { undoFact } from "../src/undo";
import { ownerAsks } from "../src/waiting";
import { homeView } from "../src/dashboard/home";
import { homePage, APP_COPY } from "../src/dashboard/html-app";
import { STALE_OK } from "../src/dashboard/server";
import { keepGuesses } from "../src/keep-guess";

setDefaultTimeout(30_000);
beforeEach(() => { process.env.PB_TODAY = "2026-10-08"; });

async function remember(root: string, token: string, body: Record<string, unknown>) {
  const res = await handle(root, new Request("http://pb/v1/remember", { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${token}` } }));
  return await res.json() as { outcome: string; message?: string };
}
const view = (root: string) => homeView(root, loadRules(root), loadBrain(root), new Date());

// A new brain with its first (trial) assistant, plus a second one that reads the same area, so
// "other assistants then get it" can be seen.
function brain() {
  const root = join(mkdtempSync(join(tmpdir(), "pb-keep-guess-")), "brain");
  const { token } = initBrain(root, { owner: "Sam Rivera", agent: "claude" });
  const f = join(root, "rules/policy.yaml"), p = YAML.parse(readFileSync(f, "utf8"));
  p.agents.muse = { tier: "trial", transport: "mcp", slices: ["area:work"] };
  writeFileSync(f, YAML.stringify(p));
  commitPaths(root, ["rules/policy.yaml"], "owner: a second assistant", OWNER);
  return { root, token: token! };
}
const SAM = "people/sam-rivera";
const fact = (root: string, attr: string) => loadBrain(root).find((n) => n.fm.id === SAM)?.fm.facts?.[attr];
const museReads = (root: string) => JSON.stringify(previewRead(root, "muse", SAM));

test("Keep on a Not confirmed line files it as the owner's, and another assistant then gets it", async () => {
  const { root, token } = brain();
  expect((await remember(root, token, { type: "person", title: "Sam Rivera", attribute: "based_in", value: "Lisbon", as_of: "2026-10-01", sources: ["agent:claude"] })).outcome).toBe("inbox");
  const [line] = view(root).unconfirmed ?? [];
  expect(line?.keep).toBeDefined();
  expect(museReads(root)).not.toContain("Lisbon");
  const r = keepGuesses(root, [line!.keep!]);
  expect(r.kept).toBe(1);
  expect(view(root).unconfirmed).toBeUndefined();
  const recs = records(fact(root, "based_in") as never);
  expect(recs.map((x) => x.value)).toEqual(["Lisbon"]);
  expect(lineState(recs[0]!)).toBe("yours");
  expect(museReads(root)).toContain("Lisbon");
  // Still never an ask.
  expect(ownerAsks(root).total).toBe(0);
});

test("Keep all on a page keeps every line of that page and no other", async () => {
  const { root, token } = brain();
  await remember(root, token, { type: "person", title: "Sam Rivera", attribute: "based_in", value: "Lisbon", as_of: "2026-10-01", sources: ["agent:claude"] });
  await remember(root, token, { type: "person", title: "Sam Rivera", attribute: "prefers", value: "short answers", as_of: "2026-10-01", sources: ["agent:claude"] });
  await remember(root, token, { type: "person", title: "Jane Roy", attribute: "role", value: "course coordinator", area: "work", as_of: "2026-10-01", sources: ["agent:claude"] });
  const lines = view(root).unconfirmed ?? [];
  expect(lines.length).toBe(3);
  const mine = lines.filter((l) => l.page === SAM).map((l) => l.keep!);
  expect(mine.length).toBe(2);
  expect(keepGuesses(root, mine).kept).toBe(2);
  const left = view(root).unconfirmed ?? [];
  expect(left.map((l) => l.what)).toEqual([lines.find((l) => l.page !== SAM)!.what]);
  expect(museReads(root)).toContain("Lisbon");
  expect(museReads(root)).toContain("short answers");
});

test("a line that changed since the home showed it is not kept", async () => {
  const { root, token } = brain();
  await remember(root, token, { type: "person", title: "Sam Rivera", attribute: "based_in", value: "Lisbon", as_of: "2026-10-01", sources: ["agent:claude"] });
  const [line] = view(root).unconfirmed ?? [];
  const r = keepGuesses(root, [{ ...line!.keep!, seen: "0000000000000000" }]);
  expect(r.kept).toBe(0);
  expect(fact(root, "based_in")).toBeUndefined();
  expect(view(root).unconfirmed?.length).toBe(1);
});

test("Keep never accepts a proposal that is not a Not confirmed line, money ones included", async () => {
  const { root, token } = brain();
  await remember(root, token, { type: "person", title: "Sam Rivera", attribute: "salary", value: "90000 a year", as_of: "2026-10-01", sources: ["agent:claude"] });
  expect(view(root).unconfirmed ?? []).toEqual([]);
  const files = readdirSync(join(root, "inbox")).filter((x) => x.endsWith(".yaml"));
  expect(files.length).toBe(1);
  const r = keepGuesses(root, [{ file: files[0]!, seen: proposalSeen(root, files[0]!)! }]);
  expect(r.kept).toBe(0);
  expect(fact(root, "salary")).toBeUndefined();
  expect(existsSync(join(root, "inbox", files[0]!))).toBe(true);
  // A name that is not a proposal file is never read.
  expect(keepGuesses(root, [{ file: "../rules/policy.yaml", seen: "0000000000000000" }]).kept).toBe(0);
});

test("Undo takes a kept line back off every assistant", async () => {
  const { root, token } = brain();
  await remember(root, token, { type: "person", title: "Sam Rivera", attribute: "based_in", value: "Lisbon", as_of: "2026-10-01", sources: ["agent:claude"] });
  const [line] = view(root).unconfirmed ?? [];
  const at = readDiary(root).length;
  expect(keepGuesses(root, [line!.keep!]).kept).toBe(1);
  const tokens = readDiary(root).slice(at).map((x) => x.undo_token);
  expect(tokens.length).toBeGreaterThan(0);
  for (const t of tokens.reverse()) expect(undoFact(root, t).outcome).toBe("undone");
  // The owner's own page held nothing before this line; it stays (G942).
  expect(museReads(root)).not.toContain("Lisbon");
});

test("the home offers Keep on each line and Keep all on a page with more than one, behind a fresh sign-in", async () => {
  const { root, token } = brain();
  await remember(root, token, { type: "person", title: "Sam Rivera", attribute: "based_in", value: "Lisbon", as_of: "2026-10-01", sources: ["agent:claude"] });
  await remember(root, token, { type: "person", title: "Sam Rivera", attribute: "prefers", value: "short answers", as_of: "2026-10-01", sources: ["agent:claude"] });
  const html = homePage(view(root), "x");
  expect(html).toContain('action="/action/guess-keep"');
  expect(html.match(new RegExp(`>${APP_COPY.keep}<`, "g"))?.length).toBe(2);
  expect(html).toContain(`>${APP_COPY.keepAll}<`);
  // Keeping lets a thing out to assistants: never on the 30-day sign-in.
  expect(STALE_OK["guess-keep"]).toBeUndefined();
});

async function dash(root: string, port: number) {
  const { dashboardHandler, flashOf } = await import("../src/dashboard/server");
  const H = `127.0.0.1:${port}`;
  let at = Date.parse("2026-10-08T14:00:00Z");
  const d = dashboardHandler(root, { port, loginKey: "k".repeat(32), now: () => new Date(at) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
  const req = async (method: string, path: string, fields?: Record<string, string>) => {
    const body = fields ? new URLSearchParams(fields) : undefined;
    const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/home`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
    return { status: r.status, text: await r.text(), loc: r.headers.get("location") ?? "" };
  };
  return { req, flashOf, later: (min: number) => { at += min * 60_000; } };
}
const keepField = (html: string, label: string) => html.match(new RegExp(`name="keep" value="([^"]+)"><button[^>]*>${label}<`))?.[1];
const csrfOf = (html: string) => html.match(/name="csrf" value="([^"]+)"/)![1]!;

test("Keep all from the home's own form keeps the page's lines and says so, with Undo", async () => {
  const { root, token } = brain();
  await remember(root, token, { type: "person", title: "Sam Rivera", attribute: "based_in", value: "Lisbon", as_of: "2026-10-01", sources: ["agent:claude"] });
  await remember(root, token, { type: "person", title: "Sam Rivera", attribute: "prefers", value: "short answers", as_of: "2026-10-01", sources: ["agent:claude"] });
  const { req } = await dash(root, 8871);
  const home = (await req("GET", "/home")).text;
  const field = keepField(home, APP_COPY.keepAll);
  expect(field?.split(",").length).toBe(2);
  const r = await req("POST", "/action/guess-keep", { csrf: csrfOf(home), keep: field! });
  expect(r.status).toBe(303);
  const after = (await req("GET", r.loc)).text;
  expect(after).toContain("Kept 2.");
  expect(after).toContain('action="/action/diary-undo"');
  expect(after).not.toContain(`>${APP_COPY.keepAll}<`);
  expect(museReads(root)).toContain("short answers");
});

test("on an old sign-in Keep keeps nothing", async () => {
  const { root, token } = brain();
  await remember(root, token, { type: "person", title: "Sam Rivera", attribute: "based_in", value: "Lisbon", as_of: "2026-10-01", sources: ["agent:claude"] });
  const { req, later } = await dash(root, 8872);
  const home = (await req("GET", "/home")).text;
  const field = keepField(home, APP_COPY.keep)!;
  later(60 * 24 * 2);
  await req("POST", "/action/guess-keep", { csrf: csrfOf(home), keep: field });
  expect(fact(root, "based_in")).toBeUndefined();
  expect(museReads(root)).not.toContain("Lisbon");
});

test("the same line said twice is kept once and doesn't come back", async () => {
  const { root, token } = brain();
  const body = { type: "person", title: "Sam Rivera", attribute: "based_in", value: "Lisbon", as_of: "2026-10-01", sources: ["agent:claude"] };
  await remember(root, token, body);
  await remember(root, token, { ...body, as_of: "2026-10-02" });
  const lines = view(root).unconfirmed ?? [];
  expect(lines.length).toBe(1);
  expect(keepGuesses(root, [lines[0]!.keep!]).kept).toBe(1);
  expect(view(root).unconfirmed).toBeUndefined();
});

test("a kept line never tells another assistant which assistant filed it", async () => {
  const { root, token } = brain();
  await remember(root, token, { type: "person", title: "Sam Rivera", attribute: "based_in", value: "Lisbon", as_of: "2026-10-01", sources: ["agent:claude"] });
  const [line] = view(root).unconfirmed ?? [];
  expect(keepGuesses(root, [line!.keep!]).kept).toBe(1);
  const read = museReads(root);
  expect(read).toContain("Lisbon");
  // The approval's ref named the proposal's file, and the file is named after its assistant (G944).
  expect(read.toLowerCase()).not.toContain("claude");
  expect(JSON.stringify(previewSearch(root, "muse", "Lisbon")).toLowerCase()).not.toContain("claude");
});

test("a kept line on the home says the owner kept it", async () => {
  const { root, token } = brain();
  await remember(root, token, { type: "person", title: "Sam Rivera", attribute: "based_in", value: "Lisbon", as_of: "2026-10-01", sources: ["agent:claude"] });
  expect(keepGuesses(root, [view(root).unconfirmed![0]!.keep!]).kept).toBe(1);
  const html = homePage(view(root), "x");
  expect(html).toContain("You kept what Claude said today");
  expect(html).not.toContain("Claude learned it");
});

test("Keep answers a twin only when it would be the same line: never one whose words look like health", async () => {
  const { root, token } = brain();
  await remember(root, token, { type: "person", title: "Sam Rivera", attribute: "based_in", value: "Lisbon", as_of: "2026-10-01", sources: ["agent:claude"] });
  const head = readdirSync(join(root, "inbox")).find((x) => x.endsWith(".yaml"))!;
  const doc = YAML.parse(readFileSync(join(root, "inbox", head), "utf8"));
  doc.request.text = "Sam moved to Lisbon for chemotherapy at the hospital there.";
  const twin = head.replace(/\.yaml$/, "-b.yaml");
  writeFileSync(join(root, "inbox", twin), YAML.stringify(doc));
  commitPaths(root, [`inbox/${twin}`], "propose(claude): twin", "claude");
  const [line] = view(root).unconfirmed ?? [];
  expect(line?.keep?.file).toBe(head);
  expect(keepGuesses(root, [line!.keep!]).kept).toBe(1);
  expect(existsSync(join(root, "inbox", twin))).toBe(true);
});
