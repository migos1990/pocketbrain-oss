// SPDX-License-Identifier: AGPL-3.0-only
// What a thin org is (docs/gardener.md "What an org is"): the Gardener's web-only run looks an
// org's name up and suggests one plain line, the org's website and the page's own sentence that
// backs it. The suggestion waits in inbox/describe/ for the owner's answer on the org's page; the
// hub never files it on its own. Off until the owner puts `describe_orgs: true` in
// rules/gardener.yaml. Only an org's id, title and aliases ever go to the run: never a person's
// name, a page's text, or an org at private or above, or one whose name reads as money, health or
// legal.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { sensitivityRank, isList, isDisputed, type Note, type FactRecord } from "./brain";
import { ownerName } from "./rules";
import { findInjection, findSecret, approvalClaim } from "./checks";
import { sensitiveName, sensitiveShape } from "./shape";
import { git } from "./git";
import { clock } from "./clock";
import { CoreError, requireGardener } from "./core";

export const DESCRIBE_DIR = "inbox/describe";
const LIST_MAX = 15; // a page of the work list; the run asks again after it suggests
const PER_DAY = 40; // suggestions a day, a safety rail on the first full pass
const LINE = { min: 3, max: 140 };
const QUOTE = { min: 10, max: 300 };

export interface Suggestion { org: string; by: string; at: string; what_it_is: string; website: string; quote: string; status: "waiting" | "no"; decided?: string }

export const describeFile = (id: string) => `${DESCRIBE_DIR}/${id.replace(/\//g, "__")}.yaml`;

export function describeOn(root: string): boolean {
  try { return (YAML.parse(readFileSync(join(root, "rules", "gardener.yaml"), "utf8")) as { describe_orgs?: unknown } | null)?.describe_orgs === true; } catch { return false; }
}

export function suggestionFor(root: string, id: string): Suggestion | undefined {
  try { const s = YAML.parse(readFileSync(join(root, describeFile(id)), "utf8")) as Suggestion; return s && s.org === id ? s : undefined; } catch { return undefined; }
}

const live = (f: unknown): FactRecord | undefined => {
  if (!f || isDisputed(f as never)) return undefined;
  if (isList(f as never)) return (f as { items: FactRecord[] }).items.find((i) => !i.valid_to && !i.retired);
  const r = f as FactRecord;
  return r.valid_to || r.retired ? undefined : r;
};
// The org's own line, once the owner said yes to one (or wrote one).
export const whatItIs = (n: Note): FactRecord | undefined => live(n.fm.facts?.what_it_is);

export const isOrg = (n: Note) => n.fm.type === "org" || n.fm.id.startsWith("orgs/");

// Orgs the run may look up: in the Gardener's view, below private, a name that doesn't read as
// money, health or legal, no line yet and no suggestion asked or answered.
function candidates(root: string, agent: string, tool: string, writes = false) {
  const { rules, res } = requireGardener(root, agent, tool, writes);
  const notes = [...res.visible.values()].map((v) => v.note).filter((n) => isOrg(n)
    && sensitivityRank(n.fm.sensitivity) < sensitivityRank("private")
    && !sensitiveName(rules, String(n.fm.title ?? "")) && !(n.fm.aliases ?? []).some((a) => sensitiveName(rules, a))
    && !whatItIs(n) && !existsSync(join(root, describeFile(n.fm.id))));
  return { rules, notes: notes.sort((a, b) => String(a.fm.created ?? "").localeCompare(String(b.fm.created ?? "")) || a.fm.id.localeCompare(b.fm.id)) };
}

export function orgsToDescribe(root: string, agent: string) {
  if (!describeOn(root)) { requireGardener(root, agent, "orgs_to_describe"); return { on: false, orgs: [], left: 0, next: "Off until the owner turns it on. Nothing to do." }; }
  const { notes } = candidates(root, agent, "orgs_to_describe");
  const orgs = notes.slice(0, LIST_MAX).map((n) => ({ id: n.fm.id, title: String(n.fm.title ?? n.fm.id), ...(n.fm.aliases?.length ? { aliases: n.fm.aliases } : {}) }));
  return { on: true, orgs, left: notes.length - orgs.length, next: orgs.length ? "For each org: web_search its title (and alias) only, open its own site with web_fetch, then suggest_about with one plain line, the site's https address and the site's sentence that names the org. Call orgs_to_describe again when the list is done." : "Nothing to describe." };
}

