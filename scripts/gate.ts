// SPDX-License-Identifier: AGPL-3.0-only
// The merge gate every branch passes before the builder merges it, whichever thread wrote it.
//   bun scripts/gate.ts [base]            verdict for HEAD against base (default main): MERGE or BLOCKED
//   bun scripts/gate.ts [base] --no-run   skip the long checks (bun run check, red run); rules only
//   bun scripts/gate.ts [base] --no-ledger  where the ledger can't be read (CI): slice-audit and
//                                           agent-eval rules print as notes; every other rule blocks
//   bun scripts/gate.ts record <agent-evals|slice-audit> <pass|clear|fail|regression> [note]
//   bun scripts/gate.ts flaky [--days 7]  tests that failed then passed on rerun twice or more
//   bun scripts/gate.ts [base] --ci-red-ok  merge while GitHub CI on main is red (a branch that fixes it)
// A full run also runs the north-star eval (scripts/north-star.ts) and blocks on a fail (NORTH_STAR_BLOCKING).
// Paid agent evals and slice audits are run by one session and recorded in a ledger keyed by the
// git tree, so a rebase or squash with the same content keeps its evidence. Ledger: $PB_GATES, else
// /mnt/project-files/pocketbrain/gates.jsonl if that folder exists, else ~/.config/pocketbrain/gates.jsonl.
// Flaky tests (backlog #323): a failing test file is rerun once. A test that then passes is logged
// in flaky.jsonl beside the ledger ($PB_FLAKY overrides) and lets the gate pass the first time;
// the same test flaking again on another tree blocks it, so nobody excuses it as flaky twice.
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const ACCESS_CORE = /(^|\/)src\/(carve|write|checks|auth|oauth|cell|view|relay|act)\.ts$/;
export const PROMPTS = /(^|\/)src\/(orientation|judge|model)\.ts$|(^|\/)rules\/instructions\/|(^|\/)evals\/cases\/agents\.ts$/;
const CODE = /^(src|scripts|\.claude\/hooks)\/.*\.ts$/;
const TESTS = /^(test|evals)\//;
const DOCS = /^(README\.md|CLAUDE\.md|docs\/|evals\/README\.md)/;

export interface Change { status: string; path: string }
export interface Entry { tree: string; sha?: string; kind: "agent-evals" | "slice-audit"; result: string; note?: string; at?: string }

