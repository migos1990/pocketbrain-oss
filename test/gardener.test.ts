// SPDX-License-Identifier: AGPL-3.0-only
// The gardener (docs/gardener.md): one outside agent with role: gardener. It reads everything,
// only proposes, has its own door (upkeep, forgetting, changes), a proposal cap, hours, and is
// left out of the use signal and the scorecard. The hub drives its Anthropic side through `ant`.
import { test, expect, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken, tokenInfo } from "../src/auth";
import { loadRules } from "../src/rules";
import { loadBrain } from "../src/brain";
import { appendChained } from "../src/readlog";
import { sleep } from "../src/sleep";
import { measures, week } from "../src/measure";
import { openWindow, nightPlan, recordRun, cleanup, rotate, parseWindow, inWindows } from "../src/gardener";
import { sha256 } from "../src/util";
import { tendOnce } from "../src/start";
import { jobChecks, record } from "../src/probe";
import { openItems } from "../src/textline/items";

// 2026-10-08 is a Thursday. 07:30Z is 03:30 in Toronto (in the nightly window); 16:00Z is noon.
const IN = "2026-10-08T07:30:00Z", OUT = "2026-10-08T16:00:00Z";
const SRC = { as_of: "2026-10-07", sources: ["gmail:f000000000000006"], verification: "verified-by-source" };
afterEach(() => { delete process.env.PB_NOW; });

async function call(root: string, token: string, method: string, path: string, body?: unknown) {
  const res = await handle(root, new Request(`http://pb${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${token}` } }));
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { /* markdown */ }
  return { status: res.status, text, json };
}
async function mcp(root: string, token: string, method: string, params: Record<string, unknown> = {}) {
  return (await call(root, token, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method, params })).json;
}
const policy = (root: string) => YAML.parse(readFileSync(join(root, "rules/policy.yaml"), "utf8"));

test("a gardener must stay an outside agent with no say: never inside the wall, the resolver or an area owner", () => {
  for (const [patch, why] of [
    [(p: any) => { p.agents.gardener.inside_wall = true; }, "inside_wall"],
    [(p: any) => { p.resolver = "gardener"; }, "resolver"],
    [(p: any) => { p.areas.work.owner = "gardener"; }, "own an area"],
  ] as [(p: any) => void, string][]) {
    const root = makeBrain();
    const p = policy(root);
    patch(p);
    writeFileSync(join(root, "rules/policy.yaml"), YAML.stringify(p));
    expect(() => loadRules(root)).toThrow(why);
  }
});

test("the gardener reads the whole brain, private included, and its writes are proposals", async () => {
  const root = makeBrain();
  process.env.PB_NOW = IN;
  const tok = issueToken(root, "gardener");
  const ctx = await call(root, tok, "GET", "/v1/context");
  expect(ctx.status).toBe(200);
  for (const n of loadBrain(root)) expect(ctx.text).toContain(n.fm.title);
  expect(ctx.text).toContain("Maple Trust Bank"); // the private money note
  const w = await call(root, tok, "POST", "/v1/remember", { id: "projects/course-a", attribute: "next_step", value: "Publish grades", ...SRC });
  expect(w.json.outcome).toBe("inbox");
  const o = await call(root, tok, "GET", "/v1/orientation");
  expect(o.text).toContain("## Your job: the gardener");
  expect(o.text).toContain("At most 13 proposals in 24 hours; you have made 1");
});

test("the 14th proposal in 24 hours is refused", async () => {
  const root = makeBrain();
  process.env.PB_NOW = IN;
  const tok = issueToken(root, "gardener");
  for (let i = 1; i <= 13; i++) {
    const r = await call(root, tok, "POST", "/v1/remember", { id: "projects/course-a", attribute: `step_${i}`, value: `Step ${i}`, ...SRC });
    expect(r.json.outcome).toBe("inbox");
  }
  const r = await call(root, tok, "POST", "/v1/remember", { id: "projects/course-a", attribute: "step_14", value: "Step 14", ...SRC });
  expect(r.status).toBe(422);
  expect(r.json.message).toBe("proposal cap reached (13 a day); try again tomorrow");
  expect(readdirSync(join(root, "inbox")).filter((f) => f.includes("gardener"))).toHaveLength(13);
  // Another agent isn't capped.
  expect((await call(root, issueToken(root, "helper"), "POST", "/v1/remember", { id: "projects/course-a", attribute: "next_step", value: "Step 15", ...SRC })).json.outcome).toBe("inbox");
}, 20_000); // 15 committed writes; near 5 s under the full suite

