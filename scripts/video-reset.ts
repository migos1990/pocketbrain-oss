#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// Every take of the hackathon video starts here: Robin's fictional brain as President of a
// made-up company (examples/video, with the sample's rules), the same assistants and the same tokens every time, last night's
// gardener run replayed through the real write path, one relay message held, and a hub on its own
// ports. Louis's own brain and hub are never touched.
//
//   bun scripts/video-reset.ts                   stop the video hub, rebuild the brain, start it again
//   bun scripts/video-reset.ts --no-serve        rebuild only
//   bun scripts/video-reset.ts --stop            stop the video hub
//   bun scripts/video-reset.ts --save-access     keep this brain's tokens and Auth0 door for every later take
//   bun scripts/video-reset.ts --bind-claude     bind the newest waiting Auth0 connection as claude, keep it
//   bun scripts/video-reset.ts --no-tripwire     no daytime gardener attempt: no pause, no alert
//   bun scripts/video-reset.ts --tripwire        only the daytime attempt, on the brain as it is (the 1:25 shot)
//   bun scripts/video-reset.ts --local-fga       use an OpenFGA server on this computer as the second lock, keep it
//
// Folder: $PB_VIDEO_DIR or ~/pocketbrain-video (brain/, keep/, tokens/, hub.log, hub.pid).
// Keys for the video hub: ~/pocketbrain-video/config/keys/<NAME> (folder 700, files 600).
// Ports: $PB_VIDEO_PORT (8797) for assistants, $PB_VIDEO_DASHBOARD_PORT (8798) for the dashboard.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync, openSync } from "node:fs";
import { readLoginLink } from "../src/dashboard/login-link";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import YAML from "yaml";
import { issueToken } from "../src/auth";
import { handle } from "../src/server";
import { localTime, timezoneOf, inWindows } from "../src/gardener";
import { loadRules } from "../src/rules";
import { relayOnce, fileTransport } from "../src/relay";
import { listPending, bindClient, loadOAuth, asBase, managementToken } from "../src/oauth";
import { lookUp } from "../src/offboard";
import { FgaClient } from "../src/fga";

const APP = join(import.meta.dir, "..");
const DIR = process.env.PB_VIDEO_DIR ?? join(homedir(), "pocketbrain-video");
const BRAIN = join(DIR, "brain"), KEEP = join(DIR, "keep"), TOKENS = join(DIR, "tokens");
const PORT = Number(process.env.PB_VIDEO_PORT ?? 8797);
const DASH = Number(process.env.PB_VIDEO_DASHBOARD_PORT ?? 8798);
const PID = join(DIR, "hub.pid"), LOG = join(DIR, "hub.log");
// The video hub's own key files (AUTH0_MGMT_CLIENT_SECRET, FGA_CLIENT_SECRET, …), never the real hub's.
const CONFIG = join(DIR, "config"), KEYS = join(CONFIG, "keys");
// The assistants that connect with a pasted token. claude (claude.ai) comes in through Auth0.
const PASTED = ["town", "claude-code", "gardener", "robin", "alice"];
// Token hashes; the Auth0 door with its bindings, coworkers, machines and management client; FGA.
const KEPT = ["rules/tokens.yaml", "rules/oauth.yaml", "rules/fga.yaml"];
const args = process.argv.slice(2);
const say = (s: string) => console.log(s);

