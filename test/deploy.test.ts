// SPDX-License-Identifier: AGPL-3.0-only
// Auto-update (scripts/deploy.ts) against real git repos: a GitHub stand-in with a release branch
// and tags, and the Mac's working copy cloned from it. Install, restart and health are fakes, so
// each path is driven: deploy, already current, rollback, down, blocked, untagged, held.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployOnce, newestTag, updatePlist, type Effects } from "../scripts/deploy";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
const sh = (cwd: string, ...a: string[]) => { const r = Bun.spawnSync(["git", ...a], { cwd, env, stdout: "pipe", stderr: "pipe" }); if (r.exitCode) throw new Error(r.stderr.toString()); return r.stdout.toString().trim(); };

// GitHub stand-in: main with v0.1.0, release branch at v0.1.0. The Mac clone runs v0.1.0.
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "pb-deploy-"));
  const origin = join(dir, "origin"), app = join(dir, "app");
  sh(dir, "init", "-q", "-b", "main", origin);
  writeFileSync(join(origin, "VERSION"), "0.1.0\n");
  sh(origin, "add", "-A"); sh(origin, "commit", "-q", "-m", "0.1.0"); sh(origin, "tag", "-a", "v0.1.0", "-m", "0.1.0");
  sh(origin, "branch", "release");
  sh(dir, "clone", "-q", origin, app);
  sh(app, "checkout", "-q", "--detach", "v0.1.0");
  const release = (v: string) => {
    writeFileSync(join(origin, "VERSION"), `${v}\n`);
    sh(origin, "commit", "-qam", v); sh(origin, "tag", "-a", `v${v}`, "-m", v);
    sh(origin, "branch", "-f", "release", `v${v}`);
  };
  const calls: string[] = [];
  const fx = (o: { healthy?: (version: string) => boolean; install?: boolean } = {}): Effects => ({
    install: () => { calls.push("install"); return o.install ?? true; },
    restart: () => { calls.push("restart"); return true; },
    healthy: async () => { const v = readFileSync(join(app, "VERSION"), "utf8").trim(); calls.push(`health ${v}`); return o.healthy ? o.healthy(v) : true; },
    log: () => {},
  });
  const state = join(dir, "deploy.json"), hold = join(dir, "deploy.hold");
  const once = (f: Effects) => deployOnce({ app, fx: f, state, hold, now: () => new Date("2026-10-15T22:00:00Z") });
  const running = () => readFileSync(join(app, "VERSION"), "utf8").trim();
  return { origin, app, release, fx, calls, once, running, state, hold };
}

test("a new release is checked out, installed, restarted and kept when the hub is healthy", async () => {
  const r = rig();
  r.release("0.2.0");
  const s = await r.once(r.fx());
  expect(s).toMatchObject({ status: "deployed", version: "v0.2.0", previous: "v0.1.0" });
  expect(r.running()).toBe("0.2.0");
  expect(r.calls).toEqual(["install", "restart", "health 0.2.0"]);
  expect(JSON.parse(readFileSync(r.state, "utf8")).status).toBe("deployed");
});

test("each pass records since when main has changes the release branch lacks (the self-check's release lag)", async () => {
  const r = rig();
  expect((await r.once(r.fx())).unreleased_since).toBeNull();
  writeFileSync(join(r.origin, "VERSION"), "0.1.1-dev\n");
  sh(r.origin, "commit", "-qam", "unreleased work");
  const s = await r.once(r.fx());
  expect(s.unreleased_since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(JSON.parse(readFileSync(r.state, "utf8")).unreleased_since).toBe(s.unreleased_since);
});

test("nothing new: no install, no restart", async () => {
  const r = rig();
  const s = await r.once(r.fx());
  expect(s).toMatchObject({ status: "current", version: "v0.1.0" });
  expect(r.calls).toEqual([]);
});

test("a release that doesn't come up healthy is rolled back to the version before", async () => {
  const r = rig();
  r.release("0.2.0");
  const s = await r.once(r.fx({ healthy: (v) => v !== "0.2.0" }));
  expect(s).toMatchObject({ status: "rolled-back", version: "v0.1.0", previous: "v0.2.0" });
  expect(r.running()).toBe("0.1.0");
  expect(r.calls).toEqual(["install", "restart", "health 0.2.0", "install", "restart", "health 0.1.0"]);
});

test("after a rollback the same bad tag isn't tried again; a newer one is (stranger rehearsal 2)", async () => {
  const r = rig();
  r.release("0.2.0");
  await r.once(r.fx({ healthy: (v) => v !== "0.2.0" }));
  r.calls.length = 0;
  const again = await r.once(r.fx({ healthy: (v) => v !== "0.2.0" }));
  expect(again).toMatchObject({ status: "rolled-back", version: "v0.1.0", previous: "v0.2.0" });
  expect(r.calls).toEqual([]);
  expect(r.running()).toBe("0.1.0");
  r.release("0.2.1");
  expect(await r.once(r.fx())).toMatchObject({ status: "deployed", version: "v0.2.1", previous: "v0.1.0" });
});

test("a failed install also rolls back, before any restart", async () => {
  const r = rig();
  r.release("0.2.0");
  let n = 0;
  const f = r.fx();
  const s = await r.once({ ...f, install: () => { r.calls.push("install"); return n++ > 0; } });
  expect(s.status).toBe("rolled-back");
  expect(r.calls).toEqual(["install", "install", "restart", "health 0.1.0"]);
});

test("when the old version doesn't come back either, the state says down", async () => {
  const r = rig();
  r.release("0.2.0");
  const s = await r.once(r.fx({ healthy: () => false }));
  expect(s.status).toBe("down");
  expect(s.detail).toContain("needs a look");
});

test("uncommitted changes in the working copy block the deploy and are left alone", async () => {
  const r = rig();
  r.release("0.2.0");
  writeFileSync(join(r.app, "VERSION"), "hand edit\n");
  const s = await r.once(r.fx());
  expect(s.status).toBe("blocked");
  expect(readFileSync(join(r.app, "VERSION"), "utf8")).toBe("hand edit\n");
  expect(r.calls).toEqual([]);
});

test("a release branch tip without a version tag is not deployed", async () => {
  const r = rig();
  writeFileSync(join(r.origin, "VERSION"), "untagged\n");
  sh(r.origin, "commit", "-qam", "untagged");
  sh(r.origin, "branch", "-f", "release", "main");
  const s = await r.once(r.fx());
  expect(s.status).toBe("error");
  expect(s.detail).toContain("carries no vX.Y.Z tag");
  expect(r.running()).toBe("0.1.0");
});

test("on hold, nothing moves", async () => {
  const r = rig();
  r.release("0.2.0");
  writeFileSync(r.hold, "x");
  expect((await r.once(r.fx())).status).toBe("held");
  expect(r.running()).toBe("0.1.0");
});

test("newest tag is by semver, not by text", () => {
  expect(newestTag(["v0.9.0", "v0.10.0", "v0.2.1", "nightly", ""])).toBe("v0.10.0");
  expect(newestTag(["nightly"])).toBeUndefined();
});

test("the launchd job runs a pass every N minutes and never keeps itself alive", () => {
  const p = updatePlist({ bun: "/opt/homebrew/bin/bun", app: "/Users/x/pocketbrain", home: "/Users/x", minutes: 10 });
  expect(p).toContain("<string>/Users/x/pocketbrain/scripts/deploy.ts</string>");
  expect(p).toContain("<key>StartInterval</key><integer>600</integer>");
  expect(p).not.toContain("KeepAlive");
  expect(p).not.toContain("tunnel");
});
