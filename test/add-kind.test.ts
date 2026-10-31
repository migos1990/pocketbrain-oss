// SPDX-License-Identifier: AGPL-3.0-only
// `pocketbrain add <agent> --kind …` (docs/add-an-agent.md#one-command-per-kind): from zero to a
// working context_pack in at most three owner actions, for each kind of assistant: the command,
// then at most two pastes. The kind picks the door and a slice preset; the output is one block.
import { test, expect, afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { main } from "../src/cli";
import { handle } from "../src/server";
import { setupOAuth, clearJwksCache } from "../src/oauth";
import { startFakeAS, connect } from "./fake-as";

const BASE = "https://brain.test";
const RESOURCE = `${BASE}/mcp/oauth`;
const as = startFakeAS("user_owner");
afterAll(() => as.stop());

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
const tokenIn = (s: string) => s.match(/pb_[A-Za-z0-9_-]+/)?.[0] ?? "";
const mcpCall = (root: string, token: string, path = "/mcp") => handle(root, new Request(BASE + path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "context_pack", arguments: {} } }) })).then((r) => r.json() as any);
// The owner's actions the output asks for: "1." … lines in the steps block.
const steps = (out: string) => [...out.matchAll(/^\s*(\d)\. /gm)].map((m) => Number(m[1]));

test("--kind town: one command grants a preset trial slice and prints one paste block; context_pack works with it", async () => {
  const root = makeBrain();
  const r = run(root, "add", "town2", "--kind", "town", "--url", BASE, "--yes");
  expect(r.code).toBe(0);
  expect(policy(root).town2).toMatchObject({ tier: "trial", transport: "mcp", slices: ["area:work", "contacts-basic"], exclude_types: ["money"] });
  expect(r.out).toContain(`${BASE}/mcp`);
  expect(r.out).toContain("pocketBrain is");
  expect(steps(r.out)).toEqual([1, 2]);
  const ctx = await mcpCall(root, tokenIn(r.out));
  expect(ctx.result.content[0].text).toContain("Course A");
  expect(ctx.result.content[0].text).not.toContain("Maple Trust");
});

