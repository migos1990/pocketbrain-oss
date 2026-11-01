// SPDX-License-Identifier: AGPL-3.0-only
// Docs drift, second pass (owner, 2026-10-31: "we should have a CI that checks for docs out of
// whack"). test/docs.test.ts checks commands, flags, scripts and paths in code spans; this file
// checks what it doesn't: section links, paths named in prose, subcommands, the names of the
// environment variables and keys the code reads, the version labels, the changelog's gap ids,
// and the Settings list the phone doc repeats. It runs in `bun test`, so CI fails on drift.
// The live half (the site's addresses and the public repo, which need the network) is
// `bun scripts/docs-live.ts`.
import { test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { excludedNames, excludedPaths, isExcluded } from "./excluded.ts";

const ROOT = join(import.meta.dir, "..");
const text = (f: string) => readFileSync(join(ROOT, f), "utf8");
const md = (dir: string) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".md")).map((f) => `${dir}/${f}`);
// video-kit.md is the film's private runbook, left out of the public repo (as in docs.test.ts).
const PRIVATE = new Set(["docs/video-kit.md"]);
const CURRENT = ["README.md", "CLAUDE.md", "CONTRIBUTING.md", "SECURITY.md", ...md("docs"), ...md("docs/spec"), ...md("docs/connect")].filter((f) => !PRIVATE.has(f));
const CHANGELOG = text("CHANGELOG.md");
const unreleased = CHANGELOG.slice(CHANGELOG.indexOf("## [Unreleased]"), CHANGELOG.search(/^## \[\d/m));

// GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens, repeats numbered.
function anchors(f: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  for (const m of text(f).replace(/```[\s\S]*?```/g, "").matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const base = m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  for (const m of text(f).matchAll(/<a (?:name|id)="([^"]+)"/g)) out.add(m[1]);
  return out;
}

test("every link to a section of a repo doc names a heading that exists", () => {
  const broken: string[] = [];
  for (const f of [...CURRENT, "CHANGELOG.md"])
    for (const m of text(f).matchAll(/\]\(([^)\s#]*)#([^)\s]+)\)/g)) {
      if (/^[a-z]+:/.test(m[1])) continue;
      const target = m[1] ? join(f, "..", m[1]) : f;
      if (!target.endsWith(".md") || !existsSync(join(ROOT, target))) continue;
      if (!anchors(target).has(decodeURIComponent(m[2]).toLowerCase())) broken.push(`${f} -> ${m[1]}#${m[2]}`);
    }
  expect(broken).toEqual([]);
});

// A path written in a sentence ("see docs/x.md", "the hub's src/y.ts") must exist too, not only one
// in backticks. Brain paths (rules/, log/, inbox/…) are the owner's brain's, not this repo's.
const REPO_PATH = /(?<![\w/.~-])((?:src|test|scripts|evals|docs|examples|conformance|macos|site)\/[\w.\/-]*[\w-]\.(?:ts|md|sh|jsonl|json|yaml|yml|py|swift|txt|html))(?![\w/-])/g;
test("every repo path named in the docs exists", () => {
  const missing: string[] = [];
  for (const f of [...CURRENT, "CHANGELOG.md#Unreleased"]) {
    const body = f === "CHANGELOG.md#Unreleased" ? unreleased : text(f);
    for (const m of body.matchAll(REPO_PATH)) {
      const p = m[1];
      // "evals/weekly.yaml in the brain" is the owner's brain's file, said so in the sentence.
      if (body.slice(m.index! + p.length, m.index! + p.length + 13) === " in the brain") continue;
      // A .jsonl is a log a run writes (evals/history/switchday.jsonl); the site's pages live on
      // branch claude/pocketbrain-site, and a sentence naming one says so.
      if (p.endsWith(".jsonl")) continue;
      const line = body.slice(body.lastIndexOf("\n", m.index!) + 1, body.indexOf("\n", m.index!) >>> 0);
      if (p.startsWith("site/") && line.includes("claude/pocketbrain-site")) continue;
      // A path the public copy leaves out is still a repo path (the public copy keeps the docs).
      if (!existsSync(join(ROOT, p)) && !isExcluded(p)) missing.push(`${f}: ${p}`);
    }
  }
  expect([...new Set(missing)]).toEqual([]);
});

// `pocketbrain <command> <subcommand>`: the subcommand must be one `help --all` lists for it.
const usage = Bun.spawnSync(["bun", "src/cli.ts", "help", "--all"], { cwd: ROOT }).stdout.toString();
function subcommands(): { subs: Map<string, Set<string>>; open: Set<string> } {
  const subs = new Map<string, Set<string>>();
  const open = new Set<string>(); // commands whose second word is an argument (<agent>, <dir>…)
  for (const m of usage.matchAll(/^ {2}([a-z][a-z-]*)(?: ([^\n]*))?$/gm)) {
    const cmd = m[1];
    const s = subs.get(cmd) ?? new Set<string>();
    subs.set(cmd, s);
    const rest = (m[2] ?? "").split(/\s{3,}/)[0]; // the form, not its explanation
    // Each "|" alternative may repeat the command ("standing list | standing set <p>").
    for (const alt of rest.split(/\s\|\s/)) {
      const words = alt.trim().split(/\s+/);
      const w = words[0] === cmd ? words[1] : words[0];
      if (!w) continue;
      if (/^[a-z][a-z-]*$/.test(w)) s.add(w);
      else if (!w.startsWith("-")) open.add(cmd);
    }
  }
  return { subs, open };
}
const code = (s: string) => [...s.matchAll(/```[a-z]*\n([\s\S]*?)```|`([^`\n]+)`/g)].map((m) => m[1] ?? m[2]);

test("help --all lists subcommands to check against", () => {
  const { subs } = subcommands();
  expect([...(subs.get("standing") ?? [])].sort()).toEqual(["approve", "list", "set", "suggest"]);
});

test("every `pocketbrain <command> <subcommand>` in the docs is one the CLI lists", () => {
  const { subs, open } = subcommands();
  const unknown: string[] = [];
  for (const [f, body] of [...CURRENT.map((f) => [f, text(f)]), ["CHANGELOG.md#Unreleased", unreleased]])
    for (const snip of code(body))
      for (const line of snip.split("\n"))
        for (const m of line.matchAll(/(?:^|\s|\$ )pocketbrain ([a-z][a-z-]*) ([a-z][a-z-]*)\b/g)) {
          const known = subs.get(m[1]);
          if (!known?.size || open.has(m[1]) || known.has(m[2])) continue;
          unknown.push(`${f}: pocketbrain ${m[1]} ${m[2]} (the CLI lists ${[...known].join(", ")})`);
        }
  expect([...new Set(unknown)]).toEqual([]);
});

// Environment variables and key names, both ways: a name the docs tell you to set is one the code
// reads, and a name the code reads is in the docs (where a stranger looks for it). Only names;
// values never appear anywhere.
const walk = (d: string): string[] => readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
const SRC = walk("src").filter((f) => f.endsWith(".ts")).map(text).join("\n");
const ALL_CODE = [SRC, ...["scripts", "test", "evals", "conformance", "macos", ".github", ".githooks", "site"].filter((d) => existsSync(join(ROOT, d))).flatMap(walk).filter((f) => /\.(ts|sh|yml|swift|py)$|githooks\//.test(f)).map(text), text("install.sh")].join("\n");
const DOCS = CURRENT.map(text).join("\n");
// The machine's own variables, read for where things go, not settings an owner looks up.
const OS_VARS = new Set(["HOME", "PATH", "TMPDIR", "USER", "SHELL", "TERM", "XDG_CONFIG_HOME", "NODE_ENV", "CI", "GITHUB_ACTIONS"]);

test("every environment variable and key name the code reads is named in the docs", () => {
  const read = new Set<string>();
  for (const m of SRC.matchAll(/(?:process|Bun)\.env\.([A-Z][A-Z0-9_]+)|env\[["']([A-Z][A-Z0-9_]+)["']\]/g)) read.add(m[1] ?? m[2]);
  // Key names held in tables (the model providers' keys, src/model.ts).
  for (const m of SRC.matchAll(/["']([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:API_KEY|TOKEN|SECRET|SID|PUSH_KEY|RELAY_KEY))["']/g)) read.add(m[1]);
  // A name with a per-account suffix is documented as GMAIL_REFRESH_TOKEN_<ACCOUNT>.
  const undocumented = [...read].filter((v) => !OS_VARS.has(v) && !new RegExp(`(?<![A-Z0-9_])${v}(?![A-Z0-9])`).test(DOCS)).sort();
  expect(undocumented).toEqual([]);
});

test("every PB_ variable and key name the docs name is one the code reads", () => {
  const named = new Set<string>();
  for (const m of DOCS.matchAll(/\b(PB_[A-Z0-9_]+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:API_KEY|AUTH_TOKEN|ACCOUNT_SID|PUSH_KEY|RELAY_KEY))\b/g)) named.add(m[1]);
  expect([...named].filter((v) => !excludedNames.includes(v) && !new RegExp(`\\b${v}\\b`).test(ALL_CODE)).sort()).toEqual([]);
});

test("each name public-exclude.txt says only a left-out file reads is read by one (in the private repo)", () => {
  const files = excludedPaths.filter((p) => !p.endsWith("/") && existsSync(join(ROOT, p)));
  if (!files.length) return; // the public copy: those files are gone
  const left = files.map(text).join("\n");
  expect(excludedNames.filter((v) => !new RegExp(`\\b${v}\\b`).test(left))).toEqual([]);
});

// Version labels: package.json, README's status line and the newest dated CHANGELOG section say
// the same version, and the changelog reads newest first under one [Unreleased].
test("package.json, README's status line and the newest dated changelog section name one version", () => {
  const pkg = JSON.parse(text("package.json")).version;
  const readme = text("README.md").match(/\*\*Status: [^(]*\((\d+\.\d+\.\d+)\b/)?.[1];
  const dated = [...CHANGELOG.matchAll(/^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/gm)];
  expect({ readme, changelog: dated[0]?.[1] }).toEqual({ readme: pkg, changelog: pkg });
});

test("the changelog opens with [Unreleased] and its releases run newest first", () => {
  const heads = [...CHANGELOG.matchAll(/^## \[([^\]]+)\](?: - (.+))?$/gm)].map((m) => ({ v: m[1], date: m[2] ?? "" }));
  expect(heads[0]?.v).toBe("Unreleased");
  expect(heads.filter((h) => h.v === "Unreleased").length).toBe(1);
  const rel = heads.slice(1);
  const key = (v: string) => v.split(".").map((n) => n.padStart(4, "0")).join(".");
  for (let i = 1; i < rel.length; i++) {
    expect(key(rel[i - 1].v) > key(rel[i].v)).toBe(true);
    if (/^\d{4}-/.test(rel[i - 1].date) && /^\d{4}-/.test(rel[i].date)) expect(rel[i - 1].date >= rel[i].date).toBe(true);
  }
});

// The changelog states only true things: a gap id it cites as fixed is named by the code, tests or
// evals that fixed it (closed gaps leave evals/gaps.ts, but their tests and comments keep the id).
test("every gap id the changelog cites is named in src, test, evals or scripts", () => {
  const cited = new Set([...CHANGELOG.matchAll(/\bG(\d{1,4})\b/g)].map((m) => `G${m[1]}`));
  expect([...cited].filter((g) => !new RegExp(`\\b${g}\\b`).test(ALL_CODE)).sort()).toEqual([]);
});

test("CLAUDE.md's map lists each thing once", () => {
  // Two rows that start the same way are one row kept twice (one older than the other).
  const rows = [...text("CLAUDE.md").matchAll(/^\| (.+?) \| `/gm)].map((m) => m[1].slice(0, 40));
  expect(rows.filter((r, i) => rows.indexOf(r) !== i)).toEqual([]);
});

test("every current doc is linked from README, CLAUDE.md or another doc", () => {
  const orphans = md("docs").filter((f) => !PRIVATE.has(f)).filter((f) => {
    const name = f.slice("docs/".length);
    return !CURRENT.filter((g) => g !== f).some((g) => text(g).includes(name));
  });
  expect(orphans).toEqual([]);
});

test("the phone doc's list of Settings pages is the dashboard's SETTINGS list", () => {
  const labels = [...text("src/dashboard/html.ts").match(/const SETTINGS[^\n]*/)![0].matchAll(/\["\/[a-z]*", "([^"]+)"/g)].map((m) => m[1]);
  expect(labels.length).toBeGreaterThan(5);
  const said = text("docs/dashboard-phone.md").match(/links every other page \(([^;)]*)/)?.[1] ?? "";
  // One item per page, in the dashboard's order, each starting with the page's label.
  const items = said.split(",").map((s) => s.trim());
  expect(items.length).toBe(labels.length);
  expect(items.filter((s, i) => !s.startsWith(labels[i]))).toEqual([]);
});

test("docs-live checks the site addresses a reader runs, not ones a sentence mentions", async () => {
  const { runnableSiteUrls, docFiles } = await import("../scripts/docs-live.ts");
  const doc = "Mentioned: `curl https://pocketbrain.dev/install.sh`.\n\n```sh\ncurl -fsSL https://pocketbrain.dev/install.sh | sh\ncurl https://demo.pocketbrain.dev/health\n```\n";
  expect(runnableSiteUrls(doc)).toEqual(["https://pocketbrain.dev/install.sh"]);
  expect(docFiles(ROOT)).toContain("docs/quickstart.md");
  expect(docFiles(ROOT)).not.toContain("docs/video-kit.md");
});

test("CI runs docs-live on main and daily, read-only, with no secrets", () => {
  const wf = text(".github/workflows/docs-live.yml");
  expect(wf).toContain("bun scripts/docs-live.ts");
  expect(wf).toMatch(/branches: \[main\]/);
  expect(wf).toMatch(/schedule:/);
  expect(wf).toMatch(/permissions:\n\s+contents: read/);
  expect(wf).not.toMatch(/secrets\./);
});
