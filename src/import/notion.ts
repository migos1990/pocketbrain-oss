// SPDX-License-Identifier: AGPL-3.0-only
// Notion import (bootstrap.md section 2, steps 3 to 8): raw JSON snapshot -> one Markdown
// file per row in the memory-shape format, plus import/REPORT.md listing everything that
// didn't fit. Deterministic: same snapshot in, byte-identical files out.
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { Note, FactRecord, Frontmatter, SourceRef, Sensitivity, Verification, Fact } from "../brain";
import { saveNote, slugify, loadBrain } from "../brain";
import { extractRefs, schemeOf, AGENT_MEMORY_SCHEMES, refString } from "../sources";
import { redactSecrets } from "../checks";
import { compareKey } from "../normalize";

type Row = Record<string, string | number | undefined>;

interface Ctx {
  root: string;
  rawDir: string;
  notes: Note[];
  byLegacy: Map<string, Note>; // notion page id -> note
  report: Record<string, string[]>;
  importDate: string;
}

const AGENTS: Record<string, string> = { instinct: "instinct", vamprose: "town", "vamprose / town": "town", town: "town", muse: "muse", claude: "claude" };
// Which area a row belongs to is personal, so it lives in the brain's rules/import.yaml, not here:
//   areas: { <Notion Entity value>: <area key> }
//   area_hints: { <area key>: [<regex>, ...] }   # matched against titles, first area wins
//   finance_words: [<regex>, ...]                 # extra words that mark a contact as money-related
interface ImportHints { areas: Record<string, string>; hints: [string, RegExp][]; finance: RegExp }
let HINTS: ImportHints = loadImportHints();
function loadImportHints(root?: string): ImportHints {
  const p = root ? join(root, "rules", "import.yaml") : "";
  const y = (p && existsSync(p) ? YAML.parse(readFileSync(p, "utf8")) : {}) ?? {};
  const areas: Record<string, string> = { personal: "personal", ...(y.areas ?? {}) };
  const hints = Object.entries((y.area_hints ?? {}) as Record<string, string[]>).map(([a, res]) => [a, new RegExp(res.join("|"), "i")] as [string, RegExp]);
  const words = ["bank", "banque", "tfsa", "celi", "rrsp", "reer", "portfolio", "financial", "advisor", "conseill", "mortgage", "hypoth", "compensation", "rsu", ...(y.finance_words ?? [])];
  return { areas, hints, finance: new RegExp(`\\b(${words.join("|")})\\b`, "i") };
}
const VERIF: Record<string, Verification> = {
  "confirmed by louis": "confirmed-by-owner", "confirmed by owner": "confirmed-by-owner", "verified by source": "verified-by-source",
  "self-reported": "self-reported", unverified: "unverified",
};

function s(r: Row, k: string): string {
  const v = r[k];
  return v === undefined || v === null ? "" : String(v).trim();
}
function pageId(r: Row): string {
  return s(r, "url").slice(-32);
}
function flag(ctx: Ctx, section: string, line: string) {
  (ctx.report[section] ??= []).push(line);
}

