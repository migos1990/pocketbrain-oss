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
import type { PageRead } from "../src/proofread";

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
  const go = (want: string, f: GoEffects, o: { mark?: boolean } = {}) => deployGo({ app, want, fx: f, state, hold, now: () => new Date("2026-10-27T12:00:00Z"), ...o });
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

// G956 (2026-11-16): the brain-quotes report ran only when someone asked the Mac to, so a test that
// carried a brain page's words (PR 214) sat in main until the next hand run. deploy go now runs it
// for the code it just verified: file:line only, what is new since the last deploy, report-only.
test("go reports brain quotes for the code it deployed, new lines named by file:line, and never blocks", async () => {
  const r = rig();
  const quotes = [{ lines: 2, hits: ["test/a.test.ts:3", "docs/b.md:9"] }, { lines: 3, hits: ["test/a.test.ts:3", "docs/b.md:9", "test/c.test.ts:16"] }];
  const f = (i: number) => ({ ...r.fx(), brainQuotes: async (code: string) => { r.calls.push(`quotes ${code.slice(0, 7)}`); return quotes[i]; } });
  const s1 = await r.go(r.commit("0.2.0"), f(0));
  expect(s1.status).toBe("deployed");
  expect(s1.brain_quotes).toEqual(quotes[0]);
  expect(logs(r.calls)).toContain("brain quotes: 2 line(s) in tracked files repeat 8 words of a brain page (report only, words never printed); first count");
  const s2 = await r.go(r.commit("0.3.0"), f(1));
  expect(s2.status).toBe("deployed");
  expect(logs(r.calls)).toContain("; 1 new since the last deploy: test/c.test.ts:16");
  // A report that can't run says so and the deploy stands; the last count is kept for next time.
  const s3 = await r.go(r.commit("0.4.0"), { ...r.fx(), brainQuotes: async () => { throw new Error("no brain folder known"); } });
  expect(s3.status).toBe("deployed");
  expect(logs(r.calls)).toContain("brain quotes: didn't run: no brain folder known");
  expect(s3.brain_quotes).toEqual(quotes[1]);
  expect(JSON.parse(readFileSync(r.state, "utf8")).brain_quotes).toEqual(quotes[1]);
});

// G971: a report-only step that printed nothing at 0 could not be told apart from one that never
// ran, so go prints its count at 0 too, first time and after a deploy that had lines.
test("go prints the brain-quotes line at 0, so a clean report is seen to have run", async () => {
  const r = rig();
  const f = (q: { lines: number; hits: string[] }) => ({ ...r.fx(), brainQuotes: async () => q });
  await r.go(r.commit("0.2.0"), f({ lines: 0, hits: [] }));
  expect(logs(r.calls)).toContain("brain quotes: 0 line(s) in tracked files repeat 8 words of a brain page (report only, words never printed); first count");
  await r.go(r.commit("0.3.0"), f({ lines: 1, hits: ["docs/b.md:9"] }));
  await r.go(r.commit("0.4.0"), f({ lines: 0, hits: [] }));
  expect(logs(r.calls)).toContain("brain quotes: 0 line(s) in tracked files repeat 8 words of a brain page (report only, words never printed); none new since the last deploy");
});

