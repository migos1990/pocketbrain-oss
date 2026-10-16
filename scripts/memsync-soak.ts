// SPDX-License-Identifier: AGPL-3.0-only
// Memory sync soak (docs/memory-sync.md, "Soak"): 14 simulated days on the sample brain with two
// fake assistants that keep memories of their own. "town" talks MCP (the fixture's helper, a
// trial agent); "instinct" uses the browser door (the fixture's planner, a core agent that
// writes directly). Each day the owner edits, corrects or forgets facts; each night the hub runs
// the sync pass; each morning the owner works through Needs you. Synthetic data only.
//
// Measures: days for a change to reach every assistant's memory, owner cards (Needs you items,
// counted at 30 seconds each), and whether anything wrong sticks, in an assistant's memory or in
// the brain. `bun scripts/memsync-soak.ts` prints the report; test/memsync-soak.test.ts holds the bar.
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "../test/fixture";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { loadBrain, saveNote, type FactRecord } from "../src/brain";
import { records } from "../src/carve";
import { decideProposal } from "../src/write";
import * as ms from "../src/memsync";
import { squash } from "../src/match";

const DAYS = 14;
// Owner minutes per card: a tap, or a fix by hand in the assistant's own settings.
const MINUTES: Record<string, number> = { "memory fix": 0.5, "change to approve": 0.5, "memory fix stuck": 3 };
const POINTER = /in pocketBrain/i;
const day = (d: number) => `2026-11-${String(d).padStart(2, "0")}`;

// The facts the story moves. All in both assistants' slices (area:work, contacts-basic).
const ROLE = { id: "people/jane-roy", attr: "role" };

interface Mem { [about: string]: string }
interface Agent { name: string; door: "mcp" | "browser"; mem: Mem; offline: number[]; style: "pointer" | "value"; cookie?: string; token: string; cantApply?: number }

export interface SoakReport {
  days: number;
  changes: { day: number; about: string; to: string; converged?: number }[];
  cards: { day: number; kind: string; what: string }[];
  ownerMinutes: number;
  stuck: string[];
  notes: string[];
}

const aboutOf = (title: string, attr: string) => `${title}: ${attr.replace(/_/g, " ")}`;

