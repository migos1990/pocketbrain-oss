// SPDX-License-Identifier: AGPL-3.0-only
// The waiting session (onboarding protocol step 1, docs/add-an-agent.md): the owner's own sign-in
// on the OAuth door that no agent is bound to yet. It can say who it is, what it's for and which
// slices it would like with request_access, and nothing else: no brain data, no other tool. The
// request is a suggestion the dashboard shows the owner, escaped; Approve there creates a trial
// agent (src/addagent.ts). The request itself grants nothing.
import { loadRules, type Rules } from "./rules";
import { setPendingRequest, type AccessRequest, type OAuthConfig } from "./oauth";
import { AGENT_NAME, RESERVED, lookalike, lookalikeBase } from "./addagent";
import { isOwnerId } from "./owner";
import { readCapped } from "./util";

const MAX_BODY = 16_000;

const TOOL = {
  name: "request_access",
  description: "Ask the owner of this brain to let you in. Say what to call you, what you will use the brain for, and which slices you would like. The owner reviews it on their dashboard and decides; until then nothing in the brain is readable. Call it once; calling again replaces your request.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "What to call you, e.g. Hark" },
      purpose: { type: "string", description: "One or two sentences: what you will do with the brain" },
      slices: { type: "array", items: { type: "string" }, description: "Slices you would like (the owner may give fewer)" },
    },
    required: ["name", "purpose", "slices"],
  },
};

// Control characters become spaces; invisible format characters (bidi overrides, zero-width) are
// dropped, so the owner's card shows the text as it reads (G162). So are the letters that draw as
// blank space (Hangul fillers, the blank Braille cell, the combining grapheme joiner), and a pile
// of combining marks is cut to two, so nothing on the card is padded or smeared (G167).
// Characters that draw as blank space (G167); the Khitan filler and the null notehead from the act door re-audit (S1, S2).
export const FILLERS = /[\u115f\u1160\u3164\uffa0\u2800\u034f\u{16FE4}\u{1D159}]/gu;
const clean = (v: unknown, max: number) => String(v ?? "").replace(/\p{Cf}/gu, "").replace(FILLERS, "").replace(/(\p{M}{2})\p{M}+/gu, "$1").replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);

// The request as the owner will see it, or why it can't be filed. The slice names it gave are kept
// whether or not they exist (never "all"), so nothing stored or answered depends on the rules; the
// dashboard pre-checks only the requestable ones. The agent id is a valid new name not taken (one
// already asked for gets -2, -3, ..., chosen here and never told to the assistant); a name that is
// or reads as the owner or an existing agent gets assistant-N. The label is always the id.
function shapeRequest(root: string, args: Record<string, unknown>): AccessRequest | string {
  const rules = loadRules(root);
  const name = clean(args.name, 60);
  const purpose = clean(args.purpose, 300);
  const asName = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 28);
  if (!AGENT_NAME.test(asName)) return "give a name of at least two letters, e.g. Hark";
  // A name that reads as the owner or another assistant gets a plain id instead (G70).
  // So does an existing agent's own id, or one with a number after it ("planner2", "steward-1"):
  // the push would show helper-2 alone, a near-copy of helper (G167).
  const stem = asName.replace(/-?\d+$/, "");
  const base = rules.policy.agents[asName] || rules.policy.agents[stem] || lookalike(rules, name) || lookalike(rules, asName) || lookalike(rules, stem) || isOwnerId(asName, rules.policy.owner?.name) ? "assistant" : asName;
  if (!purpose) return "say in a sentence what you will use the brain for";
  const taken = (a: string) => !!rules.policy.agents[a] || RESERVED.has(a) || isOwnerId(a, rules.policy.owner?.name) || !!lookalike(rules, a);
  // An existing id whose -N still reads as a hub role ("gardener-2") falls back to assistant-N.
  let agent = "";
  for (const b of [base, "assistant"]) {
    agent = b;
    for (let i = 2; taken(agent) && i < 100; i++) agent = `${b}-${i}`;
    if (!taken(agent)) break;
  }
  if (taken(agent)) return "give another name";
  const asked = Array.isArray(args.slices) ? args.slices.map((x) => clean(x, 60)) : [];
  const slices = [...new Set(asked.filter((x) => x && x !== "all"))].slice(0, 20);
  // The label is always the id: request text can mimic a name in ways no check catches (G70).
  return { agent, name: agent, said: name, purpose, slices, at: new Date().toISOString() };
}

