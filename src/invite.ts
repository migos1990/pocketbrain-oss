// SPDX-License-Identifier: AGPL-3.0-only
// One-time invite codes (docs/spec/agent-onboarding.md, step 2): for an agent that can't sign in
// with OAuth, the owner gives it a short code instead of a long token. The agent redeems it once
// at POST /v1/enroll and gets its own token, so the token never passes through the owner's hands.
// Only a hash of each code is kept, in rules/invites.yaml (owner commits, so git is the record).
// A code lasts 15 minutes by default (an hour at most), works once, dies with the agent's revoke,
// and wrong guesses are rate-limited for the whole hub.
import { randomInt, randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync, readFileSync, rmSync, statSync, existsSync, renameSync, linkSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { loadRules, readYaml, tierOf, type Rules } from "./rules";
import { gitSide } from "./quotes";
import { sha256, alert } from "./util";
import { sensitivityRank } from "./brain";
import { narrowSlice } from "./carve";
import { TOKEN_ROLES, type TokenRole } from "./tokenrole";
import { git } from "./git";
import { OWNER } from "./owner";
import { issueToken } from "./auth";

// role (G245): the kind of key the owner said yes to (none = a plain key). purpose "rotate" (G240):
// a code for the gardener's rotation only, never a token or an enrollment.
// by "terminal" (G285): made by `pocketbrain invite` for a narrow agent, so it is good only while
// the agent is still narrow; it is checked again when redeemed.
interface Invite { hash: string; agent: string; created: string; until: string; used?: string; role?: TokenRole; purpose?: "rotate"; by?: "terminal" }
interface InviteFile { invites: Invite[] }

const file = (root: string) => join(root, "rules", "invites.yaml");
// Crockford base32: no I, L, O or U, so a code read aloud or retyped survives.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const normalize = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");

function load(root: string): InviteFile {
  const f = readYaml<Partial<InviteFile>>(file(root), {});
  return { invites: f.invites ?? [] };
}

// G283: two terminals redeeming one code at once must not both read it unspent. Every read-change-
// write of the invites file holds an exclusive lock file outside git, holding its holder's pid,
// time and a random token (G314, G335):
// - created whole: the content is written to a file only this process names, then link()ed to the
//   lock path, which fails if a lock is there; the lock is never seen empty or half-written (G335:
//   an O_EXCL create filled a moment later read as stale, so a second holder took it over);
// - stale when its process is gone, it is older than 30 s, or it is dated in the future (a planted
//   file must not lock the hub out); a lock that doesn't parse is stale only once its mtime is over
//   2 s old (or in the future), so a reader never takes one being written;
// - taken over only under a second lock (`.break`, same link() creation, itself stale after 2 s or
//   when dated in the future, G351),
//   and only if the lock still holds what was read as stale; a fresh lock moved by mistake is put
//   back (a residual race: a holder that was stale but alive releasing in that window);
// - released only by its holder, atomically: renamed to a name only it uses, checked, removed (a
//   lock that turns out not to be its own is put back);
// - waited for only by a terminal (a short wait, its own process) and a revoke; the hub's
//   /v1/enroll and the dashboard never wait: busy is an answer (503) at once.
const LOCK_STALE_MS = 30_000, TERMINAL_WAIT_MS = 5_000, UNWRITTEN_MS = 2_000;
export class InviteLockBusy extends Error {}
function lockAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
const mtimeAge = (p: string) => { try { return Date.now() - statSync(p).mtimeMs; } catch { return Infinity; } };
function lockStale(text: string, age: number): boolean {
  let held: { pid?: unknown; at?: unknown; token?: unknown };
  try { held = JSON.parse(text); } catch { return age > UNWRITTEN_MS || age < -5_000; }
  const at = typeof held?.at === "string" ? Date.parse(held.at) : NaN;
  if (!Number.isFinite(at) || typeof held.token !== "string") return age > UNWRITTEN_MS || age < -5_000;
  const since = Date.now() - at;
  return since > LOCK_STALE_MS || since < -5_000 || !lockAlive(Number(held.pid));
}
// Puts `text` at `p` whole, or fails with EEXIST: written to a name only this call uses, then
// link()ed into place (link never replaces a file).
function createWhole(p: string, text: string, token: string): boolean {
  const tmp = `${p}.${token}.new`;
  writeFileSync(tmp, text, { mode: 0o600 });
  try { linkSync(tmp, p); return true; } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return false;
  } finally { rmSync(tmp, { force: true }); }
}
// Removes `p` only if it still holds `text`: renamed aside first, so nobody else's lock is removed.
function removeIf(p: string, text: string, token: string) {
  const aside = `${p}.${token}.old`;
  try { renameSync(p, aside); } catch { return; } // gone already
  let moved = "";
  try { moved = readFileSync(aside, "utf8"); } catch { /* gone */ }
  if (moved !== text) { try { linkSync(aside, p); } catch { /* a newer one is there */ } }
  rmSync(aside, { force: true });
}
// True when it removed the stale lock or a dead `.break` (the caller tries again at once); false when another breaker
// holds `.break` or the lock changed, so the caller waits like any busy lock (G351).
function breakStale(p: string, text: string, token: string): boolean {
  const brk = `${p}.break`;
  if (!createWhole(brk, token, token)) {
    // A breaker that died, or a `.break` dated in the future (planted), is cleared like a stale lock (G351).
    const age = mtimeAge(brk);
    if (!(age > UNWRITTEN_MS || age < -5_000)) return false;
    try { removeIf(brk, readFileSync(brk, "utf8"), token); } catch { /* gone */ }
    return true; // cleared: try again at once
  }
  try {
    let now = "";
    try { now = readFileSync(p, "utf8"); } catch { return true; }
    if (now !== text || !lockStale(now, mtimeAge(p))) return false;
    removeIf(p, text, token);
    return true;
  } finally { removeIf(brk, token, token); }
}
export function withInviteLock<T>(root: string, fn: () => T, waitMs = 0): T {
  const p = gitSide(root, "pb-invites.lock");
  const token = randomBytes(12).toString("hex");
  const me = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token });
  const until = Date.now() + waitMs;
  // G351: every path that made no progress meets the deadline, so a no-wait caller (/v1/enroll on the
  // hub's one thread) answers busy instead of spinning; a path that did (the lock was released, or
  // a stale one removed) tries again at once, a bounded number of times past the deadline.
  let retries = 0;
  for (;;) {
    if (createWhole(p, me, token)) break;
    let text: string | undefined;
    try { text = readFileSync(p, "utf8"); } catch { /* released meanwhile */ }
    const progress = text === undefined || (lockStale(text, mtimeAge(p)) && breakStale(p, text, token));
    if (progress && ++retries <= 20) continue;
    if (Date.now() >= until) throw new InviteLockBusy("another one-time code is being redeemed right now (.git/pb-invites.lock); try again in a moment");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  try { return fn(); }
  finally { removeIf(p, me, token); }
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

export function createInvite(root: string, agent: string, o: { minutes?: number; now?: Date; role?: TokenRole; purpose?: "rotate"; terminal?: boolean } = {}): { code: string; agent: string; until: string } {
  const rules = loadRules(root), a = rules.policy.agents[agent], p = rules.policy;
  if (!a || a.inside_wall) throw new Error(`${agent} isn't an outside agent in policy.yaml`);
  if (a.role === "gardener" && o.purpose !== "rotate") throw new Error("the gardener gets its token from its own setup (pocketbrain gardener rotate), not an invite");
  if (o.purpose === "rotate" && a.role !== "gardener") throw new Error(`${agent} isn't the gardener: a rotation code is for the gardener only`);
  if (o.role && !TOKEN_ROLES.includes(o.role)) throw new Error(`role is ${TOKEN_ROLES.join(" or ")}`);
  if (o.role === "resolver" && ![p.resolver, p.owner_channel ?? p.louis_channel ?? p.resolver].includes(agent)) throw new Error(`${agent} is neither the resolver nor the owner's channel, so it has no resolver key`);
  const minutes = Math.min(Math.max(o.minutes ?? 15, 1), 60);
  const now = o.now ?? new Date();
  const raw = Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  const until = new Date(now.getTime() + minutes * 60_000).toISOString();
  // The terminal's wrong-code counter must exist before a code does (G285: missing fails closed).
  if (!counterOk(root) && !existsSync(failFile(root))) { try { writeFileSync(failFile(root), "[]", { mode: 0o600 }); } catch { /* spend fails closed */ } }
  withInviteLock(root, () => {
    const f = load(root);
    f.invites.push({ hash: sha256(raw), agent, created: now.toISOString(), until, ...(o.role ? { role: o.role } : {}), ...(o.purpose ? { purpose: o.purpose } : {}), ...(o.terminal ? { by: "terminal" as const } : {}) });
    save(root, f, `invite for ${agent} until ${until}`);
  });
  return { code: `${raw.slice(0, 5)}-${raw.slice(5)}`, agent, until };
}

// Every open invite for the agent is cancelled (called by revokeTokens).
export function cancelInvites(root: string, agent: string): number {
  // A revoke waits a moment rather than fail at once; if the lock stays busy, revokeTokens throws
  // before it removes a key (G336), so the agent is never left keyless with a code still open.
  return withInviteLock(root, () => {
    const f = load(root);
    const open = f.invites.filter((i) => i.agent === agent && !i.used);
    if (!open.length) return 0;
    const now = new Date().toISOString();
    for (const i of open) i.used = `cancelled ${now}`;
    save(root, f, `invites for ${agent} cancelled`);
    return open.length;
  }, 3_000);
}

// ---------- redeeming ----------

export const ENROLL_FAILS_PER_WINDOW = 10;
const WINDOW_MS = 10 * 60_000;
let fails: number[] = [];
// The hub's /v1/enroll counts wrong codes in its own long-lived process. A terminal is a new process
// each time, so its wrong codes are also kept outside git (G245), shared by every terminal run.
const failFile = (root: string) => gitSide(root, "pb-enroll-fails.json");
function shellFails(root: string, now: number): number[] {
  try { return (JSON.parse(readFileSync(failFile(root), "utf8")) as number[]).filter((t) => typeof t === "number" && now - t < WINDOW_MS); } catch { return []; }
}
function shellFail(root: string, now: number) {
  try { writeFileSync(failFile(root), JSON.stringify([...shellFails(root, now), now]), { mode: 0o600 }); } catch { /* no git folder yet: memory only */ }
}
export function resetEnrollLimits() { fails = []; }
// A plain file holding a list of times (G314: anything else fails closed). A shell can still write
// `[]` back between guesses; that is G279's family (a same-user shell), each guess still alerts.
function counterOk(root: string): boolean {
  try {
    if (!statSync(failFile(root)).isFile()) return false;
    const v = JSON.parse(readFileSync(failFile(root), "utf8"));
    return Array.isArray(v) && v.every((t) => typeof t === "number");
  } catch { return false; }
}

// Checks a code without spending it: the invite, or why not. `only.agent` binds it to the agent (the
// terminal's --code); `only.role` must be what the owner made it for (a plain code also makes a
// reader key, which is narrower); `purpose` must match (a rotation code is nothing else).
function findCode(root: string, f: InviteFile, code: string, now: number, only: { agent?: string; role?: TokenRole; purpose?: "rotate" }): Invite | undefined {
  const h = sha256(normalize(code));
  const inv = f.invites.find((i) => i.hash === h);
  const a = inv ? loadRules(root).policy.agents[inv.agent] : undefined;
  if (!inv || inv.used || inv.until < new Date(now).toISOString() || !a || a.inside_wall) return undefined;
  if ((inv.purpose ?? "") !== (only.purpose ?? "")) return undefined;
  if (!only.purpose && a.role === "gardener") return undefined;
  if (only.agent !== undefined && (inv.agent !== only.agent || !(inv.role === only.role || (!inv.role && only.role === "reader")))) return undefined;
  // A terminal's code was good for a narrow agent only: widened since, it is refused (G285).
  if (inv.by === "terminal" && shellMintRefusal(root, inv.agent)) return undefined;
  return inv;
}

export type Enrolled = { agent: string; token: string } | { status: 400 | 401 | 429 | 503; error: string };

// Reads, checks and marks the invite in one synchronous step, so a code can't be spent twice.
// `only` (the terminal's --code, G184): the code must be for that agent; `role`: the token's role.
export function redeemInvite(root: string, code: unknown, only: { agent?: string; role?: TokenRole } = {}): Enrolled {
  const r = spend(root, code, only);
  if ("status" in r) return r;
  // /v1/enroll (no `only`) gets the key the owner made the code for; the terminal, the role it asked.
  const token = issueToken(root, r.agent, only.agent !== undefined ? only.role : r.role);
  // Like every token from a code, it is in the digest (G314; mintFromShell alerts for the terminal).
  if (only.agent === undefined) alert(root, { agent: r.agent, check: "token_minted", from: `a one-time code was redeemed at POST /v1/enroll for a ${r.role ? `${r.role} ` : ""}token. If you didn't give that code out: pocketbrain token --revoke ${r.agent}` });
  return { agent: r.agent, token };
}

// The gardener's rotation code (G240): checked and spent here; rotate() mints and sends the token.
export function spendRotateCode(root: string, code: unknown, agent: string): string | undefined {
  const r = spend(root, code, { agent, purpose: "rotate" });
  return "status" in r ? r.error : undefined;
}

function spend(root: string, code: unknown, only: { agent?: string; role?: TokenRole; purpose?: "rotate" }): Invite | { status: 400 | 401 | 429 | 503; error: string } {
  const now = Date.now();
  const shell = only.agent !== undefined;
  fails = fails.filter((t) => now - t < WINDOW_MS);
  if (fails.length + (shell ? shellFails(root, now).length : 0) >= ENROLL_FAILS_PER_WINDOW) return { status: 429, error: "too many wrong codes; try again in a few minutes" };
  if (typeof code !== "string" || code.length > 40) return { status: 400, error: 'send {"code": "<invite code>"}' };
  // G285: the terminal's counter is a file a shell could remove or replace; then nothing is counted,
  // so no code is taken from a terminal until it is a plain file again (a new code makes it).
  if (shell && !counterOk(root)) {
    alert(root, { agent: only.agent, check: "token_code_refused", from: "the terminal's wrong-code counter (.git/pb-enroll-fails.json) is missing or not a file, so no one-time code is taken from a terminal. If you didn't remove it, someone with a shell did." });
    return { status: 429, error: "the guess counter for terminal codes is missing, isn't a file or isn't a list of times; remove .git/pb-enroll-fails.json and make a new code on the dashboard (it recreates the counter)" };
  }
  try { return withInviteLock(root, () => {
    const f = load(root);
    const inv = findCode(root, f, code, now, only);
    if (!inv) {
      if (shell) { shellFail(root, now); alert(root, { agent: only.agent, check: "token_code_refused", from: "a one-time code typed in a terminal was wrong, used, expired or for another key. If that wasn't you, someone with a shell is guessing." }); }
      else fails.push(now);
      return { status: 401 as const, error: "that code isn't valid; ask the owner for a new one" };
    }
    inv.used = new Date(now).toISOString();
    save(root, f, `invite for ${inv.agent} used`);
    return inv;
  }, shell ? TERMINAL_WAIT_MS : 0); } catch (e) {
    if (e instanceof InviteLockBusy) return { status: 503, error: e.message };
    throw e;
  }
}

// ---------- the terminal's gate (G184) ----------
// Any program with a shell can run the CLI, so the CLI only tightens: resuming an agent or showing
// it more needs the dashboard's login. Minting a token is the same kind of step. From a terminal
// alone, `token`, `connect`, `invite` and `edge enroll` serve only a narrow agent: its writes wait
// for the owner, it sees nothing private, every slice it holds is a named area, kind or tag (never
// all), and it has no hub role (gardener, resolver, the owner's channel or editor). That keeps the
// owner's own first steps working (init's first agent and `add` are trial agents like that). A
// wider agent needs the owner's one-time code from the dashboard (the agent's page), passed as
// --code. Returns why a terminal may not mint for the agent, or undefined when it may.
export function shellMintRefusal(root: string, agent: string): string | undefined {
  const rules = loadRules(root), a = rules.policy.agents[agent], p = rules.policy;
  if (!a || a.inside_wall) return undefined; // issueToken says why
  return reachRefusal(rules, agent);
}

// G241: narrow also bounds reach, to what add, init and menubar setup make by default (a trial
// agent with one area and contacts-basic, money left out): money must be left out, its slices may
// name at most one area between them, and a slice that spans areas must limit itself to named
// attributes (as contacts-basic does). `rules` may hold an agent not yet written (add's preview).
export function reachRefusal(rules: Rules, agent: string): string | undefined {
  const a = rules.policy.agents[agent], p = rules.policy;
  if (!a || a.inside_wall) return undefined;
  const t = tierOf(rules, agent);
  const spec = (s: string) => rules.slices[s] as Record<string, unknown> | undefined;
  const slices = a.slices ?? [];
  const wide = slices.filter((s) => !narrowSlice(s, spec(s)));
  const areas = new Set(slices.flatMap((s) => (spec(s)?.areas as string[] | undefined) ?? []));
  const across = slices.filter((s) => spec(s) && !spec(s)!.areas && !spec(s)!.only_attributes && !(spec(s)!.include && !spec(s)!.types && !spec(s)!.tags));
  const why = [
    t.writes === "propose" ? "" : "its writes go straight into the brain",
    sensitivityRank(t.max_sensitivity) > sensitivityRank("personal") ? `it sees ${t.max_sensitivity} notes` : "",
    wide.length ? `it holds ${wide.join(", ")}` : "",
    (a.exclude_types ?? []).includes("money") ? "" : "money isn't left out",
    areas.size > 1 ? `it spans ${areas.size} areas` : "",
    across.length ? `${across.join(", ")} reaches across areas with every field` : "",
    a.role ? `it is the ${a.role}` : "",
    [p.resolver, p.owner_channel, p.louis_channel, p.owner_editor].includes(agent) ? "it holds one of your roles" : "",
  ].filter(Boolean);
  return why.length ? why.join(", ") : undefined;
}

// A token from the terminal (G184): for a narrow agent, or with the owner's one-time code. Every one
// is a `token_minted` alert, so the digest names it; the token itself is never logged.
// `mint` makes the token once the gate passes (default: a new token; `token rotate` passes
// rotateToken, so the old one keeps its overlap). The gate is the same for every door.
export function mintFromShell(root: string, agent: string, o: { via: string; code?: string; role?: TokenRole; mint?: () => string }): string {
  if (o.code !== undefined) {
    const r = spend(root, o.code, { agent, role: o.role });
    if ("status" in r) throw new Error(`${r.error} (a code works once, for the agent it was made for)`);
  } else {
    const why = shellMintRefusal(root, agent);
    if (why) throw new Error(`${agent}: ${why}, so a terminal alone can't make it a token. On the dashboard, open ${agent}'s page (Assistants) and press "One-time code", then run: pocketbrain ${o.via} --code <code>`);
  }
  const token = (o.mint ?? (() => issueToken(root, agent, o.role)))();
  alert(root, { agent, check: "token_minted", from: `pocketbrain ${o.via} made a ${o.role ? `${o.role} ` : ""}token from a terminal${o.code !== undefined ? " with your one-time code" : ""}. If that wasn't you: pocketbrain token --revoke ${agent}` });
  return token;
}
