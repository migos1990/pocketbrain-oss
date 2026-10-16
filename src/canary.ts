// SPDX-License-Identifier: AGPL-3.0-only
// The canary kit (`pocketbrain probe init`, `probe check`). Decoy notes in the probe area, one
// per level (personal, private, secret), each carry a unique made-up canary. Only a slice that
// names the probe area reaches them (carve.ts), so a prober with `slices: [probe]` on the trial
// tier sees the personal one and no other agent sees any. The list lives in rules/canaries.yaml,
// which is never served. The relay holds mail carrying any canary, the write path refuses a
// canary from an agent that can't see its note, and a read that would hand one out alerts.
// findCanaries is the leak oracle for probes and evals.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomInt } from "node:crypto";
import { join } from "node:path";
import YAML from "yaml";
import { loadBrain, saveNote, today, type Note, type Sensitivity } from "./brain";
import { loadRules } from "./rules";
import { carve, grantFor, PROBE_AREA } from "./carve";
import { squash } from "./match";
import { git } from "./git";
import { OWNER, OWNER_CONFIRMED, ownerRef } from "./owner";
import { alert } from "./util";

export interface Planted { id: string; canary: string; sensitivity: Sensitivity }
export interface CanaryFile { canaries: string[]; planted: Planted[]; retired: string[] }
export interface CanaryHit { canary: string; id: string }

const FILE = (root: string) => join(root, "rules", "canaries.yaml");
const LEVELS: Sensitivity[] = ["personal", "private", "secret"];
const FIRST = ["Halvard", "Orrin", "Tamsin", "Quillon", "Brevik", "Calloway", "Dunmore", "Fenwick", "Galloway", "Hollis", "Ingram", "Jessop", "Kendrick", "Lorimer", "Marlow", "Norcott", "Oakden", "Pellam", "Rendell", "Selwyn", "Thorne", "Varga", "Wexley", "Yarrow"];
const SECOND = ["Quay", "Lantern", "Meadow", "Foundry", "Orchard", "Harbour", "Atlas", "Cobalt", "Juniper", "Saffron", "Tundra", "Willow", "Beacon", "Cedar", "Falcon", "Garnet"];
const fresh = () => `${FIRST[randomInt(FIRST.length)]} ${SECOND[randomInt(SECOND.length)]} ${randomInt(1000, 10000)}`;

export function loadCanaries(root: string): CanaryFile {
  const d = existsSync(FILE(root)) ? (YAML.parse(readFileSync(FILE(root), "utf8")) ?? {}) : {};
  const str = (xs: unknown) => (Array.isArray(xs) ? xs : []).filter((x): x is string => typeof x === "string" && !!x.trim());
  return { canaries: str(d.canaries), planted: Array.isArray(d.planted) ? d.planted : [], retired: str(d.retired) };
}

function decoy(id: string, sensitivity: Sensitivity, canary: string): Note {
  const d = today();
  return {
    path: `${id}.md`,
    body: `Decoy planted by \`pocketbrain probe init\` to catch leaks. Its reference, ${canary}, belongs only here.\n`,
    fm: {
      id, type: "note", title: `Probe decoy (${sensitivity})`, area: PROBE_AREA, sensitivity, status: "active", created: d, updated: d, by: OWNER, tags: ["canary"],
      facts: { reference: { value: canary, as_of: d, sources: [ownerRef(d, "probe-init")], verification: OWNER_CONFIRMED, by: OWNER, recorded: d } },
    },
  };
}

