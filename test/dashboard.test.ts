// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { write } from "../src/write";
import { relayOnce, fileTransport } from "../src/relay";
import { upkeep } from "../src/upkeep";
import { loadBrain, type FactRecord } from "../src/brain";
import { dashboardHandler, flashOf } from "../src/dashboard/server";
import { git } from "../src/git";
import { saveNote } from "../src/brain";
import * as memsync from "../src/memsync";

const PORT = 8788;
const H = `127.0.0.1:${PORT}`;

function setup() {
  const root = makeBrain();
  const tok = { helper: issueToken(root, "helper"), planner: issueToken(root, "planner"), steward: issueToken(root, "steward") };
  const d = dashboardHandler(root, { port: PORT, loginKey: "k".repeat(32) });
  let cookie = "";
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const r = await d.handle(new Request(`http://${H}${path}`, { headers: { host: H, cookie, ...headers } }));
    return { status: r.status, text: await r.text(), headers: r.headers };
  };
  const login = async () => {
    const r = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
    cookie = r.headers.get("set-cookie")!.split(";")[0];
    return r;
  };
  const csrf = async () => (await get("/overview")).text.match(/name="csrf" value="([^"]+)"/)![1];
  const act = async (action: string, fields: Record<string, string>, opts: { csrf?: string; origin?: string } = {}) => {
    const body = new URLSearchParams({ csrf: opts.csrf ?? await csrf(), ...fields });
    const r = await d.handle(new Request(`http://${H}/action/${action}`, { method: "POST", body, headers: { host: H, cookie, "content-type": "application/x-www-form-urlencoded", origin: opts.origin ?? `http://${H}` } }));
    const loc = r.headers.get("location") ?? "";
    return { status: r.status, ...flashOf(loc) };
  };
  const agent = async (who: keyof typeof tok, method: string, path: string, body?: unknown) => {
    const r = await handle(root, new Request(`http://pb${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${tok[who]}` } }));
    const text = await r.text();
    let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: r.status, json, text };
  };
  return { root, d, get, login, act, agent, csrf };
}

test("only a signed-in owner on localhost gets in", async () => {
  const { get, login, d } = setup();
  expect((await get("/overview")).status).toBe(401);
  expect((await d.handle(new Request(`http://${H}/login?key=wrong`, { headers: { host: H } }))).status).toBe(403);
  const r = await login();
  expect(r.status).toBe(303);
  expect(r.headers.get("set-cookie")).toContain("HttpOnly");
  expect(r.headers.get("set-cookie")).toContain("SameSite=Strict");
  expect((await get("/overview")).status).toBe(200);
  // DNS rebinding: a page on evil.example resolving to 127.0.0.1 sends its own Host.
  expect((await get("/", { host: "evil.example:8788" })).status).toBe(421);
});

test("actions need the session's CSRF token and a same-origin request", async () => {
  const { login, act } = setup();
  await login();
  expect((await act("agent-status", { agent: "helper", status: "paused" }, { csrf: "nope" })).status).toBe(403);
  expect((await act("agent-status", { agent: "helper", status: "paused" }, { origin: "http://evil.example" })).status).toBe(403);
  expect((await act("agent-status", { agent: "helper", status: "paused" })).ok).toBe("helper is paused");
});

