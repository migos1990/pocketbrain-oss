// SPDX-License-Identifier: AGPL-3.0-only
// The apps on the owner's own computer in one command (docs/connect.md): `add <app> --kind cursor|
// vscode|codex|gemini|claude-desktop|mcp`. Their config holds a command, `pocketbrain mcp --agent
// <app>`, not a key: the key waits in its own file (0600, in agent-keys/ next to the keys folder),
// read by the stdio bridge, which only ever talks to this machine. Another app's config file is
// written only with --write, after a backup, with only the pocketbrain entry changed.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { main } from "../src/cli";
import { handle } from "../src/server";
import { bridge, agentKeyFile } from "../src/local-apps";
import { runAction } from "../src/dashboard/actions";
import { tokenOwner } from "../src/auth";

function run(root: string, ...args: string[]) {
  const out: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { out.push(a.join(" ")); };
  let code: number;
  try { code = main([...args, "--brain", root]); } finally { console.log = log; console.error = err; }
  return { code, out: out.join("\n") };
}
const policy = (root: string) => YAML.parse(readFileSync(join(root, "rules", "policy.yaml"), "utf8")).agents;

let home = "", saved: Record<string, string | undefined> = {};
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pb-apps-home-"));
  saved = { HOME: process.env.HOME, PB_CONFIG_DIR: process.env.PB_CONFIG_DIR, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  process.env.PB_CONFIG_DIR = join(home, ".config", "pocketbrain");
  delete process.env.XDG_CONFIG_HOME;
});
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

const lines = (...msgs: unknown[]) => (async function* () { for (const m of msgs) yield JSON.stringify(m); })();
const viaHub = (root: string) => ((url: string | URL | Request, init?: RequestInit) => handle(root, new Request(String(url), init))) as typeof fetch;

test("--kind cursor: a narrow trial agent whose key goes in a 0600 file, never printed, and no app config is written without --write", () => {
  const root = makeBrain();
  const r = run(root, "add", "cursor", "--kind", "cursor", "--yes");
  expect(r.code).toBe(0);
  expect(policy(root).cursor).toMatchObject({ tier: "trial", transport: "mcp", slices: ["area:work", "contacts-basic"], exclude_types: ["money"] });
  const key = agentKeyFile("cursor");
  expect(existsSync(key)).toBe(true);
  expect(statSync(key).mode & 0o777).toBe(0o600);
  expect(statSync(join(key, "..")).mode & 0o777).toBe(0o700);
  const token = readFileSync(key, "utf8").trim();
  expect(token).toStartWith("pb_cursor_");
  expect(r.out).not.toContain(token);
  // The snippet names the bridge command, and the file was not touched.
  expect(r.out).toContain('"mcp"');
  expect(r.out).toContain('"--agent"');
  expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
  expect(r.out).toContain("--write");
  expect(r.out).toContain("pocketbrain token --revoke cursor");
});

test("--write merges only the pocketbrain entry, after a backup of the file as it was", () => {
  const root = makeBrain();
  mkdirSync(join(home, ".cursor"));
  const before = JSON.stringify({ mcpServers: { other: { url: "https://other.example/mcp", headers: { Authorization: "Bearer theirs" } } }, keep: [1, 2] }, null, 2) + "\n";
  writeFileSync(join(home, ".cursor", "mcp.json"), before);
  const r = run(root, "add", "cursor", "--kind", "cursor", "--yes", "--write");
  expect(r.code).toBe(0);
  const after = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
  expect(after.mcpServers.other).toEqual(JSON.parse(before).mcpServers.other);
  expect(after.keep).toEqual([1, 2]);
  expect(after.mcpServers.pocketbrain.args).toEqual(expect.arrayContaining(["mcp", "--agent", "cursor"]));
  expect(JSON.stringify(after)).not.toContain("pb_cursor_");
  const backups = readdirSync(join(home, ".cursor")).filter((f) => f.startsWith("mcp.json.pocketbrain-backup-"));
  expect(backups.length).toBe(1);
  expect(readFileSync(join(home, ".cursor", backups[0]), "utf8")).toBe(before);
});

test("--write refuses a config it can't read, and changes nothing", () => {
  const root = makeBrain();
  mkdirSync(join(home, ".gemini"));
  writeFileSync(join(home, ".gemini", "settings.json"), "{ not json");
  const r = run(root, "add", "gemini", "--kind", "gemini", "--yes", "--write");
  expect(r.code).toBe(1);
  expect(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).toBe("{ not json");
  expect(readdirSync(join(home, ".gemini"))).toEqual(["settings.json"]);
});

