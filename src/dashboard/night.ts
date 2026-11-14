// SPDX-License-Identifier: AGPL-3.0-only
// While you slept, `/night` (owner's ask of 2026-11-14; plans/build-next-2026-11-14.md step 6): one
// morning page of what the memory did overnight. Nothing here is counted or worded anew: each line
// is a diary row (src/diary.ts) as the home already says it, with the home's own Undo and the
// home's own rule for what is private now (latestLines in home.ts, invariant 16); what it could
// not decide is the home's own waiting list (homeWaiting); when the night pass ran is its heartbeat
// (src/heartbeat.ts). A night is the owner's evening to morning, by the owner's clock, and only what
// the owner did not do themselves. A quiet night says so in one line. The home links here only until
// the page is opened once for that night (the day kept in `.git/pb-night-seen`, never committed).
import { readFileSync, writeFileSync } from "node:fs";
import type { Note } from "../brain";
import type { Rules } from "../rules";
import { readDiary, sayDay, type DiaryRow } from "../diary";
import { ownerClock } from "../clock";
import { readBeat } from "../heartbeat";
import { isOwnerId } from "../owner";
import { gitSide } from "../quotes";
import { latestLines, homeWaiting, waitingTotal, type HomeLine, type Waiting } from "./home";
import { esc, line } from "./html-home";
import { appPage } from "./html-app";

// The night by the owner's clock: from 19:00 the evening before to 07:00, the hour the hub's own
// morning starts (DEFAULT_SCHEDULE.digest_hour in src/start.ts). Before 07:00 it is the night so far.
export const NIGHT_FROM = 19, NIGHT_TO = 7;
// Lines a group shows before it counts the rest.
export const NIGHT_LINES = 6;

export const NIGHT_COPY = {
  title: "While you slept",
  back: "On your mind",
  ran: "The night pass ran at {time} and took {took}.",
  ranNoTime: "The night pass ran at {time}.",
  quiet: "A quiet night. Nothing in your memory changed while you slept.",
  learned: "Learned",
  tidied: "Tidied",
  waiting: "Could not decide",
  waitingHint: "Two sources disagree, and only you can say which is right.",
  settle: "Settle",
  elsewhereOne: "1 more thing waits on On your mind",
  elsewhere: "{n} more things wait on On your mind",
  elsewhereAllOne: "1 thing waits on On your mind",
  elsewhereAll: "{n} things wait on On your mind",
  more: "and {n} more",
  nLearned: "learned",
  nTidied: "tidied",
  nWaiting: "for you",
  homeOne: "While you slept, 1 thing changed in your memory.",
  homeMany: "While you slept, {n} things changed in your memory.",
};
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));

export type NightGroup = "learned" | "tidied";
// A diary row's kind as the page files it. A conflict line is the waiting list's; a row that only
// says the owner looked (`seen`), or that an older source still disagrees (`kept`), is not news.
const GROUP: Partial<Record<DiaryRow["kind"], NightGroup>> = {
  new: "learned", changed: "learned", item_added: "learned", confirmed: "learned", settled: "learned",
  // Tidied is also what the night let go of: a fact taken back, or one nobody used any more.
  folded: "tidied", moved: "tidied", set_aside: "tidied", retracted: "tidied",
};

const addDay = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// The night `now` belongs to: the owner's day it ends on, and whether a moment falls in it.
export function nightOf(rules: Rules, now: Date): { day: string; has: (at: string) => boolean } {
  const day = ownerClock(rules, now).day, eve = addDay(day, -1);
  return {
    day,
    has: (at) => {
      const t = new Date(at);
      if (Number.isNaN(t.getTime()) || t.getTime() > now.getTime()) return false;
      const p = ownerClock(rules, t);
      return (p.day === eve && p.hour >= NIGHT_FROM) || (p.day === day && p.hour < NIGHT_TO);
    },
  };
}

export interface NightView {
  day: string; // the owner's day the night ended on
  ran?: { time: string; took?: string }; // the night pass, when it finished in this night
  groups: { key: NightGroup; lines: HomeLine[]; more: number }[];
  counts: { learned: number; tidied: number; waiting: number };
  waiting: Waiting[];
  quiet: boolean; // nothing changed overnight; what waits is still listed
  latest?: string; // when the newest listed line was filed, for the home's link (seen up to here)
}

