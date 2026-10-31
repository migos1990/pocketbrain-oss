// SPDX-License-Identifier: AGPL-3.0-only
// Hub operations end to end with real clones and real SSH signing keys: a home hub and a laptop
// replica, ops queued offline and replayed, forged pushes refused, the hub failing over to the
// laptop, and the old hub stepping down when it comes back.
import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { loadBrain, type FactRecord } from "../src/brain";
import * as hub from "../src/hub";
import { main } from "../src/cli";
import { registerLouisMessages } from "../src/louis";
import { doctor } from "../src/doctor";

const sh = (cwd: string, ...cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } });
  return r.stdout.toString().trim();
};
const fact = (root: string, id: string, attr: string) => loadBrain(root).find((n) => n.fm.id === id)?.fm.facts?.[attr] as FactRecord | undefined;
const head = (root: string) => sh(root, "git", "rev-parse", "HEAD");
const req = (value: string, as_of = "2026-10-08") => ({ agent: "planner", id: "projects/course-a", attribute: "next_step", value, as_of, sources: ["gmail:f000000000000006"], verification: "verified-by-source" as const });

let keys: string;
const key = (n: string) => join(keys, n);
beforeAll(() => {
  // These tests sign real commits; they fail loudly, never skip, without ssh-keygen.
  if (!hub.hasSshKeygen()) throw new Error("install ssh-keygen (openssh-client) for the signed-commit tests in test/hub.test.ts");
  keys = mkdtempSync(join(tmpdir(), "pb-keys-"));
  for (const n of ["home", "laptop", "stranger"]) sh(keys, "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", `${n}@pb`, "-f", key(n));
});
const pub = (n: string) => readFileSync(key(n) + ".pub", "utf8").trim();

// A hub at home and a laptop replica, both signing, each listing the other's git address.
function pair() {
  const home = makeBrain();
  hub.init(home, { name: "home", key: key("home"), git: home });
  const laptop = mkdtempSync(join(tmpdir(), "pb-laptop-"));
  sh(tmpdir(), "git", "clone", "-q", home, laptop);
  const say = hub.init(laptop, { name: "laptop", key: key("laptop"), git: laptop });
  expect(say.join("\n")).toContain("hub add-replica laptop");
  hub.addReplica(home, "laptop", { signing_key: pub("laptop"), git: laptop });
  expect(hub.sync(laptop).problems).toEqual([]);
  return { home, laptop };
}

test("E2E: a laptop write queues as a signed op, the hub replays it, the laptop follows", () => {
  const { home, laptop } = pair();
  expect(hub.hubRole(home).mode).toBe("hub");
  expect(hub.hubRole(laptop).mode).toBe("replica");

  // Offline on the laptop: the write is queued, not applied.
  const w = write(laptop, req("Publish grades"));
  expect(w.outcome).toBe("queued");
  expect(w.file).toMatch(/^ops\/laptop\/[0-9A-Z]{26}\.json$/);
  expect(fact(laptop, "projects/course-a", "next_step")?.value).toBe("Grade the midterm");
  expect(hub.signerOf(laptop, "HEAD", hub.loadHub(laptop)!)).toBe("laptop");

  // The laptop can't commit anything but its own ops.
  expect(() => registerLouisMessages(laptop, ["imsg:phonemsg-1"], "test")).toThrow(/laptop is a replica; home is the hub/);
  sh(laptop, "git", "reset", "-q", "--hard");

  // Sync: the op goes to the hub's inbound branch; the hub ingests and replays it.
  expect(hub.sync(laptop).pushed).toBe(1);
  const s = hub.sync(home);
  expect(s.ingest?.received).toEqual({ laptop: 1 });
  expect(s.replay?.applied.map((a) => a.outcome)).toEqual(["committed"]);
  expect(fact(home, "projects/course-a", "next_step")?.value).toBe("Publish grades");
  const applied = readdirSync(join(home, "ops/applied/2026-10"));
  expect(applied).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(home, "ops/applied/2026-10", applied[0]), "utf8")).applied.outcome).toBe("committed");
  // The write itself is authored by the agent, as always; the hub signed it.
  expect(sh(home, "git", "log", "-3", "--format=%an")).toContain("planner");

  // The laptop moves to the hub's main: same fact, nothing left to send.
  const back = hub.sync(laptop);
  expect(back.pushed).toBe(0);
  expect(head(laptop)).toBe(head(home));
  expect(fact(laptop, "projects/course-a", "next_step")?.value).toBe("Publish grades");
  expect(hub.verifyHistory(home, undefined).problems).toEqual([]);
});

