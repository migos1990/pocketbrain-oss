// SPDX-License-Identifier: AGPL-3.0-only
// The demo brain (outside review 2026-10-29, item 2): a made-up life of about 500 facts that the
// owner's screens and the UI tests are designed against, instead of the 7-note sample brain that
// made every home say "Nothing new since yesterday". Two parts:
//   examples/demo-brain/   what the brain held before the week: ~60 people across work, teaching,
//                          family and friends, their places, projects, decisions and two private
//                          money pages, each page with the owner's own notes, cited and linked.
//                          Written from scripts/demo-data.ts by this script (test/demo-brain.test.ts
//                          fails when the folder and the tables differ).
//   replayWeek()           Fri 2 to Thu 8 Oct 2026 through the hub's own paths: mail pulled and filed
//                          (Gmail fixture, a fake model that reads each sentence), the owner's box,
//                          assistants' writes and memory imports, their reads, a quiz answer that
//                          is out of date, the hub's tick and its page writer. It ends with three
//                          open conflicts, one private value held for the owner, assistants that
//                          read today and one that has something wrong.
//   bun scripts/demo-brain.ts                 rewrite examples/demo-brain/ from the tables
//   bun scripts/demo-brain.ts --out <dir>     a replayed demo brain in <dir> (an empty or new folder),
//                                             to look at: PB_BRAIN=<dir> bun src/cli.ts dashboard
// Never the real brain. Nobody in it is real.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import YAML from "yaml";
import { sha256 } from "../src/util";
import { slugify, serializeNote, type Note, type FactRecord } from "../src/brain";
import { OWNER, ORGS, PEOPLE, PROJECTS, DECISIONS, MONEY, PREFERS } from "./demo-data";

export const DEMO_DIR = join(import.meta.dir, "..", "examples", "demo-brain");
// The demo's today: the last day of the replayed week, the same day the sample brain is pinned to.
export const DEMO_DAY = "2026-10-08";
// The moment the screens are looked at: 10:00 in Montréal on DEMO_DAY.
export const DEMO_NOW = `${DEMO_DAY}T14:00:00Z`;
export const DEMO_AGENTS = ["claude", "chatgpt", "gemini"] as const;
// The assistants' tokens are fixed, so the replay is the same commit for commit on every machine
// (the UI snapshots show commit ids). Only their hashes are in the brain; they open a throwaway copy.
export const DEMO_TOKENS: Record<string, string> = Object.fromEntries(DEMO_AGENTS.map((a) => [a, `pb_${a}_demo-brain-only-${a}`]));

const BEFORE = "2026-09-30"; // the day every base page was last written
const ownerRef = (d: string, what: string) => `owner:${d}/${what}`;
const OWNER_REFS = [ownerRef("2026-09-01", "notes"), ownerRef("2026-09-20", "notes")];
const hex = (n: number) => n.toString(16).padStart(16, "0");
const addressOf = (name: string) => `${slugify(name).replace(/-/g, ".")}@example.org`;
// Mail the hub read before the week: every base fact from an email cites one of these.
const baseMail = (k: number) => `gmail:${hex(0xd000 + k)}`;
export const BASE_MAIL_COUNT = 120;

// A fact as the brain stores it.
function rec(value: unknown, as_of: string, src: string, by = src.startsWith("owner:") ? "owner" : src.startsWith("agent:") ? src.slice(6, src.indexOf("/")) : "capture"): FactRecord {
  // What the hub's own pull files from mail is the sender's say-so (self-reported), as here: an
  // older email outranking a newer one would turn every update in the week into a conflict.
  const verification = src.startsWith("owner:") ? "confirmed-by-owner" : src.startsWith("gcal:") ? "verified-by-source" : "self-reported";
  return { value, as_of, sources: [src], verification, by, recorded: as_of } as FactRecord;
}
const day = (k: number, from = "2026-08-10", span = 50) => new Date(Date.parse(`${from}T12:00:00Z`) + (k % span) * 86_400_000).toISOString().slice(0, 10);
const words = (ref: string, d: string) => `${ref.startsWith("owner:") ? "Your notes" : ref.startsWith("gcal:") ? "Calendar" : ref.startsWith("agent:") ? `${ref.slice(6, 7).toUpperCase()}${ref.slice(7, ref.indexOf("/"))}'s note` : "Email"}, ${d} (${ref})`;
const cited = (prose: string, ref: string, d: string) => `${prose}[^1]\n\n[^1]: ${words(ref, d)}\n`;

