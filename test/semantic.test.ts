// SPDX-License-Identifier: AGPL-3.0-only
// Semantic search (src/semantic.ts, docs/semantic-search.md) with a stub embedder: deterministic,
// no model. Fusion and the why line, the doors that embed the query, hidden equals missing with
// semantic on, vectors kept out of git, and no download from a search.
import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeBrain } from "./fixture";
import * as core from "../src/core";
import * as sem from "../src/semantic";
import { whyLine, buildIndex, docText, rank } from "../src/retrieve";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { loadBrain } from "../src/brain";
import { loadRules } from "../src/rules";
import { carve, grantFor } from "../src/carve";
import { createHash } from "node:crypto";
import { brain as standingBrain } from "./standing-fixture";
import { forgetPerson } from "../src/forget";

const vectorFiles = (d: string): string[] => existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? vectorFiles(join(d, e.name)) : e.name.endsWith(".f32") ? [join(d, e.name)] : []) : [];

// Words hashed into 64 dimensions, a few mapped to a shared concept first, then normalized.
const CONCEPT: Record<string, string> = { pedagogy: "course", syllabus: "course", lender: "bank", banking: "bank" };
function vec(text: string): Float32Array {
  const v = new Float32Array(64);
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2)) {
    const w = CONCEPT[raw] ?? raw;
    let h = 7;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % 64] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
const calls: string[][] = [];
const STUB: sem.Embedder = { id: "stub", embed: async (xs) => { calls.push(xs); return xs.map(vec); } };