// G1009 (2026-11-19): every green main went to the public repo before anything that knows the
// brain's words had looked at it. go now marks the sha it verified, for the public workflow, only
// when the brain-quotes report ran on it and named no line the last marked sha didn't have.
test("go marks a sha for the public repo only when the brain-quotes report ran and found nothing new", async () => {
  const r = rig();
  const marked: string[] = [];
  const f = (q: (() => { lines: number; hits: string[] }) | undefined) => ({ ...r.fx(), ...(q ? { brainQuotes: async () => q() } : {}), markChecked: (sha: string) => { marked.push(sha); return true; } });
  // A clean first count is marked.
  const a = r.commit("0.2.0");
  const s1 = await r.go(a, f(() => ({ lines: 0, hits: [] })), { mark: true });
  expect(marked).toEqual([a]);
  expect(s1.public_checked).toEqual({ sha: a, hits: [] });
  expect(logs(r.calls)).toContain(`public repo: ${a.slice(0, 7)} marked as checked`);
  // A new line: not marked, and the deploy stands.
  const b = r.commit("0.3.0");
  const s2 = await r.go(b, f(() => ({ lines: 1, hits: ["docs/b.md:9"] })), { mark: true });
  expect(s2.status).toBe("deployed");
  expect(marked).toEqual([a]);
  expect(logs(r.calls)).toContain(`public repo: ${b.slice(0, 7)} not marked: 1 line(s) repeat a brain page's words since the last marked commit: docs/b.md:9`);
  // The same line on the next deploy is still new against the last marked sha, not against the last deploy.
  const c = r.commit("0.4.0");
  const s3 = await r.go(c, f(() => ({ lines: 1, hits: ["docs/b.md:9"] })), { mark: true });
  expect(marked).toEqual([a]);
  expect(s3.public_checked).toEqual({ sha: a, hits: [] });
  // A report that didn't run marks nothing.
  const d = r.commit("0.5.0");
  await r.go(d, { ...f(undefined), brainQuotes: async () => { throw new Error("no brain folder known"); } }, { mark: true });
  expect(marked).toEqual([a]);
  expect(logs(r.calls)).toContain(`public repo: ${d.slice(0, 7)} not marked: the brain-quotes report didn't run`);
  // The line gone: marked again.
  const e = r.commit("0.6.0");
  const s5 = await r.go(e, f(() => ({ lines: 0, hits: [] })), { mark: true });
  expect(marked).toEqual([a, e]);
  expect(s5.public_checked).toEqual({ sha: e, hits: [] });
  // A mark that can't be pushed says so and keeps the last one.
  const g = r.commit("0.7.0");
  const s6 = await r.go(g, { ...f(() => ({ lines: 0, hits: [] })), markChecked: () => false }, { mark: true });
  expect(s6.status).toBe("deployed");
  expect(s6.public_checked).toEqual({ sha: e, hits: [] });
  expect(logs(r.calls)).toContain(`public repo: ${g.slice(0, 7)} not marked: the tag could not be pushed`);
});

test("a first count that already has lines is not marked", async () => {
  const r = rig();
  const marked: string[] = [];
  await r.go(r.commit("0.2.0"), { ...r.fx(), brainQuotes: async () => ({ lines: 1, hits: ["docs/b.md:9"] }), markChecked: (sha: string) => { marked.push(sha); return true; } }, { mark: true });
  expect(marked).toEqual([]);
});

// G1113 (2026-11-19): with G1009 live, every deploy pushed the public tag when the report was clean
// and go had no way to leave it out, so a deploy published as a side effect and the Mac held every
// deploy until the owner spoke. Marking is its own switch, off unless the owner turned it on.
test("a deploy marks nothing for the public repo unless marking is on", async () => {
  const r = rig();
  const marked: string[] = [];
  const f = () => ({ ...r.fx(), brainQuotes: async () => ({ lines: 0, hits: [] }), markChecked: (sha: string) => { marked.push(sha); return true; } });
  const a = r.commit("0.2.0");
  const s1 = await r.go(a, f());
  expect(s1.status).toBe("deployed");
  expect(marked).toEqual([]);
  expect(s1.public_checked).toBeUndefined();
  expect(logs(r.calls)).toContain(`public repo: ${a.slice(0, 7)} is clear to mark and was not marked: marking is off`);
  // The same sha, already running, marked by itself once the owner says so: no second deploy.
  const s2 = await r.go(a, f(), { mark: true });
  expect(s2.status).toBe("current");
  expect(marked).toEqual([a]);
  expect(r.calls.filter((c) => c === "restart").length).toBe(1);
});