test("codex: --write adds one [mcp_servers.pocketbrain] table and keeps the rest of config.toml", () => {
  const root = makeBrain();
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "config.toml"), 'model = "o4"\n\n[mcp_servers.other]\ncommand = "other"\n');
  expect(run(root, "add", "codex", "--kind", "codex", "--yes", "--write").code).toBe(0);
  expect(run(root, "connect", "codex", "--kind", "codex", "--write").code).toBe(0); // again: replaced, not doubled
  const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  expect(toml).toStartWith('model = "o4"\n\n[mcp_servers.other]\ncommand = "other"\n');
  expect(toml.split("[mcp_servers.pocketbrain]").length).toBe(2);
  expect(toml).toContain('"--agent", "codex"');
});

test("a wide app is refused before anything is written", () => {
  const root = makeBrain();
  const r = run(root, "add", "wide", "--kind", "cursor", "--slices", "area:work,area:personal", "--yes", "--write");
  expect(r.code).toBe(1);
  expect(policy(root).wide).toBeUndefined();
  expect(existsSync(agentKeyFile("wide"))).toBe(false);
  expect(existsSync(join(home, ".cursor"))).toBe(false);
});

test("revoke deletes the key file, and the bridge then gets nothing", async () => {
  const root = makeBrain();
  expect(run(root, "add", "cursor", "--kind", "cursor", "--yes").code).toBe(0);
  expect(existsSync(agentKeyFile("cursor"))).toBe(true);
  expect(run(root, "token", "--revoke", "cursor").code).toBe(0);
  expect(existsSync(agentKeyFile("cursor"))).toBe(false);
  const out: string[] = [];
  const code = await bridge({ agent: "cursor", lines: lines({ jsonrpc: "2.0", id: 1, method: "tools/list" }), write: (s) => out.push(s), fetch: viaHub(root) });
  expect(code).toBe(1);
  expect(out.join("")).not.toContain('"tools"');
});

test("the bridge round-trips MCP to the local hub with the agent's own key", async () => {
  const root = makeBrain();
  expect(run(root, "add", "cursor", "--kind", "cursor", "--yes").code).toBe(0);
  const out: string[] = [];
  const code = await bridge({
    agent: "cursor",
    lines: lines({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "context_pack", arguments: {} } }, { jsonrpc: "2.0", method: "notifications/initialized" }),
    write: (s) => out.push(s), fetch: viaHub(root),
  });
  expect(code).toBe(0);
  const replies = out.join("").trim().split("\n").map((l) => JSON.parse(l));
  expect(replies.length).toBe(1); // a notification gets no reply
  expect(replies[0].id).toBe(1);
  expect(replies[0].result.content[0].text).toContain("Course A");
  expect(replies[0].result.content[0].text).not.toContain("Maple Trust");
});

test("the bridge only talks to this machine: any other address is refused before a request", async () => {
  const root = makeBrain();
  expect(run(root, "add", "cursor", "--kind", "cursor", "--yes").code).toBe(0);
  for (const url of ["https://evil.example", "http://127.0.0.1.evil.example:8787", "http://10.0.0.5:8787", "http://localhost@evil.example"]) {
    let called = 0;
    const code = await bridge({ agent: "cursor", url, lines: lines({ jsonrpc: "2.0", id: 1, method: "tools/list" }), write: () => {}, fetch: (async () => { called++; return new Response("{}"); }) as unknown as typeof fetch });
    expect({ url, code, called }).toEqual({ url, code: 2, called: 0 });
  }
  expect(run(root, "mcp", "--agent", "cursor", "--url", "https://evil.example").code).toBe(2);
});

test("the bridge refuses a key file others can read", async () => {
  const root = makeBrain();
  expect(run(root, "add", "cursor", "--kind", "cursor", "--yes").code).toBe(0);
  chmodSync(agentKeyFile("cursor"), 0o644);
  let called = 0;
  const code = await bridge({ agent: "cursor", lines: lines({ jsonrpc: "2.0", id: 1, method: "tools/list" }), write: () => {}, fetch: (async () => { called++; return new Response("{}"); }) as unknown as typeof fetch });
  expect(code).toBe(1);
  expect(called).toBe(0);
});

test("the dashboard's Revoke deletes the key file too", () => {
  const root = makeBrain();
  expect(run(root, "add", "cursor", "--kind", "cursor", "--yes").code).toBe(0);
  runAction({ root }, "agent-revoke", { agent: "cursor" });
  expect(existsSync(agentKeyFile("cursor"))).toBe(false);
});

