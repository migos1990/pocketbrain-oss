// SPDX-License-Identifier: AGPL-3.0-only
// The act door (docs/act.md, backlog #204): the carve decides what an agent may know; this
// decides what it may do, for one action, sending a mail. The agent asks with `act`; the brain
// checks the request against that agent's act block in rules/policy.yaml (only the owner edits
// it), holds it for the owner, and sends it only after the owner approves it in the dashboard.
// The only transport is a fake one: a line in actions/fake/sent.jsonl, outside the brain's git.
//
// What holds, whatever an agent does:
// - No act block, no actions. loadRules drops the block for collaborators, the gardener, the
//   resolver and the owner's text channel, inside_wall agents, and paused or read-only agents.
// - One recipient, matched raw against a strict address shape and the owner's list (exact
//   addresses, or a domain with no subdomains). A refusal says the list's size, never its contents.
// - A value the agent can't see (hiddenNeedles, src/needles.ts) refuses the request, alerts the
//   owner and stops that agent's requests until the owner clears it, so a refusal is one guess at
//   most. Values it can see that sit above the recipient's ceiling only mark the item `carries`.
// - Every mail waits for the owner, approved in the dashboard only (a text can reject or put
//   off, never approve). The approval is bound to a hash of the exact bytes, by id, once.
// - Approving and sending each re-run every check against the current rules and brain; a failure
//   cancels the action. Expiry: 24 hours waiting, 10 minutes between approval and send.
// - Every step is a line in actions/log.jsonl (hash-chained), hub state that the brain's git
//   ignores. The body is in the first line only; no agent route reads that file.
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Sensitivity } from "./brain";
import { loadBrain } from "./brain";
import { loadRules, ownerName, actOn, validAddress, type ActEntry, type Rules } from "./rules";
import { findSecret, findInjection } from "./checks";
import { findCarried, unhide, squash } from "./match";
import { FILLERS } from "./access-request";
import { carve, grantFor, shownWords } from "./carve";
import { hiddenNeedles, hiddenWords, outwardScreen, screenText, type ScreenHit } from "./needles";
import { loadCanaries } from "./canary";
import { appendChained } from "./readlog";
import { CoreError } from "./core";
import { tokenRole } from "./tokenrole";
import { hubRole } from "./hub";
import { tokenInfo } from "./auth";
import { loadOAuth } from "./oauth";
import { coworkerStanding } from "./offboard";
import { OWNER } from "./owner";
import { alert, escapeRe, readJsonl, sha256, appendJsonl } from "./util";

export { actOn };

export type ActionState = "waiting" | "approved" | "sending" | "sent" | "declined" | "expired" | "cancelled" | "failed";

export interface Action {
  id: string; agent: string; kind: "send_mail"; to: string; subject: string; body: string; why: string;
  hash: string; code: string; entry: string; entry_label: string; entry_kind: "exact" | "domain";
  ceiling: Sensitivity; carries: string[]; hits: ScreenHit[]; flags: string[];
  at: string; expires: string; state: ActionState;
  approved?: { at: string; by: string; via: string; send_by: string };
  ended?: { at: string; why?: string; via?: string };
}

export interface ActReply { request: string; status: string; message: string }

const WAIT_MS = 24 * 3_600_000;
const SEND_WITHIN_MS = 10 * 60_000;
const DAY_MS = 24 * 3_600_000;
const DEFAULT_AGENT_MAX = 3;
const DEFAULT_REQUESTS = 10;
const DEFAULT_OWNER_MAX = 10;
const RECIPIENT_ALERT_AT = 3;
const MAX = { subject: 120, body: 4000, why: 300, to: 254 };

// Hub state, never the brain's git (red team L3): actions/ holds a .gitignore of "*", so the
// relay's `git add log`, the write path and any owner commit never pick up a mail body.
const stateDir = (root: string) => join(root, "actions");
export const actionsLog = (root: string) => join(stateDir(root), "log.jsonl");
const sentFile = (root: string) => join(stateDir(root), "fake", "sent.jsonl");
function ensureState(root: string) {
  mkdirSync(stateDir(root), { recursive: true });
  if (!existsSync(join(stateDir(root), ".gitignore"))) writeFileSync(join(stateDir(root), ".gitignore"), "*\n");
}
const iso = (ms: number) => new Date(ms).toISOString();

