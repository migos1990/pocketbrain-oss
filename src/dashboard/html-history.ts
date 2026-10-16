// SPDX-License-Identifier: AGPL-3.0-only
// History pages: a note's facts over time with who saved each value, every save with what it
// changed, the note as it was after any save, and what changed in the whole brain this week.
// Plain labels only: no commit hashes on screen, a moment is named by its date.
import { isDisputed, isList, type Note, type FactRecord, type SourceRef, sensitivityRank } from "../brain";
import type { State } from "./data";
import { esc, button, type Page } from "./html";
import { cap, plain, agentLabel } from "./labels";
import { OWNER } from "../owner";
import { kindLabel, folderOf, sourceWords } from "./browse";
import { actorOf, changesBetween, spans, firstSaveOf, undoFor, factValue, type Save, type FactChange, type Version, type Undo } from "./history";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// "2026-09-28..." -> "28 Sep 2026"; partial dates stay partial.
export const dayName = (d: string | undefined) => {
  const m = String(d ?? "").match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/);
  return !m ? esc(d) : m[3] ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : m[2] ? `${MONTHS[+m[2] - 1]} ${m[1]}` : m[1];
};
const clock = (iso: string) => String(iso).slice(11, 16);
const enc = (id: string) => id.split("/").map(encodeURIComponent).join("/");
const noteHref = (id: string) => `/note/${enc(id)}`;
export const historyHref = (id: string, at?: string) => `/history/${enc(id)}${at ? `?at=${encodeURIComponent(at)}` : ""}`;

// Who made a save, in words. The Gardener raising privacy after the classifier read a fact is
// the privacy check; upkeep commits as "reflect".
export function saver(s: State, c: Pick<Save, "actor" | "message">): string {
  if (c.actor === OWNER) return "You";
  if (c.actor === "reflect") return "Nightly upkeep";
  if (c.actor === "hub") return "The hub";
  if (c.actor === "gardener" && /^gardener: made \w+: /.test(c.message)) return "The privacy check";
  return agentLabel(s.rules, c.actor);
}

// The owner's own word shows as "added by you", not as a source.
const outside = (xs: SourceRef[] | undefined) => (xs ?? []).filter((x) => !/^(owner|louis):/.test(typeof x === "string" ? x : x.ref));

const attrName = (a?: string) => `<span title="${esc(a)}">${esc(cap(a))}</span>`;

// One change as a short line of HTML.
export function changeLine(c: FactChange): string {
  const from = outside(c.sources).length ? ` <span class="sub">from ${esc(sourceWords(outside(c.sources)))}</span>` : "";
  switch (c.type) {
    case "created": return "Created the note";
    case "deleted": return "Deleted the note";
    case "added": return `${attrName(c.attr)}: <b>${esc(c.to)}</b>${from}`;
    case "changed": return `${attrName(c.attr)}: <s>${esc(c.from)}</s> to <b>${esc(c.to)}</b>${from}`;
    case "removed": return `${attrName(c.attr)}: removed <s>${esc(c.from)}</s>`;
    case "forgot": return `${attrName(c.attr)}: forgotten, unused past its shelf life <s>${esc(c.from)}</s>`;
    case "private": return `${attrName(c.attr)}: made ${esc(plain(c.level ?? "private"))}`;
    case "shared": return `${attrName(c.attr)}: kept to ${esc(c.to || "fewer assistants")} only`;
    case "confirmed": return `${attrName(c.attr)}: confirmed still true`;
    case "text": return "Edited the notes text";
    case "note-private": return `Made the whole note ${esc(plain(c.level ?? "private"))}`;
    case "corrected": return `${attrName(c.attr)}: corrected, <s>${esc(c.from)}</s> was never right`;
    case "note-open": return `Opened the whole note to ${esc(plain(c.level ?? "personal"))}`;
  }
}

// The same in a sentence for a one-line row: "changed Role, added Phone".
function changeSummary(cs: FactChange[]): string {
  const word: Record<string, string> = { added: "added", changed: "changed", removed: "removed", forgot: "forgot", corrected: "corrected", private: "made private", shared: "narrowed who sees", confirmed: "confirmed" };
  const parts = cs.slice(0, 3).map((c) => c.type === "private" ? `made ${esc(plain(c.attr))} private` : c.attr ? `${word[c.type]} ${esc(plain(c.attr))}` : c.type === "created" ? "created the note" : c.type === "deleted" ? "deleted the note" : c.type === "text" ? "edited the notes text" : c.type === "note-open" ? "opened the note up" : "made the note private");
  return parts.join(", ") + (cs.length > 3 ? ` and ${cs.length - 3} more` : "");
}

