// SPDX-License-Identifier: AGPL-3.0-only
// A class the owner teaches, noticed from what the brain already holds (owner, 2026-11-07, on his
// school's page: "it should have understood by then that I teach there … and this is a class
// number"; G711, G712). A mail's subject and sender are never stored (G38), so this reads only the
// brain: a course code ("PROD 20410") in the titles or values of pages filed from two or more mails,
// and people whose org fact names one school cited by those same mails. That is one ask in the
// owner's words, kept in inbox/teach/; nothing is filed before his tap. Yes files the course page
// (org: the school) and his own word that he teaches it (teaches:, never his employer's org fact);
// "I'm taking it" the same with takes:; No is remembered, so the code is never asked again.
// Code only, no model. docs/wiki.md "A class you teach".
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { loadBrain, isDisputed, sensitivityRank, today, type Note, type FactRecord } from "./brain";
import { records } from "./carve";
import { loadRules } from "./rules";
import { ownerTitle, ownerOf } from "./capture";
import { refString } from "./sources";
import { git } from "./git";
import { clock } from "./clock";
import { write } from "./write";
import { OWNER, OWNER_CONFIRMED, ownerRef } from "./owner";
import { CoreError } from "./core";
import { renderTouchedPages } from "./wiki";

export const TEACH_DIR = "inbox/teach";
const MIN_MAILS = 2; // a code in pages from one mail is that mail, not a class
const MIN_PEOPLE = 2; // people at the school behind the same mails
// A course code: two to five capitals, then three to six digits ("PROD 20410", "MATH101").
const CODE = /\b([A-Z]{2,5}) ?(\d{3,6})\b/g;

export type TeachAnswer = "teaches" | "takes" | "no";
export interface TeachAsk { code: string; org: string; org_title: string; pages: string[]; people: string[]; refs: string[]; question: string; status: "waiting" | TeachAnswer; at: string; decided?: string; course?: string }
export interface TeachFind { code: string; org: string; org_title: string; pages: string[]; people: string[]; refs: string[] }

const slug = (code: string) => code.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const teachFile = (code: string) => `${TEACH_DIR}/${slug(code)}.yaml`;
const live = (r: FactRecord) => !r.valid_to && !r.retired && !r.unseen;
const linked = (v: unknown) => [...String(v ?? "").matchAll(/\[\[([^\]|]+)/g)].map((m) => m[1]!.trim());
const liveRecs = (n: Note, attr: string): FactRecord[] => { const f = n.fm.facts?.[attr]; return f && !isDisputed(f) ? records(f).filter(live) : []; };
const mailRefs = (n: Note) => new Set(Object.keys(n.fm.facts ?? {}).flatMap((a) => liveRecs(n, a)).flatMap((r) => (r.sources ?? []).map((s) => refString(s))).filter((s) => /^(gmail|mail|gcal):/.test(s)));
const active = (n: Note) => !["archived", "merged", "superseded"].includes(String(n.fm.status));

function ownerPage(root: string, notes: Note[]): Note | undefined {
  const rules = loadRules(root);
  const id = ownerOf(rules, notes, ownerTitle(rules) ?? "")?.page;
  return id ? notes.find((n) => n.fm.id === id) : undefined;
}

// Every course code the brain shows signs of, with its school: never a code that is already a page,
// one the owner's page already says he teaches or takes, or one he answered.
export function findTeaching(root: string, notes = loadBrain(root)): TeachFind[] {
  const P = sensitivityRank("private");
  const pages = notes.filter((n) => active(n) && sensitivityRank(n.fm.sensitivity) < P && n.fm.type !== "hub");
  const byCode = new Map<string, Note[]>();
  for (const n of pages) {
    if (n.fm.type === "person" || n.fm.type === "org") continue;
    const text = [n.fm.title, ...Object.keys(n.fm.facts ?? {}).flatMap((a) => liveRecs(n, a).map((r) => typeof r.value === "string" ? r.value : ""))].join("\n");
    for (const m of new Set([...String(text).matchAll(CODE)].map((x) => `${x[1]} ${x[2]}`))) byCode.set(m, [...(byCode.get(m) ?? []), n]);
  }
  const me = ownerPage(root, notes);
  const said = new Set(me ? ["teaches", "takes"].flatMap((a) => liveRecs(me, a)).flatMap((r) => linked(r.value)).map((id) => String(notes.find((n) => n.fm.id === id)?.fm.title ?? "")) : []);
  const titles = new Set(notes.map((n) => String(n.fm.title ?? "")));
  const answered = new Set(teachAsks(root).map((a) => a.code));
  const out: TeachFind[] = [];
  for (const [code, ps] of [...byCode].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (titles.has(code) || said.has(code) || answered.has(code)) continue;
    const refs = new Set(ps.flatMap((p) => [...mailRefs(p)]));
    if (refs.size < MIN_MAILS) continue;
    // The school: the org most people behind the same mails work at.
    const at = new Map<string, Set<string>>();
    for (const n of pages) {
      if (n.fm.type !== "person" || n.fm.id === me?.fm.id) continue;
      const org = liveRecs(n, "org");
      if (!org.some((r) => (r.sources ?? []).some((s) => refs.has(refString(s))))) continue;
      for (const id of org.flatMap((r) => linked(r.value))) at.set(id, (at.get(id) ?? new Set()).add(n.fm.id));
    }
    const best = [...at].filter(([id]) => notes.some((n) => n.fm.id === id && n.fm.type === "org" && active(n)))
      .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))[0];
    if (!best || best[1].size < MIN_PEOPLE) continue;
    // His own employer is not a class he teaches.
    if (me && liveRecs(me, "org").some((r) => linked(r.value).includes(best[0]))) continue;
    const org = notes.find((n) => n.fm.id === best[0])!;
    out.push({ code, org: org.fm.id, org_title: String(org.fm.title ?? org.fm.id), pages: ps.map((p) => p.fm.id).sort(), people: [...best[1]].sort(), refs: [...refs].sort() });
  }
  return out;
}

