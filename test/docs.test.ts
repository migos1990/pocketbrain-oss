// SPDX-License-Identifier: AGPL-3.0-only
// Docs ship with the change (project rule 11): stale docs are a bug, so the claims a test can
// check are checked here. Every `pocketbrain <command>` named in README.md, CLAUDE.md or docs/
// must be a real command in `pocketbrain help --all`, every flag after it must be one the CLI
// knows, every repo path in backticks must exist, and every `bun run <script>` must be a script.
import { test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
// Design records written before the code live in docs/history/ and are not promises about today's
// CLI. video-kit.md is the hackathon film's private runbook, left out of the public repo.
const HISTORY = new Set(["video-kit.md"]);
const DOCS = ["README.md", "CLAUDE.md", ...readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md") && !HISTORY.has(f)).map((f) => `docs/${f}`)];
const text = (f: string) => readFileSync(join(ROOT, f), "utf8");
const cli = text("src/cli.ts");
const usage = Bun.spawnSync(["bun", "src/cli.ts", "help", "--all"], { cwd: ROOT }).stdout.toString();
const commands = new Set([...usage.matchAll(/^\s{2}([a-z][a-z-]*)\b/gm)].map((m) => m[1]));
const scripts = Object.keys(JSON.parse(text("package.json")).scripts ?? {});

const code = (s: string) => [...s.matchAll(/```[a-z]*\n([\s\S]*?)```|`([^`\n]+)`/g)].map((m) => m[1] ?? m[2]);

test("help --all lists commands to check against", () => {
  expect(commands.size).toBeGreaterThan(10);
});

for (const f of DOCS) {
  test(`docs are true: ${f}`, () => {
    const problems: string[] = [];
    for (const snip of code(text(f))) {
      for (const line of snip.split("\n")) {
        const m = line.match(/(?:^|\s|\$ )pocketbrain\s+([a-z][a-z-]*)((?:\s+[^#|;&]*)?)/);
        if (m && !["<command>", "help"].includes(m[1])) {
          if (!commands.has(m[1])) problems.push(`unknown command: pocketbrain ${m[1]}`);
          for (const flag of (m[2] ?? "").match(/--[a-z][a-z-]+/g) ?? [])
            if (!cli.includes(`"${flag}"`) && !usage.includes(flag)) problems.push(`unknown flag: pocketbrain ${m[1]} ${flag}`);
        }
        const r = line.match(/\bbun run ([a-z][a-z0-9:-]*)/);
        if (r && !scripts.includes(r[1])) problems.push(`no package.json script: bun run ${r[1]}`);
      }
      for (const p of snip.match(/^(?:src|test|scripts|evals|docs|examples)\/[\w./-]+\.(?:ts|md|sh|json|yaml)$/gm) ?? [])
        if (!existsSync(join(ROOT, p))) problems.push(`missing file: ${p}`);
    }
    expect(problems).toEqual([]);
  });
}

test("every src/*.ts file is in CLAUDE.md's map", () => {
  const map = text("CLAUDE.md");
  const missing = readdirSync(join(ROOT, "src")).filter((f) => f.endsWith(".ts") && !map.includes(`src/${f}`) && !map.includes(`\`${f}\``));
  expect(missing).toEqual([]);
});

test("design records live in docs/history, each marked as history", () => {
  const records = readdirSync(join(ROOT, "docs", "history")).filter((f) => f.endsWith(".md"));
  expect(records.length).toBeGreaterThanOrEqual(10);
  expect(records.filter((f) => !text(`docs/history/${f}`).includes("Design record from 2026-10-08, kept for history"))).toEqual([]);
  expect(records.filter((f) => existsSync(join(ROOT, "docs", f)))).toEqual([]);
});

test("every relative link in README.md, CLAUDE.md, CHANGELOG.md and docs/ resolves", () => {
  const broken: string[] = [];
  for (const f of [...DOCS, "CHANGELOG.md"])
    for (const m of text(f).matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g))
      if (!/^[a-z]+:/.test(m[1]) && !existsSync(join(ROOT, f, "..", m[1]))) broken.push(`${f} -> ${m[1]}`);
  expect(broken).toEqual([]);
});

