// SPDX-License-Identifier: AGPL-3.0-only
// pocketbrain support bundle (backlog 297): one text file a pilot user can send for help without
// anyone reading their brain. Versions, doctor (offline), job health, the shape of rules/ (keys
// and value types, never values) and the last lines of the hub and tunnel logs. Every line goes
// through one scrubber: secret shapes, login keys, long opaque strings, mail and IP addresses,
// phone numbers, outside hostnames, the home folder, and any title, alias, id, fact value, body
// line or rules value from the brain. The finished text is checked again and not written at all
// if a secret shape or a brain value is still in it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, release } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { loadBrain } from "./brain";
import { findSecret, redactSecrets } from "./checks";
import { doctor } from "./doctor";
import { brainFormat } from "./format";
import { loadRules } from "./rules";
import { jobChecks } from "./probe";
import { START_LABEL, TUNNEL_LABEL } from "./menubar";

const HUB_LINES = 200, TUNNEL_LINES = 50;
const FILE_EXT = /\.(?:ts|js|json|jsonl|yaml|yml|md|log|plist|age|txt|sh|swift|pub|lock)$/i;
const LOCAL = /^(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)$/;
const NOT_VALUE = new Set(["sources", "verification", "by", "recorded", "as_of", "as_of_approx", "confidence", "status"]);

// Strings from the brain and rules/ that must not appear: titles, aliases, ids and their last
// part, fact values (current and past), body lines, rules values. Short common words are left
// out so the rest of a line still reads, and so are agent ids.
function brainTerms(root: string): string[] {
  const terms = new Set<string>();
  const add = (v: unknown) => {
    const s = String(v ?? "").trim();
    if (s.length >= 5 || (s.length >= 4 && /\d/.test(s))) terms.add(s);
  };
  const leaves = (v: unknown, key = ""): void => {
    if (NOT_VALUE.has(key)) return;
    if (Array.isArray(v)) v.forEach((x) => leaves(x));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) leaves(x, k);
    else if (typeof v === "string" || typeof v === "number") add(v);
  };
  for (const n of loadBrain(root)) {
    add(n.fm.title); (n.fm.aliases ?? []).forEach(add); add(n.fm.id);
    const id = String(n.fm.id ?? n.path.replace(/\.md$/, ""));
    add(id); add(id.split("/").pop()); add(n.path.replace(/\.md$/, ""));
    leaves(n.fm.facts); leaves(n.fm.history);
    for (const l of n.body.split("\n")) if (l.trim().length >= 12) add(l.trim());
  }
  const rules = join(root, "rules");
  if (existsSync(rules)) for (const f of readdirSync(rules).filter((x) => /\.ya?ml$/.test(x))) {
    try { leaves(YAML.parse(readFileSync(join(rules, f), "utf8"))); } catch { /* shape() says it doesn't parse */ }
  }
  // Agent ids stay: support needs to know which assistant a line is about, and they're the
  // owner's labels for programs, not content (a display label is still a value and goes).
  try { for (const a of Object.keys(loadRules(root).policy.agents)) terms.delete(a); } catch { /* rules don't load */ }
  return [...terms].sort((a, b) => b.length - a.length);
}

