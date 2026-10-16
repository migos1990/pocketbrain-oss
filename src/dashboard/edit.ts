// SPDX-License-Identifier: AGPL-3.0-only
// Louis edits the brain from the dashboard: one fact at a time, or a whole note as text.
// He is the top of the conflict order, so an edit replaces the fact directly (the old record
// goes to history) as a confirmed-by-owner record. Each save is one git commit by the owner and
// one line in log/writes.jsonl. Secrets never go in, whoever types them; rules/ and conflict
// packets are not editable here.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { loadBrain, parseNote, saveNote, serializeNote, today, isList, isDisputed, CONTENT_DIRS, type Note, type FactRecord, type Sensitivity } from "../brain";
import { cap } from "./labels";
import { loadRules, attributeSpec } from "../rules";
import { normalizeValue } from "../normalize";
import { findSecret } from "../checks";
import { logWrite } from "../write";
import { git, authorEnv } from "../git";
import { OWNER, OWNER_CONFIRMED, isOwnerConfirmed, isOwnerId, ownerRef } from "../owner";
import { hubGate } from "../hub";
import { CoreError } from "../core";

const EDITABLE = CONTENT_DIRS.filter((d) => d !== "disputes");

export function editableNote(root: string, id: string): Note {
  const clean = id.replace(/\.md$/, "");
  if (!/^[a-z0-9_-]+(\/[A-Za-z0-9._-]+)+$/.test(clean) || clean.includes("..")) throw new CoreError(400, "bad note id");
  if (!EDITABLE.includes(clean.split("/")[0])) throw new CoreError(403, `${clean.split("/")[0]}/ isn't editable here`);
  const note = loadBrain(root).find((n) => n.fm.id === clean);
  if (!note) throw new CoreError(404, `no note ${clean}`);
  return note;
}

function commit(root: string, id: string, msg: string, keys: string[]) {
  git(root, ["add", id + ".md"]);
  git(root, ["commit", "-q", "-m", `owner: ${msg}\n\nKind: owner-edit${keys.length ? `\nFact-Keys: ${keys.join(", ")}` : ""}`], OWNER);
}

