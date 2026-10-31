// SPDX-License-Identifier: AGPL-3.0-only
// Live readers for the non-Google sources (docs/sources-pull.md): Discord channels through a
// read-only bot, texts from the Mac's Messages database, and Granola's local cache. Each returns
// items in the source's own shape (pull.ts toItem reads them) and a cursor for the next pass.
// Nothing here writes to the source; Discord is only ever read (GET), never posted to.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import { keysDir } from "./secrets";
import { timed } from "./util";
import type { SourceConfig } from "./pull";

type Raw = Record<string, any>;
type Http = (url: string, init?: RequestInit) => Promise<Response>;
let http: Http = (url, init) => fetch(url, init);
// Tests swap in a fake Discord; nothing in the test suite reaches Discord.
export function useDiscordHttp(h: Http) { http = h; }

// ---------- Discord ----------

const DISCORD = "https://discord.com/api/v10";
const RECENT = 50; // the last messages per channel, re-read each pass so an edit is seen

async function dget(path: string): Promise<Raw> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error(`DISCORD_BOT_TOKEN isn't in ${keysDir()}`);
  // GET only: the hub never posts, reacts or edits.
  const r = await timed(http, `${DISCORD}/${path}`, { method: "GET", headers: { authorization: `Bot ${token}` } });
  if (r.status === 401) throw new Error("Discord refused the bot token; make a new one and put it in the keys folder");
  if (r.status === 403) throw new Error(`the bot can't read ${path.split("?")[0]} (it needs View Channel and Read Message History there)`);
  if (!r.ok) throw new Error(`Discord answered ${r.status}`);
  return (await r.json()) as Raw;
}