function note(id: string, type: string, title: string, area: string, facts: Record<string, unknown>, body: string, o: { sensitivity?: string; aliases?: string[]; extra?: Record<string, unknown>; created?: string } = {}): Note {
  return {
    path: `${id}.md`,
    body,
    fm: { id, type, title, ...(o.aliases ? { aliases: o.aliases } : {}), area, sensitivity: (o.sensitivity ?? "personal") as never, status: "active", created: o.created ?? "2026-09-01", updated: BEFORE, by: "owner", ...(o.extra ?? {}), facts: facts as never },
  };
}

// ---------- the base: what the brain held on 30 September ----------

export function baseNotes(): Note[] {
  const out: Note[] = [];
  let mail = 0;
  const nextMail = () => baseMail(mail++);
  const orgLink = (slug: string) => `[[orgs/${slug}]]`;

  // Who is where and on what, said in the notes as well as in the facts, so pages link both ways.
  const list = (ids: string[]) => ids.length < 2 ? ids.join("") : `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}`;
  const link = (id: string) => `[[${id}]]`;
  for (const [slug, title, kind, city, area, prose] of ORGS) {
    const src = area === "personal" ? OWNER_REFS[0]! : nextMail();
    const d = day(slug.length * 3);
    const here = PEOPLE.filter((p) => p[3] === slug).map((p) => link(`people/${slugify(p[0])}`));
    out.push(note(`orgs/${slug}`, "org", title, area, { kind: rec(kind, d, src), city: rec(city, d, src) }, cited(`${prose}${here.length ? ` People Robin knows here: ${list(here)}.` : ""}`, src, d)));
  }

  PEOPLE.forEach(([name, area, role, org, how, city, mailer, prose], k) => {
    const slug = slugify(name);
    const family = area === "personal";
    const src = family ? OWNER_REFS[k % 2]! : nextMail();
    const d = day(k * 7);
    const facts: Record<string, unknown> = {};
    if (role) facts.role = rec(role, d, src);
    if (org) facts.org = rec(orgLink(org), d, src);
    facts.relationship = rec(how, d, OWNER_REFS[0]!);
    facts.city = rec(city, d, family ? OWNER_REFS[1]! : src);
    if (mailer) facts.emails = { items: [rec(addressOf(name), "2026-09-01", OWNER_REFS[0]!)] };
    facts.last_contact = rec(day(k * 5, "2026-08-25", 35), day(k * 5, "2026-08-25", 35), `gcal:${hex(0xc000 + k)}@1`);
    if (/daughter|son|niece|mother|brother|partner/.test(how)) facts.birthday = rec(`${["03", "05", "07", "11", "12", "01", "04"][k % 7]}-${String(3 + (k * 4) % 25).padStart(2, "0")}`, "2026-09-01", OWNER_REFS[0]!);
    const on = PROJECTS.filter((x) => x[4] === slug || x[7].includes(slug)).map((x) => link(`projects/${x[0]}`)).filter((x) => !prose.includes(x));
    out.push(note(`people/${slug}`, "person", name, area, facts, cited(`${prose}${on.length ? ` Also on ${list(on)}.` : ""}`, src, d), { aliases: [name.split(" ")[0]!] }));
  });

  // The owner's own page: who they are and how they like things, some of it in the words an
  // assistant's memory kept (imported, G490).
  const me: Record<string, unknown> = {
    role: rec("director of product", "2026-09-01", OWNER_REFS[0]!),
    org: rec("[[orgs/harbourline]]", "2026-09-01", OWNER_REFS[0]!),
    city: rec("Montréal", "2026-09-01", OWNER_REFS[0]!),
    emails: { items: [rec(OWNER.address, "2026-09-01", OWNER_REFS[0]!)] },
    prefers: { items: PREFERS.map(([v, from], i) => rec(v, day(i * 3, "2026-09-05", 20), from === "owner" ? OWNER_REFS[1]! : `agent:${from === "chatgpt-mem" ? "chatgpt" : "claude"}/memory-2026-09-20`)) },
  };
  const close = PEOPLE.filter((p) => p[1] === "personal" && !p[3] && !["Jordan Ellis", "Léa Lefebvre", "Theo Lefebvre"].includes(p[0])).map((p) => link(`people/${slugify(p[0])}`));
  out.push(note(`people/${OWNER.slug}`, "person", OWNER.name, "personal", me, cited(`Robin leads product for Atlas at [[orgs/harbourline]] and teaches the [[projects/product-discovery-course]] on Tuesday evenings. Lives in Rosemont with [[people/jordan-ellis]], [[people/lea-lefebvre]] and [[people/theo-lefebvre]]. Family, friends and the people who help at home: ${list(close)}. Advice before a hard call comes from [[people/sam-patel]].`, OWNER_REFS[0]!, "2026-09-01"), { aliases: ["Robin", "me"] }));

  PROJECTS.forEach(([slug, title, area, status, lead, due, next, people, prose], k) => {
    // The owner set up their own projects; what happens next comes in by mail like the rest.
    const own = area === "personal" ? OWNER_REFS[1]! : undefined;
    const src = nextMail();
    const d = day(k * 3, "2026-09-12", 18);
    const facts: Record<string, unknown> = {
      status: rec(status, d, src),
      lead: rec(`[[people/${lead}]]`, d, own ?? src),
      due: rec(due, d, own ?? src),
      next_step: rec(next, BEFORE, src),
      people: { items: people.map((p) => rec(`[[people/${p}]]`, d, src)) },
    };
    const with_ = [lead, ...people].filter((p, i, a) => a.indexOf(p) === i).map((p) => link(`people/${p}`)).filter((x) => !prose.includes(x));
    const decided = DECISIONS.filter((x) => x[6] === slug).map((x) => link(`decisions/${x[0]}-${x[1]}`));
    out.push(note(`projects/${slug}`, "project", title, area, facts, cited(`${prose}${with_.length ? ` With ${list(with_)}.` : ""}${decided.length ? ` Decided so far: ${list(decided)}.` : ""}`, src, d)));
  });

  for (const [date, slug, title, area, chose, why, project, people] of DECISIONS) {
    const src = area === "personal" ? OWNER_REFS[0]! : nextMail();
    out.push(note(`decisions/${date}-${slug}`, "decision", title, area, { chose: rec(chose, date, src), why: rec(why, date, src) },
      cited(`Decided on ${date} for the [[projects/${project}]], with ${people.map((p) => `[[people/${p}]]`).join(" and ")}.`, src, date), { extra: { decided_on: date }, created: date }));
  }

  for (const [slug, title, facts, prose] of MONEY) {
    const src = slug === "household-taxes" ? nextMail() : OWNER_REFS[1]!;
    const d = "2026-09-02";
    out.push(note(`money/${slug}`, "money", title, "personal", Object.fromEntries(Object.entries(facts).map(([a, v]) => [a, rec(v, d, src)])), cited(prose, src, d), { sensitivity: "private" }));
  }
  return out;
}

