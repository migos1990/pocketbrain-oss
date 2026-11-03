// SPDX-License-Identifier: AGPL-3.0-only
// Apps on the owner's own computer, in one command (docs/connect.md): Cursor, VS Code, Codex CLI,
// Gemini CLI, Claude Desktop, or any MCP app that starts a command. Each app's config holds a
// command, `pocketbrain mcp --agent <name>` (the stdio bridge below), and never a key: the key the
// terminal gate made (mintFromShell, G184) waits in its own file under agent-keys/, next to the
// keys folder, readable by the owner alone (0600, folder 0700). That file is the one key pocketBrain
// keeps at rest (docs/hosting.md, "Keys at rest"); token --revoke and the dashboard's Revoke delete
// it. The bridge only talks to the hub on this machine, so editing an app's config can't send the
// key anywhere else. Another app's config file is written only with --write, after a backup of the
// file as it was, with only the pocketbrain entry changed; a file it can't read is left alone.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { keysDir } from "./secrets";

export const LOCAL_APPS = ["cursor", "vscode", "codex", "gemini", "claude-desktop", "mcp"] as const;
export type LocalApp = typeof LOCAL_APPS[number];
export const isLocalApp = (k: string | undefined): k is LocalApp => !!k && (LOCAL_APPS as readonly string[]).includes(k);
export const APP_LABEL: Record<LocalApp, string> = { cursor: "Cursor", vscode: "VS Code", codex: "Codex CLI", gemini: "Gemini CLI", "claude-desktop": "Claude Desktop", mcp: "your MCP app" };

export class AppConfigError extends Error {}

// ---------- the key at rest ----------

export const agentKeysDir = () => join(dirname(keysDir()), "agent-keys");
const safeName = (agent: string) => { if (!/^[a-z0-9][a-z0-9_-]*$/.test(agent)) throw new AppConfigError(`${agent} isn't a plain agent name`); return agent; };
export const agentKeyFile = (agent: string) => join(agentKeysDir(), safeName(agent));

// The folder is made 0700 and the file 0600 before the key is in it, so it is never readable by others.
export function saveAgentKey(agent: string, token: string): string {
  const dir = agentKeysDir(), file = agentKeyFile(agent);
  testRunGuard([file]);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(file, "", { mode: 0o600 });
  chmodSync(file, 0o600);
  writeFileSync(file, `${token}\n`);
  return file;
}

export function readAgentKey(agent: string): string {
  const file = agentKeyFile(agent);
  if (!existsSync(file)) throw new AppConfigError(`no key for ${agent} on this computer (${file}); connect it again: pocketbrain connect ${agent} --kind <app>`);
  const st = statSync(file);
  if (!st.isFile()) throw new AppConfigError(`${file} isn't a file`);
  if (st.mode & 0o077) throw new AppConfigError(`${file} is readable by others, so it isn't used. Fix: chmod 600 ${file}, then pocketbrain token --revoke ${agent} and connect it again, since the key may have been read`);
  const key = readFileSync(file, "utf8").trim();
  if (!/^pb_[A-Za-z0-9_-]+$/.test(key)) throw new AppConfigError(`${file} doesn't hold a pocketBrain key`);
  return key;
}

