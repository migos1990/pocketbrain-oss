// SPDX-License-Identifier: AGPL-3.0-only
// Semantic search, entirely on this machine (docs/semantic-search.md). A local embedding model
// (bge-m3, MIT licence, q8) turns each note an agent can see into a vector, and a query into
// another; search fuses the cosine ranking with BM25 (src/retrieve.ts, reciprocal-rank fusion).
// No note text and no query ever leaves the machine: the model runs in a worker thread of the hub
// (src/embed-worker.ts, so the hub's event loop stays free) through @huggingface/transformers (an
// optional dependency, imported only when needed), and downloads are off (env.allowRemoteModels =
// false) except in `pocketbrain search setup`.
//
// What a vector is made from: a document's rendered, visible text exactly as the agent's index
// holds it (docText in src/retrieve.ts), so a hidden fact or carved value can never shape it.
// Vectors are cached by the sha256 of that text, outside the brain (vectorDir below), so neither
// git nor a backup can pick them up, and never in a folder inside a git work tree or a brain.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MODEL_ID = "Xenova/bge-m3";
export const MODEL_DTYPE = "q8";
// Named so the outbound host list (scripts/outbound-hosts.txt) shows where `search setup` downloads
// from: the model page, and the file host it redirects the large files to (another *.cdn.hf.co by region).
export const MODEL_PAGE = "https://huggingface.co/Xenova/bge-m3";
export const MODEL_FILE_HOST = "https://us.aws.cdn.hf.co";
// The files the q8 model needs; present in the model dir means semantic search is on.
export const MODEL_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"];
// A document's text is cut here before it is embedded (as measured, evals/cases/retrieval.ts ret-synth-semantic).
export const DOC_CHARS = 1500;
// A query is cut here: a question, not a document (a long one cost seconds of model time).
export const QUERY_CHARS = 256;
// A query waits this long for its vector, then searches by words alone.
const QUERY_WAIT_MS = 4000;
// Queries waiting for the model, all agents together (each agent has at most one waiting).
const MAX_QUERIES = 16;
// Documents embedded per model call: one. The q8 model quantizes each call's activations together,
// so a text's vector shifts (by about 0.015) with whatever else is in its batch: batched, a hidden
// note's text could nudge the vector of a note the asker sees. Alone, a vector is a function of its
// own text only (and a query never waits behind more than one document).
const DOC_BATCH = 1;
// A background pass starts at most this often.
const PASS_GAP_MS = 30_000;

// close releases a model loaded in this thread (its ONNX sessions), so a command can exit cleanly.
export interface Embedder { id: string; embed(texts: string[]): Promise<Float32Array[]>; close?(): Promise<void> }

const home = () => process.env.HOME || homedir();
export const modelDir = () => resolve(process.env.PB_MODEL_DIR || join(home(), ".cache", "pocketbrain", "models"));
export const vectorDir = () => resolve(process.env.PB_VECTOR_DIR || join(home(), ".cache", "pocketbrain", "vectors"));
export const modelPresent = (dir = modelDir()) => MODEL_FILES.every((f) => existsSync(join(dir, MODEL_ID, f)));
export function modelBytes(dir = modelDir()): number {
  return MODEL_FILES.reduce((a, f) => { try { return a + statSync(join(dir, MODEL_ID, f)).size; } catch { return a; } }, 0);
}

// Tests inject a deterministic embedder; nothing else does.
let injected: Embedder | undefined;
export function useEmbedder(e: Embedder | undefined) {
  injected = e;
  local = undefined;
  failed = undefined;
  mem.clear();
  used.clear();
  passes.clear();
}

// On when the model is in the model dir (or a test embedder is set) and PB_SEMANTIC isn't "0".
// The optional library, installed or not (bun install --omit optional leaves it out).
let lib: boolean | undefined;
export function libraryPresent(): boolean {
  if (lib === undefined) { try { Bun.resolveSync("@huggingface/transformers", import.meta.dir); lib = true; } catch { lib = false; } }
  return lib;
}