// The content hash (red team M3): over the exact bytes the transport sends, with the id, the agent
// and the action, so a same-text request by another agent or under another id is another approval.
export function actionHash(a: { id: string; agent: string; action: string; to: string; subject: string; body: string }): string {
  return sha256(JSON.stringify({ v: 1, id: a.id, agent: a.agent, action: a.action, to: a.to, subject: a.subject, body: a.body }));
}
const rehash = (a: Action) => actionHash({ id: a.id, agent: a.agent, action: a.kind, to: a.to, subject: a.subject, body: a.body });

type Ev = Record<string, unknown> & { ev: string; at: string; action?: string; agent?: string };
const readEvents = (root: string) => readJsonl<Ev>(actionsLog(root));
function event(root: string, e: Record<string, unknown>) {
  ensureState(root);
  appendChained(actionsLog(root), { at: iso(Date.now()), ...e });
}

// The current state of every action, folded from the log. Time runs out without a log line.
export function listActions(root: string, evs = readEvents(root)): Action[] {
  const out = new Map<string, Action>();
  for (const e of evs) {
    if (!e.action) continue;
    if (e.ev === "requested") {
      out.set(e.action, {
        id: e.action, agent: String(e.agent), kind: "send_mail", to: String(e.to), subject: String(e.subject), body: String(e.body), why: String(e.why ?? ""),
        hash: String(e.hash_content), code: String(e.code), entry: String(e.entry), entry_label: String(e.entry_label), entry_kind: e.entry_kind === "domain" ? "domain" : "exact",
        ceiling: (e.ceiling as Sensitivity) ?? "public", carries: (e.carries as string[]) ?? [], hits: (e.hits as ScreenHit[]) ?? [], flags: (e.flags as string[]) ?? [],
        at: e.at, expires: String(e.expires), state: "waiting",
      });
      continue;
    }
    const a = out.get(e.action);
    if (!a || e.hash_content !== a.hash) continue;
    const end = (s: ActionState) => { a.state = s; a.ended = { at: e.at, ...(e.why ? { why: String(e.why) } : {}), ...(e.via ? { via: String(e.via) } : {}) }; };
    if (e.ev === "approved" && a.state === "waiting") { a.state = "approved"; a.approved = { at: e.at, by: String(e.by), via: String(e.via), send_by: String(e.send_by) }; }
    else if (e.ev === "sending" && a.state === "approved") a.state = "sending";
    else if (e.ev === "sent" && a.state === "sending") end("sent");
    else if (e.ev === "failed" && (a.state === "sending" || a.state === "sent")) end("failed");
    else if (e.ev === "declined" && (a.state === "waiting" || a.state === "approved")) end("declined");
    else if (e.ev === "expired" && (a.state === "waiting" || a.state === "approved")) end("expired");
    else if (e.ev === "cancelled" && (a.state === "waiting" || a.state === "approved")) end("cancelled");
  }
  const now = iso(Date.now());
  for (const a of out.values()) {
    if (a.state === "waiting" && a.expires < now) a.state = "expired";
    if (a.state === "approved" && a.approved!.send_by < now) a.state = "expired";
  }
  return [...out.values()];
}

export const waitingActions = (root: string) => listActions(root).filter((a) => a.state === "waiting");

// After a tripwire refusal an agent's requests stop until the owner clears it (red team M8).
export function latched(root: string, agent: string, evs = readEvents(root)): boolean {
  let on = false;
  for (const e of evs) if (e.agent === agent && !e.action) { if (e.ev === "latched") on = true; else if (e.ev === "unlatched") on = false; }
  return on;
}
export function latchedAgents(root: string): string[] {
  const evs = readEvents(root);
  return [...new Set(evs.filter((e) => e.ev === "latched").map((e) => String(e.agent)))].filter((a) => latched(root, a, evs));
}

