// SPDX-License-Identifier: AGPL-3.0-only
// The read log keeps no secret-shaped words (bug hunt 2026-10-15 B3, backlog #137). A search
// whose words looked like a credential was logged as typed, and backups leave out any file that
// holds a secret, so one such search dropped the whole hash-chained read log (the audit trail and
// the forgetting signal) from every later backup.
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { search, readNote } from "../src/core";
import { verifyChain } from "../src/readlog";
import * as bk from "../src/backup";

test("a credential-looking search is logged redacted, and the read log still goes into backups", async () => {
  const keys = mkdtempSync(join(tmpdir(), "pb-keys-"));
  Bun.spawnSync(["age-keygen", "-o", join(keys, "id")]);
  const pub = Bun.spawnSync(["age-keygen", "-y", join(keys, "id")]).stdout.toString().trim();
  const root = makeBrain();
  search(root, "planner", "course grades");
  search(root, "planner", "where is the DEPLOY_API_KEY=see-1password note");
  // Split by a newline or a tab, a secret reads as one once the log line is JSON (re-audit of #137).
  search(root, "planner", "DB_PASSWORD=abc1\ndefghij");
  search(root, "planner", "MY_API_KEY:\tab1\tcdefghijk");
  search(root, "planner", "x".repeat(170) + " pb_town_" + "A".repeat(40));
  try { readNote(root, "planner", "notes/sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx"); } catch { /* not a note */ }
  const log = readFileSync(join(root, "log/reads.jsonl"), "utf8");
  expect(bk.secretIn(log)).toBeUndefined();
  expect(log).toContain("[removed: secret-shaped]");
  expect(log).toContain("course grades");
  expect(verifyChain(join(root, "log/reads.jsonl")).broken).toBeUndefined();
  const dest = mkdtempSync(join(tmpdir(), "pb-dest-"));
  const b = bk.backup(root, { dest, recipients: [pub], record: false });
  expect(b.skipped.map((s) => s.path)).not.toContain("log/reads.jsonl");
  const to = join(mkdtempSync(join(tmpdir(), "pb-new-")), "brain");
  await bk.restore(b.file, { to, identity: join(keys, "id") });
  expect(existsSync(join(to, "log/reads.jsonl"))).toBe(true);
});
