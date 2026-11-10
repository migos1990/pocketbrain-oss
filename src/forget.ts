// SPDX-License-Identifier: AGPL-3.0-only
// Forget a person (backlog row 330, docs/forget.md): someone, often not the owner, asks to be taken
// out, not only hidden. One owner commit removes their note, turns every link to them into
// [[redacted]] (what agents already see for a note outside their view), drops their standing, any
// settled dispute about their facts and any inbox item naming them. The local traces go too: the
// standing signals for their addresses, the views folder, the restart cache. For 14 days
// `pocketbrain forget --undo` reverts the commit and puts the local traces back; after that the
// kept traces are deleted and the undo is refused. What it can't take out (the hash-chained logs,
// journal and mail lines naming them, git history, backups made before) is listed, never hidden.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTENT_DIRS, dropParsed, isDisputed, loadBrain, type Note } from "./brain";
import { CoreError, dropStaleVectors } from "./core";
import { commitPaths, git, gitRun } from "./git";
import { hubRole } from "./hub";
import { OWNER, isOwnerEmail } from "./owner";
import { addressesOf, dropPersonStanding, loadStanding, restorePersonTraces, type StandingTraces } from "./standing";
import { logWrite, resolveEntity } from "./write";
import YAML from "yaml";
import { buildAll } from "./backup";
import { edgeEnrolled } from "./edge";
import { dropChatsNaming } from "./ask-threads";

export const FORGET_UNDO_DAYS = 14;
const DAY = 86_400_000;
const ID = /^people\/[a-z0-9][a-z0-9._-]*$/;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// [[id]], [[id|label]], [[id#anchor]]; never [[id-2]], which is someone else.
const linkRe = (id: string) => new RegExp(`\\[\\[${esc(id)}(?:[|#][^\\]]*)?\\]\\]`, "g");
const mentions = (id: string) => new RegExp(`(^|[^A-Za-z0-9._/-])${esc(id)}(?![A-Za-z0-9._/-])`);
const stashDir = (root: string) => join(root, ".git", "pb-forget");
// Where a person's name can stay after a forget: free text and logs, reported only.
const LEFTOVER_DIRS = ["journal", "archive", "comms", "handoffs", "digest", "capture", "textline", "inbox", "relay", "log"];

// named: other notes that still name them in plain text (their title or an address) once the links
// are [[redacted]]. Prose is the owner's to edit; the plan and the result list it, before --yes too.
export interface ForgetPlan { id: string; title: string; links: string[]; inbox: string[]; disputes: string[]; standing: boolean; named: string[] }
interface Stash { id: string; at: string; traces: StandingTraces; untracked: Record<string, string>; chats?: number }

function walk(root: string, rel: string): string[] {
  const dir = join(root, rel);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const r = `${rel}/${e.name}`;
    return e.isDirectory() ? walk(root, r) : e.isFile() ? [r] : [];
  });
}
const isTracked = (root: string, rel: string) => gitRun(root, ["ls-files", "--error-unmatch", "--", rel]).ok;

function thePerson(root: string, id: string): { note: Note; notes: Note[] } {
  if (!ID.test(id) || id.includes("..")) throw new CoreError(400, `forget takes a person note's id, like people/jane-roy`);
  const notes = loadBrain(root);
  const note = notes.find((n) => n.fm.id === id && n.fm.type === "person");
  if (!note) throw new CoreError(404, `no person note ${id}`);
  const open = Object.entries(note.fm.facts ?? {}).find(([, f]) => isDisputed(f));
  if (open) throw new CoreError(409, `${id}#${open[0]} is in dispute ${(open[1] as { dispute: string }).dispute}; settle it first, nothing was changed`);
  const pointer = notes.find((n) => [n.fm.merged_into, n.fm.superseded_by, n.fm.supersedes].some((x) => x === id || (Array.isArray(x) && x.includes(id))));
  if (pointer) throw new CoreError(409, `${pointer.fm.id} was merged into or replaced by ${id}; undo that merge (or forget ${pointer.fm.id} too) first, nothing was changed`);
  return { note, notes };
}

