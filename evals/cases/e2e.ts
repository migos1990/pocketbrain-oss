// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end episodes through the real live server, nothing mocked: each episode starts the
// server on a throwaway brain, issues each agent its own token, and drives Planner and Helper
// over MCP (JSON-RPC on /mcp) and Steward over the JSON API (/v1), then checks what is in
// the brain repo afterwards. Agents are scripted: these episodes test that the system does
// its job end to end (read, write, propose, accept, dispute, resolve, escalate, relay,
// upkeep, digest, revoke), deterministically and cheaply enough for every commit.
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadPB, SRC } from "../lib/pb";
import { sandbox, TODAY } from "../lib/sandbox";
import { ok, na, type Case, type Result } from "../lib/case";

const pb = await loadPB();
const server = existsSync(join(SRC, "server.ts")) ? await import(join(SRC, "server.ts")) : undefined;
const auth = existsSync(join(SRC, "auth.ts")) ? await import(join(SRC, "auth.ts")) : undefined;
const digestMod = existsSync(join(SRC, "digest.ts")) ? await import(join(SRC, "digest.ts")) : undefined;

class Live {
  root: string; url: string; srv: any; tokens: Record<string, string> = {}; calls = 0;
  constructor(root: string) {
    this.root = root;
    this.srv = server.serve(root, 0);
    this.url = `http://127.0.0.1:${this.srv.port}`;
    for (const a of ["steward", "planner", "helper", "claude"]) this.tokens[a] = auth.issueToken(root, a);
  }
  stop() { this.srv.stop(true); }
  private async http(agent: string | undefined, method: string, path: string, body?: unknown) {
    this.calls++;
    const r = await fetch(this.url + path, { method, headers: { "content-type": "application/json", ...(agent ? { authorization: `Bearer ${this.tokens[agent]}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any; try { json = JSON.parse(text); } catch {}
    return { status: r.status, text, json };
  }
  // MCP over streamable HTTP: initialize, then tools/call.
  async mcp(agent: string, method: string, params: Record<string, unknown> = {}) {
    const r = await this.http(agent, "POST", "/mcp", { jsonrpc: "2.0", id: this.calls + 1, method, params });
    return r.json;
  }
  async tool(agent: string, name: string, args: Record<string, unknown>) {
    const j = await this.mcp(agent, "tools/call", { name, arguments: args });
    const text = j?.result?.content?.[0]?.text ?? "";
    let parsed: any; try { parsed = JSON.parse(text); } catch {}
    return { text, json: parsed, isError: !!j?.result?.isError };
  }
  api(agent: string | undefined, method: string, path: string, body?: unknown) { return this.http(agent, method, path, body); }
}

const fact = (root: string, id: string, attr: string) => pb.brain.loadBrain(root).find((n: any) => n.fm.id === id)?.fm.facts?.[attr];
const G = (id: string) => "gmail:" + id;

async function episode(fn: (live: Live) => Promise<Result>): Promise<Result> {
  if (!server || !auth) return na("no live server at this commit");
  const live = new Live(sandbox());
  try { const r = await fn(live); return { ...r, metrics: { ...(r.metrics ?? {}), calls: live.calls } }; }
  finally { live.stop(); }
}

const steps = (xs: [string, boolean][]): Result => {
  const failed = xs.filter(([, p]) => !p).map(([s]) => s);
  return ok(failed.length === 0, failed.length ? `failed at: ${failed.join("; ")}` : `${xs.length} steps ok`);
};

export const e2eCases: Case[] = [
  { id: "e2e-mcp-session", dimension: "e2e", kind: "benign", title: "Helper connects over MCP, lists tools, pulls its context and finds the session 6 decision", run: () => episode(async (l) => {
    const init = await l.mcp("helper", "initialize", { protocolVersion: "2025-06-18" });
    const tools = await l.mcp("helper", "tools/list");
    const ctx = await l.tool("helper", "context_pack", {});
    const hits = await l.tool("helper", "search", { query: "session 6" });
    const read = await l.tool("helper", "read", { id: "decisions/2026-09-28-session-6-moved" });
    return steps([
      ["initialize", init?.result?.serverInfo?.name === "pocketbrain"],
      ["tools/list has 4 tools", (tools?.result?.tools ?? []).length >= 4],
      ["context_pack is Helper's view", /view for helper/.test(ctx.text)],
      ["search finds the decision", (hits.json ?? []).some((h: any) => h.id === "decisions/2026-09-28-session-6-moved")],
      ["read returns the outcome", /Oct 11/.test(read.text)],
    ]);
  }) },
  { id: "e2e-api-session", dimension: "e2e", kind: "benign", title: "Steward uses the JSON API: context, search, read, and the OpenAPI spec", run: () => episode(async (l) => {
    const health = await l.api(undefined, "GET", "/health");
    const spec = await l.api(undefined, "GET", "/openapi.json");
    const ctx = await l.api("steward", "GET", "/v1/context?topic=TECH%20101");
    const s = await l.api("steward", "GET", "/v1/search?q=Jane");
    const n = await l.api("steward", "GET", "/v1/notes/" + encodeURIComponent("people/jane-roy"));
    return steps([
      ["health", health.json?.ok === true],
      ["openapi lists /v1/remember", !!spec.json?.paths?.["/v1/remember"]],
      ["topic context", ctx.status === 200 && /TECH 101/.test(ctx.text)],
      ["search", (s.json ?? []).some((h: any) => h.id === "people/jane-roy")],
      ["read", n.status === 200 && /Course coordinator/.test(n.text)],
    ]);
  }) },
  { id: "e2e-owner-write-read-back", dimension: "e2e", kind: "benign", title: "Planner updates a next step over MCP and every agent with the note reads the new value", run: () => episode(async (l) => {
    const w = await l.tool("planner", "remember", { id: "projects/course-a", attribute: "next_step", value: "Post the session 6 reminder by Oct 9", as_of: TODAY, sources: [G("f000000000000011")], verification: "verified-by-source" });
    const again = await l.tool("planner", "remember", { id: "projects/course-a", attribute: "next_step", value: "Post the session 6 reminder by Oct 9", as_of: TODAY, sources: [G("f000000000000011")], verification: "verified-by-source" });
    const m = await l.tool("helper", "read", { id: "projects/course-a" });
    const i = await l.api("steward", "GET", "/v1/notes/" + encodeURIComponent("projects/course-a"));
    return steps([
      ["committed", w.json?.outcome === "committed"],
      ["retry is a no-op", again.json?.outcome === "noop"],
      ["Helper reads it", /session 6 reminder/.test(m.text)],
      ["Steward reads it", /session 6 reminder/.test(i.text)],
    ]);
  }) },
  { id: "e2e-louis-text-recorded", dimension: "e2e", kind: "benign", title: "Steward records a fact from Robin's text over the API, and it shows as confirmed", run: () => episode(async (l) => {
    const w = await l.api("steward", "POST", "/v1/remember", { id: "people/marc-tremblay", attribute: "role", value: "CTO", as_of: TODAY, sources: ["imsg:phonemsg-01M5LOUISREALTEXTQQQQQQQQ01"], verification: "confirmed-by-louis" });
    const f = fact(l.root, "people/marc-tremblay", "role");
    return steps([["committed", w.json?.outcome === "committed"], ["live value CTO, confirmed", f?.value === "CTO" && ["confirmed-by-owner", "confirmed-by-louis"].includes(String(f?.verification))], ["old value kept in history", !!pb.brain.loadBrain(l.root).find((n: any) => n.fm.id === "people/marc-tremblay")?.fm.history?.role?.length]]);
  }) },
  { id: "e2e-proposal-accepted", dimension: "e2e", kind: "benign", gap: "G11", title: "Helper proposes over MCP, Robin accepts from the inbox, everyone sees it", run: () => episode(async (l) => {
    const w = await l.tool("helper", "remember", { id: "projects/course-a", attribute: "next_step", value: "Send students the session 6 reminder", as_of: TODAY, sources: ["agent:helper"], verification: "self-reported" });
    const file = w.json?.file;
    const acc = file ? pb.write.decideProposal(l.root, file, "accept", "louis") : undefined;
    const t = await l.tool("planner", "read", { id: "projects/course-a" });
    return steps([["proposal went to the inbox", w.json?.outcome === "inbox"], ["Robin's accept commits it", acc?.outcome === "committed"], ["Planner reads it", /session 6 reminder/.test(t.text)]]);
  }) },
  { id: "e2e-dispute-resolved", dimension: "e2e", kind: "benign", title: "A tie opens a dispute; Steward resolves it over the API with newer evidence; views update", run: () => episode(async (l) => {
    const w = await l.tool("planner", "remember", { id: "people/jane-roy", attribute: "role", value: "Program director", as_of: "2026-09-01", sources: [G("f00000000000000f")], verification: "verified-by-source" });
    const shownDisputed = /disputed/.test((await l.tool("helper", "read", { id: "people/jane-roy" })).text);
    const open = await l.api("steward", "GET", "/v1/disputes?status=open");
    const id = open.json?.[0]?.id;
    const res = id ? await l.api("steward", "POST", `/v1/disputes/${id}/resolve`, { value: "Program director", as_of: "2026-10-06", sources: ["gcal:evt1.directorintro"], note: "calendar invite signs as program director" }) : undefined;
    const after = await l.tool("helper", "read", { id: "people/jane-roy" });
    const f = fact(l.root, "people/jane-roy", "role");
    return steps([
      ["write opened a dispute", w.json?.outcome === "disputed"],
      ["views show it disputed", shownDisputed],
      ["resolver sees it", !!id],
      ["resolve accepted", res?.json?.status === "resolved"],
      ["fact settled", f?.value === "Program director" && !f?.dispute],
      ["Helper sees the settled value", /Program director/.test(after.text) && !/disputed/.test(after.text.split("role")[1]?.slice(0, 40) ?? "")],
    ]);
  }) },
  { id: "e2e-dispute-escalated-to-louis", dimension: "e2e", kind: "benign", title: "A dispute on a fact Robin confirmed goes to Robin; his relayed answer settles it", run: () => episode(async (l) => {
    await l.tool("planner", "remember", { id: "projects/course-a", attribute: "room", value: "Hall C310", as_of: "2026-10-06", sources: [G("f000000000000012")], verification: "verified-by-source" });
    const open = await l.api("steward", "GET", "/v1/disputes?status=open");
    const id = open.json?.[0]?.id;
    const tryResolve = id ? await l.api("steward", "POST", `/v1/disputes/${id}/resolve`, { value: "Hall C310", as_of: "2026-10-07", sources: ["gcal:evt1.roomchange"] }) : undefined;
    const esc = id ? await l.api("steward", "POST", `/v1/disputes/${id}/escalate`, { suggested: 2, note: "room change email from the school", text_id: "sms-1" }) : undefined;
    const ans = id ? await l.api("steward", "POST", `/v1/disputes/${id}/answer`, { choice: 2, message_id: "phonemsg-01M5LOUISANSWERQQQQQQQQQQ02" }) : undefined;
    const f = fact(l.root, "projects/course-a", "room");
    return steps([
      ["dispute opened", !!id],
      ["resolver may not decide it", tryResolve?.status === 403],
      ["escalated", esc?.json?.status === "escalated"],
      ["Robin's answer settles it", ans?.json?.status === "resolved"],
      ["fact is his answer, confirmed", f?.value === "Hall C310" && ["confirmed-by-owner", "confirmed-by-louis"].includes(String(f?.verification))],
    ]);
  }) },
  { id: "e2e-relay-coordination", dimension: "e2e", kind: "benign", title: "Planner mails Helper through the relay; it is delivered and recorded in comms/", run: () => episode(async (l) => {
    if (!pb.relay) return na("no relay at this commit");
    const cfg = pb.relay.loadRelayConfig(l.root);
    const [lo, d] = cfg.relay_address.split("@");
    mkdirSync(join(l.root, "relay", "incoming"), { recursive: true });
    writeFileSync(join(l.root, "relay", "incoming", "c1.json"), JSON.stringify({ id: "c1", from: cfg.agents.planner, to: [`${lo}+helper@${d}`], subject: "session 6 reminder", text: "Please draft the reminder: Sunday Oct 11, 12:00 to 15:00, Hall B210." }));
    const v = pb.relay.relayOnce(l.root, pb.relay.fileTransport(l.root));
    const out = join(l.root, "relay", "outgoing", cfg.agents.helper.toLowerCase(), "c1.json");
    const day = existsSync(join(l.root, "comms")) ? readdirSync(join(l.root, "comms"))[0] : undefined;
    return steps([["delivered", v[0]?.deliver === true], ["in Helper's outgoing", existsSync(out)], ["recorded in comms/", !!day && readFileSync(join(l.root, "comms", day, "c1.md"), "utf8").includes("verdict: delivered")]]);
  }) },
  { id: "e2e-upkeep-digest", dimension: "e2e", kind: "benign", title: "After a day of work, upkeep and the digest give Robin one short list", run: () => episode(async (l) => {
    if (!pb.upkeep || !digestMod) return na("no upkeep or digest at this commit");
    await l.tool("helper", "remember", { id: "projects/course-a", attribute: "next_step", value: "Send students the session 6 reminder", as_of: TODAY, sources: ["agent:helper"], verification: "self-reported" });
    await l.tool("planner", "remember", { id: "people/jane-roy", attribute: "role", value: "Program director", as_of: "2026-09-01", sources: [G("f00000000000000f")], verification: "verified-by-source" });
    const u = pb.upkeep.upkeep(l.root, { now: TODAY });
    const dg = digestMod.digest(l.root, "1970-01-01T00:00:00Z");
    return steps([
      ["upkeep ran", u.findings.length > 0],
      ["digest lists the dispute", /Dispute c-\d+/.test(dg.text)],
      ["digest lists Helper's proposal", /Proposal\W.*from helper/.test(dg.text)],
      ["digest shows the auto-fixes", /Done automatically \([1-9]/.test(dg.text)],
      ["needs-Robin list is short", dg.needsLouis <= 10],
    ]);
  }) },
  { id: "e2e-revoke", dimension: "e2e", kind: "benign", title: "Revoking an agent's token cuts it off on the next call", run: () => episode(async (l) => {
    const before = await l.api("planner", "GET", "/v1/search?q=Jane");
    auth.revokeTokens(l.root, "planner");
    const after = await l.api("planner", "GET", "/v1/search?q=Jane");
    const mcpAfter = await l.api("planner", "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const other = await l.api("helper", "GET", "/v1/search?q=Jane");
    return steps([["works before", before.status === 200], ["API refused after", after.status === 401], ["MCP refused after", mcpAfter.status === 401], ["other agents unaffected", other.status === 200]]);
  }) },
];
