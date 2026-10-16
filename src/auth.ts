// SPDX-License-Identifier: AGPL-3.0-only
// Per-agent bearer tokens for the live server, until the hosted AS (architecture 0.2) is in
// place. Only hashes are stored, in rules/tokens.yaml, so the brain repo never holds a
// usable credential. Louis issues and revokes them from the CLI.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { sha256 } from "./util";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { loadRules, readYaml } from "./rules";
import { git } from "./git";
import { OWNER } from "./owner";
import { revokeAgentClients } from "./oauth";
import { cancelInvites } from "./invite";
import { TOKEN_ROLES, type TokenRole } from "./tokenrole";

// role: absent on a token that does everything its agent may (every token before G18).
// expires: set when the token was rotated out (`token rotate`); past it, the token is refused and
// the line is dropped at the next change to the file.
interface TokenFile { agents: Record<string, { hash: string; issued: string; role?: TokenRole; expires?: string }[]> }

const now = () => (process.env.PB_NOW ? Date.parse(process.env.PB_NOW) : Date.now());
const alive = (e: { expires?: string }) => !e.expires || Date.parse(e.expires) > now(); // an unreadable date counts as past

const file = (root: string) => join(root, "rules", "tokens.yaml");

function load(root: string): TokenFile {
  const t = readYaml<Partial<TokenFile>>(file(root), {});
  return { ...t, agents: t.agents ?? {} };
}

// Issued tokens per agent (hashes and dates only), for the owner dashboard.
// Live ones only: a token past its rotation overlap counts as revoked everywhere (edge, browser door).
export function tokenInfo(root: string): TokenFile["agents"] {
  const a = load(root).agents;
  return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, Array.isArray(v) ? v.filter(alive) : v]));
}

function save(root: string, t: TokenFile, message = "owner: server tokens changed") {
  for (const [k, v] of Object.entries(t.agents)) if (Array.isArray(v)) { const keep = v.filter(alive); if (keep.length) t.agents[k] = keep; else delete t.agents[k]; }
  mkdirSync(join(root, "rules"), { recursive: true });
  writeFileSync(file(root), "# Hashes of the live server's per-agent tokens. Only the owner edits this file (pocketbrain token).\n" + YAML.stringify(t));
  git(root, ["add", "rules/tokens.yaml"]);
  git(root, ["commit", "-q", "-m", message, "--", "rules/tokens.yaml"], OWNER);
}

// role (G18): "reader" for the token a vendor's config holds (its slice below private, no dispute
// or owner-channel routes), "resolver" for the one that only settles disputes and carries the
// owner's texts. Only the resolver or the owner's channel agent gets a resolver token.
export function issueToken(root: string, agent: string, role?: TokenRole): string {
  const rules = loadRules(root), a = rules.policy.agents[agent];
  if (!a || a.inside_wall) throw new Error(`${agent} isn't an outside agent in policy.yaml`);
  if (role && !TOKEN_ROLES.includes(role)) throw new Error(`role is ${TOKEN_ROLES.join(" or ")}`);
  const p = rules.policy;
  if (role === "resolver" && ![p.resolver, p.owner_channel ?? p.louis_channel ?? p.resolver].includes(agent)) throw new Error(`${agent} is neither the resolver nor the owner's channel, so it has no resolver routes`);
  const token = `pb_${agent}_${randomBytes(24).toString("base64url")}`;
  const t = load(root);
  (t.agents[agent] ??= []).push({ hash: sha256(token), issued: new Date(now()).toISOString().slice(0, 10), ...(role ? { role } : {}) });
  save(root, t);
  return token;
}

