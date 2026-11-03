// SPDX-License-Identifier: AGPL-3.0-only
// Source pulls (docs/sources-pull.md; decided 2026-10-11: the hub pulls, the gardener tends).
// The hub reads the places the owner lists in rules/sources.yaml (Slack channels, Gmail labels,
// calendars, Docs, Zoom meetings) and feeds each new or changed item through the capture path:
// secrets blanked, injection held, limits, then extraction and code checks. What comes of it:
//   - a fact the brain already holds gets the source added and is re-confirmed (no proposal);
//   - a new or different value becomes an inbox proposal citing the exact source and its version;
//   - when a source moves (edited, deleted, access lost), every fact citing the old version turns
//     `due`, with the reason, and no model is asked. The gardener re-reads and proposes at night.
// Nothing outside the allowlist is read. A live source also needs `consent:` in sources.yaml,
// which only the owner writes; until then only `fixture:` sources (JSON files) run.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { join, isAbsolute } from "node:path";
import { loadBrain, saveNote, today, isList, sensitivityRank, type FactRecord, type Fact, type Sensitivity } from "./brain";
import { readYaml, loadRules, attributeSpec, gardeners } from "./rules";
import { nameKeys } from "./mentions";
import { hubRole } from "./hub";
import { factFreshness } from "./freshness";
import { git } from "./git";
import { alert, appendJsonl, readJsonl } from "./util";
import { verifyLog, claimKey } from "./evidence";
import { loadEscalation } from "./textline/policy";
import { clock, ownerDay } from "./clock";
import { refString, sourceRank } from "./sources";
import { extractCapture, fileCard, checkCandidate, releaseHeldDaily, captureModel, findCapture, previewExtraction, readCapture, unfinishedPull, type CaptureItem } from "./capture";
import { fetchGmail, fetchGmailMessage, fetchCalendar, fetchCalendarEvent, fetchUpcoming, fetchDrive, fetchDriveFile, fetchContacts, fetchContact } from "./google";
import { cardItem, readCard, cardCandidates, cardAdjust, ownerRelations, fetchVcards, withoutDetails } from "./contacts";
import { fetchDiscord, fetchDiscordMessage, fetchTexts, fetchText, fetchGranola, fetchGranolaNote } from "./feeds";
import { findInjection, redactSecrets } from "./checks";
import { compareKey } from "./normalize";
import { logWrite } from "./write";
import { recordCheckedRefs, checkedRefs } from "./louis";
import { senderHash } from "./sameperson";
import { senderStanding } from "./sender";
import { createHash } from "node:crypto";
import type { Model } from "./model";
import { recordInteraction } from "./standing";
import { saveUpcoming, toUpcoming } from "./upcoming";
import { keepWords, keptQuotes } from "./quotes";

// Sources whose items are messages to or from the owner: they feed standing suggestions.
// Phone handles compare by digits (the last 10, so +1 and spacing don't matter); emails and chat ids as written.
const handleKey = (h: string) => (/@|^chat/i.test(h.trim()) ? h.trim().toLowerCase() : h.replace(/\D/g, "").slice(-10));
// The Messages threads the text channel uses (rules/escalation.yaml): iMessage to the owner's own
// handle, or the Twilio number the hub texts from.
function channelThreads(root: string): Set<string> {
  const t = loadEscalation(root).transport;
  return new Set([t.imessage?.to, t.twilio?.from].filter((h): h is string => !!h && !!h.trim()).map(handleKey).filter(Boolean));
}
const STANDING_KINDS = new Set<SourceKind>(["gmail", "mail", "imessage"]);

// mail is any other mailbox (IMAP, Outlook, iCloud): RFC 822 fields, keyed by Message-ID.
// imessage is the owner's texts (iMessage/SMS) from the Mac's ~/Library/Messages/chat.db, read only.
// granola is the owner's recorded conversations (Granola notes; its local cache on the Mac, read only).
// contacts is the owner's address book (Google Contacts, or a vCard file): read by code, never a model (src/contacts.ts).
export type SourceKind = "slack" | "gmail" | "mail" | "gcal" | "gdoc" | "zoom" | "discord" | "imessage" | "granola" | "contacts";
// The ref scheme per kind. Gmail messages never change, so their ref has no version.
export const SCHEME: Record<SourceKind, string> = { slack: "slack", gmail: "gmail", mail: "mail", imessage: "imessage", granola: "granola", gcal: "gcal", gdoc: "gdoc", zoom: "zoom", discord: "discord", contacts: "contacts" };

export interface SourceConfig {
  kind: SourceKind;
  account?: string;            // which mailbox (one source per account): named in its refs, gmail:<account>/<id>
  where?: string[];            // allowlist: Slack channels, Gmail labels, calendars, Drive folders, Zoom series
  area?: string;               // the area new notes from this source land in
  min_sensitivity?: Sensitivity; // floor for every fact from this source (Zoom defaults to private)
  max_per_day?: number;        // items stored per day (default 30)
  skip_bulk?: boolean;         // mail: false reads list, bulk and machine-sent mail too (default: skipped)
  every_minutes?: number;      // pull this source less often than poll_minutes (e.g. 1440: daily)
  // Mail another account forwards into this one: matched on the addresses the mail was delivered
  // to (Delivered-To, X-Forwarded-For), it keeps that account's name and area. A rule named only in
  // To or Cc, which the sender writes, gives its area and floor, never its account (itemFloor). Each
  // address is compared whole: "@school.example" is that domain exactly, "me@school.example" that
  // address. The floor is the highest of the source's and every matching rule's.
  forwarded?: { to: string; account: string; area?: string; min_sensitivity?: Sensitivity }[];
  fixture?: string;            // a JSON file of items in the source's own shape (tests, dry runs)
  address?: string;            // live Gmail: the mailbox's address; connect refuses any other account
  backfill_days?: number;      // live sources: how far back the first pass reads (default 2)
  guild?: string;              // discord: the server id, when where: names channels ("#dev")
  path?: string;               // texts, granola: a database or cache other than the Mac's default
  silent_after_hours?: number; // no proposal or re-confirmation this long is a failing probe check (default 72; 0: never)
  upcoming?: boolean;          // gcal: keep the coming 60 days' titles and times so next_* facts answer live (src/upcoming.ts)
  new_notes_per_day?: number;  // new notes proposed per day; the rest wait in inbox/held (default 3, backlog 396)
}
export interface SourcesFile { consent?: string; poll_minutes?: number; sources?: Record<string, SourceConfig> }

// The owner's consent line: an ISO date (YYYY-MM-DD) on or before today, optionally followed by a
// note ("2026-10-12 by text"). Anything else ("no", "pending", a future date) is not consent.
export function consentProblem(c: unknown): string | undefined {
  const s = c instanceof Date ? c.toISOString().slice(0, 10) : c === undefined || c === null ? "" : String(c).trim();
  if (!s) return "rules/sources.yaml needs the owner's consent: line first";
  const d = s.match(/^(\d{4}-\d{2}-\d{2})(?:\s.*)?$/)?.[1];
  const real = d && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);
  if (!real) return `consent: ${JSON.stringify(s.slice(0, 40))} isn't a date; the owner's consent: line is the day they agreed, as YYYY-MM-DD`;
  if (d > today()) return `consent: ${d} is after today; live sources start on that day`;
  return undefined;
}

// One item as the hub keeps it: the source's id, its version, and the text the model may see.
// delivered: the addresses the receiving server says it delivered to (a forwarded: rule matched here
// routes the item); named: To and Cc as the sender wrote them (a rule matched only here can tighten).
// A sender no person writes from (owner's phone, 2026-10-29: Apple receipts from a no-reply
// address, none of the list headers, filled "Waiting on you"): no-reply, receipts, orders,
// billing, invoices, payments, notifications, alerts, mailer-daemon, postmaster, bounces.
const MACHINE_LOCAL = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|notifications?|notify|alerts?|receipts?|orders?|billing|invoices?|payments?|mailer-daemon|postmaster|bounces?)(?:[-_.+].*)?$/i;
function machineSender(from: string | undefined): boolean {
  const addr = /<([^>]+)>/.exec(from ?? "")?.[1] ?? from ?? "";
  const local = addr.trim().split("@")[0] ?? "";
  return addr.includes("@") && MACHINE_LOCAL.test(local);
}

export interface SourceItem { id: string; version: string; text: string; at?: string; from?: string; to?: string; delivered?: string; named?: string; subject?: string; where?: string; gone?: boolean; bulk?: boolean }

export function loadSources(root: string): SourcesFile {
  return readYaml<SourcesFile>(join(root, "rules", "sources.yaml"), {});
}

// Mail never changes, so mail refs have no version; with several mailboxes the ref names the account.
export function refFor(kind: SourceKind, it: Pick<SourceItem, "id" | "version">, account?: string): string {
  if (kind === "gmail") return account ? `gmail:${account}/${it.id}` : `gmail:${it.id}`;
  if (kind === "mail") return `mail:${account ?? "mail"}/${it.id}`;
  return `${SCHEME[kind]}:${it.id}@${it.version}`;
}
export const idOfRef = (ref: string) => ref.replace(/@[^@/]*$/, "");

