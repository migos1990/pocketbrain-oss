// SPDX-License-Identifier: AGPL-3.0-only
// Did my assistant stop reading the brain? (next-level F4, G697, G698). Each of the owner's own
// assistants that is connected (a live token or an OAuth sign-in) and not paused is measured
// against its own habit: the gaps between its reading sessions over the last weeks give its usual
// gap, and it is quiet when the time since its last read is well past that. An assistant that reads
// hourly is quiet after a day; one that reads weekly only after about two weeks. Too little history
// (fewer than MIN_SESSIONS sessions) says nothing. The home shows one line, never counted as an
// ask, linking to Who knows; nothing when every connected assistant has read recently.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { readEntriesSince } from "./readlog";
import { ownAssistant, type Rules } from "./rules";
import { tokenInfo } from "./auth";
import { loadOAuth } from "./oauth";

const HOUR = 3_600_000, DAY = 24 * HOUR;
// History looked at: long enough for a weekly reader to have a few sessions.
export const HISTORY_DAYS = 42;
// Reads closer than this are one session (an assistant connects, searches, reads, in one chat).
const SESSION_GAP = 30 * 60_000;
export const MIN_SESSIONS = 4;
// Quiet once past this many times its usual gap, never sooner than a day, always by two weeks.
const FACTOR = 3;
const FLOOR = DAY, CEILING = 14 * DAY;

export interface Quiet { agent: string; last: string; days: number; usualHours: number }

// The usual gap: the larger of the median gap and the gap three sessions in four stay under, so
// one long weekend doesn't make a daily reader look weekly, and a few bursts don't make it hourly.
export function usualGap(times: number[]): number | undefined {
  const sessions: number[] = [];
  for (const t of [...times].sort((a, b) => a - b)) if (!sessions.length || t - sessions.at(-1)! >= SESSION_GAP) sessions.push(t);
  if (sessions.length < MIN_SESSIONS) return undefined;
  const gaps = sessions.slice(1).map((t, i) => t - sessions[i]!).sort((a, b) => a - b);
  const at = (q: number) => gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))]!;
  return Math.max(at(0.5), at(0.75));
}
export const quietAfter = (usual: number) => Math.min(CEILING, Math.max(FLOOR, FACTOR * usual));

function connected(root: string, name: string, tokens: ReturnType<typeof tokenInfo>, oauth: ReturnType<typeof loadOAuth>): boolean {
  if ((tokens[name]?.length ?? 0) > 0) return true;
  return Object.values(oauth?.clients ?? {}).some((v) => v.agent === name) || Object.values(oauth?.machines ?? {}).some((v) => v.agent === name)
    || Object.values(oauth?.coworkers ?? {}).some((v) => v.agent === name && Object.keys(v.clients ?? {}).length > 0);
}

// Kept per read-log, token and sign-in version and hour: the home renders often, the read log
// changes on every read, and a revoked assistant must drop off at once.
let kept: { key: string; out: Quiet[] } | undefined;
const version = (f: string) => { const st = existsSync(f) ? statSync(f) : undefined; return `${st?.size ?? 0}:${st?.mtimeMs ?? 0}`; };
export function quietAssistants(root: string, rules: Rules, now = new Date()): Quiet[] {
  const files = [join(root, "log", "reads.jsonl"), join(root, "rules", "tokens.yaml"), join(root, "rules", "oauth.yaml")];
  const key = `${root}\0${files.map(version).join("\0")}\0${now.toISOString().slice(0, 13)}\0${JSON.stringify(rules.policy.agents)}`;
  if (kept?.key === key) return kept.out;
  let tokens: ReturnType<typeof tokenInfo> = {}, oauth: ReturnType<typeof loadOAuth>;
  try { tokens = tokenInfo(root); } catch { /* no tokens file: only OAuth sign-ins count */ }
  try { oauth = loadOAuth(root); } catch { oauth = undefined; }
  const since = new Date(now.getTime() - HISTORY_DAYS * DAY).toISOString();
  const byAgent = new Map<string, number[]>();
  for (const e of readEntriesSince(root, since)) {
    const t = Date.parse(e.at);
    if (!e.agent || Number.isNaN(t) || t > now.getTime()) continue;
    const list = byAgent.get(e.agent);
    if (list) list.push(t); else byAgent.set(e.agent, [t]);
  }
  const out: Quiet[] = [];
  for (const [name, a] of Object.entries(rules.policy.agents)) {
    if (!ownAssistant(rules, name) || (a.status ?? "active") === "paused" || !connected(root, name, tokens, oauth)) continue;
    const times = byAgent.get(name);
    if (!times?.length) continue;
    const usual = usualGap(times);
    if (usual === undefined) continue;
    const last = times.reduce((m, t) => (t > m ? t : m), 0), since = now.getTime() - last;
    if (since > quietAfter(usual)) out.push({ agent: name, last: new Date(last).toISOString(), days: Math.floor(since / DAY), usualHours: Math.round(usual / HOUR) });
  }
  out.sort((a, b) => a.last.localeCompare(b.last));
  kept = { key, out };
  return out;
}

// The home's one line: the assistant quiet longest by name, then how many more. Undefined when
// none is quiet.
export function quietLine(quiet: Quiet[], name: (agent: string) => string): string | undefined {
  const q = quiet[0];
  if (!q) return undefined;
  const when = q.days >= 2 ? `${q.days} days` : q.days === 1 ? "a day" : "a while";
  const lead = `${name(q.agent)} has not read your brain in ${when}`;
  return quiet.length > 1 ? `${lead}, and ${quiet.length - 1} more assistant${quiet.length > 2 ? "s have" : " has"} gone quiet. Who knows has the details.` : `${lead}. Who knows has the details.`;
}

// Who knows' line under a quiet assistant's name: when it last read and how often it used to.
export function quietWords(q: Quiet): string {
  const usual = q.usualHours < 2 ? "every hour or so" : q.usualHours < 36 ? "about every day" : `about every ${Math.round(q.usualHours / 24)} days`;
  return `Last read ${q.days === 1 ? "a day" : `${q.days} days`} ago; it used to read ${usual}`;
}