// A new token for a pasted assistant, with the old one(s) of the same role kept working for an
// overlap, so the assistant never breaks while the owner re-pastes. One owner commit. The gardener
// rotates its own token into its vault (`pocketbrain gardener rotate`); a resolver token isn't
// rotated with an overlap. A second rotate never extends an older token's end.
export const ROTATE_MAX_HOURS = 24 * 7;
export function rotateToken(root: string, agent: string, o: { role?: TokenRole; overlapHours?: number } = {}): { token: string; expires: string; expiring: number } {
  const rules = loadRules(root), a = Object.hasOwn(rules.policy.agents, agent) ? rules.policy.agents[agent] : undefined;
  if (!a || a.inside_wall) throw new Error(`${agent} isn't an outside agent in policy.yaml`);
  if (a.role === "gardener") throw new Error(`the gardener rotates its own token into its vault: pocketbrain gardener rotate`);
  // The resolver token carries the owner's own texts: no window with two of them.
  if (o.role === "resolver") throw new Error("a resolver token carries your own texts, so it isn't rotated with an overlap: revoke it (pocketbrain token --revoke <agent>) and issue a new one");
  if (o.role && !TOKEN_ROLES.includes(o.role)) throw new Error(`role is ${TOKEN_ROLES.join(" or ")}`);
  const hours = o.overlapHours ?? 24;
  if (!Number.isFinite(hours) || hours < 0 || hours > ROTATE_MAX_HOURS) throw new Error(`the overlap is 0 to ${ROTATE_MAX_HOURS} hours`);
  const expires = new Date(now() + hours * 3_600_000).toISOString();
  const token = `pb_${agent}_${randomBytes(24).toString("base64url")}`;
  const t = load(root);
  const list = (t.agents[agent] ??= []);
  let expiring = 0;
  for (const e of list) if ((e.role ?? undefined) === o.role && alive(e)) { if (!e.expires || e.expires > expires) e.expires = expires; expiring++; }
  list.push({ hash: sha256(token), issued: new Date(now()).toISOString().slice(0, 10), ...(o.role ? { role: o.role } : {}) });
  save(root, t, `owner: ${agent} token rotated; the old one works until ${expires}`);
  return { token, expires, expiring };
}

// Cuts the agent off everywhere: its pasted tokens and every OAuth connection bound to it.
export function revokeTokens(root: string, agent: string): number {
  const t = load(root);
  const n = t.agents[agent]?.length ?? 0;
  delete t.agents[agent];
  save(root, t);
  cancelInvites(root, agent);
  return n + revokeAgentClients(root, agent);
}

// Keeps only the agent's tokens whose hash passes `keep` (the gardener's rotation). Returns how
// many were revoked.
export function retainTokens(root: string, agent: string, keep: (hash: string) => boolean): number {
  const t = load(root);
  const before = t.agents[agent] ?? [];
  const after = before.filter((e) => keep(e.hash));
  if (after.length === before.length) return 0;
  if (after.length) t.agents[agent] = after; else delete t.agents[agent];
  save(root, t);
  return before.length - after.length;
}

// The agent a token belongs to and its role, or undefined. Removing an agent from policy.yaml
// also cuts it off, even if its token is still listed.
export function tokenOwner(root: string, token: string | undefined): { agent: string; role?: TokenRole } | undefined {
  if (!token) return undefined;
  const h = Buffer.from(sha256(token), "hex");
  const policy = loadRules(root).policy.agents;
  for (const [agent, list] of Object.entries(load(root).agents ?? {})) {
    if (!policy[agent] || policy[agent].inside_wall || !Array.isArray(list)) continue;
    // A hand-mangled line (no hash, a short one) is skipped, not a 500 for every agent.
    const e = list.find((x) => { const b = Buffer.from(typeof x?.hash === "string" ? x.hash : "", "hex"); return b.length === h.length && timingSafeEqual(b, h) && alive(x); });
    // An unknown role (a hand-edited file) is refused rather than read as no role.
    if (e) return e.role === undefined || TOKEN_ROLES.includes(e.role) ? { agent, ...(e.role ? { role: e.role } : {}) } : undefined;
  }
  return undefined;
}

export const agentForToken = (root: string, token: string | undefined): string | undefined => tokenOwner(root, token)?.agent;