// One process at a time through approve and send: a lock file next to the log, so the dashboard,
// the CLI and the hub can't send the same action twice (red team M9). Every function here is
// synchronous, so within one process the lock is held across a whole transition.
function withLock<T>(root: string, fn: () => T): T {
  ensureState(root);
  const lock = join(stateDir(root), "lock");
  const until = Date.now() + 5000;
  for (;;) {
    try { closeSync(openSync(lock, "wx")); break; } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 60_000) { rmSync(lock, { force: true }); continue; } } catch { continue; }
      if (Date.now() > until) throw new CoreError(503, "another approval is being sent; try again in a moment");
      Bun.sleepSync(20);
    }
  }
  try { return fn(); } finally { rmSync(lock, { force: true }); }
}

// ---------- the checks, the same at request, approval and send ----------

// What a mail may hold: only what the owner sees on the card (G210). An allowlist, so a character
// that draws as nothing (tag characters, variation selectors, format and private-use code points,
// line separators, the blank fillers access requests drop) is refused, never stripped: the owner
// approves the bytes that would be sent. Letters, numbers, punctuation and symbols in any script,
// up to two marks on a letter, one emoji presentation selector after a pictograph, space, no-break
// space, tab, and newlines in the body.
const FILL = new RegExp(FILLERS.source, "u");
const SELECTOR = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u;
const PLAIN = /[\p{L}\p{N}\p{P}\p{S} \u00A0\u202F\u3000\t]/u; // plus the narrow no-break space (French) and the ideographic space
function unseenChar(v: string, newlines: boolean): string | undefined {
  const cs = [...v];
  let marks = 0;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i], prev = cs[i - 1] ?? "";
    if (newlines && (c === "\n" || (c === "\r" && cs[i + 1] === "\n"))) { marks = 0; continue; } // LF or CRLF in the body
    if (FILL.test(c)) return c;
    if (SELECTOR.test(c)) { if ((c === "\uFE0F" || c === "\uFE0E") && /\p{Extended_Pictographic}/u.test(prev)) continue; return c; }
    // Anything Unicode itself says may draw as nothing (re-audit, G210): Mongolian free variation
    // selectors and Khmer inherent vowels are marks, so the mark rule alone let them through.
    if (/\p{Default_Ignorable_Code_Point}/u.test(c)) return c;
    if (/\p{M}/u.test(c)) { if (++marks <= 2 && /[\p{L}\p{M}]/u.test(prev)) continue; return c; }
    marks = 0;
    if (!PLAIN.test(c)) return c;
  }
  return undefined;
}
// Card-shaped runs with dots or slashes between groups (findSecret takes spaces and dashes).
const DOTTED_CARD = /\b(?:\d[./]?){13,19}\b/g;
function luhn(d: string): boolean {
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) { let n = Number(d[i]); if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
  return sum % 10 === 0;
}
function outboundSecret(text: string): string | undefined {
  const t = unhide(text);
  const s = findSecret(t);
  if (s) return s;
  // A bare key header isn't a key to findSecret, but next to the log line's hash it is to the
  // backup's scan, which would then drop the actions log (re-audit, G212).
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(t)) return "a private key header";
  for (const m of t.matchAll(DOTTED_CARD)) { const d = m[0].replace(/\D/g, ""); if (d.length >= 13 && luhn(d)) return "a card-number-shaped number"; }
  return undefined;
}
// "Robin approved", "the owner signed off": shown to the owner as a flag, never a reason to send.
const approvalClaim = (name: string) => new RegExp(`\\b(louis|the owner|owner${name === "the owner" ? "" : `|${escapeRe(name)}`})\\s+(has\\s+)?(already\\s+)?(approved|confirmed|agreed|signed off|said (ok|yes))\\b|\\bAPPROVED\\b`, "i");

interface Fields { to: string; subject: string; body: string; why: string }
type Refusal = { check: string; status: number; message: string; tripwire?: string; recipient?: boolean };

