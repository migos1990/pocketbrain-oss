// SPDX-License-Identifier: AGPL-3.0-only
// LongMemEval, retrieval only (plans close-three-gaps step B1; docs/longmemeval.md).
// Each question's chat sessions become pages of a throwaway brain, our own ranker (`rank` in
// src/retrieve.ts) ranks them for the question, and the script prints session-level recall at 5
// and 10 by question type, scored the way the benchmark's own retrieval code scores it.
//
//   bun scripts/longmemeval.ts --data <longmemeval_s_cleaned.json> [--slice dev|rest] [--semantic]
//                              [--json out.json] [--limit n]
//
// The dataset is read from the path given and never copied into the repo. The dev slice (50
// questions, fixed by a hash of their ids) is the only slice to look at while working; the rest is
// run once on a clean, committed tree, and a second run of it is refused unless you say why
// (`--again "<reason>"`), and then printed with the count of earlier runs. Nothing here changes
// how the hub ranks: no constant of src/ is set or tuned by this script.
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Note } from "../src/brain";
import { loadRules } from "../src/rules";
import { carve, grantFor } from "../src/carve";
import { buildIndex, docText, rank, type Semantic } from "../src/retrieve";
import { embedInput, QUERY_CHARS, type Embedder } from "../src/semantic";

export const LABEL = "retrieval only; sessions filed as raw pages; no language model in the loop";
export const DEV_SIZE = 50;
export const KS = [5, 10] as const;
const DEV_SALT = "pocketbrain-longmemeval-dev-v1";

interface Turn { role: string; content: string; has_answer?: boolean }
export interface Item {
  question_id: string; question_type: string; question: string; question_date: string;
  haystack_session_ids: string[]; haystack_dates: string[]; haystack_sessions: Turn[][];
}

// The benchmark's own session-level corpus (src/retrieval/run_retrieval.py, process_item_flat_index):
// a session's text is its user turns joined by a space, and an evidence session ("answer" in its id)
// with no user turn marked has_answer is relabelled "noans", so it doesn't count as a target.
export function corpusOf(it: Item): { id: string; text: string; date: string }[] {
  return it.haystack_sessions.map((s, i) => {
    const sid = it.haystack_session_ids[i];
    const user = s.filter((t) => t.role === "user");
    const id = sid.includes("answer") && user.every((t) => !t.has_answer) ? sid.replace("answer", "noans") : sid;
    return { id, text: user.map((t) => t.content).join(" "), date: it.haystack_dates[i] };
  });
}
export const targetsOf = (corpus: { id: string }[]) => [...new Set(corpus.map((c) => c.id).filter((id) => id.includes("answer")))];

// Skipped as the benchmark skips them when it reports retrieval: abstention questions ("_abs"),
// and questions whose evidence is in no user turn (most single-session-assistant ones).
export function skipReason(it: Item): "abstention" | "no-user-target" | undefined {
  if (it.question_id.includes("_abs")) return "abstention";
  if (!it.haystack_sessions.some((s) => s.some((t) => t.role === "user" && t.has_answer))) return "no-user-target";
}

// recall_any@k: one evidence session in the top k; recall_all@k: every one (eval_utils.py).
export function recallAt(ranked: string[], targets: string[], k: number): { any: boolean; all: boolean } {
  const top = new Set(ranked.slice(0, k));
  return { any: targets.some((t) => top.has(t)), all: targets.length > 0 && targets.every((t) => top.has(t)) };
}

export function devIds(items: Item[], n = DEV_SIZE): Set<string> {
  const h = (id: string) => createHash("sha256").update(DEV_SALT + id).digest("hex");
  return new Set(items.map((i) => i.question_id).sort((a, b) => h(a).localeCompare(h(b)) || a.localeCompare(b)).slice(0, n));
}
export const sliceOf = (items: Item[], slice: "dev" | "rest") => { const dev = devIds(items); return items.filter((i) => dev.has(i.question_id) === (slice === "dev")); };

const day = (d: string) => (d.match(/^(\d{4})\/(\d{2})\/(\d{2})/) ?? []).slice(1).join("-") || "2023-01-01";

