// SPDX-License-Identifier: AGPL-3.0-only
// Live Google sources for the hub's pulls (docs/sources-pull.md): Gmail, Calendar and Drive, each
// with its own read-only scope and its own token. The owner's own Google OAuth client (a "Desktop app"
// client) and the refresh tokens live as key files in ~/.config/pocketbrain/keys/
// (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GMAIL_REFRESH_TOKEN_<ACCOUNT>, GCAL_REFRESH_TOKEN_<ACCOUNT>,
// GDRIVE_REFRESH_TOKEN_<ACCOUNT>), never in the brain, chat or git, and are never printed. Incremental:
// Gmail's history from the stored historyId, Calendar's sync token per calendar, Drive's newest
// modifiedTime per listed folder.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { keysDir } from "./secrets";
import { timed } from "./util";
import type { SourceConfig } from "./pull";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GCAL_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
type Product = "gmail" | "gcal" | "gdoc";
const PRODUCT: Record<Product, { scope: string; key: string; api: string; label: string }> = {
  gmail: { scope: GMAIL_SCOPE, key: "GMAIL_REFRESH_TOKEN", api: "https://gmail.googleapis.com/gmail/v1/users/me", label: "Gmail" },
  gcal: { scope: GCAL_SCOPE, key: "GCAL_REFRESH_TOKEN", api: "https://www.googleapis.com/calendar/v3", label: "Calendar" },
  gdoc: { scope: DRIVE_SCOPE, key: "GDRIVE_REFRESH_TOKEN", api: "https://www.googleapis.com/drive/v3", label: "Drive" },
};
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAX_IDS = 100;       // messages read per pass at most; the rest wait for the next pass
const MAX_TEXT = 20_000;   // characters of a message body kept in memory for extraction

type Raw = Record<string, any>;
type Http = (url: string, init?: RequestInit) => Promise<Response>;
let http: Http = (url, init) => fetch(url, init);
// Tests swap in a fake Gmail; nothing in the test suite reaches Google.
export function useHttp(h: Http) { http = h; }

export const tokenKey = (account?: string, product: Product = "gmail") => `${PRODUCT[product].key}${account ? `_${account.toUpperCase().replace(/[^A-Z0-9]/g, "_")}` : ""}`;

function client() {
  const id = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) throw new Error(`GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET aren't in ${keysDir()}`);
  return { id, secret };
}

