// SPDX-License-Identifier: AGPL-3.0-only
// Slice sharing for a collaborator (docs/share.md): a person gets one or more slices of the brain,
// live and read-only, until a date. The owner previews it, says yes, and can extend or end it.
// Each step is one owner commit (Kind: share), so git is the record. The limits that make it safe
// (read-only, paused past its date, personal at most, no money, no all slice, not the resolver or
// an area owner) are in loadRules (src/rules.ts), and ask_to_see is off for it (src/asks.ts).
// How the person's assistant connects is unchanged: an invite code or their own sign-in.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { loadRules } from "./rules";
import { today } from "./brain";
import { previewNewAgent, type NewAgentPreview } from "./addagent";
import { revokeTokens } from "./auth";
import { loadOAuth, removeCoworker } from "./oauth";
import { git } from "./git";
import { OWNER } from "./owner";

export interface NewShare { agent: string; name: string; slices: string[]; days?: number }
export interface SharePreview extends NewAgentPreview { name: string; until: string }

export const MAX_DAYS = 180;
const plusDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function check(s: NewShare) {
  const days = s.days ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new Error(`--days is 1 to ${MAX_DAYS}; extend it later if the work goes on`);
  if (!s.name?.trim()) throw new Error("--name is the person's name, as you'll see it on screens");
  if (s.slices.includes("all")) throw new Error("a collaborator gets one or more slices, never all");
}
function checkName(root: string, agent: string) {
  if (loadRules(root).policy.areas?.[agent]) throw new Error(`${agent} is an area's name; pick another name for the collaborator`);
}

// What the person's assistant would see, from the same carve the server applies. Writes nothing.
export function previewShare(root: string, s: NewShare): SharePreview {
  check(s);
  checkName(root, s.agent);
  const p = previewNewAgent(root, { agent: s.agent, slices: s.slices, exclude_types: ["money"] });
  return { ...p, name: s.name.trim(), until: plusDays(today(), s.days ?? 30) };
}

function commit(root: string, msg: string) {
  git(root, ["add", "rules/policy.yaml"]);
  git(root, ["commit", "-q", "-m", `owner: ${msg}\n\nKind: share`, "--", "rules/policy.yaml"], OWNER);
}

function edit(root: string, f: (doc: YAML.Document) => void) {
  const file = join(root, "rules", "policy.yaml");
  const doc = YAML.parseDocument(readFileSync(file, "utf8"));
  f(doc);
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
}

// The owner's yes: the agent goes into policy.yaml as a collaborator, in one owner commit.
export function addShare(root: string, s: NewShare): SharePreview {
  const p = previewShare(root, s);
  edit(root, (doc) => doc.setIn(["agents", s.agent], doc.createNode({
    label: p.name.slice(0, 60), tier: "trial", transport: "mcp", slices: s.slices, exclude_types: ["money"],
    collaborator: { name: p.name.slice(0, 60), until: p.until },
  }, { flow: true })));
  commit(root, `share ${s.slices.join(", ")} with ${p.name} as ${s.agent} until ${p.until} (read-only)`);
  return p;
}

function shared(root: string, agent: string) {
  const a = loadRules(root).policy.agents[agent];
  if (!a?.collaborator) throw new Error(`${agent} isn't a collaborator (pocketbrain share list)`);
  return a.collaborator;
}

export function extendShare(root: string, agent: string, days: number): string {
  const c = shared(root, agent);
  if (c.ended) throw new Error(`${agent}'s share ended on ${c.ended}; share again with share add under a new name`);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new Error(`--days is 1 to ${MAX_DAYS}`);
  const until = plusDays(c.until > today() ? c.until : today(), days);
  edit(root, (doc) => doc.setIn(["agents", agent, "collaborator", "until"], until));
  commit(root, `share with ${c.name} (${agent}) extended to ${until}`);
  return `${agent} shared until ${until}`;
}

// Ends it now: keys revoked, sign-ins unbound, the agent paused for good. The entry stays, so the
// record of what was shared and when stays readable in policy.yaml as well as in git.
export function endShare(root: string, agent: string): string {
  const c = shared(root, agent);
  // G352: ended, paused and the person's sign-in let go first: none of it needs the invites lock, so
  // a revoke that fails on a busy lock still leaves the share ended. Running it again revokes the keys.
  for (const [sub, cw] of Object.entries(loadOAuth(root)?.coworkers ?? {})) if (cw.agent === agent) removeCoworker(root, sub);
  if (!c.ended || loadRules(root).policy.agents[agent]?.status !== "paused") {
    edit(root, (doc) => { if (!c.ended) doc.setIn(["agents", agent, "collaborator", "ended"], today()); doc.setIn(["agents", agent, "status"], "paused"); });
    commit(root, `share with ${c.name} (${agent}) ended`);
  }
  let keys: number;
  try { keys = revokeTokens(root, agent); } // its keys and every sign-in bound to it
  catch (e) { throw new Error(`${agent}: share ended and paused, but ${(e as Error).message}`); }
  return `${agent}: share ended; ${keys} key(s) and sign-in(s) revoked`;
}

export interface ShareRow { agent: string; name: string; slices: string[]; until: string; ended?: string; active: boolean }

export function listShares(root: string): ShareRow[] {
  const rules = loadRules(root);
  return Object.entries(rules.policy.agents).filter(([, a]) => a.collaborator).map(([agent, a]) => ({
    agent, name: a.collaborator!.name, slices: a.slices ?? [], until: a.collaborator!.until, ended: a.collaborator!.ended, active: a.status !== "paused",
  })).sort((x, y) => x.agent.localeCompare(y.agent));
}

// For the owner's digest: who sees what until when, and shares that ended or ran out this week.
export function shareLines(root: string): string[] {
  const week = plusDays(today(), -7);
  const rows = listShares(root);
  const on = rows.filter((r) => r.active).map((r) => `${r.name} (${r.agent}): ${r.slices.join(", ")} until ${r.until}`);
  const off = rows.filter((r) => !r.active && (r.ended ?? r.until) >= week).map((r) => `${r.name} (${r.agent}) ended ${r.ended ?? r.until}`);
  return on.length || off.length ? [`- Shared with people: ${[...on, ...off].join("; ")}`] : [];
}
