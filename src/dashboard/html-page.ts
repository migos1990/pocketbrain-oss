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
import { esc, hidden, href, line, replyHtml, signInAgain } from "./html-home";
import { appPage } from "./html-app";
import { plain } from "./home";
import { ownerConflicts } from "../core";
import { inboxConflicts } from "../settle-inbox";
import { MADE } from "../wiki";
import { sensitivityRank } from "../brain";

export const PAGE_COPY = {
  back: "Memory",
  next: "Next:",
  disagree: "Two sources disagree · settle",
  sources: "{n} sources",
  oneSource: "1 source",
  mentioned: "Mentioned on",
  changed: "What changed",
  details: "Details",
  who: "Who sees this",
  whoName: "Who sees {name}",
  change: "Change who sees it",
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
  editShort: "Edit",
  roleAt: "{role} at {org}",
} as const;

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));
const PAGE_CSS = `
.band{margin:calc(-20px - env(safe-area-inset-top)) max(-16px,calc(-1 * env(safe-area-inset-left))) 20px;padding:calc(20px + env(safe-area-inset-top)) 20px 22px;border-radius:0 0 28px 28px;background:var(--soft);display:flex;flex-direction:column;gap:14px}
.band.t-work{background:var(--t-work);--band-text:var(--t-work-text)}.band.t-teaching{background:var(--t-teaching);--band-text:var(--t-teaching-text)}.band.t-personal{background:var(--t-personal);--band-text:var(--t-personal-text)}
.band .bar{display:flex;justify-content:space-between;align-items:center}
.band .bar a{color:var(--band-text,var(--text));font-weight:700;display:inline-flex;align-items:center;min-height:44px}
.band .head{display:flex;gap:16px;align-items:center}.band .head>div{min-width:0}
.band .face{flex:none;width:68px;height:68px;border-radius:50%;background:var(--bg);color:var(--band-text,var(--text));display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800}
.band h1{font-size:26px;line-height:32px;overflow-wrap:anywhere}
.band .kind{margin:2px 0 0;font-size:14px;line-height:20px;color:var(--band-text,var(--muted));font-weight:600}
.band .chips{margin:0}.band .chip{font-size:13px;line-height:18px;font-weight:700;color:var(--band-text,var(--text));background:var(--bg);border-radius:999px;padding:6px 12px}
.prose{font-size:17px;line-height:26px}
.prose h2,.prose h3{font-size:17px;color:var(--text);margin:20px 0 4px}
.prose sup a{font-size:12px;display:inline-block;min-width:24px;padding-left:2px;text-align:left}
.prose ol{padding-left:24px;color:var(--muted);font-size:13px;line-height:18px;list-style:decimal}
.prose ol li{margin:0 0 8px}
.prose details.quote{border:0}.prose details.quote summary{min-height:44px;font-weight:500;color:var(--muted)}
.prose blockquote{margin:0 0 8px;padding-left:12px;border-left:2px solid var(--line);color:var(--text)}
a.project{margin:18px 0 0;background:var(--soft);border-radius:20px;padding:14px 16px;display:flex;flex-direction:column;gap:8px;color:var(--text)}
.project .nm{font-weight:700}.project .flag{align-self:flex-start;font-size:13px;line-height:18px;font-weight:700;color:var(--warn);background:var(--warn-bg);border-radius:8px;padding:4px 10px}
h2.sec{font-size:17px;line-height:24px;font-weight:700;color:var(--text);margin:22px 0 4px}
details{border-top:1px solid var(--line);margin:8px 0 0}
details summary{min-height:44px;display:flex;align-items:center;cursor:pointer;font-weight:700}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0 0 16px;font-size:15px;line-height:22px}
dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
.seen{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:16px 0 0;font-size:13px;line-height:18px;color:var(--muted)}
.seen b{font-weight:700}.seen span{background:var(--soft);border-radius:999px;padding:3px 10px;font-weight:600;color:var(--text)}
.wrap.page{padding-bottom:calc(190px + env(safe-area-inset-bottom))}
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
  const first = displayName(id, n.fm.title).split(/\s+/)[0]!;
  const chips = `<div class="seen"><b>${esc(fill(PAGE_COPY.whoName, { name: first }))}</b>${names.length ? names.map((x) => `<span>${esc(x)}</span>`).join("") : esc(PAGE_COPY.nobody)}</div>`;
  if (closed) return chips;
  const act = (action: string, f: Record<string, string>, label: string) => `<form method="post" action="/action/${action}">${hidden(csrf, f)}<button>${esc(label)}</button></form>`;
  const rows = s.agents.map((a) => {
    const byName = (s.rules.policy.agents[a.name]?.exclude ?? []).includes(id);
    const state = seen.includes(a.name) ? PAGE_COPY.sees : byName ? PAGE_COPY.hiddenByYou : PAGE_COPY.cant;
    const btn = seen.includes(a.name) ? act("note-hide", { id, agent: a.name }, fill(PAGE_COPY.hide, { agent: a.label }))
      : byName ? act("note-show", { id, agent: a.name }, fill(PAGE_COPY.showAgain, { agent: a.label })) : "";
    return `<li class="line"><div class="t">${esc(a.label)} · ${esc(state)}</div>${btn}</li>`;
  }).join("");
  const level = `<details><summary>${PAGE_COPY.level}</summary><p class="quiet">${PAGE_COPY.levelNote}</p><form method="post" action="/action/note-sensitivity">${hidden(csrf, { id })}<select name="sensitivity" aria-label="${PAGE_COPY.level}">${LEVELS.map(([v, l]) => `<option value="${v}"${v === n.fm.sensitivity ? " selected" : ""}>${esc(l)}</option>`).join("")}</select> <button>${PAGE_COPY.save}</button></form></details>`;
  return `${chips}<details id="who"><summary>${PAGE_COPY.change}</summary>${rows ? `<ul>${rows}</ul>` : ""}${level}</details>`;
}

// The page's open question as a card (the brief's Person board): what's next, and a conflict on the
// page with its way to settle. A value shows only where Details would show it.
function projectCard(s: State, n: Note, fresh: boolean): string {
  const id = n.fm.id;
  const open = [...ownerConflicts(s.root, s.now), ...inboxConflicts(s.root)].find((c) => c.page === id);
  const f = n.fm.facts?.next_step;
  const r = f && !isDisputed(f) && !isList(f) ? f as FactRecord : undefined;
  const next = r && !r.valid_to && (fresh || !shut(n, r)) ? plain(r.value, (x) => { const t = s.notes.find((m) => m.fm.id === x)?.fm.title; return t === undefined ? undefined : String(t); }) : "";
  if (!open && !next) return "";
  const inner = `<span class="nm">${esc(displayName(id, n.fm.title))}</span>${next ? `<span>${PAGE_COPY.next} ${esc(next)}</span>` : ""}${open ? `<span class="flag">${PAGE_COPY.disagree}</span>` : ""}`;
  return open ? `<a class="project" href="/settle/${esc(open.id)}">${inner}</a>` : `<div class="project">${inner}</div>`;
}

// What a person does, under their name (canvas Person board: "QA lead at Harbourline · Montréal"):
// their role, where they work, their city, each only where Details would show it. None known: the
// page's kind and sources, as before.
function personLine(s: State, n: Note, fresh: boolean, closed: boolean): string | undefined {
  if (closed || folderOf(n.fm.id) !== "people") return undefined;
  const one = (attr: string) => {
    const f = n.fm.facts?.[attr];
    const r = f && !isDisputed(f) && !isList(f) ? f as FactRecord : undefined;
    return r && !r.valid_to && (fresh || !shut(n, r)) ? plain(r.value, (x) => { const t = s.notes.find((m) => m.fm.id === x)?.fm.title; return t === undefined ? undefined : String(t); }) : "";
  };
  const [role, org, city] = [one("role"), one("org"), one("city")];
  const what = role && org ? fill(PAGE_COPY.roleAt, { role, org }) : role || org;
  return [what, city].filter(Boolean).join(" · ") || undefined;
}

const AREAS = new Set(["work", "teaching", "personal"]);
const initials = (name: string) => name.split(/\s+/).filter((w) => /^\p{L}/u.test(w)).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");

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
  }, 2).replace(/href="\/note\//g, 'href="/p/').replace(/(class="b-ref">)\[(\d+)\]/g, "$1$2").replace(/\s+(<sup>)/g, "$1");
  const c = connections(s, n);
  const mentioned = c.mentionedIn.length ? `<h2>${PAGE_COPY.mentioned}</h2><ul>${c.mentionedIn.map((x) => `<li class="line"><div class="t"><a href="${href(x.fm.id)}">${esc(displayName(x.fm.id, x.fm.title))}</a></div></li>`).join("")}</ul>` : "";
  const who = whoSees(s, csrf, n, closed);
  const details = closed ? "" : facts(s, n, fresh);
  const open = fresh && sensitivityRank(n.fm.sensitivity) >= sensitivityRank("private") ? `<p class="kind">${PAGE_COPY.openPrivate}</p>` : "";
  const body = open + (closed ? `<p class="quiet">${PAGE_COPY.shutPage}</p>${signInAgain(csrf)}` : details.includes(PAGE_COPY.shut) || withheld ? `${proseOrEmpty()}${signInAgain(csrf)}` : proseOrEmpty());
  function proseOrEmpty() { return prose.trim() ? `<div class="prose">${prose}</div>` : `<p class="quiet">${esc(fill(PAGE_COPY.empty, { name: first }))}</p>`; }
  const area = String(n.fm.area ?? "");
  const kind = String(n.fm.type ?? kindLabel(folderOf(n.fm.id)));
  const face = folderOf(n.fm.id) === "people" && initials(name) ? `<span class="face" aria-hidden="true">${esc(initials(name))}</span>` : "";
  const editHref = `/note/${n.fm.id.split("/").map(encodeURIComponent).join("/")}`;
  const band = `<header class="band${AREAS.has(area) ? ` t-${area}` : ""}"><div class="bar"><a href="/memory">‹ ${PAGE_COPY.back}</a>${closed ? "" : `<a href="${editHref}" aria-label="${PAGE_COPY.edit}">${PAGE_COPY.editShort}</a>`}</div>