// Rules as `pocketbrain init` writes them, with the owner's three assistants, the Gardener and the
// hub's capture agent, and a Gmail source on a fixture the replay fills.
export function baseRules(): Record<string, string> {
  const policy = `# Who sees what. Only you edit this folder. Every limit here is enforced in code.
owner: { name: ${OWNER.name}, timezone: America/Toronto }
agents:
  claude: { tier: core, label: Claude, transport: mcp, slices: [all] }
  chatgpt: { tier: core, label: ChatGPT, transport: mcp, slices: [area:work, area:teaching, area:personal, contacts-full], exclude_types: [money] }
  gemini: { tier: trial, label: Gemini, transport: mcp, browser: true, slices: [area:work, contacts-basic], exclude_types: [money] }
  # Keeps the brain in order (docs/gardener.md): reads everything, only proposes, only in its hours.
  gardener: { tier: trial, role: gardener, max_sensitivity: private, slices: [all], max_proposals_per_day: 13, windows: ["daily 03:25-05:00", "sun 09:55-12:00"] }
  # The hub's own reader of your mail, calendar and captures. Inside the wall.
  capture: { tier: core, slices: [all], inside_wall: true }
tiers:
  core: { max_sensitivity: private, writes: direct }
  trial: { max_sensitivity: personal, writes: propose }
areas:
  work: { owner: claude }
  teaching: { owner: claude }
  personal: { owner: claude }
link_names: true
logs: { accept: false }
`;
  const sources = `consent: 2026-09-01 demo brain, a made-up mailbox
sources:
  mail:
    kind: gmail
    fixture: log/demo-mail.json
`;
  const relay = `relay_address: relay@brain.example
owner_address: ${OWNER.address}
agents:
${DEMO_AGENTS.map((a) => `  ${a}: ${a}@brain.example`).join("\n")}
canaries: [Zephyr Holdings 7731]
`;
  const tokens = "# Hashes of the live server's per-agent tokens. Only the owner edits this file (pocketbrain token).\n" + YAML.stringify({ agents: Object.fromEntries(DEMO_AGENTS.map((a) => [a, [{ hash: sha256(DEMO_TOKENS[a]!), issued: BEFORE }]])) });
  const messages = YAML.stringify({ messages: OWNER_REFS.map((id) => ({ id, added: id.slice(6, 16), note: "the owner's notes" })) }, { lineWidth: 0 });
  return { "policy.yaml": policy, "sources.yaml": sources, "relay.yaml": relay, "tokens.yaml": tokens, "owner-messages.yaml": `# The owner's own messages that facts may cite as the owner's word. Only the owner adds to this file.\n${messages}` };
}

