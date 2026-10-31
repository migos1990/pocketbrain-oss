// SPDX-License-Identifier: AGPL-3.0-only
// The upkeep agent, `reflect` (architecture 7.6, Louis's decision of 2026-10-08): it may fix
// links and dates on its own, each fix its own revertable commit tagged reflect:auto, and
// recheck facts against live sources. Any contradiction is escalated, never resolved.
// No LLM in v1: every pass here is a rule.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { Note, FactRecord, Sensitivity } from "./brain";
import { loadBrain, saveNote, today, linksIn, isDisputed, isList, sensitivityRank } from "./brain";
import { loadRules, attributeSpec, readYaml } from "./rules";
import { factFreshness, daysBetween, passedDay } from "./freshness";
import { records, carve, grantFor } from "./carve";
import { compareKey } from "./normalize";
import { refString, sourceRank } from "./sources";
import { runChecks } from "./checks";
import { archiveOldLogs } from "./logs";
import { git } from "./git";
import { queueOp } from "./hub";
import type { WriteResult } from "./write";
import { wikiLint, renderTouchedPages } from "./wiki";
import { setAsideReceipts } from "./receipt-pages";
import { linkFamily } from "./family";
import { OWNER } from "./owner";
import { staleMentions } from "./drift";
import { linkMentions, namePlan } from "./mentions";

// Notes whose names upkeep links in one run; the rest wait for the next night.
export const MENTION_NOTES_PER_RUN = 50;
// How far back upkeep looks for touched pages: a day and a margin, so a late night run misses none.
export const PAGE_TEXT_HOURS = 26;

export interface Finding {
  rule: string;
  key: string; // note id or fact key
  kind: "auto-fix" | "review" | "escalate";
  detail: string;
}

// A connected source (Gmail, calendar) that can recheck one fact. Returns undefined when it
// has nothing to say. In v1 the connectors run inside the wall with read-only grants.
export interface LiveSource {
  name: string;
  recheck(note: Note, attribute: string, r: FactRecord): { verdict: "confirms" | "contradicts"; value?: unknown; ref: string } | undefined;
}

interface Suppression { key: string; rule: string; since: string; why?: string }

export function loadSuppressions(root: string): Suppression[] {
  return readYaml<{ suppressions?: Suppression[] }>(join(root, "rules", "suppressions.yaml"), {}).suppressions ?? [];
}

function commitFix(root: string, run: string, files: string[], msg: string, keys: string[]) {
  git(root, ["add", ...files]);
  git(root, ["commit", "-q", "-m", `reflect: ${msg}\n\nAgent: reflect\nRun: ${run}\nKind: auto-fix\nFact-Keys: ${keys.join(", ")}`], "reflect");
}

const isoDate = (s: string) => /^\d{4}(-\d{2}(-\d{2})?)?$/.test(s);
function fixDate(s: unknown): string | undefined {
  if (typeof s !== "string") return undefined;
  const m = s.trim().match(/^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?$/);
  if (!m) return undefined;
  const out = [m[1], m[2].padStart(2, "0"), m[3]?.padStart(2, "0")].filter(Boolean).join("-");
  return out !== s ? out : undefined;
}

