#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// One scripted day on a throwaway copy of a brain: what the brain's own model calls cost at
// the default model's list price, and the request volumes a hosted door would see (from the read and
// write logs; the brain itself never meters or bills them):
//   bun scripts/usage-day.ts                       the built-in fake brain
//   bun scripts/usage-day.ts --brain <brain repo>  a git clone of a real brain in a temp folder
// The traffic is scripted (TASKS below), not measured: each agent connects once, then per task
// pulls a topic context, searches twice, reads two notes and writes a journal line; every
// fourth task also writes a fact. Agents mail each other through the relay. At night the
// sleep pass runs with fake models, so token counts are estimated from the real prompts
// (characters / 4) and model minutes are ~0: a live model is needed for real latency.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "../test/fixture";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { formatProblem } from "../src/format";
import { loadRules } from "../src/rules";
import { carve, grantFor } from "../src/carve";
import { loadBrain } from "../src/brain";
import { relayOnce, fileTransport, loadRelayConfig } from "../src/relay";
import { sleep } from "../src/sleep";
import { capture } from "../src/capture";
import { makeModel, routing, type ModelRequest, type Provider } from "../src/model";
import { drainAftercheck, queueAftercheck } from "../src/aftercheck";
import { metered, summary, capState, money, fmtMinutes } from "../src/usage";
import { readEntries } from "../src/readlog";
import { PRICES as LIST_PRICES, priceFor } from "../src/pricing";

// The fake models are priced as the default model would be (src/pricing.ts list price).
const AS = "claude-sonnet-5-5";
const LIST = LIST_PRICES.anthropic![AS];
const PRICES = { model_input_per_million: LIST.input, model_output_per_million: LIST.output };
const CAP = 20;
// Tasks per agent, busiest first, over whichever agents the brain has (outside the wall, not the gardener).
const TASK_COUNTS = [20, 12, 8, 6];
const MAIL = 8;
const CAPTURES = 5; // the owner's quick notes through the day, one model call each

const src = process.argv.includes("--brain") ? process.argv[process.argv.indexOf("--brain") + 1] : undefined;
// A brain newer (or older) than this code is refused, as every pocketbrain command does (src/format.ts).
const fp = src ? formatProblem(src) : undefined;
if (fp) { console.error(fp.text); process.exit(1); }
let root: string;
if (src) {
  root = join(mkdtempSync(join(tmpdir(), "pb-usage-")), "brain");
  Bun.spawnSync(["git", "clone", "-q", src, root]);
} else root = makeBrain();
// --grow N: N extra synthetic people (shared organisation, a few close names) so a small brain
// has the near-duplicate pairs and nearby notes a real one has. Committed like any owner edit.
const grow = process.argv.includes("--grow") ? Number(process.argv[process.argv.indexOf("--grow") + 1]) : 0;
if (grow > 0) {
  const FIRST = ["Alex", "Sam", "Rita", "Marc", "Lea", "Omar", "Ines", "Paul", "Nora", "Theo"], LAST = ["Tremblay", "Gagnon", "Roy", "Cote", "Bouchard", "Gauthier", "Morin", "Lavoie"];
  for (let i = 0; i < grow; i++) {
    const title = `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / 2) % LAST.length]}`;
    const id = `people/grow-${i}`;
    mkdirSync(join(root, "people"), { recursive: true });
    writeFileSync(join(root, `${id}.md`), `---\nid: ${id}\ntype: person\ntitle: ${title}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  org: { value: Northfield University, as_of: 2026-09-01, sources: ["gmail:f000000000000001"], verification: verified-by-source, by: planner, recorded: 2026-10-01 }\n  role: { value: ${i % 3 ? "Lecturer" : "Teaching assistant"}, as_of: 2026-09-01, sources: ["gmail:f000000000000001"], verification: verified-by-source, by: planner, recorded: 2026-10-01 }\n---\nWorks with ${title.split(" ")[0]} on the course.\n`);
  }
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "commit", "-qm", `grow: ${grow} synthetic people`], { cwd: root });
}
process.env.PB_TODAY ??= new Date().toISOString().slice(0, 10);

const pf = join(root, "rules", "policy.yaml");
const doc = YAML.parseDocument(readFileSync(pf, "utf8"));
doc.set("usage", { currency: "USD", prices: PRICES, cap: { monthly: CAP, alert_at: 0.8 } });
writeFileSync(pf, doc.toString());

