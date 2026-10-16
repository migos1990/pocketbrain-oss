// SPDX-License-Identifier: AGPL-3.0-only
// Agent memory sync (src/memsync.ts, docs/memory-sync.md): readable memories are scanned, the
// others quizzed, drift becomes corrections the owner decides, and every question and correction
// stays inside the agent's own slice.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { digest } from "../src/digest";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { loadBrain, saveNote } from "../src/brain";
import { loadRules } from "../src/rules";
import { carve, grantFor } from "../src/carve";
import * as ms from "../src/memsync";

const OLD = { as_of: "2026-06-01", sources: ["gmail:f000000000000009"], verification: "verified-by-source" as const, by: "planner", recorded: "2026-06-01" };

beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; delete process.env.PB_NOW; });

// Jane's role changed (Teaching assistant -> Course coordinator); the bank's name changed too,
// and money is withheld from helper.
function brain(): string {
  const root = makeBrain();
  const notes = loadBrain(root);
  const jane = notes.find((n) => n.fm.id === "people/jane-roy")!;
  jane.fm.history = { role: [{ value: "Teaching assistant", ...OLD }] };
  saveNote(root, jane);
  const bank = notes.find((n) => n.fm.id === "money/main-bank")!;
  const attr = Object.keys(bank.fm.facts ?? {})[0];
  bank.fm.history = { [attr]: [{ value: "Old Harbour Savings", ...OLD }] };
  saveNote(root, bank);
  return root;
}

function setPolicy(root: string, patch: (p: any) => void) {
  const f = join(root, "rules/policy.yaml");
  const p = YAML.parse(readFileSync(f, "utf8"));
  patch(p);
  writeFileSync(f, YAML.stringify(p));
}

