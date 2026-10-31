// SPDX-License-Identifier: AGPL-3.0-only
// The incremental carve (carve.ts carveFromMemo) remembers what each frozen note gave the last
// carve for the same grant, so a carve after one write works out only that note (docs/perf.md).
// Its answers must be exactly the full carve's, after any change to notes or rules; the full
// carve runs on unfrozen copies, which the memo never takes.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, saveNote, type Note } from "../src/brain";
import { loadRules } from "../src/rules";
import { carve, grantFor, carveStats, type CarveResult } from "../src/carve";

const AGENTS = ["steward", "planner", "helper", "gardener"];
const shape = (r: CarveResult) => JSON.stringify({
  mergedTo: [...r.mergedTo ?? []], visible: [...r.visible].map(([id, v]) => [id, v.note.fm, v.note.body, v.note.path, v.attributes === "all" ? "all" : [...v.attributes], v.body, v.slices]),
  excluded: r.excluded, hidden: r.hiddenFacts, notShared: r.notShared, carved: r.carvedValues, flags: r.flags,
});

function compare(root: string, what: string) {
  const rules = loadRules(root);
  const shared = loadBrain(root, { shared: true });
  for (const agent of AGENTS) {
    const grant = () => grantFor(rules, agent);
    const memo = carve(shared, rules, grant(), { flags: false });
    const full = carve(structuredClone(shared), rules, grant(), { flags: false });
    expect(shape(memo), `${what}: ${agent}`).toBe(shape(full));
    // Twice: the second carve is all memo hits.
    expect(shape(carve(shared, rules, grant(), { flags: false })), `${what}: ${agent}, again`).toBe(shape(full));
    const plain = carve(structuredClone(shared), rules, grant(), { flags: false, names: false });
    expect(shape(carve(shared, rules, grant(), { flags: false, names: false })), `${what}: ${agent}, names off`).toBe(shape(plain));
  }
}

