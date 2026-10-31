// SPDX-License-Identifier: AGPL-3.0-only
// The Mac takes a main sha (outside audit 2026-10-27): no vX.Y.Z tag has ever existed and cloud
// sessions can't push one, so the go flow is `bun scripts/deploy.ts go <sha>`. It checks out exactly
// that commit, restarts, and keeps it only when the restarted hub's own /health reports that sha;
// then it runs the real brain's north star once and reports its counts, report-only. Install,
// restart, health, the hub's code and the north star are fakes over real git repos.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployGo, deployOnce, type GoEffects } from "../scripts/deploy";
import { deployCheck, type NorthStarRecord } from "../src/probe";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
const sh = (cwd: string, ...a: string[]) => { const r = Bun.spawnSync(["git", ...a], { cwd, env, stdout: "pipe", stderr: "pipe" }); if (r.exitCode) throw new Error(r.stderr.toString()); return r.stdout.toString().trim(); };

// GitHub stand-in: main at v0.1.0 (the release branch too). The Mac clone runs it, and so does its hub.
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "pb-go-"));
  const origin = join(dir, "origin"), app = join(dir, "app");
  sh(dir, "init", "-q", "-b", "main", origin);
  writeFileSync(join(origin, "VERSION"), "0.1.0\n");
  sh(origin, "add", "-A"); sh(origin, "commit", "-q", "-m", "0.1.0"); sh(origin, "tag", "-a", "v0.1.0", "-m", "0.1.0");
  sh(origin, "branch", "release");
  sh(dir, "clone", "-q", origin, app);
  sh(app, "checkout", "-q", "--detach", "v0.1.0");
  const commit = (v: string, branch = "main") => {
    sh(origin, "checkout", "-q", branch);
    writeFileSync(join(origin, "VERSION"), `${v}\n`);
    sh(origin, "commit", "-qam", v);
    const sha = sh(origin, "rev-parse", "HEAD");
    sh(origin, "checkout", "-q", "main");
    return sha;
  };
  const head = () => sh(app, "rev-parse", "HEAD");
  const hub = { code: head() as string | undefined };
  const calls: string[] = [];
  const counts = { pass: false, asks: 8, not_conflict: 6, home_asks: 2, pages: 99, pages_ok: 63, share: 0.64 };
  const fx = (o: { healthy?: (version: string) => boolean; restartTakes?: boolean; reports?: boolean; northStar?: () => Promise<NorthStarRecord | undefined> } = {}): GoEffects => ({
    install: () => { calls.push("install"); return true; },
    restart: () => { calls.push("restart"); if (o.restartTakes !== false) hub.code = o.reports === false ? undefined : head(); return true; },
    healthy: async () => { const v = readFileSync(join(app, "VERSION"), "utf8").trim(); calls.push(`health ${v}`); return o.healthy ? o.healthy(v) : true; },
    code: async () => hub.code,
    northStar: o.northStar ?? (async (code) => { calls.push(`north-star ${code.slice(0, 7)}`); return { code, at: "2026-10-27T12:00:00Z", exit: 1, counts }; }),
    log: (l) => calls.push(`log ${l}`),
  });
  const state = join(dir, "deploy.json"), hold = join(dir, "deploy.hold");
  const go = (want: string, f: GoEffects) => deployGo({ app, want, fx: f, state, hold, now: () => new Date("2026-10-27T12:00:00Z") });
  return { dir, origin, app, commit, head, hub, calls, fx, go, state, hold, counts };
}
const steps = (calls: string[]) => calls.filter((c) => !c.startsWith("log "));
const logs = (calls: string[]) => calls.filter((c) => c.startsWith("log ")).join("\n");

test("go <sha> checks out exactly that main commit and keeps it when the restarted hub reports that sha", async () => {
  const r = rig();
  const was = r.head();
  const sha = r.commit("0.2.0");
  r.commit("0.3.0"); // main moved on: go takes the sha asked for, not main's tip
  const s = await r.go(sha.slice(0, 9), r.fx());
  expect(s).toMatchObject({ status: "deployed", mode: "go", sha, running: sha, previous: was });
  expect(r.head()).toBe(sha);
  expect(steps(r.calls)).toEqual(["install", "restart", "health 0.2.0", `north-star ${sha.slice(0, 7)}`]);
  expect(JSON.parse(readFileSync(r.state, "utf8"))).toMatchObject({ status: "deployed", sha, running: sha });
  expect(logs(r.calls)).toContain(`hub healthy and running ${sha.slice(0, 7)}`);
});

test("go main follows origin/main's tip", async () => {
  const r = rig();
  const tip = r.commit("0.2.0");
  expect(await r.go("main", r.fx())).toMatchObject({ status: "deployed", sha: tip, running: tip });
});

test("healthy is not enough: a hub that still reports the old sha is rolled back", async () => {
  const r = rig();
  const was = r.head();
  const sha = r.commit("0.2.0");
  const s = await r.go(sha, r.fx({ restartTakes: false }));
  expect(s).toMatchObject({ status: "rolled-back", sha: was, previous: sha });
  expect(s.detail).toContain(`reported ${was.slice(0, 7)}`);
  expect(r.head()).toBe(was);
  expect(steps(r.calls)).not.toContain(`north-star ${sha.slice(0, 7)}`);
});

test("a hub that reports no code at all is not verified, so it is rolled back", async () => {
  const r = rig();
  const sha = r.commit("0.2.0");
  const s = await r.go(sha, r.fx({ reports: false }));
  expect(s.status).toBe("rolled-back");
  expect(s.detail).toContain("reported no code");
});