function vectors() { const d = mkdtempSync(join(tmpdir(), "pb-vec-")); process.env.PB_VECTOR_DIR = d; return d; }
async function on(root: string) {
  vectors();
  sem.useEmbedder(STUB);
  await sem.fillVectors(root, core.visibleTexts(root));
}
// test/setup.ts points both dirs into the run folder; each test may move them, and gets them back.
const DIRS = { PB_VECTOR_DIR: process.env.PB_VECTOR_DIR, PB_MODEL_DIR: process.env.PB_MODEL_DIR };
afterEach(() => {
  sem.useEmbedder(undefined);
  for (const [k, v] of Object.entries(DIRS)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  delete process.env.PB_SEMANTIC;
  calls.length = 0;
});

test("a note found only by meaning comes back weak, via similar meaning; a word match keeps its why", async () => {
  const root = makeBrain();
  expect(core.search(root, "steward", "pedagogy")).toEqual([]); // no word of it in any note
  await on(root);
  const opts = await sem.queryOpts("pedagogy");
  expect(opts.vector).toBeInstanceOf(Float32Array);
  const hits = core.search(root, "steward", "pedagogy", 20, {}, opts);
  const a = hits.find((h) => h.id === "projects/course-a")!;
  expect(a).toBeDefined();
  expect(a).toMatchObject({ matched: [], via: ["similar meaning"], strength: "weak" });
  expect(whyLine(a)).toBe("Matched only by similar meaning, none of your words (weak: check it is what was asked before relying on it)");
  // a word hit keeps the words it matched, as without semantic search
  const course = core.search(root, "steward", "course logistics", 20, {}, await sem.queryOpts("course logistics"));
  expect(course[0]).toMatchObject({ id: "projects/course-a", matched: ["course", "logistics"], strength: "strong" });
  expect(course.find((h) => h.id === "projects/course-a")!.via).not.toContain("similar meaning");
});

test("fusion: a note both rankings find comes before one only words find", async () => {
  const root = makeBrain();
  await on(root);
  // "course" is in both course notes; "pedagogy syllabus" pulls the meaning ranking toward them too.
  const words = core.search(root, "steward", "course coordinator");
  const both = core.search(root, "steward", "course coordinator", 20, {}, await sem.queryOpts("course coordinator"));
  expect(words.map((h) => h.id)).toContain("people/jane-roy");
  expect(both.map((h) => h.id).slice(0, words.length).sort()).toEqual(words.map((h) => h.id).sort());
  // all hits by meaning only: a context pack says none of the words is in the view, so "not in my view" stays reachable
  expect(core.contextPack(root, "steward", "pedagogy", await sem.queryOpts("pedagogy"))).toContain("None of your words is in any note in your view: the notes below are only similar in meaning.");
});

test("a note found only by meaning stays only when it stands out from the rest of the view (G372)", () => {
  const root = makeBrain();
  const ru = loadRules(root);
  const idx = buildIndex(carve(loadBrain(root), ru, grantFor(ru, "steward")), ru);
  expect(idx.docs.length).toBeGreaterThan(4);
  // the query is the first axis; each note gets the cosine asked for
  const at = (c: number) => { const v = new Float32Array(4); v[0] = c; v[1] = Math.sqrt(1 - c * c); return v; };
  const query = at(1);
  const target = idx.docs[0];
  const run = (top: number, rest: number) => {
    const cos = new Map(idx.docs.map((d) => [docText(d), d === target ? top : rest]));
    return rank(idx, "zzqxj", 50, { semantic: { query, vectorOf: (t) => at(cos.get(t) ?? 0) } });
  };
  // well above the view's median: kept, weak, via meaning only
  const kept = run(0.62, 0.45);
  expect(kept.map((h) => h.id)).toEqual([target.id]);
  expect(kept[0]).toMatchObject({ matched: [], via: ["similar meaning"], strength: "weak" });
  // a flat view, as for a question nothing in it answers: no meaning-only hit at all, however high the cosines
  expect(run(0.66, 0.62)).toEqual([]);
  expect(run(0.3, 0.3)).toEqual([]);
});

test("the doors embed the query: MCP search and context_pack, /v1/search and /v1/context", async () => {
  const root = makeBrain();
  await on(root);
  const tok = issueToken(root, "steward");
  const call = async (method: string, path: string, body?: unknown) => (await handle(root, new Request(`http://pb${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${tok}` } }))).text();
  const tool = async (name: string, args: unknown) => JSON.parse(await call("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).result.content[0].text as string;
  expect(await call("GET", "/v1/search?q=pedagogy")).toContain("projects/course-a");
  expect(await call("GET", "/v1/context?topic=pedagogy")).toContain("Matched only by similar meaning");
  const mcp = JSON.parse(await tool("search", { query: "pedagogy" }));
  expect(mcp.why).toContain("The hits are only similar in meaning (weak).");
  expect(mcp.next).toContain("If none of them is what was asked, it isn't in your view.");
  expect(mcp.hits.map((h: { id: string }) => h.id)).toContain("projects/course-a");
  expect(await tool("context_pack", { topic: "pedagogy" })).toContain("Course A");
  expect(calls.flat()).toContain("pedagogy");
  // off by PB_SEMANTIC=0: the doors search by words only, and the query is never embedded
  process.env.PB_SEMANTIC = "0";
  calls.length = 0;
  expect(JSON.parse(await call("GET", "/v1/search?q=pedagogy"))).toEqual([]);
  expect(JSON.parse(await tool("search", { query: "pedagogy" })).hits).toEqual([]);
  expect(calls).toEqual([]);
});

test("contract: with semantic search on, a hidden note or a carved value answers exactly as if it weren't there", async () => {
  // A hidden note's title, searched for: the same answer as on a brain where it is titled with a word that's nowhere.
  const root = makeBrain();
  const renamed = makeBrain();
  const f = join(renamed, "money/main-bank.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("title: Main bank", "title: Zzyzx nowhere"));
  await on(root);
  await sem.fillVectors(renamed, core.visibleTexts(renamed));
  for (const q of ["Main bank", "lender", "banking app cards"]) {
    const o = await sem.queryOpts(q);
    expect(core.search(root, "helper", q, 20, {}, o)).toEqual(core.search(renamed, "helper", q, 20, {}, o));
    expect(core.contextPack(root, "helper", q, o)).toEqual(core.contextPack(renamed, "helper", q, o));
  }
  // Each carved value (rt-search-side-channel): searched here, and on a brain where every note that
  // says it says another, made-up value instead. Helper is shown neither, so its view is the same text
  // in both brains, and the searched value is hidden in one and missing from the other.
  const rules = loadRules(root);
  const carved = carve(loadBrain(root), rules, grantFor(rules, "helper")).carvedValues ?? [];
  expect(carved.length).toBeGreaterThan(0);
  const other = makeBrain();
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.name.startsWith(".") ? [] : e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".md") ? [join(d, e.name)] : []);
  for (const file of walk(other)) { const t = readFileSync(file, "utf8"); const out = carved.reduce((x, v, i) => x.split(v).join(`Qqvwx Zzyzx ${"kmrt"[i % 4]}lorbe`), t); if (out !== t) writeFileSync(file, out); }
  const helperTexts = (r: string) => { const ru = loadRules(r); return buildIndex(carve(loadBrain(r), ru, grantFor(ru, "helper")), ru).docs.map(docText); };
  expect(helperTexts(other)).toEqual(helperTexts(root));
  await sem.fillVectors(other, core.visibleTexts(other));
  for (const v of carved) {
    const o = await sem.queryOpts(v);
    expect(core.search(root, "helper", v, 20, {}, o), v).toEqual(core.search(other, "helper", v, 20, {}, o));
    expect(core.contextPack(root, "helper", v, o), v).toEqual(core.contextPack(other, "helper", v, o));
  }
});

