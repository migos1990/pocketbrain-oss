// SPDX-License-Identifier: AGPL-3.0-only
// The north-star eval (outside review 2026-10-25): does the brain build its own wiki and ask the
// owner only about contradictions? Two numbers, the same two for a replayed week and for the real brain:
//   asks           what the owner must decide (every open item but an alert or an assistant's mail
//                  request, src/textline/items.ts openItems, 36 h after the last day, so a conflict
//                  held for the night pass counts once its fallback releases it; minus what the
//                  hub files on its own, src/filing.ts autoSaves). One counted list (audit v10,
//                  2026-11-01): an item held by a rule (held_by_access, held_by_capture,
//                  held_by_ambiguity below) still waits for the owner, so it is an ask; those lines
//                  only say why. Each value the serving hold keeps until the owner taps Show it
//                  is an ask too (held_by_serving; G626, the owner's "i trust u" of 2026-11-02
//                  00:18Z and the coordinator's pick, as G618). The list is src/waiting.ts
//                  ownerAsks, the one the home counts. An assistant's proposal held until a day (assistant_held) or left to
//                  expire (assistant_expiring) leaves on its own, so it is not.
// What it counts is the owner's to change: a change to what this file counts as an ask, as a
// page that passes, or to what makes it pass needs the owner's own typed word in a thread, never a
// coordinator's or a thread's call (audit v10: three commits on 2026-11-01 took held items out of
// asks without it). A test that pins these numbers changes only with that word.
//   pages_ok       share of the pages touched that week (or yesterday) that end the night with
//                  cited prose (a body sentence plus a footnote naming a source), at least one
//                  inbound [[link]] from another active page, and more than the hub's own text:
//                  prose beyond its written-from-facts lead, or a source's own words shown to the
//                  owner on the page (audit v5, midday: the writer's templates no longer count alone)
//                  A page whose facts were all ended (set aside, taken back) isn't counted (G520).
// Also printed, not part of pass (re-audit 2026-10-25): brain commits in the window, how many say
// why (a "Why:" line in the message), and how many of them the Gardener made; and of the pages that
// pass, how many have prose beyond the hub's text and how many show a source's words.
//   home_asks      what the owner's home screen counts as waiting (waitingCount in
//                  src/dashboard/home.ts: conflicts, held values, held mail, and one card that
//                  counts what waits on Settings), the same list as asks (G626). home_asked lists
//                  the home's conflicts by fact.
//   assistant_held a core assistant's own proposals held until a day (src/filing.ts
//                  the owner's hold_assistants_until), when they file; and assistant_expiring, an outside
//                  assistant's that expire unconfirmed. Queues with a day, not asks: printed apart
//   held_by_access an assistant's write the write path held for the owner because that assistant
//                  can't see all of the page (invariant 3, "not_in_your_view") and that contradicts
//                  nothing the page holds (no differing live value): the access rule working, not a
//                  filing failure. Waits on Settings, never the home; an ask (G598). One whose
//                  value differs is a conflict the home lists, so it counts as an ask about one.
//   held_by_capture an assistant's own capture (not the capture agent's or the owner's) that cites
//                  a source and is about a person: the source-save rule waits for the owner
//                  ("It's about a person"), kept under the scope freeze. Waits on Settings, never the
//                  home; an ask (G600).
//   held_by_ambiguity a proposal by a name that fits a page the brain has as well as a new one
//                  ("new or same as …?"): the hub never guesses which. Waits on Settings, never the
//                  home; an ask (G603).
//   bun scripts/north-star.ts                  replay a fixed week on the shipped default rules
//   bun scripts/north-star.ts --file-all       the same week with auto_decide file: all on, to compare
//   bun scripts/north-star.ts --brain <path>   the same two numbers for a real brain (read-only, counts only;
//                                              --json prints the counts as one line; the hub records
//                                              that after every start, so after every deploy: src/probe.ts)
// The replay: `pocketbrain init` defaults, a Gmail source on a fixture, 50 facts over 7 days, 3 of
// them planted contradictions (two senders, same day, different value). Most senders are people the
// owner knows (their address on their page, his word); one fact comes from an address no page holds,
// and one person's page starts the week with a lead the owner imported, not one the hub wrote.
// On day 8 the owner corrects one fact in their own words (phone UI spec §11): it must file, and
// it never asks.
// Pass (audit v3, 2026-10-26: a count alone passed by luck) = every ask is about a planted
// contradiction, each planted contradiction is asked exactly once, the saves the hub planned all
// land, the imported page ends with cited prose, and pages_ok >= 80%. scripts/gate.ts runs it and
// blocks a merge on a fail (NORTH_STAR_BLOCKING).
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initBrain } from "../src/init";
import { loadBrain, linksIn, slugify, isDisputed, isList, CONTENT_DIRS, type Note, type FactRecord } from "../src/brain";
import { footnotes, refsIn, MADE } from "../src/wiki";
import { makeModel, type ModelRequest } from "../src/model";
import { pullSource } from "../src/pull";
import { runAuto } from "../src/filing";
import { loadRules, isGardener } from "../src/rules";
import { ownerSay } from "../src/owner-say";
import { ownerConflicts } from "../src/core";
import { loadState, type State } from "../src/dashboard/data";
import { ownerPage } from "../src/dashboard/html-page";
import { waitingCount } from "../src/dashboard/home";
import { ownerAsks, changesHeld } from "../src/waiting";
import YAML from "yaml";