// Called by every revoke (token --revoke, the dashboard's Revoke). True when a file was there.
export function dropAgentKey(agent: string): boolean {
  let file: string;
  try { file = agentKeyFile(agent); } catch { return false; }
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

// ---------- the apps' config files ----------

const home = () => process.env.HOME ?? homedir();
const appSupport = () => process.platform === "darwin" ? join(home(), "Library", "Application Support") : process.env.XDG_CONFIG_HOME ?? join(home(), ".config");

export function configPath(app: LocalApp): string | undefined {
  switch (app) {
    case "cursor": return join(home(), ".cursor", "mcp.json");
    case "gemini": return join(home(), ".gemini", "settings.json");
    case "codex": return join(process.env.CODEX_HOME ?? join(home(), ".codex"), "config.toml");
    case "vscode": return join(appSupport(), "Code", "User", "mcp.json");
    case "claude-desktop": return join(appSupport(), "Claude", "claude_desktop_config.json");
    case "mcp": return undefined;
  }
}

// Absolute paths: an app started from the Dock or a launcher has a short PATH and wouldn't find
// `pocketbrain`. The config folder goes along when it was moved, so the bridge finds the key.
export function bridgeCommand(agent: string): { command: string; args: string[]; env?: Record<string, string> } {
  const env: Record<string, string> = {};
  for (const k of ["PB_CONFIG_DIR", "XDG_CONFIG_HOME"]) if (process.env[k]) env[k] = process.env[k]!;
  return { command: process.execPath, args: [resolve(import.meta.dir, "cli.ts"), "mcp", "--agent", safeName(agent)], ...(Object.keys(env).length ? { env } : {}) };
}

const jsonKey = (app: LocalApp) => app === "vscode" ? "servers" : "mcpServers";
const jsonEntry = (app: LocalApp, agent: string) => app === "vscode" ? { type: "stdio", ...bridgeCommand(agent) } : bridgeCommand(agent);

function tomlBlock(agent: string): string {
  const b = bridgeCommand(agent);
  const q = (s: string) => JSON.stringify(s);
  const env = b.env ? `env = { ${Object.entries(b.env).map(([k, v]) => `${k} = ${q(v)}`).join(", ")} }\n` : "";
  return `[mcp_servers.pocketbrain]\ncommand = ${q(b.command)}\nargs = [${b.args.map(q).join(", ")}]\n${env}`;
}

// What goes into the app's config, to paste by hand when --write isn't given.
export function snippet(app: LocalApp, agent: string): string {
  if (app === "codex") return tomlBlock(agent);
  return JSON.stringify({ [jsonKey(app)]: { pocketbrain: jsonEntry(app, agent) } }, null, 2);
}

// The file as it would be with the pocketbrain entry set; everything else kept. Throws on a file
// it can't read, so nothing is written over something it doesn't understand.
export function mergeConfig(app: LocalApp, old: string | undefined, agent: string): string {
  if (app === "mcp") throw new AppConfigError("an MCP app's config isn't known; paste the command into it");
  if (app === "codex") {
    const text = old ?? "";
    try { Bun.TOML.parse(text); } catch (e) { throw new AppConfigError(`can't read ${configPath(app)} as TOML (${(e as Error).message}), so it was left as it is`); }
    // Drop an earlier [mcp_servers.pocketbrain] table and its sub-tables, up to the next other table.
    const out: string[] = [];
    let skipping = false;
    for (const line of text.split("\n")) {
      const header = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/);
      if (header) skipping = header[1] === "mcp_servers.pocketbrain" || header[1].startsWith("mcp_servers.pocketbrain.");
      if (!skipping) out.push(line);
    }
    const kept = out.join("\n").replace(/\s+$/, "");
    return `${kept ? `${kept}\n\n` : ""}${tomlBlock(agent)}`;
  }
  let doc: Record<string, unknown> = {};
  if (old !== undefined && old.trim()) {
    try { doc = JSON.parse(old); } catch (e) { throw new AppConfigError(`can't read ${configPath(app)} as JSON (${(e as Error).message}), so it was left as it is`); }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new AppConfigError(`${configPath(app)} isn't a JSON object, so it was left as it is`);
  }
  const key = jsonKey(app);
  const servers = doc[key] ?? {};
  if (typeof servers !== "object" || Array.isArray(servers)) throw new AppConfigError(`${key} in ${configPath(app)} isn't an object, so it was left as it is`);
  return `${JSON.stringify({ ...doc, [key]: { ...(servers as object), pocketbrain: jsonEntry(app, agent) } }, null, 2)}\n`;
}

// --write: the backup first, then the merged file. Returns where both are.
export function writeAppConfig(app: LocalApp, agent: string, now = new Date()): { path: string; backup?: string } {
  const path = configPath(app);
  if (!path) throw new AppConfigError("an MCP app's config isn't known; paste the command into it");
  testRunGuard([path]);
  const old = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const next = mergeConfig(app, old, agent);
  let backup: string | undefined;
  if (old !== undefined) {
    backup = `${path}.pocketbrain-backup-${now.toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(path, backup);
    if (readFileSync(backup, "utf8") !== old) throw new AppConfigError(`the backup ${backup} doesn't match ${path}, so it was left as it is`);
  } else mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  return { path, backup };
}

