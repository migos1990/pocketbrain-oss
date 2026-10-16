// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKeys } from "../src/secrets";

test("keys load from owner-only files; the environment wins; loose files are ignored", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "pb-keys-")), "keys");
  mkdirSync(dir);
  const put = (n: string, v: string, mode: number) => { writeFileSync(join(dir, n), v); chmodSync(join(dir, n), mode); };
  put("PBTEST_A_KEY", "abc123\n", 0o600);
  put("PBTEST_B_KEY", "loose", 0o644);
  put("PBTEST_C_KEY", "file", 0o600);
  process.env.PBTEST_C_KEY = "env";
  const r = loadKeys(dir);
  expect(r.loaded).toEqual(["PBTEST_A_KEY"]);
  expect(process.env.PBTEST_A_KEY).toBe("abc123");
  expect(process.env.PBTEST_B_KEY).toBeUndefined();
  expect(r.ignored.join()).toContain("PBTEST_B_KEY (readable by others");
  expect(r.ignored.join()).not.toContain("loose");
  expect(process.env.PBTEST_C_KEY).toBe("env");
  for (const k of ["PBTEST_A_KEY", "PBTEST_C_KEY"]) delete process.env[k];
});
