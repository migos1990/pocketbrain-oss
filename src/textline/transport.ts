// SPDX-License-Identifier: AGPL-3.0-only
// How a text reaches Louis and how his reply comes back. One interface, four implementations;
// rules/escalation.yaml picks one (transport.use) and a fallback.
//
//   instinct  the designed path (architecture 0.6): Instinct is the one voice that texts Louis.
//             Hosted agents can't be pushed to, so texts wait in textline/outbox/ and
//             Instinct's own 5-minute routine pulls them over /v1/owner/outbox, sends them,
//             and posts Louis's replies back to /v1/owner/replies. If Instinct exposes an
//             inbound URL, push_url sends straight to it instead.
//   twilio    direct SMS from a number Louis owns. Replies come from his phone, not an agent.
//   imessage  direct, through Messages on the Mac that runs the hub.
//   fake      files only, for tests, the demo and evals.
//
// Replies relayed by an agent (instinct) are untrusted: they can only tighten or decide
// non-private items (see poll.ts). Direct replies are Louis's own word.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TransportConfig } from "./policy";
import type { Fetch } from "./items";
import { readJsonl, appendJsonl, sha256 } from "../util";

export interface OutgoingText { id: string; text: string; at: string }
export interface IncomingText { id: string; text: string; at: string; in_reply_to?: string }
export interface SendResult { ok: boolean; id?: string; detail?: string }

export interface TextTransport {
  name: string;
  trusted: boolean; // replies come from Louis's own phone, not relayed by an agent
  send(t: OutgoingText): Promise<SendResult>;
  replies(): Promise<IncomingText[]>; // new since the last call
  // instinct only: has the agent pulled recently enough to count as working?
  stale?(now: Date): boolean;
}

const dir = (root: string, ...p: string[]) => {
  const d = join(root, "textline", ...p);
  mkdirSync(d, { recursive: true });
  return d;
};
function readJson<T>(f: string, fallback: T): T {
  try { return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : fallback; } catch { return fallback; }
}
// The file for a text or reply id. Ids come from outside (Instinct, a phone), so two that differ
// only in punctuation must not share a file, nor one crafted to equal another's file name (gap
// G110): an id that had to change carries a short hash, and a name another id holds gets -2, -3.
function slot(d: string, id: string): string {
  const clean = id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120) || "no-id";
  const base = clean === id ? clean : `${clean.slice(0, 100)}-${sha256(id).slice(0, 12)}`;
  let f = join(d, `${base}.json`);
  for (let n = 2; existsSync(f) && readJson<{ id?: unknown }>(f, {}).id !== id; n++) f = join(d, `${base}-${n}.json`);
  return f;
}

// ---------- fake ----------

export function fakeTransport(root: string, trusted = true): TextTransport {
  return {
    name: "fake", trusted,
    async send(t) {
      appendJsonl(join(dir(root, "fake"), "sent.jsonl"), t);
      return { ok: true, id: t.id };
    },
    async replies() { return drain(dir(root, "fake", "inbox")); },
  };
}

// Test helper: Louis "texts back".
export function fakeReply(root: string, text: string, id = `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`) {
  writeFileSync(slot(dir(root, "fake", "inbox"), id), JSON.stringify({ id, text, at: new Date().toISOString() }));
}
export function fakeSent(root: string): OutgoingText[] {
  return readJsonl<OutgoingText>(join(root, "textline", "fake", "sent.jsonl"));
}

function drain(d: string): IncomingText[] {
  const done = join(d, "done");
  mkdirSync(done, { recursive: true });
  const out: IncomingText[] = [];
  for (const f of readdirSync(d).filter((x) => x.endsWith(".json")).sort()) {
    const r = readJson<IncomingText | undefined>(join(d, f), undefined);
    renameSync(join(d, f), join(done, f));
    if (r?.text) out.push({ id: String(r.id ?? f), text: String(r.text), at: String(r.at ?? new Date().toISOString()), in_reply_to: r.in_reply_to });
  }
  return out;
}

// ---------- instinct ----------

