// SPDX-License-Identifier: AGPL-3.0-only
// The owner dashboard: Louis's control panel (architecture 0). It is a separate listener from
// the agents' server and binds to loopback only, so the tunnel that exposes /mcp and /v1
// never reaches it. The owner can also opt in to their own tailnet (src/dashboard/tailnet.ts). Auth is a local owner session: a login link printed once at start-up
// sets an HttpOnly cookie; every action also needs the session's CSRF token, and requests
// for any other Host are refused (DNS rebinding).
import { markSeen, keepPrivate } from "../seen";
import { displayName } from "../diary";
import { plain } from "./home";
import { pageParam } from "./paging";
import { keepLoginLinks, loginWords } from "./login-link";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { withFileLock } from "../filelock";
import { readCapped } from "../util";
import { sessionFile, addAppPhone, useAppPhone, phoneName, endSignIns } from "./phone-app";
import { join } from "node:path";
import { loadRules } from "../rules";
import { loadBrain } from "../brain";
import { carve, grantFor, records } from "../carve";
import { renderView } from "../view";
import { CoreError, ownerWhy, ownerDecide, ownerKeepBoth, ownerConflict, ownerConflicts } from "../core";
import { settlePage, heldMailPage } from "./html-settle";
import { ownerError, ownerErrorHtml, ownerStatus, type OwnerErrorId, type Vars } from "../owner-errors";
import { decideHeld, fileTransport, type MailTransport } from "../relay";
import { loadState, latestDigest, keptFor, comms } from "./data";
import { layout, overview, agentsPage, agentPage, activityPage, upkeepPage, digestPage, esc, button, type Page } from "./html";
import { runAction } from "./actions";
import { proposeEdit, defaultModelFor, type ModelFor, type EditProposal } from "./edit-chat";
import { editableNote, noteText, saveNoteText, editorCommits } from "./edit";
import { brainPage, brainResults, notePage, whyPage, proposalPage, editorCard, oauthCard, newAgentPage } from "./html-brain";
import { previewNewAgent } from "../addagent";
import { cap, agentLabel, agentTitle, refusalWords } from "./labels";
import { audience, kindCounts, kindLabel, folderOf, browsable, searchNotes, byTitle } from "./browse";

const names = (xs: string[]) => xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
import { noteSaves, noteVersions, versionAt, revertedHashes, savesSince, brainAt } from "./history";
import { noteHistoryPage, snapshotPage, weekPage, brainOnPage } from "./html-history";
import { git } from "../git";
import { recordOwnerTime } from "../measure";
import { usagePage } from "./usage";
import { peoplePage } from "./people";
import { homeView, pageLines, dayWords, firstName, attrWords, factSentence, pageSentences, type HeldValue, settleLeft, settleCard, settleNext, changedPages, learnedThisWeek, backedUpWords, privateNow } from "./home";
import type { Note } from "../brain";
import { ownerPage, askProse, askFact, sideWords } from "./html-page";
import { signInAgain } from "./html-home";
import { homePage, askPage, memoryPage, whoPage, letPage, rankAreas, APP_COPY, FONT_PATH } from "./html-app";
import { parentOf as wikiParent } from "../wiki";
import { findOverlaps, assistantOf } from "../overlap";
const FONT_FILE = new URL("./fonts/schibsted-grotesk-latin.woff2", import.meta.url).pathname;
import { withMarks, marksFor, markAgents, shorts, colours } from "./marks";
import { lastBackup } from "../backup";
import { drillWords, lastRestoreDrill } from "../restore-drill";
import { readDiary, shownValue } from "../diary";
import { inboxConflict, inboxConflicts, settleInbox } from "../settle-inbox";
import { ownerSay, ownerSayModel, boxModel, type SayReply } from "../owner-say";
import { undoFact } from "../undo";
import { fixEverywhere } from "../beliefs";
import { withRadar } from "./home-beliefs";
import { mapPage, mapGrid } from "./html-map";
import { fgaPage, fgaGrid } from "./html-fga";
import { loadOAuth, listPending, cleanupReplaced } from "../oauth";
import { loadKeys } from "../secrets";
import { askPolicy, pollAsks, offerOnce, openOffers, mayOffer } from "../asks";
import * as consent from "../consent";
import { consentPage, type ConsentProposal } from "./html-consent";
import { isTailnetIp, tailnetSelf, SERVE_PORT } from "./tailnet";
import { loadEscalation } from "../textline/policy";
import { makeTransport } from "../textline/transport";

// Requests pages make by themselves (polls, search as you type), not the owner opening a page.
const BACKGROUND = /^\/(map\/grid|fga\/grid|brain\/results)$/;

// tailnet: also listen on this machine's Tailscale address (src/dashboard/tailnet.ts). `true`
// asks Tailscale for the address and name; tests and odd setups pass them. tailnetLogin: the
// owner's Tailscale login, the only identity the `tailscale serve` path lets in.
// devices: the tailnet addresses (100.x) of the owner's own devices that may open it; none, none do.
type Tailnet = { address?: string; name?: string; login?: string; devices?: string[] };
export interface DashboardOptions { port?: number; hostname?: string; loginKey?: string; transport?: () => MailTransport; modelFor?: ModelFor; tailnet?: boolean | Tailnet; tailnetLogin?: string; tailnetDevices?: string[]; now?: () => Date }

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
// Compared as bytes: two strings of the same length can differ in bytes (non-ASCII), and
// timingSafeEqual throws on buffers of different sizes.
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const rand = () => randomBytes(24).toString("base64url");

// Sign-ins outlive a hub restart: kept in .git/ (never committed, never in a view or backup's
// notes), owner-only, by the hash of the cookie so the file alone signs nobody in. A sign-in
// lasts 30 days; the newest 20 are kept. The login link still changes at every start.
const SESSION_DAYS = 30;
// at: when the owner last proved it was them (a link, or Face ID in the app), for FRESH_MINUTES;
// since: when this sign-in began, for its 30 days. Face ID never moves since (audit v11, G642).
type Kept = Record<string, { csrf: string; at: string; since?: string }>;
const sidHash = (sid: string) => createHash("sha256").update(sid).digest("hex");
function keptSessions(root: string, now: Date): Kept {
  try {
    const all = JSON.parse(readFileSync(sessionFile(root), "utf8")) as Kept;
    return Object.fromEntries(Object.entries(all).filter(([, v]) => typeof v?.csrf === "string" && now.getTime() - Date.parse(v.since ?? v.at) < SESSION_DAYS * 86_400_000));
  } catch { return {}; }
}
// A sign-in from the last few minutes (phone UI spec §8, the login re-prompt where there is no
// WebAuthn): a forget from the box, a private or held value on a page, and Show ask for one.
export const FRESH_MINUTES = 10;
// Wrong device keys the phone app's fresh door takes in an hour before it waits (docs/phone-app.md).
const APP_MISSES = 10;
// The app's own requests to its fresh door carry this header and no Origin (audit v11, G642): a
// web page, this hub's own included, can't send it without a preflight the hub never answers.
export const APP_HEADER = "x-pocketbrain-app";
// A fresh-door nonce lasts this long and is spent by one try.
const NONCE_MS = 120_000;
// The rule for every button (re-audit 2026-10-30, G525: Let it through sent a held message on the
// 30-day sign-in, and /action/mail-release did the same from any old form). Only what the three owner
// screens (/home, /p, /settle) offer, and only what keeps a thing back or puts one right, runs on the
// 30-day sign-in; every other action, and anything that lets a held thing out, needs a sign-in from
// the last FRESH_MINUTES. Checked once, before any action runs.
// A pick or typed answer on a conflict whose sides the settle screen hides past a fresh sign-in
// (a private one) needs a fresh sign-in too (audit v7, G553: an old form picked a hidden side).
const hiddenSides = (root: string | undefined, id: string | undefined) => !!root && !!id && !!(id.startsWith("p-") ? inboxConflict(root, id) : ownerConflict(root, id))?.private;
export const STALE_OK: Record<string, (form: Record<string, string>, root?: string) => boolean> = {
  "sign-in-again": () => true,
  "settle-mail": (form) => form.n === "drop",
  "settle-pick": (form, root) => !hiddenSides(root, form.id),
  "settle-both": () => true,
  "diary-undo": () => true,
  "fix-everywhere": () => true,
  "note-hide": () => true,
  "diary-keep": () => true,
  // The Gardener's line on an org (src/describe.ts): only ever on a page below private, and Undo
  // takes each answer back, like settling a conflict that isn't private.
  "org-yes": () => true,
  "org-no": () => true,
  "org-again": () => true,
  "org-undo": () => true,
};
// Who a value goes to after Show, said as carve will serve it (audit v11, G645): another person's
// private matter goes to the resolver alone, or to no assistant, never "your assistants".
export function whoGetsIt(only: (string[] | undefined)[]): string {
  const it = only.length === 1 ? "it" : "them";
  if (only.every((o) => o === undefined)) return `Your assistants get ${it} now.`;
  const names = [...new Set(only.flatMap((o) => o ?? []))];
  const why = only.length === 1 ? "it's another person's private matter" : "some are another person's private matter";
  if (only.some((o) => o === undefined)) return `Your assistants get ${it} now, except where ${why}: ${names.length ? `only ${names.join(" and ")} gets those` : "no assistant gets those"}.`;
  if (only.every((o) => o!.length === 0)) return `No assistant gets ${it}: ${why}.`;
  return `Only ${names.join(" and ")} gets ${it}: ${why}.`;
}
export const needsFresh = (action: string, form: Record<string, string>, root?: string): boolean => !STALE_OK[action]?.(form, root);
// A folder with no .git keeps no sign-in file, so its sign-in times live in this run only.
const signedInHere = new Map<string, string>();
function freshSignIn(root: string, sid: string, now: Date): boolean {
  const at = keptSessions(root, now)[sidHash(sid)]?.at ?? signedInHere.get(sidHash(sid));
  return !!at && now.getTime() - Date.parse(at) < FRESH_MINUTES * 60_000;
}
function dropSession(root: string, sid: string, now: Date) {
  const all = keptSessions(root, now);
  delete all[sidHash(sid)];
  try { writeFileSync(sessionFile(root), JSON.stringify(all), { mode: 0o600 }); } catch { /* the cookie is gone from this run anyway */ }
}
function keepSession(root: string, sid: string, csrf: string, now: Date) {
  if (!existsSync(join(root, ".git"))) { signedInHere.set(sidHash(sid), now.toISOString()); return; }
  const t = now.toISOString(), all = Object.entries({ ...keptSessions(root, now), [sidHash(sid)]: { csrf, at: t, since: t } }).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, 20);
  try { writeFileSync(sessionFile(root), JSON.stringify(Object.fromEntries(all)), { mode: 0o600 }); chmodSync(sessionFile(root), 0o600); }
  catch (e) { console.error(`dashboard: couldn't keep the sign-in across restarts: ${(e as Error).message}`); }
}
// Face ID in the phone app: the sign-in is fresh again for FRESH_MINUTES, and still ends 30 days
// after it began (audit v11, G642: the app's door reset the 30-day clock at every use).
// The app's doors, one line per call in .git/ (owner only, never served): when, which door, the
// status, whether a cookie came, and for a refusal the hub's own one-line reason. Never a key, a
// nonce or a cookie: an answer with a 200 is never read, since it carries the nonce or the phone key.
// The last APP_DOOR_KEEP lines are kept. `pocketbrain dashboard phones log` prints them (G651).
export const appDoorFile = (root: string) => join(root, ".git", "pb-app-door.jsonl");
const APP_DOOR_KEEP = 500;
// The app's doors, by path. A call refused before it reaches them (the tailnet or serve gate, a Host
// the hub doesn't know) leaves a line too, its reason the refusal's error id, never the device,
// the login or the Host it came with.
const APP_DOORS = new Set(["/app/pair", "/app/nonce", "/app/fresh"]);
function refusedAppDoor(root: string, req: Request, res: Response, id: string, now: Date): Promise<Response> {
  const path = new URL(req.url).pathname;
  return req.method === "POST" && APP_DOORS.has(path) ? appDoorLog(root, path, req, res, now, id) : Promise.resolve(res);
}

