// SPDX-License-Identifier: AGPL-3.0-only
// A second, deliberately small implementation of the Memory Passport HTTP door
// (docs/spec/memory-passport.md), in memory, from conformance/fixture.json. It shares no code with
// pocketBrain, so the conformance suite passing against both says the spec, not one codebase,
// defines the behaviour. Not for real use: no persistence, no OAuth, no owner inbox.
//   bun conformance/reference-server.ts [port]   prints one token per agent
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Fact { value: string; as_of: string; sources: string[] }
interface Note { id: string; type: string; title: string; area: string; aliases?: string[]; facts: Record<string, Fact>; body: string }
interface AgentDef { name: string; sees: "all" | string[]; hidden_attributes?: Record<string, string[]>; writes: "direct" | "propose" }
interface Data { owner: string; today: string; notes: Note[]; agents: Record<string, AgentDef> }
interface Handoff { id: string; from: string; to: string; at: string; task: string; next_step: string; delivered: boolean; done?: boolean }
// A credential: an approved agent's (all routes, or only the owner's routes for a resolver), or a
// sign-in the owner hasn't approved yet (nothing).
interface Cred { hash: Buffer; agent?: AgentDef; role?: "resolver"; at: number[] }
interface Opts { perMinute?: number }

const hash = (s: string) => createHash("sha256").update(s).digest();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json" } });
const SOURCE = /^[a-z][a-z0-9-]*:\S+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// The request budget: at most perMinute requests per credential in any 60 seconds (default 300).
export function referenceServer(data: Data, opts: Opts = {}) {
  const notes = new Map(data.notes.map((n) => [n.id, structuredClone(n)]));
  const tokens: Cred[] = [];
  const inbox: unknown[] = [];
  const handoffs: Handoff[] = [];
  const perMinute = opts.perMinute ?? 300;
  const mint = (c: Omit<Cred, "hash" | "at">) => { const t = `mp_${randomBytes(24).toString("hex")}`; tokens.push({ ...c, hash: hash(t), at: [] }); return t; };
  // role: an agent in the fixture; "resolver" gives the full agent's route-limited credential.
  const issue = (role: string, as?: "resolver") => mint({ agent: data.agents[role], ...(as ? { role: as } : {}) });
  const issueWaiting = () => mint({});

  const cred = (req: Request) => {
    const t = req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
    if (!t) return undefined;
    const h = hash(t);
    return tokens.find((x) => timingSafeEqual(x.hash, h));
  };
  const sees = (a: AgentDef, id: string) => a.sees === "all" || a.sees.includes(id);
  const hiddenAttr = (a: AgentDef, id: string, attr: string) => !!a.hidden_attributes?.[id]?.includes(attr);
  // Every value the agent may not see, longest first, so text that quotes one is withheld too.
  const hiddenValues = (a: AgentDef) => [...notes.values()].flatMap((n) => Object.entries(n.facts).filter(([k]) => !sees(a, n.id) || hiddenAttr(a, n.id, k)).map(([, f]) => f.value))
    .filter((v) => !visibleValues(a).has(v)).sort((x, y) => y.length - x.length);
  const visibleValues = (a: AgentDef) => new Set([...notes.values()].filter((n) => sees(a, n.id)).flatMap((n) => Object.entries(n.facts).filter(([k]) => !hiddenAttr(a, n.id, k)).map(([, f]) => f.value)));
  const scrub = (a: AgentDef, text: string) => {
    let out = text;
    // In any case: "MAPLE trust bank" names the same hidden value (G530).
    for (const v of hiddenValues(a)) out = out.replace(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[withheld]");
    return out.replace(/\[\[([^\]]+)\]\]/g, (m, id) => (sees(a, id) ? m : "[withheld]"));
  };
  const view = (a: AgentDef, n: Note) => ({
    // A visible note's title and aliases are text too: a hidden value in them is withheld (G530).
    id: n.id, title: scrub(a, n.title), type: n.type, area: n.area, aliases: (n.aliases ?? []).map((x) => scrub(a, x)),
    facts: Object.fromEntries(Object.entries(n.facts).filter(([k]) => !hiddenAttr(a, n.id, k))),
    body: scrub(a, n.body),
  });
  const missing = (id: string) => json({ error: `no note ${id} in your view` }, 404);
  const agentNamed = (name: string) => Object.values(data.agents).find((a) => a.name === name);

  // The sender's answer is the same whether the handoff is delivered or held: a held one carries
  // a value its recipient may not see, and only the owner may release it.
  function handOff(a: AgentDef, b: Record<string, unknown>) {
    const to = agentNamed(String(b.to ?? ""));
    if (!to || to === a) return json({ error: "to must name another agent" }, 400);
    if (typeof b.task !== "string" || !b.task.trim() || typeof b.next_step !== "string" || !b.next_step.trim()) return json({ error: "task and next_step are required" }, 400);
    const text = `${b.task}\n${b.next_step}`;
    const id = `ho-${randomBytes(6).toString("hex")}`;
    handoffs.push({ id, from: a.name, to: to.name, at: new Date().toISOString(), task: b.task, next_step: b.next_step, delivered: !hiddenValues(to).some((v) => text.includes(v)) });
    return json({ id, reply: `Handed off (id ${id}). The recipient sees it when it next checks what's new; ${data.owner} may look at it first.` });
  }
  const changes = (a: AgentDef) => ({ handoffs: handoffs.filter((h) => h.to === a.name && h.delivered && !h.done).map((h) => ({ id: h.id, from: "an assistant", at: h.at, task: h.task, next_step: h.next_step })) });

  function orientation(a: AgentDef) {
    const mine = [...notes.values()].filter((n) => sees(a, n.id));
    const areas = [...new Set(mine.map((n) => n.area))].sort();
    return [
      `# You are ${a.name}, connected to ${data.owner}'s memory`,
      "",
      `You see ${mine.length} notes, in these areas: ${areas.join(", ")}. Anything else is withheld, and a withheld note answers exactly like one that doesn't exist.`,
      "`[withheld]` in a text marks something you may not see. It is final: don't guess it or look for it elsewhere.",
      `Every write needs a source (scheme:id, e.g. gmail:<id>) and an as_of date. ${a.writes === "direct" ? "Your writes are committed." : `Your writes wait for ${data.owner}'s approval.`}`,
      "",
    ].join("\n");
  }

  function search(a: AgentDef, q: string) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return [...notes.values()].filter((n) => sees(a, n.id)).map((n) => view(a, n))
      .filter((v) => { const hay = [v.title, ...v.aliases, ...Object.values(v.facts).map((f) => f.value), v.body].join(" ").toLowerCase(); return words.length > 0 && words.every((w) => hay.includes(w)); })
      .map((v) => ({ id: v.id, title: v.title, type: v.type, area: v.area }));
  }

  function remember(a: AgentDef, b: Record<string, unknown>) {
    const refuse = (message: string) => json({ outcome: "refused", message }, 422);
    const id = String(b.id ?? ""), attribute = String(b.attribute ?? "");
    const sources = Array.isArray(b.sources) ? b.sources.map(String) : [];
    if (!sources.length || !sources.every((s) => SOURCE.test(s))) return refuse("every write needs sources: [\"scheme:id\"]");
    if (typeof b.as_of !== "string" || !DATE.test(b.as_of) || b.as_of > data.today) return refuse("as_of must be a date, today at the latest");
    if (!/^[a-z][a-z0-9_]*$/.test(attribute) || typeof b.value !== "string" || !b.value) return refuse("attribute and value are required");
    const n = notes.get(id);
    if (!n || !sees(a, id)) return refuse(`no note ${id}`);
    // A hidden attribute takes the same path as a new one: nothing in the answer tells them apart,
    // and it never replaces the hidden fact: a direct writer's write goes to the owner (G530).
    if (a.writes === "propose" || hiddenAttr(a, id, attribute)) {
      inbox.push({ by: a.name, id, attribute, value: b.value, as_of: b.as_of, sources });
      if (a.writes !== "propose") return json({ outcome: "committed", message: `${id}#${attribute} recorded` });
      return json({ outcome: "inbox", message: `held for ${data.owner}'s approval` });
    }
    n.facts[attribute] = { value: b.value, as_of: b.as_of, sources };
    return json({ outcome: "committed", message: `${id}#${attribute} recorded` });
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/.well-known/memory-passport" && req.method === "GET")
      return json({ memory_passport: "0.2", doors: { api: { url: `${url.origin}/v1`, auth: "bearer" } }, orientation: `${url.origin}/v1/orientation` });
    if (!url.pathname.startsWith("/v1/")) return json({ error: "not found" }, 404);
    const c = cred(req);
    // A waiting sign-in answers exactly like an unknown credential.
    if (!c?.agent) return json({ error: "missing or unknown credential" }, 401);
    const now = Date.now();
    c.at = c.at.filter((t) => t > now - 60_000);
    if (c.at.length >= perMinute) {
      const wait = Math.max(1, Math.ceil((c.at[0] + 60_000 - now) / 1000));
      return new Response(JSON.stringify({ error: `over the request budget; retry in ${wait} seconds` }), { status: 429, headers: { "content-type": "application/json", "retry-after": String(wait) } });
    }
    c.at.push(now);
    // Disputes and the owner's routes are out of this spec, so a resolver credential gets none of it.
    if (c.role === "resolver") return json({ error: "this credential works only on the owner's routes" }, 403);
    const a = c.agent;
    if (req.method === "GET" && url.pathname === "/v1/orientation") return new Response(orientation(a), { headers: { "content-type": "text/markdown; charset=utf-8" } });
    if (req.method === "GET" && url.pathname === "/v1/search") return json(search(a, url.searchParams.get("q") ?? ""));
    if (req.method === "GET" && url.pathname.startsWith("/v1/notes/")) {
      let id: string;
      try { id = decodeURIComponent(url.pathname.slice("/v1/notes/".length)); } catch { return json({ error: "bad id" }, 400); }
      const n = notes.get(id);
      return n && sees(a, id) ? json(view(a, n)) : missing(id);
    }
    if (req.method === "GET" && url.pathname === "/v1/changes") return json(changes(a));
    if (req.method === "POST" && ["/v1/remember", "/v1/handoffs", "/v1/handoffs/done"].includes(url.pathname)) {
      const text = await req.text();
      if (text.length > 64_000) return json({ outcome: "refused", message: "body too large" }, 413);
      let b: unknown;
      try { b = JSON.parse(text); } catch { return json({ outcome: "refused", message: "body must be JSON" }, 400); }
      if (!b || typeof b !== "object" || Array.isArray(b)) return json({ outcome: "refused", message: "body must be an object" }, 400);
      const body = b as Record<string, unknown>;
      if (url.pathname === "/v1/handoffs") return handOff(a, body);
      if (url.pathname === "/v1/handoffs/done") {
        const h = handoffs.find((x) => x.id === body.id && x.to === a.name && x.delivered);
        if (!h) return json({ error: "no open handoff with that id" }, 404);
        h.done = true;
        return json({ result: "done" });
      }
      return remember(a, body);
    }
    return json({ error: "not found" }, 404);
  }
  return { handle, issue, issueWaiting, inbox };
}

export const loadFixture = (file = join(import.meta.dir, "fixture.json")): Data => JSON.parse(readFileSync(file, "utf8"));

if (import.meta.main) {
  const s = referenceServer(loadFixture());
  const port = Number(process.argv[2] ?? 8790);
  Bun.serve({ port, hostname: "127.0.0.1", fetch: s.handle });
  console.log(`reference server on http://127.0.0.1:${port}\nfull token: ${s.issue("full")}\nlimited token: ${s.issue("limited")}\nresolver token: ${s.issue("full", "resolver")}\nwaiting token: ${s.issueWaiting()}`);
}