<div class="head">${face}<div><h1>${esc(name)}</h1><p class="kind">${esc(personLine(s, n, fresh, closed) ?? `${kind} · ${count === 1 ? PAGE_COPY.oneSource : fill(PAGE_COPY.sources, { n: count })}`)}</p></div></div>${area ? `<div class="chips"><span class="chip">${esc(area.charAt(0).toUpperCase() + area.slice(1))}</span></div>` : ""}</header>`;
  const changedList = lines.length ? `<h2 class="sec">${PAGE_COPY.changed}</h2><ul>${lines.map((l) => line(l, csrf, n.fm.id)).join("")}</ul>` : "";
  const mentionedList = mentioned.replace(`<h2>${PAGE_COPY.mentioned}</h2>`, `<h2 class="sec">${PAGE_COPY.mentioned}</h2>`);
  const pinned = `<div class="pinned">${replyHtml(csrf, { ...o, page: n.fm.id })}<form class="box" method="post" action="/say">${hidden(csrf, { page: n.fm.id })}<label class="sr" for="q">${esc(fill(PAGE_COPY.box, { name: first }))}</label><input type="text" id="q" name="q" placeholder="${esc(fill(PAGE_COPY.box, { name: first }))}" autocomplete="off" enterkeyhint="send" maxlength="500"><button>${PAGE_COPY.send}</button></form></div>`;
  return appPage(name, "memory", `${band}