const clockWords = (rules: Rules, at: Date) => {
  const tz = rules.policy.owner?.timezone?.trim();
  const say = (z?: string) => new Intl.DateTimeFormat("en-GB", { timeZone: z, hour: "numeric", minute: "2-digit", hourCycle: "h23" }).format(at);
  try { return say(tz || "America/Toronto"); } catch { return say("America/Toronto"); }
};
const tookWords = (ms: number) => { const m = Math.round(ms / 60_000); return m < 1 ? "under a minute" : m === 1 ? "1 minute" : `${m} minutes`; };

export function nightView(root: string, rules: Rules, notes: Note[], now: Date): NightView {
  const night = nightOf(rules, now);
  // Rows of this night that the owner did not make. `since` only spares reading older months.
  const since = new Date(now.getTime() - 48 * 3_600_000).toISOString();
  const recent = readDiary(root, { since });
  const rows = recent.filter((r) => night.has(r.at) && r.source_word !== "you" && !isOwnerId(r.by));
  const at = new Map(rows.map((r) => [r.undo_token, r]));
  // The home's own lines, newest first, cut to this night's rows. Asking for as many lines as
  // there are rows since the night began is enough: nothing older can come before them.
  const newer = recent.filter((r) => r.at >= (rows.at(0)?.at ?? "9")).length;
  const lines = rows.length ? latestLines(root, rules, notes, newer).filter((l) => at.has(l.token) && l.undo !== "undone") : [];
  const of = (g: NightGroup) => lines.filter((l) => GROUP[at.get(l.token)!.kind] === g);
  const groups = (["learned", "tidied"] as const).map((key) => { const all = of(key); return { key, lines: all.slice(0, NIGHT_LINES), more: Math.max(0, all.length - NIGHT_LINES) }; }).filter((g) => g.lines.length);
  const waiting = homeWaiting(root, now);
  const beat = readBeat(root, "night");
  const ran = beat?.ok && night.has(beat.at) ? { time: clockWords(rules, new Date(beat.at)), ...(beat.ms !== undefined ? { took: tookWords(beat.ms) } : {}) } : undefined;
  const counts = { learned: of("learned").length, tidied: of("tidied").length, waiting: waitingTotal(waiting) };
  const latest = lines.map((l) => at.get(l.token)!.at).sort().at(-1);
  return { day: night.day, ...(ran ? { ran } : {}), groups, counts, waiting, quiet: !groups.length, ...(latest ? { latest } : {}) };
}

// How many things the night page has to say, for the home's one link to it. 0 means no link.
export const nightCount = (v: NightView) => v.groups.reduce((a, g) => a + g.lines.length + g.more, 0);


// The home's one link to the page: its words while the night has something to say and the owner
// has not opened the page for that night; undefined otherwise.
const seenFile = (root: string) => gitSide(root, "pb-night-seen");
// Seen is "this night, up to this line": before 07:00 the page is the night so far, so what the
// night files after the owner looked brings the link back (G823).
const seenUpTo = (root: string, day: string): string | undefined => { try { const [d, t] = readFileSync(seenFile(root), "utf8").trim().split(" "); return d === day ? t ?? "" : undefined; } catch { return undefined; } };
export const markNightSeen = (root: string, v: NightView): void => { try { writeFileSync(seenFile(root), `${v.day} ${v.latest ?? ""}\n`, { mode: 0o600 }); } catch { /* a link that stays is the only cost */ } };
export function nightLink(root: string, rules: Rules, notes: Note[], now: Date): string | undefined {
  const v = nightView(root, rules, notes, now), n = nightCount(v), seen = seenUpTo(root, v.day);
  if (!n || !v.latest || (seen !== undefined && v.latest <= seen)) return undefined;
  return fill(n === 1 ? NIGHT_COPY.homeOne : NIGHT_COPY.homeMany, { n });
}

