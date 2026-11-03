// SPDX-License-Identifier: AGPL-3.0-only
// Same person? (docs/same-person.md). One person often lands in the brain as several person notes,
// one per email, phone number or handle a source saw. Two active person notes that share an address
// both sides trust (owner-confirmed or verified by a source, current, not disputed) become one
// proposal for the owner, with the shared address and its refs as the evidence. A name alone never
// does (upkeep's possible-duplicate line covers that). Nothing merges until the owner says so, at any
// score; the merge is `mergeNotes` (never picks a winner) and is undone by reverting its commit.
// Owner-only: agents never see proposals.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { FactRecord, Note } from "./brain";
import { loadBrain, isDisputed } from "./brain";
import { loadRules, attributeSpec, captureAgentName, type Rules } from "./rules";
import { records } from "./carve";
import { compareKey } from "./normalize";
import { refString, ownerVouched } from "./sources";
import { mergeNotes, mergeBlocked } from "./merge";
import { parseAddress, loadStanding } from "./standing";
import { git, gitRun, authorEnv } from "./git";
import { hubGate } from "./hub";
import { CoreError } from "./core";
import { sha256, appendJsonl, readJsonl } from "./util";
import { OWNER } from "./owner";
import { checkedRefs } from "./louis";

export type AddressKind = "email" | "phone" | "handle";
export interface Evidence { kind: AddressKind; address: string; refs: string[]; added_by: string[]; on: Record<string, { refs: string[]; added_by: string[] }> }
export interface SamePerson { id: string; keep: string; drop: string; titles: [string, string]; score: number; evidence: Evidence[]; private: boolean; swap_moves_standing: boolean; standing_note?: string; blocked?: string; swap_blocked?: string; card: string }
export interface PersonMerge { id: string; keep: string; drop: string; commit: string; evidence: Evidence[]; at: string }

// The bar, in code: a shared email or phone number (0.9) qualifies; a shared handle (0.7), even with
// a matching name (+0.1), doesn't. Raising the score never merges anything by itself.
const WEIGHT: Record<AddressKind, number> = { email: 0.9, phone: 0.9, handle: 0.7 };
const NAME_BONUS = 0.1;
export const SAME_PERSON_BAR = 0.9;
const NOUN: Record<AddressKind, string> = { email: "an email address", phone: "a phone number", handle: "a handle" };

const dir = (root: string) => join(root, "log", "people");
const mergesFile = (root: string) => join(dir(root), "merges.jsonl");
const notSameFile = (root: string) => join(dir(root), "not-same.json");

// A source-verified address counts only while no ref it cites was found missing by the connector
// (log/refs-checked.jsonl), so a forged message id can't vouch for it. An address the owner approved
// on a card (approved:, which only the hub writes) is trusted as before taps ranked as their source.
// A card ref vouches only on a record the hub filed (the capture agent's, or an inside-wall agent's,
// as write.ts weighs it): a record saved before G581 by an assistant citing a borrowed card still
// says verified-by-source, and it never makes the address it planted a known sender (audit v9).
const cardOnly = (r: FactRecord, rules: Rules) => {
  const refs = r.sources.map(refString);
  return refs.some((x) => x.startsWith("contacts:")) && refs.every((x) => x.startsWith("contacts:") || x.startsWith("agent:"))
    && r.by !== captureAgentName(rules.policy) && !(r.by && rules.policy.agents[r.by]?.inside_wall);
};
// For a sender (`found`), only once a ref it cites was checked and found too (audit v10, G615): an
// assistant's own verified-by-source label on a mail id nobody read vouched for any address it
// planted. A pull marks the items it read, the nightly recheck the rest (src/louis.ts
// recordCheckedRefs). A same-person proposal still waits for the owner's click either way.
const trusted = (r: FactRecord, rules: Rules, checked?: Map<string, boolean>, found = false) => !r.valid_to && !r.retired
  && (ownerVouched(r) || (r.verification === "verified-by-source" && !cardOnly(r, rules) && !r.sources.some((x) => checked?.get(refString(x)) === false) && (!found || r.sources.some((x) => checked?.get(refString(x)) === true))));

function kindOf(rules: Rules, type: string, attr: string): AddressKind | undefined {
  const n = attributeSpec(rules, type, attr).normalize;
  if (n === "email" || attr === "email" || attr === "emails") return "email";
  if (n === "e164" || attr === "phone" || attr === "phones") return "phone";
  if (attr === "handle" || attr === "handles") return "handle";
  return undefined;
}

