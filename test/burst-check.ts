// SPDX-License-Identifier: AGPL-3.0-only
// The burst check (test/burst-property.test.ts): an assistant that writes a script instead of
// asking one thing at a time sends the hub many calls at once, mixed with another assistant's calls
// and with writes landing between its reads. On one made-up brain (test/carve-gen.ts) this sends
// every read the carve property makes (test/carve-check.ts), for every assistant and token, through
// every door, in a seeded order and many at a time, and says what a burst may not change:
//   same      a read whose answer is the same call after call when asked alone gets that same
//             answer in the burst, byte for byte
//   crossed   and never the answer another token gets to the same read (where the two differ)
//   leak      no answer in the burst, with or without writes between the reads, carries a value,
//             name, id or date the leak oracle (evals/lib/oracle.ts) keeps from its reader
//   missing   every fact a reader is owed is in the burst's read of its page
//   refused   a write the checks refuse alone (a password-shaped value, a reserved attribute, a
//             path under rules/) is refused on every call in the burst, in the same words
//   hidden    a write to a page out of the writer's view answers as a write to a page that
//             does not exist
//   author    each value a writer's burst left in the brain is recorded as that writer's, in the
//             page and in the commit, and rules/ is as it was
//   budget    on the default budget a burst from one token gets as many answers as its minute
//             holds and no more, a turned-away call carries nothing, and another token's calls
//             in the same burst are all answered
// It reads and writes only a made-up brain in the run's temp folder.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { type Generated } from "./carve-gen";
import { DOORS, type Door, type Ask, type Leak, argOf, asksFor, open, oracleOf, servedIn, type Session } from "./carve-check";
import { prng } from "./carve-gen";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { loadBrain } from "../src/brain";
import { resetBudgets, DEFAULT_BUDGET } from "../src/budget";
import { carvedFor } from "../evals/lib/oracle";
import { sha256 } from "../src/util";

export interface BurstFinding { kind: "same" | "crossed" | "leak" | "missing" | "refused" | "hidden" | "author" | "rules" | "budget" | "alone"; who: string; what: string }
export interface BurstChecked { findings: BurstFinding[]; readers: number; reads: number; stable: number; writes: number; committed: number; refused: number; turnedAway: number }

interface Reader { agent: string; role: string; token: string; who: string; sessions: Map<Door, Session> }
interface Job { r: Reader; door: Door; ask: Ask; key: string }

const WIDTH = 64; // calls in flight at once
const gitIn = (root: string, args: string[]) => Bun.spawnSync(["git", "-c", "user.name=louis", "-c", "user.email=l@x", "-c", "commit.gpgsign=false", ...args], { cwd: root });

// Every file under rules/, hashed: what a burst of writes may not change.
function rulesHash(root: string): string {
  const out: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d).sort()) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else out.push(`${p.slice(root.length)}\n${readFileSync(p, "utf8")}`); } };
  walk(join(root, "rules"));
  return sha256(out.join("\n\0"));
}

async function inChunks<T>(jobs: T[], run: (j: T) => Promise<void>) {
  for (let i = 0; i < jobs.length; i += WIDTH) await Promise.all(jobs.slice(i, i + WIDTH).map(run));
}
function shuffled<T>(xs: T[], r: ReturnType<typeof prng>): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = r.int(0, i); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
}

async function readersOf(g: Generated, doors: readonly Door[]): Promise<Reader[]> {
  const out: Reader[] = [];
  for (const a of g.agents) for (const role of a.roles) {
    const token = issueToken(g.root, a.name, role === "reader" ? "reader" : undefined);
    const who = `${a.name} (${role} token)`;
    const sessions = new Map<Door, Session>();
    for (const door of doors) sessions.set(door, await open(g.root, door, token, who));
    out.push({ agent: a.name, role, token, who, sessions });
  }
  return out;
}

