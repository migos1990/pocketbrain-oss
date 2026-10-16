// SPDX-License-Identifier: AGPL-3.0-only
// Ask to see (docs/ask-to-see.md): an agent asks for something outside its cut, the owner
// approves on their phone (Auth0 Guardian, through CIBA) or in the dashboard, and the agent gets
// that one note, once. Nothing about its slice changes.
//
// What holds, whatever an agent does:
// - The answer to an ask is the same whether or not anything matches (invariant 3): a request
//   id and "waiting". A miss expires like an ask the owner ignored.
// - Only the owner approves. An agent, a relayed text or a model never can; the approval is a
//   dashboard click (CSRF, loopback) or a CIBA approval for the owner's own user at the AS.
// - One approval is one read of one note, within use_within_minutes. Secret notes, conflict
//   packets and the types or areas in ask_to_see.never are never offered.
// - One ask waiting per agent, and max_per_day, so an agent can't flood the owner's phone.
// - The push names the agent and a short code, never the note, unless push_title is set.
// - Every step goes in log/asks.jsonl and the read in log/reads.jsonl, both hash-chained, with
//   the approval (who, how, the AS's request id) attached.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Note } from "./brain";
import { loadBrain, sensitivityRank } from "./brain";
import { loadRules, ownerName, coOwnerOf, type Rules } from "./rules";
import { carve, grantFor, folderOf, type Grant } from "./carve";
import { renderNote } from "./view";
import { buildIndex, rank } from "./retrieve";
import { appendChained } from "./readlog";
import { loadOAuth } from "./oauth";
import { CoreError } from "./core";
import { readJsonl } from "./util";

export interface GuardianConfig {
  domain?: string;      // the Auth0 tenant (dev-xxxx.us.auth0.com); default: the OAuth door's issuer
  client_id: string;    // an Auth0 application with the CIBA grant; its secret is AUTH0_CIBA_CLIENT_SECRET
  user_id?: string;     // the owner at Auth0 (auth0|…); default: the OAuth door's owner_subject
  audience?: string;
  scope?: string;       // default "openid"
}

export interface AskPolicy {
  approver?: "dashboard" | "guardian"; // the dashboard always works too
  expires_minutes?: number;             // how long an ask waits for the owner (default 5)
  use_within_minutes?: number;          // how long an approval stays usable (default 15)
  max_per_day?: number;                 // per agent (default 5)
  never?: string[];                     // types, folders or areas never offered (money, health…)
  push_title?: boolean;                 // put the note's title in the push (default: a code only)
  guardian?: GuardianConfig;
}

export type AskState = "waiting" | "approved" | "declined" | "used" | "expired";

export interface Ask {
  id: string; agent: string; what: string; why: string; at: string; expires: string;
  candidates: { id: string; title: string; sensitivity: string; type?: string }[];
  code: string; approver: string; ref?: string; push_error?: string; boot?: string;
  state: AskState; approved?: { at: string; by: string; via: string; note: string; ref?: string; use_by: string };
  declined?: { at: string; via: string }; used?: { at: string };
}

const file = (root: string) => join(root, "log", "asks.jsonl");
const now = () => new Date();
const iso = (d: Date) => d.toISOString();

export function askPolicy(rules: Rules): AskPolicy | undefined {
  const p = rules.policy.ask_to_see;
  if (!p) return undefined;
  return p === true ? {} : p;
}

export const asksOn = (rules: Rules, agent: string) =>
  !!askPolicy(rules) && rules.policy.agents[agent]?.role !== "gardener" && !rules.policy.agents[agent]?.inside_wall
  // A collaborator gets the slices the owner shared, never one-off notes (src/share.ts).
  && !rules.policy.agents[agent]?.collaborator;

// Which run of the hub logged an ask: a push is sent between two log lines, so an ask from an
// earlier run with neither its ref nor its failure logged was cut off by a restart (row 253).
let boot = randomBytes(4).toString("hex");
export function restartAsks() { boot = randomBytes(4).toString("hex"); } // tests: a new process

function event(root: string, e: Record<string, unknown>) {
  appendChained(file(root), { at: iso(now()), ...e });
}

