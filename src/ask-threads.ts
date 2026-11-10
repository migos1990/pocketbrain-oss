// SPDX-License-Identifier: AGPL-3.0-only
// Ask's chats (owner, 2026-11-07, G716): "starting a new thread, and seeing previous threads …
// keeping the context within each session." Each chat is one file in the brain's git folder
// (gitSide, as quotes are), owner-only (0600): never committed, never in a cell, a view, the digest
// or a text. What the owner typed may hold a private value, so the screens decide what of a chat
// they show (src/dashboard/server.ts, G637, G717); this file only keeps and drops chats.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { gitSide } from "./quotes";
import { escapeRe } from "./util";

export const CHAT_KEEP_DAYS = 90; // a chat untouched this long is dropped
export const CHATS_MAX = 100; // the oldest chats go past this many
export const CHAT_TURNS = 200; // a chat keeps its newest turns
const ID = /^[0-9a-f]{16}$/;

export interface Chat<T> { id: string; created: number; updated: number; turns: T[] }

const dir = (root: string) => gitSide(root, "pb-ask");
const file = (root: string, id: string) => join(dir(root), `${id}.json`);
export const isChatId = (id: unknown): id is string => typeof id === "string" && ID.test(id);
export const newChatId = () => randomBytes(8).toString("hex");

function read<T>(root: string, id: string): Chat<T> | undefined {
  if (!isChatId(id) || !existsSync(file(root, id))) return undefined;
  try { const c = JSON.parse(readFileSync(file(root, id), "utf8")) as Chat<T>; return c?.id === id && Array.isArray(c.turns) ? c : undefined; } catch { return undefined; }
}

// Every chat kept, newest first; chats past their days or past CHATS_MAX are dropped here.
export function listChats<T>(root: string, now: number): Chat<T>[] {
  const d = dir(root);
  if (!existsSync(d)) return [];
  const all = readdirSync(d).filter((f) => f.endsWith(".json")).flatMap((f) => { const c = read<T>(root, f.slice(0, -5)); return c ? [c] : []; })
    .sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id));
  const keep = all.filter((c, i) => i < CHATS_MAX && c.updated >= now - CHAT_KEEP_DAYS * 86_400_000);
  for (const c of all) if (!keep.includes(c)) rmSync(file(root, c.id), { force: true });
  return keep;
}

export function getChat<T>(root: string, id: string, now: number): Chat<T> | undefined {
  return listChats<T>(root, now).find((c) => c.id === id);
}

// Adds a turn to a chat, starting it when `id` names none. Returns the chat as saved.
export function addTurn<T>(root: string, id: string | undefined, turn: T, now: number): Chat<T> {
  const c = (id ? getChat<T>(root, id, now) : undefined) ?? { id: newChatId(), created: now, updated: now, turns: [] };
  const next: Chat<T> = { ...c, updated: now, turns: [...c.turns, turn].slice(-CHAT_TURNS) };
  mkdirSync(dir(root), { recursive: true, mode: 0o700 });
  if (dir(root) === join(root, ".pb-ask") && !existsSync(join(dir(root), ".gitignore"))) writeFileSync(join(dir(root), ".gitignore"), "*\n");
  const tmp = `${file(root, next.id)}.tmp`;
  writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  renameSync(tmp, file(root, next.id));
  return next;
}

export function deleteChat(root: string, id: string): boolean {
  if (!isChatId(id) || !existsSync(file(root, id))) return false;
  rmSync(file(root, id), { force: true });
  return true;
}

// Every chat that names someone (by any of `needles`, lower-cased: a page id, a name, an address)
// is deleted whole, whatever its age: a forgotten person stays in no chat (src/forget.ts, G763).
// Returns how many went.
export function dropChatsNaming(root: string, needles: string[]): number {
  const d = dir(root), keys = needles.map((n) => n.toLowerCase()).filter(Boolean);
  if (!keys.length || !existsSync(d)) return 0;
  let n = 0;
  for (const f of readdirSync(d).filter((x) => x.endsWith(".json") || x.endsWith(".tmp"))) {
    let text = "";
    try { text = readFileSync(join(d, f), "utf8"); } catch { continue; }
    // The file as stored (JSON escapes a quote or a non-ASCII letter) and as read back.
    let said = text;
    try { said = `${text}\n${collect(JSON.parse(text)).join("\n")}`; } catch { /* a file cut short is matched as stored */ }
    // As whole words: "sam roy" is not in "balsam Royce". A deleted chat is not brought back.
    if (keys.some((k) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(k)}(?![\\p{L}\\p{N}])`, "u").test(said.toLowerCase()))) { rmSync(join(d, f), { force: true }); n++; }
  }
  return n;
}
const collect = (v: unknown): string[] => typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(collect) : v && typeof v === "object" ? Object.values(v).flatMap(collect) : [];
