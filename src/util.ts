// SPDX-License-Identifier: AGPL-3.0-only
// Small helpers every module used to carry its own copy of: hashing, regex escaping, whole-word
// matching, and the append-only JSON-lines logs under log/.
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, ftruncateSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { requestId } from "./reqid";
import { redactSecrets, hardSecretIn } from "./checks";

export const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// `word` as a whole word in `text`, case-insensitive. `edge` is the class of characters that
// may not touch it on either side (letters by default; the relay also counts digits).
export function hasWord(text: string, word: string, edge = "\\p{L}"): boolean {
  return new RegExp(`(^|[^${edge}])${escapeRe(word)}($|[^${edge}])`, "iu").test(text);
}

// Many whole words against many texts (a carve holds thousands of carved values). Each word's
// pattern is compiled once, and a word is tried on a text only if the text has a token equal to
// the word's first token: one pass over the text's tokens instead of one pattern per word
// (docs/perf.md). Words whose first token isn't plain ASCII, or that start with a separator, are
// always tried, so the matches are exactly those of the patterns.
const foldToken = (s: string) => s.replace(/\u017F/g, "s").replace(/\u212A/g, "k").toLowerCase(); // the two non-ASCII letters /iu folds to ASCII
// A word's key: its first two tokens when both are plain ASCII (adjacent tokens in the text),
// else the first; common first words ("the", a first name) would otherwise match most texts.
// Undefined when the word must always be tried.
export function tokenKey(w: string): string | undefined {
  const two = w.match(/^([A-Za-z0-9]+)[^\p{L}\p{N}]+([A-Za-z0-9]+)(?=[^\p{L}\p{N}]|$)/u);
  if (two) return `${two[1].toLowerCase()} ${two[2].toLowerCase()}`;
  const one = w.match(/^[A-Za-z0-9]+(?=[^\p{L}\p{N}]|$)/u);
  return one ? one[0].toLowerCase() : undefined;
}
// The keys a text offers: every token and every pair of adjacent tokens.
export function textKeys(text: string, into = new Set<string>()): Set<string> {
  const toks = foldToken(text).split(/[^\p{L}\p{N}]+/u);
  for (let k = 0; k < toks.length; k++) { into.add(toks[k]); if (k + 1 < toks.length) into.add(`${toks[k]} ${toks[k + 1]}`); }
  return into;
}
export function tokenIndex(words: string[]): (text: string) => number[] {
  const by = new Map<string, number[]>(), always: number[] = [];
  words.forEach((w, i) => {
    const k = tokenKey(w);
    if (k === undefined) always.push(i); else (by.get(k) ?? by.set(k, []).get(k)!).push(i);
  });
  return (text) => {
    const c = new Set(always);
    const toks = foldToken(text).split(/[^\p{L}\p{N}]+/u);
    for (let k = 0; k < toks.length; k++) {
      for (const i of by.get(toks[k]) ?? []) c.add(i);
      if (k + 1 < toks.length) for (const i of by.get(`${toks[k]} ${toks[k + 1]}`) ?? []) c.add(i);
    }
    return [...c].sort((a, b) => a - b);
  };
}

// Whole words (letters and digits on neither side) found in a text, in the order given. Same
// matches as hasWord(text, word, "\\p{L}\\p{N}") for each word.
export function wordSet(words: string[]) {
  const edge = "\\p{L}\\p{N}";
  const each = words.map((w) => new RegExp(`(^|[^${edge}])${escapeRe(w)}($|[^${edge}])`, "iu"));
  const candidates = tokenIndex(words);
  return { found: (text: string) => candidates(text).filter((i) => each[i].test(text)).map((i) => words[i]) };
}

// One JSON object per line. A torn line (a crash mid-append) is skipped, not fatal.
export function readJsonl<T = Record<string, unknown>>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* torn line */ }
  }
  return out;
}

// The last `bytes` of a file (all of it when smaller), without reading the rest.
export function tailOf(file: string, bytes = 65_536): { text: string; whole: boolean } {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size, n = Math.min(size, bytes);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    return { text: buf.toString("utf8"), whole: n === size };
  } finally { closeSync(fd); }
}

// A line a crash cut short (the process died mid-append, so it was never acknowledged) is cut
// off before the next append; otherwise the next entry would be glued onto it and lost too.
export function endTornLine(file: string): boolean {
  if (!existsSync(file)) return false;
  const fd = openSync(file, "r+");
  try {
    const size = fstatSync(fd).size;
    if (!size) return false;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    if (last[0] === 0x0a) return false;
    // Walk back to the last newline; the torn line is everything after it.
    const chunk = 65_536;
    for (let end = size; end > 0; end -= chunk) {
      const start = Math.max(0, end - chunk), buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      const nl = buf.lastIndexOf(0x0a);
      if (nl >= 0) { ftruncateSync(fd, start + nl + 1); return true; }
    }
    ftruncateSync(fd, 0);
    return true;
  } finally { closeSync(fd); }
}

