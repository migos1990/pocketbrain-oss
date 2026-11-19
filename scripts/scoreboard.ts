// SPDX-License-Identifier: AGPL-3.0-only
// The scoreboard (docs/scoreboard.md): what pocketBrain claims, as numbers a stranger can print
// again. Each row is one command of this repo, run on made-up data or a public benchmark, never on
// anyone's own memory. This script runs the command, reads the numbers out of what it printed, and
// keeps them with the commit and the day in docs/scoreboard.json; the page and the README's block
// are that record rendered, never typed (test/scoreboard.test.ts).
//
//   bun scripts/scoreboard.ts                       print the page as recorded
//   bun scripts/scoreboard.ts check                 the page and the README block are the record rendered
//   bun scripts/scoreboard.ts run [row ...]         run the rows' commands now, compare every number with the record
//   bun scripts/scoreboard.ts record [row ...]      run them on a clean, committed tree and write the record and the page
//   ... --lme <file>                                where the LongMemEval file is (default ~/lme/longmemeval_s_cleaned.json);
//                                                   without the file that row is left as recorded
//   bun scripts/scoreboard.ts record <row> --output <file> --commit <sha> [--day <yyyy-mm-dd>]
//                                                   record one row from the saved output of its command at that commit
//
// Rows: slice, burst, answers, longmemeval. `run` exits 1 when a number differs from the record.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sliceProofLine } from "../src/slice-proof";
import { semanticState } from "../src/semantic";
import { LABEL } from "./longmemeval";

const ROOT = join(import.meta.dir, "..");
const LME_FILE = "~/lme/longmemeval_s_cleaned.json";
const LME_URL = "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json";

export interface SliceV { memories: number; doors: number; leaks: number; missing: number; owed: number; readers: number; pages: number; answers: number; seconds: number }
export interface BurstV { brains: number; tokens: number; reads: number; same: number; writes: number; filed: number; refused: number; turnedAway: number; findings: number }
export interface AnswerV { assistant: string; door: string; asked: number; answered: number; answerable: number; outside: number; tokens: number }
export interface LmeV { data: string; sha256: string; questions: number; commit: string; tables: Record<string, string[]> }
export interface Rec<V> { command: string; commit: string; day: string; values: V }
export interface Board { rows: { slice?: Rec<SliceV>; burst?: Rec<BurstV>; answers?: Rec<AnswerV[]>; answers_model?: Rec<AnswerV[]>; longmemeval?: Rec<LmeV> } }
export type RowId = keyof Board["rows"];

const ints = (m: RegExpMatchArray) => m.slice(1).map(Number);

// scripts/slice-proof.ts, its last line. A run that broke prints no counts and is no result.
export function parseSlice(out: string): SliceV | undefined {
  const m = out.match(/^(\d+) memories, (\d+) doors, (\d+) leak\(s\), (\d+) missing \((\d+) owed facts read back\); (\d+) assistants and tokens, (\d+) pages, (\d+) answers read, (\d+) s/m);
  if (!m) return undefined;
  const [memories, doors, leaks, missing, owed, readers, pages, answers, seconds] = ints(m);
  return { memories, doors, leaks, missing, owed, readers, pages, answers, seconds };
}

// test/burst-property.test.ts, the line it prints before it passes or fails.
export function parseBurst(out: string): BurstV | undefined {
  const m = out.match(/^burst property: (\d+) brains, (\d+) tokens, (\d+) reads in bursts \((\d+) held to the same call asked alone\), (\d+) writes between reads \((\d+) filed, (\d+) refused\), (\d+) calls turned away over budget, (\d+) brains with a finding/m);
  if (!m) return undefined;
  const [brains, tokens, reads, same, writes, filed, refused, turnedAway, findings] = ints(m);
  return { brains, tokens, reads, same, writes, filed, refused, turnedAway, findings };
}