// G984: the owner found odd sentences and a slow page on his phone after a deploy. go now reads his
// pages on the real brain with the code before and the code after, and prints what changed: counts
// and milliseconds only, report-only.
test("go reads the owner's pages before and after the change and says what the new code did, and never blocks", async () => {
  const r = rig();
  const reads: PageRead[] = [
    { pages: 40, failed: 0, odd: 3, odd_pages: 2, by_rule: { doubled: 3 }, by_kind: {}, median_ms: 20, p95_ms: 60, max_ms: 90, slow: 0 },
    { pages: 40, failed: 0, odd: 5, odd_pages: 4, by_rule: { doubled: 2, "machine-date": 3 }, by_kind: {}, median_ms: 22, p95_ms: 400, max_ms: 900, slow: 2 },
  ];
  let i = 0;
  const s = await r.go(r.commit("0.2.0"), { ...r.fx(), pageRead: async () => { r.calls.push(`read v${readFileSync(join(r.app, "VERSION"), "utf8").trim()}`); return reads[i++]; } });
  expect(s.status).toBe("deployed");
  // The first reading is taken on the old checkout, before anything is installed; the second after the hub is verified.
  expect(steps(r.calls).filter((c) => /^(read|install|restart)/.test(c))).toEqual(["read v0.1.0", "install", "restart", "read v0.2.0"]);
  expect(logs(r.calls)).toContain("pages read: 5 odd sentences on 4 of 40 pages, 2 more than on the code before (machine-date +3, doubled -1); a page renders in 22 ms at the median (was 20), 900 ms at the slowest (was 90), 2 over 300 ms (was 0); by rule: machine-date 3, doubled 2; WORSE than the code before: sentences and speed (report only; counts and milliseconds, never a page's name or words)");
  expect(s.page_read).toEqual(reads[1]);
  expect(JSON.parse(readFileSync(r.state, "utf8")).page_read).toEqual(reads[1]);
});

test("go with no reading from the code before says so; a reading that fails says so and the deploy stands", async () => {
  const r = rig();
  const one: PageRead = { pages: 12, failed: 1, odd: 0, odd_pages: 0, by_rule: {}, by_kind: {}, median_ms: 9, p95_ms: 30, max_ms: 31, slow: 0 };
  let n = 0;
  // The code that was running has no such script: the first call answers nothing.
  const s1 = await r.go(r.commit("0.2.0"), { ...r.fx(), pageRead: async () => (n++ === 0 ? undefined : one) });
  expect(s1.status).toBe("deployed");
  expect(logs(r.calls)).toContain("pages read: 0 odd sentences on 0 of 12 pages; a page renders in 9 ms at the median, 31 ms at the slowest, 0 over 300 ms; 1 page failed to render; no reading on the code before, so nothing to compare (report only;");
  const s2 = await r.go(r.commit("0.3.0"), { ...r.fx(), pageRead: async () => { throw new Error("no brain folder known"); } });
  expect(s2.status).toBe("deployed");
  expect(logs(r.calls)).toContain("pages read: didn't run: no brain folder known");
  expect(s2.page_read).toEqual(one); // the last reading is kept
  // A deploy that rolls back prints no after-reading: the old code is running again.
  const before = r.calls.length;
  const s3 = await r.go(r.commit("0.4.0"), { ...r.fx({ healthy: (v) => v !== "0.4.0" }), pageRead: async () => one });
  expect(s3.status).toBe("rolled-back");
  expect(r.calls.slice(before).filter((c) => c.startsWith("log pages read")).length).toBe(0);
});

test("go on a checkout already moved by hand takes no reading 'before': the new code would be read twice", async () => {
  const r = rig();
  const sha = r.commit("0.2.0");
  const sh = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", "-C", cwd, ...a]);
  sh(r.app, "fetch", "-q", "origin"); sh(r.app, "checkout", "-q", "--detach", sha); // by hand, no restart: the hub still runs 0.1.0
  const one: PageRead = { pages: 12, failed: 0, odd: 4, odd_pages: 3, by_rule: { doubled: 4 }, by_kind: {}, median_ms: 9, p95_ms: 30, max_ms: 31, slow: 0 };
  let n = 0;
  const s = await r.go(sha, { ...r.fx(), pageRead: async () => { n++; return one; } });
  expect(s.status).toBe("deployed");
  expect(n).toBe(1);
  expect(logs(r.calls)).toContain("no reading on the code before, so nothing to compare");
  expect(logs(r.calls)).not.toContain("the same");
});
