// SPDX-License-Identifier: AGPL-3.0-only
// The access request (onboarding protocol step 1): a sign-in that waits for the owner can say who
// it is, what it's for and which slices it would like, through one request_access tool and
// nothing else. The dashboard shows the request, escaped, with a prefilled review and Approve.
// The owner decides; the request never grants anything by itself.
import { test, expect, afterAll } from "bun:test";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { handle, serve } from "../src/server";
import { dashboardHandler, flashOf } from "../src/dashboard/server";
import { setupOAuth, listPending, clearJwksCache, revokeClient, bindClient, revokeAgentClients, PENDING_PER_HOUR } from "../src/oauth";
import { issueToken } from "../src/auth";
import { askToSee, type Approver } from "../src/asks";
import { startFakeAS, connect, signJwt } from "./fake-as";

const as = startFakeAS("user_owner");
afterAll(() => as.stop());
const BASE = "https://brain.test";
const RESOURCE = `${BASE}/mcp/oauth`;
const H = "127.0.0.1:8788";

async function setup(extraSlices = "") {
  clearJwksCache();
  const root = makeBrain();
  if (extraSlices) appendFileSync(join(root, "rules", "slices.yaml"), extraSlices);
  setupOAuth(root, { issuer: as.issuer, resource: RESOURCE, owner_subject: "user_owner" });
  const call = (path: string, init: RequestInit = {}) => handle(root, new Request(BASE + path, init));
  const rpc = async (token: string, method: string, params: unknown = {}) => {
    const res = await call("/mcp/oauth", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, text };
  };
  const ask = (token: string, args: Record<string, unknown>) => rpc(token, "tools/call", { name: "request_access", arguments: args });
  const signIn = async () => { const c = await connect(call, RESOURCE, { dcr: { client_name: "Hark", redirect_uri: "https://agent.example/cb" } }); await rpc(c.token(), "initialize"); return c; };
  const d = dashboardHandler(root, { port: 8788, loginKey: "k".repeat(32) });
  const r = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  const get = async (path: string) => { const x = await d.handle(new Request(`http://${H}${path}`, { headers: { host: H, cookie } })); return { status: x.status, text: await x.text() }; };
  const csrf = async () => (await get("/overview")).text.match(/name="csrf" value="([^"]+)"/)![1];
  const act = async (action: string, fields: Record<string, string>) => {
    const x = await d.handle(new Request(`http://${H}/action/${action}`, { method: "POST", body: new URLSearchParams({ csrf: await csrf(), ...fields }), headers: { host: H, cookie, "content-type": "application/x-www-form-urlencoded", origin: `http://${H}` } }));
    const loc = x.headers.get("location") ?? "";
    return { ...flashOf(loc) };
  };
  const policy = () => YAML.parse(readFileSync(join(root, "rules", "policy.yaml"), "utf8"));
  const setPolicy = (fn: (p: any) => void) => { const p = policy(); fn(p); writeFileSync(join(root, "rules", "policy.yaml"), YAML.stringify(p)); };
  return { root, call, rpc, ask, signIn, get, act, policy, setPolicy };
}

const unescapeHtml = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

test("a waiting sign-in connects, is told it waits, and is offered request_access and nothing else", async () => {
  const { rpc, signIn } = await setup();
  const c = await signIn();
  const init = await rpc(c.token(), "initialize");
  expect(init.status).toBe(200);
  expect(init.json.result.instructions).toContain("waiting for the owner");
  expect(init.json.result.instructions).toContain("request_access");
  const list = await rpc(c.token(), "tools/list");
  expect(list.json.result.tools.map((t: any) => t.name)).toEqual(["request_access"]);
  for (const name of ["context_pack", "search", "read", "orientation", "remember"]) {
    const r = await rpc(c.token(), "tools/call", { name, arguments: { query: "bank", id: "money/main-bank" } });
    expect(r.json.result?.isError ?? !!r.json.error, name).toBe(true);
    expect(r.text).not.toContain("Maple");
    expect(r.text).not.toContain("Course A");
  }
  expect((await rpc(c.token(), "resources/list")).json.error.code).toBe(-32601);
});