// One question's sessions as pages a reader sees in full: a throwaway rules folder (the sample
// brain's), one note per session in the steward's area, ranked through the real carve and index.
let rulesRoot: string | undefined;
function rules() {
  if (!rulesRoot) {
    rulesRoot = mkdtempSync(join(tmpdir(), "pb-lme-"));
    cpSync(join(import.meta.dir, "..", "examples", "brain", "rules"), join(rulesRoot, "rules"), { recursive: true });
  }
  return loadRules(rulesRoot);
}
export function indexFor(it: Item) {
  const corpus = corpusOf(it);
  const notes: Note[] = corpus.map((c, i) => {
    const id = `notes/s${String(i).padStart(3, "0")}`;
    return { path: `${id}.md`, body: c.text, fm: { id, type: "note", title: `Chat on ${day(c.date)}`, area: "personal", sensitivity: "personal", status: "active", created: day(c.date), updated: day(c.date), by: "steward" } };
  });
  const r = rules();
  const idx = buildIndex(carve(notes, r, grantFor(r, "steward")), r, day(it.question_date));
  const sessionOf = new Map(notes.map((n, i) => [n.fm.id, corpus[i].id]));
  return { idx, corpus, sessionOf };
}

export function rankSessions(it: Item, semantic?: (idx: ReturnType<typeof indexFor>["idx"]) => Semantic | undefined): { ranked: string[]; targets: string[] } {
  const { idx, corpus, sessionOf } = indexFor(it);
  const hits = rank(idx, it.question, Math.max(...KS), semantic ? { semantic: semantic(idx) } : {});
  return { ranked: hits.map((h) => sessionOf.get(h.id)!), targets: targetsOf(corpus) };
}

export interface Row { id: string; type: string; skipped?: string; r5any?: boolean; r5all?: boolean; r10any?: boolean; r10all?: boolean }
export function table(rows: Row[]): string[] {
  const types = [...new Set(rows.map((r) => r.type))].sort();
  const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "-");
  const out = ["| question type | scored | skipped | recall_any@5 | recall_any@10 | recall_all@5 | recall_all@10 |", "|---|---|---|---|---|---|---|"];
  for (const t of [...types, "all"]) {
    const rs = rows.filter((r) => t === "all" || r.type === t), sc = rs.filter((r) => !r.skipped);
    const c = (k: keyof Row) => sc.filter((r) => r[k]).length;
    out.push(`| ${t} | ${sc.length} | ${rs.length - sc.length} | ${pct(c("r5any"), sc.length)} | ${pct(c("r10any"), sc.length)} | ${pct(c("r5all"), sc.length)} | ${pct(c("r10all"), sc.length)} |`);
  }
  return out;
}

// The held-out record: one line per run of the rest, outside the repo and the brain.
export const heldOutLog = () => join(process.env.PB_LME_STATE ?? join(homedir(), ".cache", "pocketbrain"), "longmemeval-rest-runs.jsonl");
export function priorRestRuns(dataHash: string): number {
  const f = heldOutLog();
  if (!existsSync(f)) return 0;
  return readFileSync(f, "utf8").split("\n").filter(Boolean).filter((l) => { try { return JSON.parse(l).data === dataHash; } catch { return false; } }).length;
}

function git(args: string[]): string { return spawnSync("git", args, { cwd: join(import.meta.dir, ".."), encoding: "utf8" }).stdout.trim(); }

// Document vectors cached by the text's hash, outside the repo, so a long embedding run resumes.
async function vectorsFor(texts: string[], embedder: Embedder, cacheDir: string, say: (s: string) => void): Promise<Map<string, Float32Array>> {
  mkdirSync(cacheDir, { recursive: true });
  const out = new Map<string, Float32Array>();
  const want = [...new Set(texts)];
  const missing: string[] = [];
  for (const t of want) {
    const f = join(cacheDir, createHash("sha256").update(embedder.id + "\0" + t).digest("hex"));
    if (existsSync(f)) out.set(t, new Float32Array(readFileSync(f).buffer.slice(0)));
    else missing.push(t);
  }
  missing.sort((a, b) => a.length - b.length); // like lengths in a batch: less padding, same vectors
  const started = Date.now();
  for (let i = 0; i < missing.length; i += 8) {
    const batch = missing.slice(i, i + 8);
    const vs = await embedder.embed(batch);
    batch.forEach((t, j) => {
      out.set(t, vs[j]);
      writeFileSync(join(cacheDir, createHash("sha256").update(embedder.id + "\0" + t).digest("hex")), Buffer.from(vs[j].buffer));
    });
    if ((i / 8) % 50 === 0) say(`embedded ${Math.min(i + 8, missing.length)} of ${missing.length} new texts (${Math.round((Date.now() - started) / 1000)} s)`);
  }
  return out;
}

