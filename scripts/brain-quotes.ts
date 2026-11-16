// SPDX-License-Identifier: AGPL-3.0-only
// Does this repo quote the owner's real brain? (G938) Every run of 8 words in a brain page's text is
// hashed and kept in memory only; each tracked file of the repo is read the same way, and a line where
// a run of the brain starts is reported by file and line, never by its words. The hub's own sentences
// are dropped first: runs the fictional brains in examples/ share, runs a brain this code makes from
// nothing (init with examples/seed) holds, and runs inside a string literal of src/, today's or any
// commit's, since the code wrote those into the brain (G939). Report-only:
// it exits 0 whatever it finds, writes nothing, and sends nothing anywhere. Run it on the Mac, where
// the brain is (docs/release.md, "The public repo and the site"):
//   bun scripts/brain-quotes.ts --brain ~/pocketbrain-brain
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { join, relative, resolve } from "node:path";

const RUN = 8;
// A number is any number, and numbers in a row (a date, a time) are one (G940): the code fills in
// counts and dates, so "day 3 of 14 since 2026-10-12" and "day 4 of 14 since 2026-10-19" are one
// sentence of the hub's.
const words = (text: string) => {
  const out: string[] = [];
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const num = /^\p{N}+$/u.test(w);
    if (!num) out.push(w);
    else if (out[out.length - 1] !== "0") out.push("0");
  }
  return out;
};
const hash = (ws: string[]) => createHash("sha256").update(ws.join(" ")).digest("hex").slice(0, 20);

export function shingles(text: string): string[] {
  const ws = words(text);
  const out: string[] = [];
  for (let i = 0; i + RUN <= ws.length; i++) out.push(hash(ws.slice(i, i + RUN)));
  return out;
}

// A brain's text: every .md file (pages, and inbox items too), never rules/, log/, views/ (each
// agent's view re-renders the pages, read here already, and rules/), digest/ (the hub's daily report,
// its sentences put together from pages and counts at run time, G940), a dot folder (.git, .cells)
// or a symlink.
function pages(brain: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, top: boolean) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || (top && ["rules", "log", "views", "digest"].includes(e.name))) continue;
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

// A page's text is what it says, not its shape (G940): the body, and each string value of its
// frontmatter on its own, so keys, dates, refs and agent names never join into a run that every
// page shares ("sensitivity personal status active created ..."). Frontmatter that doesn't parse
// is read whole.
// A page's body less the paragraph the hub writes from its facts (G971): the paragraph right above
// the hub's mark, "(Written by the hub from this page's facts.)" (MADE in src/wiki.ts), and the hub's
// own references to it, footnotes labelled p- or pf-. That paragraph is the code's sentences with the
// page's facts filled in, two or more words at a time, and the facts are read from the frontmatter
// already; anything a person wrote on the page, outside it, is still read.
const MADE = "(Written by the hub from this page's facts.)";
function hubless(body: string): string {
  return body.split(/^(?=#{1,6} )/m).map((sec) => {
    const at = sec.indexOf(MADE);
    if (at < 0) return sec;
    // Only the one paragraph right above the mark (pageLead joins its sentences into one); a
    // paragraph a person wrote above it in the same section is still read.
    const before = sec.slice(0, at).trimEnd(), head = /^#{1,6} [^\n]*\n/.exec(before)?.[0].length ?? 0;
    const cut = Math.max(before.lastIndexOf("\n\n"), head);
    return before.slice(0, cut) + "\n\n" + sec.slice(at + MADE.length);
  }).join("").replace(/^\[\^pf?-[^\]\s]+\]:[^\n]*$/gm, "").replace(/\[\^pf?-[^\]\s]+\]/g, " ");
}

export function pageTexts(text: string): string[] {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return [hubless(text)];
  let front: unknown;
  try { front = YAML.parse(m[1]); } catch { return [hubless(text)]; }
  const leaves: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") leaves.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(front);
  return [...leaves, hubless(text.slice(m[0].length))];
}

const runsOf = (brain: string) => new Set(pages(brain).flatMap((p) => pageTexts(readFileSync(p, "utf8")).flatMap(shingles)));

