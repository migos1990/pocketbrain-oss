// SPDX-License-Identifier: AGPL-3.0-only
// OpenFGA (or a hosted OpenFGA service such as Auth0 FGA) as a second lock on the carve. Off unless rules/fga.yaml exists and the
// hub starts it. When on, an outside agent keeps a slice from policy.yaml only if FGA also says
// `agent:<name> can_read slice:<slice>`; the carve inside each slice stays local. FGA holds agent
// and slice names only, never a note id or a value: it knows who may see what, never what it says.
// It can only take access away: a slice missing from policy.yaml is never added because FGA has it.
// The hub keeps an in-memory copy, refreshed every refresh_s; if FGA can't be reached for longer
// than max_age_s, outside agents get no slices (fail closed). Removing a tuple in the FGA console
// cuts the slice on the next refresh.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { loadRules, type Rules } from "./rules";

export interface FgaConfig {
  api_url: string;                // e.g. https://api.us1.fga.dev
  store_id: string;
  model_id?: string;              // authorization model id; default: the store's latest
  token_issuer?: string;          // client credentials, e.g. https://fga.us.auth0.com
  api_audience?: string;          // e.g. https://api.us1.fga.dev/
  client_id?: string;             // its secret is the key FGA_CLIENT_SECRET, never in this file
  refresh_s?: number;             // default 30
  max_age_s?: number;             // default 120
}

export interface Tuple { user: string; relation: string; object: string }

// The authorization model to load into the store (`pocketbrain fga model`). can_read is its own
// relation so a later model can widen it (a coworker's agents through the coworker) without
// changing what the hub asks.
export const MODEL = {
  schema_version: "1.1",
  type_definitions: [
    { type: "agent" },
    {
      type: "slice",
      relations: { reader: { this: {} }, can_read: { computedUserset: { relation: "reader" } } },
      metadata: { relations: { reader: { directly_related_user_types: [{ type: "agent" }] }, can_read: { directly_related_user_types: [] } } },
    },
  ],
};

// FGA object ids can't carry pocketBrain's "area:" prefix as is.
export const sliceObject = (slice: string) => `slice:${slice.replace(/:/g, "__")}`;
const sliceName = (object: string) => object.replace(/^slice:/, "").replace(/__/g, ":");

export function loadFga(root: string): FgaConfig | undefined {
  const f = join(root, "rules", "fga.yaml");
  if (!existsSync(f)) return undefined;
  const c = YAML.parse(readFileSync(f, "utf8")) as FgaConfig | null;
  if (!c?.api_url || !c.store_id) return undefined;
  return c;
}

const outside = (rules: Rules) => Object.entries(rules.policy.agents).filter(([, a]) => !a.inside_wall);

// What policy.yaml grants, as FGA tuples. `pocketbrain fga sync` writes these.
export function tuplesFromPolicy(rules: Rules): Tuple[] {
  return outside(rules).flatMap(([name, a]) => (a.slices ?? []).map((s) => ({ user: `agent:${name}`, relation: "reader", object: sliceObject(s) })));
}

// ---------- the hub's copy ----------

interface Entry { slices: Set<string>; at: number }
const state = { on: false, maxAgeMs: 120_000, agents: new Map<string, Entry>(), timer: undefined as ReturnType<typeof setInterval> | undefined, lastError: "" };

// Called by grantFor for every grant. Inside-the-wall agents and a hub without FGA pass through.
export function confirmSlices(agent: string, slices: string[], insideWall?: boolean): string[] {
  if (!state.on || insideWall) return slices;
  const e = state.agents.get(agent);
  if (!e || Date.now() - e.at > state.maxAgeMs) return [];
  return slices.filter((s) => e.slices.has(s));
}

// True when FGA leaves this agent every slice policy.yaml gives it: FGA off, inside the wall, or a
// fresh entry that holds them all. A merge check reads this so a stale or partial FGA copy refuses
// the merge instead of looking like an agent that sees neither note (G226).
export function fgaConfirmsAll(agent: string, slices: string[], insideWall?: boolean): boolean {
  if (!state.on || insideWall) return true;
  return confirmSlices(agent, slices, insideWall).length === new Set(slices).size;
}

export function fgaStatus() {
  return { on: state.on, agents: [...state.agents].map(([a, e]) => ({ agent: a, slices: [...e.slices], age_s: Math.round((Date.now() - e.at) / 1000) })), last_error: state.lastError };
}

// ---------- the API ----------

export class FgaClient {
  private token?: { value: string; until: number };
  constructor(private c: FgaConfig, private fetchFn: typeof fetch = fetch) {}

