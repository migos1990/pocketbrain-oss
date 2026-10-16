// SPDX-License-Identifier: AGPL-3.0-only
// Capture channels (docs/capture.md): the ways a capture reaches src/capture.ts besides the CLI.
//   mailbox      Louis forwards an email (or writes a note) to a capture address. The hub reads
//                it every poll_minutes. Only senders in policy.yaml capture.mail.allowed_from
//                count; a From line can be forged, so a mailbox capture is always a document,
//                never Louis's word, and only ever becomes proposals he reviews.
//   drop folder  a folder synced by the storage service Louis already pays for. His phone saves
//                a text, a dictated transcript, a voice note (transcribed by src/transcribe.ts when
//                the owner turned it on), an .eml or a small JSON file there; any machine
//                that has the folder picks it up. On a replica the capture is queued as an op
//                signed by that machine (the phone signs nothing); the hub stores it.
// Both end in capture(): same secret removal, size and daily limits, injection hold and dedupe.
// The agent route (MCP `capture`, POST /v1/capture) is in src/core.ts.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { homedir } from "node:os";
import { today } from "./brain";
import { loadRules } from "./rules";
import { capture, captureConfig, extractPending, type CaptureInput, type CaptureResult, type MailConfig } from "./capture";
import { hubRole } from "./hub";
import { AUDIO, maxAudioBytes, transcriberFor } from "./transcribe";

// ---------- email parsing (enough MIME for what mail clients send) ----------

function unfold(head: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of head.replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ").split("\n")) {
    const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (m && !(m[1].toLowerCase() in out)) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

// =?UTF-8?B?...?= and =?UTF-8?Q?...?= in headers.
function decodeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, data) => {
    try {
      const bytes = enc.toUpperCase() === "B" ? Buffer.from(data, "base64") : Buffer.from(data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m: string, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
      return new TextDecoder(/utf-?8/i.test(cs) ? "utf-8" : "latin1").decode(bytes);
    } catch { return data; }
  });
}

function decodeBody(body: string, encoding = ""): string {
  const e = encoding.toLowerCase();
  if (e === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (e === "quoted-printable") {
    const bytes = Buffer.from(body.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
    return new TextDecoder("utf-8").decode(bytes);
  }
  return body;
}

const stripHtml = (h: string) => h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, "\n\n").trim();

// The text of one MIME entity: text/plain preferred, else text/html stripped.
function textOf(headers: Record<string, string>, body: string): { plain?: string; html?: string } {
  const ct = headers["content-type"] ?? "text/plain";
  const boundary = ct.match(/boundary="?([^";]+)"?/i)?.[1];
  if (/^multipart\//i.test(ct) && boundary) {
    let plain: string | undefined, html: string | undefined;
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith("--")) break;
      const i = part.replace(/^\r?\n/, "").search(/\r?\n\r?\n/);
      if (i < 0) continue;
      const p = part.replace(/^\r?\n/, "");
      const t = textOf(unfold(p.slice(0, i)), p.slice(i).replace(/^\r?\n\r?\n/, ""));
      plain ??= t.plain; html ??= t.html;
    }
    return { plain, html };
  }
  if (/attachment/i.test(headers["content-disposition"] ?? "")) return {};
  const text = decodeBody(body, headers["content-transfer-encoding"]);
  if (/^text\/html/i.test(ct)) return { html: stripHtml(text) };
  if (/^text\//i.test(ct)) return { plain: text };
  return {};
}

