// SPDX-License-Identifier: AGPL-3.0-only
// The slice audit of the G184 fix (claude/cli-token-pem): the terminal gate must also hold for
// the gardener's rotation (G240), bound a narrow agent's reach (G241), check a code before the
// browser door opens (G242), bind a one-time code to its role and keep the guess limit across
// processes, and not count an `include` slice with a filter as narrow (G245).
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { main } from "../src/cli";
import { tokenOwner } from "../src/auth";
import { runAction } from "../src/dashboard/actions";
import { shellMintRefusal, resetEnrollLimits, ENROLL_FAILS_PER_WINDOW } from "../src/invite";
import { rotate } from "../src/gardener";

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
const alerts = (root: string) => existsSync(join(root, "log/alerts.jsonl")) ? readFileSync(join(root, "log/alerts.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const policy = (root: string) => YAML.parse(readFileSync(join(root, "rules/policy.yaml"), "utf8"));
const codeOf = (s: string) => s.match(/[0-9A-Z]{5}-[0-9A-Z]{5}/)![0];

// A stand-in `ant` that keeps whatever token it is handed, as a hostile one would.
function fakeAnt(root: string, body = "") {
  const d = mkdtempSync(join(tmpdir(), "pb-ant-"));
  const cap = join(d, "captured.txt");
  const ant = join(d, "ant");
  writeFileSync(ant, `#!/bin/sh\n# ${body}\ncase "$*" in\n *"auth status"*) exit 0;;\n *"credentials list"*) echo '[]'; exit 0;;\n *"credentials create"*) cat > ${cap}; echo '"cred_1"'; exit 0;;\nesac\nexit 0\n`);
  chmodSync(ant, 0o755);
  writeFileSync(join(d, "claude-lock.json"), JSON.stringify({ resources: { "vault.yaml": { id: "vlt_1" } } }));
  writeFileSync(join(root, "rules/gardener.yaml"), `ant: ${ant}\nlock_file: ${join(d, "claude-lock.json")}\nmcp_url: http://127.0.0.1:8787/mcp\n`);
  const captured = () => existsSync(cap) ? JSON.parse(readFileSync(cap, "utf8")).auth.token as string : undefined;
  return { ant, captured, swap: (b: string) => writeFileSync(ant, readFileSync(ant, "utf8").replace(/^# .*$/m, `# ${b}`)) };
}

test("G240: gardener rotate from a terminal needs the owner's code; the token never reaches an ant the shell named", () => {
  const root = makeBrain();
  const a = fakeAnt(root);
  const r = run(root, "gardener", "rotate");
  expect(r.code).toBe(1);
  expect(r.out).toContain("Rotation code");
  expect(a.captured()).toBeUndefined();
  // With the code from the gardener's dashboard page, it rotates and the owner hears of it.
  const said = runAction({ root }, "token-code", { agent: "gardener" });
  expect(said).toContain("pocketbrain gardener rotate --code");
  const ok = run(root, "gardener", "rotate", "--code", codeOf(said));
  expect(ok.code).toBe(0);
  expect(tokenOwner(root, a.captured())?.agent).toBe("gardener");
  const minted = alerts(root).filter((x) => x.check === "token_minted");
  expect(minted.map((x) => x.agent)).toEqual(["gardener"]);
  expect(minted[0].from).toContain(a.ant);
  // The gardener's code is no token: neither `token --code` nor /v1/enroll takes it.
  const c2 = codeOf(runAction({ root }, "token-code", { agent: "gardener" }));
  expect(run(root, "token", "--agent", "gardener", "--code", c2).code).toBe(1);
});

test("G240: the scheduled rotation hands the token only to the ant the owner last approved", () => {
  const root = makeBrain();
  const a = fakeAnt(root);
  expect(run(root, "gardener", "rotate", "--code", codeOf(runAction({ root }, "token-code", { agent: "gardener" }))).code).toBe(0);
  const first = a.captured();
  // Same ant: the hub's weekly job rotates on its own.
  expect(rotate(root, { scheduled: true }).ok).toBe(true);
  expect(a.captured()).not.toBe(first);
  const second = a.captured();
  // A different ant binary at the same path: refused, nothing sent, the owner is told.
  a.swap("replaced");
  const r = rotate(root, { scheduled: true });
  expect(r.ok).toBe(false);
  expect(a.captured()).toBe(second);
  expect(alerts(root).some((x) => x.check === "gardener_ant" && /changed/.test(String(x.detail)))).toBe(true);
  // And rules/gardener.yaml naming another ant is refused the same way.
  const b = fakeAnt(root, "other");
  expect(rotate(root, { scheduled: true }).ok).toBe(false);
  expect(b.captured()).toBeUndefined();
});

test("G241: a terminal mints only for an agent no wider than add and init make: one area, money left out", () => {
  const root = makeBrain();
  const r = run(root, "add", "rogue", "--slices", "area:personal,area:work,contacts-basic", "--exclude-types", "none", "--door", "local", "--yes");
  expect(r.code).toBe(1);
  expect(r.token).toBeUndefined();
  expect(policy(root).agents.rogue).toBeUndefined();
  for (const args of [["--slices", "area:personal,area:work"], ["--slices", "area:work", "--exclude-types", "none"]]) {
    const x = run(root, "add", "rogue2", ...args, "--door", "mcp", "--yes");
    expect([args.join(" "), x.code, x.token]).toEqual([args.join(" "), 1, undefined]);
  }
  // The default shape still works, from add and for an existing agent.
  const ok = run(root, "add", "newbot", "--slices", "area:work,contacts-basic", "--door", "local", "--yes");
  expect(ok.code).toBe(0);
  expect(tokenOwner(root, ok.token)?.agent).toBe("newbot");
  expect(shellMintRefusal(root, "helper")).toBeUndefined();
  // An existing trial agent whose money isn't left out is refused too.
  const pf = join(root, "rules/policy.yaml");
  const p = policy(root); delete p.agents.helper.exclude_types; writeFileSync(pf, YAML.stringify(p));
  expect(shellMintRefusal(root, "helper")).toContain("money");
});

test("G245: a slice that lists notes by name but adds a filter selects everything, so it isn't narrow", () => {
  const root = makeBrain();
  const sf = join(root, "rules/slices.yaml");
  const y = YAML.parse(readFileSync(sf, "utf8"));
  y.slices.sneaky = { include: ["people/nobody"], max_sensitivity: "personal" };
  y.slices.listed = { include: ["people/nobody"] };
  writeFileSync(sf, YAML.stringify(y));
  const pf = join(root, "rules/policy.yaml");
  const p = policy(root); p.agents.helper.slices = ["sneaky"]; writeFileSync(pf, YAML.stringify(p));
  expect(run(root, "token", "--agent", "helper").code).toBe(1);
  p.agents.helper.slices = ["listed"]; writeFileSync(pf, YAML.stringify(p));
  expect(shellMintRefusal(root, "helper")).toBeUndefined();
});

test("G242: connect --browser with a wrong code changes nothing", () => {
  const root = makeBrain();
  const r = run(root, "connect", "steward", "--browser", "--code", "ZZZZZ-ZZZZZ");
  expect(r.code).toBe(1);
  expect(policy(root).agents.steward.browser).toBeUndefined();
});

test("G245: a one-time code is bound to the kind of key the owner made it for", () => {
  resetEnrollLimits();
  const root = makeBrain();
  // A plain code makes a plain or a reader key, never a resolver key.
  const plain = codeOf(runAction({ root }, "token-code", { agent: "steward" }));
  expect(run(root, "token", "--agent", "steward", "--role", "resolver", "--code", plain).code).toBe(1);
  expect(run(root, "token", "--agent", "steward", "--role", "reader", "--code", plain).code).toBe(0);
  // A resolver code, made as such on the dashboard, makes the resolver key and nothing else.
  const said = runAction({ root }, "token-code", { agent: "steward", role: "resolver" });
  expect(said).toContain("--role resolver");
  const res = codeOf(said);
  expect(run(root, "token", "--agent", "steward", "--code", res).code).toBe(1);
  const ok = run(root, "token", "--agent", "steward", "--role", "resolver", "--code", res);
  expect(ok.code).toBe(0);
  expect(tokenOwner(root, ok.token)).toEqual({ agent: "steward", role: "resolver" });
});

test("G245: wrong codes from the terminal count across processes", () => {
  resetEnrollLimits();
  const root = makeBrain();
  const good = codeOf(runAction({ root }, "token-code", { agent: "steward" }));
  for (let i = 0; i < ENROLL_FAILS_PER_WINDOW; i++) run(root, "token", "--agent", "steward", "--code", `ZZZZZ-ZZZ${String(i).padStart(2, "0")}`);
  resetEnrollLimits(); // a new process
  const r = run(root, "token", "--agent", "steward", "--code", good);
  expect(r.code).toBe(1);
  expect(r.out).toContain("too many");
});