// The current state of every ask, folded from the log.
export function listAsks(root: string): Ask[] {
  const out = new Map<string, Ask>();
  for (const e of readJsonl<Record<string, unknown> & { ask: string; ev: string; at: string }>(file(root))) {
    if (e.ev === "asked") {
      out.set(e.ask, { id: e.ask, agent: String(e.agent), what: String(e.what), why: String(e.why ?? ""), at: e.at, expires: String(e.expires), candidates: (e.candidates as Ask["candidates"]) ?? [], code: String(e.code), approver: String(e.approver), state: "waiting", ...(e.boot ? { boot: String(e.boot) } : {}) });
      continue;
    }
    const a = out.get(e.ask);
    if (!a) continue;
    if (e.ev === "push") a.ref = String(e.ref);
    else if (e.ev === "push_failed") a.push_error = String(e.error);
    else if (e.ev === "approved" && a.state === "waiting") { a.state = "approved"; a.approved = { at: e.at, by: String(e.by), via: String(e.via), note: String(e.note), ref: e.ref ? String(e.ref) : undefined, use_by: String(e.use_by) }; }
    else if (e.ev === "declined" && a.state === "waiting") { a.state = "declined"; a.declined = { at: e.at, via: String(e.via) }; }
    else if (e.ev === "used" && a.state === "approved") { a.state = "used"; a.used = { at: e.at }; }
    else if (e.ev === "expired" && (a.state === "waiting" || a.state === "approved")) a.state = "expired";
  }
  // Time runs out without a log line; the next write records it.
  const t = iso(now());
  for (const a of out.values()) {
    if (a.state === "waiting" && a.expires < t) a.state = "expired";
    if (a.state === "approved" && a.approved && a.approved.use_by < t) a.state = "expired";
  }
  return [...out.values()];
}

export const waitingAsks = (root: string) => listAsks(root).filter((a) => a.state === "waiting" && a.candidates.length);

// What the owner could be asked to release: the whole brain except what is never offered.
// A co-owner's assistant is never offered or handed anything past its own limits
// (docs/household.md): her areas, personal at most, no money.
const coOwnerMay = (co: ReturnType<typeof coOwnerOf>, n: Note) =>
  !co || (co.areas.includes(n.fm.area) && !["private", "secret"].includes(n.fm.sensitivity) && n.fm.type !== "money" && folderOf(n) !== "money");

function offerable(notes: Note[], rules: Rules, p: AskPolicy, agent: string): { res: ReturnType<typeof carve>; rules: Rules } {
  const never = new Set(p.never ?? []);
  const mine = carve(notes, rules, grantFor(rules, agent));
  const co = coOwnerOf(rules, agent);
  const pool = notes.filter((n) => !mine.visible.has(n.fm.id) && n.fm.sensitivity !== "secret" && folderOf(n) !== "agents"
    && !never.has(folderOf(n)) && !never.has(n.fm.type) && !never.has(n.fm.area)
    // A co-owner's assistant is never offered anything past its own limits (docs/household.md):
    // her areas, personal at most, no money. The ask still answers the same, and runs out.
    && coOwnerMay(co, n));
  const owner: Rules = { ...rules, slices: { ...rules.slices, "ask:any": {} } };
  const grant: Grant = { agent: "owner", slices: ["ask:any"], exclude_types: [], exclude: [], ceiling: co ? "personal" : "private" };
  return { res: carve(pool, owner, grant), rules: owner };
}

// Words the agent sends become a search over what it doesn't hold; the best few matches are
// what the owner is shown. The agent learns none of this.
function match(root: string, rules: Rules, p: AskPolicy, agent: string, what: string): Ask["candidates"] {
  const { res, rules: r } = offerable(loadBrain(root), rules, p, agent);
  return rank(buildIndex(res, r), what, 3).map((h) => {
    const n = res.visible.get(h.id)!.note;
    return { id: n.fm.id, title: n.fm.title, sensitivity: n.fm.sensitivity, type: n.fm.type };
  });
}

const CODE = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const code = () => [...randomBytes(4)].map((b) => CODE[b % CODE.length]).join("");

// Auth0 binding messages: 64 characters of letters, digits, spaces and + - _ . , : #
// The push names the agent by its id: a label alone could read as the owner or another
// assistant. A label that says more than the id goes beside it: "claude.ai (claude)".
function askerName(label: string | undefined, agent: string): string {
  const f = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return label && f(label) !== f(agent) ? `${label} (${agent})` : agent;
}