// The day as the sender's own Date header gives it ("14 Oct 2026 21:30 -0400" is the 14th), not
// the UTC day; a header with no day-month-year falls back to the parsed date.
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const isoDay = (d?: string) => {
  if (!d) return undefined;
  const m = d.match(/\b(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})\b/) ?? d.match(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/)?.slice(0, 4).map((x, i, a) => i === 1 ? a[2] : i === 2 ? a[1] : x) as RegExpMatchArray | undefined;
  const mon = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
  if (m && mon >= 0) return `${m[3]}-${String(mon + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const t = new Date(d.replace(/\s+at\s+/i, " ").replace(/\s*\(.*\)$/, ""));
  return isNaN(t.getTime()) ? undefined : t.toISOString().slice(0, 10);
};

// A forwarded message keeps the original's headers inside the body (Gmail's "---------- Forwarded
// message ---------", Apple Mail's "Begin forwarded message:", Outlook's "-----Original Message-----").
// The capture is about the original: its sender, subject and date.
const FORWARD = /^(-{5,}\s*Forwarded message\s*-{5,}|Begin forwarded message:|-{5,}\s*Original Message\s*-{5,})\s*$/im;
function forwarded(text: string): { from?: string; subject?: string; date?: string } | undefined {
  const m = text.match(FORWARD);
  if (!m) return undefined;
  const after = text.slice(m.index! + m[0].length).replace(/^\s*\n/, "");
  const head = after.split(/\n\s*\n/)[0];
  const h = unfold(head.split("\n").map((l) => l.replace(/^[>*\s]+/, "").replace(/\*+/g, "")).join("\n"));
  return { from: h.from, subject: h.subject, date: h.date ?? h.sent };
}

export interface MailItem { id: string; from: string; to?: string; subject?: string; date?: string; text: string }

export function parseMime(raw: string): MailItem {
  const norm = raw.replace(/\r\n/g, "\n");
  const i = norm.indexOf("\n\n");
  const headers = unfold(i >= 0 ? norm.slice(0, i) : norm);
  const t = textOf(headers, i >= 0 ? norm.slice(i + 2) : "");
  return {
    id: headers["message-id"]?.replace(/[<>]/g, "") ?? "",
    from: decodeWords(headers.from ?? ""), to: headers.to, subject: headers.subject ? decodeWords(headers.subject) : undefined, date: headers.date,
    text: (t.plain ?? t.html ?? "").trim(),
  };
}

// What gets captured from one email: the whole text (Louis's line on top and the original), with
// the original's sender, subject and date when it was forwarded.
export function mailInput(m: MailItem): CaptureInput {
  const f = forwarded(m.text);
  return { kind: "email", text: m.text, from: f?.from ?? m.from, subject: f?.subject ?? m.subject, received: isoDay(f?.date) ?? isoDay(m.date) };
}

export const addressOf = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();

// ---------- the capture mailbox ----------

export interface MailSource { name: string; fetchNew(): MailItem[]; done(m: MailItem): void }

// A Maildir: new/ holds unread messages (one file each); done moves them to cur/ marked seen.
// fetchmail, getmail, offlineimap or a mail client rule can fill one from any IMAP account.
export function maildirSource(dir: string): MailSource {
  // By message, not Message-ID: two messages can share one (a resend, a copy), and each file must move.
  const files = new WeakMap<MailItem, string>();
  return {
    name: `maildir ${dir}`,
    fetchNew: () => {
      const nd = join(dir, "new");
      if (!existsSync(nd)) return [];
      return readdirSync(nd).filter((f) => !f.startsWith(".")).sort().map((f) => {
        const m = parseMime(readFileSync(join(nd, f), "utf8"));
        const item = { ...m, id: m.id || f };
        files.set(item, f);
        return item;
      });
    },
    done: (m) => {
      const f = files.get(m);
      if (!f || !existsSync(join(dir, "new", f))) return;
      mkdirSync(join(dir, "cur"), { recursive: true });
      renameSync(join(dir, "new", f), join(dir, "cur", `${f.split(":")[0]}:2,S`));
    },
  };
}

// AgentMail inbox (the agents' mail service). Written against AgentMail's REST shape, the same as
// the relay (src/relay.ts); NOT yet run against a live account. Needs a key scoped to this inbox.
export function agentMailSource(inboxAddress: string, apiKey: string, base = "https://api.agentmail.to/v0"): MailSource {
  const inbox = encodeURIComponent(inboxAddress);
  const call = (method: string, path: string, body?: unknown) => {
    const r = Bun.spawnSync(["curl", "-sS", "--max-time", "20", "-X", method, `${base}${path}`, "-H", `Authorization: Bearer ${apiKey}`, "-H", "Content-Type: application/json", ...(body ? ["-d", JSON.stringify(body)] : [])]);
    const out = r.stdout.toString();
    try { return out ? JSON.parse(out) : {}; } catch { return {}; }
  };
  return {
    name: `agentmail ${inboxAddress}`,
    fetchNew: () => (call("GET", `/inboxes/${inbox}/messages?labels=unread&limit=50`).messages ?? []).map((m: Record<string, unknown>) => {
      const full = call("GET", `/inboxes/${inbox}/messages/${encodeURIComponent(String(m.message_id))}`);
      return { id: String(m.message_id), from: String(full.from ?? ""), subject: String(full.subject ?? ""), date: String(full.timestamp ?? ""), text: String(full.text ?? (full.html ? stripHtml(String(full.html)) : "")) };
    }),
    done: (m) => call("PATCH", `/inboxes/${inbox}/messages/${encodeURIComponent(m.id)}`, { add_labels: ["captured"], remove_labels: ["unread"] }),
  };
}

export function mailSourceFor(cfg: MailConfig | undefined, env = process.env): MailSource | { error: string } | undefined {
  if (!cfg) return undefined;
  if (!cfg.allowed_from?.length) return { error: "policy.yaml capture.mail.allowed_from is empty: name the owner's own addresses" };
  if (cfg.provider === "maildir") return cfg.dir ? maildirSource(expand(cfg.dir)) : { error: "capture.mail.dir is not set" };
  if (cfg.provider === "agentmail") {
    const key = env[cfg.key_env ?? "AGENTMAIL_CAPTURE_KEY"];
    if (!cfg.inbox) return { error: "capture.mail.inbox is not set" };
    return key ? agentMailSource(cfg.inbox, key) : { error: `set ${cfg.key_env ?? "AGENTMAIL_CAPTURE_KEY"} (a key scoped to the capture inbox only)` };
  }
  return { error: `unknown capture.mail.provider ${(cfg as { provider?: string }).provider}` };
}

function alert(root: string, check: string, from: string) {
  mkdirSync(join(root, "log"), { recursive: true });
  appendFileSync(join(root, "log", "alerts.jsonl"), JSON.stringify({ at: new Date().toISOString(), agent: "capture", check, from }) + "\n");
}

export interface IntakeItem { name: string; outcome: "stored" | "queued" | "duplicate" | "held" | "refused" | "ignored" | "failed"; detail: string; file?: string }

function outcomeOf(r: CaptureResult): IntakeItem["outcome"] {
  return r.refused ? "refused" : r.duplicate ? "duplicate" : r.queued ? "queued" : r.held ? "held" : "stored";
}
const detailOf = (r: CaptureResult) => r.refused ?? (r.held ? `held for the owner: ${r.held.join("; ")}` : r.file);

// One pass over the mailbox. Senders not in allowed_from are dropped with an alert; their text
// is never stored. Every message read is marked done, so a failure can't loop.
export async function mailOnce(root: string, source: MailSource, cfg: MailConfig): Promise<IntakeItem[]> {
  const allowed = new Set((cfg.allowed_from ?? []).map((a) => a.toLowerCase()));
  const out: IntakeItem[] = [];
  for (const m of source.fetchNew()) {
    const sender = addressOf(m.from);
    if (!allowed.has(sender)) {
      alert(root, "capture_mail_sender", `${sender || "(no sender)"}: not in capture.mail.allowed_from; dropped`);
      out.push({ name: m.id, outcome: "ignored", detail: `${sender} isn't one of the owner's addresses` });
      source.done(m);
      continue;
    }
    const r = await capture(root, mailInput(m), undefined, { via: "mail" });
    out.push({ name: m.id, outcome: outcomeOf(r), detail: detailOf(r) ?? "", file: r.file });
    source.done(m);
  }
  return out;
}

// ---------- the drop folder ----------

export function expand(p: string): string { return p.replace(/^~(?=$|\/)/, homedir()); }

async function inputFromFile(root: string, path: string): Promise<CaptureInput | string> {
  const ext = extname(path).toLowerCase();
  const name = basename(path);
  const received = isoDay(statSync(path).mtime.toISOString());
  if (AUDIO.has(ext)) {
    // A voice note: its transcript is the capture (src/transcribe.ts); the audio stays here.
    const t = transcriberFor(root);
    if (typeof t === "string") return t;
    try { return { kind: "voice", text: await t(path), received }; } catch (e) { return `audio: couldn't transcribe it: ${(e as Error).message}`; }
  }
  const raw = readFileSync(path, "utf8");
  if (ext === ".txt" || ext === ".md" || ext === "") {
    const voice = /(^|[-_. ])(voice|transcript|dictat\w*)([-_. ]|$)/i.test(name);
    return { kind: voice ? "voice" : "text", text: raw, received };
  }
  if (ext === ".eml") return mailInput(parseMime(raw));
  if (ext === ".json") {
    // A phone shortcut can save {"text": "...", "kind": "voice", "subject": "..."}.
    let j: Record<string, unknown>;
    try { j = JSON.parse(raw); } catch { return "not valid JSON"; }
    if (typeof j.text !== "string") return 'JSON needs a "text" string';
    const kind = j.kind === "voice" || j.kind === "email" ? j.kind : "text";
    return { kind, text: j.text, subject: typeof j.subject === "string" ? j.subject : undefined, received: typeof j.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(j.date) ? j.date : received };
  }
  return `unsupported file type ${ext || "(none)"}; use .txt, .md, .eml or .json`;
}

