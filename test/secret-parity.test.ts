// SPDX-License-Identifier: AGPL-3.0-only
// One secret detector (bug hunt 2026-10-15 B2, backlog #136): whatever a backup refuses to carry,
// the write path refuses first. Otherwise one agent write passes every check and then every
// later backup refuses, so any writer could stop backups.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { findSecret, redactSecrets } from "../src/checks";
import * as bk from "../src/backup";

// Each is something backups refuse to carry.
const SHAPES = [
  "The course bot key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx",
  "Deploy reads STRIPE_API_KEY=stored-in-1password",
  "token pb_planner_AbCdEfGhIjKlMnOpQrStUvWxYz012345 for the door",
  "age key AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",
  "-----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNzaC1rZXktdjEAAAAA",
  "aws AKIAABCDEFGHIJKLMNOP",
];

test("every string a backup refuses, the write check refuses and the importers redact", () => {
  for (const s of SHAPES) {
    expect(bk.secretIn(s)).toBeDefined();
    expect(findSecret(s)).toBeDefined();
    expect(bk.secretIn(redactSecrets(s).text)).toBeUndefined();
  }
});

test("an agent write the backup would refuse is refused at the write, and backups keep working", () => {
  const pub = Bun.spawnSync(["sh", "-c", "age-keygen 2>/dev/null | age-keygen -y"]).stdout.toString().trim();
  for (const value of SHAPES.slice(0, 2)) {
    const root = makeBrain();
    const dest = mkdtempSync(join(tmpdir(), "pb-dest-"));
    const w = write(root, { agent: "planner", id: "projects/course-a", attribute: "deploy_note", value, as_of: "2026-10-08", sources: ["gmail:f000000000000006"], verification: "verified-by-source" } as any);
    expect(w.outcome).toBe("refused");
    expect(w.fails?.[0].check).toBe("no_secret_shapes");
    expect(() => bk.backup(root, { dest, recipients: [pub], record: false })).not.toThrow();
  }
});

test("a secret in a source ref is refused too, so it can't reach a note and stop backups", () => {
  const pub = Bun.spawnSync(["sh", "-c", "age-keygen 2>/dev/null | age-keygen -y"]).stdout.toString().trim();
  const root = makeBrain();
  const w = write(root, { agent: "planner", id: "projects/course-a", attribute: "deploy_note", value: "deploy uses the bot", as_of: "2026-10-08", sources: ["url:https://example.com/hook?key=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx"], verification: "verified-by-source" } as any);
  expect(w.outcome).toBe("refused");
  expect(w.fails?.map((f) => f.check)).toContain("no_secret_shapes");
  expect(() => bk.backup(root, { dest: mkdtempSync(join(tmpdir(), "pb-dest-")), recipients: [pub], record: false })).not.toThrow();
});

test("redacting a pasted private key removes the whole block, not only its first line", () => {
  const pem = "note\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACBzZWNyZXRzZWNyZXRzZWNyZXRzZWNyZXRzZWNyZXQAAAAA\n-----END OPENSSH PRIVATE KEY-----\nafter";
  const r = redactSecrets(pem);
  expect(r.text).toBe("note\n[removed: secret-shaped]\nafter");
  expect(r.found).toEqual(["a private key"]);
});