test("E2E: the same op twice, or after it was applied, changes nothing", () => {
  const { home, laptop } = pair();
  write(laptop, req("Publish grades"));
  write(laptop, req("Publish grades")); // a retry: a second op file, same content
  hub.sync(laptop);
  const r = hub.sync(home).replay!.applied.map((a) => a.outcome);
  expect(r).toEqual(["committed", "noop"]);
  const n = head(home);
  expect(hub.sync(home).replay!.applied).toEqual([]);
  expect(head(home)).toBe(n);
});

test("E2E: ops in one batch apply by as_of; an older value arriving after a newer one is a dispute", () => {
  const { home, laptop } = pair();
  write(laptop, req("Newer step", "2026-10-08"));
  write(laptop, req("Older step", "2026-10-05"));
  hub.sync(laptop);
  expect(hub.sync(home).replay!.applied.map((a) => a.outcome)).toEqual(["committed", "committed"]);
  expect(fact(home, "projects/course-a", "next_step")?.value).toBe("Newer step");
  // Late: the older value only reaches the hub after the newer one is live. write() doesn't
  // guess; Robin sees both.
  hub.sync(laptop);
  write(laptop, req("Late older step", "2026-10-06"));
  hub.sync(laptop);
  expect(hub.sync(home).replay!.applied.map((a) => a.outcome)).toEqual(["disputed"]);
});

