// SPDX-License-Identifier: AGPL-3.0-only
// Broken servers the conformance suite must fail. Each mutant wraps the reference server with one
// plausible mistake (a 403 for hidden notes, a flag that unlocks everything, identity from a
// header) and names the checks that must catch it. test/conformance.test.ts runs every mutant: a
// check that lets its mutant pass is too weak to keep implementations honest.
import type { Fixture } from "./suite";

export type Handler = (req: Request) => Promise<Response> | Response;
export interface Ctx { fx: Fixture; fullToken: string; limitedToken: string; resolverToken: string; waitingToken: string; hidden: string[] }
export interface Mutant { name: string; catches: string[]; wrap: (inner: Handler, ctx: Ctx) => Handler }

const asFull = (req: Request, ctx: Ctx, url = req.url) => {
  const h = new Headers(req.headers);
  h.set("authorization", `Bearer ${ctx.fullToken}`);
  return new Request(url, { method: req.method, headers: h, body: req.body, duplex: "half" } as RequestInit);
};
const as = (req: Request, token: string) => {
  const h = new Headers(req.headers);
  h.set("authorization", `Bearer ${token}`);
  return new Request(req.url, { method: req.method, headers: h, body: req.body, duplex: "half" } as RequestInit);
};
const bearer = (req: Request) => req.headers.get("authorization")?.replace(/^Bearer /, "");
const isLimited = (req: Request, ctx: Ctx) => req.headers.get("authorization") === `Bearer ${ctx.limitedToken}`;
const noteId = (url: URL) => { try { return decodeURIComponent(url.pathname.replace(/^\/v1\/notes\//, "")).replace(/\/+$/, ""); } catch { return ""; } };

export const MUTANTS: Mutant[] = [
  {
    name: "a hidden note written with a plain slash answers 403",
    catches: ["R5"],
    wrap: (inner, ctx) => (req) => {
      const url = new URL(req.url);
      return isLimited(req, ctx) && url.pathname.startsWith("/v1/notes/") && !url.pathname.includes("%2F") && ctx.hidden.includes(noteId(url))
        ? Response.json({ error: "forbidden" }, { status: 403 }) : inner(req);
    },
  },
  {
    name: "a hidden note's 404 carries a header saying why",
    catches: ["R5", "F1", "I1", "B1"],
    wrap: (inner, ctx) => async (req) => {
      const url = new URL(req.url), r = await inner(req);
      if (!url.pathname.startsWith("/v1/notes/") || !ctx.hidden.includes(noteId(url))) return r;
      const h = new Headers(r.headers); h.set("x-hidden-by", "slice");
      return new Response(await r.text(), { status: r.status, headers: h });
    },
  },
  {
    name: "search by a hidden note's id says something is there",
    catches: ["R6"],
    wrap: (inner, ctx) => (req) => {
      const url = new URL(req.url), q = url.searchParams.get("q") ?? "";
      return url.pathname === "/v1/search" && ctx.hidden.some((id) => id === q || id.endsWith(`/${q}`)) ? Response.json([{ id: "[withheld]", title: "[withheld]" }]) : inner(req);
    },
  },
  {
    name: "include_hidden=true reads as the full agent",
    catches: ["F1", "F2", "F3"],
    wrap: (inner, ctx) => (req) => (new URL(req.url).searchParams.get("include_hidden") === "true" ? inner(asFull(req, ctx)) : inner(req)),
  },
  {
    name: "a write saying direct: true skips the owner's inbox",
    catches: ["F4", "F5"],
    wrap: (inner, ctx) => async (req) => {
      if (req.method !== "POST" || !isLimited(req, ctx)) return inner(req);
      const text = await req.text();
      const body = JSON.parse(text || "{}");
      const again = new Request(req.url, { method: "POST", headers: req.headers, body: text });
      return body.direct === true ? inner(asFull(again, ctx)) : inner(again);
    },
  },
  {
    name: "an X-Agent header names who is asking",
    catches: ["I1", "F5"],
    wrap: (inner, ctx) => (req) => (req.headers.get("x-agent") === ctx.fx.agents.full.name ? inner(asFull(req, ctx)) : inner(req)),
  },
  {
    name: "a token in the query string is taken, before the header",
    catches: ["I1", "I2", "F5"],
    wrap: (inner, ctx) => (req) => {
      const t = new URL(req.url).searchParams.get("access_token");
      if (t !== ctx.fullToken) return inner(req);
      return inner(asFull(req, ctx));
    },
  },
  {
    name: "who wrote a fact is taken from the body",
    catches: ["I3"],
    wrap: (inner) => {
      const claimed = new Map<string, string>();
      return async (req) => {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/v1/remember") {
          const text = await req.text(), b = JSON.parse(text || "{}");
          if (typeof b.by === "string") claimed.set(`${b.id}#${b.attribute}`, b.by);
          return inner(new Request(req.url, { method: "POST", headers: req.headers, body: text }));
        }
        const r = await inner(req);
        if (req.method !== "GET" || !url.pathname.startsWith("/v1/notes/") || r.status !== 200) return r;
        const j = await r.json();
        for (const [k, f] of Object.entries(j.facts ?? {})) { const by = claimed.get(`${j.id}#${k}`); if (by) (f as Record<string, unknown>).by = by; }
        return Response.json(j);
      };
    },
  },
  {
    name: "a handoff's sender is told it was held",
    catches: ["H1"],
    wrap: (inner, ctx) => async (req) => {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== "/v1/handoffs") return inner(req);
      const text = await req.text(), r = await inner(new Request(req.url, { method: "POST", headers: req.headers, body: text }));
      if (!ctx.fx.probes.hidden_values.some((v) => text.includes(v))) return r;
      const j = await r.json();
      return Response.json({ ...j, reply: `${j.reply} Held: it carries something the recipient may not see.` });
    },
  },
  {
    name: "a handoff is delivered without checking the recipient's slice, under its sender's name",
    catches: ["H2"],
    wrap: (inner, ctx) => {
      const sent: { id: string; task: string; next_step: string }[] = [];
      return async (req) => {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/v1/handoffs") {
          const text = await req.text(), b = JSON.parse(text || "{}");
          const r = await inner(new Request(req.url, { method: "POST", headers: req.headers, body: text }));
          const j = await r.clone().json();
          if (j.id) sent.push({ id: j.id, task: b.task, next_step: b.next_step });
          return r;
        }
        const r = await inner(req);
        if (req.method !== "GET" || url.pathname !== "/v1/changes" || !isLimited(req, ctx)) return r;
        const j = await r.json(), have = new Set((j.handoffs ?? []).map((h: { id: string }) => h.id));
        return Response.json({ ...j, handoffs: [...(j.handoffs ?? []), ...sent.filter((s) => !have.has(s.id)).map((s) => ({ ...s, from: ctx.fx.agents.full.name, at: "" }))] });
      };
    },
  },
  {
    name: "a resolver credential reads like its agent's own",
    catches: ["P1", "P2"],
    wrap: (inner, ctx) => (req) => (bearer(req) === ctx.resolverToken ? inner(as(req, ctx.fullToken)) : inner(req)),
  },
  {
    name: "a sign-in the owner hasn't approved reads as the limited agent",
    catches: ["Q1"],
    wrap: (inner, ctx) => (req) => (bearer(req) === ctx.waitingToken ? inner(as(req, ctx.limitedToken)) : inner(req)),
  },
  {
    name: "over the request budget, a 429 carries no Retry-After",
    catches: ["B1"],
    wrap: (inner) => async (req) => {
      const r = await inner(req);
      if (r.status !== 429) return r;
      const h = new Headers(r.headers); h.delete("retry-after");
      return new Response(await r.text(), { status: 429, headers: h });
    },
  },
  {
    name: "the request budget counts only reads of notes that exist",
    catches: ["B1"],
    wrap: (inner, ctx) => async (req) => {
      const r = await inner(req), url = new URL(req.url);
      return r.status === 429 && url.pathname.startsWith("/v1/notes/") && ctx.hidden.includes(noteId(url)) ? Response.json({ error: "no such note" }, { status: 404 }) : r;
    },
  },
];
