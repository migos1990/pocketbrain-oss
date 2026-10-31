// SPDX-License-Identifier: AGPL-3.0-only
// Write-path fuzz: seeded, deterministic, no dependencies. Random and mutated remember() bodies
// (odd unicode, huge strings, wrong types, traversal ids, null bytes, nested objects, bad dates,
// refs with spaces, carved values in every field) from each agent at a fixture brain. After each
// one the invariants must hold: no crash (only a CoreError below 500, as the server would answer
// a 4xx), nothing committed under rules/ or outside the content folders, no file outside the
// brain, a refused write changes no file, every change is committed and authored by the writer,
// and no value carved from the writer lands in a committed note.
// PB_FUZZ_N sets the iteration count (default 150), PB_FUZZ_SEED the seed.
import { test, expect } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { remember, CoreError } from "../src/core";
import { squash } from "../src/match";

const N = Number(process.env.PB_FUZZ_N ?? 150);
const SEED = Number(process.env.PB_FUZZ_SEED ?? 20261015);
const ESC = "pbfuzz-escape";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Values the fixture keeps from planner and helper (money is excluded for both, and private).
const CARVED = ["Maple Trust Bank", "via the bank app > Cards > Replace"];
const nest = (d: number): unknown => (d ? { a: nest(d - 1) } : "deep");
const ODD = ["\u202Eevil", "Zoë 🧠 ﷽ 𝔘𝔫𝔦", "a\u0000b", "\uD800lone", "ｆｕｌｌ ｗｉｄｔｈ", "", " ", "\n\n", "---\nid: rules/policy\n---", "[[money/main-bank]]", `../../${ESC}`, `%2e%2e/${ESC}`, "x".repeat(100_000), "Ma\u200Bple Tr\u200Bust Ba\u200Bnk", "M a p l e  T r u s t  B a n k", "MAPLE TRUST BANK"];
const POOLS: Record<string, unknown[]> = {
  kind: ["fact", "journal", "delete", 1, null, ["fact"]],
  id: [`../${ESC}`, `../../${ESC}/x`, "rules/policy", "rules/slices", "agents/steward/cap", "agents/WRITER/cap", `people/../../${ESC}`, "people/jane-roy", "people/jane-roy\u0000", "people/ jane", "/etc/passwd", "people/jane-roy/../../../rules/policy", ".git/config", "log/writes", "inbox/x", "journal/steward/2026-10", "money/main-bank", "decisions/2026-09-01-pick-bank", "people/paul-advisor", "projects/course-a", "C:\\x", "people/" + "a".repeat(5000), 7, null, { id: "people/jane-roy" }, ["people/jane-roy"]],
  title: [`../../${ESC}`, "..", ".", "rules", "Maple Trust Bank", "Jane Roy", "x".repeat(10_000), 12, null, { t: 1 }, ...ODD.slice(0, 6)],
  type: ["person", "org", "project", "decision", "note", "procedure", "money", "capability", "event", "../x", 3, null],
  area: ["work", "personal", `../${ESC}`, "rules", "WRITER", "steward", "", 7, ["work"]],
  attribute: ["role", "next_step", "next_step", "status", "phones", "org", "maple_trust_bank", "../x", "Role", "a b", "__proto__", "constructor", "x".repeat(300), 5, null],
  value: [...CARVED, "draft", "Course coordinator", "ship v2", 7, ...ODD, 42, -1, 1e308, 0, true, null, [], [1, "two", { three: 3 }], nest(60), { org: "Maple Trust Bank" }, { __proto__: { polluted: 1 } }, "draft"],
  as_of: ["2026-10-01", "2026-10-05", "2026-09-15", "-0001-01-01", "0000-00-00", "2026-13-45", "9999-12-31", "", 20261001, null, "2026-10-01T00:00:00Z", "2026", ["2026-10-01"]],
  sources: [["gmail:f000000000000001"], ["gmail:f000000000000003"], ["url:https://example.com/a"], ["doc:has space"], ["doc:Maple-Trust-Bank"], ["doc:maple_trust_bank"], "gmail:f000000000000001", [{ ref: "gmail:f000000000000002" }], [null], [123], [{ ref: 5, via: {} }], [], ["owner:2026-10-01/text"], ["imsg:phonemsg-01FAKE0000000000000000000T"], ["url:javascript:alert(1)"], ["agent-relay:steward"], {}, [`doc:../../${ESC}`]],
  verification: ["verified-by-source", "self-reported", "confirmed-by-owner", "god", 1, null],
  source_type: ["email", "agent_observation", "owner_message", "weird", 9],
  text: [...ODD, 5, { t: "x" }],
  retract: [true, false, "yes", 1],
  sensitivity: ["public", "personal", "private", "secret", "none", 0, ["private"]],
  share_with: [["planner"], "planner", [1], [], ["*"], null, [{ a: 1 }]],
  as_of_approx: [true, "yes", null],
  confidence: ["stated", "inferred", 3],
  agent: ["steward", "owner", null],
};
const FIELDS = Object.keys(POOLS);
// Half the mutations stay plausible, so writes get past the schema into routing, conflicts and commits.
const PLAUSIBLE: Record<string, unknown[]> = {
  id: ["projects/course-a", "projects/course-b", "people/jane-roy", "people/paul-advisor", "money/main-bank", "agents/WRITER/notes"],
  title: ["Jane Roy", "Course C", "Maple Trust Bank", "New Org", "Zoë 🧠"],
  type: ["person", "org", "project", "note", "money", "capability"],
  area: ["work", "personal", "WRITER"],
  attribute: ["role", "next_step", "status", "phones", "org", "maple_trust_bank", "bank"],
  value: [...CARVED, "draft", "Course coordinator", "ship v2", "+15145550199", "Maple  Trust\nBank", "Zoë 🧠"],
  as_of: ["2026-10-01", "2026-10-05", "2026-09-15", "2026-10-08", "2027-01-01"],
  sources: [["gmail:f000000000000001"], ["gmail:f000000000000003"], ["url:https://example.com/a"], ["doc:Maple-Trust-Bank"], ["owner:2026-10-01/text"], ["agent-relay:steward"]],
  verification: ["verified-by-source", "self-reported", "confirmed-by-owner"],
  sensitivity: ["personal", "private", "public"],
  share_with: [["planner"], ["helper"], []],
  retract: [true, false],
  kind: ["fact", "journal"],
  text: ["a journal line", "Maple Trust Bank was mentioned"],
};
const BASE = { kind: "fact", id: "projects/course-a", attribute: "next_step", value: "draft", as_of: "2026-10-01", sources: ["gmail:f000000000000001"], verification: "verified-by-source" };
const sub = (v: unknown, writer: string): unknown => typeof v === "string" ? v.replace("WRITER", writer) : v;

