// SPDX-License-Identifier: AGPL-3.0-only
// The north-star eval (scripts/north-star.ts, outside review 2026-10-25): a replayed week of 50
// facts with 3 planted contradictions; pass = exactly 3 asks and >= 80% of touched pages with cited
// prose and an inbound link. The gate prints it and, with NORTH_STAR_BLOCKING on, blocks on a fail.
import { test, expect } from "bun:test";
import { week, citedProse, inboundLinks } from "../scripts/north-star";
import { northStarVerdict, NORTH_STAR_BLOCKING } from "../scripts/gate";
import type { Note } from "../src/brain";

const note = (id: string, body: string, title = id): Note => ({ path: `${id}.md`, fm: { id, type: "person", title, status: "active" } as never, body } as Note);

test("the fixed week is 50 facts, 3 of them planted contradictions on the same day as the value they contradict", () => {
  const w = week();
  expect(w.length).toBe(50);
  const planted = w.filter((f) => f.planted);
  expect(planted.length).toBe(3);
  for (const p of planted) expect(w.some((f) => !f.planted && f.day === p.day && f.entity === p.entity && f.attribute === p.attribute && f.value !== p.value && f.from !== p.from)).toBe(true);
  expect(new Set(w.map((f) => f.sentence)).size).toBe(50);
});

test("cited prose needs a sentence and a footnote naming a source; a link from another page counts as inbound", () => {
  expect(citedProse(note("people/ana", "Ana Diaz is the program director at North College.[^1]\n\n[^1]: gmail:f000000000000001"))).toBe(true);
  expect(citedProse(note("people/ana", "Ana Diaz is the program director at North College."))).toBe(false);
  expect(citedProse(note("people/ana", "[^1]: gmail:f000000000000001"))).toBe(false);
  const links = inboundLinks([note("people/ana", "Works with [[people/ben]]."), note("people/ben", "See [[people/ben]] and [[Ana]].", "Ben"), note("people/cy", "x", "Ana")]);
  expect(links.get("people/ben")).toBe(1);
  expect(links.get("people/cy")).toBe(1);
});

test("the gate blocks on the north star now that the honest replay passes (audit v3)", () => {
  expect(NORTH_STAR_BLOCKING).toBe(true);
  expect(northStarVerdict(1, false)).toBeUndefined();
  expect(northStarVerdict(0, true)).toBeUndefined();
  expect(northStarVerdict(1, true)).toContain("north star");
});

// Re-audit 2026-10-25: the Gardener made 0 commits since the review and 0 of 1,434 commits said why.
// The north star prints both, for the replay and the real brain (report-only, not in pass).
test("the north star counts commits, the Gardener's, and those that say why", async () => {
  const { makeBrain } = await import("./fixture");
  const { git } = await import("../src/git");
  const { whyCounts } = await import("../scripts/north-star");
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = makeBrain();
  const since = new Date(Date.now() - 60_000).toISOString();
  const g = (a: string) => a === "gardener";
  const before = whyCounts(root, since, g);
  writeFileSync(join(root, "a.md"), "a"); git(root, ["add", "a.md"]); git(root, ["commit", "-qm", "planner: x"], "planner");
  writeFileSync(join(root, "b.md"), "b"); git(root, ["add", "b.md"]); git(root, ["commit", "-qm", "gardener: wiki page\n\nWhy: three new facts about her role since the last summary"], "gardener");
  const c = whyCounts(root, since, g);
  expect({ commits: c.commits - before.commits, with_why: c.with_why - before.with_why, gardener: c.gardener - before.gardener, gardener_why: c.gardener_why - before.gardener_why }).toEqual({ commits: 2, with_why: 1, gardener: 1, gardener_why: 1 });
});

// A fresh init's shipped defaults: the hub's planned saves all land (2026-10-25, 83 were refused
// "unknown agent instinct" because the capture agent wasn't in a new brain's policy).
test("north star: on a fresh init the replay's planned saves are never refused", async () => {
  const { replay } = await import("../scripts/north-star");
  const m = await replay();
  expect(m.notes.filter((n) => /planned save\(s\) refused/.test(n))).toEqual([]);
}, 120_000);

