// SPDX-License-Identifier: AGPL-3.0-only
// G184: any program with a shell can run the CLI. From a shell alone, `token`, `connect`, `invite`
// and `edge enroll` used to mint a working token for any existing agent, steward with the all
// slice included, which undid "the CLI only tightens". Now a terminal mints only for a narrow
// agent (writes wait for the owner, nothing private, named slices only, no hub role); a wider one
// needs a one-time code the owner makes on the dashboard. Every mint from a terminal is an alert.
import { test, expect } from "bun:test";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { main } from "../src/cli";
import { tokenOwner } from "../src/auth";
import { runAction } from "../src/dashboard/actions";
import { dashboardHandler } from "../src/dashboard/server";
import { digest } from "../src/digest";
import { resetEnrollLimits } from "../src/invite";

const APP = join(import.meta.dir, "..");
function run(root: string, ...args: string[]) {
  const out: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { out.push(a.join(" ")); };
  let code: number;
  try { code = main([...args, "--brain", root]); } finally { console.log = log; console.error = err; }
  const text = out.join("\n");
  return { code, out: text, token: text.match(/pb_[A-Za-z0-9]+_[A-Za-z0-9_-]{20,}/)?.[0] };
}
const tokens = (root: string, agent: string) => (YAML.parse(readFileSync(join(root, "rules/tokens.yaml"), "utf8"))?.agents?.[agent] ?? []) as unknown[];
const hasTokens = (root: string, agent: string) => existsSync(join(root, "rules/tokens.yaml")) && tokens(root, agent).length > 0;
const alerts = (root: string) => existsSync(join(root, "log/alerts.jsonl")) ? readFileSync(join(root, "log/alerts.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

// The repro as found (consent-access/cli-token.test.ts), in a real process.
test("G184: a shell can't get a token for the all-slice agent from the CLI with no owner step", () => {
  const root = makeBrain();
  const r = Bun.spawnSync(["bun", join(APP, "src/cli.ts"), "token", "--agent", "steward", "--brain", root], { cwd: APP, env: { ...process.env, PB_CONFIG_DIR: mkdtempSync(join(tmpdir(), "pb-cfg-")) } });
  const tok = r.stdout.toString().trim().split(/\s+/).find((x) => x.startsWith("pb_")) ?? "";
  expect({ exit: r.exitCode, minted: !!tok }).toEqual({ exit: 1, minted: false });
  expect(r.stderr.toString()).toContain("dashboard");
  expect(hasTokens(root, "steward")).toBe(false);
});

test("G184: no CLI door mints for a wide agent without the owner's code", () => {
  resetEnrollLimits();
  const root = makeBrain();
  for (const args of [["token", "--agent", "steward"], ["token", "--agent", "steward", "--role", "reader"], ["token", "--agent", "planner"], ["connect", "steward"], ["connect", "planner"], ["connect", "steward", "--browser", "--key-only"], ["invite", "steward"], ["edge", "enroll", "steward"]]) {
    const r = run(root, ...args);
    expect([args.join(" "), r.code, r.token]).toEqual([args.join(" "), 1, undefined]);
  }
  expect(hasTokens(root, "steward")).toBe(false);
  expect(hasTokens(root, "planner")).toBe(false);
  // The refused browser door wasn't turned on either, and no invite was made.
  expect(YAML.parse(readFileSync(join(root, "rules/policy.yaml"), "utf8")).agents.steward.browser).toBeUndefined();
  expect(existsSync(join(root, "rules/invites.yaml"))).toBe(false);
});

test("G184: the gardener (all slice, trial) and the resolver stay out of the terminal's reach", () => {
  const root = makeBrain();
  expect(run(root, "token", "--agent", "gardener").code).toBe(1);
  expect(run(root, "token", "--agent", "steward", "--role", "resolver").code).toBe(1);
  expect(hasTokens(root, "gardener")).toBe(false);
});

test("G184: a narrow trial agent still gets its token from the terminal, and the owner hears of it", () => {
  const root = makeBrain();
  const r = run(root, "token", "--agent", "helper");
  expect(r.code).toBe(0);
  expect(tokenOwner(root, r.token)?.agent).toBe("helper");
  const c = run(root, "connect", "helper");
  expect(c.code).toBe(0);
  expect(tokenOwner(root, c.token)?.agent).toBe("helper");
  const a = alerts(root).filter((x) => x.check === "token_minted");
  expect(a.map((x) => x.agent)).toEqual(["helper", "helper"]);
  expect(JSON.stringify(a)).not.toContain(r.token!);
  expect(digest(root).text).toContain("token_minted");
});

test("G184: the owner's one-time code from the dashboard lets the terminal mint once, for that agent only", () => {
  resetEnrollLimits();
  const root = makeBrain();
  const said = runAction({ root }, "token-code", { agent: "steward" });
  const code = said.match(/[0-9A-Z]{5}-[0-9A-Z]{5}/)![0];
  expect(said).toContain(`pocketbrain token --agent steward --code ${code}`);
  // A code made for steward doesn't mint for planner.
  expect(run(root, "token", "--agent", "planner", "--code", code).code).toBe(1);
  const r = run(root, "token", "--agent", "steward", "--code", code);
  expect(r.code).toBe(0);
  expect(tokenOwner(root, r.token)?.agent).toBe("steward");
  expect(run(root, "token", "--agent", "steward", "--code", code).code).toBe(1); // once
  expect(alerts(root).filter((x) => x.check === "token_minted").map((x) => x.agent)).toEqual(["steward"]);
  // connect takes the same code.
  const code2 = runAction({ root }, "token-code", { agent: "steward" }).match(/[0-9A-Z]{5}-[0-9A-Z]{5}/)![0];
  const c = run(root, "connect", "steward", "--code", code2);
  expect(c.code).toBe(0);
  expect(tokenOwner(root, c.token)?.agent).toBe("steward");
});

test("G184: the dashboard shows the code on the page, never in a redirect URL", async () => {
  const root = makeBrain();
  const H = "127.0.0.1:8788";
  const d = dashboardHandler(root, { port: 8788, loginKey: "k".repeat(32) });
  const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const page = await (await d.handle(new Request(`http://${H}/agent/steward`, { headers: { host: H, cookie } }))).text();
  expect(page).toContain("token-code");
  const csrf = page.match(/name="csrf" value="([^"]+)"/)![1];
  const r = await d.handle(new Request(`http://${H}/action/token-code`, { method: "POST", body: new URLSearchParams({ csrf, agent: "steward" }), headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/agent/steward`, "content-type": "application/x-www-form-urlencoded" } }));
  expect(r.status).toBe(200);
  expect(r.headers.get("location")).toBeNull();
  expect(r.headers.get("cache-control")).toContain("no-store");
  expect(await r.text()).toMatch(/pocketbrain token --agent steward --code [0-9A-Z]{5}-[0-9A-Z]{5}/);
});

// token rotate (claude/token-rotate) mints too, so it goes through the same gate (mintFromShell).
test("G184: token rotate for a wide agent without the owner's code mints nothing; with it, once, with an alert", () => {
  resetEnrollLimits();
  const root = makeBrain();
  const count = () => hasTokens(root, "steward") ? tokens(root, "steward").length : 0;
  const before = count();
  const r = run(root, "token", "rotate", "steward", "--yes");
  expect(r.code).toBe(1);
  expect(r.token).toBeUndefined();
  expect(r.out).toContain("One-time code");
  expect(count()).toBe(before);
  const code = runAction({ root }, "token-code", { agent: "steward" }).match(/[0-9A-Z]{5}-[0-9A-Z]{5}/)![0];
  const ok = run(root, "token", "rotate", "steward", "--yes", "--code", code);
  expect(ok.code).toBe(0);
  expect(tokenOwner(root, ok.token)?.agent).toBe("steward");
  expect(alerts(root).filter((a) => a.check === "token_minted").map((a) => a.agent)).toEqual(["steward"]);
  // The code is spent: a second rotation with it is refused.
  expect(run(root, "token", "rotate", "steward", "--yes", "--code", code).code).toBe(1);
  // A narrow trial agent still rotates from the terminal alone.
  expect(run(root, "token", "rotate", "helper", "--yes").code).toBe(0);
});