test("vectors live outside the brain: never in a git work tree, never in a brain folder", async () => {
  const root = makeBrain();
  const home = mkdtempSync(join(tmpdir(), "pb-home-"));
  const keep = process.env.HOME;
  process.env.HOME = home;
  delete process.env.PB_VECTOR_DIR;
  try {
    sem.useEmbedder(STUB);
    expect(sem.vectorDir()).toBe(join(home, ".cache", "pocketbrain", "vectors"));
    expect(await sem.fillVectors(root, core.visibleTexts(root))).toBeGreaterThan(0);
    const files = (d: string): string[] => existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)]) : [];
    expect(files(sem.vectorDir()).filter((f) => f.endsWith(".f32")).length).toBeGreaterThan(0);
    // pointed inside the brain (a git work tree), they stay in memory: search works, nothing is written there
    sem.useEmbedder(undefined);
    process.env.PB_VECTOR_DIR = join(root, ".cache", "pocketbrain", "vectors");
    sem.useEmbedder(STUB);
    expect(sem.persistRoot()).toBeUndefined();
    await sem.fillVectors(root, core.visibleTexts(root));
    expect(core.search(root, "steward", "pedagogy", 20, {}, await sem.queryOpts("pedagogy")).length).toBeGreaterThan(0);
    expect(existsSync(join(root, ".cache"))).toBe(false);
    expect(Bun.spawnSync(["git", "status", "--porcelain", "--ignored"], { cwd: root }).stdout.toString()).not.toMatch(/\.cache|\.f32/);
    expect(files(root).filter((f) => f.endsWith(".f32"))).toEqual([]);
    // a brain that isn't a git repo is refused too
    expect(sem.insideRepoOrBrain(join(makeBrain({ git: false }), "vectors"))).toBe(true);
    expect(sem.insideRepoOrBrain(join(home, ".cache", "pocketbrain", "vectors"))).toBe(false);
    // a symlink into a repo is followed (F9): ~/.cache linking into the brain is refused
    const linked = mkdtempSync(join(tmpdir(), "pb-home-"));
    Bun.spawnSync(["ln", "-s", root, join(linked, ".cache")]);
    expect(sem.insideRepoOrBrain(join(linked, ".cache", "pocketbrain", "vectors"))).toBe(true);
  } finally { if (keep === undefined) delete process.env.HOME; else process.env.HOME = keep; }
});