test("upkeep_run, sleep_run, changes_since and last_run are the gardener's alone", async () => {
  const root = makeBrain();
  process.env.PB_NOW = IN;
  const g = issueToken(root, "gardener"), town = issueToken(root, "planner");
  // Town-like agents: 403 on the routes, a tool error and no listing over MCP.
  for (const [m, p] of [["POST", "/v1/gardener/upkeep"], ["POST", "/v1/gardener/sleep"], ["GET", "/v1/gardener/changes"], ["GET", "/v1/gardener/last"]]) expect((await call(root, town, m, p)).status).toBe(403);
  expect((await mcp(root, town, "tools/list")).result.tools.map((t: any) => t.name)).not.toContain("upkeep_run");
  expect((await mcp(root, town, "tools/call", { name: "upkeep_run", arguments: {} })).result.isError).toBe(true);

  expect((await call(root, g, "GET", "/v1/gardener/last")).json).toEqual({ at: null, run: null, proposals: [], decided: [], waiting: 0, conflicts_to_weigh: 0, wiki_missing: ["people/jane-roy", "people/paul-advisor", "projects/course-a", "money/main-bank"], wiki_missing_total: 4 });
  expect((await mcp(root, g, "tools/list")).result.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["upkeep_run", "sleep_run", "changes_since", "last_run"]));
  const before = await call(root, town, "POST", "/v1/remember", { id: "people/jane-roy", attribute: "role", value: "Dean", ...SRC });
  expect(before.json.outcome).toBe("committed");
  await Bun.sleep(1100); // git dates are to the second
  const u = await call(root, g, "POST", "/v1/gardener/upkeep");
  expect(u.status).toBe(200);
  expect(u.json.run).toMatch(/^reflect-/);
  const s = await mcp(root, g, "tools/call", { name: "sleep_run", arguments: {} });
  expect(JSON.parse(s.result.content[0].text)).toMatchObject({ retired: [], waiting: expect.any(Number) });

  expect((await call(root, town, "POST", "/v1/remember", { id: "projects/course-a", attribute: "next_step", value: "Publish grades", ...SRC })).json.outcome).toBe("committed");
  const ch = await call(root, g, "GET", `/v1/gardener/changes?since=${u.json.run}`);
  const ids = ch.json.changes.map((c: any) => c.id);
  expect(ids).toContain("projects/course-a");
  expect(ids).not.toContain("people/jane-roy"); // committed before the run
  expect(ch.json.changes.find((c: any) => c.id === "projects/course-a")).toMatchObject({ attrs_changed: ["next_step"], by: "planner" });
  expect(ch.json.changes[0].markdown).toContain("Publish grades");
  // Default: since its last upkeep_run.
  expect((await call(root, g, "GET", "/v1/gardener/changes")).json.changes.map((c: any) => c.id)).toEqual(ids);

  await call(root, g, "POST", "/v1/remember", { id: "people/jane-roy", attribute: "role", value: "Provost", ...SRC });
  const last = (await call(root, g, "GET", "/v1/gardener/last")).json;
  expect(last.run).toBe(u.json.run);
  expect(last.proposals).toEqual(["people/jane-roy"]);
  const ops = readFileSync(join(root, "log/reads.jsonl"), "utf8").split("\n").filter((l) => l.includes('"gardener"')).map((l) => JSON.parse(l).op);
  expect(ops).toEqual(expect.arrayContaining(["upkeep_run", "sleep_run", "changes_since", "last_run"]));
});