export function upkeep(root: string, opts: { live?: LiveSource[]; now?: string; run?: string } = {}): { run: string; findings: Finding[]; file: string; queued?: boolean } {
  const now = opts.now ?? today();
  const run = opts.run ?? `reflect-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  // On a replica, upkeep changes nothing here: the live rechecks this machine can make (its
  // Gmail or calendar export) are recorded and queued as a signed op. The hub runs the rule
  // passes on its own current notes and replays the recorded rechecks against them.
  {
    const q = queueOp(root, "upkeep", "reflect", { run, now, live: recordRechecks(root, opts.live ?? []) }, run);
    if (q) {
      if (q.outcome === "refused") throw new Error(q.message);
      return { run, findings: [], file: q.file!, queued: true };
    }
  }
  const rules = loadRules(root);
  let notes = loadBrain(root);
  const suppressed = loadSuppressions(root);
  const isSuppressed = (key: string, rule: string) => suppressed.some((s) => s.key === key && s.rule === rule);
  const findings: Finding[] = [];
  const add = (f: Finding) => { if (!isSuppressed(f.key, f.rule)) findings.push(f); return !isSuppressed(f.key, f.rule); };
  const byId = new Map(notes.map((n) => [n.fm.id, n]));

  // 1. Links: repoint links to merged or superseded notes, and links that match a note by alias or slug.
  for (const n of notes) {
    let body = n.body;
    for (const target of new Set(linksIn(body))) {
      const t = byId.get(target);
      let to: string | undefined;
      // Merged notes are pointers, so links move on. A superseded decision is history the owner
      // wants findable: links to it stay, and the decisions point at each other (below).
      if (t && t.fm.merged_into) to = String(t.fm.merged_into);
      else if (!t && !target.startsWith("rules/") && target !== "redacted") {
        const k = compareKey(target.split("/").pop()!.replace(/-/g, " "));
        const hits = notes.filter((x) => [x.fm.title, ...(x.fm.aliases ?? []), x.fm.id.split("/").pop()!.replace(/-/g, " ")].some((y) => compareKey(y) === k));
        if (hits.length === 1) to = hits[0].fm.id;
        else add({ rule: "broken-link", key: n.fm.id, kind: "review", detail: `links to [[${target}]], which doesn't exist${hits.length > 1 ? ` (could be ${hits.map((h) => h.fm.id).join(" or ")})` : ""}` });
      }
      if (to && add({ rule: "link-repoint", key: n.fm.id, kind: "auto-fix", detail: `[[${target}]] -> [[${to}]]` }))
        body = body.split(`[[${target}]]`).join(`[[${to}]]`).split(`[[${target}|`).join(`[[${to}|`);
    }
    if (body !== n.body) {
      n.body = body;
      saveNote(root, n);
      commitFix(root, run, [n.path], `repoint links in ${n.fm.id}`, [n.fm.id]);
    }
  }

  // 1b. Replaced decisions point both ways: old.superseded_by <-> new.supersedes.
  for (const n of notes) {
    const fm = n.fm as typeof n.fm & { superseded_by?: string; supersedes?: string | string[] };
    if (fm.superseded_by) {
      const b = byId.get(String(fm.superseded_by)) as (typeof n & { fm: typeof fm }) | undefined;
      const have = b ? [b.fm.supersedes ?? []].flat().map(String) : [];
      if (b && !have.includes(n.fm.id) && add({ rule: "supersede-link", key: b.fm.id, kind: "auto-fix", detail: `supersedes: ${n.fm.id} (it says superseded_by: ${b.fm.id})` })) {
        b.fm.supersedes = have.length ? [...have, n.fm.id] : n.fm.id;
        saveNote(root, b);
        commitFix(root, run, [b.path], `link ${b.fm.id} to the decision it replaced`, [b.fm.id]);
      }
    }
    for (const old of [fm.supersedes ?? []].flat().map(String)) {
      const a = byId.get(old) as (typeof n & { fm: typeof fm }) | undefined;
      if (a && !a.fm.superseded_by && add({ rule: "supersede-link", key: a.fm.id, kind: "auto-fix", detail: `superseded_by: ${n.fm.id}${a.fm.status === "active" ? ", status superseded" : ""}` })) {
        a.fm.superseded_by = n.fm.id;
        if (a.fm.status === "active") a.fm.status = "superseded";
        saveNote(root, a);
        commitFix(root, run, [a.path], `mark ${a.fm.id} as replaced by ${n.fm.id}`, [a.fm.id]);
      }
    }
  }

  // 1c. Names become links (src/mentions.ts, docs/wiki.md): a note's text that names exactly one
  //     other note by its title or alias gets a link there, the words kept as written. Only where
  //     every assistant that sees this note also sees the note named, so no reader's view loses a
  //     name to [[redacted]]; otherwise, and when a name fits two notes, a review line. A brain-
  //     writing job, so nothing at all until `pocketbrain wiki links on` (`wiki links preview`
  //     shows the owner what it would do). A finding reaches the Gardener when it sees the note
  //     (gardenerUpkeep filters by key), possibly without its text: no line names a name, a note
  //     or a value; the commit itself says what changed.
  if ((rules.policy as { link_names?: boolean }).link_names === true) {
    let touched = 0;
    for (const p of namePlan(notes, rules)) {
      if (touched >= MENTION_NOTES_PER_RUN) break;
      const n = byId.get(p.from)!;
      if (p.ambiguous) add({ rule: "name-ambiguous", key: n.fm.id, kind: "review", detail: `${p.ambiguous === 1 ? "a name in the text fits" : `${p.ambiguous} names in the text each fit`} more than one note; link the right one by hand` });
      if (p.blind) add({ rule: "name-unlinked", key: n.fm.id, kind: "review", detail: "the text names a page that some assistants who see this note can't see; left as plain text" });
      const fresh = p.link.length && add({ rule: "link-mention", key: n.fm.id, kind: "auto-fix", detail: `linked ${p.link.length === 1 ? "a name" : `${p.link.length} names`} in the text to the one note each names` });
      if (!fresh) continue;
      n.body = linkMentions(n.body, p.link, p.index);
      saveNote(root, n);
      commitFix(root, run, [n.path], `link names in ${n.fm.id}`, [n.fm.id]);
      touched++;
    }
  }

  // 1c2. Receipts held as pages before no-reply mail stopped being read (src/receipt-pages.ts):
  //      set aside once, a diary line each with Undo; one hub commit with a why.
  if (setAsideReceipts(root).length) { notes = loadBrain(root); byId.clear(); for (const n of notes) byId.set(n.fm.id, n); }
  // 1c3. A person with the owner's surname may be family (src/family.ts): one inferred fact linking
  //      the owner's page, a diary line each with Undo; one hub commit with a why.
  //      Off until the owner turns it on: then a count only, never a name.
  {
    const fam = linkFamily(root);
    if (fam.filed.length) { notes = loadBrain(root); byId.clear(); for (const n of notes) byId.set(n.fm.id, n); }
    else if (fam.counted) add({ rule: "family-links", key: "family-links", kind: "review", detail: `${fam.counted} person page${fam.counted === 1 ? " has" : "s have"} your surname and may be family; \`pocketbrain wiki family on\` links them to your page` });
  }

  // 1d. Page text (src/wiki.ts renderTouchedPages, docs/wiki.md): every page a commit touched in
  //     the last day gets an opening paragraph from its facts, each sentence citing its source,
  //     linked to the pages its sources name. One hub commit with a why; a person's or the
  //     Gardener's prose is kept as it is.
  {
    const w = renderTouchedPages(root, new Date(Date.now() - PAGE_TEXT_HOURS * 3_600_000).toISOString());
    // Not a finding: nothing was wrong. The hub commit says which pages and why.
    if (w.written.length) { notes = loadBrain(root); byId.clear(); for (const n of notes) byId.set(n.fm.id, n); }
  }

  // 1e. A summary is one plain line under the title: a reference marker in it ("…[^1]", from a
  //     Gardener sync that cited it) shows raw wherever the summary is read, so it is taken out.
  for (const n of notes) {
    if (typeof n.fm.summary !== "string" || !/\[\^[^\]\s]+\]/.test(n.fm.summary)) continue;
    const plain = n.fm.summary.replace(/\s*\[\^[^\]\s]+\]/g, "").trim();
    if (!add({ rule: "summary-marker", key: n.fm.id, kind: "auto-fix", detail: "took a reference marker out of the summary" })) continue;
    n.fm.summary = plain;
    saveNote(root, n);
    commitFix(root, run, [n.path], `plain summary for ${n.fm.id}`, [n.fm.id]);
  }

  // 2. Dates: malformed dates in frontmatter get normalized (2026-9-5 -> 2026-09-05).
  for (const n of notes) {
    let changed = false;
    for (const k of ["created", "updated", "decided_on"]) {
      const f = fixDate(n.fm[k]);
      if (f && add({ rule: "date-format", key: n.fm.id, kind: "auto-fix", detail: `${k}: ${n.fm[k]} -> ${f}` })) { (n.fm as Record<string, unknown>)[k] = f; changed = true; }
    }
    for (const [attr, fact] of Object.entries(n.fm.facts ?? {})) {
      for (const r of records(fact)) {
        const f = fixDate(r.as_of);
        if (f && add({ rule: "date-format", key: `${n.fm.id}#${attr}`, kind: "auto-fix", detail: `as_of: ${r.as_of} -> ${f}` })) { r.as_of = f; changed = true; }
        if (isoDate(String(r.as_of)) && String(r.as_of) > now)
          add({ rule: "as-of-in-future", key: `${n.fm.id}#${attr}`, kind: "review", detail: `as_of ${r.as_of} is after today` });
      }
    }
    if (changed) { saveNote(root, n); commitFix(root, run, [n.path], `normalize dates in ${n.fm.id}`, [n.fm.id]); }
  }

  notes = loadBrain(root);

  // 3. Freshness: due and stale facts become a review list, most stale first.
  for (const n of notes) {
    if (n.fm.status !== "active") continue;
    // A project whose due date has passed but is still active.
    const due = n.fm.facts?.due as FactRecord | undefined;
    const pastDue = n.fm.type === "project" && due && typeof due.value === "string" && isoDate(due.value) && due.value < now;
    for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
      if (attr === "due" && pastDue) continue; // past-due below says it once
      const fr = factFreshness(f, attributeSpec(rules, n.fm.type, attr), now);
      if (fr === "due" || fr === "stale") {
        const r = records(f)[0];
        add({ rule: `freshness-${fr}`, key: `${n.fm.id}#${attr}`, kind: "review", detail: `${fr}: last confirmed ${r.last_confirmed ?? r.as_of}${r.as_of_approx ? " (approx.)" : ""}` });
      }
    }
    if (pastDue)
      add({ rule: "past-due", key: `${n.fm.id}#due`, kind: "review", detail: `due ${due.value}, still active` });
    // A deadline or an event whose day went by and that still reads as current (`passedDay` in
    // src/freshness.ts): a review line; nothing asks the owner about it, only a conflict asks.
    if (n.fm.type !== "dispute" && !["archived", "superseded"].includes(String(n.fm.status ?? ""))) for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
      if (isList(f) || isDisputed(f) || (n.fm.type === "project" && attr === "due")) continue;
      const r = f as FactRecord;
      if (r.retired || (r.valid_to && r.valid_to <= now)) continue;
      const date = passedDay(r, attributeSpec(rules, n.fm.type, attr), now);
      if (date) add({ rule: "past-date", key: `${n.fm.id}#${attr}`, kind: "review", detail: `names ${date}, which has passed; not confirmed since` });
    }
  }

  // 4. Duplicate entities: same type, same normalized title or alias. Notes count only as
  //    meeting records: same title and same held_on date (two write-ups of one meeting).
  const seen = new Map<string, string>();
  const twins: [Note, Note][] = [];
  const heldOn = (x: Note) => { const h = x.fm.facts?.held_on as FactRecord | undefined; return h && typeof h.value === "string" ? h.value : undefined; };
  for (const n of notes.filter((x) => x.fm.status === "active" && (["person", "org", "project"].includes(x.fm.type) || (x.fm.type === "note" && heldOn(x))))) {
    for (const name of [n.fm.title, ...(n.fm.aliases ?? [])]) {
      const k = `${n.fm.type}:${compareKey(name)}${n.fm.type === "note" ? `@${heldOn(n)}` : ""}`;
      const other = seen.get(k);
      if (other && other !== n.fm.id) {
        add({ rule: "possible-duplicate", key: n.fm.id, kind: "review", detail: `same name as ${other} ("${name}")` });
        // The packet goes on the older note (the one the duplicate likely copies).
        const pair = [byId.get(other)!, n].sort((x, y) => String(x.fm.created).localeCompare(String(y.fm.created)) || x.fm.id.localeCompare(y.fm.id)) as [Note, Note];
        if (!twins.some(([a, b]) => a.fm.id === pair[0].fm.id && b.fm.id === pair[1].fm.id)) twins.push(pair);
      }
      else seen.set(k, n.fm.id);
    }
  }

  // 4b. Contradictions (backlog 282): two notes for one person, org or project (step 4's twins)
  //     holding the same attribute with different current values from different sources become
  //     one dispute packet on the first note, listing both. Nothing is resolved or changed: the
  //     conflict order (stronger source, then newer) only marks the suggestion. A value that is
  //     a less specific form of the other ("Coordinator", "Course coordinator") is not a
  //     contradiction. Notes in different areas, or a fact shared with named agents only, get a
  //     review line instead: a packet lives in one area. The finding names no value and no other
  //     note, since the gardener sees findings on facts in its view.
  {
    const words = (v: unknown) => new Set(String(v).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    const within = (a: Set<string>, b: Set<string>) => [...a].every((w) => b.has(w));
    const current = (n: Note, attr: string) => { const f = n.fm.facts?.[attr]; return f && !isDisputed(f) && !("items" in (f as object)) && !(f as FactRecord).valid_to ? f as FactRecord : undefined; };
    const packets = notes.filter((n) => n.fm.id.startsWith("disputes/") && (n.fm as { origin?: string }).origin === "contradiction");
    for (const [a, b] of twins) {
      if (!a || !b) continue;
      for (const attr of Object.keys(a.fm.facts ?? {})) {
        const ra = current(a, attr), rb = current(b, attr);
        if (!ra || !rb || typeof ra.value === "object" || typeof rb.value === "object") continue;
        const wa = words(ra.value), wb = words(rb.value);
        if (!wa.size || !wb.size || within(wa, wb) || within(wb, wa)) continue;
        const refsA = new Set(ra.sources.map(refString));
        if (rb.sources.map(refString).some((x) => refsA.has(x))) continue;
        const key = `${a.fm.id}#${attr}`, other = `${b.fm.id}#${attr}`;
        const pair = [compareKey(ra.value), compareKey(rb.value)].sort().join("\u0000");
        if (packets.some((p) => p.fm.fact_key === key && (p.fm as { other_key?: string }).other_key === other && (((p.fm as { candidates?: FactRecord[] }).candidates ?? []).map((c) => compareKey(c.value)).sort().join("\u0000") === pair))) continue;
        // Whoever can see one side must see the other, or the packet would carry a hidden value.
        const seesBoth = Object.keys(rules.policy.agents ?? {}).every((agent) => {
          let res; try { res = carve(notes, rules, grantFor(rules, agent), { flags: false }); } catch { return false; }
          const hidden = new Set(res.hiddenFacts.map((h) => h.key));
          const sees = (n: Note) => { const v = res.visible.get(n.fm.id); return !!v && (v.attributes === "all" || v.attributes.has(attr)) && !hidden.has(`${n.fm.id}#${attr}`); };
          return sees(a) === sees(b);
        });
        if (a.fm.area !== b.fm.area || ra.share_with || rb.share_with || !seesBoth) {
          add({ rule: "contradiction", key, kind: "review", detail: `another note for the same ${a.fm.type}, in another area or shared with named agents only, holds a different value; compare them yourself` });
          continue;
        }
        const ka = sourceRank(ra), kb = sourceRank(rb);
        const suggested = ka !== kb ? (ka > kb ? 1 : 2) : ra.as_of !== rb.as_of ? (ra.as_of > rb.as_of ? 1 : 2) : undefined;
        const level = [a.fm.sensitivity, b.fm.sensitivity, ra.sensitivity, rb.sensitivity].filter(Boolean).sort((x, y) => sensitivityRank(y as Sensitivity) - sensitivityRank(x as Sensitivity))[0] as Sensitivity;
        const id = nextDispute(root), d = today();
        // Each side carries the stricter level, so the resolver's view of the packet withholds both values.
        const lift = (r: FactRecord) => sensitivityRank(level) > sensitivityRank((r.sensitivity ?? a.fm.sensitivity) as Sensitivity) ? { ...r, sensitivity: level } : r;
        const cands = [lift(ra), lift({ ...rb, note: `${rb.note ? rb.note + "; " : ""}held by ${b.fm.id}` })];
        if (!add({ rule: "contradiction", key, kind: "escalate", detail: `another note for the same ${a.fm.type} holds a different value from another source; dispute ${id} waits for the owner` })) continue;
        saveNote(root, {
          fm: { id: `disputes/${id}`, type: "dispute", title: key, area: a.fm.area, sensitivity: level, status: "open", created: d, updated: d, by: "reflect", fact_key: key, other_key: other, origin: "contradiction", step: 6, candidates: cands, ...(suggested ? { suggested } : {}) } as Note["fm"],
          body: `\`${a.fm.id}\` and \`${b.fm.id}\` look like the same ${a.fm.type} and disagree on \`${attr}\`. Upkeep doesn't pick a winner and changes neither note.\n\n${cands.map((c, i) => `${i + 1}. ${c.value} (as of ${c.as_of}, ${c.verification}, ${c.sources.map(refString).join(", ")})${i === 1 ? ` on ${b.fm.id}` : ""}`).join("\n")}\n\n${suggested ? `Suggested: ${suggested} (${ka !== kb ? "the stronger source" : "the newer one"}, by the conflict order). ` : ""}The owner answers with the number; the answer is written to \`${key}\`. Merging the two notes is its own review line.\n`,
          path: "",
        });
        packets.push(loadBrain(root).find((n) => n.fm.id === `disputes/${id}`)!);
        commitFix(root, run, ["disputes"], `contradiction on ${key}: dispute ${id}`, [key]);
      }
    }
  }

  // 5. Open disputes are listed every run until Louis answers.
  for (const n of notes) for (const [attr, f] of Object.entries(n.fm.facts ?? {}))
    if (isDisputed(f)) add({ rule: "open-dispute", key: `${n.fm.id}#${attr}`, kind: "escalate", detail: `${f.dispute}: ${f.candidates.length} candidates waiting for the owner` });

  // 6. Live recheck. Confirmation refreshes last_confirmed (a mechanical fix); a contradiction
  //    marks the fact disputed and escalates. Upkeep never picks the winner.
  for (const src of opts.live ?? []) {
    for (const n of loadBrain(root)) {
      let changed = false;
      for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
        if (isDisputed(f) || "items" in (f as object)) continue;
        const r = f as FactRecord;
        const res = src.recheck(n, attr, r);
        if (!res) continue;
        const key = `${n.fm.id}#${attr}`;
        if (res.verdict === "confirms") {
          if (r.last_confirmed !== now && add({ rule: "recheck-confirmed", key, kind: "auto-fix", detail: `${src.name} confirms (${res.ref})` })) {
            r.last_confirmed = now;
            if (!r.sources.map(refString).includes(res.ref)) r.sources.push(res.ref);
            changed = true;
          }
        } else if (add({ rule: "recheck-contradicts", key, kind: "escalate", detail: `${src.name} says "${res.value}" (${res.ref}); brain says "${r.value}"` })) {
          const id = nextDispute(root);
          const challenger: FactRecord = { value: res.value, as_of: now, sources: [res.ref], verification: "verified-by-source", by: "reflect", recorded: now };
          n.fm.facts![attr] = { dispute: id, candidates: [r, challenger] };
          writeDisputePacket(root, id, n, attr, [r, challenger]);
          changed = true;
        }
      }
      if (changed) {
        saveNote(root, n);
        commitFix(root, run, [n.path, ...(existsSync(join(root, "disputes")) ? ["disputes"] : [])], `recheck ${n.fm.id} against ${src.name}`, Object.keys(n.fm.facts ?? {}).map((a) => `${n.fm.id}#${a}`));
      }
    }
  }

  // 7. Journals older than 60 days leave every view (Louis, 2026-10-08), still in git.
  const jdir = join(root, "journal");
  if (existsSync(jdir)) {
    for (const agent of readdirSync(jdir)) {
      for (const f of readdirSync(join(jdir, agent))) {
        const m = f.match(/^(\d{4}-\d{2})\.md$/);
        if (!m) continue;
        const end = new Date(`${m[1]}-01T00:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
        if (daysBetween(end.toISOString().slice(0, 10), now) <= 60) continue;
        const key = `journal/${agent}/${m[1]}`;
        if (!add({ rule: "journal-archive", key, kind: "auto-fix", detail: "older than 60 days, moved to archive/journal" })) continue;
        mkdirSync(join(root, "archive", "journal", agent), { recursive: true });
        renameSync(join(jdir, agent, f), join(root, "archive", "journal", agent, f));
        commitFix(root, run, ["-A", "journal", "archive"], `archive ${key}`, [key]);
      }
    }
    // Agent logs (src/logs.ts) leave by month, after policy.yaml logs.retention_days (default 60).
    for (const key of archiveOldLogs(root, now, (key) => add({ rule: "journal-archive", key, kind: "auto-fix", detail: "agent logs past retention, moved to archive/journal" })))
      commitFix(root, run, ["-A", "journal", "archive"], `archive ${key}`, [key]);
  }

  // 8. Stored facts against today's checks (eval gap G10). A record that today's write path
  //    would refuse keeps its value but loses the authority it claimed: confirmed-by-louis
  //    without Louis's message id, or agent memory presented as verified, becomes
  //    self-reported; unresolvable sources become unverified. The original claim stays in `note`.
  {
    const enabled = new Set(rules.checks.checks ?? []);
    for (const n of loadBrain(root)) {
      if (["merged", "superseded"].includes(n.fm.status) || n.fm.id.startsWith("disputes/")) continue;
      const owner = rules.policy.areas?.[n.fm.area]?.owner ?? n.fm.by;
      const keys: string[] = [];
      for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
        if (isDisputed(f)) continue;
        for (const r of records(f)) {
          if (r.valid_to) continue;
          const fails = runChecks({ agent: owner, id: n.fm.id, attribute: attr, value: r.value, as_of: r.as_of, as_of_approx: r.as_of_approx, sources: r.sources, verification: r.verification, confidence: r.confidence }, enabled)
            .filter((x) => x.outcome === "refuse" && ["approval_needs_message_id", "source_matches_type", "source_resolvable"].includes(x.check));
          if (!fails.length) continue;
          const key = `${n.fm.id}#${attr}`;
          const to = fails.some((x) => x.check === "source_resolvable") ? "unverified" : "self-reported";
          if (r.verification === to) continue;
          if (!add({ rule: "stored-recheck", key, kind: "auto-fix", detail: `${r.verification} -> ${to} (${fails.map((x) => x.check).join(", ")}); re-confirm with a message id to restore it` })) continue;
          r.note = `${r.note ? r.note + "; " : ""}claimed ${r.verification}, downgraded ${now} by upkeep: ${fails.map((x) => x.reason).join("; ")}`;
          r.verification = to;
          keys.push(key);
        }
      }
      if (keys.length) {
        saveNote(root, n);
        commitFix(root, run, [n.fm.id + ".md"], `recheck ${n.fm.id}: authority it can't back up`, keys);
      }
    }
  }

  // 8b. A change reaches its neighbours (src/drift.ts, docs/wiki.md): a page whose fact changed, or
  //     a note linking to it, that still states the earlier value is a review line. The Gardener
  //     gets findings on the notes it sees (gardenerUpkeep filters by key), sometimes without their
  //     text or with a title or an earlier value carved from it, so a line names no page, fact,
  //     date or value; the owner opens the note.
  for (const d of staleMentions(loadBrain(root).filter((n) => !n.fm.id.startsWith("disputes/"))))
    add({ rule: "neighbour-drift", key: d.note, kind: "review", detail: d.note === d.page ? "the text still states an earlier value of one of this note's facts; update it or check it" : "the text still states a value that has since changed on a note it links to; update it or check it" });

  // 9. The wiki's lint (src/wiki.ts, docs/wiki.md): page and structure findings for review only.
  for (const f of wikiLint(loadBrain(root).filter((n) => !n.fm.id.startsWith("disputes/")))) add(f);

  // Findings go to inbox/reflect/<run>.md for the digest.
  const rel = `inbox/reflect/${run}.md`;
  mkdirSync(join(root, "inbox", "reflect"), { recursive: true });
  const group = (k: Finding["kind"]) => findings.filter((f) => f.kind === k).map((f) => `- [${f.rule}] \`${f.key}\`: ${f.detail}`);
  writeFileSync(join(root, rel), [
    `# Upkeep run ${run}`, "",
    `## Escalated to the owner (${group("escalate").length})`, "", ...group("escalate"), "",
    `## Fixed automatically (${group("auto-fix").length})`, "", "Each is its own commit; `pocketbrain undo --run " + run + "` reverts them all and suppresses the fixes.", "", ...group("auto-fix"), "",
    `## To review (${group("review").length})`, "", ...group("review"), "",
  ].join("\n"));
  git(root, ["add", rel]);
  git(root, ["commit", "-q", "-m", `reflect: findings for ${run}\n\nAgent: reflect\nRun: ${run}\nKind: findings`], "reflect");
  return { run, findings, file: rel };
}