// A text's runs, less the ones the code wrote (G940): a word is the code's when a group of GRAM
// words around it is one of the code's own, and a run with at most one word of its own that isn't
// a number is the code's sentence with a name or a value filled in, never a quote.
function ownRuns(text: string, code: Set<string>): { own: string[]; code: number } {
  const ws = words(text);
  const mine = ws.map(() => true);
  for (let i = 0; i + GRAM <= ws.length; i++) if (code.has(ws.slice(i, i + GRAM).join(" "))) for (let k = i; k < i + GRAM; k++) mine[k] = false;
  const own: string[] = [];
  let made = 0;
  for (let i = 0; i + RUN <= ws.length; i++) {
    let left = 0;
    for (let k = i; k < i + RUN; k++) if (mine[k] && ws[k] !== "0") left++;
    if (left <= 1) made++; else own.push(hash(ws.slice(i, i + RUN)));
  }
  return { own, code: made };
}

// The text of each string literal in a TypeScript source, without comments, code or what a template
// interpolates: a fragment per quoted piece, a template with each ${...} read as one number, and pieces joined only by
// `+` read as one. A scanner, not a parser: a regex literal is told from division by the token before it,
// so one that opens a statement right after a block's } is read as division (a rare miss that only
// changes which runs count as the code's own).
// With `chains`, plain strings that follow one another separated only by commas (a call's
// arguments, an array's items) are also read as one more fragment, joined by spaces: the code
// prints them side by side, as `add("missing-hub", "notes/overview", "pages use…")` or a list of
// report lines, so the words of short literals around them are the code's too (G971).
export function literals(src: string, o: { chains?: boolean } = {}): string[] {
  const out: string[] = [];
  const chains: string[] = [], parts: number[] = [];
  let chainNext = false; // the last string was followed by a comma and another string
  const tplChain = new Map<number, boolean>(); // a template's fragment index: did it follow a comma?
  let pendingChain = false;
  const chainOn = (s: string, cont: boolean) => {
    if (!o.chains) return;
    if (cont && chains.length) { chains[chains.length - 1] += " " + s; parts[parts.length - 1]++; } else { chains.push(s); parts.push(1); }
  };
  const lookComma = () => {
    let j = i; while (j < n && /\s/.test(src[j])) j++;
    if (src[j] !== ",") return false;
    let k = j + 1; while (k < n && /\s/.test(src[k])) k++;
    return src[k] === "'" || src[k] === '"' || src[k] === "`";
  };
  const n = src.length;
  let i = 0;
  let prev = ""; // last significant token: "" (start), "id", "num", or the punctuation itself
  let joinNext = false; // the last fragment ended a plain string and a `+` followed
  // Brace depth at each open ${ of a template, and the fragment it continues: what a template fills
  // in reads as one number, so a count or a date it fills in matches (G940).
  const stack: { depth: number; at: number }[] = [];
  let depth = 0;
  const regexOK = () => !(prev === "id" || prev === "num" || prev === ")" || prev === "]" || prev === "}" || prev === "str");
  const KW = new Set(["return", "typeof", "case", "do", "else", "in", "of", "instanceof", "new", "delete", "void", "throw", "yield", "await"]);
  const push = (s: string, plain: boolean) => {
    if (joinNext && plain && out.length) out[out.length - 1] += s; else out.push(s);
    joinNext = false;
  };
  const esc = (c: string) => (c === "n" || c === "t" || c === "r" ? " " : c);
  // Reads a template from just after its backtick (or a closing } of ${) to its end or next ${.
  const template = (at = -1) => {
    let s = at >= 0 ? out[at] + " 0 " : "";
    const done = () => { if (at >= 0) out[at] = s; else { out.push(s); at = out.length - 1; tplChain.set(at, pendingChain); } };
    while (i < n) {
      const c = src[i];
      if (c === "\\") { s += esc(src[i + 1] ?? ""); i += 2; continue; }
      if (c === "`") { i++; done(); joinNext = false; prev = "str"; chainOn(s, tplChain.get(at) ?? false); chainNext = lookComma(); return; }
      if (c === "$" && src[i + 1] === "{") { i += 2; done(); joinNext = false; stack.push({ depth, at }); depth++; prev = "("; return; }
      s += c; i++;
    }
    done();
  };
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'" || c === '"') {
      let s = ""; i++;
      while (i < n && src[i] !== c && src[i] !== "\n") { if (src[i] === "\\") { s += esc(src[i + 1] ?? ""); i += 2; } else s += src[i++]; }
      i++;
      push(s, true); prev = "str";
      chainOn(s, chainNext);
      chainNext = false;
      // A `+` and another plain string after it read as one sentence.
      let j = i; while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === "+") { let k = j + 1; while (k < n && /\s/.test(src[k])) k++; if (src[k] === "'" || src[k] === '"') { joinNext = true; i = k; } }
      else chainNext = lookComma();
      continue;
    }
    if (c === "`") { i++; pendingChain = chainNext; chainNext = false; template(); continue; }
    if (c === "/" && regexOK()) {
      i++; let cls = false;
      while (i < n && src[i] !== "\n") { const d = src[i]; if (d === "\\") { i += 2; continue; } if (d === "[") cls = true; else if (d === "]") cls = false; else if (d === "/" && !cls) break; i++; }
      i++; while (i < n && /[a-z]/i.test(src[i])) i++;
      prev = "num"; continue;
    }
    if (/[A-Za-z_$]/.test(c)) { let j = i; while (j < n && /[\w$]/.test(src[j])) j++; prev = KW.has(src.slice(i, j)) ? "(" : "id"; i = j; continue; }
    if (/[0-9]/.test(c)) { while (i < n && /[\w.]/.test(src[i])) i++; prev = "num"; continue; }
    if (c === "{") { depth++; prev = "{"; i++; continue; }
    if (c === "}") {
      i++;
      if (stack.length && depth - 1 === stack[stack.length - 1].depth) { depth--; template(stack.pop()!.at); continue; }
      depth--; prev = "}"; continue;
    }
    prev = c; i++;
  }
  return [...out, ...chains.filter((_, k) => parts[k] > 1)].filter((s) => s.trim());
}

