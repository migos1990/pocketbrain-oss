// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "bun:test";
import { writeFileSync, readFileSync, mkdirSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { handover, verifyPackage } from "../src/handover";
import { loadBrain, type FactRecord } from "../src/brain";

const env = { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" };
const sh = (cwd: string, args: string[]) => Bun.spawnSync(["git", ...args], { cwd, env }).stdout.toString();

function brainWithExtras() {
  const root = makeBrain();
  const add = (rel: string, text: string) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); };
  const fm = (id: string, extra = "", body = "") => `---\nid: ${id}\ntype: note\ntitle: ${id}\narea: personal\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: steward\n${extra}---\n${body}\n`;
  add("notes/zephyr.md", fm("notes/zephyr", "", "Zephyr Holdings 7731 account backup."));
  add("notes/vault.md", fm("notes/vault", "", "x").replace("sensitivity: personal", "sensitivity: secret"));
  add("agents/planner/sync.md", fm("agents/planner/sync", "", "Planner's daily sync."));
  add("notes/ideas.md", fm("notes/ideas", "verification: confirmed-by-louis\nlegacy: { notion: 00000000000000000000000000000abc }\nsources: [\"instinct-mem:ideas\", \"url:http://evt1.bg/\", \"url:https://example.com/a\"]\n",
    "See [[agents/planner/sync]] and [[projects/course-a]]. From thread f000000000000001 and phonemsg-01FAKE0000000000000000000T."));
  add("inbox/proposal.md", "pending");
  add("comms/2026-10-08.md", "agent chatter");
  add("rules/tokens.yaml", "planner: sha256:" + "a".repeat(64) + "\n");
  sh(root, ["add", "-A"]);
  sh(root, ["commit", "-qm", "extras"]);
  // a secret that was deleted later: must not be recoverable from the package's history
  add("notes/old-secret.md", fm("notes/old-secret", "", "PIN 9911"));
  sh(root, ["add", "-A"]); sh(root, ["commit", "-qm", "oops"]);
  sh(root, ["rm", "-q", "notes/old-secret.md"]); sh(root, ["commit", "-qm", "remove"]);
  return root;
}

const outDir = () => join(mkdtempSync(join(tmpdir(), "pb-out-")), "brain");

test("strips canaries, agents, secrets and working state; keeps the rest", () => {
  const root = brainWithExtras();
  const out = outDir();
  const r = handover(root, { to: "Alex Successor", out });
  expect(r.problems).toEqual([]);
  const ids = loadBrain(out).map((n) => n.fm.id);
  expect(ids).toContain("people/jane-roy");
  expect(ids).toContain("money/main-bank");
  expect(ids).toContain("notes/ideas");
  expect(ids).not.toContain("notes/zephyr");
  expect(ids).not.toContain("notes/vault");
  expect(ids).not.toContain("agents/planner/sync");
  for (const d of ["inbox", "comms", "views", "log"]) expect(existsSync(join(out, d))).toBe(false);
  expect(existsSync(join(out, "rules", "tokens.yaml"))).toBe(false);
  expect(existsSync(join(out, "rules", "relay.yaml"))).toBe(false);
  expect(r.stripped.map((s) => s.reason).sort()).toEqual(["agent capability note (Robin's assistants)", "canary note", "secret note"]);
});

