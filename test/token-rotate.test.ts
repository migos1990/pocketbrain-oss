// SPDX-License-Identifier: AGPL-3.0-only
// `pocketbrain token rotate <agent>` (docs/add-an-agent.md#rotating-a-token): a new token, the old
// one still working for an overlap (24 h unless told), then refused and dropped, so a pasted
// assistant never breaks mid-rotation. Doctor warns on a token older than 90 days.
import { test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { issueToken, rotateToken, tokenOwner, tokenInfo } from "../src/auth";
import { doctor } from "../src/doctor";
import { main } from "../src/cli";
import { runAction } from "../src/dashboard/actions";

afterEach(() => { delete process.env.PB_NOW; delete process.env.PB_TODAY; });
const at = (iso: string) => { process.env.PB_NOW = iso; };
const tokensFile = (root: string) => readFileSync(join(root, "rules", "tokens.yaml"), "utf8");
const lastCommit = (root: string) => Bun.spawnSync(["git", "log", "-1", "--format=%an %s"], { cwd: root }).stdout.toString().trim();
const cli = (args: string[]) => {
  const out: string[] = [], err: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.join(" ")); };
  let code: number;
  try { code = main(args); } finally { console.log = log; console.error = error; }
  return { code, out: out.join("\n"), err: err.join("\n") };
};

test("rotate: both tokens work during the overlap; after it the old one is refused and dropped", () => {
  const root = makeBrain();
  at("2026-10-16T10:00:00Z");
  const old = issueToken(root, "planner");
  const r = rotateToken(root, "planner");
  expect(r.expires).toBe("2026-10-17T10:00:00.000Z");
  expect(r.expiring).toBe(1);
  expect(tokenOwner(root, old)?.agent).toBe("planner");
  expect(tokenOwner(root, r.token)?.agent).toBe("planner");
  expect(lastCommit(root)).toContain("owner: planner token rotated");
  at("2026-10-17T10:00:01Z");
  expect(tokenOwner(root, old)).toBeUndefined();
  expect(tokenOwner(root, r.token)?.agent).toBe("planner");
  expect(tokenInfo(root).planner!.length).toBe(1);
  // The next owner change to tokens.yaml drops the expired line.
  issueToken(root, "helper");
  expect(tokensFile(root).match(/hash:/g)!.length).toBe(2);
});

test("rotate keeps the role: a reader token rotates to a reader token, and the plain token is untouched", () => {
  const root = makeBrain();
  at("2026-10-16T10:00:00Z");
  const plain = issueToken(root, "planner");
  const reader = issueToken(root, "planner", "reader");
  const r = rotateToken(root, "planner", { role: "reader", overlapHours: 2 });
  expect(tokenOwner(root, r.token)).toEqual({ agent: "planner", role: "reader" });
  at("2026-10-16T12:00:01Z");
  expect(tokenOwner(root, reader)).toBeUndefined();
  expect(tokenOwner(root, plain)).toEqual({ agent: "planner" });
});

test("a second rotate never extends an old token's overlap", () => {
  const root = makeBrain();
  at("2026-10-16T10:00:00Z");
  const old = issueToken(root, "planner");
  rotateToken(root, "planner", { overlapHours: 1 });
  at("2026-10-16T10:30:00Z");
  rotateToken(root, "planner", { overlapHours: 48 });
  at("2026-10-16T11:00:01Z");
  expect(tokenOwner(root, old)).toBeUndefined();
});

test("rotate refuses the gardener (it rotates itself), an agent with no outside seat, and odd overlaps", () => {
  const root = makeBrain();
  issueToken(root, "planner");
  expect(() => rotateToken(root, "gardener")).toThrow(/gardener rotate/);
  expect(() => rotateToken(root, "no-such-agent")).toThrow(/outside agent/);
  expect(() => rotateToken(root, "planner", { overlapHours: -1 })).toThrow(/overlap/);
  expect(() => rotateToken(root, "planner", { overlapHours: 24 * 8 })).toThrow(/overlap/);
  expect(() => rotateToken(root, "steward", { role: "resolver" })).toThrow(/resolver token carries your own texts/);
});

test("the command shows what it would do first; --yes prints the token once with the paste, the old one's end, and how to end it now", () => {
  const root = makeBrain();
  at("2026-10-16T10:00:00Z");
  issueToken(root, "planner");
  const before = tokensFile(root);
  const p = cli(["token", "rotate", "planner", "--brain", root]);
  expect(p.code).toBe(0);
  expect(p.out).toContain("planner sees: area:work");
  expect(p.out).toContain("run the same command with --yes");
  expect(p.out).not.toMatch(/pb_planner_/);
  expect(tokensFile(root)).toBe(before);
  // planner is core, so from a terminal it takes the owner's one-time code (G184, mintFromShell).
  const code = runAction({ root }, "token-code", { agent: "planner" }).match(/[0-9A-Z]{5}-[0-9A-Z]{5}/)![0];
  const y = cli(["token", "rotate", "planner", "--yes", "--code", code, "--overlap", "6", "--url", "https://brain.example", "--brain", root]);
  expect(y.code).toBe(0);
  expect(y.out.match(/pb_planner_[A-Za-z0-9_-]+/g)!.length).toBeGreaterThan(0);
  expect(y.out).toContain("URL:    https://brain.example/mcp");
  expect(y.out).toContain("the old token keeps working until 2026-10-16 16:00 UTC");
  expect(y.out).toContain("Paste the new token into planner now");
});

// Outside review 2026-10-25 (G419): a token never rotated used to live forever.
test("a token expires 90 days after it was issued unless rotated; doctor warns 14 days ahead and names the expired one", async () => {
  const root = makeBrain();
  at("2026-06-01T10:00:00Z");
  const old = issueToken(root, "planner");
  at("2026-07-20T10:00:00Z");
  const soon = issueToken(root, "steward");
  at("2026-10-16T10:00:00Z");
  process.env.PB_TODAY = "2026-10-16";
  const fresh = issueToken(root, "helper");
  expect(tokenOwner(root, old)).toBeUndefined();
  expect(tokenOwner(root, soon)?.agent).toBe("steward");
  expect(tokenOwner(root, fresh)?.agent).toBe("helper");
  const f = (await doctor(root, { offline: true })).filter((x) => x.area === "tokens");
  expect(f.some((x) => x.level === "warn" && x.text.includes("planner") && x.text.includes("expired") && x.text.includes("pocketbrain token rotate planner"))).toBe(true);
  expect(f.some((x) => x.level === "warn" && x.text.includes("steward") && x.text.includes("expires") && x.text.includes("pocketbrain token rotate steward"))).toBe(true);
  expect(f.some((x) => x.level === "warn" && x.text.includes("helper"))).toBe(false);
  // A rotation gives a fresh 90 days.
  at("2026-10-17T10:00:00Z");
  const next = rotateToken(root, "steward").token;
  at("2026-12-01T10:00:00Z");
  expect(tokenOwner(root, next)?.agent).toBe("steward");
});