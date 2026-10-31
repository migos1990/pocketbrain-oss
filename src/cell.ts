// SPDX-License-Identifier: AGPL-3.0-only
// Cells: defence in depth for the read path. Without cells, every read loads the whole brain
// and filters it per request, so one bug in that filter could hand an agent anything. With
// cells, the hub writes each agent a directory holding only its carved slice (hidden facts
// dropped, carved values already scrubbed, no other agent in its policy), and the agent's
// reads are answered from that directory alone. A read-path bug can then leak only what the
// agent already holds. Writes, disputes and the relay stay on the hub, which alone sees the
// whole brain; after a committed write, the next read of a cell updates it in place, rewriting
// only the notes the change can reach (`affectedBy`), or rebuilds it in full when it can't tell.
//
// What this does not do: a cell is a directory read by the same process, not an OS sandbox.
// It protects against logic bugs in the read path, not against code running on the machine.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import YAML from "yaml";
import type { Fact, FactRecord, Note } from "./brain";
import { loadBrain, saveNote, isDisputed, isList, CONTENT_DIRS } from "./brain";
import { loadRules, tierOf } from "./rules";
import { carve, grantFor, linkFor, visibleFacts, shownUpdated, type CarveResult } from "./carve";
import { redactLinks, agentFact, needlesOf, guidanceFor, pageSummary } from "./view";
import { carriedForms, type Needle } from "./match";
import { escapeRe, textKeys, tokenKey } from "./util";
import { headCommit } from "./git";
import { standingForCell } from "./standing";
import { withoutTokenRole, withTokenRole } from "./tokenrole";

export interface CellInfo { agent: string; brain_commit: string; rules_commit: string; rules_hash?: string; code?: string; slices: string[]; not_shared: string[]; notes: number }

// The code that builds cells, as a hash of every source file and the dependency lock: cells are kept on disk across
// restarts (startCells), and one built by other code (an upgrade that changed carve, view or the
// scrub) is rebuilt before it is served, never trusted.
let codeHash: string | undefined;
function cellCode(): string {
  if (!codeHash) {
    const h = createHash("sha256");
    const dir = import.meta.dir;
    const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".ts")) h.update(relative(dir, p)).update("\0").update(readFileSync(p)); } };
    walk(dir);
    // The dependencies too (the YAML parser shapes every note a cell holds).
    for (const f of ["package.json", "bun.lock"]) { const p = join(dir, "..", f); if (existsSync(p)) h.update(f).update("\0").update(readFileSync(p)); }
    codeHash = h.digest("hex").slice(0, 16);
  }
  return codeHash;
}

// What rules/ holds on disk, committed or not. The plain read path loads rules/ from disk on every
// request, so an owner's uncommitted edit (a new exclude, a pause) applies at once; a cell built
// before the edit must notice it too (bug hunt A5), not wait for the next commit.
export function rulesHash(root: string): string {
  const h = createHash("sha256");
  const walk = (dir: string, rel: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name), r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) h.update(r).update("\0").update(readFileSync(p)).update("\0");
    }
  };
  walk(join(root, "rules"), "rules");
  return h.digest("hex").slice(0, 16);
}

export const cellsDir = (root: string) => join(root, ".cells");
export const cellDir = (root: string, agent: string) => join(cellsDir(root), agent);

// Cells are on when the hub was started with them (serve --cells) or the brain asks for them.
let enabled = process.env.PB_CELLS === "1";
export function useCells(on: boolean) { enabled = on; }
export function cellsOn(): boolean { return enabled; }

// Build one agent's cell from the full brain. Written to a temp dir and swapped in, so a read
// never sees a half-built cell.
export function buildCell(root: string, agent: string, notes?: Note[], slices?: string[]): CellInfo {
  notes ??= loadBrain(root, { shared: true });
  // The cell holds the agent's whole slice whichever token asked; a reader token is capped when it reads.
  return withoutTokenRole(() => build(root, agent, notes, slices));
}

// A reader token's cell for the sealed edge (G249): carved under the reader role, so capped below
// private like any read by that token, and kept apart from the agent's own cell (the hub reads
// that one and caps per request). The edge seals it under its own key, wrapped for reader tokens
// only, so a reader token's holder can decrypt nothing above personal.
const READER_DIR = ".edge-reader";
export const readerCellDir = (root: string, agent: string) => join(cellsDir(root), READER_DIR, agent);
export function buildReaderCell(root: string, agent: string): { dir: string; info: CellInfo } {
  const dir = readerCellDir(root, agent);
  mkdirSync(dirname(dir), { recursive: true });
  const info = withTokenRole(agent, "reader", () => build(root, agent, loadBrain(root, { shared: true }), undefined, dir));
  return { dir, info };
}