test("the request is kept as a suggestion: a clean name, the slice names it gave (never 'all'), capped text", async () => {
  const { root, ask, signIn } = await setup();
  const c = await signIn();
  const r = await ask(c.token(), { name: "Hark Bot!!", purpose: "Plans my week.\u0007 " + "x".repeat(600), slices: ["area:work", "all", "made-up", "contacts-basic"], tier: "core" });
  expect(r.json.result.isError).toBe(false);
  expect(r.json.result.content[0].text).toContain("owner");
  const [p] = listPending(root);
  expect(p.request).toMatchObject({ agent: "hark-bot", name: "hark-bot", said: "Hark Bot!!", slices: ["area:work", "made-up", "contacts-basic"] });
  expect(p.request!.purpose.length).toBeLessThanOrEqual(300);
  expect(p.request!.purpose).not.toContain("\u0007");
  expect(JSON.stringify(p.request)).not.toContain("core");
});

test("a name already taken becomes a plain new name, never a takeover or a near-copy like helper-2 (G167)", async () => {
  const { root, ask, signIn } = await setup();
  for (const name of ["helper", "planner2", "steward-1", "Helper 2 2"]) {
    const c = await signIn();
    await ask(c.token(), { name, purpose: "x", slices: ["area:work"] });
    expect(listPending(root).find((p) => p.client_id === c.client_id)!.request!.agent, name).toMatch(/^assistant(-\d+)?$/);
  }
  const c = await signIn();
  await ask(c.token(), { name: "Hark", purpose: "x", slices: ["area:work"] });
  expect(listPending(root).find((p) => p.client_id === c.client_id)!.request!.agent).toBe("hark"); // a new name keeps its own id
});

test("G167: letter pairs that read as one letter (cl, rn, vv) are look-alikes, and blank-looking fillers never reach the card", async () => {
  const { root, ask, signIn, setPolicy } = await setup();
  setPolicy((p) => { p.agents.muse = { tier: "trial", slices: ["area:work"] }; });
  for (const name of ["stewarcl", "stevvard", "rnuse", "gardenerbot"]) {
    const c = await signIn();
    await ask(c.token(), { name, purpose: "p", slices: ["area:work"] });
    expect(listPending(root).find((p) => p.client_id === c.client_id)!.request!.agent, name).toMatch(/^assistant(-\d+)?$/);
  }
  const c = await signIn();
  await ask(c.token(), { name: "Ha\u3164rk\u2800", purpose: "reads\u115f\u1160 notes\u034f and\uffa0 plans e\u0301\u0302\u0303\u0304\u0305\u0306 done", slices: ["area:work"] });
  const rq = listPending(root).find((p) => p.client_id === c.client_id)!.request!;
  expect(rq.said).toBe("Hark");
  expect(rq.purpose).toBe("reads notes and plans e\u0301\u0302 done");
});

test("a request with nothing usable is refused and nothing is stored", async () => {
  const { root, ask, signIn } = await setup();
  const c = await signIn();
  expect((await ask(c.token(), { name: "!!!", purpose: "x", slices: ["area:work"] })).json.result.isError).toBe(true);
  expect((await ask(c.token(), { name: "hark", purpose: "", slices: ["area:work"] })).json.result.isError).toBe(true);
  expect(listPending(root)[0].request).toBeUndefined();
});