test("--kind claude-code: runs `claude mcp add` and writes the standing instruction into ~/.claude/CLAUDE.md, once", async () => {
  const root = makeBrain();
  const home = mkdtempSync(join(tmpdir(), "pb-home-"));
  const bin = mkdtempSync(join(tmpdir(), "pb-bin-"));
  const record = join(bin, "args.txt");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${record}\n`);
  chmodSync(join(bin, "claude"), 0o755);
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "# My notes\n\nKeep answers short.\n");
  const env = { HOME: process.env.HOME, PATH: process.env.PATH };
  process.env.HOME = home; process.env.PATH = `${bin}:${process.env.PATH}`;
  try {
    const r = run(root, "add", "cc", "--kind", "claude-code", "--yes");
    expect(r.code).toBe(0);
    const args = readFileSync(record, "utf8").split("\n");
    expect(args.slice(0, 7)).toEqual(["mcp", "add", "--scope", "user", "--transport", "http", "pocketbrain"]);
    expect(args).toContain("http://127.0.0.1:8787/mcp");
    const token = tokenIn(args.join(" "));
    expect(r.out).not.toContain(token); // ran for the owner, never printed
    const md = readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
    expect(md).toStartWith("# My notes\n\nKeep answers short.\n");
    expect(md).toContain("call context_pack with the topic");
    expect(steps(r.out)).toEqual([]);
    expect((await mcpCall(root, token)).result.content[0].text).toContain("Course A");
    // A second Claude Code agent replaces the block instead of adding another.
    run(root, "add", "cc2", "--kind", "claude-code", "--yes");
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8").split("<!-- pocketbrain -->").length).toBe(2);
  } finally { process.env.HOME = env.HOME; process.env.PATH = env.PATH; }
});

test("--kind claude-code without the claude CLI prints its line and the block instead", () => {
  const root = makeBrain();
  const home = mkdtempSync(join(tmpdir(), "pb-home-"));
  const env = { HOME: process.env.HOME, PATH: process.env.PATH };
  // git and the shell, but no claude: a dir with links to git only.
  const bin = mkdtempSync(join(tmpdir(), "pb-noclaude-"));
  symlinkSync(Bun.which("git")!, join(bin, "git"));
  process.env.HOME = home; process.env.PATH = `${bin}:/bin`;
  try {
    const r = run(root, "add", "cc", "--kind", "claude-code", "--yes");
    expect(r.code).toBe(0);
    expect(r.out).toContain("claude mcp add --scope user --transport http pocketbrain http://127.0.0.1:8787/mcp");
    expect(steps(r.out)).toEqual([1]);
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toContain("call context_pack with the topic");
  } finally { process.env.HOME = env.HOME; process.env.PATH = env.PATH; }
});

test("--kind claude-ai: opens the sign-in window; after one sign-in, context_pack works", async () => {
  clearJwksCache();
  const root = makeBrain();
  setupOAuth(root, { issuer: as.issuer, resource: RESOURCE, owner_subject: "user_owner" });
  const r = run(root, "add", "cai", "--kind", "claude-ai", "--url", BASE, "--yes");
  expect(r.code).toBe(0);
  expect(r.out).toContain(RESOURCE);
  expect(r.out).not.toContain("pb_cai_");
  expect(steps(r.out)).toEqual([1, 2]);
  const call = (path: string, init: RequestInit = {}) => handle(root, new Request(BASE + path, init));
  const c = await connect(call, RESOURCE, { dcr: { client_name: "Claude", redirect_uri: "https://claude.ai/cb" } });
  expect((await mcpCall(root, c.token(), "/mcp/oauth")).result.content[0].text).toContain("Course A");
});

test("--kind browser: browser door on, a reader key and its instruction; the key signs in and reads", async () => {
  const root = makeBrain();
  const r = run(root, "add", "inst", "--kind", "browser", "--url", BASE, "--yes");
  expect(r.code).toBe(0);
  expect(policy(root).inst.browser).toBe(true);
  expect(r.out).toContain(`${BASE}/b`);
  expect(steps(r.out)).toEqual([1, 2]);
  const login = await handle(root, new Request(BASE + "/b/login", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ agent: "inst", password: tokenIn(r.out) }).toString() }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const page = await (await handle(root, new Request(BASE + "/b/context", { headers: { cookie } }))).text();
  expect(page).toContain("Course A");
});

test("--kind picks the door; a --door that disagrees, or an unknown kind, is refused", () => {
  const root = makeBrain();
  expect(run(root, "add", "x1", "--kind", "town", "--door", "oauth", "--yes").code).toBe(2);
  expect(run(root, "add", "x1", "--kind", "fax", "--yes").code).toBe(2);
  expect(policy(root).x1).toBeUndefined();
  // Without --yes it still only previews, with the preset slices named.
  const p = run(root, "add", "x1", "--kind", "town");
  expect(p.out).toContain("area:work");
  expect(policy(root).x1).toBeUndefined();
});

// From the stranger rehearsal (docs/add-an-agent.md#one-command-per-kind): what a newcomer hit.
test("a name holding the owner's says why and suggests one; the usage names --kind", () => {
  const root = makeBrain();
  const owner = YAML.parse(readFileSync(join(root, "rules", "policy.yaml"), "utf8")).owner?.name ?? "";
  const r = run(root, "add", `${String(owner).split(" ")[0].toLowerCase()}-claude`, "--kind", "claude-code", "--yes");
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("holds your name");
  expect(r.out).toContain("such as claude-code");
  expect(r.out).toContain("--kind");
});

test("connect <existing agent> --kind claude-code does what add --kind does, for the agent init made", async () => {
  const root = makeBrain();
  const home = mkdtempSync(join(tmpdir(), "pb-home-"));
  const bin = mkdtempSync(join(tmpdir(), "pb-bin-"));
  const record = join(bin, "args.txt");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${record}\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const env = { HOME: process.env.HOME, PATH: process.env.PATH };
  process.env.HOME = home; process.env.PATH = `${bin}:${process.env.PATH}`;
  try {
    const r = run(root, "connect", "helper", "--kind", "claude-code");
    expect(r.code).toBe(0);
    const token = tokenIn(readFileSync(record, "utf8").split("\n").join(" "));
    expect(token).toStartWith("pb_helper_");
    expect(r.out).not.toContain(token);
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toContain("<!-- pocketbrain -->");
    expect((await mcpCall(root, token)).result.content[0].text).toContain("Course A");
    // Every kind connects an existing agent (row 388: init prints connect <agent> --kind for each); an unknown one doesn't.
    expect(run(root, "connect", "helper", "--kind", "town").code).toBe(0);
    expect(run(root, "connect", "helper", "--kind", "chatgpt").code).toBe(2);
  } finally { process.env.HOME = env.HOME; process.env.PATH = env.PATH; }
});