export function bindingMessage(agent: string, ask: { code: string; candidates: Ask["candidates"] }, withTitle: boolean): string {
  const clean = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^A-Za-z0-9 +\-_.,:#()]/g, "").replace(/\s+/g, " ").trim();
  const title = withTitle && ask.candidates[0] ? clean(ask.candidates[0].title) : "";
  const head = `${clean(agent)} wants to read`;
  const tail = `once. Code ${ask.code}`;
  // Without the title the owner still learns what kind of note a phone approval releases.
  const top = ask.candidates[0];
  const kind = top ? clean(`${top.sensitivity} ${top.type ?? ""}`) : "private";
  const msg = title ? `${head} ${title} ${tail}` : `${head} a ${kind} note ${tail}`;
  return msg.length <= 64 ? msg : `${head} a note ${tail}`.slice(0, 64);
}

export interface Approver {
  name: string;
  // Start the owner's approval. A ref comes back when something was sent (the CIBA auth_req_id).
  start(root: string, ask: Ask, message: string): Promise<{ ref?: string; error?: string }>;
  // Ask the AS how it went. Only called while the ask waits.
  poll(root: string, ask: Ask): Promise<{ state: "waiting" | "approved" | "declined" | "expired"; by?: string; error?: string }>;
}

// The owner clicks in the dashboard; nothing is sent anywhere.
export const dashboardApprover: Approver = {
  name: "dashboard",
  async start() { return {}; },
  async poll() { return { state: "waiting" }; },
};

type Fetch = typeof fetch;