// Per cell, what the last build in this process wrote: what its notes' rendering depended on
// (Deps) and, per note, its source and the file written. The next build renders again only the
// notes a change can reach (affectedBy): a full build of a 10k-note brain takes seconds, and
// the first read after every write waited for it (docs/perf.md).
interface Deps { grant: string; values: string[]; needles: Map<string, Needle>; visible: Map<string, boolean>; hidden: Map<string, string>; mergedTo: Map<string, string> }
const built = new Map<string, { deps: Deps; notes: Map<string, Rendered> }>();
// A note's cell file: its source, path, the note it came from and whether the file holds
// "[withheld]" (the exact pass changed it, so a needle can find what that left).
interface Rendered { src: string; text: string; note: Note; withheld: boolean }

function depsOf(res: CarveResult): Deps {
  const hidden = new Map<string, string[]>();
  for (const h of res.hiddenFacts) { const id = h.key.slice(0, h.key.indexOf("#")); (hidden.get(id) ?? hidden.set(id, []).get(id)!).push(h.key); }
  return {
    grant: JSON.stringify(res.grant),
    values: res.carvedValues ?? [],
    needles: new Map(needlesOf(res).map((n) => [JSON.stringify([n.value, n.squashed, n.digits ?? "", n.parts]), n])),
    visible: new Map([...res.visible].map(([id, v]) => [id, v.body])),
    hidden: new Map([...hidden].map(([id, keys]) => [id, keys.sort().join("\n")])),
    mergedTo: new Map(res.mergedTo ?? []),
  };
}

// Which visible notes can render differently under `next` than under `last`, besides notes
// whose own source changed: undefined means all of them. A note is reached when its hidden
// facts or body grant changed, when it names a note that came into or left the slice (a link
// is kept or redacted), or when one of its strings holds the first words of a carved value
// added or dropped (the same test scrubCarved uses to try a value) or a line a disguised-value
// needle added or dropped finds; when needles change, also every note whose cell file holds
// "[withheld]" (G132). Anything that could reach a note without passing those tests
// (a grant change, a carved value or changed needle holding "withheld", "redacted", "[" or
// "]" in any case, carved values that changed order) rebuilds them all.
function affectedBy(last: Deps, next: Deps, res: CarveResult, seen?: WeakMap<Note, Forms>): ((id: string, note: Note, withheld: boolean) => boolean) | undefined {
  if (last.grant !== next.grant) return undefined;
  const lastSet = new Set(last.values), nextSet = new Set(next.values);
  const values = [...next.values.filter((v) => !lastSet.has(v)), ...last.values.filter((v) => !nextSet.has(v))];
  const kept = (xs: string[], other: Set<string>) => xs.filter((v) => other.has(v)).join("\0");
  if (kept(last.values, nextSet) !== kept(next.values, lastSet)) return undefined;
  const needles = [...[...next.needles].filter(([k]) => !last.needles.has(k)), ...[...last.needles].filter(([k]) => !next.needles.has(k))].map(([, n]) => n);
  if ([...values, ...needles.flatMap((n) => [n.value, n.squashed, ...n.parts])].some((v) => /withheld|redacted|[[\]]/i.test(v))) return undefined;
  const ids = new Set<string>();
  for (const [id, body] of next.visible) if (last.visible.get(id) !== body) ids.add(id);
  for (const id of last.visible.keys()) if (!next.visible.has(id)) ids.add(id);
  for (const id of new Set([...last.hidden.keys(), ...next.hidden.keys()])) if (last.hidden.get(id) !== next.hidden.get(id)) ids.add(id);
  const linked = [...ids].filter((id) => !res.visible.has(id) || !last.visible.has(id));
  // A link to a merged note shows the note it became while that one is in view (linkFor): a note
  // naming a merged note is reached when its target changed or came into or left the slice.
  for (const p of new Set([...last.mergedTo.keys(), ...next.mergedTo.keys()])) {
    const a = last.mergedTo.get(p), b = next.mergedTo.get(p);
    if (a !== b || (a && linked.includes(a)) || (b && linked.includes(b))) linked.push(p);
  }
  const keys = values.map(tokenKey);
  if (!values.length && !needles.length && !linked.length) return (id) => ids.has(id);
  // A value scrubCarved can't look up by its first words (it starts with a non-ASCII letter or a
  // separator) is tried on every string; here, on the note's whole text, without word edges.
  const unkeyed = values.filter((_, i) => keys[i] === undefined).map((v) => new RegExp(escapeRe(v), "iu"));
  return (id, note, withheld) => {
    if (ids.has(id)) return true;
    // findCarried reads a line after the exact pass: "[withheld]" can split an encoded run or
    // let a line decode, so a needle can find what the note's own text doesn't show.
    if (needles.length && withheld) return true;
    const f = formsOf(note, seen);
    if (linked.some((l) => f.text.includes(l))) return true;
    if (keys.some((k) => k !== undefined && f.keys.has(k))) return true;
    if (unkeyed.some((re) => re.test(f.text))) return true;
    return needles.some((n) => f.squashed.includes(n.squashed) || n.parts.some((p) => f.squashed.includes(p)) || (!!n.digits && f.digits.has(n.digits)));
  };
}

