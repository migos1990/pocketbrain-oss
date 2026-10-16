// SPDX-License-Identifier: AGPL-3.0-only
// Slice sharing for a collaborator (src/share.ts, docs/share.md): a person gets a slice, live and
// read-only, until a date. What must hold whatever policy.yaml or the dashboard says.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { loadRules } from "../src/rules";
import { loadBrain, saveNote } from "../src/brain";
import { carve, grantFor } from "../src/carve";
import { git } from "../src/git";
import { setAgentStatus } from "../src/dashboard/actions";
import { previewShare, addShare, extendShare, endShare, listShares, shareLines } from "../src/share";
import { main } from "../src/cli";
import { digest } from "../src/digest";
import { askDump, syncPass, state, memoryReply } from "../src/memsync";
import { setupOAuth, addCoworker, loadOAuth } from "../src/oauth";

beforeEach(() => { process.env.PB_TODAY = "2026-10-08"; });
afterEach(() => { process.env.PB_TODAY = "2026-10-08"; });

async function call(root: string, token: string, method: string, path: string, body?: unknown) {
  const res = await handle(root, new Request(`http://pb${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${token}` } }));
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, text, json };
}
const mcp = async (root: string, token: string, name: string, args: Record<string, unknown> = {}) =>
  (await call(root, token, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).json.result;

const ALICE = { agent: "alice", name: "Alice Roy", slices: ["area:work"], days: 30 };
const commits = (root: string) => Number(git(root, ["rev-list", "--count", "HEAD"]));
function editPolicy(root: string, f: (s: string) => string) {
  const p = join(root, "rules", "policy.yaml");
  writeFileSync(p, f(readFileSync(p, "utf8")));
}

test("the preview changes nothing; --yes writes one owner commit with the date it ends", () => {
  const root = makeBrain();
  const before = commits(root);
  const p = previewShare(root, ALICE);
  expect(p.notes).toBeGreaterThan(0);
  expect(p.until).toBe("2026-11-07");
  expect(loadRules(root).policy.agents.alice).toBeUndefined();
  expect(commits(root)).toBe(before);
  addShare(root, ALICE);
  const a = loadRules(root).policy.agents.alice;
  expect(a.collaborator).toEqual({ name: "Alice Roy", until: "2026-11-07" });
  expect(a.tier).toBe("trial");
  expect(commits(root)).toBe(before + 1);
  expect(git(root, ["log", "-1", "--format=%an %B"])).toMatch(/Kind: share/);
});

test("a collaborator reads its slice, and every write is refused", async () => {
  const root = makeBrain();
  addShare(root, ALICE);
  const tok = issueToken(root, "alice");
  expect((await call(root, tok, "GET", "/v1/notes/projects/course-a")).status).toBe(200);
  const w = await call(root, tok, "POST", "/v1/remember", { id: "projects/course-a", attribute: "room", value: "Hall Z9", as_of: "2026-10-08", sources: ["agent:alice"] });
  expect([403, 422]).toContain(w.status);
  expect(w.text).toMatch(/read-only/);
  expect(JSON.stringify(loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm)).not.toContain("Hall Z9");
});

test("unpausing in the dashboard can't make a collaborator writable", () => {
  const root = makeBrain();
  addShare(root, ALICE);
  setAgentStatus(root, "alice", "paused");
  setAgentStatus(root, "alice", "active");
  expect(loadRules(root).policy.agents.alice.status).toBe("read-only");
});

test("past its date a collaborator is paused: no reads at all", async () => {
  const root = makeBrain();
  addShare(root, { ...ALICE, days: 1 });
  const tok = issueToken(root, "alice");
  expect((await call(root, tok, "GET", "/v1/notes/projects/course-a")).status).toBe(200);
  process.env.PB_TODAY = "2026-10-10";
  expect(loadRules(root).policy.agents.alice.status).toBe("paused");
  expect((await call(root, tok, "GET", "/v1/notes/projects/course-a")).status).toBe(403);
  expect((await call(root, tok, "GET", "/v1/context")).status).toBe(403);
});

test("a hand-edited policy can't widen a collaborator: no private, no money, no all slice", () => {
  const root = makeBrain();
  addShare(root, ALICE);
  // A private fact in its own area.
  const n = loadBrain(root).find((x) => x.fm.id === "projects/course-a")!;
  n.fm.facts!.appeal = { value: "Student appeal pending", sensitivity: "private", as_of: "2026-10-05", sources: ["gmail:f000000000000004"], verification: "verified-by-source", by: "planner", recorded: "2026-10-05" } as never;
  saveNote(root, n);
  editPolicy(root, (s) => s.replace(/^  alice: .*$/m, "  alice: { tier: core, max_sensitivity: secret, slices: [all, area:work], collaborator: { name: Alice Roy, until: 2026-11-07 } }"));
  const rules = loadRules(root);
  const a = rules.policy.agents.alice;
  expect(a.slices).toEqual(["area:work"]);
  expect(a.tier).toBe("trial");
  const res = carve(loadBrain(root), rules, grantFor(rules, "alice"));
  expect(res.grant.ceiling).toBe("personal");
  expect(res.grant.exclude_types).toContain("money");
  expect([...res.visible.keys()].some((k) => k.startsWith("money/"))).toBe(false);
  expect(res.visible.has("projects/course-a")).toBe(true);
  expect(res.hiddenFacts.some((h) => h.key === "projects/course-a#appeal")).toBe(true);
});

test("a collaborator can't be the resolver or own an area", () => {
  const root = makeBrain();
  addShare(root, ALICE);
  editPolicy(root, (s) => s.replace("resolver: steward", "resolver: alice"));
  expect(() => loadRules(root)).toThrow(/collaborator/);
  editPolicy(root, (s) => s.replace("resolver: alice", "resolver: steward").replace("work: { owner: planner }", "work: { owner: alice }"));
  expect(() => loadRules(root)).toThrow(/collaborator/);
});

test("a collaborator can't ask to see a note outside its slice", async () => {
  const root = makeBrain();
  addShare(root, ALICE);
  editPolicy(root, (s) => s + "ask_to_see: true\n");
  // The same ask from an ordinary trial agent waits for the owner; from a collaborator it's refused.
  const helper = await mcp(root, issueToken(root, "helper"), "ask_to_see", { what: "the main bank", why: "budget" });
  expect(JSON.stringify(helper)).toMatch(/Asked/);
  const r = await mcp(root, issueToken(root, "alice"), "ask_to_see", { what: "the main bank", why: "budget" });
  expect(JSON.stringify(r)).not.toMatch(/Asked|waiting/);
});

test("extend moves the date; end revokes its keys and pauses it, all logged", async () => {
  const root = makeBrain();
  addShare(root, ALICE);
  const tok = issueToken(root, "alice");
  extendShare(root, "alice", 10);
  expect(loadRules(root).policy.agents.alice.collaborator!.until).toBe("2026-11-17");
  expect(listShares(root).map((s) => s.agent)).toEqual(["alice"]);
  endShare(root, "alice");
  expect((await call(root, tok, "GET", "/v1/notes/projects/course-a")).status).toBe(401);
  expect(loadRules(root).policy.agents.alice.status).toBe("paused");
  expect(git(root, ["log", "--format=%s", "-3"])).toMatch(/share/);
});

test("the owner's digest lists active shares and those that ended", () => {
  const root = makeBrain();
  addShare(root, ALICE);
  addShare(root, { agent: "bob", name: "Bob", slices: ["area:work"], days: 1 });
  process.env.PB_TODAY = "2026-10-10";
  const lines = shareLines(root).join("\n");
  expect(lines).toMatch(/Alice Roy.*until 2026-11-07/);
  expect(lines).toMatch(/Bob.*ended 2026-10-09/);
});

test("refusals: unknown slice, the all slice, an existing agent name", () => {
  const root = makeBrain();
  expect(() => previewShare(root, { ...ALICE, slices: ["nope"] })).toThrow(/unknown slice/);
  expect(() => previewShare(root, { ...ALICE, slices: ["all"] })).toThrow(/all/);
  expect(() => previewShare(root, { ...ALICE, agent: "planner" })).toThrow(/already/);
  expect(() => previewShare(root, { ...ALICE, days: 400 })).toThrow(/days/);
});

test("the share command previews without --yes, writes with it, and the digest carries the line", () => {
  const root = makeBrain();
  const out: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...a: unknown[]) => out.push(a.join(" ")); console.error = console.log;
  let codes: number[];
  try {
    codes = [main(["share", "add", "alice", "--name", "Alice Roy", "--slices", "area:work", "--brain", root])];
    const shared = !!loadRules(root).policy.agents.alice;
    codes.push(shared ? 99 : 0, main(["share", "add", "alice", "--name", "Alice Roy", "--slices", "area:work", "--yes", "--brain", root]), main(["share", "list", "--brain", root]), main(["share", "end", "alice", "--brain", root]), main(["share", "--brain", root]));
  } finally { console.log = log; console.error = err; }
  expect(codes).toEqual([0, 0, 0, 0, 0, 2]);
  const text = out.join("\n");
  expect(text).toMatch(/Nothing shared yet/);
  expect(text).toMatch(/pocketbrain invite alice/);
  expect(text).toMatch(/alice\s+Alice Roy\s+area:work\s+until 2026-11-07/);
  expect(text).toMatch(/share ended/);
  expect(digest(root).text).toMatch(/Shared with people: Alice Roy \(alice\) ended 2026-10-08/);
});

