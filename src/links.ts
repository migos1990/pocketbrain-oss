// SPDX-License-Identifier: AGPL-3.0-only
// Links both ways, as one agent sees them (docs/wiki.md "What assistants see"). The dashboard's
// "Mentioned in" (src/dashboard/browse.ts connections) for agents: computed per carve, never
// stored. A link counts only where the agent itself can see it: in a body it has the grant for, or
// in a fact it is shown, after the same scrub it gets (scrubPage, agentFact), and only to a note in its
// view. So a hidden note is never named, and no link the agent couldn't read is revealed.
import { linksIn } from "./brain";
import { visibleFacts, type CarveResult } from "./carve";
import { scrubPage, agentFact } from "./view";

export interface Linked { id: string; title: string }
export interface Neighbours { linksTo: Linked[]; mentionedIn: Linked[] }

const built = new WeakMap<CarveResult, Map<string, Neighbours>>();
// At most this many of each are named; the rest are counted.
export const NEIGHBOURS_SHOWN = 20;

export function neighbours(res: CarveResult, id: string): Neighbours {
  let all = built.get(res);
  if (!all) { all = graphOf(res); built.set(res, all); }
  return all.get(id) ?? { linksTo: [], mentionedIn: [] };
}

function graphOf(res: CarveResult): Map<string, Neighbours> {
  const title = (id: string) => String(res.visible.get(id)!.note.fm.title ?? id);
  const out = new Map<string, Set<string>>(), back = new Map<string, Set<string>>();
  for (const [id, v] of res.visible) {
    const seen = [
      // The body as the agent reads it (scrubPage): a hidden fact's sentence, and the link in it, gone
      // (audit v10, G612; redactLinks alone kept that link).
      ...(v.body ? linksIn(scrubPage(v.note.body, v, res)) : []),
      // Facts as the agent reads them (agentFact): no writer fields, scrubbed like read's.
      ...linksIn(JSON.stringify(visibleFacts(v, res).map(([, f]) => agentFact(f, res.grant.agent, res, v)))),
    ];
    for (const to of seen) {
      if (to === id || !res.visible.has(to)) continue;
      (out.get(id) ?? out.set(id, new Set()).get(id)!).add(to);
      (back.get(to) ?? back.set(to, new Set()).get(to)!).add(id);
    }
  }
  const list = (s?: Set<string>) => [...(s ?? [])].map((x) => ({ id: x, title: title(x) })).sort((a, b) => a.title.localeCompare(b.title));
  const m = new Map<string, Neighbours>();
  for (const id of res.visible.keys()) if (out.has(id) || back.has(id)) m.set(id, { linksTo: list(out.get(id)), mentionedIn: list(back.get(id)) });
  return m;
}

const named = (xs: Linked[]) => xs.slice(0, NEIGHBOURS_SHOWN).map((x) => `${x.title} \`${x.id}\``).join(", ") + (xs.length > NEIGHBOURS_SHOWN ? `, and ${xs.length - NEIGHBOURS_SHOWN} more` : "");

// read's Markdown: who links here, and where this links.
export function neighbourLines(n: Neighbours): string[] {
  return [...(n.mentionedIn.length ? [`Mentioned in: ${named(n.mentionedIn)}`] : []), ...(n.linksTo.length ? [`Links to: ${named(n.linksTo)}`] : [])];
}

// context_pack's one line per hit: both directions together, linked-to first.
// At most five in a pack (G768): the rest are one read away, and the note's own links say them.
const CONNECTED_SHOWN = 5;
export function connectedLine(n: Neighbours): string | undefined {
  const seen = new Set<string>();
  const both = [...n.linksTo, ...n.mentionedIn].filter((x) => !seen.has(x.id) && seen.add(x.id));
  return both.length ? `Connected: ${named(both.slice(0, CONNECTED_SHOWN))}${both.length > CONNECTED_SHOWN ? `, and ${both.length - CONNECTED_SHOWN} more (read this note for all)` : ""}` : undefined;
}