  private async auth(): Promise<Record<string, string>> {
    if (!this.c.token_issuer || !this.c.client_id) return {};
    if (this.token && Date.now() < this.token.until) return { authorization: `Bearer ${this.token.value}` };
    const secret = process.env.FGA_CLIENT_SECRET;
    if (!secret) throw new Error("no FGA_CLIENT_SECRET key");
    const issuer = this.c.token_issuer.replace(/\/$/, "");
    const r = await this.fetchFn(`${issuer}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", client_id: this.c.client_id, client_secret: secret, audience: this.c.api_audience ?? `${this.c.api_url.replace(/\/$/, "")}/` }),
    });
    if (!r.ok) throw new Error(`FGA token: HTTP ${r.status}`);
    const j = (await r.json()) as { access_token: string; expires_in?: number };
    this.token = { value: j.access_token, until: Date.now() + Math.max(60, (j.expires_in ?? 3600) - 60) * 1000 };
    return { authorization: `Bearer ${j.access_token}` };
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const r = await this.fetchFn(`${this.c.api_url.replace(/\/$/, "")}/stores/${this.c.store_id}${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(await this.auth()) }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`FGA ${path}: HTTP ${r.status}`);
    return (await r.json()) as T;
  }

  private model() { return this.c.model_id ? { authorization_model_id: this.c.model_id } : {}; }

  async writeModel(): Promise<string> {
    return (await this.post<{ authorization_model_id: string }>("/authorization-models", MODEL)).authorization_model_id;
  }

  async canRead(agent: string): Promise<Set<string>> {
    const j = await this.post<{ objects: string[] }>("/list-objects", { ...this.model(), type: "slice", relation: "can_read", user: `agent:${agent}` });
    return new Set((j.objects ?? []).map(sliceName));
  }

  async readAll(): Promise<Tuple[]> {
    const out: Tuple[] = [];
    let token: string | undefined;
    do {
      const j: { tuples: { key: Tuple }[]; continuation_token?: string } = await this.post("/read", { page_size: 100, ...(token ? { continuation_token: token } : {}) });
      out.push(...(j.tuples ?? []).map((t) => t.key));
      token = j.continuation_token || undefined;
    } while (token);
    return out;
  }

  async write(writes: Tuple[], deletes: Tuple[]) {
    if (!writes.length && !deletes.length) return;
    await this.post("/write", { ...this.model(), ...(writes.length ? { writes: { tuple_keys: writes } } : {}), ...(deletes.length ? { deletes: { tuple_keys: deletes } } : {}) });
  }
}

const key = (t: Tuple) => `${t.user}|${t.relation}|${t.object}`;

// Makes FGA match policy.yaml for agent→slice reader tuples. Other tuples are left alone.
export async function syncFga(root: string, o: { apply?: boolean; client?: FgaClient } = {}) {
  const c = loadFga(root);
  if (!c) throw new Error("no rules/fga.yaml");
  const client = o.client ?? new FgaClient(c);
  const want = tuplesFromPolicy(loadRules(root));
  const have = (await client.readAll()).filter((t) => t.user.startsWith("agent:") && t.relation === "reader" && t.object.startsWith("slice:"));
  const haveK = new Set(have.map(key)), wantK = new Set(want.map(key));
  const add = want.filter((t) => !haveK.has(key(t)));
  const remove = have.filter((t) => !wantK.has(key(t)));
  if (o.apply) await client.write(add, remove);
  return { add, remove };
}

export async function refreshFga(root: string, client: FgaClient) {
  const rules = loadRules(root);
  for (const [name] of outside(rules)) {
    try {
      state.agents.set(name, { slices: await client.canRead(name), at: Date.now() });
      state.lastError = "";
    } catch (e) {
      state.lastError = (e as Error).message;   // the old entry ages out after max_age_s
    }
  }
}

// The hub turns the lock on. Returns false when there's no rules/fga.yaml.
export async function startFga(root: string, client?: FgaClient): Promise<boolean> {
  const c = loadFga(root);
  if (!c) return false;
  const cl = client ?? new FgaClient(c);
  state.on = true;
  state.maxAgeMs = (c.max_age_s ?? 120) * 1000;
  await refreshFga(root, cl);
  state.timer = setInterval(() => void refreshFga(root, cl), (c.refresh_s ?? 30) * 1000);
  (state.timer as { unref?: () => void }).unref?.();
  return true;
}

export function stopFga() {
  if (state.timer) clearInterval(state.timer);
  state.on = false;
  state.agents.clear();
  state.timer = undefined;
  state.lastError = "";
}
