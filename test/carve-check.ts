// SPDX-License-Identifier: AGPL-3.0-only
// The carve property's checker, shared by the test (test/carve-property.test.ts) and the nightly
// run (scripts/slice-proof.ts): one random brain (test/carve-gen.ts), every agent and token, every
// door an assistant reads through, every read it can make there, checked against the leak oracle
// (evals/lib/oracle.ts), which is written from rules/ without the carve code.
//
// The three doors (docs/slice-proof.md):
//   mcp      POST /mcp, tools/call (the OAuth door and the local stdio bridge end in the same calls)
//   api      GET /v1/... with the token in the Authorization header
//   browser  /b: a sign-in form, a session cookie, HTML pages
// A read a door doesn't have is skipped there (the browser door has no why and no who_is).
// What an agent asked for (a read id, a search word, a topic) is taken out of that call's own
// answer before it is checked: echoing it isn't a leak.
// An answer the door refused for the wrong reason (a request budget, a sign-in that didn't take, a
// 500) is never counted as "no leak": it fails the run, so a door that stopped answering can't
// pass as a door that leaks nothing.
import { generate, evolve, type Generated } from "./carve-gen";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { loadBrain } from "../src/brain";
import { mergeNotes } from "../src/merge";
import { handOff } from "../src/handoff";
import { renderTouchedPages } from "../src/wiki";
import { resetBudgets } from "../src/budget";
import { forbiddenFor, carvedFor, leakFinder } from "../evals/lib/oracle";

export const DOORS = ["mcp", "api", "browser"] as const;
export type Door = (typeof DOORS)[number];

export interface Finding { agent: string; role: string; door: Door; tool: string; kind: "value" | "name" | "id" | "date"; what: string; from: string }
export interface Checked { findings: Finding[]; answers: number; pages: number; facts: number; readers: number }

type Ask = { read: "orientation" | "whats_new" | "context_pack" | "memory_check" } | { read: "read"; id: string } | { read: "context_pack"; topic: string }
  | { read: "search"; query: string } | { read: "why"; key: string } | { read: "who_is"; address: string };
const argOf = (a: Ask): string | undefined => "id" in a ? a.id : "topic" in a ? a.topic : "query" in a ? a.query : "key" in a ? a.key : "address" in a ? a.address : undefined;
const SINCE = "1990-01-01";

// Every read the property makes on a brain: the same list for every agent and door.
function asksFor(root: string): { asks: Ask[]; pages: number; facts: number } {
  const notes = loadBrain(root);
  const asks: Ask[] = [{ read: "orientation" }, { read: "whats_new" }, { read: "context_pack" }, { read: "memory_check" }];
  for (const n of notes) asks.push({ read: "read", id: n.fm.id });
  for (const n of notes.slice(0, 4)) asks.push({ read: "context_pack", topic: n.fm.title });
  for (const n of notes.slice(0, 6)) {
    const v = Object.values(n.fm.facts ?? {})[0] as any;
    const word = String(v?.value ?? v?.items?.[0]?.value ?? n.fm.title).split(/[^\p{L}\p{N}]+/u).find((x) => x.length > 3) ?? n.fm.title;
    asks.push({ read: "search", query: word });
  }
  let facts = 0;
  for (const n of notes) for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
    facts++;
    asks.push({ read: "why", key: `${n.fm.id}#${attr}` });
    if (attr === "emails" || attr === "contact") for (const r of ((f as any).items ?? [f]) as { value?: unknown }[]) if (typeof r.value === "string") asks.push({ read: "who_is", address: r.value });
  }
  return { asks, pages: notes.length, facts };
}

// A JSON answer as the strings it carries (keys too), so an escaped quote or line break in the
// wire form can't hide a value from the matcher.
function leaves(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (typeof v === "number") return [String(v)];
  if (Array.isArray(v)) return v.flatMap(leaves);
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => [k, ...leaves(x)]);
  return [];
}
const unescapeHtml = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e]!);
// An HTML page as its text and, decoded, every address it links to (a note's id rides in its link).
function pageText(html: string): string {
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => { const h = unescapeHtml(m[1]); try { return decodeURIComponent(h); } catch { return h; } });
  return `${unescapeHtml(html)}\n${hrefs.join("\n")}`;
}

// A status a door may answer a read with: the read itself, "not in your view" (which a hidden note
// and a missing one share), or a request the door doesn't take in that shape.
const ANSWERED = new Set([200, 400, 404]);
// The reads every agent can always make: anything but the read itself means the door is not answering.
const ALWAYS = new Set<Ask["read"]>(["orientation", "whats_new", "memory_check"]);
const answered = (a: Ask, status: number) => status === 200 || (ANSWERED.has(status) && !(ALWAYS.has(a.read) || (a.read === "context_pack" && !("topic" in a))));

interface Session { get(a: Ask): Promise<string | undefined> }