const rules = loadRules(root);
const notes = loadBrain(root);
const agents = Object.entries(rules.policy.agents).filter(([, a]) => !a.inside_wall && a.role !== "gardener").map(([id]) => id);
const TASKS: Record<string, number> = Object.fromEntries(agents.map((a, i) => [a, TASK_COUNTS[i % TASK_COUNTS.length]]));
const tok = Object.fromEntries(agents.map((a) => [a, issueToken(root, a)]));
const call = async (a: string, method: string, path: string, body?: unknown) =>
  (await handle(root, new Request(`http://pb${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${tok[a]}` } }))).text();
const mcp = (a: string, name: string, args: unknown) => call(a, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

for (const a of agents) {
  const viaMcp = rules.policy.agents[a].transport !== "api";
  const mine = [...carve(notes, rules, grantFor(rules, a)).visible.values()].map((v) => v.note);
  if (!mine.length) continue;
  if (viaMcp) await call(a, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }); // orientation rides in the handshake
  await (viaMcp ? mcp(a, "orientation", {}) : call(a, "GET", "/v1/orientation"));
  for (let t = 0; t < TASKS[a]; t++) {
    const n = mine[t % mine.length], m = mine[(t + 1) % mine.length];
    const word = n.fm.title.split(/\s+/)[0];
    if (viaMcp) {
      await mcp(a, "context_pack", { topic: n.fm.title });
      await mcp(a, "search", { query: word });
      await mcp(a, "search", { query: m.fm.title });
      await mcp(a, "read", { id: n.fm.id });
      await mcp(a, "read", { id: m.fm.id });
    } else {
      await call(a, "GET", `/v1/context?topic=${encodeURIComponent(n.fm.title)}`);
      await call(a, "GET", `/v1/search?q=${encodeURIComponent(word)}`);
      await call(a, "GET", `/v1/search?q=${encodeURIComponent(m.fm.title)}`);
      await call(a, "GET", `/v1/notes/${encodeURIComponent(n.fm.id)}`);
      await call(a, "GET", `/v1/notes/${encodeURIComponent(m.fm.id)}`);
    }
    const journal = { kind: "journal", text: `Worked on ${n.fm.title} for Louis (task ${t + 1})`, sources: ["gmail:f000000000000006"] };
    await (viaMcp ? mcp(a, "remember", journal) : call(a, "POST", "/v1/remember", journal));
    if (t % 4 === 3) {
      const fact = { id: n.fm.id, attribute: "last_contact", value: process.env.PB_TODAY, as_of: process.env.PB_TODAY, sources: ["gmail:f000000000000006"], verification: "verified-by-source" };
      await (viaMcp ? mcp(a, "remember", fact) : call(a, "POST", "/v1/remember", fact));
    }
  }
}

const cfg = loadRelayConfig(root);
const boxes = Object.keys(cfg.agents ?? {}).filter((a) => agents.includes(a));
if (boxes.length > 1) {
  const inc = join(root, "relay", "incoming");
  mkdirSync(inc, { recursive: true });
  for (let i = 0; i < MAIL; i++) {
    const [from, to] = [boxes[i % boxes.length], boxes[(i + 1) % boxes.length]];
    writeFileSync(join(inc, `day-${i}.json`), JSON.stringify({ id: `day-${i}`, from: cfg.agents[from], to: [cfg.relay_address.replace("@", `+${to}@`)], subject: `handoff ${i}`, text: `Picking up the follow-up from this morning's thread (${i}).` }));
  }
  relayOnce(root, fileTransport(root));
}

// The owner's captures during the day (fake extractor, real prompts).
const extractor = metered(root, "capture.extract", makeModel({ provider: "fake", model: "fake-extract", max_sensitivity: "personal" }, { fake: () => JSON.stringify({ facts: [] }) }), "capture");
for (let i = 0; i < CAPTURES; i++) await capture(root, { kind: "text", text: `Note ${i + 1}: call back about the ${notes[i % notes.length].fm.title} follow-up next week.` }, extractor);

