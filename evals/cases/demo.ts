// SPDX-License-Identifier: AGPL-3.0-only
// The demo moment (outside review 2026-10-29, docs/demo-moment.md, G503/G504): ask Claude "what's
// next with Jane", get an answer that cites the brain and is right; tell the box one thing and
// Claude knows it a minute later. Run through the product's own doors: the owner's box is the
// dashboard's POST /say, Claude's read is an MCP tools/call context_pack on the hub's handler.
//
//   bun evals/run.ts --only demo           the round trip and its latency, the Cite lines (free)
//   bun evals/run.ts --llm --only demo     the side by side: the same questions with and without
//                                          the brain, graded on the answer being right and cited
//
// Grading is by fixed words, not a judge: right means the expected words are in the answer (or,
// for a name the brain doesn't hold, that it says so and invents nothing); cited means it says
// the answer came from "your brain" and names the page.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SRC } from "../lib/pb";
import { sandbox, realBrainPath } from "../lib/sandbox";
import { llm, AGENT_MODEL } from "../lib/llm";
import { ok, na, type Case } from "../lib/case";

const has = (f: string) => existsSync(join(SRC, f));
const server = has("server.ts") ? await import(join(SRC, "server.ts")) : undefined;
const auth = has("auth.ts") ? await import(join(SRC, "auth.ts")) : undefined;
const dash = has("dashboard/server.ts") ? await import(join(SRC, "dashboard/server.ts")) : undefined;
const cell = has("cell.ts") ? await import(join(SRC, "cell.ts")) : undefined;

// Said on Jane Roy's page (the synthetic brain also holds a J. Roy whose alias is Jane Roy, so the
// home box would ask which one; on her page it's hers).
export const TOLD = { q: "Her next step is send the syllabus by Friday", page: "people/jane-roy" };

// One synthetic brain with the hub's two doors on it: the owner's box and an agent's MCP read.
export async function doors(root: string, agent = "claude") {
  const tok = auth.issueToken(root, agent);
  const ask = async (topic: string): Promise<string> => {
    const r = await server.handle(root, new Request("http://pb/mcp", { method: "POST", headers: { authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "context_pack", arguments: { topic } } }) }));
    return ((await r.json()) as { result: { content: { text: string }[] } }).result.content[0].text;
  };
  const H = "127.0.0.1:8794", key = "k".repeat(32);
  const d = dash.dashboardHandler(root, { port: 8794, loginKey: key });
  const cookie = (await d.handle(new Request(`http://${H}/login?key=${key}`, { headers: { host: H } }))).headers.get("set-cookie").split(";")[0];
  const hdr = { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/home` };
  const tell = async (t: { q: string; page?: string }): Promise<string> => {
    const csrf = (await (await d.handle(new Request(`http://${H}/home`, { headers: hdr }))).text()).match(/name="csrf" value="([^"]+)"/)![1];
    return (await d.handle(new Request(`http://${H}/say`, { method: "POST", headers: { ...hdr, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, ...t }) }))).text();
  };
  return { ask, tell };
}

// Told on the box, then read over MCP until it shows: milliseconds from the tell to the first read
// that has it, with cells on as the hub serves them.
export async function roundTrip(root: string): Promise<{ ms: number; known: string; noted: boolean }> {
  cell.useCells(true);
  try {
    const { ask, tell } = await doors(root);
    await ask("what's next with Jane");
    const t0 = performance.now();
    const noted = (await tell(TOLD)).includes("Noted");
    let known = "";
    while (performance.now() - t0 < 60_000 && !known.includes("send the syllabus")) known = await ask("what's next with Jane");
    return { ms: Math.round(performance.now() - t0), known, noted };
  } finally { cell.useCells(false); }
}