test("a note no view shows any more loses its vector at the next pass", async () => {
  const root = makeBrain();
  const dir = vectors();
  sem.useEmbedder(STUB);
  await core.vectorsReady(root);
  const before = vectorFiles(dir).length;
  expect(before).toBeGreaterThan(0);
  Bun.spawnSync(["git", "-C", root, "rm", "-q", "people/paul-advisor.md"]);
  Bun.spawnSync(["git", "-C", root, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", "rm"]);
  await core.vectorsReady(root);
  expect(vectorFiles(dir).length).toBeLessThan(before);
});

test("forget drops the person's vectors at once, with semantic search on or off (G368)", async () => {
  const root = standingBrain();
  const dir = vectors();
  // the real model's id, so the vectors are the ones a hub with the model off would find
  const REAL: sem.Embedder = { ...STUB, id: "bge-m3-q8" };
  sem.useEmbedder(REAL);
  await core.vectorsReady(root);
  const of = (t: string) => createHash("sha256").update(sem.embedInput(t)).digest("hex");
  const sams = core.visibleTexts(root).filter((t) => t.includes("people/sam-roy`") || t.includes("[[people/sam-roy"));
  expect(sams.length).toBeGreaterThan(0);
  const names = () => new Set(vectorFiles(dir).map((f) => f.replace(/^.*\/|\.f32$/g, "")));
  for (const t of sams) expect(names().has(of(t))).toBe(true);
  sem.useEmbedder(undefined); // off: no model, no embedder
  expect(sem.semanticOn()).toBe(false);
  forgetPerson(root, "people/sam-roy");
  for (const t of sams) expect(names().has(of(t)), t.slice(0, 60)).toBe(false);
  // what every view still shows keeps its vectors
  sem.useEmbedder(REAL);
  const kept = core.visibleTexts(root).map(of).filter((h) => names().has(h));
  expect(kept.length).toBeGreaterThan(0);
});

test("a search never downloads: no model means off, and the loader is told local files only", async () => {
  const empty = mkdtempSync(join(tmpdir(), "pb-models-"));
  process.env.PB_MODEL_DIR = empty;
  const fetched: string[] = [];
  const keep = globalThis.fetch;
  globalThis.fetch = (async (u: unknown) => { fetched.push(String(u)); throw new Error("no network in this test"); }) as unknown as typeof fetch;
  try {
    expect(sem.modelPresent()).toBe(false);
    expect(sem.semanticOn()).toBe(false);
    expect(await sem.queryOpts("anything at all")).toEqual({});
    const root = makeBrain();
    const tok = issueToken(root, "steward");
    expect((await handle(root, new Request("http://pb/v1/search?q=course", { headers: { authorization: `Bearer ${tok}` } }))).status).toBe(200);
    // The real library, asked for the model with an empty model dir: it refuses, and fetches nothing.
    await expect(sem.loadLocalEmbedder()).rejects.toThrow();
    expect(fetched).toEqual([]);
    // What the loader asks of the library: no remote models, local files only, the model dir.
    const seen: unknown[] = [];
    const env: Record<string, unknown> = {};
    const fake = { env, pipeline: async (_task: string, _id: string, o: unknown) => { seen.push({ remote: env.allowRemoteModels, local: env.localModelPath, o }); return async () => ({ dims: [1, 2], data: new Float32Array([1, 0]) }); } };
    await sem.loadLocalEmbedder({ load: async () => fake as never });
    expect(seen).toEqual([{ remote: false, local: empty, o: { dtype: "q8", local_files_only: true } }]);
    expect(env.allowRemoteModels).toBe(false);
  } finally { globalThis.fetch = keep; }
  // Loading the real library and building a brain took just over bun's 5 s default under a busy gate
  // run (6.0 s, twice); the test waits on no timer, so it gets room rather than a rerun.
}, 30_000);

test("doctor says whether semantic search is on, and why not", async () => {
  const { doctor } = await import("../src/doctor");
  const root = makeBrain();
  process.env.PB_MODEL_DIR = mkdtempSync(join(tmpdir(), "pb-models-"));
  const line = async () => (await doctor(root, { offline: true })).find((f) => f.area === "search")!;
  expect(await line()).toMatchObject({ level: "ok", text: expect.stringContaining("semantic search off: no model in") });
  expect((await line()).text).toContain("pocketbrain search setup");
  sem.useEmbedder(STUB);
  expect((await line()).text).toBe("semantic search on (stub)");
  process.env.PB_SEMANTIC = "0";
  expect((await line()).text).toBe("semantic search off (PB_SEMANTIC=0)");
});

test("search setup is a command that needs no brain; anything else after search prints its usage", () => {
  const r = Bun.spawnSync(["bun", "src/cli.ts", "search"], { cwd: join(import.meta.dir, ".."), env: { ...process.env, PB_BRAIN: "" } });
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("search setup");
  expect(r.stderr.toString()).not.toContain("No brain here");
});

test("a model that won't load turns semantic search off, says why, and fetches nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-models-"));
  for (const f of sem.MODEL_FILES) { const p = join(dir, sem.MODEL_ID, f); Bun.spawnSync(["mkdir", "-p", join(p, "..")]); writeFileSync(p, "not a model"); }
  process.env.PB_MODEL_DIR = dir;
  const fetched: string[] = [];
  const keep = globalThis.fetch;
  globalThis.fetch = (async (u: unknown) => { fetched.push(String(u)); throw new Error("no network in this test"); }) as unknown as typeof fetch;
  const err = console.error;
  console.error = () => {};
  try {
    sem.useEmbedder(undefined);
    expect(sem.semanticOn()).toBe(true);
    expect(await sem.embedQuery("course", { waitMs: 30_000 })).toBeUndefined();
    expect(sem.semanticOn()).toBe(false);
    expect(sem.semanticState().why).toContain("didn't load");
    expect(fetched).toEqual([]);
  } finally { globalThis.fetch = keep; console.error = err; }
});