function nextDispute(root: string): string {
  const dir = join(root, "disputes");
  const nums = existsSync(dir) ? readdirSync(dir).map((f) => Number(f.match(/^c-(\d+)\.md$/)?.[1] ?? 0)) : [];
  return `c-${String(Math.max(0, ...nums) + 1).padStart(4, "0")}`;
}

// A dispute opened outside the write path (a recheck, a merge): the packet Louis answers.
export function openDispute(root: string, n: Note, attr: string, cands: FactRecord[], intro: string): string {
  const id = nextDispute(root);
  writeDisputePacket(root, id, n, attr, cands, intro);
  return id;
}

function writeDisputePacket(root: string, id: string, n: Note, attr: string, cands: FactRecord[], intro = `A live recheck contradicts \`${n.fm.id}#${attr}\`.`) {
  const d = today();
  saveNote(root, {
    fm: { id: `disputes/${id}`, type: "dispute", title: `${n.fm.id}#${attr}`, area: n.fm.area, sensitivity: n.fm.sensitivity, status: "open", created: d, updated: d, by: "reflect", fact_key: `${n.fm.id}#${attr}`, step: 6, candidates: cands } as Note["fm"],
    body: `${intro} Upkeep doesn't pick a winner.\n\n${cands.map((c, i) => `${i + 1}. ${c.value} (as of ${c.as_of}, ${c.verification}, ${c.sources.map(refString).join(", ")})`).join("\n")}\n\nThe owner answers with the number.\n`,
    path: "",
  });
}