export function instinctTransport(root: string, cfg: TransportConfig["instinct"] = {}, opts: { fetch?: Fetch; key?: string } = {}): TextTransport {
  const f = opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  return {
    name: "instinct", trusted: false,
    async send(t) {
      if (cfg.push_url) {
        try {
          const r = await f(cfg.push_url, { method: "POST", headers: { "content-type": "application/json", ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}) }, body: JSON.stringify({ to: "louis", ...t }), signal: AbortSignal.timeout(10_000) });
          return r.ok ? { ok: true, id: t.id } : { ok: false, detail: `push HTTP ${r.status}` };
        } catch (e) { return { ok: false, detail: `push failed: ${(e as Error).message}` }; }
      }
      writeFileSync(slot(dir(root, "outbox"), t.id), JSON.stringify({ ...t, status: "queued" }));
      return { ok: true, id: t.id, detail: "queued for Instinct to pull" };
    },
    async replies() { return drain(dir(root, "replies")); },
    stale(now) {
      if (cfg.push_url) return false;
      const queued = outbox(root).filter((m) => m.status === "queued");
      if (!queued.length) return false;
      const limit = (cfg.stale_pull_minutes ?? 20) * 60_000;
      const last = lastPull(root);
      const oldest = queued.map((m) => m.at).sort()[0];
      return now.getTime() - new Date(last && last > oldest ? last : oldest).getTime() > limit;
    },
  };
}

interface OutboxEntry extends OutgoingText { status: "queued" | "sent" | "superseded"; sent_at?: string; message_id?: string }

export function outbox(root: string): OutboxEntry[] {
  const d = join(root, "textline", "outbox");
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((x) => x.endsWith(".json")).sort().map((x) => readJson<OutboxEntry>(join(d, x), undefined as never)).filter(Boolean);
}
export function markOutbox(root: string, id: string, status: OutboxEntry["status"], message_id?: string): boolean {
  // Found by the id inside, never by a file name alone, so only that text is marked.
  const d = join(root, "textline", "outbox");
  const f = existsSync(d) ? readdirSync(d).filter((x) => x.endsWith(".json")).map((x) => join(d, x)).find((x) => readJson<{ id?: unknown }>(x, {}).id === id) : undefined;
  if (!f) return false;
  const e = readJson<OutboxEntry>(f, undefined as never);
  // Once it's out (or replaced) the words go: a text can quote a source (src/quotes.ts).
  const { text: _text, ...rest } = e;
  writeFileSync(f, JSON.stringify({ ...rest, text: "", status, ...(status === "sent" ? { sent_at: new Date().toISOString(), message_id } : {}) }));
  return true;
}
export function lastPull(root: string): string | undefined {
  return readJson<{ at?: string }>(join(root, "textline", "instinct-pull.json"), {}).at;
}
export function recordPull(root: string) {
  writeFileSync(join(dir(root), "instinct-pull.json"), JSON.stringify({ at: new Date().toISOString() }));
}
export function queueReply(root: string, r: IncomingText) {
  writeFileSync(slot(dir(root, "replies"), r.id), JSON.stringify(r));
}

// ---------- twilio ----------