// A model that failed to load (the optional library missing, a damaged file) turns it off until restart.
let failed: string | undefined;
export const semanticOn = () => process.env.PB_SEMANTIC !== "0" && (!!injected || (!failed && modelPresent() && libraryPresent()));
export function semanticState(): { on: boolean; why: string } {
  if (process.env.PB_SEMANTIC === "0") return { on: false, why: "off (PB_SEMANTIC=0)" };
  if (injected) return { on: true, why: `on (${injected.id})` };
  if (failed) return { on: false, why: `off: the model didn't load (${failed}); searching by words` };
  if (!modelPresent()) return { on: false, why: `off: no model in ${modelDir()} (pocketbrain search setup downloads it once)` };
  if (!libraryPresent()) return { on: false, why: "off: the model is here but its library, @huggingface/transformers, isn't installed (bun install)" };
  const where = persistRoot();
  return { on: true, why: `on (${MODEL_ID} ${MODEL_DTYPE}, local, ${Math.round(modelBytes() / 1e6)} MB; vectors ${where ? `in ${where}` : `in memory only: ${vectorDir()} is inside a git work tree or a brain`})` };
}

// ---------- the local model ----------

type Transformers = typeof import("@huggingface/transformers");
const importTransformers = (): Promise<Transformers> => import("@huggingface/transformers");

// The model, loaded once, from the model dir only. allowRemoteModels stays false unless `download`
// (the setup command), and local_files_only says the same to the loader, so a search never fetches.
export async function loadLocalEmbedder(opts: { download?: boolean; load?: () => Promise<Transformers>; progress?: (p: { status: string; file?: string; progress?: number }) => void } = {}): Promise<Embedder> {
  const t = await (opts.load ?? importTransformers)();
  const dir = modelDir();
  t.env.allowLocalModels = true;
  t.env.localModelPath = dir;
  t.env.cacheDir = dir;
  t.env.allowRemoteModels = !!opts.download;
  try {
    const f = await t.pipeline("feature-extraction", MODEL_ID, { dtype: MODEL_DTYPE, local_files_only: !opts.download, ...(opts.progress ? { progress_callback: opts.progress as never } : {}) });
    return {
      id: "bge-m3-q8",
      embed: async (xs) => {
        const out = await f(xs, { pooling: "mean", normalize: true });
        const dim = out.dims[out.dims.length - 1] as number, data = out.data as Float32Array;
        return xs.map((_, i) => data.slice(i * dim, (i + 1) * dim));
      },
      close: async () => { await (f as { dispose?: () => Promise<void> }).dispose?.(); },
    };
  } finally {
    t.env.allowRemoteModels = false;
  }
}

// `pocketbrain search setup`: the only download. Fetches the model into the model dir, then checks
// it loads from there with downloads off again. Each model it loads is released before it returns:
// left loaded, ONNX Runtime's teardown at process exit panicked the command on macOS after it had
// finished (Bun 1.4.3).
export async function setupModel(got: (file: string) => void = () => {}, o: { load?: () => Promise<Transformers> } = {}): Promise<{ bytes: number; already: boolean }> {
  if (!libraryPresent()) throw new Error("its library, @huggingface/transformers, isn't installed: run bun install in the app folder (without --omit optional)");
  const already = modelPresent();
  const check = async (e: Embedder) => { try { await e.embed(["check"]); } finally { await e.close?.(); } };
  if (!already) await check(await loadLocalEmbedder({ download: true, load: o.load, progress: (p) => { if (p.status === "done" && p.file) got(p.file); } }));
  await check(await loadLocalEmbedder({ load: o.load }));
  return { bytes: modelBytes(), already };
}

