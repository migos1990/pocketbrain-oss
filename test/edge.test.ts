// SPDX-License-Identifier: AGPL-3.0-only
// The sealed edge (src/edge.ts, docs/edge.md): a published bundle holds no readable note or
// token, a live token reads its slice through it and nothing else, writes queue sealed to the hub
// and replay through the normal write path, and a revoked or paused agent opens nothing new.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeBrain } from "./fixture";
import { enroll, publish, edgeHandle, replay, openBundle } from "../src/edge";
import { issueToken, revokeTokens, tokenInfo } from "../src/auth";
import { sha256 } from "../src/util";
import { setAgentStatus } from "../src/dashboard/actions";
import { loadBrain } from "../src/brain";

let out = "";
beforeEach(() => { process.env.PB_CONFIG_DIR = join(mkdtempSync(join(tmpdir(), "pb-edge-home-")), "keys"); out = mkdtempSync(join(tmpdir(), "pb-edge-out-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; });

const mcp = (token: string, name: string, args: Record<string, unknown> = {}) => edgeHandle(out, new Request("http://edge/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }));
const text = async (r: Response) => { const j = await r.json() as { result?: { content: { text: string }[] } }; return j.result?.content[0].text ?? JSON.stringify(j); };

test("a published bundle holds no readable note, value or token", () => {
  const root = makeBrain();
  const token = enroll(root, "planner");
  expect(publish(root, out).published).toEqual(["planner"]);
  const raw = readFileSync(join(out, "planner.json"), "utf8");
  for (const s of ["Grade the midterm", "Course A", "Maple Trust", token, "course-a"]) expect(raw).not.toContain(s);
});

test("a live token reads its own slice at the edge; hidden notes stay missing; other tokens get nothing", async () => {
  const root = makeBrain();
  const token = enroll(root, "planner");
  const helper = enroll(root, "helper");
  const plainToken = issueToken(root, "planner"); // a token that was never enrolled
  publish(root, out);
  expect(await text(await mcp(token, "read", { id: "projects/course-a" }))).toContain("Grade the midterm");
  expect(await text(await mcp(token, "read", { id: "money/main-bank" }))).toContain("no note money/main-bank in your view");
  expect(await text(await mcp(token, "search", { query: "bank" }))).not.toContain("Maple");
  expect((await mcp(plainToken, "read", { id: "projects/course-a" })).status).toBe(401);
  expect((await mcp(helper.replace(/^pb_helper_/, "pb_planner_"), "read", { id: "projects/course-a" })).status).toBe(401);
  expect((await mcp("pb_planner_" + "x".repeat(32), "read", { id: "projects/course-a" })).status).toBe(401);
});

test("a write at the edge is queued sealed to the hub and replayed through the write path", async () => {
  const root = makeBrain();
  const token = enroll(root, "planner");
  publish(root, out);
  const r = JSON.parse(await text(await mcp(token, "remember", { id: "projects/course-a", attribute: "next_step", value: "Publish the grades", as_of: "2026-10-07", sources: ["gmail:f000000000000009"], verification: "verified-by-source" })));
  expect(r.outcome).toBe("queued");
  const q = readdirSync(join(out, "queue")).filter((f) => f.endsWith(".json"));
  expect(q.length).toBe(1);
  expect(readFileSync(join(out, "queue", q[0]), "utf8")).not.toContain("Publish the grades");
  // Nothing changed at home until the hub replays.
  const step = () => JSON.stringify(loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm.facts!.next_step);
  expect(step()).not.toContain("Publish the grades");
  const rs = await replay(root, out);
  expect(rs.map((x) => [x.agent, x.tool])).toEqual([["planner", "remember"]]);
  expect(["committed", "inbox"]).toContain(rs[0].outcome);
  expect(readdirSync(join(out, "queue")).filter((f) => f.endsWith(".json"))).toEqual([]);
});

test("a revoked token: no bundle on the next publish, and its queued writes are refused on replay", async () => {
  const root = makeBrain();
  const token = enroll(root, "planner");
  publish(root, out);
  await mcp(token, "remember", { id: "projects/course-a", attribute: "next_step", value: "Publish the grades", as_of: "2026-10-07", sources: ["gmail:f000000000000009"], verification: "verified-by-source" });
  const old = readFileSync(join(out, "planner.json"), "utf8");
  revokeTokens(root, "planner");
  const p = publish(root, out);
  expect(p.left_out.planner).toBe("no live enrolled token");
  expect(existsSync(join(out, "planner.json"))).toBe(false);
  expect((await mcp(token, "read", { id: "projects/course-a" })).status).toBe(401);
  const rs = await replay(root, out);
  expect(rs[0].outcome).toBe("refused");
  expect(rs[0].message).toContain("revoked");
  // A new token's bundle is sealed with a new key: the old token opens nothing in it.
  enroll(root, "planner");
  publish(root, out);
  expect(readFileSync(join(out, "planner.json"), "utf8")).not.toBe(old);
  expect((await mcp(token, "read", { id: "projects/course-a" })).status).toBe(401);
});

test("a paused agent gets no bundle; tools that need the hub say so", async () => {
  const root = makeBrain();
  const token = enroll(root, "planner");
  publish(root, out);
  const busy = await mcp(token, "log_session", { log_id: "x" });
  expect(await text(busy)).toContain("needs the hub");
  setAgentStatus(root, "planner", "paused");
  expect(publish(root, out).left_out.planner).toBe("paused");
  expect((await mcp(token, "read", { id: "projects/course-a" })).status).toBe(401);
});

// G202: a replayed write runs under its token's role, so a reader token's write through the edge
// keeps the G18 guard (its made-up owner message id waits in the inbox, as it does at the hub).
test("G202: a reader token's write through the edge replays as the reader's", async () => {
  const root = makeBrain();
  const token = enroll(root, "steward", "reader");
  expect(tokenInfo(root).steward.find((t) => t.hash === sha256(token))?.role).toBe("reader");
  expect(publish(root, out).published).toContain("steward");
  const fake = ["imsg:phonemsg-01M9", "FAKE".repeat(5), "00"].join("");
  await mcp(token, "remember", { id: "people/paul-advisor", attribute: "role", value: "Forged CEO", as_of: "2026-10-07", sources: [fake], verification: "confirmed-by-louis" });
  const rs = await replay(root, out);
  expect(rs[0].agent).toBe("steward");
  expect(rs[0].outcome).toBe("inbox");
  const reg = ["owner-messages.yaml", "louis-messages.yaml"].map((f) => join(root, "rules", f)).filter((f) => existsSync(f)).map((f) => readFileSync(f, "utf8")).join("");
  expect(reg).not.toContain("FAKEFAKE");
});

// ---------- G249: a reader token decrypts only a cell built under the reader role ----------

const fileText = (files: Record<string, Buffer>) => Object.entries(files).filter(([p]) => p.endsWith(".md")).map(([, v]) => v.toString());

test("G249: a reader token's wrap opens only a reader-capped cell: no private note or private value", async () => {
  const root = makeBrain();
  const plain = enroll(root, "steward");
  const reader = enroll(root, "steward", "reader");
  publish(root, out);
  const b = JSON.parse(readFileSync(join(out, "steward.json"), "utf8"));
  // The token holder's own client: the key comes from the token and the salt in the bundle.
  const full = openBundle(b, plain)!, capped = openBundle(b, reader)!;
  expect(fileText(full).some((t) => /^sensitivity: private/m.test(t))).toBe(true); // the plain token's cell is the whole slice
  expect(capped).toBeDefined();
  const texts = fileText(capped);
  expect(texts.length).toBeGreaterThan(0);
  expect(texts.filter((t) => /^sensitivity: private/m.test(t))).toEqual([]);
  expect(texts.join("\n")).not.toContain("Maple Trust");
  expect(Object.keys(capped)).not.toContain("money/main-bank.md");
  expect(YAML.parse(capped["rules/tokens.yaml"].toString()).agents.steward.map((t: { hash: string }) => t.hash)).toEqual([sha256(reader)]);
  // Served at the edge, each token reads its own cell.
  expect(await text(await mcp(reader, "read", { id: "money/main-bank" }))).toContain("no note money/main-bank in your view");
  expect(await text(await mcp(plain, "read", { id: "money/main-bank" }))).toContain("Maple Trust");
});

// ---------- G202 follow-ups: retire and capture under the role, and the role read at replay ----------

test("G202: a reader's retire of a private fact, queued at the edge, is refused like at the hub; a plain token's goes through", async () => {
  const retireBank = { id: "money/main-bank", attribute: "bank", as_of: "2026-10-07", sources: ["gmail:f000000000000009"], verification: "verified-by-source" };
  const root = makeBrain();
  const reader = enroll(root, "steward", "reader"), plain = enroll(root, "steward");
  publish(root, out);
  await mcp(reader, "retire", retireBank);
  const before = readFileSync(join(root, "money/main-bank.md"), "utf8");
  let rs = await replay(root, out);
  expect(rs[0].outcome).not.toMatch(/committed|inbox/);
  expect(readFileSync(join(root, "money/main-bank.md"), "utf8")).toBe(before);
  // The control: the same retire from the plain token reaches the note.
  await mcp(plain, "retire", retireBank);
  rs = await replay(root, out);
  expect(["committed", "inbox"]).toContain(rs[0].outcome);
});

test("G202: a reader's capture at the edge replays as at the hub (capture has no reader rule)", async () => {
  const root = makeBrain();
  const token = enroll(root, "steward", "reader");
  publish(root, out);
  await mcp(token, "capture", { text: "Robin wants the grades out by Friday" });
  const rs = await replay(root, out);
  expect(rs[0].agent).toBe("steward");
  expect(rs[0].outcome).toBe("stored");
});

const setRole = (root: string, token: string, role: string | undefined) => {
  const f = join(root, "rules", "tokens.yaml");
  const t = YAML.parse(readFileSync(f, "utf8"));
  for (const e of t.agents.steward) if (e.hash === sha256(token)) { if (role) e.role = role; else delete e.role; }
  writeFileSync(f, YAML.stringify(t));
};
const forgedOwnerWrite = () => ({ id: "people/paul-advisor", attribute: "role", value: "Forged CEO", as_of: "2026-10-07", sources: [["imsg:phonemsg-01M9", "FAKE".repeat(5), "00"].join("")], verification: "confirmed-by-louis" });
const ownerRegistry = (root: string) => ["owner-messages.yaml", "louis-messages.yaml"].map((f) => join(root, "rules", f)).filter((f) => existsSync(f)).map((f) => readFileSync(f, "utf8")).join("");

test("G202: the role is read at replay: a token made a reader after queueing replays as a reader, one made a resolver is refused", async () => {
  const root = makeBrain();
  const token = enroll(root, "steward");
  publish(root, out);
  await mcp(token, "remember", forgedOwnerWrite());
  setRole(root, token, "reader");
  let rs = await replay(root, out);
  expect(rs[0].outcome).toBe("inbox");
  expect(ownerRegistry(root)).not.toContain("FAKEFAKE");
  setRole(root, token, undefined);
  publish(root, out);
  await mcp(token, "remember", { ...forgedOwnerWrite(), value: "Forged again" });
  setRole(root, token, "resolver");
  rs = await replay(root, out);
  expect(rs[0].outcome).toBe("refused");
});

// ---------- G181 follow-up: replay refusing an agent with hours tells the owner, like the tripwire ----------

test("G181: replay refusing an agent with hours raises an owner alert", async () => {
  const root = makeBrain();
  const token = enroll(root, "planner");
  publish(root, out);
  await mcp(token, "remember", { id: "projects/course-a", attribute: "next_step", value: "Queued before hours", as_of: "2026-10-07", sources: ["gmail:f000000000000009"], verification: "verified-by-source" });
  const f = join(root, "rules", "policy.yaml");
  writeFileSync(f, readFileSync(f, "utf8").replace(/^(  planner: \{)/m, `$1 windows: ["daily 03:25-05:00"],`));
  const rs = await replay(root, out);
  expect(rs[0].outcome).toBe("refused");
  const alerts = existsSync(join(root, "log", "alerts.jsonl")) ? readFileSync(join(root, "log", "alerts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  expect(alerts.some((a) => a.agent === "planner" && a.check === "gardener_hours")).toBe(true);
});

// Slice audit 2026-10-25 (G419): the hub stopped taking a token in the URL, but the edge still did,
// and a bundle kept opening for a token past its 90 days until the next publish.
test("the edge takes a token only in the header, never in the URL path", async () => {
  const root = makeBrain();
  const token = enroll(root, "planner");
  publish(root, out);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read", arguments: { id: "projects/course-a" } } });
  const r = await edgeHandle(out, new Request(`http://edge/mcp/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body }));
  expect(r.status).toBe(401);
  // A write is queued before any cell opens, so the door itself must refuse it.
  const w = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "remember", arguments: { id: "projects/course-a", attribute: "next_step", value: "x", as_of: "2026-10-07", sources: ["agent:planner"] } } });
  expect((await edgeHandle(out, new Request(`http://edge/mcp/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: w }))).status).toBe(401);
  expect(existsSync(join(out, "queue")) ? readdirSync(join(out, "queue")).filter((f) => f.endsWith(".json")) : []).toEqual([]);
});

test("a token past its expiry opens nothing at the edge, even before the next publish", async () => {
  const root = makeBrain();
  const token = enroll(root, "planner");
  publish(root, out);
  expect(await text(await mcp(token, "read", { id: "projects/course-a" }))).toContain("Grade the midterm");
  process.env.PB_NOW = new Date(Date.now() + 91 * 86_400_000).toISOString();
  try {
    expect((await mcp(token, "read", { id: "projects/course-a" })).status).toBe(401);
    expect((await mcp(token, "remember", { id: "projects/course-a", attribute: "next_step", value: "x", as_of: "2026-10-07", sources: ["agent:planner"] })).status).toBe(401);
  } finally { delete process.env.PB_NOW; }
});