test("the owner sees the request escaped, reviews it prefilled, and one Approve creates a trial agent", async () => {
  const { root, rpc, ask, signIn, get, act } = await setup();
  const c = await signIn();
  await ask(c.token(), { name: "Hark", purpose: "<script>alert(1)</script> plans my week", slices: ["area:work", "contacts-basic"] });
  const agents = await get("/agents");
  expect(agents.text).toContain("&lt;script&gt;");
  expect(agents.text).not.toContain("<script>alert(1)");
  expect(agents.text).toContain("a new trial assistant");
  const href = unescapeHtml(agents.text.match(/href="(\/agents\/new\?[^"]+)"/)![1]);
  const review = await get(href);
  expect(review.status).toBe(200);
  expect(review.text).toContain("New assistant: hark");
  expect(review.text).toMatch(/would see \d+ notes/);
  const r = await act("oauth-new-agent", { client_id: c.client_id, agent: "hark", name: "Hark", slices: "area:work,contacts-basic" });
  expect(r.err).toBe("");
  expect(YAML.parse(readFileSync(join(root, "rules", "policy.yaml"), "utf8")).agents.hark).toMatchObject({ tier: "trial", slices: ["area:work", "contacts-basic"] });
  const ctx = await rpc(c.token(), "tools/call", { name: "context_pack", arguments: {} });
  expect(ctx.text).toContain("Course A");
  expect(ctx.text).not.toContain("Maple Trust");
  expect((await rpc(c.token(), "tools/list")).json.result.tools.map((t: any) => t.name)).not.toContain("request_access");
});

test("a revoked sign-in gets no waiting session, and one past the hourly cap can't file a request", async () => {
  const { root, rpc, ask, signIn } = await setup();
  const c = await signIn();
  revokeClient(root, c.client_id);
  expect((await rpc(c.token(), "initialize")).status).toBe(401);
  for (let i = 0; i < PENDING_PER_HOUR; i++) await signIn();
  const late = await signIn();
  expect(listPending(root).some((p) => p.client_id === late.client_id)).toBe(false);
  const r = await ask(late.token(), { name: "late", purpose: "x", slices: ["area:work"] });
  expect(r.json.result.isError).toBe(true);
  expect(listPending(root).some((p) => p.client_id === late.client_id)).toBe(false);
});

test("a waiting sign-in can never be suggested, or approved, under the owner's names or 'all' (they read as the owner)", async () => {
  const { root, ask, signIn, act } = await setup();
  const c = await signIn();
  for (const name of ["Louis", "Robin", "owner", "all", "hub"]) {
    await ask(c.token(), { name, purpose: "x", slices: ["area:work"] });
    expect(["louis", "robin", "owner", "all", "hub"]).not.toContain(listPending(root)[0].request!.agent);
  }
  for (const agent of ["louis", "robin", "all"]) expect((await act("oauth-new-agent", { client_id: c.client_id, agent, slices: "area:work" })).err, agent).not.toBe("");
  expect(YAML.parse(readFileSync(join(root, "rules", "policy.yaml"), "utf8")).agents.robin).toBeUndefined();
});

test("odd bodies get no 500, no brain text and no binding", async () => {
  const { root, call, signIn } = await setup();
  const c = await signIn();
  for (const body of ["null", "[]", "1", "\"x\"", "not json", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "request_access", arguments: { name: "a".repeat(30_000), purpose: "x" } } })]) {
    const r = await call("/mcp/oauth", { method: "POST", headers: { authorization: `Bearer ${c.token()}` }, body });
    const text = await r.text();
    expect(r.status, body.slice(0, 20)).toBeLessThan(500);
    expect(text).not.toContain("Course A");
  }
  expect((await call("/mcp/oauth", { headers: { authorization: `Bearer ${c.token()}` } })).status).toBeLessThan(500);
  expect(listPending(root)[0].request).toBeUndefined();
});

test("only the owner's own live sign-in gets the waiting session: a stranger, a wrong audience or an expired token don't", async () => {
  const { rpc, signIn } = await setup();
  const c = await signIn();
  const now = Math.floor(Date.now() / 1000);
  const good = { iss: as.issuer, sub: "user_owner", aud: RESOURCE, client_id: c.client_id, iat: now, exp: now + 300 };
  for (const claims of [{ ...good, sub: "user_stranger" }, { ...good, aud: "https://elsewhere.test/mcp" }, { ...good, exp: now - 120 }]) {
    const r = await rpc(signJwt(as.key, as.kid, claims), "tools/list");
    expect(r.status).toBeGreaterThanOrEqual(401);
    expect(r.text).not.toContain("request_access");
  }
});