async function form(body: Record<string, string>): Promise<Raw> {
  const r = await timed(http, TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
  const j = (await r.json().catch(() => ({}))) as Raw;
  return { ...j, _status: r.status, _ok: r.ok };
}

// A token with anything beyond its one read-only scope (send, modify, delete, write) is refused, not used.
function checkScope(scope: unknown, product: Product) {
  if (typeof scope === "string" && scope.split(" ").some((s) => s && s !== PRODUCT[product].scope)) throw new Error(`the ${PRODUCT[product].label} token carries more than read-only access (${scope}); reconnect with pocketbrain sources connect`);
}

const tokens = new Map<string, { token: string; until: number }>();
export async function accessToken(account?: string, product: Product = "gmail"): Promise<string> {
  const key = tokenKey(account, product);
  const { id, secret } = client();
  const refresh = process.env[key];
  if (!refresh) throw new Error(`${key} is missing; run pocketbrain sources connect <source>`);
  const hit = tokens.get(refresh);
  if (hit && hit.until > Date.now()) return hit.token;
  const j = await form({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" });
  if (!j._ok || !j.access_token) throw new Error(`Google refused the ${PRODUCT[product].label} token (${j.error ?? j._status}); run pocketbrain sources connect <source> again`);
  checkScope(j.scope, product);
  tokens.set(refresh, { token: j.access_token, until: Date.now() + (Number(j.expires_in ?? 3600) - 60) * 1000 });
  return j.access_token;
}

async function get(token: string, path: string, q: Record<string, string | string[]> = {}, product: Product = "gmail"): Promise<Raw> {
  const u = new URL(`${PRODUCT[product].api}/${path}`);
  for (const [k, v] of Object.entries(q)) for (const x of [v].flat()) u.searchParams.append(k, x);
  const r = await timed(http, u.toString(), { headers: { authorization: `Bearer ${token}` } });
  if (r.status === 404) return { _notFound: true };
  if (r.status === 410) return { _gone: true }; // Calendar: the sync token expired
  if (!r.ok) throw new Error(`${PRODUCT[product].label} ${path.split("/")[0]} answered ${r.status}`);
  return (await r.json()) as Raw;
}

// The readable body: text/plain if there is one, else text/html with the tags taken out.
export function bodyText(payload: Raw | undefined): string {
  const parts: Raw[] = [];
  const walk = (p: Raw | undefined) => { if (!p) return; parts.push(p); (p.parts ?? []).forEach(walk); };
  walk(payload);
  const dec = (p: Raw) => Buffer.from(String(p.body?.data ?? ""), "base64url").toString("utf8");
  const plain = parts.filter((p) => p.mimeType === "text/plain" && p.body?.data).map(dec).join("\n");
  if (plain.trim()) return plain.slice(0, MAX_TEXT);
  const html = parts.filter((p) => p.mimeType === "text/html" && p.body?.data).map(dec).join("\n");
  return html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/p>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, MAX_TEXT);
}

async function listIds(token: string, cfg: SourceConfig): Promise<string[]> {
  const ids: string[] = [];
  const labels = cfg.where?.length ? cfg.where : [undefined];
  for (const label of labels) {
    let page: string | undefined;
    do {
      const r = await get(token, "messages", { q: `newer_than:${cfg.backfill_days ?? 2}d`, maxResults: "100", ...(label ? { labelIds: label } : {}), ...(page ? { pageToken: page } : {}) });
      ids.push(...(r.messages ?? []).map((m: Raw) => String(m.id)));
      page = r.nextPageToken;
    } while (page && ids.length < MAX_IDS);
  }
  return [...new Set(ids)];
}

type Seen = (id: string, version?: string) => boolean;

// One pass. `cursor` is the historyId the last pass ended on. Returns the messages in Gmail's own
// shape with `text` filled in (pull.ts toItem reads them), deletions as { id, deleted }, and the
// historyId to start from next time. A cursor too old for Gmail's history falls back to a listing.
// With where: labels, the history is asked per label (labelId), so mail outside the allowlist is
// never listed or fetched and can't fill the 100-message window (evals/gaps.ts G41).
export async function fetchGmail(cfg: SourceConfig, cursor?: string, seen: Seen = () => false): Promise<{ items: Raw[]; cursor: string; more?: boolean }> {
  const token = await accessToken(cfg.account);
  const profile = await get(token, "profile");
  let added: string[] = [], deleted: string[] = [];
  let next = String(profile.historyId);
  if (cursor) {
    let gone = false;
    for (const label of cfg.where?.length ? cfg.where : [undefined]) {
      let page: string | undefined;
      do {
        const h = await get(token, "history", { startHistoryId: cursor, historyTypes: ["messageAdded", "messageDeleted"], maxResults: "500", ...(label ? { labelId: label } : {}), ...(page ? { pageToken: page } : {}) });
        if (h._notFound) { gone = true; break; }
        for (const e of h.history ?? []) {
          added.push(...(e.messagesAdded ?? []).map((m: Raw) => String(m.message.id)));
          deleted.push(...(e.messagesDeleted ?? []).map((m: Raw) => String(m.message.id)));
        }
        if (h.historyId) next = String(h.historyId);
        page = h.nextPageToken;
      } while (page);
      if (gone) break;
    }
    if (gone) added = await listIds(token, { ...cfg, backfill_days: 7 });
  } else added = await listIds(token, cfg);
  added = [...new Set(added)].filter((id) => !deleted.includes(id) && !seen(id));
  const more = added.length > MAX_IDS;
  const items: Raw[] = deleted.map((id) => ({ id, deleted: true }));
  for (const id of added.slice(0, MAX_IDS)) {
    const m = await get(token, `messages/${id}`, { format: "full" });
    if (m._notFound) continue;
    items.push({ ...m, text: bodyText(m.payload) });
  }
  // With more than MAX_IDS waiting, keep the old cursor so the rest is read next pass (seen ids skip).
  return { items, cursor: more && cursor ? cursor : next, ...(more ? { more } : {}) };
}

// One item by id, for verify_source on a live source.
export async function fetchGmailMessage(cfg: SourceConfig, id: string): Promise<Raw | undefined> {
  const m = await get(await accessToken(cfg.account), `messages/${id}`, { format: "full" });
  return m._notFound ? undefined : { ...m, text: bodyText(m.payload) };
}

// ---------- connecting a mailbox: OAuth on the Mac, loopback redirect with PKCE ----------

export function saveKey(name: string, value: string) {
  mkdirSync(keysDir(), { recursive: true, mode: 0o700 });
  const f = join(keysDir(), name);
  writeFileSync(f, value + "\n", { mode: 0o600 });
  chmodSync(f, 0o600);
}

// Starts a one-shot listener on 127.0.0.1, returns the URL to open; resolves once Google redirects
// back. The refresh token is saved as a key file and never printed. `address`, when given, must be
// the account that signed in, so the wrong mailbox can't be connected by mistake.
export async function connectGoogle(cfg: SourceConfig, opts: { open?: (url: string) => void; port?: number } = {}): Promise<{ url: string; done: Promise<string> }> {
  if (cfg.kind !== "gmail" && cfg.kind !== "gcal" && cfg.kind !== "gdoc") throw new Error(`sources connect is for gmail, gcal and gdoc sources, not ${cfg.kind}`);
  const product: Product = cfg.kind;
  const { id, secret } = client();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  let finish!: (v: string) => void, fail!: (e: Error) => void;
  const done = new Promise<string>((res, rej) => { finish = res; fail = rej; });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      if (u.pathname !== "/") return new Response("", { status: 404 });
      const stop = (msg: string, ok: boolean) => { setTimeout(() => server.stop(), 50); return new Response(`${msg} You can close this tab.`, { status: ok ? 200 : 400 }); };
      if (u.searchParams.get("state") !== state) { fail(new Error("the sign-in came back with the wrong state; try again")); return stop("Sign-in refused.", false); }
      const code = u.searchParams.get("code");
      if (!code) { fail(new Error(`Google sign-in stopped: ${u.searchParams.get("error") ?? "no code"}`)); return stop("Sign-in stopped.", false); }
      const j = await form({ client_id: id, client_secret: secret, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirect });
      try {
        if (!j._ok || !j.refresh_token) throw new Error(`Google gave no refresh token (${j.error ?? j._status})`);
        checkScope(j.scope, product);
        // Who signed in: Gmail's profile address, the primary calendar's id (its owner's address), or Drive's user.
        const me = product === "gmail" ? String((await get(j.access_token, "profile")).emailAddress)
          : product === "gcal" ? String((await get(j.access_token, "calendars/primary", {}, "gcal")).id)
          : String((await get(j.access_token, "about", { fields: "user(emailAddress)" }, "gdoc")).user?.emailAddress);
        if (cfg.address && me.toLowerCase() !== cfg.address.toLowerCase()) throw new Error("the account that signed in isn't this source's address; nothing saved");
        saveKey(tokenKey(cfg.account, product), j.refresh_token);
        finish(tokenKey(cfg.account, product));
        return stop(`pocketBrain can now read this ${({ gmail: "mailbox", gcal: "calendar", gdoc: "Drive" })[product]} (read only).`, true);
      } catch (e) { fail(e as Error); return stop("Sign-in refused.", false); }
    },
  });
  const redirect = `http://127.0.0.1:${server.port}/`;
  const url = `${AUTH_URL}?${new URLSearchParams({ client_id: id, redirect_uri: redirect, response_type: "code", scope: PRODUCT[product].scope, access_type: "offline", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256", ...(cfg.address ? { login_hint: cfg.address } : {}) })}`;
  opts.open?.(url);
  return { url, done };
}

