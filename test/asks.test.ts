// SPDX-License-Identifier: AGPL-3.0-only
// Ask to see (src/asks.ts): one read of one note, only with the owner's approval, from the
// dashboard or from a phone push through Auth0 CIBA (a fake AS here).
import { test, expect, afterEach } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { askToSee, askStatus, approveAsk, declineAsk, listAsks, guardianApprover, bindingMessage, pollAsks, testPush, cancelAsks } from "../src/asks";
import { loadRules } from "../src/rules";
import { verifyChain, readEntries } from "../src/readlog";
import { dashboardHandler, flashOf } from "../src/dashboard/server";

const MOM = `---
id: people/mom
type: person
title: Mom
area: personal
sensitivity: private
status: active
created: 2026-10-01
updated: 2026-10-01
by: steward
facts:
  appointment: { value: "Cardiology, Oct 14 at 9:30, Hopital Sainte-Anne", as_of: 2026-10-01, sources: ["gcal:evt-fake-1"], verification: verified-by-source, by: steward, recorded: 2026-10-01 }
  door_code: { value: "4417", as_of: 2026-10-01, sources: ["imsg:fake-2"], verification: confirmed-by-owner, by: steward, recorded: 2026-10-01, sensitivity: secret }
---
Mom's appointments. She pays with [[money/main-bank]].
`;

function setup(policy = "ask_to_see: { never: [money] }") {
  const root = makeBrain();
  writeFileSync(join(root, "people/mom.md"), MOM);
  if (policy) appendFileSync(join(root, "rules/policy.yaml"), `\n${policy}\n`);
  const tok = { helper: issueToken(root, "helper"), planner: issueToken(root, "planner") };
  const call = async (agent: keyof typeof tok, method: string, path: string, body?: unknown) => {
    const res = await handle(root, new Request(`http://pb${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${tok[agent]}` } }));
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, text, json };
  };
  const mcp = (agent: keyof typeof tok, method: string, params?: unknown) => call(agent, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method, params });
  return { root, call, mcp };
}

const shape = (r: any) => JSON.parse(JSON.stringify(r).replace(/ask-[0-9a-f]{12}/g, "ask-x"));

test("off unless the owner turns it on: no tools, and the route refuses", async () => {
  const { call, mcp } = setup("");
  const tools = (await mcp("helper", "tools/list")).json.result.tools.map((t: any) => t.name);
  expect(tools).not.toContain("ask_to_see");
  expect((await call("helper", "POST", "/v1/ask", { what: "Mom", why: "x" })).status).toBe(403);
});

test("an ask answers the same whether or not anything matches, and only a match reaches the owner", async () => {
  const { root, call, mcp } = setup();
  const tools = (await mcp("helper", "tools/list")).json.result.tools.map((t: any) => t.name);
  expect(tools).toContain("ask_to_see");
  const hit = await call("helper", "POST", "/v1/ask", { what: "Mom's appointment", why: "Robin asked me to book a taxi for it" });
  const miss = await call("planner", "POST", "/v1/ask", { what: "zebra polo tournament", why: "planning" });
  expect(hit.status).toBe(200);
  expect(miss.status).toBe(200);
  expect(shape(hit.json)).toEqual(shape(miss.json));
  const [a, b] = listAsks(root);
  expect(a.candidates[0].id).toBe("people/mom");
  expect(b.candidates).toEqual([]);
  // The miss never shows up for the owner; it simply runs out.
  expect((await call("planner", "GET", `/v1/ask/${miss.json.request}`)).json.status).toBe("waiting");
});

