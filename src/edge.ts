// SPDX-License-Identifier: AGPL-3.0-only
// The sealed edge (backlog 119, big bet 7): each agent's cell, sealed so that whatever stores it
// can't read it, served while the hub sleeps. Reads are answered from the sealed cell; writes are
// queued, sealed to the hub, and replayed through the normal write path when it wakes.
//
// Keys. Each publish seals an agent's cell (src/cell.ts: its slice only, already scrubbed) with a
// fresh random key, and wraps that key once per live token of the agent, under a key derived from
// the token (HKDF). The hub keeps those derived wrap keys at home (~/.config/pocketbrain/edge/,
// mode 600), learned once when `edge enroll` issues the token; it never stores the token. The edge
// holds ciphertext, wraps and token hashes only, so it opens a cell only while a request carrying
// a live token is in hand. Queued writes are sealed to the hub's X25519 key: the edge can't read
// them either. A revoked or paused agent gets no bundle on the next publish, and each publish uses
// a new content key, so an old token opens nothing published after it was revoked.
//
// What this does not do: the edge decrypts in memory to answer, so code running on the edge while
// a request is in flight sees that agent's slice; a pause or revoke reaches the edge only at the
// next publish; reads answered at the edge aren't in the hub's read log.
import { createCipheriv, createDecipheriv, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, timingSafeEqual, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";
import YAML from "yaml";
import { keysDir } from "./secrets";
import { alert, sha256, appendJsonl, readJsonl } from "./util";
import { loadRules } from "./rules";
import { issueToken, tokenInfo, tokenExpiry } from "./auth";
import { buildCell, buildReaderCell, cellDir } from "./cell";
import { handle } from "./server";
import * as core from "./core";
import { withTokenRole } from "./tokenrole";

// v2 (G249): a bundle holds one sealed cell per kind of token, the agent's whole slice for plain
// tokens and a reader-capped one for reader tokens, each under its own key. A v1 bundle opens
// nothing; republish.
const V = 2;
type CellKind = "full" | "reader";
const INFO = "pocketbrain edge v1";
type Sealed = { iv: string; tag: string; ct: string };
export interface Bundle { v: number; agent: string; sealed_at: string; brain_commit: string; salt: string; hub_key: string; wraps: Record<string, Sealed>; expires?: Record<string, number>; cells: Partial<Record<CellKind, Sealed>> }

// ---------- crypto ----------

function seal(key: Buffer, data: Buffer, aad: string): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(data), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}
// A tag is 16 bytes or nothing opens: Node's GCM accepts a cut tag (4 bytes is a forgery in about
// 2^32 tries) unless authTagLength is fixed, and the length is checked here too (G588).
function open(key: Buffer, s: Sealed, aad: string): Buffer {
  const tag = Buffer.from(s.tag, "base64");
  if (tag.length !== 16) throw new Error("sealed: the tag is not 16 bytes");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64"), { authTagLength: 16 });
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(Buffer.from(s.ct, "base64")), d.final()]);
}
// The wrap key for one token. The salt is fixed per brain (home state), so it can be learned once.
const wrapKey = (token: string, salt: string) => Buffer.from(hkdfSync("sha256", token, Buffer.from(salt, "base64"), INFO, 32));
// A bundle's wraps are keyed by a hash of the wrap key, never by the token hash tokens.yaml stores (G178).
const wrapId = (wk: Buffer) => sha256(`${INFO} wrap id:${wk.toString("base64")}`);
// Queued ops are signed under a key from the wrap key: the edge derives it from the token in hand,
// the hub from its home state. A bundle and the queue alone can't produce it (G178).
const macKey = (wk: Buffer) => Buffer.from(hkdfSync("sha256", wk, Buffer.alloc(0), `${INFO} queue mac`, 32));
const macOf = (wk: Buffer, op: Record<string, unknown>) => createHmac("sha256", macKey(wk)).update(JSON.stringify(op)).digest("base64");
// An agent with hours (windows, or the gardener) is checked against them by the live hub only;
// the edge has no clock it can trust, so such an agent is never published or replayed (G181).
const hasHours = (a: { windows?: string[]; role?: string } | undefined) => !!a?.windows?.length || a?.role === "gardener";

// ---------- home state: never leaves the hub ----------

