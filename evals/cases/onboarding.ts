// SPDX-License-Identifier: AGPL-3.0-only
// Onboarding a new agent (docs/add-an-agent.md, docs/spec/agent-onboarding.md): what the owner
// approves is what the agent gets, a new agent is always trial and never everything, and the
// OAuth approval window lets in one sign-in of the owner's own account, once, while it's open.
// Each case pins a finding from the slice audit of claude/add-an-agent. The OAuth cases use the
// tests' fake authorization server. Scored n/a at commits without src/addagent.ts.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { join } from "node:path";
import { SRC } from "../lib/pb";
import { sandbox } from "../lib/sandbox";
import { ok, na, type Case, type Result } from "../lib/case";

const has = (f: string) => existsSync(join(SRC, f));
const add = has("addagent.ts") ? await import(join(SRC, "addagent.ts")) : undefined;
const oauth = add ? await import(join(SRC, "oauth.ts")) : undefined;
const server = add ? await import(join(SRC, "server.ts")) : undefined;
const rules = add ? await import(join(SRC, "rules.ts")) : undefined;
const init = has("init.ts") ? await import(join(SRC, "init.ts")) : undefined;
const invite = has("invite.ts") ? await import(join(SRC, "invite.ts")) : undefined;
const auth = add ? await import(join(SRC, "auth.ts")) : undefined;
const core = add ? await import(join(SRC, "core.ts")) : undefined;
const apps = has("local-apps.ts") ? await import(join(SRC, "local-apps.ts")) : undefined;
const fake = add && existsSync(join(SRC, "..", "test", "fake-as.ts")) ? await import(join(SRC, "..", "test", "fake-as.ts")) : undefined;

const steps = (xs: [string, boolean][]): Result => {
  const failed = xs.filter(([, p]) => !p).map(([s]) => s);
  return ok(failed.length === 0, failed.length ? `failed at: ${failed.join("; ")}` : `${xs.length} steps held`);
};
const refused = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
const BASE = "https://brain.test", RESOURCE = `${BASE}/mcp/oauth`;

