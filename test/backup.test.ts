// SPDX-License-Identifier: AGPL-3.0-only
// Backups end to end with real age keys, real git bundles and real SSH signing keys: back up,
// lose the machine, restore on a clean one, prove nothing changed; plus the ways it must refuse.
import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { loadBrain, type FactRecord } from "../src/brain";
import * as hub from "../src/hub";
import * as bk from "../src/backup";

const sh = (cwd: string, ...cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};
const fact = (root: string, id: string, attr: string) => loadBrain(root).find((n) => n.fm.id === id)?.fm.facts?.[attr] as FactRecord | undefined;
let n = 0; // each write a new attribute, so none is a conflict with the last
const req = (value: string, attribute = `step_${++n}`) => ({ agent: "planner", id: "projects/course-a", attribute, value, as_of: "2026-10-08", sources: ["gmail:f000000000000006"], verification: "verified-by-source" as const });
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const cli = (...args: string[]) => sh(join(import.meta.dir, ".."), "bun", "src/cli.ts", ...args);

let keys: string, identity: string, pub: string, otherIdentity: string;
beforeAll(() => {
  // Real keys; these tests fail loudly, never skip, without age or ssh-keygen.
  if (!Bun.which("age") || !Bun.which("age-keygen")) throw new Error("install age (brew install age / apt install age) for test/backup.test.ts");
  if (!hub.hasSshKeygen()) throw new Error("install ssh-keygen for test/backup.test.ts");
  keys = tmp("pb-bk-keys-");
  identity = join(keys, "louis.agekey");
  otherIdentity = join(keys, "stranger.agekey");
  sh(keys, "age-keygen", "-o", identity);
  sh(keys, "age-keygen", "-o", otherIdentity);
  pub = sh(keys, "age-keygen", "-y", identity).out;
  sh(keys, "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "home@pb", "-f", join(keys, "home"));
});

// A brain set up for backups the way `backup --init` leaves it, with a write and some state git
// doesn't carry: the read log, a text channel state file. Plus two secrets that must stay out.
function brainWithBackups(dest: string) {
  const root = makeBrain();
  expect(cli("backup", "--init", "--pub", pub, "--brain", root).code).toBe(0);
  const cfg = readFileSync(join(root, "rules", "backup.yaml"), "utf8").replace("dest: ~/pocketbrain-backups", `dest: ${dest}`);
  writeFileSync(join(root, "rules", "backup.yaml"), cfg);
  sh(root, "git", "commit", "-qam", "louis: backup folder");
  expect(write(root, req("Publish grades", "next_step")).outcome).toBe("committed");
  mkdirSync(join(root, "log"), { recursive: true });
  appendFileSync(join(root, "log", "reads.jsonl"), JSON.stringify({ at: "2026-10-08T10:00:00Z", agent: "planner", op: "read", ids: ["projects/course-a"] }) + "\n");
  mkdirSync(join(root, "textline"), { recursive: true });
  writeFileSync(join(root, "textline", "state.json"), JSON.stringify({ sent: 3 }));
  writeFileSync(join(root, ".env"), "TWILIO_AUTH_TOKEN=abcdef0123456789abcdef\n");
  writeFileSync(join(root, "textline", "debug.txt"), `token pb_planner_${"A".repeat(32)} pasted by mistake\n`);
  mkdirSync(join(root, "views"), { recursive: true });
  writeFileSync(join(root, "views", "planner.md"), "derived");
  return root;
}

test("E2E: back up, lose the machine, restore into an empty folder: same history, same state, working brain", async () => {
  const dest = tmp("pb-bk-dest-");
  const root = brainWithBackups(dest);
  const before = bk.fingerprint(root);

  const r = bk.backup(root);
  expect(r.file).toBe(join(dest, "brain-2026-10-08.tar.age"));
  expect(r.recorded).toBe(true);
  // log/last-backup is committed, so a freshness check can read it without seeing the backup.
  expect(sh(root, "git", "log", "-1", "--format=%an %s").out).toBe("backup backup: brain-2026-10-08.tar.age");
  expect(r.skipped.map((s) => s.path).sort()).toEqual([".env", "textline/debug.txt"]);

  // The file is ciphertext: no note text, no paths, no commit ids.
  const enc = readFileSync(r.file);
  for (const s of ["Publish grades", "projects/course-a", "rules/", r.head]) expect(enc.includes(Buffer.from(s))).toBe(false);

  // The machine is gone.
  const to = join(tmp("pb-bk-new-"), "brain");
  rmSync(root, { recursive: true, force: true });

  const res = await bk.restore(r.file, { to, identity });
  expect(res.head).toBe(before.head);
  expect(res.findings.filter((f) => f.level === "FAIL")).toEqual([]);
  const after = bk.fingerprint(to);
  expect(bk.diffFingerprints(before, after, [".env", "textline/debug.txt"])).toEqual([]);
  expect(fact(to, "projects/course-a", "next_step")?.value).toBe("Publish grades");
  expect(readFileSync(join(to, "log", "reads.jsonl"), "utf8")).toContain("projects/course-a");
  expect(existsSync(join(to, ".env"))).toBe(false);
  expect(existsSync(join(to, "textline", "debug.txt"))).toBe(false);
  expect(res.built.length).toBeGreaterThan(0);
  expect(existsSync(join(to, "views", `${res.built[0]}.md`))).toBe(true);
  // And it takes writes again.
  expect(write(to, req("Post the final")).outcome).toBe("committed");
});

test("E2E: a signed hub restores as the hub with its key from 1Password; doctor has no FAIL", async () => {
  const dest = tmp("pb-bk-dest-");
  const root = brainWithBackups(dest);
  hub.init(root, { name: "home", key: join(keys, "home"), git: root });
  expect(write(root, req("Grade the final")).outcome).toBe("committed");
  const before = bk.fingerprint(root);
  const r = bk.backup(root);
  const to = join(tmp("pb-bk-new-"), "brain");

  // Without the signing key the brain comes back, but doctor says what's missing.
  // (No global git config here: cloud sessions sign everything with their own key by default.)
  const globalConfig = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = join(keys, "empty-gitconfig");
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
  const noKey = await bk.restore(r.file, { to: join(tmp("pb-bk-nokey-"), "brain"), identity }).finally(() => {
    if (globalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = globalConfig;
  });
  expect(noKey.findings.some((f) => f.level === "FAIL" && f.area === "signing")).toBe(true);
  expect(noKey.next.join("\n")).toContain("hub init --name home --key");

  const res = await bk.restore(r.file, { to, identity, key: join(keys, "home") });
  expect(res.replica).toBe("home");
  expect(hub.hubRole(to).mode).toBe("hub");
  expect(res.findings.filter((f) => f.level === "FAIL")).toEqual([]);
  expect(res.findings.find((f) => f.area === "history")?.level).toBe("ok");
  expect(bk.diffFingerprints(before, bk.fingerprint(to), [".env", "textline/debug.txt"])).toEqual([]);
  // The restored hub signs its next commit with the same key and it verifies.
  expect(write(to, req("Close the course")).outcome).toBe("committed");
  expect(hub.verifyNew(to).problems).toEqual([]);
});

test("E2E: pocketbrain drill passes and says which key it proved", () => {
  const dest = tmp("pb-bk-dest-");
  const root = brainWithBackups(dest);
  const headBefore = sh(root, "git", "rev-parse", "HEAD").out;

  const given = cli("drill", "--identity", identity, "--brain", root);
  expect(given.err).toBe("");
  expect(given.code).toBe(0);
  expect(given.out).toContain("drill PASSED");
  expect(given.out).toContain("the 1Password key path is proven");
  expect(given.out).toContain("diff: none");
  expect(given.out).toContain("left out on purpose: .env (credential file)");

  const throwaway = cli("drill", "--brain", root);
  expect(throwaway.code).toBe(0);
  expect(throwaway.out).toContain("a throwaway key (mechanics only");

  // Restore from the CLI with the key on stdin, the way `op read ... |` hands it over.
  const r = bk.backup(root, { record: false });
  const to = join(tmp("pb-bk-cli-"), "brain");
  const p = Bun.spawnSync(["bun", "src/cli.ts", "restore", r.file, "--to", to, "--identity", "-"], { cwd: join(import.meta.dir, ".."), stdin: readFileSync(identity) });
  expect(p.stdout.toString()).toContain("nothing to fix");
  expect(p.exitCode).toBe(0);
  rmSync(r.file);

  // The drill never touches the brain or the real backup folder.
  expect(sh(root, "git", "rev-parse", "HEAD").out).toBe(headBefore);
  expect(readdirSync(dest)).toEqual([]);
}, 30_000); // two drills and a restore: about 5 s under a full-suite load, past bun's default

test("restore refuses the wrong key, a tampered backup, and a folder that isn't empty", async () => {
  const dest = tmp("pb-bk-dest-");
  const root = brainWithBackups(dest);
  const r = bk.backup(root);

  await expect(bk.restore(r.file, { to: join(tmp("pb-bk-x-"), "b"), identity: otherIdentity })).rejects.toThrow(/can't decrypt/);
  await expect(bk.restore(r.file, { to: root, identity })).rejects.toThrow(/isn't empty/);

  // Someone with the public key swaps the read log: every hash is checked, nothing is restored.
  const stage = tmp("pb-bk-tamper-");
  bk.decrypt(r.file, identity, stage);
  writeFileSync(join(stage, "files", "log", "reads.jsonl"), "forged\n");
  const forged = join(dest, "brain-2026-10-08-forged.tar.age");
  const tar = Bun.spawnSync(["tar", "-cf", "-", "-C", stage, "."]);
  Bun.spawnSync(["age", "-r", pub, "-o", forged], { stdin: tar.stdout });
  const to = join(tmp("pb-bk-x-"), "b");
  await expect(bk.restore(forged, { to, identity })).rejects.toThrow(/log\/reads.jsonl: doesn't match its hash/);
  expect(existsSync(to)).toBe(false);
});

test("backup refuses plaintext secrets on main, a private key as recipient, and a folder inside the brain", () => {
  const dest = tmp("pb-bk-dest-");
  const root = brainWithBackups(dest);

  writeFileSync(join(root, "rules", "backup.pub"), readFileSync(identity, "utf8"));
  expect(() => bk.backup(root)).toThrow(/holds a private key/);
  sh(root, "git", "checkout", "rules/backup.pub");

  expect(() => bk.backup(root, { dest: join(root, "backups") })).toThrow(/inside the brain/);

  writeFileSync(join(root, "notes-oops.md"), "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAE\n");
  sh(root, "git", "add", "notes-oops.md");
  sh(root, "git", "commit", "-qm", "oops");
  expect(() => bk.backup(root)).toThrow(/plaintext secrets.*notes-oops.md \(a private key\)/);
  expect(readdirSync(dest)).toEqual([]);
});

test("the hub's schedule: first backup, nothing while main is still, again once it moved and every_hours passed", () => {
  const dest = tmp("pb-bk-dest-");
  const root = brainWithBackups(dest);
  const t0 = new Date("2026-10-08T03:00:00Z");
  expect(bk.due(root, t0)).toEqual({ due: true, why: "no backup yet" });
  expect(bk.scheduled(root, t0)?.file).toEndWith("brain-2026-10-08.tar.age");

  // The last-backup commit itself doesn't count as main moving.
  const next = new Date("2026-10-09T04:00:00Z");
  expect(bk.due(root, next).due).toBe(false);
  expect(bk.scheduled(root, next)).toBeUndefined();

  expect(write(root, req("Publish the final grades")).outcome).toBe("committed");
  expect(bk.due(root, new Date("2026-10-08T10:00:00Z")).due).toBe(false); // only 7h
  expect(bk.scheduled(root, next)?.file).toEndWith("brain-2026-10-08-2.tar.age"); // PB_TODAY pins the name
  expect(readdirSync(dest).sort()).toEqual(["brain-2026-10-08-2.tar.age", "brain-2026-10-08.tar.age"]);

  // Doctor reads the same record.
  const lines = bk.backupFindings(root, next);
  expect(lines.map((f) => f.level)).toEqual(["ok"]);
  expect(bk.backupFindings(root, new Date("2026-10-20T00:00:00Z"))[0].level).toBe("ok"); // main hasn't moved since
  expect(write(root, req("Archive the course")).outcome).toBe("committed");
  expect(bk.backupFindings(root, new Date("2026-10-20T00:00:00Z"))[0].text).toMatch(/days ago and main has moved/);

  // A replica leaves backups to the hub.
  hub.init(root, { name: "home" });
  const replica = tmp("pb-bk-rep-");
  sh(tmpdir(), "git", "clone", "-q", root, replica);
  hub.init(replica, { name: "laptop" });
  expect(bk.scheduled(replica, new Date("2026-11-01T00:00:00Z"))).toBeUndefined();
});

test("rotation: 30 days of dailies, the first of each month, always the newest; nothing else touched", () => {
  const dest = tmp("pb-bk-rot-");
  const names: string[] = [];
  for (let d = new Date("2026-06-01"); d <= new Date("2026-10-08"); d = new Date(d.getTime() + 86400000)) names.push(`brain-${d.toISOString().slice(0, 10)}.tar.age`);
  names.push("brain-2026-10-08-2.tar.age");
  for (const n of [...names, "notes.txt", "brain-final.tar.age"]) writeFileSync(join(dest, n), "x");

  const deleted = bk.rotate(dest, { keep_daily: 30, keep_monthly: "all" }, "2026-10-08");
  const left = readdirSync(dest).sort();
  expect(left).toContain("notes.txt");
  expect(left).toContain("brain-final.tar.age");
  for (const m of ["06", "07", "08", "09"]) expect(left).toContain(`brain-2026-${m}-01.tar.age`);
  expect(left).toContain("brain-2026-09-09.tar.age");
  expect(left).not.toContain("brain-2026-09-08.tar.age");
  expect(left).toContain("brain-2026-10-08-2.tar.age");
  expect(left.filter((f) => f.startsWith("brain-2026-")).length).toBe(4 + 30 + 1);
  expect(deleted.length).toBe(names.length - 35);

  // keep_monthly: 2 keeps September and October's firsts only; keep_daily 0 still keeps the newest.
  bk.rotate(dest, { keep_daily: 0, keep_monthly: 2 }, "2026-10-08");
  expect(readdirSync(dest).sort()).toEqual(["brain-2026-09-01.tar.age", "brain-2026-10-01.tar.age", "brain-2026-10-08-2.tar.age", "brain-final.tar.age", "notes.txt"]);
});

// Backlog #196: the restore half of the real-use bar, provable in one command on demo data.
test("drill also checks git fsck, note and fact counts, and that the hub boots on the restored brain", async () => {
  const root = makeBrain();
  const d = await bk.drill(root);
  expect(d.ok).toBe(true);
  expect(d.notes).toBe(loadBrain(root).length);
  expect(d.facts).toBeGreaterThan(0);
  expect(d.checks).toEqual([]);
  const text = bk.renderDrill(d);
  expect(text).toContain("git fsck: clean");
  expect(text).toContain(`${d.notes} notes and ${d.facts} facts, same as before`);
  expect(text).toContain("hub booted on the restored brain");
});

// 2026-10-22 on the Mac: the restore was identical, yet the drill said "failed" over a hub log the
// pull writes and never commits, and over a week of open hub alerts. A drill that fails on noise
// teaches the owner to ignore it: it compares the brain's content, and reports alerts apart.
test("a drill passes over hub logs changed outside git and open hub alerts, and lists the alerts apart", async () => {
  const root = makeBrain();
  mkdirSync(join(root, "log", "sources"), { recursive: true });
  writeFileSync(join(root, "log", "sources", "runs.jsonl"), JSON.stringify({ at: "2026-10-07T10:00:00Z", source: "calendar" }) + "\n");
  sh(root, "git", "add", "-f", "log/sources/runs.jsonl");
  sh(root, "git", "commit", "-qm", "hub: runs");
  appendFileSync(join(root, "log", "sources", "runs.jsonl"), JSON.stringify({ at: "2026-10-08T10:00:00Z", source: "calendar" }) + "\n");
  appendFileSync(join(root, "log", "alerts.jsonl"), JSON.stringify({ at: "2026-10-08T09:00:00Z", agent: "hub", check: "probe_fill", from: "calendar quiet 72h" }) + "\n");
  const d = await bk.drill(root);
  expect(d.diff).toEqual([]);
  expect(d.doctorFails).toEqual([]);
  expect(d.ok).toBe(true);
  expect(d.alerts.join("\n")).toMatch(/hub alert/);
  expect(bk.renderDrill(d)).toContain("open alerts on the brain (not a drill failure");
});

test("restore checks catch a missing note, a broken repo and a hub that can't boot", async () => {
  const root = makeBrain();
  const before = bk.brainCounts(root);
  expect(await bk.restoreChecks(root, before)).toEqual([]);
  rmSync(join(root, "projects", "course-a.md"));
  writeFileSync(join(root, "rules", "policy.yaml"), readFileSync(join(root, "rules", "policy.yaml"), "utf8") + "\nbad: [\n");
  const objects = join(root, ".git", "objects");
  const pack = readdirSync(objects).find((d) => /^[0-9a-f]{2}$/.test(d))!;
  // git writes its objects read-only; a test run as root (here) ignores that, the CI runner doesn't.
  for (const f of readdirSync(join(objects, pack))) { chmodSync(join(objects, pack, f), 0o644); writeFileSync(join(objects, pack, f), "corrupt"); }
  const problems = (await bk.restoreChecks(root, before)).join("\n");
  expect(problems).toMatch(/notes: \d+ before, \d+ after/);
  expect(problems).toMatch(/git fsck/);
  expect(problems).toMatch(/hub didn't boot/);
});

// CI runs it from the repo, where no brain is (the CI test job's last step failed so, G540).
test("pocketbrain drill --demo needs no brain anywhere", () => {
  const cfg = tmp("pb-demo-drill-nobrain-");
  const env: Record<string, string> = { ...process.env as Record<string, string>, PB_CONFIG_DIR: cfg };
  delete env.PB_BRAIN;
  const p = Bun.spawnSync(["bun", "src/cli.ts", "drill", "--demo"], { cwd: join(import.meta.dir, ".."), env });
  expect({ exit: p.exitCode, err: p.stderr.toString().trim().split("\n")[0] ?? "" }).toEqual({ exit: 0, err: "" });
});

test("pocketbrain drill --demo: the sample brain, a throwaway key, one pass line, nothing recorded", () => {
  const cfg = tmp("pb-demo-drill-cfg-");
  const p = Bun.spawnSync(["bun", "src/cli.ts", "drill", "--demo"], { cwd: join(import.meta.dir, ".."), env: { ...process.env, PB_BRAIN: join(cfg, "nowhere"), PB_CONFIG_DIR: cfg } });
  const out = p.stdout.toString().trim();
  expect(p.exitCode).toBe(0);
  expect(out.split("\n")).toHaveLength(1);
  expect(out).toMatch(/^drill PASSED in [\d.]+s \(demo brain, throwaway key\): \d+ notes, \d+ facts, fsck clean, hub booted$/);
  expect(existsSync(join(cfg, "nowhere"))).toBe(false);
});