// `undo --run <id>`: one revert commit for every auto-fix of that run, plus suppressions so the
// next run doesn't re-apply them (backup-recovery.md 4.1, 4.2).
export function undoRun(root: string, run: string): string {
  const log = git(root, ["log", "--format=%H%x00%B%x01", "--grep", `^Run: ${run}$`]);
  const commits = log.split("\x01").map((x) => x.trim()).filter(Boolean).map((x) => {
    const [h, body] = x.split("\x00");
    return { h, body, keys: body.match(/^Fact-Keys: (.*)$/m)?.[1].split(", ") ?? [], kind: body.match(/^Kind: (.*)$/m)?.[1] };
  }).filter((c) => c.kind === "auto-fix");
  if (!commits.length) return `no auto-fix commits for ${run}`;
  for (const c of commits) {
    const r = Bun.spawnSync(["git", "revert", "--no-commit", c.h], { cwd: root });
    if (r.exitCode !== 0) { git(root, ["revert", "--abort"]); return `conflict reverting ${c.h.slice(0, 7)}: a later write touched the same file; listed for the owner`; }
  }
  // Rules that fired, per key, from the findings file of that run.
  const findingsFile = [join(root, "inbox", "reflect", `${run}.md`), join(root, "inbox", "sleep", `${run}.md`)].find((f) => existsSync(f)) ?? "";
  const fired = findingsFile ? [...readFileSync(findingsFile, "utf8").matchAll(/^- \[([a-z?-]+)\] `([^`]+)`/gm)] : [];
  const sup = loadSuppressions(root);
  const autoRules = new Set(["link-repoint", "link-mention", "date-format", "recheck-confirmed", "journal-archive", "stored-recheck", "retire"]);
  for (const [, rule, key] of fired) if (autoRules.has(rule) && !sup.some((s) => s.key === key && s.rule === rule)) sup.push({ key, rule, since: today(), why: `reverted ${run}` });
  mkdirSync(join(root, "rules"), { recursive: true });
  writeFileSync(join(root, "rules", "suppressions.yaml"), YAML.stringify({ suppressions: sup }, { lineWidth: 0 }));
  // The reverts are staged already; add only the suppressions, never whatever else sits in the
  // tree (queued texts, quotes in a worktree brain: G94).
  git(root, ["add", "rules/suppressions.yaml"]);
  git(root, ["commit", "-q", "-m", `undo ${run}: reverted ${commits.length} auto-fix commits and suppressed them`], OWNER);
  return `reverted ${commits.length} commits from ${run}; suppressions written`;
}

// Read-only live source backed by a JSON file of facts exported from Gmail or calendar,
// for dry runs: { "people/x#role": { "value": "...", "ref": "gmail:..." } }.
export function fileLiveSource(file: string): LiveSource {
  const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, { value: unknown; ref: string }>;
  return {
    name: "export",
    recheck: (n, attr, r) => {
      const e = data[`${n.fm.id}#${attr}`];
      if (!e) return undefined;
      return compareKey(e.value) === compareKey(r.value) ? { verdict: "confirms", ref: e.ref } : { verdict: "contradicts", value: e.value, ref: e.ref };
    },
  };
}