// Every run inside a string literal of the code that writes brains: src/'s .ts files as they are now
// and in every commit the checkout holds, since a page keeps a sentence an older hub wrote.
// The code's own word groups: every run of GRAM words inside a string literal of the code that
// writes brains, src/'s .ts files as they are now and in every commit the checkout holds, since a
// page keeps a sentence an older hub wrote. Short groups, so a sentence the code puts together from
// several literals (list items, a joined array, a template's branches) is still seen as the code's.
export const GRAM = 4;
export function codeRuns(repo: string, tracked: string[], history = true): Set<string> {
  const lits = new Set<string>();
  const add = (src: string) => { for (const l of literals(src, { chains: true })) lits.add(l); };
  const isCode = (f: string) => f.startsWith("src/") && f.endsWith(".ts");
  for (const f of tracked) if (isCode(f) && existsSync(join(repo, f))) add(readFileSync(join(repo, f), "utf8"));
  if (!history) return gramsOf([...lits]);
  const objs = Bun.spawnSync(["git", "rev-list", "--objects", "--all", "--", "src"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const ids = objs.exitCode === 0
    ? [...new Set(objs.stdout.toString().split("\n").filter((l) => isCode(l.slice(l.indexOf(" ") + 1)) && l.includes(" ")).map((l) => l.slice(0, l.indexOf(" "))))]
    : [];
  if (ids.length) {
    const cat = Bun.spawnSync(["git", "cat-file", "--batch"], { cwd: repo, stdin: new TextEncoder().encode(ids.join("\n") + "\n"), stdout: "pipe", stderr: "pipe" });
    const buf = cat.stdout;
    let at = 0;
    while (at < buf.length) {
      const nl = buf.indexOf(10, at);
      if (nl < 0) break;
      const [, kind, size] = buf.subarray(at, nl).toString().split(" ");
      at = nl + 1;
      if (kind !== "blob") continue;
      const len = Number(size);
      add(buf.subarray(at, at + len).toString("utf8"));
      at += len + 1;
    }
  }
  return gramsOf([...lits]);
}

const gramsOf = (texts: string[]) => {
  const grams = new Set<string>();
  for (const t of texts) { const ws = words(t); for (let i = 0; i + GRAM <= ws.length; i++) grams.add(ws.slice(i, i + GRAM).join(" ")); }
  return grams;
};

// A brain this checkout's code makes from nothing: init from examples/seed's files, in a temp folder
// with its own home and config, so the owner's own config is never read or changed. The caller
// removes it.
export function freshBrain(repo: string): string {
  const home = mkdtempSync(join(tmpdir(), "pb-bq-fresh-"));
  const seed = (f: string) => join(repo, "examples", "seed", f);
  const from = [["--from-text", "notes.txt"], ["--from-mbox", "mail.mbox"], ["--from-ics", "calendar.ics"], ["--from-contacts", "contacts.vcf"]]
    .filter(([, f]) => existsSync(seed(f))).flatMap(([flag, f]) => [flag, seed(f)]);
  const brain = join(home, "brain");
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, PB_CONFIG_DIR: join(home, "config") };
  delete env.PB_BRAIN;
  const r = Bun.spawnSync(["bun", join(repo, "src", "cli.ts"), "init", brain, "--name", "Sam Example", ...from], { cwd: home, env, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) rmSync(home, { recursive: true, force: true });
  if (r.exitCode !== 0) throw new Error(`init of a fresh brain failed: ${r.stderr.toString().slice(0, 400)}`);
  return brain;
}

export interface Hit { file: string; line: number }

export function brainQuotes(o: { brain: string; repo: string; examples: string[]; history?: boolean }): { hits: Hit[]; files: number; runs: number; code: number } {

  const skip = o.examples.map((e) => resolve(e) + "/");
  const ls = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: o.repo, stdout: "pipe", stderr: "pipe" });
  // Not a checkout: say so, never "0 lines" over files nobody read.
  if (ls.exitCode !== 0) throw new Error(`${o.repo} is not a git checkout: git ls-files failed`);
  const tracked = ls.stdout.toString().split("\0").filter(Boolean);
  // The brain's runs the code wrote: counted, never reported.
  const grams = codeRuns(o.repo, tracked, o.history ?? true);
  const runs = new Set<string>();
  let code = 0;
  for (const p of pages(o.brain)) for (const t of pageTexts(readFileSync(p, "utf8"))) {
    const r = ownRuns(t, grams);
    for (const h of r.own) runs.add(h);
    code += r.code;
  }
  for (const ex of o.examples) for (const h of runsOf(ex)) runs.delete(h);
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
  return { hits, files, runs: runs.size, code };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const at = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const brain = at("--brain");
  if (!brain) { console.error("usage: bun scripts/brain-quotes.ts --brain <path> [--repo <path>] [--json]"); process.exit(2); }
  const repo = at("--repo") ?? join(import.meta.dir, "..");
  // A fresh brain from the code running this script (on the Mac, the same checkout as --repo).
  const fresh = freshBrain(join(import.meta.dir, ".."));
  let r: ReturnType<typeof brainQuotes>;
  try { r = brainQuotes({ brain, repo, examples: [...["brain", "demo-brain"].map((b) => join(repo, "examples", b)).filter(existsSync), fresh] }); }
  finally { rmSync(join(fresh, ".."), { recursive: true, force: true }); }
  // --json: one object for the deploy log (G956), still file:line only.
  if (argv.includes("--json")) { console.log(JSON.stringify({ lines: r.hits.length, files: r.files, code: r.code, hits: r.hits.map((h) => `${h.file}:${h.line}`) })); process.exit(0); }
  for (const h of r.hits) console.log(`${h.file}:${h.line}`);
  console.log(`brain quotes: ${r.hits.length} line(s) in ${r.files} tracked files share an ${RUN}-word run with a page of the brain; ${r.code} runs of the brain's pages are the code's own sentences and not counted (report only; words never printed)`);
}