// ---------- the sources' own shapes -> SourceItem ----------
// Enough of each API's object for the pull: Slack conversations.history, Gmail messages.get,
// Calendar events.list, Drive revisions, Zoom transcripts. Fixtures use these same shapes.
type Raw = Record<string, any>;
export function toItem(kind: SourceKind, r: Raw): SourceItem | undefined {
  switch (kind) {
    case "slack": {
      if (!r.ts || !r.channel || r.subtype === "bot_message" || r.subtype === "channel_join") return undefined;
      const team = r.team ?? "T";
      return { id: `${team}/${r.channel}/${r.ts}`, version: r.edited?.ts ?? r.ts, text: String(r.text ?? ""), at: new Date(Number(r.ts) * 1000).toISOString(), from: r.user_email ?? r.user, where: r.channel_name ?? r.channel, gone: r.subtype === "message_deleted" };
    }
    case "gmail": {
      const all = (k: string) => (r.payload?.headers ?? []).filter((x: Raw) => String(x.name).toLowerCase() === k).map((x: Raw) => String(x.value ?? ""));
      const h = (k: string) => all(k)[0];
      const to = ["to", "delivered-to", "x-forwarded-for", "x-forwarded-to"].map(h).filter(Boolean).join(", ");
      // Delivered-To and X-Forwarded-For are what Gmail adds on receipt and on forwarding.
      const delivered = [...all("delivered-to"), ...all("x-forwarded-for")].join(", ");
      const named = [...all("to"), ...all("cc")].join(", ");
      // Mail to a list or from a machine (owner's phone, 2026-10-25: a social network's
      // notification became a card): List-Unsubscribe, List-Id, Precedence bulk/list/junk,
      // Auto-Submitted other than "no", or Gmail's Promotions, Social and Forums tabs.
      const labels: string[] = r.labelIds ?? [];
      const bulk = !!h("list-unsubscribe") || !!h("list-id") || /^(bulk|list|junk)$/i.test((h("precedence") ?? "").trim())
        || (!!h("auto-submitted") && !/^no$/i.test(h("auto-submitted")!.trim())) || labels.some((l) => /^CATEGORY_(PROMOTIONS|SOCIAL|FORUMS)$/.test(l))
        || machineSender(h("from"));
      return { id: String(r.id), version: "1", text: String(r.text ?? r.snippet ?? ""), at: r.internalDate ? new Date(Number(r.internalDate)).toISOString() : undefined, from: h("from"), to, delivered, named, subject: h("subject"), where: labels.join(","), gone: !!r.deleted, ...(bulk ? { bulk } : {}) };
    }
    case "mail": {
      const id = String(r.message_id ?? r.messageId ?? "").replace(/^<|>$/g, "");
      if (!id) return undefined;
      return { id, version: "1", text: String(r.text ?? ""), at: r.date ? new Date(r.date).toISOString() : undefined, from: r.from, to: [r.to, r.delivered_to].filter(Boolean).join(", "), delivered: r.delivered_to, named: [r.to, r.cc].filter(Boolean).join(", "), subject: r.subject, where: r.folder ?? "INBOX", gone: !!r.deleted };
    }
    case "imessage": {
      // A row of chat.db's message table joined to its handle and chat. where = the thread's name
      // or the other person's handle, so the allowlist names threads or contacts.
      if (!r.guid || r.item_type) return undefined;
      return { id: String(r.guid), version: r.date_edited ? String(r.date_edited) : "1", text: String(r.text ?? ""), at: r.date, from: r.is_from_me ? "me" : r.handle, ...(r.is_from_me && r.handle ? { to: String(r.handle) } : {}), where: r.chat ?? r.handle, gone: !!r.is_deleted };
    }
    case "granola": {
      // A document from Granola's cache (state.documents) or export: the AI notes, else the
      // owner's own notes, else the transcript. Version = updated_at.
      if (!r.id) return undefined;
      const text = r.notes_markdown ?? r.notes_plain ?? (Array.isArray(r.transcript) ? r.transcript.map((x: Raw) => x.text).join("\n") : r.transcript) ?? "";
      return { id: String(r.id), version: String(r.updated_at ?? r.created_at ?? "1"), text: String(text), at: r.created_at, subject: r.title, where: r.folder ?? "notes", gone: !!r.deleted_at };
    }
    case "gcal": {
      const when = r.start?.dateTime ?? r.start?.date;
      const text = [r.summary && `Event: ${r.summary}`, when && `When: ${when}`, r.location && `Where: ${r.location}`, r.description].filter(Boolean).join("\n");
      return { id: String(r.id), version: String(r.etag ?? r.updated ?? "1").replace(/"/g, ""), text, at: r.updated, subject: r.summary, where: r.calendar ?? "primary", gone: r.status === "cancelled" };
    }
    case "discord": {
      // Discord's message object (GET /channels/{id}/messages): read only, never posted to.
      if (!r.id || !r.channel_id || r.author?.bot || (r.type !== undefined && r.type !== 0 && r.type !== 19)) return undefined;
      return { id: `${r.channel_id}/${r.id}`, version: r.edited_timestamp ? String(Date.parse(r.edited_timestamp)) : "1", text: String(r.content ?? ""), at: r.timestamp, from: r.author?.username, where: r.channel_name ?? r.channel_id, gone: !!r.deleted };
    }
    case "gdoc":
      return { id: String(r.fileId ?? r.id), version: String(r.revisionId ?? r.version ?? "1"), text: String(r.text ?? ""), at: r.modifiedTime, subject: r.name, where: r.folder, gone: !!r.trashed || !!r.removed };
    case "zoom":
      return { id: String(r.uuid), version: "1", text: String(r.transcript ?? r.summary ?? ""), at: r.start_time, subject: r.topic, where: r.topic, gone: !!r.deleted };
    case "contacts":
      return cardItem(r);
  }
}

// ---------- state: what the hub has seen, per source ----------

// seen: id -> version. pending: no model yet. live: the source's own cursor (Gmail historyId).
// day/stored_today: the max_per_day count for that day. failed: id -> extraction attempts so far.
interface State { cursor?: string; live?: string; seen: Record<string, string>; pending?: string[]; day?: string; stored_today?: number; failed?: Record<string, number> }
const statePath = (root: string, name: string) => join(root, "log", "sources", `${name}.json`);
function loadState(root: string, name: string): State {
  const p = statePath(root, name);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { seen: {} };
}

// Every ref the hub has read at its source: what a pass, verify_source or a recheck recorded as
// found (log/refs-checked.jsonl), and every item a pull has seen (its state), which covers what was
// pulled before that log was kept. The write path ranks a ref of a kind the hub reads as exact only
// when it is here (G441).
export function hubReadRefs(root: string): Set<string> {
  const out = new Set<string>();
  for (const [ref, ok] of checkedRefs(root)) if (ok) out.add(ref);
  let file: SourcesFile;
  try { file = loadSources(root); } catch { return out; }
  for (const [name, cfg] of Object.entries(file.sources ?? {})) {
    let st: State;
    try { st = loadState(root, name); } catch { continue; }
    for (const [id, version] of Object.entries(st.seen ?? {})) out.add(refFor(cfg.kind, { id, version }, cfg.account));
  }
  return out;
}

// ---------- drift: a moved source turns its facts due ----------

function eachRecord(f: Fact, fn: (r: FactRecord) => void) {
  if (isList(f)) f.items.forEach(fn);
  else if (!("disputed" in (f as object))) fn(f as FactRecord);
}

// Does a live fact in `facts` (limited to `attrs`) cite this item, at any version?
export function cites(facts: Record<string, Fact>, attrs: Set<string> | "all", ref: string): boolean {
  let hit = false;
  for (const [a, f] of Object.entries(facts)) if (attrs === "all" || attrs.has(a)) eachRecord(f, (r) => {
    if (!r.valid_to && (r.sources ?? []).some((s) => idOfRef(refString(s)) === idOfRef(ref))) hit = true;
  });
  return hit;
}

// Every live fact citing exactly `ref` gets review_after today and the reason. Returns the notes changed.
// An item gone at its source (mail deleted, event cancelled, file removed): the fact turns due
// with "source gone", and when that item was its only source it stops claiming verified-by-source.
// The value and the note stay; a later read that finds the item saying it again restores it.
function goneAt(r: FactRecord, ref: string, day: string) {
  r.review_after = day;
  r.recheck = { why: "source gone", ref, at: day };
  if (r.verification !== "verified-by-source" || independentSources(r) > 1) return;
  r.verification = "unverified";
  r.note = `${r.note ? r.note + "; " : ""}verified-by-source until ${day}: source gone (${ref})`;
}

export function markDue(root: string, ref: string, why: string): string[] {
  const changed: string[] = [];
  for (const n of loadBrain(root)) {
    const keys: string[] = [];
    for (const [attr, f] of Object.entries(n.fm.facts ?? {})) eachRecord(f, (r) => {
      if (r.valid_to || !(r.sources ?? []).some((s) => refString(s) === ref)) return;
      if (why === "source gone") goneAt(r, ref, today());
      else { r.review_after = today(); r.recheck = { why, ref, at: today() }; }
      if (!keys.includes(attr)) keys.push(attr);
    });
    if (!keys.length) continue;
    saveNote(root, n);
    changed.push(n.path);
    // Every fact change gets its hash-chained line in log/writes.jsonl, like write() gives it.
    for (const a of keys) logWrite(root, { at: new Date().toISOString(), agent: "hub", kind: "source-due", key: `${n.fm.id}#${a}`, outcome: "committed", source: ref, why });
  }
  return changed;
}

// The text of the item being distilled, while its facts are extracted (set by distil). Only a
// pulled item can corroborate, and only a value whose every word it contains.
let grounding: string | undefined;
// corroborate() only confirms a value the text being read states; source backfill (src/backfill.ts)
// runs it against a mail it found by searching.
export function withGrounding<T>(text: string, fn: () => T): T {
  grounding = text;
  try { return fn(); } finally { grounding = undefined; }
}
const flatWords = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
export function groundedIn(value: unknown, text: string | undefined): boolean {
  if (!text) return false;
  const have = new Set(flatWords(text));
  const words = flatWords(typeof value === "string" ? value : JSON.stringify(value) ?? "").filter((w) => w.length >= 3 || /\d/.test(w));
  return words.length > 0 && words.every((w) => have.has(w));
}

// A pulled item repeats a value the brain holds: add the source (replacing an older version of
// the same item) and set last_confirmed. Never touches the value, never raises verification and
// never clears a recheck: those are the owner's (evals/gaps.ts G36). Committed as hub.
export function corroborate(root: string, noteId: string, attribute: string, matches: (r: FactRecord) => boolean, ref: string): string | undefined {
  const n = loadBrain(root).find((x) => x.fm.id === noteId);
  const f = n?.fm.facts?.[attribute];
  if (!n || !f) return undefined;
  let hit = false;
  eachRecord(f, (r) => {
    if (r.valid_to || !matches(r) || !groundedIn(r.value, grounding)) return;
    const others = (r.sources ?? []).filter((s) => idOfRef(refString(s)) !== idOfRef(ref));
    r.sources = [...others, ref];
    r.last_confirmed = today();
    hit = true;
  });
  if (!hit) return undefined;
  saveNote(root, n);
  logWrite(root, { at: new Date().toISOString(), agent: "hub", kind: "source-confirm", key: `${noteId}#${attribute}`, outcome: "committed", source: ref });
  git(root, ["add", n.path]);
  git(root, ["commit", "-q", "-m", `pull: ${ref} confirms ${noteId}#${attribute}\n\nAgent: hub\nKind: pull`], "hub");
  return n.path;
}

// ---------- one pass over one source ----------

export interface Preview { ref: string; account?: string; area?: string; floor?: Sensitivity; facts: { status: string; entity?: string; attribute?: string; value?: string }[]; skipped?: string }
// failed: items whose extraction threw this pass. deferred: items over max_per_day, read another day.
export interface PullResult { source: string; fetched: number; stored: string[]; skipped: number; due: string[]; refused?: string; extracted?: number; confirmed?: number; proposals?: number; preview?: Preview[]; more?: boolean; failed?: number; deferred?: number; capped?: boolean }

export function fetchFixture(root: string, cfg: SourceConfig): Raw[] {
  const p = isAbsolute(cfg.fixture!) ? cfg.fixture! : join(root, cfg.fixture!);
  const j = JSON.parse(readFileSync(p, "utf8"));
  return Array.isArray(j) ? j : (j.items ?? j.messages ?? []);
}

// Kinds added after the first consent line was written: the line must name them, so consent given
// for Gmail and Calendar never quietly extends to a new kind of private data.
const NAMED: Partial<Record<SourceKind, { label: string; word: RegExp }>> = { gdoc: { label: "Drive", word: /\bdrive\b/i }, contacts: { label: "Contacts", word: /\bcontacts?\b/i } };
const consentCovers = (consent: string, kind: SourceKind) => !NAMED[kind] || NAMED[kind]!.word.test(consent);
// Why a live source may not be read yet, as pullOne refuses it (doctor names the same, src/doctor.ts).
export function consentGap(file: SourcesFile, name: string, cfg: SourceConfig): string | undefined {
  const no = consentProblem(file.consent);
  if (no) return `${name} is a live source; ${no}`;
  if (!consentCovers(String(file.consent), cfg.kind)) return `${name}: the consent: line doesn't name ${NAMED[cfg.kind]!.label}; the owner adds it before anything is read`;
  return undefined;
}

const WORDS = 4; // shorter than this is chatter ("ok", "thanks!", an emoji)
const MAX_TRIES = 3; // an item whose extraction throws is tried this many passes, then skipped with an alert

type Fetched = Raw[] | { items: Raw[]; cursor?: string; more?: boolean };
// dryRun: read and extract, print what would happen, write nothing (no state, capture, proposal,
// fact change, alert or run line). It still reads real data, so a live source still needs consent.
// seen(id, version?): the hub has this item (at that version) and nothing about it is waiting.
type Seen = (id: string, version?: string) => boolean;
// known(id): the hub has read this item before, whether or not something about it is waiting.
type PullOpts = { upcoming?: (cfg: SourceConfig) => Raw[] | Promise<Raw[]>; fetch?: (cfg: SourceConfig, cursor?: string, seen?: Seen, known?: (id: string) => boolean) => Fetched | Promise<Fetched>; model?: Model | null; dryRun?: boolean };
const LIVE: Partial<Record<SourceKind, (cfg: SourceConfig, cursor?: string, seen?: Seen, known?: (id: string) => boolean) => Promise<Fetched>>> = {
  gmail: fetchGmail, gcal: fetchCalendar, gdoc: fetchDrive, discord: fetchDiscord,
  imessage: async (cfg, cursor, _seen, known) => fetchTexts(cfg, cursor, known), granola: async (cfg, cursor) => fetchGranola(cfg, cursor),
  contacts: async (cfg, cursor, seen) => (cfg.path ? fetchVcards(cfg, cursor) : fetchContacts(cfg, cursor, seen)),
};
export async function pullSource(root: string, name: string, opts: PullOpts = {}): Promise<PullResult> {
  let r: PullResult;
  try { r = await pullOne(root, name, opts); }
  catch (e) { r = { source: name, fetched: 0, stored: [], skipped: 0, due: [], refused: `${name}: ${(e as Error).message}` }; }
  if (opts.dryRun) return r;
  if (!r.refused) {
    try { await refreshUpcoming(root, name, opts.upcoming); }
    catch (e) { r = { ...r, refused: `${name}: coming events: ${(e as Error).message}` }; }
  }
  if (r.refused) failed(root, name, r.refused);
  appendJsonl(runsPath(root), { at: clock().toISOString(), ...r, preview: undefined });
  return r;
}

// A calendar the owner marked `upcoming: true`: its coming events, after a pull that read it (and so
// passed its consent check), into the read-time cache (src/upcoming.ts).
async function refreshUpcoming(root: string, name: string, fetch?: (cfg: SourceConfig) => Raw[] | Promise<Raw[]>) {
  const cfg = loadSources(root).sources?.[name];
  if (!cfg || cfg.kind !== "gcal" || !cfg.upcoming) return;
  const raw = fetch ? await fetch(cfg) : cfg.fixture ? fetchFixture(root, cfg) : await fetchUpcoming(cfg);
  saveUpcoming(root, name, raw.flatMap((r) => toUpcoming(r, name, cfg.min_sensitivity) ?? []));
}

async function pullOne(root: string, name: string, opts: PullOpts): Promise<PullResult> {
  const file = loadSources(root);
  const cfg = file.sources?.[name];
  const out: PullResult = { source: name, fetched: 0, stored: [], skipped: 0, due: [] };
  if (!cfg) return { ...out, refused: `no source ${name} in rules/sources.yaml` };
  if (!SCHEME[cfg.kind]) return { ...out, refused: `${name}: unknown kind ${cfg.kind}` };
  let fetchFn = opts.fetch;
  if (!fetchFn && !cfg.fixture) {
    // A live pull sends the owner's mail or messages to the extraction model: his consent first.
    const no = consentGap(file, name, cfg);
    if (no) return { ...out, refused: no };
    fetchFn = LIVE[cfg.kind];
    if (!fetchFn) return { ...out, refused: `${name}: live ${cfg.kind} fetching isn't built yet; use fixture: for now` };
  }
  // Yesterday's held new notes go first, within today's share (capture.ts releaseHeldDaily).
  releaseHeldDaily(root, name);
  const state = loadState(root, name);
  const waiting = (id: string) => (state.pending ?? []).includes(id) || id in (state.failed ?? {});
  const seen: Seen = (id, version) => id in state.seen && (version === undefined || state.seen[id] === version) && !waiting(id);
  const got = fetchFn ? await fetchFn(cfg, state.live, seen, (id) => id in state.seen) : fetchFixture(root, cfg);
  const raw = Array.isArray(got) ? got : got.items;
  const nextLive = Array.isArray(got) ? undefined : got.cursor;
  if (!Array.isArray(got) && got.more) out.more = true;
  // An item left waiting (over the cap, no model, a failed extraction) keeps the source's own
  // cursor where it was, so the next pass gets it again; the items already seen are skipped.
  let hold = false;
  const model = opts.model === undefined ? captureModel(root) : opts.model;
  const card = cfg.kind === "contacts";
  if (opts.dryRun) {
    if (!model && !card) return { ...out, refused: `${name}: a dry run needs the extraction model (rules/models.yaml capture.extract)` };
    out.preview = [];
  }
  // max_per_day is per day per source, kept in the state with its day (evals/gaps.ts G40).
  // Contacts: most cards name no page and store nothing, so a first read of an address book gets more room.
  const cap = cfg.max_per_day ?? (card ? 200 : 30);
  const by = `source:${name}`;
  const day = process.env.PB_TODAY ?? ownerDay(loadRules(root));
  if (state.day !== day) { state.day = day; state.stored_today = 0; }
  const contacts: Parameters<typeof recordInteraction>[1][] = [];
  const read: Record<string, boolean> = {}; // mail and events this pass read, recorded as checked (G417)
  const readFrom: Record<string, string | undefined> = {}; // the hash of each read item's sender (G643)
  const echo = cfg.kind === "imessage" ? channelThreads(root) : new Set<string>();
  // Contacts: the people the owner's own card names, the only new pages a card may start.
  const family = card ? ownerRelations(raw, loadRules(root), loadBrain(root)) : new Set<string>();
  for (const r of raw) {
    const it = toItem(cfg.kind, r);
    if (!it) { out.skipped++; continue; }
    // The hub's own texts to the owner (and his one-word replies) are never a source: they quote
    // proposals and sources, so reading them back would let a fact confirm itself.
    if (echo.size && [it.where, it.from, it.to].some((h) => h && echo.has(handleKey(h)))) { state.seen[it.id] = it.version; out.skipped++; continue; }
    out.fetched++;
    const prev = state.seen[it.id];
    // A deleted item has lost its labels; it was allowed when it was read, which `prev` records.
    if (it.gone) {
      if (prev && !opts.dryRun) {
        const was = refFor(cfg.kind, { id: it.id, version: prev }, cfg.account);
        out.due.push(...markDue(root, was, "source gone")); delete state.seen[it.id];
        if (cfg.kind === "gmail" || cfg.kind === "gcal" || card) read[was] = false;
      }
      continue;
    }
    if (cfg.where?.length && !(it.where ?? "").split(",").some((w) => cfg.where!.includes(w))) {
      // Mail or an event outside the allowlist is marked seen (its id and version, nothing else),
      // so a flood of it can't hold the cursor or be fetched again (evals/gaps.ts G41).
      if (!opts.dryRun && (cfg.kind === "gmail" || cfg.kind === "gcal")) state.seen[it.id] = it.version;
      out.skipped++; continue;
    }
    // List and machine mail carries no fact of the owner's: seen, never sent to a model.
    if (it.bulk && cfg.skip_bulk !== false) { if (!opts.dryRun) state.seen[it.id] = it.version; out.skipped++; continue; }
    if (prev === it.version && !waiting(it.id)) { out.skipped++; continue; }
    if (opts.dryRun) {
      if (it.text.split(/\s+/).filter(Boolean).length < WORDS) { out.skipped++; continue; }
      const { fwd, floor, area } = itemFloor(cfg, it);
      const ref = refFor(cfg.kind, it, cfg.account);
      const pv: Preview = { ref, account: fwd?.account ?? cfg.account, area, floor, facts: [] };
      const held = findInjection(it.text) ?? (it.subject ? findInjection(it.subject) : undefined);
      if (held) pv.skipped = `held: ${held}`;
      else if (card) pv.facts = previewCard(root, r, it.text, family);
      else pv.facts = (await previewExtraction(root, redactSecrets([it.subject, it.text].filter(Boolean).join("\n")).text, model!, cfg.kind)).map((i) => ({ status: i.status, entity: i.candidate?.entity, attribute: i.candidate?.attribute, value: i.candidate?.value === undefined ? undefined : String(i.candidate.value) }));
      out.preview!.push(pv);
      out.extracted = (out.extracted ?? 0) + 1;
      continue;
    }
    const short = it.text.split(/\s+/).filter(Boolean).length < WORDS;
    // Over today's cap: not seen, not touched; it waits for tomorrow's count.
    if (!short && (state.stored_today ?? 0) >= cap) { out.skipped++; out.deferred = (out.deferred ?? 0) + 1; hold = true; out.capped = true; continue; }
    // Who wrote and who the owner answered, for standing suggestions (addresses and times only).
    if (!prev && STANDING_KINDS.has(cfg.kind)) {
      const sent = cfg.kind === "imessage" ? it.from === "me" : cfg.kind === "gmail" ? (it.where ?? "").split(",").includes("SENT") : /^sent\b/i.test(it.where ?? "");
      contacts.push({ kind: cfg.kind, from: it.from, to: it.to ?? (cfg.kind === "imessage" ? it.where : undefined), at: it.at, sent });
    }
    if (prev && prev !== it.version) out.due.push(...markDue(root, refFor(cfg.kind, { id: it.id, version: prev }, cfg.account), "source changed"));
    state.seen[it.id] = it.version;
    if (cfg.kind === "gmail" || cfg.kind === "gcal" || card) { const ref = refFor(cfg.kind, it, cfg.account); read[ref] = true; readFrom[ref] = senderHash(it.from); }
    if (it.at && (!state.cursor || it.at > state.cursor)) state.cursor = it.at;
    if (short) { out.skipped++; continue; }
    const ref = refFor(cfg.kind, it, cfg.account);
    const { fwd, named, floor: fl, area } = itemFloor(cfg, it);
    let d: Awaited<ReturnType<typeof distil>> | ReturnType<typeof distilCard>;
    try {
      // G420: known/unknown, never the address. A mail or text with no sender to name is unknown,
      // never left without the field: a capture without one is judged as if from before G420.
      const sender = STANDING_KINDS.has(cfg.kind) ? senderStanding(root, it.from) ?? "unknown" : undefined;
      d = card ? distilCard(root, it, r, ref, { source: name, source_kind: cfg.kind, by, area: area ?? (loadRules(root).policy.areas?.personal ? "personal" : undefined), ...(fl ? { min_sensitivity: fl } : {}) }, family) : await distil(root, it, ref, { source: name, source_kind: cfg.kind, by, ...(sender ? { sender } : {}), ...(fwd ? { forwarded_from: fwd.account } : {}), ...(named ? { addressed_to: named.account } : {}), ...(area ? { area } : {}), ...(fl ? { min_sensitivity: fl } : {}) }, model);
    } catch (e) {
      // One item's bad model answer (or any throw) fails that item, not the pass (evals/gaps.ts G42).
      out.failed = (out.failed ?? 0) + 1;
      const tries = (state.failed?.[it.id] ?? 0) + 1;
      const failedNow = { ...(state.failed ?? {}) };
      if (tries >= MAX_TRIES) {
        delete failedNow[it.id];
        alert(root, { agent: by, check: "source_item_failed", from: `${ref}: extraction failed ${tries} times (${String((e as Error)?.message ?? e).slice(0, 160)}); skipped, nothing stored` });
      } else { failedNow[it.id] = tries; hold = true; }
      state.failed = failedNow;
      continue;
    }
    if (state.failed && it.id in state.failed) { const { [it.id]: _, ...rest } = state.failed; state.failed = rest; }
    if (d.outcome === "pending") { state.pending = [...new Set([...(state.pending ?? []), it.id])]; out.skipped++; hold = true; continue; }
    state.pending = (state.pending ?? []).filter((x) => x !== it.id);
    if (d.outcome !== "done") { out.skipped++; continue; }
    out.stored.push(d.file!); state.stored_today = (state.stored_today ?? 0) + 1;
    out.extracted = (out.extracted ?? 0) + 1;
    out.confirmed = (out.confirmed ?? 0) + d.items!.filter((i) => i.status === "known" && i.confirmed).length;
    out.proposals = (out.proposals ?? 0) + d.items!.filter((i) => i.proposal).length;
  }
  if (opts.dryRun) return out;
  if (Object.keys(read).length) recordCheckedRefs(root, read, readFrom);
  if (nextLive && !hold) state.live = nextLive;
  if (out.capped) delete out.more;
  mkdirSync(join(root, "log", "sources"), { recursive: true });
  writeFileSync(statePath(root, name), JSON.stringify(state, null, 2) + "\n");
  // Oldest first, whatever order the source listed them in, so reply delays come out right.
  // Recorded once the state is saved, so a pass that fails midway doesn't count anything twice.
  for (const c of contacts.sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")))) {
    try { recordInteraction(root, c); } catch (e) { console.error(`standing signals: ${(e as Error).message}`); }
  }
  git(root, ["add", "-A", "log/sources", ...new Set(out.due)]);
  git(root, ["commit", "-q", "-m", `pull: ${name} (${out.stored.length} stored, ${new Set(out.due).size} notes due)\n\nAgent: ${by}\nKind: pull`], by);
  out.due = [...new Set(out.due)];
  return out;
}

export async function pullAll(root: string, opts: { model?: Model | null } = {}): Promise<PullResult[]> {
  const out: PullResult[] = [];
  const runs = pullRuns(root);
  for (const [name, cfg] of Object.entries(loadSources(root).sources ?? {})) {
    const last = runs.filter((r) => r.source === name).at(-1)?.at;
    if (cfg.every_minutes && last && Date.now() - Date.parse(last) < cfg.every_minutes * 60_000) continue;
    out.push(await pullSource(root, name, opts));
  }
  if (out.length) await preverifyInbox(root);
  return out;
}

// An item's sensitivity floor. Transcripts and texts are mostly other people's words: private
// unless the owner lowers it. Mail forwarded from another account takes the higher of the two floors.
// A forwarded: rule matched on a delivery address picks the item's account and area (G37: never To,
// which the sender writes). Mail Gmail fetched or a correspondent wrote to that account names it
// only in To or Cc (G364): a rule matched only there gives its area and floor, never its account,
// and its floor joins any other, so a sender can raise an item's floor but never lower one. Each
// address is compared whole; when several rules match, the one with the highest floor wins.
const addresses = (s?: string) => (s ?? "").toLowerCase().match(/[^\s<>,;:"'()[\]]+@[^\s<>,;:"'()[\]]+/g) ?? [];
export function forwardMatches(rule: string, address: string): boolean {
  const r = rule.trim().toLowerCase();
  if (!r) return false;
  if (r.startsWith("@") || !r.includes("@")) { const dom = r.replace(/^@/, ""); return address.slice(address.lastIndexOf("@") + 1) === dom; }
  return address === r;
}
export function itemFloor(cfg: SourceConfig, it: SourceItem) {
  const base = cfg.min_sensitivity ?? (["zoom", "imessage", "granola"].includes(cfg.kind) ? "private" as Sensitivity : undefined);
  const rank = (s?: Sensitivity) => (s ? sensitivityRank(s) : -1);
  type Rule = NonNullable<SourceConfig["forwarded"]>[number];
  const best = (got: string[]) => (cfg.forwarded ?? []).filter((f) => got.some((a) => forwardMatches(String(f.to ?? ""), a)))
    .reduce<Rule | undefined>((b, f) => (!b || rank(f.min_sensitivity) > rank(b.min_sensitivity) ? f : b), undefined);
  const fwd = best(addresses(it.delivered));
  const byName = best(addresses(it.named));
  const named = fwd ? undefined : byName;
  const floor = [base, fwd?.min_sensitivity, byName?.min_sensitivity].filter((x): x is Sensitivity => !!x).sort((a, b) => sensitivityRank(b) - sensitivityRank(a))[0];
  return { fwd, named, floor, area: fwd?.area ?? named?.area ?? cfg.area };
}

export function floorFor(floor: Sensitivity | undefined, noteSens?: Sensitivity): Sensitivity | undefined {
  if (!floor) return undefined;
  return noteSens && sensitivityRank(noteSens) >= sensitivityRank(floor) ? undefined : floor;
}

// ---------- distil: facts in, never a copy ----------
// The brain is a portable memory layer, not a mirror of the owner's mailbox or chats. A pulled
// item's text is held in memory only: secrets blanked, injection shapes refused, then extraction.
// What lands in the brain is the facts (each citing the ref) and a capture record with the ref and
// what came of it. The text stays in the source; verify_source reads it there when needed.
const MAX_BYTES = 64 * 1024;
export async function distil(root: string, it: SourceItem, ref: string, fm: Record<string, unknown>, model: Model | null): Promise<{ outcome: "done" | "pending" | "held" | "duplicate"; file?: string; items?: CaptureItem[] }> {
  const text = redactSecrets(it.text).text.slice(0, MAX_BYTES);
  // The subject (a mail's Subject, an invite or document title) is content too: it is used, with
  // secrets blanked, only to name who an item is about, and never stored (evals/gaps.ts G38).
  const subject = it.subject ? redactSecrets(it.subject).text : undefined;
  const hash = createHash("sha256").update(compareKey(text)).digest("hex").slice(0, 8);
  const prior = findCapture(root, hash);
  // A record still pending is a pull the hub was stopped in the middle of: extract it again.
  if (prior && unfinishedPull(readCapture(root, prior).fm)) rmSync(join(root, prior), { force: true });
  else if (prior) return { outcome: "duplicate" };
  const inj = findInjection(text) ?? (it.subject ? findInjection(it.subject) : undefined);
  if (inj) { alert(root, { agent: String(fm.by), check: "source_held", from: `${ref}: ${inj}; nothing sent to a model, nothing stored` }); return { outcome: "held" }; }
  if (!model) return { outcome: "pending" };
  const received = it.at?.slice(0, 10) && it.at.slice(0, 10) <= today() ? it.at.slice(0, 10) : today();
  const id = `${received}-${hash}`;
  const rel = `inbox/captures/${id}.md`;
  // The keys of the names the item uses (hashes, never the words): the page writer links a page
  // whose fact cites this item to the other pages it names (src/wiki.ts, src/mentions.ts nameKeys).
  const keys = nameKeys([text, subject].filter(Boolean).join("\n"));
  const head = { id, kind: "text", received, stored: today(), via: "source", ...fm, source_ref: ref, ...(keys.length ? { name_keys: keys } : {}), status: "pending" };
  mkdirSync(join(root, "inbox", "captures"), { recursive: true });
  writeFileSync(join(root, rel), `---\n${YAML.stringify(head, { lineWidth: 0 })}---\nNot kept here: pocketBrain stores the facts, not a copy. The original is at ${ref}.\n`);
  grounding = text;
  try {
    return { outcome: "done", file: rel, items: await extractCapture(root, rel, model, text, [subject, it.where].filter(Boolean).join("\n")) };
  } catch (e) {
    rmSync(join(root, rel), { force: true }); // uncommitted; pullOne counts the failure and retries
    throw e;
  } finally { grounding = undefined; }
}

// A contact card, read by code (src/contacts.ts): the same capture record and filing as a pulled
// mail's facts, with no model. A card that would file nothing (no page it names, nothing new)
// leaves no record at all.
export function distilCard(root: string, it: SourceItem, raw: Raw, ref: string, fm: Record<string, unknown>, family: Set<string>): { outcome: "done" | "held" | "duplicate" | "empty"; file?: string; items?: CaptureItem[] } {
  const c = readCard(raw);
  if (!c) return { outcome: "empty" };
  const text = redactSecrets(it.text).text.slice(0, MAX_BYTES);
  const inj = findInjection(text);
  if (inj) { alert(root, { agent: String(fm.by), check: "source_held", from: `${ref}: ${inj}; nothing stored` }); return { outcome: "held" }; }
  const rules = loadRules(root), notes = loadBrain(root);
  const cands = cardCandidates(c, rules, notes);
  const adjust = (x: CaptureItem) => cardAdjust(x, notes, family);
  const useful = cands.map((x) => adjust(checkCandidate(x, text, notes, rules) as CaptureItem)).some((x) => typeof x !== "string" && ["known", "changes", "new-fact", "new-note"].includes(x.status));
  if (!useful) return { outcome: "empty" };
  const hash = createHash("sha256").update(compareKey(text)).digest("hex").slice(0, 8);
  if (findCapture(root, hash)) return { outcome: "duplicate" };
  const received = it.at?.slice(0, 10) && it.at.slice(0, 10) <= today() ? it.at.slice(0, 10) : today();
  const id = `${received}-${hash}`;
  const rel = `inbox/captures/${id}.md`;
  const keys = nameKeys(text);
  const head = { id, kind: "text", received, stored: today(), via: "source", ...fm, source_ref: ref, ...(keys.length ? { name_keys: keys } : {}), status: "pending" };
  mkdirSync(join(root, "inbox", "captures"), { recursive: true });
  writeFileSync(join(root, rel), `---\n${YAML.stringify(head, { lineWidth: 0 })}---\nNot kept here: pocketBrain stores the facts, not a copy. The card is at ${ref}.\n`);
  try { return { outcome: "done", file: rel, items: withGrounding(text, () => fileCard(root, rel, text, cands, adjust)) }; }
  catch (e) { rmSync(join(root, rel), { force: true }); throw e; }
}
// What a card would file, for `sources pull --dry-run`: nothing stored.
function previewCard(root: string, raw: Raw, text: string, family: Set<string>): Preview["facts"] {
  const c = readCard(raw);
  if (!c) return [];
  const rules = loadRules(root), notes = loadBrain(root);
  return cardCandidates(c, rules, notes).map((x) => {
    const a = cardAdjust(checkCandidate(x, text, notes, rules) as CaptureItem, notes, family);
    return typeof a === "string" ? { status: "dropped", entity: x.entity, attribute: x.attribute } : { status: a.status, entity: a.candidate.entity, attribute: a.candidate.attribute, ...(["emails", "phones"].includes(a.candidate.attribute) ? {} : { value: a.candidate.value }) };
  });
}

// ---------- running unattended ----------

// One line per pass in log/sources/runs.jsonl: what the digest and `week` count.
const runsPath = (root: string) => join(root, "log", "sources", "runs.jsonl");
export const pullRuns = (root: string) => readJsonl<PullResult & { at: string }>(runsPath(root));

// `start` asks every minute; a pass is due every poll_minutes (sources.yaml, default 15).
export function pullsDue(root: string, now = new Date()): boolean {
  const file = loadSources(root);
  if (!Object.keys(file.sources ?? {}).length) return false;
  const last = pullRuns(root).at(-1)?.at;
  return !last || now.getTime() - Date.parse(last) >= (file.poll_minutes ?? 15) * 60_000;
}

// A source that can't be read says so in the digest, once a day per source and reason, never
// silently: an expired token or a missing consent line is the owner's to fix.
function failed(root: string, name: string, why: string) {
  const rules = loadRules(root), day = ownerDay(rules); // the owner's day (src/clock.ts)
  const seen = readJsonl<Record<string, unknown>>(join(root, "log", "alerts.jsonl"))
    .some((a) => a.check === "source_failed" && typeof a.at === "string" && ownerDay(rules, a.at) === day && a.agent === `source:${name}` && a.from === why);
  if (!seen) alert(root, { agent: `source:${name}`, check: "source_failed", from: why });
}

// The digest's line: what the pulls did since `from`.
export function pullSummary(root: string, from: string): string | undefined {
  const runs = pullRuns(root).filter((r) => r.at >= from);
  if (!runs.length) return undefined;
  const sum = (k: "confirmed" | "proposals") => runs.reduce((s, r) => s + (r[k] ?? 0), 0);
  const stored = runs.reduce((s, r) => s + r.stored.length, 0);
  const due = new Set(runs.flatMap((r) => r.due)).size;
  const bad = [...new Set(runs.filter((r) => r.refused).map((r) => r.source))];
  return `- Sources: ${stored} item(s) read, ${sum("confirmed")} fact(s) confirmed, ${sum("proposals")} proposal(s), ${due} note(s) due because a source moved${bad.length ? `; failing: ${bad.join(", ")}` : ""}`;
}

// ---------- verify: one cited item, for the gardener ----------
// The gardener never gets a connector or a search. It names one ref an agent cited and the claim
// made from it; the hub fetches that one item, through the same allowlist, and answers match,
// no-match or unreachable, with a short quote. The check is words, not a model: every number in
// the claim must be in the item, and most of its words.

export type Verdict = "match" | "no-match" | "unreachable";
// dated: the item's own day (the owner's day it was sent or last changed), the as_of for a newer
// value it states (G375).
export interface VerifyResult { ref: string; result: Verdict; quote?: string; dated?: string; why: string; confirmed?: string[]; due?: string[]; elsewhere?: string[] }
export const VERIFY_PER_DAY = 40;

const KIND_OF: Record<string, SourceKind> = { gmail: "gmail", mail: "mail", imessage: "imessage", granola: "granola", gcal: "gcal", gdoc: "gdoc", slack: "slack", zoom: "zoom", discord: "discord", contacts: "contacts" };
function parseRef(ref: string): { kind: SourceKind; id: string; version?: string; account?: string } | undefined {
  const t = ref.trim();
  const mailM = t.match(/^(gmail|mail):(?:([^/]+)\/)?(.+)$/);
  if (mailM) return mailM[1] === "mail" && !mailM[2] ? undefined : { kind: mailM[1] as SourceKind, id: mailM[3], account: mailM[2] };
  const m = t.match(/^([a-z]+):(.+?)(?:@([^@/]+))?$/);
  const kind = m ? KIND_OF[m[1]] : undefined;
  return kind ? { kind, id: m![2], version: m![3] } : undefined;
}

// The one item a ref names, read through a listed source of that kind, or why it can't be.
// A mail or calendar ref the hub read, or found missing or gone, is recorded as checked
// (log/refs-checked.jsonl, src/louis.ts): the write path lets only such refs replace a value (G417).
export async function fetchOne(root: string, ref: string): Promise<(SourceItem & { floor?: Sensitivity }) | string> {
  const out = await fetchOneItem(root, ref);
  if (EXACT_REF.test(ref)) {
    // Only the version the hub holds counts as read: a ref naming another version of a real
    // calendar event (made up, or old) is left unchecked rather than vouched for.
    const v = parseRef(ref)?.version;
    const ok = typeof out === "object" ? (v && v !== out.version ? undefined : !out.gone) : /not found in the/.test(out) ? false : undefined;
    if (ok !== undefined) recordCheckedRefs(root, { [ref]: ok }, { [ref]: typeof out === "object" ? senderHash(out.from) : undefined });
  }
  return out;
}
const EXACT_REF = /^(gmail|gmail-thread|gcal):/;
const outside = (cfg: SourceConfig, it: SourceItem) => !!cfg.where?.length && !(it.where ?? "").split(",").some((w) => cfg.where!.includes(w));
// An item the hub read from this source under its allowlist and captured (its capture record in
// inbox/captures names the source and the item) may be read again by verify_source whatever its
// labels are now: archived mail leaves INBOX (Gardener night 2026-10-27, G457). An item only
// skipped as outside the allowlist is marked seen but was never read, so it has no capture record.
function capturedFrom(root: string, source: string, kind: SourceKind, id: string): boolean {
  const dir = join(root, "inbox", "captures");
  if (!existsSync(dir)) return false;
  const scheme = SCHEME[kind];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    let head: string;
    try { head = readFileSync(join(dir, f), "utf8").split(/^---$/m)[1] ?? ""; } catch { continue; }
    const src = head.match(/^source: (.+)$/m)?.[1]?.trim(), at = head.match(/^source_ref: (.+)$/m)?.[1]?.trim();
    if (src !== source || !at) continue;
    const p = parseRef(at);
    if (p && p.kind === kind && p.id === id && at.startsWith(`${scheme}:`)) return true;
  }
  return false;
}

async function fetchOneItem(root: string, ref: string): Promise<(SourceItem & { floor?: Sensitivity }) | string> {
  const r = parseRef(ref);
  if (!r) return `${ref} isn't a ref the hub can read (gmail:, mail:, imessage:, granola:, gcal:, gdoc:, discord:, contacts:)`;
  const file = loadSources(root);
  const listed = Object.entries(file.sources ?? {}).filter(([, s]) => s.kind === r.kind && (!r.account || s.account === r.account));
  if (!listed.length) return `no ${r.kind} source${r.account ? ` for ${r.account}` : ""} in rules/sources.yaml`;
  for (const [name, cfg] of listed) {
    if (!cfg.fixture) continue;
    const it = fetchFixture(root, cfg).map((x) => toItem(r.kind, x)).find((x) => x?.id === r.id);
    if (!it) continue;
    if (it.gone) return { id: it.id, version: it.version, text: "", gone: true };
    if (outside(cfg, it) && !capturedFrom(root, name, r.kind, it.id)) return `${ref} is outside the allowlist`;
    return { ...it, floor: itemFloor(cfg, it).floor };
  }
  const live = listed.filter(([, s]) => !s.fixture);
  if (!live.length) return `${ref} not found in the ${r.kind} source`;
  const no = consentProblem(file.consent);
  if (no) return `no valid consent for live sources: ${no}`;
  if (!consentCovers(file.consent!, r.kind)) return `the consent: line doesn't name ${NAMED[r.kind]!.label}`;
  const one: Partial<Record<SourceKind, (cfg: SourceConfig, id: string) => Promise<Raw | undefined>>> = {
    gmail: fetchGmailMessage, gcal: fetchCalendarEvent, gdoc: fetchDriveFile, discord: fetchDiscordMessage,
    imessage: async (cfg, id) => fetchText(cfg, id), granola: async (cfg, id) => fetchGranolaNote(cfg, id),
    contacts: async (cfg, id) => cfg.path ? fetchVcards(cfg).items.find((x) => x.resourceName === id) ?? { resourceName: id, metadata: { deleted: true } } : fetchContact(cfg, id),
  };
  const get = one[r.kind];
  if (!get) return `live ${r.kind} reading isn't built yet`;
  // Gone (deleted, cancelled, not found) counts only when every listed source says so: the item
  // may live in another listed account. A gone item carries no text, so no allowlist applies.
  let gone: SourceItem | undefined;
  for (const [name, cfg] of live) {
    const m = await get(cfg, r.id);
    const it = m && toItem(r.kind, m);
    if (!it) continue;
    if (it.gone) { gone = { id: it.id, version: it.version, text: "", gone: true }; continue; }
    if (outside(cfg, it) && !capturedFrom(root, name, r.kind, it.id)) return `${ref} is outside the allowlist`;
    return { ...it, floor: itemFloor(cfg, it).floor };
  }
  return gone ?? `${ref} not found in the ${r.kind} source`;
}

const flat = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
const claimWords = (claim: string) => flat(claim).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 || /\d/.test(w));
// The quote is source text handed to a model (the gardener, a proposal the owner's agents may
// read), so it is redacted, checked for injection whole (before it is cut, so a cut can't hide
// the instruction), and capped. One that reads as instructions is withheld (G90).
export const QUOTE_MAX = 200;
// G194: redacted whole before it is cut into lines. A key's body line alone reads as any base64
// run, so redacting the chosen line only let it through. Every BEGIN/END block (a key, a PGP block,
// a certificate; to the end of the text when it never ends) goes first, then the secret shapes.
const ARMOR = /-----BEGIN [^\n]*?-----[\s\S]*?(?:-----END [^\n]*?-----|$)/g;
export function checkClaim(raw: string, claim: string): { result: "match" | "no-match"; quote?: string; withheld?: string } {
  const text = redactSecrets(raw.replace(ARMOR, "[removed: armored block]")).text;
  const t = flat(text);
  const words = claimWords(claim);
  const nums = words.filter((w) => /\d/.test(w));
  const found = words.filter((w) => t.includes(w));
  const ok = words.length > 0 && nums.every((n) => t.includes(n)) && found.length / words.length >= 0.6;
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
  const best = sentences.map((s) => ({ s, n: words.filter((w) => flat(s).includes(w)).length })).sort((a, b) => b.n - a.n)[0]?.s ?? "";
  const result = ok ? "match" : "no-match";
  const quote = best.trim();
  const inj = findInjection(quote);
  if (inj) return { result, withheld: `reads as instructions (${inj})` };
  return { result, quote: quote.slice(0, QUOTE_MAX) };
}

// `ceiling`: the caller's sensitivity ceiling. Above it the verdict still comes back, the quote doesn't.
// `recheck`: also check every fact citing the item (recheckFacts), limited to `recheck` (the caller's view).
// What verify_source checks a claim against: the item's text, less a contact card's emails and phones.
const verifiable = (ref: string, text: string) => (parseRef(ref)?.kind === "contacts" ? withoutDetails(text) : text);
export async function verifySource(root: string, agent: string, ref: string, claim: string, cap = VERIFY_PER_DAY, ceiling?: Sensitivity, recheck?: (noteId: string, attr: string) => boolean): Promise<VerifyResult> {
  const rules = loadRules(root), now = clock(), day = ownerDay(rules, now); // the owner's day (src/clock.ts)
  const used = readJsonl<{ at: string; agent: string }>(verifyLog(root)).filter((e) => e.agent === agent && typeof e.at === "string" && ownerDay(rules, e.at) === day).length;
  let out: VerifyResult;
  let withheld: string | undefined;
  if (used >= cap) out = { ref, result: "unreachable", why: `${cap} checks today is the cap; the rest wait for tomorrow night` };
  else {
    let it: Awaited<ReturnType<typeof fetchOne>>;
    try { it = await fetchOne(root, ref); } catch (e) { it = (e as Error).message; }
    if (typeof it === "string") out = { ref, result: "unreachable", why: it };
    else if (it.gone) {
      out = { ref, result: "no-match", why: "source gone: the item was deleted, cancelled or isn't at the source any more" };
      if (recheck) { const r = recheckFacts(root, ref, null, recheck); if (r.due.length) out.due = r.due; }
    }
    else {
      const want = parseRef(ref)?.version;
      // A contact card's emails and phones are held until Show: never checked or quoted here.
      const c = checkClaim(verifiable(ref, [it.subject, it.text].filter(Boolean).join("\n")), claim);
      const above = ceiling && it.floor && sensitivityRank(it.floor) > sensitivityRank(ceiling);
      const dated = it.at && !above ? [ownerDay(rules, it.at), day].sort()[0] : undefined; // never after the brain's day
      out = { ref, result: c.result, ...(above || !c.quote ? {} : { quote: c.quote }), ...(dated ? { dated } : {}), why: c.result === "match" ? "the item says this" : "the item doesn't say this" };
      if (above) out.why += ` (no quote: the source is ${it.floor}, above your ${ceiling} level)`;
      else if (c.withheld) { out.why += ` (quote withheld: ${c.withheld})`; withheld = c.withheld; }
      if (want && want !== it.version && it.version !== "1") out.why += ` (the item changed since ${want}; read version ${it.version})`;
      if (recheck) {
        const r = recheckFacts(root, ref, [it.subject, it.text].filter(Boolean).join("\n"), recheck);
        if (r.confirmed.length) out.confirmed = r.confirmed;
        if (r.due.length) out.due = r.due;
        if (r.elsewhere) { out.elsewhere = r.elsewhere; out.why += `; it says ${r.elsewhere.join(", ")}'s value only about someone else, so that fact wasn't confirmed: check whether it changed`; }
      }
    }
  }
  appendJsonl(verifyLog(root), { at: now.toISOString(), agent, ref, result: out.result, claim: claimKey(claim), ...(withheld ? { withheld } : {}) });
  return out;
}

// Does the cited item say this value? The hub reads it as verify_source does, by the same word
// check, for a write that cites it (src/core.ts gardenerSourceSays). Nothing of the item comes
// back. A value the word check can't judge, a ref the hub can't read or an unreachable source is
// "unknown": the write goes on as before.
export async function itemSays(root: string, ref: string, value: unknown): Promise<"says" | "not" | "gone" | "unknown"> {
  if (!parseRef(ref) || !wordCheckable(value)) return "unknown";
  let it: Awaited<ReturnType<typeof fetchOne>>;
  try { it = await fetchOne(root, ref); } catch { return "unknown"; }
  if (typeof it === "string") return "unknown";
  if (it.gone) return "gone";
  return checkClaim([it.subject, it.text].filter(Boolean).join("\n"), String(value)).result === "match" ? "says" : "not";
}

// ---------- corroborate: each fact checked against the item it cites ----------
// Whenever the hub reads a cited item (verify_source, or upkeep's recheck below), every live fact
// citing that item is checked against the item's own words, by the fact's own value, never by the
// caller's claim. Still said: re-confirmed, last_confirmed today, and a recheck this item raised is
// cleared. Not said any more (or the item is gone): due today, with the reason. The value never
// changes; a new value comes from a pull or a proposal. Values the word check can't judge (an ISO
// date, a short word, a list or object) are left alone. `allow` limits it to a caller's view.
const wordCheckable = (v: unknown): v is string | number =>
  (typeof v === "string" || typeof v === "number") && !/^\d{4}(-\d{2}){0,2}$/.test(String(v).trim()) && claimWords(String(v)).length > 0;

const namedSentence = (text: string, name: string, value: string) => {
  const names = flatWords(name).filter((w) => w.length >= 3);
  return text.split(/(?<=[.!?])\s+|\n+/).some((s) => flatWords(s).some((w) => names.includes(w)) && checkClaim(s, value).result === "match");
};

// The sentence of `text` that says `value` (naming `name` when given), as checkClaim quotes it;
// none when it reads as instructions.
function saidIn(text: string, value: string, name?: string): string | undefined {
  const names = name === undefined ? [] : flatWords(name).filter((w) => w.length >= 3);
  const s = text.split(/(?<=[.!?])\s+|\n+/).find((x) => checkClaim(x, value).result === "match" && (!names.length || flatWords(x).some((w) => names.includes(w))));
  const c = checkClaim(s ?? text, value);
  return c.withheld ? undefined : c.quote || undefined;
}

export function recheckFacts(root: string, ref: string, text: string | null, allow?: (noteId: string, attr: string) => boolean): { confirmed: string[]; due: string[]; files: string[]; elsewhere?: string[] } {
  const id = idOfRef(ref), day = today();
  const confirmed = new Set<string>(), due = new Set<string>(), elsewhere = new Set<string>(), files: string[] = [];
  // A replica writes nothing here: the hub rechecks on its own pass, against its own notes.
  const role = hubRole(root).mode;
  if (role !== "single" && role !== "hub") return { confirmed: [], due: [], files };
  for (const n of loadBrain(root)) {
    if (n.fm.status !== "active") continue;
    let changed = false;
    for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
      if (allow && !allow(n.fm.id, attr)) continue;
      const key = `${n.fm.id}#${attr}`;
      eachRecord(f, (r) => {
        if (r.valid_to || !(r.sources ?? []).some((s) => idOfRef(refString(s)) === id)) return;
        if (text !== null && !wordCheckable(r.value)) return;
        const said = text !== null && checkClaim(text, String(r.value)).result === "match";
        // A person's value counts only from a sentence that names them: "Sam takes over as course
        // coordinator" doesn't confirm Jane as coordinator. Said only about someone else: left alone.
        if (said && n.fm.type === "person" && !namedSentence(text!, n.fm.title ?? "", String(r.value))) { elsewhere.add(key); return; }
        if (said) {
          // The sentence that says it is kept as the source's own words, owner-only and outside
          // git, so the page can show what the source said (real-brain north star, 2026-10-30).
          const words = saidIn(text!, String(r.value), n.fm.type === "person" ? n.fm.title ?? "" : undefined);
          if (words) keepWords(root, [ref], words);
          r.last_confirmed = day;
          if (r.verification === "unverified" || r.verification === "self-reported") r.verification = "verified-by-source";
          if (r.recheck && idOfRef(r.recheck.ref) === id) { delete r.recheck; delete r.review_after; }
          confirmed.add(key);
        } else {
          if (text === null) goneAt(r, ref, day);
          else { r.review_after = day; r.recheck = { why: "the source no longer says this", ref, at: day }; }
          due.add(key);
        }
        changed = true;
      });
    }
    if (changed) { saveNote(root, n); files.push(n.path); }
  }
  const at = new Date().toISOString();
  for (const key of confirmed) logWrite(root, { at, agent: "hub", kind: "source-confirm", key, outcome: "committed", source: ref });
  for (const key of due) logWrite(root, { at, agent: "hub", kind: "source-due", key, outcome: "committed", source: ref, why: "recheck" });
  if (files.length) {
    git(root, ["add", ...files]);
    git(root, ["commit", "-q", "-m", `hub: rechecked ${confirmed.size + due.size} fact(s) against ${ref} (${confirmed.size} confirmed, ${due.size} due)\n\nAgent: hub\nKind: pull\nFact-Keys: ${[...confirmed, ...due].join(", ")}`, "--", ...files], "hub");
  }
  return { confirmed: [...confirmed], due: [...due], files, ...(elsewhere.size ? { elsewhere: [...elsewhere] } : {}) };
}

// Upkeep's own recheck: due and stale facts that cite an item the hub can read are checked at
// that item, at most `max` items a pass, without a model. A fact already flagged by that item
// waits for an owner or a new value instead of spending a check every night.
export const RECHECK_PER_PASS = 20;
export interface Recheck { checked: number; confirmed: string[]; due: string[]; unreachable: number; sampled: number }
// Each pass also checks that a few more cited items still exist (sampleRefs), beyond the candidates.
export const SAMPLE_PER_PASS = 10;
// Cited items read each night only to keep the words a fact was drawn from.
export const WORDS_PER_PASS = 10;
// `allow` limits which facts it picks and touches (the gardener's view when it runs upkeep_run).
// What rides on a weak fact (backlog 310, docs/gardener.md "What gets rechecked first"). Agent
// reads per note over the last `days` days, the gardener's own reads left out: it reads to tend.
export function readCounts(root: string, days = 30, end = today()): Map<string, number> {
  const f = join(root, "log", "reads.jsonl"), out = new Map<string, number>();
  if (!existsSync(f)) return out;
  const since = new Date(Date.parse(`${end}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const skip = new Set(gardeners(loadRules(root)));
  for (const e of readJsonl<{ at?: string; agent?: string; ids?: string[] }>(f)) {
    const d = String(e.at ?? "").slice(0, 10);
    if (d < since || d > end || skip.has(String(e.agent))) continue;
    for (const id of new Set(e.ids ?? [])) out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}
// Sources that are different items: two versions of one mail are one source.
export const independentSources = (r: Pick<FactRecord, "sources">) => new Set((r.sources ?? []).map((x) => idOfRef(refString(x)))).size;
// Below an exact source (sourceRank in src/sources.ts): self-reported, relayed, inferred, vague.
const weakBacking = (r: FactRecord) => sourceRank(r) < 3;
// A fresh fact on one source that agents read is rechecked too, once a month at most.
export const RECONFIRM_DAYS = 30;

export interface RecheckPick { ref: string; keys: string[]; score: [number, number, number, number] }
// The refs a recheck pass reads, most at stake first: facts on a single source, then weakly
// backed ones, then the most read, then the most overdue. Candidates are due and stale facts,
// plus fresh single-source facts agents read that weren't confirmed in RECONFIRM_DAYS (never the
// owner's word). Ties keep the brain's order.
export function recheckCandidates(root: string, opts: { allow?: (noteId: string, attr: string) => boolean } = {}): RecheckPick[] {
  const rules = loadRules(root), now = today(), reads = readCounts(root, RECONFIRM_DAYS, now);
  const cutoff = new Date(Date.parse(`${now}T00:00:00Z`) - RECONFIRM_DAYS * 86_400_000).toISOString().slice(0, 10);
  const picks = new Map<string, RecheckPick>();
  const better = (a: RecheckPick["score"], b: RecheckPick["score"]) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
  for (const n of loadBrain(root)) {
    if (n.fm.status !== "active") continue;
    const read = reads.get(n.fm.id) ?? 0;
    for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
      if (opts.allow && !opts.allow(n.fm.id, attr)) continue;
      const fr = factFreshness(f, attributeSpec(rules, n.fm.type, attr), now);
      const overdue = fr === "stale" ? 2 : fr === "due" ? 1 : 0;
      if (fr === "disputed") continue;
      eachRecord(f, (r) => {
        if (r.valid_to || !wordCheckable(r.value)) return;
        const single = independentSources(r) < 2;
        const unconfirmed = !r.last_confirmed || r.last_confirmed < cutoff;
        if (!overdue && !(single && read > 0 && unconfirmed && !r.recheck && sourceRank(r) < 5)) return;
        const score: RecheckPick["score"] = [single ? 1 : 0, weakBacking(r) ? 1 : 0, read, overdue];
        for (const s of (r.sources ?? []).map((x) => refString(x))) {
          if (!parseRef(s) || (r.recheck && idOfRef(r.recheck.ref) === idOfRef(s))) continue;
          const id = idOfRef(s), have = picks.get(id);
          if (!have) { picks.set(id, { ref: s, keys: [`${n.fm.id}#${attr}`], score }); continue; }
          if (!have.keys.includes(`${n.fm.id}#${attr}`)) have.keys.push(`${n.fm.id}#${attr}`);
          if (better(score, have.score)) have.score = score;
        }
      });
    }
  }
  const all = [...picks.values()];
  return all.map((p, i) => [p, i] as const).sort(([a, i], [b, j]) => (better(a.score, b.score) ? -1 : better(b.score, a.score) ? 1 : i - j)).map(([p]) => p);
}