export function normalizeAddress(kind: AddressKind, raw: string): string | undefined {
  if (kind === "handle") return /^[a-z][\w.+-]*:[^\s:]+$/i.test(raw.trim()) ? raw.trim().toLowerCase() : undefined;
  const a = parseAddress(raw);
  if (!a) return undefined;
  return (kind === "email") === a.includes("@") ? a : undefined;
}

// The hash a read item's sender is kept under (log/refs-checked.jsonl): its address in the form
// person pages key it by, so the log never holds an address in plain text (unsalted: a short one can be guessed back). undefined: no address to read.
export function senderHash(from: string | undefined): string | undefined {
  if (!from?.trim()) return undefined;
  for (const kind of ["email", "phone", "handle"] as AddressKind[]) {
    const a = normalizeAddress(kind, from);
    if (a) return sha256(`${kind}:${a}`);
  }
  return undefined;
}

// A ref the hub read vouches for one address: a mail's, the one it came from; a contact card's,
// any address on it, but only on a record the hub filed from that card (the capture agent or an
// inside-wall agent, as cardOnly weighs it), so no assistant borrows a card for its own address.
const hubFiled = (r: FactRecord, rules: Rules) => r.by === captureAgentName(rules.policy) || !!(r.by && rules.policy.agents[r.by]?.inside_wall);
function vouchesFor(ref: string, key: string, r: FactRecord, rules: Rules, checked?: Map<string, boolean>, senders?: Map<string, string>): boolean {
  if (ref.startsWith("contacts:")) return checked?.get(ref) === true && hubFiled(r, rules);
  return senders?.get(ref) === sha256(key);
}

// Every trusted address on a person note, with the refs that vouch for it. `senders` (with found):
// a source-verified address counts only when a ref it cites was read from that very address
// (audit v11, G643: a real mail id the hub had read vouched for any address an assistant planted).
export function trustedAddresses(note: Note, rules: Rules, checked?: Map<string, boolean>, o: { found?: boolean; senders?: Map<string, string> } = {}): Map<string, { kind: AddressKind; refs: string[]; by: string[] }> {
  const out = new Map<string, { kind: AddressKind; refs: string[]; by: string[] }>();
  for (const [attr, f] of Object.entries(note.fm.facts ?? {})) {
    const kind = kindOf(rules, note.fm.type, attr);
    if (!kind || isDisputed(f)) continue;
    for (const r of records(f)) {
      if (typeof r.value !== "string" || !trusted(r, rules, checked, o.found)) continue;
      const a = normalizeAddress(kind, r.value);
      if (!a) continue;
      const key = `${kind}:${a}`;
      if (o.found && !ownerVouched(r) && !r.sources.some((x) => vouchesFor(refString(x), key, r, rules, checked, o.senders))) continue;
      const e = out.get(key) ?? { kind, refs: [], by: [] };
      e.refs.push(...r.sources.map(refString));
      if (r.by) e.by.push(r.by);
      out.set(key, e);
    }
  }
  return out;
}

// The owner's standing entry for this note, unless it was placed on an earlier note with the same id
// (the same rule as standing.ts entryFor): a stale entry never comes back through a merge.
type Entries = ReturnType<typeof loadStanding>["people"];
const liveEntry = (st: Entries, n: Note) => {
  const e = st[n.fm.id];
  return e && (!e.note_created || e.note_created === String(n.fm.created ?? "")) ? e : undefined;
};
const sameStanding = (a: Entries[string], b: Entries[string]) => a.tier === b.tier && (a.authority ?? "") === (b.authority ?? "");

const names = (n: Note) => [n.fm.title, ...(n.fm.aliases ?? [])].filter(Boolean).map((x) => compareKey(x));
const pairKey = (a: string, b: string) => [a, b].sort().join(" ");

function loadNotSame(root: string): Record<string, string[]> {
  try { return existsSync(notSameFile(root)) ? JSON.parse(readFileSync(notSameFile(root), "utf8")) : {}; } catch { return {}; }
}
function saveNotSame(root: string, d: Record<string, string[]>) {
  mkdirSync(dir(root), { recursive: true });
  writeFileSync(notSameFile(root), JSON.stringify(d, null, 2) + "\n");
}