// The replay's own setup never counts as an ask, and every planted contradiction reaches the owner
// as one (2026-10-26, G431: a "rules/ changed outside git" card stood in for a planted conflict the
// hub had logged held and then dropped).
test("north star: the replay's asks are the planted contradictions, none of its own setup", async () => {
  const { replay } = await import("../scripts/north-star");
  const m = await replay();
  expect(m.asks_by_kind.rules).toBeUndefined();
  expect(m.asks).toBe(m.planted);
  // Audit v3 (2026-10-26): the count matched by luck once, so each ask is checked against its fact.
  const planted = ["people/ben-okafor#role", "people/dev-patel#org", "projects/spring-course#next_step"];
  expect([...m.asked].sort()).toEqual(planted);
  expect(m.not_conflict).toBe(0);
  // Audit v4: the Dev Patel pair used to land on a page made private by an org named "Hill School",
  // and so reached only the old deck as a card. Each planted contradiction is a conflict now, and the
  // owner's home (the only screen that asks) lists each one once.
  expect(m.asks_by_kind).toEqual({ dispute: 3 });
  expect([...m.home_asked].sort()).toEqual(planted);
  // Day 8 (phone UI spec §11): the owner's own correction files and adds no ask.
  expect(m.owner_corrected).toBe(true);
  expect(m.notes.filter((n) => /nobody contradicted|not asked exactly once/.test(n))).toEqual([]);
}, 120_000);

// Audit v3: --brain always exited 0, so nothing could ever block on the real brain's numbers.
test("north star --brain exits 1 when the brain misses the bar, and says why", () => {
  const { makeBrain } = require("./fixture") as typeof import("./fixture");
  const root = makeBrain();
  const r = Bun.spawnSync(["bun", "scripts/north-star.ts", "--brain", root], { stdout: "pipe", stderr: "pipe" });
  expect(r.stdout.toString()).toContain("north star (real brain");
  expect(r.stdout.toString()).toContain("FAIL");
  expect(r.exitCode).toBe(1);
});

// Audit v4: "pages_ok is the page writer grading its own templates" (10/10 replayed, 57% real). The
// report says how many passing pages have prose beyond the hub's own text, and how many show the
// owner a source's own words on their page (G451's kept quotes, read from the page, not the files).
test("north star: a page that passes on the hub's own text alone is counted apart, as is a page showing a source's words", async () => {
  const { proseBeyondHub, quotesSource, report } = await import("../scripts/north-star");
  const { MADE } = await import("../src/wiki");
  const { makeBrain } = await import("./fixture");
  const { loadState } = await import("../src/dashboard/data");
  const { keepQuote } = await import("../src/quotes");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const lead = `Ana Diaz is the program director at North College.[^p-1] ${MADE}`;
  const hubOnly = note("people/ana", `${lead}\n\n[^p-1]: An email, 2026-10-06 (gmail:f000000000000001)`);
  expect(citedProse(hubOnly)).toBe(true);
  expect(proseBeyondHub(hubOnly)).toBe(false);
  expect(proseBeyondHub(note("people/ana", `${lead}\n\nShe has run the program since the spring and leads the Harbor Study.[^1]\n\n[^p-1]: gmail:f000000000000001\n[^1]: gmail:f000000000000002`))).toBe(true);
  // The same page, with and without the source's words kept for the owner.
  const root = makeBrain();
  mkdirSync(join(root, "people"), { recursive: true });
  writeFileSync(join(root, "people", "ana-diaz.md"), `---\nid: people/ana-diaz\ntype: person\ntitle: Ana Diaz\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: owner\n---\n${hubOnly.body}`);
  const page = () => { const s = loadState(root); return { s, n: s.notes.find((x) => x.fm.id === "people/ana-diaz")! }; };
  let p = page();
  expect(quotesSource(p.s, p.n)).toBe(false);
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "q.yaml"), "x: 1\n");
  const { putQuote } = await import("../src/quotes");
  putQuote(root, "q.yaml", "Ana is now the program director for the Harbor Study team");
  keepQuote(root, "q.yaml", ["gmail:f000000000000001"]);
  p = page();
  expect(quotesSource(p.s, p.n)).toBe(true);
  const text = report({ asks: 3, asks_by_kind: { dispute: 3 }, asked: [], not_conflict: 0, assistant_held: 1, assistant_expiring: 2, held_by_access: 0, held_by_capture: 0, held_by_ambiguity: 0, home_asks: 2, home_asked: [], planted: 3, pages: 10, pages_ok: 10, prose: 10, inbound: 10, share: 1, pages_beyond_hub: 0, pages_quoted: 0, pass: true, notes: [] }, "x");
  expect(text).toContain("0 with prose beyond the hub's own written-from-facts text, 0 showing the owner a source's own words");
  expect(text).toContain("asks the home screen lists: 2 (1 wait on Settings)");
  expect(text).toContain("held until your hold on assistants' proposals ends: 1 assistant proposal(s); 2 more expire unconfirmed (not asks)");
});

