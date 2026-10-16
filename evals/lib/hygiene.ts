// SPDX-License-Identifier: AGPL-3.0-only
// Eval hygiene (backlog 106): a golden case must not reuse an example from the prompt it grades.
// A model that echoes its own instructions would pass such a case without understanding it.
// Prompts are the text agents and model steps are given (orientation, the browser door's
// guide, the standing instruction, the judge, capture, sleep and after-check prompts); case
// inputs are the quoted strings in evals/cases. Overlap is any run of SHINGLE words in common.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const SHINGLE = 6;
const PROSE = 4; // real words a run needs to count
export const PROMPT_FILES = ["src/orientation.ts", "src/browser.ts", "src/judge.ts", "src/capture.ts", "src/sleep.ts", "src/aftercheck.ts", "src/relay.ts", "docs/agent-instructions.md"];
// Cases that check the prompt text itself (its wording is the expected answer), not a golden input.
export const PROMPT_CHECKS = new Set(["evals/cases/orientation.ts", "evals/cases/onboarding.ts"]);
// Adversarial cases copy a prompt's own wording on purpose (an injection that imitates the answer
// format). Only a case whose id has an "-inject" part is exempt, and only on the line that holds that id.
export const ADVERSARIAL = /\bid:\s*["'][a-z0-9-]*-inject(-[a-z0-9-]*)?["']/;

const words = (t: string) => t.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").split(/[^a-z0-9]+/).filter(Boolean);
// Quoted strings on one line ("…" or '…'), plus template literals when `templates` (prompts are built from them).
export function literals(src: string, templates = false): string[] {
  const out = [...src.matchAll(/"((?:[^"\\\n]|\\.){20,})"|'((?:[^'\\\n]|\\.){20,})'/g)].map((m) => m[1] ?? m[2]);
  if (templates) out.push(...[...src.matchAll(/`([^`]{20,})`/g)].map((m) => m[1]));
  return out;
}
export function shingles(text: string, n = SHINGLE): Set<string> {
  const w = words(text);
  const s = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) {
    const run = w.slice(i, i + n);
    if (run.filter((x) => /^[a-z]{3,}$/.test(x)).length >= PROSE) s.add(run.join(" ")); // prose, not code or regex fragments
  }
  return s;
}

// Every case input that shares a run of SHINGLE words with a prompt: [case file, input, shared words, prompt file].
export function contamination(prompts: Record<string, string>, cases: Record<string, string>): [string, string, string, string][] {
  const seen = new Map<string, string>();
  for (const [f, text] of Object.entries(prompts))
    for (const l of f.endsWith(".md") ? [text] : literals(text, true)) for (const s of shingles(l)) seen.set(s, f);
  const out: [string, string, string, string][] = [];
  for (const [f, text] of Object.entries(cases))
    for (const l of text.split("\n").filter((line) => !ADVERSARIAL.test(line)).flatMap((line) => literals(line))) { const hit = [...shingles(l)].find((s) => seen.has(s)); if (hit) out.push([f, l.slice(0, 120), hit, seen.get(hit)!]); }
  return out;
}

export function repoContamination(root: string) {
  const read = (f: string) => { try { return readFileSync(join(root, f), "utf8"); } catch { return ""; } };
  const prompts = Object.fromEntries(PROMPT_FILES.map((f) => [f, read(f)]));
  const cases = Object.fromEntries(readdirSync(join(root, "evals", "cases")).filter((f) => f.endsWith(".ts")).map((f) => `evals/cases/${f}`).filter((f) => !PROMPT_CHECKS.has(f)).map((f) => [f, read(f)]));
  return contamination(prompts, cases);
}