// Dead source refs: the items cited by live facts in view that this pass doesn't already read, the
// ones checked longest ago (or never) first, so over the nights every cited item gets looked at,
// fresh facts nobody reads included. A fact already flagged by an item doesn't put it back.
export function sampleRefs(root: string, opts: { allow?: (noteId: string, attr: string) => boolean; skip?: Set<string> } = {}): string[] {
  const last = new Map<string, string>();
  for (const e of readJsonl<{ at?: string; ref?: string }>(verifyLog(root))) {
    if (typeof e.ref !== "string" || typeof e.at !== "string") continue;
    const id = idOfRef(e.ref);
    if ((last.get(id) ?? "") < e.at) last.set(id, e.at);
  }
  const rules = loadRules(root), now = today(), refs = new Map<string, string>();
  for (const n of loadBrain(root)) {
    if (n.fm.status !== "active") continue;
    for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
      if (opts.allow && !opts.allow(n.fm.id, attr)) continue;
      if (factFreshness(f, attributeSpec(rules, n.fm.type, attr), now) === "disputed") continue;
      eachRecord(f, (r) => {
        if (r.valid_to) return;
        for (const s of (r.sources ?? []).map((x) => refString(x))) {
          const id = idOfRef(s);
          if (!parseRef(s) || opts.skip?.has(id) || refs.has(id) || (r.recheck && idOfRef(r.recheck.ref) === id)) continue;
          refs.set(id, s);
        }
      });
    }
  }
  return [...refs].map(([id, ref], i) => ({ ref, at: last.get(id) ?? "", i })).sort((a, b) => a.at.localeCompare(b.at) || a.i - b.i).map((x) => x.ref);
}