function body(r: () => number, writer: string): Record<string, unknown> {
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const b: Record<string, unknown> = r() < 0.05 ? {} : { ...BASE };
  if (r() < 0.3) Object.assign(b, { id: undefined, title: pick(POOLS.title as string[]), type: pick(POOLS.type), area: sub(pick(POOLS.area), writer) });
  for (let k = Math.floor(r() * r() * 4); k >= 0; k--) {
    const f = pick(FIELDS);
    if (r() < 0.1) delete b[f]; else b[f] = sub(pick(r() < 0.5 && PLAUSIBLE[f] ? PLAUSIBLE[f] : POOLS[f]), writer);
  }
  return b;
}

const git = (root: string, args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root }).stdout.toString();
const ALLOWED = (writer: string) => new RegExp(`^(people|orgs|projects|decisions|notes|money|disputes|inbox)/[^/]+$|^agents/${writer}/[^/]+$|^journal/${writer}/[^/]+$|^diary/\\d{4}-\\d{2}\\.jsonl$`);

test(`fuzz: ${N} mutated writes from every agent keep the write path's invariants (seed ${SEED})`, () => {
  const outer = mkdtempSync(join(tmpdir(), "pb-fuzz-"));
  const root = join(outer, "brain");
  renameSync(makeBrain(), root);
  const r = rng(SEED);
  const agents = ["steward", "planner", "helper", "gardener"];
  const broken: string[] = [];
  const outcomes: Record<string, number> = {};
  const tmpBefore = readdirSync(tmpdir()).filter((f) => f.includes(ESC)).length;
  for (let i = 0; i < N; i++) {
    const writer = agents[Math.floor(r() * agents.length)];
    let req = body(r, writer);
    if (r() < 0.7) req = JSON.parse(JSON.stringify(req) ?? "{}");
    const head = git(root, ["rev-parse", "HEAD"]).trim();
    const where = `#${i} ${writer} ${JSON.stringify(req).slice(0, 160)}`;
    let outcome = "threw";
    try { outcome = remember(root, writer, req).outcome; }
    catch (e) {
      if (!(e instanceof CoreError) || e.status >= 500) { broken.push(`${where}: crash ${(e as Error).message.slice(0, 120)}`); continue; }
      outcome = `core-${e.status}`;
    }
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    const dirty = git(root, ["status", "--porcelain", "-uall"]).split("\n").filter(Boolean).map((l) => l.slice(3)).filter((p) => !p.startsWith("log/"));
    if (dirty.length) broken.push(`${where}: ${outcome} left uncommitted ${dirty.join(", ")}`);
    const after = git(root, ["rev-parse", "HEAD"]).trim();
    if (outcome === "refused" || outcome.startsWith("core-")) { if (after !== head) broken.push(`${where}: refused but committed`); }
    for (const c of git(root, ["log", "--format=@%an", "--name-only", `${head}..${after}`]).split("@").filter((x) => x.trim())) {
      const [author, ...files] = c.trim().split("\n").filter(Boolean);
      if (author !== writer) broken.push(`${where}: commit authored by ${author}`);
      for (const f of files) if (!ALLOWED(writer).test(f)) broken.push(`${where}: committed ${f}`);
    }
    if (writer === "planner" || writer === "helper") {
      const added = squash(git(root, ["diff", head, after, "--", "people", "orgs", "projects", "decisions", "notes", "agents"]).split("\n").filter((l) => l.startsWith("+")).join("\n"));
      for (const v of CARVED) if (added.includes(squash(v))) broken.push(`${where}: carved value "${v}" committed into a note`);
    }
    if (readdirSync(outer).join() !== "brain") broken.push(`${where}: wrote outside the brain: ${readdirSync(outer).join(", ")}`);
  }
  if (readdirSync(tmpdir()).filter((f) => f.includes(ESC)).length !== tmpBefore) broken.push("a file escaped into the temp folder");
  if (({} as Record<string, unknown>).polluted !== undefined) broken.push("Object.prototype polluted");
  if (process.env.PB_FUZZ_VERBOSE) {
    const why: Record<string, number> = {};
    for (const l of readFileSync(join(root, "log", "writes.jsonl"), "utf8").trim().split("\n")) for (const c of JSON.parse(l).checks ?? []) why[c] = (why[c] ?? 0) + 1;
    console.log(outcomes, why);
  }
  expect(broken.slice(0, 15)).toEqual([]);
}, 60_000);