async function main() {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const data = arg("--data");
  if (!data) throw new Error("--data <path to the LongMemEval json> is required (the file is never committed)");
  const slice = (arg("--slice") ?? "dev") as "dev" | "rest";
  if (slice !== "dev" && slice !== "rest") throw new Error("--slice is dev or rest");
  const raw = readFileSync(data);
  const dataHash = createHash("sha256").update(raw).digest("hex");
  const items: Item[] = JSON.parse(raw.toString("utf8"));
  const commit = git(["rev-parse", "HEAD"]);
  const dirty = git(["status", "--porcelain", "--", "src", "scripts", "examples/brain/rules", "package.json", "bun.lock"]);
  const again = arg("--again");
  let prior = 0;
  if (slice === "rest") {
    if (dirty) throw new Error("the held-out run needs a clean, committed tree (src, scripts, rules, lockfile); commit first");
    prior = priorRestRuns(dataHash);
    if (prior && !again) throw new Error(`the held-out questions of this file were already run ${prior} time(s); a second look needs --again "<reason>" and is printed with that count`);
  }
  let chosen = sliceOf(items, slice);
  const limit = Number(arg("--limit") ?? 0);
  if (limit > 0) chosen = chosen.slice(0, limit);
  const say = (s: string) => console.error(s);

  const rankers = ["words"];
  let embedder: Embedder | undefined;
  let vecs = new Map<string, Float32Array>();
  const qvecs = new Map<string, Float32Array>();
  if (process.argv.includes("--semantic")) {
    const { loadLocalEmbedder } = await import("../src/semantic");
    embedder = await loadLocalEmbedder();
    const texts: string[] = [];
    for (const it of chosen) for (const d of indexFor(it).idx.docs) texts.push(embedInput(docText(d)));
    vecs = await vectorsFor(texts, embedder, join(homedir(), ".cache", "pocketbrain", "longmemeval-vectors"), say);
    for (const it of chosen) qvecs.set(it.question_id, (await embedder.embed([it.question.slice(0, QUERY_CHARS)]))[0]);
    rankers.push("words + local model");
  }

  const report: Record<string, { rows: Row[] }> = {};
  for (const name of rankers) {
    const rows: Row[] = chosen.map((it) => {
      const skipped = skipReason(it);
      if (skipped) return { id: it.question_id, type: it.question_type, skipped };
      const sem = name === "words" ? undefined : () => ({ query: qvecs.get(it.question_id)!, vectorOf: (t: string) => vecs.get(embedInput(t)) });
      const { ranked, targets } = rankSessions(it, sem);
      const r5 = recallAt(ranked, targets, 5), r10 = recallAt(ranked, targets, 10);
      return { id: it.question_id, type: it.question_type, r5any: r5.any, r5all: r5.all, r10any: r10.any, r10all: r10.all };
    });
    report[name] = { rows };
  }
  await embedder?.close?.();

  console.log(`# LongMemEval, ${LABEL}\n`);
  console.log(`- data: ${basename(data)}, sha256 ${dataHash}`);
  console.log(`- commit: ${commit}${dirty ? " (DIRTY tree: dev numbers only, never quoted)" : ""}`);
  console.log(`- slice: ${slice}, ${chosen.length} questions${limit ? ` (cut to --limit ${limit})` : ""}${slice === "rest" ? `, held-out run ${prior + 1}${again ? ` (again: ${again})` : ""}` : ""}`);
  console.log(`- skipped as the benchmark skips them: abstention questions and questions with no evidence in a user turn`);
  for (const [name, { rows }] of Object.entries(report)) {
    console.log(`\n## ${name}\n`);
    for (const l of table(rows)) console.log(l);
  }
  if (slice === "rest") {
    mkdirSync(dirname(heldOutLog()), { recursive: true });
    appendFileSync(heldOutLog(), JSON.stringify({ data: dataHash, commit, at: new Date().toISOString(), again: again ?? null }) + "\n");
  }
  const out = arg("--json");
  if (out) writeFileSync(out, JSON.stringify({ label: LABEL, data: basename(data), dataHash, commit, dirty: !!dirty, slice, report }, null, 2));
}

if (import.meta.main) await main();
