// SPDX-License-Identifier: AGPL-3.0-only
// Full-stack regression: a real hub process (`pocketbrain serve`) on a copy of the fictional sample
// brain, and one fake assistant through each door the owner's real assistants use:
//   mcp      a pasted bearer token on /mcp (how Town connects)                 agent planner
//   browser  the /b sign-in form a vault fills (how Instinct connects)        agent helper
//   oauth    /mcp/oauth with DCR + PKCE against a stand-in AS (how Muse does)  agent muse, added with `add --door oauth`
//   local    `add --door local`, then /mcp on 127.0.0.1 (how Claude Code does) agent laptop
// Each door runs the same golden path: read, write, held write, hidden-fact refusal, paused, revoked.
// The owner's side goes through the CLI where the owner would use it (add, connect, token --revoke)
// and the dashboard's own function for pause. Then the free switch-day check runs.
// Every step's answer is compared with test/e2e/doors.json; any change fails.
//   bun scripts/e2e.ts                 run and compare
//   PB_E2E_UPDATE=1 bun scripts/e2e.ts rewrite test/e2e/doors.json after a wanted change (read the diff)
// Never the real brain: the brain is a temp copy of examples/brain.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupOAuth, clearJwksCache } from "../src/oauth";
import { setAgentStatus, runAction } from "../src/dashboard/actions";
import { startFakeAS, connect } from "../test/fake-as";
import { loadBrain, saveNote } from "../src/brain";
import { quiz } from "../src/memsync";
import { forbiddenFor, findLeaks } from "../evals/lib/oracle";

const APP = join(import.meta.dir, "..");
const SNAPSHOT = join(APP, "test", "e2e", "doors.json");
const TODAY = "2026-10-08";
export type Door = "mcp" | "browser" | "oauth" | "local";
export const DOORS: Door[] = ["mcp", "browser", "oauth", "local"];
export const STEPS = ["read", "write", "held", "hidden", "g74", "paused", "resumed", "revoked"] as const;
// `notes`: every note id the answer names, so a read that starts showing (or stops showing) a note
// fails even when the first lines of the answer stay the same.
export interface Step { step: string; status: number; says: string; notes?: string[] }
// A new note's id may end in a random 6-hex suffix (notes/garden-plan-planner-e77eee): masked.
const idSuffix = (s: string) => s.replace(/(\b(?:people|projects|money|decisions|notes|orgs)\/[a-z0-9-]+-)[0-9a-f]{6}\b/g, "$1HASH");
export const noteIds = (s: string) => [...new Set(idSuffix(s).match(/\b(?:people|projects|money|decisions|notes|orgs)\/[a-z0-9-]+(?:HASH)?/g) ?? [])].sort();

// What changes from run to run is masked; everything else is the answer.
export function normalize(s: string): string {
  return idSuffix(s)
    .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:PORT")
    .replace(/\bpb_[A-Za-z0-9_-]{8,}/g, "pb_TOKEN")
    .replace(/\bclient_[A-Za-z0-9_-]{6,}/g, "client_ID")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?\b/g, "TIMESTAMP")
    .replace(/\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, "HASH")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

// Differences between the saved and the new answers, one line each.
export function compare(want: Record<string, Step[]>, got: Record<string, Step[]>): string[] {
  const out: string[] = [];
  for (const door of new Set([...Object.keys(want), ...Object.keys(got)])) {
    const a = want[door] ?? [], b = got[door] ?? [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i], y = b[i];
      const show = (s?: Step) => s ? `${s.status} "${s.says}" notes [${(s.notes ?? []).join(", ")}]` : "(none)";
      if (JSON.stringify(x) !== JSON.stringify(y)) out.push(`${door} ${y?.step ?? x?.step}: saved ${show(x)}\n    now   ${show(y)}`);
    }
  }
  return out;
}

// What must hold on every door whatever the saved answers say, so a leak can't be saved as the
// new normal with PB_E2E_UPDATE=1.
export function invariants(got: Record<string, Step[]>): string[] {
  const out: string[] = [];
  for (const [door, steps] of Object.entries(got)) {
    const by = Object.fromEntries(steps.map((x) => [x.step, x]));
    if (by.read?.notes?.includes("money/main-bank")) out.push(`${door} read: shows the hidden note money/main-bank`);
    if (by.hidden && !/no note money\/main-bank in your view/.test(by.hidden.says)) out.push(`${door} hidden: not refused (${by.hidden.says})`);
    if (by.g74 && /^LEAKS/.test(by.g74.says)) out.push(`${door} g74: memory sync hands over ${by.g74.says.slice(7)}`);
    if (by.paused && by.paused.status !== 403) out.push(`${door} paused: answered ${by.paused.status}, not 403`);
    if (by.revoked && by.revoked.status !== 401) out.push(`${door} revoked: answered ${by.revoked.status}, not 401`);
  }
  return out;
}