function moveTo(dir: string, sub: string, name: string, why?: string) {
  const dest = join(dir, sub);
  mkdirSync(dest, { recursive: true });
  let target = join(dest, name);
  for (let i = 2; existsSync(target); i++) target = join(dest, `${basename(name, extname(name))}-${i}${extname(name)}`);
  renameSync(join(dir, name), target);
  if (why) writeFileSync(`${target}.why.txt`, why + "\n");
}

// One pass over the drop folder: each file at its top level becomes a capture, then moves to
// done/<date>/ (or failed/ with a .why.txt). Files still being synced (changed in the last
// settle seconds) wait for the next pass.
export async function dropOnce(root: string, dir: string, opts: { settleSeconds?: number } = {}): Promise<IntakeItem[]> {
  const d = expand(dir);
  if (!existsSync(d)) return [{ name: d, outcome: "failed", detail: "drop folder doesn't exist on this machine" }];
  const max = captureConfig(loadRules(root)).max_bytes * 4; // an .eml carries headers and MIME
  const settle = (opts.settleSeconds ?? 10) * 1000;
  const out: IntakeItem[] = [];
  for (const e of readdirSync(d, { withFileTypes: true }).filter((x) => x.isFile() && !x.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(d, e.name);
    const st = statSync(path);
    if (Date.now() - st.mtimeMs < settle) continue;
    const limit = AUDIO.has(extname(e.name).toLowerCase()) ? maxAudioBytes(root) : max;
    if (st.size > limit) { moveTo(d, "failed", e.name, `${st.size} bytes; the limit is ${limit}`); out.push({ name: e.name, outcome: "failed", detail: "too large" }); continue; }
    const input = await inputFromFile(root, path);
    if (typeof input === "string") { moveTo(d, "failed", e.name, input); out.push({ name: e.name, outcome: "failed", detail: input }); continue; }
    const r = await capture(root, input, undefined, { via: "drop" });
    const outcome = outcomeOf(r);
    if (outcome === "refused") { moveTo(d, "failed", e.name, r.refused); out.push({ name: e.name, outcome, detail: r.refused ?? "" }); continue; }
    moveTo(d, join("done", today()), e.name);
    out.push({ name: e.name, outcome, detail: detailOf(r) ?? "", file: r.file });
  }
  return out;
}

// ---------- one tick: mailbox, drop folder, then extraction on the hub ----------

export interface TickResult { mail: IntakeItem[]; drop: IntakeItem[]; extracted: { file: string; proposals: number; error?: string }[]; problems: string[] }

export async function intakeTick(root: string, opts: { mail?: MailSource; drop?: string; settleSeconds?: number; extract?: boolean } = {}): Promise<TickResult> {
  const cfg = captureConfig(loadRules(root));
  const res: TickResult = { mail: [], drop: [], extracted: [], problems: [] };
  const src = opts.mail ?? mailSourceFor(cfg.mail);
  if (src && "error" in src) res.problems.push(`mailbox: ${src.error}`);
  else if (src) {
    try { res.mail = await mailOnce(root, src, cfg.mail!); } catch (e) { res.problems.push(`mailbox: ${(e as Error).message}`); }
  }
  const drop = opts.drop ?? cfg.drop_folder;
  if (drop && existsSync(expand(drop))) {
    try { res.drop = await dropOnce(root, drop, { settleSeconds: opts.settleSeconds }); } catch (e) { res.problems.push(`drop folder: ${(e as Error).message}`); }
  }
  // Extraction needs the model and commits proposals: the hub (or a one-machine brain) only.
  const role = hubRole(root).mode;
  if (opts.extract !== false && (role === "hub" || role === "single")) {
    for (const x of await extractPending(root)) res.extracted.push({ file: x.file, proposals: x.items?.filter((i) => i.proposal).length ?? 0, ...(x.error ? { error: x.error } : {}) });
  }
  return res;
}