// Auth0 Guardian through Client-Initiated Backchannel Authentication (OpenID CIBA core 1.0):
// POST /bc-authorize starts the push to the owner's phone; POST /oauth/token with the CIBA grant
// answers authorization_pending, slow_down, access_denied or expired_token until the owner acts.
// Tokens come straight from the token endpoint over TLS with the client's secret, so a success
// is the AS saying the owner approved; the id token's sub must still be the owner.
export function guardianApprover(rules: Rules, root: string, opts: { fetch?: Fetch; secret?: string } = {}): Approver {
  const g = askPolicy(rules)?.guardian;
  const door = loadOAuth(root);
  const domain = g?.domain ?? (door ? new URL(door.issuer).host : undefined);
  const user = g?.user_id ?? door?.owner_subject;
  const f = opts.fetch ?? fetch;
  const base = domain ? (/^https?:\/\//.test(domain) ? domain.replace(/\/+$/, "") : `https://${domain}`) : "";
  const missing = () => !g?.client_id ? "ask_to_see.guardian.client_id is not set" : !domain ? "no Auth0 domain (ask_to_see.guardian.domain or rules/oauth.yaml)" : !user ? "no owner user id (ask_to_see.guardian.user_id or rules/oauth.yaml owner_subject)" : !(opts.secret ?? process.env.AUTH0_CIBA_CLIENT_SECRET) ? "AUTH0_CIBA_CLIENT_SECRET is not set (put it in ~/.config/pocketbrain/keys/)" : undefined;
  const form = (o: Record<string, string>) => new URLSearchParams({ client_id: g!.client_id, client_secret: (opts.secret ?? process.env.AUTH0_CIBA_CLIENT_SECRET)!, ...o });
  const post = async (path: string, body: URLSearchParams) => {
    const r = await f(`${base}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    let j: Record<string, unknown> = {};
    try { j = await r.json() as Record<string, unknown>; } catch { /* not JSON */ }
    return { ok: r.ok, status: r.status, j };
  };
  return {
    name: "guardian",
    async start(_root, ask, message) {
      const why = missing();
      if (why) return { error: why };
      const secs = Math.max(30, Math.min(300, Math.round((Date.parse(ask.expires) - Date.now()) / 1000)));
      try {
        const r = await post("/bc-authorize", form({
          login_hint: JSON.stringify({ format: "iss_sub", iss: `${base}/`, sub: user! }),
          scope: g!.scope ?? "openid", binding_message: message, requested_expiry: String(secs),
          ...(g!.audience ? { audience: g!.audience } : {}),
        }));
        if (!r.ok || typeof r.j.auth_req_id !== "string") return { error: `Auth0 refused the push (${r.status} ${String(r.j.error ?? "")} ${String(r.j.error_description ?? "")})`.trim() };
        return { ref: r.j.auth_req_id };
      } catch (e) { return { error: `Auth0 unreachable: ${(e as Error).message}` }; }
    },
    async poll(_root, ask) {
      if (!ask.ref) return { state: "waiting" };
      const why = missing();
      if (why) return { state: "waiting", error: why };
      try {
        const r = await post("/oauth/token", form({ grant_type: "urn:openid:params:grant-type:ciba", auth_req_id: ask.ref }));
        if (r.ok) {
          const sub = subOf(r.j.id_token);
          if (sub !== user) return { state: "declined", error: `approved by ${sub ?? "someone unknown"}, not the owner` };
          return { state: "approved", by: sub };
        }
        const err = String(r.j.error ?? "");
        if (err === "authorization_pending" || err === "slow_down") return { state: "waiting" };
        if (err === "access_denied") return { state: "declined" };
        if (err === "expired_token") return { state: "expired" };
        return { state: "waiting", error: `${r.status} ${err}` };
      } catch (e) { return { state: "waiting", error: (e as Error).message }; }
    },
  };
}

// The id token's sub, read without checking the signature: it came from the token endpoint over
// TLS, in answer to this client's own secret (OpenID Connect core 3.1.3.7).
function subOf(idToken: unknown): string | undefined {
  if (typeof idToken !== "string") return undefined;
  try { return JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8")).sub; } catch { return undefined; }
}

export function approverFor(root: string, rules = loadRules(root), opts: { fetch?: Fetch; secret?: string } = {}): Approver {
  return askPolicy(rules)?.approver === "guardian" ? guardianApprover(rules, root, opts) : dashboardApprover;
}

function grantCheck(rules: Rules, agent: string) {
  const a = rules.policy.agents[agent];
  if (!a || a.inside_wall) throw new CoreError(403, `${agent} has no grant`);
  if (a.status === "paused") throw new CoreError(403, `${agent} is paused by ${ownerName(rules)}`);
  if (!asksOn(rules, agent)) throw new CoreError(403, `asking to see isn't turned on for ${agent}`);
}

export interface AskReply { request: string; status: "waiting" | "approved" | "not approved" | "used"; message: string; note?: string }

const WAITING = (id: string, O: string) => `Asked ${O}. Nothing is shared until ${O} approves. Check with ask_status and request ${id} in a minute; if ${O} approves, you get the note once.`;

// The agent's ask. Same reply whether or not anything matches.
export async function askToSee(root: string, agent: string, body: { what?: unknown; why?: unknown }, approver?: Approver): Promise<AskReply> {
  const rules = loadRules(root);
  grantCheck(rules, agent);
  const p = askPolicy(rules)!;
  const what = typeof body.what === "string" ? body.what.trim().slice(0, 200) : "";
  const why = typeof body.why === "string" ? body.why.trim().slice(0, 300) : "";
  if (!what) throw new CoreError(400, "what is required: a few words for what you need (e.g. \"the board feedback\")");
  if (!why) throw new CoreError(400, `why is required: one sentence ${ownerName(rules)} reads before deciding`);
  const mine = listAsks(root).filter((a) => a.agent === agent);
  if (mine.some((a) => a.state === "waiting")) throw new CoreError(429, "you already have an ask waiting; check it with ask_status");
  const day = iso(new Date(Date.now() - 86_400_000));
  if (mine.filter((a) => a.at >= day).length >= (p.max_per_day ?? 5)) throw new CoreError(429, `at most ${p.max_per_day ?? 5} asks in 24 hours`);

  const candidates = match(root, rules, p, agent, what);
  const id = `ask-${randomBytes(6).toString("hex")}`;
  const t = now();
  const ap = approver ?? approverFor(root, rules);
  const a: Ask = { id, agent, what, why, at: iso(t), expires: iso(new Date(t.getTime() + (p.expires_minutes ?? 5) * 60_000)), candidates, code: code(), approver: ap.name, state: "waiting" };
  event(root, { ask: id, ev: "asked", agent, what, why, expires: a.expires, candidates, code: a.code, approver: ap.name, boot });
  // Nothing to offer: nobody is bothered, and the ask simply runs out.
  if (candidates.length) {
    const r = await ap.start(root, a, bindingMessage(askerName(rules.policy.agents[agent]?.label, agent), a, !!p.push_title));
    if (r.ref) event(root, { ask: id, ev: "push", ref: r.ref });
    if (r.error) event(root, { ask: id, ev: "push_failed", error: r.error.slice(0, 300) });
  }
  return { request: id, status: "waiting", message: WAITING(id, ownerName(rules)) };
}

// Polls the AS for one waiting ask and records what changed.
async function refresh(root: string, a: Ask, ap: Approver): Promise<Ask> {
  if (a.state !== "waiting" || !a.ref || ap.name !== a.approver) return a;
  const r = await ap.poll(root, a);
  if (r.state === "approved" && a.candidates[0]) approveAsk(root, a.id, a.candidates[0].id, { via: "guardian", by: r.by ?? "owner", ref: a.ref });
  else if (r.state === "declined") declineAsk(root, a.id, "guardian");
  else if (r.state === "expired") event(root, { ask: a.id, ev: "expired" });
  return listAsks(root).find((x) => x.id === a.id) ?? a;
}

// Every waiting ask with a push out (the server's tick, and the dashboard on load).
export async function pollAsks(root: string, approver?: Approver): Promise<number> {
  const ap = approver ?? approverFor(root);
  if (ap.name === "dashboard") return 0;
  let n = 0;
  // A push an earlier run sent (or was sending) when it stopped: its ref is lost, so an approval on
  // the phone could never be seen. Send it again; the owner answers the new one.
  for (const a of listAsks(root).filter((x) => x.state === "waiting" && x.candidates.length && !x.ref && !x.push_error && x.boot !== boot && x.approver === ap.name)) {
    const r = await ap.start(root, a, bindingMessage(askerName(loadRules(root).policy.agents[a.agent]?.label, a.agent), a, !!askPolicy(loadRules(root))?.push_title));
    event(root, { ask: a.id, ev: "resent", why: "the hub restarted before the push was recorded" });
    if (r.ref) event(root, { ask: a.id, ev: "push", ref: r.ref });
    if (r.error) event(root, { ask: a.id, ev: "push_failed", error: r.error.slice(0, 300) });
  }
  for (const a of listAsks(root).filter((x) => x.state === "waiting" && x.ref)) {
    const after = await refresh(root, a, ap);
    if (after.state !== "waiting") n++;
  }
  return n;
}

// The agent checks its ask. An approved one is handed over here, once.
export async function askStatus(root: string, agent: string, id: string, approver?: Approver): Promise<AskReply> {
  const rules = loadRules(root);
  grantCheck(rules, agent);
  const O = ownerName(rules);
  let a = listAsks(root).find((x) => x.id === id && x.agent === agent);
  if (!a) throw new CoreError(404, `no ask ${id} of yours`);
  a = await refresh(root, a, approver ?? approverFor(root, rules));
  if (a.state === "waiting") return { request: id, status: "waiting", message: `Still waiting for ${O}. Check again in a minute; it runs out at ${a.expires}.` };
  if (a.state === "used") return { request: id, status: "used", message: "You already read it. One approval is one read; ask again if you need it again." };
  if (a.state !== "approved") return { request: id, status: "not approved", message: `${O} didn't approve this (or it ran out). Don't ask another assistant for it.` };
  return { request: id, status: "approved", message: `${O} approved one read. This is it: it won't be served again, so don't store it or pass it on.`, note: handOver(root, agent, a) };
}

// The one read: the approved note alone, rendered as a view holding only that note, so its links
// to anything else show as [[redacted]] and its secret or share_with-limited facts stay out.
function handOver(root: string, agent: string, a: Ask): string {
  const rules = loadRules(root);
  const noteId = a.approved!.note;
  const notes = loadBrain(root);
  const note = notes.find((n) => n.fm.id === noteId);
  // Changed under it (made secret, moved to a never type, deleted): the approval no longer holds.
  const p = askPolicy(rules) ?? {};
  const never = new Set(p.never ?? []);
  const co = coOwnerOf(rules, agent);
  if (!note || sensitivityRank(note.fm.sensitivity) > sensitivityRank("private") || never.has(folderOf(note)) || never.has(note.fm.type) || never.has(note.fm.area) || !coOwnerMay(co, note)) {
    event(root, { ask: a.id, ev: "expired", why: "the note changed since the approval" });
    throw new CoreError(410, `this approval no longer holds; ask ${ownerName(rules)} again`);
  }
  const one: Rules = { ...rules, slices: { ...rules.slices, [`ask:${a.id}`]: { include: [noteId] } } };
  const res = carve(notes, one, { agent, slices: [`ask:${a.id}`], exclude_types: [], exclude: [], ceiling: note.fm.sensitivity === "private" && !co ? "private" : "personal" });
  const v = res.visible.get(noteId)!;
  const md = renderNote(v, res, one).join("\n") + "\n";
  event(root, { ask: a.id, ev: "used", agent, note: noteId });
  appendChained(join(root, "log", "reads.jsonl"), { at: iso(now()), agent, op: "ask_read", ids: [noteId], grant: a.id, approved_via: a.approved!.via, ...(a.approved!.ref ? { approval_ref: a.approved!.ref } : {}) });
  return md;
}

// The owner's decision, from the dashboard or relayed from Guardian by refresh().
export function approveAsk(root: string, id: string, noteId: string, how: { via: string; by?: string; ref?: string } = { via: "dashboard" }): string {
  const a = listAsks(root).find((x) => x.id === id);
  if (!a) throw new CoreError(404, `no ask ${id}`);
  if (a.state !== "waiting") throw new CoreError(409, `${id} is ${a.state}`);
  if (!a.candidates.some((c) => c.id === noteId)) throw new CoreError(400, `${noteId} isn't one of the matches for ${id}`);
  const p = askPolicy(loadRules(root)) ?? {};
  const use_by = iso(new Date(Date.now() + (p.use_within_minutes ?? 15) * 60_000));
  event(root, { ask: id, ev: "approved", note: noteId, by: how.by ?? "owner", via: how.via, use_by, ...(how.ref ? { ref: how.ref } : {}) });
  return `${a.agent} may read ${a.candidates.find((c) => c.id === noteId)!.title} once`;
}

export function declineAsk(root: string, id: string, via = "dashboard"): string {
  const a = listAsks(root).find((x) => x.id === id);
  if (!a) throw new CoreError(404, `no ask ${id}`);
  if (a.state !== "waiting") throw new CoreError(409, `${id} is ${a.state}`);
  event(root, { ask: id, ev: "declined", via });
  return `declined; ${a.agent} gets nothing`;
}

// `pocketbrain ask test`: one push to the owner's phone, waiting up to two minutes for the answer,
// so the Auth0 side can be checked before an agent ever asks. Nothing is released either way.
export async function testPush(root: string, opts: { fetch?: Fetch; secret?: string; every?: number; within?: number } = {}): Promise<string> {
  const rules = loadRules(root);
  const ap = guardianApprover(rules, root, opts);
  const t = Date.now();
  const a: Ask = { id: "ask-test", agent: "test", what: "", why: "", at: iso(new Date(t)), expires: iso(new Date(t + (opts.within ?? 120_000))), candidates: [], code: code(), approver: "guardian", state: "waiting" };
  const s = await ap.start(root, a, `pocketBrain test. Code ${a.code}`);
  if (s.error) return `not sent: ${s.error}`;
  a.ref = s.ref;
  console.log(`Sent. Your phone should show "pocketBrain test. Code ${a.code}". Approve or deny it.`);
  while (Date.now() < Date.parse(a.expires)) {
    await Bun.sleep(opts.every ?? 5000);
    const r = await ap.poll(root, a);
    if (r.error) return `Auth0 answered with an error: ${r.error}`;
    if (r.state === "approved") return `approved by ${r.by}: the phone path works`;
    if (r.state === "declined") return "denied on the phone: the phone path works (you said no)";
    if (r.state === "expired") return "Auth0 says it ran out before an answer";
  }
  return "no answer within two minutes";
}

// Revoke (dashboard and CLI): the agent's waiting asks are declined and an approval it hasn't
// used yet runs out, so a cut-off agent can't come back for a read it was promised.
export function cancelAsks(root: string, agent: string): number {
  let n = 0;
  for (const a of listAsks(root).filter((x) => x.agent === agent)) {
    if (a.state === "waiting") { event(root, { ask: a.id, ev: "declined", via: "revoke" }); n++; }
    else if (a.state === "approved") { event(root, { ask: a.id, ev: "expired", why: "access revoked" }); n++; }
  }
  return n;
}
