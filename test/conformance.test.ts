// SPDX-License-Identifier: AGPL-3.0-only
// The Memory Passport conformance suite (conformance/, docs/spec/memory-passport.md) against two
// implementations: pocketBrain on examples/brain (the fixture's content) and the small reference
// server, which shares no code with it.
import { test, expect, afterAll } from "bun:test";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { runConformance, report, type Fixture } from "../conformance/suite";
import { referenceServer, loadFixture } from "../conformance/reference-server";
import { MUTANTS } from "../conformance/mutants";
import { addFixtureExtras } from "../scripts/conformance";
import { setupOAuth, clearJwksCache } from "../src/oauth";
import { startFakeAS, connect } from "./fake-as";

const fx = loadFixture() as unknown as Fixture;
// pocketBrain checks that fail today, each with the backlog row that fixes it. Empty this as they land.
const POCKETBRAIN_KNOWN: Record<string, string> = {};

test("the reference server passes every check, none skipped", async () => {
  const s = referenceServer(loadFixture());
  const results = await runConformance((path, init) => s.handle(new Request(`http://ref${path}`, init)), fx,
    { name: "steward", token: s.issue("full") }, { name: "helper", token: s.issue("limited") }, { resolver: s.issue("full", "resolver"), waiting: s.issueWaiting() });
  expect(results.filter((r) => !r.ok).map((r) => `${r.id}: ${r.detail}`)).toEqual([]);
  expect(results.filter((r) => r.skipped).map((r) => r.id)).toEqual([]);
  expect(results.length).toBeGreaterThanOrEqual(34);
});

// A slow full run saw the wait tick from 59 to 58 s between the hidden and the missing note's 429
// (builder pre-push, 2026-10-22) and B1 called them different. Only the wait may differ.
test("B1: two over-budget answers a second apart, the same but for the wait, pass", async () => {
  const s = referenceServer(loadFixture());
  let wait = 60;
  const ticking = async (req: Request) => {
    const r = await s.handle(req);
    if (r.status !== 429) return r;
    const w = String(wait--);
    return new Response(JSON.stringify({ error: `too many requests from you; try again in ${w} s` }), { status: 429, headers: { "content-type": "application/json", "retry-after": w } });
  };
  const results = await runConformance((path, init) => ticking(new Request(`http://ref${path}`, init)), fx,
    { name: "steward", token: s.issue("full") }, { name: "helper", token: s.issue("limited") }, { resolver: s.issue("full", "resolver"), waiting: s.issueWaiting() });
  expect(results.find((r) => r.id === "B1")).toMatchObject({ ok: true });
});

// 0.2's checks, by id: each one runs, and the budget check found the reference server's budget.
test("spec 0.2: handoffs, route-limited and waiting credentials and the request budget are checked", async () => {
  const s = referenceServer(loadFixture());
  const results = await runConformance((path, init) => s.handle(new Request(`http://ref${path}`, init)), fx,
    { name: "steward", token: s.issue("full") }, { name: "helper", token: s.issue("limited") }, { resolver: s.issue("full", "resolver"), waiting: s.issueWaiting() });
  expect(results.map((r) => r.id)).toEqual(expect.arrayContaining(["H1", "H2", "H3", "P1", "P2", "Q1", "B1"]));
  const over = await s.handle(new Request("http://ref/v1/orientation", { headers: { authorization: "Bearer x" } }));
  expect(over.status).toBe(401);
});

// Must-fail: each broken server fails exactly the checks written to catch its mistake, so no check
// is a pass that nothing can fail.
for (const m of MUTANTS) {
  test(`the suite catches a server where ${m.name}`, async () => {
    const s = referenceServer(loadFixture());
    const fullToken = s.issue("full"), limitedToken = s.issue("limited"), resolverToken = s.issue("full", "resolver"), waitingToken = s.issueWaiting();
    const raw = loadFixture();
    const sees = raw.agents.limited.sees as string[];
    const ctx = { fx, fullToken, limitedToken, resolverToken, waitingToken, hidden: raw.notes.map((n) => n.id).filter((id) => !sees.includes(id)) };
    const h = m.wrap((req) => s.handle(req), ctx);
    const results = await runConformance(async (path, init) => h(new Request(`http://ref${path}`, init)), fx,
      { name: "steward", token: fullToken }, { name: "helper", token: limitedToken }, { resolver: resolverToken, waiting: waitingToken });
    expect(results.filter((r) => !r.ok).map((r) => r.id).sort()).toEqual([...m.catches].sort());
  });
}

// examples/brain plus the fixture's one extra note: a person outside the work area, so the limited
// agent sees it only through contacts-basic (role, not phones).
function pocketBrainFixture() {
  const root = makeBrain({ git: false });
  addFixtureExtras(root);
  return root;
}

// The owner's own sign-in on the OAuth door, not yet approved: pocketBrain's waiting session.
const as = startFakeAS("user_owner");
afterAll(() => as.stop());
async function waitingSignIn(root: string) {
  clearJwksCache();
  const base = "https://brain.test";
  setupOAuth(root, { issuer: as.issuer, resource: `${base}/mcp/oauth`, owner_subject: "user_owner" });
  const c = await connect((path, init) => handle(root, new Request(base + path, init)), `${base}/mcp/oauth`, { dcr: { client_name: "Hark", redirect_uri: "https://agent.example/cb" } });
  return c.token();
}

test("pocketBrain passes every MUST check but the known ones, with its resolver token and a waiting sign-in", async () => {
  const root = pocketBrainFixture();
  const waiting = await waitingSignIn(root);
  const results = await runConformance((path, init) => handle(root, new Request(`https://brain.test${path}`, init)), fx,
    { name: "steward", token: issueToken(root, "steward") }, { name: "helper", token: issueToken(root, "helper") },
    { resolver: issueToken(root, "steward", "resolver"), waiting });
  expect(results.filter((r) => r.skipped).map((r) => r.id)).toEqual([]);
  const failing = results.filter((r) => !r.ok && r.level === "MUST").map((r) => r.id);
  if (failing.some((id) => !(id in POCKETBRAIN_KNOWN))) console.log(report(results));
  expect(failing.sort()).toEqual(Object.keys(POCKETBRAIN_KNOWN).sort());
});

test("the fixture is what pocketBrain is tested on", () => {
  const root = pocketBrainFixture();
  const { loadBrain } = require("../src/brain") as typeof import("../src/brain");
  const brain = new Map(loadBrain(root).map((n) => [n.fm.id, n]));
  for (const n of fx.probes ? loadFixture().notes : []) {
    const b = brain.get(n.id)!;
    expect(b?.fm.title).toBe(n.title);
    for (const [k, f] of Object.entries(n.facts)) {
      const rec = b.fm.facts?.[k] as { value?: unknown; items?: { value: unknown }[] };
      expect(String(rec.value ?? rec.items?.[0]?.value)).toBe(f.value);
    }
  }
});