// Where the owner pastes the standing instruction in each app.
export const INSTRUCTION_PLACE: Record<LocalApp, string> = {
  cursor: "Cursor Settings > Rules > User Rules",
  vscode: "a user instructions file (Command Palette: Chat: New Instructions File, then your user folder)",
  codex: "~/.codex/AGENTS.md",
  gemini: "~/.gemini/GEMINI.md",
  "claude-desktop": "Settings > Profile, the box for personal preferences",
  mcp: "the app's own custom instructions",
};

// A test run (test/setup.ts sets PB_TEST_RUN_DIR) never writes outside its own folder (as G393).
function testRunGuard(paths: string[]) {
  const run = process.env.PB_TEST_RUN_DIR;
  if (!run) return;
  const out = paths.filter((p) => !resolve(p).startsWith(resolve(run) + "/"));
  if (out.length) throw new Error(`a test run won't write outside its own folder (${out.join(", ")})`);
}

// ---------- the stdio bridge: pocketbrain mcp --agent <name> ----------

// Only this machine: http(s) to 127.0.0.1, ::1 or localhost, with no user part.
export function isLoopback(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
}

// One JSON-RPC message per line in, one per line out (the MCP stdio transport). Each message is
// POSTed to the hub's /mcp with the agent's key; a notification gets no line back. A refused key
// ends the bridge (exit 1); an address that isn't this machine is refused before anything (exit 2).
export async function bridge(o: { agent: string; url?: string; lines: AsyncIterable<string>; write: (s: string) => void; fetch?: typeof fetch; err?: (s: string) => void }): Promise<number> {
  const err = o.err ?? ((s: string) => console.error(s));
  const base = (o.url ?? "http://127.0.0.1:8787").replace(/\/$/, "");
  if (!isLoopback(base)) { err(`pocketbrain mcp: ${base} isn't this computer. The bridge only talks to the hub on this machine (http://127.0.0.1:8787), so a key never leaves it.`); return 2; }
  let key: string;
  try { key = readAgentKey(o.agent); } catch (e) { err(`pocketbrain mcp: ${(e as Error).message}`); return 1; }
  const f = o.fetch ?? fetch;
  let session: string | undefined;
  const fail = (id: unknown, message: string) => { if (id !== undefined && id !== null) o.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } })}\n`); };
  for await (const raw of o.lines) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { o.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "not JSON" } })}\n`); continue; }
    // A bare null, number or array is valid JSON but no message: it has no id to answer.
    const msg: { id?: unknown } = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as { id?: unknown } : {};
    const isRequest = msg.id !== undefined && msg.id !== null;
    let res: Response;
    try {
      // Never follow a redirect: the key goes to this machine's hub only (isLoopback above).
      res = await f(`${base}/mcp`, { method: "POST", body: line, redirect: "manual", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) } });
    } catch (e) { err(`pocketbrain mcp: the hub at ${base} didn't answer (${(e as Error).message}). Is pocketbrain start running?`); fail(msg.id, "pocketBrain's hub isn't running on this computer"); continue; }
    if (res.status === 401 || res.status === 403) { err(`pocketbrain mcp: the hub refused ${o.agent}'s key (revoked, or expired). Connect it again: pocketbrain connect ${o.agent} --kind <app>`); fail(msg.id, "the hub refused this key"); return 1; }
    if (res.status >= 300 && res.status < 400) { err(`pocketbrain mcp: the hub at ${base} answered with a redirect (${res.status}), which the bridge doesn't follow, so its key stays on this computer.`); fail(msg.id, "the hub answered with a redirect, which the bridge doesn't follow"); continue; }
    session = res.headers.get("mcp-session-id") ?? session;
    const body = await res.text();
    if (!isRequest || !body.trim()) continue;
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      for (const l of body.split("\n")) {
        if (!l.startsWith("data:") || !l.slice(5).trim()) continue;
        try { o.write(`${JSON.stringify(JSON.parse(l.slice(5)))}\n`); } catch { fail(msg.id, `the hub answered ${res.status} with a stream line that isn't JSON`); }
      }
    } else {
      try { o.write(`${JSON.stringify(JSON.parse(body))}\n`); } catch { fail(msg.id, `the hub answered ${res.status} without JSON`); }
    }
  }
  return 0;
}

export async function* stdinLines(): AsyncIterable<string> {
  let buf = "";
  const dec = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) { yield buf.slice(0, i); buf = buf.slice(i + 1); }
  }
  if (buf.trim()) yield buf;
}
