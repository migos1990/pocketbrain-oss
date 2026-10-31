// SPDX-License-Identifier: AGPL-3.0-only
// Family by surname (owner's phone, 2026-10-31: his father's page, same surname as his, said
// "Nothing written here yet" and linked nowhere; G546). A person page named with a first name of its
// own and the owner's surname gets one fact, `family`, whose value links the owner's page: inferred,
// inferred from the two names alone, so it cites no source of its own ("unverified"), filed by upkeep in one hub
// commit with a diary line and Undo. The page text then links the owner's page, and the owner's page
// links back. Never on the owner's own page or a namesake's, never where the page already says how
// the owner knows them (relationship) or holds a family fact, never on a title and surname alone
// ("M. Lake" may be the owner), and never twice: an Undo holds. Nothing asks.
// It copies no other fact's refs (builder's slice audits of b532242, b1619f30, da6497e0): a ref
// copied once would outlive a later tightening of the fact it came from. A fact some reader of it
// can't see never stops it, and an assistant whose view can't be built stops it for every page
// (fails closed). Off until the owner turns it on
// (`pocketbrain wiki family on`, policy family_links); off, upkeep only counts the pages. Each fact
// it files has its line in log/writes.jsonl.
import { loadBrain, saveNote, today, isDisputed, sensitivityRank, type Note, type FactRecord } from "./brain";
import { records, carve, grantFor } from "./carve";
import { appendDiary, diaryRow, readDiary } from "./diary";
import { commitPaths } from "./git";
import { clock, ownerDay } from "./clock";
import { loadRules, type Rules } from "./rules";
import { ownerOf, ownerTitle } from "./capture";
import { personKey, titleKind, logWrite } from "./write";

const live = (r: FactRecord) => !r.valid_to && !r.retired;
// A record every reader of the page sees as the page shows it.
const open = (n: Note) => (r: FactRecord) => live(r) && !r.share_with && !r.unseen && sensitivityRank(r.sensitivity ?? n.fm.sensitivity) <= sensitivityRank(n.fm.sensitivity);
const INACTIVE = new Set(["archived", "merged", "superseded"]);
const SAYS_WHO = ["family", "relationship"];

// `done`: pages upkeep already filed once (their diary lines), left alone from then on.
export function familyPages(rules: Rules, notes: Note[], done: ReadonlySet<string> = new Set()): { id: string; owner: string; sources: string[] }[] {
  const title = ownerTitle(rules);
  const self = title ? ownerOf(rules, notes, title)?.page : undefined;
  if (!title || !self) return [];
  const mine = personKey(title).split(" ");
  // Who reads which page: the link names the owner's page, so it goes only where every assistant
  // that reads the page also reads the owner's (a hidden page answers like a missing one).
  const views: ReturnType<typeof carve>[] = [];
  for (const agent of Object.keys(rules.policy.agents ?? {})) {
    try { views.push(carve(notes, rules, grantFor(rules, agent), { flags: false })); } catch { return []; }
  }
  const out: { id: string; owner: string; sources: string[] }[] = [];
  for (const n of notes) {
    if (n.fm.type !== "person" || n.fm.id === self || INACTIVE.has(String(n.fm.status)) || done.has(n.fm.id) || titleKind(n.fm.title)) continue;
    const name = personKey(n.fm.title).split(" ");
    if (name.length < 2 || name.at(-1) !== mine.at(-1) || name[0] === mine[0] || ownerOf(rules, notes, String(n.fm.title))) continue;
    const facts = n.fm.facts ?? {};
    // A fact any reader of the page has carved away (an exclude by name, a slice's attributes, a
    // fact's own level or share_with) neither feeds the link nor stops it: the carve decides, the
    // way it decides what each assistant reads (builder's slice audit of b1619f30).
    // Only the assistants that would read the family fact itself count (a contacts slice that
    // shows a person's name and address and not "family" never sees its refs).
    const readers = views.filter((v) => { const a = v.visible.get(n.fm.id)?.attributes; return !!a && (a === "all" || a.has("family")); });
    const hidden = new Set(readers.flatMap((v) => v.hiddenFacts.filter((h) => h.key.startsWith(`${n.fm.id}#`)).map((h) => h.key.slice(n.fm.id.length + 1))));
    if (SAYS_WHO.some((a) => facts[a] !== undefined && !hidden.has(a) && (isDisputed(facts[a]) || records(facts[a]!).some(open(n))))) continue;
    if (views.some((v) => v.visible.has(n.fm.id) && !v.visible.has(self))) continue;
    out.push({ id: n.fm.id, owner: self, sources: ["unverified"] });
  }
  return out;
}

export const familyOn = (rules: Rules) => (rules.policy as { family_links?: boolean }).family_links === true;

// Files them (only when the owner turned it on; else `counted` says how many it would); returns the
// pages filed. One hub commit with a why.
export function linkFamily(root: string): { filed: string[]; counted: number } {
  const rules = loadRules(root), notes = loadBrain(root);
  const done = new Set(readDiary(root).filter((r) => r.why === "family").map((r) => r.fact_key.slice(0, r.fact_key.lastIndexOf("#"))));
  const found = familyPages(rules, notes, done);
  if (!found.length || !familyOn(rules)) return { filed: [], counted: found.length };
  const at = clock().toISOString(), d = today(), month = ownerDay(rules, clock()).slice(0, 7);
  const paths: string[] = [];
  let rel = "";
  for (const f of found) {
    const n = notes.find((x) => x.fm.id === f.id)!;
    const rec: FactRecord = { value: `[[${f.owner}]]`, as_of: d, sources: f.sources, verification: "unverified", confidence: "inferred", by: "hub", recorded: d };
    (n.fm.facts ??= {}).family = rec;
    n.fm.updated = d;
    saveNote(root, n);
    paths.push(n.path);
    logWrite(root, { at, agent: "hub", kind: "family", key: `${f.id}#family`, outcome: "committed", sources: f.sources.length });
    rel = appendDiary(root, { ...diaryRow({ at, factKey: `${f.id}#family`, title: String(n.fm.title ?? f.id), kind: "new", from: undefined, to: rec.value, incoming: rec, acceptedBy: "hub", rank: 9, sensitivity: n.fm.sensitivity }), why: "family" }, month);
  }
  commitPaths(root, [...paths, rel], `hub: ${found.length} page${found.length === 1 ? "" : "s"} may be family\n\nWhy: ${found.length === 1 ? "this person has" : "these people have"} your surname and a first name of their own, so each page now says they may be family and links your page. Inferred from the name only; each has a diary line with Undo, and an Undo holds.\nKind: family`, "hub");
  return { filed: found.map((f) => f.id), counted: found.length };
}
