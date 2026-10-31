// SPDX-License-Identifier: AGPL-3.0-only
// Capture precision (backlog #198, big bet 2): a self-filling brain is only trusted if what it
// proposes is right. 40 synthetic source items (evals/fixtures/fill/items.yaml) with hand-labelled
// facts go through the product's own extraction path (capture.previewExtraction: the prompt and
// the code checks a pull uses) and are scored:
//   precision  proposals that are a labelled fact / all proposals (target 0.9)
//   recall     labelled facts proposed or already held / all labelled facts
//   grounding  proposals whose quote alone carries the value / all proposals
// fill-checks runs a fake model that answers the labelled facts plus planted wrong ones, so it
// measures the code checks for free on every run. fill-model runs the routed capture.extract
// model (--llm; paid, through the harness thread), which is the number bet 2 is judged on.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { SRC } from "../lib/pb";
import { sandbox } from "../lib/sandbox";
import { stepModel, label } from "../lib/stepmodel";
import { ok, na, type Case, type Result } from "../lib/case";

const has = (f: string) => existsSync(join(SRC, f));
const model = has("model.ts") ? await import(join(SRC, "model.ts")) : undefined;
const capture = has("capture.ts") ? await import(join(SRC, "capture.ts")) : undefined;

interface Fact { who?: string; entity?: string; type?: string; attribute: string; value?: string; match?: string; quote?: string; catch?: boolean; grounded?: boolean }
interface Item { id: string; kind: string; text: string; want?: Fact[]; also?: Fact[]; traps?: Fact[] }
export const FILL_ITEMS: Item[] = YAML.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "fill", "items.yaml"), "utf8")).items;

interface Listed { candidate: { entity: string; type: string; attribute: string; value: string; quote: string }; status: string; target?: string }
// What reaches the owner as a proposal. "known" is already in the brain (no card); the rest are dropped.
const PROPOSED = new Set(["changes", "new-fact", "new-note", "ambiguous"]);

const fold = (t: string) => t.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function matches(f: Fact, l: Listed): boolean {
  const c = l.candidate;
  const who = `${c.entity ?? ""} ${(l.target ?? "").replace(/[/-]/g, " ")}`;
  // A label's attribute may list the places the fact can rightly go ("schedule_changes|outcome").
  return (!f.who || new RegExp(f.who, "i").test(who)) && new RegExp(`^(${f.attribute})$`).test(c.attribute) && new RegExp(f.match ?? esc(f.value ?? ""), "i").test(String(c.value));
}

// The quote alone carries the value: the date (whole, or its day and month), or most of the
// value's words. The checks hold the value to the whole item; this holds it to the cited line.
export function quoteCarries(value: string, quote: string): boolean {
  const q = fold(quote), v = String(value).trim();
  const d = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (d) return q.includes(v) || (new RegExp(`(^|\\D)0?${Number(d[3])}(\\D|$)`).test(q) && (q.includes(MONTHS[Number(d[2]) - 1]) || q.includes(`${d[2]}-${d[3]}`)));
  const words = fold(v).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 || /\d/.test(w));
  return !words.length || words.filter((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(w)}($|[^\\p{L}\\p{N}])`, "u").test(q)).length / words.length >= 0.6;
}

export interface FillScore { proposed: number; right: number; wanted: number; found: number; grounded: number; misses: string[]; wrong: string[] }
export function scoreItem(it: Item, listed: Listed[]): FillScore {
  const props = listed.filter((l) => PROPOSED.has(l.status));
  const want = it.want ?? [], also = it.also ?? [];
  const found = want.filter((w) => listed.some((l) => (PROPOSED.has(l.status) || l.status === "known") && matches(w, l)));
  const wrong = props.filter((l) => ![...want, ...also].some((f) => matches(f, l)));
  return {
    proposed: props.length, right: props.length - wrong.length, wanted: want.length, found: found.length,
    grounded: props.filter((l) => quoteCarries(l.candidate.value, l.candidate.quote)).length,
    misses: want.filter((w) => !found.includes(w)).map((w) => `${it.id} ${w.who}#${w.attribute}`),
    wrong: wrong.map((l) => `${it.id} ${l.candidate.entity}#${l.candidate.attribute}=${l.candidate.value}`),
  };
}