// ---------- the queue (G369) and the background pass (G370) ----------

// An embedder that waits for the test to let each call through.
function gated() {
  const seen: string[][] = [];
  const gates: (() => void)[] = [];
  const e: sem.Embedder = { id: "stub", embed: (xs) => { seen.push(xs); return new Promise((r) => gates.push(() => r(xs.map(vec)))); } };
  const release = async () => { while (gates.length) { gates.shift()!(); await new Promise((r) => setTimeout(r, 5)); } };
  return { e, seen, release };
}

test("a query whose caller gave up is skipped, an agent has one query waiting, and agents take turns (G369)", async () => {
  vectors();
  const g = gated();
  sem.useEmbedder(g.e);
  const busy = sem.embedQuery("first, holds the model", { agent: "a", waitMs: 60_000 });
  await new Promise((r) => setTimeout(r, 5));
  // agent a floods; agent b asks once
  const flood = Array.from({ length: 20 }, (_, i) => sem.embedQuery(`flood ${i}`, { agent: "a", waitMs: 60_000 }));
  const gaveUp = sem.embedQuery("b gave up", { agent: "b", waitMs: 1 });
  await new Promise((r) => setTimeout(r, 20));
  const fromB = sem.embedQuery("from b", { agent: "b", waitMs: 60_000 });
  expect(sem.queuedQueries()).toBe(2); // a's latest and b's, nothing else
  expect(await gaveUp).toBeUndefined();
  await g.release();
  expect(await busy).toBeInstanceOf(Float32Array);
  expect(await fromB).toBeInstanceOf(Float32Array);
  const answered = await Promise.all(flood);
  expect(answered.filter(Boolean).length).toBe(1); // only a's newest ran; the 19 before it gave way
  expect(g.seen.flat()).not.toContain("b gave up");
  expect(g.seen.flat().filter((t) => t.startsWith("flood"))).toEqual(["flood 19"]);
});