export async function runSoak(opts: { log?: (s: string) => void } = {}): Promise<SoakReport> {
  const log = opts.log ?? (() => {});
  process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-soak-cfg-"));
  process.env.PB_NOW = `${day(1)}T08:00:00Z`;
  const root = makeBrain();
  // instinct gets the browser door, as the owner's `connect --browser` would set it.
  const pf = join(root, "rules/policy.yaml");
  writeFileSync(pf, readFileSync(pf, "utf8").replace(/^  planner: \{ /m, "  planner: { browser: true, "));
  const report: SoakReport = { days: DAYS, changes: [], cards: [], ownerMinutes: 0, stuck: [], notes: [] };

  const note = (id: string) => loadBrain(root).find((n) => n.fm.id === id)!;
  const current = (id: string, attr: string) => { const f = note(id).fm.facts?.[attr]; return f ? records(f).filter((r) => !r.retired && !r.valid_to).map((r) => String(r.value)) : []; };
  // The owner's own edit: the old record goes to history, as the dashboard does it.
  const ownerSet = (id: string, attr: string, value: string, d: number) => {
    const n = note(id);
    const old = n.fm.facts![attr] as FactRecord;
    n.fm.history = { ...(n.fm.history ?? {}), [attr]: [...(n.fm.history?.[attr] ?? []), { ...old, ended_by: { at: day(d), by: "louis" } } as FactRecord] };
    n.fm.facts![attr] = { ...old, value, as_of: day(d), by: "louis", verification: "confirmed-by-louis" } as FactRecord;
    saveNote(root, n);
    report.changes.push({ day: d, about: aboutOf(n.fm.title, attr), to: value });
  };
  const ownerForget = (id: string, attr: string, d: number) => {
    const n = note(id);
    const old = n.fm.facts![attr] as FactRecord;
    n.fm.history = { ...(n.fm.history ?? {}), [attr]: [...(n.fm.history?.[attr] ?? []), { ...old, retired: { at: day(d), by: "louis", why: "no longer true" } } as FactRecord] };
    delete n.fm.facts![attr];
    saveNote(root, n);
    report.changes.push({ day: d, about: aboutOf(n.fm.title, attr), to: "(forgotten)" });
  };

  // A third fact to forget later, added before the assistants copy anything.
  { const n = note("projects/course-a"); n.fm.facts!.room = { value: "Room 101", as_of: day(1), sources: ["gmail:f000000000000003"], verification: "verified-by-source", by: "louis", recorded: day(1) } as FactRecord; saveNote(root, n); }
  // Every fact both assistants can see, as each would have copied it on day 1.
  const course = note("projects/course-a");
  const jane = note(ROLE.id);
  const seed: Mem = {};
  for (const n of [course, jane]) for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
    const v = records(f).find((r) => !r.retired)?.value;
    if (typeof v === "string") seed[aboutOf(n.fm.title, attr)] = v;
  }
  const [NEXT, SECOND] = ["next_step", "room"];
  const ROLE_ABOUT = aboutOf(jane.fm.title, ROLE.attr);

  const agents: Agent[] = [
    { name: "helper", door: "mcp", mem: { ...seed }, offline: [], style: "pointer", token: issueToken(root, "helper") },
    // Off for three days, and it keeps values, not pointers: the harder case.
    { name: "planner", door: "browser", mem: { ...seed }, offline: [5, 6, 7], style: "value", token: issueToken(root, "planner") },
  ];

  const http = async (method: string, path: string, init: { token?: string; cookie?: string; body?: string; form?: boolean } = {}) =>
    handle(root, new Request(`http://pb${path}`, { method, body: init.body, redirect: "manual", headers: {
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.form ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
  const mcp = async (a: Agent, name: string, args: Record<string, unknown> = {}) => {
    const r = await (await http("POST", "/mcp", { token: a.token, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json() as any;
    return JSON.parse(r.result.content[0].text);
  };
  const browserLogin = async (a: Agent) => {
    const r = await http("POST", "/b/login", { body: new URLSearchParams({ agent: a.name, password: a.token }).toString(), form: true });
    a.cookie = r.headers.get("set-cookie")?.split(";")[0];
  };

  // What a well-behaved assistant does at the start of a conversation.
  const answerFor = (a: Agent, question: string) => {
    const m = question.match(/what is (.+?)'s (.+?)\? Answer/);
    const v = m ? a.mem[`${m[1]}: ${m[2]}`] : undefined;
    return v ?? "nothing";
  };
  const applyCheck = (a: Agent, c: ms.Check | any) => {
    const body: ms.Reply = { answers: [], corrections: [] };
    for (const i of c.changes?.items ?? []) {
      if (!(i.about in a.mem)) continue;
      if (i.now === null) delete a.mem[i.about];
      else a.mem[i.about] = a.style === "pointer" ? i.pointer : i.now;
    }
    if (c.changes) body.changes_seen = c.changes.id;
    for (const x of c.corrections ?? []) {
      // Some memory an assistant can't edit itself (a routine, a skill): it says so, once.
      if (a.cantApply) { a.cantApply--; body.corrections!.push({ id: x.id, done: false, note: "it's in a routine I can't edit" }); continue; }
      if (x.kind === "forget") delete a.mem[x.about]; else a.mem[x.about] = x.right;
      body.corrections!.push({ id: x.id, done: true });
    }
    for (const q of c.questions ?? []) body.answers!.push({ id: q.id, answer: answerFor(a, q.question) });
    return body;
  };
  const checkIn = async (a: Agent) => {
    if (a.door === "mcp") {
      const c = await mcp(a, "memory_check");
      const body = applyCheck(a, c);
      await mcp(a, "memory_check_reply", body as Record<string, unknown>);
      return;
    }
    let page = await (await http("GET", "/b/memory-check", { cookie: a.cookie })).text();
    if (/Please sign in/.test(page) || !a.cookie) { await browserLogin(a); page = await (await http("GET", "/b/memory-check", { cookie: a.cookie })).text(); }
    // The browser agent reads the same check through the page; the hub's own view of it is
    // what the page renders, so read it back from memsync to drive the form.
    const c = ms.memoryCheck(root, a.name);
    const body = applyCheck(a, c);
    const csrf = page.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
    const form = new URLSearchParams({ csrf });
    if (body.changes_seen) form.set("changes_seen", body.changes_seen);
    for (const x of body.answers ?? []) form.set(`a:${x.id}`, x.answer);
    for (const x of body.corrections ?? []) form.set(`c:${x.id}`, x.done ? "yes" : "no");
    if (/name="csrf"/.test(page)) await http("POST", "/b/memory-check", { cookie: a.cookie, body: form.toString(), form: true });
  };

  // The owner's morning: every Needs you item about memory is one card.
  const morning = (d: number) => {
    for (const c of ms.state(root).corrections.filter((x) => x.state === "proposed")) {
      report.cards.push({ day: d, kind: "memory fix", what: `${c.agent}: ${c.about} "${c.wrong}"` });
      ms.approve(root, c.id);
    }
    for (const c of ms.state(root).corrections.filter((x) => x.state === "needs-hand" || x.state === "still-wrong")) {
      if (report.cards.some((k) => k.kind === "memory fix stuck" && k.what.startsWith(c.id))) continue;
      report.cards.push({ day: d, kind: "memory fix stuck", what: `${c.id} ${c.agent}: ${c.about}` });
      // The owner fixes it by hand in that assistant (its routine), as the card says.
      const a = agents.find((x) => x.name === c.agent)!;
      if (c.kind === "forget") delete a.mem[c.about]; else a.mem[c.about] = c.right!;
    }
    for (const p of inbox()) {
      report.cards.push({ day: d, kind: "change to approve", what: `${p.request.agent}: ${p.request.id}#${p.request.attribute} = ${p.request.value}` });
      // The owner rejects a value the brain already replaced; anything else is accepted.
      const old = (note(p.request.id).fm.history?.[p.request.attribute] ?? []).some((r) => squash(String(r.value)) === squash(String(p.request.value)));
      decideProposal(root, p.file, old ? "reject" : "accept");
    }
  };
  const inbox = () => {
    const dir = join(root, "inbox");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f: string) => f.endsWith(".yaml")).map((f: string) => ({ file: f, ...YAML.parse(readFileSync(join(dir, f), "utf8")) }));
  };

  for (let d = 1; d <= DAYS; d++) {
    process.env.PB_NOW = `${day(d)}T09:00:00Z`;
    process.env.PB_TODAY = day(d);
    morning(d);
    // The day's story.
    if (d === 2) ownerSet(ROLE.id, ROLE.attr, "Program director", d);
    // Drift: town re-reads an old email thread and its memory goes back to the old role.
    if (d === 4) { agents[0].mem[ROLE_ABOUT] = "Course coordinator"; report.notes.push("day 4: town's memory drifts back to the old role"); }
    // An edit while instinct is offline (days 5 to 7).
    if (d === 5) ownerSet(course.fm.id, NEXT, "Print the final exam", d);
    if (d === 6) {
      // Conflict: instinct, offline since day 5, still holds the old role and writes it back as new.
      const a = agents[1];
      const stale = seed[ROLE_ABOUT];
      const r = await (await http("POST", "/v1/remember", { token: a.token, body: JSON.stringify({ id: ROLE.id, attribute: ROLE.attr, value: stale, as_of: day(d), sources: [`agent:${a.name}`], source_type: "agent_observation" }) })).json() as any;
      report.notes.push(`day 6: instinct wrote its stale role back: ${r.outcome}${r.fails ? ` (${r.fails.map((f: any) => f.check).join(", ")})` : r.message ? ` (${String(r.message).slice(0, 120)})` : ""}`);
    }
    if (d === 8 && SECOND) ownerForget(course.fm.id, SECOND, d);
    if (d === 9) ownerSet(ROLE.id, ROLE.attr, "Dean of programs", d);
    // Instinct's routine copies the previous role back in, and it can't edit that routine itself.
    if (d === 10) { agents[1].mem[ROLE_ABOUT] = "Program director"; agents[1].cantApply = 1; report.notes.push("day 10: instinct's routine holds the previous role"); }
    if (d === 11) {
      // Hub restart: browser sessions live in memory, so instinct is signed out; memsync's state is on disk.
      agents[1].cookie = undefined;
      report.notes.push("day 11: hub restart (browser sessions dropped)");
    }
    if (d === 12) ownerSet(course.fm.id, NEXT, "Publish the grades", d);
    // Conversations: each assistant that is online checks in once.
    for (const a of agents) if (!a.offline.includes(d)) await checkIn(a);
    // Night: the sync pass.
    process.env.PB_NOW = `${day(d)}T23:30:00Z`;
    ms.syncPass(root);
    // Convergence: a change has reached an assistant when its memory no longer holds an older value.
    for (const ch of report.changes) {
      if (ch.converged !== undefined) continue;
      const [title, ...rest] = ch.about.split(": ");
      const n = loadBrain(root).find((x) => x.fm.title === title)!;
      const attr = Object.keys({ ...(n.fm.facts ?? {}), ...(n.fm.history ?? {}) }).find((k) => k.replace(/_/g, " ") === rest.join(": "))!;
      const now = current(n.fm.id, attr).map(squash);
      const ok = agents.every((a) => !(ch.about in a.mem) || POINTER.test(a.mem[ch.about]) || now.includes(squash(a.mem[ch.about])));
      if (ok) ch.converged = d - ch.day;
    }
    log(`day ${d}: ${agents.map((a) => `${a.name} ${JSON.stringify(a.mem)}`).join(" | ")}`);
  }

  // Anything wrong that stuck: in a memory, or in the brain.
  for (const a of agents) for (const [about, v] of Object.entries(a.mem)) {
    if (POINTER.test(v)) continue;
    const [title, ...rest] = about.split(": ");
    const n = loadBrain(root).find((x) => x.fm.title === title);
    const attr = n && Object.keys({ ...(n.fm.facts ?? {}), ...(n.fm.history ?? {}) }).find((k) => k.replace(/_/g, " ") === rest.join(": "));
    const now = n && attr ? current(n.fm.id, attr) : [];
    if (!now.map(squash).includes(squash(v))) report.stuck.push(`${a.name} remembers "${v}" for ${about}; the brain says ${now.length ? `"${now.join(", ")}"` : "nothing"}`);
  }
  const role = current(ROLE.id, ROLE.attr);
  if (role.join() !== "Dean of programs") report.stuck.push(`the brain says Jane Roy's role is "${role.join(", ")}", not the owner's "Dean of programs"`);
  for (const ch of report.changes) if (ch.converged === undefined) report.stuck.push(`${ch.about} → ${ch.to} (day ${ch.day}) never reached every assistant`);
  report.ownerMinutes = report.cards.reduce((n, c) => n + (MINUTES[c.kind] ?? 1), 0);
  // Stuck fixes left open at the end: a card the owner would still see.
  for (const c of ms.state(root).corrections.filter((x) => ["proposed", "approved", "delivered", "applied", "needs-hand", "still-wrong"].includes(x.state)))
    report.stuck.push(`fix ${c.id} for ${c.agent} (${c.about}) still ${c.state} at the end`);
  delete process.env.PB_NOW;
  delete process.env.PB_TODAY;
  return report;
}

if (import.meta.main) {
  const r = await runSoak({ log: process.argv.includes("-v") ? console.log : undefined });
  console.log(`# Memory sync soak, ${r.days} simulated days\n`);
  for (const c of r.changes) console.log(`- day ${c.day}: ${c.about} → ${c.to}: ${c.converged === undefined ? "NOT converged" : `converged in ${c.converged} day(s)`}`);
  console.log(`\nOwner cards: ${r.cards.length} (~${r.ownerMinutes} min)`);
  for (const c of r.cards) console.log(`  - day ${c.day} ${c.kind}: ${c.what}`);
  console.log(`\nStuck: ${r.stuck.length ? "" : "nothing"}`);
  for (const s of r.stuck) console.log(`  - ${s}`);
  for (const n of r.notes) console.log(`note: ${n}`);
  process.exit(r.stuck.length ? 1 : 0);
}