${body}${closed ? "" : projectCard(s, n, fresh)}${changedList}${mentionedList}
${details ? `<details><summary>${PAGE_COPY.details}</summary>${details}</details>` : ""}${who}
${pinned}`, { css: PAGE_CSS, wrap: "page" });
}

// Ask's answer about a page (audit v7: Ask answered with a list of facts): the page's own opening
// prose, its links kept, and what it cites as chips (the page, the pages it names, how many
// sources). Worked out when Ask is drawn, from the page as it is then, with the same rule as the
// page: a private page answers nothing before a fresh sign-in. No new read: it is the page the box
// already answered from.
export interface AskProse { html: string; cites: { href: string; label: string }[] }
export function askProse(s: State, n: Note, fresh: boolean): AskProse | undefined {
  if (!fresh && sensitivityRank(n.fm.sensitivity) >= sensitivityRank("private")) return undefined;
  const top = (n.body ?? "").split(/^#{1,6} /m)[0]!.split(/\n\s*\n/).map((x) => x.trim()).find((x) => x && !x.startsWith("[^"));
  if (!top) return undefined;
  const notes = new Set((top.match(/\[\^[^\]\s]+\]/g) ?? []));
  const text = top.replace(/\[\^[^\]\s]+\]/g, "").split(MADE).join(" ").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  const html = wikiLinks(s, text).replace(/href="\/note\//g, 'href="/p/').replace(/ class="mono"/g, "").replace(/ title="[^"]*"/g, "");
  const linked = [...new Set([...html.matchAll(/href="\/p\/([^"]+)"/g)].map((m) => decodeURIComponent(m[1]!)))].filter((id) => id !== n.fm.id).slice(0, 2);
  const title = (id: string) => displayName(id, s.notes.find((x) => x.fm.id === id)?.fm.title);
  const count = sourceCount(n) || notes.size;
  return { html, cites: [{ href: href(n.fm.id), label: displayName(n.fm.id, n.fm.title) }, ...linked.map((id) => ({ href: href(id), label: title(id) })), ...(count ? [{ href: href(n.fm.id), label: count === 1 ? PAGE_COPY.oneSource : fill(PAGE_COPY.sources, { n: count }) }] : [])] };
}