function shapeOf(body: Record<string, unknown>): Fields | Refusal {
  const bad = (message: string): Refusal => ({ check: "shape", status: 422, message });
  if (body.action !== "send_mail") return bad("action must be send_mail, the only action there is");
  for (const k of ["to", "subject", "body", "why"] as const) if (typeof body[k] !== "string" || !(body[k] as string).length) return bad(`${k} is required (a string)`);
  const f = { to: body.to as string, subject: body.subject as string, body: body.body as string, why: body.why as string };
  if (f.to.length > MAX.to) return { check: "recipient", status: 422, message: "to must be one plain address", recipient: true };
  return charsOf(f) ?? f;
}
function charsOf(f: Fields): Refusal | undefined {
  const bad = (message: string): Refusal => ({ check: "shape", status: 422, message });
  if (f.subject.length > MAX.subject) return bad(`the subject is at most ${MAX.subject} characters`);
  if (f.body.length > MAX.body) return bad(`the body is at most ${MAX.body} characters`);
  if (f.why.length > MAX.why) return bad(`why is at most ${MAX.why} characters, one line`);
  if (/[\r\n]/.test(f.subject)) return bad("the subject is one line: no line breaks");
  if (/[\r\n]/.test(f.why)) return bad("why is one line: no line breaks");
  for (const [k, v] of [["subject", f.subject], ["body", f.body], ["why", f.why]] as const) {
    const c = unseenChar(v, k === "body");
    if (c) return bad(`the ${k} has control, direction or invisible characters (first: U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}); plain text only (newlines in the body are fine)`);
  }
  return undefined;
}

// The list entry the address matches: an exact address, or "@domain" with that domain only.
function entryFor(entries: ActEntry[], to: string): { entry: ActEntry; kind: "exact" | "domain" } | undefined {
  const exact = entries.find((e) => !e.to.startsWith("@") && e.to === to);
  if (exact) return { entry: exact, kind: "exact" };
  const domain = to.split("@")[1];
  const d = entries.find((e) => e.to.startsWith("@") && e.to.slice(1) === domain);
  return d ? { entry: d, kind: "domain" } : undefined;
}
export const entryLabel = (entries: ActEntry[], e: ActEntry) => e.label ?? `entry ${entries.indexOf(e) + 1} on its list`;

interface Passed { entry: ActEntry; kind: "exact" | "domain"; label: string; ceiling: Sensitivity; carries: string[]; hits: ScreenHit[]; flags: string[] }

// Everything but the rate caps and the latch: recipient, characters, leaks, secrets, the outward
// screen and the flags. The text is never changed; a request passes as it came or not at all.
function contentChecks(root: string, rules: Rules, agent: string, f: Fields): Passed | Refusal {
  const entries = rules.policy.agents[agent]!.act!.send_mail!.to;
  const notOnList: Refusal = { check: "recipient", status: 403, message: `not on your list (${entries.length} entr${entries.length === 1 ? "y" : "ies"})`, recipient: true };
  // Raw input, no normalising first: the checked bytes are the hashed and sent bytes (M6).
  if (!validAddress(f.to)) return { check: "recipient", status: 422, message: "to must be one plain address: lowercase letters, digits, dot, dash or underscore, then @ and a domain", recipient: true };
  const hit = entryFor(entries, f.to);
  if (!hit) return notOnList;
  const chars = charsOf(f);
  if (chars) return chars;
  const notes = loadBrain(root);
  // The tripwire: canaries, and any value the agent can't see, in the address, subject or body.
  const text = unhide(`${f.to}\n${f.subject}\n${f.body}`);
  const low = text.toLowerCase();
  const canary = [...loadCanaries(root).canaries, ...loadCanaries(root).retired].find((c) => low.includes(c.toLowerCase()));
  const needle = findCarried(text, hiddenNeedles(notes, rules, agent));
  const from = canary ? "a canary" : needle?.from;
  const tripMsg = `refused: this mail can't be sent. ${ownerName(rules).replace(/^the/, "The")} is told.`;
  if (from) return { check: "tripwire", status: 403, message: tripMsg, tripwire: from };
  // why too: it is logged and shown, and a secret in it would drop the log from backups (G212).
  const secret = outboundSecret(`${f.subject}\n${f.body}\n${f.why}`);
  if (secret) return { check: "secret", status: 422, message: `refused: the mail or its why contains ${secret}. Never send or store secrets.` };
  // The outward screen at the recipient's ceiling (H2): flags, never refuses, except in the local
  // part of an address under a domain entry, which is no place for anything (M7).
  const ceiling = hit.entry.max_sensitivity ?? "public";
  const screen = outwardScreen(notes, rules, ceiling);
  const local = f.to.split("@")[0];
  if (hit.kind === "domain") {
    if ((local.match(/\d/g) ?? []).length > 3) return notOnList;
    // A word of a value the agent can't see is the tripwire, latch included, so a local part is
    // one guess at most (G211); a word it can see above the ceiling is just not a listed address.
    const inLocal = screenText(screen, local.replace(/[._-]+/g, " "));
    if (inLocal.length) {
      const seen = shownWords(carve(notes, rules, grantFor(rules, agent), { flags: false }));
      const unseen = inLocal.find((h) => !h.match.split(/[^\p{L}\p{N}]+/u).filter(Boolean).every((w) => seen.has(squash(w))));
      if (unseen) return { check: "tripwire", status: 403, message: tripMsg, tripwire: unseen.from };
      return notOnList;
    }
  }
  const hits = screenText(screen, `${f.subject}\n${f.body}\n${f.to}`);
  const flags: string[] = [];
  // One word of a value the agent can't see (red team M2): a flag for the owner, not a refusal.
  const words = hiddenWords(notes, rules, agent);
  const word = [...new Set(text.split(/[^\p{L}\p{N}]+/u).map(squash))].find((w) => words.has(w));
  if (word) flags.push(`it uses "${word}", one word of a value ${agent} can't see`);
  for (const [k, v] of [["why", f.why], ["subject", f.subject], ["body", f.body]] as const) {
    if (approvalClaim(ownerName(rules)).test(v)) flags.push(`the ${k} claims the owner approved; you never did here`);
    const inj = findInjection(v);
    if (inj) flags.push(`the ${k} ${inj}`);
  }
  return { entry: hit.entry, kind: hit.kind, label: entryLabel(entries, hit.entry), ceiling, carries: [...new Set(hits.map((h) => h.from))].sort(), hits, flags };
}