// `search setup` runs setupModel in a child process (src/semantic-setup.ts) and reads its report:
// on macOS, ONNX Runtime's teardown aborts a process that loaded the model as it exits, even with
// every session released (Bun 1.4.3), so the command never loads the model itself. The child
// writes each line before it exits; a `done` line counts even if the child then aborts. Its stderr
// is held back and shown only if it didn't finish, so the abort's panic text never reaches the owner.
export function setupInChild(got: (file: string) => void = () => {}, o: { cmd?: string[]; stderr?: (s: string) => void } = {}): Promise<{ bytes: number; already: boolean }> {
  const cmd = o.cmd ?? [process.execPath, fileURLToPath(new URL("./semantic-setup.ts", import.meta.url))];
  return new Promise((resolve, reject) => {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: process.env });
    let result: { bytes: number; already: boolean } | undefined, error: string | undefined, buf = "";
    const line = (l: string) => {
      if (l.startsWith("got ")) got(l.slice(4));
      else if (l.startsWith("done ")) result = JSON.parse(l.slice(5));
      else if (l.startsWith("error ")) error = l.slice(6);
    };
    const errText = new Response(p.stderr).text();
    (async () => {
      const dec = new TextDecoder();
      for await (const chunk of p.stdout) { buf += dec.decode(chunk, { stream: true }); let i; while ((i = buf.indexOf("\n")) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); } }
      if (buf) line(buf);
      const code = await p.exited;
      const err = await errText;
      if (result) return resolve(result);
      if (err) (o.stderr ?? ((t: string) => process.stderr.write(t)))(err);
      reject(new Error(error ?? `the setup process stopped before it finished (exit ${code}${p.signalCode ? `, ${p.signalCode}` : ""})`));
    })().catch(reject);
  });
}

// The model runs in a worker thread: inference and tokenizing take seconds of CPU, which on the
// hub's own thread stalled every request (slice audit F3). The worker is held open only while
// work is waiting, so a script that embeds still exits when it is done.
function workerEmbedder(): Embedder {
  const w = new Worker(new URL("./embed-worker.ts", import.meta.url).href) as Worker & { ref(): void; unref(): void };
  const waiting = new Map<number, { done: (v: Float32Array[]) => void; fail: (e: Error) => void }>();
  let n = 0;
  const idle = () => { if (!waiting.size) w.unref(); };
  idle();
  w.onmessage = (ev: MessageEvent<{ id: number; v?: Float32Array[]; error?: string }>) => {
    const p = waiting.get(ev.data.id);
    if (!p) return;
    waiting.delete(ev.data.id);
    idle();
    if (ev.data.error !== undefined) p.fail(new Error(ev.data.error)); else p.done(ev.data.v!);
  };
  w.onerror = (ev) => { for (const p of waiting.values()) p.fail(new Error(ev.message)); waiting.clear(); idle(); };
  return {
    id: "bge-m3-q8",
    embed: (texts) => new Promise((done, fail) => { const id = ++n; waiting.set(id, { done, fail }); w.ref(); w.postMessage({ id, texts }); }),
  };
}

let local: Embedder | undefined;
function embedder(): Embedder {
  if (injected) return injected;
  return (local ??= workerEmbedder());
}
const embedderId = () => injected?.id ?? "bge-m3-q8";

// ---------- the queue ----------
// One model call at a time. Queries go first, one waiting per agent, taken in turn (an agent's
// newer query replaces its older one), at most MAX_QUERIES in all; a query whose caller stopped
// waiting is skipped. Then the documents a search found without a vector, by agent in turn, so the
// asker's own notes come before the background pass's. The loop yields between model calls.
interface Job { texts: string[]; done: (v: Float32Array[]) => void; fail: (e: unknown) => void; cancelled?: boolean }
const queryJobs = new Map<string, Job>();
const askedJobs = new Map<string, Job[]>();
const backgroundJobs: Job[] = [];
function take(): Job | undefined {
  for (const [agent, j] of queryJobs) { queryJobs.delete(agent); return j; }
  for (const [agent, js] of askedJobs) {
    askedJobs.delete(agent);
    const j = js.shift()!;
    if (js.length) askedJobs.set(agent, js); // to the back of the line
    return j;
  }
  return backgroundJobs.shift();
}
let pumping = false;
const tick = () => new Promise<void>((r) => setImmediate(r));
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (let j = take(); j; j = take()) {
      if (j.cancelled) continue;
      try { j.done(await embedder().embed(j.texts)); } catch (e) {
        if (!injected && !failed) { failed = (e as Error).message; console.error(`semantic search: the local model failed (${failed}); searching by words until the hub restarts`); }
        j.fail(e);
      }
      await tick();
    }
  } finally { pumping = false; }
}
// How many queries wait for the model now (tests, and the bound).
export const queuedQueries = () => queryJobs.size;

