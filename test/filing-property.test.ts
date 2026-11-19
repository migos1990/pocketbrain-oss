// SPDX-License-Identifier: AGPL-3.0-only
// Filing as a property (G986): for made-up weeks of messy mail (test/filing-gen.ts: a person's
// note, a shop's promo code, a receipt, the owner's own signed mail, a forwarded chain, the same
// mail twice) read by a careless extractor that hands back what it never should, four statements
// hold after the hub pulled and filed everything, whatever came in:
//   1. the owner is never filed as a contact: at most one person page carries the owner's name,
//      their own, titled as the rules name them, however a mail spelled it;
//   2. no code a shop mailed is stored anywhere in the brain, nor shown to the model;
//   3. pulling and filing the same mail again changes nothing;
//   4. every fact the week added has a source.
// The statements are written here from what the files hold, apart from the filing code.
//   Each run: FILING_CASES weeks (default 6).  Soak: FILING_SOAK=1 (300).  One seed: FILING_SEED=n.
//   A failing seed goes in test/fixtures/filing-seeds.json with its reason and is replayed every run.
import { test, expect, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { week, gmailItems, careless, type Week } from "./filing-gen";
import { makeModel, type ModelRequest } from "../src/model";
import { useCaptureModel } from "../src/capture";
import { pullSource } from "../src/pull";
import { runAuto } from "../src/filing";

const FROZEN: { seed: number; why: string }[] = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "filing-seeds.json"), "utf8"));
const BASE = 41_000;
const N = Number(process.env.FILING_CASES ?? (process.env.FILING_SOAK ? 300 : 6));
const SEEDS = process.env.FILING_SEED ? [Number(process.env.FILING_SEED)] : Array.from({ length: N }, (_, i) => BASE + i);

afterAll(() => useCaptureModel());

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "owner", GIT_AUTHOR_EMAIL: "o@x", GIT_COMMITTER_NAME: "owner", GIT_COMMITTER_EMAIL: "o@x" } }).stdout.toString().trim();

// Every file of the brain outside .git and the hub's own logs, by path.
function files(root: string, dir = root, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f), rel = relative(root, p);
    if (rel === ".git" || rel === "log" || rel === ".cells") continue;
    if (statSync(p).isDirectory()) files(root, p, out); else out.push(rel);
  }
  return out.sort();
}
const state = (root: string) => createHash("sha256").update(files(root).map((f) => `${f}\0${readFileSync(join(root, f), "utf8")}`).join("\0")).digest("hex");
const frontmatter = (text: string): Record<string, any> | undefined => { const m = /^---\n([\s\S]*?)\n---/.exec(text); try { return m ? YAML.parse(m[1]!) : undefined; } catch { return undefined; } };
// A name as a bag of plain words, titles and bracketed notes aside: "Varga, Liv" and "Mr Liv Varga (Tidewater)" are Liv Varga.
const bag = (name: unknown) => String(name ?? "").replace(/\([^)]*\)/g, " ").toLowerCase().normalize("NFD").replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w && !["mr", "mrs", "ms", "dr", "m", "mme", "monsieur", "madame"].includes(w)).sort().join(" ");
// Every record of a fact: an object that holds a value.
function records(v: unknown, out: Record<string, any>[] = []): Record<string, any>[] {
  if (Array.isArray(v)) v.forEach((x) => records(x, out));
  else if (v && typeof v === "object") { if ("value" in v) out.push(v as Record<string, any>); for (const x of Object.values(v)) if (x && typeof x === "object") records(x, out); }
  return out;
}
const recordKeys = (root: string) => new Set(files(root).filter((f) => f.endsWith(".md") && !f.startsWith("inbox/")).flatMap((f) => records(frontmatter(readFileSync(join(root, f), "utf8"))?.facts).map((r) => `${f}\0${JSON.stringify(r.value)}\0${r.as_of ?? ""}`)));