function git(cwd: string, a: string[], who = "robin") {
  const r = Bun.spawnSync(["git", ...a], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who}@example.com`, GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: `${who}@example.com` } });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
}

function stop() {
  if (!existsSync(PID)) return;
  const pid = Number(readFileSync(PID, "utf8"));
  try { process.kill(pid); say(`stopped the video hub (pid ${pid})`); } catch { /* already gone */ }
  rmSync(PID, { force: true });
  for (let i = 0; i < 40; i++) { try { process.kill(pid, 0); Bun.sleepSync(100); } catch { break; } }
}

// Keep what the takes need to stay connected: token hashes and the Auth0 door with its bindings.
function saveAccess() {
  mkdirSync(KEEP, { recursive: true });
  for (const f of KEPT) if (existsSync(join(BRAIN, f))) { mkdirSync(dirname(join(KEEP, f)), { recursive: true }); cpSync(join(BRAIN, f), join(KEEP, f)); say(`kept ${f}`); }
}

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const dated = (t: string) => t.replace(/@D([+-]\d+)@/g, (_m, n) => day(Number(n)));

// The instant that reads as hh:mm in the owner's timezone on the given UTC day.
function at(dayIso: string, hh: number, mm: number, tz: string): Date {
  let d = new Date(`${dayIso}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`);
  for (let i = 0; i < 3; i++) {
    let diff = localTime(d, tz).minutes - (hh * 60 + mm);
    if (diff > 720) diff -= 1440; else if (diff < -720) diff += 1440;
    d = new Date(d.getTime() - diff * 60_000);
  }
  return d;
}

function overlay(from: string, to: string) {
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const s = join(from, e.name), t = join(to, e.name);
    if (e.isDirectory()) { mkdirSync(t, { recursive: true }); overlay(s, t); }
    else writeFileSync(t, dated(readFileSync(s, "utf8")));
  }
}

async function call(agent: string, token: string, tool: string, a: Record<string, unknown> = {}, path = "/mcp") {
  const r = await handle(BRAIN, new Request(`http://127.0.0.1:${PORT}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: a } }) }));
  const text = await r.text();
  return { status: r.status, text };
}

// The gardener signs in to Auth0 as itself when a machine app is bound to it and its secret is in
// the video hub's keys (AUTH0_GARDENER_CLIENT_SECRET); otherwise it uses its pasted token.
async function gardenerSignIn(): Promise<{ token: string; path: string; how: string }> {
  const pasted = { token: readFileSync(join(TOKENS, "gardener.txt"), "utf8").trim(), path: "/mcp", how: "its pasted token" };
  const c = loadOAuth(BRAIN);
  const client = Object.entries(c?.machines ?? {}).find(([, m]) => m.agent === "gardener")?.[0];
  const keyFile = join(KEYS, "AUTH0_GARDENER_CLIENT_SECRET");
  if (!c || !client || !existsSync(keyFile)) return pasted;
  try {
    const r = await fetch(`${asBase(c)}oauth/token`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", client_id: client, client_secret: readFileSync(keyFile, "utf8").trim(), audience: c.resource }) });
    const j = await r.json() as { access_token?: string; error_description?: string };
    if (j.access_token) return { token: j.access_token, path: "/mcp/oauth", how: "its own Auth0 machine identity" };
    say(`gardener: Auth0 refused its machine sign-in (${j.error_description ?? r.status}); using its pasted token`);
  } catch (e) { say(`gardener: Auth0 unreachable (${(e as Error).message}); using its pasted token`); }
  return pasted;
}

// The write path's outcome inside an MCP answer: inbox, committed, refused...
function outcome(text: string): string {
  try { const inner = JSON.parse(JSON.parse(text).result.content[0].text); return `${inner.outcome}${inner.outcome === "inbox" ? "" : `: ${inner.message}`}`; } catch { return text.slice(0, 160); }
}

// This afternoon: the gardener's token used outside its hours. Refused, gardener paused, Robin told.
// Half an hour ago, or earlier until it falls outside every window (Sunday mornings are inside one).
async function daytime() {
  const tz = timezoneOf(loadRules(BRAIN));
  const g = await gardenerSignIn();
  const windows = loadRules(BRAIN).policy.agents.gardener?.windows ?? [];
  let off = new Date(Date.now() - 30 * 60_000);
  while (inWindows(windows, off, tz)) off = new Date(off.getTime() - 30 * 60_000);
  process.env.PB_NOW = off.toISOString();
  const r = await call("gardener", g.token, "context_pack", {}, g.path);
  say(`gardener, ${localTime(off, tz).label}: ${r.status === 401 ? "refused, outside its hours; paused" : `NOT refused (${r.status}): check its windows`}`);
  delete process.env.PB_NOW;
}

// `--local-fga` once points the video brain at an OpenFGA server on this computer ($PB_VIDEO_FGA_URL,
// default http://127.0.0.1:8089). Every later reset checks it: a server started fresh (its memory
// store is empty) gets the store and model again, and a server that isn't running turns FGA off for
// the take rather than cutting every assistant off (FGA fails closed).
const LOCAL_FGA = (process.env.PB_VIDEO_FGA_URL ?? "http://127.0.0.1:8089").replace(/\/$/, "");
const isLocal = (u: string) => /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(u.replace(/\/$/, ""));
async function localFga() {
  const file = join(BRAIN, "rules", "fga.yaml");
  const cur = existsSync(file) ? YAML.parse(readFileSync(file, "utf8")) as { api_url?: string; store_id?: string } : undefined;
  if (!args.includes("--local-fga") && !(cur?.api_url && isLocal(cur.api_url))) return;
  const url = cur?.api_url && isLocal(cur.api_url) ? cur.api_url.replace(/\/$/, "") : LOCAL_FGA;
  const up = await fetch(`${url}/healthz`).then((r) => r.ok, () => false);
  if (!up) {
    rmSync(file, { force: true });
    say(`FGA: no OpenFGA answering at ${url}; FGA is OFF for this take (start it: docs/video-kit.md, step 9)`);
    return;
  }
  let store = cur?.store_id && isLocal(cur.api_url ?? "") ? cur.store_id : undefined;
  if (store && !(await fetch(`${url}/stores/${store}`).then((r) => r.ok, () => false))) store = undefined;
  if (!store) {
    const r = await fetch(`${url}/stores`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "pocketbrain-video" }) });
    if (!r.ok) throw new Error(`OpenFGA: creating the store failed (HTTP ${r.status})`);
    store = ((await r.json()) as { id: string }).id;
    const model_id = await new FgaClient({ api_url: url, store_id: store }).writeModel();
    // Checked every 3 seconds, so a relationship deleted on camera shows on the next answer.
    writeFileSync(file, YAML.stringify({ api_url: url, store_id: store, model_id, refresh_s: 3, max_age_s: 60 }));
    mkdirSync(join(KEEP, "rules"), { recursive: true });
    cpSync(file, join(KEEP, "rules", "fga.yaml"));
    say(`FGA: local OpenFGA at ${url}, new store ${store} with the pocketBrain model (kept for later takes)`);
  } else say(`FGA: local OpenFGA at ${url}, store ${store}`);
}