// Cited items the hub can read whose words it never kept, from live facts the word check can
// judge, newest recorded first.
export function wordlessRefs(root: string, allow?: (noteId: string, attr: string) => boolean): string[] {
  // An item read lately and still without words (it didn't say the value, or couldn't be reached)
  // waits as long as a confirmation lasts.
  const since = new Date(clock().getTime() - RECONFIRM_DAYS * 86_400_000).toISOString();
  const seen = new Set(readJsonl<{ at?: string; ref?: string }>(verifyLog(root)).filter((e) => typeof e.ref === "string" && String(e.at ?? "") >= since).map((e) => idOfRef(e.ref!)));
  const picks: { ref: string; at: string }[] = [];
  for (const n of loadBrain(root)) {
    if (n.fm.status !== "active") continue;
    for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
      if (allow && !allow(n.fm.id, attr)) continue;
      eachRecord(f, (r) => {
        if (r.valid_to || r.recheck || !wordCheckable(r.value)) return;
        for (const s of (r.sources ?? []).map((x) => refString(x))) {
          if (!parseRef(s) || seen.has(idOfRef(s)) || keptQuotes(root, s).length) continue;
          seen.add(idOfRef(s)); picks.push({ ref: s, at: String(r.recorded ?? r.as_of ?? "") });
        }
      });
    }
  }
  return picks.sort((a, b) => b.at.localeCompare(a.at)).map((p) => p.ref);
}

