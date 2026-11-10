// SPDX-License-Identifier: AGPL-3.0-only
// A fact that links a page the brain doesn't have (the Mac's probe, 2026-11-09: a person's org fact
// linked an org page that never existed, so nothing tied the two and the page failed the north
// star). The pipeline made the link, so it is an open question about data, and those become asks
// (standing decision): one per fact, in the owner's words, kept in inbox/links/. Nothing changes
// before his tap. He picks the page he meant (up to three whose name is close), keeps it as a plain
// name (a page that later takes that name links by itself, G674), or leaves it, which is
// remembered so it is never asked again. Code only, no model. docs/wiki.md "A link to a page you
// don't have".
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { loadBrain, isDisputed, sensitivityRank, today, type Note, type FactRecord } from "./brain";
import { records } from "./carve";
import { git } from "./git";
import { clock } from "./clock";
import { write } from "./write";
import { OWNER, OWNER_CONFIRMED, ownerRef } from "./owner";
import { CoreError } from "./core";
import { compareKey } from "./normalize";
import { renderTouchedPages } from "./wiki";
import { sha256 } from "./util";

export const LINKS_DIR = "inbox/links";
const MAX_CHOICES = 3;

export interface LinkFind { page: string; attr: string; target: string; words: string; choices: string[] }
export interface LinkAsk extends LinkFind { key: string; question: string; status: "waiting" | "picked" | "name" | "no"; at: string; decided?: string; picked?: string }
export type LinkAnswer = { pick: string } | "name" | "no";

const live = (r: FactRecord) => !r.valid_to && !r.retired && !r.unseen;
const active = (n: Note) => !["archived", "merged", "superseded"].includes(String(n.fm.status));
export const linkKey = (page: string, attr: string, target: string) => sha256(`link:${page}#${attr}->${target}`).slice(0, 16);
const fileOf = (key: string) => `${LINKS_DIR}/${key}.yaml`;
// The words a link stands for: its label, else its last path part as words.
const wordsOf = (target: string, label?: string) => (label?.trim() || target.split("/").pop()!.replace(/-/g, " ")).replace(/\s+/g, " ").trim();

export function linkAsks(root: string): LinkAsk[] {
  const dir = join(root, LINKS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort().flatMap((f) => {
    try { const a = YAML.parse(readFileSync(join(dir, f), "utf8")) as LinkAsk; return a?.key ? [a] : []; } catch { return []; }
  });
}
export const waitingLinkAsks = (root: string) => linkAsks(root).filter((a) => a.status === "waiting");

// Every live fact on a page below private that links a page the brain has under no id, title or
// alias; never one asked before. The pages it might mean: active pages in the same folder whose
// name shares the link's words, closest first.
export function findDangling(root: string, notes = loadBrain(root)): LinkFind[] {
  const P = sensitivityRank("private");
  const known = new Set<string>();
  for (const n of notes) for (const k of [n.fm.id, n.fm.title, ...(n.fm.aliases ?? [])]) if (k) known.add(String(k).toLowerCase());
  const asked = new Set(linkAsks(root).map((a) => a.key));
  const out: LinkFind[] = [];
  for (const n of notes) {
    if (!active(n) || sensitivityRank(n.fm.sensitivity) >= P || n.fm.type === "hub") continue;
    for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
      if (isDisputed(f)) continue;
      for (const r of records(f).filter(live)) {
        if (r.sensitivity && sensitivityRank(r.sensitivity) >= P) continue;
        for (const m of String(r.value ?? "").matchAll(/\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g)) {
          const target = m[1]!.trim();
          if (known.has(target.toLowerCase()) || target === "redacted" || target.startsWith("rules/")) continue;
          const key = linkKey(n.fm.id, attr, target);
          if (asked.has(key) || out.some((x) => linkKey(x.page, x.attr, x.target) === key)) continue;
          const words = wordsOf(target, m[2]);
          const want = compareKey(words).split(/\s+/).filter((w) => w.length >= 3);
          const folder = target.includes("/") ? target.split("/")[0] : undefined;
          const choices = notes.filter((x) => active(x) && x.fm.id !== n.fm.id && (!folder || x.fm.id.startsWith(`${folder}/`)) && sensitivityRank(x.fm.sensitivity) < P)
            .map((x) => ({ id: x.fm.id, hit: want.filter((w) => compareKey(String(x.fm.title ?? "")).split(/\s+/).includes(w)).length }))
            .filter((x) => x.hit > 0).sort((a, b) => b.hit - a.hit || a.id.localeCompare(b.id)).slice(0, MAX_CHOICES).map((x) => x.id);
          out.push({ page: n.fm.id, attr, target, words, choices });
        }
      }
    }
  }
  return out;
}