test("a note read only by the gardener is still forgotten; it stays out of the scorecard's reads", async () => {
  const root = makeBrain();
  appendChained(join(root, "log/reads.jsonl"), { at: "2027-01-01T09:00:00.000Z", agent: "planner", op: "search", ids: ["people/jane-roy"] });
  appendChained(join(root, "log/reads.jsonl"), { at: "2027-05-20T09:00:00.000Z", agent: "gardener", op: "read", ids: ["projects/course-a"] });
  process.env.PB_TODAY = "2027-06-01";
  expect((await sleep(root, { now: "2027-06-01" })).retired.map((x) => x.key)).toEqual(["projects/course-a#next_step"]);
  const [m] = measures(root, ["2027-05-20"]);
  expect(m.reads.gardener).toBeUndefined();
  process.env.PB_TODAY = "2026-10-08";
});

test("the scorecard keeps the gardener on its own line", async () => {
  const root = makeBrain();
  // The run is logged at PB_NOW and the proposal by the wall clock, so both go on today's date,
  // inside the gardener's hours (daily 03:25-05:00 Toronto). 08:30Z is 04:30 on summer time and
  // 03:30 on winter time, so it stays in the window on every day, the day the clocks change too
  // (G591: IN's 07:30Z was 02:30 on 2026-11-01, outside it, and the run was a tripwire trip).
  const day = new Date().toISOString().slice(0, 10);
  process.env.PB_NOW = `${day}T08:30:00Z`;
  const tok = issueToken(root, "gardener");
  await call(root, tok, "POST", "/v1/gardener/upkeep");
  await call(root, tok, "POST", "/v1/remember", { id: "projects/course-a", attribute: "next_step", value: "Publish grades", ...SRC });
  const w = week(root, day);
  expect(w.text).toMatch(/gardener: 1 runs, 1 proposals \(0 accepted, 0 rejected, 1 open\), 0 cap hits, 0 tripwire trips/);
  expect(w.verdicts.map((v) => v.measure)).not.toContain("gardener reads");
});

test("hours: outside them the token pauses the gardener, says nothing, and tells the owner; `gardener open` lets a manual run through", async () => {
  expect(parseWindow("mon-fri 08:00-09:00")!.days).toEqual([1, 2, 3, 4, 5]);
  expect(inWindows(["sat 23:00-01:00"], new Date("2026-10-11T04:30:00Z"), "America/Toronto")).toBe(true); // Sun 00:30
  const root = makeBrain();
  const tok = issueToken(root, "gardener");
  process.env.PB_NOW = IN;
  expect((await call(root, tok, "GET", "/v1/orientation")).status).toBe(200);

  process.env.PB_NOW = OUT;
  openWindow(root, "gardener", 60, new Date(OUT));
  const opened = await call(root, tok, "GET", "/v1/orientation");
  expect(opened.status).toBe(200); // the owner's manual run
  expect(opened.text).toContain("has opened a manual window for you until"); // so the gardener doesn't stop itself
  process.env.PB_NOW = "2026-10-08T17:01:00Z"; // the hour is over
  const reads = readFileSync(join(root, "log/reads.jsonl"), "utf8");
  const r = await call(root, tok, "GET", "/v1/context");
  expect(r.status).toBe(401);
  expect(r.text).toBe("unauthorized");
  expect(policy(root).agents.gardener.status).toBe("paused");
  expect(Bun.spawnSync(["git", "log", "-1", "--format=%an %s"], { cwd: root }).stdout.toString()).toContain("hub hub: gardener paused (tripwire");
  const alert = readFileSync(join(root, "log/alerts.jsonl"), "utf8");
  expect(alert).toContain("The gardener's token was used at 2026-10-08 13:01 (America/Toronto), outside its hours. Paused.");
  expect(alert).toContain("pocketbrain token --revoke gardener");
  expect(readFileSync(join(root, "log/reads.jsonl"), "utf8")).toBe(reads); // nothing read
  process.env.PB_NOW = IN;
  expect((await call(root, tok, "GET", "/v1/context")).status).toBe(403); // paused until the owner unpauses
  const m = measures(root, [new Date().toISOString().slice(0, 10)])[0]; // alerts carry the real time
  expect(m).toMatchObject({ leaks: 0, gardener: { trips: 1 } });
});

