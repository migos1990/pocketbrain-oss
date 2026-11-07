// SPDX-License-Identifier: AGPL-3.0-only
// The owner's own notes on a page (owner, 2026-11-07, G718, G719): "## Your notes", text only the
// owner typed. The page's Edit replaces them (Kind: owner-page-edit); a sentence on a page the box
// caught no fact in is kept there, dated (Kind: owner-page-note). Each is one owner commit through
// saveNoteText, so every check on a page's text holds; the night writer keeps an owner-written
// "Your notes" where it is (src/wiki.ts). The page says when the owner last changed them.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadBrain, today } from "./brain";
import { git } from "./git";
import { saveNoteText } from "./dashboard/edit";
import { sections } from "./wiki";
import { CoreError } from "./core";
import { sayDay } from "./diary";

export const YOUR_NOTES = "Your notes";
export const NOTE_MAX = 2000;
const DEF = /^\[\^[^\]\s]+\]:/m;

const fileOf = (root: string, id: string) => {
  const n = loadBrain(root).find((x) => x.fm.id === id);
  if (!n || !existsSync(join(root, `${id}.md`))) throw new CoreError(404, "no such page");
  return { n, path: join(root, `${id}.md`) };
};
const splitFile = (raw: string) => { const m = raw.match(/^(---\n[\s\S]*?\n---\n?)([\s\S]*)$/); return m ? { head: m[1]!, body: m[2]! } : { head: "", body: raw }; };

// The owner's notes on a page as they stand, "" when there are none.
export function yourNotes(body: string): string {
  return sections(body.split(DEF)[0] ?? body).find((x) => x.heading === YOUR_NOTES)?.text.trim() ?? "";
}

// The body with its "Your notes" section set to `text` (gone when empty), before any footnote
// definitions so they stay at the end.
export function withYourNotes(body: string, text: string): string {
  const at = body.search(DEF), main = at < 0 ? body : body.slice(0, at), defs = at < 0 ? "" : body.slice(at);
  const re = new RegExp(`^## ${YOUR_NOTES}\\n[\\s\\S]*?(?=^## |(?![\\s\\S]))`, "m");
  const cut = main.replace(re, "").replace(/\n{3,}/g, "\n\n").trimEnd();
  const sec = text.trim() ? `\n\n## ${YOUR_NOTES}\n${text.trim()}\n` : "\n";
  return `${cut}${sec}${defs ? `\n${defs.trimEnd()}\n` : ""}`.replace(/^\n+/, "");
}

function save(root: string, id: string, text: string, kind: "owner-page-edit" | "owner-page-note"): string {
  const { path } = fileOf(root, id);
  const raw = readFileSync(path, "utf8"), { head, body } = splitFile(raw);
  const next = `${head}${withYourNotes(body, text)}`;
  if (next === raw) return "No change.";
  saveNoteText(root, id, next, kind === "owner-page-edit" ? "edit your notes on" : "keep a note on", { trailers: [`Kind: ${kind}`, `Day: ${today()}`] });
  return "Saved.";
}

// The page's Edit: the owner's notes replaced by what they typed ("" takes them away).
export function setYourNotes(root: string, id: string, text: string): string {
  if (text.length > NOTE_MAX) throw new CoreError(400, "that's too long for a page's notes");
  return save(root, id, text.replace(/\r\n/g, "\n"), "owner-page-edit");
}

// A sentence kept as a note, dated: "You, 8 Oct: …".
export function addYourNote(root: string, id: string, said: string): string {
  const line = said.replace(/\s+/g, " ").trim();
  if (!line) throw new CoreError(400, "there's nothing to keep");
  if (line.length > 500) throw new CoreError(400, "that's too long for a note");
  const { n } = fileOf(root, id);
  const was = yourNotes(splitFile(readFileSync(join(root, `${n.fm.id}.md`), "utf8")).body);
  return save(root, id, `${was ? `${was}\n\n` : ""}You, ${dayWords(today())}: ${line}`, "owner-page-note");
}

// "8 Oct", with the year only when it isn't this year's.
export const dayWords = (day: string) => sayDay(day).replace(new RegExp(` ${today().slice(0, 4)}$`), "");

// The day the owner last changed a page's notes by hand, if ever.
export function editedOn(root: string, id: string): string | undefined {
  // The owner's day from the commit's Day: trailer (today(), so PB_TODAY and the owner's clock hold).
  const msg = git(root, ["log", "-1", "--format=%B", "-E", "--grep=^Kind: owner-page-(edit|note)$", "--", `${id}.md`]);
  return msg.match(/^Day: (\d{4}-\d{2}-\d{2})$/m)?.[1];
}