export function planForget(root: string, id: string): ForgetPlan {
  const { note, notes } = thePerson(root, id);
  const re = linkRe(id), m = mentions(id);
  const links = notes.filter((n) => n.fm.id !== id && re.test(readFileSync(join(root, `${n.fm.id}.md`), "utf8"))).map((n) => n.fm.id).filter((x) => !x.startsWith("disputes/")).sort();
  const disputes = notes.filter((n) => n.fm.type === "dispute" && [n.fm.fact_key, (n.fm as { other_key?: string }).other_key].some((k) => typeof k === "string" && k.startsWith(`${id}#`))).map((n) => n.fm.id).sort();
  // A proposal for a new page by name (no id yet, decided ones too) that names this person goes as
  // well: kept, the hub's start would reopen it and file the page again (G601 slice audit F1).
  const byName = (p: string) => { try { const r = (YAML.parse(readFileSync(join(root, p), "utf8")) ?? {}).request; return !!r && !r.id && typeof r.title === "string" && typeof r.type === "string" && resolveEntity([note], r.type, r.title).id === id; } catch { return false; } };
  const inbox = walk(root, "inbox").filter((p) => p.endsWith(".yaml") && (m.test(readFileSync(join(root, p), "utf8")) || byName(p))).sort();
  const title = String(note.fm.title ?? id);
  const needles = namesOf(title, addressesOf(note));
  const named = notes.filter((n) => n.fm.id !== id && !disputes.includes(n.fm.id) && needles.some((x) => readFileSync(join(root, `${n.fm.id}.md`), "utf8").replace(re, "").toLowerCase().includes(x))).map((n) => n.fm.id).sort();
  return { id, title, links, inbox, disputes, standing: id in loadStanding(root).people, named };
}
const namesOf = (title: string, addresses: string[]) => [...(title.length >= 4 ? [title.toLowerCase()] : []), ...addresses.map((a) => a.toLowerCase())];

// Files outside the notes that still name the person, by id, title or address.
function leftovers(root: string, id: string, title: string, addresses: string[]): string[] {
  const needles = [id, ...namesOf(title, addresses)];
  return LEFTOVER_DIRS.flatMap((d) => walk(root, d)).filter((p) => {
    try { const t = readFileSync(join(root, p), "utf8").toLowerCase(); return needles.some((n) => t.includes(n)); } catch { return false; }
  }).sort();
}

// Views are derived: every file there that names them goes, and the current views are built again.
function refreshViews(root: string, needles: string[]) {
  if (!existsSync(join(root, "views"))) return;
  for (const p of walk(root, "views")) if (needles.some((n) => readFileSync(join(root, p), "utf8").includes(n))) unlinkSync(join(root, p));
  buildAll(root);
}

