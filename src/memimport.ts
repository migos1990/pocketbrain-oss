// SPDX-License-Identifier: AGPL-3.0-only
// Memory import (docs/memory-sync.md, "Bringing memory in"): what an assistant already remembers
// (Claude Code's memory files, a claude.ai memory export, Town's or Instinct's answer to "what do
// you remember?") and the owner's own notes become proposals in the inbox. It is the capture
// pipeline (src/capture.ts) with a different origin, so nothing new decides anything:
// - each chunk is stored as a capture (secrets removed, injection shapes held for the owner, the
//   same text twice is a no-op), then a model lists candidate facts with their quotes;
// - deterministic checks drop what the text doesn't say and compare the rest with the brain:
//   known values are skipped, changes and new facts become proposals naming the old value;
// - an agent's memory is cited as that agent's observation (self-reported), never the owner's
//   word; the owner's own notes are the owner's word. Nothing is committed until the owner accepts.
import { existsSync, readFileSync, readdirSync, statSync, lstatSync } from "node:fs";
import { join, basename } from "node:path";
import { loadRules, ownerName } from "./rules";
import { capture, captureConfig, type CaptureResult } from "./capture";
import { memoryFiles, chunks } from "./memsync";
import type { Model } from "./model";

export const ME = "me";

// Markdown and text as they are; JSON (a memory export) as its string values, one per line,
// leaving out values that are only an id or a timestamp (a claude.ai export's account_uuid).
const ID_ONLY = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)$/i;

// A vendor's chat history is not its memory (G493). What a vendor's export keeps of its memory:
// - ChatGPT (conversations.json): each memory save is a message the assistant sends to its memory
//   tool (recipient "bio"); only those are read. Unconfirmed against a real export: the layout is
//   what ChatGPT's memory tool is known to write, not a documented format.
// - claude.ai: memories.json is read whole; conversations.json is chat history and read as nothing.
// - Gemini: Google's download holds chats, Gems and activity (MyActivity.json), no saved info, so
//   activity is read as nothing; paste the Saved info page as text instead.
// Chat history goes to an agent's log archive (`pocketbrain logs import`), never into memory.
export type MemoryShape = "text" | "json" | "chatgpt" | "chat-history" | "gemini-activity";
const chatgptSaves = (list: any[]): string[] => list.flatMap((c) => Object.values<any>(c?.mapping ?? {})
  .map((n) => n?.message)
  .filter((m) => m?.recipient === "bio" && m?.author?.role === "assistant")
  .sort((a, b) => (a.create_time ?? 0) - (b.create_time ?? 0))
  .flatMap((m) => (m.content?.parts ?? []).filter((x: unknown): x is string => typeof x === "string" && !!x.trim()).map((x: string) => x.trim())));

export function memoryShape(data: unknown): MemoryShape {
  const list = Array.isArray(data) ? data : [data];
  if (list.some((c: any) => c && typeof c === "object" && c.mapping && typeof c.mapping === "object")) return "chatgpt";
  if (list.some((c: any) => Array.isArray(c?.chat_messages))) return "chat-history";
  if (list.some((c: any) => typeof c?.header === "string" && /gemini|bard/i.test(c.header) && typeof c?.time === "string")) return "gemini-activity";
  return "json";
}

export function readMemory(paths: string[]): { name: string; text: string; shape?: MemoryShape }[] {
  const out: { name: string; text: string; shape?: MemoryShape }[] = [];
  const add = (p: string) => {
    if (!existsSync(p)) return;
    // Inside a folder, links are skipped (G76): one could point at the brain itself.
    if (statSync(p).isDirectory()) { for (const n of readdirSync(p).sort()) if (!n.startsWith(".") && !lstatSync(join(p, n)).isSymbolicLink()) add(join(p, n)); return; }
    const raw = readFileSync(p, "utf8");
    if (/\.json$/i.test(p)) {
      let data: unknown;
      try { data = JSON.parse(raw); } catch { out.push({ name: basename(p), text: raw, shape: "text" }); return; }
      const shape = memoryShape(data);
      if (shape === "chatgpt") { out.push({ name: basename(p), text: chatgptSaves(Array.isArray(data) ? data : [data]).join("\n"), shape }); return; }
      if (shape !== "json") { out.push({ name: basename(p), text: "", shape }); return; }
      const lines: string[] = [];
      const walk = (v: unknown) => { if (typeof v === "string") { if (v.trim() && !ID_ONLY.test(v.trim())) lines.push(v.trim()); } else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x); };
      walk(data);
      out.push({ name: basename(p), text: lines.join("\n"), shape });
    } else if (/\.(md|markdown|txt)$/i.test(p)) out.push({ name: basename(p), text: raw, shape: "text" });
  };
  for (const p of paths) add(p.replace(/^~(?=\/|$)/, process.env.HOME ?? ""));
  return out.filter((x) => x.text.trim());
}

// Files given that hold no memory (chat history, Gemini activity), named for the owner.
export function skippedMemory(paths: string[]): { name: string; shape: MemoryShape }[] {
  const seen: { name: string; shape: MemoryShape }[] = [];
  const add = (p: string) => {
    if (!existsSync(p)) return;
    if (statSync(p).isDirectory()) { for (const n of readdirSync(p).sort()) if (!n.startsWith(".") && !lstatSync(join(p, n)).isSymbolicLink()) add(join(p, n)); return; }
    if (!/\.json$/i.test(p)) return;
    try { const s = memoryShape(JSON.parse(readFileSync(p, "utf8"))); if (s === "chat-history" || s === "gemini-activity") seen.push({ name: basename(p), shape: s }); } catch { /* not JSON: read as text */ }
  };
  for (const p of paths) add(p.replace(/^~(?=\/|$)/, process.env.HOME ?? ""));
  return seen;
}

// `who` is an agent in policy.yaml or "me". Without paths, an agent's own memory.files are read.
export async function importMemory(root: string, who: string, paths: string[], model?: Model): Promise<{ name: string; result: CaptureResult }[]> {
  const rules = loadRules(root);
  if (who !== ME && !rules.policy.agents[who]) throw new Error(`no agent ${who} in policy.yaml (or use "${ME}" for ${ownerName(rules)}'s own notes)`);
  const files = paths.length ? paths : who === ME ? [] : memoryFiles(rules, who);
  if (!files.length) throw new Error(who === ME ? "give the files or folders of your notes" : `give ${who}'s memory files, or set memory.files for it in policy.yaml`);
  const max = captureConfig(rules).max_bytes;
  const out: { name: string; result: CaptureResult }[] = [];
  for (const f of readMemory(files)) {
    for (const [i, text] of chunks(f.text, max).entries()) {
      const result = await capture(root, { kind: "text", text }, model, who === ME ? { via: "cli" } : { agent: who, via: "import" });
      out.push({ name: chunks(f.text, max).length > 1 ? `${f.name} part ${i + 1}` : f.name, result });
    }
  }
  return out;
}