async function rebuild() {
  rmSync(BRAIN, { recursive: true, force: true });
  mkdirSync(BRAIN, { recursive: true });
  // Only the sample's rules (checks, RULES.md); the notes are Robin's work brain, all in examples/video.
  cpSync(join(APP, "examples", "brain", "rules"), join(BRAIN, "rules"), { recursive: true });
  overlay(join(APP, "examples", "video", "rules"), join(BRAIN, "rules"));
  overlay(join(APP, "examples", "video", "brain"), BRAIN);
  git(BRAIN, ["init", "-q", "-b", "main"]);
  git(BRAIN, ["add", "-A"]);
  git(BRAIN, ["commit", "-q", "-m", "Robin's video brain"]);

  // Same tokens every take: restore the kept hashes, or issue them once and keep them.
  mkdirSync(TOKENS, { recursive: true }); chmodSync(TOKENS, 0o700);
  for (const f of KEPT) if (existsSync(join(KEEP, f))) cpSync(join(KEEP, f), join(BRAIN, f));
  // Offboarding on camera: ask Auth0 about coworkers every 5 seconds, so blocking Alice cuts her
  // assistant within one breath instead of 30 seconds (kept files may set their own value).
  const ofile = join(BRAIN, "rules", "oauth.yaml");
  if (existsSync(ofile)) {
    const odoc = YAML.parseDocument(readFileSync(ofile, "utf8"));
    if (odoc.get("coworkers") && odoc.get("coworker_check_s") === undefined) { odoc.set("coworker_check_s", 5); writeFileSync(ofile, odoc.toString({ lineWidth: 0 })); }
  }
  const have = existsSync(join(BRAIN, "rules/tokens.yaml")) ? Object.keys(YAML.parse(readFileSync(join(BRAIN, "rules/tokens.yaml"), "utf8"))?.agents ?? {}) : [];
  let issued = false;
  for (const a of PASTED) {
    if (have.includes(a) && existsSync(join(TOKENS, `${a}.txt`))) continue;
    writeFileSync(join(TOKENS, `${a}.txt`), issueToken(BRAIN, a) + "\n", { mode: 0o600 });
    say(`new token for ${a}: ${join(TOKENS, `${a}.txt`)} (paste it into ${a === "town" ? "Town's connector" : a === "claude-code" ? "Claude Code's MCP config" : a === "robin" ? "nothing; the reset uses it for Robin's board-deck agent's receipts" : a === "alice" ? "nothing; the film's \"Alice's script\" shot uses it" : "nothing; the replay uses it"})`);
    issued = true;
  }
  // Ask to see: the Guardian settings name the owner's Auth0 account, so they live in keep/, not in
  // the repo. Without them, approval is the dashboard's Allow once button. Retakes need headroom.
  const ats = join(KEEP, "ask-to-see.yaml");
  const pfile = join(BRAIN, "rules", "policy.yaml");
  const pdoc = YAML.parseDocument(readFileSync(pfile, "utf8"));
  const cur = (pdoc.toJS() as { ask_to_see?: Record<string, unknown> }).ask_to_see;
  const kept = existsSync(ats) ? YAML.parse(readFileSync(ats, "utf8")) as Record<string, unknown> : {};
  // The kept file adds to the video policy's never-list; it can't make deals or comp askable.
  const never = [...new Set([...((cur?.never as string[]) ?? []), ...((kept.never as string[]) ?? [])])];
  if (cur || existsSync(ats)) pdoc.set("ask_to_see", pdoc.createNode({ ...cur, ...kept, ...(never.length ? { never } : {}), max_per_day: 50 }));
  writeFileSync(pfile, pdoc.toString({ lineWidth: 0 }));
  git(BRAIN, ["add", "-A"]);
  git(BRAIN, ["commit", "-q", "--allow-empty", "-m", "access for the video"]);
  if (issued) saveAccess();

  // Last night: the gardener runs at 03:40, inside its hours: upkeep (a duplicate meeting write-up),
  // one fix and one stale decision to retire, all proposals.
  const tz = timezoneOf(loadRules(BRAIN));
  const night = at(day(-1), 3, 40, tz);
  const g = await gardenerSignIn();
  const gcall = (tool: string, a: Record<string, unknown> = {}) => call("gardener", g.token, tool, a, g.path);
  const plan = YAML.parse(readFileSync(join(APP, "examples", "video", "gardener-night.yaml"), "utf8")) as {
    upkeep?: boolean;
    proposals?: { id: string; attribute: string; value: string; sources: string[]; reason: string }[];
    retire?: { id: string; attribute: string; as_of: string; sources: string[]; reason: string }[];
  };
  process.env.PB_NOW = night.toISOString();
  const label = localTime(night, tz).label;
  say(`gardener, ${label}: signed in with ${g.how}`);
  await gcall("context_pack");
  if (plan.upkeep) {
    const r = await gcall("upkeep_run");
    let found = r.text.slice(0, 160);
    try { const j = JSON.parse(JSON.parse(r.text).result.content[0].text) as { findings: { rule: string; key: string }[] }; found = j.findings.map((f) => `${f.rule} ${f.key}`).join("; ") || "nothing"; } catch { /* keep the raw text */ }
    say(`gardener, ${label}: upkeep found ${found}`);
  }
  for (const p of plan.proposals ?? []) {
    const r = await gcall("remember", { id: p.id, attribute: p.attribute, value: dated(p.value), as_of: day(-1), sources: p.sources, verification: "verified-by-source" });
    say(`gardener, ${label}: ${p.id} ${p.attribute} -> ${outcome(r.text)}`);
  }
  for (const p of plan.retire ?? []) {
    const r = await gcall("retire", { id: p.id, attribute: p.attribute, as_of: dated(p.as_of), sources: p.sources, verification: "verified-by-source" });
    say(`gardener, ${label}: retire ${p.id} ${p.attribute} -> ${outcome(r.text)}`);
  }

  if (args.includes("--no-tripwire")) say("gardener: no daytime attempt this take (--no-tripwire)");
  else await daytime();

  // Robin's own board-deck agent did its one task: the Activity page keeps its receipts.
  const rtok = readFileSync(join(TOKENS, "robin.txt"), "utf8").trim();
  await call("robin", rtok, "search", { query: "board deck" });
  for (const id of ["projects/board-prep", "notes/exec-staff", "projects/fy27-plan"]) await call("robin", rtok, "read", { id });
  say("robin: board-deck agent searched once and read 3 notes (its receipts)");

  // Theo's Claude Code tries to pass the reorg to Maya's claude.ai, which only sees strategy. The relay holds it.
  const inc = join(BRAIN, "relay", "incoming");
  mkdirSync(inc, { recursive: true });
  const relay = YAML.parse(readFileSync(join(BRAIN, "rules", "relay.yaml"), "utf8"));
  writeFileSync(join(inc, "video-001.json"), JSON.stringify({ id: "video-001", from: relay.agents.town, to: [relay.relay_address.replace("@", "+claude@")], subject: "Org news for the board deck", text: "For the deck: Announce Monday: platform moves under Priya in January.", received_at: new Date().toISOString() }));
  for (const v of relayOnce(BRAIN, fileTransport(BRAIN))) say(`relay: ${v.sender} -> ${v.recipient}: ${v.deliver ? "delivered" : `held (${v.reasons.join("; ")})`}`);
  git(BRAIN, ["add", "-A"]);
  git(BRAIN, ["commit", "-q", "--allow-empty", "-m", "video: relay seed"]);

  // A local OpenFGA server (the open-source engine behind hosted FGA services) when there's no hosted tenant.
  await localFga();

  // A take that removed a slice in the FGA console left FGA short: write policy.yaml's tuples back.
  if (existsSync(join(BRAIN, "rules", "fga.yaml"))) {
    const r = Bun.spawnSync(["bun", "src/cli.ts", "fga", "sync", "--apply", "--brain", BRAIN], { cwd: APP, env: { ...process.env, PB_CONFIG_DIR: CONFIG } });
    say(r.exitCode === 0 ? "FGA: slices written back from policy" : `FGA: sync failed, fix before the FGA beat: ${r.stderr.toString().trim().slice(0, 200)}`);
  }
}