export function teachAsks(root: string): TeachAsk[] {
  const dir = join(root, TEACH_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort().flatMap((f) => {
    try { const a = YAML.parse(readFileSync(join(dir, f), "utf8")) as TeachAsk; return a?.code ? [a] : []; } catch { return []; }
  });
}
export const waitingTeachAsks = (root: string) => teachAsks(root).filter((a) => a.status === "waiting");

const question = (f: TeachFind) => `You seem to teach ${f.code} at ${f.org_title}. Right?`;

// One ask per code found, in one hub commit; a code asked before is never asked again.
export function raiseTeachAsks(root: string, o: { apply?: boolean } = {}): TeachFind[] {
  const found = findTeaching(root);
  if (o.apply === false || !found.length) return found;
  mkdirSync(join(root, TEACH_DIR), { recursive: true });
  const at = clock().toISOString();
  const rels = found.map((f) => {
    const rel = teachFile(f.code);
    const ask: TeachAsk = { ...f, question: question(f), status: "waiting", at };
    writeFileSync(join(root, rel), YAML.stringify(ask, { lineWidth: 0 }));
    return rel;
  });
  git(root, ["add", ...rels]);
  git(root, ["commit", "-q", "-m", `hub: ask about ${found.length === 1 ? `one class (${found[0]!.code})` : `${found.length} classes`}\n\nWhy: a course code recurs in pages filed from ${found[0]!.refs.length} or more mails, with people at one school behind them; a question only, nothing is filed before the owner answers.`], "hub");
  return found;
}

// The owner's answer. Yes (teaches) or "I'm taking it" (takes) files the course page under the
// school and his own word on his page; No records the answer. Each is one commit.
export function answerTeach(root: string, code: string, answer: TeachAnswer): TeachAsk {
  const began = new Date(Math.min(Date.now(), clock().getTime()) - 1000).toISOString();
  const rel = teachFile(code);
  const ask = teachAsks(root).find((a) => a.code === code);
  if (!ask) throw new CoreError(404, `no question about ${code}`);
  if (ask.status !== "waiting") throw new CoreError(409, `${code} was answered already`);
  const d = today();
  let course: string | undefined;
  if (answer !== "no") {
    const notes = loadBrain(root);
    const school = notes.find((n) => n.fm.id === ask.org);
    const me = ownerPage(root, notes);
    if (!school || !me) throw new CoreError(409, "the school's page or your own page is gone");
    const ref = ownerRef(d, `teach-${slug(code)}`);
    // The course page: its school from the mails that formed the signal and his tap.
    const page = write(root, { agent: OWNER, title: code, type: "project", area: school.fm.area, attribute: "org", value: `[[${school.fm.id}]]`, as_of: d, sources: [ref, ...ask.refs], verification: OWNER_CONFIRMED } as never, { owner: true });
    if (page.outcome !== "committed" && page.outcome !== "noop") throw new CoreError(409, page.message ?? "the course page wasn't filed");
    course = page.fact_key?.split("#")[0];
    if (!course) throw new CoreError(500, "the course page has no id");
    const mine = write(root, { agent: OWNER, id: me.fm.id, attribute: answer, value: `[[${course}]]`, as_of: d, sources: [ref], verification: OWNER_CONFIRMED } as never, { owner: true });
    if (mine.outcome !== "committed" && mine.outcome !== "noop") throw new CoreError(409, mine.message ?? "your page wasn't changed");
  }
  const done: TeachAsk = { ...ask, status: answer, decided: d, ...(course ? { course } : {}) };
  writeFileSync(join(root, rel), YAML.stringify(done, { lineWidth: 0 }));
  git(root, ["add", rel]);
  git(root, ["commit", "-q", "-m", `owner: ${answer === "no" ? "doesn't teach" : answer === "takes" ? "takes" : "teaches"} ${code}\n\nWhy: the owner answered the question about ${code} at ${ask.org_title}.`], OWNER);
  // The pages say it now, not after the night writer (G707).
  if (course) try { renderTouchedPages(root, began); } catch { /* the night run writes it */ }
  return done;
}