// The init rules this brain shares with every new brain (checks, slices, RULES.md), from a fresh init.
async function initRules(): Promise<Record<string, string>> {
  const { initBrain } = await import("../src/init");
  const tmp = mkdtempSync(join(tmpdir(), "pb-demo-init-"));
  const keep = process.env.PB_TODAY;
  process.env.PB_TODAY = "2026-09-01";
  try {
    initBrain(join(tmp, "b"), { owner: OWNER.name, token: false });
    const out: Record<string, string> = {};
    for (const f of ["checks.yaml", "slices.yaml", "RULES.md"]) out[f] = readFileSync(join(tmp, "b", "rules", f), "utf8");
    out[".gitignore"] = readFileSync(join(tmp, "b", ".gitignore"), "utf8");
    out.FORMAT = readFileSync(join(tmp, "b", "FORMAT"), "utf8");
    return out;
  } finally { if (keep === undefined) delete process.env.PB_TODAY; else process.env.PB_TODAY = keep; rmSync(tmp, { recursive: true, force: true }); }
}

// Every file of examples/demo-brain/, by path.
export async function baseFiles(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const n of baseNotes()) files[n.path] = serializeNote(n);
  const init = await initRules();
  for (const f of ["checks.yaml", "slices.yaml", "RULES.md"]) files[`rules/${f}`] = init[f]!;
  for (const [f, text] of Object.entries(baseRules())) files[`rules/${f}`] = text;
  files[".gitignore"] = init[".gitignore"]!;
  files.FORMAT = init.FORMAT!;
  // The mail the hub read before the week: citing it passes the source check (src/louis.ts).
  files["log/refs-checked.jsonl"] = Array.from({ length: BASE_MAIL_COUNT }, (_, k) => JSON.stringify({ ref: baseMail(k), ok: true })).join("\n") + "\n";
  files["README.md"] = `# The demo brain\n\nA made-up life of about 500 facts: the brain the owner's screens and the UI tests are designed against (outside review 2026-10-29). Written by \`bun scripts/demo-brain.ts\` from \`scripts/demo-data.ts\`; edit the tables, not these files. Nobody in it is real.\n\nThis folder is the brain on 30 September 2026. The UI tests copy it and replay a week on top (\`replayWeek\` in \`scripts/demo-brain.ts\`): mail filed, things the owner said, assistants' reads and writes, three conflicts and one private value waiting. To look at it yourself:\n\n\`\`\`sh\nbun scripts/demo-brain.ts --out /tmp/demo && PB_BRAIN=/tmp/demo bun src/cli.ts dashboard\n\`\`\`\n`;
  return files;
}