// Everything a note's strings offer the tests above, kept per frozen note (src/brain.ts): its
// text, the token keys scrubCarved looks values up by, and, line by line as findCarried reads
// them, its squashed forms and digit runs. A superset of what any one string or line holds, so
// it can only say a note may be reached, never miss one.
interface Forms { text: string; keys: Set<string>; squashed: string; digits: Set<string> }
const forms = new WeakMap<Note, Forms>();
function formsOf(note: Note, seen?: WeakMap<Note, Forms>): Forms {
  const hit = forms.get(note) ?? seen?.get(note);
  if (hit) return hit;
  const strings: string[] = [note.body];
  const walk = (v: unknown) => { if (typeof v === "string") strings.push(v); else if (typeof v === "number") strings.push(String(v)); else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x); };
  walk(note.fm);
  const keys = new Set<string>(), sq: string[] = [], digits = new Set<string>();
  for (const s of strings) {
    textKeys(s, keys);
    for (const line of s.split("\n")) { const c = carriedForms(line); sq.push(...c.sq); for (const d of c.digitRuns) digits.add(d); }
  }
  const f = { text: strings.join("\n"), keys, squashed: sq.join("|"), digits };
  if (Object.isFrozen(note)) forms.set(note, f);
  else seen?.set(note, f);
  return f;
}
// Each build in this process gets a number, so a read's cached carve (snapshot in core.ts) never
// outlives a rebuild that left cell.json the same.
const generations = new Map<string, number>();
let generation = 0;
export const cellGeneration = (dir: string) => generations.get(dir) ?? 0;
// Per cell, the files each in-place update since the last full build wrote or removed, so a
// read can reload only those (cellChangesSince).
const changes = new Map<string, { from: number; to: number; paths: string[] }[]>();

// The cell files changed since the build numbered `from`, or undefined when a full build came
// between (then every file may have changed).
export function cellChangesSince(dir: string, from: number): string[] | undefined {
  const paths = new Set<string>();
  let at = from;
  for (const c of changes.get(dir) ?? []) {
    if (c.to <= at) continue;
    if (c.from !== at) return undefined;
    for (const p of c.paths) paths.add(p);
    at = c.to;
  }
  return at === cellGeneration(dir) ? [...paths] : undefined;
}

// Which visible notes can read differently under carve `b` than under `a`, for notes whose own
// source is the same in both (the merge backstop, merge.ts): the test in-place cell updates rely on,
// with every note counted as holding "[withheld]" so a changed needle reaches all it could.
// `seen` keeps each note's forms across calls for notes that aren't frozen (one merge, many viewers).
export function mayReadDifferently(a: CarveResult, b: CarveResult, seen?: WeakMap<Note, unknown>): (id: string, note: Note) => boolean {
  const f = affectedBy(depsOf(a), depsOf(b), b, seen as WeakMap<Note, Forms> | undefined);
  return f ? (id, note) => f(id, note, true) : () => true;
}

// A note's cell file as text, for comparing what an agent would read (the merge backstop, merge.ts).
export function cellText(v: CarveResult["visible"] extends Map<string, infer V> ? V : never, agent: string, res: CarveResult): string {
  const n = cellNote(v, agent, res);
  return JSON.stringify(n.fm) + "\0" + n.body;
}