export async function recheckDue(root: string, opts: { max?: number; sample?: number; allow?: (noteId: string, attr: string) => boolean } = {}): Promise<Recheck> {
  const max = opts.max ?? RECHECK_PER_PASS;
  const out: Recheck = { checked: 0, confirmed: [], due: [], unreachable: 0, sampled: 0 };
  if (!Object.keys(loadSources(root).sources ?? {}).length) return out;
  const refs = recheckCandidates(root, { allow: opts.allow }).map((p) => p.ref).slice(0, Math.max(0, max));
  for (const ref of refs) {
    let it: Awaited<ReturnType<typeof fetchOne>>;
    try { it = await fetchOne(root, ref); } catch (e) { it = (e as Error).message; }
    out.checked++;
    if (typeof it === "string") { out.unreachable++; appendJsonl(verifyLog(root), { at: new Date().toISOString(), agent: "hub", ref, result: "unreachable" }); continue; }
    const r = recheckFacts(root, ref, it.gone ? null : [it.subject, it.text].filter(Boolean).join("\n"), opts.allow);
    out.confirmed.push(...r.confirmed);
    out.due.push(...r.due);
    appendJsonl(verifyLog(root), { at: new Date().toISOString(), agent: "hub", ref, result: r.confirmed.length ? "match" : "no-match" });
  }
  // Existence only: an item still there changes nothing; one gone turns its facts due.
  const sample = sampleRefs(root, { allow: opts.allow, skip: new Set(refs.map(idOfRef)) }).slice(0, Math.max(0, opts.sample ?? SAMPLE_PER_PASS));
  for (const ref of sample) {
    let it: Awaited<ReturnType<typeof fetchOne>>;
    try { it = await fetchOne(root, ref); } catch (e) { it = (e as Error).message; }
    out.sampled++;
    if (typeof it === "string") { out.unreachable++; appendJsonl(verifyLog(root), { at: new Date().toISOString(), agent: "hub", ref, result: "unreachable" }); continue; }
    if (it.gone) out.due.push(...recheckFacts(root, ref, null, opts.allow).due);
    appendJsonl(verifyLog(root), { at: new Date().toISOString(), agent: "hub", ref, result: it.gone ? "gone" : "present" });
  }
  return out;
}