// An agent the owner paused, set read-only or revoked that this request looks like: the same base
// name (helper for helper-2), or a name that reads as its id, label or alias, look-alike letters and
// a trailing number or version included (G177). The card and oauth status say so, and the card
// offers no one-click review (G72, backlog 209).
export function comingBack(rules: Rules, c: OAuthConfig | undefined, rq: AccessRequest): { agent: string; status: "paused" | "read-only" | "revoked"; on?: string } | undefined {
  for (const k of [rq.agent.replace(/-\d+$/, ""), lookalikeBase(rules, rq.agent), lookalikeBase(rules, rq.said ?? rq.name)]) {
    if (!k) continue;
    const st = rules.policy.agents[k]?.status;
    if (st === "paused" || st === "read-only") return { agent: k, status: st };
    if (c?.revoked_agents?.[k]) return { agent: k, status: "revoked", on: c.revoked_agents[k] };
  }
  return undefined;
}

// The owner's words for it, after "You " on the card and "you " in oauth status.
export const comingBackText = (b: { agent: string; status: string; on?: string }) =>
  `${b.status === "paused" ? "paused" : b.status === "read-only" ? "set read-only" : "revoked"} ${b.agent}${b.on ? ` on ${b.on}` : ""}; this looks like it coming back`;

const SENT = "Sent to the owner. Nothing is readable until the owner approves; reconnect later to find out.";

const WAITING = (slices: string[]) => [
  "This connection is waiting for the owner of this brain to approve it. Nothing in the brain is readable yet.",
  "Call request_access once with a short name for yourself, what you will use the brain for, and the slices you would like.",
  `Areas you can ask for: ${slices.join(", ") || "none listed"}; the owner may offer others. The owner sees your request on their dashboard and decides; reconnect later to find out.`,
].join("\n");

export async function waitingMcp(root: string, clientId: string, req: Request): Promise<Response> {
  // Read at most MAX_BODY; anything that isn't one JSON-RPC object is answered "method not found".
  // Counted as it streams: a chunked body with no length stops at the cap too.
  const text = await readCapped(req, MAX_BODY) ?? "";
  let msg: { id?: unknown; method?: string; params?: Record<string, unknown> } = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) msg = parsed as typeof msg;
  } catch { /* answered below */ }
  const json = (body: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, ...body as object }), { headers: { "content-type": "application/json" } });
  const reply = (result: unknown) => json({ result });
  const toolText = (t: string, isError: boolean) => reply({ content: [{ type: "text", text: t }], isError });
  if (msg.id === undefined && msg.method) return new Response(null, { status: 202 }); // notifications
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: String(msg.params?.protocolVersion ?? "2025-06-18"),
        capabilities: { tools: {} },
        serverInfo: { name: "pocketbrain", version: "0.1.0" },
        // Area slices only: the owner's own named slices can name people or topics.
        instructions: WAITING(Object.keys(loadRules(root).slices).filter((x) => x.startsWith("area:")).sort()),
      });
    case "ping": return reply({});
    case "tools/list": return reply({ tools: [TOOL] });
    case "tools/call": {
      if (msg.params?.name !== TOOL.name) return toolText("This connection is waiting for the owner's approval; the only tool until then is request_access.", true);
      const r = shapeRequest(root, (msg.params?.arguments ?? {}) as Record<string, unknown>);
      if (typeof r === "string") return toolText(r, true);
      if (!setPendingRequest(root, clientId, r)) return toolText("The owner's list of waiting sign-ins is full or this one lapsed; try again later.", true);
      // One answer whatever was asked: echoing the name or slices back would tell a waiting
      // assistant which slices, agents and owner names exist.
      return toolText(SENT, false);
    }
  }
  return json({ error: { code: -32601, message: "this connection is waiting for the owner's approval" } });
}