// The demo on any brain: ask about someone, tell the box something new about them, ask again until
// the answer has it, and ask about a name the brain doesn't hold. Counts, yes/no and milliseconds
// only, never a value, so it can run on a copy of the owner's real brain and be reported anywhere.
export async function measure(root: string, o: { ask: string; tell: { q: string; page?: string }; absent: string; agent?: string }) {
  cell.useCells(true);
  try {
    const { ask, tell } = await doors(root, o.agent ?? "claude");
    const cites = (t: string) => t.split("\n").filter((l) => l.startsWith("Cite as: "));
    const told = (o.tell.q.match(/\bis\s+(.+?)\.?$/i)?.[1] ?? o.tell.q).trim(); // what follows "is"
    const before = await ask(o.ask);
    const t0 = performance.now();
    const noted = (await tell(o.tell)).includes("Noted");
    let after = "";
    while (noted && performance.now() - t0 < 60_000 && !after.includes(told)) after = await ask(o.ask);
    const ms = Math.round(performance.now() - t0);
    const none = await ask(`what's next with ${o.absent}`);
    const out = {
      notes_before: cites(before).length, cited_before: cites(before).length > 0 && !/gmail:|gcal:/.test(cites(before).join("")),
      noted, known: after.includes(told), tell_to_known_ms: noted ? ms : null,
      cited_as_your_note: cites(after).some((l) => /Your note \d{4}-\d{2}-\d{2}/.test(l)),
      absent_said: none.includes(`No note about "${o.absent}"`), absent_notes: (none.match(/^### /gm) ?? []).length,
    };
    return { out, pass: out.known && out.cited_as_your_note && out.absent_said && ms < 60_000, cites: [...cites(before), "--- after ---", ...cites(after)] };
  } finally { cell.useCells(false); }
}

const SYSTEM = "You are Claude, Robin's assistant. Answer Robin's question in at most three sentences. Don't invent facts about Robin's life or people.";
const WITH = (pack: string) => `${SYSTEM}\nYou called Robin's pocketBrain (the context_pack tool) for this question; its answer is below. Use it, and say where an answer came from.\n\n<tool_result name="context_pack">\n${pack}\n</tool_result>`;
const NOT_HELD = /not in (?:your|my) brain|no note|isn't in|is not in|don't have|do not have|nothing (?:about|on)|not (?:find|found)|no (?:record|information)/i;

// The questions, after TOLD went through the box. right: the answer is correct; page: what a
// citation must name (none for a name the brain doesn't hold).
export const QUESTIONS: { q: string; right: (a: string) => boolean; page?: string }[] = [
  { q: "What's next with Jane?", right: (a) => /syllabus/i.test(a) && /friday/i.test(a), page: "Jane Roy" },
  { q: "What is Jane's role?", right: (a) => /course coordinator/i.test(a), page: "Jane Roy" },
  { q: "What's the next step for Course A?", right: (a) => /grade/i.test(a) && /midterm/i.test(a), page: "Course A" },
  { q: "What's next with Zoe?", right: (a) => NOT_HELD.test(a) && !/midterm|syllabus/i.test(a) },
];
// Cited: the answer says it came from the brain ("from your brain", "her pocketBrain page") and
// names the page.
const cited = (a: string, page?: string) => !page || (/\b(?:your|the|her|his|its) (?:pocket)?brain\b|pocketbrain/i.test(a) && a.toLowerCase().includes(page.toLowerCase()));

export function demoCases(): Case[] {
  if (!server?.handle || !auth?.issueToken || !dash?.dashboardHandler || !cell?.useCells) return [];
  return [
    {
      id: "demo-round-trip", dimension: "e2e", kind: "benign", source: "synthetic",
      title: "told on the owner's box, known over MCP in under a minute, cited as the owner's note (G504)",
      run: async () => {
        const r = await roundTrip(sandbox("synthetic"));
        const cite = /Cite as: \(from your brain: Jane Roy; next_step: Your note \d{4}/.test(r.known);
        return ok(r.noted && r.known.includes("send the syllabus by Friday") && cite && r.ms < 60_000, `noted ${r.noted}, known after ${r.ms} ms, cited as your note ${cite}`, { tell_to_known_ms: r.ms });
      },
    },
    {
      id: "demo-name-not-held", dimension: "retrieval", kind: "benign", source: "synthetic",
      title: "a name the view doesn't hold is said, and no note that only shares another word comes back (G503)",
      run: async () => {
        const { ask } = await doors(sandbox("synthetic"));
        const zoe = await ask("what's next with Zoe"), jane = await ask("what's next with Jane");
        const heads = [...jane.matchAll(/^### (.+) `/gm)].map((m) => m[1]);
        return ok(zoe.includes('No note about "Zoe"') && !zoe.includes("### ") && heads[0] === "Jane Roy", `Zoe: ${zoe.includes("No note about") ? "said not held" : "not said"}, ${(zoe.match(/^### /gm) ?? []).length} notes; Jane: ${heads.join(", ")}`);
      },
    },
    {
      // On a copy of the real brain ($PB_BRAIN): EVAL_DEMO_ASK ("what's next with <name>"),
      // EVAL_DEMO_TELL ("<Full Name>'s next step is <something new>"), EVAL_DEMO_ABSENT (a name it lacks).
      id: "demo-moment-real", dimension: "e2e", kind: "benign", source: "real",
      title: "real brain copy: told on the box, known over MCP in under a minute, cited; an absent name is said",
      run: async () => {
        const ask = process.env.EVAL_DEMO_ASK, said = process.env.EVAL_DEMO_TELL;
        if (!realBrainPath() || !ask || !said) return na("set PB_BRAIN, EVAL_DEMO_ASK and EVAL_DEMO_TELL");
        const r = await measure(sandbox("real"), { ask, tell: { q: said }, absent: process.env.EVAL_DEMO_ABSENT ?? "Zoe" });
        return ok(r.pass, JSON.stringify(r.out), r.out.tell_to_known_ms === null ? undefined : { tell_to_known_ms: r.out.tell_to_known_ms });
      },
    },
    {
      id: "demo-side-by-side", dimension: "retrieval", kind: "benign", source: "synthetic", llm: true,
      title: "the same questions with and without the brain: with it, right and cited; without it, not",
      run: async () => {
        const root = sandbox("synthetic");
        const { ask, tell } = await doors(root);
        if (!(await tell(TOLD)).includes("Noted")) return ok(false, "the box didn't note the told fact");
        let withRight = 0, withCited = 0, without = 0, citable = 0;
        const misses: string[] = [];
        for (const x of QUESTIONS) {
          const pack = await ask(x.q);
          let a: string, b: string;
          try { [a, b] = await Promise.all([llm(WITH(pack), x.q), llm(SYSTEM, x.q)]); } catch (e) { return na(`infra: ${String((e as Error)?.message ?? e).slice(0, 120)}`); }
          if (x.right(a)) withRight++; else misses.push(`with "${x.q}": ${a.slice(0, 80)}`);
          if (x.page) { citable++; if (cited(a, x.page)) withCited++; else misses.push(`uncited "${x.q}": ${a.slice(0, 80)}`); }
          if (x.right(b) && x.page) without++; // a no-brain "I don't know Zoe" is right by luck, not counted
        }
        const n = QUESTIONS.length;
        return ok(withRight === n && withCited === citable && without < withRight, `${AGENT_MODEL}: with the brain ${withRight}/${n} right, ${withCited}/${citable} cited; without ${without}/${citable} right${misses.length ? `; ${misses.join("; ")}` : ""}`, { with_right: withRight, with_cited: withCited, without_right: without, asked: n });
      },
    },
  ];
}