function sh(args: string[], env: Record<string, string>, cwd = APP) {
  const r = Bun.spawnSync(["bun", "src/cli.ts", ...args], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function sampleBrain(): string {
  const root = mkdtempSync(join(tmpdir(), "pb-e2e-"));
  cpSync(join(APP, "examples", "brain"), root, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: "robin", GIT_AUTHOR_EMAIL: "r@x", GIT_COMMITTER_NAME: "robin", GIT_COMMITTER_EMAIL: "r@x", GIT_AUTHOR_DATE: `${TODAY}T12:00:00Z`, GIT_COMMITTER_DATE: `${TODAY}T12:00:00Z` };
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "sample brain"]]) Bun.spawnSync(["git", ...a], { cwd: root, env });
  return root;
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const p = s.port!; s.stop(true); return p;
}

// One assistant's session on one door: the same five calls, whatever the door.
interface Client {
  context(topic: string): Promise<Step>;
  read(id: string): Promise<Step>;
  remember(fact: Record<string, unknown>): Promise<Step>;
  // memory_check and the change feed, raw (the leak oracle reads all of it), and a quiz answer.
  memory(): Promise<{ status: number; raw: string }>;
  answer(id: string, text: string): Promise<{ status: number; raw: string }>;
}

function mcpClient(base: string, path: string, token: () => string): Client {
  let id = 0;
  const tool = async (name: string, args: Record<string, unknown>) => {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token()}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) });
    const text = await r.text();
    let j: any; try { j = JSON.parse(text); } catch { j = undefined; }
    const body = j?.result?.content?.[0]?.text ?? j?.error?.message ?? j?.error_description ?? j?.error ?? text;
    return { status: r.status, says: `${j?.result?.isError ? "error: " : ""}${normalize(String(body))}`, notes: noteIds(String(body)), raw: String(body) };
  };
  return {
    context: async (topic) => ({ step: "", ...pick(await tool("context_pack", { topic })) }),
    read: async (nid) => ({ step: "", ...pick(await tool("read", { id: nid })) }),
    remember: async (fact) => ({ step: "", ...pick(await tool("remember", fact)) }),
    memory: async () => {
      const [m, w] = [await tool("memory_check", {}), await tool("whats_new", {})];
      return { status: Math.max(m.status, w.status), raw: `${m.raw}\n${w.raw}` };
    },
    answer: async (qid, text) => { const r = await tool("memory_check_reply", { answers: [{ id: qid, answer: text }] }); return { status: r.status, raw: r.raw }; },
  };
}

