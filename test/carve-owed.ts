// SPDX-License-Identifier: AGPL-3.0-only
// The other half of the carve property (G815): what each agent and token must be given. The leak
// oracle (evals/lib/oracle.ts) says what must never come out; a hub that served every assistant an
// empty view would pass it. This says which facts a reader is owed, from rules/ and the notes,
// without the carve code, and the checker (test/carve-check.ts) reads each one back through
// every door.
//
// Owed is the part of a grant with one reading only, so a miss is a fault and never a matter of
// taste:
//   - the agent holds the ready-made slice of the page's area (`area:<area>`) or `all`, neither
//     redefined in slices.yaml: every fact of such a page, with no attribute filter;
//   - the leak oracle carves out neither the page nor the fact for this reader (kind, name,
//     ceiling, share_with, the owner's Show, a page not filed yet that the grant doesn't read in
//     every area or list by id: such a page is owed to a reader holding `all`, or an area slice
//     for every area, and never through its area slice alone);
//   - no custom slice the agent also holds takes the fact away (`exclude`, `exclude_attributes`);
//   - the page is not folded into another (`status: merged`);
//   - the value is plain text or a number, links no page, and holds nothing the leak oracle
//     forbids this reader (the hub withholds such a value on purpose).
// A page reached only through a custom slice (kinds, tags, attribute lists) is not counted: its
// rules have their own tests. The check reports how many facts were owed, so a run that owed
// almost nothing is seen.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { loadBrain } from "../src/brain";
import { isUnfiled } from "../src/carve";
import { forbiddenFor, carvedFor, leakFinder, distinctive } from "../evals/lib/oracle";

export interface Owed { id: string; attr: string; value: string }

export async function owedFor(root: string, agent: string, opts: { role?: "reader" } = {}): Promise<Owed[]> {
  const policy = YAML.parse(readFileSync(join(root, "rules", "policy.yaml"), "utf8"));
  const sf = join(root, "rules", "slices.yaml");
  const slices: Record<string, { exclude?: string[]; exclude_attributes?: string[] }> = (existsSync(sf) ? YAML.parse(readFileSync(sf, "utf8"))?.slices : undefined) ?? {};
  const mine: string[] = policy.agents?.[agent]?.slices ?? [];
  const held = new Set<string>(mine.filter((s) => !(s in slices)));
  const areas = Object.keys(policy.areas ?? {});
  // A custom slice the agent also holds may take a fact away by name or by attribute: that wins
  // over any slice that gives it, so such a fact is not owed.
  const takenAway = (id: string, attr: string) => mine.some((s) => slices[s]?.exclude_attributes?.includes(attr) || slices[s]?.exclude?.includes(`${id}#${attr}`) || slices[s]?.exclude?.includes(id));
  const { carved } = await carvedFor(root, agent, opts);
  const out = new Set(carved.map((c) => c.id));
  const forbidden = leakFinder([...(await forbiddenFor(root, agent, opts)), ...carved.flatMap((c) => c.names.map((n) => ({ value: n, from: c.id })))]);
  const owed: Owed[] = [];
  for (const n of loadBrain(root)) {
    const id: string = n.fm.id;
    // A page folded into another answers like a missing one; its facts live on the page that took it.
    if (id.split("/")[0] === "agents" || out.has(id) || n.fm.status === "merged") continue;
    if (!held.has("all") && !held.has(`area:${n.fm.area}`)) continue;
    // A page not filed yet is read whole only by `all` or an area slice for every area (src/carve.ts
    // readsEveryArea, G849, G872); a level- or attribute-only slice reads it under its own filter,
    // which this oracle doesn't owe (G981).
    if (isUnfiled(n) && !held.has("all") && !areas.every((a) => held.has(`area:${a}`))) continue;
    for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
      if (out.has(`${id}#${attr}`) || takenAway(id, attr)) continue;
      const recs = (Array.isArray((f as any)?.items) ? (f as any).items : [f]) as Record<string, unknown>[];
      for (const r of recs) {
        if (r.valid_to || r.retired || r.ended_by) continue;
        const value = typeof r.value === "number" ? String(r.value) : typeof r.value === "string" ? r.value : undefined;
        if (!value || !distinctive(value) || value.includes("[[") || forbidden(value).length) continue;
        owed.push({ id, attr, value });
      }
    }
  }
  return owed;
}
