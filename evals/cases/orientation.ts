// SPDX-License-Identifier: AGPL-3.0-only
// A brand-new agent connects through the real live server and is told, before anything else,
// who it is, what it holds, what it may write or retire, and what is withheld. These cases
// check that the orientation is there on the first contact, and that every claim in it
// matches what the server then enforces for that agent.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SRC } from "../lib/pb";
import { sandbox, TODAY } from "../lib/sandbox";
import { ok, na, type Case, type Result } from "../lib/case";

const server = existsSync(join(SRC, "orientation.ts")) ? await import(join(SRC, "server.ts")) : undefined;
const auth = existsSync(join(SRC, "auth.ts")) ? await import(join(SRC, "auth.ts")) : undefined;

// The fresh agent: a trial assistant Robin just added, with a small slice.
const SCOUT = "  scout: { tier: trial, transport: mcp, slices: [area:side, contacts-basic], exclude_types: [money] }\n";
const OTHERS = ["steward", "planner", "planbot", "helper", "claude", "reflect"];

function addScout(root: string) {
  const p = join(root, "rules", "policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace(/^agents:\n/m, `agents:\n${SCOUT}`));
}

async function episode(fn: (l: { url: string; root: string; tok: Record<string, string> }) => Promise<Result>): Promise<Result> {
  if (!server || !auth) return na("no orientation at this commit");
  const root = sandbox("synthetic", addScout);
  const srv = server.serve(root, 0);
  const tok: Record<string, string> = { scout: auth.issueToken(root, "scout"), steward: auth.issueToken(root, "steward") };
  try { return await fn({ url: `http://127.0.0.1:${srv.port}`, root, tok }); }
  finally { srv.stop(true); }
}

async function http(url: string, token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(url + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any; try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
}
const rpc = async (url: string, token: string, method: string, params: unknown = {}) => (await http(url, token, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method, params })).json;
const tool = async (url: string, token: string, name: string, args: unknown = {}) => {
  const t = (await rpc(url, token, "tools/call", { name, arguments: args }))?.result?.content?.[0]?.text ?? "";
  let json: any; try { json = JSON.parse(t); } catch {}
  return { text: t as string, json };
};

const steps = (xs: [string, boolean][]): Result => {
  const failed = xs.filter(([, p]) => !p).map(([s]) => s);
  return ok(!failed.length, failed.length ? `failed: ${failed.join("; ")}` : `${xs.length} steps`);
};
const held = (text: string) => Number(text.match(/You hold (\d+) notes and (\d+) facts/)?.[1] ?? -1);

export const orientationCases: Case[] = [
  { id: "e2e-orientation-fresh-agent", dimension: "e2e", kind: "benign", title: "A fresh agent is told on connect who it is, what it holds and what it may do, and each claim holds", run: () => episode(async ({ url, tok }) => {
    const t = tok.scout;
    const init = await rpc(url, t, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "eval", version: "1" } });
    const instr: string = init?.result?.instructions ?? "";
    const names: string[] = (await rpc(url, t, "tools/list"))?.result?.tools?.map((x: any) => x.name) ?? [];
    const viaTool = (await tool(url, t, "orientation")).text;
    const ctx = (await tool(url, t, "context_pack")).text;
    const remember = (await tool(url, t, "remember", { title: "Garden plan", type: "project", area: "side", attribute: "next_step", value: "Book the room", as_of: TODAY, sources: ["agent:scout"], verification: "self-reported" })).json;
    const retire = (await tool(url, t, "retire", { id: "people/jane-roy", attribute: "role", as_of: TODAY, sources: ["agent:scout"] })).json;
    const lower = (instr + "\n" + viaTool).toLowerCase();
    return steps([
      ["instructions name the agent", instr.startsWith("# You are scout")],
      ["orientation is the first tool, retire is listed", names[0] === "orientation" && names.includes("retire")],
      ["the instructions are the short contract; the tool is the full guide", instr.length < 950 && viaTool.startsWith("# You are scout") && /orientation tool/.test(instr)],
      ["both slices named", viaTool.includes("- area:side:") && viaTool.includes("- contacts-basic:")],
      ["note count matches the context pack", held(viaTool) >= 0 && held(viaTool) === held(ctx)],
      ["says money is not shared", viaTool.includes("Not shared with you: money.")],
      ["says asking other agents is blocked", /don't ask another assistant/.test(viaTool) && /ask another assistant/.test(instr)],
      ["explains [withheld] and [[redacted]]", instr.includes("`[withheld]`") && viaTool.includes("`[[redacted]]`")],
      ["says every write is a proposal", viaTool.includes("every write is a proposal") && instr.includes("each one waits for")],
      ["...and remember lands in the inbox", remember?.outcome === "inbox"],
      ["...and retire lands in the inbox too", retire?.outcome === "inbox"],
      ["names no other agent", OTHERS.every((a) => !new RegExp(`\\b${a}\\b`).test(lower))],
      ["names nothing it can't see", !/maple|main-bank|compensation|finance/.test(lower)],
      [`short enough to read in full (${viaTool.length})`, viaTool.length < 6400], // 6000, plus the today pack (docs/agent-instructions.md "Today")
    ]);
  }) },
  { id: "e2e-orientation-api-resolver", dimension: "e2e", kind: "benign", title: "An API-only agent finds its orientation at GET /v1 and is told its resolver job", run: () => episode(async ({ url, tok }) => {
    const root = await http(url, tok.steward, "GET", "/v1");
    const o = await http(url, tok.steward, "GET", "/v1/orientation?format=json");
    const disputes = await http(url, tok.steward, "GET", "/v1/disputes");
    const scoutDisputes = await http(url, tok.scout, "GET", "/v1/disputes");
    const anon = await fetch(url + "/v1").then(async (r) => ({ status: r.status, json: await r.json().catch(() => undefined) as any }));
    return steps([
      ["GET /v1 points at the orientation", root.json?.read_first === "/v1/orientation" && root.json?.you_are === "steward"],
      ["routes are API routes, not tool names", (o.json?.text ?? "").includes("POST /v1/retire")],
      ["told it is the resolver", o.json?.resolver === true && /You are the resolver/.test(o.json?.text ?? "")],
      ["...and the dispute routes answer it", disputes.status === 200],
      ["...and refuse a non-resolver", scoutDisputes.status === 403],
      ["no token: a hint, no agent named", anon.status === 401 && /orientation/.test(anon.json?.hint ?? "") && !/steward|scout/.test(JSON.stringify(anon.json))],
    ]);
  }) },
  { id: "e2e-orientation-follows-rules", dimension: "e2e", kind: "benign", title: "When Robin changes an agent's grant, its next orientation says so without a restart", run: () => episode(async ({ url, root, tok }) => {
    const before = (await tool(url, tok.scout, "orientation")).text;
    const p = join(root, "rules", "policy.yaml");
    writeFileSync(p, readFileSync(p, "utf8").replace(SCOUT, "  scout: { tier: trial, transport: mcp, slices: [area:work], exclude_types: [money], status: read-only }\n"));
    Bun.spawnSync(["git", "commit", "-qam", "louis: scout to work, read-only"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
    const after = (await tool(url, tok.scout, "orientation")).text;
    const ctx = (await tool(url, tok.scout, "context_pack")).text;
    const write = (await tool(url, tok.scout, "remember", { id: "projects/course-a", attribute: "next_step", value: "x", as_of: TODAY, sources: ["agent:scout"] })).json;
    return steps([
      ["before: area:side", before.includes("- area:side:")],
      ["after: area:work, not area:side", after.includes("- area:work:") && !after.includes("- area:side:")],
      ["after: count matches the new context", held(after) === held(ctx)],
      ["after: says read-only", /read-only/.test(after)],
      ["...and a write is refused", write?.outcome === "refused"],
    ]);
  }) },
];