// A few cited items whose words were never kept, newest fact first, read only so a page can show
// what its sources said, not only the hub's text (real-brain north star, 2026-10-30). Reading one
// checks every fact citing it, as any read does (recheckFacts). Returns how many were read.
export async function keepSourceWords(root: string, opts: { max?: number; allow?: (noteId: string, attr: string) => boolean } = {}): Promise<number> {
  const role = hubRole(root).mode;
  if ((role !== "single" && role !== "hub") || !Object.keys(loadSources(root).sources ?? {}).length) return 0;
  let n = 0;
  for (const ref of wordlessRefs(root, opts.allow).slice(0, Math.max(0, opts.max ?? WORDS_PER_PASS))) {
    let it: Awaited<ReturnType<typeof fetchOne>>;
    try { it = await fetchOne(root, ref); } catch (e) { it = (e as Error).message; }
    n++;
    if (typeof it === "string") { appendJsonl(verifyLog(root), { at: new Date().toISOString(), agent: "hub", ref, result: "unreachable" }); continue; }
    const r = recheckFacts(root, ref, it.gone ? null : [it.subject, it.text].filter(Boolean).join("\n"), opts.allow);
    appendJsonl(verifyLog(root), { at: new Date().toISOString(), agent: "hub", ref, result: it.gone ? "gone" : r.confirmed.length ? "match" : "no-match" });
  }
  return n;
}

