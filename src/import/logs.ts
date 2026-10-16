// SPDX-License-Identifier: AGPL-3.0-only
// Louis forwarding a vendor's export into an agent's log archive (docs/agent-logs.md, section 4).
// Each parser turns one export file into LogRequests; ingestLog does the rest, so imports get
// the same ids, redaction, holds and limits as logs an agent sends itself.
// Formats: plain text or Markdown (one log), our own JSON ({...} or [{...}]), a Claude Code
// session (.jsonl), a claude.ai export (conversations.json) and a ChatGPT export
// (conversations.json). Anything else: paste it as text.
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { LogRequest, LogTurn } from "../logs";

export type LogFormat = "auto" | "text" | "json" | "claude-code" | "claude-export" | "chatgpt-export";

const day = (t: unknown): string | undefined => {
  if (typeof t === "number") return new Date(t * (t < 1e12 ? 1000 : 1)).toISOString().slice(0, 10);
  if (typeof t === "string" && /^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  return undefined;
};
const hhmm = (t: unknown): string | undefined => {
  const iso = typeof t === "number" ? new Date(t * (t < 1e12 ? 1000 : 1)).toISOString() : typeof t === "string" ? t : undefined;
  return iso?.match(/T(\d{2}:\d{2})/)?.[1];
};

// Claude Code: one JSON object per line; user and assistant lines carry message.content as a
// string or a list of blocks. Tool calls become one short line, tool results are dropped.
function claudeCode(text: string): LogRequest[] {
  const sessions = new Map<string, { turns: LogTurn[]; first?: string }>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "user" && e.type !== "assistant") continue;
    const id = String(e.sessionId ?? "session");
    const s = sessions.get(id) ?? { turns: [] };
    sessions.set(id, s);
    const c = e.message?.content;
    const parts: string[] = typeof c === "string" ? [c] : Array.isArray(c) ? c.flatMap((b: any) =>
      b?.type === "text" ? [String(b.text)] : b?.type === "tool_use" ? [`[tool: ${b.name}]`] : []) : [];
    const body = parts.join("\n").trim();
    if (!body) continue;
    s.first ??= e.timestamp;
    s.turns.push({ role: e.type, at: hhmm(e.timestamp), text: body });
  }
  return [...sessions].filter(([, s]) => s.turns.length).map(([id, s]) => ({ log_id: `claude-code:${id}`, date: day(s.first), kind: "conversation", channel: "claude-code", turns: s.turns }));
}

function claudeExport(list: any[]): LogRequest[] {
  return list.filter((c) => Array.isArray(c?.chat_messages)).map((c) => ({
    log_id: `claude.ai:${c.uuid}`, date: day(c.created_at), kind: "conversation" as const, channel: "claude.ai", title: c.name || undefined,
    turns: c.chat_messages.map((m: any) => ({ role: String(m.sender ?? "?"), at: hhmm(m.created_at), text: String(m.text ?? (m.content ?? []).map((b: any) => b?.text ?? "").join("\n")) }))
      .filter((t: LogTurn) => t.text.trim()),
  })).filter((l) => l.turns.length);
}

// ChatGPT: a tree in `mapping`; follow parent links back from current_node for the shown branch.
function chatgptExport(list: any[]): LogRequest[] {
  return list.filter((c) => c?.mapping).map((c) => {
    const turns: LogTurn[] = [];
    let node = c.current_node;
    const seen = new Set<string>();
    while (node && c.mapping[node] && !seen.has(node)) {
      seen.add(node);
      const m = c.mapping[node].message;
      const parts = (m?.content?.parts ?? []).filter((p: unknown) => typeof p === "string").join("\n").trim();
      if (m && parts && ["user", "assistant"].includes(m.author?.role)) turns.unshift({ role: m.author.role, at: hhmm(m.create_time), text: parts });
      node = c.mapping[node].parent;
    }
    return { log_id: `chatgpt:${c.conversation_id ?? c.id}`, date: day(c.create_time), kind: "conversation" as const, channel: "chatgpt", title: c.title || undefined, turns };
  }).filter((l) => l.turns.length);
}

export function parseExport(file: string, format: LogFormat = "auto", opts: { date?: string } = {}): LogRequest[] {
  const text = readFileSync(file, "utf8");
  const asText = (): LogRequest[] => [{ log_id: `file:${basename(file)}`, date: opts.date ?? day(statSync(file).mtime.toISOString()), kind: "conversation", title: basename(file).replace(/\.(txt|md)$/, ""), text }];
  if (format === "text") return asText();
  if (format === "claude-code" || (format === "auto" && file.endsWith(".jsonl"))) return claudeCode(text);
  let data: any;
  try { data = JSON.parse(text); } catch { if (format === "auto") return asText(); throw new Error(`${file} is not JSON`); }
  const list = Array.isArray(data) ? data : [data];
  if (format === "claude-export" || (format === "auto" && list.some((c) => Array.isArray(c?.chat_messages)))) return claudeExport(list);
  if (format === "chatgpt-export" || (format === "auto" && list.some((c) => c?.mapping))) return chatgptExport(list);
  return list.map((l) => ({ ...l, date: l.date ?? opts.date }));
}