async function appDoorLog(root: string, door: string, req: Request, res: Response, now: Date, refused?: string): Promise<Response> {
  try {
    if (!existsSync(join(root, ".git"))) return res;
    const why = refused ?? (res.status === 200 ? undefined : (await res.clone().text()).split("\n")[0]!.slice(0, 160));
    const line = JSON.stringify({ at: now.toISOString(), door, status: res.status, cookie: /(?:^|;\s*)pb_owner=/.test(req.headers.get("cookie") ?? ""), ...(why ? { why } : {}) });
    const f = appDoorFile(root);
    const old = existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
    writeFileSync(f, [...old.slice(-(APP_DOOR_KEEP - 1)), line].join("\n") + "\n", { mode: 0o600 });
  } catch (e) { console.error(`dashboard: couldn't log the app's door: ${(e as Error).message}`); }
  return res;
}

function markFresh(root: string, sid: string, now: Date) {
  const all = keptSessions(root, now), k = all[sidHash(sid)];
  if (!k) return;
  all[sidHash(sid)] = { csrf: k.csrf, at: now.toISOString(), since: k.since ?? k.at };
  try { writeFileSync(sessionFile(root), JSON.stringify(all), { mode: 0o600 }); chmodSync(sessionFile(root), 0o600); }
  catch (e) { console.error(`dashboard: couldn't keep the fresh sign-in: ${(e as Error).message}`); }
}