// Parses what Louis typed: JSON for objects, numbers and lists when it parses, else text.
function parseValue(raw: string): unknown {
  const t = raw.trim();
  if (/^[[{]/.test(t) || /^-?\d+(\.\d+)?$/.test(t)) { try { return JSON.parse(t); } catch { /* text */ } }
  return t;
}

export function setFact(root: string, id: string, attribute: string, raw: string, asOf?: string): string {
  const note = editableNote(root, id);
  const attr = attribute.trim();
  if (!/^[a-z][a-z0-9_]*$/.test(attr)) throw new CoreError(400, "attribute names are lowercase words joined by _");
  if (!raw.trim()) throw new CoreError(400, "empty value; delete the fact by editing the note text");
  const secret = findSecret(raw);
  if (secret) throw new CoreError(422, `that looks like ${secret}; secrets never go in the brain (keep it in your password manager)`);
  const d = today();
  const as_of = asOf?.trim() || d;
  if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(as_of)) throw new CoreError(400, "as of is a date like 2026-10-08");
  const rules = loadRules(root);
  const facts = (note.fm.facts ??= {});
  const old = facts[attr];
  if (isDisputed(old)) throw new CoreError(409, `${id}#${attr} is in dispute ${old.dispute}; settle it on the overview`);
  const value = normalizeValue(parseValue(raw), attributeSpec(rules, note.fm.type, attr));
  const rec: FactRecord = { value, as_of, sources: [ownerRef(d, "dashboard-edit")], verification: OWNER_CONFIRMED, by: OWNER, recorded: d, last_confirmed: d };
  if (isList(old)) {
    // A list gets a new item; ending items is done in the note text.
    old.items.push(rec);
  } else {
    if (old) {
      const prev = old as FactRecord;
      // Flags stay sticky: an edit never loosens who may see the fact.
      if (prev.sensitivity) rec.sensitivity = prev.sensitivity;
      if (prev.share_with) rec.share_with = prev.share_with;
      ((note.fm.history ??= {})[attr] ??= []).push({ ...prev, ended_by: { step: 6, at: d, by: OWNER } });
    }
    facts[attr] = rec;
  }
  note.fm.updated = d;
  saveNote(root, note);
  const key = `${note.fm.id}#${attr}`;
  commit(root, note.fm.id, `edit ${key}`, [key]);
  logWrite(root, { at: new Date().toISOString(), agent: OWNER, kind: "owner-edit", op: "set", key, outcome: "committed", step: 6 });
  return `${key} = ${JSON.stringify(value)}`;
}

// "Still true": Louis vouches for a fact again. Its value and history stay as they are; it
// gains his word as a source and today's last_confirmed, so freshness starts over.
export function confirmFact(root: string, id: string, attribute: string): string {
  const note = editableNote(root, id);
  const f = note.fm.facts?.[attribute];
  if (!f) throw new CoreError(404, `no fact ${attribute} on ${note.fm.id}`);
  if (isList(f) || isDisputed(f)) throw new CoreError(409, "only a single value can be confirmed here; edit the list or settle the conflict instead");
  const d = today();
  const r = f as FactRecord;
  r.last_confirmed = d;
  const ref = ownerRef(d, "dashboard-confirm");
  if (!r.sources?.some((x) => (typeof x === "string" ? x : x.ref) === ref)) r.sources = [...(r.sources ?? []), ref];
  saveNote(root, note);
  const key = `${note.fm.id}#${attribute}`;
  commit(root, note.fm.id, `confirm ${key}`, [key]);
  logWrite(root, { at: new Date().toISOString(), agent: OWNER, kind: "owner-edit", key, outcome: "committed", step: 6 });
  return `${key} confirmed`;
}

// The note's free text only; the frontmatter (facts, flags) is kept exactly as it is.
export function saveNoteBody(root: string, id: string, body: string): string {
  const text = noteText(root, id);
  const head = text.match(/^---\n[\s\S]*?\n---\n/)?.[0];
  if (!head) throw new CoreError(422, "this note has no frontmatter; edit the whole file instead");
  const b = body.replace(/\r\n/g, "\n").trim();
  return saveNoteText(root, id, head + (b ? b + "\n" : ""), "edit the text of");
}

// Undo one of Louis's own dashboard edits: a new commit by him that reverses it.
export function undoOwnerEdit(root: string, hash: string): string {
  if (!/^[0-9a-f]{7,40}$/.test(hash)) throw new CoreError(400, "bad commit");
  const msg = git(root, ["log", "-1", "--format=%B", hash]);
  if (!/^owner: /.test(msg) || !/\nKind: owner-edit\b/.test(msg)) throw new CoreError(403, "only your own edits from the dashboard can be undone here");
  hubGate(root, ["revert"]);
  const r = Bun.spawnSync(["git", "revert", "--no-edit", hash], { cwd: root, env: authorEnv(root, OWNER) });
  if (r.exitCode !== 0) {
    Bun.spawnSync(["git", "revert", "--abort"], { cwd: root });
    throw new CoreError(409, "something changed the same note since; edit it again instead");
  }
  logWrite(root, { at: new Date().toISOString(), agent: OWNER, kind: "owner-edit", key: msg.split("\n")[0].match(/[a-z0-9_-]+\/[A-Za-z0-9._-]+(?:#[a-z0-9_]+)?/)?.[0] ?? "", outcome: "committed", step: 6 });
  return "undone: the old value is back";
}

// Lines in `after` that aren't in `before`: what the save adds.
function addedLines(before: string, after: string): string[] {
  const had = new Set(before.split("\n"));
  return after.split("\n").filter((l) => !had.has(l));
}

// Checks a whole-note text before it is saved; returns the parsed note.
export function checkNoteText(root: string, id: string, text: string): { note: Note; before: string } {
  const current = editableNote(root, id);
  const before = readFileSync(join(root, current.fm.id + ".md"), "utf8");
  const normalized = text.replace(/\r\n/g, "\n");
  let note: Note;
  try { note = parseNote(normalized, current.path); }
  catch (e) { throw new CoreError(422, `the note doesn't parse: ${e instanceof Error ? e.message : String(e)}`); }
  if (!note.fm || typeof note.fm !== "object") throw new CoreError(422, "the frontmatter is empty");
  if (note.fm.id !== current.fm.id) throw new CoreError(422, `the id must stay ${current.fm.id} (rename by creating a new note)`);
  for (const k of ["type", "title", "area", "sensitivity"]) if (!note.fm[k]) throw new CoreError(422, `the frontmatter needs ${k}`);
  const secret = findSecret(addedLines(before, normalized).join("\n"));
  if (secret) throw new CoreError(422, `the new text has ${secret}; secrets never go in the brain`);
  return { note, before };
}

// A model's edit that changes a fact value without saying so would keep the old provenance
// (another agent's source on Louis's change). Once Louis approves, every changed value is his
// word and the old record goes to history, whatever the model wrote.
function stampChanged(prev: Note, next: Note): string[] {
  const d = today();
  const changed: string[] = [];
  for (const [attr, f] of Object.entries(next.fm.facts ?? {})) {
    const old = prev.fm.facts?.[attr];
    if (isList(f) || isDisputed(f) || isList(old) || isDisputed(old)) continue;
    const r = f as FactRecord;
    const o = old as FactRecord | undefined;
    if (o && JSON.stringify(o.value) === JSON.stringify(r.value)) continue;
    if (isOwnerId(r.by) && isOwnerConfirmed(r.verification)) continue;
    next.fm.facts![attr] = { ...r, sources: [ownerRef(d, "dashboard-edit")], verification: OWNER_CONFIRMED, by: OWNER, recorded: d, last_confirmed: d, as_of: r.as_of && r.as_of !== o?.as_of ? r.as_of : d, ...(o?.sensitivity ? { sensitivity: o.sensitivity } : {}), ...(o?.share_with ? { share_with: o.share_with } : {}) };
    const hist = ((next.fm.history ??= {})[attr] ??= []);
    if (o && !hist.some((h) => JSON.stringify(h.value) === JSON.stringify(o.value) && h.as_of === o.as_of)) hist.push({ ...o, ended_by: { step: 6, at: d, by: OWNER } });
    changed.push(`${next.fm.id}#${attr}`);
  }
  if (changed.length) next.fm.updated = d;
  return changed;
}

export function saveNoteText(root: string, id: string, text: string, why = "edit text", opts: { stamp?: boolean } = {}): string {
  const { note, before } = checkNoteText(root, id, text);
  let after = text.replace(/\r\n/g, "\n");
  if (after === before) return `${note.fm.id}: no change`;
  if (opts.stamp && stampChanged(parseNote(before, note.path), note).length) after = serializeNote(note);
  writeFileSync(join(root, note.fm.id + ".md"), after.endsWith("\n") ? after : after + "\n");
  // The facts that differ are named, so the change feed can tell a hidden fact's edit from a visible one.
  const prev = parseNote(before, note.path), next = parseNote(after, note.path);
  const keys = [...new Set([...Object.keys(prev.fm.facts ?? {}), ...Object.keys(next.fm.facts ?? {})])].filter((a) => JSON.stringify(prev.fm.facts?.[a]) !== JSON.stringify(next.fm.facts?.[a])).map((a) => `${note.fm.id}#${a}`);
  commit(root, note.fm.id, `${why} ${note.fm.id}`, keys);
  logWrite(root, { at: new Date().toISOString(), agent: OWNER, kind: "owner-edit", key: note.fm.id, outcome: "committed", step: 6 });
  return `${note.fm.id}: saved`;
}

export function noteText(root: string, id: string): string {
  const n = editableNote(root, id);
  return readFileSync(join(root, n.fm.id + ".md"), "utf8");
}

// ---------- Louis's editor (policy.yaml owner_editor) ----------

export function setEditor(root: string, agent: string | undefined): string {
  const rules = loadRules(root);
  if (agent) {
    const a = rules.policy.agents[agent];
    if (!a || a.inside_wall) throw new CoreError(404, `${agent} isn't an outside agent in policy.yaml`);
  }
  if ((rules.policy.owner_editor ?? undefined) === agent) return agent ? `${agent} is already your editor` : "no editor set";
  const file = join(root, "rules", "policy.yaml");
  if (!existsSync(file)) throw new CoreError(404, "no rules/policy.yaml");
  const doc = YAML.parseDocument(readFileSync(file, "utf8"));
  if (agent) doc.set("owner_editor", agent);
  else doc.delete("owner_editor");
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
  git(root, ["add", "rules/policy.yaml"]);
  git(root, ["commit", "-q", "-m", `owner: ${agent ? `${agent} is my editor` : "no editor"}\n\nKind: owner-editor`, "--", "rules/policy.yaml"], OWNER);
  return agent ? `${agent} is now your editor: its writes apply directly` : "editor removed: its writes go back through the inbox";
}

export interface EditorCommit { hash: string; at: string; subject: string; reverted: boolean }

// The editor's recent commits, newest first, each revertable from the dashboard.
export function editorCommits(root: string, agent: string, limit = 20): EditorCommit[] {
  const out = git(root, ["log", `-${limit}`, `--author=^${agent} <`, "--format=%H%x09%aI%x09%s"]);
  const reverted = new Set(git(root, ["log", "--format=%b", "--grep", "^This reverts commit "]).match(/[0-9a-f]{40}/g) ?? []);
  return out.split("\n").filter(Boolean).map((l) => {
    const [hash, at, subject] = l.split("\t");
    return { hash, at, subject, reverted: reverted.has(hash) };
  });
}

export function revertCommit(root: string, hash: string): string {
  if (!/^[0-9a-f]{40}$/.test(hash)) throw new CoreError(400, "bad commit");
  const author = git(root, ["log", "-1", "--format=%an", hash]);
  // Only what an agent wrote; Louis's own edits and rules changes are undone in git by him.
  const a = loadRules(root).policy.agents[author];
  if (!a || a.inside_wall) throw new CoreError(403, "only an outside agent's commits are revertable here");
  hubGate(root, ["revert"]); // a replica commits nothing but its own ops
  const r = Bun.spawnSync(["git", "revert", "--no-edit", hash], { cwd: root, env: authorEnv(root, OWNER) });
  if (r.exitCode !== 0) {
    Bun.spawnSync(["git", "revert", "--abort"], { cwd: root });
    throw new CoreError(409, "a later change touched the same lines; revert it in git by hand");
  }
  return `reverted ${hash.slice(0, 7)} (${author})`;
}

// ---------- Forget a note, bring it back ----------

const FORGOT = /^Forgot: (\S+)$/m;

// Forget a whole note: its file leaves the brain in one owner commit, so from the next request no
// assistant can read, search or be handed it (cells rebuild on the new commit), and it answers
// like a note that never existed. Git keeps it; Bring back restores it exactly as it was.
export function forgetNote(root: string, id: string): string {
  const note = editableNote(root, id);
  if (note.fm.id.split("/")[0] === "agents") throw new CoreError(403, "an assistant's own note goes when you remove the assistant");
  const open = Object.entries(note.fm.facts ?? {}).find(([, f]) => isDisputed(f));
  if (open) throw new CoreError(409, `${note.fm.id}#${open[0]} is in dispute ${(open[1] as { dispute: string }).dispute}; settle it on the overview first`);
  hubGate(root, ["commit"]); // a replica commits nothing but its own ops, so it never stages the removal
  git(root, ["rm", "-q", "--", note.fm.id + ".md"]);
  git(root, ["commit", "-q", "-m", `owner: forget ${note.fm.id}\n\nKind: owner-edit\nForgot: ${note.fm.id}`], OWNER);
  logWrite(root, { at: new Date().toISOString(), agent: OWNER, kind: "owner-forget", key: note.fm.id, outcome: "committed", step: 6 });
  return `Forgot ${note.fm.title}. No assistant can see it now.`;
}

// A forget the owner made, read from its commit: the owner as author, the owner-edit kind, and an
// id under a content folder (never rules/, agents/ or a conflict packet). Anything else, however
// its message reads, is not offered and never restored.
const FORGETTABLE = EDITABLE.filter((d) => d !== "agents");
function ownerForget(root: string, hash: string): string | undefined {
  const [email = "", ...rest] = git(root, ["log", "-1", "--format=%ae%n%B", hash]).split("\n");
  const msg = rest.join("\n");
  const id = msg.match(FORGOT)?.[1];
  if (!id || !/^owner: forget /.test(msg) || !/\nKind: owner-edit\b/.test(msg)) return undefined;
  if (!/^(owner|louis)@pocketbrain\.local$/.test(email)) return undefined;
  if (!/^[a-z0-9_-]+(\/[A-Za-z0-9._-]+)+$/.test(id) || id.includes("..") || !FORGETTABLE.includes(id.split("/")[0])) return undefined;
  return id;
}

export interface Forgotten { hash: string; at: string; id: string; title: string }

// The owner's recent forgets whose note isn't back, newest first, for Bring back.
export function recentlyForgotten(root: string, limit = 10): Forgotten[] {
  const out = git(root, ["log", "-n", "50", "--grep=^Forgot: ", "--format=%H%x09%aI"]);
  const seen = new Set<string>();
  const list: Forgotten[] = [];
  for (const line of out.split("\n").filter(Boolean)) {
    const [hash, at] = line.split("\t");
    const id = ownerForget(root, hash);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (existsSync(join(root, id + ".md"))) continue;
    let title = id;
    try { title = String(parseNote(git(root, ["show", `${hash}^:${id}.md`]), id + ".md").fm.title ?? id); } catch { /* keep the id */ }
    list.push({ hash, at, id, title });
    if (list.length >= limit) break;
  }
  return list;
}

export function bringBack(root: string, hash: string): string {
  if (!/^[0-9a-f]{40}$/.test(hash)) throw new CoreError(400, "bad commit");
  const id = ownerForget(root, hash);
  if (!id) throw new CoreError(403, "only notes you forgot can be brought back here");
  const text = git(root, ["show", `${hash}^:${id}.md`]);
  let title = id;
  try { title = String(parseNote(text, id + ".md").fm.title ?? id); } catch { throw new CoreError(409, "the forgotten note can't be read back; restore it in git by hand"); }
  if (existsSync(join(root, id + ".md"))) throw new CoreError(409, `${title} is already back (or a new note took its name)`);
  hubGate(root, ["commit"]);
  git(root, ["checkout", `${hash}^`, "--", id + ".md"]);
  git(root, ["commit", "-q", "-m", `owner: bring back ${id}\n\nKind: owner-edit`, "--", id + ".md"], OWNER);
  logWrite(root, { at: new Date().toISOString(), agent: OWNER, kind: "owner-edit", key: id, outcome: "committed", step: 6 });
  return `${title} is back, as it was.`;
}

// ---------- It was never right ----------

// After Louis replaced a value, he can say the old one was never right: a correction, not a change.
// The replaced record is marked as such in history, and the right value takes the old one's date,
// since it held all along. Values and sources stay; Undo reverses the mark like any owner edit.
export function markNeverRight(root: string, id: string, attribute: string): string {
  const note = editableNote(root, id);
  const f = note.fm.facts?.[attribute];
  const old = note.fm.history?.[attribute]?.at(-1);
  if (!f || isList(f) || isDisputed(f) || !old?.ended_by || !isOwnerId(old.ended_by.by) || old.ended_by.step !== 6)
    throw new CoreError(409, `you haven't replaced ${attribute} on ${note.fm.id} yet; change the value first, then mark the old one`);
  if (old.ended_by.correction) return "Already marked as never right.";
  const cur = f as FactRecord;
  old.ended_by.correction = true;
  if (old.as_of && old.as_of < cur.as_of) cur.as_of = old.as_of;
  note.fm.updated = today();
  saveNote(root, note);
  const key = `${note.fm.id}#${attribute}`;
  commit(root, note.fm.id, `correct ${key}`, [key]);
  logWrite(root, { at: new Date().toISOString(), agent: OWNER, kind: "owner-edit", op: "never-right", key, outcome: "committed", step: 6 });
  return `Marked the old ${cap(attribute)} as never right. ${typeof cur.value === "object" ? JSON.stringify(cur.value) : String(cur.value)} holds from ${cur.as_of}.`;
}

// ---------- Who can see a note ----------

const LEVELS: Sensitivity[] = ["public", "personal", "private", "secret"];

function ownerPolicyCommit(root: string, msg: string, edit: (doc: YAML.Document) => void) {
  const file = join(root, "rules", "policy.yaml");
  if (!existsSync(file)) throw new CoreError(404, "no rules/policy.yaml");
  hubGate(root, ["commit"]);
  const doc = YAML.parseDocument(readFileSync(file, "utf8"));
  edit(doc);
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
  git(root, ["add", "rules/policy.yaml"]);
  git(root, ["commit", "-q", "-m", `owner: ${msg}\n\nKind: owner-edit`, "--", "rules/policy.yaml"], OWNER);
}

function outsideAgent(root: string, agent: string) {
  const a = loadRules(root).policy.agents[agent];
  if (!a || a.inside_wall) throw new CoreError(404, `${agent} isn't an assistant in policy.yaml`);
  return a;
}

// Hide one note from one assistant: its id goes on that agent's exclude list in policy.yaml (the
// carve drops it before any slice is read). Only narrows; the other assistants keep what they had.
export function hideNoteFrom(root: string, id: string, agent: string): string {
  const note = editableNote(root, id);
  const a = outsideAgent(root, agent);
  if ((a.exclude ?? []).includes(note.fm.id)) return `${a.label ?? agent} already can't see ${note.fm.title}.`;
  ownerPolicyCommit(root, `hide ${note.fm.id} from ${agent}`, (doc) => {
    const list = (doc.getIn(["agents", agent, "exclude"]) as YAML.YAMLSeq | undefined);
    if (list && YAML.isSeq(list)) list.add(note.fm.id);
    else doc.setIn(["agents", agent, "exclude"], doc.createNode([note.fm.id], { flow: true }));
  });
  return `${a.label ?? agent} can't see ${note.fm.title} now.`;
}

// Undo of a by-name hide only. It never adds a slice or raises a ceiling: an assistant that
// doesn't get the note for another reason still doesn't.
export function showNoteTo(root: string, id: string, agent: string): string {
  const note = editableNote(root, id);
  const a = outsideAgent(root, agent);
  const list = a.exclude ?? [];
  if (!list.includes(note.fm.id)) throw new CoreError(409, `${note.fm.title} isn't hidden from ${agent} by name; what ${agent} sees is set by its share on the Agents page`);
  ownerPolicyCommit(root, `show ${note.fm.id} to ${agent} again`, (doc) => {
    const rest = list.filter((x) => x !== note.fm.id);
    if (rest.length) doc.setIn(["agents", agent, "exclude"], doc.createNode(rest, { flow: true }));
    else doc.deleteIn(["agents", agent, "exclude"]);
  });
  return `${a.label ?? agent} can see ${note.fm.title} again.`;
}

// The note's own level. Facts flagged above it keep their flag, so opening a note up never opens a
// fact that was marked private on its own.
export function setNoteSensitivity(root: string, id: string, level: string): string {
  const note = editableNote(root, id);
  if (!LEVELS.includes(level as Sensitivity)) throw new CoreError(400, "a level is public, personal, private or secret");
  if (note.fm.sensitivity === level) return `${note.fm.title} is already ${level}.`;
  note.fm.sensitivity = level as Sensitivity;
  note.fm.updated = today();
  saveNote(root, note);
  commit(root, note.fm.id, `make ${note.fm.id} ${level}`, []);
  logWrite(root, { at: new Date().toISOString(), agent: OWNER, kind: "owner-edit", key: note.fm.id, outcome: "committed", step: 6 });
  return `${note.fm.title} is ${level} now.`;
}
