// SPDX-License-Identifier: AGPL-3.0-only
// The model-judged duplicate step (src/judge.ts), run with a real model through the product's
// own code: judgeDuplicates builds the prompt, so the eval can never drift from what ships
// (no copied prompt to keep in sync). Runs only with --llm.
//
//   bun evals/run.ts --llm --only judge                 the routed model (review role), as the product runs it
//   EVAL_DUP_PROVIDER=openai EVAL_DUP_MODEL=gpt-x …     another provider/model (needs its key)
//   EVAL_STEP_MODEL=claude-haiku-5-5 …                  another Anthropic model (lib/stepmodel.ts)
//   EVAL_REPEATS=5 bun evals/run.ts --llm --only judge  every repeat must pass (pass^k)
//
// A provider outage, rate limit or missing key is n/a, never a failure: only a wrong answer
// counts against the step.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SRC } from "../lib/pb";
import { sandbox, writeNote } from "../lib/sandbox";
import { ok, na, type Case, type Result } from "../lib/case";
import { stepModel, label } from "../lib/stepmodel";

const judge = existsSync(join(SRC, "judge.ts")) ? await import(join(SRC, "judge.ts")) : undefined;
const model = existsSync(join(SRC, "model.ts")) ? await import(join(SRC, "model.ts")) : undefined;

const person = (id: string, title: string, facts: Record<string, string>, aliases: string[] = []) => `---
id: ${id}
type: person
title: ${title}
${aliases.length ? `aliases: [${aliases.join(", ")}]\n` : ""}area: work
sensitivity: personal
status: active
created: 2026-10-01
updated: 2026-10-01
by: planner
facts:
${Object.entries(facts).map(([k, v]) => `  ${k}: { value: ${v}, as_of: 2026-10-01, sources: ["agent:planner"], verification: self-reported, by: planner, recorded: 2026-10-01 }`).join("\n")}
---
`;
const org = (id: string, title: string, facts: Record<string, string>) => person(id, title, facts).replace("type: person", "type: org");

// Known answers. "same" pairs must come back as same or unsure (a review item either way);
// "different" pairs must never come back as same, since that is a merge suggestion to the owner.
const PAIRS: { a: string; b: string; truth: "same" | "different" }[] = [
  { a: "people/helene-bouchard", b: "people/helene-b", truth: "same" },
  { a: "orgs/banque-nationale", b: "orgs/banque-nationale-du-canada", truth: "same" },
  { a: "people/j-roy", b: "people/jane-roy", truth: "same" },
  { a: "people/marie-tremblay", b: "people/marie-gagnon", truth: "different" },
  { a: "people/marc-tremblay", b: "people/marie-tremblay", truth: "different" }, // marc-tremblay is in the fixture
  { a: "orgs/montreal-childrens-hospital", b: "orgs/montreal-general-hospital", truth: "different" },
];

export function brain(): string { // exported for checking the pairs by hand
  return sandbox("synthetic", (r) => {
    writeNote(r, "people/helene-bouchard", person("people/helene-bouchard", "Hélène Bouchard", { role: "Electrical engineer", employer: "Énergie Nordique" }));
    writeNote(r, "people/helene-b", person("people/helene-b", "Helene B.", { role: "Engineer at Energie Nordique" }));
    writeNote(r, "orgs/banque-nationale", org("orgs/banque-nationale", "Banque Nationale", { relationship: "Mortgage lender" }));
    writeNote(r, "orgs/banque-nationale-du-canada", org("orgs/banque-nationale-du-canada", "Banque Nationale du Canada", { relationship: "Bank holding the mortgage" }));
    writeNote(r, "people/marie-tremblay", person("people/marie-tremblay", "Marie Tremblay", { role: "Dentist", city: "Laval" }));
    writeNote(r, "people/marie-gagnon", person("people/marie-gagnon", "Marie Gagnon", { role: "Grade 3 teacher", city: "Montreal" }));
    writeNote(r, "orgs/montreal-childrens-hospital", org("orgs/montreal-childrens-hospital", "Montreal Children's Hospital", { relationship: "Pediatric care" }));
    writeNote(r, "orgs/montreal-general-hospital", org("orgs/montreal-general-hospital", "Montreal General Hospital", { relationship: "Adult emergency" }));
  });
}

const INFRA = /\b(429|5\d\d)\b|fetch failed|timed? ?out|abort|ECONN|ENOTFOUND|^set [A-Z_]+ for /i;

const INFRA_CLI = /CLI failed/;

async function once(): Promise<{ result?: Result; wrong: string[]; missed: string[]; used: string }> {
  const root = brain();
  const m = process.env.EVAL_DUP_PROVIDER
    ? model.makeModel({ provider: process.env.EVAL_DUP_PROVIDER, model: process.env.EVAL_DUP_MODEL ?? "" })
    : model.modelConfigFor ? stepModel(model, root, "upkeep.duplicates", process.env.EVAL_DUP_MODEL ?? process.env.EVAL_STEP_MODEL)
    : model.makeModel({ provider: "anthropic", model: process.env.EVAL_DUP_MODEL ?? "claude-haiku-5-5" });
  const used = label(m);
  let items: string[];
  try {
    items = (await judge.judgeDuplicates(root, m)).items;
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (INFRA.test(msg) || INFRA_CLI.test(msg)) return { result: na(`infra: ${msg.slice(0, 120)}`), wrong: [], missed: [], used };
    throw e;
  }
  const verdict = (a: string, b: string) => items.find((l) => l.includes(`\`${a}\``) && l.includes(`\`${b}\``))?.match(/possible-duplicate, (\w+)/)?.[1];
  const wrong = PAIRS.filter((p) => p.truth === "different" && verdict(p.a, p.b) === "same").map((p) => `${p.a}~${p.b}`);
  const missed = PAIRS.filter((p) => p.truth === "same" && !verdict(p.a, p.b)).map((p) => `${p.a}~${p.b}`);
  return { wrong, missed, used };
}

export function judgeCases(): Case[] {
  return [{
    id: "judge-duplicates", dimension: "upkeep", llm: true, source: "synthetic",
    title: "model-judged duplicates: never calls two different entities the same, and reports every true duplicate",
    run: async () => {
      if (!judge || !model) return na("no judge at this commit");
      let used = "";
      const k = Math.max(1, Number(process.env.EVAL_REPEATS ?? 1));
      const wrong: string[] = [], missed: string[] = [];
      let passes = 0;
      for (let i = 0; i < k; i++) {
        const r = await once();
        if (r.result) return r.result;
        used = r.used;
        wrong.push(...r.wrong); missed.push(...r.missed);
        if (!r.wrong.length && !r.missed.length) passes++;
      }
      const u = (xs: string[]) => [...new Set(xs)].join(", ");
      return ok(passes === k, `${used}: ${passes}/${k} runs clean${wrong.length ? `; called same: ${u(wrong)}` : ""}${missed.length ? `; missed: ${u(missed)}` : ""}`,
        { pass_k: passes / k, false_same: wrong.length });
    },
  }];
}