// A query's vector, or undefined (off, the queue is full, the model failed, or it took too long):
// the caller then searches by words alone. Never throws.
export function embedQuery(q: string, o: { agent?: string; waitMs?: number } = {}): Promise<Float32Array | undefined> {
  const agent = o.agent ?? "";
  if (!semanticOn() || !q.trim()) return Promise.resolve(undefined);
  const older = queryJobs.get(agent);
  if (!older && queryJobs.size >= MAX_QUERIES) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (v: Float32Array | undefined) => { if (timer) clearTimeout(timer); timer = undefined; resolve(v); };
    const job: Job = { texts: [q.slice(0, QUERY_CHARS)], done: (v) => finish(v[0]), fail: () => finish(undefined) };
    if (older) { older.cancelled = true; older.done([]); }
    queryJobs.delete(agent);
    queryJobs.set(agent, job);
    timer = setTimeout(() => { job.cancelled = true; if (queryJobs.get(agent) === job) queryJobs.delete(agent); finish(undefined); }, o.waitMs ?? QUERY_WAIT_MS);
    void pump();
  });
}

// What the doors pass to core.search and core.contextPack: a query vector when semantic search is on.
export async function queryOpts(q: string | undefined, agent?: string): Promise<{ vector?: Float32Array }> {
  const vector = q ? await embedQuery(q, { agent }) : undefined;
  return vector ? { vector } : {};
}

// ---------- document vectors ----------

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const hashes = new Map<string, string>();
function hashOf(text: string): string {
  let h = hashes.get(text);
  if (!h) { if (hashes.size > 50_000) hashes.clear(); h = sha(text); hashes.set(text, h); }
  return h;
}
// One folder per brain under the vector dir, so pruning one brain's leftovers never touches another's.
const brainKeys = new Map<string, string>();
function brainKey(root: string): string {
  let k = brainKeys.get(root);
  if (!k) { let p = resolve(root); try { p = realpathSync(p); } catch { /* not there yet */ } k = sha(p).slice(0, 16); brainKeys.set(root, k); }
  return k;
}

// The vector dir, or undefined when it is inside a git work tree or a brain (any folder above it,
// symlinks followed, holds .git or rules/policy.yaml): vectors are then kept in memory only.
const safeDirs = new Map<string, boolean>();
export function insideRepoOrBrain(dir: string): boolean {
  // the deepest folder that exists, with its symlinks resolved, then the part not made yet
  let d = resolve(dir), rest = "";
  while (!existsSync(d) && dirname(d) !== d) { rest = join(d.slice(dirname(d).length + 1), rest); d = dirname(d); }
  try { d = join(realpathSync(d), rest); } catch { d = join(d, rest); }
  for (; ; d = dirname(d)) {
    if (existsSync(join(d, ".git")) || existsSync(join(d, "rules", "policy.yaml"))) return true;
    if (dirname(d) === d) return false;
  }
}
export function persistRoot(): string | undefined {
  const dir = vectorDir();
  if (!safeDirs.has(dir)) safeDirs.set(dir, !insideRepoOrBrain(dir));
  return safeDirs.get(dir) ? dir : undefined;
}
const brainFolder = (root: string) => { const base = persistRoot(); return base ? join(base, brainKey(root)) : undefined; };
const folderOf = (root: string) => { const b = brainFolder(root); return b ? join(b, embedderId()) : undefined; };
const fileOf = (folder: string, h: string) => join(folder, h.slice(0, 2), `${h}.f32`);
// Whether this brain has a vector folder at all (a forget checks it before working out what to keep).
export const hasVectors = (root: string) => { const b = brainFolder(root); return !!b && existsSync(b); };