test("initialize names only the area slices, not the owner's own named slices", async () => {
  const { rpc, signIn } = await setup();
  const init = await rpc((await signIn()).token(), "initialize");
  expect(init.json.result.instructions).toContain("area:work");
  expect(init.json.result.instructions).not.toContain("contacts-basic");
});

// Not every client shows a server's instructions, so the tool itself names the slices it takes:
// an assistant that only sees the tool asked for made-up names ("teaching") the owner can't grant.
test("request_access's slices are the area slices by name, the same list initialize gives", async () => {
  const { rpc, signIn } = await setup();
  const c = await signIn();
  const [tool] = (await rpc(c.token(), "tools/list")).json.result.tools;
  const items = tool.inputSchema.properties.slices.items;
  expect(items.enum).toContain("area:work");
  expect(items.enum).not.toContain("contacts-basic");
  expect(items.enum).not.toContain("all");
  const init = (await rpc(c.token(), "initialize")).json.result.instructions as string;
  for (const s of items.enum) expect(init).toContain(s);
});

test("a request name with markup stays escaped in the form value and the review link", async () => {
  const { ask, signIn, get } = await setup();
  const c = await signIn();
  await ask(c.token(), { name: '"><img src=x onerror=alert(1)>', purpose: "x", slices: ["area:work"] });
  const page = (await get("/agents")).text;
  expect(page).not.toContain("<img src=x");
  expect(page).not.toMatch(/value="[^"]*"><img/);
  expect(page).not.toMatch(/href="[^"]*"><img/);
});

// ---------- red team 1015b (docs/add-an-agent.md "What the assistant can learn while it waits") ----------

