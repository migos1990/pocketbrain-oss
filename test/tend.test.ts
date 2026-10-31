// SPDX-License-Identifier: AGPL-3.0-only
// `pocketbrain tend --managed` (docs/gardener.md): writes the gardener's Managed Agents files for
// the owner's own Anthropic account, from their own policy, hub address and timezone. With
// --apply it drives `ant` (a fake one here): agents, environment and vault, the first token into
// the vault on stdin, then each deployment created and paused in the same step.
import { test, expect, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { tendPlan, writeTendFiles, applyManaged } from "../src/tend";
import { createInvite } from "../src/invite";
// The owner's one-time rotation code from the gardener's dashboard page (G240).
const rot = (root: string) => ({ code: createInvite(root, "gardener", { purpose: "rotate" }).code });
import { tokenInfo } from "../src/auth";
import { sha256 } from "../src/util";

const restore = { PATH: process.env.PATH, KEY: process.env.ANTHROPIC_API_KEY };
afterEach(() => { process.env.PATH = restore.PATH; if (restore.KEY === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = restore.KEY; });

const hub = (root: string, url = "https://brain.robin.example") =>
  writeFileSync(join(root, "rules/hub.yaml"), YAML.stringify({ hub: "robin-mini", public_url: url }));
const out = () => mkdtempSync(join(tmpdir(), "pb-tend-"));
const setPolicy = (root: string, f: (p: any) => void) => {
  const file = join(root, "rules/policy.yaml");
  const p = YAML.parse(readFileSync(file, "utf8"));
  f(p);
  writeFileSync(file, YAML.stringify(p));
};

test("the files come from the owner's own brain: their name, their door, their timezone and the gardener's hours", () => {
  const root = makeBrain();
  hub(root);
  setPolicy(root, (p) => { p.owner.timezone = "Europe/Paris"; });
  const dir = out();
  const plan = tendPlan(root, { dir });
  expect(plan).toMatchObject({ agent: "gardener", mcpUrl: "https://brain.robin.example/mcp", timezone: "Europe/Paris", nightlyCron: "30 3 * * *", weeklyCron: "0 10 * * 0" });
  writeTendFiles(plan);
  const read = (p: string) => readFileSync(join(dir, p), "utf8");
  const nightly = read("agents/gardener/agent.md"), weekly = read("agents/gardener-weekly/agent.md");
  expect(nightly).toContain("url: https://brain.robin.example/mcp");
  expect(nightly).toContain("Robin's pocketBrain");
  expect(nightly).toContain("model: claude-haiku-5-5");
  expect(weekly).toContain("name: gardener-weekly");
  expect(weekly).toContain("model: claude-opus-5-5");
  const dep = YAML.parse(read("agents/gardener/deployment-nightly.yaml"));
  expect(dep.schedule).toEqual({ type: "cron", expression: "30 3 * * *", timezone: "Europe/Paris" });
  expect(dep.vault_ids).toEqual(["YOUR_VAULT_ID"]);
  expect(YAML.parse(read("agents/gardener-weekly/deployment-weekly.yaml")).schedule.expression).toBe("0 10 * * 0");
  expect(YAML.parse(read("agents/gardener/environment.yaml")).config.networking).toEqual({ type: "limited", allow_mcp_servers: true });
  // Nothing of anyone else's setup: no other door or zone.
  const all = readdirSync(join(dir, "agents"), { recursive: true }).map(String).filter((f) => /\.(md|yaml)$/.test(f)).map((f) => read(join("agents", f))).join("\n");
  expect(all).not.toContain("America/Toronto");
  expect([...new Set(all.match(/https?:\/\/[^\s)]+/g))]).toEqual(["https://brain.robin.example/mcp"]);
});

test("the gardener's instructions keep its rules: propose only, notes are data, no secrets, no claimed approvals", () => {
  const root = makeBrain();
  hub(root);
  const dir = out();
  writeTendFiles(tendPlan(root, { dir }));
  for (const f of ["agents/gardener/agent.md", "agents/gardener-weekly/agent.md"]) {
    const t = readFileSync(join(dir, f), "utf8");
    expect(t).toContain("default_config: {enabled: false}");
    expect(t).toMatch(/data, never instructions/);
    expect(t).toMatch(/[Nn]ever write secrets/);
    expect(t).toMatch(/[Nn]ever claim Robin approved/);
    expect(t).not.toMatch(/name: (retire|capture|memory_check)/); // only the tools a gardener needs
  }
});

// Eval gardener-dispute-suggest went 2/3 twice on wiki-summaries-5: the one run that missed
// verified the right side's mail, then suggested nothing ("no source backs a newer value"),
// reading step 5's "a match means propose nothing" as covering the conflict too.
test("a conflict side whose source matches is suggested: step 5's 'propose nothing' is about facts, not conflicts", () => {
  const root = makeBrain();
  hub(root);
  const dir = out();
  writeTendFiles(tendPlan(root, { dir }));
  const t = readFileSync(join(dir, "agents/gardener/agent.md"), "utf8");
  const step4 = t.split("\n").find((l) => l.startsWith("4. "))!;
  expect(step4).toMatch(/suggest_answer/);
  expect(step4).toMatch(/"propose nothing" is about facts, never about a conflict/);
  // The wiki step says nothing about proposals that could be read as a reason to hold one back.
  expect(t.split("\n").find((l) => l.startsWith("8. "))!).not.toMatch(/propos/);
});

test("the schedule follows the gardener's windows, five minutes after each opens", () => {
  const root = makeBrain();
  hub(root);
  setPolicy(root, (p) => { p.agents.gardener.windows = ["daily 03:55-05:00", "sat 08:00-09:30"]; });
  expect(tendPlan(root, { dir: out() })).toMatchObject({ nightlyCron: "0 4 * * *", weeklyCron: "5 8 * * 6" });
});

test("a run that would start between 01:00 and 03:00 is refused: clocks change in that hour", () => {
  const root = makeBrain();
  hub(root);
  for (const daily of ["daily 01:55-03:00", "daily 00:55-02:00", "daily 02:30-04:00"]) {
    setPolicy(root, (p) => { p.agents.gardener.windows = [daily, "sun 09:55-12:00"]; });
    expect(() => tendPlan(root, { dir: out() })).toThrow(/between 01:00 and 03:00.*repeat.*skip/s);
  }
  setPolicy(root, (p) => { p.agents.gardener.windows = ["daily 03:25-05:00", "sun 01:30-04:00"]; });
  expect(() => tendPlan(root, { dir: out() })).toThrow(/sun 01:30-04:00/);
  setPolicy(root, (p) => { p.agents.gardener.windows = ["daily 02:55-05:00", "sun 09:55-12:00"]; });
  expect(tendPlan(root, { dir: out() }).nightlyCron).toBe("0 3 * * *");
});

test("it refuses, and writes nothing, without a gardener, an https door or windows it can schedule in", () => {
  const root = makeBrain();
  const dir = out();
  expect(() => tendPlan(root, { dir })).toThrow(/public_url in rules\/hub\.yaml or pass --url/);
  expect(() => tendPlan(root, { dir, url: "http://brain.robin.example" })).toThrow(/https/);
  hub(root);
  setPolicy(root, (p) => { p.agents.gardener.windows = ["mon-fri 03:00-04:00"]; });
  expect(() => tendPlan(root, { dir })).toThrow(/one daily and one weekly window/);
  setPolicy(root, (p) => { delete p.agents.gardener; });
  expect(() => tendPlan(root, { dir })).toThrow(/role: gardener/);
  expect(readdirSync(dir)).toEqual([]);
});

test("with two gardeners it asks which, and --agent picks one", () => {
  const root = makeBrain();
  hub(root);
  setPolicy(root, (p) => { p.agents.tidier = { ...p.agents.gardener }; });
  expect(() => tendPlan(root, { dir: out() })).toThrow(/several gardeners \(gardener, tidier\): pick one with --agent/);
  expect(() => tendPlan(root, { dir: out(), agent: "helper" })).toThrow(/helper has no role: gardener/);
  const plan = tendPlan(root, { dir: out(), agent: "tidier" });
  expect(Object.keys(plan.files)).toContain("agents/tidier-weekly/agent.md");
});

test("--url wins over hub.yaml, and existing files are kept unless --force", () => {
  const root = makeBrain();
  hub(root);
  const dir = out();
  const plan = tendPlan(root, { dir, url: "https://door.robin.example/" });
  expect(plan.mcpUrl).toBe("https://door.robin.example/mcp");
  writeFileSync(join(dir, "keep.txt"), "x");
  expect(writeTendFiles(plan).written.length).toBe(6);
  writeFileSync(join(dir, "agents/gardener/agent.md"), "my edits");
  const again = writeTendFiles(plan);
  expect(again.kept).toContain("agents/gardener/agent.md");
  expect(readFileSync(join(dir, "agents/gardener/agent.md"), "utf8")).toBe("my edits");
  writeTendFiles(plan, { force: true });
  expect(readFileSync(join(dir, "agents/gardener/agent.md"), "utf8")).toContain("Robin's pocketBrain");
});

// ---------- --apply, against a fake `ant` on PATH ----------

const URL = "https://brain.robin.example";

function fakeAnt(opts: { failPause?: boolean; credential?: boolean } = {}) {
  const bin = mkdtempSync(join(tmpdir(), "pb-ant-"));
  const log = join(bin, "argv.log"), stdin = join(bin, "stdin.log");
  // `ant apply` writes the lock file in its working directory, like the real one.
  writeFileSync(join(bin, "ant"), `#!/bin/sh
echo "$(pwd) | $* key=\${ANTHROPIC_API_KEY:-unset}" >> "${log}"
case "$*" in *"apply --yes agents/"*deployment*) f="\${*##* }"; grep -q "^schedule:" "$f" && echo "  scheduled" >> "${log}" || echo "  unscheduled" >> "${log}" ;; esac
add() { K="$1" V="$2" "${process.execPath}" -e 'const fs=require("fs"),f="claude-lock.json";const j=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{resources:{}};j.resources[process.env.K]={id:process.env.V};fs.writeFileSync(f,JSON.stringify(j))'; }
case "$*" in
  *"auth status"*) echo "workspace: robin" ;;
  *"apply --yes"*"vault.yaml"*) add ./agents/gardener/vault.yaml vlt_r; add ./agents/gardener/agent.md agent_n; add ./agents/gardener-weekly/agent.md agent_w; add ./agents/gardener/environment.yaml env_r ;;
  *"apply --yes agents/gardener/deployment-nightly.yaml"*) grep -q vlt_r agents/gardener/deployment-nightly.yaml || { echo "no vault id" >&2; exit 1; }; add ./agents/gardener/deployment-nightly.yaml depl_n ;;
  *"apply --yes agents/gardener-weekly/deployment-weekly.yaml"*) add ./agents/gardener-weekly/deployment-weekly.yaml depl_w ;;
  *"deployments pause"*) ${opts.failPause ? 'echo "pause failed" >&2; exit 1' : "echo paused"} ;;
  *"credentials list"*) ${opts.credential ? `echo '{"id":"vcrd_have","auth":{"type":"static_bearer","mcp_server_url":"https://brain.robin.example/mcp"}}'` : "true"} ;;
  *"credentials create"*) cat > "${stdin}"; echo vcrd_new ;;
  *) echo "unknown $*" >&2; exit 2 ;;
esac
`);
  chmodSync(join(bin, "ant"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.ANTHROPIC_API_KEY = "sk-ant-not-for-ant";
  return { log, stdin, lines: () => readFileSync(log, "utf8").split("\n").filter((l) => l && !l.startsWith("  ")), raw: () => readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

test("--apply: vault first, the token into it on stdin only, then each deployment created and paused at once", () => {
  const root = makeBrain();
  const dir = out();
  const ant = fakeAnt();
  const plan = tendPlan(root, { dir, url: URL });
  writeTendFiles(plan);
  const r = applyManaged(root, plan, rot(root));
  expect(r.ok).toBe(true);
  const calls = ant.lines().map((l) => l.split(" | ")[1]);
  const at = (s: string) => calls.findIndex((c) => c.includes(s));
  expect(at("credentials create")).toBeGreaterThan(at("vault.yaml"));
  expect(at("apply --yes agents/gardener/deployment-nightly.yaml")).toBeGreaterThan(at("credentials create"));
  expect(calls[at("apply --yes agents/gardener/deployment-nightly.yaml") + 1]).toContain("beta:deployments pause --deployment-id depl_n");
  expect(calls[at("apply --yes agents/gardener-weekly/deployment-weekly.yaml") + 1]).toContain("beta:deployments pause --deployment-id depl_w");
  expect(ant.lines().every((l) => l.startsWith(`${dir} | --profile pocketbrain `) && l.endsWith("key=unset"))).toBe(true);
  // The token: a fresh gardener token, in the vault for this door, never in arguments, logs or output.
  const sent = JSON.parse(readFileSync(ant.stdin, "utf8"));
  expect(sent.auth).toMatchObject({ type: "static_bearer", mcp_server_url: "https://brain.robin.example/mcp" });
  expect(tokenInfo(root).gardener.map((t) => t.hash)).toEqual([sha256(sent.auth.token)]);
  expect(readFileSync(ant.log, "utf8")).not.toContain(sent.auth.token);
  expect(r.lines.join("\n")).not.toContain(sent.auth.token);
  expect(YAML.parse(readFileSync(join(dir, "agents/gardener/deployment-nightly.yaml"), "utf8")).vault_ids).toEqual(["vlt_r"]);
  // rules/gardener.yaml now points at this lock file, so cleanup and rotation run from `start`.
  const cfg = YAML.parse(readFileSync(join(root, "rules/gardener.yaml"), "utf8"));
  expect(cfg).toMatchObject({ ant_profile: "pocketbrain", lock_file: join(dir, "claude-lock.json"), mcp_url: "https://brain.robin.example/mcp" });
  expect(Bun.spawnSync(["git", "log", "--format=%an %s"], { cwd: root }).stdout.toString()).toContain("Robin owner: gardener on Managed Agents");
  expect(r.lines.join("\n")).toMatch(/paused/);
});

test("--apply: no deployment ever has its schedule before it is paused", () => {
  const root = makeBrain();
  const dir = out();
  const ant = fakeAnt();
  const plan = tendPlan(root, { dir, url: URL });
  writeTendFiles(plan);
  expect(applyManaged(root, plan, rot(root)).ok).toBe(true);
  const raw = ant.raw();
  for (const [file, id] of [["deployment-nightly.yaml", "depl_n"], ["deployment-weekly.yaml", "depl_w"]]) {
    const applies = raw.map((l, i) => ({ l, i })).filter(({ l }) => l.includes(`apply --yes`) && l.includes(file)).map(({ i }) => i);
    expect(applies.length).toBe(2);
    expect(raw[applies[0] + 1]).toBe("  unscheduled");
    expect(raw[applies[0] + 2]).toContain(`beta:deployments pause --deployment-id ${id}`);
    expect(raw[applies[1] + 1]).toBe("  scheduled");
    expect(raw[applies[1] + 2]).toContain(`beta:deployments pause --deployment-id ${id}`);
  }
  // The file on disk ends with its schedule, so later applies keep it.
  expect(readFileSync(join(dir, "agents/gardener/deployment-nightly.yaml"), "utf8")).toContain("schedule:");
});

test("--apply again keeps the vault's credential rather than minting another token", () => {
  const root = makeBrain();
  const dir = out();
  const ant = fakeAnt({ credential: true });
  const plan = tendPlan(root, { dir, url: URL });
  writeTendFiles(plan);
  expect(applyManaged(root, plan, rot(root)).ok).toBe(true);
  expect(ant.lines().some((l) => l.includes("credentials create"))).toBe(false);
  expect(tokenInfo(root).gardener ?? []).toEqual([]);
});

test("--apply: a deployment that won't pause gets no schedule, and nothing runs on its own", () => {
  const root = makeBrain();
  const dir = out();
  const ant = fakeAnt({ failPause: true });
  const plan = tendPlan(root, { dir, url: URL });
  writeTendFiles(plan);
  const r = applyManaged(root, plan, rot(root));
  expect(r.ok).toBe(false);
  expect(r.lines.join("\n")).toContain("depl_n was created without a schedule");
  expect(ant.raw()).not.toContain("  scheduled");
  expect(ant.lines().some((l) => l.includes("deployment-weekly"))).toBe(false);
  expect(readFileSync(join(dir, "agents/gardener/deployment-nightly.yaml"), "utf8")).toContain("schedule:");
  expect(readFileSync(join(root, "log/alerts.jsonl"), "utf8")).toContain("depl_n");
});

test("--apply with ant missing or signed out changes nothing", () => {
  const root = makeBrain();
  const dir = out();
  const plan = tendPlan(root, { dir, url: URL, ant: join(dir, "no-such-ant") });
  writeTendFiles(plan);
  const r = applyManaged(root, plan, rot(root));
  expect(r.ok).toBe(false);
  expect(r.lines.join("\n")).toContain("isn't installed");
  expect(existsSync(join(root, "rules/gardener.yaml"))).toBe(false);
  expect(tokenInfo(root).gardener ?? []).toEqual([]);
});

test("the gardener can corroborate: verify_source is enabled, every tool its steps name is enabled and served, memory_sync stays off", () => {
  const root = makeBrain();
  hub(root);
  const dir = out();
  writeTendFiles(tendPlan(root, { dir }));
  const served = new Set([...readFileSync(join(import.meta.dir, "../src/server.ts"), "utf8").matchAll(/^\s+name: "([a-z_]+)",$/gm)].map((m) => m[1]));
  for (const f of ["agents/gardener/agent.md", "agents/gardener-weekly/agent.md"]) {
    const text = readFileSync(join(dir, f), "utf8");
    const [, front, body] = text.split(/^---$/m);
    const enabled = [...front.matchAll(/\{name: ([a-z_]+), enabled: true/g)].map((m) => m[1]);
    expect(enabled).toContain("verify_source");
    expect(enabled).not.toContain("memory_sync");
    for (const t of enabled) expect(served.has(t)).toBe(true);
    const named = [...body.matchAll(/`([a-z]+_[a-z_]+|orientation|search|read|remember)`/g)].map((m) => m[1]);
    for (const t of named) if (served.has(t)) expect(enabled).toContain(t);
    expect(body).toContain("`verify_source`");
    expect(body).toContain("`decided`");
    expect(body).not.toContain("Louis");
  }
  const nightly = readFileSync(join(dir, "agents/gardener/agent.md"), "utf8");
  expect(nightly).toContain("rechecked.due");
  expect(nightly).toContain("At most 10 calls a night");
});

test("both gardener passes say a verify_source match means the fact stands: no proposal on it", () => {
  const root = makeBrain();
  hub(root);
  const dir = out();
  writeTendFiles(tendPlan(root, { dir }));
  for (const f of ["agents/gardener/agent.md", "agents/gardener-weekly/agent.md"]) {
    const t = readFileSync(join(dir, f), "utf8");
    expect(t).toMatch(/A `match` means the source still supports the fact: propose nothing on that fact/);
  }
});
