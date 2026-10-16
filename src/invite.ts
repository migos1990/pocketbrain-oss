// SPDX-License-Identifier: AGPL-3.0-only
// One-time invite codes (docs/spec/agent-onboarding.md, step 2): for an agent that can't sign in
// with OAuth, the owner gives it a short code instead of a long token. The agent redeems it once
// at POST /v1/enroll and gets its own token, so the token never passes through the owner's hands.
// Only a hash of each code is kept, in rules/invites.yaml (owner commits, so git is the record).
// A code lasts 15 minutes by default (an hour at most), works once, dies with the agent's revoke,
// and wrong guesses are rate-limited for the whole hub.
import { randomInt } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { loadRules, readYaml } from "./rules";
import { sha256 } from "./util";
import { git } from "./git";
import { OWNER } from "./owner";
import { issueToken } from "./auth";

interface Invite { hash: string; agent: string; created: string; until: string; used?: string }
interface InviteFile { invites: Invite[] }

const file = (root: string) => join(root, "rules", "invites.yaml");
// Crockford base32: no I, L, O or U, so a code read aloud or retyped survives.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const normalize = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");

function load(root: string): InviteFile {
  const f = readYaml<Partial<InviteFile>>(file(root), {});
  return { invites: f.invites ?? [] };
}

function save(root: string, f: InviteFile, msg: string) {
  mkdirSync(join(root, "rules"), { recursive: true });
  // Spent and lapsed invites are kept a day for the record, then dropped from the file (git keeps them).
  const cutoff = new Date(Date.now() - 86_400_000).toISOString();
  f.invites = f.invites.filter((i) => (i.used ?? i.until) > cutoff);
  writeFileSync(file(root), "# One-time invite codes (hashes only). Only the owner edits this file (pocketbrain invite).\n" + YAML.stringify(f));
  git(root, ["add", "rules/invites.yaml"]);
  git(root, ["commit", "-q", "-m", `owner: ${msg}`, "--", "rules/invites.yaml"], OWNER);
}

export function createInvite(root: string, agent: string, o: { minutes?: number; now?: Date } = {}): { code: string; agent: string; until: string } {
  const a = loadRules(root).policy.agents[agent];
  if (!a || a.inside_wall) throw new Error(`${agent} isn't an outside agent in policy.yaml`);
  if (a.role === "gardener") throw new Error("the gardener gets its token from its own setup (pocketbrain gardener rotate), not an invite");
  const minutes = Math.min(Math.max(o.minutes ?? 15, 1), 60);
  const now = o.now ?? new Date();
  const raw = Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  const until = new Date(now.getTime() + minutes * 60_000).toISOString();
  const f = load(root);
  f.invites.push({ hash: sha256(raw), agent, created: now.toISOString(), until });
  save(root, f, `invite for ${agent} until ${until}`);
  return { code: `${raw.slice(0, 5)}-${raw.slice(5)}`, agent, until };
}

// Every open invite for the agent is cancelled (called by revokeTokens).
export function cancelInvites(root: string, agent: string): number {
  const f = load(root);
  const open = f.invites.filter((i) => i.agent === agent && !i.used);
  if (!open.length) return 0;
  const now = new Date().toISOString();
  for (const i of open) i.used = `cancelled ${now}`;
  save(root, f, `invites for ${agent} cancelled`);
  return open.length;
}

// ---------- redeeming ----------

export const ENROLL_FAILS_PER_WINDOW = 10;
const WINDOW_MS = 10 * 60_000;
let fails: number[] = [];
export function resetEnrollLimits() { fails = []; }

export type Enrolled = { agent: string; token: string } | { status: 400 | 401 | 429; error: string };

// Reads, checks and marks the invite in one synchronous step, so a code can't be spent twice.
export function redeemInvite(root: string, code: unknown): Enrolled {
  const now = Date.now();
  fails = fails.filter((t) => now - t < WINDOW_MS);
  if (fails.length >= ENROLL_FAILS_PER_WINDOW) return { status: 429, error: "too many wrong codes; try again in a few minutes" };
  if (typeof code !== "string" || code.length > 40) return { status: 400, error: 'send {"code": "<invite code>"}' };
  const h = sha256(normalize(code));
  const f = load(root);
  const inv = f.invites.find((i) => i.hash === h);
  const a = inv ? loadRules(root).policy.agents[inv.agent] : undefined;
  if (!inv || inv.used || inv.until < new Date(now).toISOString() || !a || a.inside_wall || a.role === "gardener") {
    fails.push(now);
    return { status: 401, error: "that code isn't valid; ask the owner for a new one" };
  }
  inv.used = new Date(now).toISOString();
  save(root, f, `invite for ${inv.agent} used`);
  return { agent: inv.agent, token: issueToken(root, inv.agent) };
}
