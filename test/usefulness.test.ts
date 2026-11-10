// SPDX-License-Identifier: AGPL-3.0-only
// The one number every change must move (plans/next-level.md, revised move 1; audit v13 section 7):
// a set of questions an assistant would ask about the owner, each asked as that assistant's
// context_pack, scored as answerable (what the answer needs is in the pack) and in how many tokens.
// Half written, half harvested from what assistants really asked (the reads log), re-sampled monthly.
import { test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { loadBrain } from "../src/brain";

const SET = join(import.meta.dir, "..", "evals", "fixtures", "usefulness-demo.yaml");

async function demo() { process.env.PB_NOW = DEMO_NOW; return (await makeDemoBrain()).root; }

test("every question in the demo set names a fact the demo brain holds", async () => {
  const { loadUsefulness } = await import("../src/usefulness");
  try {
    const root = await demo();
    const qs = loadUsefulness(SET);
    expect(qs.length).toBe(25);
    const notes = new Map(loadBrain(root).map((n) => [n.fm.id, n]));
    for (const q of qs) for (const k of q.facts) {
      const [id, attr] = k.split("#");
      expect(notes.get(id!)?.fm.facts?.[attr!], k).toBeDefined();
    }
  } finally { delete process.env.PB_NOW; }
}, 90_000);

// Four of the demo set's questions: one fact, one decision, one money fact a work-only trial
// assistant can't see, one about a page outside its area. The whole set runs in
// scripts/usefulness.ts (bun run usefulness), too long for a unit test.
function small(root: string) {
  const f = join(root, "u4.yaml");
  writeFileSync(f, readFileSync(SET, "utf8").split("\n").filter((l) => !/^  - /.test(l) || /id: (who-maya|why-northgate|kitchen-payment|jordan),/.test(l)).join("\n"));
  return f;
}

test("scored per assistant and door: answered of asked, tokens, noise; a missing fact is not answered", async () => {
  const { scoreUsefulness, answers } = await import("../src/usefulness");
  try {
    const root = await demo();
    const s = scoreUsefulness(root, { file: small(root), agents: ["claude", "gemini"], harvest: 0, doors: ["pack", "search"] });
    for (const door of ["pack", "search"] as const) {
      const claude = s.agents.find((a) => a.agent === "claude" && a.door === door)!;
      expect(claude.sets.usefulness).toEqual({ asked: 4, answered: 4 });
      expect(claude.tokens.median).toBeGreaterThan(0);
      expect(claude.noise).toBeGreaterThan(0);
      // A trial assistant that sees only work notes answers fewer.
      const gemini = s.agents.find((a) => a.agent === "gemini" && a.door === door)!;
      expect(gemini.sets.usefulness!.answered).toBeLessThan(4);
    }
    // Answerable means the needed value is there, nothing else.
    const q = { id: "x", q: "who is Maya Chen?", set: "usefulness" as const, facts: ["people/maya-chen#role"], says: [], notes: [], oneOf: [] };
    expect(answers(root, q, "- **role** [current]: design lead (as of …)").answered).toBe(true);
    expect(answers(root, q, "- **role** [current]: staff engineer").answered).toBe(false);
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("half the set comes from what assistants really asked, the same all month, never more than asked for", async () => {
  const { harvest } = await import("../src/usefulness");
  try {
    const root = await demo();
    const a = harvest(root, { n: 10, day: "2026-10-08" }), b = harvest(root, { n: 10, day: "2026-10-30" }), c = harvest(root, { n: 4, day: "2026-11-02" });
    expect(a.length).toBeGreaterThan(0);
    expect(a.length).toBeLessThanOrEqual(10);
    expect(a.map((x) => x.q)).toEqual(b.map((x) => x.q));
    expect(c.length).toBeLessThanOrEqual(4);
    expect(new Set(a.map((x) => x.q.toLowerCase())).size).toBe(a.length);
    for (const x of a) { expect(x.set).toBe("use"); expect(x.notes.length).toBeGreaterThan(0); }
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("scoring is not an assistant's read: the reads log and the brain stay as they were", async () => {
  const { scoreUsefulness } = await import("../src/usefulness");
  try {
    const root = await demo();
    const log = join(root, "log", "reads.jsonl");
    const before = existsSync(log) ? readFileSync(log, "utf8") : "";
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString();
    scoreUsefulness(root, { file: small(root), agents: ["claude"] });
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe(before);
    expect(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString()).toBe(head);
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("the counts line names no question, note or value", async () => {
  const { scoreUsefulness, countsText } = await import("../src/usefulness");
  try {
    const root = await demo();
    const text = countsText(scoreUsefulness(root, { file: small(root), agents: ["claude"], harvest: 2 }));
    expect(text).toMatch(/claude by context pack: \d+\/\d+ answered/);
    expect(text).toMatch(/claude by search, then read 3: \d+\/\d+ answered/);
    for (const bad of ["Maya", "maya-chen", "design lead", "Atlas", "who is", "people/"]) expect(text).not.toContain(bad);
    // The door assistants use most leads (CEO review, 2026-11-09): memory_check then read, then the pack.
    const lines = text.split("\n").filter((l) => l.startsWith("  claude by "));
    expect(lines[0]).toMatch(/^  claude by memory_check, then read 3: /);
    expect(lines[1]).toMatch(/^  claude by context pack: /);
    expect(text.split("\n")[1]).toMatch(/^The number to steer by is the first line per assistant/);
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("a brain's own set is evals/usefulness.yaml, and its golden files count too", async () => {
  const { scoreUsefulness } = await import("../src/usefulness");
  try {
    const root = await demo();
    require("node:fs").mkdirSync(join(root, "evals"), { recursive: true });
    writeFileSync(join(root, "evals", "usefulness.yaml"), "questions:\n  - { id: a, q: \"who is Maya Chen?\", facts: [people/maya-chen#role] }\n");
    const s = scoreUsefulness(root, { harvest: 0, doors: ["pack"], agents: ["claude"] });
    expect(s.agents.find((a) => a.agent === "claude")!.sets.usefulness).toEqual({ asked: 1, answered: 1 });
    // The golden set's own shape: one of the wanted notes, with the expected fact shown.
    writeFileSync(join(root, "evals", "weekly.yaml"), "questions:\n  - { id: w1, as: [claude], q: \"what's next on Atlas?\", want: [projects/atlas-launch], expect: next_step }\n  - { id: w2, as: [claude], q: \"who is Maya Chen?\", want: [projects/kitchen-renovation], expect: lead }\n");
    const g = scoreUsefulness(root, { harvest: 0, doors: ["pack"], agents: ["claude"] });
    expect(g.agents.find((a) => a.agent === "claude")!.sets.weekly).toEqual({ asked: 2, answered: 1 });
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("the memory_check door: the change feed the agent would get, then the notes it points to; logs nothing (G769)", async () => {
  const { scoreUsefulness } = await import("../src/usefulness");
  const { memoryCheck, previewFeed } = await import("../src/memsync");
  const { write } = await import("../src/write");
  try {
    const root = await demo();
    const f = join(root, "u1.yaml");
    writeFileSync(f, "questions:\n  - { id: next, q: \"where is the senior designer hire\", facts: [projects/designer-hire#status] }\n");
    // Before its first memory_check an agent has no feed: the door gives it nothing.
    expect(scoreUsefulness(root, { file: f, agents: ["claude"], harvest: 0, doors: ["check"] }).agents[0]!.all).toEqual({ asked: 1, answered: 0 });
    memoryCheck(root, "claude");
    write(root, { kind: "fact", agent: "owner", id: "projects/designer-hire", attribute: "status", value: "offer sent", as_of: "2026-10-08", sources: ["owner:2026-10-08/notes"] }, { owner: true });
    const log = join(root, "log", "memsync.jsonl"), before = readFileSync(log, "utf8");
    expect(previewFeed(root, "claude").map((i) => i.key)).toContain("projects/designer-hire#status");
    const s = scoreUsefulness(root, { file: f, agents: ["claude"], harvest: 0, doors: ["check"] });
    expect(s.agents[0]!.all).toEqual({ asked: 1, answered: 1 });
    expect(s.agents[0]!.tokens.median).toBeGreaterThan(0);
    expect(readFileSync(log, "utf8")).toBe(before);
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("a note counts only when it comes back as a note; an id on a line is a pointer, counted apart (G768)", async () => {
  const { answers, compareShapes, lostToWide } = await import("../src/usefulness");
  try {
    const root = await demo();
    const q = { id: "k", q: "who is Maya", set: "usefulness" as const, facts: [], says: [], notes: ["people/kenji-watanabe"], oneOf: [] };
    expect(answers(root, q, "# pack\n### Kenji Watanabe `people/kenji-watanabe`\nperson")).toMatchObject({ answered: true, pointer: false });
    expect(answers(root, q, "Connected: Kenji Watanabe `people/kenji-watanabe`")).toMatchObject({ answered: false, pointer: true });
    expect(answers(root, q, "nothing here")).toMatchObject({ answered: false, pointer: false });
    // Kenji is the sixth match for "who is Maya": named on the line in one shape, a note in the others.
    const f = join(root, "u1.yaml");
    writeFileSync(f, "questions:\n  - { id: kenji, q: \"who is Maya\", notes: [people/kenji-watanabe] }\n");
    const by = new Map(compareShapes(root, { file: f, agents: ["claude"], harvest: 0 }).map((x) => [x.shape, x]));
    expect(by.get("eight whole")).toMatchObject({ asked: 1, answered: 1, pointers: 0 });
    expect(by.get("three whole, five named")).toMatchObject({ asked: 1, answered: 0, pointers: 1 });
    expect(by.get("today")).toMatchObject({ asked: 1, answered: 1, pointers: 0 });
    expect(by.get("eight whole")!.median).toBeGreaterThan(by.get("today")!.median);
    // Nina is the eighth: eight whole notes bring her as a note, today's pack names her on a line.
    writeFileSync(f, "questions:\n  - { id: kenji, q: \"who is Maya\", notes: [people/kenji-watanabe] }\n  - { id: nina, q: \"who is Maya\", notes: [people/nina-petrova] }\n");
    expect(lostToWide(root, { file: f, agents: ["claude"], harvest: 0 })).toEqual([{ agent: "claude", set: "usefulness", index: 2, at: 8, now: "named on a line", missing: 1 }]);
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("a contested fact served as current is a miss, whichever way the conflict is stored (G768)", async () => {
  const { answers, scoreUsefulness } = await import("../src/usefulness");
  try {
    const root = await demo();
    // The Atlas next step is contested by its record's `contested` key (an open dispute), not the two-candidate form.
    const q = { id: "a", q: "what's the next step on the Atlas launch?", set: "usefulness" as const, facts: ["projects/atlas-launch#next_step"], says: [], notes: [], oneOf: [] };
    expect(answers(root, q, "# p\n### Atlas launch `projects/atlas-launch`\n- **next_step** [current]: freeze the beta build on 15 October").answered).toBe(false);
    expect(answers(root, q, "# p\n### Atlas launch `projects/atlas-launch`\n- **next_step** [disputed]: freeze the beta build on 15 October").answered).toBe(true);
    const f = join(root, "u1.yaml");
    writeFileSync(f, "questions:\n  - { id: atlas-next, q: \"what's the next step on the Atlas launch?\", facts: [projects/atlas-launch#next_step] }\n");
    // Until the pack marks it (trust work, elsewhere), the number counts it as not answered.
    expect(scoreUsefulness(root, { file: f, agents: ["claude"], harvest: 0, doors: ["pack"] }).agents[0]!.all.answered).toBe(0);
  } finally { delete process.env.PB_NOW; }
}, 90_000);