// One write through a door an assistant writes through: the MCP tool or the API route.
async function remember(root: string, token: string, door: "mcp" | "api", body: Record<string, unknown>): Promise<{ status: number; text: string }> {
  if (door === "api") {
    const res = await handle(root, new Request("http://pb/v1/remember", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
    return { status: res.status, text: await res.text() };
  }
  const res = await handle(root, new Request("http://pb/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "remember", arguments: body } }) }));
  const j = await res.json().catch(() => undefined) as any;
  return { status: res.status, text: (j?.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n") || JSON.stringify(j?.error ?? "") };
}

// The words of a write's answer, less what names that one call: the id it wrote to and the marker.
const shape = (text: string, ...names: string[]) => names.filter(Boolean).reduce((t, n) => t.split(n).join("<it>"), text).replace(/"request_id":\s*"[^"]*"/g, "").replace(/\b[0-9a-f]{7,40}\b/g, "<sha>");

export const markOf = (agent: string, k: number) => `Burstmark ${agent} n${k} Quillon`;

export async function burst(g: Generated, o: { budget?: boolean; doors?: readonly Door[] } = {}): Promise<BurstChecked> {
  const { root, seed } = g;
  const doors = o.doors ?? DOORS;
  const r = prng(seed ^ 0xb075);
  const findings: BurstFinding[] = [];
  const add = (kind: BurstFinding["kind"], who: string, what: string) => findings.push({ kind, who, what });
  resetBudgets();
  let turnedAway = 0;

  // The budget statement first, on the budget the brain came with (the default: no `budget:`).
  if (o.budget !== false) {
    const [a, b] = g.agents;
    const ta = issueToken(root, a!.name), tb = b ? issueToken(root, b.name) : undefined;
    const get = (t: string) => handle(root, new Request("http://pb/v1/orientation", { headers: { authorization: `Bearer ${t}` } }));
    const n = DEFAULT_BUDGET.requests_per_minute + 60;
    const calls = [...Array.from({ length: n }, () => ({ t: ta, mine: true })), ...(tb ? Array.from({ length: 40 }, () => ({ t: tb, mine: false })) : [])];
    const res = await Promise.all(shuffled(calls, r).map(async (c) => { const x = await get(c.t); return { ...c, status: x.status, text: await x.text() }; }));
    const mine = res.filter((x) => x.mine), ok = mine.filter((x) => x.status === 200).length, away = mine.filter((x) => x.status === 429);
    turnedAway = away.length;
    if (ok !== DEFAULT_BUDGET.requests_per_minute || ok + away.length !== n) add("budget", a!.name, `${n} calls at once: ${ok} answered, ${away.length} turned away, with ${DEFAULT_BUDGET.requests_per_minute} a minute allowed`);
    const { scan } = await oracleOf(root, a!.name, "full");
    for (const x of away) if (scan(x.text, { read: "orientation" }).length || x.text.length > 400) { add("budget", a!.name, `a turned-away call carried ${x.text.length} characters`); break; }
    const others = res.filter((x) => !x.mine);
    if (others.some((x) => x.status !== 200)) add("budget", b!.name, `${others.filter((x) => x.status !== 200).length} of its 40 calls were not answered while ${a!.name} was over its budget`);
    resetBudgets();
  }

  // Room for the burst itself: the owner's own budget line, committed as the owner would.
  const pf = join(root, "rules", "policy.yaml");
  const policy = YAML.parse(readFileSync(pf, "utf8"));
  policy.budget = { requests_per_minute: 100_000, writes_per_hour: 100_000 };
  await Bun.write(pf, YAML.stringify(policy));
  gitIn(root, ["add", "rules/policy.yaml"]);
  gitIn(root, ["commit", "-q", "-m", "burst check: room for a burst"]);

  const readers = await readersOf(g, doors);
  const { asks } = asksFor(root);
  const jobs: Job[] = [];
  for (const rd of readers) for (const door of doors) for (const [i, ask] of asks.entries()) jobs.push({ r: rd, door, ask, key: `${rd.who}|${door}|${i}` });
  const askKey = (j: Job) => `${j.door}|${j.key.split("|")[2]}`;
  const tool = (j: Job) => `${j.ask.read}${argOf(j.ask) ? ` ${JSON.stringify(argOf(j.ask))}` : ""} through ${j.door}`;

  // One quiet pass and one burst over a brain nobody is writing to; returns the burst's answers.
  const quietThenBurst = async (label: string) => {
    const oracles = new Map<string, Awaited<ReturnType<typeof oracleOf>>>();
    for (const rd of readers) oracles.set(rd.who, await oracleOf(root, rd.agent, rd.role));
    const alone = new Map<string, string | undefined>();
    for (const j of jobs) alone.set(j.key, await j.r.sessions.get(j.door)!.get(j.ask));
    const got = new Map<string, string | undefined>();
    await inChunks(shuffled(jobs, r), async (j) => { got.set(j.key, await j.r.sessions.get(j.door)!.get(j.ask)); });
    // What each other token gets to the same read, to name a crossed answer as one.
    const byAsk = new Map<string, { who: string; text: string }[]>();
    for (const j of jobs) { const t = alone.get(j.key); if (t !== undefined) byAsk.set(askKey(j), [...(byAsk.get(askKey(j)) ?? []), { who: j.r.who, text: t }]); }
    let reads = 0, stable = 0;
    const pages = new Map<string, string>();
    for (const j of jobs) {
      const t = got.get(j.key), base = alone.get(j.key);
      // The call asked alone is held to the oracle too, so a fault that needs no burst is named as one.
      if (base !== undefined && base !== t) for (const l of oracles.get(j.r.who)!.scan(base, j.ask)) add("alone", j.r.who, `${label}: ${l.kind} "${l.what}" of ${l.from} in ${l.tool} through ${j.door}, asked alone`);
      if (t === undefined) { if (base !== undefined) add("same", j.r.who, `${label}: ${tool(j)} was not answered in the burst`); continue; }
      reads++;
      if (j.ask.read === "read") pages.set(`${j.r.who}|${j.door}|${j.ask.id}`, t);
      for (const l of oracles.get(j.r.who)!.scan(t, j.ask)) add("leak", j.r.who, `${label}: ${l.kind} "${l.what}" of ${l.from} in ${l.tool} through ${j.door}`);
      if (t === base) { stable++; continue; }
      // It differs: asked alone once more. An answer that isn't the same twice when asked alone
      // (none is, today) gives the burst nothing to be held to.
      if (await j.r.sessions.get(j.door)!.get(j.ask) !== base) continue;
      stable++;
      const other = (byAsk.get(askKey(j)) ?? []).find((x) => x.who !== j.r.who && x.text === t && x.text !== base);
      if (other) add("crossed", j.r.who, `${label}: ${tool(j)} came back as the answer ${other.who} gets`);
      else add("same", j.r.who, `${label}: ${tool(j)} differs from the same call asked alone`);
    }
    for (const rd of readers) for (const door of doors) for (const ow of oracles.get(rd.who)!.owed)
      if (!servedIn(pages.get(`${rd.who}|${door}|${ow.id}`), ow.value)) add("missing", rd.who, `${label}: owed ${ow.id}#${ow.attr}, and the burst's read through ${door} did not carry it`);
    return { reads, stable };
  };

  const first = await quietThenBurst("reads only");

  // Writes between the reads. Each full token writes a marker of its own to every page (in its
  // view or not), and sends writes the checks refuse; every reader keeps reading meanwhile.
  const before = new Map<string, Awaited<ReturnType<typeof oracleOf>>>();
  for (const rd of readers) before.set(rd.who, await oracleOf(root, rd.agent, rd.role));
  const rules0 = rulesHash(root);
  const ids = loadBrain(root).map((n) => n.fm.id);
  // Built here, never written whole in a file: a value the secret check refuses.
  const secret = ["pass", "word"].join("") + ": " + ["Tr0ub4dor", "Xk9", "plume"].join("&") + String(seed % 97);
  const writers = readers.filter((x) => x.role === "full");
  interface W { r: Reader; door: "mcp" | "api"; body: Record<string, unknown>; kind: "mark" | "hidden" | "secret" | "reserved" | "rules"; names: string[]; alone?: string; got?: { status: number; text: string } }
  const ws: W[] = [];
  let k = 0;
  for (const w of writers) {
    const { carved } = await carvedFor(root, w.agent);
    const out = new Set(carved.filter((c) => c.whole).map((c) => c.id));
    const src = (n: number) => [`url:https://example.org/${w.agent}/${n}`];
    const door = () => (k % 2 ? "mcp" : "api") as "mcp" | "api";
    // In the everyday run a few pages each way; every page when every door is read.
    const some = (xs: string[]) => o.doors ? shuffled(xs, r).slice(0, 3) : xs;
    for (const id of [...some(ids.filter((id) => !out.has(id))), ...some(ids.filter((id) => out.has(id)))]) { const n = ++k; ws.push({ r: w, door: door(), kind: out.has(id) ? "hidden" : "mark", names: [id, markOf(w.agent, n)], body: { id, attribute: `noted_by_${w.agent}`, value: markOf(w.agent, n), as_of: "2026-01-05", sources: src(n) } }); }
    const mine = ids.filter((id) => !out.has(id));
    for (const id of mine.slice(0, o.doors ? 1 : 3)) {
      { const n = ++k; ws.push({ r: w, door: door(), kind: "secret", names: [id], body: { id, attribute: "detail", value: secret, as_of: "2026-01-05", sources: src(n) } }); }
      { const n = ++k; ws.push({ r: w, door: door(), kind: "reserved", names: [id], body: { id, attribute: "standing", value: "inner", as_of: "2026-01-05", sources: src(n) } }); }
    }
    { const n = ++k; ws.push({ r: w, door: door(), kind: "rules", names: [], body: { id: "rules/policy", attribute: "detail", value: markOf(w.agent, n), as_of: "2026-01-05", sources: src(n) } }); }
  }
  // Alone first: what a refused write is told, and what a write to a page that isn't there is told.
  const nowhere = new Map<string, string>();
  for (const w of ws) {
    if (w.kind === "mark") continue;
    if (w.kind === "hidden") {
      const key = `${w.r.who}|${w.door}`;
      if (!nowhere.has(key)) { const id = "people/nobody-by-this-name"; nowhere.set(key, shape((await remember(root, w.r.token, w.door, { ...w.body, id })).text, id, ...w.names)); }
      w.alone = nowhere.get(key);
    } else w.alone = shape((await remember(root, w.r.token, w.door, w.body)).text, ...w.names);
  }
  const mid: { j: Job; text: string }[] = [];
  type Step = { w: W } | { j: Job };
  const steps: Step[] = shuffled([...ws.map((w) => ({ w })), ...jobs.map((j) => ({ j }))], r);
  await inChunks(steps, async (s) => {
    if ("w" in s) s.w.got = await remember(root, s.w.r.token, s.w.door, s.w.body);
    else { const t = await s.j.r.sessions.get(s.j.door)!.get(s.j.ask); if (t !== undefined) mid.push({ j: s.j, text: t }); }
  });
  let committed = 0, refused = 0;
  for (const w of ws) {
    const t = w.got!;
    const what = `${w.kind} write ${JSON.stringify(w.body.id)} #${w.body.attribute} through ${w.door}`;
    if (t.status >= 500) add("refused", w.r.who, `${what} answered ${t.status}`);
    if (w.kind === "mark") { if (/"outcome":\s*"committed"/.test(t.text)) committed++; continue; }
    if (w.kind === "hidden") { if (shape(t.text, ...w.names) !== w.alone) add("hidden", w.r.who, `${what}: a page out of its view did not answer like a page that isn't there`); continue; }
    refused++;
    if (!/refused|not allowed|error/i.test(t.text) || /"outcome":\s*"(committed|inbox|disputed|noop)"/.test(t.text)) add("refused", w.r.who, `${what} was not refused in the burst`);
    else if (shape(t.text, ...w.names) !== w.alone) add("refused", w.r.who, `${what} was refused in other words than when sent alone`);
  }
  if (rulesHash(root) !== rules0) add("rules", "any", "rules/ changed during the burst of writes");

  // The brain after: each marker is its writer's, in the page and in the commit; the refused value is nowhere.
  const notes = loadBrain(root);
  const recs = (f: any): any[] => !f || typeof f !== "object" ? [] : [...(Array.isArray(f.items) ? f.items : Array.isArray(f.candidates) ? f.candidates : [f]), ...(Array.isArray(f.history) ? f.history : [])];
  const marker = /Burstmark (\w+) n\d+ Quillon/g;
  for (const n of notes) for (const [attr, f] of Object.entries(n.fm.facts ?? {})) for (const rec of recs(f)) {
    for (const m of JSON.stringify(rec.value ?? "").matchAll(marker)) if (rec.by !== m[1]) add("author", m[1]!, `its value on ${n.fm.id}#${attr} is recorded as written by ${rec.by}`);
  }
  const log = gitIn(root, ["log", "--format=%x00%an", "-p", "--no-color"]).stdout.toString();
  for (const c of log.split("\0").slice(1)) {
    const author = c.slice(0, c.indexOf("\n"));
    const added = c.split("\n").filter((l) => l.startsWith("+")).join("\n");
    for (const m of added.matchAll(marker)) if (author !== m[1]) { add("author", m[1]!, `a commit by ${author} added its value`); break; }
    if (added.includes(secret)) add("refused", author, "the refused value is in a commit");
  }
  const files = (d: string): string[] => existsSync(d) ? readdirSync(d).filter((f) => f !== ".git" && f !== ".cells").flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? files(p) : [p]; }) : [];
  for (const f of files(root)) if (readFileSync(f, "utf8").includes(secret)) add("refused", "any", `the refused value is in ${f.slice(root.length + 1)}`);

  // What was read while the writes landed: nothing kept from its reader before the burst, and no
  // writer's marker its reader is kept from now.
  const after = new Map<string, Awaited<ReturnType<typeof oracleOf>>>();
  for (const rd of readers) after.set(rd.who, await oracleOf(root, rd.agent, rd.role));
  for (const { j, text } of mid) {
    const seen = new Set<string>();
    const say = (l: Leak) => { const s = `${l.kind} ${l.what}`; if (!seen.has(s)) { seen.add(s); add("leak", j.r.who, `between writes: ${l.kind} "${l.what}" of ${l.from} in ${l.tool} through ${j.door}`); } };
    for (const l of before.get(j.r.who)!.scan(text, j.ask)) say(l);
    for (const l of after.get(j.r.who)!.scan(text, j.ask)) if (l.kind === "value" && /Burstmark/.test(l.what)) say(l);
  }

  // And once the writes are in: the same quiet-against-burst comparison on the brain as it now is.
  const second = await quietThenBurst("after the writes");
  return { findings, readers: readers.length, reads: first.reads + second.reads + mid.length, stable: first.stable + second.stable, writes: ws.length, committed, refused, turnedAway };
}

export const reportBurst = (g: Generated, f: BurstFinding[]) => !f.length ? "" : `seed ${g.seed} (replay: BURST_SEED=${g.seed} bun test test/burst-property.test.ts)\n` +
  [...new Map(f.map((x) => [`${x.kind} ${x.who} ${x.what}`, x])).values()].slice(0, 14).map((x) => `  [${x.kind}] ${x.who}: ${x.what}`).join("\n") + (f.length > 14 ? `\n  and ${f.length - 14} more` : "");