const isRefusal = (x: unknown): x is Refusal => !!x && typeof (x as Refusal).check === "string" && typeof (x as Refusal).message === "string";

function agentMax(rules: Rules, agent: string) { return rules.policy.agents[agent]?.act?.send_mail?.max_per_day ?? DEFAULT_AGENT_MAX; }
function ownerMax(rules: Rules) { return rules.policy.act?.max_per_day ?? DEFAULT_OWNER_MAX; }
function sentSince(all: Action[], since: string, agent?: string) {
  return all.filter((a) => (!agent || a.agent === agent) && (a.state === "sent" || a.state === "sending" || a.state === "failed") && (a.ended?.at ?? a.approved?.at ?? a.at) >= since).length;
}

// Who may ask at all: an active agent with an act block, on the hub, not a reader token.
function doorCheck(root: string, rules: Rules, agent: string): Refusal | undefined {
  const a = rules.policy.agents[agent];
  const O = ownerName(rules);
  if (a?.status === "paused" || a?.status === "read-only") return { check: "agent_status", status: 403, message: `${agent} is ${a.status} by ${O}; no actions` };
  if (!a || !actOn(rules, agent)) return { check: "allowed", status: 403, message: `you have no actions: ${O} hasn't given you any (no act block)` };
  if (tokenRole(agent) === "reader") return { check: "allowed", status: 403, message: "this is a reader token: it can't ask for actions" };
  const role = hubRole(root);
  if (role.mode === "replica" || role.mode === "unnamed") return { check: "replica", status: 403, message: "actions run on the hub only, never on a replica" };
  return undefined;
}

// The agent still holds a way in: a token, an OAuth client or a coworker binding (revoke cuts them).
function hasCredential(root: string, agent: string): boolean {
  if ((tokenInfo(root)[agent] ?? []).length) return true;
  const o = loadOAuth(root);
  return Object.values(o?.clients ?? {}).some((c) => c.agent === agent) || Object.values(o?.coworkers ?? {}).some((c) => c.agent === agent);
}

