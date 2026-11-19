// SPDX-License-Identifier: AGPL-3.0-only
// The read a deploy takes of the owner's pages (G984): counts and milliseconds, nothing that names
// a page or repeats its words, and nothing written. Run here on the demo brain, as a child process,
// the way scripts/deploy.ts runs it on the real one.
import { test, expect, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { loadBrain } from "../src/brain";
import { RULES, SLOW_PAGE_MS, asPageRead, pageReadLine, pageReadOf, proofread, readPages, type PageRead, type Proofread } from "../src/proofread";

const SCRIPT = join(import.meta.dir, "..", "scripts", "page-read.ts");
const git = (root: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root, stdout: "pipe" }).stdout.toString();

// One demo brain for both tests (it takes seconds to build); the first leaves it as it found it.
let root = "";
beforeAll(async () => { root = (await makeDemoBrain()).root; });

test("page-read prints counts and milliseconds only, and writes no page, commit or log", () => {
  // .cells/ is there before the read too when the demo brain was served through cells (PB_CELLS=1).
  const dirt = () => git(root, "status", "--porcelain", "--ignored").split("\n").filter((l) => l !== "!! .cells/").join("\n");
  const head = git(root, "rev-parse", "HEAD"), status = dirt();
  const r = Bun.spawnSync(["bun", SCRIPT, "--brain", root, "--json"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PB_NOW: DEMO_NOW } });
  expect(r.exitCode).toBe(0);
  const out = r.stdout.toString().trim();
  const j = JSON.parse(out) as Record<string, unknown>;
  expect(Object.keys(j).sort()).toEqual(["by_kind", "by_rule", "failed", "max_ms", "median_ms", "odd", "odd_pages", "p95_ms", "pages", "slow"]);
  for (const [k, v] of Object.entries(j)) if (k !== "by_rule" && k !== "by_kind") expect(typeof v).toBe("number");
  for (const [k, v] of Object.entries(j.by_rule as object)) { expect(RULES as readonly string[]).toContain(k); expect(typeof v).toBe("number"); }
  expect(j.pages as number).toBeGreaterThan(50);
  expect(asPageRead(j)).toEqual(j as unknown as PageRead);
  // No page's id, title or alias appears in what it prints, as JSON or as the line.
  const line = pageReadLine(asPageRead(j)!);
  for (const n of loadBrain(root)) for (const name of [n.fm.id, n.fm.title, ...(n.fm.aliases ?? [])].map(String)) {
    if (name.length < 4) continue;
    expect(out.includes(name) || line.includes(name) ? name : "").toBe("");
  }
  // Nothing written but the parse cache every reader of a brain keeps (.cells/, derived, ignored by
  // the brain's git): no commit, no changed or new file, no log of the read, no heartbeat.
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
  expect(dirt()).toBe(status);
  expect(existsSync(join(root, "log", "proofread.json"))).toBe(false);
  expect(existsSync(join(root, "log", "heartbeats", "proofread.json"))).toBe(false);
  expect(Bun.spawnSync(["bun", SCRIPT], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PB_BRAIN: "" } }).exitCode).toBe(2);
}, 60_000);

test("the night's run counts what the read counts, and is still the one that keeps a log", () => {
  const now = new Date(DEMO_NOW);
  const { read, ms } = readPages(root, now);
  expect(existsSync(join(root, "log", "proofread.json"))).toBe(false);
  expect(ms.length).toBe(read.pages);
  expect(proofread(root, now)).toEqual(read);
  expect(existsSync(join(root, "log", "proofread.json"))).toBe(true);
  // Every page of the demo brain rendered twice: seconds on a busy machine, so its own limit.
}, 60_000);

const read = (o: Partial<Proofread> = {}): Proofread => ({ at: "x", pages: 5, odd_pages: 0, by_rule: {}, by_kind: {}, ...o });
test("the summary: totals by rule, the middle and the slowest page, and how many are over the line", () => {
  expect(SLOW_PAGE_MS).toBe(300);
  expect(pageReadOf(read({ odd_pages: 2, by_rule: { doubled: 2, "said-twice": 1 }, failed: 1 }), [10.4, 20.2, 30.6, 301, 950.5])).toEqual({ pages: 5, failed: 1, odd: 3, odd_pages: 2, by_rule: { doubled: 2, "said-twice": 1 }, by_kind: {}, median_ms: 31, p95_ms: 951, max_ms: 951, slow: 2 });
  expect(pageReadOf(read({ pages: 0 }), [])).toMatchObject({ median_ms: 0, max_ms: 0, slow: 0, odd: 0 });
});

test("an answer that isn't counts is refused, and a rule name this code doesn't know is dropped", () => {
  const ok = { pages: 5, failed: 0, odd: 1, odd_pages: 1, by_rule: { doubled: 1, "people/someone": 4, note: "words" }, by_kind: {}, median_ms: 3, p95_ms: 4, max_ms: 5, slow: 0 };
  expect(asPageRead(ok)?.by_rule).toEqual({ doubled: 1 });
  expect(asPageRead({ ...ok, pages: "many" })).toBeUndefined();
  expect(asPageRead({ ...ok, max_ms: -1 })).toBeUndefined();
  expect(asPageRead(null)).toBeUndefined();
  expect(asPageRead("5 pages")).toBeUndefined();
});

const base: PageRead = { pages: 40, failed: 0, odd: 3, odd_pages: 2, by_rule: { doubled: 3 }, by_kind: {}, median_ms: 20, p95_ms: 60, max_ms: 90, slow: 0 };
test("the line says better, the same or worse than the code before, and worse only for a real change", () => {
  expect(pageReadLine(base, base)).toContain("the same count as on the code before;");
  expect(pageReadLine(base, base)).not.toContain("WORSE");
  expect(pageReadLine({ ...base, odd: 1, by_rule: { doubled: 1 } }, base)).toContain("2 fewer than on the code before (doubled -2)");
  // One rule up and another down by as much: the total is the same, and the line still shows the move.
  expect(pageReadLine({ ...base, by_rule: { doubled: 1, "bare-url": 2 } }, base)).toContain("the same count as on the code before (doubled -2, bare-url +2)");
  expect(pageReadLine({ ...base, odd: 4, by_rule: { doubled: 4 } }, base)).toContain("WORSE than the code before: sentences ");
  // Slower but under the line is noise; over the line and half again as slow, or one more page over it, is not.
  expect(pageReadLine({ ...base, max_ms: 250 }, base)).not.toContain("WORSE");
  expect(pageReadLine({ ...base, max_ms: 400 }, base)).toContain("WORSE than the code before: speed ");
  expect(pageReadLine({ ...base, max_ms: 400 }, { ...base, max_ms: 380 })).not.toContain("WORSE");
  expect(pageReadLine({ ...base, max_ms: 400, slow: 1 }, { ...base, max_ms: 380 })).toContain("WORSE than the code before: speed ");
  expect(pageReadLine({ ...base, failed: 1 }, base)).toContain("1 page failed to render (was 0); by rule: doubled 3; WORSE than the code before: sentences ");
});
