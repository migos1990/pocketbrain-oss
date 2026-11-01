// SPDX-License-Identifier: AGPL-3.0-only
// Memory Passport bundles (docs/export.md, docs/spec/memory-passport.md "Bundles"): the way out of
// a brain and back in. One JSON file:
//   - a brain bundle: every content note (front matter and body) and the owner's rules that decide
//     the carve, so `importBundle` into a fresh folder gives every agent the same carve;
//   - a slice bundle: one agent's view, each note in the shape GET /v1/notes/{id} answers, for
//     another memory tool.
// Neither carries raw sources (notes hold refs only), tokens, OAuth bindings, invites, logs, the
// inbox or anything `secret`: secret notes and facts are dropped and their values blanked in text.
// Owner-only: no agent route reaches it.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTENT_DIRS, loadBrain, parseNote, saveNote, serializeNote, today, isList, isDisputed, type Fact, type FactRecord, type Note } from "./brain";
import { loadRules, ownerName } from "./rules";
import { carve, grantFor, visibleFacts } from "./carve";
import { agentFact, scrubPage } from "./view";
import { withoutTokenRole } from "./tokenrole";
import { git } from "./git";
import { OWNER } from "./owner";

export const BUNDLE_VERSION = "0.2";
// The rules a carve reads. tokens.yaml, oauth.yaml, invites.yaml, hub.yaml and the rest stay home.
export const BUNDLE_RULES = ["RULES.md", "policy.yaml", "slices.yaml", "checks.yaml", "standing.yaml"];
const SECRET = "[secret]";
// A note id: a content folder, then slug segments. No dot segments, no absolute paths.
const ID = new RegExp(`^(${CONTENT_DIRS.join("|")})(/[a-z0-9][a-z0-9_-]*)+$`);

export interface BrainBundle { memory_passport: string; bundle: "brain"; exported: string; owner: string; notes: { fm: Note["fm"]; body: string }[]; rules: Record<string, string> }
export interface SliceBundle { memory_passport: string; bundle: "slice"; exported: string; agent: string; notes: SliceNote[] }
interface SliceNote { id: string; title: string; type: string; area: string; aliases: string[]; facts: Record<string, unknown>; body?: string }

const isSecret = (r: FactRecord | undefined) => r?.sensitivity === "secret";

// A fact without its secret records; undefined when nothing is left.
function dropSecret(f: Fact): Fact | undefined {
  if (isList(f)) { const items = f.items.filter((r) => !isSecret(r)); return items.length ? { ...f, items } : undefined; }
  if (isDisputed(f)) { const candidates = f.candidates.filter((r) => !isSecret(r)); return candidates.length ? { ...f, candidates } : undefined; }
  return isSecret(f as FactRecord) ? undefined : f;
}

