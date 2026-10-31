// SPDX-License-Identifier: AGPL-3.0-only
// A page as the owner reads it (phone UI spec §2.2): the title, what kind of page and how many
// sources, the prose with its numbered references, Mentioned on, Changed (this page's diary lines,
// with Undo), then Details (the facts) and Who sees this, each one row. The box sits at the bottom
// with the page as its subject. Standalone like the home (html-home.ts); fixed words in PAGE_COPY.
import type { Note, FactRecord } from "../brain";
import { isList, isDisputed } from "../brain";
import type { State } from "./data";
import type { HomeLine } from "./home";
import type { SayReply } from "../owner-say";
import { wikiBody, wikiLinks } from "./html-brain";
import { displayName } from "../diary";
import { connections, audience, kindLabel, folderOf } from "./browse";
import { agentLabel } from "./labels";
import { refString } from "../sources";
import { keptQuotes, itemRef } from "../quotes";
import { sensitiveShape } from "../shape";
import { CSS, esc, hidden, href, line, replyHtml, signInAgain } from "./html-home";
import { sensitivityRank } from "../brain";

export const PAGE_COPY = {
  back: "Home",
  sources: "{n} sources",
  oneSource: "1 source",
  mentioned: "Mentioned on",
  changed: "Changed",
  details: "Details",
  who: "Who sees this",
  nobody: "Only you.",
  hide: "Hide from {agent}",
  showAgain: "Show to {agent} again",
  sees: "sees it",
  hiddenByYou: "hidden by you",
  cant: "doesn't see it",
  level: "How private",
  levelNote: "A less private level can let more assistants see it. Facts you marked private stay private.",
  save: "Save",
  box: "What changed about {name}?",
  send: "Send",
  empty: "Nothing written here yet. Tell me something about {name}.",
  shut: "private · sign in again to see it",
  shutPage: "This page is private. Sign in again to read it.",
  openPrivate: "Only you see this page. It stays open 10 minutes after you sign in.",
  edit: "Edit this page",
} as const;

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));
const PAGE_CSS = `
.top{display:flex;align-items:center;min-height:44px}
.top a{color:var(--text-2);font-size:15px;display:inline-flex;align-items:center;min-height:44px}
h1{font-size:26px;line-height:32px;font-weight:600;margin:4px 0 0}
.kind{color:var(--text-2);font-size:15px;margin:0 0 16px}
.prose{font-size:18px;line-height:29px}
.prose h2,.prose h3{font-size:17px;color:var(--text);margin:20px 0 4px;text-transform:none;letter-spacing:0}
.prose sup a{font-size:13px;display:inline-block;min-width:24px;text-align:center}
.prose ol{padding-left:24px;color:var(--text-2);font-size:15px;line-height:22px}
.prose ol li{margin:0 0 8px}
details{border-top:1px solid var(--line)}
details summary{min-height:44px;display:flex;align-items:center;cursor:pointer;font-weight:500}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0 0 16px;font-size:15px;line-height:22px}
dt{color:var(--text-2)}dd{margin:0;overflow-wrap:anywhere}
.pinned{position:sticky;bottom:0;background:var(--bg);padding:12px 0 calc(12px + env(safe-area-inset-bottom));margin-top:24px;border-top:1px solid var(--line)}
.pinned form.box{margin:0}
.prose details.quote{border:0}.prose details.quote summary{min-height:44px;font-weight:400;color:var(--text-2)}
.prose blockquote{margin:0 0 8px;padding-left:12px;border-left:2px solid var(--line);color:var(--text)}
`;

// A value as text with its [[links]] kept, for wikiLinks to turn into links to their pages.
const linkText = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "string" ? v : Array.isArray(v) ? v.map(linkText).join(", ") : typeof v === "object" ? Object.values(v as object).map(linkText).join(", ") : String(v));

// A private value, or one still held for the owner's Show, shows only after a fresh sign-in.
const shut = (n: Note, r: FactRecord) => !!r.unseen || sensitivityRank(r.sensitivity ?? n.fm.sensitivity) >= sensitivityRank("private");

