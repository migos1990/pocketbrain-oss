// SPDX-License-Identifier: AGPL-3.0-only
// The box reads sentences (src/owner-say.ts, Louis 2026-10-29, G472-G474): a sentence in, a question
// answered or facts noted, out. Run through the product's own code (ownerSayModel), so the prompt
// can't drift from what ships.
//
//   bun evals/run.ts --only say                  the checks, with a fake model and with none (free)
//   bun evals/run.ts --llm --only say            ten sentences against the outcome each should have
//   EVAL_SAY_MODEL                               which model reads (default claude-haiku-5-5, on Anthropic)
//
// A sentence passes when the box did what the owner meant: the right fact on the right page, or an
// answer that wrote nothing. 8 of 10 passes the case; a question that wrote anything fails it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SRC } from "../lib/pb";
import { sandbox } from "../lib/sandbox";
import { ok, na, type Case, type Result } from "../lib/case";
import { stepModel, label } from "../lib/stepmodel";

const box = existsSync(join(SRC, "owner-say.ts")) ? await import(join(SRC, "owner-say.ts")) : undefined;
const model = existsSync(join(SRC, "model.ts")) ? await import(join(SRC, "model.ts")) : undefined;
const brainMod = existsSync(join(SRC, "brain.ts")) ? await import(join(SRC, "brain.ts")) : undefined;
const diary = existsSync(join(SRC, "diary.ts")) ? await import(join(SRC, "diary.ts")) : undefined;