export function readDir(dir: string, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(join(dir, rel))) return out;
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, readDir(dir, r)); else out[r] = readFileSync(join(dir, r), "utf8");
  }
  return out;
}

export function factCount(notes: Note[]): number {
  let n = 0;
  for (const x of notes) for (const f of Object.values(x.fm.facts ?? {})) n += Array.isArray((f as { items?: unknown[] }).items) ? (f as { items: unknown[] }).items.length : 1;
  return n;
}

// ---------- the week ----------

interface Mail { day: number; entity: string; type: "person" | "project"; attribute: string; value: string; sentence: string; from: string }
// Fri 2 Oct is day 0, Thu 8 Oct (the demo's today) day 6.
export function weekMail(): Mail[] {
  const m = (day: number, from: string, entity: string, type: Mail["type"], attribute: string, value: string, sentence: string): Mail => ({ day, entity, type, attribute, value, sentence, from });
  return [
    m(0, "Omar Haddad", "Tomás Rivera", "person", "role", "senior backend engineer", "Tomás Rivera is now a senior backend engineer on the Atlas team"),
    m(0, "Elena Rossi", "Pricing page refresh", "project", "next_step", "review the second round of mockups on 9 October", "For the Pricing page refresh the next step is to review the second round of mockups on 9 October"),
    m(0, "Ravi Menon", "Ravi Menon", "person", "last_contact", "2026-10-02", "Robin met Ravi Menon on 2026-10-02 to talk about the Pinecrest pilot"),
    m(1, "Lina Sato", "Choir winter concert", "project", "next_step", "buy the concert tickets for the grandparents by 1 November", "For the Choir winter concert the next step is to buy the concert tickets for the grandparents by 1 November"),
    m(1, "Kai Nakamura", "Red River climbing trip", "project", "next_step", "book the cabin for 9 to 16 April", "For the Red River climbing trip the next step is to book the cabin for 9 to 16 April"),
    m(2, "Diego Alvarez", "Book club, November", "project", "next_step", "finish the book before the 25th", "For the Book club, November the next step is to finish the book before the 25th"),
    m(2, "Emma Wilson", "Emma Wilson", "person", "last_contact", "2026-10-04", "Robin called Emma Wilson on 2026-10-04 to plan her visit next summer"),
    m(3, "Priya Shah", "Q1 roadmap", "project", "next_step", "share the first draft with Priya by 16 October", "For the Q1 roadmap the next step is to share the first draft with Priya by 16 October"),
    m(3, "Felix Moreau", "Senior designer hire", "project", "next_step", "decide between Lucas and Nina by 14 October", "For the Senior designer hire the next step is to decide between Lucas and Nina by 14 October"),
    m(3, "Claire Dubois", "Isabelle Roy", "person", "role", "registrar", "Isabelle Roy is now the registrar for continuing studies"),
    m(3, "Laila Haddad", "Laila Haddad", "person", "role", "product manager", "Laila Haddad is now a product manager on the Atlas team"),
    m(4, "Antoine Lavoie", "Product Discovery course", "project", "next_step", "return the midterm reflections on 13 October", "For the Product Discovery course the next step is to return the midterm reflections on 13 October"),
    m(4, "Zoe Harper", "Guest lectures", "project", "next_step", "send Zoe the room details for 17 November", "For the Guest lectures the next step is to send Zoe the room details for 17 November"),
    m(4, "Ben Carter", "Pinecrest pilot", "project", "next_step", "send the export sample to Ben by 9 October", "For the Pinecrest pilot the next step is to send the export sample to Ben by 9 October"),
    m(4, "Valérie Roy", "Mom's move", "project", "next_step", "sign the lease at Maison des Pins on 15 October", "For the Mom's move the next step is to sign the lease at Maison des Pins on 15 October"),
    m(5, "Kenji Watanabe", "Kenji Watanabe", "person", "role", "senior data analyst", "Kenji Watanabe is now a senior data analyst on the Atlas team"),
    m(5, "Maya Chen", "Maya Chen", "person", "last_contact", "2026-10-07", "Robin met Maya Chen on 2026-10-07 to go over the beta screens"),
    m(5, "Sofia Marquez", "Sofia Marquez", "person", "role", "senior product marketing manager", "Sofia Marquez is now the senior product marketing manager for Atlas"),
    // Three contradictions: two people, the same day, two values for one fact. Nothing tells which
    // is right, so each waits on the owner's home as a conflict.
    m(5, "Omar Haddad", "Atlas launch", "project", "next_step", "freeze the beta build on 15 October", "For the Atlas launch the next step is to freeze the beta build on 15 October"),
    m(5, "Daniel Okoro", "Atlas launch", "project", "next_step", "freeze the beta build on 22 October", "For the Atlas launch the next step is to freeze the beta build on 22 October"),
    m(5, "Grace Liu", "Grace Liu", "person", "role", "customer success director", "Grace Liu is now the customer success director for Atlas"),
    m(5, "Priya Shah", "Grace Liu", "person", "role", "head of customer experience", "Grace Liu is now the head of customer experience for Atlas"),
    m(5, "Luc Gauthier", "Kitchen renovation", "project", "next_step", "take the tile delivery on 12 October", "For the Kitchen renovation the next step is to take the tile delivery on 12 October"),
    m(5, "Simone Laurent", "Kitchen renovation", "project", "next_step", "take the tile delivery on 19 October", "For the Kitchen renovation the next step is to take the tile delivery on 19 October"),
    // This morning. Hélène's note names her surgery: private, held from every assistant until the owner sees it.
    m(6, "Hélène Lefebvre", "Hélène Lefebvre", "person", "prefers", "visits in the morning until the hip surgery on 20 November", "Hélène Lefebvre prefers visits in the morning until the hip surgery on 20 November"),
    m(6, "Hannah Becker", "Hannah Becker", "person", "last_contact", "2026-10-08", "Robin met Hannah Becker on 2026-10-08 to walk through the release checklist"),
    m(6, "Martin Leclerc", "Martin Leclerc", "person", "last_contact", "2026-10-08", "Robin talked to Martin Leclerc on 2026-10-08 about the Saturday carpool"),
  ];
}