// The rules as a merge of `drop` into `keep` leaves them, for the before/after carve (G200): the
// kept note carries the dropped note's standing entry when it had none (mergeSamePerson moves it),
// so an agent that can't read that standing today must not read it on the kept note after.
function rulesAfterMerge(rules: Rules, keep: Note, drop: Note): Rules {
  const people = rules.standing?.people ?? {};
  const live = (n: Note) => { const e = people[n.fm.id]; return e && (!e.note_created || e.note_created === String(n.fm.created ?? "")) ? e : undefined; };
  const moved = live(drop);
  if (!rules.standing || live(keep) || !moved) return rules;
  return { ...rules, standing: { ...rules.standing, people: { ...people, [keep.fm.id]: { ...moved, note_created: String(keep.fm.created ?? "") } } } };
}

export function samePersonProposals(root: string, notes = loadBrain(root)): SamePerson[] {
  const rules = loadRules(root);
  const people = notes.filter((n) => n.fm.type === "person" && n.fm.status === "active").sort((a, b) => String(a.fm.created ?? "").localeCompare(String(b.fm.created ?? "")) || a.fm.id.localeCompare(b.fm.id));
  const checked = checkedRefs(root);
  const held = new Map(people.map((n) => [n.fm.id, trustedAddresses(n, rules, checked)]));
  const byAddress = new Map<string, Note[]>();
  for (const n of people) for (const key of held.get(n.fm.id)!.keys()) byAddress.set(key, [...(byAddress.get(key) ?? []), n]);
  const pairs = new Map<string, [Note, Note]>();
  for (const ns of byAddress.values()) for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) pairs.set(pairKey(ns[i].fm.id, ns[j].fm.id), [ns[i], ns[j]]);
  const notSame = loadNotSame(root);
  const out: SamePerson[] = [];
  const st = loadStanding(root).people;
  for (const [pk, [older, newer]] of pairs) {
    const a = held.get(older.fm.id)!, b = held.get(newer.fm.id)!;
    const shared = [...a.keys()].filter((k) => b.has(k)).sort();
    // The owner said "not the same" for these addresses: only a new shared one asks again.
    if (notSame[pk] && shared.every((k) => notSame[pk].includes(k))) continue;
    const side = (h: typeof a, k: string) => ({ refs: [...new Set(h.get(k)!.refs)].sort(), added_by: [...new Set(h.get(k)!.by)].sort() });
    const evidence: Evidence[] = shared.map((k) => ({
      kind: a.get(k)!.kind, address: k.slice(k.indexOf(":") + 1),
      refs: [...new Set([...a.get(k)!.refs, ...b.get(k)!.refs])].sort(), added_by: [...new Set([...a.get(k)!.by, ...b.get(k)!.by])].sort(),
      on: { [older.fm.id]: side(a, k), [newer.fm.id]: side(b, k) },
    }));
    const nameMatch = names(older).some((x) => names(newer).includes(x));
    const score = Math.round((Math.max(...evidence.map((e) => WEIGHT[e.kind])) + (nameMatch ? NAME_BONUS : 0)) * 100) / 100;
    if (score < SAME_PERSON_BAR) continue;
    // Keep the note the owner placed in standing; otherwise the older one (more history).
    const [keep, drop] = !liveEntry(st, older) && liveEntry(st, newer) ? [newer, older] : [older, newer];
    const sk = liveEntry(st, keep), sd = liveEntry(st, drop);
    const priv = [keep, drop].some((n) => n.fm.sensitivity === "private" || n.fm.sensitivity === "secret");
    const why = evidence.map((e) => priv ? `a private note shares ${NOUN[e.kind]}` : `same ${e.kind} ${e.address} (${[keep, drop].map((n) => `${n.fm.title}: from ${e.on[n.fm.id].refs.join(", ")}, added by ${e.on[n.fm.id].added_by.join(", ") || "nobody named"}`).join("; ")})`).join("; ");
    const standing = sk && sd ? (sameStanding(sk, sd) ? `Both are ${sk.tier} in your standing; the pins combine.` : `Both have a standing (${sk.tier}, ${sd.tier}); set one before merging.`) : "";
    // Still listed when the rules keep the two apart (areas, excludes, an open dispute), with the
    // reason in plain words and no Merge offered that way (G150-G152, G155).
    const blocked = mergeBlocked(rules, keep, drop, rulesAfterMerge(rules, keep, drop), notes), swapBlocked = mergeBlocked(rules, drop, keep, rulesAfterMerge(rules, drop, keep), notes);
    const stop = blocked ? ` Can't merge here: ${blocked}.` : "";
    out.push({
      id: `sp-${sha256(`${pk} ${shared.join(" ")}`).slice(0, 12)}`, keep: keep.fm.id, drop: drop.fm.id, titles: [keep.fm.title, drop.fm.title],
      score, evidence, private: priv, swap_moves_standing: !!sk && !sd, ...(standing ? { standing_note: standing } : {}),
      ...(blocked ? { blocked } : {}), ...(swapBlocked ? { swap_blocked: swapBlocked } : {}),
      card: `Same person? ${keep.fm.title} and ${drop.fm.title}: ${why}.${standing ? ` ${standing}` : ""}${stop}`,
    });
  }
  return out.sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));
}