// Rules only: what this diff requires and whether the evidence is there. Pure, so it is tested.
// Jobs the hub repeats while it runs (setInterval in src/start.ts). Audit v4: 4 became 6 in a day,
// one running git log every minute. A branch that adds one says why in a "Job-Budget: <reason>"
// trailer, so a new recurring job is a decision, never a side effect.
export const recurringJobs = (startTs: string) => (startTs.match(/\bsetInterval\(/g) ?? []).length;

export function rules(changes: Change[], messages: string, tree: string, ledger: Entry[], jobs?: { base: number; head: number }): string[] {
  const fail: string[] = [];
  if (jobs && jobs.head > jobs.base && !/^Job-Budget: \S/m.test(messages))
    fail.push(`jobs: src/start.ts repeats ${jobs.head} jobs, ${jobs.base} on the base; say why in a "Job-Budget: <reason>" trailer, or fold the work into a job that already runs`);
  const paths = changes.map((c) => c.path);
  const code = paths.filter((p) => CODE.test(p));
  if (code.length && !paths.some((p) => TESTS.test(p)) && !/^No-Test: \S/m.test(messages))
    fail.push(`test first: ${code[0]} changed but no test/ or evals/ file did (or add a "No-Test: <reason>" trailer)`);
  const newSrc = changes.some((c) => c.status === "A" && /^src\/.*\.ts$/.test(c.path));
  if ((newSrc || paths.includes("src/cli.ts")) && !paths.some((p) => DOCS.test(p)))
    fail.push("docs: a new src file or a CLI change needs README, CLAUDE.md or docs/ updated in the same branch");
  const has = (kind: Entry["kind"], ok: string[]) => ledger.some((e) => e.tree === tree && e.kind === kind && ok.includes(e.result));
  if (paths.some((p) => ACCESS_CORE.test(p)) && !has("slice-audit", ["clear"]))
    fail.push(`slice audit: the access core changed; no "clear" slice audit recorded for tree ${tree.slice(0, 7)}`);
  if (paths.some((p) => PROMPTS.test(p)) && !has("agent-evals", ["pass"]))
    fail.push(`agent evals: a prompt changed; no passing \`--llm --only agents\` run recorded for tree ${tree.slice(0, 7)} (ask the eval runner via eval-queue.md)`);
  return fail;
}

// The rules that need the ledger's evidence. CI can't read the ledger, so with --no-ledger they
// print as what the builder still has to record, and only the others block. Pure, so it is tested.
export function splitEvidence(fail: string[]): { block: string[]; needs: string[] } {
  const ev = (x: string) => x.startsWith("slice audit:") || x.startsWith("agent evals:");
  return { block: fail.filter((x) => !ev(x)), needs: fail.filter(ev) };
}

const git = (...a: string[]) => {
  const r = Bun.spawnSync(["git", ...a], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
};

export function ledgerPath(): string {
  if (process.env.PB_GATES) return process.env.PB_GATES;
  return existsSync("/mnt/project-files/pocketbrain") ? "/mnt/project-files/pocketbrain/gates.jsonl" : join(homedir(), ".config/pocketbrain/gates.jsonl");
}

function readLedger(): Entry[] {
  const f = ledgerPath();
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
}

// \`bun run check\` passes only with no failure and no skip: a skipped test is a tool this machine
// lacks (test/tools.ts), and known noise is how real regressions hide (backlog #278). Pure, so it is tested.
export function checkFailures(exitCode: number, stderr: string): string[] {
  const out: string[] = [];
  if (exitCode !== 0) out.push(`checks: \`bun run check\` failed\n${stderr.split("\n").filter((l) => /fail|error|lacks/i.test(l)).slice(0, 10).join("\n")}`);
  const skips = [...stderr.matchAll(/^\s*(\d+) skip\b/gm)].reduce((n, m) => n + Number(m[1]), 0);
  if (skips) out.push(`checks: ${skips} test${skips === 1 ? "" : "s"} skipped; every test must run (install what test/tools.ts names)`);
  return out;
}

// The north star (outside review 2026-10-25): on since the honest replay passed on main (audit v3,
// 2026-10-26), so a merge that breaks it is blocked. Pure verdict, so it is tested.
export const NORTH_STAR_BLOCKING = true;
export function northStarVerdict(exitCode: number, blocking: boolean): string | undefined {
  if (exitCode === 0 || !blocking) return undefined;
  return "north star: the replayed week asked about something other than its 3 planted contradictions (or missed one), its imported page or under 80% of its pages ended without cited prose and an inbound link, or a planned save was refused (bun scripts/north-star.ts)";
}

// GitHub CI on main (G521): it was red on every push from 2026-10-15 to 2026-10-30 while the gate and
// the pre-push hook were green, and nobody saw it; the release tag waits on it. A full gate run reads
// the latest finished runs of ci.yml on main and blocks while main has been red for over a day.
export interface CiRun { conclusion: string | null; created_at: string; head_sha: string }
export function ciVerdict(runs: CiRun[], now = Date.now()): string | undefined {
  const done = runs.filter((r) => r.conclusion).sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (!done.length || done[0].conclusion === "success") return undefined;
  const green = done.find((r) => r.conclusion === "success");
  const firstRed = [...done].reverse().find((r) => r.conclusion !== "success" && (!green || r.created_at > green.created_at))!;
  if (now - Date.parse(firstRed.created_at) < 86_400_000) return undefined;
  return `GitHub CI on main has been red since ${firstRed.created_at.slice(0, 16)}Z (${firstRed.head_sha.slice(0, 8)})${green ? `, last green ${green.created_at.slice(0, 10)}` : `, no green run in the last ${done.length}`}: fix it first, or pass --ci-red-ok on the branch that does`;
}

function ciRuns(): CiRun[] | string {
  const url = Bun.spawnSync(["git", "remote", "get-url", "origin"], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
  const repo = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1];
  if (!repo) return "no GitHub origin";
  const r = Bun.spawnSync(["gh", "api", `repos/${repo}/actions/workflows/ci.yml/runs?branch=main&per_page=50`, "--jq", ".workflow_runs | map({conclusion, created_at, head_sha})"], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  if (r.exitCode !== 0) return (r.stderr.toString().trim().split("\n").at(-1) || "gh failed").slice(0, 120);
  try { return JSON.parse(r.stdout.toString()) as CiRun[]; } catch { return "unreadable answer"; }
}

// ---------- flaky tests ----------

export interface Failure { file: string; name: string }
// output: what bun printed for that failure (its error and diff), so a flake can be diagnosed later.
export interface FlakyEntry { at: string; file: string; test: string; tree: string; sha?: string; output?: string }

// bun test prints each file's path line ("test/x.test.ts:") before its results; a failure is "(fail) <name> [ms]".
// On GitHub Actions bun wraps each file in a group, so the path line starts "::group::".
const FILE_LINE = /^(?:::group::)?((?:test|evals)\/\S+\.test\.ts):$/;
export function parseFailures(out: string): Failure[] {
  let file = "";
  const fails: Failure[] = [];
  for (const line of out.split("\n")) {
    const f = line.match(FILE_LINE);
    if (f) { file = f[1]; continue; }
    if (/^\d+ tests? failed:?$/.test(line.trim())) break; // a closing summary repeats them without files
    const m = line.match(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/);
    if (m && file && !fails.some((x) => x.file === file && x.name === m[1])) fails.push({ file, name: m[1] });
  }
  return fails;
}

// What bun printed for one failure: the lines in its file's section after the result before it,
// through its own (fail) line, at most the last 4000 characters.
export function failureOutput(out: string, f: Failure): string {
  let file = "", buf: string[] = [];
  for (const line of out.split("\n")) {
    const fl = line.match(FILE_LINE);
    if (fl) { file = fl[1]; buf = []; continue; }
    if (file !== f.file) continue;
    buf.push(line);
    const m = line.match(/^\((pass|fail|skip|todo)\) (.+?)(?: \[[\d.]+m?s\])?$/);
    if (m && m[1] === "fail" && m[2] === f.name) return buf.join("\n").trim().slice(-4000);
    if (m) buf = [];
  }
  return "";
}

// First run's failures against the rerun's: still failing is real; passing now is a flake, which
// blocks when the same test already flaked on another tree.
export function judgeFlakes(first: Failure[], rerun: Failure[], ledger: FlakyEntry[], tree: string) {
  const same = (x: Failure, y: Failure) => x.file === y.file && x.name === y.name;
  const real = first.filter((f) => rerun.some((r) => same(f, r)));
  const flaky: Failure[] = [], repeat: (Failure & { before: FlakyEntry })[] = [];
  for (const f of first.filter((f) => !real.includes(f))) {
    const before = ledger.find((e) => e.file === f.file && e.test === f.name && e.tree !== tree);
    if (before) repeat.push({ ...f, before }); else flaky.push(f);
  }
  return { real, flaky, repeat };
}

export function flakyReport(ledger: FlakyEntry[], days = 7, now = Date.now()) {
  const since = new Date(now - days * 86_400_000).toISOString();
  const by = new Map<string, FlakyEntry[]>();
  for (const e of ledger.filter((e) => e.at >= since)) by.set(`${e.file}\0${e.test}`, [...(by.get(`${e.file}\0${e.test}`) ?? []), e]);
  return [...by.values()].filter((es) => es.length >= 2)
    .map((es) => ({ file: es[0].file, test: es[0].test, flakes: es.length, trees: new Set(es.map((e) => e.tree)).size, last: es.map((e) => e.at).sort().at(-1)! }))
    .sort((x, y) => y.flakes - x.flakes || x.test.localeCompare(y.test));
}

export function flakyPath(): string {
  if (process.env.PB_FLAKY) return process.env.PB_FLAKY;
  return join(dirname(ledgerPath()), "flaky.jsonl");
}
const readJsonl = <T>(f: string): T[] => existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as T]; } catch { return []; } }) : [];