// What the owner typed in the home's box, by day and local time.
export const WEEK_SAID: [number, string, string][] = [
  [3, "19:40", "Had lunch with Sam Patel"],
  [4, "21:10", "Mom's move: next step is book the movers"],
  [5, "20:30", "Met Lucas Fontaine for coffee"],
  [6, "09:40", "Antoine Lavoie is now the head TA"],
];

// What an assistant wrote from a conversation with the owner (a core assistant's own note).
export const WEEK_NOTES: [number, string, string, string, string][] = [
  [2, "claude", "people/daniel-okoro", "prefers", "a written spec before any meeting"],
  [4, "claude", "people/priya-shah", "prefers", "the decision in the first line of an email"],
  [5, "chatgpt", "people/diego-alvarez", "prefers", "long novels nobody else has read"],
];

// How many times each assistant read the brain, by day (Thursday is today).
export const WEEK_READS: Record<string, number[]> = { claude: [1, 0, 0, 2, 1, 2, 6], chatgpt: [1, 0, 0, 1, 0, 1, 3], gemini: [0, 0, 0, 1, 0, 0, 0] };
const TOPICS = ["Atlas launch", "Maya Chen", "Q1 roadmap", "Grace Liu", "Kitchen renovation", "Product Discovery course", "Mom's move", "Priya Shah", "Pinecrest pilot", "Senior designer hire"];

