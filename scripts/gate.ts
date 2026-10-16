// SPDX-License-Identifier: AGPL-3.0-only
// The merge gate every branch passes before the builder merges it, whichever thread wrote it.
//   bun scripts/gate.ts [base]            verdict for HEAD against base (default main): MERGE or BLOCKED
//   bun scripts/gate.ts [base] --no-run   skip the long checks (bun run check, red run); rules only
//   bun scripts/gate.ts record <agent-evals|slice-audit> <pass|clear|fail|regression> [note]
// Paid agent evals and slice audits are run by one session and recorded in a ledger keyed by the
// git tree, so a rebase or squash with the same content keeps its evidence. Ledger: $PB_GATES, else
// /mnt/project-files/pocketbrain/gates.jsonl if that folder exists, else ~/.config/pocketbrain/gates.jsonl.
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
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
export function rules(changes: Change[], messages: string, tree: string, ledger: Entry[]): string[] {
  const fail: string[] = [];
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

// Red run: the branch's changed tests against the base's code must fail, else they don't test the change.
function red(base: string, tests: string[]): string | undefined {
  if (!tests.length) return;
  const dir = mkdtempSync(join(tmpdir(), "pb-gate-red-"));
  Bun.spawnSync(["sh", "-c", `git archive ${base} | tar -x -C ${dir}`]);
  for (const t of tests) { mkdirSync(join(dir, dirname(t)), { recursive: true }); cpSync(t, join(dir, t)); }
  if (existsSync("node_modules")) symlinkSync(join(process.cwd(), "node_modules"), join(dir, "node_modules"));
  const r = Bun.spawnSync(["bun", "test", ...tests.map((t) => `./${t}`)], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, PB_TODAY: process.env.PB_TODAY ?? "" } });
  return r.exitCode === 0 ? `test first: the changed tests (${tests.join(", ")}) also pass on ${base}, so none was seen failing` : undefined;
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
  const base = argv.find((a) => !a.startsWith("--")) ?? "main";
  const run = !argv.includes("--no-run");
  const mb = git("merge-base", base, "HEAD");
  const changes = git("diff", "--name-status", "--no-renames", mb, "HEAD").split("\n").filter(Boolean).map((l) => { const [status, path] = l.split("\t"); return { status, path }; });
  const fail = rules(changes, git("log", "--format=%B", `${mb}..HEAD`), git("rev-parse", "HEAD^{tree}"), readLedger());
  console.log(`gate: ${changes.length} files changed since ${base} (${mb.slice(0, 7)})`);
  if (run) {
    const r = red(mb, changes.filter((c) => c.status !== "D" && /^test\/.*\.test\.ts$/.test(c.path)).map((c) => c.path));
    if (r) fail.push(r);
    const check = Bun.spawnSync(["bun", "run", "check"], { stdout: "pipe", stderr: "pipe" });
    console.log(`bun run check: exit ${check.exitCode}`);
    fail.push(...checkFailures(check.exitCode, check.stderr.toString()));
  }
  for (const f of fail) console.log(`✗ ${f}`);
  console.log(fail.length ? "BLOCKED" : "MERGE");
  return fail.length ? 1 : 0;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