// A coworker's agent (rules/oauth.yaml) whose account the sign-in service says is blocked or
// deleted (src/offboard.ts) is offboarded: its mail is cancelled. When the hub can't tell right
// now (no answer for too long), nothing is sent and nothing is cancelled: try again later.
function coworkerOff(root: string, agent: string): string | undefined {
  for (const [subject, cw] of Object.entries(loadOAuth(root)?.coworkers ?? {})) {
    if (cw.agent !== agent) continue;
    const st = coworkerStanding(subject);
    if (st === "blocked" || st === "gone") return `${cw.name}'s account is ${st === "gone" ? "deleted" : "blocked"} at the sign-in service (offboarded)`;
    if (st === "unknown") throw new CoreError(503, `can't confirm ${cw.name}'s account is still active at the sign-in service; nothing sent, try again in a minute`);
  }
  return undefined;
}

// Approve and send re-run every check against the current rules and brain (red team M5).
function recheck(root: string, a: Action, all: Action[]): string | undefined {
  const rules = loadRules(root);
  const door = doorCheck(root, rules, a.agent);
  if (door) return door.check === "allowed" ? `${a.agent} no longer has this action (its act block, status or role changed)` : door.message;
  if (!hasCredential(root, a.agent)) return `${a.agent} has no live key or sign-in (revoked)`;
  const off = coworkerOff(root, a.agent);
  if (off) return off;
  if (latched(root, a.agent)) return `${a.agent}'s requests are stopped after a tripwire refusal`;
  if (rehash(a) !== a.hash) return "the stored mail doesn't match its hash";
  const since = iso(Date.now() - DAY_MS);
  if (sentSince(all, since) >= ownerMax(rules)) return `the owner-wide limit of ${ownerMax(rules)} mails in 24 hours is reached for today`;
  if (sentSince(all, since, a.agent) >= agentMax(rules, a.agent)) return `${a.agent} has sent its ${agentMax(rules, a.agent)} mails for today`;
  const c = contentChecks(root, rules, a.agent, { to: a.to, subject: a.subject, body: a.body, why: a.why });
  if (isRefusal(c)) {
    if (c.tripwire) alert(root, { agent: a.agent, check: "act_tripwire", from: c.tripwire, action: a.id });
    return c.tripwire ? "the mail now carries a value the agent can't see" : c.recipient ? "the recipient is no longer on the agent's list" : c.message;
  }
  const fresh = c.carries.filter((x) => !a.carries.includes(x));
  if (fresh.length) return `the mail now carries values from ${fresh.join(", ")}, which the page you approved didn't show`;
  return undefined;
}

// ---------- the agent's side ----------

const WAITING = (id: string, O: string) => `Waiting for ${O}, who approves mail in the dashboard only. Nothing is sent until then. Check with act_status and request ${id}; it runs out in 24 hours.`;

const randomCode = () => String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
let codeRoll: (() => string) | undefined;
const rollCode = () => (codeRoll ?? randomCode)();
/** Tests only: fix the next code rolls. */
export const __setCodeRoll = (f: (() => string) | undefined) => { codeRoll = f; };