const mem = new Map<string, Float32Array>();
const memKey = (root: string, h: string) => `${brainKey(root)}/${embedderId()}/${h}`;
// Vectors a search used or a fill stored since the last pass: the pass's prune keeps them, so a
// reader token's narrower view and a note embedded during the pass aren't deleted and redone.
const used = new Set<string>();

// The text a document is embedded from: its visible text, cut at DOC_CHARS.
export const embedInput = (text: string) => text.slice(0, DOC_CHARS);

// A document's vector if it has one yet (memory, then the vector dir); never computes one.
export function vectorFor(root: string, text: string): Float32Array | undefined {
  const h = hashOf(embedInput(text)), k = memKey(root, h);
  const hit = mem.get(k);
  if (hit) { used.add(k); return hit; }
  if (pending.has(k)) return undefined;
  const folder = folderOf(root);
  if (!folder) return undefined;
  try {
    const b = readFileSync(fileOf(folder, h));
    const v = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    mem.set(k, v);
    used.add(k);
    return v;
  } catch { return undefined; }
}

function store(root: string, h: string, v: Float32Array) {
  const k = memKey(root, h);
  mem.set(k, v);
  used.add(k);
  const folder = folderOf(root);
  if (!folder) return;
  const f = fileOf(folder, h);
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, Buffer.from(v.buffer, v.byteOffset, v.byteLength), { mode: 0o600 });
  renameSync(tmp, f);
}

// Embeds the documents that have no vector yet, DOC_BATCH at a time: for a search, behind the
// queries and in turn with other agents' searches (agent); otherwise behind both (the background
// pass). Returns how many it embedded; a search calls it without waiting.
const pending = new Set<string>();
export function fillVectors(root: string, texts: string[], o: { agent?: string } = {}): Promise<number> {
  if (!semanticOn()) return Promise.resolve(0);
  const todo = new Map<string, string>();
  for (const t of texts) {
    const x = embedInput(t), h = hashOf(x);
    // already waiting for its vector: not queued again (G373)
    if (x.trim() && !todo.has(h) && !pending.has(memKey(root, h)) && !vectorFor(root, x)) todo.set(h, x);
  }
  if (!todo.size) return Promise.resolve(0);
  const list = [...todo];
  for (const [h] of list) pending.add(memKey(root, h));
  const batches: Promise<number>[] = [];
  for (let i = 0; i < list.length; i += DOC_BATCH) {
    const part = list.slice(i, i + DOC_BATCH);
    batches.push(new Promise<number>((resolve) => {
      const clear = () => { for (const [h] of part) pending.delete(memKey(root, h)); };
      const job: Job = {
        texts: part.map(([, x]) => x),
        done: (vs) => { clear(); part.forEach(([h], j) => store(root, h, vs[j])); resolve(part.length); },
        fail: () => { clear(); resolve(0); },
      };
      if (o.agent === undefined) backgroundJobs.push(job);
      else askedJobs.set(o.agent, [...(askedJobs.get(o.agent) ?? []), job]);
    }));
  }
  void pump();
  return Promise.all(batches).then((ns) => ns.reduce((a, b) => a + b, 0));
}

