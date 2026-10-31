// SPDX-License-Identifier: AGPL-3.0-only
// Agent refusal stats (docs/refusals.md): every MCP tool call and API request an
// agent makes is one line in log/calls.jsonl: when, who, which tool or route, and, when it was
// refused, the refusal's kind. The kind is the refusal text cut to its first words with ids,
// numbers, quoted text, addresses and links taken out, so no note content lands in the log and the
// same refusal reads the same each time. The week report lists, per agent, how often it calls
// each tool, how often it is refused and with what, and the refusals it retries anyway.
import { join } from "node:path";
import { appendJsonl, readJsonl } from "./util";

export interface CallLine { at: string; agent: string; tool: string; refused?: string }

const file = (root: string) => join(root, "log", "calls.jsonl");

export function refusalKind(text: string): string {
  return text
    .replace(/"[^"]*"|`[^`]*`|'[^']*'/g, "…")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+|\b(url|gmail|gcal|imsg|discord|granola|gmail-thread|contacts):\S+/gi, "<ref>")
    .replace(/\S+@\S+/g, "<address>")
    .replace(/\b[\w.-]+\/[\w./#[\]-]+/g, "<id>")
    .replace(/\d+/g, "#")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ").trim()
    .split(" ").slice(0, 8).join(" ")
    .replace(/[:;,.]+$/, "")
    .slice(0, 80) || "refused";
}

export function logCall(root: string, agent: string, tool: string, refusal?: string) {
  const line: CallLine = { at: new Date().toISOString(), agent, tool: tool.slice(0, 60), ...(refusal !== undefined ? { refused: refusalKind(refusal) } : {}) };
  try { appendJsonl(file(root), line); } catch { /* the call itself never fails on its log line */ }
}

// An API route without its ids: /v1/notes/people/jane-roy → GET /v1/notes, /v1/disputes/c-0001/resolve → POST /v1/disputes/resolve.
export function routeName(method: string, path: string): string {
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  const word = (s?: string) => !!s && /^[a-z][a-z0-9_]*$/.test(s);
  // A fixed route keeps its name; one with an id (a note's path, a dispute's number) keeps its resource.
  if (parts.length <= 3 && parts.every(word) && parts[1] !== "notes") return `${method} /${parts.join("/")}`;
  const verb = parts[1] === "disputes" && parts.length >= 4 && word(parts.at(-1)) ? `/${parts.at(-1)}` : "";
  return `${method} /${parts.slice(0, 2).join("/")}${verb}`;
}

export interface AgentCalls { agent: string; calls: number; refused: number; tools: [string, number][]; kinds: [string, number][]; retried: [string, number][] }

const RETRY_MS = 10 * 60_000;
const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);

// Per agent over the days given: calls, refusals, its commonest tools and refusal kinds, and each
// refusal it ran into again on the same tool within ten minutes of being refused.
export function refusalStats(root: string, dates: string[]): AgentCalls[] {
  const days = new Set(dates);
  const lines = readJsonl<CallLine>(file(root)).filter((l) => days.has(String(l.at).slice(0, 10)) && l.agent && l.tool);
  const by = new Map<string, CallLine[]>();
  for (const l of lines) by.set(l.agent, [...(by.get(l.agent) ?? []), l]);
  return [...by].sort((a, b) => a[0].localeCompare(b[0])).map(([agent, ls]) => {
    const tools = new Map<string, number>(), kinds = new Map<string, number>(), retried = new Map<string, number>();
    const last = new Map<string, number>(); // tool + kind → when it was last refused
    for (const l of ls.sort((a, b) => a.at.localeCompare(b.at))) {
      tools.set(l.tool, (tools.get(l.tool) ?? 0) + 1);
      if (l.refused === undefined) continue;
      kinds.set(l.refused, (kinds.get(l.refused) ?? 0) + 1);
      const key = `${l.tool}\u0000${l.refused}`, t = Date.parse(l.at), before = last.get(key);
      if (before !== undefined && t - before <= RETRY_MS) retried.set(`${l.tool}: ${l.refused}`, (retried.get(`${l.tool}: ${l.refused}`) ?? 0) + 1);
      last.set(key, t);
    }
    return { agent, calls: ls.length, refused: ls.filter((l) => l.refused !== undefined).length, tools: top(tools, 5), kinds: top(kinds, 3), retried: top(retried, 5) };
  });
}

export const REFUSED_FLAG = 0.2;

export function refusalLines(stats: AgentCalls[]): string[] {
  if (!stats.length) return [];
  const pctOf = (a: AgentCalls) => Math.round((a.refused / a.calls) * 100);
  const flagged = stats.filter((a) => a.calls > 0 && a.refused / a.calls > REFUSED_FLAG);
  const retries = stats.flatMap((a) => a.retried.map(([k, n]) => `- ${a.agent} retried "${k}" ${n} time${n === 1 ? "" : "s"}`));
  return [
    "## Agent refusals", "",
    "| Agent | Calls | Refused | Top tools | Commonest refusals |", "|---|---|---|---|---|",
    ...stats.map((a) => `| ${a.agent} | ${a.calls} | ${a.refused} (${pctOf(a)}%) | ${a.tools.map(([t, n]) => `${t} ${n}`).join(", ")} | ${a.kinds.map(([k, n]) => `${k} (${n})`).join("; ") || "–"} |`), "",
    ...(flagged.length ? [...flagged.map((a) => `- **${a.agent} is refused ${pctOf(a)}% of the time**; commonest: ${a.kinds[0]?.[0] ?? "–"}. Its instruction or the refusal's text may need work.`), ""] : []),
    ...(retries.length ? ["Refusals retried anyway (the same refusal on the same tool again within 10 minutes):", "", ...retries, ""] : []),
  ];
}

// Agents that read the brain since `since` (ms) with no line in calls.jsonl: every agent read
// comes through a door that logs a call, so a gap means a door skipped the call log. Connects
// (MCP initialize, GET /v1) don't count as reads. `pocketbrain doctor` warns on any.
export function uncalled(root: string, since: number, min = 3): { agent: string; reads: number }[] {
  const after = (e: { at?: string }) => !!e.at && Date.parse(e.at) >= since;
  const called = new Set(readJsonl<CallLine>(file(root)).filter(after).map((c) => c.agent));
  const reads = new Map<string, number>();
  for (const r of readJsonl<{ at?: string; agent?: string; op?: string }>(join(root, "log", "reads.jsonl")))
    if (after(r) && r.agent && r.op !== "connect" && !called.has(r.agent)) reads.set(r.agent, (reads.get(r.agent) ?? 0) + 1);
  return [...reads].filter(([, n]) => n >= min).map(([agent, n]) => ({ agent, reads: n })).sort((a, b) => b.reads - a.reads);
}