export function requestAction(root: string, agent: string, body: Record<string, unknown>): ActReply {
  const rules = loadRules(root);
  const door = doorCheck(root, rules, agent);
  if (door) throw new CoreError(door.status, door.message);
  const evs = readEvents(root);
  const since = iso(Date.now() - DAY_MS);
  const mine = evs.filter((e) => e.agent === agent && (e.ev === "requested" || e.ev === "refused") && e.at >= since);
  const refuse = (r: Refusal): never => {
    event(root, { ev: "refused", agent, check: r.check, reason: r.message.slice(0, 200) });
    if (r.tripwire) {
      alert(root, { agent, check: "act_tripwire", from: r.tripwire });
      event(root, { ev: "latched", agent, why: "tripwire" });
    }
    if (r.recipient) {
      const n = mine.filter((e) => e.ev === "refused" && e.check === "recipient").length + 1;
      if (n === RECIPIENT_ALERT_AT) alert(root, { agent, check: "act_recipient", detail: `${n} mail requests to addresses not on ${agent}'s list in 24 hours` });
    }
    throw new CoreError(r.status, r.message);
  };
  const cap = rules.policy.agents[agent]!.act!.send_mail!.max_requests_per_day ?? DEFAULT_REQUESTS;
  if (mine.length >= cap) refuse({ check: "request_cap", status: 429, message: `at most ${cap} act requests in 24 hours, refused ones included` });
  if (latched(root, agent, evs)) refuse({ check: "latched", status: 403, message: `your act requests are paused until ${ownerName(rules)} looks at your last one` });
  const f = shapeOf(body);
  if (isRefusal(f)) refuse(f);
  const fields = f as Fields;
  const all = listActions(root, evs);
  // One waiting mail first: with it filled every probe gets the same answer, whatever it holds (G211).
  if (all.some((a) => a.agent === agent && ["waiting", "approved", "sending"].includes(a.state))) refuse({ check: "one_waiting", status: 429, message: "you already have a mail waiting; check it with act_status" });
  // Then the recipient, so a probe is a recipient refusal (counted, and alerted at 3).
  const c = contentChecks(root, rules, agent, fields);
  if (isRefusal(c)) refuse(c);
  const ok = c as Passed;
  const max = agentMax(rules, agent);
  if (mine.filter((e) => e.ev === "requested").length >= max) refuse({ check: "agent_cap", status: 429, message: `at most ${max} mails in 24 hours` });
  if (sentSince(all, since) >= ownerMax(rules)) refuse({ check: "owner_cap", status: 429, message: `the owner-wide limit of mails for today is reached; try tomorrow` });

  const id = `act-${randomBytes(6).toString("hex")}`;
  // A code names one waiting mail in a text reply (G146), so it is re-rolled while another waiting mail has it.
  const taken = new Set(waitingActions(root).map((w) => w.code));
  let code = rollCode();
  while (taken.has(code)) code = rollCode();
  const hash = actionHash({ id, agent, action: "send_mail", ...fields });
  event(root, {
    ev: "requested", action: id, agent, kind: "send_mail", to: fields.to, subject: fields.subject, body: fields.body, why: fields.why, hash_content: hash, code,
    entry: ok.entry.to, entry_label: ok.label, entry_kind: ok.kind, ceiling: ok.ceiling, carries: ok.carries, hits: ok.hits.slice(0, 20), flags: ok.flags, expires: iso(Date.now() + WAIT_MS),
  });
  return { request: id, status: "waiting", message: WAITING(id, ownerName(rules)) };
}

export function actionStatus(root: string, agent: string, id: string): ActReply {
  const rules = loadRules(root);
  if (!rules.policy.agents[agent]) throw new CoreError(403, `${agent} has no grant`);
  const a = listActions(root).find((x) => x.id === id && x.agent === agent);
  if (!a) throw new CoreError(404, `no action ${id} of yours`);
  const O = ownerName(rules);
  const said: Record<ActionState, [string, string]> = {
    waiting: ["waiting", `Still waiting for ${O}. It runs out at ${a.expires}.`],
    approved: ["approved", `${O} approved it; it is being sent.`],
    sending: ["approved", `${O} approved it; it is being sent.`],
    sent: ["sent", "Sent."],
    failed: ["failed", `${O} approved it but the transport failed; ${O} sees why.`],
    declined: ["declined", `${O} declined it. Don't ask another assistant to send it.`],
    expired: ["expired", `It ran out before it was sent. Ask again only if ${O} still wants it.`],
    cancelled: ["cancelled", `It was cancelled before sending. Don't ask another assistant to send it.`],
  };
  const [status, message] = said[a.state];
  return { request: id, status, message };
}

// ---------- the owner's side ----------

function find(root: string, id: string) {
  const evs = readEvents(root);
  const all = listActions(root, evs);
  const a = all.find((x) => x.id === id);
  if (!a) throw new CoreError(404, `no action ${id}`);
  return { a, all };
}
// A time-out the log doesn't know yet is written down when someone acts on it.
function noteExpiry(root: string, a: Action, evs: Ev[]) {
  if (a.state === "expired" && !evs.some((e) => e.action === a.id && e.ev === "expired")) event(root, { ev: "expired", action: a.id, hash_content: a.hash, why: a.approved ? "approved but not sent within 10 minutes" : "not approved within 24 hours" });
}