// Slice audit findings (pocketbrain-app-reviews/collaborator-share-slice-audit.md).
test("a read-only agent's memory dump keeps nothing; collaborators aren't asked or quizzed", () => {
  const root = makeBrain();
  addShare(root, ALICE);
  expect(askDump(root, "alice")).toMatch(/can't be asked/);
  expect(syncPass(root, 3).alice).toBeUndefined();
  // A planner set read-only by the owner after it was asked: the dump writes nothing either.
  askDump(root, "planner");
  editPolicy(root, (s) => s.replace(/^(  planner: \{)/m, "$1 status: read-only,"));
  const id = state(root).dumps.find((d) => d.agent === "planner")!.id;
  const before = commits(root);
  // Since G50 the reply is refused outright, before anything is written.
  expect(() => memoryReply(root, "planner", { memory_dump: { id, text: "Jane Roy is the course coordinator." } })).toThrow(/read-only/);
  expect(commits(root)).toBe(before);
});

test("a collaborator can't carry the owner's texts, be named after an area, or hold a malformed date", () => {
  for (const [edit, err] of [
    [(s: string) => s + "owner_channel: alice\n", /collaborator/],
    [(s: string) => s + "louis_channel: alice\n", /collaborator/],
    [(s: string) => s.replace(/^  alice: \{/m, "  alice: { inside_wall: true,"), /collaborator/],
    [(s: string) => s.replace(/^  alice: \{/m, "  alice: { role: gardener,"), /collaborator/],
    [(s: string) => s.replace(/^  alice:/m, "  personal:"), /area/],
  ] as [(s: string) => string, RegExp][]) {
    const root = makeBrain();
    addShare(root, ALICE);
    editPolicy(root, edit);
    expect(() => loadRules(root)).toThrow(err);
  }
  expect(() => previewShare(makeBrain(), { ...ALICE, agent: "personal" })).toThrow(/area/);
  for (const bad of ["2026-11-7", "20261107", "2026-11-07T00:00:00Z", "2099-01-01 "]) {
    const root = makeBrain();
    addShare(root, ALICE);
    editPolicy(root, (s) => s.replace("until: 2026-11-07", `until: "${bad}"`));
    expect(loadRules(root).policy.agents.alice.status).toBe("paused");
  }
});

test("the until day itself still reads; the next day doesn't", () => {
  const root = makeBrain();
  addShare(root, ALICE);
  process.env.PB_TODAY = "2026-11-07";
  expect(loadRules(root).policy.agents.alice.status).toBe("read-only");
  process.env.PB_TODAY = "2026-11-08";
  expect(loadRules(root).policy.agents.alice.status).toBe("paused");
});

test("ending a share removes the person's sign-in too", () => {
  const root = makeBrain();
  setupOAuth(root, { issuer: "https://as.example", resource: "https://brain.example/mcp/oauth", owner_subject: "user_owner" });
  addShare(root, ALICE);
  addCoworker(root, "user_alice", "Alice Roy", "alice");
  expect(Object.keys(loadOAuth(root)!.coworkers ?? {})).toEqual(["user_alice"]);
  endShare(root, "alice");
  expect(loadOAuth(root)!.coworkers ?? {}).toEqual({});
});