// ChatGPT's memory still holds Isabelle Roy's role from before Monday's mail: the home's belief
// radar shows it, with Fix everywhere.
export const WRONG_BELIEF = { agent: "chatgpt", key: "people/isabelle-roy#role", answer: "She's the course coordinator" };

const START = Date.parse("2026-10-02T04:00:00Z"); // midnight in Montréal, Fri 2 Oct
const localAt = (d: number, hhmm: string) => new Date(START + d * 86_400_000 + (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))) * 60_000);

export interface Replayed { tokens: Record<string, string>; conflicts: string[] }

// The week, on a copy of examples/demo-brain/ at `root` (a git repo). Sets the clock as it goes and
// puts the environment back after.
export async function replayWeek(root: string): Promise<Replayed> {
  const { pullSource } = await import("../src/pull");
  const { runAuto } = await import("../src/filing");
  const { renderTouchedPages } = await import("../src/wiki");
  const { ownerSay } = await import("../src/owner-say");
  const { write } = await import("../src/write");
  const { serve } = await import("../src/server");
  const { quiz, memoryReply } = await import("../src/memsync");
  const { ownerConflicts, gardenerDisputes } = await import("../src/core");
  const { makeModel } = await import("../src/model");
  const keys = ["PB_TODAY", "PB_NOW", "GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"] as const;
  const env = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const setClock = (t: Date) => {
    process.env.PB_NOW = t.toISOString();
    process.env.PB_TODAY = new Date(t.getTime() - 4 * 3_600_000).toISOString().slice(0, 10);
    process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = t.toISOString();
  };
  const mail = weekMail();
  const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: { prompt: string }) => JSON.stringify({ facts: mail.filter((f) => r.prompt.includes(f.sentence)).map((f) => ({ entity: f.entity, type: f.type, attribute: f.attribute, value: f.value, quote: f.sentence })) }) });
  const fixture: Record<string, unknown>[] = [];
  let server: ReturnType<typeof serve> | undefined;
  try {
    setClock(localAt(0, "07:00"));
    const tokens = { ...DEMO_TOKENS };
    server = serve(root, 0);
    const api = `http://127.0.0.1:${server.port}`;
    let topic = 0;
    for (let d = 0; d <= 6; d++) {
      // The Gardener's night pass read the open conflicts and had nothing to suggest: from then
      // on they wait on the owner (src/gardener-hold.ts).
      if (d === 6) { setClock(localAt(6, "03:30")); gardenerDisputes(root, "gardener"); }
      // Reads through the morning, from 07:00, all before the demo's 10:00.
      for (const [agent, per] of Object.entries(WEEK_READS)) for (let i = 0; i < per[d]!; i++) {
        const m = 7 * 60 + i * 22 + DEMO_AGENTS.indexOf(agent as never) * 7;
        setClock(localAt(d, `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`));
        await fetch(`${api}/v1/context?topic=${encodeURIComponent(TOPICS[topic++ % TOPICS.length]!)}`, { headers: { authorization: `Bearer ${tokens[agent]}` } });
      }
      // What an assistant noted from a conversation.
      for (const [nd, agent, id, attribute, value] of WEEK_NOTES) if (nd === d) {
        setClock(localAt(d, "12:15"));
        write(root, { agent, id, attribute, value, as_of: process.env.PB_TODAY!, sources: [`agent:${agent}/${process.env.PB_TODAY}`], verification: "self-reported" });
      }
      // The day's mail, read at the end of the work day (this morning's at 09:00).
      const today = mail.filter((f) => f.day === d);
      const at = localAt(d, d === 6 ? "09:00" : "17:30");
      today.forEach((f, k) => fixture.push({ id: hex(0xe000 + d * 100 + k), threadId: hex(0xe000 + d * 100 + k), internalDate: String(at.getTime() - (today.length - k) * 600_000), labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: `${f.from} <${addressOf(f.from)}>` }, { name: "To", value: OWNER.address }, { name: "Subject", value: `${f.entity}` }] }, text: `Hi Robin, a quick note. ${f.sentence}. Talk soon, ${f.from.split(" ")[0]}` }));
      mkdirSync(join(root, "log"), { recursive: true });
      writeFileSync(join(root, "log", "demo-mail.json"), JSON.stringify(fixture));
      setClock(at);
      await pullSource(root, "mail", { model });
      runAuto(root, at);
      // What the owner said in the box.
      for (const [sd, hhmm, text] of WEEK_SAID) if (sd === d) { setClock(localAt(d, hhmm)); ownerSay(root, text); }
      // The night pass writes the pages that changed (today's run waits for tonight). Every few
      // nights here, covering the days since: the page writer is the slow part of the replay.
      if (d === 2 || d === 5) { const night = localAt(d, "23:30"); setClock(night); renderTouchedPages(root, new Date(night.getTime() - (d === 2 ? 3 : 3) * 86_400_000).toISOString()); }
    }
    // This morning ChatGPT answered a memory check from its own, older memory.
    setClock(localAt(6, "09:50"));
    const [q] = quiz(root, WRONG_BELIEF.agent, 1, [WRONG_BELIEF.key]);
    if (q) memoryReply(root, WRONG_BELIEF.agent, { answers: [{ id: q.id, answer: WRONG_BELIEF.answer }] });
    const conflicts = ownerConflicts(root, new Date(DEMO_NOW), { held: true }).map((c) => c.id);
    return { tokens, conflicts };
  } finally {
    server?.stop(true);
    for (const k of keys) if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
}