// Phone links (owner, 2026-10-24: yesterday's link was dead after a hub restart, and the signed-out
// page offered only a Mac command). One-time, a day long, kept in .git/ by hash so they outlive a
// restart and the file alone signs nobody in; they open only on the tailnet listener, never loopback.
const PHONE_LINK_HOURS = 24;
const phoneFile = (root: string) => join(root, ".git", "pb-phone-links.json");
function phoneLinks(root: string, now: Date): Record<string, string> {
  try {
    const all = JSON.parse(readFileSync(phoneFile(root), "utf8")) as Record<string, string>;
    return Object.fromEntries(Object.entries(all).filter(([, at]) => typeof at === "string" && now.getTime() - Date.parse(at) < PHONE_LINK_HOURS * 3_600_000));
  } catch { return {}; }
}
// Written whole and renamed into place, under a lock the CLI and the hub share, so a link used in
// one process is never written back by the other (slice audit, G379).
function savePhoneLinks(root: string, links: Record<string, string>) {
  const tmp = `${phoneFile(root)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(links), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, phoneFile(root));
}
export function mintPhoneLink(root: string, now = new Date()): string {
  if (!existsSync(join(root, ".git"))) throw new Error("phone links need the brain's git folder");
  const token = rand();
  const done = withFileLock(root, "phone-links", () => {
    const kept = Object.entries({ ...phoneLinks(root, new Date()), [sidHash(token)]: now.toISOString() }).sort((a, b) => b[1].localeCompare(a[1])).slice(0, 5);
    savePhoneLinks(root, Object.fromEntries(kept));
    return true;
  });
  if (!done) throw new Error("another sign-in link is being made or used right now; try again");
  return token;
}
function usePhoneLink(root: string, token: string, now: Date): boolean {
  if (!token) return false;
  return withFileLock(root, "phone-links", () => {
    const links = phoneLinks(root, now), h = sidHash(token);
    if (!links[h]) return false;
    delete links[h];
    savePhoneLinks(root, links);
    return true;
  }) ?? false;
}

// What an error says to the owner (audit v5): a refusal keeps its own words, never a file path;
// anything else from inside the code is one plain sentence, the details in the hub's log.
const PATHS = /(?:[A-Za-z]:)?(?:\/[\w.@~-]+){2,}\/?/g;
export function ownerFacingError(e: unknown): string {
  if (e instanceof CoreError) return e.message.replace(PATHS, "a file");
  return ownerError("dash.internal");
}

// Messages after a button, per sign-in, by a random id (audit v5: Show put a held value in the
// address). The URL carries only the id; a few minutes is plenty for a redirect.
const flashes = new Map<string, { sid: string; msg: string; at: number }>();
function keepFlash(sid: string, msg: string) {
  const now = Date.now(); for (const [k, f] of flashes) if (now - f.at > 15 * 60_000 || flashes.size > 500) flashes.delete(k);
  const id = rand().slice(0, 16); flashes.set(id, { sid, msg, at: now }); return `@${id}`;
}
const takeFlash = (sid: string, id: string) => { const f = flashes.get(id); return f && f.sid === sid ? f.msg : undefined; };
/** The words a redirect's ?ok= or ?err= stands for, for tests that read them off the Location. */
export function flashOf(loc: string): { ok: string; err: string } {
  const one = (k: string) => { const v = decodeURIComponent(loc.match(new RegExp(`[?&]${k}=([^&#]*)`))?.[1] ?? ""); return v.startsWith("@") ? flashes.get(v.slice(1))?.msg ?? "" : v; };
  return { ok: one("ok"), err: one("err") };
}

// How many of Ask's turns a sign-in keeps (owner app step 4).
export const ASK_TURNS = 20;
// A follow-up on Ask carries the last answer's page while the conversation is warm: 30 minutes.
export const ASK_FOLLOW_MS = 30 * 60_000;
// privateThen: what of the turn's page or fact was already private or held when it was answered (G637).
interface AskTurn { said: string; reply: SayReply; fresh: boolean; at: number; privateThen?: string[] }

export function dashboardHandler(root: string, opts: DashboardOptions & { port: number }) {
  const loginKey = opts.loginKey ?? rand();
  const now = opts.now ?? (() => new Date());
  const sessions = new Map<string, string>(); // session id -> csrf token, this run's sign-ins
  const proposals = new Map<string, EditProposal>(); // model-proposed edits waiting for Louis
  const consents = new Map<string, ConsentProposal>(); // proposed slices from a sentence (src/consent.ts)
  const modelFor = opts.modelFor ?? defaultModelFor(root);
  const allowedHosts = new Set<string>();
  const tailnetHosts = new Set<string>();
  // Called again with the real port after binding, so port 0 (pick a free one) works too.
  // Tailnet names are allowed only on the tailnet listener (handleTailnet), never on loopback,
  // except the MagicDNS name as `tailscale serve` sends it (https on 443, proxied to loopback):
  // that one only on its own https port and only with the owner's Tailscale login (serveHosts, below).
  let tn: Tailnet | undefined;
  const serveHosts = new Set<string>();
  const setPort = (port: number) => {
    allowedHosts.clear(); tailnetHosts.clear(); serveHosts.clear();
    for (const h of LOOPBACK) allowedHosts.add(`${h}:${port}`);
    if (tn) for (const h of [tn.address, tn.name]) if (h) tailnetHosts.add(`${h}:${port}`);
    if (tn?.name && tn.login) serveHosts.add(`${tn.name}:${SERVE_PORT}`);
  };
  const setTailnet = (t: Tailnet, port: number) => { tn = t; setPort(port); };
  setPort(opts.port);

  const PAGE_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; form-action 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" };
  const html = (p: Page, status = 200, extra: Record<string, string> = {}) =>
    new Response(layout({ root }, p), { status, headers: { ...PAGE_HEADERS, ...extra } });
  // The owner app's four tabs (html-app.ts): On your mind is the home, with a mark per assistant
  // under each memory (marks.ts); Who knows has the assistants' rows; Memory and Ask stand alone.
  const clock = () => process.env.PB_NOW ? new Date(process.env.PB_NOW) : new Date();
  // fresh: a sign-in from the last FRESH_MINUTES, the only one a held value shows on (G630).
  const home = (csrf: string, said?: string, reply?: ReturnType<typeof ownerSay>, flash?: string, all = false, done = false, fresh = false, tok?: string) => {
    const rules = loadRules(root), notes = loadBrain(root, { shared: true });
    const v = homeView(root, rules, notes, clock(), { all, fresh });
    const of = marksFor(rules, notes);
    v.since = withMarks(v.since, rules, notes, of);
    v.earlier = v.earlier.map((d) => ({ ...d, lines: withMarks(d.lines, rules, notes, of) }));
    return new Response(homePage(v, csrf, { said, reply, flash, done, ...(tok ? { undo: tok } : {}) }), { headers: PAGE_HEADERS });
  };
  const who = (csrf: string, fresh: boolean, flash?: string) => {
    const rules = loadRules(root), notes = loadBrain(root, { shared: true });
    const v = homeView(root, rules, notes, clock(), { fresh });
    v.reads = withRadar(root, rules, notes, v.reads, fresh);
    const pages = notes.filter((n) => folderOf(n.fm.id) !== "disputes" && n.fm.sensitivity !== "secret");
    const agents = markAgents(rules), short = shorts(agents.map((a) => a.name)), colour = colours(agents.map((a) => a.name));
    return new Response(whoPage(v, csrf, {
      flash,
      memory: { pages: pages.length, people: pages.filter((n) => folderOf(n.fm.id) === "people").length, learned: learnedThisWeek(root, clock()), backup: backedUpWords(lastBackup(root)?.at, clock()), drill: drillWords(lastRestoreDrill(root)) },
      trial: Object.entries(rules.policy.agents).filter(([, a]) => a.tier === "trial").map(([k]) => k),
      shorts: Object.fromEntries(agents.map((a, i) => [a.agent, short[i]!])),
      colours: Object.fromEntries(agents.map((a, i) => [a.agent, colour[i]!])),
    }), { headers: PAGE_HEADERS });
  };
  // What of an answer's page or fact is private or held now (G551; a page-wide answer counts every
  // fact, G582 re-audit: a page with no prose answers with up to three): "" for the page, else attrs.
  const privateParts = (byId: Map<string, Note>, t: Pick<AskTurn, "reply">): string[] => {
    // A reply naming several people by their relationship (say.answer-many, G649): each page, and
    // its relationship fact, checked as it is now; a page gone since (forgotten) counts as changed.
    if (t.reply.pages) return t.reply.pages.flatMap((id) => { const n = byId.get(id), f = n?.fm.facts?.relationship; return [...(!n || privateNow(n, "") ? [`${id}#`] : []), ...(f && (privateNow(n, "relationship") || records(f).some((r) => !!r.unseen && !r.valid_to)) ? [`${id}#relationship`] : [])]; });
    const key = t.reply.fact_key, page = t.reply.page ?? key?.slice(0, key.lastIndexOf("#"));
    if (!page) return [];
    const n = byId.get(page);
    // One fact (G706): private now, or a value held unseen since, as for a whole page below.
    if (key) { const a = key.slice(key.lastIndexOf("#") + 1), f = n?.fm.facts?.[a]; return privateNow(n, a) || (f && records(f).some((r) => !!r.unseen && !r.valid_to)) ? [a] : []; }
    return [...(privateNow(n, "") ? [""] : []), ...Object.keys(n?.fm.facts ?? {}).filter((a) => privateNow(n, a) || records(n!.fm.facts![a]!).some((r) => !!r.unseen && !r.valid_to))];
  };
  // A read answer built for an older sign-in: owner-say.ts answers a private page or fact with
  // "sign in again" and scrubs the page's prose for it (answer, about). A write's reply says back
  // values, so it never counts.
  const readFor = (r: SayReply) => !r.undo_token && (!!r.signin || r.kind === "say.lookup" || r.kind.startsWith("say.answer"));
  // A turn made right after a sign-in may hold a private value: on an older sign-in it isn't shown
  // again. A read answer made on an older sign-in shows, unless something on its page or fact became
  // private or held only after it was answered. A hidden turn says so in its place, with the tap to
  // sign in again (G637).
  const ask = (csrf: string, sid: string, flash?: string) => {
    const rules = loadRules(root), fresh = freshSignIn(root, sid, now());
    const day = now().getTime() - 86_400_000;
    const all = (chats.get(sid) ?? []).filter((t) => t.at >= day);
    const notes = loadBrain(root, { shared: true }), byId = new Map(notes.map((n) => [n.fm.id, n]));
    const visible = (t: AskTurn) => {
      if (fresh) return true;
      if (t.fresh) return false;
      const parts = privateParts(byId, t);
      return !parts.length || (readFor(t.reply) && parts.every((x) => t.privateThen?.includes(x)));
    };
    const titles = new Map(notes.map((n) => [n.fm.id, displayName(n.fm.id, n.fm.title)]));
    // An answer about a page shows that page's prose as the page is now (askProse in html-page.ts).
    let st: ReturnType<typeof loadState> | undefined;
    const prose = (t: AskTurn) => {
      // One fact (G706): the sentence with its page and its source; a page: its prose.
      const key = t.reply.kind === "say.answer" && t.reply.fact_key?.split("#") || undefined;
      const fact = key && byId.get(key[0]!);
      if (fact) { const p = askFact(st ??= loadState(root, now()), fact, key[1]!, t.reply.text, fresh); return p ? { prose: p } : {}; }
      const n = t.reply.kind === "say.lookup" && t.reply.page ? byId.get(t.reply.page) : undefined; const p = n ? askProse(st ??= loadState(root, now()), n, fresh) : undefined; return p ? { prose: p } : {};
    };
    const turns = all.map((t) => visible(t) ? { ...t, ...(t.reply.page && titles.has(t.reply.page) ? { title: titles.get(t.reply.page) } : {}), ...prose(t) } : { hidden: true as const });
    return new Response(askPage({ date: dayWords(clock()), name: firstName(rules) }, csrf, { turns, flash }), { headers: PAGE_HEADERS });
  };
  // The sheet a dashed mark opens: only for one of the owner's assistants that doesn't get the fact.
  // The area is offered only when sharing it would let that assistant get the fact.
  const letSheet = (csrf: string, q: URLSearchParams) => {
    const key = q.get("key") ?? "", agent = q.get("agent") ?? "";
    const hash = key.lastIndexOf("#");
    const rules = loadRules(root), notes = loadBrain(root, { shared: true });
    const id = key.slice(0, hash), attr = key.slice(hash + 1);
    const note = hash > 0 ? notes.find((n) => n.fm.id === id) : undefined;
    const a = markAgents(rules).find((x) => x.agent === agent);
    const mark = a && note?.fm.facts?.[attr] ? marksFor(rules, notes)(key).find((m) => m.agent === agent) : undefined;
    if (!a || !note || !mark || mark.holds) return undefined;
    const line = pageLines(root, rules, notes, id).find((l) => l.key === key && l.undo !== "undone");
    const area = note.fm.area ? String(note.fm.area) : undefined;
    const grant = grantFor(rules, agent);
    const widened = area && !grant.slices.includes(`area:${area}`) ? carve(notes, rules, grantFor(rules, agent, [...grant.slices, `area:${area}`]), { flags: false }) : undefined;
    const opens = !!widened && !!widened.visible.get(id) && !widened.hiddenFacts.some((h) => h.key === key);
    return new Response(letPage({ agent, name: a.name, short: mark.short, id, key, offered: openOffers(root, agent).some((o) => o.approved?.note === id), once: mayOffer(rules, agent, note), what: line?.what ?? `${displayName(id, note.fm.title)}: ${attrWords(attr)}`, ...(opens ? { area, areaPages: notes.filter((n) => n.fm.area === area).length } : {}) }, csrf), { headers: PAGE_HEADERS });
  };
  // Memory: titles only, and a secret page's title only right after a sign-in. Its search reads
  // values only right after a sign-in too: on the 30-day one it matches titles and aliases alone,
  // so the pages that come back can't confirm a guessed private or held value (slice audit,
  // 2026-10-30, G542).
  const memory = (q: URLSearchParams, fresh: boolean) => {
    const s = loadState(root, clock());
    const shown = (n: Note) => fresh || n.fm.sensitivity !== "secret";
    const page = (n: Note) => ({ id: n.fm.id, title: displayName(n.fm.id, n.fm.title), ...(n.fm.area ? { area: String(n.fm.area) } : {}), ...(wikiParent(n) ? { parent: wikiParent(n) } : {}), ...(assistantOf(n.fm.id) ? { assistant: agentTitle(s.rules, assistantOf(n.fm.id)) } : {}) });
    const kind = q.get("kind") ?? undefined, query = (q.get("q") ?? "").trim().slice(0, 200);
    const all = browsable(s).filter(shown);
    return new Response(memoryPage({
      pages: all.length, people: all.filter((n) => folderOf(n.fm.id) === "people").length,
      name: firstName(s.rules), kinds: kindCounts(s), areas: rankAreas(all.map((n) => (n.fm.area ? { area: String(n.fm.area) } : {}))), week: changedPages(root, s.rules, s.notes, s.now, shown),
      ...(q.get("changes") === "week" && !query && !kind ? { allWeek: true } : {}),
      ...(query ? { q: query, found: (fresh ? searchNotes(s, query, 20).map((h) => h.note) : byTitle(browsable(s), query)).filter(shown).map(page) } : {}),
      ...(kind === "agents" && !query ? { overlaps: findOverlaps(all) } : {}),
      ...(kind && !query ? { kind: { label: kindLabel(kind), pages: browsable(s).filter((n) => folderOf(n.fm.id) === kind && shown(n)).sort((a, b) => String(a.fm.title).localeCompare(String(b.fm.title))).map(page), folder: kind } } : {}),
    }), { headers: PAGE_HEADERS });
  };

  // A page as the owner reads it (phone UI spec §2.2).
  const pageScreen = (csrf: string, id: string, o: { said?: string; reply?: ReturnType<typeof ownerSay>; flash?: string; undo?: string; fresh?: boolean } = {}) => {
    const s = loadState(root);
    const n = s.notes.find((x) => x.fm.id === id);
    if (!n) return undefined;
    return new Response(ownerPage(s, csrf, n, pageLines(root, s.rules, s.notes, id), o), { headers: PAGE_HEADERS });
  };
  const text = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  // Owner-facing errors are pages in the owner app's look, before sign-in too (G621: they were bare
  // text); a fetch reads only the status. The words and the fix come from src/owner-errors.ts,
  // never typed here.
  const page = (id: OwnerErrorId, tab: string, vars: Vars = {}, status = ownerStatus(id)) =>
    html({ title: status === 404 ? "Not found" : status >= 500 ? "Something broke" : "Can't do that", tab, body: `<div class="oops">${ownerErrorHtml(id, vars, esc)}</div>` }, status);
  // The phone app reads its routes' errors as text (/app/pair, /app/fresh): unchanged by G621.
  const oopsText = (id: OwnerErrorId, vars: Vars = {}) => text(ownerError(id, vars), ownerStatus(id));
  const oops = (id: OwnerErrorId, vars: Vars = {}) => {
    const status = ownerStatus(id);
    return html({ title: status === 404 ? "Not found" : status >= 500 ? "Something broke" : "Can't do that", tab: "", bare: true, body: `<div class="oops">${ownerErrorHtml(id, vars, esc)}</div>` }, status);
  };

  // On the tailnet's plain http address Safari says "Not Secure" (the owner's phone, G621): say why,
  // and name the https address `tailscale serve` gives when the owner's Tailscale login is set.
  const plainHttpNote = (secure: boolean) => !secure && tn?.name && tn.login
    ? `<p class="sub">Safari says Not Secure because this address is plain http. Your tailnet still encrypts it end to end. The https address is <a href="https://${esc(tn.name)}:${SERVE_PORT}/">https://${esc(tn.name)}:${SERVE_PORT}</a>.</p>` : "";
  // Signed out on the phone: one button texts a fresh link to the owner's own phone.
  const signedOutPhone = (secure: boolean) => html({ title: "Sign in", tab: "", bare: true, body: `<h1>Sign in on this phone</h1><p>You're not signed in here. A sign-in lasts 30 days on this browser.</p><form method="post" action="/send-link"><button class="go">Text me a sign-in link</button></form><p class="sub">The link goes to your own phone by text, works once, and lasts a day.</p>${plainHttpNote(secure)}` }, 401);
  // A phone link that's spent or old: plain words and the same button, never a Mac command.
  const usedLink = () => html({ title: "Sign in", tab: "", bare: true, body: `${ownerErrorHtml("dash.phone-link-used", {}, esc)}<form method="post" action="/send-link"><button class="go">Text me a sign-in link</button></form>` }, ownerStatus("dash.phone-link-used"));
  const sends: number[] = [];
  async function sendLink(req: Request, hosts: Set<string>, secure: boolean): Promise<Response> {
    const origin = req.headers.get("origin");
    if (!origin || !hosts.has(origin.replace(/^https?:\/\//, ""))) return oops("dash.cross-origin");
    const t0 = now().getTime();
    while (sends.length && t0 - sends[0] > 3_600_000) sends.shift();
    if (sends.length >= 3) return oops("dash.link-cap");
    // Counted before the send, failed or not, so parallel requests or retries can't pass the cap (G378).
    sends.push(t0);
    const cfg = loadEscalation(root).transport;
    let tr: ReturnType<typeof makeTransport>, link: string;
    try { tr = makeTransport(root, cfg.use, cfg); } catch (e) { return oops("dash.link-no-channel", { reason: (e as Error).message }); }
    // Only a channel that reaches the owner's own phone directly; never one an assistant relays.
    if (!tr.trusted) return oops("dash.link-relayed");
    try { link = `${secure ? "https" : "http"}://${req.headers.get("host")}/login?key=${mintPhoneLink(root, now())}`; } catch { return oops("dash.link-busy"); }
    const r = await tr.send({ id: `signin-${t0}`, text: `pocketBrain sign-in link for your phone (works once, for a day): ${link}`, at: now().toISOString() });
    if (!r.ok) return oops("dash.link-not-sent", { reason: r.detail ?? "no reason given" });
    return html({ title: "Sent", tab: "", bare: true, body: `<h1>Check your texts</h1><p>A sign-in link is on its way to this phone. Open Messages and tap the link in the text from pocketBrain. It works once, for a day.</p>${plainHttpNote(secure)}<form method="post" action="/send-link"><button>Text me another link</button></form>` });
  }

  // The phone app's two doors (docs/phone-app.md), on the tailnet and `tailscale serve` only. The
  // app's own requests carry no Origin; a page's do, and then it must be this hub. A body is a small
  // JSON object. Neither key is ever logged, echoed or kept in clear (only its hash, phone-app.ts).
  const appJson = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
  const appCookie = (sid: string, secure: boolean) => `pb_owner=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86_400}${secure ? "; Secure" : ""}`;
  async function appBody(req: Request, hosts: Set<string>): Promise<Record<string, unknown> | Response> {
    const origin = req.headers.get("origin");
    if (origin && !hosts.has(origin.replace(/^https?:\/\//, ""))) return oopsText("dash.cross-origin");
    const raw = await readCapped(req, 2048);
    if (raw === undefined) return appJson({ error: "too large" }, 413);
    try { const b = JSON.parse(raw || "{}"); if (b && typeof b === "object" && !Array.isArray(b)) return b as Record<string, unknown>; } catch { /* below */ }
    return oopsText("dash.bad-form");
  }
  const signInFor = (sid: string | undefined) => {
    const id = sid ?? rand();
    if (!sessions.has(id)) sessions.set(id, rand());
    keepSession(root, id, sessions.get(id)!, now());
    return id;
  };
  const forget = (hashes: string[]) => { for (const sid of [...sessions.keys()]) if (hashes.includes(sidHash(sid))) sessions.delete(sid); endSignIns(root, hashes); };
  async function appPair(req: Request, hosts: Set<string>, secure: boolean): Promise<Response> {
    const b = await appBody(req, hosts);
    if (b instanceof Response) return b;
    const key = typeof b.key === "string" ? b.key : "";
    // The same one-time phone link the Sign in button spends (usePhoneLink): one use, a day.
    if (!usePhoneLink(root, key, now())) return oopsText("dash.phone-link-used");
    const sid = signInFor(undefined), device = randomBytes(32).toString("base64url");
    try { forget(addAppPhone(root, device, phoneName(b.name), sidHash(sid), now())); } catch { return oopsText("dash.link-busy"); }
    return appJson({ device }, 200, { "set-cookie": appCookie(sid, secure) });
  }
  // Wrong keys count against the door, not the key: past APP_MISSES an hour every key waits.
  const misses: number[] = [];
  // The fresh door (audit v11, G642): only the app's own request (no Origin, the app's header), on
  // a live sign-in this phone made, with a one-time nonce the hub gave that sign-in a moment ago,
  // and at most APP_FRESH_PER_HOUR times an hour per phone. It never makes a sign-in, never moves
  // the 30 days, and sets no cookie: a lapsed sign-in pairs again with a phone link.
  const nonces = new Map<string, { h: string; t: number }>();
  const appOnly = (req: Request) => !req.headers.get("origin") && req.headers.get(APP_HEADER) === "1";
  function appNonce(req: Request): Response {
    if (!appOnly(req)) return oopsText("dash.cross-origin");
    const sid = session(req);
    if (!sid) return oopsText("dash.app-signed-out");
    const t0 = now().getTime();
    for (const [n, v] of nonces) if (t0 - v.t > NONCE_MS || nonces.size > 20) nonces.delete(n);
    const nonce = rand();
    nonces.set(nonce, { h: sidHash(sid), t: t0 });
    return appJson({ nonce });
  }
  async function appFresh(req: Request, hosts: Set<string>): Promise<Response> {
    if (!appOnly(req)) return oopsText("dash.cross-origin");
    const b = await appBody(req, hosts);
    if (b instanceof Response) return b;
    const t0 = now().getTime();
    while (misses.length && t0 - misses[0]! > 3_600_000) misses.shift();
    if (misses.length >= APP_MISSES) return oopsText("dash.app-cap");
    const sid = session(req);
    if (!sid) return oopsText("dash.app-signed-out");
    const nonce = typeof b.nonce === "string" ? b.nonce : "", n = nonces.get(nonce);
    nonces.delete(nonce);
    if (!n || n.h !== sidHash(sid) || t0 - n.t > NONCE_MS) return oopsText("dash.app-nonce");
    const device = typeof b.device === "string" ? b.device : "";
    let r: ReturnType<typeof useAppPhone>;
    try { r = useAppPhone(root, device, sidHash(sid), now()); } catch { return oopsText("dash.link-busy"); }
    if (r === "cap") return oopsText("dash.app-phone-cap");
    if (r !== "ok") { misses.push(t0); return oopsText("dash.app-not-paired"); }
    markFresh(root, sid, now());
    return appJson({ fresh: true });
  }

  function session(req: Request): string | undefined {
    const sid = req.headers.get("cookie")?.match(/(?:^|;\s*)pb_owner=([A-Za-z0-9_-]+)/)?.[1];
    if (!sid) return undefined;
    // With a .git, the kept file is the truth: a sign-in ended elsewhere (a phone removed from the
    // CLI, docs/phone-app.md) ends here too, not only at the next restart (slice audit of PR 42).
    const hasGit = existsSync(join(root, ".git"));
    if (sessions.has(sid) && !hasGit) return sid;
    const kept = hasGit ? keptSessions(root, now())[sidHash(sid)] : undefined;
    if (!kept) { sessions.delete(sid); return undefined; }
    if (sessions.has(sid)) return sid;
    sessions.set(sid, kept.csrf);
    return sid;
  }

  // The chips the box last offered each sign-in (only those count as taps).
  const offered = new Map<string, Set<string>>();
  // Ask's conversation per sign-in (owner app step 4): in this run's memory only, never on disk, the
  // last ASK_TURNS turns, gone a day after the last one or when the sign-in ends.
  const chats = new Map<string, AskTurn[]>();
  let lastOwnerMinute = "";
  async function handle(req: Request, hosts = allowedHosts, secure = false): Promise<Response> {
    const url = new URL(req.url);
    const host = req.headers.get("host") ?? "";
    if (!hosts.has(host)) return refusedAppDoor(root, req, oops("dash.host"), "dash.host", now());
    // The owner app's typeface (html-app.ts): a public font file, the same for everyone, no brain in it.
    if (url.pathname === FONT_PATH && req.method === "GET") return new Response(Bun.file(FONT_FILE), { headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" } });

    // The tailnet and tailscale serve: a phone link works here, and a signed-out phone can ask for one.
    const remote = hosts !== allowedHosts;
    if (url.pathname === "/login") {
      // Already signed in (the old text tapped again, or a restart in between): home, not an error.
      if (session(req)) return new Response(null, { status: 303, headers: { location: "/", "cache-control": "no-store" } });
      let k = url.searchParams.get("key") ?? "";
      if (!same(k, loginKey)) {
        if (!remote) return oops("dash.login-key");
        // A phone link is spent by the Sign in button, never by opening it: a message preview or a
        // second fetch of the link spends nothing (owner, 2026-10-24). The button posts from this
        // page only.
        if (req.method !== "POST") return !k || !phoneLinks(root, now())[sidHash(k)] ? usedLink() : html({ title: "Sign in", tab: "", bare: true, body: `<h1>Sign in on this phone</h1><form method="post" action="/login"><input type="hidden" name="key" value="${esc(k)}"><button class="go">Sign in</button></form><p class="sub">The link works once, for a day.</p><p><a href="pocketbrain://pair?hub=${encodeURIComponent(`${secure ? "https" : "http"}://${host}`)}&amp;key=${encodeURIComponent(k)}">Open in the pocketBrain app</a></p>` });
        const origin = req.headers.get("origin");
        if (!origin || !hosts.has(origin.replace(/^https?:\/\//, ""))) return oops("dash.cross-origin");
        try { k = String((await req.formData()).get("key") ?? ""); } catch { return oops("dash.bad-form"); }
        if (!usePhoneLink(root, k, now())) return usedLink();
      }
      const sid = rand();
      sessions.set(sid, rand());
      keepSession(root, sid, sessions.get(sid)!, now());
      // Lax on the tailnet, so the phone's browser keeps the sign-in when a link is opened from
      // Messages; every action still needs the session's CSRF token and a same-origin Origin.
      return new Response(null, { status: 303, headers: { location: "/", "set-cookie": `pb_owner=${sid}; HttpOnly; SameSite=${remote ? "Lax" : "Strict"}; Path=/; Max-Age=${SESSION_DAYS * 86_400}${secure ? "; Secure" : ""}`, "cache-control": "no-store" } });
    }
    if (remote && url.pathname === "/send-link" && req.method === "POST") return sendLink(req, hosts, secure);
    // The phone app (docs/phone-app.md): pair with a phone link, then Face ID makes a sign-in fresh.
    // Each call leaves a line (when, door, status, the hub's reason), so a phone's "Couldn't reach
    // your hub" can be read against what the hub answered (G651).
    if (remote && url.pathname === "/app/pair" && req.method === "POST") return appDoorLog(root, "/app/pair", req, await appPair(req, hosts, secure), now());
    if (remote && url.pathname === "/app/nonce" && req.method === "POST") return appDoorLog(root, "/app/nonce", req, appNonce(req), now());
    if (remote && url.pathname === "/app/fresh" && req.method === "POST") return appDoorLog(root, "/app/fresh", req, await appFresh(req, hosts), now());
    const sid = session(req);
    if (!sid) return remote ? signedOutPhone(secure) : oops("dash.signed-out");
    const csrf = sessions.get(sid)!;
    // ?ok= and ?err= name a message kept for this sign-in (keepFlash); plain text is still read, so
    // an old link shows its words, but the hub itself never puts a message in an address.
    for (const k of ["ok", "err"]) { const v = url.searchParams.get(k); if (v?.startsWith("@")) url.searchParams.set(k, takeFlash(sid, v.slice(1)) ?? ""); }
    const flash = url.searchParams.get("ok") ? { msg: url.searchParams.get("ok")! } : url.searchParams.get("err") ? { msg: refusalWords(url.searchParams.get("err")!), err: true } : undefined;
    // The week's "your time" (src/measure.ts): page loads only, not the grids' 2 s polls or other
    // fetches, and one line a minute at most (minutes are counted per minute anyway).
    const minute = new Date().toISOString().slice(0, 16);
    if (req.method === "GET" && !BACKGROUND.test(url.pathname) && req.headers.get("sec-fetch-dest") !== "empty" && minute !== lastOwnerMinute) {
      lastOwnerMinute = minute;
      recordOwnerTime(root, "dashboard");
    }

    if (req.method === "POST") {
      // Same-origin only, and the form's token must match this session's.
      const origin = req.headers.get("origin");
      if (origin && !hosts.has(origin.replace(/^https?:\/\//, ""))) return oops("dash.cross-origin");
      let fd: FormData;
      try { fd = await req.formData(); } catch { return oops("dash.bad-form"); }
      const form = Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]));
      if (!form.csrf || !same(form.csrf, csrf)) return oops("dash.csrf");
      const ref = req.headers.get("referer");
      // Back to the page the form was on; a path starting `//` would leave the dashboard.
      const refUrl = ref ? URL.parse(ref) : null;
      // Back to the page the form was on, on this host only: a path starting // or /\ is read by
      // browsers as another host (backlog #207), so it goes home instead.
      const back = refUrl?.host === host && /^\/(?![/\\])/.test(refUrl.pathname) ? refUrl.pathname : "/";
      // The message stays on the hub for this sign-in; the URL carries only its id (audit v5: Show
      // put a held value in the address).
      // tok: diary undo tokens for the home's done line (G631), comma-joined.
      const go = (path: string, r: { ok?: string; err?: string; undo?: string; wrong?: string; tok?: string[] }, hash = "") => new Response(null, { status: 303, headers: { location: `${path}?${r.err !== undefined ? `err=${keepFlash(sid, r.err)}` : `ok=${keepFlash(sid, r.ok ?? "")}${r.undo ? `&undo=${r.undo}` : ""}${r.tok?.length ? `&tok=${r.tok.join(",")}` : ""}${r.wrong ? `&wrong=${encodeURIComponent(r.wrong)}` : ""}`}${hash}` } });
      // The diary rows an action just added for one fact: their Undo tokens, newest last.
      const diaryAt = () => readDiary(root).length;
      const newTokens = (at: number, factKey?: string) => readDiary(root).slice(at).filter((r) => !factKey || r.fact_key === factKey).map((r) => r.undo_token).filter((t) => /^[0-9a-f]{16}$/.test(t));
      // What a pick leaves (G631): the next question waits on the home, or nothing does.
      const leftWords = () => { const n = settleLeft(root, now()); return n === 0 ? "Nothing else to settle." : n === 1 ? "1 more to settle." : `${n} more to settle.`; };
      // One plain line for what was settled: the fact as the home says it, or only its page for a private one.
      const settledWords = (c: { page: string; attr: string; fact_key: string; private?: boolean }) => {
        const notes = loadBrain(root), n = notes.find((x) => x.fm.id === c.page), f = n?.fm.facts?.[c.attr];
        if (!n || f === undefined || c.private || privateNow(n, c.attr, undefined)) return `Settled: ${displayName(c.page, n?.fm.title)}'s ${attrWords(c.attr)}.`;
        return `Settled: ${factSentence(c.page, n.fm.title, c.attr, shownValue(f), new Map(notes.map((x) => [x.fm.id, x])))}`;
      };
      const fail = (e: unknown) => { if (!(e instanceof CoreError)) console.error(e); return ownerFacingError(e); };
      const gated = url.pathname.startsWith("/action/") ? url.pathname.slice("/action/".length) : /^\/(propose|consent)\//.test(url.pathname) ? url.pathname.split("/")[1]! : "";
      if (gated && needsFresh(gated, form, root) && !freshSignIn(root, sid, now())) {
        if (gated === "settle-mail" || gated === "settle-pick") return go(`/settle/${encodeURIComponent(form.id ?? "")}`, { err: gated === "settle-pick" ? "Sign in again to settle it: its sides show only right after you sign in." : "Sign in again to let it through: it may hold something private." });
        return go(gated === "diary-seen" ? "/home" : back, { err: gated === "diary-seen" ? "Sign in again to see it: a held value shows only right after you sign in." : "Sign in again to do that: it needs a sign-in from the last few minutes." });
      }

      const pm = url.pathname.match(/^\/propose\/(.+)$/);
      if (pm) {
        const id = decodeURIComponent(pm[1]);
        try {
          const p = { ...(await proposeEdit(root, id, form.instruction ?? "", modelFor, form.section || undefined)), id: rand().slice(0, 12) };
          proposals.set(p.id, p);
          return new Response(null, { status: 303, headers: { location: `/proposal/${p.id}` } });
        } catch (e) { return go(back, { err: fail(e) }); }
      }
      const cm = url.pathname.match(/^\/consent\/([^/]+)$/);
      if (cm) {
        const agent = decodeURIComponent(cm[1]);
        let model;
        try { model = modelFor(consent.STEP); } catch { model = undefined; } // no model set up: the owner's words alone
        try {
          const p = { ...(await consent.propose(root, agent, form.intent ?? "", model)), id: rand().slice(0, 12) };
          consents.set(p.id, p);
          return new Response(null, { status: 303, headers: { location: `/consent/${p.id}` } });
        } catch (e) { return go(back, { err: fail(e) }, "#for"); }
      }
      // The owner's text box (src/owner-say.ts): the answer is the home page with it under the box.
      if (url.pathname === "/say") {
        // The composer lets a line break with Shift+Enter; the hub reads what was said as one line.
        const said = (form.q ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
        let reply;
        const fresh = freshSignIn(root, sid, now());
        try { // A chip counts as a tap only when the box offered that exact sentence to this sign-in;
        // anything else posted as a chip is read as typed words (coordinator, 2026-10-27).
        const chip = form.chip === "1" && !!offered.get(sid)?.has(said);
        // On Ask, a follow-up carries the page this sign-in's last answer there was about.
        const follows = form.from === "ask" ? (chats.get(sid) ?? []).filter((x) => x.at >= now().getTime() - ASK_FOLLOW_MS && x.reply.page).at(-1)?.reply.page : undefined;
        reply = await ownerSayModel(root, said, { page: form.page || undefined, fresh, chip, ...(form.from === "ask" ? { from: "ask" as const, ...(follows ? { follows } : {}) } : {}) }, chip ? undefined : boxModel(root));
        if (reply.chips?.length) offered.set(sid, new Set(reply.chips.map((c) => c.say))); } catch (e) { return go("/home", { err: fail(e) }); }
        if (form.page && reply.kind !== "say.unknown-name" && reply.kind !== "say.forgotten") { const r = pageScreen(csrf, reply.page ?? form.page, { said, reply, fresh }); if (r) return r; }
        if (form.from === "ask") {
          const byId = new Map(loadBrain(root, { shared: true }).map((n) => [n.fm.id, n]));
          const turns = [...(chats.get(sid) ?? []), { said, reply, fresh, at: now().getTime(), privateThen: privateParts(byId, { reply }) }].slice(-ASK_TURNS);
          chats.set(sid, turns);
          return ask(csrf, sid);
        }
        return home(csrf, said, reply, undefined, false, false, freshSignIn(root, sid, now()));
      }
      const action = url.pathname.startsWith("/action/") ? url.pathname.slice("/action/".length) : "";
      // Undo from a diary line (src/undo.ts): a forward write, back to the home with what happened.
      // A held message, from its settle screen: send it as it is, or keep it back.
      if (action === "settle-mail") {
        const id = (form.id ?? "").replace(/^m-/, "");
        const m = comms(root).find((x) => x.id === id && x.verdict === "held");
        if (!m || !["send", "drop"].includes(form.n ?? "")) return go("/home", { err: "Nothing to settle there any more." });
        try {
          const r = decideHeld(root, (opts.transport ?? (() => fileTransport(root)))(), m.id, form.n === "send" ? "release" : "drop");
          if (!/: (released|dropped)-by-owner$/.test(r)) return go("/home", { err: "Nothing to settle there any more." });
          const to = agentLabel(loadRules(root), m.to);
          return go("/home", { ok: form.n === "send" ? `Sent it to ${to}.` : `Kept it back. ${to} never sees it.` });
        } catch (e) { return go("/home", { err: fail(e) }); }
      }
      if (action === "settle-pick" || action === "settle-both") {
        const id = form.id ?? "", value = (form.value ?? "").replace(/\s+/g, " ").trim();
        const c = id.startsWith("p-") ? inboxConflict(root, id) : ownerConflict(root, id);
        if (!c) return go("/home", { err: "Nothing to settle there any more." });
        const back = `/settle/${encodeURIComponent(id)}`;
        const at = diaryAt();
        // A card that holds several questions goes on to its next one; the last goes home (G669).
        const card = settleCard(root, id, now());
        const done = () => { const n = settleNext(root, card, id, now()); return n ? `/settle/${encodeURIComponent(n)}` : "/home"; };
        // A conflict that waits in the inbox (src/settle-inbox.ts): keep yours, take the new one, or type it.
        if (id.startsWith("p-")) {
          try {
            if (action === "settle-both") { settleInbox(root, id, { n: 1 }); return go(done(), { ok: `Kept what you had. I won't ask again unless something newer comes in. ${leftWords()}`, tok: newTokens(at, c.fact_key) }); }
            if (!form.n && !value) return go(back, { err: "Pick one, or type what it is." });
            settleInbox(root, id, value ? { typed: value } : { n: Number(form.n) });
            // A pick ends the question: back to the home, where it is gone and the number is one less (G631).
            return go(done(), { ok: `${settledWords(c)} ${leftWords()}`, tok: newTokens(at, c.fact_key) });
          } catch (e) { return go(back, { err: fail(e) }); }
        }
        try {
          if (action === "settle-both") { ownerKeepBoth(root, id); return go(done(), { ok: `Kept both. I won't ask again unless something newer comes in. ${leftWords()}`, tok: newTokens(at, c.fact_key) }); }
          if (!form.n && !value) return go(back, { err: "Pick one, or type what it is." });
          ownerDecide(root, id, value || form.n!, `settle-${id}`, { typed: !!value });
          return go(done(), { ok: `${settledWords(c)} ${leftWords()}`, tok: newTokens(at, c.fact_key) });
        } catch (e) { return go(back, { err: fail(e) }); }
      }
      if (action === "sign-in-again") {
        sessions.delete(sid);
        chats.delete(sid);
        dropSession(root, sid, now());
        return new Response(null, { status: 303, headers: { location: "/", "set-cookie": `pb_owner=; HttpOnly; Path=/; Max-Age=0`, "cache-control": "no-store" } });
      }
      if (action === "diary-seen") {
        // Show: the owner sees a held value, and from now on their assistants get it (src/seen.ts).
        // A card can hold several values that read the same (home.ts heldName): one key per line.
        const keys = (form.key ?? "").split("\n").map((k) => k.trim()).filter(Boolean).slice(0, 50);
        const notes = loadBrain(root), said: HeldValue[] = [], at = diaryAt(), only: (string[] | undefined)[] = [];
        for (const key of keys) {
          const r = markSeen(root, key);
          if (r.outcome === "not_saved") return go("/home", { err: r.message });
          if (r.outcome !== "seen") continue;
          const hash = key.lastIndexOf("#"), id = key.slice(0, hash);
          const n = notes.find((x) => x.fm.id === id);
          // Said as the home says a memory (G625): "Ben Carter prefers tea", never "Ben Carter: prefers is tea".
          const attr = key.slice(hash + 1);
          // One sentence per page, as the card read them (G634).
          said.push({ page: id, title: n?.fm.title, attr, value: r.value });
          only.push(r.shareWith);
        }
        if (!said.length) return go("/home", { err: "Nothing waiting there any more." });
        return go("/home", { ok: `${pageSentences(said, new Map(notes.map((x) => [x.fm.id, x]))).join(" ")} ${whoGetsIt(only)}`, tok: newTokens(at) });
      }
      if (action === "diary-keep") {
        // Keep it private (G630): still held from every assistant, no longer waiting (src/seen.ts).
        const keys = (form.key ?? "").split("\n").map((k) => k.trim()).filter(Boolean).slice(0, 50);
        let kept = 0;
        for (const key of keys) {
          const r = keepPrivate(root, key);
          // A save that fails after others went through says how many were kept (review of #60).
          if (r.outcome === "not_saved") return go("/home", { err: kept ? `${kept} kept private; the rest ${r.message}` : r.message });
          if (r.outcome === "kept") kept++;
        }
        return kept ? go("/home", { ok: APP_COPY.keptPrivate }) : go("/home", { err: "Nothing waiting there any more." });
      }
      if (action === "fix-everywhere") {
        // The belief radar's one tap (src/dashboard/home-beliefs.ts): every assistant gets the brain's
        // value for this fact, through memory sync's own corrections and questions. The flash names
        // the page and the fact, never a value.
        const key = form.key ?? "";
        const hash = key.lastIndexOf("#"), id = key.slice(0, hash);
        try {
          const r = fixEverywhere(root, key);
          const n = loadBrain(root).find((x) => x.fm.id === id);
          const what = `${displayName(id, n?.fm.title)}: ${key.slice(hash + 1).replace(/[_-]+/g, " ")}`;
          return go("/home", { ok: r.approved.length || r.asked.length || r.rescanned.length ? `${what}. Your assistants get the right answer at their next check.` : `${what}. Nothing to fix now.` });
        } catch { return go("/home", { err: "That isn't wrong anywhere any more." }); }
      }
      if (action === "diary-undo") {
        const to = form.page ? `/p/${form.page.split("/").map(encodeURIComponent).join("/")}` : "/home";
        // A sentence that noted several things carries all their tokens: newest first, so a page it started goes too.
        try { const done = (form.token ?? "").split(",").filter(Boolean).reverse().map((t) => undoFact(root, t)); return go(to, { ok: (done.at(-1) ?? undoFact(root, "")).message }); } catch (e) { return go(to, { err: fail(e) }); }
      }
      if (action === "proposal-apply" || action === "proposal-discard") {
        const p = proposals.get(form.pid ?? "");
        if (!p) return go("/brain", { err: "that proposal is gone (the dashboard restarted, or it was already used)" });
        proposals.delete(p.id);
        if (action === "proposal-discard") return go(`/note/${p.noteId}`, { ok: "discarded; nothing changed" });
        // The note may have changed since the model read it; never overwrite that.
        if (noteText(root, p.noteId) !== p.before) return go(`/note/${p.noteId}`, { err: "the note changed since the proposal; ask again" });
        try { return go(`/note/${p.noteId}`, { ok: saveNoteText(root, p.noteId, p.after, `apply ${p.model}'s proposal ("${p.instruction.slice(0, 60)}") to`, { stamp: true, ...(p.section ? { trailers: ["Via: edit-with-chat", `Section: ${p.section}`] } : {}) }) }); }
        catch (e) { return go(`/note/${p.noteId}`, { err: fail(e) }); }
      }
      if (action === "consent-apply" || action === "consent-discard") {
        const p = consents.get(form.pid ?? "");
        if (!p) return go("/agents", { err: "that proposal is gone (the dashboard restarted, or it was already used)" });
        consents.delete(p.id);
        const page = `/agent/${encodeURIComponent(p.agent)}`;
        if (action === "consent-discard") return go(page, { ok: "discarded; nothing changed" });
        try {
          const ok = consent.applyChoice(root, p.agent, p.slices, p.exclude_types);
          return go(page, { ok: ok.replace(/^\S+/, cap(agentLabel(loadRules(root), p.agent))) + ".", undo: git(root, ["rev-parse", "HEAD"]) });
        } catch (e) { return go(page, { err: fail(e) }); }
      }
      // Louis's own edits on the Brain tab come back with a plain sentence and an Undo.
      if (action === "fact-set" || action === "note-body-save" || action === "section-save" || action === "fact-confirm") {
        const attr = form.attribute?.trim() ?? "";
        const isNew = action === "fact-set" && !!attr && !loadBrain(root).find((n) => n.fm.id === form.id?.replace(/\.md$/, ""))?.fm.facts?.[attr];
        try {
          const raw = runAction({ root, transport: opts.transport }, action, form);
          if (/: no change$/.test(raw)) return go(back, { ok: "No change." });
          const head = git(root, ["rev-parse", "HEAD"]);
          const ok = action === "note-body-save" ? "Saved the notes." : action === "section-save" ? `Saved the ${form.heading?.trim()} section.` : action === "fact-confirm" ? `Marked ${cap(attr)} as still true.` : isNew ? `Added ${cap(attr)}.` : `Saved ${cap(attr)}. The old value is under Earlier values.`;
          // A replaced single value can then be marked as never right: a correction, not a change.
          const replaced = action === "fact-set" && !isNew && !!loadBrain(root).find((n) => n.fm.id === form.id?.replace(/\.md$/, ""))?.fm.history?.[attr];
          return go(back, { ok, undo: head, wrong: replaced ? attr : undefined }, attr ? `#f-${encodeURIComponent(attr)}` : "");
        } catch (e) { return go(back, { err: fail(e) }); }
      }
      // Just this one, from a dashed mark's sheet: one read, for one of the owner's own assistants
      // (the marks' own list), behind a fresh sign-in like every other widening.
      if (action === "let-once") {
        try {
          const key = form.key ?? "", id = key.slice(0, Math.max(0, key.lastIndexOf("#")));
          const a = markAgents(loadRules(root)).find((x) => x.agent === form.agent);
          if (!a || !id) throw new CoreError(404, "no such assistant or page");
          offerOnce(root, a.agent, id);
          return go("/home", { ok: APP_COPY.onItsWay.replace("{name}", a.name) });
        } catch (e) { return go("/home", { err: fail(e) }); }
      }
      // Forgetting, correcting and who-can-see come back with Undo too. A forgotten note has no page.
      if (["org-yes", "org-no", "org-again", "org-undo"].includes(action)) {
        try {
          const ok = runAction({ root, transport: opts.transport }, action, form);
          return go(back, { ok, undo: action === "org-undo" ? undefined : git(root, ["rev-parse", "HEAD"]) });
        } catch (e) { return go(back, { err: fail(e) }); }
      }
      if (["note-forget", "note-bring-back", "fact-wrong", "fact-done", "fact-forget", "note-hide", "note-show", "note-sensitivity"].includes(action)) {
        try {
          let ok = runAction({ root, transport: opts.transport }, action, form);
          const head = git(root, ["rev-parse", "HEAD"]);
          if (action === "note-sensitivity" && / now\.$/.test(ok)) {
            const seen = audience(loadState(root), form.id?.replace(/\.md$/, "") ?? "").seen;
            ok += seen.length ? ` Seen by ${names(seen.map((a) => agentLabel(loadRules(root), a)))}.` : " Only you can see it.";
          }
          const changed = / now\.$| again\.$| as it was\.$|^Forgot |^Marked /.test(ok);
          return go(action === "note-forget" ? "/brain" : action === "note-hide" && form.from === "let" ? "/home" : back, { ok, undo: changed ? head : undefined });
        } catch (e) { return go(back, { err: fail(e) }); }
      }
      // Replaced connections deleted at the sign-in service (backlog 289): a network call, so awaited here.
      if (action === "oauth-cleanup") {
        loadKeys();
        const cut = await cleanupReplaced(root);
        if (cut.skipped && !cut.deleted.length) return go(back, { err: `nothing deleted: ${cut.skipped}` });
        return go(back, cut.failed.length ? { err: `Deleted ${cut.deleted.length} old app(s); ${cut.failed.length} failed (${cut.failed.map((f) => f.why).join(", ")}). They stay refused here.` } : { ok: `Deleted ${cut.deleted.length} old app${cut.deleted.length === 1 ? "" : "s"} at the sign-in service.` });
      }
      // G184: the one-time code goes on the page itself, never into a redirect URL (browser history).
      if (action === "token-code") {
        try {
          const msg = runAction({ root, transport: opts.transport }, action, form);
          const pg = agentPage(loadState(root), csrf, form.agent ?? "");
          return html(pg ? { ...pg, flash: { msg } } : { title: "One-time code", tab: "agents", body: "", flash: { msg } });
        } catch (e) { return go(back, { err: fail(e) }); }
      }
      if (action) {
        try { const ok = runAction({ root, transport: opts.transport }, action, form); return go(back, { ok }); }
        catch (e) { return go(back, { err: fail(e) }); }
      }
      return oops("dash.no-button");
    }
    if (req.method !== "GET") return oops("dash.method");

    // An approval on the phone shows up here even if the agent hasn't checked yet.
    if (askPolicy(loadRules(root))?.approver === "guardian") await pollAsks(root).catch(() => 0);
    const s = loadState(root);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    // Audit v5: only the owner screens open on the 30-day sign-in, each shutting what is private on
    // its own: the four tabs (Memory lists titles only), the page and settle screens. Every other
    // page can show a private value, so it needs a sign-in from the last 10 minutes, like a private
    // value on /p.
    if (!/^\/(home|memory|ask|who|let|p\/.+|settle\/.+)?$/.test(p) && !freshSignIn(root, sid, now()))
      return html({ title: "Sign in again", tab: "", body: ownerErrorHtml("dash.sign-in-again", {}, esc) + signInAgain(csrf) }, ownerStatus("dash.sign-in-again"));
    const undo = url.searchParams.get("undo")?.match(/^[0-9a-f]{7,40}$/)?.[0];
    const wrong = url.searchParams.get("wrong")?.match(/^[a-z][a-z0-9_]*$/)?.[0];
    const noteId = p.match(/^\/note\/(.+)$/)?.[1].split("/").map(decodeURIComponent).join("/");
    const fix = wrong && noteId ? button(csrf, "fact-wrong", { id: noteId, attribute: wrong }, "It was never right", "", "The old value was a mistake, not something that changed? It stays in history, marked as never right.") : "";
    const withFlash = (pg: Page) => html({ ...pg, flash: flash && undo && !flash.err ? { ...flash, extra: button(csrf, "owner-undo", { hash: undo }, "Undo") + fix } : flash });
    // The home is the front door (audit v4); the old overview is one tap away from it.
    if (p === "/overview") return withFlash(overview(s, csrf, url.searchParams));
    const op = p.match(/^\/p\/(.+)$/);
    if (op) return pageScreen(csrf, op[1]!.split("/").map(decodeURIComponent).join("/"), { flash: url.searchParams.get("ok") ?? url.searchParams.get("err") ?? undefined, undo: url.searchParams.get("ok") ? undo : undefined, fresh: freshSignIn(root, sid, now()) }) ?? page("dash.no-note", "brain", { id: op[1]! });
    const mailId = p.match(/^\/settle\/m-([A-Za-z0-9_-]+)$/)?.[1];
    if (mailId) return new Response(heldMailPage(comms(root).find((x) => x.id === mailId && x.verdict === "held"), csrf, loadRules(root), loadBrain(root), url.searchParams.get("err") ?? undefined, { fresh: freshSignIn(root, sid, now()) }), { headers: PAGE_HEADERS });
    const settleId = p.match(/^\/settle\/(c-\d{4,}|p-[A-Za-z0-9._-]+)$/)?.[1];
    if (settleId) {
      const c = settleId.startsWith("p-") ? inboxConflict(root, settleId) : ownerConflict(root, settleId);
      // Where this question sits among the ones waiting on the home ("1 of 3"), and its page's area.
      const ids = [...ownerConflicts(root, now()).filter((x) => !x.held).map((x) => x.id), ...inboxConflicts(root).map((x) => x.id)];
      const pageNote = c ? loadBrain(root, { shared: true }).find((n) => n.fm.id === c.page) : undefined;
      const area = pageNote?.fm.area;
      const fresh = freshSignIn(root, sid, now()), rules = loadRules(root);
      // Each side's source words (G619), under the page's own rule for kept words.
      const words = Object.fromEntries((c?.sides ?? []).map((x) => [x.n, sideWords(root, rules, pageNote, x.refs, x.value, fresh)] as const).filter((e): e is [number, string] => !!e[1]));
      return new Response(settlePage(c, csrf, rules, url.searchParams.get("err") ?? undefined, { fresh, words, ...(area ? { area: String(area) } : {}), ...(c && ids.includes(c.id) ? { pos: ids.indexOf(c.id) + 1, of: ids.length } : {}) }), { headers: PAGE_HEADERS });
    }
    if (p === "/" || p === "/home") return home(csrf, undefined, undefined, url.searchParams.get("ok") ?? url.searchParams.get("err") ?? undefined, url.searchParams.get("all") === "1", !!url.searchParams.get("ok"), freshSignIn(root, sid, now()), url.searchParams.get("tok")?.match(/^[0-9a-f]{16}(?:,[0-9a-f]{16}){0,49}$/)?.[0]);
    const flashed = url.searchParams.get("ok") ?? url.searchParams.get("err") ?? undefined;
    if (p === "/who") return who(csrf, freshSignIn(root, sid, now()), flashed);
    if (p === "/let") return letSheet(csrf, url.searchParams) ?? page("dash.no-note", "brain", { id: url.searchParams.get("key")?.split("#")[0] ?? "" });
    if (p === "/ask") return ask(csrf, sid, flashed);
    if (p === "/memory") return memory(url.searchParams, freshSignIn(root, sid, now()));
    const editor = s.rules.policy.owner_editor;
    if (p === "/agents") return withFlash(agentsPage(s, csrf, oauthCard(s, csrf, loadOAuth(root), listPending(root)) + editorCard(s, csrf, editor, editor ? editorCommits(root, editor) : [])));
    if (p === "/agents/new") {
      const q = url.searchParams;
      const clientId = q.get("client_id") ?? "";
      const req = { agent: (q.get("agent") ?? "").trim(), name: q.get("name")?.trim().slice(0, 60) || undefined, slices: q.getAll("slices").flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean) };
      if (!listPending(root).some((x) => x.client_id === clientId)) return page("dash.connection-gone", "agents");
      try { return html(newAgentPage(csrf, clientId, req, previewNewAgent(root, req))); }
      catch (e) { return page("dash.cant-add", "agents", { reason: e instanceof Error ? e.message : String(e) }); }
    }
    if (p === "/brain") return withFlash(brainPage(s, csrf, { q: url.searchParams.get("q") ?? "", kind: url.searchParams.get("kind") || url.searchParams.get("folder") || undefined, page: pageParam(url) }));
    // The search box asks for this as you type: results only, from this computer, no model.
    if (p === "/brain/results") return new Response(brainResults(s, csrf, (url.searchParams.get("q") ?? "").slice(0, 300)), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    const nm = p.match(/^\/note\/(.+)$/);
    if (nm) {
      const id = nm[1].split("/").map(decodeURIComponent).join("/");
      try {
        const note = editableNote(root, id);
        return withFlash(notePage(s, csrf, note, noteText(root, id), editor, url.searchParams.get("edit") ?? undefined));
      } catch (e) { if (!(e instanceof CoreError)) throw e; return page("dash.note", "brain", { reason: e.message }, e.status); }
    }
    const wm = p.match(/^\/why\/(.+)$/);
    if (wm) {
      const id = wm[1].split("/").map(decodeURIComponent).join("/");
      const attr = url.searchParams.get("fact") ?? "";
      const note = s.notes.find((n) => n.fm.id === id);
      try {
        if (!note) throw new CoreError(404, `no note ${id}`);
        return withFlash(whyPage(s, note, attr, ownerWhy(root, `${id}#${attr}`)));
      } catch (e) { if (!(e instanceof CoreError)) throw e; return page("dash.note", "brain", { reason: e.message }, e.status); }
    }
    // History, read from git: what changed this week, one note's facts over time, a note as it was.
    if (p === "/history") {
      const day = url.searchParams.get("at")?.match(/^\d{4}-\d{2}-\d{2}$/)?.[0];
      if (day) {
        const b = keptFor(root, `brain-at:${day}`, s.dayKey, () => brainAt(root, day));
        return b ? withFlash(brainOnPage(s, day, b.notes, b.at, pageParam(url))) : page("dash.no-day", "brain", { day });
      }
      const days = 7;
      return withFlash(weekPage(s, keptFor(root, "week", s.key, () => savesSince(root, new Date(s.now.getTime() - days * 86_400_000).toISOString())), days));
    }
    const hm = p.match(/^\/history\/(.+)$/);
    if (hm) {
      const id = hm[1].split("/").map(decodeURIComponent).join("/");
      const note = s.notes.find((n) => n.fm.id === id);
      if (!note) return page("dash.no-note", "brain", { id });
      const { versions, saves } = keptFor(root, `history:${id}`, s.key, () => { const versions = noteVersions(root, id); return { versions, saves: noteSaves(root, id, versions) }; });
      const at = url.searchParams.get("at");
      if (at) {
        const v = versionAt(versions, at);
        return v ? withFlash(snapshotPage(s, csrf, note, v, saves, at)) : page("dash.no-version", "brain");
      }
      return withFlash(noteHistoryPage(s, csrf, note, saves, keptFor(root, "reverted", s.dayKey, () => revertedHashes(root))));
    }
    const cp = p.match(/^\/consent\/([A-Za-z0-9_-]+)$/);
    if (cp) {
      const prop = consents.get(cp[1]);
      return prop ? html(consentPage(s, csrf, prop)) : page("dash.consent-gone", "agents");
    }
    const pr = p.match(/^\/proposal\/([A-Za-z0-9_-]+)$/);
    if (pr) {
      const prop = proposals.get(pr[1]);
      return prop ? withFlash(proposalPage(s, csrf, prop)) : page("dash.proposal-gone", "brain");
    }
    if (p === "/fga") return withFlash(await fgaPage(s));
    if (p === "/fga/grid") return new Response(await fgaGrid(s), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" } });
    if (p === "/map") return withFlash(mapPage(s, url.searchParams.get("as") || undefined, pageParam(url), { q: url.searchParams.get("q") ?? "", read: url.searchParams.get("read") ?? "" }));
    // The map page asks for this every 2 seconds, so a revoke or an FGA change shows as it lands.
    if (p === "/map/grid") return new Response(mapGrid(s, url.searchParams.get("as") || undefined, pageParam(url)), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" } });
    if (p === "/activity") return withFlash(activityPage(s, url.searchParams.get("agent") || undefined, url.searchParams.get("op") || undefined, url.searchParams));
    if (p === "/upkeep") return withFlash(upkeepPage(s, csrf));
    if (p === "/digest") return withFlash(digestPage(s, csrf, latestDigest(root)));
    if (p === "/people") return withFlash(peoplePage(s, csrf));
    if (p === "/usage") return withFlash(usagePage(root, csrf, url.searchParams.get("month")?.match(/^\d{4}-\d{2}$/)?.[0]));
    const m = p.match(/^\/agent\/([a-z0-9_-]+)(\/view)?$/i);
    if (m) {
      const name = decodeURIComponent(m[1]);
      if (m[2]) {
        // The same carve the page state holds (kept until the brain or rules change, data.ts).
        const res = s.carves.get(name);
        if (!res || !s.agents.some((a) => a.name === name)) return oops("dash.no-agent", { name });
        return text(renderView(s.notes, s.rules, res, root));
      }
      const pg = agentPage(s, csrf, name, url.searchParams);
      return pg ? withFlash(pg) : page("dash.no-agent", "agents", { name });
    }
    return page("dash.not-found", "");
  }

  const guarded = async (req: Request, hosts: Set<string>, secure = false) => {
    try { return await handle(req, hosts, secure); }
    catch (e) { console.error(e); return oops("dash.internal"); }
  };
  // One of the owner's own devices, by its tailnet address (dashboard_tailnet_devices in
  // rules/hub.yaml). A Tailscale account can hold other machines (a box an assistant runs on), so
  // the owner's login alone is not enough; a list naming none lets no device in.
  const refused = (req: Request, id: Parameters<typeof oops>[0]) => refusedAppDoor(root, req, oops(id), id, now());
  const ownDevice = (ip: string | undefined) => { const a = ip?.replace(/^::ffff:/i, ""); return !!a && isTailnetIp(a) && !!tn?.devices?.includes(a); };
  return {
    loginKey, setPort, setTailnet,
    // Loopback. A request naming this machine's MagicDNS name on SERVE_PORT came through
    // `tailscale serve`, which sets Tailscale-User-Login to the tailnet user and X-Forwarded-For to
    // the device's tailnet address (replacing any the client sent). Only the owner's login, from one
    // of the owner's listed devices, gets in: not another tailnet user or machine, not a funnel
    // request, and nothing carrying Cloudflare's headers. Any other loopback sender could set the
    // headers too, so the dashboard's own login key and cookie still apply on top.
    handle: (req: Request) => {
      const host = req.headers.get("host") ?? "";
      if (!serveHosts.has(host)) return guarded(req, allowedHosts);
      const who = req.headers.get("tailscale-user-login")?.trim().toLowerCase();
      const viaFunnel = req.headers.has("tailscale-funnel-request") || [...req.headers.keys()].some((k) => k.startsWith("cf-"));
      if (viaFunnel || !who || !tn?.login || !same(who, tn.login.trim().toLowerCase())) return refused(req, "dash.tailnet-owner-only");
      if (!ownDevice(req.headers.get("x-forwarded-for")?.trim())) return refused(req, "dash.tailnet-device");
      return guarded(req, serveHosts, true);
    },
    // The tailnet listener: only one of the owner's listed devices, only this machine's tailnet
    // names as Host and Origin. `peer` is the connection's address, never a header.
    handleTailnet: async (req: Request, peer: string | undefined) => {
      if (!tn?.address) return oops("dash.not-found");
      if (!isTailnetIp(peer)) return refused(req, "dash.tailnet-owner-only");
      if (!ownDevice(peer)) return refused(req, "dash.tailnet-device");
      return guarded(req, tailnetHosts);
    },
  };
}

export function serveDashboard(root: string, opts: DashboardOptions = {}) {
  const hostname = opts.hostname ?? "127.0.0.1";
  if (!LOOPBACK.has(hostname)) throw new Error(`the dashboard binds to loopback only (got ${hostname}); reach it from elsewhere with an SSH tunnel`);
  const port = opts.port ?? 8788;
  const h = dashboardHandler(root, { ...opts, port });
  const server = Bun.serve({ port, hostname, fetch: h.handle });
  h.setPort(server.port!);
  const loginUrl = `http://${hostname === "::1" ? "[::1]" : hostname}:${server.port}/login?key=${h.loginKey}`;
  const kept = (tailnet?: string, serve?: string) => { const f = keepLoginLinks(root, { local: loginUrl, ...(tailnet ? { tailnet } : {}), ...(serve ? { serve } : {}) }); return loginWords(f, loginUrl, tailnet, serve); };
  if (!opts.tailnet) return { server, loginUrl, loginSay: kept() };
  // Opt-in: the same dashboard on this machine's Tailscale address, same port.
  const t: Tailnet = { ...(opts.tailnet === true ? (tailnetSelf() ?? {}) : opts.tailnet), ...(opts.tailnetLogin ? { login: opts.tailnetLogin } : {}), ...(opts.tailnetDevices ? { devices: opts.tailnetDevices } : {}) };
  if (!isTailnetIp(t.address)) return { server, loginUrl, loginSay: kept(), tailnetProblem: "dashboard_tailnet is on, but this machine has no Tailscale address (is Tailscale up?); the dashboard stays on localhost" };
  let tailnetServer: ReturnType<typeof Bun.serve>;
  try { tailnetServer = Bun.serve({ port: server.port!, hostname: t.address, fetch: (req, srv) => h.handleTailnet(req, srv.requestIP(req)?.address) }); }
  catch (e) { return { server, loginUrl, loginSay: kept(), tailnetProblem: `couldn't listen on ${t.address}:${server.port} (${e instanceof Error ? e.message : String(e)}); the dashboard stays on localhost` }; }
  h.setTailnet(t, server.port!);
  const tailnetLoginUrl = `http://${t.name ?? t.address}:${server.port}/login?key=${h.loginKey}`;
  // With `tailscale serve --bg --https=SERVE_PORT http://127.0.0.1:<port>` on this machine,
  // and the owner's Tailscale login set (dashboard_tailnet_login in rules/hub.yaml).
  const serveLoginUrl = t.name && t.login ? `https://${t.name}:${SERVE_PORT}/login?key=${h.loginKey}` : undefined;
  return {
    server, loginUrl, tailnetServer, tailnetLoginUrl, loginSay: kept(tailnetLoginUrl, serveLoginUrl),
    ...(serveLoginUrl ? { serveLoginUrl, servePort: SERVE_PORT } : {}),
  };
}