const sum = (xs: FillScore[]) => xs.reduce((a, s) => ({ proposed: a.proposed + s.proposed, right: a.right + s.right, wanted: a.wanted + s.wanted, found: a.found + s.found, grounded: a.grounded + s.grounded, misses: [...a.misses, ...s.misses], wrong: [...a.wrong, ...s.wrong] }), { proposed: 0, right: 0, wanted: 0, found: 0, grounded: 0, misses: [], wrong: [] } as FillScore);
const rate = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 1000 : 1);
const metrics = (t: FillScore) => ({ items: FILL_ITEMS.length, proposals: t.proposed, precision: rate(t.right, t.proposed), recall: rate(t.found, t.wanted), grounding: rate(t.grounded, t.proposed) });
const line = (t: FillScore) => { const m = metrics(t); return `${m.items} items, ${m.proposals} proposals: precision ${m.precision}, recall ${m.recall}, grounding ${m.grounding}`; };
const some = (xs: string[], n = 4) => xs.slice(0, n).join("; ") + (xs.length > n ? `; +${xs.length - n} more` : "");

// The fake model's answer for an item: every labelled fact (with its exact quote) plus the traps.
const asCandidate = (f: Fact) => ({ entity: f.entity ?? f.who!.split("|")[0].replace(/\b\p{L}/gu, (c) => c.toUpperCase()), type: f.type, attribute: f.attribute.split("|")[0], value: f.value, quote: f.quote });
const fakeFor = (it: Item) => {
  const text = JSON.stringify({ facts: [...(it.want ?? []), ...(it.traps ?? [])].map(asCandidate) });
  return { config: { provider: "fake", model: "fill-fixture" }, complete: async () => ({ text, provider: "fake", model: "fill-fixture" }) };
};

const INFRA = /\b(429|5\d\d)\b|fetch failed|timed? ?out|abort|ECONN|ENOTFOUND|CLI failed|^set [A-Z_]+ for /i;

export function fillCases(): Case[] {
  return [
    {
      id: "fill-checks", dimension: "write-quality", source: "synthetic",
      title: "capture precision, fake model: the code checks drop every planted fact they can see and keep every labelled one",
      run: async (): Promise<Result> => {
        if (!capture?.previewExtraction) return na("no capture extraction at this commit");
        const root = sandbox("synthetic");
        const scores: FillScore[] = [], leaked: string[] = [], dropped: string[] = [];
        for (const it of FILL_ITEMS) {
          const listed: Listed[] = await capture.previewExtraction(root, it.text, fakeFor(it), it.kind);
          const s = scoreItem(it, listed);
          scores.push(s);
          dropped.push(...s.misses);
          for (const t of (it.traps ?? []).filter((t) => t.catch)) {
            const l = listed.find((x) => x.candidate.attribute === t.attribute && x.candidate.value === t.value && x.candidate.quote === t.quote);
            if (l && PROPOSED.has(l.status)) leaked.push(`${it.id} ${t.attribute}=${t.value}`);
          }
        }
        const t = sum(scores);
        return ok(!leaked.length && !dropped.length,
          `${line(t)}${leaked.length ? `; planted facts proposed: ${some(leaked)}` : ""}${dropped.length ? `; labelled facts dropped: ${some(dropped)}` : ""}`,
          { ...metrics(t), leaked: leaked.length, dropped: dropped.length });
      },
    },
    {
      id: "fill-model", dimension: "write-quality", source: "synthetic", llm: true, gap: "G321",
      title: "capture precision, routed model: at least 0.9 of what 40 source items propose is a labelled fact",
      run: async (): Promise<Result> => {
        if (!model?.modelConfigFor || !capture?.previewExtraction) return na("no capture extraction at this commit");
        const root = sandbox("synthetic");
        const m = stepModel(model, root, capture.STEP);
        const scores: FillScore[] = [];
        try {
          for (const it of FILL_ITEMS) scores.push(scoreItem(it, await capture.previewExtraction(root, it.text, m, it.kind)));
        } catch (e) {
          const msg = String((e as Error)?.message ?? e);
          if (INFRA.test(msg)) return na(`infra: ${msg.slice(0, 120)}`);
          throw e;
        }
        const t = sum(scores);
        return ok(metrics(t).precision >= 0.9,
          `${label(m)}: ${line(t)}${t.wrong.length ? `; not labelled: ${some(t.wrong, Infinity)}` : ""}${t.misses.length ? `; missed: ${some(t.misses, Infinity)}` : ""}`,
          // The whole lists, not the first four: the next prompt change works from them.
          { ...metrics(t), not_labelled: t.wrong, missed: t.misses });
      },
    },
  ];
}
