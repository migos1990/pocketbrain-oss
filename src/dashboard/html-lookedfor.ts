// SPDX-License-Identifier: AGPL-3.0-only
// "What it looked for": the dashboard's read-only version of `explain <agent>`. From the read
// log (log/reads.jsonl) it shows the agent's searches, grouped by words, with what they found,
// and the notes it asked for and didn't get, telling apart a note hidden from it (the agent
// got "no note", same as for a missing one) from one that doesn't exist. Owner only.
import { join } from "node:path";
import { readEntries, verifyReadLog, type ReadEntry } from "../readlog";
import type { CarveResult } from "../carve";
import { keptFor, type State } from "./data";
import { esc } from "./html";
import { noteName, term } from "./labels";
import { readsByDay } from "../whoread";
import { ownerLocal } from "../clock";

const when = (iso: string) => esc(ownerLocal(String(iso)).replace("T", " ").slice(0, 16));

// The read log is parsed once while it and the day stay the same (it changes the key when it grows).
export function lookedFor(s: State, agent: string, res: CarveResult, entries: ReadEntry[] = keptFor(s.root, "read-entries", s.dayKey, () => readEntries(s.root))): string {
  const mine = entries.filter((e) => e.agent === agent);
  const chain = keptFor(s.root, "read-chain", s.dayKey, () => verifyReadLog(s.root));
  const searches = new Map<string, { q: string; n: number; last: ReadEntry; op: string }>();
  for (const e of mine) {
    if (!e.q) continue;
    const k = e.q.trim().toLowerCase();
    const g = searches.get(k);
    if (g) { g.n++; g.last = e; } else searches.set(k, { q: e.q.trim(), n: 1, last: e, op: e.op });
  }
  const groups = [...searches.values()].sort((a, b) => b.last.at.localeCompare(a.last.at)).slice(0, 40);
  const missed = groups.filter((g) => !(g.last.ids ?? []).length);
  const hidden = new Set(res.excluded.map((x) => x.id));
  const asked = mine.filter((e) => e.asked).reverse().slice(0, 40);

  const integrity = chain.broken
    ? `<div class="flash err">The read log was changed at line ${chain.broken} (${esc(chain.why)}), so what follows can't be trusted past that point.</div>`
    : "";
  const searchRows = groups.map((g) => {
    const ids = g.last.ids ?? [];
    const found = ids.length
      ? `${ids.length} note${ids.length > 1 ? "s" : ""}: ${ids.slice(0, 4).map((id) => noteName(s.notes, id)).join(", ")}${ids.length > 4 ? ` <span class="sub">+${ids.length - 4}</span>` : ""}`
      : '<b>nothing</b>';
    return `<tr><td>"${esc(g.q)}"${g.n > 1 ? ` <span class="sub">${g.n} times</span>` : ""}</td><td class="sub">${term(g.op)}</td><td>${found}</td><td class="sub">${when(g.last.at)}</td></tr>`;
  }).join("");
  const askedRows = asked.map((e) => {
    const id = e.asked!.replace(/\.md$/, "");
    const why = hidden.has(id)
      ? '<span class="kind" title="carved out of its view">hidden from it</span> <span class="sub">it was told there is no such note</span>'
      : '<span class="kind">doesn\'t exist</span>';
    return `<tr><td>${noteName(s.notes, id)}</td><td>${why}</td><td class="sub">${when(e.at)}</td></tr>`;
  }).join("");

  const summary = mine.length
    ? `<p class="sub">${groups.length} different search${groups.length === 1 ? "" : "es"}${missed.length ? `, ${missed.length} that found nothing (a gap in what it can see, or in the brain)` : ""}; ${asked.length} note${asked.length === 1 ? "" : "s"} asked for and not given.</p>`
    : "";
  return `<h2 id="looked-for">What it looked for</h2>${integrity}${summary}
<h3>Searches</h3>${groups.length ? `<div class="card wrap"><table><thead><tr><th>Words</th><th>How</th><th>Found</th><th>Last time</th></tr></thead><tbody>${searchRows}</tbody></table></div>` : '<div class="card empty">No searches yet.</div>'}
<h3>Asked for and didn't get</h3>${asked.length ? `<div class="card wrap"><table><thead><tr><th>Note</th><th>Why</th><th>When</th></tr></thead><tbody>${askedRows}</tbody></table></div>` : '<div class="card empty">Nothing refused.</div>'}
${whatItRead(s, agent, entries)}`;
}

// Day by day, the last 7 days: the notes it was handed (src/whoread.ts), and an "unusual" line
// when most of a day sat outside the areas it read in the 28 days before.
export function whatItRead(s: Pick<State, "root" | "notes"> & Partial<Pick<State, "rules">>, agent: string, entries?: ReadEntry[]): string {
  const days = readsByDay(s.root, agent, { days: 7, entries, notes: s.notes, rules: s.rules });
  const rows = days.map((d) => {
    const flag = d.unusual ? `<div class="flash err">Unusual: ${d.unusual.outside.length} of ${d.unusual.of} notes outside its usual areas (${esc(d.unusual.areas.join(", "))}).</div>` : "";
    const notes = d.notes.slice(0, 12).map((n) => `${noteName(s.notes, n.id)}${n.n > 1 ? ` <span class="sub">x${n.n}</span>` : ""}`).join(", ");
    const more = d.notes.length > 12 ? ` <span class="sub">+${d.notes.length - 12}</span>` : "";
    const extra = [d.searches.length ? `${d.searches.length} search${d.searches.length === 1 ? "" : "es"}` : "", d.whole ? `${d.whole} whole-view pull${d.whole === 1 ? "" : "s"}` : "", d.asked ? `${d.asked} not given` : ""].filter(Boolean).join(", ");
    return `<tr><td class="sub">${esc(d.day)}</td><td>${flag}${d.notes.length ? notes + more : '<span class="sub">no note</span>'}</td><td class="sub">${esc(extra)}</td></tr>`;
  }).join("");
  return `<h3 id="what-it-read">What it read, day by day</h3>${days.length ? `<div class="card wrap"><table><thead><tr><th>Day</th><th>Notes it was handed</th><th>Also</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="card empty">Nothing read in the last 7 days.</div>'}
<p class="sub">Also from the command line: <code>pocketbrain reads ${esc(agent)}</code>.</p>`;
}