test("approved once in the dashboard: the agent reads the note one time, without its secret fact or links", async () => {
  const { root, call } = setup();
  const r = (await call("helper", "POST", "/v1/ask", { what: "Mom's appointment", why: "book a taxi" })).json;
  expect((await call("helper", "GET", `/v1/ask/${r.request}`)).json.status).toBe("waiting");
  // Before the approval the note is still outside its slice.
  expect((await call("helper", "GET", "/v1/notes/people%2Fmom")).status).toBe(404);
  approveAsk(root, r.request, "people/mom");
  const got = (await call("helper", "GET", `/v1/ask/${r.request}`)).json;
  expect(got.status).toBe("approved");
  expect(got.note).toContain("Cardiology, Oct 14");
  expect(got.note).not.toContain("4417");
  expect(got.note).toContain("[[redacted]]");
  expect(got.note).not.toContain("main-bank");
  const again = (await call("helper", "GET", `/v1/ask/${r.request}`)).json;
  expect(again.status).toBe("used");
  expect(again.note).toBeUndefined();
  expect((await call("helper", "GET", "/v1/notes/people%2Fmom")).status).toBe(404);
  // The receipt: one read of that note, with the approval attached, in the chained read log.
  const read = readEntries(root).find((e) => e.op === "ask_read")!;
  expect(read).toMatchObject({ agent: "helper", ids: ["people/mom"], grant: r.request, approved_via: "dashboard" });
  expect(verifyChain(join(root, "log", "reads.jsonl")).broken).toBeUndefined();
  expect(verifyChain(join(root, "log", "asks.jsonl")).broken).toBeUndefined();
});