export function appendJsonl(file: string, entry: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  endTornLine(file);
  appendFileSync(file, JSON.stringify(withRequestId(entry)) + "\n");
}

// A log line written inside a hub request names it (src/reqid.ts), for `pocketbrain trace`.
export function withRequestId<T>(entry: T): T {
  const id = requestId();
  if (!id || !entry || typeof entry !== "object" || Array.isArray(entry) || "request_id" in entry) return entry;
  return { ...entry, request_id: id };
}

// A source call that never answers must not hold up the hub: pulls run in the same queue as
// agent writes. Gives up after PB_HTTP_TIMEOUT_MS (default 20 s), whatever `http` is.
export async function timed(http: (url: string, init?: RequestInit) => Promise<Response>, url: string, init: RequestInit = {}): Promise<Response> {
  const ms = Number(process.env.PB_HTTP_TIMEOUT_MS ?? 20_000);
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(new Error(`no answer from ${new URL(url).host} in ${ms / 1000}s`)); }, ms); });
  try { return await Promise.race([http(url, { ...init, signal: ac.signal }), late]); }
  finally { clearTimeout(timer); }
}

// log/alerts.jsonl: what the digest, dashboard and text channel surface as "needs you".
// log/ is committed, and the backup refuses a plaintext secret on main (G201), so every string an
// alert carries is redacted here, whoever wrote it (G280: a reason quoting the sender's text). If
// the whole line still holds a hard secret (a key split across two fields), every field but the
// check's name, the agent, and from/to when they are agent names (so a blanked relay or handoff
// alert still says who, G314) is blanked; keys are redacted too, at any depth. If even that line
// held one, only the check and agent are kept. Every writer of log/alerts.jsonl goes through here
// (G312; test/cli-token-audit3.test.ts greps src/ for any other).
const ALERT_REMOVED = "[removed: secret-shaped]";
const AGENT_NAME = /^[a-z][a-z0-9-]{1,30}$/;
const keepAsIs = (k: string, v: unknown) => typeof v === "string" && !hardSecretIn(v) && (k === "check" || k === "agent" || ((k === "from" || k === "to") && AGENT_NAME.test(v)));
function scrubDeep(v: unknown, blank: boolean): unknown {
  if (typeof v === "string") return blank ? ALERT_REMOVED : redactSecrets(v).text;
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, blank));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x], i) => [blank ? `k${i}` : redactSecrets(k).text, scrubDeep(x, blank)]));
  return v;
}
const strings = (v: unknown): string[] => typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...strings(x)]) : [];
const holdsHard = (e: Record<string, unknown>) => !!(hardSecretIn(JSON.stringify(e)) || hardSecretIn(strings(e).join("\n")));
export function alert(root: string, entry: Record<string, unknown>) {
  const clean = (blank: boolean) => Object.fromEntries(Object.entries(entry).map(([k, v]) => [redactSecrets(k).text, keepAsIs(k, v) ? v : scrubDeep(v, blank)]));
  let e = clean(false);
  if (holdsHard(e)) e = clean(true);
  if (holdsHard(e)) e = Object.fromEntries(Object.entries(entry).filter(([k, v]) => (k === "check" || k === "agent") && keepAsIs(k, v)).concat([["detail", ALERT_REMOVED]]));
  appendJsonl(join(root, "log", "alerts.jsonl"), { at: new Date().toISOString(), ...e });
}

// A request body as text, read as it streams and stopped at `max` bytes: undefined when it is
// longer. A declared length over the cap is refused before reading; a chunked body is counted.
export async function readCapped(req: Request, max: number): Promise<string | undefined> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return undefined;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel().catch(() => undefined); return undefined; }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

// The code sha this checkout is at (git rev-parse HEAD of the app folder), "" outside git.
export function codeVersion(dir = join(import.meta.dir, "..")): string {
  const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
}
// The code sha this process started on: taken once, when the hub starts serving (serve() in
// server.ts), so a checkout made after the start (a deploy that hasn't restarted yet) never changes
// it. /health answers it and scripts/deploy.ts go compares it with the sha it was asked for.
let startedOn: string | undefined;
export const codeAtStart = (): string => (startedOn ??= codeVersion());

// "2026-10-05" as the page writer says it in a sentence (src/wiki.ts): "5 Oct", and "5 Oct 2026"
// for another year. Every form a date inside a value may take in prose, so whatever scrubs a
// hidden value from text scrubs these too (slice audit of the audit v9 stack, G589).
export const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function dateWordForms(v: string): string[] {
  const out: string[] = [];
  for (const m of v.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const mo = +m[2]!;
    if (mo < 1 || mo > 12) continue;
    const said = `${+m[3]!} ${MONTHS_SHORT[mo - 1]}`;
    out.push(v.replace(m[0], said), v.replace(m[0], `${said} ${m[1]}`), said, `${said} ${m[1]}`);
  }
  return [...new Set(out)];
}