// Notion markup -> plain Markdown. Mentions resolve to [[ids]] in a second pass.
export function cleanText(t: string): string {
  return t
    .replace(/<br\s*\/?>/g, "\n")
    // Notion auto-links calendar ids as if they were domains: [evt1.bG](http://evt1.bG)91aX…
    .replace(/\[(evt1\.[^\]\s]+)\]\(https?:\/\/[^)\s]+\)/g, "$1")
    .replace(/([.)\]])n(- |#)/g, "$1\n$2") // Notion rows where newlines were lost as a literal n
    .replace(/^n(#{1,6} |- )/gm, "$1")
    .replace(/\\([|$~*_#\[\]()>-])/g, "$1")
    .replace(/<mention-date start="([^"]+)"[^>]*\/>/g, "$1")
    .replace(/<mention-user[^>]*>([^<]*)<\/mention-user>/g, "$1")
    .replace(/<\/?(span|u|b|i|strong|em)[^>]*>/g, "")
    .replace(/&amp;/g, "&");
}

const FINGERPRINT = /^\s*(Instinct|Vamprose|Town|Muse|Claude)\s*\|{1,2}\s*(created|modified)[^\n]*\|{1,2}\s*\d{4}-\d{2}-\d{2}[^\n]*$/gim;
const SOURCE_LINE = /^\s*Source type:[^\n]*$/gim;

function cleanBody(raw: string): string {
  let b = cleanText(raw).replace(FINGERPRINT, "").replace(SOURCE_LINE, "");
  b = b.replace(/\n{3,}/g, "\n\n").trim();
  return b ? b + "\n" : "";
}

function fingerprintInfo(fp: string) {
  const lines = cleanText(fp).split(/\n/).map((l) => l.trim()).filter(Boolean);
  const dates = lines.map((l) => l.match(/(\d{4}-\d{2}-\d{2})/)?.[1]).filter(Boolean) as string[];
  const first = lines[0]?.split("|")[0].trim().toLowerCase();
  return { created: dates[0], updated: dates.sort().at(-1), by: AGENTS[first ?? ""], corrupted: /(^|\s)n[A-Z-]/.test(fp) };
}

// Sources for a row: exact refs from Source, lineage and body; else one honest vague ref.
function rowSources(ctx: Ctx, r: Row, body: string, title: string): { refs: SourceRef[]; laundering: boolean } {
  const srcText = cleanText(`${s(r, "Source")}\n${s(r, "Original source lineage")}`);
  const refs = extractRefs(srcText);
  const type = s(r, "Source type").toLowerCase();
  const date = s(r, "date:Date:start");
  if (!refs.length) {
    if (/wiki/i.test(srcText)) refs.push("town-wiki:knowledge");
    else if (/routine/i.test(srcText)) refs.push(`town-routine:${slugify(title)}`);
    else if (type.includes("text received from louis") || /imessage|louis's messages/i.test(srcText)) {
      const range = srcText.match(/(\d{4}-\d{2}-\d{2})\s*(?:to|and|-|\.\.)\s*(\d{4}-\d{2}-\d{2})/);
      refs.push(range ? `imsg:${range[1]}..${range[2]}` : `imsg:${srcText.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? (date || "unknown")}`);
    } else if (type.includes("own description")) refs.push(`agent:${AGENTS[s(r, "Author agent").toLowerCase()] ?? "unknown"}`);
    else if (type.includes("call")) refs.push(`call:${date || "undated"}/${slugify(title)}`);
    else if (type.includes("document") || type.includes("image")) refs.push(`doc:${slugify(srcText.slice(0, 60)) || "unnamed"}`);
    else refs.push("unverified");
  }
  const schemes = refs.map((x) => schemeOf(refString(x)) ?? "");
  const laundering = type.includes("text received from louis") && schemes.every((x) => AGENT_MEMORY_SCHEMES.has(x));
  return { refs, laundering };
}

function asOfFor(r: Row): { as_of: string; approx: boolean } {
  const src = cleanText(`${s(r, "Source")}`);
  const d = src.match(/\b(20\d{2}-\d{2}-\d{2})\b/g);
  if (d?.length === 1) return { as_of: d[0], approx: false };
  const date = s(r, "date:Date:start") || s(r, "date:Valid from:start");
  return { as_of: date || "2026-10-04", approx: true };
}

function verificationOf(r: Row): { verification: Verification; confidence?: "inferred" } {
  const v = VERIF[s(r, "Verification").toLowerCase()] ?? "unverified";
  const c = s(r, "Confidence").toLowerCase();
  if (c === "unverified") return { verification: "unverified" };
  return { verification: v, ...(c === "inferred" ? { confidence: "inferred" as const } : {}) };
}

function record(ctx: Ctx, value: unknown, base: Omit<FactRecord, "value">): FactRecord {
  return { value, ...base };
}

function areaFromText(t: string): string | undefined {
  return HINTS.hints.find(([, re]) => re.test(t))?.[0];
}

function newNote(ctx: Ctx, folder: string, title: string, r: Row, type: string, area: string, sens: Sensitivity, body: string): Note {
  let base = `${folder}/${slugify(title) || "untitled"}`;
  let id = base;
  for (let n = 2; ctx.notes.some((x) => x.fm.id === id); n++) id = `${base}-${n}`;
  if (id !== base) flag(ctx, "Id collisions", `\`${id}\`: "${title}" has the same slug as \`${base}\``);
  const fp = fingerprintInfo(s(r, "Fingerprint"));
  if (fp.corrupted) flag(ctx, "Corrupted Notion text", `\`${id}\`: Fingerprint has literal \`n\` where newlines were lost`);
  const legacyKey = cleanText(s(r, "Fact key"));
  const fm: Frontmatter = {
    id, type, title, area, sensitivity: sens, status: "active",
    created: fp.created ?? s(r, "date:Date:start") ?? ctx.importDate,
    updated: fp.updated ?? fp.created ?? ctx.importDate,
    by: fp.by ?? AGENTS[s(r, "Author agent").toLowerCase()] ?? "import",
    legacy: { notion: pageId(r), ...(legacyKey ? { fact_key: legacyKey } : {}) },
  };
  const note: Note = { fm, body, path: id + ".md" };
  ctx.notes.push(note);
  ctx.byLegacy.set(pageId(r), note);
  return note;
}

function readRows(ctx: Ctx, db: string): Row[] {
  const f = join(ctx.rawDir, db, "rows.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Row[]) : [];
}
function readBody(ctx: Ctx, db: string, r: Row): string {
  const f = join(ctx.rawDir, db, "bodies", pageId(r) + ".md");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
}

// Shared per-row work: sources, verification, as_of, sensitivity, secret scan.
function common(ctx: Ctx, db: string, r: Row, title: string) {
  const rawBody = readBody(ctx, db, r);
  const red = redactSecrets(cleanBody(rawBody));
  if (red.found.length) flag(ctx, "Secret-shaped strings removed", `${db} "${title}": ${[...new Set(red.found)].join(", ")}`);
  const { refs, laundering } = rowSources(ctx, r, rawBody, title);
  const ver = verificationOf(r);
  if (laundering && ver.verification !== "unverified") {
    flag(ctx, "Source type laundering (write-quality N5)", `${db} "${title}": Source type says "a text received from Louis" but the source is agent memory (${refs.map(refString).join(", ")}); imported as self-reported`);
    ver.verification = "self-reported";
  }
  if (ver.verification === "confirmed-by-owner" && !refs.some((x) => /^imsg:phonemsg-/.test(refString(x)))) {
    flag(ctx, "Confirmed by Louis without a message id", `${db} "${title}": kept as confirmed-by-owner, cited as ${refs.map(refString).join(", ")}; add the phonemsg id`);
  }
  if (refs.length === 1 && refs[0] === "unverified") flag(ctx, "No usable source", `${db} "${title}"`);
  const { as_of, approx } = asOfFor(r);
  const sens: Sensitivity = s(r, "Sensitive") === "__YES__" ? "private" : "personal";
  const bodyRefs = extractRefs(cleanText(rawBody)).filter((x) => !refs.map(refString).includes(x));
  const noteSources = [...refs, ...bodyRefs];
  const base = { as_of, ...(approx ? { as_of_approx: true } : {}), sources: refs, ...ver, by: "", recorded: ctx.importDate };
  return { body: red.text, base, sens, noteSources, rawBody };
}

// Pass 2, deterministic part: an agent's appended "sources" lines often give an exact ref
// for one field ("role COO at Acme: an email, Gmail f000..."). Lift it into the fact.
function upgradeFromBody(ctx: Ctx, note: Note, rawBody: string, attr: string, words: RegExp) {
  const f = note.fm.facts?.[attr] as FactRecord | undefined;
  if (!f) return;
  for (const line of cleanText(rawBody).split("\n")) {
    if (!/^\s*-/.test(line) || !words.test(line)) continue;
    if (/unverified/i.test(line)) continue;
    const refs = extractRefs(line).filter((x) => /^(gmail|gcal|url|imsg:phonemsg)/.test(x));
    if (!refs.length) continue;
    const before = f.sources.map(refString).join(", ");
    f.sources = refs;
    f.verification = "verified-by-source";
    const d = line.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (d) { f.as_of = d[1]; delete f.as_of_approx; }
    flag(ctx, "Sources upgraded from page bodies (pass 2)", `\`${note.fm.id}#${attr}\`: ${before} -> ${refs.join(", ")}`);
    return;
  }
}

function setFact(note: Note, attr: string, f: Fact) {
  (note.fm.facts ??= {})[attr] = f;
}

function importDecisions(ctx: Ctx) {
  for (const r of readRows(ctx, "decisions")) {
    const title = cleanText(s(r, "Name"));
    const c = common(ctx, "decisions", r, title);
    const area = areaFromText(title) ?? "personal";
    if (!areaFromText(title)) flag(ctx, "Area guessed", `decisions "${title}": Notion Area "${s(r, "Area") || "empty"}" -> personal`);
    const decided = s(r, "date:Decision date:start");
    const datePrefix = decided || s(r, "date:Date:start");
    const n = newNote(ctx, "decisions", `${datePrefix ? datePrefix + " " : ""}${title.replace(/^\d{4}-\d{2}-\d{2}\s*/, "")}`, r, "decision", area, c.sens, c.body);
    n.fm.title = title;
    n.fm.sources = c.noteSources;
    if (decided) n.fm.decided_on = decided;
    const opts = cleanText(s(r, "Options considered"));
    if (opts && !/not detailed/i.test(opts)) n.fm.options = opts.split(/;\s*/).filter(Boolean);
    const outcome = cleanText(s(r, "Outcome"));
    if (outcome) setFact(n, "outcome", record(ctx, outcome, { ...c.base, as_of: decided || c.base.as_of, by: n.fm.by }));
    if (/details not supplied/i.test(outcome)) flag(ctx, "Topics with no content", `decisions "${title}": "${outcome}"`);
  }
  // A content-free decision that names the same thing as a real one is a duplicate pointer.
  const decisions = ctx.notes.filter((x) => x.fm.type === "decision");
  const words = (t: string) => new Set(compareKey(t).split(" ").filter((w) => w.length > 1 && !["the", "to", "and", "moved", "move"].includes(w)));
  for (const d of decisions) {
    const out = (d.fm.facts?.outcome as FactRecord | undefined)?.value;
    if (typeof out !== "string" || !/details not supplied/i.test(out)) continue;
    const w = words(d.fm.title);
    const best = decisions.filter((x) => x !== d).map((x) => ({ x, n: [...words(x.fm.title)].filter((y) => w.has(y)).length })).sort((a, b) => b.n - a.n)[0];
    if (best && best.n >= 3) {
      d.fm.status = "merged";
      d.fm.merged_into = best.x.fm.id;
      flag(ctx, "Duplicates merged", `\`${d.fm.id}\` merged into \`${best.x.fm.id}\``);
    }
  }
}

function importProjects(ctx: Ctx) {
  for (const r of readRows(ctx, "projects")) {
    const title = cleanText(s(r, "Name"));
    const c = common(ctx, "projects", r, title);
    const entity = s(r, "Entity").toLowerCase();
    const area = HINTS.areas[entity] ?? areaFromText(title) ?? "personal";
    if (!HINTS.areas[entity]) flag(ctx, "Area guessed", `projects "${title}": no Entity -> ${area}`);
    const n = newNote(ctx, "projects", title, r, "project", area, c.sens, c.body);
    n.fm.sources = c.noteSources;
    const by = n.fm.by;
    const status = s(r, "Status").toLowerCase();
    if (status) setFact(n, "status", record(ctx, status, { ...c.base, by }));
    const next = cleanText(s(r, "Next step"));
    if (next) setFact(n, "next_step", record(ctx, next, { ...c.base, by }));
    const due = s(r, "date:Due:start");
    if (due) setFact(n, "due", record(ctx, due, { ...c.base, by }));
    if (/\bOct(ober)? 6\b[^.\n]{0,40}session|session[^.\n]{0,20}\bOct(ober)? 6\b/i.test(c.body + next))
      flag(ctx, "Date problems", `\`${n.fm.id}\`: says "Oct 6 session", but the course runs on Mondays (2026-10-05). Left as written.`);
    const sup = cleanText(s(r, "Supersedes"));
    if (/superseded by/i.test(sup)) {
      n.fm.status = "superseded";
      (n.fm as Record<string, unknown>)._superseded_hint = sup.match(/project:[a-z0-9-]+/)?.[0];
    }
  }
  for (const n of ctx.notes.filter((x) => x.fm._superseded_hint !== undefined)) {
    const hint = String(n.fm._superseded_hint ?? "");
    delete (n.fm as Record<string, unknown>)._superseded_hint;
    const target = ctx.notes.find((x) => x !== n && x.fm.type === "project" && String(x.fm.legacy?.fact_key ?? "").startsWith(hint));
    if (target) { n.fm.superseded_by = target.fm.id; flag(ctx, "Duplicates merged", `\`${n.fm.id}\` superseded by \`${target.fm.id}\``); }
    else flag(ctx, "Unresolved links", `\`${n.fm.id}\`: Supersedes "${hint}" matches no project`);
  }
}

function findProjectByTitle(ctx: Ctx, title: string): Note | undefined {
  const k = compareKey(title);
  if (!k) return undefined;
  const all = [...ctx.notes.filter((x) => x.fm.type === "project"), ...ctx.notes.filter((x) => x.fm.type === "decision")];
  return all.find((x) => compareKey(x.fm.title) === k)
    ?? all.filter((x) => compareKey(x.fm.title).startsWith(k) || k.startsWith(compareKey(x.fm.title))).sort((a, b) => a.fm.title.length - b.fm.title.length)[0]
    ?? all.find((x) => k.split(" ").filter((w) => w.length > 3).every((w) => compareKey(x.fm.title).includes(w)));
}

function orgNote(ctx: Ctx, raw: string, area: string, r: Row): Note {
  const m = raw.match(/^([^()]+?)\s*\(([^)]+)\)\s*$/);
  const title = (m ? m[1] : raw).trim();
  const aliases = m && !/^(unclear|unknown|\?)$/i.test(m[2].trim()) ? [m[2].trim()] : [];
  const existing = ctx.notes.find((x) => x.fm.type === "org" && [x.fm.title, ...(x.fm.aliases ?? [])].some((t) => compareKey(t) === compareKey(title)));
  if (existing) return existing;
  const n = newNote(ctx, "orgs", title, { url: "", Fingerprint: s(r, "Fingerprint"), "Author agent": s(r, "Author agent") }, "org", area, "personal", "");
  delete n.fm.legacy;
  ctx.byLegacy.delete("");
  if (aliases.length) n.fm.aliases = aliases;
  n.fm.sources = [`notion:${pageId(r)}`];
  n.body = `Created by the Notion import from the free-text Org field.\n`;
  return n;
}

function importPeople(ctx: Ctx) {
  for (const r of readRows(ctx, "people")) {
    const title = cleanText(s(r, "Name"));
    const c = common(ctx, "people", r, title);
    const rel = cleanText(s(r, "Related project"));
    const proj = rel ? findProjectByTitle(ctx, rel) : undefined;
    let area = proj?.fm.area ?? areaFromText(`${rel} ${s(r, "Org")} ${s(r, "Role")}`);
    if (!area) { area = "personal"; flag(ctx, "Area guessed", `people "${title}": no related project${rel ? ` matched "${rel}"` : ""} -> personal`); }
    if (rel && !proj) flag(ctx, "Unresolved links", `people "${title}": Related project "${rel}" matches no project or decision`);
    const n = newNote(ctx, "people", title, r, "person", area, c.sens, c.body);
    n.fm.sources = c.noteSources;
    const by = n.fm.by;
    const role = cleanText(s(r, "Role"));
    const relationship = cleanText(s(r, "Relationship"));
    if (role) setFact(n, "role", record(ctx, role, { ...c.base, by }));
    if (relationship) setFact(n, "relationship", record(ctx, relationship, { ...c.base, by }));
    const org = cleanText(s(r, "Org"));
    if (org) {
      const o = orgNote(ctx, org, area, r);
      setFact(n, "org", record(ctx, `[[${o.fm.id}]]`, { ...c.base, by }));
    }
    const last = s(r, "date:Last contact:start");
    if (last) setFact(n, "last_contact", record(ctx, last, { ...c.base, as_of: last, as_of_approx: undefined, by }));
    if (n.fm.facts?.last_contact) delete (n.fm.facts.last_contact as FactRecord).as_of_approx;
    if (proj) n.body = `${n.body}${n.body ? "\n" : ""}Related: [[${proj.fm.id}]]\n`;
    upgradeFromBody(ctx, n, c.rawBody, "role", /\brole\b/i);
    upgradeFromBody(ctx, n, c.rawBody, "org", /\b(org|company|at [A-Z])/);
    // People tied to money (an advisor, a bank contact) get a tag so slices can leave them out.
    if (HINTS.finance.test(`${org} ${role} ${rel} ${title}`) || (proj && proj.fm.sensitivity !== "personal")) {
      n.fm.tags = ["finance"];
      flag(ctx, "Tagged finance (kept out of contacts-basic)", `\`${n.fm.id}\``);
    }
  }
  // An org whose only contacts are finance contacts (a bank, a brokerage) is finance too.
  for (const o of ctx.notes.filter((x) => x.fm.type === "org")) {
    const people = ctx.notes.filter((p) => p.fm.type === "person" && (p.fm.facts?.org as FactRecord | undefined)?.value === `[[${o.fm.id}]]`);
    if (people.length && people.every((p) => p.fm.tags?.includes("finance"))) o.fm.tags = ["finance"];
  }
}

function importNotes(ctx: Ctx) {
  for (const r of readRows(ctx, "notes")) {
    const title = cleanText(s(r, "Name"));
    const c = common(ctx, "notes", r, title);
    const rel = cleanText(s(r, "Related project"));
    const proj = rel ? findProjectByTitle(ctx, rel) : undefined;
    const area = proj?.fm.area ?? areaFromText(`${title} ${rel}`) ?? "personal";
    const type = s(r, "Type").toLowerCase() === "procedure" ? "procedure" : "note";
    const n = newNote(ctx, "notes", title.replace(/\s*\((Vamprose|Town) wiki\)\s*$/i, ""), r, type, area, c.sens, c.body);
    n.fm.title = title;
    n.fm.sources = c.noteSources;
    n.fm.verification = c.base.verification;
    const topic = cleanText(s(r, "Topic"));
    if (topic) n.fm.tags = [slugify(topic)];
    if (/wiki/i.test(title)) flag(ctx, "Wiki dumps (write-quality N7)", `\`${n.fm.id}\`: a synthesis; candidate to compile at build time instead of storing`);
    if (c.body.length > 8192) flag(ctx, "Over the 8 KB note limit", `\`${n.fm.id}\` (${Math.round(c.body.length / 1024)} KB): split into journal or smaller notes`);
    if (/hard rules|never use em dash/i.test(c.body)) flag(ctx, "Rules found inside notes", `\`${n.fm.id}\`: proposed into rules/RULES.md for Louis to confirm`);
  }
}

function importMoney(ctx: Ctx) {
  for (const r of readRows(ctx, "money")) {
    const title = cleanText(s(r, "Name"));
    const c = common(ctx, "money", r, title);
    const n = newNote(ctx, "money", title.replace(/^\d{4}-\d{2}-\d{2}\s*/, ""), r, "money", "personal", "private", c.body);
    n.fm.title = title;
    n.fm.sources = c.noteSources;
    const by = n.fm.by;
    const kind = s(r, "Type").toLowerCase();
    if (kind) setFact(n, "kind", record(ctx, kind, { ...c.base, by }));
    const amount = s(r, "Amount");
    if (amount) setFact(n, "amount", record(ctx, `${s(r, "Currency") || "CAD"} ${Number(amount).toFixed(2)}`, { ...c.base, by }));
    const due = s(r, "date:Due:start");
    if (due) setFact(n, "due", record(ctx, due, { ...c.base, by }));
    const status = s(r, "Status").toLowerCase();
    if (status) setFact(n, "status", record(ctx, status, { ...c.base, by }));
  }
}

function importCapabilities(ctx: Ctx) {
  for (const r of readRows(ctx, "capabilities")) {
    const title = cleanText(s(r, "Name"));
    const c = common(ctx, "capabilities", r, title);
    const agent = AGENTS[s(r, "Agent").toLowerCase()] ?? AGENTS[s(r, "Author agent").toLowerCase()] ?? "unknown";
    const what = cleanText(s(r, "What it does"));
    const n = newNote(ctx, `agents/${agent}`, title, r, "capability", agent, c.sens, (what ? what + "\n" : "") + c.body);
    n.fm.sources = c.noteSources;
    const base = { ...c.base, verification: "self-reported" as Verification, sources: [`agent:${agent}`], by: agent };
    delete (base as { confidence?: string }).confidence;
    const status = s(r, "Status").toLowerCase();
    if (status) setFact(n, "status", record(ctx, status, base));
    if (status === "retired") n.fm.status = "ended";
    const sched = cleanText(s(r, "Triggers or schedule"));
    if (sched) setFact(n, "schedule", record(ctx, sched, base));
    const tools = cleanText(s(r, "Tools or accounts used")).split(/[,;]\s*/).map((t) => t.trim()).filter(Boolean);
    if (tools.length) setFact(n, "tools", { items: tools.map((t) => record(ctx, t, base)) });
    const kind = s(r, "Type").toLowerCase();
    if (kind) n.fm.tags = [kind];
    const overlaps = cleanText(s(r, "Overlaps with"));
    if (overlaps) n.body += `\nOverlaps: ${overlaps}\n`;
  }
}

// Notion page mentions -> [[ids]] (or plain titles when the page isn't imported).
function resolveMentions(ctx: Ctx) {
  const re = /<mention-page url="[^"]*?([0-9a-f]{32})[^"]*"\s*>([^<]*)<\/mention-page>|<mention-page url="[^"]*?([0-9a-f]{32})[^"]*"\s*\/>/g;
  const fix = (t: string) => t.replace(re, (_all, id1, label, id2) => {
    const target = ctx.byLegacy.get(id1 ?? id2);
    return target ? `[[${target.fm.id}]]` : (label || "(Notion page)");
  });
  for (const n of ctx.notes) {
    n.body = fix(n.body);
    for (const f of Object.values(n.fm.facts ?? {})) {
      const recs = "items" in (f as object) ? (f as { items: FactRecord[] }).items : [f as FactRecord];
      for (const r of recs) if (typeof r.value === "string") r.value = fix(r.value);
    }
  }
}

export function importNotion(root: string, rawDir = join(root, "import", "raw"), importDate = "2026-10-08") {
  HINTS = loadImportHints(root);
  const ctx: Ctx = { root, rawDir, notes: [], byLegacy: new Map(), report: {}, importDate };
  importDecisions(ctx);
  importProjects(ctx);
  importMoney(ctx);
  importPeople(ctx);
  importNotes(ctx);
  importCapabilities(ctx);
  resolveMentions(ctx);
  // Notion's legacy fact_key strings keep their backslashes out.
  for (const n of ctx.notes) if (n.fm.legacy?.fact_key) n.fm.legacy.fact_key = String(n.fm.legacy.fact_key).replace(/\\/g, "");

  for (const d of ["people", "orgs", "projects", "decisions", "notes", "money", "agents"]) rmSync(join(root, d), { recursive: true, force: true });
  for (const n of ctx.notes) saveNote(root, n);

  // Reconcile (bootstrap step 7): every Notion page id in exactly one file.
  const counts: Record<string, number> = {};
  for (const db of ["decisions", "projects", "people", "notes", "money", "capabilities"]) counts[db] = readRows(ctx, db).length;
  const reloaded = loadBrain(root);
  const ids = reloaded.map((n) => n.fm.legacy?.notion).filter(Boolean);
  const dupIds = ids.filter((x, i) => ids.indexOf(x) !== i);
  const rowTotal = Object.values(counts).reduce((a, b) => a + b, 0);

  const folders: Record<string, number> = {};
  for (const n of reloaded) folders[n.fm.id.split("/")[0]] = (folders[n.fm.id.split("/")[0]] ?? 0) + 1;
  const facts = reloaded.reduce((a, n) => a + Object.keys(n.fm.facts ?? {}).length, 0);
  const approx = reloaded.reduce((a, n) => a + Object.values(n.fm.facts ?? {}).filter((f) => (f as FactRecord).as_of_approx).length, 0);

  const out: string[] = [
    "# Notion import report",
    "",
    `Imported ${importDate} from the raw snapshot in \`import/raw/\` (read through the Notion MCP, rows mode plus one page fetch per row). Re-running the import on the same snapshot gives the same files.`,
    "",
    "## Counts",
    "",
    "| Notion database | Rows |", "|---|---|",
    ...Object.entries(counts).map(([k, v]) => `| ${k} | ${v} |`),
    `| **total** | **${rowTotal}** (content rows: ${rowTotal - counts.capabilities}) |`,
    "",
    "| Brain folder | Files |", "|---|---|",
    ...Object.entries(folders).map(([k, v]) => `| ${k}/ | ${v} |`),
    "",
    `${facts} facts in frontmatter; ${approx} carry \`as_of_approx\` because Notion's dates were logging dates.`,
    "",
    "## Reconciliation",
    "",
    `- Notion page ids found in files: ${ids.length} of ${rowTotal} rows ${ids.length === rowTotal ? "(all)" : "(MISMATCH)"}`,
    `- Page ids in more than one file: ${dupIds.length ? dupIds.join(", ") : "none"}`,
    `- Sensitive rows kept private: ${reloaded.filter((n) => n.fm.sensitivity === "private").length} files at \`private\``,
    "",
  ];
  const order = [
    "Secret-shaped strings removed", "Source type laundering (write-quality N5)", "Confirmed by Louis without a message id",
    "No usable source", "Date problems", "Duplicates merged", "Topics with no content", "Rules found inside notes",
    "Over the 8 KB note limit", "Wiki dumps (write-quality N7)", "Unresolved links", "Area guessed",
    "Tagged finance (kept out of contacts-basic)", "Sources upgraded from page bodies (pass 2)", "Id collisions", "Corrupted Notion text",
  ];
  for (const k of [...order, ...Object.keys(ctx.report).filter((x) => !order.includes(x))]) {
    const items = ctx.report[k];
    if (!items?.length) continue;
    out.push(`## ${k} (${items.length})`, "", ...items.map((x) => `- ${x}`), "");
  }
  out.push("## Not imported", "", "- Receipts and expenses: empty database.", "- Agent comms, Agent hierarchy, Agent safety and tests: coordination pages, hand-converted into `rules/` instead (bootstrap.md 5).", "- Muse's 6 trashed duplicate rows: in Notion's trash, not live.", "");
  mkdirSync(join(root, "import"), { recursive: true });
  writeFileSync(join(root, "import", "REPORT.md"), out.join("\n"));
  return { files: reloaded.length, rows: rowTotal, report: join(root, "import", "REPORT.md") };
}