interface Home { salt: string; hub_public: string; hub_private: string; agents: Record<string, Record<string, string>> } // agent -> token hash -> wrap key (base64)
export const edgeHome = () => join(dirname(keysDir()), "edge");
const homeFile = () => join(edgeHome(), "home.json");

function loadHome(): Home {
  if (existsSync(homeFile())) return JSON.parse(readFileSync(homeFile(), "utf8"));
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { salt: randomBytes(16).toString("base64"), hub_public: publicKey.export({ type: "spki", format: "der" }).toString("base64"), hub_private: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"), agents: {} };
}
// Whether any agent is enrolled for the edge: then bundles may be published that a change on the
// hub doesn't reach until `edge publish` runs again (src/forget.ts says so).
export const edgeEnrolled = (): boolean => {
  try { return existsSync(homeFile()) && Object.values((JSON.parse(readFileSync(homeFile(), "utf8")) as Home).agents ?? {}).some((t) => Object.keys(t).length > 0); } catch { return false; }
};
function saveHome(h: Home) {
  mkdirSync(edgeHome(), { recursive: true, mode: 0o700 });
  const tmp = `${homeFile()}.tmp`;
  writeFileSync(tmp, JSON.stringify(h, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, homeFile());
}

// A new token for the agent that also opens its sealed cell. The token is returned once and
// never stored; only its hash (rules/tokens.yaml) and its wrap key (home state). `reader` makes it
// a reader token (G18): its wrap opens only the reader-capped cell (G249) and its replayed writes
// keep that role (G202). `token`: one the caller already minted with that role (the CLI's, through
// its G184 gate, mintFromShell).
export function enroll(root: string, agent: string, role?: "reader", token?: string): string {
  if (role !== undefined && role !== "reader") throw new Error("an edge token is plain or reader: the resolver's routes need the hub");
  token ??= issueToken(root, agent, role);
  const h = loadHome();
  (h.agents[agent] ??= {})[sha256(token)] = wrapKey(token, h.salt).toString("base64");
  saveHome(h);
  return token;
}

// ---------- publish: the hub seals each enrolled agent's cell ----------

function packDir(dir: string): Buffer {
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files[relative(dir, p)] = readFileSync(p).toString("base64");
    }
  };
  walk(dir);
  return gzipSync(JSON.stringify(files));
}

// Writes <out>/<agent>.json per enrolled, active agent with at least one live enrolled token, and
// removes the bundle of any other agent. Returns what was published and what was left out, and why.
export function publish(root: string, out: string): { published: string[]; left_out: Record<string, string> } {
  const h = loadHome(), rules = loadRules(root), live = tokenInfo(root);
  mkdirSync(out, { recursive: true });
  const published: string[] = [], left_out: Record<string, string> = {};
  for (const [agent, wraps] of Object.entries(h.agents)) {
    const a = rules.policy.agents[agent];
    const hashes = new Set((live[agent] ?? []).filter((t) => !t.role || t.role === "reader").map((t) => t.hash));
    const keep = Object.entries(wraps).filter(([hash]) => hashes.has(hash));
    const why = !a ? "no longer in policy.yaml" : a.inside_wall ? "inside the wall" : a.status === "paused" ? "paused" : hasHours(a) ? "has hours only the hub checks" : !keep.length ? "no live enrolled token" : undefined;
    if (why) { left_out[agent] = why; rmSync(join(out, `${agent}.json`), { force: true }); continue; }
    // One cell per kind of token (G249): a reader token's key opens only the cell carved under the
    // reader role, so what it decrypts holds nothing above personal, whatever client opens it.
    const roleOf = (hash: string) => (live[agent] ?? []).find((t) => t.hash === hash)?.role === "reader" ? "reader" : "full";
    const cells: Partial<Record<CellKind, Sealed>> = {}, wrapsOut: Record<string, Sealed> = {}, expires: Record<string, number> = {};
    let brainCommit = "";
    const staging = mkdtempSync(join(tmpdir(), "pb-edge-pack-"));
    try {
      for (const kind of ["full", "reader"] as const) {
        const mine = keep.filter(([hash]) => roleOf(hash) === kind);
        if (!mine.length) continue;
        const built = kind === "reader" ? buildReaderCell(root, agent) : { info: buildCell(root, agent), dir: cellDir(root, agent) };
        brainCommit = built.info.brain_commit;
        const at = join(staging, kind);
        mkdirSync(at, { recursive: true });
        copyTree(built.dir, at);
        // The cell's own tokens.yaml: hashes of the live enrolled tokens that open this cell only.
        const tokens = { agents: { [agent]: (live[agent] ?? []).filter((t) => mine.some(([hash]) => hash === t.hash)) } };
        writeFileSync(join(at, "rules", "tokens.yaml"), YAML.stringify(tokens));
        const key = randomBytes(32);
        cells[kind] = seal(key, packDir(at), `${agent}:${V}:${kind}`);
        for (const [hash, wk] of mine) {
          const id = wrapId(Buffer.from(wk, "base64"));
          wrapsOut[id] = seal(Buffer.from(wk, "base64"), key, `${agent}:${V}`);
          // Each token's end date travels with its wrap, so the edge refuses it on time (G419).
          const t = (live[agent] ?? []).find((x) => x.hash === hash);
          if (t) expires[id] = tokenExpiry(t);
        }
      }
      const bundle: Bundle = { v: V, agent, sealed_at: new Date().toISOString(), brain_commit: brainCommit, salt: h.salt, hub_key: h.hub_public, wraps: wrapsOut, expires, cells };
      const f = join(out, `${agent}.json`);
      writeFileSync(`${f}.tmp`, JSON.stringify(bundle));
      renameSync(`${f}.tmp`, f);
      published.push(agent);
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }
  for (const f of existsSync(out) ? readdirSync(out) : []) {
    const agent = f.replace(/\.json$/, "");
    if (f.endsWith(".json") && !published.includes(agent) && !(agent in left_out)) { rmSync(join(out, f), { force: true }); left_out[agent] = "not enrolled"; }
  }
  return { published, left_out };
}

function copyTree(from: string, to: string) {
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const a = join(from, e.name), b = join(to, e.name);
    if (e.isDirectory()) { mkdirSync(b, { recursive: true }); copyTree(a, b); }
    else if (e.isFile()) writeFileSync(b, readFileSync(a));
  }
}