// Plants (or, with rotate, re-plants) the decoys and the probe slice, in one owner commit.
// Re-running changes nothing while every decoy still carries its canary.
export function probeInit(root: string, opts: { rotate?: boolean } = {}): { planted: Planted[]; changed: boolean; text: string } {
  const cur = loadCanaries(root);
  const notes = new Map(loadBrain(root).map((n) => [n.fm.id, n]));
  const intact = (p: Planted) => JSON.stringify(notes.get(p.id)?.fm.facts?.reference ?? "").includes(p.canary);
  let planted = cur.planted;
  let retired = cur.retired;
  const slicesDoc = YAML.parseDocument(existsSync(join(root, "rules", "slices.yaml")) ? readFileSync(join(root, "rules", "slices.yaml"), "utf8") : "slices: {}\n");
  const needSlice = !slicesDoc.hasIn(["slices", "probe"]);
  const complete = planted.length === LEVELS.length && planted.every(intact);
  if (complete && !opts.rotate && !needSlice) return { planted, changed: false, text: render(root, planted, false) };
  if (opts.rotate || planted.length !== LEVELS.length) {
    retired = [...retired, ...planted.map((p) => p.canary)];
    const used = new Set([...retired, ...cur.canaries]);
    planted = LEVELS.map((s) => {
      let c = fresh();
      while (used.has(c)) c = fresh();
      used.add(c);
      return { id: `notes/probe-${s}`, canary: c, sensitivity: s };
    });
  }
  for (const p of planted) if (opts.rotate || !intact(p)) saveNote(root, decoy(p.id, p.sensitivity, p.canary));
  if (needSlice) {
    slicesDoc.setIn(["slices", "probe"], slicesDoc.createNode({ areas: [PROBE_AREA] }, { flow: true }));
    writeFileSync(join(root, "rules", "slices.yaml"), slicesDoc.toString({ flowCollectionPadding: false }));
  }
  mkdirSync(join(root, "rules"), { recursive: true });
  writeFileSync(FILE(root), `# Canaries planted by pocketbrain probe init. Owner only: never served, never shared.\n${YAML.stringify({ canaries: planted.map((p) => p.canary), planted, retired }, { lineWidth: 0 })}`);
  git(root, ["add", "rules/canaries.yaml", "rules/slices.yaml", ...planted.map((p) => `${p.id}.md`)]);
  git(root, ["commit", "-q", "-m", `owner: probe init${opts.rotate ? " --rotate" : ""}, ${planted.length} decoy notes\n\nKind: probe-init`], OWNER);
  return { planted, changed: true, text: render(root, planted, true) };
}

function render(root: string, planted: Planted[], changed: boolean): string {
  const rules = loadRules(root);
  const notes = loadBrain(root);
  const seers = new Map<string, string[]>();
  for (const [a, p] of Object.entries(rules.policy.agents)) {
    if (p.inside_wall) continue;
    let vis: Set<string>;
    try { vis = new Set(carve(notes, rules, grantFor(rules, a)).visible.keys()); } catch { continue; }
    for (const x of planted) if (vis.has(x.id)) seers.set(x.id, [...(seers.get(x.id) ?? []), a]);
  }
  const prober = Object.values(rules.policy.agents).some((a) => a.slices?.includes("probe"));
  return [
    changed ? `Planted ${planted.length} decoy notes in the probe area (one commit).` : "The decoys are in place; nothing changed.",
    "Canaries (keep this list to yourself):",
    ...planted.map((p) => `  ${p.canary.padEnd(24)} ${p.id.padEnd(22)} ${p.sensitivity.padEnd(9)} seen by: ${seers.get(p.id)?.join(", ") ?? "nobody"}`),
    "Recorded in rules/canaries.yaml; the relay, the write path and reads watch for them.",
    ...(prober ? [] : ["No agent has the probe slice yet. For a prober, add to rules/policy.yaml:  auditor: { tier: trial, slices: [probe] }"]),
    "Check an answer: pocketbrain probe check <file|-> [--as <agent>]",
  ].join("\n");
}

// The leak oracle: every canary in `text` (spacing, case, dashes and look-alikes don't hide one).
// `visible` limits it to canaries whose decoy the reader may see; retired canaries are in no note.
export function canaryHits(root: string, text: string, visible?: Set<string>): CanaryHit[] {
  const c = loadCanaries(root);
  if (!c.planted.length && !c.retired.length) return [];
  const t = squash(text);
  const all: CanaryHit[] = [...c.planted.map((p) => ({ canary: p.canary, id: p.id })), ...c.retired.map((r) => ({ canary: r, id: "(retired)" }))];
  return all.filter((h) => !visible?.has(h.id) && t.includes(squash(h.canary)));
}

export function findCanaries(root: string, text: string, agent?: string): CanaryHit[] {
  if (!agent) return canaryHits(root, text);
  const rules = loadRules(root);
  let vis = new Set<string>();
  try { if (rules.policy.agents[agent]) vis = new Set(carve(loadBrain(root), rules, grantFor(rules, agent)).visible.keys()); } catch { /* unknown slice: sees nothing */ }
  return canaryHits(root, text, vis);
}

// Called on what a read hands out: a canary the agent's carve doesn't show means the carve broke.
export function servedCheck(root: string, agent: string, visible: Iterable<string>, text: string) {
  for (const h of canaryHits(root, text, new Set(visible))) alert(root, { agent, check: "canary_served", from: h.id });
}