// Every value the bundle must not carry: secret facts' values and secret notes' fact values.
function secretValues(notes: Note[]): string[] {
  const out = new Set<string>();
  const add = (r: FactRecord) => { if (typeof r.value === "string" && r.value.trim().length >= 3) out.add(r.value); };
  for (const n of notes) {
    const all = n.fm.sensitivity === "secret";
    for (const f of Object.values(n.fm.facts ?? {})) {
      const recs = isList(f) ? f.items : isDisputed(f) ? f.candidates : [f as FactRecord];
      for (const r of recs) if (all || isSecret(r)) add(r);
    }
    for (const rs of Object.values(n.fm.history ?? {})) for (const r of rs) if (all || isSecret(r)) add(r);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

const blank = (text: string, secrets: string[]) => secrets.reduce((t, v) => t.split(v).join(SECRET), text);

export function exportBrain(root: string): BrainBundle {
  const all = loadBrain(root);
  const secrets = secretValues(all);
  const notes = all.filter((n) => n.fm.sensitivity !== "secret").map((n) => {
    const fm = structuredClone(n.fm);
    for (const [k, f] of Object.entries(fm.facts ?? {})) { const kept = dropSecret(f); if (kept) fm.facts![k] = kept; else delete fm.facts![k]; }
    for (const [k, rs] of Object.entries(fm.history ?? {})) { const kept = rs.filter((r) => !isSecret(r)); if (kept.length) fm.history![k] = kept; else delete fm.history![k]; }
    // Values a secret fact held may sit anywhere else in the note; the text is parsed back below.
    const text = blank(serializeNote({ fm, body: n.body, path: n.path }), secrets);
    const back = parseNote(text, n.path);
    return { fm: back.fm, body: back.body };
  });
  const rules: Record<string, string> = {};
  for (const f of BUNDLE_RULES) { const p = join(root, "rules", f); if (existsSync(p)) rules[f] = readFileSync(p, "utf8"); }
  return { memory_passport: BUNDLE_VERSION, bundle: "brain", exported: today(), owner: ownerName(loadRules(root)), notes, rules };
}

// One agent's view, as its own reads would answer (no token role: the agent's full carve).
export function exportSlice(root: string, agent: string): SliceBundle {
  const rules = loadRules(root);
  if (!rules.policy.agents[agent]) throw new Error(`no agent ${agent} in policy.yaml`);
  const res = withoutTokenRole(() => carve(loadBrain(root), rules, grantFor(rules, agent)));
  // The fields core.readNote serves, built the same way.
  const notes = [...res.visible.values()].map((v) => ({
    id: v.note.fm.id, title: v.note.fm.title, type: v.note.fm.type, area: v.note.fm.area, aliases: v.note.fm.aliases ?? [],
    facts: Object.fromEntries(visibleFacts(v, res).map(([a, f]) => [a, agentFact(f, agent, res)])),
    ...(v.body && v.note.body.trim() ? { body: scrubPage(v.note.body, v, res) } : {}),
  })).sort((a, b) => a.id.localeCompare(b.id));
  return { memory_passport: BUNDLE_VERSION, bundle: "slice", exported: today(), agent, notes };
}

// A brain bundle into a folder that doesn't exist or is empty: notes, the carve's rules, one
// commit by the owner. Refuses anything that isn't a brain bundle, and any id or rules file outside
// what export writes, before it writes a byte.
export function importBundle(file: string, into: string): { notes: number; rules: string[] } {
  let b: unknown;
  try { b = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new Error(`not a JSON bundle: ${(e as Error).message}`); }
  const bundle = b as { memory_passport?: unknown; bundle?: unknown; exported?: unknown; notes?: { fm: Note["fm"]; body?: unknown }[]; rules?: unknown };
  if (!bundle || typeof bundle !== "object" || typeof bundle.memory_passport !== "string") throw new Error("not a Memory Passport bundle");
  if (bundle.bundle === "slice") throw new Error("a slice bundle is one agent's view, for another memory tool; import takes a brain bundle (pocketbrain export)");
  if (bundle.bundle !== "brain" || !Array.isArray(bundle.notes) || !bundle.rules || typeof bundle.rules !== "object") throw new Error("not a brain bundle");
  if (existsSync(into) && readdirSync(into).length) throw new Error(`${into} isn't empty: import makes a fresh brain`);
  const notes: Note[] = [];
  const seen = new Set<string>();
  for (const n of bundle.notes) {
    const id = (n as { fm?: { id?: unknown } })?.fm?.id;
    if (typeof id !== "string" || !ID.test(id)) throw new Error(`bad note id ${JSON.stringify(id)}`);
    if (seen.has(id)) throw new Error(`note ${id} twice`);
    seen.add(id);
    // Through the parser, as if read from disk: what can't be a note fails here.
    notes.push(parseNote(serializeNote({ fm: n.fm, body: typeof n.body === "string" ? n.body : "", path: `${id}.md` }), `${id}.md`));
  }
  const rules = Object.entries(bundle.rules as Record<string, unknown>);
  for (const [f, text] of rules) if (!BUNDLE_RULES.includes(f) || typeof text !== "string") throw new Error(`rules/${f} isn't something export writes`);
  if (!rules.some(([f]) => f === "policy.yaml")) throw new Error("the bundle has no rules/policy.yaml");
  mkdirSync(join(into, "rules"), { recursive: true });
  for (const [f, text] of rules) writeFileSync(join(into, "rules", f), text as string);
  for (const n of notes) saveNote(into, n);
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: into });
  git(into, ["add", "-A"], OWNER);
  git(into, ["commit", "-q", "-m", `import: Memory Passport bundle of ${String(bundle.exported ?? "an unknown day").slice(0, 10)} (${notes.length} notes)`], OWNER);
  return { notes: notes.length, rules: rules.map(([f]) => f).sort() };
}
