// SPDX-License-Identifier: AGPL-3.0-only
// The launch site's counter, a Cloudflare Worker: page views and install-script downloads,
// as totals per day. It never reads or stores the visitor's address, browser, cookies or any
// id, sets no cookie, and keeps a referrer only as its host. See docs/site-analytics.md.

/** The slice of Workers KV this uses. */
export interface Store {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface Env {
  COUNTS: Store;
  /** The owner's token for GET /stats. Empty means /stats answers 401. */
  STATS_TOKEN: string;
  /** Where the install script is fetched from, e.g. the release's raw install.sh. */
  INSTALL_SCRIPT_URL: string;
  /** The public source's git address; GET /git/... redirects there, so the installer's default
   * clone address is the site's own. Empty turns /git off. */
  SOURCE_REPO_URL: string;
  /** The site's pages, comma separated ("/,/docs"). Any other path counts as "other". */
  PAGES: string;
}

interface Day {
  views: Record<string, number>;
  installs: number;
  from: Record<string, number>;
  countries: Record<string, number>;
}

const DAYS_SHOWN = 30;
const SITE_HOSTS = new Set(["pocketbrain.dev", "www.pocketbrain.dev"]);

// The page's whole beacon: the path and where it came from, sent once per page view.
const BEACON = `navigator.sendBeacon&&navigator.sendBeacon("/hit",JSON.stringify({p:location.pathname,r:document.referrer}));`;

const empty = (): Day => ({ views: {}, installs: 0, from: {}, countries: {} });
const dayOf = (now: Date) => now.toISOString().slice(0, 10);

async function bump(env: Env, now: Date, change: (d: Day) => void) {
  // Read-modify-write on KV: two hits in the same instant can lose one. Close enough for a
  // launch site's totals, and documented.
  const key = `day:${dayOf(now)}`;
  const raw = await env.COUNTS.get(key);
  const day: Day = raw ? { ...empty(), ...JSON.parse(raw) } : empty();
  change(day);
  await env.COUNTS.put(key, JSON.stringify(day));
}

const add = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

function page(p: unknown, pages: Set<string>): string {
  if (typeof p !== "string" || p.length > 200) return "other";
  let path = p.split(/[?#]/)[0]!;
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return pages.has(path) ? path : "other";
}

function host(r: unknown): string | null {
  if (typeof r !== "string" || !r || r.length > 2000) return null;
  let u: URL;
  try { u = new URL(r); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const h = u.hostname.toLowerCase().replace(/^www\./, "");
  if (h.length > 100 || !/^[a-z0-9.-]+$/.test(h) || SITE_HOSTS.has(h) || SITE_HOSTS.has(`www.${h}`)) return null;
  return h;
}

function country(req: Request): string | null {
  const c = req.headers.get("CF-IPCountry") ?? "";
  return /^[A-Z]{2}$/.test(c) && c !== "XX" && c !== "T1" ? c : null;
}

function sameToken(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function stats(env: Env, now: Date): Promise<Response> {
  const days: (Day & { day: string })[] = [];
  const totals = { views: 0, installs: 0 };
  for (let i = 0; i < DAYS_SHOWN; i++) {
    const day = dayOf(new Date(now.getTime() - i * 86_400_000));
    const raw = await env.COUNTS.get(`day:${day}`);
    const d: Day = raw ? { ...empty(), ...JSON.parse(raw) } : empty();
    days.push({ day, ...d });
    totals.views += Object.values(d.views).reduce((a, b) => a + b, 0);
    totals.installs += d.installs;
  }
  return Response.json({ days, totals }, { headers: { "Cache-Control": "no-store" } });
}

export async function handle(req: Request, env: Env, now: Date, fetchScript: (url: string) => Promise<Response> = fetch): Promise<Response> {
  const { pathname } = new URL(req.url);

  if (pathname === "/hit" && req.method === "POST") {
    let body: { p?: unknown; r?: unknown } = {};
    try { body = JSON.parse((await req.text()).slice(0, 4000)); } catch { /* counts as other */ }
    const pages = new Set(env.PAGES.split(",").map((s) => s.trim()).filter(Boolean));
    const from = host(body?.r);
    const c = country(req);
    await bump(env, now, (d) => {
      add(d.views, page(body?.p, pages));
      if (from) add(d.from, from);
      if (c) add(d.countries, c);
    });
    return new Response(null, { status: 204 });
  }

  if (pathname === "/install.sh" && req.method === "GET") {
    const r = await fetchScript(env.INSTALL_SCRIPT_URL);
    if (!r.ok) return new Response("The installer is unavailable right now; try again in a minute.\n", { status: 502 });
    const script = await r.text();
    await bump(env, now, (d) => { d.installs += 1; });
    return new Response(script, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }

  if ((pathname === "/git" || pathname.startsWith("/git/")) && req.method === "GET" && env.SOURCE_REPO_URL) {
    // git follows a redirect on its first request and keeps the new address for the rest.
    const { search } = new URL(req.url);
    return Response.redirect(`${env.SOURCE_REPO_URL.replace(/\/+$/, "")}${pathname.slice(4)}${search}`, 302);
  }

  if (pathname === "/count.js" && req.method === "GET") {
    return new Response(BEACON, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
  }

  if (pathname === "/stats" && req.method === "GET") {
    const auth = req.headers.get("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!sameToken(env.STATS_TOKEN, token)) return new Response("unauthorized\n", { status: 401 });
    return stats(env, now);
  }

  return new Response("not found\n", { status: 404 });
}

export default {
  fetch: (req: Request, env: Env) => handle(req, env, new Date()),
};