async function browserClient(base: string, agent: string, key: string): Promise<Client> {
  const login = await fetch(`${base}/b/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ agent, password: key }) });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const page = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(base + path, { redirect: "manual", ...init, headers: { cookie, ...(init.headers ?? {}) } });
    const html = await r.text();
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    return { status: r.status, html, raw: text, says: normalize(text.replace(/^[\s\S]*?(Result:)/, "$1")), notes: noteIds(text) };
  };
  return {
    context: async (topic) => ({ step: "", ...pick(await page(`/b/context?topic=${encodeURIComponent(topic)}`)) }),
    read: async (id) => ({ step: "", ...pick(await page(`/b/notes/${id}`)) }),
    remember: async (fact) => {
      const form = await page("/b/remember");
      const csrf = form.html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
      const fields: Record<string, string> = { csrf };
      for (const [k, v] of Object.entries(fact)) fields[k] = Array.isArray(v) ? v.join(" ") : String(v);
      return { step: "", ...pick(await page("/b/remember", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) })) };
    },
    memory: async () => {
      const [m, w] = [await page("/b/memory-check"), await page("/b/changes")];
      return { status: Math.max(m.status, w.status), raw: `${m.raw}\n${w.raw}` };
    },
    answer: async (qid, text) => {
      const form = await page("/b/memory-check");
      const csrf = form.html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
      const r = await page("/b/memory-check", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, [`a:${qid}`]: text }) });
      return { status: r.status, raw: r.raw };
    },
  };
}
const pick = (p: { status: number; says: string; notes: string[]; raw?: string }) => ({ status: p.status, says: p.says, notes: p.notes });

// G74 (red team 1015b, beliefs #1): a fact the agent sees, whose value carries a carved value and a
// link to a hidden note, is shown scrubbed on reads. Memory sync must not hand it over raw: the
// agent answers a quiz with the old value, the owner runs `beliefs fix`, and neither the correction
// in memory_check nor the change feed may hold a value outside the agent's slice or the hidden id.
const KEY = "people/jane-roy#role";
async function g74(c: Client, agent: string, root: string, env: Record<string, string>): Promise<Step> {
  await c.memory(); // the change feed's baseline
  const jane = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
  const role = (jane.fm.facts as any).role;
  (jane.fm.history as any) = { ...(jane.fm.history ?? {}), role: [{ ...role, value: "Teaching assistant", as_of: "2026-06-01" }] };
  role.value = `Course coordinator for ${agent}, paid via Maple Trust Bank, see [[money/main-bank]]`;
  saveNote(root, jane);
  Bun.spawnSync(["git", "commit", "-qam", `owner: jane's role (${agent})`], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "robin", GIT_AUTHOR_EMAIL: "r@x", GIT_COMMITTER_NAME: "robin", GIT_COMMITTER_EMAIL: "r@x" } });
  const keep = process.env.PB_CONFIG_DIR;
  process.env.PB_CONFIG_DIR = env.PB_CONFIG_DIR;
  try { const [q] = quiz(root, agent, 1, [KEY]); if (q) await c.answer(q.id, "Teaching assistant"); }
  finally { if (keep === undefined) delete process.env.PB_CONFIG_DIR; else process.env.PB_CONFIG_DIR = keep; }
  const fix = sh(["beliefs", "fix", KEY, "--brain", root], env);
  const got = await c.memory();
  const leaks = [...findLeaks(got.raw, await forbiddenFor(root, agent)).map((l) => `${l.from} (${l.how})`), ...(/money\/main-bank/.test(got.raw) ? ["hidden id money/main-bank"] : [])];
  return { step: "", status: got.status, says: leaks.length ? `LEAKS: ${[...new Set(leaks)].sort().join(", ")}` : `no withheld value or hidden id (beliefs fix exit ${fix.code})`, notes: noteIds(got.raw).filter((n) => n !== "money/main-bank") };
}

// The golden path. The owner's pause and revoke act on the hub's brain from outside, as they would.
async function golden(c: Client, agent: string, root: string, env: Record<string, string>): Promise<Step[]> {
  const out: Step[] = [];
  const at = (step: string, s: Step) => out.push({ ...s, step });
  at("read", await c.context("course"));
  at("write", await c.remember({ id: "projects/course-a", attribute: "e2e_check", value: `checked by ${agent}`, as_of: TODAY, sources: ["gmail:f0000000000000e2"] }));
  // The held write: a fact on a private note waits for the owner at every door (since G422 a core
  // assistant's note outside its area files itself, so area ownership alone no longer holds it).
  at("held", await c.remember({ title: `Garden plan ${agent}`, type: "note", area: "personal", sensitivity: "private", attribute: "plan", value: "tomatoes in May", as_of: TODAY, sources: ["gmail:f0000000000000e3"] }));
  at("hidden", await c.read("money/main-bank"));
  at("g74", await g74(c, agent, root, env));
  setAgentStatus(root, agent, "paused");
  at("paused", await c.context("course"));
  setAgentStatus(root, agent, "active");
  at("resumed", await c.context("course"));
  const rv = sh(["token", "--revoke", agent, "--brain", root], env);
  if (rv.code !== 0) throw new Error(`token --revoke ${agent}: ${rv.err}`);
  at("revoked", await c.context("course"));
  return out;
}

export async function runE2E(o: { log?: (s: string) => void } = {}): Promise<Record<Door, Step[]>> {
  const log = o.log ?? (() => {});
  const root = sampleBrain();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { PB_TODAY: TODAY, PB_CONFIG_DIR: mkdtempSync(join(tmpdir(), "pb-e2e-config-")) };
  const as = startFakeAS("auth0|robin", { auth0: true, reuseGraceMs: 2000 });
  clearJwksCache();
  setupOAuth(root, { issuer: as.issuer, resource: `${base}/mcp/oauth`, owner_subject: "auth0|robin", jwks_uri: `${as.issuer}jwks` });
  const hub = Bun.spawn(["bun", "src/cli.ts", "serve", "--brain", root, "--port", String(port)], { cwd: APP, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  try {
    for (let i = 0; ; i++) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* starting */ }
      if (i > 100) throw new Error("the hub didn't answer /health");
      await Bun.sleep(100);
    }
    const res = {} as Record<Door, Step[]>;
    const token = (args: string[]) => {
      const r = sh([...args, "--brain", root], env);
      const t = (r.out + r.err).match(/pb_[A-Za-z0-9_-]{8,}/)?.[0];
      if (!t) throw new Error(`no token from ${args.join(" ")}: ${r.out}${r.err}`);
      return t;
    };

    log("door mcp (planner, pasted bearer)");
    // planner is core tier: the terminal needs the owner's one-time code from the dashboard (G184).
    const otc = runAction({ root }, "token-code", { agent: "planner" }).match(/[0-9A-Z]{5}-[0-9A-Z]{5}/)![0];
    const tPlanner = token(["token", "--agent", "planner", "--code", otc]);
    res.mcp = await golden(mcpClient(base, "/mcp", () => tPlanner), "planner", root, env);

    log("door browser (helper, /b sign-in)");
    const key = token(["connect", "helper", "--browser", "--key-only"]);
    res.browser = await golden(await browserClient(base, "helper", key), "helper", root, env);

    log("door oauth (muse, DCR + PKCE)");
    const add = sh(["add", "muse", "--slices", "area:work,contacts-basic", "--door", "oauth", "--url", base, "--yes", "--brain", root], env);
    if (add.code !== 0) throw new Error(`add muse: ${add.out}${add.err}`);
    const m = await connect((p, init) => fetch(base + p, init), `${base}/mcp/oauth`, { dcr: { client_name: "Muse", redirect_uri: "https://muse.example/oauth/callback" } });
    res.oauth = await golden(mcpClient(base, "/mcp/oauth", m.token), "muse", root, env);

    log("door local (laptop, add --door local)");
    const tLocal = token(["add", "laptop", "--slices", "area:work,contacts-basic", "--door", "local", "--port", String(port), "--yes"]);
    res.local = await golden(mcpClient(base, "/mcp", () => tLocal), "laptop", root, env);
    return res;
  } finally {
    hub.kill();
    as.stop();
  }
}

// The free switch-day check: the invite works and all 20 day-one answers are in the new assistant's slice.
export function switchDay(): { ok: boolean; says: string } {
  const r = Bun.spawnSync(["bun", "evals/run.ts", "--only", "switchday"], { cwd: APP, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString() + r.stderr.toString();
  const line = out.split("\n").find((l) => /switchday-reachable/.test(l)) ?? out.split("\n").filter(Boolean).at(-1) ?? "";
  return { ok: r.exitCode === 0 && /switchday-reachable/.test(out), says: line.trim() };
}

async function main(): Promise<number> {
  const got = await runE2E({ log: (s) => console.log(s) });
  const sd = switchDay();
  console.log(`switch day (free): ${sd.ok ? "pass" : "FAIL"} ${sd.says}`);
  const broken = invariants(got);
  for (const b of broken) console.log(`✗ ${b}`);
  if (process.env.PB_E2E_UPDATE === "1") {
    if (broken.length) { console.log("E2E FAILED: not saving answers that break an invariant"); return 1; }
    mkdirSync(join(APP, "test", "e2e"), { recursive: true });
    writeFileSync(SNAPSHOT, JSON.stringify(got, null, 2) + "\n");
    console.log(`wrote ${SNAPSHOT}; read the diff before committing`);
    return sd.ok ? 0 : 1;
  }
  if (!existsSync(SNAPSHOT)) { console.log("no saved answers: run PB_E2E_UPDATE=1 bun scripts/e2e.ts and commit test/e2e/doors.json"); return 1; }
  const diffs = compare(JSON.parse(readFileSync(SNAPSHOT, "utf8")), got);
  for (const d of diffs) console.log(`✗ ${d}`);
  const steps = Object.values(got).reduce((n, s) => n + s.length, 0);
  const bad = diffs.length || broken.length || !sd.ok;
  console.log(bad ? `E2E FAILED: ${diffs.length} answer(s) changed, ${broken.length} invariant(s) broken${sd.ok ? "" : ", switch day failed"} (a wanted change: PB_E2E_UPDATE=1 bun scripts/e2e.ts)` : `E2E PASSED: ${DOORS.length} doors, ${steps} steps, switch day`);
  return bad ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