// Inbox proposals whose only evidence is a link (an agent citing an email or an event) are checked
// before the owner sees them; a mismatch is flagged in the proposal and as an alert. Pulled
// captures are skipped: their quote was already checked against the text.
export async function preverifyInbox(root: string): Promise<{ checked: number; mismatched: string[] }> {
  const dir = join(root, "inbox");
  const out = { checked: 0, mismatched: [] as string[] };
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".yaml"))) {
    const p = YAML.parse(readFileSync(join(dir, f), "utf8")) ?? {};
    const refs = ((p.request?.sources ?? []) as unknown[]).map((s) => refString(s as never));
    if (p.source_check || (p.checks ?? []).includes("capture") || !refs.length || !refs.every((r) => parseRef(r)) || typeof p.request?.value !== "string") continue;
    const results: VerifyResult[] = [];
    for (const r of refs) results.push(await verifySource(root, "hub", r, p.request.value, Infinity));
    const best = results.find((r) => r.result === "match") ?? results.find((r) => r.result === "no-match") ?? results[0];
    p.source_check = { result: best.result, ref: best.ref, why: best.why, at: today() };
    // The source sentence itself is kept nowhere (G98): the verdict is what the owner reads.
    writeFileSync(join(dir, f), YAML.stringify(p, { lineWidth: 0 }));
    out.checked++;
    if (best.result === "no-match") { out.mismatched.push(f); alert(root, { agent: String(p.by ?? p.request?.agent ?? "agent"), check: "source_mismatch", from: `${f}: ${best.ref} doesn't say "${String(p.request.value).slice(0, 80)}"` }); }
  }
  if (out.checked) { git(root, ["add", "-A", "inbox"]); git(root, ["commit", "-q", "-m", `pull: checked ${out.checked} proposal(s) against their cited source\n\nAgent: hub\nKind: pull`], "hub"); }
  return out;
}