function cellNote(v: CarveResult["visible"] extends Map<string, infer V> ? V : never, agent: string, res: CarveResult): Note {
  const facts = Object.fromEntries(visibleFacts(v, res).map(([attr, f]) => [attr, agentFact(f, agent, res)]));
  const fm = { ...v.note.fm, facts: Object.keys(facts).length ? facts : undefined, updated: shownUpdated(v, res), by: undefined, history: undefined, legacy: undefined } as unknown as Note["fm"];
  // Decision links point only at notes in the slice; the rest become "redacted".
  const f = fm as unknown as Record<string, unknown>;
  for (const k of ["superseded_by", "supersedes", "merged_into"]) if (f[k] !== undefined) {
    const ids = [f[k]].flat().map(String).map((id) => linkFor(id, res) ?? "redacted");
    f[k] = Array.isArray(f[k]) ? ids : ids[0];
  }
  // The wiki fields (src/wiki.ts): the summary is text like the body, a parent outside the slice is dropped.
  if (f.summary !== undefined) f.summary = pageSummary(v, res);
  if (f.parent !== undefined && !(typeof f.parent === "string" && res.visible.has(f.parent))) f.parent = undefined;
  // Links to notes outside the slice are redacted here, so the cell never holds their ids.
  return { fm, body: v.body ? redactLinks(v.note.body, res) : "", path: v.note.path };
}

function build(root: string, agent: string, notes: Note[], slices?: string[], dir = cellDir(root, agent)): CellInfo {
  // Hash rules/ before reading them (eval gap G106): an edit landing mid-build then leaves a
  // stale hash, so freshCell rebuilds, never a cell from old rules stamped with the new hash.
  const rulesAt = rulesHash(root);
  const rules = loadRules(root);
  const a = rules.policy.agents[agent];
  if (!a || a.inside_wall) throw new Error(`${agent} has no grant`);
  // Built from the slices OpenFGA (src/fga.ts) confirms when the hub has it on; freshCell rebuilds
  // the cell when FGA's answer changes, so a tuple removed or added back takes effect on the next read.
  const grant = grantFor(rules, agent);
  if (slices) grant.slices = slices;
  const res = carve(notes, rules, grant, { flags: false });
  const tier = tierOf(rules, agent);
  const deps = depsOf(res);
  const last = built.get(dir);
  // Forgotten until this build ends: one that fails partway leaves the next to start from nothing.
  built.delete(dir);
  const from = cellGeneration(dir), gen = ++generation;
  generations.set(dir, gen);
  if (!last) changes.delete(dir);
  // The cell still on disk and a change that reaches only some notes: update it in place. Reads
  // run in this process, which is busy here, so none sees it half-updated; a crash mid-update
  // leaves cell.json at the old commit, so the next read builds it again.
  // Only a cell this code built is updated in place; any other is built again from nothing.
  const affected = last && infoAt(dir)?.code === cellCode() ? affectedBy(last.deps, deps, res) : undefined;
  const inPlace = !!affected;
  const target = inPlace ? dir : `${dir}.building`;
  const rendered = new Map<string, Rendered>();
  const touched: string[] = [];
  mkdirSync(cellsDir(root), { recursive: true });
  writeFileSync(join(cellsDir(root), ".gitignore"), "*\n"); // derived, never committed
  if (!inPlace) { rmSync(target, { recursive: true, force: true }); mkdirSync(join(target, "rules"), { recursive: true }); }

  for (const [id, v] of res.visible) {
    if (!inPlace) formsOf(v.note); // ready for the in-place updates that follow
    const prev = inPlace ? last!.notes.get(id) : undefined;
    // A note loaded shared is the same object while its file is unchanged (src/brain.ts).
    const src = prev && prev.note === v.note ? prev.src : JSON.stringify(v.note.fm) + "\0" + v.note.body;
    if (prev && prev.src === src && !affected!(id, v.note, prev.withheld)) { rendered.set(id, { ...prev, note: v.note }); continue; }
    const note = cellNote(v, agent, res);
    saveNote(target, note);
    touched.push(note.path);
    rendered.set(id, { src, text: note.path, note: v.note, withheld: JSON.stringify(note.fm).includes("[withheld]") || note.body.includes("[withheld]") });
  }
  if (inPlace) for (const [id, prev] of last!.notes) if (!rendered.has(id)) { rmSync(join(dir, prev.text), { force: true }); touched.push(prev.text); }

  const policy = {
    ...(rules.policy.owner ? { owner: rules.policy.owner } : {}),
    // The owner's context budget (src/context.ts), everyone's and this agent's own: reads served
    // from the cell take their rules from here.
    ...(rules.policy.context_budget ? { context_budget: rules.policy.context_budget } : {}),
    agents: { [agent]: { tier: a.tier, slices: ["all"], ...(a.context_budget ? { context_budget: a.context_budget } : {}) } },
    tiers: { [a.tier]: { max_sensitivity: res.grant.ceiling, writes: tier.writes } },
    areas: {},
  };
  // Rewritten only when changed, so an unchanged rules file keeps its parsed copy.
  const put = (f: string, text: string) => { if (!inPlace || !existsSync(f) || readFileSync(f, "utf8") !== text) writeFileSync(f, text); };
  put(join(target, "rules", "policy.yaml"), YAML.stringify(policy));
  put(join(target, "rules", "checks.yaml"), YAML.stringify({ checks: [], types: rules.checks.types ?? {} }));
  put(join(target, "rules", "RULES.md"), guidanceFor(rules, res));
  // Standing only for people whose standing this agent sees, never the owner's own addresses.
  put(join(target, "rules", "standing.yaml"), YAML.stringify(standingForCell(res, rules)));
  const info: CellInfo = { agent, brain_commit: headCommit(root), rules_commit: headCommit(root, "rules"), rules_hash: rulesAt, code: cellCode(), slices: res.grant.slices, not_shared: res.notShared, notes: res.visible.size };
  writeFileSync(join(target, "cell.json"), JSON.stringify(info, null, 2) + "\n");

  if (!inPlace) {
    rmSync(`${dir}.old`, { recursive: true, force: true });
    if (existsSync(dir)) renameSync(dir, `${dir}.old`);
    renameSync(target, dir);
    rmSync(`${dir}.old`, { recursive: true, force: true });
  }
  built.set(dir, { deps, notes: rendered });
  // Kept only for a chain of in-place updates; a full build starts it again.
  changes.set(dir, inPlace ? [...(changes.get(dir) ?? []), { from, to: gen, paths: touched }].slice(-16) : []);
  return info;
}

