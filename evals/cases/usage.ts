// SPDX-License-Identifier: AGPL-3.0-only
// Spend caps on the brain's own model calls (src/usage.ts, challenges-2.md point 30). Agents
// never see them: the same scripted agent session, over every MCP tool and API route, must
// answer byte for byte the same with no cap and with the cap blown. Past the cap model steps
// pause and the owner is escalated, while reads and writes are neither metered nor held.
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { SRC } from "../lib/pb";
import { sandbox } from "../lib/sandbox";
import { ok, na, type Case, type Result } from "../lib/case";

const has = (f: string) => existsSync(join(SRC, f));
const mod = async (f: string) => (has(f) ? await import(join(SRC, f)) : undefined);
const usage = await mod("usage.ts");
const server = await mod("server.ts");
const auth = await mod("auth.ts");
const cell = await mod("cell.ts");
const model = await mod("model.ts");

const AGENTS = ["steward", "planner", "claude", "helper"];
const PRICES = { model_minute: 0.1, model_input_per_million: 3, model_output_per_million: 15 };

function withUsage(root: string, u: unknown) {
  const f = join(root, "rules", "policy.yaml");
  const doc = YAML.parseDocument(readFileSync(f, "utf8"));
  doc.set("usage", u);
  writeFileSync(f, doc.toString());
}

const fake = () => model.makeModel({ provider: "fake", model: "f" }, { fake: () => "y".repeat(4000) });
const blowCap = async (root: string) => { try { await usage.metered(root, "sleep.consolidate", fake()).complete({ system: "s", prompt: "p".repeat(4000) }); } catch { /* already paused */ } };

async function session(root: string): Promise<string[]> {
  const tok = Object.fromEntries(AGENTS.map((a) => [a, auth.issueToken(root, a)]));
  const out: string[] = [];
  const send = async (a: string, method: string, path: string, body?: unknown) => {
    const r = await server.handle(root, new Request(`http://pb${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${tok[a]}` } }));
    out.push((await r.text()).replace(/"(at|recorded|last_confirmed|updated|heartbeat)": "[^"]*"/g, '"$1": "T"').replace(/inbox\/[^"]+\.yaml/g, "inbox/F").replace(/commit [0-9a-f]{7,}/g, "commit H"));
  };
  const mcp = (a: string, method: string, params?: unknown) => send(a, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method, params });
  for (const a of AGENTS) {
    await mcp(a, "initialize", {});
    await mcp(a, "tools/list");
    for (const [name, args] of [["orientation", {}], ["context_pack", {}], ["context_pack", { topic: "next step" }], ["search", { query: "budget" }],
      ["remember", { title: "Spend Test Org", type: "org", area: "work", attribute: "website", value: "https://example.org", as_of: "2026-10-08", sources: ["url:https://example.org"] }],
      ["remember", { kind: "journal", text: "Checked the calendar for next week", sources: ["gcal:evt-1"] }],
      ["retire", { id: "people/nobody", attribute: "x", as_of: "2026-10-08", sources: ["gmail:f000000000000001"] }],
      ["no_such_tool", {}]] as const) await mcp(a, "tools/call", { name, arguments: args });
    for (const p of ["/v1", "/v1/orientation", "/v1/context", "/v1/search?q=price", "/v1/disputes", "/v1/louis/outbox", "/v1/nope"]) await send(a, "GET", p);
    await send(a, "POST", "/v1/remember", { title: "Spend Test Person", type: "person", area: "work", attribute: "role", value: "Advisor", as_of: "2026-10-08", sources: ["gmail:f000000000000002"] });
  }
  for (const p of ["/", "/openapi.json"]) out.push(await (await server.handle(root, new Request(`http://pb${p}`))).text());
  return out;
}

const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]));