async function open(root: string, door: Door, token: string, who: string): Promise<Session> {
  const fail = (a: Ask, status: number): never => { throw new Error(`carve check: the ${door} door answered ${status} to ${a.read} for ${who}; a door that doesn't answer proves nothing`); };
  if (door === "mcp") return {
    get: async (a) => {
      const { read, ...args } = a as Ask & Record<string, unknown>;
      const res = await handle(root, new Request("http://pb/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: read, arguments: read === "whats_new" ? { since: SINCE } : args } }) }));
      if (res.status !== 200) fail(a, res.status);
      const j = await res.json().catch(() => undefined) as any;
      const text: string = (j?.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n") || JSON.stringify(j?.error ?? "");
      return text;
    },
  };
  if (door === "api") return {
    get: async (a) => {
      const q = encodeURIComponent;
      const path = a.read === "orientation" ? "/v1/orientation" : a.read === "whats_new" ? `/v1/changes?since=${SINCE}` : a.read === "memory_check" ? "/v1/memory-check"
        : a.read === "context_pack" ? `/v1/context${"topic" in a ? `?topic=${q(a.topic)}` : ""}` : a.read === "read" ? `/v1/notes/${q(a.id)}`
        : a.read === "search" ? `/v1/search?q=${q(a.query)}` : a.read === "why" ? `/v1/why?key=${q(a.key)}` : `/v1/who?address=${q(argOf(a)!)}`;
      const res = await handle(root, new Request(`http://pb${path}`, { headers: { authorization: `Bearer ${token}` } }));
      if (!answered(a, res.status)) fail(a, res.status);
      const body = await res.text();
      if (!(res.headers.get("content-type") ?? "").includes("json")) return body;
      try { return leaves(JSON.parse(body)).join("\n"); } catch { return body; }
    },
  };
  // The browser door: sign in on the form as a vault would, then read pages with the cookie.
  const signIn = await handle(root, new Request("http://pb/b/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ password: token }).toString() }));
  const cookie = signIn.headers.get("set-cookie")?.split(";")[0];
  if (signIn.status !== 303 || !cookie) throw new Error(`carve check: the browser door didn't sign ${who} in (${signIn.status}); a door that doesn't open proves nothing`);
  return {
    get: async (a) => {
      const q = encodeURIComponent;
      if (a.read === "why" || a.read === "who_is") return undefined; // not on this door
      const path = a.read === "orientation" ? "/b/orientation" : a.read === "whats_new" ? `/b/changes?since=${SINCE}` : a.read === "memory_check" ? "/b/memory-check"
        : a.read === "context_pack" ? `/b/context${"topic" in a ? `?topic=${q(a.topic)}` : ""}` : a.read === "read" ? `/b/notes/${q(a.id)}` : `/b/search?q=${q(argOf(a)!)}`;
      const res = await handle(root, new Request(`http://pb${path}`, { headers: { cookie } }));
      if (!answered(a, res.status)) fail(a, res.status);
      return pageText(await res.text());
    },
  };
}

// One brain through the doors: what leaked (nothing, when the carve holds) and what was checked.
export async function check(g: Generated, doors: readonly Door[] = DOORS): Promise<Checked> {
  const findings: Finding[] = [];
  const { asks, pages, facts } = asksFor(g.root);
  let answers = 0, readers = 0;
  for (const a of g.agents) for (const role of a.roles) {
    readers++;
    const token = issueToken(g.root, a.name, role === "reader" ? "reader" : undefined);
    const opts = role === "reader" ? { role: "reader" as const } : {};
    const values = await forbiddenFor(g.root, a.name, opts);
    const { carved, shownDates } = await carvedFor(g.root, a.name, opts);
    const names = carved.flatMap((c) => c.names.map((n) => ({ value: n, from: c.id })));
    const inValues = leakFinder(values), inNames = leakFinder(names);
    const ids = carved.filter((c) => c.whole).map((c) => ({ id: c.id, re: new RegExp(`(^|[^\\w/-])${c.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w-])`) }));
    for (const door of doors) {
      // Each door spends the same per-agent request budget (src/budget.ts); the check reads far
      // faster than an assistant does, so each door starts with a fresh minute.
      resetBudgets();
      const s = await open(g.root, door, token, `${a.name} (${role} token)`);
      for (const ask of asks) {
        let text = await s.get(ask);
        if (text === undefined) continue;
        answers++;
        const arg = argOf(ask);
        // Only the argument as a whole: "notes/x" asked for is not taken out of "notes/x-dup".
        if (arg && arg.length > 2) text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}-])${arg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}-])`, "gu"), " ");
        const tool = `${ask.read}${arg ? ` ${JSON.stringify(arg)}` : ask.read === "whats_new" ? ` since ${SINCE}` : ""}`;
        const add = (kind: Finding["kind"], what: string, from: string) => findings.push({ agent: a.name, role, door, tool, kind, what, from });
        for (const l of inValues(text)) add("value", l.value, l.from);
        for (const l of inNames(text)) add("name", l.value, l.from);
        for (const { id, re } of ids) if (text.includes(id) && re.test(text)) add("id", id, id);
        for (const c of carved) {
          // Only the generator's dates (each used once, 1991-2019) identify a note; a stamp the code
          // writes (a merge's today) is shared by many notes and says nothing.
          for (const d of c.dates) if (/^(199|200|201)\d-/.test(d) && !shownDates.has(d) && text.includes(d)) add("date", d, c.id);
        }
      }
    }
  }
  return { findings, answers, pages, facts, readers };
}

export const report = (g: Generated, f: Finding[]) => `seed ${g.seed} (replay: CARVE_SEED=${g.seed} bun test test/carve-property.test.ts; CARVE_FREEZE=1 to freeze it)${g.ops.length ? `\n  ops: ${g.ops.join("; ")}` : ""}\n` +
  [...new Map(f.map((x) => [`${x.agent}/${x.role} ${x.door} ${x.kind} ${x.what}`, x])).values()].slice(0, 12).map((x) => `  ${x.agent} (${x.role} token) got ${x.kind} "${x.what}" of ${x.from} through ${x.door}, in ${x.tool}`).join("\n");

// The brain a seed makes, with its merges, handoffs and the page writer run over it.
export async function brainOf(seed: number): Promise<Generated> {
  const g = generate(seed);
  await evolve(g, { mergeNotes, handOff, loadBrain, renderTouchedPages });
  return g;
}