async function call(root: string, token: string, method: string, path: string, body?: unknown) {
  const res = await handle(root, new Request(`http://pb${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${token}` } }));
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, text, json };
}
const mcp = async (root: string, token: string, name: string, args: Record<string, unknown> = {}) =>
  (await call(root, token, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).json.result;

test("targets come from the agent's own carve: a withheld fact is never asked about", () => {
  const root = brain();
  const rules = loadRules(root);
  const notes = loadBrain(root);
  const keys = (agent: string) => ms.targets(notes, rules, carve(notes, rules, grantFor(rules, agent))).map((t) => t.key);
  expect(keys("helper")).toContain("people/jane-roy#role");
  expect(keys("helper").some((k) => k.startsWith("money/"))).toBe(false);
  expect(keys("steward").some((k) => k.startsWith("money/"))).toBe(true);
  const jane = ms.targets(notes, rules, carve(notes, rules, grantFor(rules, "helper"))).find((t) => t.key === "people/jane-roy#role")!;
  expect(jane.current).toEqual(["Course coordinator"]);
  expect(jane.old).toEqual(["Teaching assistant"]);
  for (const q of ms.quiz(root, "helper", 20)) expect(q.key.startsWith("money/")).toBe(false);
});

test("grading is by rule: old value is drift, current is in sync, nothing is missing", () => {
  const t: ms.Target = { key: "x#role", title: "Jane Roy", names: ["Jane Roy"], attr: "role", current: ["Grade the midterm again"], old: ["Grade the midterm"] };
  expect(ms.grade(t, "Grade the midterm")).toBe("drift");
  expect(ms.grade(t, "She has to grade the midterm again.")).toBe("in-sync");
  expect(ms.grade(t, "nothing")).toBe("missing");
  expect(ms.grade(t, "Plan the final")).toBe("differs");
  expect(ms.grade({ ...t, current: [] }, "I don't know")).toBe("in-sync");
});

test("a readable memory is scanned, and an approved correction rewrites that line, keeps a backup and re-checks", () => {
  const root = brain();
  const dir = mkdtempSync(join(tmpdir(), "pb-mem-"));
  const f = join(dir, "people.md");
  writeFileSync(f, "# People\n\nJane Roy\n- role: Teaching assistant\n- likes tea\n\nPaul is an advisor.\n");
  setPolicy(root, (p) => { p.agents.planner.memory = { files: [dir] }; });
  const found = ms.scan(root, "planner");
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({ file: f, line: 4, key: "people/jane-roy#role", kind: "update", wrong: "Teaching assistant" });
  expect(ms.scan(root, "planner")[0].correction).toBeUndefined(); // proposed once
  expect(readFileSync(f, "utf8")).toContain("Teaching assistant"); // nothing changes before the owner says so
  const out = ms.approve(root, found[0].correction!);
  expect(out).toContain("verified");
  expect(readFileSync(f, "utf8")).toBe("# People\n\nJane Roy\n- role: Course coordinator\n- likes tea\n\nPaul is an advisor.\n");
  expect(existsSync(`${f}.pb-bak-${found[0].correction}`)).toBe(true);
  expect(ms.state(root).corrections[0].state).toBe("verified");
});

test("a declined correction changes nothing; a line edited since the scan is left for the owner", () => {
  const root = brain();
  const dir = mkdtempSync(join(tmpdir(), "pb-mem-"));
  const f = join(dir, "jane.md");
  writeFileSync(f, "Jane Roy is our Teaching assistant.\n");
  setPolicy(root, (p) => { p.agents.planner.memory = { files: [f] }; });
  const [a] = ms.scan(root, "planner");
  expect(ms.decline(root, a.correction!)).toContain("declined");
  expect(readFileSync(f, "utf8")).toBe("Jane Roy is our Teaching assistant.\n");
  const root2 = brain();
  setPolicy(root2, (p) => { p.agents.planner.memory = { files: [f] }; });
  const [b] = ms.scan(root2, "planner");
  writeFileSync(f, "Jane Roy is our teaching aide.\n");
  expect(ms.approve(root2, b.correction!)).toContain("by hand");
  expect(readFileSync(f, "utf8")).toBe("Jane Roy is our teaching aide.\n");
});

test("an opaque agent is quizzed through its own door; drift goes to the owner, signed corrections come back, and a re-quiz verifies", async () => {
  const root = brain();
  const tok = issueToken(root, "helper");
  ms.quiz(root, "helper", 1, ["people/jane-roy#role"]);
  const check = await call(root, tok, "GET", "/v1/memory-check");
  expect(check.status).toBe(200);
  expect(check.json.questions).toHaveLength(1);
  expect(check.json.questions[0].question).toContain("Jane Roy's role");
  expect(check.json.questions[0].question).not.toContain("Course coordinator"); // the question never gives the answer away
  const ans = await call(root, tok, "POST", "/v1/memory-check", { answers: [{ id: check.json.questions[0].id, answer: "She's a Teaching assistant" }] });
  expect(ans.json.answers[0].result).toBe("thanks"); // the verdict is the owner's
  const [c] = ms.state(root).corrections;
  expect(c).toMatchObject({ agent: "helper", kind: "update", wrong: "Teaching assistant", right: "Course coordinator", state: "proposed" });
  expect((await call(root, tok, "GET", "/v1/memory-check")).json.corrections).toHaveLength(0); // not before the owner approves
  ms.approve(root, c.id);

  const got = await mcp(root, tok, "memory_check");
  const body = JSON.parse(got.content[0].text);
  expect(body.corrections).toHaveLength(1);
  const fix = body.corrections[0];
  expect(fix.instruction).toContain("Course coordinator");
  const full = ms.state(root).corrections[0];
  expect(ms.verifyCorrection(full, body.signed_by)).toBe(true);
  expect(ms.verifyCorrection({ ...full, right: "Dean" }, body.signed_by)).toBe(false); // a tampered copy fails

  const done = await mcp(root, tok, "memory_check_reply", { corrections: [{ id: fix.id, done: true }] });
  expect(done.content[0].text).toContain("asked about it again");
  const again = (await call(root, tok, "GET", "/v1/memory-check")).json;
  expect(again.corrections).toHaveLength(0);
  expect(again.questions).toHaveLength(1);
  await call(root, tok, "POST", "/v1/memory-check", { answers: [{ id: again.questions[0].id, answer: "Course coordinator" }] });
  expect(ms.state(root).corrections[0].state).toBe("verified");
});

test("an agent can't answer another agent's questions or take its corrections", async () => {
  const root = brain();
  const [q] = ms.quiz(root, "helper", 1, ["people/jane-roy#role"]);
  const planner = issueToken(root, "planner");
  const r = await call(root, planner, "POST", "/v1/memory-check", { answers: [{ id: q.id, answer: "Teaching assistant" }], corrections: [{ id: "fix-00000000", done: true }] });
  expect(r.json.answers[0].result).toBe("no such open question");
  expect(r.json.corrections[0].result).toBe("no such correction waiting");
  expect(ms.state(root).corrections).toHaveLength(0);
});

test("the gardener runs the pass and sees counts only; it has no memory_check of its own; a paused agent isn't quizzed", async () => {
  const root = brain();
  process.env.PB_NOW = "2026-10-08T07:30:00Z"; // in the gardener's window
  setPolicy(root, (p) => { p.agents.planner.status = "paused"; });
  const g = issueToken(root, "gardener");
  const r = await mcp(root, g, "memory_sync");
  const out = JSON.parse(r.content[0].text);
  expect(Object.keys(out.agents).sort()).toEqual(["helper", "steward"]);
  expect(out.agents.helper.quizzed).toBeGreaterThan(0);
  expect(r.content[0].text).not.toContain("Teaching assistant");
  expect((await mcp(root, g, "memory_check")).isError).toBe(true);
  const h = issueToken(root, "helper");
  expect((await mcp(root, h, "memory_sync")).isError).toBe(true);
});

test("a fact copied into a readable memory gets a pointer proposal; approved, the line points at the brain", () => {
  const root = brain();
  const dir = mkdtempSync(join(tmpdir(), "pb-mem-"));
  const f = join(dir, "people.md");
  writeFileSync(f, "Jane Roy\n- role: Course coordinator\n- likes tea\n");
  setPolicy(root, (p) => { p.agents.planner.memory = { files: [dir] }; });
  const found = ms.pointers(root, "planner").filter((x) => x.key === "people/jane-roy#role");
  expect(found).toHaveLength(1);
  expect(readFileSync(f, "utf8")).toContain("Course coordinator"); // nothing before the owner says so
  expect(ms.approve(root, found[0].correction!)).toContain("verified");
  expect(readFileSync(f, "utf8")).toBe("Jane Roy\n- role: in pocketBrain (people/jane-roy)\n- likes tea\n");
  expect(ms.pointers(root, "planner").filter((x) => x.key === "people/jane-roy#role")).toHaveLength(0);
});

test("brain first: a write with no read of that note (or a search) shortly before is flagged for the owner", async () => {
  const root = brain();
  const { write } = await import("../src/write");
  const core = await import("../src/core");
  const req = { kind: "fact" as const, attribute: "next_step", as_of: "2026-10-07", sources: ["gmail:f000000000000006"], verification: "verified-by-source" as const };
  write(root, { ...req, agent: "planner", id: "projects/course-a", value: "Print the midterm" });
  core.readNote(root, "helper", "projects/course-a");
  write(root, { ...req, agent: "helper", id: "projects/course-a", value: "Publish grades" });
  const r = ms.brainFirst(root);
  expect(r.find((u) => u.agent === "planner")!.unread.map((x) => x.key)).toEqual(["projects/course-a#next_step"]);
  expect(r.find((u) => u.agent === "helper")!.unread).toHaveLength(0);
});

test("the standing instruction keeps facts in the brain and points the agent at memory_check", async () => {
  const { standingInstruction } = await import("../src/orientation");
  for (const t of ["mcp", "api"] as const) {
    const s = standingInstruction(loadRules(brain()), t, "https://brain.example");
    expect(s).toContain("keep only a pointer");
    expect(s).toContain(t === "mcp" ? "memory_check" : "/v1/memory-check");
  }
});

test("the digest lists memory corrections waiting on the owner, and ones that need a hand fix", () => {
  const root = makeBrain();
  const log = (e: Record<string, unknown>) => { mkdirSync(join(root, "log"), { recursive: true }); appendFileSync(join(root, "log", "memsync.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n"); };
  log({ ev: "correction", id: "fix-aaaa", agent: "planner", key: "projects/course-a#day", kind: "update", about: "Course A: day", wrong: "Tuesdays", right: "Thursdays", from: { file: "/x/MEMORY.md", line: 3 } });
  log({ ev: "correction", id: "fix-bbbb", agent: "helper", key: "people/sam#city", kind: "forget", about: "Sam: city", wrong: "Lyon", from: {} });
  log({ ev: "correction", id: "fix-cccc", agent: "helper", key: "people/sam#job", kind: "update", about: "Sam: job", wrong: "nurse", right: "doctor", from: { file: "/x/m.md", line: 1 } });
  log({ ev: "approved", id: "fix-cccc", signature: "s" });
  log({ ev: "needs-hand", id: "fix-cccc", note: "line 1 of /x/m.md changed since the scan" });
  log({ ev: "correction", id: "fix-dddd", agent: "helper", key: "people/sam#age", kind: "update", about: "Sam: age", wrong: "40", right: "41", from: {} });
  log({ ev: "declined", id: "fix-dddd" });
  const t = digest(root).text;
  expect(t).toContain("**Memory correction** fix-aaaa for planner (Course A: day): its memory says \"Tuesdays\", the brain says \"Thursdays\". `memsync approve fix-aaaa` or `memsync decline fix-aaaa`.");
  expect(t).toContain("**Memory correction** fix-bbbb for helper (Sam: city): its memory still has \"Lyon\", which the brain forgot.");
  expect(t).toContain("**Memory fix by hand** fix-cccc for helper: line 1 of /x/m.md changed since the scan");
  expect(t).not.toContain("fix-dddd");
});

test("live: a change in the brain reaches the agent at its next memory_check, inside its slice, signed, until it confirms; then it's checked", async () => {
  const root = brain();
  const tok = issueToken(root, "helper");
  const check = async () => JSON.parse((await mcp(root, tok, "memory_check")).content[0].text);
  expect((await check()).changes).toBeUndefined(); // the first check only records what the agent is shown from now on

  // Robin's brain changes Jane's role, and the bank (withheld from helper).
  const notes = loadBrain(root);
  const jane = notes.find((n) => n.fm.id === "people/jane-roy")!;
  const was = jane.fm.facts!.role as any;
  jane.fm.history = { role: [...(jane.fm.history?.role ?? []), { ...was }] };
  jane.fm.facts!.role = { ...was, value: "Program director", as_of: "2026-10-14" };
  saveNote(root, jane);
  const bank = notes.find((n) => n.fm.id === "money/main-bank")!;
  const attr = Object.keys(bank.fm.facts ?? {})[0];
  (bank.fm.facts![attr] as any).value = "New Harbour Bank";
  saveNote(root, bank);

  const c = await check();
  expect(c.changes.items).toEqual([{ key: "people/jane-roy#role", about: "Jane Roy: role", now: "Program director", was: ["Teaching assistant", "Course coordinator"], as_of: "2026-10-14", pointer: "in pocketBrain (people/jane-roy)" }]);
  expect(JSON.stringify(c)).not.toContain("Harbour"); // nothing outside its slice
  const feed = { id: c.changes.id, agent: "helper", items: c.changes.items, issued: c.changes.issued, signature: c.changes.signature };
  expect(ms.verifyFeed(feed, c.signed_by)).toBe(true);
  expect(ms.verifyFeed({ ...feed, items: [{ ...feed.items[0], now: "Dean" }] }, c.signed_by)).toBe(false);
  expect((await check()).changes.id).toBe(c.changes.id); // the same list until the agent confirms it

  const planner = issueToken(root, "planner");
  expect((await call(root, planner, "POST", "/v1/memory-check", { changes_seen: c.changes.id })).json.changes_seen).toContain("no such change list");
  const seen = await mcp(root, tok, "memory_check_reply", { changes_seen: c.changes.id });
  expect(seen.content[0].text).toContain("up to date");
  const after = await check();
  expect(after.changes).toBeUndefined();
  expect(after.questions.map((q: any) => q.question)).toEqual([expect.stringContaining("Jane Roy's role")]);
  // It kept a pointer, as the standing instruction asks: that's in sync, nothing for Robin.
  await mcp(root, tok, "memory_check_reply", { answers: [{ id: after.questions[0].id, answer: "in pocketBrain (people/jane-roy)" }] });
  expect(ms.state(root).quizzes.at(-1)!.verdict).toBe("in-sync");
  expect(ms.state(root).corrections).toHaveLength(0);
});

// Slice audit of G18: questions and corrections were made from the agent's whole slice, so a
// reader token (below private) must not be handed the private ones.
test("a reader token gets no question or correction about a private fact; the no-role token still does", async () => {
  const root = brain();
  const attr = Object.keys(loadBrain(root).find((n) => n.fm.id === "money/main-bank")!.fm.facts ?? {})[0];
  const full = issueToken(root, "steward"), reader = issueToken(root, "steward", "reader");
  ms.quiz(root, "steward", 2, [`money/main-bank#${attr}`, "people/jane-roy#role"]);
  const qs = (await call(root, full, "GET", "/v1/memory-check")).json.questions;
  const bankQ = qs.find((q: any) => /bank/i.test(q.question));
  await call(root, full, "POST", "/v1/memory-check", { answers: [{ id: bankQ.id, answer: "Old Harbour Savings" }] });
  ms.approve(root, ms.state(root).corrections[0].id);
  const r = (await call(root, reader, "GET", "/v1/memory-check")).json;
  expect(JSON.stringify(r)).not.toMatch(/Maple Trust|Old Harbour|bank/i);
  expect(r.questions.length).toBe(1);
  expect((await call(root, full, "GET", "/v1/memory-check")).json.corrections[0].instruction).toContain("Maple Trust");
});

test("a read-only agent can read its memory check but not reply to it (G50)", () => {
  const root = makeBrain();
  const p = join(root, "rules/policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace("helper: { tier: trial,", "helper: { tier: trial, status: read-only,"));
  expect(() => ms.memoryCheck(root, "helper")).not.toThrow();
  expect(() => ms.memoryReply(root, "helper", { memory_dump: { id: "x", text: "Robin likes tea" }, answers: [{ id: "q", answer: "a" }] })).toThrow("read-only");
});

// G74 (red team beliefs #1): a visible fact whose value carries a carved value or a link to a
// hidden note is scrubbed on the read path; memory sync must hand the agent the same scrubbed text.
const LEAKY = "Course coordinator, paid via Maple Trust Bank, see [[money/main-bank]]";
function leaky(root: string) {
  const jane = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
  (jane.fm.facts as any).role.value = LEAKY;
  saveNote(root, jane);
}

test("g74: a correction never carries a value or note id withheld from the agent", () => {
  const root = brain();
  leaky(root);
  const [q] = ms.quiz(root, "helper", 1, ["people/jane-roy#role"]);
  ms.memoryReply(root, "helper", { answers: [{ id: q.id, answer: "Teaching assistant" }] });
  const c = ms.state(root).corrections.find((x) => x.agent === "helper")!;
  ms.approve(root, c.id);
  const out = JSON.stringify(ms.memoryCheck(root, "helper"));
  expect(out).not.toContain("Maple Trust");
  expect(out).not.toContain("money/main-bank");
  expect(out).toContain("[withheld]");
});

test("g74: a correction made before the fix with a raw value is held back, not delivered", () => {
  const root = brain();
  const [q] = ms.quiz(root, "helper", 1, ["people/jane-roy#role"]);
  ms.memoryReply(root, "helper", { answers: [{ id: q.id, answer: "Teaching assistant" }] });
  const c = ms.state(root).corrections.find((x) => x.agent === "helper")!;
  leaky(root); // the log line now stands in for one written by the old code
  appendFileSync(join(root, "log", "memsync.jsonl"), JSON.stringify({ ev: "correction", id: "fix-old", agent: "helper", key: c.key, kind: "update", about: c.about, wrong: "Teaching assistant", right: LEAKY, from: {}, at: new Date().toISOString() }) + "\n");
  // approve() now declines it (G187: not what the brain says in helper's view); one approved by the old code:
  expect(ms.approve(root, "fix-old")).toContain("declined");
  appendFileSync(join(root, "log", "memsync.jsonl"), JSON.stringify({ ev: "correction", id: "fix-old2", agent: "helper", key: c.key, kind: "update", about: c.about, wrong: "Teaching assistant", right: LEAKY, from: {}, at: new Date().toISOString() }) + "\n" + JSON.stringify({ ev: "approved", id: "fix-old2", issued: new Date().toISOString(), signature: "x", at: new Date().toISOString() }) + "\n");
  const out = JSON.stringify(ms.memoryCheck(root, "helper"));
  expect(out).not.toContain("Maple Trust");
  expect(out).not.toContain("money/main-bank");
  expect(ms.state(root).corrections.find((x) => x.id === "fix-old")!.state).toBe("declined");
  expect(ms.state(root).corrections.find((x) => x.id === "fix-old2")!.state).toBe("needs-hand");
});

test("g74: the change feed shows the scrubbed value, and an open feed with a raw value is replaced", () => {
  const root = brain();
  ms.memoryCheck(root, "helper"); // baseline
  leaky(root);
  const out = JSON.stringify(ms.memoryCheck(root, "helper").changes);
  expect(out).toContain("Course coordinator");
  expect(out).not.toContain("Maple Trust");
  expect(out).not.toContain("money/main-bank");
});

// G76 (red team beliefs #3): a symlink in an agent's memory folder must not pull a brain note in.
test("g76: the memory walk skips symlinks, so a linked brain note is never scanned, copied or written", () => {
  const root = brain();
  const dir = mkdtempSync(join(tmpdir(), "pb-mem-"));
  const { symlinkSync } = require("node:fs");
  symlinkSync(join(root, "money", "main-bank.md"), join(dir, "notes.md"));
  symlinkSync(join(root, "people"), join(dir, "people"));
  writeFileSync(join(dir, "own.md"), "Jane is a Teaching assistant.\n");
  setPolicy(root, (p) => { p.agents.planner.memory = { files: [dir] }; });
  expect(ms.memoryFiles(loadRules(root), "planner")).toEqual([join(dir, "own.md")]);
  const before = readFileSync(join(root, "money", "main-bank.md"), "utf8");
  for (const c of ms.state(root).corrections) ms.approve(root, c.id);
  ms.scan(root, "planner");
  for (const c of ms.state(root).corrections.filter((x) => x.state === "proposed")) ms.approve(root, c.id);
  expect(readFileSync(join(root, "money", "main-bank.md"), "utf8")).toBe(before);
  expect(require("node:fs").readdirSync(dir).filter((f: string) => f.includes("pb-bak")).every((f: string) => f.startsWith("own.md"))).toBe(true);
});

test("g76: a correction whose file became a symlink after the scan is not applied through it", () => {
  const root = brain();
  const dir = mkdtempSync(join(tmpdir(), "pb-mem-"));
  const f = join(dir, "own.md");
  writeFileSync(f, "Jane is a Teaching assistant.\n");
  setPolicy(root, (p) => { p.agents.planner.memory = { files: [dir] }; });
  ms.scan(root, "planner");
  const c = ms.state(root).corrections.find((x) => x.agent === "planner" && x.state === "proposed")!;
  const target = join(mkdtempSync(join(tmpdir(), "pb-elsewhere-")), "secret.md"); // a file the agent doesn't own
  const { renameSync, symlinkSync } = require("node:fs");
  renameSync(f, f + ".moved");
  writeFileSync(target, "Jane is a Teaching assistant.\nAccount 0042\n");
  symlinkSync(target, f);
  const before = readFileSync(target, "utf8");
  ms.approve(root, c.id);
  expect(readFileSync(target, "utf8")).toBe(before);
  expect(ms.state(root).corrections.find((x) => x.id === c.id)!.state).toBe("needs-hand");
});

test("a fix the agent couldn't apply isn't proposed again for the same drift, and clears once the agent answers right", async () => {
  const root = brain();
  const tok = issueToken(root, "helper");
  const ask = async (answer: string) => {
    ms.quiz(root, "helper", 1, ["people/jane-roy#role"]);
    const q = (await call(root, tok, "GET", "/v1/memory-check")).json.questions[0];
    await call(root, tok, "POST", "/v1/memory-check", { answers: [{ id: q.id, answer }] });
  };
  await ask("Teaching assistant");
  const [c] = ms.state(root).corrections;
  ms.approve(root, c.id);
  const fix = (await call(root, tok, "GET", "/v1/memory-check")).json.corrections[0];
  await call(root, tok, "POST", "/v1/memory-check", { corrections: [{ id: fix.id, done: false, note: "in a routine I can't edit" }] });
  expect(ms.state(root).corrections[0].state).toBe("needs-hand");
  await ask("Teaching assistant"); // the same drift, found again by the nightly quiz
  expect(ms.state(root).corrections).toHaveLength(1); // no second card for the owner
  await ask("Course coordinator"); // fixed by hand
  expect(ms.state(root).corrections[0].state).toBe("verified");
});

// Docs sweep b20-21: a fact whose only live value is withheld or redacted is still held; sync
// must not read it as gone and tell the agent to forget it.
test("a fact held only as [withheld]/[[redacted]] is never quizzed as gone or corrected to forget", () => {
  const root = brain();
  const jane = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
  (jane.fm.facts as any).role.value = "[[money/main-bank]]";
  (jane.fm as any).history = { role: [{ value: "Teaching assistant", as_of: "2026-01-01", sources: ["gmail:f000000000000001"], verification: "verified-by-source", by: "planner", recorded: "2026-01-02" }] };
  saveNote(root, jane);
  const qs = ms.quiz(root, "helper", 1, ["people/jane-roy#role"]);
  if (qs.length) ms.memoryReply(root, "helper", { answers: [{ id: qs[0].id, answer: "Teaching assistant" }] });
  expect(ms.state(root).corrections.filter((x) => x.agent === "helper" && x.kind === "forget")).toEqual([]);
});
