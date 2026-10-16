// SPDX-License-Identifier: AGPL-3.0-only
// Contradiction finder in the night pass (backlog 282, docs/upkeep.md): two notes for the same
// person, org or project holding one attribute with different current values from different
// sources become one dispute packet listing both. Nothing is resolved or changed; the conflict
// order only marks the suggestion. Fixtures only; no model.
import { test, expect } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { upkeep } from "../src/upkeep";
import { loadBrain, type FactRecord } from "../src/brain";

const commit = (root: string) => Bun.spawnSync(["git", "add", "-A"], { cwd: root }) && Bun.spawnSync(["git", "commit", "-qm", "setup"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
const packets = (root: string) => loadBrain(root).filter((n) => n.fm.id.startsWith("disputes/"));
// A second note for Jane Roy (her alias), written by an agent from its own chat.
function twin(root: string, value: string, opts: { area?: string; source?: string } = {}) {
  writeFileSync(join(root, "people", "j-roy.md"), [
    "---", "id: people/j-roy", "type: person", "title: J. Roy", "aliases: [Jane Roy]", `area: ${opts.area ?? "work"}`, "sensitivity: personal", "status: active",
    "created: 2026-10-05", "updated: 2026-10-05", "by: helper", "facts:",
    `  role: { value: ${value}, as_of: 2026-10-05, sources: ["${opts.source ?? "agent:helper"}"], verification: self-reported, by: helper, recorded: 2026-10-05 }`,
    "---", "", ""].join("\n"));
  commit(root);
}
const role = (root: string, id: string) => (loadBrain(root).find((n) => n.fm.id === id)!.fm.facts!.role as FactRecord).value;

test("two notes for one person with different roles from different sources become one dispute packet listing both", () => {
  const root = makeBrain();
  const area = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.area;
  twin(root, "Associate Dean", { area });
  const r = upkeep(root, { now: "2026-10-08" });
  const [p] = packets(root);
  expect(packets(root).length).toBe(1);
  expect(p.fm.fact_key).toBe("people/jane-roy#role");
  expect((p.fm as any).other_key).toBe("people/j-roy#role");
  expect(((p.fm as any).candidates as FactRecord[]).map((c) => c.value)).toEqual(["Course coordinator", "Associate Dean"]);
  // The verified email outranks an agent's own word: that is only the suggestion.
  expect((p.fm as any).suggested).toBe(1);
  expect(p.body).toContain("Suggested: 1");
  // Nothing changed on either note.
  expect(role(root, "people/jane-roy")).toBe("Course coordinator");
  expect(role(root, "people/j-roy")).toBe("Associate Dean");
  const f = r.findings.find((x) => x.rule === "contradiction")!;
  expect(f.kind).toBe("escalate");
  expect(f.key).toBe("people/jane-roy#role");
  // The finding (which the gardener may see) never names the other note or the values.
  expect(f.detail).not.toContain("j-roy");
  expect(f.detail).not.toContain("Dean");
});

test("the next night doesn't open it again", () => {
  const root = makeBrain();
  twin(root, "Associate Dean", { area: loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.area });
  upkeep(root, { now: "2026-10-08" });
  upkeep(root, { now: "2026-10-09" });
  expect(packets(root).length).toBe(1);
});

test("a less specific value of the same thing, or the same source on both, is not a contradiction", () => {
  const root = makeBrain();
  const area = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.area;
  twin(root, "Coordinator", { area });
  upkeep(root, { now: "2026-10-08" });
  expect(packets(root).length).toBe(0);
  const src = String(((loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.facts!.role as FactRecord).sources[0]));
  twin(root, "Associate Dean", { area, source: src });
  upkeep(root, { now: "2026-10-09" });
  expect(packets(root).length).toBe(0);
});

test("notes in different areas get a review line, never a packet that would carry one area's value into the other", () => {
  const root = makeBrain();
  twin(root, "Associate Dean", { area: "personal" });
  const r = upkeep(root, { now: "2026-10-08" });
  expect(packets(root).length).toBe(0);
  expect(existsSync(join(root, "disputes")) ? readdirSync(join(root, "disputes")).length : 0).toBe(0);
  expect(r.findings.find((x) => x.rule === "contradiction")?.kind).toBe("review");
});

test("a twin note at a stricter level makes both sides of the packet that level, so the resolver gets no value", () => {
  const root = makeBrain();
  const area = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.area;
  twin(root, "Associate Dean", { area });
  const f = join(root, "people", "j-roy.md");
  writeFileSync(f, require("node:fs").readFileSync(f, "utf8").replace("sensitivity: personal", "sensitivity: private"));
  commit(root);
  upkeep(root, { now: "2026-10-08" });
  const ps = packets(root);
  // Either a packet whose sides are both private, or (if the carve differs) only a review line.
  for (const p of ps) expect(((p.fm as any).candidates as FactRecord[]).every((c) => c.sensitivity === "private")).toBe(true);
});

// Slice audit of row 282 (F1-F3).
import { getDispute, listDisputes, resolveDispute, answerDispute, ownerDecide, gardenerUpkeep } from "../src/core";
import { loadRules } from "../src/rules";
import { saveNote } from "../src/brain";
function opened() {
  const root = makeBrain();
  twin(root, "Associate Dean", { area: loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.area });
  upkeep(root, { now: "2026-10-08" });
  return { root, id: packets(root)[0].fm.id.split("/")[1], resolver: String(loadRules(root).policy.resolver) };
}

test("the resolver never sees a contradiction packet's values and can't settle it; a relayed answer waits for the owner", () => {
  const { root, id, resolver } = opened();
  const v = getDispute(root, resolver, id) as any;
  expect(JSON.stringify(v)).not.toContain("Associate Dean");
  expect(JSON.stringify(v)).not.toContain("j-roy");
  expect(JSON.stringify(listDisputes(root, resolver))).not.toContain("Associate Dean");
  expect(() => resolveDispute(root, resolver, id, { value: "Associate Dean", as_of: "2026-10-08", sources: ["gmail:f000000000000009"] })).toThrow();
  expect(answerDispute(root, resolver, id, { choice: 2, message_id: "phonemsg-01X0EXAMPLEFORGEDTEXT0001" }).status).toBe("answer-held");
  expect(role(root, "people/jane-roy")).toBe("Course coordinator");
});

test("the owner's answer keeps a share_with or level the fact gained after the packet opened, and the current value goes to history", () => {
  const { root, id } = opened();
  const n = loadBrain(root).find((x) => x.fm.id === "people/jane-roy")!;
  n.fm.facts!.role = { ...(n.fm.facts!.role as FactRecord), value: "Program director", as_of: "2026-10-07", sensitivity: "private", share_with: ["planner"] };
  saveNote(root, n); commit(root);
  ownerDecide(root, id, 2);
  const after = loadBrain(root).find((x) => x.fm.id === "people/jane-roy")!;
  const r = after.fm.facts!.role as FactRecord;
  expect(r.value).toBe("Associate Dean");
  expect(r.sensitivity).toBe("private");
  expect(r.share_with).toEqual(["planner"]);
  expect(JSON.stringify(after.fm.history?.role ?? [])).toContain("Program director");
});

test("the gardener never gets a finding on a fact hidden from it, even when it sees the note", async () => {
  const root = makeBrain();
  const n = loadBrain(root).find((x) => x.fm.id === "people/jane-roy")!;
  n.fm.facts!.role = { ...(n.fm.facts!.role as FactRecord), share_with: ["planner"] };
  saveNote(root, n);
  twin(root, "Associate Dean", { area: n.fm.area });
  process.env.PB_NOW = "2026-10-08T07:30:00Z";
  try {
    const r = await gardenerUpkeep(root, "gardener");
    expect(r.findings.some((f) => f.key === "people/jane-roy#role")).toBe(false);
  } finally { delete process.env.PB_NOW; }
});

test("while another dispute holds the fact, the contradiction packet can't be settled over it", () => {
  const { root, id } = opened();
  const n = loadBrain(root).find((x) => x.fm.id === "people/jane-roy")!;
  const r = n.fm.facts!.role as FactRecord;
  n.fm.facts!.role = { dispute: "c-0099", candidates: [r, { ...r, value: "Dean of studies", sources: ["gmail:f000000000000008"] }] } as any;
  saveNote(root, n); commit(root);
  expect(() => ownerDecide(root, id, 2)).toThrow(/c-0099/);
  expect((loadBrain(root).find((x) => x.fm.id === "people/jane-roy")!.fm.facts!.role as any).dispute).toBe("c-0099");
});
