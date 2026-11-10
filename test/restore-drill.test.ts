// SPDX-License-Identifier: AGPL-3.0-only
// The Sunday restore test (next-level R1, G690): the hub proves once a week that its newest backup,
// read back out of the offsite folder, restores into a working brain, with real age keys and real
// git. It never touches the brain or the backup folders except to read.
import { test, expect, beforeAll } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import * as bk from "../src/backup";
import { restoreDrill, drillWords, drillCheck, drillKeyOn, drillKeyOff, lastRestoreDrill } from "../src/restore-drill";
import { readBeat, lateJobs, lateLine } from "../src/heartbeat";
import { jobChecks } from "../src/probe";
import { dueJobs, drillApart } from "../src/start";
import { brainCounts } from "../src/backup";

const sh = (cwd: string, ...cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const cli = (...args: string[]) => sh(join(import.meta.dir, ".."), "bun", "src/cli.ts", ...args);

let pub: string;
beforeAll(() => {
  if (!Bun.which("age") || !Bun.which("age-keygen")) throw new Error("install age for test/restore-drill.test.ts");
  const keys = tmp("pb-rd-keys-");
  sh(keys, "age-keygen", "-o", join(keys, "owner.agekey"));
  pub = sh(keys, "age-keygen", "-y", join(keys, "owner.agekey")).out;
});

// A brain with backups set up as `backup --init` leaves it, one backup made, the owner's key only.
function brainWithBackup() {
  const root = makeBrain(), dest = tmp("pb-rd-dest-");
  expect(cli("backup", "--init", "--pub", pub, "--brain", root).code).toBe(0);
  writeFileSync(join(root, "rules", "backup.yaml"), readFileSync(join(root, "rules", "backup.yaml"), "utf8").replace("dest: ~/pocketbrain-backups", `dest: ${dest}`));
  sh(root, "git", "commit", "-qam", "louis: backup folder");
  return { root, dest, keyFile: join(tmp("pb-rd-cfg-"), "keys", "backup-drill.key") };
}
const offsiteTo = (root: string, to: string) => writeFileSync(join(root, "log", "offsite.json"), JSON.stringify({ to, on_at: new Date().toISOString() }) + "\n");

test("without the drill key the Sunday test proves the mechanics on a copy and says the file itself wasn't opened", async () => {
  const { root, keyFile } = brainWithBackup();
  const b = bk.backup(root);
  const head = sh(root, "git", "rev-parse", "HEAD").out;
  const d = await restoreDrill(root, { keyFile });
  expect(d.problems).toEqual([]);
  expect(d).toMatchObject({ ok: true, key: "throwaway", from: "local", file: b.file.split("/").pop() });
  expect(drillWords(d)).toContain("tested with a stand-in key");
  expect(readBeat(root, "restore_drill")?.ok).toBe(true);
  expect(sh(root, "git", "rev-parse", "HEAD").out).toBe(head); // the brain itself is untouched
  expect(sh(root, "git", "status", "--porcelain").out).not.toContain("rules/");
});

test("with the drill key the newest backup itself is restored: same notes and facts as the brain had at that commit", async () => {
  const { root, keyFile } = brainWithBackup();
  const said = drillKeyOn(root, { keyFile });
  expect(said).toContain("not printed");
  expect(said).not.toContain("AGE-SECRET-KEY");
  expect(statSync(keyFile).mode & 0o077).toBe(0);
  const pubs = readFileSync(join(root, "rules", "backup.pub"), "utf8");
  expect(pubs).toContain(pub);
  expect(pubs.match(/^age1/gm)?.length).toBe(2);
  expect(pubs).not.toContain("AGE-SECRET-KEY");
  bk.backup(root);
  const counts = brainCounts(root);
  const d = await restoreDrill(root, { keyFile });
  expect(d.problems).toEqual([]);
  expect(d).toMatchObject({ ok: true, key: "drill", from: "local", notes: counts.notes, facts: counts.facts });
  expect(drillWords(d)).toMatch(/^Your brain was restored from \w+day's backup in /);
  expect(drillCheck(root)?.ok).toBe(true);
  // Off again: the line and the key are gone, the owner's key stays.
  drillKeyOff(root, { keyFile });
  expect(existsSync(keyFile)).toBe(false);
  expect(readFileSync(join(root, "rules", "backup.pub"), "utf8").match(/^age1\S+/gm)).toEqual([pub]);
});

test("the offsite copy is read back and must match the local file; one cut short or missing fails the test and the home says so (G690)", async () => {
  const { root, dest, keyFile } = brainWithBackup();
  drillKeyOn(root, { keyFile });
  const b = bk.backup(root);
  const name = b.file.split("/").pop()!;
  const drive = tmp("pb-rd-drive-");
  offsiteTo(root, drive);
  copyFileSync(join(dest, name), join(drive, name));
  const good = await restoreDrill(root, { keyFile });
  expect(good.problems).toEqual([]);
  expect(good).toMatchObject({ ok: true, from: "offsite", key: "drill" });
  expect(drillWords(good)).toContain("in your cloud folder");

  writeFileSync(join(drive, name), readFileSync(join(dest, name)).subarray(0, 100));
  const cut = await restoreDrill(root, { keyFile });
  expect(cut.ok).toBe(false);
  expect(cut.problems[0]).toContain("differs from the local file");

  const gone = tmp("pb-rd-empty-");
  offsiteTo(root, gone);
  const missing = await restoreDrill(root, { keyFile });
  expect(missing.ok).toBe(false);
  expect(missing.problems[0]).toBe(`${name} isn't in the offsite folder yet`);
  // The probe alerts, the ledger fails, and the home's one line names it.
  expect(jobChecks(root).find((c) => c.name === "restore_drill")).toMatchObject({ ok: false });
  expect(readBeat(root, "restore_drill")).toMatchObject({ ok: false });
  expect(lateLine(lateJobs(root))).toMatch(/^Your Sunday restore test failed /);
  expect(drillWords(lastRestoreDrill(root))).toMatch(/restore test failed: .* isn't in the offsite folder yet/);
});

test("a drill key others can read is refused, and a test that stops running goes late", async () => {
  const { root, keyFile } = brainWithBackup();
  drillKeyOn(root, { keyFile });
  bk.backup(root);
  chmodSync(keyFile, 0o644);
  const d = await restoreDrill(root, { keyFile });
  expect(d.ok).toBe(false);
  expect(d.problems.join(" ")).toContain("readable by others");
  chmodSync(keyFile, 0o600);
  expect((await restoreDrill(root, { keyFile, now: new Date("2026-10-01T03:30:00Z") })).ok).toBe(true);
  expect(drillCheck(root, new Date("2026-10-12T03:30:00Z"))).toMatchObject({ ok: false, detail: expect.stringContaining("no restore test since 2026-10-01") });
});

test("the hub runs it on Sundays after the night pass, only once backups are set up, in a child it stops when it hangs", async () => {
  const plain = makeBrain();
  const sunday = new Date("2026-11-08T09:00:00Z"); // 04:00 Toronto, a Sunday
  expect(dueJobs(plain, sunday)).not.toContain("drill");
  const { root } = brainWithBackup();
  expect(dueJobs(root, sunday)).toContain("drill");
  expect(dueJobs(root, sunday)).not.toContain("drill"); // once a day
  expect(dueJobs(root, new Date("2026-11-09T09:00:00Z"))).not.toContain("drill");
  let killed = false;
  await expect(drillApart(root, { timeoutMs: 50, spawn: () => ({ exited: new Promise<number>(() => {}), kill: () => { killed = true; } }) })).rejects.toThrow("restore test stopped");
  expect(killed).toBe(true);
  expect(readBeat(root, "restore_drill")).toMatchObject({ ok: false, error: expect.stringContaining("didn't finish") });
  expect(await drillApart(root, { spawn: () => ({ exited: Promise.resolve(0), kill: () => {} }) })).toBe("restore test: passed");
});

test("drill --weekly from the command line writes the result the screens read", () => {
  const { root } = brainWithBackup();
  bk.backup(root);
  const r = sh(join(import.meta.dir, ".."), "bun", "src/cli.ts", "drill", "--weekly", "--brain", root);
  expect(r.code).toBe(0);
  expect(r.out).toContain("stand-in key");
  expect(lastRestoreDrill(root)?.ok).toBe(true);
  mkdirSync(join(root, "log"), { recursive: true });
  const jobs = sh(join(import.meta.dir, ".."), "bun", "src/cli.ts", "jobs", "--brain", root);
  expect(jobs.out).toContain("Sunday restore test");
  expect(jobs.code).toBe(0);
});

test("drill-key off removes only the drill key's own line, never the owner's key after its comment", () => {
  const { root, keyFile } = brainWithBackup();
  drillKeyOn(root, { keyFile });
  const f = join(root, "rules", "backup.pub");
  // The owner moved their own key under the drill comment and dropped the drill key's line by hand.
  const lines = readFileSync(f, "utf8").split("\n").filter((l) => l.startsWith("#") || l === pub);
  writeFileSync(f, [lines.filter((l) => l !== pub).join("\n"), pub, ""].join("\n"));
  drillKeyOff(root, { keyFile });
  expect(readFileSync(f, "utf8").match(/^age1\S+/gm)).toEqual([pub]);
});

// Audit v13 (G762): the drill key adds a second key that opens every later backup, and it was
// committed with a private git helper: the session's own author, a hard-coded "louis:" subject, and
// no hub gate, so a replica committed to rules/ too (invariants 5, 7 and 11).
test("G762 the drill key's commits are the owner's, through the repo's own git", () => {
  const { root, keyFile } = brainWithBackup();
  drillKeyOn(root, { keyFile });
  const last = () => sh(root, "git", "log", "-1", "--format=%an <%ae>%n%s%n%b").out;
  expect(last()).toMatch(/^.+ <(owner|louis)@pocketbrain\.local>\nowner: drill key for the Sunday restore test \(rules\/backup\.pub\)/);
  expect(sh(root, "git", "log", "-1", "--format=%s", "--", "rules/backup.pub").out).toContain("drill key for the Sunday restore test");
  drillKeyOff(root, { keyFile });
  expect(last()).toMatch(/^.+ <(owner|louis)@pocketbrain\.local>\nowner: drill key removed \(rules\/backup\.pub\)/);
  expect(sh(root, "git", "status", "--porcelain", "--", "rules").out).toBe("");
});

test("G762 on a clone that isn't the hub the drill key is refused: no key made, nothing committed", () => {
  const { root, keyFile } = brainWithBackup();
  writeFileSync(join(root, "rules", "hub.yaml"), "hub: home\nepoch: 1\nreplicas:\n  home: {}\n  laptop: {}\n");
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "louis: two machines");
  const head = sh(root, "git", "rev-parse", "HEAD").out, pubs = readFileSync(join(root, "rules", "backup.pub"), "utf8");
  expect(() => drillKeyOn(root, { keyFile })).toThrow(/on the hub/);
  expect(existsSync(keyFile)).toBe(false);
  expect(readFileSync(join(root, "rules", "backup.pub"), "utf8")).toBe(pubs);
  expect(sh(root, "git", "rev-parse", "HEAD").out).toBe(head);
  expect(() => drillKeyOff(root, { keyFile })).toThrow(/on the hub/);
});