// After each fact write: the conflict check and the classifier's second opinion (fake models,
// real prompts; answers shaped like a real model's).
const conflicts = metered(root, "write.conflicts", makeModel({ provider: "fake", model: "fake-conflicts", max_sensitivity: "personal" }, { fake: () => '{"conflict": false, "why": "The new value restates the note."}' }));
const classify = metered(root, "write.classify", makeModel({ provider: "fake", model: "fake-classify", max_sensitivity: "personal" }, { fake: () => '{"third_party_sensitive":{"noul":0.04},"personal_money":{"noul":0.02},"category":{"choice":"none","confidence":0.93}}' }));
// The server already drained the queue with no model configured; queue every committed fact again.
for (const l of readFileSync(join(root, "log", "writes.jsonl"), "utf8").split("\n").filter(Boolean)) {
  const e = JSON.parse(l) as { agent: string; key?: string; outcome: string; kind?: string };
  if (e.outcome === "committed" && e.key?.includes("#")) queueAftercheck(root, e.agent, e.key);
}
doc.set("aftercheck", { conflicts: true, classify: true });
writeFileSync(pf, doc.toString());
await drainAftercheck(root, { conflicts, classify });

// The night: journals -> proposals, near-duplicates -> review. Fake models, real prompts.
const consolidator = makeModel({ provider: "fake", model: "fake-sleep", max_sensitivity: "private" }, { fake: (r: ModelRequest) => JSON.stringify({ facts: [...r.prompt.matchAll(/^(\d+)\. /gm)].slice(0, 3).map((m) => ({ line: Number(m[1]), entity: "x", type: "person", attribute: "role", value: "y", quote: "z" })) }) });
const judge = makeModel({ provider: "fake", model: "fake-judge", max_sensitivity: "personal" }, { fake: (r: ModelRequest) => JSON.stringify({ pairs: [...r.prompt.matchAll(/^Pair (\d+):/gm)].map((m) => ({ i: Number(m[1]), verdict: "different", why: "Different people who share an organisation and a role." })) }) });
await sleep(root, { model: metered(root, "sleep.consolidate", consolidator), judge: metered(root, "upkeep.duplicates", judge) });

const s = summary(root);
const d = s.days.at(-1);
const cap = capState(root);
const reads = readEntries(root);
const writes = readFileSync(join(root, "log", "writes.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { agent: string; at: string });
const count = (xs: { agent: string }[]) => Object.fromEntries(agents.map((a) => [a, xs.filter((x) => x.agent === a).length]));
const [r, w] = [count(reads), count(writes)];
console.log(`One scripted day on ${src ? "a copy of a real brain" : "the built-in fake brain"} (${notes.length} notes), ${process.env.PB_TODAY}, at ${root}`);
console.log(`\nRequests a hosted door would count (never metered by the brain): ${reads.length} reads, ${writes.length} writes, ${boxes.length > 1 ? MAIL : 0} relayed messages`);
for (const a of agents) console.log(`  ${a.padEnd(9)} ${String(r[a]).padStart(4)} reads ${String(w[a]).padStart(3)} writes`);
console.log(`\nModel spend, priced as ${AS} ($${LIST.input}/$${LIST.output} per million tokens in/out; fake models, so output is short and tokens are estimated):`);
if (!d) console.log("  no model calls");
else {
  console.log(`  ${d.calls} calls, ${d.tokens_in}${d.estimated ? "~" : ""} tokens in, ${d.tokens_out}${d.estimated ? "~" : ""} out, ${fmtMinutes(d.seconds)}: ${money(d.cost)}`);
  for (const st of s.steps) console.log(`  ${st.step.padEnd(20)} ${st.calls} call(s) ${st.tokens_in + st.tokens_out}${st.estimated ? "~" : ""} tokens  ${money(st.cost)}`);
  console.log(`  A 30-day month like this: ${money(d.cost * 30)} against a ${money(CAP)} cap (${cap.state})`);
  // The same calls at the model each step is routed to (rules/models.yaml, `pocketbrain models`), and on Haiku.
  const routed = new Map(routing(root).map((x) => [x.step, x]));
  const price = (provider: string, model: string, st: { tokens_in: number; tokens_out: number }) => {
    const p = priceFor(provider as Provider, model);
    return p ? (st.tokens_in * p.input + st.tokens_out * p.output) / 1e6 : undefined;
  };
  console.log("\nPer step at its routed model, and on Haiku (per day; x30 for a month):");
  for (const st of s.steps) {
    const r = routed.get(st.step);
    const now = r ? price(r.provider, r.model, st) : undefined;
    const haiku = price("anthropic", "claude-haiku-5-5", st);
    console.log(`  ${st.step.padEnd(20)} ${String(st.calls).padStart(3)} call(s) ${r ? `${r.provider}/${r.model}`.padEnd(28) : "".padEnd(28)} ${now === undefined ? "  n/a" : money(now).padStart(8)}  haiku ${haiku === undefined ? "n/a" : money(haiku)}`);
  }
}