async function serve() {
  const out = openSync(LOG, "w");
  const p = Bun.spawn(["bun", "src/cli.ts", "serve", "--brain", BRAIN, "--port", String(PORT), "--dashboard", "--dashboard-port", String(DASH)], { cwd: APP, env: { ...process.env, PB_CONFIG_DIR: CONFIG }, stdout: out, stderr: out, stdin: "ignore" });
  p.unref();
  writeFileSync(PID, String(p.pid));
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* starting */ }
    await Bun.sleep(250);
  }
  await Bun.sleep(300);
  // The hub keeps its sign-in link in the brain's .git folder, never in its log (G609).
  const link = readLoginLink(BRAIN) ?? undefined;
  say(`\nvideo hub on http://127.0.0.1:${PORT} (pid ${p.pid}), log ${LOG}`);
  say(`dashboard: ${link ?? `no sign-in link kept yet; see ${LOG}`}`);
}

// Alice's account at Auth0 right now: a take that blocked her leaves her blocked for the next one.
async function aliceAtAuth0(alice: string | undefined): Promise<string> {
  const o = loadOAuth(BRAIN);
  const secret = process.env.AUTH0_MGMT_CLIENT_SECRET ?? (existsSync(join(KEYS, "AUTH0_MGMT_CLIENT_SECRET")) ? readFileSync(join(KEYS, "AUTH0_MGMT_CLIENT_SECRET"), "utf8").trim() : "");
  if (!o?.management_client_id || !secret || !alice) return "can't check (needs the management client with read:users, step 8)";
  try {
    const s = await lookUp(o, alice, await managementToken(o, secret), fetch);
    return s === "active" ? "active at Auth0" : `${s.toUpperCase()} at Auth0: unblock her in Auth0, User Management, before the take`;
  } catch (e) { return `can't check: ${(e as Error).message} (does the management app have read:users?)`; }
}