// The test half of `bun run check`, with one rerun of the files that failed.
// Whether bun's own count matches the failures read: a load error ("# Unhandled error between
// tests", counted as " N error") or a failure printed without a (fail) line can't be rerun safely.
export function unaccounted(out: string, parsed: number): string | undefined {
  const count = (k: string) => [...out.matchAll(new RegExp(`^\\s*(\\d+) ${k}\\b`, "gm"))].reduce((n, m) => n + Number(m[1]), 0);
  const errors = count("errors?"), fails = count("fail");
  if (errors) return `checks: \`bun test\` reported ${errors} error${errors === 1 ? "" : "s"} outside any test (a file that didn't load); not rerun`;
  if (fails > parsed) return `checks: \`bun test\` reported ${fails} failures but only ${parsed} could be named; not rerun`;
  return undefined;
}

// The rest of package.json's "check" after `bun test`, run as its own step (pinned by test/gate-flaky.test.ts).
export const CHECK_REST = "bun run typecheck && bun run deadcode && bun evals/run.ts --ci";

// `changed`: test files this branch adds or changes. A flake there blocks the first time: a new
// test that passes only sometimes isn't a test yet.
export function testsWithRerun(tree: string, sha: string, changed: string[] = []): string[] {
  const first = Bun.spawnSync(["bun", "test"], { stdout: "pipe", stderr: "pipe" });
  const out1 = first.stdout.toString() + first.stderr.toString();
  console.log(`bun test: exit ${first.exitCode}`);
  if (first.exitCode === 0) return checkFailures(0, out1);
  const fails = parseFailures(out1);
  if (!fails.length) return checkFailures(first.exitCode, out1);
  const odd = unaccounted(out1, fails.length);
  if (odd) return [odd, ...checkFailures(first.exitCode, out1)];
  const files = [...new Set(fails.map((f) => f.file))];
  const second = Bun.spawnSync(["bun", "test", ...files.map((f) => `./${f}`)], { stdout: "pipe", stderr: "pipe" });
  const j = judgeFlakes(fails, parseFailures(second.stdout.toString() + second.stderr.toString()), readJsonl<FlakyEntry>(flakyPath()), tree);
  const at = new Date().toISOString();
  mkdirSync(dirname(flakyPath()), { recursive: true });
  for (const f of [...j.flaky, ...j.repeat]) appendFileSync(flakyPath(), JSON.stringify({ at, file: f.file, test: f.name, tree, sha, output: failureOutput(out1, f) } satisfies FlakyEntry) + "\n");
  for (const f of j.flaky.filter((f) => !changed.includes(f.file))) console.log(`~ flaky: ${f.file} > ${f.name} failed, then passed on rerun; logged in ${flakyPath()} (a second flake on another tree blocks)`);
  const out: string[] = [];
  if (j.real.length) out.push(`checks: \`bun test\` failed, and failed again on rerun\n${j.real.map((f) => `(fail) ${f.file} > ${f.name}`).join("\n")}`);
  for (const f of j.flaky.filter((f) => changed.includes(f.file))) out.push(`flaky in a changed test: ${f.file} > ${f.name} failed, then passed on rerun; a test this branch adds or changes must pass every time`);
  for (const f of j.repeat) out.push(`flaky twice: ${f.file} > ${f.name} failed then passed on rerun, as it did on tree ${f.before.tree.slice(0, 7)} (${f.before.at}); fix the test, don't rerun it`);
  if (!j.real.length && !j.repeat.length && second.exitCode !== 0 && !parseFailures(second.stdout.toString() + second.stderr.toString()).length)
    out.push(`checks: the rerun of ${files.join(", ")} failed without a test failing`);
  return [...out, ...checkFailures(0, out1).filter((x) => x.includes("skipped"))];
}

