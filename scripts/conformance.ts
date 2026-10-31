// SPDX-License-Identifier: AGPL-3.0-only
// The Memory Passport conformance suite over real HTTP, against both implementations, the way an
// outside vendor would run it: the reference server (bun conformance/reference-server.ts) and a
// pocketBrain hub (bun src/cli.ts serve) on a throwaway copy of examples/brain plus the fixture's
// extra note. Never the real brain. CI runs this on every push (job "conformance").
//   bun scripts/conformance.ts        exits 1 when either server fails a MUST check
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInvite } from "../src/invite";

const APP = join(import.meta.dir, "..");
const TODAY = "2026-10-08";

// The fixture's notes examples/brain lacks: a person outside the work area, so the limited agent
// (helper) sees it only through contacts-basic (role, not phones), and the bank desk below.
export function addFixtureExtras(root: string) {
  writeFileSync(join(root, "people", "sam-lee.md"), `---
id: people/sam-lee
type: person
title: Sam Lee
area: personal
sensitivity: personal
status: active
created: 2026-09-15
updated: 2026-09-15
by: steward
facts:
  role: { value: Lab technician, as_of: 2026-09-15, sources: ["gmail:f00000000000000a"], verification: verified-by-source, by: steward, recorded: 2026-09-15 }
  phones: { value: "+15145550199", as_of: 2026-09-15, sources: ["gmail:f00000000000000a"], verification: verified-by-source, by: steward, recorded: 2026-09-15 }
---
`);
  // A work note whose title, alias and text name a hidden value (the bank's name, money is withheld
  // from helper) in other cases: probe R7 (G532).
  mkdirSync(join(root, "orgs"), { recursive: true });
  writeFileSync(join(root, "orgs", "liaison-desk.md"), `---
id: orgs/liaison-desk
type: org
title: Desk at MAPLE TRUST BANK
aliases: [maple trust bank desk]
area: work
sensitivity: personal
status: active
created: 2026-09-15
updated: 2026-09-15
by: planner
---
Our contact at Maple trust bank.
`);
  const env = { ...process.env, GIT_AUTHOR_NAME: "owner", GIT_AUTHOR_EMAIL: "o@x", GIT_COMMITTER_NAME: "owner", GIT_COMMITTER_EMAIL: "o@x" };
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "conformance fixture"]]) Bun.spawnSync(["git", ...a], { cwd: root, env });
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const p = s.port!; s.stop(true); return p;
}

async function up(base: string, path: string) {
  for (let i = 0; ; i++) {
    try { if ((await fetch(base + path)).ok) return; } catch { /* starting */ }
    if (i > 100) throw new Error(`${base} didn't answer ${path}`);
    await Bun.sleep(100);
  }
}

// One run of conformance/run.ts; its report goes straight to the log.
function suite(base: string, full: string, limited: string, extra: string[] = []): number {
  const r = Bun.spawnSync(["bun", "conformance/run.ts", base, "--full", full, "--limited", limited, ...extra], { cwd: APP, stdout: "inherit", stderr: "inherit" });
  return r.exitCode;
}

async function reference(): Promise<number> {
  const port = await freePort();
  const p = Bun.spawn(["bun", "conformance/reference-server.ts", String(port)], { cwd: APP, stdout: "pipe", stderr: "inherit" });
  try {
    const reader = p.stdout.getReader();
    let out = "";
    while (!/waiting token: \S+/.test(out)) { const { value, done } = await reader.read(); if (done) throw new Error(`reference server: ${out}`); out += new TextDecoder().decode(value); }
    const tok = (k: string) => out.match(new RegExp(`${k} token: (\\S+)`))![1];
    return suite(`http://127.0.0.1:${port}`, tok("full"), tok("limited"), ["--resolver", tok("resolver"), "--waiting", tok("waiting")]);
  } finally { p.kill(); }
}

async function pocketBrain(): Promise<number> {
  const root = mkdtempSync(join(tmpdir(), "pb-conformance-"));
  cpSync(join(APP, "examples", "brain"), root, { recursive: true });
  addFixtureExtras(root);
  const env = { ...process.env, PB_TODAY: TODAY, PB_CONFIG_DIR: mkdtempSync(join(tmpdir(), "pb-conformance-config-")) };
  const token = (agent: string, role?: string) => {
    // The owner's one-time code (the dashboard's button, G184): steward is wider than a terminal mints for alone.
    // The code names the role it mints (a resolver code mints a resolver token; G313 tightened the match).
    const code = createInvite(root, agent, role ? { role: role as "resolver" | "reader" } : {}).code;
    const r = Bun.spawnSync(["bun", "src/cli.ts", "token", "--agent", agent, ...(role ? ["--role", role] : []), "--code", code, "--brain", root], { cwd: APP, env, stdout: "pipe", stderr: "pipe" });
    const t = (r.stdout.toString() + r.stderr.toString()).match(/pb_[A-Za-z0-9_-]{8,}/)?.[0];
    // Say why (G521: CI failed here for two weeks with nothing more than this line); tokens never printed.
    if (!t) throw new Error(`no token for ${agent} (exit ${r.exitCode}): ${(r.stdout.toString() + r.stderr.toString()).replace(/pb_[A-Za-z0-9_-]+/g, "pb_<token>").trim().slice(-600)}`);
    return t;
  };
  const full = token("steward"), limited = token("helper");
  const port = await freePort();
  const hub = Bun.spawn(["bun", "src/cli.ts", "serve", "--brain", root, "--port", String(port)], { cwd: APP, env, stdout: "ignore", stderr: "ignore" });
  try {
    await up(`http://127.0.0.1:${port}`, "/health");
    // No waiting sign-in here: that takes a live authorization server (test/conformance.test.ts has one).
    return suite(`http://127.0.0.1:${port}`, full, limited, ["--resolver", token("steward", "resolver")]);
  } finally { hub.kill(); }
}

if (import.meta.main) {
  console.log("== reference server ==");
  const a = await reference();
  console.log("\n== pocketBrain ==");
  const b = await pocketBrain();
  console.log(`\nreference server: ${a === 0 ? "PASS" : "FAIL"}, pocketBrain: ${b === 0 ? "PASS" : "FAIL"}`);
  process.exit(a === 0 && b === 0 ? 0 : 1);
}