const NIGHT_CSS = `
.night-top h1{font-size:54px;line-height:.92;max-width:none}
.night-ran{margin:14px 0 0;font-size:15px;line-height:21px;color:var(--muted)}
.night-n{display:flex;gap:22px;margin:20px 0 0;padding:14px 0 0;border-top:2px solid var(--text)}
.night-n div{display:flex;flex-direction:column;gap:2px}
.night-n b{font-size:40px;line-height:1;font-weight:900;letter-spacing:-.03em}
.night-n div:first-child b{color:var(--headline-ink)}
.night-n span{font-size:14px;line-height:18px;color:var(--muted)}
.night-quiet{margin:22px 0 0;padding:22px 16px;border:2px solid var(--text);font-size:21px;line-height:27px;font-weight:800}
.night h2{margin:28px 0 4px}
.night-hint{margin:0 0 4px;font-size:14px;line-height:20px;color:var(--muted)}
.night-more{margin:8px 0 0;font-size:14px;line-height:20px;color:var(--muted)}
.night-wait{list-style:none;margin:0;padding:0}
.night-wait li{border-top:2px solid var(--text)}
.night-wait li:last-child{border-bottom:2px solid var(--text)}
.night-wait a{min-height:44px;padding:12px 0;display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--text);text-decoration:none}
.night-wait .w{font-size:17px;line-height:23px;font-weight:700;overflow-wrap:anywhere}
.night-wait .go{flex:none;font-weight:800;text-decoration:underline;text-decoration-color:var(--headline-ink);text-decoration-thickness:3px;text-underline-offset:5px}
.night-more a{color:var(--muted);text-decoration:underline;text-underline-offset:3px;display:inline-flex;align-items:center;min-height:44px}
`;

export function nightPage(v: NightView, csrf: string): string {
  const head = `<header class="top night-top"><p class="day"><a class="top-link" href="/home">‹ ${NIGHT_COPY.back}</a><span>${esc(sayDay(v.day))}</span></p><h1>${NIGHT_COPY.title}</h1></header>`;
  const ran = v.ran ? `<p class="night-ran">${esc(fill(v.ran.took ? NIGHT_COPY.ran : NIGHT_COPY.ranNoTime, v.ran))}</p>` : "";
  // What it could not decide is a conflict, which has its own screen; anything else that waits is
  // the home's to say, so it is one counted link there.
  const settle = v.waiting.filter((w) => w.href.startsWith("/settle/")), rest = v.counts.waiting - waitingTotal(settle);
  const more = rest > 0 ? `<p class="night-more"><a href="/home">${esc(fill(settle.length ? (rest === 1 ? NIGHT_COPY.elsewhereOne : NIGHT_COPY.elsewhere) : rest === 1 ? NIGHT_COPY.elsewhereAllOne : NIGHT_COPY.elsewhereAll, { n: rest }))}</a></p>` : "";
  const waiting = settle.length ? `<h2>${NIGHT_COPY.waiting}</h2><p class="night-hint">${NIGHT_COPY.waitingHint}</p><ul class="night-wait">${settle.map((w) => `<li><a href="${esc(w.href)}"><span class="w">${esc(w.what)}</span><span class="go">${NIGHT_COPY.settle}</span></a></li>`).join("")}</ul>${more}` : more;
  if (v.quiet) return appPage(NIGHT_COPY.title, "mind", `<div class="night">${head}${ran}<p class="night-quiet">${NIGHT_COPY.quiet}</p>${waiting}</div>`, { css: NIGHT_CSS });
  const n = (k: number, word: string) => `<div><b>${k}</b><span>${word}</span></div>`;
  const tiles = `<div class="night-n">${n(v.counts.learned, NIGHT_COPY.nLearned)}${n(v.counts.tidied, NIGHT_COPY.nTidied)}${n(v.counts.waiting, NIGHT_COPY.nWaiting)}</div>`;
  const groups = v.groups.map((g) => `<h2>${NIGHT_COPY[g.key]}</h2><ul class="lines">${g.lines.map((l) => line(l, csrf)).join("")}</ul>${g.more ? `<p class="night-more">${esc(fill(NIGHT_COPY.more, { n: g.more }))}</p>` : ""}`).join("");
  return appPage(NIGHT_COPY.title, "mind", `<div class="night">${head}${ran}${tiles}${groups}${waiting}</div>`, { css: NIGHT_CSS });
}
