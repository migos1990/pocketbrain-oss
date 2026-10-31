// SPDX-License-Identifier: AGPL-3.0-only
// The docs' live half (docs/release.md, Docs): every https://pocketbrain.dev address that README,
// CONTRIBUTING.md or a current doc tells you to run (inside a ```sh block) must answer 2xx.
// test/docs-truth.test.ts checks everything that needs no network; this needs it, so it is a
// script: `bun scripts/docs-live.ts` prints one line per address and exits 1 on any that fails.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PRIVATE = new Set(["video-kit.md"]); // the film's private runbook, not in the public repo

export function docFiles(root = ROOT): string[] {
  return ["README.md", "CONTRIBUTING.md", ...readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md") && !PRIVATE.has(f)).map((f) => `docs/${f}`)];
}

// The site addresses in a doc's fenced blocks: what a reader pastes, not what a sentence mentions.
export function runnableSiteUrls(markdown: string): string[] {
  const out = new Set<string>();
  for (const block of markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g))
    for (const m of block[1].matchAll(/https:\/\/(?:[a-z0-9-]+\.)?pocketbrain\.dev(?:\/[^\s"'`)|<>]*)?/g)) {
      // demo.pocketbrain.dev is the film's demo hub, up only while filming.
      if (!m[0].startsWith("https://demo.")) out.add(m[0]);
    }
  return [...out];
}

async function main(): Promise<number> {
  const where = new Map<string, string[]>();
  for (const f of docFiles())
    for (const u of runnableSiteUrls(readFileSync(join(ROOT, f), "utf8"))) where.set(u, [...(where.get(u) ?? []), f]);
  let bad = 0;
  for (const [u, files] of where) {
    let status = "no answer";
    try {
      const r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
      status = String(r.status);
      if (r.ok) { console.log(`ok   ${u}`); continue; }
    } catch (e) { status = (e as Error).message; }
    bad++;
    console.log(`FAIL ${u} (${status}), named in ${files.join(", ")}`);
  }
  console.log(bad ? `${bad} of ${where.size} addresses fail` : `all ${where.size} addresses answer`);
  return bad ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