export function twilioTransport(root: string, cfg: NonNullable<TransportConfig["twilio"]>, opts: { fetch?: Fetch; sid?: string; token?: string } = {}): TextTransport {
  const sid = opts.sid ?? process.env.TWILIO_ACCOUNT_SID, token = opts.token ?? process.env.TWILIO_AUTH_TOKEN;
  const f = opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const base = `https://api.twilio.com/2010-04-01/Accounts/${sid}`;
  const auth = { authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` };
  const cursorFile = join(dir(root), "twilio-cursor.json");
  return {
    name: "twilio", trusted: true,
    async send(t) {
      if (!sid || !token) return { ok: false, detail: "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are not set" };
      try {
        const r = await f(`${base}/Messages.json`, { method: "POST", headers: { ...auth, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ To: cfg.to, From: cfg.from, Body: t.text }).toString(), signal: AbortSignal.timeout(10_000) });
        const j = (await r.json().catch(() => ({}))) as { sid?: string; message?: string };
        return r.ok ? { ok: true, id: j.sid } : { ok: false, detail: `twilio ${r.status}: ${j.message ?? ""}`.trim() };
      } catch (e) { return { ok: false, detail: `twilio: ${(e as Error).message}` }; }
    },
    async replies() {
      if (!sid || !token) return [];
      const cur = readJson<{ seen: string[]; since?: string }>(cursorFile, { seen: [] });
      const since = cur.since ?? new Date().toISOString();
      const q = new URLSearchParams({ From: cfg.to, To: cfg.from, "DateSent>": since.slice(0, 10), PageSize: "50" });
      try {
        const r = await f(`${base}/Messages.json?${q}`, { headers: auth, signal: AbortSignal.timeout(10_000) });
        if (!r.ok) return [];
        const j = (await r.json()) as { messages?: { sid: string; body: string; date_sent?: string; date_created?: string; direction?: string }[] };
        const seen = new Set(cur.seen);
        const fresh = (j.messages ?? []).filter((m) => (m.direction ?? "inbound").startsWith("inbound") && !seen.has(m.sid))
          .map((m) => ({ id: m.sid, text: m.body, at: new Date(m.date_sent ?? m.date_created ?? Date.now()).toISOString() }))
          .filter((m) => m.at >= since).sort((a, b) => a.at.localeCompare(b.at));
        writeFileSync(cursorFile, JSON.stringify({ since, seen: [...cur.seen, ...fresh.map((m) => m.id)].slice(-500) }));
        return fresh;
      } catch { return []; }
    },
  };
}

// ---------- imessage (the Mac that runs the hub) ----------

export type Spawn = (cmd: string[]) => { exitCode: number; stdout: string; stderr: string } | Promise<{ exitCode: number; stdout: string; stderr: string }>;
// A hung Messages holds an AppleEvent for its 2-minute default. The send runs as a child process
// the hub awaits, never a sync spawn (which froze the hub's event loop, so /health stopped
// answering and the watchdog restarted the hub twice on 2026-10-24), and gives up after
// SEND_TIMEOUT_MS ("no answer"), which counts as a failed send that the watchdog acts on.
const SEND_TIMEOUT_MS = 30_000;
export async function runWithTimeout(cmd: string[], ms: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; p.kill(); }, ms);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { exitCode: timedOut ? 1 : code, stdout, stderr: timedOut ? `no answer from Messages in ${Math.round(ms / 1000)} s` : stderr };
  } finally { clearTimeout(timer); }
}
const spawn: Spawn = (cmd) => runWithTimeout(cmd, SEND_TIMEOUT_MS);

// AppleScript string literal: backslashes and quotes escaped, so text can't break out.
const as = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function imessageTransport(root: string, cfg: NonNullable<TransportConfig["imessage"]>, opts: { spawn?: Spawn; query?: (db: string, sql: string, args: unknown[]) => { rowid: number; guid: string; text: string | null; date: number }[] } = {}): TextTransport {
  const run = opts.spawn ?? spawn;
  const db = cfg.chat_db ?? join(homedir(), "Library", "Messages", "chat.db");
  const cursorFile = join(dir(root), "imessage-cursor.json");
  const query = opts.query ?? ((file: string, sql: string, args: unknown[]) => {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const d = new Database(file, { readonly: true });
    try { return d.query(sql).all(...(args as never[])) as { rowid: number; guid: string; text: string | null; date: number }[]; } finally { d.close(); }
  });
  return {
    name: "imessage", trusted: true,
    async send(t) {
      const script = `tell application "Messages" to send ${as(t.text)} to participant ${as(cfg.to)} of (1st account whose service type = iMessage)`;
      const r = await run(["osascript", "-e", script]);
      return r.exitCode === 0 ? { ok: true, id: t.id } : { ok: false, detail: `osascript: ${r.stderr.trim().slice(0, 120)}` };
    },
    async replies() {
      if (!existsSync(db)) return [];
      const cur = readJson<{ rowid?: number }>(cursorFile, {});
      try {
        if (cur.rowid === undefined) {
          // First run: start from now, never replay old conversations as answers.
          const top = query(db, "SELECT MAX(ROWID) AS rowid, '' AS guid, NULL AS text, 0 AS date FROM message", []);
          writeFileSync(cursorFile, JSON.stringify({ rowid: top[0]?.rowid ?? 0 }));
          return [];
        }
        const rows = query(db, "SELECT m.ROWID AS rowid, m.guid AS guid, m.text AS text, m.date AS date FROM message m JOIN handle h ON m.handle_id = h.ROWID WHERE h.id = ? AND m.is_from_me = 0 AND m.ROWID > ? ORDER BY m.ROWID", [cfg.to, cur.rowid]);
        if (rows.length) writeFileSync(cursorFile, JSON.stringify({ rowid: rows.at(-1)!.rowid }));
        // Messages dates are nanoseconds since 2001-01-01. Rich-text-only rows (text NULL) are skipped.
        return rows.filter((r) => r.text).map((r) => ({ id: r.guid, text: r.text!, at: new Date(Date.UTC(2001, 0, 1) + r.date / 1e6).toISOString() }));
      } catch { return []; }
    },
  };
}

export function makeTransport(root: string, use: TransportConfig["use"] | NonNullable<TransportConfig["fallback"]>, cfg: TransportConfig): TextTransport {
  switch (use) {
    case "instinct": return instinctTransport(root, cfg.instinct, { key: process.env.INSTINCT_PUSH_KEY });
    case "twilio": if (!cfg.twilio) throw new Error("transport twilio needs twilio: { from, to } in rules/escalation.yaml"); return twilioTransport(root, cfg.twilio);
    case "imessage": if (!cfg.imessage) throw new Error("transport imessage needs imessage: { to } in rules/escalation.yaml"); return imessageTransport(root, cfg.imessage);
    case "fake": return fakeTransport(root, cfg.fake?.trusted ?? true);
  }
  throw new Error(`unknown transport ${use}`);
}