// A term only as a whole word, and never inside the scrubber's own [markers].
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function makeScrub(root: string, home: string): (s: string) => string {
  const terms = brainTerms(root);
  const brainRe = terms.length ? new RegExp(terms.map((t) => `(?<![[A-Za-z0-9_])${escapeRe(t)}(?![\\]A-Za-z0-9_])`).join("|"), "gi") : undefined;
  return (s: string) => {
    let t = redactSecrets(s).text;
    t = t.replace(/([?&#;](?:key|token|code|secret|k|sig|signature)=)[^&\s"']+/gi, "$1[removed]");
    t = t.split(home).join("~").replace(/\/(?:Users|home)\/[^/\s"']+/g, "~");
    t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
    t = t.replace(/(https?:\/\/)([^/\s:"'?#]+)/gi, (m, p, h) => (LOCAL.test(h) ? m : `${p}[host]`));
    t = t.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (m) => (LOCAL.test(m) ? m : "[ip]"));
    t = t.replace(/(?:\+\d{1,3}[ .-]?)?\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g, "[phone]");
    t = t.replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, (m) => (FILE_EXT.test(m) || LOCAL.test(m) || /^\d/.test(m) ? m : "[host]"));
    t = t.replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g, "[removed: long id]");
    if (brainRe) t = t.replace(brainRe, "[brain]");
    return t;
  };
}

// The keys of a rules file, each value replaced by its type; lists by their length and their
// first item's shape.
function shape(v: unknown, scrub: (s: string) => string, depth = 0): string[] {
  const pad = "  ".repeat(depth + 1);
  if (Array.isArray(v)) return v.length && v[0] && typeof v[0] === "object" && depth < 4 ? [`${pad}- (${v.length} items, first:)`, ...shape(v[0], scrub, depth + 1)] : [];
  if (!v || typeof v !== "object" || depth > 4) return [];
  const out: string[] = [];
  for (const [k, x] of Object.entries(v)) {
    const kind = Array.isArray(x) ? `[${x.length} item${x.length === 1 ? "" : "s"}]` : x && typeof x === "object" ? "" : typeof x === "number" ? "<number>" : typeof x === "boolean" ? "<yes/no>" : x === null ? "<empty>" : "<text>";
    out.push(`${pad}${scrub(k)}:${kind ? ` ${kind}` : ""}`, ...shape(x, scrub, depth + 1));
  }
  return out;
}

function lastLines(file: string, n: number): string[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-n);
}

function appVersion(): string {
  const app = join(import.meta.dir, "..");
  const v = JSON.parse(readFileSync(join(app, "package.json"), "utf8")).version;
  const sha = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: app }).stdout.toString().trim();
  return `pocketBrain ${v}${sha ? ` (${sha})` : ""}`;
}

export class SupportError extends Error {}

export async function supportBundle(root: string, o: { home?: string; now?: Date; extra?: string[] } = {}): Promise<string> {
  const home = o.home ?? homedir(), now = o.now ?? new Date();
  const scrub = makeScrub(root, home);
  const out: string[] = [
    `pocketBrain support bundle, made ${now.toISOString()}`,
    "No note content is in this file: secrets, addresses and anything from the brain are replaced by [brackets]. Read it before you send it.",
    "",
    "## Versions",
  ];
  let format = "unreadable";
  try { format = String(brainFormat(root)); } catch (e) { format = `unreadable (${(e as Error).message})`; }
  let counts = "";
  try { const r = loadRules(root); counts = `, ${loadBrain(root).length} notes, ${Object.keys(r.policy.agents).length} agents`; } catch { counts = ", rules don't load"; }
  out.push(`  ${appVersion()}`, `  bun ${Bun.version}, ${process.platform} ${release()}`, `  brain format ${format}${counts}`, "", "## Doctor (offline)");
  for (const f of await doctor(root, { offline: true })) out.push(`  ${f.level.padEnd(4)}  ${f.area}: ${scrub(f.text)}`);
  out.push("", "## Jobs");
  const jobs = jobChecks(root, now);
  if (!jobs.length) out.push("  no job has run yet");
  for (const j of jobs) out.push(`  ${j.name}: ${j.ok ? "ok" : "failed"}: ${scrub(j.detail)}`);
  out.push("", "## Rules shape (keys only)");
  const rules = join(root, "rules");
  for (const f of existsSync(rules) ? readdirSync(rules).filter((x) => /\.ya?ml$/.test(x)).sort() : []) {
    out.push(`  ${f}`);
    try { out.push(...shape(YAML.parse(readFileSync(join(rules, f), "utf8")), scrub, 1)); } catch { out.push("    doesn't parse"); }
  }
  const logs = join(home, "Library", "Logs");
  out.push("", `## Hub log (last ${HUB_LINES} lines, scrubbed)`, ...lastLines(join(logs, `${START_LABEL}.log`), HUB_LINES).map((l) => `  ${scrub(l)}`));
  out.push("", `## Tunnel log (last ${TUNNEL_LINES} lines, scrubbed)`, ...lastLines(join(logs, `${TUNNEL_LABEL}.log`), TUNNEL_LINES).map((l) => `  ${scrub(l)}`));
  // Test seam: lines that skip the scrubber, to prove the final check refuses them.
  if (o.extra) out.push(...o.extra);
  const text = out.join("\n") + "\n";
  // Fail closed: a secret shape, or a brain value, still in the text means nothing is written.
  const left = findSecret(text.replace(/\[removed[^\]]*\]/g, ""));
  if (left) throw new SupportError(`support bundle not written: it would still hold ${left}`);
  const again = scrub(text);
  if (again !== text) throw new SupportError("support bundle not written: a line still held something the scrubber removes");
  return text;
}