test("rewrites the principal, private refs and links", () => {
  const root = brainWithExtras();
  const out = outDir();
  handover(root, { to: "Alex", out });
  const notes = loadBrain(out);
  const bank = notes.find((n) => n.fm.id === "money/main-bank")!.fm.facts!.bank as FactRecord & { confirmed_by?: string };
  expect(bank.verification).toBe("verified-by-source");
  expect(bank.confirmed_by).toContain("previous owner (Robin)");
  expect(bank.sources).toEqual(["prior:owner-message"]);
  const jane = notes.find((n) => n.fm.id === "people/jane-roy")!.fm.facts!.role as FactRecord;
  expect(jane.sources).toEqual(["prior:email"]);
  const ideas = notes.find((n) => n.fm.id === "notes/ideas")!;
  expect(ideas.fm.legacy).toBeUndefined();
  expect(ideas.fm.sources).toEqual(["prior-note:agent", "prior:reference", "url:https://example.com/a"]);
  expect(ideas.fm.verification).toBe("verified-by-source");
  expect(ideas.body).toContain("[[redacted]]");
  expect(ideas.body).toContain("[[projects/course-a]]");
  expect(ideas.body).not.toContain("phonemsg-");
  expect(ideas.body).not.toContain("f000000000000001");
  const rules = readFileSync(join(out, "rules", "RULES.md"), "utf8");
  expect(rules).toContain("the owner");
  const policy = readFileSync(join(out, "rules", "policy.yaml"), "utf8");
  expect(policy).toContain("agents: {}");
  expect(policy).not.toContain("resolver");
});

test("fresh one-commit history: deleted secrets are not recoverable", () => {
  const root = brainWithExtras();
  const out = outDir();
  handover(root, { to: "Alex", out });
  expect(sh(out, ["rev-list", "--count", "HEAD"]).trim()).toBe("1");
  expect(sh(out, ["log", "-p", "--all"])).not.toContain("PIN 9911");
  expect(sh(root, ["log", "-p", "--all"])).toContain("PIN 9911"); // still in Robin's own history
});

test("records the handover in the source brain and writes HANDOVER.md and manifest", () => {
  const root = brainWithExtras();
  const out = outDir();
  const r = handover(root, { to: "Alex Successor", out });
  const rec = readFileSync(join(root, "handovers", "2026-10-08-alex-successor.md"), "utf8");
  expect(rec).toContain(`Source commit: ${r.sourceCommit}`);
  expect(sh(root, ["log", "-1", "--format=%s"])).toContain("handover: record package for Alex Successor");
  const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  expect(m.notes).toBe(r.kept);
  expect(m.files["people/jane-roy.md"]).toMatch(/^sha256:/);
  expect(readFileSync(join(out, "HANDOVER.md"), "utf8")).toContain("handed over to Alex Successor");
});

test("refuses a dirty brain and an existing output folder", () => {
  const root = brainWithExtras();
  writeFileSync(join(root, "people/jane-roy.md"), readFileSync(join(root, "people/jane-roy.md"), "utf8") + "\nedit\n");
  expect(() => handover(root, { to: "A", out: outDir() })).toThrow(/uncommitted/);
  const out = outDir();
  mkdirSync(out, { recursive: true });
  expect(() => handover(root, { to: "A", out, allowDirty: true })).toThrow(/already exists/);
});

test("verification catches a leaked id or canary", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-v-"));
  mkdirSync(join(dir, "notes"));
  writeFileSync(join(dir, "notes", "x.md"), "---\nid: notes/x\ntype: note\ntitle: x\n---\nphonemsg-01FAKE0000000000000000000T and Zephyr Holdings 7731\n");
  const p = verifyPackage(dir, ["Zephyr Holdings 7731"], false);
  expect(p.some((x) => x.includes("private id"))).toBe(true);
  expect(p.some((x) => x.includes("canary"))).toBe(true);
});

test("encrypts to the recipient's age key when given one", () => {
  const keyDir = mkdtempSync(join(tmpdir(), "pb-k-"));
  const kg = Bun.spawnSync(["age-keygen", "-o", join(keyDir, "k.txt")]);
  if (kg.exitCode !== 0) return; // age not installed: covered in CI where it is
  const pub = readFileSync(join(keyDir, "k.txt"), "utf8").match(/public key: (age1\w+)/)![1];
  const root = brainWithExtras();
  const out = outDir();
  const r = handover(root, { to: "Alex", out, ageKey: pub });
  expect(r.package).toMatch(/handover-alex-2026-10-08\.tar\.age$/);
  const dec = Bun.spawnSync(["age", "-d", "-i", join(keyDir, "k.txt"), r.package!]);
  expect(dec.exitCode).toBe(0);
});
