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
import { readYaml, loadRules, attributeSpec } from "./rules";
import { hubRole } from "./hub";
import { factFreshness } from "./freshness";
import { git } from "./git";
import { alert, appendJsonl, readJsonl } from "./util";
import { verifyLog, claimKey } from "./evidence";
import { loadEscalation } from "./textline/policy";
import { refString } from "./sources";
import { extractCapture, captureModel, findCapture, previewExtraction, readCapture, unfinishedPull, type CaptureItem } from "./capture";
import { fetchGmail, fetchGmailMessage, fetchCalendar, fetchCalendarEvent, fetchDrive, fetchDriveFile } from "./google";
import { fetchDiscord, fetchDiscordMessage, fetchTexts, fetchText, fetchGranola, fetchGranolaNote } from "./feeds";
import { findInjection, redactSecrets } from "./checks";
import { compareKey } from "./normalize";
import { logWrite } from "./write";
import { createHash } from "node:crypto";
import type { Model } from "./model";
import { recordInteraction } from "./standing";

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
export type SourceKind = "slack" | "gmail" | "mail" | "gcal" | "gdoc" | "zoom" | "discord" | "imessage" | "granola";
// The ref scheme per kind. Gmail messages never change, so their ref has no version.
export const SCHEME: Record<SourceKind, string> = { slack: "slack", gmail: "gmail", mail: "mail", imessage: "imessage", granola: "granola", gcal: "gcal", gdoc: "gdoc", zoom: "zoom", discord: "discord" };