export function forgetPerson(root: string, id: string, o: { now?: number } = {}): { hash: string; plan: ForgetPlan; leftovers: string[]; message: string } {
  const plan = planForget(root, id);
  const { note, notes } = thePerson(root, id);
  const role = hubRole(root);
  if (role.mode === "replica" || role.mode === "unnamed") throw new CoreError(409, "forget runs on the hub; this clone commits nothing, nothing was changed");
  const at = new Date(o.now ?? Date.now()).toISOString();
  const path = `${id}.md`, noteText = readFileSync(join(root, path), "utf8");
  const addresses = addressesOf(note);
  // Every version of the note the restart cache may hold, and the linking notes as they were.
  const versions = gitRun(root, ["log", "-n", "200", "--format=%H", "--", path]).out.split("\n").filter(Boolean)
    .map((h) => gitRun(root, ["show", `${h}:${path}`])).filter((r) => r.ok).map((r) => r.out + "\n");
  const before = plan.links.map((l) => readFileSync(join(root, `${l}.md`), "utf8"));
  // Each agent's cell holds its own rendering of the note, parsed through the same cache.
  const cellCopies = walk(root, ".cells").filter((p) => p.endsWith(`/${path}`)).map((p) => readFileSync(join(root, p), "utf8"));

  const untracked: Record<string, string> = {};
  for (const l of plan.links) {
    const f = join(root, `${l}.md`);
    writeFileSync(f, readFileSync(f, "utf8").replace(linkRe(id), "[[redacted]]"));
  }
  for (const p of [...plan.inbox, ...plan.disputes.map((d) => `${d}.md`)]) {
    if (!isTracked(root, p)) untracked[p] = readFileSync(join(root, p), "utf8");
    unlinkSync(join(root, p));
  }
  const { traces } = dropPersonStanding(root, note, notes);
  unlinkSync(join(root, path));
  const paths = [path, ...plan.links.map((l) => `${l}.md`), ...plan.inbox, ...plan.disputes.map((d) => `${d}.md`), "rules/standing.yaml"].filter((p) => !(p in untracked));
  const why = commitPaths(root, paths, `owner: forget ${id}\n\nKind: owner-edit\nForgot-Person: ${id}\nForgot-At: ${at}`, OWNER);
  if (why) {
    restorePersonTraces(root, id, traces);
    for (const [p, t] of Object.entries(untracked)) writeFileSync(join(root, p), t);
    throw new CoreError(500, `not forgotten: the brain's git couldn't commit it (${why}); nothing was changed`);
  }
  const hash = git(root, ["rev-parse", "HEAD"]);
  mkdirSync(stashDir(root), { recursive: true });
  // Ask's chats that name them (owner-only files beside the git folder, never committed) go whole;
  // nothing keeps a copy, so the undo can't bring one back (audit v13, G763).
  const chats = dropChatsNaming(root, [id, ...namesOf(plan.title, addresses)]);
  writeFileSync(join(stashDir(root), `${hash}.json`), JSON.stringify({ id, at, traces, untracked, ...(chats ? { chats } : {}) } satisfies Stash) + "\n");
  logWrite(root, { at, agent: OWNER, kind: "owner-forget-person", key: id, outcome: "committed", step: 6 });
  dropParsed(root, [noteText, ...versions, ...before, ...cellCopies], [`"id":"${id}"`, ...addresses.map((a) => JSON.stringify(a))]);
  refreshViews(root, [id, ...addresses]);
  // Semantic search's vectors of the note and of every note that linked to it (src/semantic.ts).
  dropStaleVectors(root);
  // The edge reader's cells are built only by `edge publish`; they go, and bundles already
  // published still hold the person until it runs again.
  if (existsSync(join(root, ".cells", ".edge-reader"))) rmSync(join(root, ".cells", ".edge-reader"), { recursive: true, force: true });
  const edge = edgeEnrolled();

  const left = leftovers(root, id, plan.title, addresses);
  const by = new Map<string, number>();
  for (const p of left) by.set(p.split("/")[0], (by.get(p.split("/")[0]) ?? 0) + 1);
  const message = [
    `Forgot ${plan.title}: their note, ${plan.links.length} link(s) (now [[redacted]]), ${plan.inbox.length} inbox item(s), ${plan.disputes.length} settled dispute(s)${plan.standing ? ", their standing" : ""} and their local traces. No assistant can read, search or be handed them from now on.`,
    ...(chats ? [`${chats} Ask chat(s) that named them were deleted; the undo doesn't bring a chat back.`] : []),
    `Undo within ${FORGET_UNDO_DAYS} days: pocketbrain forget --undo ${id}. After that the undo is gone.`,
    ...(plan.named.length ? [`Still named in plain text, by name or address, in ${plan.named.length} note(s) assistants may read: ${plan.named.join(", ")}. A forget rewrites links, not prose: edit those notes.`] : []),
    ...(edge ? [`Edge bundles published before this still hold them: run pocketbrain edge publish --out <dir> again.`] : []),
    ...(left.length ? [`Still named, by name, id or address, in ${left.length} file(s) it doesn't edit (${[...by].map(([d, n]) => `${d}/ ${n}`).join(", ")}): logs are hash-chained and journals are assistants' own lines; edit those by hand if needed. First: ${left.slice(0, 5).join(", ")}`] : []),
    `Git history and backups made before today still hold them, and restoring one brings them back.`,
  ].join("\n");
  return { hash, plan, leftovers: left, message };
}