// scripts/usefulness.ts: one line per assistant and door (`countsText` in src/usefulness.ts).
export function parseAnswers(out: string): AnswerV[] | undefined {
  const rows = [...out.matchAll(/^ {2}(\S+) by ([^:]+): \d+\/(\d+) answered \([^)]*\); answered (\d+) of (\d+) answerable \((\d+) outside its cut\);.*?median (\d+) tokens/gm)]
    // "Answered" is the count the page sets beside "its slice can answer": answered of answerable.
    .map((m) => ({ assistant: m[1], door: m[2], asked: Number(m[3]), answered: Number(m[4]), answerable: Number(m[5]), outside: Number(m[6]), tokens: Number(m[7]) }));
  return rows.length ? rows : undefined;
}

// Which search a usefulness run says it used; each answers row takes only its own.
export const searchOf = (out: string) => out.match(/^search: (words alone|words and the local model)$/m)?.[1];

// scripts/longmemeval.ts: the header and one table per ranker. Only the held-out questions on
// committed code are a score; a dev run or a run on uncommitted code is read as nothing.
export function parseLongMemEval(out: string): LmeV | undefined {
  const data = out.match(/^- data: (\S+), sha256 ([0-9a-f]{64})$/m);
  const commit = out.match(/^- commit: ([0-9a-f]{40})$/m);
  const slice = out.match(/^- slice: rest, (\d+) questions, held-out run \d+/m);
  if (!data || !commit || !slice) return undefined;
  const tables: Record<string, string[]> = {};
  for (const part of out.split(/^## /m).slice(1)) {
    const lines = part.split("\n");
    const rows = lines.filter((l) => l.startsWith("|"));
    if (rows.length > 2 && rows.at(-1)!.startsWith("| all |")) tables[lines[0].trim()] = rows;
  }
  return Object.keys(tables).length ? { data: data[1], sha256: data[2], questions: Number(slice[1]), commit: commit[1], tables } : undefined;
}

interface Row {
  id: RowId;
  command: string;                                            // as the page shows it and a reader types it
  present: (root: string) => boolean;                         // the check is in this repo
  argv: (o: { lme: string }) => { cmd: string[]; env?: Record<string, string> };
  parse: (out: string) => unknown;
  cannot?: (o: { lme: string }) => string | undefined;        // why this machine can't run it now
}
const noModel = () => (semanticState().on ? undefined : "the local search model is not installed (bun src/cli.ts search setup downloads it once)");
export const ROWS: Row[] = [
  { id: "slice", command: "bun scripts/slice-proof.ts", present: (r) => existsSync(join(r, "scripts", "slice-proof.ts")),
    argv: () => ({ cmd: [process.execPath, "scripts/slice-proof.ts"] }), parse: parseSlice },
  { id: "burst", command: "BURST_SOAK=1 bun test test/burst-property.test.ts", present: (r) => existsSync(join(r, "test", "burst-property.test.ts")),
    argv: () => ({ cmd: [process.execPath, "test", "test/burst-property.test.ts"], env: { BURST_SOAK: "1" } }), parse: parseBurst },
  // Words alone, as a new install searches: the count is then the same whether or not the model is on the machine.
  { id: "answers", command: "PB_SEMANTIC=0 bun scripts/usefulness.ts", present: (r) => existsSync(join(r, "scripts", "usefulness.ts")),
    argv: () => ({ cmd: [process.execPath, "scripts/usefulness.ts"], env: { PB_SEMANTIC: "0" } }), parse: (out) => (searchOf(out) === "words alone" ? parseAnswers(out) : undefined) },
  { id: "answers_model", command: "bun scripts/usefulness.ts", present: (r) => existsSync(join(r, "scripts", "usefulness.ts")),
    argv: () => ({ cmd: [process.execPath, "scripts/usefulness.ts"] }), parse: (out) => (searchOf(out) === "words and the local model" ? parseAnswers(out) : undefined), cannot: noModel },
  // The bench refuses a second look at the held-out questions on one machine without a reason; this is one.
  { id: "longmemeval", command: `bun scripts/longmemeval.ts --data ${LME_FILE} --slice rest --semantic`, present: (r) => existsSync(join(r, "scripts", "longmemeval.ts")),
    argv: (o) => ({ cmd: [process.execPath, "scripts/longmemeval.ts", "--data", o.lme, "--slice", "rest", "--semantic", "--again", "the scoreboard's rerun"] }), parse: parseLongMemEval,
    cannot: (o) => noModel() ?? (existsSync(o.lme) ? undefined : `no file at ${o.lme} (the page says where to get it; --lme <file> if it is elsewhere)`) },
];
export const rowById = (id: RowId): Row => ROWS.find((r) => r.id === id)!;

// Number by number, what a rerun printed against the record. How long a run took and which commit
// it ran on are not numbers of the score.
const NOT_SCORE = new Set(["seconds", "commit"]);
function flat(v: unknown, at: string, out: Map<string, string>): void {
  if (Array.isArray(v)) v.forEach((x, i) => flat(x, x && typeof x === "object" && "assistant" in x ? `${(x as AnswerV).assistant} by ${(x as AnswerV).door}` : `${at ? `${at}, ` : ""}line ${i + 1}`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (!NOT_SCORE.has(k) && k !== "assistant" && k !== "door") flat(x, at ? `${at}, ${k}` : k, out); }
  else out.set(at, String(v));
}
export function differences(_id: RowId, recorded: unknown, now: unknown): string[] {
  const a = new Map<string, string>(), b = new Map<string, string>();
  flat(recorded, "", a); flat(now, "", b);
  return [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).map((k) => `${k}: recorded ${a.get(k) ?? "nothing"}, this run ${b.get(k) ?? "nothing"}`);
}

// ---- the page ----

const n = (k: number) => k.toLocaleString("en-US");
const measured = (r: Rec<unknown>) => `Measured ${r.day} on commit \`${r.commit.slice(0, 12)}\`.`;
const sh = (...lines: string[]) => ["```sh", ...lines, "```"];
const sliceLine = (v: SliceV) => sliceProofLine({ memories: v.memories, doors: Array.from({ length: v.doors }, () => ""), leaks: v.leaks, missing: v.missing });
const minutes = (s: number) => { const m = Math.round(s / 60); return m < 1 ? "under a minute" : m === 1 ? "1 minute" : `${m} minutes`; };
const allRow = (table: string[]) => table.at(-1)!.split("|").map((c) => c.trim()).slice(1, -1); // all, scored, skipped, any@5, any@10, all@5, all@10
const best = (v: LmeV) => v.tables["words + local model"] ?? Object.values(v.tables).at(-1)!;
const DOORS: [string, string][] = [
  ["context pack", "By context pack: one call, with the question as its topic"],
  ["search, then read 3", "By search: the search, then the top three pages read"],
  ["memory_check, then read 3", "By memory check: what changed since the assistant last looked, then up to three of those pages. This door does not take the question, so it answers fewer"],
];
const packLine = (rows: AnswerV[]) => rows.filter((a) => a.door === DOORS[0][0]).map((a) => `${a.assistant} ${a.answered} of ${a.answerable}`).join(", ");

// One line per claim, for the top of the page and the README.
export function summary(b: Board): string[] {
  const { slice, burst, answers, longmemeval } = b.rows;
  const out = ["| What is measured | Result | Command |", "|---|---|---|"];
  if (slice) out.push(`| Each assistant gets its slice and nothing else | ${sliceLine(slice.values)} | \`${slice.command}\` |`);
  if (burst) out.push(`| Many calls at once get the same slice as one call | ${n(burst.values.reads)} reads in bursts, ${n(burst.values.findings)} ${burst.values.findings === 1 ? "memory" : "memories"} with a fault | \`${burst.command}\` |`);
  if (answers && packLine(answers.values)) out.push(`| Each assistant answers what it is allowed to know | answered, of the questions its slice can answer: ${packLine(answers.values)} | \`${answers.command}\` |`);
  if (longmemeval) { const a = allRow(best(longmemeval.values)); out.push(`| Search finds the right past sessions (LongMemEval, retrieval only) | one evidence session in the top 5 for ${a[3]} of questions, every one for ${a[5]} | \`${longmemeval.command}\` |`); }
  return out;
}

export function render(b: Board): string {
  const { slice, burst, answers, answers_model, longmemeval } = b.rows;
  const out: string[] = [
    "<!-- Written by `bun scripts/scoreboard.ts record` from docs/scoreboard.json. Do not edit by hand. -->",
    "# Scoreboard", "",
    "What pocketBrain claims, as numbers. A command in this repository printed each one, on made-up memories or on a public benchmark, never on anyone's own memory. The command is beside the number, with the commit it ran on and the day, so you can run it and compare.", "",
    ...summary(b), "",
    "To check the whole page on your own machine, from a checkout of this repository:", "",
    ...sh("bun install", "bun scripts/scoreboard.ts run"), "",
    "It runs each command below and prints, row by row, whether every number came out the same. A row that needs the local search model or the benchmark's file says so and is left as recorded until they are on the machine. Rows that use no model give the same counts on any machine. Rows that use the local model are less exact: between two machines or two versions a count can move by a question or two ([longmemeval.md](longmemeval.md#results) has two runs side by side).", "",
  ];
  if (slice) {
    const v = slice.values;
    out.push("## Each assistant gets its slice and nothing else", "", `> ${sliceLine(v)}`, "", measured(slice), "", ...sh(slice.command), "",
      `${n(v.memories)} made-up memories with made-up rules, ${n(v.pages)} pages in all, read as ${n(v.readers)} assistants and tokens through ${n(v.doors)} doors. ${n(v.answers)} answers were checked for anything the rules keep from the reader ("leaks": the count of memories where one was found), and ${n(v.owed)} facts a reader is owed were read back ("missing": the count of memories where one was absent). The run took ${minutes(v.seconds)}.`, "",
      "A hub runs the same check every night on 300 memories no night has read before. How it works, and what it does not prove: [slice-proof.md](slice-proof.md).", "");
  }
  if (burst) {
    const v = burst.values;
    out.push("## Many calls at once get the same slice as one call", "", `> ${n(v.reads)} reads in bursts, ${n(v.findings)} ${v.findings === 1 ? "memory" : "memories"} with a fault`, "", measured(burst), "", ...sh(burst.command), "",
      `${n(v.brains)} made-up memories, ${n(v.tokens)} tokens. Every read an assistant can make was sent many at a time: ${n(v.reads)} reads, ${n(v.same)} of them held byte for byte to the same call asked alone. ${n(v.writes)} writes from other assistants landed between the reads (${n(v.filed)} filed, ${n(v.refused)} refused), and ${n(v.turnedAway)} calls over the request budget were turned away with nothing in them.`, "",
      "What each statement means: [slice-proof.md](slice-proof.md#a-burst-of-calls).", "");
  }
  if (answers) {
    out.push("## Each assistant answers what it is allowed to know", "", measured(answers), "", ...sh(answers.command), "",
      "The demo memory (about 500 made-up facts, with a week replayed on top) is asked its question set as each of its three assistants, through each door an assistant reads by. A question counts as answered when everything it needs is in what came back. \"Its slice can answer\" counts the questions the assistant's whole slice holds the answer to; the rest are outside its slice by the owner's rules, which is the point of a slice.", "");
    for (const [door, words] of DOORS) {
      const rows = answers.values.filter((a) => a.door === door);
      if (!rows.length) continue;
      out.push(`${words}.`, "", "| Assistant | Asked | Its slice can answer | Answered | Outside its slice | Median tokens read |", "|---|---|---|---|---|---|",
        ...rows.map((a) => `| ${a.assistant} | ${n(a.asked)} | ${n(a.answerable)} | ${n(a.answered)} | ${n(a.outside)} | ${n(a.tokens)} |`), "");
    }
    if (answers_model && packLine(answers_model.values)) out.push(`\`PB_SEMANTIC=0\` asks by words alone, as a new install searches, so the counts are the same on every machine. With the local search model installed (\`bun src/cli.ts search setup\`), \`${answers_model.command}\` searches with it and counts differently. By context pack it printed: ${packLine(answers_model.values)} (${answers_model.day}, commit \`${answers_model.commit.slice(0, 12)}\`).`, "");
    out.push("How a question is scored, and why each miss missed: [prove-the-loop.md](prove-the-loop.md#usefulness).", "");
  }
  if (longmemeval) {
    const v = longmemeval.values, a = allRow(best(v));
    out.push("## Search finds the right past sessions (LongMemEval)", "", `> one evidence session in the top 5 for ${a[3]} of questions, every evidence session for ${a[5]}`, "",
      `${measured(longmemeval)} The bench prints one label with every number: "${LABEL}".`, "",
      ...sh(`mkdir -p ~/lme && curl -L -o ${LME_FILE} \\`, `  ${LME_URL}`, "bun src/cli.ts search setup", longmemeval.command), "",
      `[LongMemEval](https://github.com/xiaowu0162/LongMemEval) is a public benchmark of 500 questions about long chat histories. This row measures one narrow thing: given a question, does pocketBrain's own search put the sessions that hold the evidence near the top? No answer is written and no judge is used, so it is not the benchmark's question-answering score and is not to be compared with one. The ${n(v.questions)} questions here were held out while the bench was built. Scored: ${a[1]}. Skipped: ${a[2]}, as the benchmark's own retrieval code skips them (questions to abstain on, and questions whose evidence is in no user turn). File \`${v.data}\`, sha256 \`${v.sha256}\`.`, "");
    for (const [name, rows] of Object.entries(v.tables)) out.push(`${name === "words" ? "Words alone" : name === "words + local model" ? "Words and the local model (bge-m3, on your machine)" : name}:`, "", ...rows, "");
    out.push("Every question type is shown, the weak ones too. The method and the rules that keep the number honest: [longmemeval.md](longmemeval.md).", "");
  }
  out.push("## What this page does not say", "",
    "- Nothing here was measured on a real person's memory. The slice numbers are about the code, on memories and rules a generator makes up; the answers are about one small demo memory and a question set written for it.",
    "- A count of 0 is a test result, not a mathematical proof. The limits are listed in [slice-proof.md](slice-proof.md#what-this-does-not-prove).",
    "- A row is added to this page only with a command that prints it. A check that is not in the repository has no row.", "");
  return out.join("\n");
}

// The README's block: the summary between two markers, rewritten by `record`.
const START = "<!-- scoreboard:start -->", END = "<!-- scoreboard:end -->";
export const readmeBlock = (b: Board) => [START, ...summary(b), END].join("\n");
export function inReadme(readme: string): string | undefined {
  const i = readme.indexOf(START), j = readme.indexOf(END);
  return i >= 0 && j > i ? readme.slice(i, j + END.length) : undefined;
}

const RECORD = (root: string) => join(root, "docs", "scoreboard.json");
export function loadRecord(root: string): Board {
  return existsSync(RECORD(root)) ? JSON.parse(readFileSync(RECORD(root), "utf8")) as Board : { rows: {} };
}
function save(root: string, b: Board): void {
  const ordered: Board = { rows: {} };
  for (const r of ROWS) if (b.rows[r.id]) (ordered.rows as Record<string, unknown>)[r.id] = b.rows[r.id];
  writeFileSync(RECORD(root), JSON.stringify(ordered, null, 2) + "\n");
  writeFileSync(join(root, "docs", "scoreboard.md"), render(ordered));
  const readme = readFileSync(join(root, "README.md"), "utf8"), was = inReadme(readme);
  if (was) writeFileSync(join(root, "README.md"), readme.replace(was, () => readmeBlock(ordered)));
}

function git(args: string[]): string { return Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim(); }

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const verb = argv[0] && !argv[0].startsWith("--") ? argv[0] : "print";
  const board = loadRecord(ROOT);
  if (verb === "print") { console.log(render(board)); return 0; }
  if (verb === "check") {
    const page = existsSync(join(ROOT, "docs", "scoreboard.md")) && readFileSync(join(ROOT, "docs", "scoreboard.md"), "utf8") === render(board);
    const block = inReadme(readFileSync(join(ROOT, "README.md"), "utf8")) === readmeBlock(board);
    console.log(page && block ? "scoreboard: the page and the README block are the record rendered" : `scoreboard: ${page ? "the README block" : "docs/scoreboard.md"} is not the record rendered; bun scripts/scoreboard.ts record writes it`);
    return page && block ? 0 : 1;
  }
  if (verb !== "run" && verb !== "record") { console.error(`scoreboard: no such command "${verb}" (print, check, run, record)`); return 2; }

  const flagsWithValue = new Set(["--lme", "--output", "--commit", "--day"]);
  const named = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !flagsWithValue.has(all[i - 1] ?? ""));
  const unknown = named.filter((x) => !ROWS.some((r) => r.id === x));
  if (unknown.length) { console.error(`scoreboard: no such row "${unknown[0]}" (${ROWS.map((r) => r.id).join(", ")})`); return 2; }
  const lme = (arg("--lme") ?? LME_FILE).replace(/^~(?=\/)/, homedir());
  const day = arg("--day") ?? new Date().toISOString().slice(0, 10);
  const put = (id: RowId, commit: string, values: unknown) => { (board.rows as Record<string, unknown>)[id] = { command: rowById(id).command, commit, day, values }; };

  // One row from the saved output of its command, for a run made on another checkout of a commit.
  const output = arg("--output");
  if (verb === "record" && output) {
    const commit = git(["rev-parse", "--verify", `${arg("--commit") ?? ""}^{commit}`]);
    if (named.length !== 1 || !/^[0-9a-f]{40}$/.test(commit)) { console.error("scoreboard: record <row> --output <file> --commit <sha> takes one row and a commit this repo has"); return 2; }
    const id = named[0] as RowId, values = rowById(id).parse(readFileSync(output, "utf8"));
    if (!values) { console.error(`scoreboard: ${output} is not a finished run of \`${rowById(id).command}\``); return 1; }
    if (id === "longmemeval" && (values as LmeV).commit !== commit) { console.error(`scoreboard: that run says it ran on ${(values as LmeV).commit.slice(0, 12)}, not ${commit.slice(0, 12)}`); return 1; }
    put(id, commit, values); save(ROOT, board);
    console.log(`${id}: recorded from ${output} at ${commit.slice(0, 12)}`);
    return 0;
  }

  if (verb === "record") {
    const dirty = git(["status", "--porcelain", "--", ".", ":(exclude)docs/scoreboard.json", ":(exclude)docs/scoreboard.md", ":(exclude)README.md"]);
    if (dirty) { console.error("scoreboard: record needs a clean, committed tree, so each number names the commit that printed it; commit first"); return 1; }
  }
  const commit = git(["rev-parse", "HEAD"]);
  let differs = 0, ran = 0;
  for (const row of ROWS) {
    if (named.length && !named.includes(row.id)) continue;
    if (!row.present(ROOT)) { if (named.length) console.log(`${row.id}: its check is not in this repo`); continue; }
    const cannot = row.cannot?.({ lme });
    if (cannot) { console.log(`${row.id}: left as recorded, ${cannot}`); continue; }
    console.error(`${row.id}: running \`${row.command}\``);
    const { cmd, env } = row.argv({ lme });
    const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
    const values = row.parse(p.stdout.toString() + "\n" + p.stderr.toString());
    ran++;
    if (!values) { differs++; console.log(`${row.id}: the run did not finish (exit ${p.exitCode}): ${(p.stderr.toString().trim().split("\n").at(-1) ?? "").slice(0, 200)}`); continue; }
    const was = board.rows[row.id];
    if (verb === "record") { put(row.id, row.id === "longmemeval" ? (values as LmeV).commit : commit, values); console.log(`${row.id}: recorded at ${commit.slice(0, 12)}`); continue; }
    if (!was) { console.log(`${row.id}: no record to compare with`); continue; }
    const d = differences(row.id, was.values, values);
    if (d.length) differs++;
    console.log(d.length ? `${row.id}: DIFFERS from the record of ${was.day} (commit ${was.commit.slice(0, 12)})\n${d.map((l) => `  ${l}`).join("\n")}` : `${row.id}: same as the record of ${was.day} (commit ${was.commit.slice(0, 12)})`);
  }
  if (verb === "record" && ran) save(ROOT, board);
  return differs ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