// where: channel ids, or names ("#dev") looked up in cfg.guild. A name that matches more than one
// channel (Discord allows that across categories) is refused, never guessed (evals/gaps.ts G46).
// Every name is resolved before any message is read. Cursor: JSON { channelId: last message id }.
export async function fetchDiscord(cfg: SourceConfig, cursor?: string): Promise<{ items: Raw[]; cursor: string }> {
  if (!cfg.where?.length) throw new Error("a discord source needs where: (the channels to read)");
  const ids: Record<string, string> = {};
  if (cfg.where.some((w) => !/^\d+$/.test(w))) {
    if (!cfg.guild) throw new Error("channel names need guild: (the server id); or list channel ids");
    const chans = (await dget(`guilds/${cfg.guild}/channels`)) as Raw[];
    for (const w of cfg.where.filter((x) => !/^\d+$/.test(x))) {
      const hits = chans.filter((c) => `#${c.name}` === (w.startsWith("#") ? w : `#${w}`));
      if (hits.length > 1) throw new Error(`${w} names ${hits.length} channels in that server (${hits.map((c) => c.id).join(", ")}); list the channel id in where: instead`);
      if (hits.length) ids[w] = String(hits[0].id);
    }
  }
  const prev: Record<string, string> = cursor ? JSON.parse(cursor) : {};
  const next: Record<string, string> = { ...prev };
  const items: Raw[] = [];
  for (const w of cfg.where) {
    const id = /^\d+$/.test(w) ? w : ids[w];
    if (!id) throw new Error(`no channel ${w} in that server`);
    const label = /^\d+$/.test(w) ? w : (w.startsWith("#") ? w : `#${w}`);
    const got = new Map<string, Raw>();
    for (const m of (await dget(`channels/${id}/messages?limit=${RECENT}`)) as Raw[]) got.set(String(m.id), m);
    // Anything newer than the last pass that the recent window didn't cover.
    if (prev[id]) {
      let after = prev[id];
      for (let i = 0; i < 5; i++) {
        const page = ((await dget(`channels/${id}/messages?limit=100&after=${after}`)) as Raw[]).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        page.forEach((m) => got.set(String(m.id), m));
        if (page.length < 100) break;
        after = String(page[page.length - 1].id);
      }
    }
    const sorted = [...got.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    if (sorted.length) next[id] = String(sorted[sorted.length - 1].id);
    items.push(...sorted.map((m) => ({ ...m, channel_id: id, channel_name: label })));
  }
  return { items, cursor: JSON.stringify(next) };
}

export async function fetchDiscordMessage(cfg: SourceConfig, ref: string): Promise<Raw | undefined> {
  const [ch, msg] = ref.split("/");
  if (!ch || !msg) return undefined;
  try {
    const m = await dget(`channels/${ch}/messages/${msg}`);
    const label = cfg.where?.find((w) => w === ch) ?? (cfg.guild ? `#${((await dget(`channels/${ch}`)) as Raw).name}` : ch);
    return { ...m, channel_id: ch, channel_name: label };
  } catch { return undefined; }
}

// ---------- texts: the Mac's Messages database (read only) ----------

const CHAT_DB = () => join(homedir(), "Library", "Messages", "chat.db");
const APPLE_EPOCH = Date.UTC(2001, 0, 1);
const appleDate = (v: number | null | undefined) => (v ? new Date(APPLE_EPOCH + (v > 1e12 ? v / 1e6 : v * 1000)).toISOString() : undefined);

// Newer macOS keeps the text only in attributedBody (an NSAttributedString in typedstream form).
// The string follows the "NSString" class name: a 0x2B marker, then a length (one byte, or
// 0x81 + two bytes little-endian, or 0x82 + four), then UTF-8.
export function attributedText(b: Uint8Array | null | undefined): string | undefined {
  if (!b) return undefined;
  const buf = Buffer.from(b);
  const at = buf.indexOf("NSString");
  if (at < 0) return undefined;
  let i = buf.indexOf(0x2b, at + 8);
  if (i < 0) return undefined;
  i++;
  let len = buf[i++];
  if (len === 0x81) { len = buf.readUInt16LE(i); i += 2; }
  else if (len === 0x82) { len = buf.readUInt32LE(i); i += 4; }
  return buf.subarray(i, i + len).toString("utf8");
}

// where: handles (phone or email) or a thread's chat_identifier ("chat…"), never a display name:
// any member of a group chat can name it, and names aren't unique (evals/gaps.ts G43). A
// display-name entry is refused with what to list instead. The allowlist is applied in the SQL
// too, so a thread that isn't listed is never read into memory. Cursor: the last ROWID read. The
// first pass reads the last backfill_days, chosen by date in the SQL so a long thread's old rows
// can't fill the batch, and with nothing recent starts after the thread's newest row (G60). Later
// passes read past the cursor and re-read the 200 rows below it, keeping only texts already read
// (`known`), so an edit or an unsend is seen and the old thread never comes in.
const TEXT_ID = /^(\+?\d[\d\s().-]{3,}|[^\s@]+@[^\s@]+\.[^\s@]+|chat\d+)$/;
const TEXTS_BATCH = 500;
function openChat(cfg: SourceConfig): Database {
  if (!cfg.where?.length) throw new Error("a texts source needs where: (the contacts or threads to read)");
  const named = cfg.where.find((w) => !TEXT_ID.test(String(w).trim()));
  if (named !== undefined) throw new Error(`texts where: ${JSON.stringify(named)} looks like a thread's display name, which anyone in a group chat can set; list the contact's handle (+15145550123 or an email) or the thread's chat_identifier (chat…) instead`);
  const path = cfg.path ?? CHAT_DB();
  if (!existsSync(path)) throw new Error(`no Messages database at ${path}`);
  try { return new Database(path, { readonly: true }); }
  catch (e) { throw new Error(`can't open the Messages database (${(e as Error).message}); the process running pocketbrain start needs Full Disk Access`); }
}

// The listed threads' messages: joins and the allowlist (2 x where: params).
const threads = (cfg: SourceConfig) => {
  const marks = cfg.where!.map(() => "?").join(",");
  return `FROM message m LEFT JOIN handle h ON m.handle_id = h.ROWID
    LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID LEFT JOIN chat c ON c.ROWID = cmj.chat_id
    WHERE (c.chat_identifier IN (${marks}) OR h.id IN (${marks}))`;
};

// Rows of the listed threads matching `extra` (SQL with ? params), oldest first, at most TEXTS_BATCH.
function textRows(db: Database, cfg: SourceConfig, extra: string, ...params: (string | number)[]): Raw[] {
  const cols = new Set((db.query("PRAGMA table_info(message)").all() as Raw[]).map((c) => String(c.name)));
  const opt = (c: string) => (cols.has(c) ? `m.${c}` : `NULL AS ${c}`);
  const sql = `SELECT m.ROWID AS rowid, m.guid, m.text, ${opt("attributedBody")}, m.is_from_me, m.date, ${opt("date_edited")}, ${opt("date_retracted")}, m.item_type, h.id AS handle,
    c.chat_identifier AS chat
    ${threads(cfg)} AND ${extra} ORDER BY m.ROWID LIMIT ${TEXTS_BATCH}`;
  return db.query(sql).all(...cfg.where!, ...cfg.where!, ...params) as Raw[];
}

const textItem = (r: Raw) => ({
  guid: r.guid, text: r.text ?? attributedText(r.attributedBody) ?? "", is_from_me: !!r.is_from_me, date: appleDate(r.date),
  date_edited: r.date_edited || undefined, is_deleted: !!r.date_retracted, item_type: r.item_type, handle: r.handle, chat: r.chat ?? r.handle,
});

export function fetchTexts(cfg: SourceConfig, cursor?: string, known: (id: string) => boolean = () => false): { items: Raw[]; cursor: string } {
  const db = openChat(cfg);
  try {
    const last = Number(cursor ?? 0);
    let rows: Raw[], top = last;
    if (!last) {
      // chat.db dates are nanoseconds since 2001 (seconds on older macOS).
      const from = Date.now() - (cfg.backfill_days ?? 2) * 864e5 - APPLE_EPOCH;
      rows = textRows(db, cfg, "(m.date >= ? OR (m.date < 1e12 AND m.date >= ?))", from * 1e6, from / 1000);
      if (!rows.length) top = Number((db.query(`SELECT MAX(m.ROWID) AS top ${threads(cfg)}`).get(...cfg.where!, ...cfg.where!) as Raw | null)?.top ?? 0);
    } else rows = textRows(db, cfg, "m.ROWID > ?", Math.max(0, last - 200));
    top = rows.reduce((m, r) => Math.max(m, Number(r.rowid)), top);
    const keep = rows.filter((r) => Number(r.rowid) > last || known(String(r.guid)));
    return { items: keep.map(textItem), cursor: String(top) };
  } finally { db.close(); }
}

// One text by guid, for verify_source: only from the listed threads, however old or new.
export function fetchText(cfg: SourceConfig, guid: string): Raw | undefined {
  const db = openChat(cfg);
  try { const r = textRows(db, cfg, "m.guid = ?", guid)[0]; return r ? textItem(r) : undefined; }
  finally { db.close(); }
}

// ---------- Granola: the desktop app's local cache (read only) ----------

const GRANOLA = () => join(homedir(), "Library", "Application Support", "Granola", "cache-v3.json");

// The cache is JSON whose "cache" field is itself a JSON string holding state.documents (by id).
// Cursor: the newest updated_at seen. The first pass reads the last backfill_days.
export function fetchGranola(cfg: SourceConfig, cursor?: string): { items: Raw[]; cursor: string } {
  const path = cfg.path ?? GRANOLA();
  if (!existsSync(path)) throw new Error(`no Granola cache at ${path}`);
  let top: Raw;
  try { top = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("Granola's cache isn't readable JSON (it may be mid-write); next pass"); }
  const inner = typeof top.cache === "string" ? JSON.parse(top.cache) : top.cache ?? top;
  const docs = inner?.state?.documents ?? inner?.documents;
  if (!docs) throw new Error("Granola's cache has no documents where expected (state.documents); its format may have changed");
  const list: Raw[] = Array.isArray(docs) ? docs : Object.values(docs);
  const from = cursor ?? new Date(Date.now() - (cfg.backfill_days ?? 2) * 864e5).toISOString();
  const items = list.filter((d) => String(d.updated_at ?? d.created_at ?? "") > from && (!cfg.where?.length || cfg.where.includes(d.folder ?? "notes")));
  const newest = items.reduce((m, d) => (String(d.updated_at ?? "") > m ? String(d.updated_at) : m), cursor ?? from);
  return { items, cursor: newest };
}

export function fetchGranolaNote(cfg: SourceConfig, id: string): Raw | undefined {
  return fetchGranola(cfg, "0").items.find((d) => String(d.id) === id);
}