test("night: managed skips the hub's own upkeep and forgetting while the gardener is running, not after 36 hours of silence", () => {
  const root = makeBrain();
  expect(nightPlan(root).full).toBe(true); // local by default
  const p = policy(root);
  writeFileSync(join(root, "rules/policy.yaml"), YAML.stringify({ ...p, night: "managed" }));
  expect(nightPlan(root, new Date(IN))).toMatchObject({ full: true, why: "night: gardener silent 36h+, ran locally" });
  process.env.PB_NOW = "2026-10-07T07:30:00Z";
  recordRun(root, { agent: "gardener", op: "upkeep_run", run: "reflect-x" });
  expect(nightPlan(root, new Date(IN))).toMatchObject({ full: false });
  expect(nightPlan(root, new Date("2026-10-08T20:00:00Z"))).toMatchObject({ full: true }); // 36.5 h
  recordRun(root, { agent: "planner", op: "upkeep_run", run: "reflect-y" }); // not a gardener: doesn't count
  expect(nightPlan(root, new Date("2026-10-08T20:00:00Z")).full).toBe(true);
});

// ---------- the Anthropic side, against a fake `ant` on PATH ----------

function fakeAnt(opts: { failCreate?: boolean; listed?: string; failUpdate?: boolean } = {}) {
  const listed = opts.listed ?? '{"id":"vcrd_old","auth":{"type":"static_bearer","mcp_server_url":"https://brain.example/mcp"}}';
  const dir = mkdtempSync(join(tmpdir(), "pb-ant-"));
  const log = join(dir, "argv.log"), stdin = join(dir, "stdin.log");
  writeFileSync(join(dir, "ant"), `#!/bin/sh
echo "$* key=\${ANTHROPIC_API_KEY:-unset}" >> "${log}"
case "$*" in
  *"auth status"*) echo ok ;;
  *"beta:deployment-runs list"*) printf '{"id":"run1","session_id":"sesn_old"}\\n{"id":"run2","session_id":"sesn_busy"}\\n{"id":"run3","session_id":"sesn_young"}\\n' ;;
  *"retrieve --session-id sesn_old"*) echo '{"id":"sesn_old","status":"idle","stop_reason":{"type":"end_turn"},"updated_at":"2026-10-08T01:00:00Z"}' ;;
  *"retrieve --session-id sesn_busy"*) echo '{"id":"sesn_busy","status":"running","updated_at":"2026-10-08T01:00:00Z"}' ;;
  *"retrieve --session-id sesn_young"*) echo '{"id":"sesn_young","status":"terminated","updated_at":"2026-10-08T07:10:00Z"}' ;;
  *"beta:sessions delete"*) echo deleted ;;
  *"credentials list"*) ${listed ? `echo '${listed}'` : "true"} ;;
  *"credentials create"*) cat > "${stdin}"; ${opts.failCreate ? 'echo "vault says no" >&2; exit 1' : listed ? 'echo "POST /v1/vaults/vlt_1/credentials: 409 Conflict" >&2; exit 1' : 'echo vcrd_new'} ;;
  *"credentials update"*) cat > "${stdin}"; if [ -e "${dir}/fail-update" ]; then echo "vault says no" >&2; exit 1; fi; echo vcrd_old ;;
  *"credentials archive"*) echo archived ;;
  *) echo "unknown $*" >&2; exit 2 ;;
esac
`);
  chmodSync(join(dir, "ant"), 0o755);
  if (opts.failUpdate) writeFileSync(join(dir, "fail-update"), "");
  const lock = join(dir, "claude-lock.json");
  writeFileSync(lock, JSON.stringify({ resources: { "./agents/gardener/vault.yaml": { id: "vlt_1" }, "./agents/gardener/deployment-nightly.yaml": { id: "dep_n" }, "./agents/gardener/agent.md": { id: "agent_1" } } }));
  return { dir, log, stdin, lock };
}