// The dashboard's approve: the form posts the id and the hash it showed, which must still be the
// stored mail's hash (M3). Then, unless told not to, it sends at once.
export function approveAction(root: string, id: string, hash: string, how: { via: string; by?: string; sendNow?: boolean } = { via: "dashboard" }): string {
  const msg = withLock(root, () => {
    const { a, all } = find(root, id);
    noteExpiry(root, a, readEvents(root));
    if (a.state !== "waiting") throw new CoreError(409, `${id} is ${a.state}`);
    if (hash !== a.hash || rehash(a) !== a.hash) throw new CoreError(409, "this mail changed since the page was drawn (its hash doesn't match); reload and look again");
    const why = recheck(root, a, all);
    if (why) { event(root, { ev: "cancelled", action: id, hash_content: a.hash, why }); throw new CoreError(409, `cancelled: ${why}`); }
    event(root, { ev: "approved", action: id, hash_content: a.hash, by: how.by ?? OWNER, via: how.via, send_by: iso(Date.now() + SEND_WITHIN_MS) });
    return `approved: ${a.agent}'s mail to ${a.entry_label}`;
  });
  return how.sendNow === false ? msg : sendAction(root, id);
}

// approved -> sending -> sent, once, under the lock. `sending` and `sent` are chained before the
// transport is called, and the transport keys on the id, so a crash, a second process or a
// restore that lost actions/ never sends twice.
export function sendAction(root: string, id: string): string {
  const a = withLock(root, () => {
    const { a, all } = find(root, id);
    noteExpiry(root, a, readEvents(root));
    if (a.state !== "approved") throw new CoreError(409, `${id} is ${a.state}`);
    const why = recheck(root, a, all);
    if (why) { event(root, { ev: "cancelled", action: id, hash_content: a.hash, why }); throw new CoreError(409, `cancelled: ${why}`); }
    event(root, { ev: "sending", action: id, hash_content: a.hash });
    event(root, { ev: "sent", action: id, hash_content: a.hash, transport: "fake" });
    return a;
  });
  try { fakeTransport(root, a); }
  catch (e) { event(root, { ev: "failed", action: id, hash_content: a.hash, error: String((e as Error).message).slice(0, 200) }); throw new CoreError(502, `the transport failed: ${(e as Error).message}`); }
  return `sent: ${a.agent}'s mail to ${a.entry_label}`;
}

export function declineAction(root: string, id: string, via = "dashboard"): string {
  return withLock(root, () => {
    const { a } = find(root, id);
    if (a.state !== "waiting" && a.state !== "approved") throw new CoreError(409, `${id} is ${a.state}`);
    event(root, { ev: "declined", action: id, hash_content: a.hash, via });
    return `declined; nothing is sent for ${a.agent}`;
  });
}

// Revoke, pause, read-only and the end of a share cancel the agent's waiting actions. The
// re-check at approval and send is the rule; this only clears the owner's queue sooner.
export function cancelActions(root: string, agent: string, why: string): number {
  if (!existsSync(actionsLog(root))) return 0;
  return withLock(root, () => {
    let n = 0;
    for (const a of listActions(root).filter((x) => x.agent === agent && (x.state === "waiting" || x.state === "approved"))) {
      event(root, { ev: "cancelled", action: a.id, hash_content: a.hash, why });
      n++;
    }
    return n;
  });
}

export function clearLatch(root: string, agent: string, by = OWNER): string {
  if (!latched(root, agent)) return `${agent} isn't paused from acting`;
  event(root, { ev: "unlatched", agent, by });
  return `${agent} may ask for actions again`;
}

// ---------- the fake transport ----------

// The only transport in v1: one line per action id in actions/fake/sent.jsonl, a folder the
// brain's git ignores. No network. A second call with the same id adds nothing.
function fakeTransport(root: string, a: Action) {
  ensureState(root);
  mkdirSync(join(stateDir(root), "fake"), { recursive: true });
  if (sentMail(root).some((m) => m.id === a.id)) return;
  appendJsonl(sentFile(root), { id: a.id, at: iso(Date.now()), from_agent: a.agent, to: a.to, subject: a.subject, body: a.body });
}

export function sentMail(root: string): { id: string; at: string; from_agent: string; to: string; subject: string; body: string }[] {
  return readJsonl(sentFile(root));
}
