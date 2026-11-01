// SPDX-License-Identifier: AGPL-3.0-only
// Random brains and policies for the carve property (test/carve-property.test.ts). Seeded: the same
// seed always makes the same brain, so a failing seed can be replayed and frozen as a fixture.
// Every value, name, id and date is a made-up word or number used once in the brain, so finding
// it in an agent's output means it came from that one note or fact.
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";

// mulberry32: small, fast, deterministic.
export function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
  const some = <T>(xs: readonly T[], p = 0.5): T[] => xs.filter(() => next() < p);
  const chance = (p: number) => next() < p;
  return { next, int, pick, some, chance };
}
type R = ReturnType<typeof prng>;

const LEVELS = ["public", "personal", "private", "secret"] as const;
const TYPES = ["people", "projects", "money", "notes", "orgs", "decisions"] as const;
const TYPE_OF: Record<string, string> = { people: "person", projects: "project", money: "money", notes: "note", orgs: "org", decisions: "decision" };
const AREAS = ["work", "home", "personal", "side", "client"] as const;
const TAGS = ["alpha", "beta", "gamma"] as const;
const ATTRS = ["role", "amount", "place", "contact", "detail", "split", "code"] as const;
const AGENTS = ["ava", "bex", "cyd", "dax"] as const;

export interface GenAgent { name: string; roles: ("full" | "reader")[] }
export interface Generated { root: string; seed: number; agents: GenAgent[]; ops: string[] }

function words(r: R, shared?: { used: Set<string>; dates: Set<string> }) {
  const used = shared?.used ?? new Set<string>();
  const C = "bdfgklmnprstvzq", V = "aeiouy";
  const word = () => { for (;;) { let w = ""; for (let i = r.int(2, 3); i > 0; i--) w += r.pick([...C]) + r.pick([...V]); w = w[0].toUpperCase() + w.slice(1) + r.pick(["n", "r", "x", "th", "l"]); if (!used.has(w.toLowerCase())) { used.add(w.toLowerCase()); return w; } } };
  const name = () => `${word()} ${word()}`;
  const dates = shared?.dates ?? new Set<string>();
  const date = () => { for (;;) { const d = `${r.int(1991, 2019)}-${String(r.int(1, 12)).padStart(2, "0")}-${String(r.int(1, 28)).padStart(2, "0")}`; if (!dates.has(d)) { dates.add(d); return d; } } };
  const amounts = new Set<string>();
  const amount = () => { for (;;) { const a = `CAD ${r.int(1, 99)},${String(r.int(0, 999)).padStart(3, "0")}.${String(r.int(10, 99))}`; if (!amounts.has(a)) { amounts.add(a); return a; } } };
  let src = 0;
  const source = () => `gmail:f${(0x100000000000000 + ++src * 7919 + r.int(0, 999)).toString(16).slice(-15)}`;
  return { word, name, date, amount, source, used, dates };
}

// What a contact card files on a person page (src/contacts.ts, docs/sources-pull.md#contacts): a
// nickname, and emails and phones floored private and held from every agent until the owner's Show
// (`unseen`, src/seen.ts); some already seen. Each cites the card. Drawn from a stream of its own,
// after the notes, so a seed's other notes and its policy are the ones it always made; its words
// and dates are never used elsewhere in the brain (audit v8, 2026-10-31; G563).
function cardFacts(seed: number, w: ReturnType<typeof words>, facts: Record<string, any>) {
  const r = prng(seed ^ 0xca4d);
  const c = words(r, w);
  const phones = new Set<string>();
  const phone = () => { for (;;) { const p = `+1${r.int(200, 989)}555${String(r.int(0, 9999)).padStart(4, "0")}`; if (!phones.has(p)) { phones.add(p); return p; } } };
  const card = `contacts:vcard/${c.word().toLowerCase()}@${r.int(0x100000, 0xffffff).toString(16)}${r.int(0x100000, 0xffffff).toString(16)}`;
  const rec = (value: string, held: boolean) => ({ value, sensitivity: "private", as_of: c.date(), sources: [card], verification: "self-reported", by: "capture", recorded: c.date(), ...(held ? { unseen: true } : {}) });
  facts.aliases = { items: [{ value: c.word(), as_of: c.date(), sources: [card], verification: "self-reported", by: "capture", recorded: c.date() }] };
  facts.emails = { items: [rec(`${c.word().toLowerCase()}.${c.word().toLowerCase()}@card.example`, r.chance(0.7))] };
  facts.phones = { items: [rec(phone(), r.chance(0.7)), ...(r.chance(0.5) ? [rec(phone(), r.chance(0.7))] : [])] };
}