// The whole name as words in the sentence, accents and case aside: "RC Boxing" is named by "RC
// Boxing trains fighters", not by "a boxing gym".
const words = (t: string) => ` ${t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
const namedIn = (quote: string, name: string) => words(name).trim().length >= 2 && words(quote).includes(words(name));
const oneLine = (v: unknown) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
const URLISH = /https?:|www\.|\b[a-z0-9-]+\.(com|ca|org|net|io|dev|app|fr|co|info|biz)\b/i;

// An org's own address: https, a name (no IP, no localhost or private name), no user or password.
function website(raw: unknown): string {
  const s = String(raw ?? "").trim();
  let u: URL;
  try { u = new URL(s); } catch { throw new CoreError(400, "website must be the org's own https address"); }
  if (u.protocol !== "https:") throw new CoreError(400, "website must be https");
  const h = u.hostname.toLowerCase();
  if (u.username || u.password || s.length > 200 || u.port || !h.includes(".") || /^[\d.]+$/.test(h) || h.includes(":") || h.startsWith("[")
    || /(^|\.)(localhost|local|internal|lan|home|test|invalid|onion)$/.test(h) || findInjection(decodeURIComponent(s)) || findSecret(s))
    throw new CoreError(400, "website must be the org's public https address: a name, no user, password, port or IP");
  return u.toString();
}

export function suggestAbout(root: string, agent: string, body: { id?: unknown; what_it_is?: unknown; website?: unknown; quote?: unknown }) {
  if (!describeOn(root)) { requireGardener(root, agent, "suggest_about", true); throw new CoreError(403, "describing orgs is off until the owner turns it on"); }
  const { rules, notes } = candidates(root, agent, "suggest_about", true);
  const id = String(body.id ?? "");
  const n = notes.find((x) => x.fm.id === id);
  if (!n) throw new CoreError(404, `no org ${id} waiting for a line (orgs_to_describe lists them)`);
  const owner = ownerName(rules);
  const what = oneLine(body.what_it_is);
  if (what.length < LINE.min || what.length > LINE.max) throw new CoreError(400, `what_it_is is one plain line, ${LINE.min} to ${LINE.max} characters`);
  if (URLISH.test(what)) throw new CoreError(400, "what_it_is says what the org is in words; the address goes in website");
  const bad = findInjection(what) ?? findSecret(what) ?? (approvalClaim(owner).test(what) ? `claims ${owner} approved` : undefined) ?? sensitiveShape(rules, what);
  if (bad) throw new CoreError(422, `what_it_is refused: ${bad}`);
  const site = website(body.website);
  const quote = oneLine(body.quote);
  if (quote.length < QUOTE.min || quote.length > QUOTE.max) throw new CoreError(400, `quote is the site's own sentence, ${QUOTE.min} to ${QUOTE.max} characters`);
  const qbad = findInjection(quote) ?? findSecret(quote) ?? sensitiveShape(rules, quote);
  if (qbad) throw new CoreError(422, `quote refused: ${qbad}`);
  // The page's sentence must name the org, by its title or an alias: a page about something else
  // isn't proof of what this org is.
  const names = [String(n.fm.title ?? ""), ...(n.fm.aliases ?? [])].filter(Boolean);
  if (!names.some((x) => namedIn(quote, x))) throw new CoreError(422, `the quote doesn't name ${names[0]}: give the site's sentence that does`);
  const day = clock().toISOString().slice(0, 10);
  const dir = join(root, DESCRIBE_DIR);
  const today = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".yaml")).filter((f) => { try { const s = YAML.parse(readFileSync(join(dir, f), "utf8")) as Suggestion; return s.by === agent && String(s.at).startsWith(day); } catch { return false; } }).length : 0;
  if (today >= PER_DAY) throw new CoreError(429, `${PER_DAY} suggestions today is the cap; the rest wait for the next run`);
  const s: Suggestion = { org: id, by: agent, at: clock().toISOString(), what_it_is: what, website: site, quote, status: "waiting" };
  const rel = describeFile(id);
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), YAML.stringify(s, { lineWidth: 0 }));
  git(root, ["add", rel]);
  git(root, ["commit", "-q", "-m", `${agent}: suggest what ${id} is\n\nWhy: the Gardener found the org's site and its own sentence naming it; a suggestion only, ${owner} answers on the org's page.\nKind: suggest`], agent);
  return { id, status: "waiting" as const, next: "Suggested. The owner answers it on the org's page." };
}

// A suggestion as the org's page shows it, or the owner's Not it.
export function describeCardState(root: string, n: Note): { waiting?: Suggestion; declined?: Suggestion } {
  if (!isOrg(n) || whatItIs(n)) return {};
  const s = suggestionFor(root, n.fm.id);
  return s?.status === "waiting" ? { waiting: s } : s?.status === "no" ? { declined: s } : {};
}