export function buildCells(root: string): CellInfo[] {
  const rules = loadRules(root);
  const notes = loadBrain(root, { shared: true });
  const agents = Object.entries(rules.policy.agents).filter(([, a]) => !a.inside_wall).map(([n]) => n);
  // An agent removed from the policy loses its cell; a revoked one keeps it, but no token reaches it.
  rmSync(cellsDir(root), { recursive: true, force: true });
  return agents.map((agent) => buildCell(root, agent, notes));
}

// At start: a cell for an agent no longer in the policy goes; the others stay on disk and each is
// checked (brain, rules, slices, code) and brought up to date on its agent's first read, so a
// restart answers at once instead of rebuilding every cell first (backlog row 217).
export function startCells(root: string): void {
  const rules = loadRules(root);
  if (!existsSync(cellsDir(root))) return;
  // A cell is current by commit; an uncommitted note edit (the owner raising a note by hand, then
  // restarting) isn't in any commit, so with one pending no kept cell is trusted.
  const dirty = Bun.spawnSync(["git", "status", "--porcelain", "--", ...CONTENT_DIRS], { cwd: root }).stdout.toString().trim();
  const keep = new Set(dirty ? [] : Object.entries(rules.policy.agents).filter(([, a]) => !a.inside_wall).map(([n]) => n));
  // The sealed edge's reader cells (readerCellDir) are kept and pruned the same way.
  const prune = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && !keep.has(e.name) && !(dir === cellsDir(root) && e.name === READER_DIR)) rmSync(join(dir, e.name), { recursive: true, force: true }); };
  prune(cellsDir(root));
  if (existsSync(join(cellsDir(root), READER_DIR))) prune(join(cellsDir(root), READER_DIR));
}

export function cellInfo(root: string, agent: string): CellInfo | undefined {
  return infoAt(cellDir(root, agent));
}
function infoAt(dir: string): CellInfo | undefined {
  const f = join(dir, "cell.json");
  // A torn file (a crash mid-write) is no cell: the next read builds it again.
  try { return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined; } catch { return undefined; }
}

// The cell to read from, rebuilt first if the brain moved on since it was built (an upkeep run,
// an edit by Louis, a write through the CLI).
export function freshCell(root: string, agent: string, slices?: string[]): { dir: string; info: CellInfo } {
  let info = cellInfo(root, agent);
  const same = !slices || (info && info.slices.length === slices.length && info.slices.every((s, i) => s === slices[i]));
  if (!info || info.brain_commit !== headCommit(root) || info.rules_hash !== rulesHash(root) || info.code !== cellCode() || !same) info = buildCell(root, agent, undefined, slices);
  return { dir: cellDir(root, agent), info };
}