function undoButton(csrf: string, u: Undo | undefined): string {
  if (!u) return "";
  if (u.action === "owner-undo") return button(csrf, "owner-undo", { hash: u.hash }, "Undo");
  if (u.action === "commit-revert") return button(csrf, "commit-revert", { hash: u.hash }, "Undo", "", "Undo this save? It becomes a new save by you.");
  return button(csrf, "upkeep-undo", { run: u.run }, "Undo that night", "", "Undo every fix this night of upkeep made, in all notes?");
}

// "Go to a date": a plain GET form, so the URL can be shared and the back button works.
const datePicker = (action: string, value = "", label = "See it on") => `<form method="get" action="${action}" class="h-pick"><label class="sub" for="h-at">${esc(label)}</label><input type="date" id="h-at" name="at" value="${esc(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "")}" required><button>Go</button></form>`;

const crumbs = (s: State, n: Note, last?: string) => `<div class="b-crumbs"><a href="/brain">Brain</a> / <a href="/brain?kind=${encodeURIComponent(folderOf(n.fm.id))}">${esc(kindLabel(folderOf(n.fm.id)))}</a> / <a href="${noteHref(n.fm.id)}" title="${esc(n.fm.id)}">${esc(n.fm.title)}</a>${last ? ` / ${last}` : ""}</div>`;

// One fact's values over time, newest first, each with who saved it and a way to open that day.
function factTimeline(s: State, n: Note, attr: string, saves: Save[]): string {
  const list = spans(n).get(attr) ?? [];
  const rows = list.map((sp) => {
    const save = firstSaveOf(saves, attr, sp.value);
    const when = sp.from ? (sp.until ? `${dayName(sp.from)} to ${dayName(sp.until)}` : `since ${dayName(sp.from)}`) : sp.until ? `until ${dayName(sp.until)}` : "";
    const bits = [when, outside(sp.sources).length ? `from ${esc(sourceWords(outside(sp.sources)))}` : "", `added by ${esc(sp.by ? (sp.by === OWNER || sp.by === "louis" || sp.by.toLowerCase() === String(s.rules.policy.owner?.name ?? "").toLowerCase() ? "you" : agentLabel(s.rules, sp.by)) : "someone")}`].filter(Boolean);
    if (sp.retired) bits.push(`forgotten ${dayName(sp.retired.at)}`);
    if (sp.correction) bits.push("never right, corrected by you");
    const saved = save ? ` · <a href="${historyHref(n.fm.id, `v${save.v}`)}">As it was</a>` : "";
    return `<li class="${sp.current ? "now" : ""}"><div class="h-val">${esc(sp.value)}${sp.current ? ' <span class="kind">now</span>' : ""}${sp.sensitivity && sensitivityRank(sp.sensitivity as never) > sensitivityRank(n.fm.sensitivity) ? ` <span class="kind">${esc(plain(sp.sensitivity))}</span>` : ""}</div><div class="b-meta">${bits.join(" · ")}${saved}</div></li>`;
  });
  return `<div class="b-fact h-fact" id="h-${esc(attr)}"><div class="b-k" title="${esc(attr)}">${esc(cap(attr))}</div><ol class="h-tl">${rows.join("")}</ol></div>`;
}

export function noteHistoryPage(s: State, csrf: string, note: Note, saves: Save[], reverted: Set<string>): Page {
  const attrs = [...spans(note).keys()];
  const facts = attrs.map((a) => factTimeline(s, note, a, saves)).join("");
  const rows = [...saves].reverse().map((c) => {
    const u = undoFor(s.rules, c, reverted);
    const undone = reverted.has(c.hash) ? '<span class="kind">undone</span>' : "";
    return `<div class="b-row h-save"><span class="b-when h-date">${dayName(c.at)}<br>${esc(clock(c.at))}</span><span class="b-main"><span class="b-title">${esc(saver(s, c))}${undone ? ` ${undone}` : ""}</span>${c.changes.map((x) => `<span class="h-change">${changeLine(x)}</span>`).join("")}</span><span class="acts"><a class="btn" href="${historyHref(note.fm.id, `v${c.v}`)}">As it was</a>${undoButton(csrf, u)}</span></div>`;
  }).join("");
  const first = saves[0]?.at;
  const body = `${crumbs(s, note)}<h1>History</h1>
<div class="h-head"><div class="sub">${saves.length} save${saves.length === 1 ? "" : "s"}${first ? ` since ${dayName(first)}` : ""}</div>${datePicker(historyHref(note.fm.id), "", "See the note on")}</div>
<h2>Facts over time</h2><div class="b-facts h-facts">${facts || '<div class="empty">No facts yet.</div>'}</div>
<h2>Every save</h2><div class="card b-list">${rows || '<div class="empty">This note has no saved history yet.</div>'}</div>`;
  return { title: `${note.fm.title}: history`, tab: "brain", body };
}