// Removes this brain's vectors no text in `keep` needs (and those of another model), on disk and in
// memory, whether semantic search is on or not. keepUsed also keeps what searches used since the
// last pass (the pass sets it; a forget doesn't). Returns how many files went.
export function pruneVectors(root: string, keep: string[], o: { keepUsed?: boolean } = {}): number {
  const live = new Set(keep.map((t) => memKey(root, hashOf(embedInput(t)))));
  const mine = `${brainKey(root)}/`;
  const kept = (k: string) => live.has(k) || (!!o.keepUsed && used.has(k));
  for (const k of [...mem.keys()]) if (k.startsWith(mine) && !kept(k)) mem.delete(k);
  for (const k of [...used]) if (k.startsWith(mine) && !live.has(k)) used.delete(k);
  const base = brainFolder(root);
  if (!base || !existsSync(base)) return 0;
  let n = 0;
  for (const model of readdirSync(base)) {
    const dir = join(base, model);
    if (model !== embedderId()) { rmSync(dir, { recursive: true, force: true }); n++; continue; }
    for (const sub of readdirSync(dir)) for (const f of readdirSync(join(dir, sub))) {
      if (!kept(`${brainKey(root)}/${model}/${f.replace(/\.f32$/, "")}`)) { rmSync(join(dir, sub, f), { force: true }); n++; }
    }
  }
  return n;
}

// ---------- the background pass ----------
// What a pass reads, from src/core.ts (passSource): the brain's HEAD, its agents, and one agent's
// visible texts. A pass embeds what has no vector, then prunes the rest. It runs when the hub
// starts and after an agent's write; it is skipped when HEAD hasn't moved since the last one, so
// only a write that committed starts one. At most one runs and one waits; they start at most every
// PASS_GAP_MS, and the loop yields between agents.
export interface PassSource { head(): string; agents(): string[]; texts(agent: string): string[] }
interface PassState { running?: Promise<void>; again: boolean; timer?: ReturnType<typeof setTimeout>; lastStart: number; lastHead?: string }
const passes = new Map<string, PassState>();
const passOf = (root: string) => { let p = passes.get(root); if (!p) passes.set(root, (p = { again: false, lastStart: 0 })); return p; };

// Whether a pass is waiting to start or running for this brain (tests).
export const passScheduled = (root: string) => { const p = passes.get(root); return !!(p?.timer || p?.running); };

export function requestPass(root: string, src: PassSource, o: { delayMs?: number } = {}) {
  if (!semanticOn()) return;
  const p = passOf(root);
  if (p.running) { p.again = true; return; }
  if (p.timer) return;
  const wait = Math.max(o.delayMs ?? 3000, p.lastStart + PASS_GAP_MS - Date.now());
  p.timer = setTimeout(() => { p.timer = undefined; void runPass(root, src); }, wait);
  p.timer.unref?.();
}

// One pass now (force: even if HEAD hasn't moved), after the one running if any. Tests and evals
// await it so every view has its vectors before they compare answers (core.vectorsReady).
export function runPass(root: string, src: PassSource, o: { force?: boolean } = {}): Promise<void> {
  if (!semanticOn()) return Promise.resolve();
  const p = passOf(root);
  if (p.running) {
    if (o.force) return p.running.then(() => runPass(root, src, o));
    p.again = true;
    return p.running;
  }
  let force = !!o.force;
  p.running = (async () => {
    do {
      p.again = false;
      p.lastStart = Date.now();
      let head = "";
      try { head = src.head(); } catch { /* not a git repo: always run */ }
      if (!force && head && head === p.lastHead) continue;
      force = false;
      const live: string[] = [], fills: Promise<number>[] = [];
      for (const agent of src.agents()) {
        await tick();
        try { const t = src.texts(agent); live.push(...t); fills.push(fillVectors(root, t)); } catch { /* no grant now */ }
      }
      await Promise.all(fills);
      await tick();
      pruneVectors(root, live, { keepUsed: true });
      for (const k of [...used]) if (k.startsWith(`${brainKey(root)}/`)) used.delete(k);
      p.lastHead = head;
    } while (p.again);
  })().catch((e) => { console.error(`semantic search: vectors not updated: ${(e as Error).message}`); }).finally(() => { p.running = undefined; });
  return p.running;
}