function withAnt(root: string, f: ReturnType<typeof fakeAnt>) {
  writeFileSync(join(root, "rules/gardener.yaml"), YAML.stringify({ ant_profile: "pocketbrain", lock_file: f.lock, delete_sessions: true, rotate_days: 7, mcp_url: "https://brain.example/mcp" }));
  process.env.PATH = `${f.dir}:${process.env.PATH}`;
  process.env.ANTHROPIC_API_KEY = "sk-ant-not-for-ant";
}
const restore = { PATH: process.env.PATH, KEY: process.env.ANTHROPIC_API_KEY };
afterEach(() => { process.env.PATH = restore.PATH; if (restore.KEY === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = restore.KEY; });

test("cleanup deletes only ended sessions older than an hour, with no Anthropic key in its environment", () => {
  const root = makeBrain();
  const f = fakeAnt();
  withAnt(root, f);
  expect(cleanup(root, new Date(IN))).toEqual({ ok: true, message: "gardener cleanup: 1 session(s) deleted" });
  const argv = readFileSync(f.log, "utf8");
  expect(argv).toContain("--profile pocketbrain beta:sessions delete --session-id sesn_old");
  expect(argv).not.toContain("delete --session-id sesn_busy");
  expect(argv).not.toContain("delete --session-id sesn_young");
  expect(argv).not.toContain("sk-ant");
  expect(argv.split("\n").filter(Boolean).every((l) => l.endsWith("key=unset"))).toBe(true);
});

test("cleanup with ant missing or signed out is a Needs-you item, not silence", () => {
  const root = makeBrain();
  const f = fakeAnt();
  withAnt(root, f);
  writeFileSync(join(root, "rules/gardener.yaml"), YAML.stringify({ lock_file: f.lock, ant: join(f.dir, "no-such-ant") }));
  expect(cleanup(root, new Date(IN)).message).toContain("isn't installed");
  expect(readFileSync(join(root, "log/alerts.jsonl"), "utf8")).toContain("gardener_ant");
});

// Mac 2026-10-25: a vault holds one active credential per MCP server URL, so creating a second one
// for the brain's door is a 409 every week. The hub's credential is updated in place (G413).
test("rotate: the new token goes on stdin into the vault's existing credential for the door; older tokens revoked", () => {
  const root = makeBrain();
  const f = fakeAnt();
  withAnt(root, f);
  issueToken(root, "gardener");
  issueToken(root, "gardener");
  const r = rotate(root, { scheduled: true });
  expect(r).toMatchObject({ ok: true, message: "gardener rotate: credential vcrd_old has the new token; 2 old token(s) revoked" });
  const sent = JSON.parse(readFileSync(f.stdin, "utf8"));
  expect(sent.auth).toMatchObject({ type: "static_bearer" });
  const token = sent.auth.token as string;
  expect(token).toMatch(/^pb_gardener_/);
  expect(tokenInfo(root).gardener.map((t) => t.hash)).toEqual([sha256(token)]);
  const argv = readFileSync(f.log, "utf8");
  expect(argv).toContain("beta:vaults:credentials update --vault-id vlt_1 --credential-id vcrd_old");
  expect(argv).not.toContain("credentials create");
  expect(argv).not.toContain("archive");
  expect(argv).not.toContain(token);
  for (const file of readdirSync(join(root, "log"))) expect(readFileSync(join(root, "log", file), "utf8")).not.toContain(token);
  expect(r.message).not.toContain(token);
});

test("rotate: the vault's credential matches the door's URL as the vault does (host case, trailing slash)", () => {
  const root = makeBrain();
  const f = fakeAnt({ listed: '{"id":"vcrd_old","auth":{"type":"static_bearer","mcp_server_url":"https://Brain.example:443/mcp/"}}' });
  withAnt(root, f);
  expect(rotate(root, { scheduled: true })).toMatchObject({ ok: true });
  expect(readFileSync(f.log, "utf8")).toContain("credentials update --vault-id vlt_1 --credential-id vcrd_old");
});

test("rotate: if the vault won't update the credential, the new token is revoked and the old one keeps working", () => {
  const root = makeBrain();
  const f = fakeAnt({ failUpdate: true });
  withAnt(root, f);
  const old = issueToken(root, "gardener");
  const r = rotate(root, { scheduled: true });
  expect(r.ok).toBe(false);
  expect(r.message).toContain("the old one still works");
  expect(tokenInfo(root).gardener.map((t) => t.hash)).toEqual([sha256(old)]);
});

test("a rotation that failed closes its probe check once the next one goes through", () => {
  const root = makeBrain();
  const f = fakeAnt({ failUpdate: true });
  withAnt(root, f);
  tendOnce(root, () => {}, new Date(2026, 9, 18, 13, 30)); // Sunday 13:30
  expect(jobChecks(root).find((c) => c.name === "gardener_rotate")).toMatchObject({ ok: false });
  rmSync(join(f.dir, "fail-update")); // the vault takes it now
  tendOnce(root, () => {}, new Date(2026, 9, 19, 13, 30)); // Monday 13:30: the daily retry
  expect(jobChecks(root).find((c) => c.name === "gardener_rotate")).toMatchObject({ ok: true });
});

// The owner's home page, 2026-10-25: "5 problems", all from one failing rotation retried daily:
// gardener_ant three times (one of them "pinned ant 1.40.0") and token_minted for keys revoked at once.
test("a failing rotation is one owner alert however often it retries; the pin and revoked keys are not problems; it closes once rotation passes", () => {
  const root = makeBrain();
  const f = fakeAnt({ failUpdate: true });
  withAnt(root, f);
  for (const d of [18, 19, 20]) tendOnce(root, () => {}, new Date(2026, 9, d, 13, 30)); // Sunday, then the daily retries
  const alerts = () => openItems(root, new Date()).filter((i) => i.kind === "alert");
  expect(alerts().map((i) => i.check)).toEqual(["gardener_ant"]);
  rmSync(join(f.dir, "fail-update"));
  tendOnce(root, () => {}, new Date(2026, 9, 21, 13, 30));
  record(root, jobChecks(root));
  expect(alerts().map((i) => i.check)).toEqual(["token_minted"]); // the one key the vault took
});

test("rotate: with no credential for the door yet, it creates one", () => {
  const root = makeBrain();
  const f = fakeAnt({ listed: "" });
  withAnt(root, f);
  issueToken(root, "gardener");
  issueToken(root, "gardener");
  const r = rotate(root, { scheduled: true });
  expect(r).toMatchObject({ ok: true, message: "gardener rotate: new credential vcrd_new; 2 old token(s) revoked" });
  const sent = JSON.parse(readFileSync(f.stdin, "utf8"));
  expect(sent.auth).toMatchObject({ type: "static_bearer", mcp_server_url: "https://brain.example/mcp" });
  const token = sent.auth.token as string;
  expect(token).toMatch(/^pb_gardener_/);
  expect(tokenInfo(root).gardener.map((t) => t.hash)).toEqual([sha256(token)]);
  expect(readFileSync(f.log, "utf8")).not.toContain(token);
  for (const file of readdirSync(join(root, "log"))) expect(readFileSync(join(root, "log", file), "utf8")).not.toContain(token);
  expect(r.message).not.toContain(token);
});

test("rotate: if the vault refuses the new token, it is revoked and the old one keeps working", async () => {
  const root = makeBrain();
  const f = fakeAnt({ failCreate: true, listed: "" });
  withAnt(root, f);
  const old = issueToken(root, "gardener");
  const r = rotate(root, { scheduled: true });
  expect(r.ok).toBe(false);
  expect(r.message).toContain("the old one still works");
  expect(tokenInfo(root).gardener.map((t) => t.hash)).toEqual([sha256(old)]);
  expect(readFileSync(f.log, "utf8")).not.toContain("archive");
  process.env.PB_NOW = IN;
  expect((await call(root, old, "GET", "/v1/orientation")).status).toBe(200);
  expect(existsSync(f.stdin)).toBe(true);
});