test("the incremental carve answers exactly like the full carve, through random edits to notes and rules", () => {
  const root = makeBrain({ git: false });
  let seed = 11;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const values = () => loadBrain(root).flatMap((n) => Object.values(n.fm.facts ?? {}).flatMap((f) => "value" in f && typeof f.value === "string" ? [f.value] : []));
  const policyFile = join(root, "rules", "policy.yaml"), slicesFile = join(root, "rules", "slices.yaml");
  const policy0 = readFileSync(policyFile, "utf8"), slices0 = readFileSync(slicesFile, "utf8");
  compare(root, "start");
  const ops: Record<string, () => void> = {
    sensitivity: () => { const n = pick(loadBrain(root)); n.fm.sensitivity = pick(["public", "personal", "private", "secret"] as const); saveNote(root, n); },
    "fact with another note's value": () => {
      const n = pick(loadBrain(root));
      n.fm.facts = { ...n.fm.facts, [pick(["note", "account", "bank", "role"])]: { value: rnd() < 0.15 ? pick(["[withheld] Harbour", "With-held Trust 4417", "[[redacted]] desk"]) : `${pick(values())}${rnd() < 0.3 ? " Trust" : ""}`, as_of: "2026-10-01", sources: ["gmail:f000000000000009"], verification: "verified-by-source" as const, by: "planner", recorded: "2026-10-01", ...(rnd() < 0.4 ? { sensitivity: "private" as const } : {}), ...(rnd() < 0.2 ? { share_with: ["steward"] } : {}) } };
      saveNote(root, n);
    },
    "alias from another title": () => { const ns = loadBrain(root); const n = pick(ns); n.fm.aliases = [...(n.fm.aliases ?? []), pick(ns).fm.title]; saveNote(root, n); },
    "title with a value": () => { const n = pick(loadBrain(root)); n.fm.title = `${n.fm.title} at ${pick(values())}`; saveNote(root, n); },
    "new note": () => { const n = pick(loadBrain(root)); const id = `${n.fm.id}-copy${Math.floor(rnd() * 1000)}`; n.fm.id = id; n.path = `${id}.md`; saveNote(root, n); },
    "note gone": () => { const ns = loadBrain(root); if (ns.length > 6) rmSync(join(root, pick(ns).path)); },
    "exclude by name": () => { const p = YAML.parse(readFileSync(policyFile, "utf8")); p.agents.planner.exclude = [pick(loadBrain(root)).fm.id]; writeFileSync(policyFile, YAML.stringify(p)); },
    "exclude a fact": () => { const p = YAML.parse(readFileSync(policyFile, "utf8")); const n = pick(loadBrain(root)); p.agents.helper.exclude = [`${n.fm.id}#${pick(Object.keys(n.fm.facts ?? { role: 1 }))}`]; writeFileSync(policyFile, YAML.stringify(p)); },
    "slice edit": () => { const s = YAML.parse(readFileSync(slicesFile, "utf8")); const name = pick(Object.keys(s.slices)); s.slices[name].exclude_attributes = [pick(["role", "phones", "note", "account"])]; writeFileSync(slicesFile, YAML.stringify(s)); },
    "merged into another": () => { const ns = loadBrain(root); const n = pick(ns); n.fm.status = "merged"; n.fm.merged_into = rnd() < 0.8 ? pick(ns).fm.id : "people/nobody"; saveNote(root, n); },
    "merge undone": () => { const n = loadBrain(root).find((x) => x.fm.status === "merged"); if (n) { n.fm.status = "active"; delete n.fm.merged_into; saveNote(root, n); } },
    "an agent's own note": () => { const n = pick(loadBrain(root)); const a = pick(AGENTS); n.fm.area = a; n.fm.by = a; saveNote(root, n); },
    "own slice edit": () => { const s = YAML.parse(readFileSync(slicesFile, "utf8")); s.slices.own = { exclude_attributes: [pick(["role", "phones", "note", "account"])] }; writeFileSync(slicesFile, YAML.stringify(s)); },
    "rules back": () => { writeFileSync(policyFile, policy0); writeFileSync(slicesFile, slices0); },
  };
  for (let i = 0; i < 200; i++) {
    const op = pick(Object.keys(ops));
    ops[op]();
    compare(root, `round ${i} (${op})`);
  }
});

test("after one note changes, the next carve works out only that note", () => {
  const root = makeBrain({ git: false });
  const rules = loadRules(root);
  const grant = () => grantFor(rules, "planner");
  carve(loadBrain(root, { shared: true }), rules, grant(), { flags: false });
  const n = loadBrain(root).find((x) => x.fm.id === "people/jane-roy") as Note;
  n.fm.facts = { ...n.fm.facts, desk: { value: "Room 4417", as_of: "2026-10-01", sources: ["gmail:f000000000000009"], verification: "verified-by-source" as const, by: "planner", recorded: "2026-10-01" } };
  saveNote(root, n);
  const before = carveStats.placed;
  carve(loadBrain(root, { shared: true }), rules, grant(), { flags: false });
  expect(carveStats.placed - before).toBe(1);
});

test("the incremental carve carves only purposeful exclusions, like the full carve: an area named like a reason doesn't (backlog 181)", () => {
  const root = makeBrain({ git: false });
  for (const area of ["above-board", "excluded-trips", "not shared"]) writeFileSync(join(root, `projects/p-${area.replace(" ", "-")}.md`),
    `---\nid: projects/p-${area.replace(" ", "-")}\ntype: project\ntitle: p\narea: ${area}\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: steward\nfacts:\n  partner: { value: Zephyr ${area.replace(/\W/g, "")} Holdings, as_of: 2026-10-01, sources: ["url:https://example.org"], verification: verified-by-source }\n---\n`);
  const rules = loadRules(root);
  const memo = carve(loadBrain(root, { shared: true }), rules, grantFor(rules, "planner"), { flags: false });
  expect(memo.carvedValues.filter((v) => v.startsWith("Zephyr"))).toEqual([]);
  expect(memo.carvedValues).toContain("Maple Trust Bank");
  compare(root, "areas named like reasons");
});