test("security: the hub refuses inbound commits that aren't the replica's own signed ops", () => {
  const { home, laptop } = pair();
  // 1. Signed by the laptop, but edits a note instead of adding an op.
  writeFileSync(join(laptop, "people/forged.md"), "---\nid: people/forged\n---\n");
  sh(laptop, "git", "add", "people/forged.md");
  sh(laptop, "git", "commit", "-q", "-m", "forged");
  sh(laptop, "git", "push", "-q", "--force", home, "HEAD:refs/heads/inbound/laptop");
  let s = hub.sync(home);
  expect(s.ingest?.refused.laptop).toMatch(/outside ops\/laptop\//);
  expect(existsSync(join(home, "people/forged.md"))).toBe(false);
  expect(readFileSync(join(home, "log/alerts.jsonl"), "utf8")).toContain("inbound_refused");

  // 2. An op file signed by a key that isn't the laptop's.
  sh(laptop, "git", "reset", "-q", "--hard", "HEAD~1");
  const id = hub.ulid();
  sh(laptop, "mkdir", "-p", "ops/laptop");
  writeFileSync(join(laptop, `ops/laptop/${id}.json`), JSON.stringify({ request_id: id, replica: "laptop", by: "planner", ...req("Stranger's step"), agent: undefined }));
  sh(laptop, "git", "add", `ops/laptop/${id}.json`);
  sh(laptop, "git", "-c", `user.signingkey=${key("stranger")}`, "commit", "-q", "-m", "op");
  sh(laptop, "git", "push", "-q", "--force", home, "HEAD:refs/heads/inbound/laptop");
  s = hub.sync(home);
  expect(s.ingest?.refused.laptop).toMatch(/isn't signed by laptop's key/);

  // 3. Unsigned.
  sh(laptop, "git", "-c", "commit.gpgsign=false", "commit", "-q", "--amend", "--no-edit");
  sh(laptop, "git", "push", "-q", "--force", home, "HEAD:refs/heads/inbound/laptop");
  expect(hub.sync(home).ingest?.refused.laptop).toMatch(/isn't signed/);
  expect(fact(home, "projects/course-a", "next_step")?.value).toBe("Grade the midterm");
});

test("security: history verification catches a replica's signed edit and an unsigned commit", () => {
  const { home, laptop } = pair();
  const base = head(laptop);
  // The laptop bypasses the gate with raw git and edits a note, signed with its own key.
  appendFileSync(join(laptop, "projects/course-a.md"), "\nedited on the laptop\n");
  sh(laptop, "git", "commit", "-q", "-am", "edit");
  let v = hub.verifyHistory(laptop, base);
  expect(v.problems[0]).toMatch(/signed by laptop, which wasn't the hub \(home\), and changes projects\/course-a\.md/);
  // An unsigned commit on the hub.
  const hb = head(home);
  appendFileSync(join(home, "projects/course-a.md"), "\nunsigned\n");
  sh(home, "git", "-c", "commit.gpgsign=false", "commit", "-q", "-am", "unsigned");
  v = hub.verifyHistory(home, hb);
  expect(v.problems[0]).toMatch(/not signed by any key/);
  // The hub's own signed work verifies.
  sh(home, "git", "reset", "-q", "--hard", hb);
  write(home, req("Publish grades"));
  expect(hub.verifyHistory(home, hb).problems).toEqual([]);
});

test("security: the write log's hash chain shows an edited line", () => {
  const { home } = pair();
  write(home, req("Publish grades"));
  write(home, req("Another step", "2026-10-08"));
  expect(hub.verifyWriteLog(home).problems).toEqual([]);
  const f = join(home, "log/writes.jsonl");
  writeFileSync(f, readFileSync(f, "utf8").replace('"agent":"planner"', '"agent":"helper"'));
  expect(hub.verifyWriteLog(home).problems[0]).toMatch(/line 1: hash doesn't match/);
});

test("E2E failover: home goes dark, the laptop is promoted and replays its queue; home steps down when it's back", () => {
  const { home, laptop } = pair();
  // Home is unreachable (powered off). The laptop keeps working: writes queue.
  const parked = home + "-off";
  renameSync(home, parked);
  expect(write(laptop, req("Written while home was dark", "2026-10-06")).outcome).toBe("queued");
  expect(hub.sync(laptop).problems[0]).toMatch(/hub home unreachable/);

  const p = hub.promote(laptop, "laptop");
  expect(p.epoch).toBe(2);
  expect(p.replay.applied.map((a) => a.outcome)).toEqual(["committed"]);
  expect(hub.hubRole(laptop).mode).toBe("hub");
  expect(fact(laptop, "projects/course-a", "next_step")?.value).toBe("Written while home was dark");
  expect(p.next.join("\n")).toMatch(/home was unreachable/);
  expect(hub.verifyHistory(laptop, undefined).problems).toEqual([]);

  // Home comes back still believing it is hub, and commits once (an agent wrote to it).
  renameSync(parked, home);
  expect(write(home, req("Split-brain write", "2026-10-07")).outcome).toBe("committed");
  // Its next sync (or server tick) sees epoch 2, parks that commit and becomes a replica.
  const s = hub.sync(home);
  expect(s.role).toBe("replica");
  expect(s.orphaned).toMatch(/^orphaned\/2026-10-08-/);
  expect(hub.hubRole(home)).toMatchObject({ mode: "replica", name: "home" });
  expect(head(home)).toBe(head(laptop));
  expect(fact(home, "projects/course-a", "next_step")?.value).toBe("Written while home was dark");
  expect(sh(home, "git", "log", "-1", "--format=%an %s", s.orphaned!)).toMatch(/^planner planner: projects\/course-a#next_step/);
  // From now on home only queues, and won't serve agents.
  expect(write(home, req("After stepping down", "2026-10-08")).outcome).toBe("queued");
  expect(main(["serve", "--brain", home])).toBe(1);
  // Its queued op reaches the new hub like any replica's.
  hub.sync(home);
  expect(hub.sync(laptop).replay!.applied[0].outcome).toBe("committed");
  expect(fact(laptop, "projects/course-a", "next_step")?.value).toBe("After stepping down");
});

test("a stale copy can't move a clone back to an older epoch", () => {
  const { home, laptop } = pair();
  const old = mkdtempSync(join(tmpdir(), "pb-stale-"));
  sh(tmpdir(), "git", "clone", "-q", home, old); // a copy at epoch 1
  renameSync(home, home + "-off");
  hub.promote(laptop, "laptop");
  renameSync(home + "-off", home);
  // home, now behind, is told by the laptop; a sync from the stale copy is refused.
  hub.sync(home);
  const stale = hub.sync(home, { from: old });
  expect(stale.problems[0]).toMatch(/stale: it names home at epoch 1; this clone knows epoch 2/);
});

test("promote refuses a history that doesn't verify, unless forced", () => {
  const { home, laptop } = pair();
  appendFileSync(join(laptop, "projects/course-a.md"), "\nsneaky\n");
  sh(laptop, "git", "commit", "-q", "-am", "sneaky");
  renameSync(home, home + "-off");
  expect(() => hub.promote(laptop, "laptop")).toThrow(/not promoting, the history doesn't check out/);
  expect(hub.promote(laptop, "laptop", { force: true }).epoch).toBe(2);
});

test("a clone without a name commits nothing once hub mode is on", () => {
  const { home } = pair();
  const anon = mkdtempSync(join(tmpdir(), "pb-anon-"));
  sh(tmpdir(), "git", "clone", "-q", home, anon);
  expect(write(anon, req("x")).outcome).toBe("refused");
  expect(() => registerLouisMessages(anon, ["imsg:phonemsg-2"], "t")).toThrow(/no replica name/);
});

test("doctor reports role, signing, history, queue and snapshots", async () => {
  const { home, laptop } = pair();
  write(laptop, req("Queued"));
  const f = await doctor(laptop, { offline: true });
  const get = (area: string) => f.filter((x) => x.area === area).map((x) => `${x.level} ${x.text}`).join("\n");
  expect(get("hub")).toMatch(/^ok laptop is a replica; the hub is home \(epoch 1/);
  expect(get("signing")).toMatch(/^ok laptop signs with/);
  expect(get("history")).toMatch(/^ok/);
  expect(get("ops")).toMatch(/1 write\(s\) queued for home/);
  // Ports nothing listens on, so the test passes on a machine that is serving a real hub on 8787.
  const free = () => { const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); const p = s.port; s.stop(true); return p; };
  const port = free();
  writeFileSync(join(home, "rules/hub.yaml"), readFileSync(join(home, "rules/hub.yaml"), "utf8") + `port: ${port}\ndashboard_port: ${free()}\n`);
  const h = await doctor(home, { offline: false });
  const hget = (area: string) => h.filter((x) => x.area === area).map((x) => `${x.level} ${x.text}`).join("\n");
  expect(hget("replicas")).toMatch(/^ok laptop reachable/);
  expect(hget("server")).toContain(`Nothing answers on 127.0.0.1:${port}`);
  expect(hget("door")).toMatch(/no public_url/i);
  expect(hget("snapshots")).toMatch(/no snapshot to fall back on/i);
  expect(hget("dashboard")).toMatch(/^ok/);
});

test("doctor flags a tunnel that forwards the dashboard, and a quick-tunnel address", async () => {
  const { home } = pair();
  const cf = join(home, "..", `cf-${Date.now()}.yml`);
  writeFileSync(cf, "tunnel: pb\ningress:\n  - hostname: x.trycloudflare.com\n    service: http://127.0.0.1:8788\n  - service: http_status:404\n");
  const cfg = hub.loadHub(home)!;
  writeFileSync(join(home, "rules/hub.yaml"), readFileSync(join(home, "rules/hub.yaml"), "utf8") + `public_url: https://x.trycloudflare.com\ntunnel: { kind: cloudflare, name: pb, config: ${cf} }\n`);
  expect(cfg.hub).toBe("home");
  const f = await doctor(home, { offline: true });
  const door = f.filter((x) => x.area === "door");
  expect(door.find((x) => /quick tunnel/.test(x.text))?.level).toBe("FAIL");
  expect(door.find((x) => /routes to the dashboard port 8788/.test(x.text))?.level).toBe("FAIL");
  expect(hub.tunnelConfig(home)).toContain("path: ^/(mcp(/.*)?|v1/.*|b(/.*)?|health|openapi\\.json|\\.well-known/oauth-protected-resource/mcp/oauth)$");
});

test("doctor flags a tunnel config older than this version's ingress, with the command that prints the new one", async () => {
  const { home } = pair();
  const cf = join(home, "..", `cf-old-${Date.now()}.yml`);
  // Before the browser door: the same rule without b(/.*)?, as on a hub set up last week.
  writeFileSync(cf, "tunnel: pb\ningress:\n  - hostname: brain.example\n    path: ^/(mcp(/.*)?|v1/.*|health|openapi\\.json)$\n    service: http://127.0.0.1:8787\n  - service: http_status:404\n");
  writeFileSync(join(home, "rules/hub.yaml"), readFileSync(join(home, "rules/hub.yaml"), "utf8") + `public_url: https://brain.example\ntunnel: { kind: cloudflare, name: pb, config: ${cf} }\n`);
  const stale = (await doctor(home, { offline: true })).find((x) => x.area === "door" && /older than/.test(x.text));
  expect(stale?.level).toBe("warn");
  expect(stale?.text).toContain("pocketbrain hub tunnel-config");
  expect(stale?.text).toContain("/b");
  writeFileSync(cf, hub.tunnelConfig(home));
  expect((await doctor(home, { offline: true })).some((x) => x.area === "door" && /older than/.test(x.text))).toBe(false);
});

test("without rules/hub.yaml nothing changes: one machine, direct writes", () => {
  const root = makeBrain();
  expect(hub.hubRole(root).mode).toBe("single");
  expect(write(root, req("Publish grades")).outcome).toBe("committed");
});
