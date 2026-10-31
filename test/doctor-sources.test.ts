// SPDX-License-Identifier: AGPL-3.0-only
// Sources in doctor (backlog 368): before the first live pull, `pocketbrain doctor` names the one
// missing step for each source (sources file, consent line, Google client, sign-in) and, after it,
// how the last pull went. Read-only: nothing is fetched, no key value is read into the output.
import { test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeBrain } from "./fixture";
import { doctor } from "../src/doctor";

// The keys folder and any Google key another test loaded into the environment (the environment wins).
const GOOGLE_ENV = /^(PB_CONFIG_DIR|GOOGLE_CLIENT_(ID|SECRET)|(GMAIL|GCAL|GDRIVE)_REFRESH_TOKEN\w*)$/;
const saved = Object.fromEntries(Object.entries(process.env).filter(([k]) => GOOGLE_ENV.test(k)));
afterEach(() => {
  for (const k of Object.keys(process.env)) if (GOOGLE_ENV.test(k)) delete process.env[k];
  Object.assign(process.env, saved);
});

// An empty keys folder, so the machine's own keys never leak into the test.
function keys(...names: string[]) {
  for (const k of Object.keys(process.env)) if (GOOGLE_ENV.test(k)) delete process.env[k];
  const dir = mkdtempSync(join(tmpdir(), "pb-keys-"));
  process.env.PB_CONFIG_DIR = dir;
  mkdirSync(join(dir, "keys"), { mode: 0o700 });
  for (const n of names) writeFileSync(join(dir, "keys", n), "secret-value-not-shown\n", { mode: 0o600 });
}
const sources = (root: string, yaml: string) => writeFileSync(join(root, "rules", "sources.yaml"), yaml);
const MAIL = "sources:\n  mail:\n    kind: gmail\n    account: personal\n    where: [INBOX]\n";
async function found(root: string) {
  const f = (await doctor(root, { offline: true })).filter((x) => x.area === "sources");
  return { ids: f.map((x) => x.id ?? x.level), text: f.map((x) => x.text).join("\n") };
}

test("no sources file: doctor says the Gardener has nothing to check facts against", async () => {
  keys();
  const root = makeBrain();
  const { ids, text } = await found(root);
  expect(ids).toEqual(["doctor.sources-none"]);
  expect(text).toContain("docs/sources-pull.md");
});

test("a live source with no consent line is named, before any key check", async () => {
  keys("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN_PERSONAL");
  const root = makeBrain();
  sources(root, MAIL);
  expect((await found(root)).ids).toEqual(["doctor.sources-consent"]);
  sources(root, `consent: 2999-01-01\n${MAIL}`);
  const later = await found(root);
  expect(later.ids).toEqual(["doctor.sources-consent"]);
  expect(later.text).toContain("after today");
});

test("Google steps in order: the client first, then the sign-in for each source, by name", async () => {
  keys();
  const root = makeBrain();
  sources(root, `consent: 2026-10-01 Gmail and Calendar read-only\n${MAIL}  cal:\n    kind: gcal\n    account: personal\n`);
  let r = await found(root);
  expect(r.ids).toEqual(["doctor.google-client-missing"]);
  expect(r.text).toContain("GOOGLE_CLIENT_ID");

  keys("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET");
  r = await found(root);
  expect(r.ids).toEqual(["doctor.source-not-connected", "doctor.source-not-connected"]);
  expect(r.text).toContain("pocketbrain sources connect mail");
  expect(r.text).toContain("pocketbrain sources connect cal");
  expect(r.text).not.toContain("secret-value-not-shown");

  keys("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN_PERSONAL", "GCAL_REFRESH_TOKEN_PERSONAL");
  r = await found(root);
  expect(r.ids).toEqual(["doctor.source-never-pulled", "doctor.source-never-pulled"]);
  expect(r.text).toContain("pocketbrain sources pull mail --dry-run");
});

test("after a pull: the last run per source, ok or the reason it was refused", async () => {
  keys("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN_PERSONAL");
  const root = makeBrain();
  sources(root, `consent: 2026-10-01\n${MAIL}`);
  mkdirSync(join(root, "log", "sources"), { recursive: true });
  const runs = join(root, "log", "sources", "runs.jsonl");
  writeFileSync(runs, `${JSON.stringify({ at: "2026-10-20T08:00:00.000Z", source: "mail", fetched: 12, stored: ["a", "b"], skipped: 10, due: [] })}\n`);
  let r = await found(root);
  expect(r.ids).toEqual(["ok"]);
  expect(r.text).toContain("mail: last pull 2026-10-20T08:00Z, 12 fetched, 2 read");

  writeFileSync(runs, `${JSON.stringify({ at: "2026-10-21T08:00:00.000Z", source: "mail", fetched: 0, stored: [], skipped: 0, due: [], refused: "Google refused the Gmail token (invalid_grant); run pocketbrain sources connect <source> again" })}\n`, { flag: "a" });
  r = await found(root);
  expect(r.ids).toEqual(["doctor.source-refused"]);
  expect(r.text).toContain("invalid_grant");
});

test("a fixture source needs no keys and no consent check fails it", async () => {
  keys();
  const root = makeBrain();
  sources(root, "sources:\n  demo:\n    kind: gmail\n    fixture: fixtures/mail.json\n");
  expect((await found(root)).ids).toEqual(["doctor.source-never-pulled"]);
});
