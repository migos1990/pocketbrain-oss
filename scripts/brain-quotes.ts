// SPDX-License-Identifier: AGPL-3.0-only
// Does this repo quote the owner's real brain? (G938) Every run of 8 words in a brain page's text is
// hashed and kept in memory only; each tracked file of the repo is read the same way, and a line where
// a run of the brain starts is reported by file and line, never by its words. Runs the fictional
// brains in examples/ share are the hub's own sentence templates and are dropped first. Report-only:
// it exits 0 whatever it finds, writes nothing, and sends nothing anywhere. Run it on the Mac, where
// the brain is (docs/release.md, "The public repo and the site"):
//   bun scripts/brain-quotes.ts --brain ~/pocketbrain-brain
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const RUN = 8;
const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const hash = (ws: string[]) => createHash("sha256").update(ws.join(" ")).digest("hex").slice(0, 20);

export function shingles(text: string): string[] {
  const ws = words(text);
  const out: string[] = [];
  for (let i = 0; i + RUN <= ws.length; i++) out.push(hash(ws.slice(i, i + RUN)));
  return out;
}

// A brain's text: every .md file (pages, and inbox items too), never rules/, log/, a dot folder
// (.git, .cells) or a symlink.
function pages(brain: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, top: boolean) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || (top && (e.name === "rules" || e.name === "log"))) continue;
      const p = join(dir, e.name);
      // A symlink is never followed: it could lead outside the brain, or into a loop.
      if (e.isSymbolicLink() || lstatSync(p).isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p, false);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
    }
  };
  walk(brain, true);
  return out;
}

const runsOf = (brain: string) => new Set(pages(brain).flatMap((p) => shingles(readFileSync(p, "utf8"))));

export interface Hit { file: string; line: number }

export function brainQuotes(o: { brain: string; repo: string; examples: string[] }): { hits: Hit[]; files: number; runs: number } {
  const runs = runsOf(o.brain);
  for (const ex of o.examples) for (const h of runsOf(ex)) runs.delete(h);
  const skip = o.examples.map((e) => resolve(e) + "/");
  const ls = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: o.repo, stdout: "pipe", stderr: "pipe" });
  // Not a checkout: say so, never "0 lines" over files nobody read.
  if (ls.exitCode !== 0) throw new Error(`${o.repo} is not a git checkout: git ls-files failed`);
  const tracked = ls.stdout.toString().split("\0").filter(Boolean);
  const hits: Hit[] = [];
  let files = 0;
  for (const f of tracked) {
    const abs = resolve(o.repo, f);
    if (skip.some((s) => abs.startsWith(s)) || !existsSync(abs) || statSync(abs).size > 2_000_000) continue;
    const buf = readFileSync(abs);
    if (buf.includes(0)) continue; // binary
    files++;
    // Words with the line each starts on, so a run is reported where it starts.
    const ws: { w: string; line: number }[] = [];
    buf.toString("utf8").split("\n").forEach((l, i) => { for (const w of words(l)) ws.push({ w, line: i + 1 }); });
    const lines = new Set<number>();
    for (let i = 0; i + RUN <= ws.length; i++) if (runs.has(hash(ws.slice(i, i + RUN).map((x) => x.w)))) lines.add(ws[i].line);
    for (const line of [...lines].sort((a, b) => a - b)) hits.push({ file: relative(resolve(o.repo), abs), line });
  }
  return { hits, files, runs: runs.size };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const at = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const brain = at("--brain");
  if (!brain) { console.error("usage: bun scripts/brain-quotes.ts --brain <path> [--repo <path>]"); process.exit(2); }
  const repo = at("--repo") ?? join(import.meta.dir, "..");
  const r = brainQuotes({ brain, repo, examples: ["brain", "demo-brain"].map((b) => join(repo, "examples", b)).filter(existsSync) });
  for (const h of r.hits) console.log(`${h.file}:${h.line}`);
  console.log(`brain quotes: ${r.hits.length} line(s) in ${r.files} tracked files share an ${RUN}-word run with a page of the brain (report only; words never printed)`);
}
