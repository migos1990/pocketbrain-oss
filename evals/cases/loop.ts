// SPDX-License-Identifier: AGPL-3.0-only
// Prove the loop (docs/prove-the-loop.md): one assistant learns a fact, the brain keeps it with its
// source, and another assistant on another door reads it back right. Town writes over MCP,
// the owner accepts it (the work area is Planner's), Instinct reads it over the browser door.
// Then the golden set: the owner's weekly questions, each answered from the brain by an agent's
// context pack. These sample questions stand in for the owner's own five on the synthetic brain.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPB, SRC } from "../lib/pb";
import YAML from "yaml";
import { realBrainPath, sandbox, TODAY } from "../lib/sandbox";
import { ok, na, type Case, type Result } from "../lib/case";

const pb = await loadPB();
const server = existsSync(join(SRC, "server.ts")) ? await import(join(SRC, "server.ts")) : undefined;
const auth = existsSync(join(SRC, "auth.ts")) ? await import(join(SRC, "auth.ts")) : undefined;
const core = existsSync(join(SRC, "core.ts")) ? await import(join(SRC, "core.ts")) : undefined;

// Two assistants set up like the owner's: Town on MCP, Instinct on the browser door only.
const AGENTS = "  town: { tier: core, transport: mcp, aliases: [Town], slices: [area:work, contacts-basic], exclude_types: [money] }\n" +
  "  instinct: { tier: trial, browser: true, aliases: [Instinct], slices: [area:work, contacts-basic], exclude_types: [money] }\n";
const withAgents = (r: string) => { const p = join(r, "rules", "policy.yaml"); writeFileSync(p, readFileSync(p, "utf8").replace(/^agents:\n/m, `agents:\n${AGENTS}`)); };

// The golden set: a weekly question, the topic an agent would ask the brain, and what a right
// answer must say. Each must come back in the agent's context pack for that topic.
export const GOLDEN: { q: string; topic: string; note: string; answer: RegExp }[] = [
  { q: "What's next on my TECH 101 course?", topic: "TECH 101 next step", note: "projects/course-a", answer: /Grade the midterm by Oct 14/ },
  { q: "When and where is session 6?", topic: "session 6", note: "decisions/2026-09-28-session-6-moved", answer: /Sunday Oct 11 12:00-15:00/ },
  { q: "Who is the course coordinator?", topic: "course coordinator", note: "people/jane-roy", answer: /Jane Roy/ },
  { q: "What do I owe Jane for TECH 202?", topic: "TECH 202", note: "projects/course-b", answer: /Send the syllabus draft to Jane/ },
  { q: "Which room is TECH 101 in?", topic: "TECH 101 room", note: "projects/course-a", answer: /Hall B210/ },
];

// The owner's own golden set lives in the brain, never in this repository: evals/weekly.yaml in
// the brain at PB_BRAIN (or PB_GOLDEN), scored by src/golden.ts. Cases run on a copy of the brain and
// report no question, answer or value.
const golden = existsSync(join(SRC, "golden.ts")) ? await import(join(SRC, "golden.ts")) : undefined;
export function ownerGolden(): { id: string; as: string[] }[] | undefined {
  const brain = realBrainPath();
  const f = golden && [process.env.PB_GOLDEN, brain && join(brain, "evals", "weekly.yaml")].find((x): x is string => !!x && existsSync(x));
  return f ? golden.loadGolden(f) : undefined;
}

const steps = (xs: [string, boolean][]): Result => {
  const failed = xs.filter(([, p]) => !p).map(([s]) => s);
  return ok(!failed.length, failed.length ? `failed: ${failed.join("; ")}` : `${xs.length} steps held`);
};

async function live<T>(fn: (l: { root: string; url: string; tok: Record<string, string> }) => Promise<T>): Promise<T> {
  const root = sandbox("synthetic", withAgents);
  const srv = server.serve(root, 0);
  try { return await fn({ root, url: `http://127.0.0.1:${srv.port}`, tok: { town: auth.issueToken(root, "town"), instinct: auth.issueToken(root, "instinct") } }); }
  finally { srv.stop(true); }
}
const tool = async (url: string, token: string, name: string, args: Record<string, unknown>) => {
  const r = await fetch(url + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const text: string = (await r.json())?.result?.content?.[0]?.text ?? "";
  let json: any; try { json = JSON.parse(text); } catch {}
  return { text, json };
};
// The browser door as Instinct uses it: its vault fills the sign-in form, then it reads pages.
async function browser(url: string, agent: string, token: string) {
  const r = await fetch(url + "/b/login", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ agent, password: token }).toString() });
  const cookie = r.headers.get("set-cookie")?.split(";")[0] ?? "";
  return async (path: string) => (await fetch(url + path, { headers: { cookie } })).text();
}

