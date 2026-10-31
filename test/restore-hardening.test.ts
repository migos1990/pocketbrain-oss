// SPDX-License-Identifier: AGPL-3.0-only
// Restore refuses a backup that carries links (bug hunt 2026-10-15 B4, backlog #145) and leaves
// nothing behind when it fails part-way, so the retry works (B5, #149). Real age and ssh-keygen
// keys, temp folders only; every temp folder is removed after.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { sha256 } from "../src/util";
import * as hub from "../src/hub";
import * as bk from "../src/backup";

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } });

let keys: string, identity: string, pub: string;
beforeAll(() => {
  if (!Bun.which("age") || !Bun.which("age-keygen")) throw new Error("install age (brew install age / apt install age) for test/restore-hardening.test.ts");
  if (!hub.hasSshKeygen()) throw new Error("install ssh-keygen for test/restore-hardening.test.ts");
  keys = tmp("pb-rh-keys-");
  identity = join(keys, "id");
  sh(keys, "age-keygen", "-o", identity);
  pub = sh(keys, "age-keygen", "-y", identity).stdout.toString().trim();
  sh(keys, "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", join(keys, "home"));
});

function brain() { const r = makeBrain(); dirs.push(r); return r; }

// Anyone with the public key can re-pack a backup: decrypt ours, change the stage, encrypt again.
function forge(file: string, dest: string, change: (stage: string, m: bk.Manifest) => void): string {
  const stage = tmp("pb-rh-craft-");
  bk.decrypt(file, identity, stage);
  const m = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf8"));
  change(stage, m);
  writeFileSync(join(stage, "manifest.json"), JSON.stringify(m));
  const out = join(dest, "brain-2026-10-09.tar.age");
  Bun.spawnSync(["age", "-r", pub, "-o", out], { stdin: Bun.spawnSync(["tar", "-cf", "-", "-C", stage, "."]).stdout });
  return out;
}

test("a backup whose untracked state is a link out of the brain is refused, and nothing is restored", async () => {
  const root = brain(), dest = tmp("pb-rh-dest-");
  const b = bk.backup(root, { dest, recipients: [pub], record: false });
  const victim = join(tmp("pb-rh-victim-"), "dotfile");
  writeFileSync(victim, "# stock content\n");
  const forged = forge(b.file, dest, (stage, m) => {
    mkdirSync(join(stage, "files", "log"), { recursive: true });
    symlinkSync(victim, join(stage, "files", "log", "alerts.jsonl"));
    m.extras.push({ path: "log/alerts.jsonl", sha256: sha256(readFileSync(victim)), bytes: 16 });
  });
  const to = join(tmp("pb-rh-new-"), "brain");
  await expect(bk.restore(forged, { to, identity })).rejects.toThrow(/not a plain file/);
  expect(existsSync(to)).toBe(false);
  expect(readFileSync(victim, "utf8")).toBe("# stock content\n");
});

test("a link to a folder in the untracked state is refused too", async () => {
  const root = brain(), dest = tmp("pb-rh-dest-");
  const b = bk.backup(root, { dest, recipients: [pub], record: false });
  const outside = tmp("pb-rh-outside-");
  writeFileSync(join(outside, "alerts.jsonl"), "x\n");
  const forged = forge(b.file, dest, (stage, m) => {
    mkdirSync(join(stage, "files"), { recursive: true });
    rmSync(join(stage, "files", "log"), { recursive: true, force: true });
    symlinkSync(outside, join(stage, "files", "log"));
    m.extras = m.extras.filter((e: { path: string }) => !e.path.startsWith("log/"));
    m.extras.push({ path: "log/alerts.jsonl", sha256: sha256(readFileSync(join(outside, "alerts.jsonl"))), bytes: 2 });
  });
  const to = join(tmp("pb-rh-new-"), "brain");
  await expect(bk.restore(forged, { to, identity })).rejects.toThrow(/not a plain file/);
  expect(existsSync(to)).toBe(false);
});

test("a backup whose git history holds a tracked link is refused, and nothing is left behind", async () => {
  const root = brain(), dest = tmp("pb-rh-dest-");
  symlinkSync("/etc/hosts", join(root, "notes-link.md"));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "a link");
  const b = bk.backup(root, { dest, recipients: [pub], record: false });
  const to = join(tmp("pb-rh-new-"), "brain");
  await expect(bk.restore(b.file, { to, identity })).rejects.toThrow(/link/);
  expect(existsSync(to)).toBe(false);
});

test("a restore that fails part-way (a mistyped --key) leaves nothing, and the retry with the right key works", async () => {
  const root = brain();
  hub.init(root, { name: "home" });
  const dest = tmp("pb-rh-dest-");
  const b = bk.backup(root, { dest, recipients: [pub], record: false });
  const to = join(tmp("pb-rh-new-"), "brain");
  await expect(bk.restore(b.file, { to, identity, key: join(keys, "hom") })).rejects.toThrow();
  expect(existsSync(to)).toBe(false);
  const r = await bk.restore(b.file, { to, identity, key: join(keys, "home") });
  expect(r.to).toBe(to);
  expect(lstatSync(join(to, ".git")).isDirectory()).toBe(true);
}, 30_000);

test("a failed restore into an existing empty folder keeps the folder, empty", async () => {
  const root = brain(), dest = tmp("pb-rh-dest-");
  hub.init(root, { name: "home" });
  const b = bk.backup(root, { dest, recipients: [pub], record: false });
  const to = tmp("pb-rh-empty-");
  await expect(bk.restore(b.file, { to, identity, key: join(keys, "hom") })).rejects.toThrow();
  expect(readdirSync(to)).toEqual([]);
}, 30_000);