async function checklist() {
  const o = loadOAuth(BRAIN);
  const bound = Object.entries(o?.clients ?? {}).filter(([, c]) => c.agent === "claude");
  say("\nbefore you roll:");
  say(`  Auth0 door: ${o ? `${o.resource}` : "not set up on the video brain (docs/video-kit.md, step 3)"}`);
  say(`  claude.ai: ${bound.length ? `bound (${bound.map(([id]) => id).join(", ")})` : "not bound yet; connect it, ask it one question, then run --bind-claude"}`);
  const coworkers = (o as unknown as { coworkers?: Record<string, { agent?: string; clients?: unknown }> })?.coworkers ?? {};
  const alice = Object.values(coworkers).find((c) => c.agent === "alice");
  say(`  Alice (coworker): ${!alice ? "not added yet (docs/video-kit.md, step 7)" : Object.keys((alice.clients ?? {}) as object).length ? "added and bound" : "added, not bound yet (step 7)"}`);
  if (alice) say(`  Alice leaving (offboarding): ${await aliceAtAuth0(Object.entries(coworkers).find(([, c]) => c.agent === "alice")?.[0])}`);
  say(`  Revoke reaching Auth0: ${(o as unknown as { management_client_id?: string })?.management_client_id ? "management client set" : "not set; Revoke only cuts locally"}${process.env.AUTH0_MGMT_CLIENT_SECRET || existsSync(join(KEYS, "AUTH0_MGMT_CLIENT_SECRET")) ? "" : " (no AUTH0_MGMT_CLIENT_SECRET key)"}`);
  const ask = (loadRules(BRAIN).policy as unknown as { ask_to_see?: { approver?: string } }).ask_to_see;
  say(`  Ask to see: ${!ask ? "off" : ask.approver === "guardian" ? `phone push${existsSync(join(KEYS, "AUTH0_CIBA_CLIENT_SECRET")) || process.env.AUTH0_CIBA_CLIENT_SECRET ? "" : " (no AUTH0_CIBA_CLIENT_SECRET key)"}` : "dashboard button (no keep/ask-to-see.yaml)"}`);
  say(`  FGA: ${existsSync(join(BRAIN, "rules", "fga.yaml")) ? "on" : "off (docs/fga.md; then --save-access)"}`);
  say(`  Town and Claude Code: tokens in ${TOKENS}, the same every take`);
  say("  your own pocketbrain connector in claude.ai and Town: OFF for the take");
}

mkdirSync(KEYS, { recursive: true }); chmodSync(KEYS, 0o700);
if (args.includes("--stop")) { stop(); process.exit(0); }
if (args.includes("--save-access")) { saveAccess(); process.exit(0); }
if (args.includes("--tripwire")) { await daytime(); process.exit(0); }
if (args.includes("--bind-claude")) {
  const p = listPending(BRAIN).sort((a, b) => b.last_seen.localeCompare(a.last_seen))[0];
  if (!p) { console.error("no waiting connection: in claude.ai, connect the video connector and ask it one question first"); process.exit(1); }
  bindClient(BRAIN, p.client_id, "claude", "claude.ai");
  saveAccess();
  say(`${p.client_id} now connects as claude (claude.ai), and stays bound after every reset`);
  process.exit(0);
}
stop();
await rebuild();
if (!args.includes("--no-serve")) await serve();
await checklist();
say(`\nreset done: ${BRAIN}`);
process.exit(0);