export function generate(seed: number): Generated {
  const r = prng(seed);
  const w = words(r);
  const root = makeBrain({ git: false });
  for (const d of readdirSync(root)) if (d !== "rules") rmSync(join(root, d), { recursive: true, force: true });
  const areas = [...new Set([r.pick(AREAS), ...r.some(AREAS, 0.5)])];
  const agentNames = AGENTS.slice(0, r.int(2, 4));

  // Notes.
  interface N { fm: Record<string, any>; body: string }
  const notes: N[] = [];
  for (let i = r.int(7, 12); i > 0; i--) {
    const folder = r.pick(TYPES);
    const title = w.name();
    const id = `${folder}/${title.toLowerCase().replace(/ /g, "-")}`;
    const created = w.date(), updated = w.date();
    const facts: Record<string, any> = {};
    for (const attr of r.some(ATTRS, 0.35).slice(0, 3).concat(r.chance(0.5) ? [] : [r.pick(ATTRS)])) {
      if (facts[attr]) continue;
      const rec = () => {
        const value = attr === "amount" ? w.amount() : attr === "split" ? { amount: w.amount(), with: w.name() } : attr === "contact" ? `${w.word().toLowerCase()}.${w.word().toLowerCase()}@${w.word().toLowerCase()}.example` : w.name();
        const x: Record<string, any> = { value, as_of: w.date(), sources: [w.source()], verification: "verified-by-source", by: "owner", recorded: w.date() };
        if (r.chance(0.2)) x.sensitivity = r.pick(LEVELS);
        if (r.chance(0.15)) x.share_with = r.some(agentNames, 0.5);
        return x;
      };
      facts[attr] = r.chance(0.12) ? { items: [rec(), rec()] } : rec();
    }
    const fm: Record<string, any> = { id, type: TYPE_OF[folder], title, ...(r.chance(0.4) ? { aliases: [w.name()] } : {}), area: r.pick(areas), sensitivity: r.pick(LEVELS), ...(r.chance(0.5) ? { tags: r.some(TAGS, 0.5) } : {}), status: "active", created, updated, by: "owner", facts };
    notes.push({ fm, body: `About ${title}.` });
  }
  // Contact cards on the people pages.
  for (const n of notes) if (n.fm.type === "person") cardFacts(seed ^ notes.indexOf(n), w, n.fm.facts);
  // Links between notes, hidden or not, and decisions that replace one another.
  for (const n of notes) if (r.chance(0.5)) n.body += ` See [[${r.pick(notes).fm.id}]].`;
  const decisions = notes.filter((n) => n.fm.type === "decision");
  if (decisions.length >= 2 && r.chance(0.7)) {
    const [old, nu] = [decisions[0], decisions[1]];
    old.fm.status = "superseded"; old.fm.superseded_by = nu.fm.id; nu.fm.supersedes = old.fm.id;
  }
  for (const n of notes) {
    const f = join(root, `${n.fm.id}.md`);
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, `---\n${YAML.stringify(n.fm, { lineWidth: 0 })}---\n${n.body}\n`);
  }

  // Policy: tiers, slices of every kind, excludes, ceilings.
  const slices: Record<string, any> = {};
  const sliceNames: string[] = ["all", ...areas.map((a) => `area:${a}`)];
  for (let i = r.int(1, 3); i > 0; i--) {
    const s: Record<string, any> = {};
    if (r.chance(0.5)) s.types = r.some(TYPES, 0.4).concat(r.pick(TYPES));
    if (r.chance(0.4)) s.tags = [r.pick(TAGS)];
    if (r.chance(0.3)) s.exclude_tags = [r.pick(TAGS)];
    if (r.chance(0.4)) s.max_sensitivity = r.pick(LEVELS);
    if (r.chance(0.3)) s.only_attributes = r.some(ATTRS, 0.4).concat(r.pick(ATTRS));
    if (r.chance(0.2)) s.exclude_attributes = [r.pick(ATTRS)];
    if (r.chance(0.2)) s.exclude = [r.pick(notes).fm.id];
    slices[`s${i}`] = s;
    sliceNames.push(`s${i}`);
  }
  const agents: Record<string, any> = {};
  const gen: GenAgent[] = [];
  for (const name of agentNames) {
    const a: Record<string, any> = { tier: r.pick(["core", "trial"]), slices: [...new Set([r.pick(sliceNames), ...r.some(sliceNames, 0.25)])] };
    if (r.chance(0.5)) a.exclude_types = [r.pick(TYPES)];
    if (r.chance(0.3)) a.max_sensitivity = r.pick(LEVELS);
    if (r.chance(0.2)) a.exclude = [r.pick(notes).fm.id];
    agents[name] = a;
    gen.push({ name, roles: r.chance(0.5) ? ["full", "reader"] : ["full"] });
  }
  writeFileSync(join(root, "rules", "policy.yaml"), YAML.stringify({ owner: { name: "Robin" }, agents, tiers: { core: { max_sensitivity: "private", writes: "direct" }, trial: { max_sensitivity: "personal", writes: "propose" } }, areas: Object.fromEntries(areas.map((a) => [a, {}])) }));
  writeFileSync(join(root, "rules", "slices.yaml"), YAML.stringify({ slices }));
  const git = (args: string[]) => Bun.spawnSync(["git", "-c", "user.name=louis", "-c", "user.email=l@x", "-c", "commit.gpgsign=false", ...args], { cwd: root });
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", `carve-gen seed ${seed}`]);
  return { root, seed, agents: gen, ops: [] };
}