// Red run: the branch's changed tests against the base's code must fail, else they don't test the change.
function red(base: string, tests: string[]): string | undefined {
  if (!tests.length) return;
  const dir = mkdtempSync(join(tmpdir(), "pb-gate-red-"));
  try {
    Bun.spawnSync(["sh", "-c", `git archive ${base} | tar -x -C ${dir}`]);
    for (const t of tests) { mkdirSync(join(dir, dirname(t)), { recursive: true }); cpSync(t, join(dir, t)); }
    if (existsSync("node_modules")) symlinkSync(join(process.cwd(), "node_modules"), join(dir, "node_modules"));
    const r = Bun.spawnSync(["bun", "test", ...tests.map((t) => `./${t}`)], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, PB_TODAY: process.env.PB_TODAY ?? "" } });
    return r.exitCode === 0 ? `test first: the changed tests (${tests.join(", ")}) also pass on ${base}, so none was seen failing` : undefined;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "record") {
    const [, kind, result, ...note] = argv;
    if (!["agent-evals", "slice-audit"].includes(kind) || !result) { console.error("record <agent-evals|slice-audit> <pass|clear|fail|regression> [note]"); return 2; }
    const e: Entry = { tree: git("rev-parse", "HEAD^{tree}"), sha: git("rev-parse", "HEAD"), kind: kind as Entry["kind"], result, note: note.join(" ") || undefined, at: new Date().toISOString() };
    mkdirSync(dirname(ledgerPath()), { recursive: true });
    appendFileSync(ledgerPath(), JSON.stringify(e) + "\n");
    console.log(`recorded ${kind} ${result} for ${e.sha!.slice(0, 7)} (tree ${e.tree.slice(0, 7)}) in ${ledgerPath()}`);
    return 0;
  }
  if (argv[0] === "flaky") {
    const d = argv.indexOf("--days"), days = d >= 0 ? Number(argv[d + 1]) : 7;
    const rows = flakyReport(readJsonl<FlakyEntry>(flakyPath()), days);
    console.log(rows.length ? rows.map((r) => `${r.flakes}x on ${r.trees} tree${r.trees === 1 ? "" : "s"}, last ${r.last}  ${r.file} > ${r.test}`).join("\n") : `no test flaked twice in the last ${days} days`);
    return 0;
  }
  const base = argv.find((a) => !a.startsWith("--")) ?? "main";
  const run = !argv.includes("--no-run");
  const mb = git("merge-base", base, "HEAD");
  // -z: raw paths, NUL-separated. Plain output quotes a non-ASCII path, which then matched no rule.
  const fields = git("diff", "--name-status", "-z", "--no-renames", mb, "HEAD").split("\0").filter(Boolean);
  const changes: Change[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) changes.push({ status: fields[i], path: fields[i + 1] });
  const startAt = (rev: string) => { const r = Bun.spawnSync(["git", "show", `${rev}:src/start.ts`], { stdout: "pipe", stderr: "pipe" }); return r.exitCode === 0 ? recurringJobs(r.stdout.toString()) : 0; };
  const jobs = { base: startAt(mb), head: startAt("HEAD") };
  const all = rules(changes, git("log", "--format=%B", `${mb}..HEAD`), git("rev-parse", "HEAD^{tree}"), readLedger(), jobs);
  const { block, needs } = argv.includes("--no-ledger") ? splitEvidence(all) : { block: all, needs: [] };
  const fail = block;
  console.log(`gate: ${changes.length} files changed since ${base} (${mb.slice(0, 7)}); recurring hub jobs ${jobs.head} (base ${jobs.base})`);
  if (run) {
    const changedTests = changes.filter((c) => c.status !== "D" && /^test\/.*\.test\.ts$/.test(c.path)).map((c) => c.path);
    const r = red(mb, changedTests);
    if (r) fail.push(r);
    // `bun run check` in two halves: the tests (with one rerun of a failing file), then the rest.
    fail.push(...testsWithRerun(git("rev-parse", "HEAD^{tree}"), git("rev-parse", "HEAD"), changedTests));
    const rest = Bun.spawnSync(["sh", "-c", CHECK_REST], { stdout: "pipe", stderr: "pipe" });
    console.log(`typecheck, deadcode, evals: exit ${rest.exitCode}`);
    if (rest.exitCode !== 0) fail.push(...checkFailures(rest.exitCode, rest.stderr.toString() + rest.stdout.toString()).map((x) => x.replace("`bun run check`", "typecheck, deadcode or evals")));
  }
  if (run) {
    // The north-star eval (scripts/north-star.ts): printed on every run; it blocks while
    // NORTH_STAR_BLOCKING is on.
    const ns = Bun.spawnSync(["bun", "scripts/north-star.ts"], { stdout: "pipe", stderr: "pipe" });
    console.log(ns.stdout.toString().trim() || `north star: didn't run (${ns.stderr.toString().trim().split("\n").at(-1)})`);
    const v = northStarVerdict(ns.exitCode, NORTH_STAR_BLOCKING);
    if (v) fail.push(v);
    // The same numbers from a real brain, where one is reachable (PB_NORTH_STAR_BRAIN, read-only,
    // counts only): printed, and blocking like the replay.
    const brain = process.env.PB_NORTH_STAR_BRAIN;
    if (brain) {
      const nb = Bun.spawnSync(["bun", "scripts/north-star.ts", "--brain", brain], { stdout: "pipe", stderr: "pipe" });
      console.log(nb.stdout.toString().trim() || `north star (real brain): didn't run (${nb.stderr.toString().trim().split("\n").at(-1)})`);
      const vb = northStarVerdict(nb.exitCode, NORTH_STAR_BLOCKING);
      if (vb) fail.push(vb.replace("north star:", "north star (real brain):"));
    } else console.log("north star (real brain): no brain here (set PB_NORTH_STAR_BRAIN to measure one)");
    // A closed gap names the commit on main that closed it (audit v3: 14 of 15 named a branch that
    // resolves nowhere). A branch's own new gaps cite the branch until it lands; printed, not blocking.
    const { GAPS } = await import("../evals/gaps");
    const stale = Object.entries(GAPS).filter(([, g]) => g.closed && Bun.spawnSync(["git", "merge-base", "--is-ancestor", g.closed.split(/[\s(]/)[0], "HEAD"], { stdout: "pipe", stderr: "pipe" }).exitCode !== 0).map(([id]) => id);
    console.log(`closed gaps naming no commit on this branch: ${stale.length}${stale.length ? ` (${stale.join(", ")}; swap in the landed sha)` : ""}`);
  }
  if (run && !argv.includes("--no-ledger")) {
    const runs = ciRuns();
    if (typeof runs === "string") console.log(`GitHub CI on main: unknown (${runs})`);
    else {
      const v = ciVerdict(runs);
      console.log(`GitHub CI on main: ${runs.find((r) => r.conclusion)?.conclusion ?? "no finished run"}`);
      if (v && !argv.includes("--ci-red-ok")) fail.push(v);
      else if (v) console.log(`~ ${v} (--ci-red-ok)`);
    }
  }
  for (const n of needs) console.log(`~ needs evidence the builder records: ${n}`);
  for (const f of fail) console.log(`✗ ${f}`);
  console.log(fail.length ? "BLOCKED" : "MERGE");
  return fail.length ? 1 : 0;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