export interface SourceConfig {
  kind: SourceKind;
  account?: string;            // which mailbox (one source per account): named in its refs, gmail:<account>/<id>
  where?: string[];            // allowlist: Slack channels, Gmail labels, calendars, Drive folders, Zoom series
  area?: string;               // the area new notes from this source land in
  min_sensitivity?: Sensitivity; // floor for every fact from this source (Zoom defaults to private)
  max_per_day?: number;        // items stored per day (default 30)
  every_minutes?: number;      // pull this source less often than poll_minutes (e.g. 1440: daily)
  // Mail another account forwards into this one: matched on the addresses the mail was delivered
  // to (Delivered-To, X-Forwarded-For; never To or X-Forwarded-To, which the sender writes), each
  // compared whole: "@school.example" is that domain exactly, "me@school.example" that address.
  // It keeps that account's name and area; the floor is the highest of the source's and the rules'.
  forwarded?: { to: string; account: string; area?: string; min_sensitivity?: Sensitivity }[];
  fixture?: string;            // a JSON file of items in the source's own shape (tests, dry runs)
  address?: string;            // live Gmail: the mailbox's address; connect refuses any other account
  backfill_days?: number;      // live sources: how far back the first pass reads (default 2)
  guild?: string;              // discord: the server id, when where: names channels ("#dev")
  path?: string;               // texts, granola: a database or cache other than the Mac's default
  silent_after_hours?: number; // no proposal or re-confirmation this long is a failing probe check (default 72; 0: never)
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
// delivered: the addresses the receiving server says it delivered to (forwarded: rules match these only).
export interface SourceItem { id: string; version: string; text: string; at?: string; from?: string; to?: string; delivered?: string; subject?: string; where?: string; gone?: boolean }

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
      return { id: String(r.id), version: "1", text: String(r.text ?? r.snippet ?? ""), at: r.internalDate ? new Date(Number(r.internalDate)).toISOString() : undefined, from: h("from"), to, delivered, subject: h("subject"), where: (r.labelIds ?? []).join(","), gone: !!r.deleted };
    }
    case "mail": {
      const id = String(r.message_id ?? r.messageId ?? "").replace(/^<|>$/g, "");
      if (!id) return undefined;
      return { id, version: "1", text: String(r.text ?? ""), at: r.date ? new Date(r.date).toISOString() : undefined, from: r.from, to: [r.to, r.delivered_to].filter(Boolean).join(", "), delivered: r.delivered_to, subject: r.subject, where: r.folder ?? "INBOX", gone: !!r.deleted };
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
export function markDue(root: string, ref: string, why: string): string[] {
  const changed: string[] = [];
  for (const n of loadBrain(root)) {
    const keys: string[] = [];
    for (const [attr, f] of Object.entries(n.fm.facts ?? {})) eachRecord(f, (r) => {
      if (r.valid_to || !(r.sources ?? []).some((s) => refString(s) === ref)) return;
      r.review_after = today();
      r.recheck = { why, ref, at: today() };
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
const NAMED: Partial<Record<SourceKind, { label: string; word: RegExp }>> = { gdoc: { label: "Drive", word: /\bdrive\b/i } };
const consentCovers = (consent: string, kind: SourceKind) => !NAMED[kind] || NAMED[kind]!.word.test(consent);

const WORDS = 4; // shorter than this is chatter ("ok", "thanks!", an emoji)
const MAX_TRIES = 3; // an item whose extraction throws is tried this many passes, then skipped with an alert

type Fetched = Raw[] | { items: Raw[]; cursor?: string; more?: boolean };
// dryRun: read and extract, print what would happen, write nothing (no state, capture, proposal,
// fact change, alert or run line). It still reads real data, so a live source still needs consent.
// seen(id, version?): the hub has this item (at that version) and nothing about it is waiting.
type Seen = (id: string, version?: string) => boolean;
type PullOpts = { fetch?: (cfg: SourceConfig, cursor?: string, seen?: Seen) => Fetched | Promise<Fetched>; model?: Model | null; dryRun?: boolean };
const LIVE: Partial<Record<SourceKind, (cfg: SourceConfig, cursor?: string, seen?: Seen) => Promise<Fetched>>> = {
  gmail: fetchGmail, gcal: fetchCalendar, gdoc: fetchDrive, discord: fetchDiscord,
  imessage: async (cfg, cursor) => fetchTexts(cfg, cursor), granola: async (cfg, cursor) => fetchGranola(cfg, cursor),
};
export async function pullSource(root: string, name: string, opts: PullOpts = {}): Promise<PullResult> {
  let r: PullResult;
  try { r = await pullOne(root, name, opts); }
  catch (e) { r = { source: name, fetched: 0, stored: [], skipped: 0, due: [], refused: `${name}: ${(e as Error).message}` }; }
  if (opts.dryRun) return r;
  if (r.refused) failed(root, name, r.refused);
  appendJsonl(runsPath(root), { at: new Date().toISOString(), ...r, preview: undefined });
  return r;
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
    const no = consentProblem(file.consent);
    if (no) return { ...out, refused: `${name} is a live source; ${no}` };
    if (!consentCovers(file.consent!, cfg.kind)) return { ...out, refused: `${name}: the consent: line doesn't name ${NAMED[cfg.kind]!.label}; the owner adds it before anything is read` };
    fetchFn = LIVE[cfg.kind];
    if (!fetchFn) return { ...out, refused: `${name}: live ${cfg.kind} fetching isn't built yet; use fixture: for now` };
  }
  const state = loadState(root, name);
  const waiting = (id: string) => (state.pending ?? []).includes(id) || id in (state.failed ?? {});
  const seen: Seen = (id, version) => id in state.seen && (version === undefined || state.seen[id] === version) && !waiting(id);
  const got = fetchFn ? await fetchFn(cfg, state.live, seen) : fetchFixture(root, cfg);
  const raw = Array.isArray(got) ? got : got.items;
  const nextLive = Array.isArray(got) ? undefined : got.cursor;
  if (!Array.isArray(got) && got.more) out.more = true;
  // An item left waiting (over the cap, no model, a failed extraction) keeps the source's own
  // cursor where it was, so the next pass gets it again; the items already seen are skipped.
  let hold = false;
  const model = opts.model === undefined ? captureModel(root) : opts.model;
  if (opts.dryRun) {
    if (!model) return { ...out, refused: `${name}: a dry run needs the extraction model (rules/models.yaml capture.extract)` };
    out.preview = [];
  }
  // max_per_day is per day per source, kept in the state with its day (evals/gaps.ts G40).
  const cap = cfg.max_per_day ?? 30;
  const by = `source:${name}`;
  if (state.day !== today()) { state.day = today(); state.stored_today = 0; }
  const contacts: Parameters<typeof recordInteraction>[1][] = [];
  const echo = cfg.kind === "imessage" ? channelThreads(root) : new Set<string>();
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
      if (prev && !opts.dryRun) { out.due.push(...markDue(root, refFor(cfg.kind, { id: it.id, version: prev }, cfg.account), "source gone")); delete state.seen[it.id]; }
      continue;
    }
    if (cfg.where?.length && !(it.where ?? "").split(",").some((w) => cfg.where!.includes(w))) {
      // Mail or an event outside the allowlist is marked seen (its id and version, nothing else),
      // so a flood of it can't hold the cursor or be fetched again (evals/gaps.ts G41).
      if (!opts.dryRun && (cfg.kind === "gmail" || cfg.kind === "gcal")) state.seen[it.id] = it.version;
      out.skipped++; continue;
    }
    if (prev === it.version && !waiting(it.id)) { out.skipped++; continue; }
    if (opts.dryRun) {
      if (it.text.split(/\s+/).filter(Boolean).length < WORDS) { out.skipped++; continue; }
      const { fwd, floor } = itemFloor(cfg, it);
      const ref = refFor(cfg.kind, it, cfg.account);
      const pv: Preview = { ref, account: fwd?.account ?? cfg.account, area: fwd?.area ?? cfg.area, floor, facts: [] };
      const held = findInjection(it.text) ?? (it.subject ? findInjection(it.subject) : undefined);
      if (held) pv.skipped = `held: ${held}`;
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
    if (it.at && (!state.cursor || it.at > state.cursor)) state.cursor = it.at;
    if (short) { out.skipped++; continue; }
    const ref = refFor(cfg.kind, it, cfg.account);
    const { fwd, floor: fl } = itemFloor(cfg, it);
    const area = fwd?.area ?? cfg.area;
    let d: Awaited<ReturnType<typeof distil>>;
    try {
      d = await distil(root, it, ref, { source: name, source_kind: cfg.kind, by, ...(fwd ? { forwarded_from: fwd.account } : {}), ...(area ? { area } : {}), ...(fl ? { min_sensitivity: fl } : {}) }, model);
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
// A forwarded: rule matches only the delivery addresses (never To, which the sender writes), each
// address whole; when several rules match, the one with the highest floor wins (evals/gaps.ts G37).
const addresses = (s?: string) => (s ?? "").toLowerCase().match(/[^\s<>,;:"'()[\]]+@[^\s<>,;:"'()[\]]+/g) ?? [];
export function forwardMatches(rule: string, address: string): boolean {
  const r = rule.trim().toLowerCase();
  if (!r) return false;
  if (r.startsWith("@") || !r.includes("@")) { const dom = r.replace(/^@/, ""); return address.slice(address.lastIndexOf("@") + 1) === dom; }
  return address === r;
}
export function itemFloor(cfg: SourceConfig, it: SourceItem) {
  const base = cfg.min_sensitivity ?? (["zoom", "imessage", "granola"].includes(cfg.kind) ? "private" as Sensitivity : undefined);
  const got = addresses(it.delivered);
  const rank = (s?: Sensitivity) => (s ? sensitivityRank(s) : -1);
  const fwd = (cfg.forwarded ?? []).filter((f) => got.some((a) => forwardMatches(String(f.to ?? ""), a)))
    .reduce<NonNullable<SourceConfig["forwarded"]>[number] | undefined>((best, f) => (!best || rank(f.min_sensitivity) > rank(best.min_sensitivity) ? f : best), undefined);
  const floor = [base, fwd?.min_sensitivity].filter((x): x is Sensitivity => !!x).sort((a, b) => sensitivityRank(b) - sensitivityRank(a))[0];
  return { fwd, floor };
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
  const head = { id, kind: "text", received, stored: today(), via: "source", ...fm, source_ref: ref, status: "pending" };
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
  const day = new Date().toISOString().slice(0, 10);
  const seen = readJsonl<Record<string, unknown>>(join(root, "log", "alerts.jsonl"))
    .some((a) => a.check === "source_failed" && String(a.at).startsWith(day) && a.agent === `source:${name}` && a.from === why);
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
export interface VerifyResult { ref: string; result: Verdict; quote?: string; why: string; confirmed?: string[]; due?: string[]; elsewhere?: string[] }
export const VERIFY_PER_DAY = 40;

const KIND_OF: Record<string, SourceKind> = { gmail: "gmail", mail: "mail", imessage: "imessage", granola: "granola", gcal: "gcal", gdoc: "gdoc", slack: "slack", zoom: "zoom", discord: "discord" };
function parseRef(ref: string): { kind: SourceKind; id: string; version?: string; account?: string } | undefined {
  const t = ref.trim();
  const mailM = t.match(/^(gmail|mail):(?:([^/]+)\/)?(.+)$/);
  if (mailM) return mailM[1] === "mail" && !mailM[2] ? undefined : { kind: mailM[1] as SourceKind, id: mailM[3], account: mailM[2] };
  const m = t.match(/^([a-z]+):(.+?)(?:@([^@/]+))?$/);
  const kind = m ? KIND_OF[m[1]] : undefined;
  return kind ? { kind, id: m![2], version: m![3] } : undefined;
}

// The one item a ref names, read through a listed source of that kind, or why it can't be.
export async function fetchOne(root: string, ref: string): Promise<(SourceItem & { floor?: Sensitivity }) | string> {
  const r = parseRef(ref);
  if (!r) return `${ref} isn't a ref the hub can read (gmail:, mail:, imessage:, granola:, gcal:, gdoc:, discord:)`;
  const file = loadSources(root);
  const listed = Object.entries(file.sources ?? {}).filter(([, s]) => s.kind === r.kind && (!r.account || s.account === r.account));
  if (!listed.length) return `no ${r.kind} source${r.account ? ` for ${r.account}` : ""} in rules/sources.yaml`;
  for (const [, cfg] of listed) {
    if (!cfg.fixture) continue;
    const it = fetchFixture(root, cfg).map((x) => toItem(r.kind, x)).find((x) => x?.id === r.id);
    if (!it) continue;
    if (cfg.where?.length && !(it.where ?? "").split(",").some((w) => cfg.where!.includes(w))) return `${ref} is outside the allowlist`;
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
  };
  const get = one[r.kind];
  if (!get) return `live ${r.kind} reading isn't built yet`;
  for (const [, cfg] of live) {
    const m = await get(cfg, r.id);
    const it = m && toItem(r.kind, m);
    if (!it) continue;
    if (cfg.where?.length && !(it.where ?? "").split(",").some((w) => cfg.where!.includes(w))) return `${ref} is outside the allowlist`;
    return { ...it, floor: itemFloor(cfg, it).floor };
  }
  return `${ref} not found in the ${r.kind} source`;
}

const flat = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
const claimWords = (claim: string) => flat(claim).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 || /\d/.test(w));
// The quote is source text handed to a model (the gardener, a proposal the owner's agents may
// read), so it is redacted, checked for injection whole (before it is cut, so a cut can't hide
// the instruction), and capped. One that reads as instructions is withheld (G90).
export const QUOTE_MAX = 200;
export function checkClaim(text: string, claim: string): { result: "match" | "no-match"; quote?: string; withheld?: string } {
  const t = flat(text);
  const words = claimWords(claim);
  const nums = words.filter((w) => /\d/.test(w));
  const found = words.filter((w) => t.includes(w));
  const ok = words.length > 0 && nums.every((n) => t.includes(n)) && found.length / words.length >= 0.6;
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
  const best = sentences.map((s) => ({ s, n: words.filter((w) => flat(s).includes(w)).length })).sort((a, b) => b.n - a.n)[0]?.s ?? "";
  const result = ok ? "match" : "no-match";
  const quote = redactSecrets(best.trim()).text;
  const inj = findInjection(quote) ?? findInjection(best);
  if (inj) return { result, withheld: `reads as instructions (${inj})` };
  return { result, quote: quote.slice(0, QUOTE_MAX) };
}

// `ceiling`: the caller's sensitivity ceiling. Above it the verdict still comes back, the quote doesn't.
// `recheck`: also check every fact citing the item (recheckFacts), limited to `recheck` (the caller's view).
export async function verifySource(root: string, agent: string, ref: string, claim: string, cap = VERIFY_PER_DAY, ceiling?: Sensitivity, recheck?: (noteId: string, attr: string) => boolean): Promise<VerifyResult> {
  const day = new Date().toISOString().slice(0, 10);
  const used = readJsonl<{ at: string; agent: string }>(verifyLog(root)).filter((e) => e.agent === agent && e.at.startsWith(day)).length;
  let out: VerifyResult;
  let withheld: string | undefined;
  if (used >= cap) out = { ref, result: "unreachable", why: `${cap} checks today is the cap; the rest wait for tomorrow night` };
  else {
    let it: Awaited<ReturnType<typeof fetchOne>>;
    try { it = await fetchOne(root, ref); } catch (e) { it = (e as Error).message; }
    if (typeof it === "string") out = { ref, result: "unreachable", why: it };
    else if (it.gone) {
      out = { ref, result: "no-match", why: "the item was deleted or cancelled" };
      if (recheck) { const r = recheckFacts(root, ref, null, recheck); if (r.due.length) out.due = r.due; }
    }
    else {
      const want = parseRef(ref)?.version;
      const c = checkClaim([it.subject, it.text].filter(Boolean).join("\n"), claim);
      const above = ceiling && it.floor && sensitivityRank(it.floor) > sensitivityRank(ceiling);
      out = { ref, result: c.result, ...(above || !c.quote ? {} : { quote: c.quote }), why: c.result === "match" ? "the item says this" : "the item doesn't say this" };
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
  appendJsonl(verifyLog(root), { at: new Date().toISOString(), agent, ref, result: out.result, claim: claimKey(claim), ...(withheld ? { withheld } : {}) });
  return out;
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
          r.last_confirmed = day;
          if (r.verification === "unverified" || r.verification === "self-reported") r.verification = "verified-by-source";
          if (r.recheck && idOfRef(r.recheck.ref) === id) { delete r.recheck; delete r.review_after; }
          confirmed.add(key);
        } else {
          r.review_after = day;
          r.recheck = { why: text === null ? "the source item was deleted or cancelled" : "the source no longer says this", ref, at: day };
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
export interface Recheck { checked: number; confirmed: string[]; due: string[]; unreachable: number }
// `allow` limits which facts it picks and touches (the gardener's view when it runs upkeep_run).
export async function recheckDue(root: string, opts: { max?: number; allow?: (noteId: string, attr: string) => boolean } = {}): Promise<Recheck> {
  const max = opts.max ?? RECHECK_PER_PASS;
  const out: Recheck = { checked: 0, confirmed: [], due: [], unreachable: 0 };
  if (!Object.keys(loadSources(root).sources ?? {}).length) return out;
  const rules = loadRules(root), now = today();
  const refs: string[] = [];
  for (const n of loadBrain(root)) {
    if (n.fm.status !== "active") continue;
    for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
      if (opts.allow && !opts.allow(n.fm.id, attr)) continue;
      const fr = factFreshness(f, attributeSpec(rules, n.fm.type, attr), now);
      if (fr !== "due" && fr !== "stale") continue;
      eachRecord(f, (r) => {
        if (r.valid_to || !wordCheckable(r.value)) return;
        for (const s of (r.sources ?? []).map((x) => refString(x))) {
          if (!parseRef(s) || (r.recheck && idOfRef(r.recheck.ref) === idOfRef(s)) || refs.some((x) => idOfRef(x) === idOfRef(s))) continue;
          refs.push(s);
        }
      });
    }
  }
  for (const ref of refs.slice(0, Math.max(0, max))) {
    let it: Awaited<ReturnType<typeof fetchOne>>;
    try { it = await fetchOne(root, ref); } catch (e) { it = (e as Error).message; }
    out.checked++;
    if (typeof it === "string") { out.unreachable++; appendJsonl(verifyLog(root), { at: new Date().toISOString(), agent: "hub", ref, result: "unreachable" }); continue; }
    const r = recheckFacts(root, ref, it.gone ? null : [it.subject, it.text].filter(Boolean).join("\n"), opts.allow);
    out.confirmed.push(...r.confirmed);
    out.due.push(...r.due);
    appendJsonl(verifyLog(root), { at: new Date().toISOString(), agent: "hub", ref, result: r.confirmed.length ? "match" : "no-match" });
  }
  return out;
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