// A brain with the OAuth door open against a fresh fake AS; `signIn` is a new DCR client that calls once.
export async function door(run: (d: { root: string; as: any; signIn: () => Promise<any>; call: (t: string) => Promise<number>; http: (path: string, init?: RequestInit) => Promise<Response> }) => Promise<Result>): Promise<Result> {
  if (!add || !fake) return na("no add-agent or fake AS at this commit");
  const as = fake.startFakeAS("user_owner");
  try {
    oauth.clearJwksCache();
    const root = sandbox();
    oauth.setupOAuth(root, { issuer: as.issuer, resource: RESOURCE, owner_subject: "user_owner" });
    const http = (path: string, init: RequestInit = {}) => server.handle(root, new Request(BASE + path, init));
    // 200 only when let in as an agent. A waiting sign-in that gets the waiting session (its one tool
    // is request_access, nothing from the brain) still waits, so it counts as 403 like before.
    const call = async (t: string) => {
      const r = await http("/mcp/oauth", { method: "POST", headers: { authorization: `Bearer ${t}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      if (r.status !== 200) return r.status;
      const tools = ((await r.json()) as { result?: { tools?: { name: string }[] } }).result?.tools?.map((x) => x.name) ?? [];
      return tools.length === 1 && tools[0] === "request_access" ? 403 : 200;
    };
    const signIn = () => fake.connect(http, RESOURCE, { dcr: { client_name: "New", redirect_uri: "https://agent.example/cb" } });
    return await run({ root, as, signIn, call, http });
  } finally { as.stop(); }
}

export const onboardingCases: Case[] = [
  // The stdio bridge for apps on the owner's computer (src/local-apps.ts, docs/hosting.md#keys-at-rest).
  { id: "rt-onboard-bridge-loopback-only", dimension: "e2e", kind: "attack", title: "the app bridge never sends an agent's key to an address off this machine, however the app's config spells it", source: "synthetic", run: async () => {
    if (!apps || !auth) return na("no local-app bridge at this commit");
    const root = sandbox();
    add.addAgent(root, { agent: "newbot", slices: ["area:work"] });
    const keyDir = mkdtempSync(join(tmpdir(), "pb-eval-keys-"));
    const was = process.env.PB_CONFIG_DIR; process.env.PB_CONFIG_DIR = keyDir;
    try {
      apps.saveAgentKey("newbot", auth.issueToken(root, "newbot"));
      const out: [string, boolean][] = [];
      for (const url of ["https://evil.example", "http://127.0.0.1.evil.example", "http://localhost@evil.example", "http://[::ffff:7f00:1]:8787", "http://0.0.0.0:8787", "file:///etc/passwd"]) {
        let sent = 0;
        const code = await apps.bridge({ agent: "newbot", url, lines: (async function* () { yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }); })(), write: () => {}, err: () => {}, fetch: (async () => { sent++; return new Response("{}"); }) as unknown as typeof fetch });
        out.push([`${url} refused, nothing sent`, code === 2 && sent === 0]);
      }
      return steps(out);
    } finally { if (was === undefined) delete process.env.PB_CONFIG_DIR; else process.env.PB_CONFIG_DIR = was; }
  } },
  { id: "rt-onboard-bridge-key-revoked", dimension: "e2e", kind: "attack", title: "revoking an app deletes the key the bridge kept, and a copy of it opens nothing", source: "synthetic", run: async () => {
    if (!apps || !auth) return na("no local-app bridge at this commit");
    const root = sandbox();
    add.addAgent(root, { agent: "newbot", slices: ["area:work"] });
    const keyDir = mkdtempSync(join(tmpdir(), "pb-eval-keys-"));
    const was = process.env.PB_CONFIG_DIR; process.env.PB_CONFIG_DIR = keyDir;
    try {
      const tok = auth.issueToken(root, "newbot");
      const file = apps.saveAgentKey("newbot", tok);
      auth.revokeTokens(root, "newbot");
      const dropped = apps.dropAgentKey("newbot");
      const r = await server.handle(root, new Request(BASE + "/mcp", { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
      return steps([["file deleted", dropped && !existsSync(file)], [`old key refused (${r.status})`, r.status === 401 || r.status === 403]]);
    } finally { if (was === undefined) delete process.env.PB_CONFIG_DIR; else process.env.PB_CONFIG_DIR = was; }
  } },
  { id: "rt-onboard-no-everything", dimension: "carving", kind: "attack", title: "a new agent can't be given the all slice, an unknown slice or no slice", source: "synthetic", run: async () => {
    if (!add) return na("no add-agent at this commit");
    const root = sandbox();
    const before = readFileSync(join(root, "rules", "policy.yaml"), "utf8");
    return steps([
      ["all refused", refused(() => add.addAgent(root, { agent: "newbot", slices: ["all"] }))],
      ["unknown refused", refused(() => add.addAgent(root, { agent: "newbot", slices: ["area:nope"] }))],
      ["empty refused", refused(() => add.addAgent(root, { agent: "newbot", slices: [] }))],
      ["policy untouched", readFileSync(join(root, "rules", "policy.yaml"), "utf8") === before],
    ]);
  } },
  { id: "rt-onboard-no-takeover", dimension: "carving", kind: "attack", title: "adding an agent under an existing name (the resolver's) is refused, so its grant is never replaced", source: "synthetic", run: async () => {
    if (!add) return na("no add-agent at this commit");
    const root = sandbox();
    const before = readFileSync(join(root, "rules", "policy.yaml"), "utf8");
    return steps([["steward refused", refused(() => add.addAgent(root, { agent: "steward", slices: ["area:work"] }))], ["odd name refused", refused(() => add.addAgent(root, { agent: "Steward ", slices: ["area:work"] }))], ["policy untouched", readFileSync(join(root, "rules", "policy.yaml"), "utf8") === before]]);
  } },
  { id: "rt-onboard-always-trial", dimension: "carving", title: "a new agent is trial (writes wait), money is out by default, and the preview matches the granted carve", source: "synthetic", run: async () => {
    if (!add) return na("no add-agent at this commit");
    const root = sandbox();
    const p = add.addAgent(root, { agent: "newbot", slices: ["area:work", "contacts-basic"] });
    const r = rules.loadRules(root);
    // newbot exists now, so its preview would refuse; the same slice under a fresh name must match.
    const twin = add.previewNewAgent(root, { agent: "otherbot", slices: ["area:work", "contacts-basic"] });
    return steps([
      ["trial", r.policy.agents.newbot.tier === "trial" && rules.tierOf(r, "newbot").writes === "propose"],
      ["money out", (r.policy.agents.newbot.exclude_types ?? []).includes("money") && !p.money],
      ["no private", !p.private],
      [`same carve (${p.notes} vs ${twin.notes})`, p.notes === twin.notes],
    ]);
  } },
  { id: "rt-onboard-window-owner-only", dimension: "e2e", kind: "attack", title: "the approval window ignores a sign-in by anyone but the owner, and stays open for the owner", source: "synthetic", run: () => door(async ({ root, as, signIn, call }) => {
    add.addAgent(root, { agent: "newbot", slices: ["area:work"] });
    oauth.expectClient(root, "newbot");
    const c = await signIn();
    const now = Math.floor(Date.now() / 1000);
    const stranger = fake.signJwt(as.key, as.kid, { iss: as.issuer, sub: "user_stranger", aud: RESOURCE, client_id: c.client_id, iat: now, exp: now + 300 });
    const s = await call(stranger);
    return steps([[`stranger refused (${s})`, s === 403], ["not bound", !oauth.loadOAuth(root).clients?.[c.client_id]], ["window still open", oauth.loadOAuth(root).expect?.agent === "newbot"]]);
  }) },
  { id: "rt-onboard-window-once", dimension: "e2e", kind: "attack", title: "the window lets in one new sign-in only; a second, and one that waited before it opened, still wait", source: "synthetic", run: () => door(async ({ root, signIn, call }) => {
    add.addAgent(root, { agent: "newbot", slices: ["area:work"] });
    const early = await signIn();
    const e1 = await call(early.token());
    await Bun.sleep(5);
    oauth.expectClient(root, "newbot");
    const e2 = await call(early.token());
    const first = await signIn(), second = await signIn();
    const f = await call(first.token()), s = await call(second.token());
    return steps([[`early waits (${e1}, ${e2})`, e1 === 403 && e2 === 403], [`first in (${f})`, f === 200], [`second waits (${s})`, s === 403], ["window closed", !oauth.loadOAuth(root).expect]]);
  }) },
  { id: "rt-onboard-window-expires", dimension: "e2e", kind: "attack", title: "a lapsed window approves nothing", source: "synthetic", run: () => door(async ({ root, signIn, call }) => {
    add.addAgent(root, { agent: "newbot", slices: ["area:work"] });
    oauth.expectClient(root, "newbot", { minutes: 10, now: new Date(Date.now() - 11 * 60_000) });
    const c = await signIn();
    const s = await call(c.token());
    return steps([[`refused (${s})`, s === 403], ["not bound", !oauth.loadOAuth(root).clients?.[c.client_id]]]);
  }) },
  // From the Muse end-to-end run (test/oauth-muse.test.ts): the moments around a sign-in and a refresh.
  { id: "rt-oauth-parallel-first-calls", dimension: "e2e", title: "an assistant's first calls sent in parallel through an open window all get in, and the window still approves only that one client", source: "synthetic", run: () => door(async ({ root, signIn, call }) => {
    add.addAgent(root, { agent: "newbot", slices: ["area:work"] });
    oauth.expectClient(root, "newbot");
    const c = await signIn();
    const got = await Promise.all([1, 2, 3].map(() => call(c.token())));
    const other = await call((await signIn()).token());
    return steps([[`all in (${got.join(",")})`, got.every((x) => x === 200)], [`next client waits (${other})`, other === 403], ["one binding", Object.keys(oauth.loadOAuth(root).clients ?? {}).length === 1]]);
  }) },
  { id: "rt-oauth-key-rotation", dimension: "e2e", kind: "attack", title: "a token signed with a key the AS just rotated in works at once; a made-up key id is refused", source: "synthetic", run: () => door(async ({ root, as, signIn, call }) => {
    if (!as.rotateKey) return na("fake AS can't rotate keys at this commit");
    add.addAgent(root, { agent: "newbot", slices: ["area:work"] });
    const c = await signIn();
    oauth.bindClient(root, c.client_id, "newbot");
    const before = await call(c.token());
    as.rotateKey();
    const fresh = await c.refresh();
    const [h, body, sig] = fresh.split(".");
    const madeUp = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(h, "base64url").toString()), kid: "nope" })).toString("base64url")}.${body}.${sig}`;
    const a = await call(fresh), m = await call(madeUp);
    return steps([[`before (${before})`, before === 200], [`rotated key in (${a})`, a === 200], [`made-up kid refused (${m})`, m === 401]]);
  }) },
  { id: "rt-oauth-jwks-burst", dimension: "e2e", kind: "attack", title: "junk tokens in a burst, or the AS going down, don't turn every OAuth call into a fetch of the AS keys; the keys in hand keep working", source: "synthetic", run: () => door(async ({ root, as, signIn, call }) => {
    if (!as.hits) return na("fake AS doesn't count fetches at this commit");
    add.addAgent(root, { agent: "newbot", slices: ["area:work"] });
    const c = await signIn();
    oauth.bindClient(root, c.client_id, "newbot");
    oauth.clearJwksCache();
    as.hits.jwks = 0;
    const [h, body, sig] = c.token().split(".");
    const junk = (i: number) => `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(h, "base64url").toString()), kid: `junk${i}` })).toString("base64url")}.${body}.${sig}`;
    const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => call(junk(i))));
    const fetches = as.hits.jwks;
    as.down = true;
    try {
      as.hits.jwks = 0;
      const during = await Promise.all(Array.from({ length: 10 }, () => call(c.token())));
      return steps([[`junk refused (${[...new Set(burst)].join(",")})`, burst.every((s) => s === 401)], [`fetches for the burst (${fetches})`, fetches <= 2], [`still in while the AS is down (${[...new Set(during)].join(",")})`, during.every((s) => s === 200)], [`no fetch storm while down (${as.hits.jwks})`, as.hits.jwks <= 1]]);
    } finally { as.down = false; }
  }) },
  { id: "rt-oauth-trailing-slash", dimension: "e2e", title: "the OAuth door with a trailing slash still answers with the OAuth challenge", source: "synthetic", run: () => door(async ({ root }) => {
    const r = await server.handle(root, new Request(`${BASE}/mcp/oauth/`, { method: "POST" }));
    return ok(r.status === 401 && (r.headers.get("www-authenticate") ?? "").includes("resource_metadata="), `${r.status} ${r.headers.get("www-authenticate") ?? "no challenge"}`);
  }) },
  { id: "rt-onboard-waiting-reads-nothing", dimension: "e2e", kind: "attack", title: "a waiting sign-in's session reads nothing: every brain tool, a batch and an access request asking for all come back empty", source: "synthetic", run: () => door(async ({ root, signIn, http }) => {
    const c = await signIn();
    const rpc = async (body: unknown) => await (await http("/mcp/oauth", { method: "POST", headers: { authorization: `Bearer ${c.token()}` }, body: JSON.stringify(body) })).text();
    const tools = ["context_pack", "search", "read", "orientation", "whats_new", "memory_check"];
    const outs = await Promise.all(tools.map((name) => rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { query: "bank", topic: "money", id: "money/main-bank" } } })));
    const batch = await rpc([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "context_pack", arguments: {} } }]);
    await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "request_access", arguments: { name: "steward", purpose: "everything", slices: ["all"], tier: "core" } } });
    const req = oauth.listPending(root)[0]?.request;
    const leak = [...outs, batch].find((o) => /Maple|Course A|Robin/.test(o));
    return steps([["no brain text", !leak], ["not bound", !oauth.loadOAuth(root).clients?.[c.client_id]], [`request tamed (${req?.agent}, ${req?.slices})`, !req || (req.agent !== "steward" && !req.slices.includes("all"))]]);
  }) },
  { id: "rt-onboard-request-owner-name", dimension: "carving", kind: "attack", title: "a new agent can't be named like the owner (louis, the owner's name, owner) or all: its commits and widenings would read as the owner's", source: "synthetic", run: async () => {
    if (!add) return na("no add-agent at this commit");
    const root = sandbox();
    const owner = rules.loadRules(root).policy.owner?.name?.toLowerCase();
    const names = ["louis", "owner", "all", ...(owner ? [owner] : [])];
    return steps(names.map((n) => [`${n} refused`, refused(() => add.addAgent(root, { agent: n, slices: ["area:work"] }))] as [string, boolean]));
  } },
  { id: "rt-onboard-request-flood", dimension: "e2e", kind: "attack", title: "a flood of new sign-ins can't bury the owner's list: new waiting connections are capped per hour", source: "synthetic", run: () => door(async ({ root, signIn, call }) => {
    for (let i = 0; i < oauth.PENDING_PER_HOUR + 5; i++) await call((await signIn()).token());
    const n = oauth.listPending(root).length;
    return ok(n === oauth.PENDING_PER_HOUR, `${n} listed`);
  }) },
  { id: "rt-onboard-discovery-says-nothing", dimension: "carving", kind: "attack", title: "the discovery document, read with no token, names no owner, agent or note", source: "synthetic", run: async () => {
    if (!invite) return na("no discovery at this commit");
    const root = sandbox();
    const r = await server.handle(root, new Request(`${BASE}/.well-known/pocketbrain`));
    const text = await r.text();
    const owner = rules.loadRules(root).policy.owner?.name as string | undefined;
    const names = [...Object.keys(rules.loadRules(root).policy.agents), ...(owner ? [owner] : []), "Maple", "Northfield"];
    const hits = names.filter((n) => text.toLowerCase().includes(n.toLowerCase()));
    return steps([[`200 (${r.status})`, r.status === 200], [`no names (${hits.join(", ")})`, hits.length === 0]]);
  } },
  { id: "rt-onboard-invite-once", dimension: "e2e", kind: "attack", title: "an invite code gives one token, once; a replay, a lapsed code and a revoked agent's code all get the same refusal", source: "synthetic", run: async () => {
    if (!invite) return na("no invites at this commit");
    invite.resetEnrollLimits();
    const root = sandbox();
    const post = async (code: string) => { const r = await server.handle(root, new Request(`${BASE}/v1/enroll`, { method: "POST", body: JSON.stringify({ code }) })); return { status: r.status, text: await r.text() }; };
    const inv = invite.createInvite(root, "planner");
    const first = await post(inv.code), replay = await post(inv.code);
    const old = invite.createInvite(root, "planner", { now: new Date(Date.now() - 20 * 60_000) });
    const lapsed = await post(old.code);
    const cut = invite.createInvite(root, "planner");
    auth.revokeTokens(root, "planner");
    const revoked = await post(cut.code);
    const refusals = [replay, lapsed, revoked];
    return steps([[`first 200 (${first.status})`, first.status === 200 && /pb_planner_/.test(first.text)], ["refusals alike", refusals.every((r) => r.status === 401 && r.text === replay.text && !/pb_/.test(r.text))]]);
  } },
  { id: "rt-onboard-invite-guessing", dimension: "e2e", kind: "attack", title: "guessing invite codes is cut off: after the limit even a real code waits", source: "synthetic", run: async () => {
    if (!invite) return na("no invites at this commit");
    invite.resetEnrollLimits();
    const root = sandbox();
    const inv = invite.createInvite(root, "planner");
    for (let i = 0; i < invite.ENROLL_FAILS_PER_WINDOW; i++) await server.handle(root, new Request(`${BASE}/v1/enroll`, { method: "POST", body: JSON.stringify({ code: `GUESS-${i}0000` }) }));
    const r = await server.handle(root, new Request(`${BASE}/v1/enroll`, { method: "POST", body: JSON.stringify({ code: inv.code }) }));
    invite.resetEnrollLimits();
    return ok(r.status === 429, `real code after guesses: ${r.status}`);
  } },
  { id: "rt-onboard-invite-no-gardener", dimension: "carving", kind: "attack", title: "no invite for the gardener or an agent that isn't in the rules", source: "synthetic", run: async () => {
    if (!invite) return na("no invites at this commit");
    const root = sandbox();
    const g = Object.entries(rules.loadRules(root).policy.agents).find(([, a]: any) => a.role === "gardener")?.[0];
    return steps([["unknown refused", refused(() => invite.createInvite(root, "nobody"))], ...(g ? [["gardener refused", refused(() => invite.createInvite(root, g))] as [string, boolean]] : [])]);
  } },
  { id: "rt-onboard-standing-no-key", dimension: "carving", title: "the standing instruction served in orientation holds no key, and the initialize text stays short", source: "synthetic", run: async () => {
    if (!invite) return na("no served standing instruction at this commit");
    const root = sandbox();
    const tok = auth.issueToken(root, "planner");
    const o = core.orientation(root, "planner", "api");
    return steps([["has the block", /Save this in your own instructions/.test(o.text) && !!o.standing_instruction], ["no key", !o.text.includes(tok) && !/pb_[a-z]/.test(o.text)], ["contract without it", !/Save this in your own instructions/.test(o.contract)]]);
  } },
  { id: "rt-init-keeps-default", dimension: "e2e", gap: "G143", title: "a second init (a demo or test brain) never moves the remembered brain that later commands use", source: "Mac thread 2026-10-16", run: async () => {
    if (!init) return na("no init at this commit");
    const cfg = mkdtempSync(join(tmpdir(), "pb-eval-cfg-"));
    const brain = () => join(mkdtempSync(join(tmpdir(), "pb-eval-init-")), "brain");
    const env = { ...process.env, PB_CONFIG_DIR: cfg, PB_TODAY: "2026-10-08" } as Record<string, string>;
    delete env.PB_BRAIN;
    const run = (dir: string, name: string) => Bun.spawnSync(["bun", join(SRC, "cli.ts"), "init", dir, "--name", name, "--no-token"], { env, stdin: "ignore" }).exitCode;
    const live = brain(), film = brain();
    const made = run(live, "Alex") === 0 && run(film, "Kim") === 0;
    const remembered = existsSync(join(cfg, "brain")) ? readFileSync(join(cfg, "brain"), "utf8").trim() : "";
    writeFileSync(join(cfg, "brain"), join(tmpdir(), "pb-eval-gone") + "\n");
    const next = brain();
    const replaced = run(next, "Sam") === 0 && readFileSync(join(cfg, "brain"), "utf8").trim() === next;
    return steps([["both brains made", made], ["live brain still the default", remembered === live], ["a gone default is replaced", replaced]]);
  } },
  { id: "rt-init-owner-reads-area", dimension: "carving", gap: "G144", title: "init never makes an agent the owner of an area it can't read (the film brain's town owned health)", source: "Mac thread 2026-10-16", run: async () => {
    if (!init) return na("no init at this commit");
    const root = join(mkdtempSync(join(tmpdir(), "pb-eval-init-")), "brain");
    init.initBrain(root, { owner: "Alex", agent: "town", areas: ["work", "health", "personal"], token: false });
    const { policy, slices } = rules.loadRules(root);
    const reads = new Set((policy.agents.town?.slices ?? []).flatMap((x: string) => slices[x]?.areas ?? []));
    const blind = Object.entries(policy.areas).filter(([a, v]: [string, any]) => v?.owner === "town" && !reads.has(a)).map(([a]) => a);
    return steps([["owns only what it reads" + (blind.length ? ` (blind: ${blind.join(", ")})` : ""), !blind.length], ["still owns work", policy.areas.work?.owner === "town"]]);
  } },
  { id: "rt-onboard-like-no-widen", dimension: "carving", kind: "attack", title: "add --like copies only what narrows: a core, all-slice or gardener agent never passes on more than trial", source: "synthetic", run: async () => {
    if (!add?.likeAgent) return na("no add --like at this commit");
    const root = sandbox();
    const r = rules.loadRules(root);
    const agents = Object.entries(r.policy.agents) as [string, any][];
    const core = agents.find(([, a]) => a.tier === "core" && !(a.slices ?? []).includes("all") && !a.inside_wall && !a.role)?.[0];
    const all = agents.find(([, a]) => (a.slices ?? []).includes("all") && a.role !== "gardener")?.[0];
    const g = agents.find(([, a]) => a.role === "gardener")?.[0];
    const xs: [string, boolean][] = [];
    if (core) {
      const like = add.likeAgent(r, core);
      xs.push(["no ceiling above trial", !like.max_sensitivity || like.max_sensitivity === "public" || like.max_sensitivity === "personal"], ["money out", like.exclude_types.includes("money")]);
      add.addAgent(root, { agent: "copycat", ...like });
      const p = rules.loadRules(root).policy.agents.copycat;
      xs.push(["copy is trial", p?.tier === "trial"], ["no all", !(p?.slices ?? []).includes("all")]);
    }
    if (all) xs.push(["all-slice source refused", refused(() => add.likeAgent(r, all))]);
    if (g) xs.push(["gardener source refused", refused(() => add.likeAgent(r, g))]);
    xs.push(["ceiling above trial refused", refused(() => add.previewNewAgent(root, { agent: "wider", slices: ["contacts-basic"], max_sensitivity: "private" }))]);
    return steps(xs);
  } },
  { id: "rt-onboard-area-name", dimension: "carving", kind: "attack", title: "a new agent can't take an area's name, since carve gives an agent its namesake area whole", source: "synthetic", run: async () => {
    if (!add) return na("no add-agent at this commit");
    const root = sandbox();
    const area = Object.keys(rules.loadRules(root).policy.areas ?? {})[0];
    if (!area) return na("no areas in the sandbox");
    const xs: [string, boolean][] = [[`"${area}" refused`, refused(() => add.previewNewAgent(root, { agent: area, slices: ["contacts-basic"] }))]];
    // An area that is only on notes counts too (audit L5), and the hand carve can't create one (M1).
    if (add.checkNotAnArea) {
      const declared = new Set(Object.keys(rules.loadRules(root).policy.areas ?? {}));
      const brain = await import(join(SRC, "brain.ts"));
      const loose = brain.loadBrain(root).map((n: any) => n.fm.area).find((x: string) => x && !declared.has(x) && /^[a-z][a-z0-9-]{1,30}$/.test(x));
      if (loose) xs.push([`note-only "${loose}" refused`, refused(() => add.previewNewAgent(root, { agent: loose, slices: ["contacts-basic"] }))]);
      const cli = await import(join(SRC, "cli.ts"));
      const err = console.error, log = console.log; console.error = () => {}; console.log = () => {};
      let code: number; try { code = cli.main(["carve", area, "--slices", "contacts-basic", "--confirm", "--brain", root]); } finally { console.error = err; console.log = log; }
      xs.push(["carve --confirm refused", code !== 0 && !rules.loadRules(root).policy.agents[area]]);
    }
    return steps(xs);
  } },
  { id: "rt-onboard-like-tier-ceiling", dimension: "carving", kind: "attack", title: "add --like never sees more than the agent it copies, even when that agent's tier ceiling is below trial's", source: "synthetic", run: async () => {
    if (!add?.checkNotAnArea) return na("no audited add --like at this commit");
    const root = sandbox();
    const r = rules.loadRules(root);
    const src = (Object.entries(r.policy.agents) as [string, any][]).find(([, a]) => a.tier === "core" && !(a.slices ?? []).includes("all") && !a.inside_wall && !a.role)?.[0];
    if (!src) return na("no core agent with named slices in the sandbox");
    const file = join(root, "rules", "policy.yaml");
    const doc = YAML.parseDocument(readFileSync(file, "utf8"));
    doc.setIn(["tiers", "core", "max_sensitivity"], "public");
    writeFileSync(file, doc.toString({ lineWidth: 0 }));
    const like = add.likeAgent(rules.loadRules(root), src);
    return steps([[`copy ceiling ${like.max_sensitivity}`, like.max_sensitivity === "public"]]);
  } },
  { id: "onboard-reconnect-replaces", dimension: "e2e", kind: "benign", title: "a Reconnect (a new OAuth client for an agent already bound) replaces the old connection: the old one is refused and listed for deletion at the sign-in service, so apps don't pile up (backlog 289)", source: "synthetic", run: async () => {
    if (!oauth?.cleanupReplaced) return na("no reconnect replace at this commit");
    const root = sandbox();
    oauth.setupOAuth(root, { issuer: "https://as.example/", resource: "https://brain.example/mcp/oauth", owner_subject: "owner" });
    oauth.bindClient(root, "c-first", "helper");
    const old = oauth.bindClient(root, "c-again", "helper");
    const c = oauth.loadOAuth(root);
    return steps([
      ["old one replaced", JSON.stringify(old) === JSON.stringify(["c-first"])],
      ["old one refused", c.revoked?.includes("c-first") && !c.clients?.["c-first"]],
      ["listed for deletion", c.replaced?.["c-first"]?.agent === "helper"],
      ["new one bound", c.clients?.["c-again"]?.agent === "helper"],
      ["not flagged as a revoke", !c.revoked_agents?.helper],
    ]);
  } },
  { id: "rt-onboard-reconnect-spares-apps", dimension: "e2e", kind: "attack", title: "a reconnect never retires, and cleanup never deletes, the management app, a machine app or a coworker's connection; a replace can be undone before cleanup (reconnect slice audit F1, F3, F4)", source: "synthetic", run: async () => {
    if (!oauth?.cleanupReplaced) return na("no reconnect replace at this commit");
    const root = sandbox();
    oauth.setupOAuth(root, { issuer: "https://as.example/", resource: "https://brain.example/mcp/oauth", owner_subject: "owner" });
    oauth.setManagement(root, "mgmt-app");
    oauth.addCoworker(root, "sub-sam", "Sam", "planner");
    oauth.bindCoworkerClient(root, "sub-sam", "c-sam");
    const refused = (id: string) => { try { oauth.bindClient(root, id, "helper"); return false; } catch { return true; } };
    oauth.bindClient(root, "c-first", "helper");
    oauth.bindClient(root, "c-again", "helper");
    let undone = false;
    try { oauth.bindClient(root, "c-first", "helper", undefined, { keepOld: true }); undone = true; } catch {}
    const c = oauth.loadOAuth(root);
    return steps([
      ["management app can't be bound", refused("mgmt-app")],
      ["coworker's connection can't be bound", refused("c-sam")],
      ["management app not retired", !c.revoked?.includes("mgmt-app")],
      ["replace undone with --keep-old", undone && !!c.clients?.["c-first"] && !c.revoked?.includes("c-first") && !c.replaced?.["c-first"]],
      ["both connections bound", c.clients?.["c-again"]?.agent === "helper"],
    ]);
  } },
];