// examples/demo-brain/ copied to `root` and committed, as the owner had it on 30 September.
export function copyBase(root: string): void {
  for (const [rel, text] of Object.entries(readDir(DEMO_DIR))) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const at = `${BEFORE}T20:00:00Z`;
  const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "owner", GIT_AUTHOR_EMAIL: "owner@pocketbrain.local", GIT_COMMITTER_NAME: "owner", GIT_COMMITTER_EMAIL: "owner@pocketbrain.local", GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
  run(["init", "-q", "-b", "main"]);
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "owner: the demo brain on 30 September"]);
}

if (import.meta.main) {
  const i = Bun.argv.indexOf("--out");
  if (i >= 0) {
    const out = Bun.argv[i + 1];
    if (!out || (existsSync(out) && readdirSync(out).length)) { console.error("--out <an empty or new folder>"); process.exit(2); }
    mkdirSync(out, { recursive: true });
    copyBase(out);
    const r = await replayWeek(out);
    const { loadBrain } = await import("../src/brain");
    console.log(`demo brain in ${out}: ${loadBrain(out).length} pages, ${factCount(loadBrain(out))} facts, ${r.conflicts.length} open conflicts. Now is ${DEMO_NOW}: PB_NOW=${DEMO_NOW} PB_BRAIN=${out} bun src/cli.ts dashboard`);
  } else {
    const files = await baseFiles();
    rmSync(DEMO_DIR, { recursive: true, force: true });
    for (const [rel, text] of Object.entries(files)) { mkdirSync(dirname(join(DEMO_DIR, rel)), { recursive: true }); writeFileSync(join(DEMO_DIR, rel), text); }
    console.log(`examples/demo-brain: ${baseNotes().length} pages, ${factCount(baseNotes())} facts before the week, ${weekMail().length + WEEK_SAID.length + WEEK_NOTES.length} in the week`);
  }
}