// ---------- the edge: answers from a sealed cell, queues writes ----------

// Opens the bundle with a token, or says why not. Nothing is decrypted without a live token.
export function openBundle(b: Bundle, token: string): Record<string, Buffer> | undefined {
  const wk = wrapKey(token, b.salt);
  const w = b.wraps[wrapId(wk)];
  if (!w || b.v !== V || !b.cells) return undefined;
  let key: Buffer;
  try { key = open(wk, w, `${b.agent}:${b.v}`); } catch { return undefined; }
  // The key opens the one cell it was made for (G249); the other fails its tag.
  for (const kind of ["full", "reader"] as const) {
    const c = b.cells[kind];
    if (!c) continue;
    try {
      const files = JSON.parse(gunzipSync(open(key, c, `${b.agent}:${b.v}:${kind}`)).toString()) as Record<string, string>;
      return Object.fromEntries(Object.entries(files).map(([p, v]) => [p, Buffer.from(v, "base64")]));
    } catch { /* not this token's cell */ }
  }
  return undefined;
}

const READ_TOOLS = new Set(["orientation", "whats_new", "context_pack", "search", "who_is", "read"]);
const WRITE_TOOLS = new Set(["remember", "retire", "capture"]);
const WRITE_ROUTES = /^\/v1\/(remember|retire|capture)$/;