async function fileWeek(w: Week): Promise<{ root: string; findings: string[]; stored: number; added: number }> {
  const root = makeBrain();
  const findings: string[] = [];
  const policy = join(root, "rules", "policy.yaml");
  writeFileSync(policy, readFileSync(policy, "utf8").replace("owner: { name: Robin }", `owner: ${JSON.stringify({ name: w.owner.name, aliases: w.owner.aliases })}`));
  // The fixture stays outside the brain: the mails themselves hold the codes. Every other week
  // the source is set to read shop and machine mail too (skip_bulk: false), the harder case.
  const fixture = join(mkdtempSync(join(tmpdir(), "pb-filing-mail-")), "mail.json");
  writeFileSync(fixture, JSON.stringify(gmailItems(w)));
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { post: { kind: "gmail", where: ["INBOX"], fixture, ...(w.seed % 2 ? { skip_bulk: false } : {}) } } }));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: sources");
  const before = recordKeys(root);
  const read = careless(w);
  useCaptureModel(() => makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => {
    for (const c of w.codes) if (r.prompt.includes(c)) findings.push(`statement 2: the code of a shop's mail was sent to the model`);
    return read(r.prompt);
  } }));
  const now = new Date();
  const pulled = await pullSource(root, "post");
  if (pulled.refused) findings.push(`the pull was refused: ${pulled.refused}`);
  runAuto(root, now); runAuto(root, new Date(now.getTime() + 60_000));

  // 1. The owner is never a contact: one page of their own at most, under their own name as the
  // rules give it, however a mail spelled it ("Varga, Liv", "Mr Liv Varga (a shop)").
  const mine = new Set([w.owner.name, ...w.owner.aliases].map(bag));
  const own = files(root).filter((x) => x.endsWith(".md") && !x.startsWith("inbox/")).map((f) => ({ f, fm: frontmatter(readFileSync(join(root, f), "utf8")) }))
    .filter(({ fm }) => fm?.type === "person" && [fm.title, ...(fm.aliases ?? [])].some((t) => mine.has(bag(t))));
  if (own.length > 1) findings.push(`statement 1: ${own.length} person pages carry the owner's name`);
  for (const { f, fm } of own) if (fm!.title !== w.owner.name) findings.push(`statement 1: ${f} is a page for the owner under another spelling of their name`);
  // 2. No mailed code anywhere in the brain, dashes or not, any case; nor in its git history.
  const squash = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const all = files(root).map((f) => [f, squash(readFileSync(join(root, f), "utf8"))] as const);
  const history = squash(sh(root, "git", "log", "-p", "--all"));
  for (const c of w.codes) {
    for (const [f, text] of all) if (text.includes(squash(c))) findings.push(`statement 2: ${f} holds a code a shop mailed`);
    if (history.includes(squash(c))) findings.push(`statement 2: the brain's git history holds a code a shop mailed`);
  }
  // 4. Every fact the week added has a source.
  let added = 0;
  for (const f of files(root).filter((x) => x.endsWith(".md") && !x.startsWith("inbox/"))) {
    for (const r of records(frontmatter(readFileSync(join(root, f), "utf8"))?.facts)) {
      if (before.has(`${f}\0${JSON.stringify(r.value)}\0${r.as_of ?? ""}`)) continue;
      added++;
      if (!Array.isArray(r.sources) || !r.sources.length) findings.push(`statement 4: a fact added on ${f} has no source`);
    }
  }
  // 3. The same mail again changes nothing.
  const one = state(root), head = sh(root, "git", "rev-parse", "HEAD");
  const again = await pullSource(root, "post");
  runAuto(root, new Date(now.getTime() + 120_000));
  if (again.stored.length) findings.push(`statement 3: the second pull stored ${again.stored.length} of the same mails again`);
  if (state(root) !== one) findings.push(`statement 3: the brain's files changed on the second pull`);
  // The pull's own run line in log/ is the one thing a second pass may commit.
  const touched = sh(root, "git", "diff", "--name-only", head, "HEAD").split("\n").filter((f) => f && !f.startsWith("log/"));
  if (touched.length) findings.push(`statement 3: the second pull committed a change outside the hub's log (${touched.length} files)`);
  return { root, findings: [...new Set(findings)], stored: pulled.stored.length, added };
}

test(`filing property: ${SEEDS.length} made-up weeks of messy mail; the owner is never a contact, no mailed code is stored, the same mail twice changes nothing, every added fact has a source`, async () => {
  const failed: string[] = [];
  let stored = 0, added = 0;
  for (const seed of SEEDS) {
    const r = await fileWeek(week(seed));
    stored += r.stored; added += r.added;
    if (r.findings.length) failed.push(`seed ${seed} (FILING_SEED=${seed} to replay):\n  ${r.findings.join("\n  ")}`);
  }
  if (process.env.FILING_SOAK || process.env.FILING_SEED) console.log(`filing property: ${SEEDS.length} weeks, ${stored} mails stored, ${added} facts added, ${failed.length} weeks with a finding`);
  expect(failed).toEqual([]);
  // The weeks did something: mail was stored and facts were filed, so the statements had something to hold over.
  expect(stored).toBeGreaterThan(SEEDS.length);
  expect(added).toBeGreaterThan(0);
}, 600_000);

test("the generator is the same week for the same seed, and every shape turns up across a run's seeds", () => {
  expect(week(BASE)).toEqual(week(BASE));
  const shapes = new Set(SEEDS.flatMap((s) => week(s).mails.map((m) => m.shape)));
  for (const s of ["person", "promo", "receipt", "owner-signature", "owner-flipped", "forwarded", "repeat"]) expect(shapes.has(s as any)).toBe(true);
  for (const s of SEEDS) { const w = week(s); expect(w.codes.length).toBeGreaterThan(0); for (const m of w.mails) expect(m.facts.every((f) => m.text.includes(f.quote))).toBe(true); }
});

test("the oracle itself reads a name in each spelling and finds every record of a fact", () => {
  // Statements that can't fail prove nothing: the name bag reads the owner's name in each spelling.
  const w = week(BASE);
  const [first, last] = w.owner.name.split(" ") as [string, string];
  expect(bag(`${last}, ${first}`)).toBe(bag(w.owner.name));
  expect(bag(`Mr ${w.owner.name} (Tidewater Books)`)).toBe(bag(w.owner.name));
  expect(bag(`${first} Other`)).not.toBe(bag(w.owner.name));
  expect(records({ role: { value: "x", sources: [] }, list: [{ value: "y", history: [{ value: "z" }] }] })).toHaveLength(3);
});

if (FROZEN.length) test(`frozen weeks: ${FROZEN.length} seeds that once failed are replayed`, async () => {
  for (const f of FROZEN) expect({ seed: f.seed, findings: (await fileWeek(week(f.seed))).findings }).toEqual({ seed: f.seed, findings: [] });
}, 600_000);