function find(root: string, id: string): SamePerson {
  const p = samePersonProposals(root).find((x) => x.id === id);
  if (!p) throw new CoreError(404, `no proposal ${id} (it was answered, or the notes changed); reload`);
  return p;
}

export function personMerges(root: string): PersonMerge[] {
  const rows = readJsonl<PersonMerge & { undone?: string }>(mergesFile(root));
  const undone = new Set(rows.filter((r) => r.undone).map((r) => r.undone));
  return rows.filter((r) => !r.undone && !undone.has(r.commit));
}

// The owner's yes. Standing follows the person: the dropped note's entry moves to the kept note in
// the same commit; two different entries wait for the owner to pick one (standing is his word).
export function mergeSamePerson(root: string, id: string, opts: { swap?: boolean } = {}): string {
  const p = find(root, id);
  // Areas, excludes by name and open disputes: refused before anything is written.
  const blocked = opts.swap ? p.swap_blocked : p.blocked;
  if (blocked) throw new CoreError(409, `can't merge here: ${blocked}`);
  // A replica commits nothing but its own ops: refuse before anything is written.
  hubGate(root, ["commit"]);
  const [keep, drop] = opts.swap ? [p.drop, p.keep] : [p.keep, p.drop];
  const notes = loadBrain(root);
  const keepNote = notes.find((n) => n.fm.id === keep)!, dropNote = notes.find((n) => n.fm.id === drop)!;
  const st = loadStanding(root).people;
  const sk = liveEntry(st, keepNote), sd = liveEntry(st, dropNote);
  if (sk && sd && !sameStanding(sk, sd))
    throw new CoreError(409, `both notes have a standing (${sk.tier}, ${sd.tier}); set one standing for this person first, then merge`);
  const also: string[] = [];
  if (sd) {
    const f = join(root, "rules", "standing.yaml");
    const raw = (YAML.parse(readFileSync(f, "utf8")) ?? {}) as { people?: Record<string, Record<string, unknown>> };
    const people = raw.people ?? {};
    const pins = [...new Set([...(sk?.addresses ?? []), ...(sd.addresses ?? [])])].sort();
    people[keep] = { ...people[drop], ...(sk ? people[keep] : {}), ...(pins.length ? { addresses: pins } : {}), note_created: String(keepNote.fm.created ?? "") };
    delete people[drop];
    writeFileSync(f, "# Who matters to the owner (docs/standing.md). Only the owner edits this file (pocketbrain standing).\n"
      + YAML.stringify({ ...raw, people }, { aliasDuplicateObjects: false }));
    also.push("rules/standing.yaml");
  }
  const before = git(root, ["rev-parse", "HEAD"]);
  const disputesDir = join(root, "disputes");
  const hadDisputes = new Set(existsSync(disputesDir) ? readdirSync(disputesDir) : []);
  let r: ReturnType<typeof mergeNotes> | undefined, err: unknown;
  try { r = mergeNotes(root, keep, drop, OWNER, { also }); } catch (e) { err = e; }
  const commit = git(root, ["rev-parse", "HEAD"]);
  if (err || !r?.ok || commit === before) {
    // Nothing half-done stays behind: the notes and standing go back to the last commit.
    const touched = [keepNote.path, dropNote.path].map((x) => x.startsWith(root) ? x.slice(root.length + 1) : x).concat(also);
    git(root, ["reset", "-q", "--", ...touched]);
    git(root, ["checkout", "--", ...touched]);
    // Disputes the merge opened go too, so no later commit sweeps them in.
    for (const f of existsSync(disputesDir) ? readdirSync(disputesDir).filter((x) => !hadDisputes.has(x)) : []) {
      git(root, ["rm", "-q", "--cached", "--ignore-unmatch", `disputes/${f}`]);
      rmSync(join(disputesDir, f), { force: true });
    }
    if (err) throw err;
    throw new CoreError(409, r?.ok ? "the merge wasn't saved; nothing changed" : r!.message);
  }
  mkdirSync(dir(root), { recursive: true });
  appendJsonl(mergesFile(root), { id, keep, drop, commit, evidence: p.evidence, at: new Date().toISOString() });
  return r.message;
}