export interface WhyCounts { commits: number; with_why: number; gardener: number; gardener_why: number }
export interface NorthStar { asks: number; asks_by_kind: Record<string, number>; asked: string[]; not_conflict: number; assistant_held: number; assistant_expiring: number; held_by_access: number; held_by_capture: number; held_by_ambiguity: number; home_asks: number; home_asked: string[]; planted: number; pages: number; pages_ok: number; prose: number; inbound: number; share: number; pages_beyond_hub: number; pages_quoted: number; pass: boolean; notes: string[]; why?: WhyCounts; owner_corrected?: boolean }
export const BAR = { share: 0.8 };

// ---------- the two numbers, from any brain ----------

// Wiki pages: not a conflict packet or an agent's own notes, which nobody reads as a page.
const isContent = (n: Note) => CONTENT_DIRS.some((d) => d !== "disputes" && d !== "agents" && n.path.startsWith(`${d}/`)) && n.fm.status !== "archived";

const emptied = (n: Note) => Object.keys(n.fm.history ?? {}).length > 0 && !Object.values(n.fm.facts ?? {}).some((f) => (isDisputed(f) ? f.candidates : isList(f) ? f.items : [f as FactRecord]).some((r) => r && !r.valid_to && !r.retired));

// Cited prose: some body text outside the footnotes, and a footnote that names a source ref.
export function citedProse(n: Note): boolean {
  const { text, notes } = footnotes(n.body ?? "");
  const prose = text.replace(/^#.*$/gm, "").replace(/\[\^[^\]]+\]/g, "").trim();
  return prose.split(/\s+/).filter(Boolean).length >= 5 && notes.some((f) => refsIn(f.text).length > 0);
}

// Prose someone or something other than the hub's page writer wrote: the body less the writer's
// own lead (the paragraph ending with MADE) and its footnotes. The writer turns a page's facts into
// sentences, so a page passing on its lead alone shows coverage, not that anyone summarized it.
export function proseBeyondHub(n: Note): boolean {
  const { text } = footnotes(n.body ?? "");
  // The made-by line is its own paragraph right after the writer's lead (G559); an older page has
  // it at the end of the lead.
  const paras = text.split(/\n\s*\n/);
  const rest = paras.filter((p, i) => !p.includes(MADE) && paras[i + 1]?.trim() !== MADE).join("\n").replace(/^#.*$/gm, "").replace(/\[\^[^\]]+\]/g, "").trim();
  return rest.split(/\s+/).filter(Boolean).length >= 5;
}
// The owner's page shows the source's own words under a reference (G451, kept outside git): counted
// from that page as the owner sees it, never from the kept files (the owner's condition, 2026-10-27).
export const quotesSource = (s: State, n: Note): boolean => /<details class="quote">/.test(ownerPage(s, "", n, []));

export function inboundLinks(notes: Note[]): Map<string, number> {
  const byKey = new Map<string, string>();
  for (const n of notes) { byKey.set(n.fm.id, n.fm.id); if (n.fm.title) byKey.set(String(n.fm.title).toLowerCase(), n.fm.id); }
  const inbound = new Map<string, number>();
  for (const n of notes) {
    if (!isContent(n)) continue;
    const to = new Set(linksIn(n.body ?? "").map((l) => byKey.get(l) ?? byKey.get(l.toLowerCase())).filter((x): x is string => !!x && x !== n.fm.id));
    for (const id of to) inbound.set(id, (inbound.get(id) ?? 0) + 1);
  }
  return inbound;
}

// The fact an open decision is about: a conflict's fact_key, a proposal's id#attribute.
function askedKey(root: string, i: { kind: string; ref: string }): string {
  try {
    if (i.kind === "dispute") return String((loadBrain(root).find((n) => n.fm.id === `disputes/${i.ref}`)?.fm as { fact_key?: unknown } | undefined)?.fact_key ?? i.ref);
    if (i.kind === "proposal") { const r = (YAML.parse(readFileSync(join(root, "inbox", i.ref), "utf8")) as { request?: { id?: string; attribute?: string } }).request; return r?.id && r.attribute ? `${r.id}#${r.attribute}` : i.ref; }
  } catch { /* unreadable: the ref itself */ }
  return i.ref;
}

// Pages whose file changed in commits since `since`, up to `until` when given (git, paths only).
export function touchedSince(root: string, since: string, until?: string): Set<string> {
  const r = Bun.spawnSync(["git", "-C", root, "log", `--since=${since}`, ...(until ? [`--until=${until}`] : []), "--name-only", "--format="], { stdout: "pipe", stderr: "pipe" });
  return new Set(r.stdout.toString().split("\n").filter((p) => p.endsWith(".md")));
}

// Commits since `since`, by author name; a commit says why when its message has a "Why:" line.
export function whyCounts(root: string, since: string, isGardener: (author: string) => boolean): WhyCounts {
  const r = Bun.spawnSync(["git", "-C", root, "log", `--since=${since}`, "--format=%an%x00%B%x1e"], { stdout: "pipe", stderr: "pipe" });
  const out: WhyCounts = { commits: 0, with_why: 0, gardener: 0, gardener_why: 0 };
  for (const c of r.stdout.toString().split("\x1e").map((x) => x.trim()).filter(Boolean)) {
    const [author, body = ""] = c.split("\0");
    const why = /^Why: \S/m.test(body), g = isGardener(author);
    out.commits++; if (why) out.with_why++; if (g) out.gardener++; if (g && why) out.gardener_why++;
  }
  return out;
}

// The day the real brain is measured over: the 24 hours up to the last nightly run (upkeep's
// findings commit, src/upkeep.ts), since pages "end the night" with prose and a page changed after
// that run hasn't been written yet (G672; pages-ok part 3). With no run in the last 36 hours, the
// last 24 hours.
export function nightWindow(root: string, now: Date): { since: string; until: string } {
  const r = Bun.spawnSync(["git", "-C", root, "log", "-1", "--author=reflect", "--grep=^Kind: findings$", "--format=%cI"], { stdout: "pipe", stderr: "pipe" });
  const at = Date.parse(r.stdout.toString().trim());
  const end = Number.isFinite(at) && at <= now.getTime() && now.getTime() - at <= 36 * 3_600_000 ? at : now.getTime();
  return { since: new Date(end - 86_400_000).toISOString(), until: new Date(end).toISOString() };
}

export function measure(root: string, since: string, now: Date, planted = 0, until?: string): NorthStar {
  const notes = loadBrain(root);
  const touched = touchedSince(root, since, until);
  // A page whose facts were all ended (set aside or taken back, as receipts were after 0.2.0; G520) has
  // nothing left to write a page from: it isn't counted. A page that never had facts still is.
  const pages = notes.filter((n) => isContent(n) && touched.has(n.path) && !emptied(n));
  const inbound = inboundLinks(notes);
  const prose = pages.filter(citedProse).length;
  const linked = pages.filter((n) => (inbound.get(n.fm.id) ?? 0) > 0).length;
  const linkedProse = pages.filter((n) => citedProse(n) && (inbound.get(n.fm.id) ?? 0) > 0);
  const state = linkedProse.length ? loadState(root, now) : undefined;
  const okPages = linkedProse.filter((n) => proseBeyondHub(n) || quotesSource(state!, n));
  const ok = okPages.length;
  // Every item that waits on the owner, one counted list with the home (src/waiting.ts, G626): open
  // decisions the hub won't file on its own, the other cards that ask, captures held past their day,
  // and each value the serving hold keeps for Show it (held_by_serving).
  const later = new Date(now.getTime() + 36 * 3_600_000);
  const own = ownerAsks(root, now, later);
  const { by, waiting, queues, homeConflicts } = own;
  const asked = waiting.map((i) => askedKey(root, i));
  // Asks that aren't about a contradiction: a proposal counts as one only when it changes a value
  // the brain holds (its reason says "changes <attribute> from", or the home lists it as a
  // conflict); every other card kind doesn't.
  const changes = waiting.filter((i) => i.kind === "dispute" || (i.kind === "proposal" && (changesHeld(root, i.ref) || homeConflicts.has(i.ref)))).length;
  // An assistant's own proposals: held until their day, or left to expire (outside review v5,
  // midday: a label with no date left 6 as asks forever). Queues, so never in asks; their own line.
  const assistant_held = queues.held.size, assistant_expiring = queues.expiring.size;
  const asks = Object.values(by).reduce((a, b) => a + b, 0);
  const share = pages.length ? ok / pages.length : 0;
  // What the phone UI's home lists (the only screen that asks): its own count of what waits
  // (conflicts, held values, held mail), and its conflicts by fact.
  const home_asked = ownerConflicts(root, later, { held: true }).map((c) => `${c.page}#${c.attr}`);
  const home_asks = waitingCount(root, later, own);
  const rules = loadRules(root);
  const why = whyCounts(root, since, (a) => isGardener(rules, a));
  return { asks, asks_by_kind: by, asked, not_conflict: asks - changes, assistant_held, assistant_expiring, held_by_access: by.held_by_access ?? 0, held_by_capture: by.held_by_capture ?? 0, held_by_ambiguity: by.held_by_ambiguity ?? 0, home_asks, home_asked, planted, pages: pages.length, pages_ok: ok, prose, inbound: linked, share, pages_beyond_hub: okPages.filter(proseBeyondHub).length, pages_quoted: okPages.filter((n) => quotesSource(state!, n)).length, pass: asks === planted && share >= BAR.share, notes: [], why };
}

// ---------- the fixed week ----------

interface Fact { day: number; entity: string; type: "person" | "project"; attribute: string; value: string; sentence: string; from: number; planted?: boolean }

// The owner's own correction on day 8: Chloe Martin's org (River Lab all week, from mail).
const CORRECTION = { name: "Chloe Martin", value: "Lake Centre" };
const UNKNOWN = 6; // colleague6: on no person page
// A page the owner imported before the week, with its own lead (the real brain's import line, as
// G436 found it): the hub's writer must still give it cited prose once its facts change.
const LEGACY = { id: "people/fay-wong", body: "Imported from your notes.[^1]\n\n[^1]: Your notes, 2026-09-01\n" };
const PEOPLE = ["Ana Diaz", "Ben Okafor", "Chloe Martin", "Dev Patel", "Eli Novak", "Fay Wong"];
const PROJECTS = ["Harbor Study", "Spring Course", "Garden Grant", "Library Move"];
const ROLES = ["program director", "teaching assistant", "grant officer", "lab manager", "course coordinator", "research fellow"];
// No org name holds a word the privacy rule reads as someone's health, school, legal or money matter
// (src/checks.ts SENSITIVE_WORDS): "Hill School" made Dev Patel's page private by accident, so a
// planted contradiction reached the owner as a page-private card, which the home never lists
// (audit v4). That path is tested on purpose in test/private-conflict-kept.test.ts.
const ORGS = ["North College", "City Library", "River Lab", "Hill Studio", "Bay Institute", "Lake Centre"];
const STEPS = [["book the main room", "send the room plan", "print the handouts"], ["send the draft budget", "collect the budget sign-off", "file the final budget"],
  ["collect the signed forms", "submit the grant forms", "answer the funder questions"], ["confirm the movers", "pack the archive boxes", "label the new shelves"]];

// Only attributes the shipped rules capture (rules/checks.yaml from init: person role, org,
// last_contact; project next_step). 44 facts that agree or move a value forward in time, and 3
// contradictions planted as pairs: two senders, the same day, two values for one fact (50 facts).
// Every sentence names another page, as real mail does, so a wiki that links names has edges.
export function week(): Fact[] {
  const out: Fact[] = [];
  PEOPLE.forEach((p, k) => out.push({ day: 1 + (k % 2), entity: p, type: "person", attribute: "role", value: ROLES[k], sentence: `${p} is now the ${ROLES[k]} for the ${PROJECTS[k % 4]} team this term`, from: k }));
  PEOPLE.forEach((p, k) => out.push({ day: 2 + (k % 2), entity: p, type: "person", attribute: "org", value: ORGS[k], sentence: `${p} works at ${ORGS[k]} and sees ${PEOPLE[(k + 1) % 6]} there most weeks`, from: k }));
  for (const d of [3, 4, 6]) PEOPLE.forEach((p, k) => out.push({ day: d, entity: p, type: "person", attribute: "last_contact", value: `2026-10-${String(5 + d).padStart(2, "0")}`, sentence: `Sam met ${p} on 2026-10-${String(5 + d).padStart(2, "0")} to talk about the ${PROJECTS[(k + d) % 4]} plan`, from: k }));
  // The Library Move's first step comes from an address no page holds (UNKNOWN): an ordinary fact
  // from a stranger files like any other (G429); only a private or money one waits.
  PROJECTS.forEach((p, k) => STEPS[k].forEach((step, j) => out.push({ day: 1 + j * 2, entity: p, type: "project", attribute: "next_step", value: step, sentence: `For the ${p} the next step is to ${step} with ${PEOPLE[(k + j) % 6]}`, from: k === 3 && j === 0 ? UNKNOWN : (k + j) % 6 })));
  out.push({ day: 5, entity: "Ana Diaz", type: "person", attribute: "role", value: "dean of studies", sentence: "Ana Diaz is now the dean of studies for the Harbor Study team this term", from: 1 });
  out.push({ day: 5, entity: "Eli Novak", type: "person", attribute: "role", value: "facilities lead", sentence: "Eli Novak is now the facilities lead for the Library Move team this term", from: 2 });
  // The planted contradictions: nothing tells which value is right, so the owner is asked.
  const pair = (entity: string, type: Fact["type"], attribute: string, a: string, b: string, say: (v: string) => string, from: [number, number]) => {
    out.push({ day: 7, entity, type, attribute, value: a, sentence: say(a), from: from[0] });
    out.push({ day: 7, entity, type, attribute, value: b, sentence: say(b), from: from[1], planted: true });
  };
  pair("Ben Okafor", "person", "role", "outreach lead", "senior assistant", (v) => `Ben Okafor is now the ${v} for the Spring Course team this term`, [3, 4]);
  pair("Spring Course", "project", "next_step", "book the exam hall", "cancel the exam hall", (v) => `For the Spring Course the next step is to ${v} with Fay Wong`, [0, 5]);
  pair("Dev Patel", "person", "org", "Bay Institute", "Lake Centre", (v) => `Dev Patel works at ${v} and sees Eli Novak there most weeks`, [2, 1]);
  return out;
}

const START = Date.parse("2026-10-05T09:00:00Z");
const at = (day: number, k: number) => new Date(START + day * 86_400_000 + k * 60_000);
const sender = (k: number) => `colleague${k}@example.org`;
const OWNER_ADDR = "sam@example.org";
const hex = (n: number) => n.toString(16).padStart(16, "0");

// fileAll: also turn on `auto_decide: { file: all }` (the owner's own hub, 2026-10-25), to compare.
export async function replay(o: { fileAll?: boolean } = {}): Promise<NorthStar> {
  const root = mkdtempSync(join(tmpdir(), "pb-north-star-"));
  const env = { PB_TODAY: process.env.PB_TODAY, PB_NOW: process.env.PB_NOW };
  try {
    initBrain(root, { owner: "Sam Lee", me: [OWNER_ADDR], token: false });
    writeFileSync(join(root, "rules", "sources.yaml"), `consent: north-star replay\nsources:\n  mail:\n    kind: gmail\n    fixture: week.json\n`);
    if (o.fileAll) writeFileSync(join(root, "rules", "escalation.yaml"), "auto_decide:\n  file: all\n");
    // The owner's own setup, committed as the owner does: left uncommitted it raised a "rules/
    // changed outside git" card that counted as one of the asks.
    Bun.spawnSync(["git", "-C", root, "add", "rules"]); Bun.spawnSync(["git", "-C", root, "commit", "-qm", "owner: replay sources", "--", "rules"]);
    const facts = week();
    const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => JSON.stringify({ facts: facts.filter((f) => r.prompt.includes(f.sentence)).map((f) => ({ entity: f.entity, type: f.type, attribute: f.attribute, value: f.value, quote: f.sentence })) }) });
    const mails: Record<string, unknown>[] = [];
    // Day 0: every sender is someone the owner knows: colleague k is PEOPLE[k], whose page holds
    // that address on the owner's word (src/sender.ts; whom the owner wrote to never vouches for a
    // sender, invariant 14). The owner also writes to each once, as real mail would show.
    PEOPLE.forEach((p, k) => {
      const id = `people/${slugify(p)}`;
      mkdirSync(join(root, "people"), { recursive: true });
      writeFileSync(join(root, `${id}.md`), `---\nid: ${id}\ntype: person\ntitle: ${p}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: owner\nfacts:\n  email: { value: "${sender(k)}", as_of: 2026-10-01, sources: ["owner:2026-10-01/setup"], verification: confirmed-by-owner, by: owner, recorded: 2026-10-01 }\n---\n${id === LEGACY.id ? LEGACY.body : ""}`);
    });
    Bun.spawnSync(["git", "-C", root, "add", "people"]); Bun.spawnSync(["git", "-C", root, "commit", "-qm", "owner: the people the owner knows", "--", "people"]);
    for (let k = 0; k < 6; k++) mails.push({ id: hex(0x5e00 + k), threadId: hex(0x5e00 + k), internalDate: String(at(0, k).getTime()), labelIds: ["SENT"], payload: { headers: [{ name: "From", value: `Sam Lee <${OWNER_ADDR}>` }, { name: "To", value: sender(k) }, { name: "Subject", value: "Hello" }] }, text: "Hello, thanks for the meeting today, talk soon." });
    let wiki: { renderTouchedPages?: (root: string, since: string) => unknown } = {};
    try { wiki = await import("../src/wiki") as typeof wiki; } catch { /* none */ }
    const notes: string[] = [];
    if (typeof wiki.renderTouchedPages !== "function") notes.push("no page writer yet (src/wiki.ts renderTouchedPages): pages get prose only from the Gardener, which the replay can't run");
    const since = new Date(START).toISOString();
    for (let d = 0; d <= 7; d++) {
      const today = facts.filter((f) => f.day === d);
      today.forEach((f, k) => mails.push({ id: hex(0xa000 + d * 100 + k), threadId: hex(0xa000 + d * 100 + k), internalDate: String(at(d, 10 + k).getTime()), labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: `C ${f.from} <${sender(f.from)}>` }, { name: "To", value: OWNER_ADDR }, { name: "Subject", value: `${f.entity} update` }] }, text: `Hi Sam, a quick update for your records. ${f.sentence}. Thanks and talk soon.` }));
      writeFileSync(join(root, "week.json"), JSON.stringify(mails));
      const now = at(d, 600);
      process.env.PB_TODAY = now.toISOString().slice(0, 10);
      process.env.PB_NOW = now.toISOString();
      await pullSource(root, "mail", { model });
      // The hub's tick (file everything, where the shipped rules turn it on) and the night pass.
      runAuto(root, now);
      if (typeof wiki.renderTouchedPages === "function") wiki.renderTouchedPages(root, new Date(now.getTime() - 86_400_000).toISOString());
    }
    // Day 8 (phone UI spec §11): the owner corrects one fact in their own words in the home's box.
    // Their word is not a conflict: it files, and the asks stay at the planted count.
    const day8 = at(8, 600);
    process.env.PB_TODAY = day8.toISOString().slice(0, 10);
    process.env.PB_NOW = day8.toISOString();
    const said = ownerSay(root, `${CORRECTION.name} moved to ${CORRECTION.value}`);
    runAuto(root, day8);
    if (typeof wiki.renderTouchedPages === "function") wiki.renderTouchedPages(root, new Date(day8.getTime() - 86_400_000).toISOString());
    const end = at(8, 900);
    process.env.PB_NOW = end.toISOString();
    const m = measure(root, since, end, facts.filter((f) => f.planted).length);
    const corrected = (loadBrain(root).find((n) => n.fm.id === `people/${slugify(CORRECTION.name)}`)?.fm.facts?.org as { value?: unknown } | undefined)?.value;
    m.owner_corrected = String(corrected ?? "").includes(CORRECTION.value);
    if (!m.owner_corrected) { m.pass = false; m.notes.push(`the owner's day-8 correction didn't file (${said.kind}: ${said.text})`); }
    m.notes.push(...notes);
    // Every ask names a planted contradiction, and each is asked once (a count alone passed by luck:
    // audit v3 found a private-page conflict standing in for one).
    const keyOf = (f: Fact) => `${f.type === "person" ? "people" : "projects"}/${slugify(f.entity)}#${f.attribute}`;
    const want = facts.filter((f) => f.planted).map(keyOf);
    const extra = m.asked.filter((k) => !want.includes(k));
    const missed = want.filter((k) => m.asked.filter((x) => x === k).length !== 1);
    if (extra.length) { m.pass = false; m.notes.push(`asked about ${extra.length} fact(s) nobody contradicted: ${extra.join(", ")}`); }
    if (missed.length) { m.pass = false; m.notes.push(`planted contradiction(s) not asked exactly once: ${missed.join(", ")}`); }
    // The phone UI asks only on its home (spec §2.1): each planted contradiction must be listed there.
    const offHome = want.filter((k) => m.home_asked.filter((x) => x === k).length !== 1);
    if (offHome.length) { m.pass = false; m.notes.push(`planted contradiction(s) not on the owner's home exactly once: ${offHome.join(", ")}`); }
    const legacy = loadBrain(root).find((n) => n.fm.id === LEGACY.id);
    if (!legacy || !citedProse(legacy)) { m.pass = false; m.notes.push(`${LEGACY.id} (an imported lead) ended the week without cited prose`); }
    // Saves the hub planned and couldn't make (the fixture's own facts, so the reason can be printed).
    const errs = new Map<string, number>();
    for (const l of (existsSync(join(root, "log", "auto-decisions-errors.jsonl")) ? readFileSync(join(root, "log", "auto-decisions-errors.jsonl"), "utf8") : "").split("\n").filter(Boolean)) {
      const why = String((JSON.parse(l) as { error?: string }).error ?? "?").slice(0, 80);
      errs.set(why, (errs.get(why) ?? 0) + 1);
    }
    for (const [why, n] of errs) m.notes.push(`${n} planned save(s) refused: ${why}`);
    // A save the hub planned and couldn't make is a defect in the shipped defaults (a fresh init's
    // capture agent missing from its policy refused 83 of them, 2026-10-25), never a pass.
    if (errs.size) m.pass = false;
    return m;
  } finally {
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(root, { recursive: true, force: true });
  }
}

