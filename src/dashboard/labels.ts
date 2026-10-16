// SPDX-License-Identifier: AGPL-3.0-only
// Plain words for the dashboard. The code keeps its names (check ids, read ops, note ids);
// the owner reads a label, and the code name stays one hover away in a title attribute, so
// a log line or a bug report can still be matched to it.
import type { Note } from "../brain";
import type { Rules } from "../rules";
import { esc } from "./html";

const LABELS: Record<string, string> = {
  // write checks and alerts
  schema: "badly formed write",
  rules_read_only: "tried to change your rules",
  protected_paths: "tried to write a protected file",
  no_secret_shapes: "looked like a password or card number",
  no_secret_level: "marked as a secret",
  injection_shapes: "looked like instructions to an agent",
  approval_needs_message_id: "approval without your message",
  no_agent_in_ids: "named another agent",
  source_present: "no source given",
  source_resolvable: "source can't be found",
  source_matches_type: "source doesn't fit the fact",
  source_exists: "source doesn't exist",
  as_of_not_future: "dated in the future",
  note_size: "note too long",
  leak_tripwire: "tried to repeat something it can't see",
  coworker_offboarded: "coworker left: cut at sign-in",
  withheld_category: "private kind of detail",
  write_conflict: "may clash with another note",
  classify_review: "may need a higher privacy level",
  gardener_hours: "gardener outside its hours",
  gardener_ant: "gardener's Anthropic side",
  proposal_cap: "too many proposals today",
  sensitivity_only_raises: "tried to loosen privacy",
  owner_message_registered: "claimed to be you",
  agent_status: "paused or read-only agent",
  log_held: "message held",
  relay: "agent mail",
  server: "server",
  upkeep: "upkeep",
  disk: "disk space",
  git: "history",
  // what an agent did when it read
  context_pack: "loaded its notes",
  search: "searched",
  read: "opened a note",
  orientation: "read the how-to",
  log_search: "searched its own log",
  log_read: "opened its own log",
  ask_read: "read once, with your OK",
  view: "loaded its notes",
  // write outcomes
  committed: "saved",
  inbox: "waiting for you",
  refused: "refused",
  refuse: "refused",
  noop: "no change",
  queued: "queued",
  held: "held",
  released: "released",
  dropped: "dropped",
  // agent setup
  core: "trusted",
  trial: "on trial",
  paste: "pasted notes",
  mcp: "connector",
  api: "web link",
  resolver: "settles conflicts",
  // where a fact came from
  "confirmed-by-owner": "you said so",
  "confirmed-by-louis": "you said so",
  "verified-by-source": "checked against a source",
  "self-reported": "the agent's word",
  unverified: "not checked",
  // preview flags
  "carved-value-in-view": "mentions a hidden value",
  "category-mention": "mentions a private kind of detail",
  "links-to-excluded": "links to a hidden note",
};

// "next_step" -> "next step" when no label is set.
export const plain = (code: unknown) => {
  const c = String(code ?? "");
  if (LABELS[c]) return LABELS[c];
  // A slice named after an area: "area:strategy" -> "strategy notes".
  const area = c.match(/^area:(.+)$/);
  return area ? `${area[1].replace(/[_-]+/g, " ")} notes` : c.replace(/[_-]+/g, " ");
};

// "next step" -> "Next step", for a label that starts a line.
export const cap = (code: unknown) => { const t = plain(code); return t.charAt(0).toUpperCase() + t.slice(1); };

// A plain label with its code name on hover.
export const term = (code: unknown) => {
  const c = String(code ?? "");
  return plain(c) === c ? esc(c) : `<span title="${esc(c)}">${esc(plain(c))}</span>`;
};

const titles = new WeakMap<Note[], Map<string, string>>();
function titleOf(notes: Note[], id: string): string | undefined {
  let m = titles.get(notes);
  if (!m) titles.set(notes, (m = new Map(notes.map((n) => [n.fm.id, String(n.fm.title ?? n.fm.id)]))));
  return m.get(id.replace(/\.md$/, ""));
}

// A note by its title (the id on hover). An id that isn't in the brain shows as it is.
export function noteName(notes: Note[], id: string): string {
  const t = titleOf(notes, id);
  return t ? `<span title="${esc(id)}">${esc(t)}</span>` : `<span class="mono" title="${esc(id)}">${esc(id)}</span>`;
}

// "projects/course-a#next_step" -> "Course A: next step", the key on hover.
export function factName(notes: Note[], key: string): string {
  const [id, attr] = String(key ?? "").split("#");
  const t = titleOf(notes, id);
  if (!t) return `<span class="mono">${esc(key)}</span>`;
  return `<span title="${esc(key)}">${esc(t)}${attr ? `: ${esc(plain(attr))}` : ""}</span>`;
}

// Prose from the code (flag details, reasons) with each note id or fact key in it named.
export function withNames(notes: Note[], text: string): string {
  return esc(text).replace(/\b([a-z0-9_-]+\/[A-Za-z0-9._-]*[A-Za-z0-9_-])(#[a-z0-9_]+)?/g, (m, id, attr) =>
    titleOf(notes, id) ? factName(notes, attr ? `${id}${attr}` : id) : m);
}

// An agent by its label from policy.yaml (`label: claude.ai`), else its id.
export const agentLabel = (rules: Rules, id: unknown) => { const k = String(id ?? ""); return rules.policy.agents[k]?.label ?? k; };

// The same, as HTML with the id on hover when they differ.
export function agentName(rules: Rules, id: unknown): string {
  const k = String(id ?? ""), l = agentLabel(rules, k);
  return l === k ? esc(k) : `<span title="${esc(k)}">${esc(l)}</span>`;
}