test("the query queue is bounded overall, and a query is cut to a question's length (G369)", async () => {
  vectors();
  const g = gated();
  sem.useEmbedder(g.e);
  const hold = sem.embedQuery("hold", { agent: "x", waitMs: 60_000 });
  await new Promise((r) => setTimeout(r, 5));
  const many = Array.from({ length: 20 }, (_, i) => sem.embedQuery(`q ${i}`, { agent: `agent${i}`, waitMs: 60_000 }));
  expect(sem.queuedQueries()).toBe(16);
  expect(await many[19]).toBeUndefined(); // over the bound: words only, at once
  await g.release();
  await hold; await Promise.all(many);
  sem.useEmbedder(g.e);
  const long = sem.embedQuery("x".repeat(5000), { agent: "y", waitMs: 60_000 });
  await new Promise((r) => setTimeout(r, 5));
  await g.release();
  await long;
  expect(g.seen.at(-1)![0].length).toBe(sem.QUERY_CHARS);
});

test("the queue lets the event loop run between model calls (G369)", async () => {
  const root = makeBrain();
  vectors();
  sem.useEmbedder(STUB);
  let ticks = 0, on = true;
  const spin = () => { ticks++; if (on) setImmediate(spin); };
  setImmediate(spin);
  const n = await sem.fillVectors(root, core.visibleTexts(root));
  on = false;
  expect(n).toBeGreaterThan(4); // more than one batch
  expect(ticks).toBeGreaterThan(0);
});