// The items a shut value cites, or one shaped like money, health or legal: their kept words can
// carry that value, so they open after a fresh sign-in too (G451 under spec §8).
function shutItems(s: State, n: Note): Set<string> {
  const out = new Set<string>();
  for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
    for (const r of isDisputed(f) ? f.candidates : isList(f) ? f.items : [f as FactRecord]) {
      if (r.valid_to || !(shut(n, r) || n.fm.type === "money" || n.fm.id.startsWith("money/") || sensitiveShape(s.rules, attr, r.value))) continue;
      for (const x of r.sources ?? []) out.add(itemRef(refString(x)));
    }
  }
  return out;
}

function facts(s: State, n: Note, fresh: boolean): string {
  const rows = Object.entries(n.fm.facts ?? {}).map(([attr, f]) => {
    const live = isDisputed(f) ? [] : isList(f) ? f.items.filter((i) => !i.valid_to) : [f as FactRecord];
    if (!live.length) return "";
    if (!fresh && live.some((r) => shut(n, r))) return `<dt>${esc(attr.replace(/_/g, " "))}</dt><dd class="kind">${PAGE_COPY.shut}</dd>`;
    const v = wikiLinks(s, live.map((r) => linkText(r.value)).join(", ")).replace(/href="\/note\//g, 'href="/p/');
    // A date said as "last week" stays a guess: "since around".
    const first = [...live].filter((r) => r.as_of).sort((a, b) => String(a.as_of).localeCompare(String(b.as_of)))[0];
    const since = first ? `since ${first.as_of_approx ? "around " : ""}${first.as_of}` : "";
    return `<dt>${esc(attr.replace(/_/g, " "))}</dt><dd>${v}${since ? ` <span class="kind">${esc(since)}</span>` : ""}</dd>`;
  }).join("");
  return rows ? `<dl>${rows}</dl>` : "";
}

function sourceCount(n: Note): number {
  const all = new Set<string>();
  for (const f of Object.values(n.fm.facts ?? {})) {
    const recs = isDisputed(f) ? f.candidates : isList(f) ? f.items : [f as FactRecord];
    for (const r of recs) for (const x of r.sources ?? []) all.add(refString(x));
  }
  return all.size;
}

const LEVELS: [string, string][] = [["public", "Public"], ["personal", "Personal"], ["private", "Private: only assistants allowed private pages"], ["secret", "Secret: no assistant"]];

// Who sees this page, and the owner's say on it, here on the page (outside review v5): hide it from
// one assistant by name, show it again (only undoes a hide, never adds a share), or set how private
// the page is (edit.ts hideNoteFrom, showNoteTo, setNoteSensitivity, through the same actions).
function whoSees(s: State, csrf: string, n: Note, closed: boolean): string {
  const id = n.fm.id;
  const seen = audience(s, id).seen;
  const names = seen.map((a) => agentLabel(s.rules, a));
  if (closed) return `<details><summary>${PAGE_COPY.who}</summary><p>${names.length ? esc(names.join(", ")) : PAGE_COPY.nobody}</p></details>`;
  const act = (action: string, f: Record<string, string>, label: string) => `<form method="post" action="/action/${action}">${hidden(csrf, f)}<button>${esc(label)}</button></form>`;
  const rows = s.agents.map((a) => {
    const byName = (s.rules.policy.agents[a.name]?.exclude ?? []).includes(id);
    const state = seen.includes(a.name) ? PAGE_COPY.sees : byName ? PAGE_COPY.hiddenByYou : PAGE_COPY.cant;
    const btn = seen.includes(a.name) ? act("note-hide", { id, agent: a.name }, fill(PAGE_COPY.hide, { agent: a.label }))
      : byName ? act("note-show", { id, agent: a.name }, fill(PAGE_COPY.showAgain, { agent: a.label })) : "";
    return `<li class="line"><div class="t">${esc(a.label)} · ${esc(state)}</div>${btn}</li>`;
  }).join("");
  const level = `<details><summary>${PAGE_COPY.level}</summary><p class="quiet">${PAGE_COPY.levelNote}</p><form method="post" action="/action/note-sensitivity">${hidden(csrf, { id })}<select name="sensitivity" aria-label="${PAGE_COPY.level}">${LEVELS.map(([v, l]) => `<option value="${v}"${v === n.fm.sensitivity ? " selected" : ""}>${esc(l)}</option>`).join("")}</select> <button>${PAGE_COPY.save}</button></form></details>`;
  return `<details id="who"><summary>${PAGE_COPY.who}</summary><p>${names.length ? esc(names.join(", ")) : PAGE_COPY.nobody}</p>${rows ? `<ul>${rows}</ul>` : ""}${level}</details>`;
}

export function ownerPage(s: State, csrf: string, n: Note, lines: HomeLine[], o: { said?: string; reply?: SayReply; flash?: string; fresh?: boolean } = {}): string {
  const fresh = !!o.fresh, closed = !fresh && sensitivityRank(n.fm.sensitivity) >= sensitivityRank("private");
  const name = displayName(n.fm.id, n.fm.title);
  const first = name.split(/\s+/)[0]!;
  const count = sourceCount(n);
  const held = fresh ? new Set<string>() : shutItems(s, n);
  let withheld = false;
  const prose = wikiBody(s, n.body, (ref) => {
    if (!held.has(itemRef(ref))) return keptQuotes(s.root, ref);
    withheld ||= keptQuotes(s.root, ref).length > 0;
    return [];
  }, 2).replace(/href="\/note\//g, 'href="/p/');
  const c = connections(s, n);
  const mentioned = c.mentionedIn.length ? `<h2>${PAGE_COPY.mentioned}</h2><ul>${c.mentionedIn.map((x) => `<li class="line"><div class="t"><a href="${href(x.fm.id)}">${esc(displayName(x.fm.id, x.fm.title))}</a></div></li>`).join("")}</ul>` : "";
  const changed = lines.length ? `<h2>${PAGE_COPY.changed}</h2><ul>${lines.map((l) => line(l, csrf, n.fm.id)).join("")}</ul>` : "";
  const who = whoSees(s, csrf, n, closed);
  const details = closed ? "" : facts(s, n, fresh);
  const open = fresh && sensitivityRank(n.fm.sensitivity) >= sensitivityRank("private") ? `<p class="kind">${PAGE_COPY.openPrivate}</p>` : "";
  const body = open + (closed ? `<p class="quiet">${PAGE_COPY.shutPage}</p>${signInAgain(csrf)}` : details.includes(PAGE_COPY.shut) || withheld ? `${proseOrEmpty()}${signInAgain(csrf)}` : proseOrEmpty());
  function proseOrEmpty() { return prose.trim() ? `<div class="prose">${prose}</div>` : `<p class="quiet">${esc(fill(PAGE_COPY.empty, { name: first }))}</p>`; }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>${esc(name)}</title><style>${CSS}${PAGE_CSS}</style></head><body><main class="wrap">
<div class="top"><a href="/home">‹ ${PAGE_COPY.back}</a></div>
<h1>${esc(name)}</h1><p class="kind">${esc(String(n.fm.type ?? kindLabel(folderOf(n.fm.id))))} · ${count === 1 ? PAGE_COPY.oneSource : fill(PAGE_COPY.sources, { n: count })}</p>
${body}${mentioned}${changed}
${details ? `<details><summary>${PAGE_COPY.details}</summary>${details}<p><a href="/note/${n.fm.id.split("/").map(encodeURIComponent).join("/")}">${PAGE_COPY.edit}</a></p></details>` : ""}${who}
<div class="pinned">${replyHtml(csrf, { ...o, page: n.fm.id })}<form class="box" method="post" action="/say">${hidden(csrf, { page: n.fm.id })}<label class="sr" for="q">${esc(fill(PAGE_COPY.box, { name: first }))}</label><input type="text" id="q" name="q" placeholder="${esc(fill(PAGE_COPY.box, { name: first }))}" autocomplete="off" enterkeyhint="send" maxlength="500"><button>${PAGE_COPY.send}</button></form></div>
</main></body></html>`;
}