// Claims the stranger rehearsals (2026-10-09, 2026-10-15) found saying more than the code does.
// Each pattern is a sentence shape that was in the docs and was false on a default install.
const OVERCLAIMS: [RegExp, string][] = [
  [/messages between assistants go through the same checks/i, "only mail sent through the relay is checked, and the relay is off by default"],
  [/rechecks facts against their sources/i, "nightly upkeep rechecks only against a source you connected (sources pull or upkeep --live)"],
  [/the hub and the tunnel start at login/i, "start --launchd --write only writes the plists; each still needs launchctl bootstrap"],
  [/agents fall back to their dated snapshot/i, "nothing switches to a snapshot by itself; the owner pastes one into the agent"],
  [/in CI and in the git pre-push hook/i, "the pre-push hook runs one plain bun test and the evals, not the cells run or the demo"],
  [/waits up to 90 seconds/i, "the health wait can run to about three minutes (scripts/deploy.ts healthy)"],
  [/every message from one agent to another goes through the relay/i, "only messages that reach the relay are checked; it is off by default and agents can talk elsewhere"],
  [/the inboxes block each other/i, "the block lists are only printed (relay --block-plan); the owner applies them"],
  [/^- Days are 1 to 180 per step/im, "only the share CLI caps days; a hand-edited date is honoured, so it isn't an always-holds limit"],
  [/It proves that any miss in the paid run/i, "the scripted case shows reachability, not that every miss is behaviour"],
  [/^- Audio over `max_bytes` is refused/im, "only the drop folder checks max_bytes; capture --voice doesn't"],
  [/point credentials-file at the file create wrote\s*$/im, "tunnel-config prints brain.example.com unless rules/hub.yaml has public_url: the hostname needs setting too"],
];

for (const f of ["README.md", "docs/quickstart.md", "IDEA.md", "docs/hub.md", "docs/release.md", "docs/relay.md", "docs/share.md", "docs/switch-day.md", "docs/capture.md"]) {
  test(`no known overclaims: ${f}`, () => {
    const t = text(f);
    expect(OVERCLAIMS.filter(([re]) => re.test(t)).map(([, why]) => why)).toEqual([]);
  });
}

// The other direction (backlog 107): every command the CLI has and every door tool an agent gets
// is named somewhere a reader looks, so a new one can't ship undocumented.
const current = DOCS.map(text).join("\n");
test("every CLI command is named as `pocketbrain <command>` in README, CLAUDE.md or a current doc", () => {
  const missing = [...commands].filter((c) => c !== "help" && !new RegExp(`pocketbrain ${c}\\b`).test(current));
  expect(missing).toEqual([]);
});
test("every MCP door tool is named in README, CLAUDE.md or a current doc", () => {
  const tools = [...text("src/server.ts").matchAll(/^\s+name: "([a-z_]+)",$/gm)].map((m) => m[1]);
  expect(tools.length).toBeGreaterThan(10);
  expect(tools.filter((t) => !new RegExp(`\\b${t}\\b`).test(current))).toEqual([]);
});

// Public docs speak to any owner, not to this project's own people and plans (stranger rehearsal
// 2026-10-15): no owner's name, no pointers into private planning files, and dashboard tabs by the
// names the dashboard shows. CLAUDE.md and docs/release.md are the contributors' guides (who merges,
// who sets the ruleset) and keep their project context.
const PUBLIC = [...DOCS.filter((f) => f !== "CLAUDE.md" && f !== "docs/release.md"), ...readdirSync(join(ROOT, "docs", "spec")).filter((f) => f.endsWith(".md")).map((f) => `docs/spec/${f}`)];
const prose = (s: string) => s.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]+`/g, "");
const INTERNAL: [RegExp, string][] = [
  [/\bLouis\b/, "names one owner; say \"the owner\" or \"you\""],
  [/\bbig[- ]bets?\b/i, "points into private planning (big bets)"],
  [/challenges-2/i, "points into private planning (challenges-2.md)"],
  [/\bbacklog (item )?#?\d+/i, "points into the private backlog"],
];
const TABS = [...text("src/dashboard/html.ts").matchAll(/\["\/[a-z]*", "[a-z]+", "([^"]+)"\]/g)].map((m) => m[1]);

test("the dashboard's tab names are found", () => {
  expect(TABS).toContain("Assistants");
});

for (const f of PUBLIC) {
  test(`speaks to any owner: ${f}`, () => {
    const t = prose(text(f));
    const problems = INTERNAL.filter(([re]) => re.test(t)).map(([re, why]) => `${t.match(re)![0]}: ${why}`);
    for (const m of t.matchAll(/dashboard's \*{0,2}([A-Z][A-Za-z ]+?)\*{0,2} (page|tab)\b/g)) if (!TABS.includes(m[1])) problems.push(`"${m[0]}": the dashboard has no ${m[1]} tab (tabs: ${TABS.join(", ")})`);
    expect(problems).toEqual([]);
  });
}
test("src/cli.ts is committed executable, so `bun link` leaves a fresh clone clean (stranger rehearsal 2)", () => {
  const mode = Bun.spawnSync(["git", "ls-files", "-s", "src/cli.ts"], { cwd: ROOT }).stdout.toString().split(" ")[0];
  expect(mode).toBe("100755");
});
