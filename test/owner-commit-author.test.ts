// SPDX-License-Identifier: AGPL-3.0-only
// Mac, 2026-10-25: `pocketbrain me name` committed the aliases as the owner but its inbox sweep
// under git's default identity, and deck-counts (now filing-counts) said the owner had no person page (it matched
// the one-word owner.name against a page titled with the full name). Every brain commit names
// who made it; the counts know the owner by the same names the capture pipeline does (G415).
// Re-audit 2026-10-25 (G426): a move the hub's code decides is the hub's commit, not the owner's,
// even when the owner ran the command; the message says the owner asked for it.
import { test, expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { git } from "../src/git";
import { sweepOwnerProposals, releaseHeld } from "../src/capture";
import { setOwnerAliases } from "../src/ownerset";

const withOwner = (owner: string) => {
  const root = makeBrain();
  const p = join(root, "rules", "policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace("owner: { name: Robin }", `owner: ${owner}`));
  git(root, ["commit", "-qam", "owner"]);
  return root;
};
const propose = (root: string, dir: string, name: string, title: string) => {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, name), YAML.stringify({ proposed: "2026-10-07", by: "steward", reason: "capture x: no person called it yet", checks: ["capture"], capture: "inbox/captures/x.md", new_note: "people/…",
    request: { agent: "steward", kind: "fact", title, type: "person", area: "work", attribute: "org", value: "Northwind", as_of: "2026-10-07", sources: ["gmail:f000000000000902"], source_type: "gmail", confidence: "stated" } }));
};
const author = (root: string) => git(root, ["log", "-1", "--format=%an <%ae>"]).trim();

test("me name's inbox sweep is the hub's commit, asked by the owner; the aliases stay the owner's", () => {
  const root = withOwner("{ name: Robin }");
  propose(root, "inbox", "2026-10-07-capture-a.yaml", "Robin Lake, M.Sc.");
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "old"]);
  setOwnerAliases(root, "Robin Lake");
  const owner = author(root);
  expect(owner).not.toMatch(/^hub /);
  expect(sweepOwnerProposals(root).moved).toBe(1);
  expect(git(root, ["log", "-1", "--format=%s"]).trim()).toMatch(/^inbox: 1 proposal/);
  expect(author(root)).toBe("hub <hub@pocketbrain.local>");
  expect(git(root, ["log", "-1", "--format=%B"])).toContain("Asked-by: owner");
});

test("inbox more is the hub's commit, asked by the owner", () => {
  const root = withOwner("{ name: Robin }");
  propose(root, "inbox/held", "2026-10-07-capture-h.yaml", "Ada Fox");
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "held"]);
  setOwnerAliases(root, "Robin Lake");
  const owner = author(root);
  expect(releaseHeld(root, 5)).toBe(1);
  expect(author(root)).not.toBe(owner);
  expect(author(root)).toBe("hub <hub@pocketbrain.local>");
  expect(git(root, ["log", "-1", "--format=%B"])).toContain("Asked-by: owner");
});

// Every commit the hub makes in a brain passes who made it: git's own default is the machine's
// login, which the wiki would read as a hand edit by the owner.
test("no commit in src is left to git's default author", () => {
  const SRC = join(import.meta.dir, "..", "src");
  const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []);
  // The number of top-level arguments of the call that opens at s[i] (just after its "(").
  const argCount = (s: string, i: number) => {
    let depth = 1, n = 1, q = "";
    for (; i < s.length && depth > 0; i++) {
      const c = s[i];
      if (q) { if (c === "\\") i++; else if (c === q) q = ""; continue; }
      if (c === '"' || c === "'" || c === "`") q = c;
      else if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      else if (c === "," && depth === 1) n++;
    }
    return n;
  };
  const bare: string[] = [];
  for (const f of files(SRC)) {
    const s = readFileSync(f, "utf8"), rel = f.slice(SRC.length + 1);
    for (const m of s.matchAll(/(?<!function )\bcommitPaths\(/g)) if (argCount(s, m.index! + m[0].length) < 4) bare.push(`${rel}:${s.slice(0, m.index).split("\n").length}`);
    for (const m of s.matchAll(/\b(git|gitRun)\(root, \["commit"/g)) if (argCount(s, m.index! + m[1].length + 1) < 3) bare.push(`${rel}:${s.slice(0, m.index).split("\n").length}`);
  }
  expect(bare).toEqual([]);
});

test("filing-counts finds the owner's page by their full name, and counts only proposals about them", () => {
  const root = withOwner("{ name: Robin, aliases: [Robin Lake] }");
  writeFileSync(join(root, "people", "robin-lake.md"), `---\nid: people/robin-lake\ntype: person\ntitle: Robin Lake\narea: personal\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: owner\nfacts: {}\n---\n`);
  propose(root, "inbox", "2026-10-07-capture-a.yaml", "Lake, Robin");
  propose(root, "inbox", "2026-10-07-capture-b.yaml", "Robin Fox");
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "old"]);
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "scripts", "filing-counts.ts"), root]);
  const out = r.stdout.toString();
  expect(out).toContain("owner has a person page: 1");
  expect(out).toContain("    about the owner: 1\n");
});

// Slice audit of G426: the hub's own commits carry "hub", so no assistant may take that name.
test("no assistant may be named hub", async () => {
  const { RESERVED_AGENTS, loadRules } = await import("../src/rules");
  expect(RESERVED_AGENTS).toContain("hub");
  const root = makeBrain();
  const p = join(root, "rules", "policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace("agents:\n", "agents:\n  hub: { tier: core, area: work }\n"));
  expect(() => loadRules(root)).toThrow(/hub/);
});
