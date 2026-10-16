// SPDX-License-Identifier: AGPL-3.0-only
// The executor steps (backlog 89: routed to a cheaper model) run with a real model through the
// product's own code, so the prompt can never drift from what ships. Each case has a known right
// answer: the facts the text states, and none it doesn't. The deterministic checks already drop
// anything ungrounded, so a weaker model can only lose recall or waste a call; both count here.
// Runs only with --llm; the model is the routed one unless EVAL_STEP_MODEL pins another
// (lib/stepmodel.ts). An outage or missing CLI is n/a, never a failure.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { SRC } from "../lib/pb";
import { sandbox } from "../lib/sandbox";
import { stepModel, label } from "../lib/stepmodel";
import { ok, na, type Case, type Result } from "../lib/case";

const has = (f: string) => existsSync(join(SRC, f));
const model = has("model.ts") ? await import(join(SRC, "model.ts")) : undefined;
const capture = has("capture.ts") ? await import(join(SRC, "capture.ts")) : undefined;
const sleepMod = has("sleep.ts") ? await import(join(SRC, "sleep.ts")) : undefined;

const INFRA = /\b(429|5\d\d)\b|fetch failed|timed? ?out|abort|ECONN|ENOTFOUND|CLI failed|^set [A-Z_]+ for /i;
const guard = async (f: () => Promise<Result>): Promise<Result> => {
  try { return await f(); } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (INFRA.test(msg)) return na(`infra: ${msg.slice(0, 120)}`);
    throw e;
  }
};

interface Want { id: string; attribute: string; value: RegExp }
const CAPTURES: { id: string; text: string; want: Want[] }[] = [
  {
    id: "steps-capture-changes",
    text: "Quick note after the faculty meeting. Sam Cote is now a lecturer at Northfield University. For TECH 101 fall 2026 the next step is to grade the midterm by Oct 21. The coffee was terrible.",
    want: [
      { id: "people/sam-cote", attribute: "role", value: /lecturer/i },
      // The step itself; both models put the date in a separate due fact, which is fine (model-routing compare).
      { id: "projects/course-a", attribute: "next_step", value: /midterm/i },
    ],
  },
  {
    id: "steps-capture-nothing",
    text: "Long day. Lunch with an old friend downtown, then a walk by the canal. I should sleep earlier this week.",
    want: [],
  },
];

function captureCase(c: (typeof CAPTURES)[number]): Case {
  return {
    id: c.id, dimension: "write-quality", llm: true, source: "synthetic",
    title: c.want.length ? `capture.extract lists every fact the text states (${c.want.length}), and nothing it doesn't` : "capture.extract lists nothing from a text with no facts",
    run: () => guard(async () => {
      if (!model?.modelConfigFor || !capture?.previewExtraction) return na("no capture extraction at this commit");
      const root = sandbox("synthetic");
      const m = stepModel(model, root, capture.STEP);
      const items: { candidate: { attribute: string; value: string }; status: string; target?: string }[] = await capture.previewExtraction(root, c.text, m, "");
      const grounded = items.filter((i) => i.status !== "ungrounded");
      const missed = c.want.filter((w) => !grounded.some((i) => i.target === w.id && i.candidate.attribute === w.attribute && w.value.test(i.candidate.value)));
      const ungrounded = items.length - grounded.length;
      const extra = c.want.length ? 0 : grounded.length;
      return ok(!missed.length && !ungrounded && !extra,
        `${label(m)}: ${items.length} listed${missed.length ? `; missed ${missed.map((w) => `${w.id}#${w.attribute}`).join(", ")}` : ""}${ungrounded ? `; ${ungrounded} ungrounded` : ""}${extra ? `; ${extra} from a text with no facts` : ""}`,
        { listed: items.length, missed: missed.length, ungrounded });
    }),
  };
}

// Journal lines from a personal-ceiling assistant: one durable fact, two lines with none.
const JOURNAL = [
  "- 2026-10-05: Call with Rita: Rita Lemieux is now an associate professor (gmail:f000000000000006)",
  "- 2026-10-06: Drafted three replies for Robin; nothing new to note.",
  "- 2026-10-07: Robin said the weather was lovely on the walk today.",
].join("\n") + "\n";

function sleepCase(): Case {
  return {
    id: "steps-sleep-consolidate", dimension: "write-quality", llm: true, source: "synthetic",
    title: "sleep.consolidate turns the one durable journal line into a proposal and leaves chatter alone",
    run: () => guard(async () => {
      if (!model?.modelConfigFor || !sleepMod?.sleep) return na("no sleep consolidation at this commit");
      const root = sandbox("synthetic", (r) => {
        mkdirSync(join(r, "journal", "helper"), { recursive: true });
        writeFileSync(join(r, "journal", "helper", "2026-10.md"), JOURNAL);
      });
      const m = stepModel(model, root, sleepMod.STEP);
      const r = await sleepMod.sleep(root, { model: m, steps: { forget: false } });
      const reqs = (r.proposals as string[]).map((p) => YAML.parse(readFileSync(join(root, p), "utf8")).request as { id?: string; attribute: string; value: string });
      const hit = reqs.some((q) => q.id === "people/rita-lemieux" && q.attribute === "role" && /associate professor/i.test(String(q.value)));
      const other = reqs.filter((q) => q.id !== "people/rita-lemieux");
      const stuck = (r.held as string[]).filter((h) => /no readable answer|not consolidated/.test(h));
      if (stuck.length && INFRA.test(stuck.join(" "))) return na(`infra: ${stuck[0].slice(0, 120)}`);
      return ok(hit && !other.length && !stuck.length,
        `${label(m)}: ${reqs.length} proposal(s)${hit ? "" : "; missed Rita Lemieux's role"}${other.length ? `; ${other.length} from chatter` : ""}${stuck.length ? `; ${stuck[0].slice(0, 80)}` : ""}`,
        { proposals: reqs.length, chatter: other.length });
    }),
  };
}

export function stepCases(): Case[] {
  return [...CAPTURES.map(captureCase), sleepCase()];
}