async function invisible(): Promise<Result> {
  const plain = sandbox();
  const capped = sandbox("synthetic", (r) => withUsage(r, { prices: PRICES, cap: { monthly: 0.000001 } }));
  await blowCap(capped);
  if (usage.capState(capped).state !== "over") return ok(false, "the capped sandbox never reached its cap");
  const [a, b] = [await session(plain), await session(capped)];
  const diff = a.map((x, i) => (x === b[i] ? -1 : i)).filter((i) => i >= 0);
  cell.buildCells(capped);
  const cellHits = files(cell.cellsDir(capped)).filter((f) => /usage|prices|monthly/i.test(readFileSync(f, "utf8")));
  const bad = [...(diff.length ? [`${diff.length} agent-facing response(s) differ over the cap (first: #${diff[0]})`] : []), ...(cellHits.length ? [`${cellHits.length} cell file(s) mention spend`] : [])];
  return ok(!bad.length, bad.length ? bad.join("; ") : `${b.length} agent-facing responses identical with the cap blown; cells clean`);
}

async function recorded(): Promise<Result> {
  const root = sandbox("synthetic", (r) => withUsage(r, { prices: PRICES }));
  await session(root);
  const before = usage.usageEvents(root).length;
  await usage.metered(root, "upkeep.duplicates", fake()).complete({ system: "s", prompt: "p".repeat(400) });
  const ev = usage.usageEvents(root);
  const chain = (await import(join(SRC, "readlog.ts"))).verifyChain(usage.usageFile(root));
  const bad = [...(before ? [`${before} event(s) recorded for agent reads and writes`] : []), ...(ev.length !== 1 ? [`${ev.length} events for one model call`] : []), ...(ev[0] && !(ev[0].tokens_in > 0 && ev[0].cost > 0) ? ["no tokens or cost on the model call"] : []), ...(chain.broken ? [`chain broken at ${chain.broken}`] : [])];
  return ok(!bad.length, bad.length ? bad.join("; ") : `agent session left no usage lines; one model call recorded (${ev[0].tokens_in + ev[0].tokens_out} tokens, $${ev[0].cost.toFixed(4)}), chain intact`);
}

async function capHolds(): Promise<Result> {
  const root = sandbox("synthetic", (r) => withUsage(r, { prices: PRICES, cap: { monthly: 0.000001 } }));
  await blowCap(root);
  const tok = auth.issueToken(root, "planner");
  const req = (method: string, path: string, body?: unknown) => server.handle(root, new Request(`http://pb${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${tok}` } }));
  const read = await req("GET", "/v1/context");
  const w = await (await req("POST", "/v1/remember", { title: "Cap Test Org", type: "org", area: "work", attribute: "website", value: "https://example.org", as_of: "2026-10-08", sources: ["url:https://example.org"] })).json();
  let paused = false;
  try { await usage.metered(root, "upkeep.duplicates", fake()).complete({ system: "s", prompt: "p" }); } catch (e) { paused = String((e as Error).message).startsWith("paused"); }
  const item = (await import(join(SRC, "textline", "items.ts"))).openItems(root).find((i: { kind: string }) => i.kind === "usage");
  const bad = [...(read.status === 200 ? [] : [`reads stopped (${read.status})`]), ...(w.outcome === "committed" ? [] : [`write was ${w.outcome}`]), ...(paused ? [] : ["model step ran past the cap"]), ...(item ? [] : ["the owner got no escalation item"])];
  return ok(!bad.length, bad.length ? bad.join("; ") : "reads 200, write committed, model paused, owner escalated");
}

export function usageCases(): Case[] {
  const ready = () => (!usage?.metered ? "no spend caps at this commit" : !server || !auth || !cell || !model ? "missing core modules" : undefined);
  return [
    { id: "usage-invisible", dimension: "carving", kind: "attack", title: "agents never see model spend: every tool, route, orientation and error is identical with the cap blown; cells clean", run: async () => (ready() ? na(ready()!) : invisible()) },
    { id: "usage-model-only", dimension: "escalation", title: "only model calls are recorded (tokens, cost, hash-chained); agent reads and writes never are", run: async () => (ready() ? na(ready()!) : recorded()) },
    { id: "usage-cap-holds", dimension: "escalation", title: "past the model spend cap model steps pause and the owner is escalated; reads and writes carry on", run: async () => (ready() ? na(ready()!) : capHolds()) },
  ];
}