export const counts = (m: NorthStar) => ({ pass: m.pass, asks: m.asks, asks_by_kind: m.asks_by_kind, not_conflict: m.not_conflict, assistant_held: m.assistant_held, assistant_expiring: m.assistant_expiring, held_by_access: m.held_by_access, held_by_capture: m.held_by_capture, held_by_ambiguity: m.held_by_ambiguity, home_asks: m.home_asks, pages: m.pages, pages_ok: m.pages_ok, share: Math.round(m.share * 100) / 100, pages_beyond_hub: m.pages_beyond_hub, pages_quoted: m.pages_quoted });

export function report(m: NorthStar, label: string): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const kinds = Object.entries(m.asks_by_kind).map(([k, n]) => `${k} ${n}`).join(", ");
  return [
    `north star (${label}): ${m.pass ? "PASS" : "FAIL"}`,
    `  asks: ${m.asks}${m.planted ? ` (want exactly ${m.planted}, the planted contradictions)` : ""}${kinds ? `: ${kinds}` : ""}`,
    `  asks the home screen lists: ${m.home_asks}${m.asks > m.home_asks ? ` (${m.asks - m.home_asks} wait on Settings)` : ""}`,
    `  held until your hold on assistants' proposals ends: ${m.assistant_held} assistant proposal(s); ${m.assistant_expiring} more expire unconfirmed (not asks)`,
    `  held by access: ${m.held_by_access} assistant proposal(s) on a page that assistant can't fully see, contradicting nothing; they wait on Settings (counted in asks)`,
    `  held by capture: ${m.held_by_capture} assistant capture(s) about a person, citing a source, that wait for you by rule; they wait on Settings (counted in asks)`,
    `  held by ambiguity: ${m.held_by_ambiguity} proposal(s) by a name that fits a page you have as well as a new one; the hub never guesses, so they wait on Settings (counted in asks)`,
    `  pages touched: ${m.pages}; with cited prose, an inbound link and more than the hub's own text: ${m.pages_ok} (${pct(m.share)}, want >= ${pct(BAR.share)}); cited prose ${m.prose}, inbound link ${m.inbound}`,
    `  of those ${m.pages_ok}: ${m.pages_beyond_hub} with prose beyond the hub's own written-from-facts text, ${m.pages_quoted} showing the owner a source's own words`,
    ...(m.why ? [`  commits: ${m.why.commits}, ${m.why.with_why} saying why; the Gardener's: ${m.why.gardener}, ${m.why.gardener_why} saying why (reported, not in pass)`] : []),
    ...m.notes.map((n) => `  note: ${n}`),
  ].join("\n");
}