// The note as a version held it, with what has changed since.
export function snapshotPage(s: State, csrf: string, note: Note, v: Version, saves: Save[], asked?: string): Page {
  const then = v.note;
  const save = saves.find((x) => x.hash === v.hash);
  const who = saver(s, { actor: save?.actor ?? actorOf(v), message: v.message });
  const since = then ? changesBetween(then, note) : [];
  const facts = then ? Object.entries(then.fm.facts ?? {}).map(([attr, f]) => {
    const r = isDisputed(f) ? undefined : isList(f) ? undefined : (f as FactRecord);
    const meta = r ? [r.as_of ? `dated ${dayName(r.as_of)}` : "", outside(r.sources).length ? `from ${esc(sourceWords(outside(r.sources)))}` : ""].filter(Boolean).join(" · ") : "";
    // Bringing an old value back is an ordinary edit by you: a new save, the current value kept in history.
    const now = note.fm.facts?.[attr];
    const restore = r && !isList(now) && !isDisputed(now) && factValue(now) !== factValue(f)
      ? button(csrf, "fact-set", { id: note.fm.id, attribute: attr, value: typeof r.value === "object" ? JSON.stringify(r.value) : String(r.value) }, "Restore", "", `Make "${factValue(f)}" the value again? It is saved as a new change by you; today's value stays in the history.`) : "";
    const changed = factValue(now) !== factValue(f) ? ` <span class="kind">${now === undefined ? "gone now" : "changed since"}</span>` : "";
    return `<div class="b-fact"><div class="b-k" title="${esc(attr)}">${esc(cap(attr))}</div><div class="b-v"><div class="b-show">${esc(factValue(f))}${changed}</div>${meta ? `<div class="b-meta">${meta}</div>` : ""}</div>${restore ? `<div class="b-side">${restore}</div>` : "<div></div>"}</div>`;
  }).join("") : "";
  const body = `${crumbs(s, note, `<a href="${historyHref(note.fm.id)}">History</a>`)}<h1 title="${esc(note.fm.id)}">${esc(then?.fm.title ?? note.fm.title)}</h1>
<div class="b-seen h-asof"><span>${asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? `On <b>${dayName(asked)}</b>, as last saved ${dayName(v.at)} at ${esc(clock(v.at))} by ${esc(who === "You" ? "you" : who)}.` : `As it was on <b>${dayName(v.at)}</b> at ${esc(clock(v.at))}, after a save by ${esc(who === "You" ? "you" : who)}.`}</span><span class="b-gap"></span>${datePicker(historyHref(note.fm.id), asked, "Another day")}<a href="${noteHref(note.fm.id)}">Back to today</a></div>
${then ? `<div class="b-facts">${facts || '<div class="empty">No facts then.</div>'}</div>
${then.body.trim() ? `<h2>Notes</h2><div class="b-text h-text">${esc(then.body.trim()).replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (m, id, l) => { const x = s.notes.find((y) => y.fm.id === id); return x ? `<a href="${noteHref(id)}" title="${esc(id)}">${esc(l ?? x.fm.title)}</a>` : m; })}</div>` : ""}
<h2>Since then</h2><div class="card b-list">${since.length ? since.map((c) => `<div class="b-row"><span class="b-main"><span class="h-change">${changeLine(c)}</span></span></div>`).join("") : '<div class="empty">Nothing has changed since.</div>'}</div>` : '<div class="empty">The note did not exist at that moment.</div>'}`;
  return { title: `${note.fm.title}: ${dayName(asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : v.at)}`, tab: "brain", body };
}