const ATTR_WORDS: Record<string, string> = { org: "workplace", parent: "parent page", project: "project", school: "school" };
const question = (f: LinkFind, title: (id: string) => string) => `${title(f.page)}'s ${ATTR_WORDS[f.attr] ?? f.attr.replace(/_/g, " ")} points to a page you don't have ("${f.words}"). Which did you mean?`;

// One ask per dangling fact found, in one hub commit; a fact asked before is never asked again.
export function raiseLinkAsks(root: string, o: { apply?: boolean } = {}): LinkFind[] {
  const notes = loadBrain(root);
  const found = findDangling(root, notes);
  if (o.apply === false || !found.length) return found;
  mkdirSync(join(root, LINKS_DIR), { recursive: true });
  const at = clock().toISOString();
  const title = (id: string) => String(notes.find((n) => n.fm.id === id)?.fm.title ?? id);
  const rels = found.map((f) => {
    const key = linkKey(f.page, f.attr, f.target);
    const ask: LinkAsk = { ...f, key, question: question(f, title), status: "waiting", at };
    writeFileSync(join(root, fileOf(key)), YAML.stringify(ask, { lineWidth: 0 }));
    return fileOf(key);
  });
  git(root, ["add", ...rels]);
  git(root, ["commit", "-q", "-m", `hub: ask about ${found.length === 1 ? "one link" : `${found.length} links`} to a page that doesn't exist\n\nWhy: a fact links a page the brain has under no id, title or alias; a question only, nothing changes before the owner answers.`], "hub");
  return found;
}

// The owner's answer: the page he meant (one of the choices) or the plain name, each his own word on
// the fact; or leave it, remembered. One commit each.
export function answerLink(root: string, key: string, answer: LinkAnswer): LinkAsk {
  const began = new Date(Math.min(Date.now(), clock().getTime()) - 1000).toISOString();
  const ask = linkAsks(root).find((a) => a.key === key);
  if (!ask) throw new CoreError(404, "no question about that link");
  if (ask.status !== "waiting") throw new CoreError(409, "that link was answered already");
  const d = today();
  let picked: string | undefined;
  if (answer !== "no") {
    if (typeof answer === "object" && !ask.choices.includes(answer.pick)) throw new CoreError(400, "that isn't one of the pages offered");
    picked = typeof answer === "object" ? answer.pick : undefined;
    const value = picked ? `[[${picked}]]` : ask.words;
    const r = write(root, { agent: OWNER, id: ask.page, attribute: ask.attr, value, as_of: d, sources: [ownerRef(d, "link")], verification: OWNER_CONFIRMED } as never, { owner: true });
    if (r.outcome !== "committed" && r.outcome !== "noop") throw new CoreError(409, r.message ?? "the page wasn't changed");
  }
  const status: LinkAsk["status"] = answer === "no" ? "no" : picked ? "picked" : "name";
  const done: LinkAsk = { ...ask, status, decided: d, ...(picked ? { picked } : {}) };
  writeFileSync(join(root, fileOf(key)), YAML.stringify(done, { lineWidth: 0 }));
  git(root, ["add", fileOf(key)]);
  git(root, ["commit", "-q", "-m", `owner: ${status === "no" ? "leaves" : "answers"} a link to a page that doesn't exist\n\nWhy: the owner answered the question about ${ask.page}#${ask.attr}.`], OWNER);
  if (answer !== "no") try { renderTouchedPages(root, began); } catch { /* the night run writes it */ }
  return done;
}