export const loopCases: Case[] = [
  { id: "e2e-loop-town-writes-instinct-reads", dimension: "e2e", kind: "benign", title: "Town learns a room change from an email and writes it with its source; Robin accepts; Instinct, on the browser door, reads the new room back with the source", source: "prove the loop, 2026-10-22", run: () => {
    if (!server || !auth || !pb.write?.decideProposal) return na("no live server or inbox at this commit");
    return live(async ({ root, url, tok }) => {
      const room = "Hall C305 from session 7";
      const w = await tool(url, tok.town, "remember", { id: "projects/course-a", attribute: "room", value: room, as_of: TODAY, sources: ["gmail:f000000000000011"], verification: "verified-by-source" });
      // Over Robin's own word the new room is a conflict for Robin (since G422; before, a proposal):
      // either way Robin's answer settles it.
      const accepted = w.json?.file ? pb.write.decideProposal(root, w.json.file, "accept", "louis") : undefined;
      const disp = w.json?.outcome === "disputed" ? /\((c-[^)\s]+)\)/.exec(String(w.json?.message ?? w.text ?? ""))?.[1] : undefined;
      const settled = disp ? (await import("../../src/dashboard/actions")).runAction({ root }, "dispute-decide", { id: disp, choice: "2" }) : "";
      const read = await browser(url, "instinct", tok.instinct);
      const changes = await read("/b/changes?since=2000-01-01T00:00:00Z");
      const note = await read("/b/notes/projects/course-a");
      const ctx = await read(`/b/context?topic=${encodeURIComponent("TECH 101 room")}`);
      const townSees = (await tool(url, tok.town, "read", { id: "projects/course-a" })).text;
      return steps([
        [`Town's write goes to Robin (${w.json?.outcome})`, w.json?.outcome === "inbox" || w.json?.outcome === "committed" || w.json?.outcome === "disputed"],
        ["Robin's accept commits it", w.json?.outcome === "committed" || accepted?.outcome === "committed" || /settled/.test(settled)],
        ["Instinct's change list shows it", changes.includes("Hall C305")],
        ["Instinct's note shows the new room", note.includes(room)],
        ["with the email it came from", note.includes("gmail:f000000000000011")],
        ["Instinct's context for the question answers it", ctx.includes(room)],
        ["the current room is the new one, not Hall B210", /\*\*room\*\* \[current\]: Hall C305/.test(note) && !/\*\*room\*\* \[current\]: Hall B210/.test(note)],
        ["Town reads the same value back", townSees.includes(room)],
      ]);
    });
  } },
  ...GOLDEN.map((g, i): Case => ({ id: `e2e-loop-golden-${i + 1}`, dimension: "retrieval", kind: "benign", title: `Golden weekly question ${i + 1}: "${g.q}" is answered from Town's context pack`, source: "prove the loop, 2026-10-22", run: () => {
    if (!core?.contextPack) return na("no context pack at this commit");
    const root = sandbox("synthetic", withAgents);
    const pack = String(core.contextPack(root, "town", g.topic));
    return steps([[`${g.note} in the pack`, pack.includes(g.note)], ["the answer is in it", g.answer.test(pack)]]);
  } })),
  // The owner's five: each listed assistant finds the note in its top 5 for the question as asked,
  // and the note shows the answer, fresh. Not run without a real brain and its golden file.
  ...(ownerGolden() ?? []).map((g): Case => ({ id: `e2e-loop-golden-owner-${g.id}`, dimension: "retrieval", kind: "benign", title: `The owner's golden question ${g.id} is found and answered fresh by ${g.as.join(", ")}`, source: "real", run: () => {
    const root = sandbox("real");
    const q = golden.loadGolden(process.env.PB_GOLDEN ?? join(root, "evals", "weekly.yaml")).find((x: { id: string }) => x.id === g.id);
    if (!q) return na("the question left the golden set");
    return steps(q.as.map((a: string): [string, boolean] => { const r = golden.askOne(root, q, a); return [`${a}: ${r.rank ? `rank ${r.rank}, ` : ""}${r.why}`, r.grade !== "fail"]; }));
  } })),
  // A plan whose date has passed is served stale, never current: the agent is told to recheck it,
  // and the golden set counts it as a wrong answer.
  { id: "e2e-loop-stale-plan-not-current", dimension: "retrieval", kind: "benign", title: "A next step whose date has passed reaches the agent marked stale, not current, and fails the golden check", source: "prove the loop, 2026-10-22", run: () => {
    if (!core?.contextPack || !golden) return na("no golden runner at this commit");
    const root = sandbox("synthetic", (r) => {
      withAgents(r);
      const f = join(r, "projects", "course-a.md");
      writeFileSync(f, readFileSync(f, "utf8").replace(/next_step: \{ value: [^,]+, as_of: [\d-]+/, "next_step: { value: Grade the midterm by Oct 5, as_of: 2026-10-06"));
    });
    const pack = String(core.contextPack(root, "town", "TECH 101 next step"));
    const row = golden.askOne(root, { id: "s1", as: ["town"], q: "What's next on my TECH 101 course?", want: ["projects/course-a"], expect: "next_step" }, "town");
    return steps([
      ["the step is in Town's pack", pack.includes("Grade the midterm by Oct 5")],
      ["marked stale, not current", /\*\*next_step\*\* \[stale\]: Grade the midterm by Oct 5/.test(pack)],
      ["the golden check fails it as stale", row.grade === "fail" && row.freshness === "stale"],
    ]);
  } },
];