export function undoForget(root: string, id: string, o: { now?: number } = {}): string {
  if (!ID.test(id) || id.includes("..")) throw new CoreError(400, `forget --undo takes a person note's id, like people/jane-roy`);
  // The owner's own forget and the owner's own undo only (G602): an assistant's commit message
  // could carry either trailer.
  const owners = (args: string[]) => git(root, ["log", "--format=%H %ae", ...args]).split("\n").map((l) => l.split(" ")).filter(([h, e]) => h && isOwnerEmail(e ?? "")).map(([h]) => h!);
  const hash = owners([`--grep=^Forgot-Person: ${esc(id)}$`])[0] ?? "";
  const undone = hash && owners([`--grep=^Undid-Forget: ${hash}$`]).length > 0;
  if (!hash || undone) throw new CoreError(404, `no forget of ${id} to undo`);
  const msg = git(root, ["log", "-1", "--format=%B", hash]);
  const at = Date.parse(msg.match(/^Forgot-At: (\S+)$/m)?.[1] ?? "");
  if (!Number.isFinite(at) || (o.now ?? Date.now()) - at > FORGET_UNDO_DAYS * DAY)
    throw new CoreError(410, `the forget of ${id} is more than ${FORGET_UNDO_DAYS} days old; its undo is gone`);
  if (existsSync(join(root, `${id}.md`))) throw new CoreError(409, `${id} exists again; nothing was changed`);
  const role = hubRole(root);
  if (role.mode === "replica" || role.mode === "unnamed") throw new CoreError(409, "forget --undo runs on the hub; this clone commits nothing");
  const r = gitRun(root, ["revert", "--no-commit", hash]);
  if (!r.ok) {
    gitRun(root, ["revert", "--abort"]);
    throw new CoreError(409, `notes changed since the forget touch the same lines; nothing was changed (revert ${hash.slice(0, 7)} in git by hand)`);
  }
  git(root, ["commit", "-q", "-m", `owner: undo forget ${id}\n\nKind: owner-edit\nUndid-Forget: ${hash}`], OWNER);
  const f = join(stashDir(root), `${hash}.json`);
  let chats = 0;
  if (existsSync(f)) {
    const s = JSON.parse(readFileSync(f, "utf8")) as Stash;
    chats = s.chats ?? 0;
    restorePersonTraces(root, id, s.traces);
    for (const [p, t] of Object.entries(s.untracked)) { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), t); }
    unlinkSync(f);
  }
  logWrite(root, { at: new Date(o.now ?? Date.now()).toISOString(), agent: OWNER, kind: "owner-edit", key: id, outcome: "committed", step: 6 });
  if (existsSync(join(root, "views"))) buildAll(root);
  dropStaleVectors(root); // the [[redacted]] versions of the linking notes
  return `${id} is back, with its links, standing and inbox items, as it was.${chats ? ` The ${chats === 1 ? "Ask chat" : `${chats} Ask chats`} deleted with the forget ${chats === 1 ? "is" : "are"} not brought back.` : ""}`;
}

// The night's housekeeping: what a forget kept for its undo goes once the window has passed.
export function expireForgets(root: string, now = Date.now()): number {
  if (!existsSync(stashDir(root))) return 0;
  let n = 0;
  for (const f of readdirSync(stashDir(root)).filter((x) => x.endsWith(".json"))) {
    let at = NaN;
    try { at = Date.parse((JSON.parse(readFileSync(join(stashDir(root), f), "utf8")) as Stash).at); } catch { /* unreadable: kept no undo worth keeping */ }
    if (!Number.isFinite(at) || now - at > FORGET_UNDO_DAYS * DAY) { unlinkSync(join(stashDir(root), f)); n++; }
  }
  return n;
}