// A queued write, sealed to the hub's X25519 key with a one-off key pair (ECIES).
function sealToHub(hubPublic: string, data: Buffer): { epk: string } & Sealed {
  const pub = createPublicKey({ key: Buffer.from(hubPublic, "base64"), format: "der", type: "spki" });
  const eph = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: pub });
  const epk = eph.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return { epk, ...seal(Buffer.from(hkdfSync("sha256", shared, Buffer.from(epk), INFO + " queue", 32)), data, "queue") };
}
function openFromEdge(hubPrivate: KeyObject, s: { epk: string } & Sealed): Buffer {
  const shared = diffieHellman({ privateKey: hubPrivate, publicKey: createPublicKey({ key: Buffer.from(s.epk, "base64"), format: "der", type: "spki" }) });
  return open(Buffer.from(hkdfSync("sha256", shared, Buffer.from(s.epk), INFO + " queue", 32)), s, "queue");
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

// One request at the edge. `dir` holds the published bundles and the queue (queue/).
export async function edgeHandle(dir: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/health") return json({ ok: true, edge: true });
  // The token comes in the Authorization header only: a token in a URL lands in logs and history.
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const agent = token?.match(/^pb_([a-z0-9-]+)_/)?.[1];
  const f = agent ? join(dir, `${agent}.json`) : "";
  if (!token || !agent || !existsSync(f)) return json({ error: "missing or unknown token" }, 401);
  const b = JSON.parse(readFileSync(f, "utf8")) as Bundle;
  const files = openBundle(b, token);
  if (!files) return json({ error: "missing or unknown token" }, 401);
  // Past its end date a token opens nothing here, reads or queued writes, without waiting for the
  // next publish. An unreadable date counts as past, as at the hub.
  const ends = b.expires?.[wrapId(wrapKey(token, b.salt))];
  const now = process.env.PB_NOW ? Date.parse(process.env.PB_NOW) : Date.now();
  if (ends !== undefined && !(ends > now)) return json({ error: "this token has expired: ask the owner for a new one" }, 401);
  const body = req.method === "POST" ? await req.text() : "";
  const queue = (op: Record<string, unknown>) => {
    const qd = join(dir, "queue");
    mkdirSync(qd, { recursive: true });
    const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
    const signed: Record<string, unknown> = { ...op, agent, token_hash: sha256(token), at: new Date().toISOString() };
    signed.mac = macOf(wrapKey(token, b.salt), signed);
    writeFileSync(join(qd, `${id}.json`), JSON.stringify(sealToHub(b.hub_key, Buffer.from(JSON.stringify(signed)))));
    return { outcome: "queued", id, message: `the hub is asleep: this write is queued and goes through the usual checks when it wakes (answers here are as of ${b.sealed_at})` };
  };
  // Writes never touch the sealed cell: they are queued for the hub.
  if (WRITE_ROUTES.test(url.pathname) && req.method === "POST") {
    let a: unknown; try { a = JSON.parse(body); } catch { return json({ error: "body must be JSON" }, 400); }
    return json(queue({ tool: url.pathname.split("/").pop(), args: a }), 202);
  }
  let rpc: { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } | undefined;
  if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
    try { rpc = JSON.parse(body); } catch { return json({ error: "body must be JSON-RPC" }, 400); }
    const name = rpc?.method === "tools/call" ? String(rpc.params?.name ?? "") : "";
    if (WRITE_TOOLS.has(name)) return json({ jsonrpc: "2.0", id: rpc?.id ?? null, result: { content: [{ type: "text", text: JSON.stringify(queue({ tool: name, args: rpc?.params?.arguments ?? {} }), null, 2) }], isError: false } });
    if (name && !READ_TOOLS.has(name)) return json({ jsonrpc: "2.0", id: rpc?.id ?? null, result: { content: [{ type: "text", text: `${name} needs the hub, which is asleep; try again later` }], isError: true } });
  } else if (url.pathname.startsWith("/v1/") && req.method !== "GET") {
    return json({ error: "the hub is asleep; reads and remember, retire and capture work here" }, 503);
  }
  // A read: the sealed cell opened into a private temp dir for this request only.
  const root = mkdtempSync(join(tmpdir(), "pb-edge-"));
  try {
    for (const [p, v] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true, mode: 0o700 }); writeFileSync(join(root, p), v, { mode: 0o600 }); }
    return await handle(root, new Request(req.url, { method: req.method, headers: req.headers, ...(req.method === "POST" ? { body } : {}) }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export function serveEdge(dir: string, port = 8789, hostname = "127.0.0.1") {
  return Bun.serve({ port, hostname, fetch: (req) => edgeHandle(dir, req) });
}

// ---------- replay: the hub, awake again, runs the queued writes ----------

// The op's MAC under the wrap key the hub holds for (agent, token hash). Object.hasOwn: an agent
// or hash named "__proto__" finds nothing.
function signedBy(h: Home, op: Record<string, unknown> & { agent: string; token_hash: string; mac?: string }): boolean {
  const wraps = Object.hasOwn(h.agents, op.agent) ? h.agents[op.agent] : undefined;
  const wk = wraps && Object.hasOwn(wraps, op.token_hash) ? wraps[op.token_hash] : undefined;
  if (!wk || typeof op.mac !== "string") return false;
  const { mac, ...rest } = op;
  const want = Buffer.from(macOf(Buffer.from(wk, "base64"), rest)), got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got);
}

export interface ReplayResult { id: string; agent?: string; tool?: string; outcome: string; message?: string }

// Each queued op is opened with the hub's key, its token hash checked against rules/tokens.yaml
// now (a token revoked since is refused), then run under that token's role (G202) through the
// same core functions as the live server. Done ops move to <dir>/queue/done/.
export async function replay(root: string, dir: string): Promise<ReplayResult[]> {
  const h = loadHome();
  const priv = createPrivateKey({ key: Buffer.from(h.hub_private, "base64"), format: "der", type: "pkcs8" });
  const qd = join(dir, "queue");
  if (!existsSync(qd)) return [];
  const out: ReplayResult[] = [];
  mkdirSync(join(qd, "done"), { recursive: true });
  // Each signed op runs once: a hash of its MAC (hex, so no backup scan mistakes it for a key) is
  // kept in the brain's log, so a copy put back in the queue is refused.
  const seenFile = join(root, "log", "edge-replayed.jsonl");
  const seen = new Set(readJsonl<{ op: string }>(seenFile).map((e) => e.op));
  const alerted = new Set<string>();
  for (const f of readdirSync(qd).filter((x) => x.endsWith(".json")).sort()) {
    const id = f.replace(/\.json$/, "");
    let op: { agent: string; token_hash: string; tool: string; args: Record<string, unknown>; at: string; mac?: string };
    try { op = JSON.parse(openFromEdge(priv, JSON.parse(readFileSync(join(qd, f), "utf8"))).toString()); }
    catch { out.push({ id, outcome: "refused", message: "not sealed to this hub" }); renameSync(join(qd, f), join(qd, "done", f)); continue; }
    const r: ReplayResult = { id, agent: op.agent, tool: op.tool, outcome: "refused" };
    // The signed token's entry as it is now: whether it's live, and its role (G202).
    const tok = (tokenInfo(root)[op.agent] ?? []).find((t) => t.hash === op.token_hash);
    const live = !!tok && (!tok.role || tok.role === "reader");
    const rules = loadRules(root);
    if (!signedBy(h, op)) r.message = "not signed by a token the hub enrolled for this agent";
    else if (seen.has(sha256(op.mac!))) r.message = "already replayed once; a copy runs nothing";
    else if (!live) r.message = "its token was revoked before the hub woke";
    else if (rules.policy.agents[op.agent]?.status === "paused") r.message = `${op.agent} is paused`;
    else if (hasHours(rules.policy.agents[op.agent])) {
      r.message = `${op.agent} has hours only the live hub checks; its edge writes don't replay`;
      // Like the live tripwire (gardener.ts hoursTripwire), the owner hears of it, once per agent per replay.
      if (!alerted.has(op.agent)) {
        alerted.add(op.agent);
        alert(root, { agent: op.agent, check: "gardener_hours", from: "the sealed edge", detail: `A write by ${op.agent} was queued at the sealed edge, which never serves an agent with hours, and was refused at replay. If you didn't expect ${op.agent} to reach the edge, revoke its token: \`pocketbrain token --revoke ${op.agent}\`.` });
      }
    }
    else {
      try {
        // Under the token's role, as the live server runs each request (G202): a reader token's
        // write keeps the G18 guard (its owner message ids wait for the owner) and the reader cap.
        const res = await withTokenRole(op.agent, tok?.role, async () => op.tool === "remember" ? (await core.gardenerSourceSays(root, op.agent, op.args)) ?? core.remember(root, op.agent, op.args)
          : op.tool === "retire" ? core.retire(root, op.agent, op.args)
          : op.tool === "capture" ? await core.captureFromAgent(root, op.agent, op.args)
          : undefined);
        if (!res) r.message = `${op.tool} can't be queued`;
        else { r.outcome = String((res as { outcome?: string }).outcome ?? "done"); r.message = (res as { message?: string }).message; }
      } catch (e) { r.message = (e as Error).message; }
    }
    if (signedBy(h, op) && !seen.has(sha256(op.mac!))) { seen.add(sha256(op.mac!)); appendJsonl(seenFile, { op: sha256(op.mac!), id, at: new Date().toISOString() }); }
    out.push(r);
    renameSync(join(qd, f), join(qd, "done", f));
  }
  return out;
}