test("never-types and secret notes are never offered; a decline gives nothing", async () => {
  const { root, call } = setup();
  const r = (await call("helper", "POST", "/v1/ask", { what: "Main bank Maple Trust", why: "pay a bill" })).json;
  const a = listAsks(root).find((x) => x.id === r.request)!;
  expect(a.candidates.map((c) => c.id)).not.toContain("money/main-bank");
  expect(() => approveAsk(root, r.request, "money/main-bank")).toThrow(/isn't one of the matches/);
  if (a.candidates.length) {
    declineAsk(root, r.request);
    expect((await call("helper", "GET", `/v1/ask/${r.request}`)).json.status).toBe("not approved");
  }
});

test("one ask at a time, a daily cap, nobody reads another agent's ask, paused and gardener can't ask", async () => {
  const { root, call } = setup("ask_to_see: { max_per_day: 2 }");
  const r = (await call("helper", "POST", "/v1/ask", { what: "Mom", why: "x" })).json;
  expect((await call("helper", "POST", "/v1/ask", { what: "Mom", why: "x" })).status).toBe(429);
  expect((await call("planner", "GET", `/v1/ask/${r.request}`)).status).toBe(404);
  declineAsk(root, r.request);
  const r2 = (await call("helper", "POST", "/v1/ask", { what: "Mom", why: "x" })).json;
  declineAsk(root, r2.request);
  expect((await call("helper", "POST", "/v1/ask", { what: "Mom", why: "x" })).status).toBe(429);
  expect((await call("helper", "POST", "/v1/ask", { what: "", why: "x" })).status).toBe(400);
  await expect(askToSee(root, "gardener", { what: "Mom", why: "x" })).rejects.toThrow(/isn't turned on/);
  const p = join(root, "rules/policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace("helper: { tier: trial,", "helper: { tier: trial, status: paused,"));
  await expect(askStatus(root, "helper", r.request)).rejects.toThrow(/paused/);
});

// ---------- Auth0 Guardian through CIBA, against a fake AS ----------

let fake: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => { fake?.stop(true); fake = undefined; });

function fakeAuth0(outcome: { answer: "approve" | "deny" | "expire"; sub?: string; pending?: number }) {
  const seen: Record<string, string>[] = [];
  let polls = 0;
  fake = Bun.serve({ port: 0, async fetch(req) {
    const body = Object.fromEntries(new URLSearchParams(await req.text()));
    seen.push({ path: new URL(req.url).pathname, ...body });
    if (body.client_secret !== "s3cret") return Response.json({ error: "access_denied" }, { status: 401 });
    if (new URL(req.url).pathname === "/bc-authorize") return Response.json({ auth_req_id: "areq-1", expires_in: 300, interval: 5 });
    if (body.grant_type !== "urn:openid:params:grant-type:ciba" || body.auth_req_id !== "areq-1") return Response.json({ error: "invalid_grant" }, { status: 400 });
    if (polls++ < (outcome.pending ?? 1)) return Response.json({ error: "authorization_pending" }, { status: 400 });
    if (outcome.answer === "deny") return Response.json({ error: "access_denied" }, { status: 400 });
    if (outcome.answer === "expire") return Response.json({ error: "expired_token" }, { status: 400 });
    const idt = ["e30", Buffer.from(JSON.stringify({ sub: outcome.sub ?? "auth0|owner" })).toString("base64url"), "sig"].join(".");
    return Response.json({ access_token: "at", id_token: idt, token_type: "Bearer", expires_in: 60 });
  } });
  return { seen, url: `http://127.0.0.1:${fake.port}` };
}

function guardianSetup(as: { url: string }, extra = "") {
  const s = setup(`ask_to_see: { approver: guardian, never: [money]${extra}, guardian: { domain: "${as.url}", client_id: cid-1, user_id: "auth0|owner" } }`);
  const ap = () => guardianApprover(loadRules(s.root), s.root, { secret: "s3cret" });
  return { ...s, ap };
}

test("Guardian: the push names the agent and a code, never the note; the phone's approval releases one read", async () => {
  const as = fakeAuth0({ answer: "approve" });
  const { root, ap, call } = guardianSetup(as);
  const r = await askToSee(root, "helper", { what: "Mom's appointment", why: "book a taxi" }, ap());
  const start = as.seen.find((x) => x.path === "/bc-authorize")!;
  expect(start.binding_message).toMatch(/^helper wants to read a private person note once\. Code [A-Z2-9]{4}$/);
  expect(start.binding_message).not.toContain("Mom");
  expect(JSON.parse(start.login_hint)).toEqual({ format: "iss_sub", iss: `${as.url}/`, sub: "auth0|owner" });
  expect(start.scope).toBe("openid");
  expect((await askStatus(root, "helper", r.request, ap())).status).toBe("waiting"); // authorization_pending
  expect(await pollAsks(root, ap())).toBe(1); // the server's tick sees the approval
  const got = await askStatus(root, "helper", r.request, ap());
  expect(got.status).toBe("approved");
  expect(got.note).toContain("Cardiology");
  const a = listAsks(root).find((x) => x.id === r.request)!;
  expect(a.approved).toMatchObject({ via: "guardian", by: "auth0|owner", ref: "areq-1", note: "people/mom" });
  expect(readEntries(root).find((e) => e.op === "ask_read")).toMatchObject({ approved_via: "guardian", approval_ref: "areq-1" });
  expect((await call("helper", "GET", `/v1/ask/${r.request}`)).json.status).toBe("used");
});

test("Guardian: a denial, an expiry or an approval by someone else gives nothing", async () => {
  for (const [outcome, want] of [[{ answer: "deny" }, "not approved"], [{ answer: "expire" }, "not approved"], [{ answer: "approve", sub: "auth0|intruder" }, "not approved"]] as const) {
    const as = fakeAuth0({ ...outcome, pending: 0 });
    const { root, ap } = guardianSetup(as);
    const r = await askToSee(root, "helper", { what: "Mom's appointment", why: "x" }, ap());
    const got = await askStatus(root, "helper", r.request, ap());
    expect(got.status).toBe(want);
    expect(got.note).toBeUndefined();
    fake!.stop(true); fake = undefined;
  }
});

test("Guardian: nothing is sent for an ask with no match, and push_title puts only a clean title in", async () => {
  const as = fakeAuth0({ answer: "approve" });
  const { root, ap } = guardianSetup(as, ", push_title: true");
  await askToSee(root, "planner", { what: "zebra polo tournament", why: "x" }, ap());
  expect(as.seen).toEqual([]);
  const pol = join(root, "rules/policy.yaml");
  writeFileSync(pol, readFileSync(pol, "utf8").replace("helper: { tier: trial,", "helper: { tier: trial, label: claude.ai,"));
  await askToSee(root, "helper", { what: "Mom's appointment", why: "x" }, ap());
  expect(as.seen[0].binding_message).toMatch(/^claude\.ai \(helper\) wants to read Mom once\. Code /);
  expect(bindingMessage("helper", { code: "AB12", candidates: [{ id: "x", title: "Mom's café <b>rdv</b>", sensitivity: "private" }] }, true)).toBe("helper wants to read Moms cafe brdvb once. Code AB12");
});

test("Guardian not set up: the ask still works from the dashboard, and the owner sees why the phone wasn't reached", async () => {
  const { root, call } = setup("ask_to_see: { approver: guardian }");
  delete process.env.AUTH0_CIBA_CLIENT_SECRET;
  const r = (await call("helper", "POST", "/v1/ask", { what: "Mom's appointment", why: "x" })).json;
  const a = listAsks(root).find((x) => x.id === r.request)!;
  expect(a.push_error).toMatch(/client_id is not set/);
  const d = dashboardHandler(root, { port: 8788, loginKey: "k".repeat(32) });
  const H = "127.0.0.1:8788";
  const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const page = await (await d.handle(new Request(`http://${H}/overview`, { headers: { host: H, cookie } }))).text();
  expect(page).toContain("asks to see");
  expect(page).toContain("reach your phone: ask_to_see.guardian.client_id is not set");
  const csrf = page.match(/name="csrf" value="([^"]+)"/)![1];
  const res = await d.handle(new Request(`http://${H}/action/ask-approve`, { method: "POST", body: new URLSearchParams({ csrf, id: r.request, note: "people/mom" }), headers: { host: H, cookie, "content-type": "application/x-www-form-urlencoded", origin: `http://${H}` } }));
  expect(flashOf(res.headers.get("location") ?? "").ok).toContain("helper may read Mom once");
  expect((await call("helper", "GET", `/v1/ask/${r.request}`)).json.status).toBe("approved");
});

test("ask test: one push to the phone, reported plainly", async () => {
  const as = fakeAuth0({ answer: "approve" });
  const { root } = guardianSetup(as);
  expect(await testPush(root, { secret: "s3cret", every: 10 })).toBe("approved by auth0|owner: the phone path works");
  expect(as.seen[0].binding_message).toMatch(/^pocketBrain test\. Code [A-Z2-9]{4}$/);
  expect(listAsks(root)).toEqual([]);
  expect(await testPush(root, { secret: "wrong", every: 10 })).toMatch(/^not sent: Auth0 refused the push \(401/);
});

test("revoking an agent declines its waiting ask and voids an unused approval", async () => {
  const { root } = setup();
  const r1 = await askToSee(root, "helper", { what: "Mom's appointment", why: "x" });
  approveAsk(root, r1.request, "people/mom");
  const r2 = await askToSee(root, "helper", { what: "Mom's appointment", why: "again" });
  expect(cancelAsks(root, "helper")).toBe(2);
  const states = Object.fromEntries(listAsks(root).map((a) => [a.id, a.state]));
  expect(states).toEqual({ [r1.request]: "expired", [r2.request]: "declined" });
  expect(verifyChain(join(root, "log", "asks.jsonl")).broken).toBeUndefined();
});

// G244: invariant 13 says an approval comes only from the dashboard or CIBA. The CLI's `ask approve`
// was a shell-only widening (an agent with a shell could release a note to itself).
test("G244: ask approve from the terminal is refused; the dashboard approves", async () => {
  const { main } = await import("../src/cli");
  const { root } = setup();
  const r = await askToSee(root, "helper", { what: "Mom's appointment", why: "book a taxi" });
  const log = console.log, err = console.error;
  const out: string[] = [];
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); }; console.error = (...a: unknown[]) => { out.push(a.join(" ")); };
  let code: number;
  try { code = main(["ask", "approve", r.request, "--brain", root]); } finally { console.log = log; console.error = err; }
  expect(code).toBe(1);
  expect(out.join("\n")).toContain("dashboard");
  expect(listAsks(root).find((x) => x.id === r.request)?.state).toBe("waiting");
});