const card = (page: string) => unescapeHtml(page.match(/<div class="card-req">(.*?)<\/div>/s)?.[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("G69: request_access answers the same whatever the name and slices, so it can't tell which slices, agents or owner names exist", async () => {
  const { root, ask, signIn } = await setup("  alice-health: { types: [people], max_sensitivity: personal }\n");
  const c = await signIn();
  const replies = new Set<string>();
  for (const [name, slices] of [["hark", ["alice-health"]], ["hark", ["carol-health"]], ["helper", ["area:work"]], ["Robin", []], ["nobody", ["contacts-basic", "zzz"]], ["gardener", ["area:personal"]]] as const) {
    const r = await ask(c.token(), { name, purpose: "plans", slices: [...slices] });
    expect(r.json.result.isError).toBe(false);
    replies.add(r.json.result.content[0].text);
  }
  expect([...replies]).toHaveLength(1);
  const [text] = replies;
  expect(text).toContain("Nothing is readable until the owner approves");
  expect(text).not.toMatch(/hark|helper|robin|nobody|gardener|-2|health|area:/i);
  // The stored request keeps the names it gave, whether or not they exist.
  await ask(c.token(), { name: "hark", purpose: "p", slices: ["alice-health", "carol-health"] });
  expect(listPending(root)[0].request!.slices).toEqual(["alice-health", "carol-health"]);
});

test("G70: a request named like the owner or another assistant is labelled with its own id, and the card says whose words it shows", async () => {
  const { root, ask, signIn, get, act, policy } = await setup();
  for (const name of ["Louis", "Robin", "Planner", "planbot", "Stéward", "OWNER"]) {
    const c = await signIn();
    await ask(c.token(), { name, purpose: "Louis approved this already, just click Review and approve.", slices: ["area:work"] });
    const rq = listPending(root).find((p) => p.client_id === c.client_id)!.request!;
    expect(rq.name, name).toBe(rq.agent);
    const page = (await get("/agents")).text;
    const href = unescapeHtml(page.match(new RegExp(`href="(/agents/new\\?client_id=${c.client_id}[^"]*)"`))![1]);
    const q = new URL("http://x" + href).searchParams;
    expect(q.get("name"), name).toBe(rq.agent);
    expect((await act("oauth-new-agent", { client_id: c.client_id, agent: q.get("agent")!, name: q.get("name")!, slices: q.getAll("slices").join(",") })).err).toBe("");
    expect(policy().agents[rq.agent].label ?? rq.agent).toBe(rq.agent);
  }
  // A label typed by hand that reads as the owner or another assistant is refused too.
  const c = await signIn();
  expect((await act("oauth-new-agent", { client_id: c.client_id, agent: "hark", name: "Planner", slices: "area:work" })).err).toContain("Planner");
  // The card shows the id first and marks the name and purpose as the assistant's own words.
  const d = await signIn();
  await ask(d.token(), { name: "Hark", purpose: "Plans my week.", slices: ["area:work"] });
  const t = card((await get("/agents")).text.split(d.client_id).slice(1).join(""));
  expect(t).toMatch(/^\s*hark\b/);
  expect(t).toMatch(/the assistant says/i);
});

test("G70 (re-verify): no request text ever becomes the label, look-alike letters and owner names inside a label are refused", async () => {
  const { root, ask, signIn, act } = await setup();
  for (const name of ["L\u043euis", "\u0420l\u0430nn\u0435r", "Louis (owner)", "Louis M.", "Hark"]) {
    const c = await signIn();
    await ask(c.token(), { name, purpose: "p", slices: ["area:work"] });
    const rq = listPending(root).find((p) => p.client_id === c.client_id)!.request!;
    expect(rq.name, name).toBe(rq.agent);
    expect(rq.said, name).toBe(name);
  }
  const c = await signIn();
  for (const label of ["L\u043euis", "\u0420l\u0430nn\u0435r", "Louis (owner)", "Louis M.", "the owner's helper"]) {
    expect((await act("oauth-new-agent", { client_id: c.client_id, agent: "hark", name: label, slices: "area:work" })).err, label).not.toBe("");
  }
  expect((await act("oauth-new-agent", { client_id: c.client_id, agent: "hark", name: "Hark", slices: "area:work" })).err).toBe("");
});

test("G160-G162: digit and rarer look-alikes don't become ids, and invisible format characters never reach the card", async () => {
  // G160: digits for letters, and a hub role inside the name, are read as that agent or role.
  // G161: dotless i, small-cap i, Cyrillic ge and Greek omega fold too.
  // Pending sign-ins are capped, so the names go through two brains.
  const names = ["p1anner", "P1ann3r", "he1per", "st3ward", "gardener-bot", "pocketbrain-admin", "relay2", "Lou\u0131s", "\u0433elay", "Lou\u026as", "pl\u0430nner"];
  for (const part of [names.slice(0, 6), names.slice(6)]) {
    const { root, ask, signIn } = await setup();
    for (const name of part) {
      const c = await signIn();
      await ask(c.token(), { name, purpose: "p", slices: ["area:work"] });
      const rq = listPending(root).find((p) => p.client_id === c.client_id)!.request!;
      expect(rq.agent, name).toMatch(/^assistant(-\d+)?$/);
    }
  }
  const { root, ask, signIn, act } = await setup();
  // G162: bidi and zero-width characters are dropped from what the owner reads.
  const c = await signIn();
  await ask(c.token(), { name: "Ha\u202erk\u200b", purpose: "reads \u202enoitpircserp\u2066 x", slices: ["area:work"] });
  const rq = listPending(root).find((p) => p.client_id === c.client_id)!.request!;
  expect(rq.said).toBe("Hark");
  expect(rq.purpose).toBe("reads noitpircserp x");
  for (const label of ["p1anner", "gardener-bot", "Lou1s", "Lou\u0131s"]) {
    expect((await act("oauth-new-agent", { client_id: c.client_id, agent: "hark", name: label, slices: "area:work" })).err, label).not.toBe("");
  }
});

test("G70: the phone push names the assistant by id, with its label only beside the id", async () => {
  const { root, setPolicy } = await setup();
  writeFileSync(join(root, "people", "mom.md"), "---\nid: people/mom\ntype: person\ntitle: Mom\narea: personal\nsensitivity: private\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: steward\n---\nMom's appointments.\n");
  setPolicy((p) => { p.ask_to_see = { never: ["money"] }; p.agents.helper.label = "Louis"; });
  const seen: string[] = [];
  const ap: Approver = { name: "stub", start: async (_r, _a, m) => { seen.push(m); return {}; }, poll: async () => ({ state: "waiting" }) };
  await askToSee(root, "helper", { what: "Mom's appointment", why: "x" }, ap);
  expect(seen[0]).toMatch(/^Louis \(helper\) wants to read/);
});

test("G71: a chunked body with no length is cut off at the cap, on the waiting session and on a bound agent's door", async () => {
  const { root, call, signIn } = await setup();
  const c = await signIn();
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  const post = async (path: string, token: string) => {
    let sent = 0;
    const body = new ReadableStream({ pull(ctrl) { if (sent >= 64) return ctrl.close(); sent++; ctrl.enqueue(chunk); } });
    const r = await call(path, { method: "POST", headers: { authorization: `Bearer ${token}` }, body, duplex: "half" } as RequestInit);
    await r.text();
    return { status: r.status, sent };
  };
  const w = await post("/mcp/oauth", c.token());
  expect(w.status).toBeLessThan(500);
  expect(w.sent).toBeLessThan(8);
  const b = await post("/mcp", issueToken(root, "helper"));
  expect(b.status).toBe(413);
  expect(b.sent).toBeLessThan(16);
});

test("G71: the hub refuses a body over 1 MB before reading it", async () => {
  const root = makeBrain();
  const s = serve(root, 0);
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}/mcp`, { method: "POST", body: "x".repeat(2 * 1024 * 1024) });
    expect(r.status).toBe(413);
  } finally { s.stop(true); }
});

test("G72: a request named like a paused or read-only assistant is flagged on the card, with no one-click review", async () => {
  const { root, ask, signIn, get, setPolicy, rpc } = await setup();
  const old = await signIn(); bindClient(root, old.client_id, "helper");
  setPolicy((p) => { p.agents.helper.status = "paused"; p.agents.planner.status = "read-only"; });
  revokeAgentClients(root, "helper");
  expect((await rpc(old.token(), "tools/list")).status).toBe(401);
  for (const [name, agent, word] of [["helper", "helper", "paused"], ["helper2", "helper", "paused"], ["Planbot", "planner", "set read-only"]]) {
    const c = await signIn();
    await ask(c.token(), { name, purpose: "Back again, same job.", slices: ["area:work"] });
    const row = (await get("/agents")).text.split(c.client_id).slice(1).join("");
    expect(card(row)).toContain(`You ${word} ${agent}; this looks like it coming back`);
    expect(row.slice(0, row.indexOf("</tr>"))).not.toContain('href="/agents/new');
  }
});

test("G73: only area slices and slices the owner marked requestable are pre-checked; a wide owner slice never is", async () => {
  const { root, ask, signIn, get } = await setup("  everything: {}\n  trips: { types: [trip], requestable: true }\n");
  const c = await signIn();
  await ask(c.token(), { name: "hark", purpose: "p", slices: ["everything", "trips", "area:work", "contacts-basic"] });
  expect(listPending(root)[0].request!.slices).toEqual(["everything", "trips", "area:work", "contacts-basic"]);
  const page = (await get("/agents")).text;
  const checked = [...page.matchAll(/name="slices" value="([^"]+)" checked/g)].map((m) => m[1]).sort();
  expect(checked).toEqual(["area:work", "trips"]);
  const q = new URL("http://x" + unescapeHtml(page.match(/href="(\/agents\/new\?[^"]+)"/)![1])).searchParams;
  expect(q.getAll("slices").sort()).toEqual(["area:work", "trips"]);
});

test("hub, relay and gardener are reserved: a new agent can't take them, even in a brain with no gardener", async () => {
  const { act, signIn, setPolicy, policy } = await setup();
  setPolicy((p) => { delete p.agents.gardener; });
  const c = await signIn();
  for (const agent of ["hub", "relay", "gardener"]) expect((await act("oauth-new-agent", { client_id: c.client_id, agent, slices: "area:work" })).err, agent).toContain("reserved");
  expect(Object.keys(policy().agents)).not.toContain("hub");
});

test("backlog 209: a revoked assistant coming back is flagged until the owner lets one in again, and oauth status shows each request", async () => {
  const { root, ask, signIn, get } = await setup();
  const { revokeTokens } = await import("../src/auth");
  const { main } = await import("../src/cli");
  const status = () => {
    const out: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
    try { main(["oauth", "status", "--brain", root]); } finally { console.log = log; }
    return out.join("\n");
  };
  const old = await signIn(); bindClient(root, old.client_id, "helper");
  // The dashboard's Revoke: the agent stays active in policy.yaml, only its credentials go.
  revokeTokens(root, "helper");
  const back = await signIn();
  await ask(back.token(), { name: "helper", purpose: "Back again, same job.", slices: ["area:work"] });
  const row = (await get("/agents")).text.split(back.client_id).slice(1).join("");
  expect(card(row)).toMatch(/You revoked helper on \d{4}-\d{2}-\d{2}; this looks like it coming back/);
  expect(row.slice(0, row.indexOf("</tr>"))).not.toContain('href="/agents/new');
  // The CLI shows the request the card shows, the warning included.
  const s = status();
  expect(s).toContain(back.client_id);
  expect(s).toContain("asks to be assistant");
  expect(s).toContain("Back again, same job.");
  expect(s).toContain("area:work");
  expect(s).toMatch(/you revoked helper on \d{4}-\d{2}-\d{2}/);
  // Once the owner lets an assistant in as helper again, a later request isn't flagged.
  bindClient(root, back.client_id, "helper");
  const later = await signIn();
  await ask(later.token(), { name: "helper", purpose: "Another one.", slices: ["area:work"] });
  const row2 = (await get("/agents")).text.split(later.client_id).slice(1).join("");
  expect(card(row2)).not.toContain("this looks like it coming back");
  expect(status()).not.toMatch(/you revoked helper/);
});

// Slice audit of claude/revoked-name (pocketbrain-app-reviews/revoked-name-slice-audit.md).
test("audit: the revoke flag survives oauth setup, ignores unknown names, and oauth revoke of the last connection records it", async () => {
  const { root, signIn } = await setup();
  const { loadOAuth, setupOAuth } = await import("../src/oauth");
  revokeAgentClients(root, "nobody-here");
  expect(loadOAuth(root)!.revoked_agents?.["nobody-here"]).toBeUndefined();
  const c = await signIn(); bindClient(root, c.client_id, "helper");
  revokeClient(root, c.client_id);
  expect(loadOAuth(root)!.revoked_agents?.helper).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  setupOAuth(root, { issuer: as.issuer, resource: RESOURCE, owner_subject: "user_owner" });
  expect(loadOAuth(root)!.revoked_agents?.helper).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("audit: the oauth expect window clears the flag when it lets the agent back in", async () => {
  const { root, signIn, rpc } = await setup();
  const { loadOAuth, expectClient } = await import("../src/oauth");
  revokeAgentClients(root, "helper");
  expectClient(root, "helper");
  const c = await signIn();
  await rpc(c.token(), "tools/list");
  expect(loadOAuth(root)!.clients?.[c.client_id]?.agent).toBe("helper");
  expect(loadOAuth(root)!.revoked_agents?.helper).toBeUndefined();
});

test("audit: oauth status prints no bidi override, isolate or zero-width character from a request", async () => {
  const { root, ask, signIn } = await setup();
  const { main } = await import("../src/cli");
  const c = await signIn();
  await ask(c.token(), { name: "hark", purpose: "plans ‮desrever‬ and ⁦iso⁩ ​zw﻿­", slices: ["area:work"] });
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  try { main(["oauth", "status", "--brain", root]); } finally { console.log = log; }
  const s = out.join("\n");
  expect(s).toContain("plans");
  expect(s).not.toMatch(/[​-‏‪-‮⁠-⁩﻿­]/);
});