// What changed in the whole brain over the last days, grouped by day, newest first.
export function weekPage(s: State, saves: Save[], days: number): Page {
  const titles = new Map(s.notes.map((n) => [n.fm.id, String(n.fm.title ?? n.fm.id)]));
  const byDay = new Map<string, Save[]>();
  for (const c of saves) { const d = c.at.slice(0, 10); byDay.set(d, [...(byDay.get(d) ?? []), c]); }
  const todayIso = s.now.toISOString().slice(0, 10);
  const yesterday = new Date(s.now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const label = (d: string) => d === todayIso ? "Today" : d === yesterday ? "Yesterday" : `${DAYS[new Date(`${d}T12:00:00Z`).getUTCDay()]} ${dayName(d)}`;
  const groups = [...byDay.entries()].map(([d, cs]) => `<h2 class="h-day">${label(d)}</h2><div class="card b-list">${cs.map((c) => {
    const title = titles.get(c.id);
    const lead = c.changes.find((x) => x.type === "changed" || x.type === "added");
    return `<a class="b-row" href="${title ? historyHref(c.id) : "#"}" title="${esc(c.id)}"><span class="b-main"><span><span class="b-title">${esc(title ?? c.id)}</span> <span class="kind">${esc(kindLabel(folderOf(c.id)))}</span></span><span class="b-snip">${esc(saver(s, c))} ${changeSummary(c.changes)}</span>${lead && lead.to !== undefined ? `<span class="b-meta">${esc(cap(lead.attr))}: ${lead.from !== undefined ? `<s>${esc(lead.from)}</s> to ` : ""}${esc(lead.to)}</span>` : ""}</span><span class="b-when">${esc(clock(c.at))}</span></a>`;
  }).join("")}</div>`).join("");
  const body = `<div class="b-crumbs"><a href="/brain">Brain</a></div><h1>What changed this week</h1>
<div class="h-head"><div class="sub">${saves.length} save${saves.length === 1 ? "" : "s"} in the last ${days} days</div>${datePicker("/history", "", "See the brain on")}</div>
${groups || '<div class="empty">Nothing changed in the last 7 days.</div>'}`;
  return { title: "What changed this week", tab: "brain", body };
}

// The whole brain on a date: every note as it was, with what has changed in it since.
export function brainOnPage(s: State, day: string, then: Note[], savedAt: string): Page {
  const now = new Map(s.notes.map((n) => [n.fm.id, n]));
  const was = new Set(then.map((n) => n.fm.id));
  const rows = then.filter((n) => folderOf(n.fm.id) !== "disputes").sort((a, b) => String(a.fm.title).localeCompare(String(b.fm.title))).map((n) => {
    const cur = now.get(n.fm.id);
    const since = cur ? changesBetween(n, cur) : [{ type: "deleted" as const }];
    const facts = Object.entries(n.fm.facts ?? {}).filter(([, f]) => !isDisputed(f)).slice(0, 3).map(([a, f]) => `${cap(a)}: ${factValue(f)}`).join(" · ");
    return `<a class="b-row" href="${cur ? historyHref(n.fm.id, day) : "#"}" title="${esc(n.fm.id)}"><span class="b-main"><span><span class="b-title">${esc(n.fm.title)}</span> <span class="kind">${esc(kindLabel(folderOf(n.fm.id)))}</span>${since.length ? '<span class="kind">changed since</span>' : ""}</span>${facts ? `<span class="b-snip">${esc(facts)}</span>` : ""}${since.length ? `<span class="b-meta">Since then: ${changeSummary(since)}</span>` : ""}</span></a>`;
  }).join("");
  const added = s.notes.filter((n) => !was.has(n.fm.id) && folderOf(n.fm.id) !== "disputes");
  const body = `<div class="b-crumbs"><a href="/brain">Brain</a> / <a href="/history">History</a></div><h1>Your brain on ${dayName(day)}</h1>
<div class="h-head"><div class="sub">${then.length} notes, as last saved ${dayName(savedAt)} at ${esc(clock(savedAt))}${added.length ? ` · ${added.length} note${added.length > 1 ? "s" : ""} added since` : ""}</div>${datePicker("/history", day, "Another day")}</div>
<div class="card b-list" style="margin-top:20px">${rows || '<div class="empty">The brain had no notes yet.</div>'}</div>`;
  return { title: `Brain on ${dayName(day)}`, tab: "brain", body };
}
