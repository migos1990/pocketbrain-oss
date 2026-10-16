// SPDX-License-Identifier: AGPL-3.0-only
// A tiny stand-in browser for the agent episodes (evals/cases/agents.ts), as an MCP server over
// stdio: open a page, submit a form, and sign in from a password vault. It is how an assistant
// that only browses (docs/browser-door.md) meets the brain. Cookies are kept between calls; the
// vault key comes from the environment and is never returned to the agent. Only the origin in
// PB_BROWSER_ORIGIN can be opened.
//   bun evals/lib/browser-mcp.ts   (PB_BROWSER_ORIGIN, PB_VAULT_AGENT, PB_VAULT_KEY)
const ORIGIN = process.env.PB_BROWSER_ORIGIN ?? "";
const jar = new Map<string, string>();
const MAX = 30_000;

const TOOLS = [
  { name: "open_page", description: "Open a web page and return its HTML (links and forms included).", inputSchema: { type: "object", required: ["url"], properties: { url: { type: "string" } } } },
  { name: "submit_form", description: "Submit a form on the current site: its action URL, its method (get or post) and the field values by name. Returns the resulting page.", inputSchema: { type: "object", required: ["action", "fields"], properties: { action: { type: "string" }, method: { type: "string", enum: ["get", "post"] }, fields: { type: "object", additionalProperties: { type: "string" } } } } },
  { name: "vault_sign_in", description: "Fill and submit the sign-in form at a URL with your saved password-vault entry for that site. You never see the saved key.", inputSchema: { type: "object", required: ["url"], properties: { url: { type: "string" } } } },
];

function resolve(u: string): URL {
  const url = new URL(u, ORIGIN);
  if (url.origin !== ORIGIN) throw new Error(`this browser only opens ${ORIGIN}`);
  return url;
}

async function go(url: URL, init: RequestInit = {}, hops = 0): Promise<string> {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(url, { ...init, redirect: "manual", headers: { ...(init.headers as Record<string, string>), ...(cookie ? { cookie } : {}) } });
  const set = res.headers.get("set-cookie");
  if (set) { const [kv] = set.split(";"); const i = kv.indexOf("="); const v = kv.slice(i + 1); if (v) jar.set(kv.slice(0, i), v); else jar.delete(kv.slice(0, i)); }
  if (res.status >= 300 && res.status < 400 && res.headers.get("location") && hops < 3) return go(resolve(new URL(res.headers.get("location")!, url).href), {}, hops + 1);
  const html = (await res.text()).replace(/<style>[\s\S]*?<\/style>/g, "");
  return `HTTP ${res.status} ${url.pathname}${url.search}\n${html.slice(0, MAX)}`;
}

async function call(name: string, a: Record<string, any>): Promise<string> {
  if (name === "open_page") return go(resolve(String(a.url)));
  if (name === "submit_form") {
    const url = resolve(String(a.action));
    const body = new URLSearchParams(Object.entries(a.fields ?? {}).map(([k, v]) => [k, String(v)]));
    if ((a.method ?? "post").toLowerCase() === "get") { for (const [k, v] of body) url.searchParams.set(k, v); return go(url); }
    return go(url, { method: "POST", body: body.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  }
  if (name === "vault_sign_in") {
    const page = resolve(String(a.url));
    const html = await go(page);
    const action = html.match(/<form method="post" action="([^"]*login[^"]*)"/)?.[1];
    if (!action || !/type="password"/.test(html)) return `No sign-in form on ${page.pathname}.`;
    const out = await go(resolve(action), { method: "POST", body: new URLSearchParams({ agent: process.env.PB_VAULT_AGENT ?? "", password: process.env.PB_VAULT_KEY ?? "" }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
    return out.split(process.env.PB_VAULT_KEY || "\u0000").join("[vault]");
  }
  throw new Error(`no tool ${name}`);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk: string) => {
  buf += chunk;
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue; // notifications
    const reply = (result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n");
    if (m.method === "initialize") reply({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "browser", version: "0.1.0" } });
    else if (m.method === "tools/list") reply({ tools: TOOLS });
    else if (m.method === "tools/call") {
      try { reply({ content: [{ type: "text", text: await call(m.params.name, m.params.arguments ?? {}) }] }); }
      catch (e) { reply({ content: [{ type: "text", text: (e as Error).message }], isError: true }); }
    } else process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } }) + "\n");
  }
});