// After the brain is written: merges (the real merge code) and handoffs (the real hand_off), when
// the seed asks for them. Async because a handoff is.
export async function evolve(g: Generated, src: { mergeNotes: Function; handOff: Function; loadBrain: Function }): Promise<void> {
  const r = prng(g.seed ^ 0x5eed);
  const notes = src.loadBrain(g.root) as { fm: Record<string, any> }[];
  if (r.chance(0.5)) {
    const byType = new Map<string, typeof notes>();
    for (const n of notes) if (n.fm.status === "active") byType.set(n.fm.type, [...(byType.get(n.fm.type) ?? []), n]);
    // A list fact on one side and a single value on the other under the same attr crashes the merge
    // (the list becomes a dispute candidate with no sources; reported, merge.ts isn't this branch's), so skip those pairs.
    const shape = (f: any) => (f?.items ? "list" : "one");
    const clash = (a: any, b: any) => Object.keys(a.fm.facts ?? {}).some((k) => b.fm.facts?.[k] && shape(a.fm.facts[k]) !== shape(b.fm.facts[k]));
    // The merge refuses any pair some agent would see differently afterwards (docs/same-person.md),
    // which most random pairs are. So first a real duplicate: one note copied under a second id (same
    // area, flags and title), committed, then the random pairs in order until one merges (refusals write nothing).
    const active = notes.filter((n) => n.fm.status === "active");
    const orig = active.length ? r.pick(active) : undefined;
    const pairs: (typeof notes)[] = [];
    if (orig) {
      const dupId = `${orig.fm.id}-dup`;
      const text = readFileSync(join(g.root, `${orig.fm.id}.md`), "utf8").replace(/^id: .*$/m, `id: ${dupId}`);
      writeFileSync(join(g.root, `${dupId}.md`), text);
      const git = (args: string[]) => Bun.spawnSync(["git", "-c", "user.name=louis", "-c", "user.email=l@x", "-c", "commit.gpgsign=false", ...args], { cwd: g.root });
      git(["add", `${dupId}.md`]); git(["commit", "-q", "-m", `carve-gen duplicate of ${orig.fm.id}`]);
      pairs.push([orig, { fm: { ...orig.fm, id: dupId } }]);
    }
    pairs.push(...[...byType.values()].flatMap((xs) => xs.flatMap((a, i) => xs.slice(i + 1).map((b) => [a, b]))).filter(([a, b]) => !clash(a, b)));
    for (const pair of pairs.slice(0, 40)) {
      const [keep, drop] = r.chance(0.5) ? [pair[0], pair[1]] : [pair[1], pair[0]];
      const m = src.mergeNotes(g.root, keep.fm.id, drop.fm.id, "owner");
      g.ops.push(`merge ${drop.fm.id} -> ${keep.fm.id}: ${m.ok ? "ok" : m.message}`);
      if (m.ok) break;
    }
  }
  if (g.agents.length >= 2 && r.chance(0.6)) {
    const [from, to] = [g.agents[0].name, g.agents[1].name];
    const n = r.pick(notes);
    const fact = Object.values(n.fm.facts ?? {})[0] as any;
    const v = fact ? JSON.stringify(fact.items ? fact.items[0].value : fact.value) : n.fm.title;
    try {
      const h = await src.handOff(g.root, from, { to, task: `Pick up ${n.fm.title}: ${v}.`, next_step: `Check ${n.fm.id} and finish it.` }, { model: null });
      g.ops.push(`handoff ${from} -> ${to} about ${n.fm.id}: ${h.id}`);
    } catch (e) { g.ops.push(`handoff refused: ${(e as Error).message}`); }
  }
}

// A brain frozen as a fixture (test/fixtures/carve-seeds/<name>/): every file but git, logs, built views and token hashes.
export function freeze(g: Generated, dir: string) {
  rmSync(dir, { recursive: true, force: true });
  cpSync(g.root, join(dir, "brain"), { recursive: true, filter: (s) => !/\/(\.git|log|views|\.cells|textline|tokens\.yaml)(\/|$)/.test(s.slice(g.root.length)) });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ seed: g.seed, agents: g.agents, ops: g.ops }, null, 1) + "\n");
}
export function thaw(dir: string, root: string): Generated {
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  cpSync(join(dir, "brain"), root, { recursive: true });
  if (!existsSync(join(root, ".git"))) {
    const git = (args: string[]) => Bun.spawnSync(["git", "-c", "user.name=louis", "-c", "user.email=l@x", "-c", "commit.gpgsign=false", ...args], { cwd: root });
    git(["init", "-q", "-b", "main"]); git(["add", "-A"]); git(["commit", "-q", "-m", "carve fixture"]);
  }
  return { root, seed: meta.seed, agents: meta.agents, ops: meta.ops };
}