// ---------- Calendar ----------

const MAX_EVENTS = 100;
// One pass over the listed calendars (where:, default primary). `cursor` is JSON { calendar: syncToken }.
// The first pass syncs fully but keeps only events updated in the last backfill_days or starting in
// the next 60 days; later passes get only what changed. Cancelled events come back as
// status "cancelled" (pull.ts treats them as gone). An expired sync token starts over.
// Incremental syncs skip events the hub already has at that version, so more than 100 changes
// move forward pass by pass instead of re-reading the same 100 (evals/gaps.ts G41).
export async function fetchCalendar(cfg: SourceConfig, cursor?: string, seen: Seen = () => false): Promise<{ items: Raw[]; cursor: string; more?: boolean }> {
  const token = await accessToken(cfg.account, "gcal");
  const prev: Record<string, string> = cursor ? JSON.parse(cursor) : {};
  const next: Record<string, string> = {};
  const items: Raw[] = [];
  const now = Date.now(), since = now - (cfg.backfill_days ?? 2) * 864e5, until = now + 60 * 864e5;
  for (const cal of cfg.where?.length ? cfg.where : ["primary"]) {
    let sync: string | undefined = prev[cal], page: string | undefined, got: Raw[] = [], restarted = false;
    for (;;) {
      const r = await get(token, `calendars/${encodeURIComponent(cal)}/events`, { maxResults: "250", showDeleted: "true", ...(sync ? { syncToken: sync } : {}), ...(page ? { pageToken: page } : {}) }, "gcal");
      if (r._gone && !restarted) { sync = undefined; page = undefined; got = []; restarted = true; continue; }
      if (r._notFound || r._gone) throw new Error(`calendar ${cal} can't be read`);
      got.push(...(r.items ?? []));
      page = r.nextPageToken;
      if (!page) { if (r.nextSyncToken) next[cal] = r.nextSyncToken; break; }
    }
    const full = !sync;
    for (const e of got) {
      const start = Date.parse(e.start?.dateTime ?? e.start?.date ?? "") || 0;
      if (full) {
        // A fresh sync returns the whole calendar: keep what is recent or coming up, unseen.
        const recent = Date.parse(e.updated ?? "") >= since || (start >= since && start <= until);
        if (e.status === "cancelled" || !recent || seen(String(e.id))) continue;
      } else if (seen(String(e.id), String(e.etag ?? e.updated ?? "1").replace(/"/g, ""))) continue;
      items.push({ ...e, calendar: cal });
    }
  }
  const more = items.length > MAX_EVENTS;
  return { items: items.slice(0, MAX_EVENTS), cursor: JSON.stringify(more && cursor ? prev : next), ...(more ? { more } : {}) };
}

export async function fetchCalendarEvent(cfg: SourceConfig, id: string): Promise<Raw | undefined> {
  const token = await accessToken(cfg.account, "gcal");
  for (const cal of cfg.where?.length ? cfg.where : ["primary"]) {
    const e = await get(token, `calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(id)}`, {}, "gcal");
    if (!e._notFound && !e._gone) return { ...e, calendar: cal };
  }
  return undefined;
}

// ---------- Drive ----------

const MAX_FILES = 50;
const FILE_FIELDS = "id,name,mimeType,parents,version,modifiedTime,trashed";
const DOC_TYPES: Record<string, string> = { "application/vnd.google-apps.document": "export", "text/plain": "media", "text/markdown": "media" };
const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

// The text of one file the allowlist already admitted: a Google Doc exported as plain text, or a
// plain-text file's content. Anything else (PDFs, Sheets, images) gives undefined and is skipped.
async function driveText(token: string, f: Raw): Promise<string | undefined> {
  const how = DOC_TYPES[f.mimeType];
  if (!how) return undefined;
  const u = new URL(`${PRODUCT.gdoc.api}/files/${encodeURIComponent(f.id)}${how === "export" ? "/export" : ""}`);
  u.searchParams.set(how === "export" ? "mimeType" : "alt", how === "export" ? "text/plain" : "media");
  const r = await timed(http, u.toString(), { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) return undefined;
  return (await r.text()).slice(0, MAX_TEXT);
}

const asItem = (f: Raw, folder: string, text: string) => ({ fileId: f.id, version: f.version, modifiedTime: f.modifiedTime, name: f.name, folder, trashed: !!f.trashed, text });

// One pass over the listed folders (where: is required: a Drive source never reads the whole Drive).
// `cursor` is JSON { folder: newest modifiedTime seen }. The first pass lists files changed in the
// last backfill_days; later passes only what changed since. A new version comes back with a new
// `version`, so pull.ts turns the facts citing the old one due. Files directly in a listed folder only.
export async function fetchDrive(cfg: SourceConfig, cursor?: string): Promise<{ items: Raw[]; cursor: string; more?: boolean }> {
  if (!cfg.where?.length) throw new Error("a Drive source needs where: with the folder ids to read; it never reads the whole Drive");
  const token = await accessToken(cfg.account, "gdoc");
  const prev: Record<string, string> = cursor ? JSON.parse(cursor) : {};
  const next: Record<string, string> = { ...prev };
  const items: Raw[] = [];
  let more = false;
  for (const folder of cfg.where) {
    const since = prev[folder] ?? new Date(Date.now() - (cfg.backfill_days ?? 2) * 864e5).toISOString();
    let page: string | undefined, listed: Raw[] = [];
    do {
      const r = await get(token, "files", { q: `'${q(folder)}' in parents and modifiedTime > '${since}'`, fields: `nextPageToken,files(${FILE_FIELDS})`, orderBy: "modifiedTime", pageSize: "100", ...(page ? { pageToken: page } : {}) }, "gdoc");
      if (r._notFound || r._gone) throw new Error(`Drive folder ${folder} can't be read`);
      listed.push(...(r.files ?? []));
      page = r.nextPageToken;
    } while (page);
    listed = listed.sort((a, b) => String(a.modifiedTime).localeCompare(String(b.modifiedTime)));
    for (const f of listed) {
      if (items.length >= MAX_FILES) { more = true; break; }
      next[folder] = f.modifiedTime;
      const text = f.trashed ? "" : await driveText(token, f);
      if (text !== undefined) items.push(asItem(f, folder, text));
    }
  }
  return { items, cursor: JSON.stringify(next), ...(more ? { more } : {}) };
}

// One file by id, for verify_source: its folders are checked against the allowlist before any of
// its text is read, so a ref outside the listed folders reads nothing.
export async function fetchDriveFile(cfg: SourceConfig, id: string): Promise<Raw | undefined> {
  const token = await accessToken(cfg.account, "gdoc");
  const f = await get(token, `files/${encodeURIComponent(id)}`, { fields: FILE_FIELDS }, "gdoc");
  if (f._notFound || f._gone) return undefined;
  const folder = (f.parents ?? []).find((p: string) => cfg.where?.includes(p));
  if (!folder) return asItem(f, (f.parents ?? []).join(",") || "none", "");
  const text = f.trashed ? "" : await driveText(token, f);
  return text === undefined ? undefined : asItem(f, folder, text);
}