if (import.meta.main) {
  const i = Bun.argv.indexOf("--brain");
  if (i >= 0) {
    const root = Bun.argv[i + 1];
    if (!root || !existsSync(join(root, "rules"))) { console.error("--brain <path to a brain>"); process.exit(2); }
    const now = new Date();
    const day = nightWindow(root, now);
    const m = measure(root, day.since, now, 0, day.until);
    // No planted answer key here: an ask passes when it is about a contradiction (a conflict, or a
    // proposal to change a value the brain holds); anything else is an ask the north star rules out.
    const notConflict = m.not_conflict;
    const pass = m.share >= BAR.share && notConflict === 0;
    // --json: counts only, no page names (the hub records it after each start: src/probe.ts).
    if (Bun.argv.includes("--json")) { console.log(JSON.stringify(counts({ ...m, pass }))); process.exit(pass ? 0 : 1); }
    console.log(report({ ...m, pass, notes: [...m.notes, `${notConflict} ask(s) not about a contradiction`] }, "real brain, pages touched in the day up to the last nightly run; asks are today's cards"));
    process.exit(pass ? 0 : 1);
  }
  const fileAll = Bun.argv.includes("--file-all");
  const m = await replay({ fileAll });
  console.log(report(m, fileAll ? "replayed week, default rules + file: all" : "replayed week, shipped default rules"));
  process.exit(m.pass ? 0 : 1);
}