test("only an authenticated write starts a background pass; reads, a request with no token and an MCP read don't (G370)", async () => {
  const root = makeBrain();
  vectors();
  sem.useEmbedder(STUB);
  const tok = issueToken(root, "steward");
  const req = (method: string, path: string, body?: unknown, auth = true) => handle(root, new Request(`http://pb${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: auth ? { authorization: `Bearer ${tok}`, "content-type": "application/json" } : {} }));
  await req("POST", "/", "{}", false);
  await req("POST", "/openapi.json", "{}", false);
  await req("POST", "/v1/remember", { id: "projects/course-a", attribute: "room", value: "B-12" }, false);
  await req("GET", "/v1/search?q=course");
  await req("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { query: "course" } } });
  await req("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect(sem.passScheduled(root)).toBe(false);
  const w = await req("POST", "/v1/remember", { id: "projects/course-a", attribute: "room", value: "B-12", as_of: "2026-10-08", sources: ["agent:steward"] });
  expect(w.status).toBeLessThan(400);
  expect(sem.passScheduled(root)).toBe(true);
});

test("a pass runs only when a commit landed, at most one runs and one waits, and it yields between agents (G370)", async () => {
  const root = makeBrain();
  vectors();
  sem.useEmbedder(STUB);
  let head = "h1", runs = 0, ticks = 0;
  const real = core.passSource(root);
  const src: sem.PassSource = { head: () => head, agents: () => { runs++; return real.agents(); }, texts: (a) => { ticks++; return real.texts(a); } };
  await sem.runPass(root, src);
  expect(runs).toBe(1);
  await sem.runPass(root, src); // HEAD didn't move: nothing to do
  expect(runs).toBe(1);
  head = "h2";
  const all = [sem.runPass(root, src), sem.runPass(root, src), sem.runPass(root, src), sem.runPass(root, src)];
  head = "h3";
  await Promise.all(all);
  expect(runs).toBe(3); // the one that ran, and one more for everything asked while it ran
  // between two agents' carves, other work gets the loop
  let between = 0;
  head = "h4";
  const order: string[] = [];
  const slow: sem.PassSource = { head: () => head, agents: () => ["steward", "planner"], texts: (a) => { order.push(a); return real.texts(a); } };
  const p = sem.runPass(root, slow);
  setImmediate(() => { between = order.length; });
  await p;
  expect(between).toBeLessThan(2);
  expect(ticks).toBeGreaterThan(0);
});

test("each document is embedded alone, so no other text (a hidden one included) can shift its vector", async () => {
  const root = makeBrain();
  vectors();
  sem.useEmbedder(STUB);
  await core.vectorsReady(root);
  expect(calls.length).toBeGreaterThan(1);
  expect(calls.filter((c) => c.length !== 1)).toEqual([]);
});

test("a document already waiting for its vector isn't queued again: N searches embed each text at most once (G373)", async () => {
  const root = makeBrain();
  vectors();
  sem.useEmbedder(STUB);
  const texts = core.visibleTexts(root);
  const distinct = new Set(texts.map((t) => sem.embedInput(t)).filter((x) => x.trim())).size;
  await Promise.all(Array.from({ length: 30 }, () => sem.fillVectors(root, texts, { agent: "helper" })));
  expect(calls.flat().length).toBeLessThanOrEqual(distinct);
});

test("search setup releases every model it loaded before the command exits (the ONNX teardown panic on exit)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-model-"));
  process.env.PB_MODEL_DIR = dir;
  for (const f of sem.MODEL_FILES) { const p = join(dir, sem.MODEL_ID, f); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.endsWith(".json") ? "{}" : "x"); }
  let loaded = 0, released = 0;
  const pipe = Object.assign(async (xs: string[]) => ({ dims: [xs.length, 2], data: new Float32Array(xs.length * 2) }), { dispose: async () => { released++; } });
  const fake = { env: {}, pipeline: async () => { loaded++; return pipe; } } as never;
  const r = await sem.setupModel(() => {}, { load: async () => fake });
  expect(r.already).toBe(true);
  expect(loaded).toBeGreaterThan(0);
  expect(released).toBe(loaded);
});

// On macOS, ONNX Runtime's teardown aborts the process at exit even after every session is
// released, so `search setup` loads the model only in a child process: the child reports before it
// exits, and an abort after its report can't fail the command (or a model never load in the CLI).
// The children stand in for ONNX's abort at exit by killing themselves: a real abort runs bun's
// crash handler, which on GitHub's runner left a process holding the pipe open (both tests timed
// out there, 2026-10-30). What setupInChild sees is the same: a report, then death by a signal.
const DIES = 'process.kill(process.pid, "SIGKILL");'

test("search setup runs the model in a child process and keeps its report through an abort at exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-setup-child-"));
  const child = (body: string) => { const p = join(dir, `c${Math.random().toString(36).slice(2)}.ts`); writeFileSync(p, `import { writeSync } from "node:fs";\n${body}`); return [process.execPath, p]; };
  const got: string[] = [];
  const r = await sem.setupInChild((f) => got.push(f), { cmd: child(`writeSync(1, "got model.onnx\\n"); writeSync(1, 'done {"bytes":5,"already":false}\\n'); ${DIES}`) });
  expect(r).toEqual({ bytes: 5, already: false });
  expect(got).toEqual(["model.onnx"]);
  await expect(sem.setupInChild(() => {}, { cmd: child(`writeSync(1, "got a\\n"); ${DIES}`) })).rejects.toThrow();
  await expect(sem.setupInChild(() => {}, { cmd: child(`writeSync(1, "error no network\\n"); process.exit(1);`) })).rejects.toThrow("no network");
  expect(readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")).not.toMatch(/\bsetupModel\(/);
}, 30_000);

test("search setup keeps the child's teardown panic off the owner's terminal once it has finished", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-setup-quiet-"));
  const child = (body: string) => { const p = join(dir, `c${Math.random().toString(36).slice(2)}.ts`); writeFileSync(p, `import { writeSync } from "node:fs";\n${body}`); return [process.execPath, p]; };
  const shown: string[] = [];
  await sem.setupInChild(() => {}, { cmd: child(`writeSync(1, 'done {"bytes":1,"already":true}\\n'); writeSync(2, "panic: A C++ exception occurred\\n"); ${DIES}`), stderr: (s) => shown.push(s) });
  expect(shown.join("")).not.toContain("panic");
  await expect(sem.setupInChild(() => {}, { cmd: child(`writeSync(2, "model file is corrupt\\n"); process.exit(1);`), stderr: (s) => shown.push(s) })).rejects.toThrow();
  expect(shown.join("")).toContain("model file is corrupt");
}, 30_000);