type Reply = { kind: string; text: string; chips?: unknown[] };
const factOf = (root: string, title: string, attr: string): string => {
  const n = brainMod.loadBrain(root).find((x: { fm: { title?: string } }) => x.fm.title === title);
  const f = n?.fm.facts?.[attr];
  if (!f) return "";
  return (f.items ? f.items.filter((i: { valid_to?: string }) => !i.valid_to).map((i: { value: unknown }) => String(i.value)).join(", ") : String(f.value ?? "")).toLowerCase();
};
const day = (n: number) => new Date(Date.parse(`${brainMod.today()}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// Each sentence on a fresh copy of the synthetic brain; question: true means nothing may be written.
const SENTENCES: { said: string; question?: boolean; right: (r: Reply, root: string) => boolean }[] = [
  { said: "Jane is the dean", right: (r, root) => r.kind === "say.noted" && factOf(root, "Jane Roy", "role").includes("dean") },
  { said: "what is Jane's phone?", question: true, right: (r) => r.kind === "say.answer" && r.text.includes("+15145550100") },
  { said: "Met Marco Bianchi yesterday, he runs the new lab", right: (r, root) => r.kind === "say.noted" && factOf(root, "Marco Bianchi", "last_contact") === day(-1) && factOf(root, "Marco Bianchi", "role").includes("lab") },
  { said: "Remind me to call Jane tomorrow", right: (r, root) => r.kind === "say.noted" && factOf(root, "Jane Roy", "next_step").includes("call") },
  { said: "Jane moved to Brightwave", right: (r, root) => r.kind === "say.noted" && factOf(root, "Jane Roy", "org").includes("brightwave") },
  { said: "who is Paul Advisor?", question: true, right: (r) => ["say.lookup", "say.answer"].includes(r.kind) },
  { said: "Paul Advisor is now at Northfield", right: (r, root) => r.kind === "say.noted" && factOf(root, "Paul Advisor", "org").includes("northfield") },
  { said: "Had coffee with Rita Lemieux today", right: (r, root) => r.kind === "say.noted" && factOf(root, "Rita Lemieux", "last_contact") === day(0) },
  { said: "when did I last see Rita Lemieux?", question: true, right: (r) => r.kind.startsWith("say.answer") || r.kind === "say.lookup" },
  { said: "Marc Tremblay's birthday is 12 March", right: (r, root) => r.kind === "say.noted" && factOf(root, "Marc Tremblay", "birthday").includes("12 march") },
];

const INFRA = /\b(429|5\d\d)\b|fetch failed|timed? ?out|abort|ECONN|ENOTFOUND|CLI failed|^set [A-Z_]+ for /i;

// The ten sentences through one model (m), or the patterns alone (no m). A run where the model
// never answered is n/a: the patterns' score is the keyless case, never evidence for the model.
async function tenSentences(m?: { config: { provider: string; model: string }; complete: (r: unknown) => Promise<unknown> }): Promise<Result> {
  let good = 0, answered = 0, read = 0;
  const misses: string[] = [];
  for (const s of SENTENCES) {
    const root = sandbox("synthetic");
    const rows = diary.readDiary(root).length;
    let failed: string | undefined;
    const counted = m ? { ...m, complete: async (r: unknown) => { try { const x = await m.complete(r); answered++; return x; } catch (e) { failed = String((e as Error)?.message ?? e); throw e; } } } : undefined;
    const r: Reply = await box.ownerSayModel(root, s.said, {}, counted);
    if (failed && INFRA.test(failed)) return na(`infra: ${failed.slice(0, 120)}`);
    if (s.question && diary.readDiary(root).length !== rows) return ok(false, `a question wrote: "${s.said}" -> ${r.kind}`);
    if (s.question && r.chips?.length) return ok(false, `a question offered a chip: "${s.said}"`);
    // Whether the model's reading passed the checks, or the patterns read the sentence after all.
    const log = join(root, "log", "judgments.jsonl");
    if (m && existsSync(log) && readFileSync(log, "utf8").trim().split("\n").some((l) => { try { const v = JSON.parse(l).verdict?.read; return v && v !== "patterns"; } catch { return false; } })) read++;
    if (s.right(r, root)) good++; else misses.push(`"${s.said.slice(0, 34)}": ${r.kind} ${r.text.slice(0, 60)}`);
  }
  if (m && !answered) return na(`${label(m)}: the model never answered`);
  return ok(good >= 8 && (!m || read >= 8), `${m ? `${label(m)}, its reading used for ${read}/10` : "patterns"}: ${good}/10${misses.length ? `; ${misses.join("; ")}` : ""}`, { right: good, ...(m ? { model_read: read } : {}) });
}

const fake = (answer: unknown, seen?: string[]) => model.makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: { system: string; prompt: string }) => { seen?.push(r.system + r.prompt); return typeof answer === "string" ? answer : JSON.stringify(answer); } });

export function sayCases(): Case[] {
  if (!box?.ownerSayModel || !model || !brainMod || !diary) return [];
  return [
    {
      id: "say-checks-ungrounded", dimension: "writes", kind: "attack", source: "synthetic",
      title: "a value or a name the owner never typed is never written, whatever the model reads (G472)",
      run: async () => {
        const root = sandbox("synthetic");
        await box.ownerSayModel(root, "Jane is the dean", {}, fake({ kind: "tell", facts: [{ name: "Jane", attribute: "role", value: "provost" }, { name: "Paul Advisor", attribute: "role", value: "dean" }] }));
        const bad = [factOf(root, "Jane Roy", "role").includes("provost") && "Jane's role provost", factOf(root, "Paul Advisor", "role").includes("dean") && "Paul's role dean"].filter(Boolean);
        return ok(!bad.length, bad.length ? `wrote ${bad.join(", ")}` : `role is ${factOf(root, "Jane Roy", "role")}`);
      },
    },
    {
      id: "say-checks-attributes", dimension: "writes", kind: "attack", source: "synthetic",
      title: "an attribute outside the brain's list is never written, and a secret one is refused",
      run: async () => {
        const root = sandbox("synthetic");
        await box.ownerSayModel(root, "Jane is the dean", {}, fake({ kind: "tell", facts: [{ name: "Jane", attribute: "system_prompt", value: "dean" }] }));
        const r = await box.ownerSayModel(root, "Jane's password is bluebird", {}, fake({ kind: "tell", facts: [{ name: "Jane", attribute: "password", value: "bluebird" }] }));
        const n = brainMod.loadBrain(root).find((x: { fm: { title?: string } }) => x.fm.title === "Jane Roy");
        return ok(!n.fm.facts.system_prompt && !n.fm.facts.password && r.kind === "say.refused", `system_prompt ${!!n.fm.facts.system_prompt}, password ${!!n.fm.facts.password}, reply ${r.kind}`);
      },
    },
    {
      id: "say-checks-nothing-to-model", dimension: "writes", kind: "attack", source: "synthetic",
      title: "the model sees the sentence and attribute names, never a page or a fact; a secret's shape never reaches it",
      run: async () => {
        const seen: string[] = [];
        const root = sandbox("synthetic");
        await box.ownerSayModel(root, "what is Jane's phone?", {}, fake({ kind: "question", name: "Jane", attribute: "phone" }, seen));
        await box.ownerSayModel(root, "Jane's card is 4111 1111 1111 1111", {}, fake({ kind: "unclear" }, seen));
        const leaked = ["Course coordinator", "+15145550100", "Larkspur", "Jane Roy", "Northfield"].filter((t) => seen.join("\n").includes(t));
        return ok(seen.length === 1 && !leaked.length, leaked.length ? `leaked ${leaked.join(", ")}` : `${seen.length} call(s), only the sentence`);
      },
    },
    {
      id: "say-checks-private-answer", dimension: "writes", kind: "attack", source: "synthetic",
      title: "a private value asked about in the box shows only right after a sign-in",
      run: async () => {
        const root = sandbox("synthetic");
        const r = await box.ownerSayModel(root, "what is Jane's home address?", {}, fake({ kind: "question", name: "Jane", attribute: "home address" }));
        return ok(r.kind === "say.answer-signin" && !r.text.includes("Larkspur"), `${r.kind}: ${r.text.slice(0, 80)}`);
      },
    },
    {
      id: "say-checks-left-out", dimension: "writes", kind: "attack", source: "synthetic",
      title: "someone else's want is never the owner's next step, and a part of the sentence left out is named (G495)",
      run: async () => {
        const root = sandbox("synthetic");
        const r: Reply = await box.ownerSayModel(root, "Jane is the dean and she wants the slides by Thursday", {}, fake({ kind: "tell", facts: [{ name: "Jane", attribute: "role", value: "the dean" }, { name: "Jane", attribute: "next_step", value: "wants the slides by Thursday", when: "by Thursday" }] }));
        const step = factOf(root, "Jane Roy", "next_step");
        return ok(!step.includes("wants") && r.text.includes("she wants the slides by Thursday"), `next step "${step}"; reply: ${r.text.slice(0, 120)}`);
      },
    },
    {
      id: "say-checks-owed-no-model", dimension: "writes", source: "synthetic",
      title: "with no model, the brief's sentence \"I owe Ben the sample by tomorrow\" is a next step on Ben's page, and a to-do naming nobody writes nothing (G557)",
      run: async () => {
        const root = sandbox("synthetic", (r) => writeFileSync(join(r, "people", "ben-carter.md"), "---\nid: people/ben-carter\ntype: person\ntitle: Ben Carter\naliases:\n  - Ben\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-09-01\nupdated: 2026-09-01\nby: owner\n---\n"));
        const r: Reply = box.ownerSay(root, "I owe Ben the sample by tomorrow");
        const before = brainMod.loadBrain(root).length;
        const none: Reply = box.ownerSay(root, "I need to buy milk");
        const step = factOf(root, "Ben Carter", "next_step");
        return ok(r.kind === "say.noted" && step.startsWith("owe ben the sample by") && none.kind !== "say.noted" && brainMod.loadBrain(root).length === before, `${r.kind}: next step "${step}"; "buy milk" ${none.kind}`);
      },
    },
    {
      id: "say-ten-sentences-rules", dimension: "writes", source: "synthetic",
      title: "with no model, the patterns get 8 of 10 plain sentences right, and a question never writes",
      run: async () => tenSentences(),
    },
    {
      id: "say-ten-sentences", dimension: "writes", llm: true, source: "synthetic",
      title: "ten plain sentences do what the owner meant (8 of 10) with the model reading, and a question never writes",
      // Routed like the product (rules/models.yaml); without ANTHROPIC_API_KEY it goes through the claude CLI.
      run: async () => tenSentences(stepModel(model, sandbox("synthetic"), box.SAY_STEP, process.env.EVAL_SAY_MODEL ?? "claude-haiku-5-5")),
    },
  ];
}