test("--write that fails to write the app's config takes the new key back, so no live key is left with nothing pointing to it", () => {
  const root = makeBrain();
  writeFileSync(join(home, "afile"), "not a folder");
  const savedCodex = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(home, "afile", "codex");
  try {
    const r = run(root, "add", "codex", "--kind", "codex", "--yes", "--write");
    expect(r.code).toBe(1);
    expect(existsSync(agentKeyFile("codex"))).toBe(false);
    const tokens = YAML.parse(readFileSync(join(root, "rules", "tokens.yaml"), "utf8")) ?? {};
    expect(JSON.stringify(tokens)).not.toContain('"codex"');
    expect(r.out).toContain("--kind codex");
  } finally { if (savedCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedCodex; }
});

test("the bridge answers a request whose streamed reply isn't JSON with an error, and keeps going; a bare null line doesn't crash it", async () => {
  const root = makeBrain();
  expect(run(root, "add", "cursor", "--kind", "cursor", "--yes").code).toBe(0);
  let n = 0;
  const f = (async () => {
    n++;
    if (n === 1) return new Response("event: message\ndata: {not json\n\n", { headers: { "content-type": "text/event-stream" } });
    if (n === 2) throw new Error("down");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 3, result: {} }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const out: string[] = [];
  const code = await bridge({ agent: "cursor", lines: (async function* () { yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }); yield "null"; yield JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }); })(), write: (s) => out.push(s), fetch: f, err: () => {} });
  expect(code).toBe(0);
  const replies = out.join("").trim().split("\n").map((l) => JSON.parse(l));
  expect(replies.map((r) => r.id)).toEqual([1, 3]);
  expect(replies[0].error.code).toBe(-32603);
});

test("token rotate for an app on this computer puts the new key in its key file, never on screen, and the bridge keeps working", async () => {
  const root = makeBrain();
  expect(run(root, "add", "cursor", "--kind", "cursor", "--yes").code).toBe(0);
  const old = readFileSync(agentKeyFile("cursor"), "utf8").trim();
  const r = run(root, "token", "rotate", "cursor", "--yes");
  expect(r.code).toBe(0);
  const next = readFileSync(agentKeyFile("cursor"), "utf8").trim();
  expect(next).toStartWith("pb_cursor_");
  expect(next).not.toBe(old);
  expect(statSync(agentKeyFile("cursor")).mode & 0o777).toBe(0o600);
  expect(r.out).not.toContain(next);
  expect(r.out).toContain(agentKeyFile("cursor"));
  const out: string[] = [];
  expect(await bridge({ agent: "cursor", lines: lines({ jsonrpc: "2.0", id: 1, method: "tools/list" }), write: (s) => out.push(s), fetch: viaHub(root) })).toBe(0);
  expect(out.join("")).toContain('"tools"');
});

test("the bridge never follows a redirect, so its key can't be carried to another address", async () => {
  const root = makeBrain();
  expect(run(root, "add", "cursor", "--kind", "cursor", "--yes").code).toBe(0);
  const inits: (RequestInit | undefined)[] = [];
  const f = (async (_u: unknown, init?: RequestInit) => { inits.push(init); return new Response("", { status: 307, headers: { location: "https://evil.example/mcp" } }); }) as unknown as typeof fetch;
  const out: string[] = [];
  const code = await bridge({ agent: "cursor", lines: lines({ jsonrpc: "2.0", id: 1, method: "tools/list" }), write: (s) => out.push(s), fetch: f, err: () => {} });
  expect(code).toBe(0);
  expect(inits.length).toBe(1);
  expect(inits[0]?.redirect).toBe("manual");
  const replies = out.join("").trim().split("\n").map((l) => JSON.parse(l));
  expect(replies[0]).toMatchObject({ id: 1, error: { code: -32603 } });
});

test("a failed --write takes back only the key it just made: the app already connected keeps its key and its file", () => {
  const root = makeBrain();
  expect(run(root, "add", "codex", "--kind", "codex", "--yes").code).toBe(0);
  const first = readFileSync(agentKeyFile("codex"), "utf8").trim();
  writeFileSync(join(home, "afile"), "not a folder");
  const savedCodex = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(home, "afile", "codex");
  try {
    const r = run(root, "connect", "codex", "--kind", "codex", "--write");
    expect(r.code).toBe(1);
  } finally { if (savedCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedCodex; }
  expect(readFileSync(agentKeyFile("codex"), "utf8").trim()).toBe(first);
  const tokens = YAML.parse(readFileSync(join(root, "rules", "tokens.yaml"), "utf8"));
  expect(tokens.agents.codex.length).toBe(1);
  expect(tokenOwner(root, first)?.agent).toBe("codex");
});