// Outside review v5: the deck is gone. Midday re-audit: a held proposal with no day was an ask
// forever. An outside assistant's proposal expires unconfirmed: a queue with a day, not an ask,
// counted on its own line.
test("north star --brain counts an outside assistant's expiring proposal apart from asks", async () => {
  const { measure } = await import("../scripts/north-star");
  const { makeBrain } = await import("./fixture");
  const { write } = await import("../src/write");
  const root = makeBrain();
  expect(write(root, { agent: "helper", id: "people/jane-roy", attribute: "role", value: "Associate dean", as_of: "2026-10-07", sources: ["gmail:1a0e88a496d9705a"] }).outcome).toBe("inbox");
  const now = new Date();
  const m = measure(root, new Date(now.getTime() - 86_400_000).toISOString(), now);
  expect(m.assistant_expiring).toBe(1);
  expect(m.asks_by_kind.proposal ?? 0).toBe(0);
}, 60_000);

// Real brain, 2026-10-27: the capture agent is also an assistant; its own proposals (no capture
// behind them) are held until their day (the hold_assistants_until the brain pins in rules/escalation.yaml): counted there, not asks.
test("north star --brain counts the capture agent's own assistant proposals as held, not as asks", async () => {
  const { measure } = await import("../scripts/north-star");
  const { makeBrain } = await import("./fixture");
  const { write } = await import("../src/write");
  const { loadRules } = await import("../src/rules");
  const { captureAgent } = await import("../src/capture");
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all, hold_assistants_until: 2026-10-30 }\n");
  const agent = captureAgent(loadRules(root));
  const r = write(root, { agent, id: "people/jane-roy", attribute: "office", value: "Room B-201", as_of: "2026-10-07", sources: ["gmail:1a0e88a496d9705a"], sensitivity: "private" } as never);
  expect(r.outcome).toBe("inbox");
  const now = new Date("2026-10-28T15:00:00Z");
  const m = measure(root, new Date(now.getTime() - 86_400_000).toISOString(), now);
  expect(m.assistant_held).toBe(1);
  expect(m.asks_by_kind.proposal ?? 0).toBe(0);
}, 60_000);

// Audit v5, midday: pages_ok scored the page writer's own templates. A page whose only prose is the
// hub's written-from-facts lead no longer counts; prose beyond it, or a source's words, does.
test("north star: a page with only the hub's own lead doesn't count in pages_ok", async () => {
  const { measure } = await import("../scripts/north-star");
  const { makeBrain } = await import("./fixture");
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = makeBrain();
  Bun.sleepSync(1100);
  const since = new Date().toISOString();
  const page = (slug: string, title: string, body: string) => writeFileSync(join(root, "people", `${slug}.md`), `---\nid: people/${slug}\ntype: person\ntitle: ${title}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-05\nby: planner\nfacts:\n  role: { value: Dean, as_of: 2026-10-05, sources: ["gmail:f000000000000009"], verification: verified-by-source, by: planner, recorded: 2026-10-05 }\n---\n${body}\n`);
  page("ann-lee", "Ann Lee", "Ann Lee's role is Dean.[^p-role] (Written by the hub from this page's facts.)\n\n[^p-role]: Email, 2026-10-05 (gmail:f000000000000009)");
  page("bo-ray", "Bo Ray", "Bo Ray chairs the hiring committee with [[people/ann-lee|Ann Lee]] this term.[^1]\n\n[^1]: Email, 2026-10-05 (gmail:f000000000000009)");
  Bun.spawnSync(["git", "add", "-A"], { cwd: root }); Bun.spawnSync(["git", "-c", "user.name=planner", "-c", "user.email=p@x", "commit", "-qm", "planner: pages"], { cwd: root });
  const now = new Date();
  const m = measure(root, since, now);
  expect(m.pages).toBe(2);
  expect(m.prose).toBe(2);
  expect(m.inbound).toBe(1); // Ann: cited prose and a link in, but only the hub's own lead
  expect(m.pages_ok).toBe(0);
}, 60_000);