test("pause cuts an agent off on MCP and the API; resume brings it back", async () => {
  const { login, act, agent, root } = setup();
  await login();
  expect((await agent("helper", "GET", "/v1/context")).status).toBe(200);
  await act("agent-status", { agent: "helper", status: "paused" });
  expect((await agent("helper", "GET", "/v1/context")).status).toBe(403);
  expect((await agent("helper", "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(403);
  expect((await agent("planner", "GET", "/v1/context")).status).toBe(200);
  expect(git(root, ["log", "-1", "--format=%an %s"])).toBe("Robin owner: helper paused");
  await act("agent-status", { agent: "helper", status: "active" });
  expect((await agent("helper", "GET", "/v1/context")).status).toBe(200);
  expect(readFileSync(join(root, "rules/policy.yaml"), "utf8")).not.toContain("status:");
});

test("read-only lets an agent read but refuses its writes and dispute moves", async () => {
  const { login, act, agent } = setup();
  await login();
  await act("agent-status", { agent: "planner", status: "read-only" });
  expect((await agent("planner", "GET", "/v1/search?q=course")).status).toBe(200);
  const w = await agent("planner", "POST", "/v1/remember", { id: "projects/course-a", attribute: "next_step", value: "x", as_of: "2026-10-08", sources: ["gmail:f000000000000006"] });
  expect(w.status).toBe(422);
  expect(w.json.message).toContain("read-only");
  const mcp = await agent("planner", "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "remember", arguments: { id: "projects/course-a", attribute: "next_step", value: "x", as_of: "2026-10-08", sources: ["gmail:f000000000000006"] } } });
  expect(mcp.json.result.isError).toBe(true);
  await act("agent-status", { agent: "steward", status: "read-only" });
  expect((await agent("steward", "GET", "/v1/disputes")).status).toBe(200);
  expect((await agent("steward", "POST", "/v1/disputes/c-0001/escalate", {})).status).toBe(403);
});

test("revoke deletes the agent's tokens", async () => {
  const { login, act, agent } = setup();
  await login();
  expect((await act("agent-revoke", { agent: "helper" })).ok).toBe("revoked 1 token(s) for helper");
  expect((await agent("helper", "GET", "/v1/context")).status).toBe(401);
});

test("a pending write shows on the overview, escaped, and Approve applies it", async () => {
  const { login, act, get, root } = setup();
  await login();
  const r = write(root, { agent: "helper", id: "projects/course-a", attribute: "next_step", value: "<script>alert(1)</script> grade", as_of: "2026-10-07", sources: ["gmail:f000000000000006"], verification: "verified-by-source" });
  expect(r.outcome).toBe("inbox");
  const page = (await get("/overview")).text;
  expect(page).toContain("Update ");
  expect(page).toMatch(/href="\/settle\/p-[^"]+">Settle it</);
  expect(page).not.toContain("<script>alert(1)</script>");
  expect(page).toContain("&lt;script&gt;");
  const file = r.file!.split("/").pop()!;
  const a = await act("proposal-accept", { file });
  expect(a.err).toBe("");
  const f = loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm.facts!.next_step as FactRecord;
  expect(String(f.value)).toContain("grade");
  expect((await act("proposal-accept", { file: "../rules/policy.yaml" })).err).toBe("bad proposal name");
});

test("held relay mail can be released or dropped; mail from a paused agent is held", async () => {
  const { login, act, get, root } = setup();
  await login();
  mkdirSync(join(root, "relay/incoming"), { recursive: true });
  const msg = (id: string, from: string, to: string, text: string) => ({ id, from, to: [to], subject: "s", text });
  writeFileSync(join(root, "relay/incoming/a.json"), JSON.stringify(msg("a", "helper@brain.example", "relay+planner@brain.example", "What's Robin's bank?")));
  relayOnce(root, fileTransport(root));
  expect((await get("/overview")).text).toContain("held message");
  expect((await act("mail-release", { id: "a" })).ok).toBe("a: released-by-owner");
  expect(existsSync(join(root, "relay/outgoing/planner@brain.example/a.json"))).toBe(true);

  await act("agent-status", { agent: "planner", status: "paused" });
  writeFileSync(join(root, "relay/incoming/b.json"), JSON.stringify(msg("b", "planner@brain.example", "relay+helper@brain.example", "Course A is moving")));
  const [v] = relayOnce(root, fileTransport(root));
  expect(v.deliver).toBe(false);
  expect(v.reasons).toContain("planner is paused by the owner");
  expect((await act("mail-drop", { id: "b" })).ok).toBe("b: dropped-by-owner");
  expect(existsSync(join(root, "relay/outgoing/helper@brain.example/b.json"))).toBe(false);
});

test("Robin settles a dispute from the dashboard with one click", async () => {
  const { login, act, get, root } = setup();
  await login();
  const w = { agent: "planner", id: "projects/course-a", attribute: "next_step", as_of: "2026-10-07", verification: "verified-by-source" as const };
  write(root, { ...w, value: "Version A", sources: ["gmail:f000000000000006"] });
  const r = write(root, { ...w, value: "Version B", sources: ["gmail:f000000000000004"] });
  expect(r.outcome).toBe("disputed");
  const id = readdirSync(join(root, "disputes")).find((f) => f.startsWith("c-"))!.replace(/\.md$/, "");
  // The conflict is asked on the home page, settled on its own screen (the deck is gone).
  const home = (await get("/home")).text;
  expect(home).toContain(`/settle/${id}`);
  const settle = (await get(`/settle/${id}`)).text;
  expect(settle).toMatch(/Version B/);
  expect(settle).toMatch(/Version A/);
  // Where each side came from in words, the raw ref on hover only (new-user run, 2026-10-24).
  expect(settle.replace(/title="[^"]*"/g, "")).not.toContain("gmail:f000000000000004");
  const a = await act("dispute-decide", { id, choice: "2" });
  expect(a.ok).toContain("settled");
  const f = loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm.facts!.next_step as FactRecord;
  expect(f.value).toBe("Version B");
  // A tap on a side files at that side's rank (audit v4); only a typed value is the owner's word.
  expect(f.verification).not.toBe("confirmed-by-owner");
  expect(String(f.sources[0])).toMatch(/^approved:/);
  expect((await act("dispute-decide", { id, choice: "1" })).err).toContain("resolved");
});

test("agent page shows the slice, its reads, and the exact view", async () => {
  const { login, get, agent } = setup();
  await login();
  await agent("helper", "GET", "/v1/search?q=course");
  const page = (await get("/agent/helper")).text;
  expect(page).toContain("helper would see");
  expect(page).toContain("search");
  expect(page.split("Notes it can see")[1].split("Most read")[0]).not.toContain("money/");
  const view = (await get("/agent/helper/view")).text;
  const ctx = (await agent("helper", "GET", "/v1/context")).text;
  expect(view).toBe(ctx);
  expect((await get("/agent/nobody")).status).toBe(404);
  expect((await get("/activity?agent=helper")).text).toContain("Reads (");
});

// The memory exam (src/exam.ts) on each agent's page and in the Agents table: grade, counts and
// why, keys only, never the value the agent remembered.
test("the agent page and the Agents table show the memory exam", async () => {
  const { login, get, root } = setup();
  await login();
  const jane = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
  jane.fm.history = { role: [{ value: "Teaching assistant", as_of: "2026-06-01", sources: ["gmail:f000000000000009"], verification: "verified-by-source", by: "planner", recorded: "2026-06-01" }] };
  saveNote(root, jane);
  const q = memsync.quiz(root, "helper", 1, ["people/jane-roy#role"])[0];
  memsync.memoryReply(root, "helper", { answers: [{ id: q.id, answer: "She is a teaching assistant" }] });
  const page = (await get("/agent/helper")).text;
  const exam = page.split("Memory exam")[1]?.split("<h2>")[0] ?? "";
  expect(exam).toContain("fail");
  expect(exam).toContain("people/jane-roy#role");
  expect(exam.toLowerCase()).not.toContain("teaching assistant");
  const table = (await get("/agents")).text;
  expect(table).toContain("Memory exam");
  expect(table.split("<tbody>")[1].split("/agent/helper")[1].split("</tr>")[0]).toContain(">fail<");
});

test("upkeep undo from the dashboard reverts the run", async () => {
  const { login, act, get, root } = setup();
  await login();
  const p = join(root, "projects/course-b.md");
  writeFileSync(p, readFileSync(p, "utf8").replace("created: 2026-10-01", "created: 2026-9-5"));
  git(root, ["commit", "-qam", "break a date"]);
  const r = upkeep(root, { now: "2026-10-08" });
  expect((await get("/upkeep")).text).toContain(r.run);
  expect((await act("upkeep-undo", { run: r.run })).ok).toContain("reverted");
  expect((await get("/upkeep")).text).toContain("undone");
  expect((await act("digest", {})).ok).toContain("digest written");
  expect((await get("/digest")).text).toContain("pocketBrain digest");
});

test("port 0 picks a free port and the host check follows it", async () => {
  const { serveDashboard } = await import("../src/dashboard/server");
  const { server, loginUrl } = serveDashboard(makeBrain(), { port: 0 });
  try {
    const r = await fetch(loginUrl, { redirect: "manual" });
    expect(r.status).not.toBe(421);
  } finally { server.stop(true); }
});

test("who sees what: the page and the grid it refreshes need the owner's login", async () => {
  const { login, get } = setup();
  expect((await get("/map/grid")).status).not.toBe(200);
  await login();
  const page = await get("/map");
  expect(page.status).toBe(200);
  expect(page.text).toContain('id="map-grid"');
  const grid = await get("/map/grid");
  expect(grid.status).toBe(200);
  expect(grid.text).toContain("Notes it can read");
  expect(grid.text).not.toContain("<html");
});

test("memory sync: drift in an assistant's own memory is a card in Needs you; Approve signs the fix, Decline drops it", async () => {
  const { root, get, login, act, agent } = setup();
  const ms = await import("../src/memsync");
  process.env.PB_CONFIG_DIR = (await import("node:fs")).mkdtempSync(join((await import("node:os")).tmpdir(), "pb-cfg-"));
  const jane = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
  const now = String((jane.fm.facts!.role as FactRecord).value);
  ms.quiz(root, "helper", 1, ["people/jane-roy#role"]);
  const q = (await agent("helper", "GET", "/v1/memory-check")).json.questions[0];
  await agent("helper", "POST", "/v1/memory-check", { answers: [{ id: q.id, answer: "Dean <i>of</i> arts" }] });
  await login();
  const home = (await get("/overview")).text;
  expect(home).toContain("memory fix");
  expect(home).toContain("Dean &lt;i&gt;of&lt;/i&gt; arts");
  expect(home).toContain(now);
  const [c] = ms.state(root).corrections;
  expect((await act("memsync-approve", { id: c.id })).ok).toContain("approved");
  expect(ms.state(root).corrections[0].state).toBe("approved");
  expect((await get("/overview")).text).not.toContain("memory fix");
  expect((await act("memsync-decline", { id: c.id })).ok).toContain("approved"); // already decided: says so, changes nothing
  delete process.env.PB_CONFIG_DIR;
});