test("an unhealthy hub is rolled back to the sha before, and the north star isn't run", async () => {
  const r = rig();
  const was = r.head();
  const sha = r.commit("0.2.0");
  const s = await r.go(sha, r.fx({ healthy: (v) => v !== "0.2.0" }));
  expect(s).toMatchObject({ status: "rolled-back", sha: was, running: was, previous: sha });
  expect(steps(r.calls)).toEqual(["install", "restart", "health 0.2.0", "install", "restart", "health 0.1.0"]);
  expect(r.head()).toBe(was);
});

test("a sha that isn't on main is refused and nothing moves", async () => {
  const r = rig();
  sh(r.origin, "branch", "side");
  const side = r.commit("side", "side");
  sh(r.app, "fetch", "-q", "origin", "+refs/heads/side:refs/remotes/origin/side");
  const was = r.head();
  const s = await r.go(side, r.fx());
  expect(s.status).toBe("error");
  expect(s.detail).toContain("not on origin/main");
  expect(r.head()).toBe(was);
  expect(steps(r.calls)).toEqual([]);
  expect((await r.go("nope123", r.fx())).status).toBe("error");
});

test("already running that sha: no restart, the north star still reported", async () => {
  const r = rig();
  const s = await r.go(r.head(), r.fx());
  expect(s).toMatchObject({ status: "current", running: r.head() });
  expect(steps(r.calls)).toEqual([`north-star ${r.head().slice(0, 7)}`]);
  expect(s.north_star?.counts).toMatchObject({ asks: 8 });
});

test("checked out but never restarted (the hub reports another sha): go restarts and verifies", async () => {
  const r = rig();
  const sha = r.commit("0.2.0");
  sh(r.app, "fetch", "-q", "origin");
  sh(r.app, "checkout", "-q", "--detach", sha); // by hand, no restart: the hub still runs 0.1.0
  const s = await r.go(sha, r.fx());
  expect(s).toMatchObject({ status: "deployed", running: sha });
  expect(steps(r.calls).slice(0, 3)).toEqual(["install", "restart", "health 0.2.0"]);
});

test("the north star's counts are in the output and deploy.json, and a FAIL doesn't change the deploy (report-only)", async () => {
  const r = rig();
  const sha = r.commit("0.2.0");
  const s = await r.go(sha, r.fx());
  expect(s.status).toBe("deployed");
  expect(s.north_star).toEqual({ code: sha, exit: 1, counts: r.counts });
  expect(logs(r.calls)).toContain(`north star (real brain, code ${sha.slice(0, 7)}): FAIL, 8 asks, 6 not about a contradiction, 2 on the home, 63/99 pages ok`);
  // A north star that can't run is a line, never a failed deploy.
  const r2 = rig();
  const sha2 = r2.commit("0.2.0");
  const s2 = await r2.go(sha2, r2.fx({ northStar: async () => { throw new Error("no brain"); } }));
  expect(s2.status).toBe("deployed");
  expect(logs(r2.calls)).toContain("north star: didn't run: no brain");
});

test("on hold, go doesn't move either", async () => {
  const r = rig();
  const sha = r.commit("0.2.0");
  writeFileSync(r.hold, "x");
  const s = await r.go(sha, r.fx());
  expect(s.status).toBe("held");
  expect(r.head()).not.toBe(sha);
});

test("the release follower never moves a hub that go put ahead of the release tag back", async () => {
  const r = rig();
  const sha = r.commit("0.2.0");
  await r.go(sha, r.fx());
  const s = await deployOnce({ app: r.app, fx: r.fx(), state: r.state, hold: r.hold });
  expect(s.status).toBe("current");
  expect(s.detail).toContain("not moving back");
  expect(r.head()).toBe(sha);
});

test("the probe's update check: a go record doesn't go stale, and its line carries the north star", () => {
  const cfg = mkdtempSync(join(tmpdir(), "pb-cfg-"));
  const prev = process.env.PB_CONFIG_DIR;
  process.env.PB_CONFIG_DIR = cfg;
  try {
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "deploy.json"), JSON.stringify({ status: "deployed", mode: "go", sha: "a".repeat(40), running: "a".repeat(40), detail: "deployed aaaaaaa (was bbbbbbb); hub healthy and running aaaaaaa", north_star: { code: "a".repeat(40), exit: 1, counts: { pass: false, asks: 8, not_conflict: 6, home_asks: 2, pages: 99, pages_ok: 63 } }, checked_at: "2026-10-20T12:00:00Z" }));
    const c = deployCheck(new Date("2026-10-27T12:00:00Z"));
    expect(c?.ok).toBe(true);
    expect(c?.detail).toContain("running aaaaaaa");
    expect(c?.detail).toContain("north star FAIL, 8 asks");
  } finally { if (prev === undefined) delete process.env.PB_CONFIG_DIR; else process.env.PB_CONFIG_DIR = prev; }
});

test("deploy go checks the hub on loopback only: another health URL is refused before anything moves", async () => {
  const { loopbackHealth } = await import("../scripts/deploy");
  expect(loopbackHealth("http://127.0.0.1:8787/health")).toBe(true);
  expect(loopbackHealth("http://localhost:9000/health")).toBe(true);
  expect(loopbackHealth("http://[::1]:8787/health")).toBe(true);
  expect(loopbackHealth("https://brain.example/health")).toBe(false);
  expect(loopbackHealth("not a url")).toBe(false);
  const p = Bun.spawnSync(["bun", "scripts/deploy.ts", "go", "main", "--health", "https://brain.example/health", "--app", mkdtempSync(join(tmpdir(), "pb-app-"))], { cwd: join(import.meta.dir, ".."), env: { ...process.env, PB_CONFIG_DIR: mkdtempSync(join(tmpdir(), "pb-cfg-")) }, stdout: "pipe", stderr: "pipe" });
  expect(p.exitCode).toBe(2);
  expect(p.stderr.toString()).toContain("loopback");
});