// What each live source says about each fact, as data: { "<id>#<attr>": { value, ref } } with
// the source's own value (for a confirmation, the value it confirmed). The same shape as
// fileLiveSource reads, so the hub re-judges it against its own current value.
export function recordRechecks(root: string, live: LiveSource[]): Record<string, { value: unknown; ref: string; source: string }> {
  const out: Record<string, { value: unknown; ref: string; source: string }> = {};
  for (const src of live) for (const n of loadBrain(root)) for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
    if (isDisputed(f) || "items" in (f as object)) continue;
    const res = src.recheck(n, attr, f as FactRecord);
    if (res) out[`${n.fm.id}#${attr}`] = { value: res.verdict === "confirms" ? (f as FactRecord).value : res.value, ref: res.ref, source: src.name };
  }
  return out;
}

export function recordedSource(name: string, data: Record<string, { value: unknown; ref: string }>): LiveSource {
  return {
    name,
    recheck: (n, attr, r) => {
      const e = data[`${n.fm.id}#${attr}`];
      if (!e || typeof e.ref !== "string") return undefined;
      return compareKey(e.value) === compareKey(r.value) ? { verdict: "confirms", ref: e.ref } : { verdict: "contradicts", value: e.value, ref: e.ref };
    },
  };
}

// The hub applies an upkeep run a replica queued: the rule passes on the hub's notes, plus the
// replica's recorded rechecks. Same run id, so `undo --run` works on it.
export function applyUpkeepOp(root: string, by: string, payload: Record<string, unknown>): WriteResult {
  if (by !== "reflect") return { outcome: "refused", message: `upkeep runs as reflect, not ${by}` };
  const run = String(payload.run ?? "");
  if (!/^reflect-[0-9T-]{19}$/.test(run)) return { outcome: "refused", message: `bad run id ${run}` };
  if (existsSync(join(root, "inbox", "reflect", `${run}.md`))) return { outcome: "noop", message: `${run} already ran` };
  const live = (payload.live ?? {}) as Record<string, { value: unknown; ref: string; source?: string }>;
  const r = upkeep(root, { run, live: Object.keys(live).length ? [recordedSource(`recorded on a replica (${[...new Set(Object.values(live).map((x) => x.source ?? "export"))].join(", ")})`, live)] : [] });
  return { outcome: "committed", message: `${run}: ${r.findings.length} findings -> ${r.file}` };
}