export function notSamePerson(root: string, id: string): string {
  const p = find(root, id);
  const d = loadNotSame(root);
  const pk = pairKey(p.keep, p.drop);
  d[pk] = [...new Set([...(d[pk] ?? []), ...p.evidence.map((e) => `${e.kind}:${e.address}`)])].sort();
  saveNotSame(root, d);
  return `${p.titles[0]} and ${p.titles[1]} stay apart; asked again only if they share a new address`;
}

// Undo: revert the merge commit as the owner, only while nothing has touched either note (or
// this pair's standing entries) since. Upkeep's link repoints that turned [[drop]] into [[keep]] after the merge are
// reverted with it (G154), so links in other notes point at the right person again and a hidden
// note shows as [[redacted]] again; those repoint commits are the only later change allowed. The
// pair then counts as "not the same" for the same evidence.
export function undoPersonMerge(root: string, id: string): string {
  const m = personMerges(root).filter((x) => x.id === id).at(-1);
  if (!m) throw new CoreError(404, `no merge ${id} to undo`);
  const notes = loadBrain(root);
  const paths = [m.keep, m.drop].map((nid) => notes.find((n) => n.fm.id === nid)?.path).filter((x): x is string => !!x).map((p) => p.startsWith(root) ? p.slice(root.length + 1) : p);
  // Earlier pointers the merge repointed from the dropped note to the kept one (G246) go back with
  // it, so a later change to one of them blocks the undo too.
  for (const f of git(root, ["show", "--name-only", "--format=", m.commit]).split("\n"))
    if (f.endsWith(".md") && !f.startsWith("disputes/") && !f.startsWith("rules/") && !paths.includes(f)) paths.push(f);
  const repoints = derivedSince(root, m);
  const later = git(root, ["log", "--format=%H", `${m.commit}..HEAD`, "--", ...paths]).split("\n").filter((c) => c && !repoints.includes(c));
  // Standing counts only for this pair: someone else's entry changing since doesn't block the undo.
  const pairStanding = (rev: string) => {
    const r = gitRun(root, ["show", `${rev}:rules/standing.yaml`]);
    const people = (r.ok ? (YAML.parse(r.out) as { people?: Record<string, unknown> } | null)?.people : undefined) ?? {};
    return JSON.stringify([people[m.keep] ?? null, people[m.drop] ?? null]);
  };
  if (pairStanding(m.commit) !== pairStanding("HEAD"))
    later.push(...git(root, ["log", "--format=%H", `${m.commit}..HEAD`, "--", "rules/standing.yaml"]).split("\n").filter(Boolean));
  if (later.length) throw new CoreError(409, `${m.keep} or ${m.drop} changed since the merge (${later.map((c) => c.slice(0, 7)).join(", ")}); undo those first or fix it by hand`);
  hubGate(root, ["revert"]);
  // Newest first, the merge last, in one sequence so a conflict anywhere aborts all of it.
  const r = Bun.spawnSync(["git", "revert", "--no-commit", ...repoints, m.commit], { cwd: root, env: authorEnv(root, OWNER) });
  if (r.exitCode !== 0) {
    // Someone else's standing entry changed next to this pair's: put this pair's entries back by
    // hand (they haven't changed since the merge, checked above) and keep everyone else's.
    const unmerged = git(root, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
    if (unmerged.length !== 1 || unmerged[0] !== "rules/standing.yaml" || !restorePairStanding(root, m)) {
      Bun.spawnSync(["git", "revert", "--abort"], { cwd: root });
      throw new CoreError(409, "a later change touched the same lines; undo it in git by hand");
    }
  }
  const done = gitRun(root, ["commit", "-q", "-m", `undo same-person merge of ${m.drop} into ${m.keep}\n\nReverts ${m.commit}${repoints.length ? ` and the link repoints and page text ${repoints.join(", ")}` : ""}.`], OWNER);
  if (!done.ok) {
    Bun.spawnSync(["git", "revert", "--abort"], { cwd: root });
    Bun.spawnSync(["git", "reset", "-q", "--merge"], { cwd: root });
    throw new CoreError(409, `the undo wasn't saved (${done.err || done.out}); nothing changed`);
  }
  Bun.spawnSync(["git", "revert", "--quit"], { cwd: root });
  appendJsonl(mergesFile(root), { id, undone: m.commit, at: new Date().toISOString() });
  const d = loadNotSame(root);
  const pk = pairKey(m.keep, m.drop);
  d[pk] = [...new Set([...(d[pk] ?? []), ...m.evidence.map((e) => `${e.kind}:${e.address}`)])].sort();
  saveNotSame(root, d);
  const links = repoints.filter((c) => !pageText(root, c)).length, texts = repoints.length - links;
  const also = [links ? `${links} link repoint${links === 1 ? "" : "s"}` : "", texts ? "the page text written since" : ""].filter(Boolean).join(" and ");
  return `undid the merge of ${m.drop} into ${m.keep}; both notes are back${also ? `, and ${also} with them` : ""}`;
}

// standing.yaml as it is now, with this pair's two entries as they were before the merge.
function restorePairStanding(root: string, m: PersonMerge): boolean {
  const at = (rev: string) => {
    const r = gitRun(root, ["show", `${rev}:rules/standing.yaml`]);
    return r.ok ? ((YAML.parse(r.out) ?? {}) as { people?: Record<string, unknown> }) : undefined;
  };
  const now = at("HEAD"), before = at(`${m.commit}^`);
  if (!now) return false;
  const people = { ...(now.people ?? {}) };
  for (const id of [m.keep, m.drop]) {
    if (before?.people?.[id]) people[id] = before.people[id];
    else delete people[id];
  }
  writeFileSync(join(root, "rules", "standing.yaml"), "# Who matters to the owner (docs/standing.md). Only the owner edits this file (pocketbrain standing).\n"
    + YAML.stringify({ ...now, people }, { aliasDuplicateObjects: false }));
  return gitRun(root, ["add", "rules/standing.yaml"]).ok;
}

// The commits since the merge that undo takes back with it, newest first: upkeep's link repoints
// and the page writer's text (src/wiki.ts renderTouchedPages), which is drawn from the facts and is
// written again the next night. Only the page writer's own shape counts: authored by hub, its
// Kind trailer, page files only.
export function derivedSince(root: string, m: PersonMerge): string[] {
  const repoints = new Set(linkRepoints(root, m));
  return git(root, ["log", "--format=%H", `${m.commit}..HEAD`]).split("\n").filter(Boolean).filter((c) => repoints.has(c) || pageText(root, c));
}
function pageText(root: string, c: string): boolean {
  if (git(root, ["show", "-s", "--format=%an", c]) !== "hub" || !/^Kind: page-writer$/m.test(git(root, ["show", "-s", "--format=%B", c]))) return false;
  const files = git(root, ["show", "--name-only", "--format=", c]).split("\n").filter(Boolean);
  return files.length > 0 && files.every((f) => f.endsWith(".md") && /^(people|orgs|projects|decisions|notes)\//.test(f));
}

// Upkeep's commits since the merge that rewrote [[drop]] links to [[keep]] (upkeep.ts, link pass),
// newest first. Only upkeep's own shape counts (G171): authored by reflect, its auto-fix trailers,
// one note file, a diff that turns [[drop into [[keep. A commit that merely says "repoint"
// is a later change like any other and still blocks the undo.
function linkRepoints(root: string, m: PersonMerge): string[] {
  const drop = `[[${m.drop}`, keep = `[[${m.keep}`;
  return git(root, ["log", "--format=%H", "--author=^reflect <", "--grep=^reflect: repoint links in ", `${m.commit}..HEAD`]).split("\n").filter(Boolean).filter((c) => {
    if (git(root, ["show", "-s", "--format=%an", c]) !== "reflect") return false;
    const body = git(root, ["show", "-s", "--format=%B", c]);
    if (!/^Agent: reflect$/m.test(body) || !/^Kind: auto-fix$/m.test(body)) return false;
    const files = git(root, ["show", "--name-only", "--format=", c]).split("\n").filter(Boolean);
    if (files.length !== 1 || !files[0].endsWith(".md") || files[0].startsWith("rules/")) return false;
    const diff = git(root, ["show", "--format=", c]).split("\n");
    return diff.some((l) => l.startsWith("-") && !l.startsWith("---") && (l.includes(`${drop}]]`) || l.includes(`${drop}|`)))
      && diff.some((l) => l.startsWith("+") && !l.startsWith("+++") && (l.includes(`${keep}]]`) || l.includes(`${keep}|`)));
  });
}
