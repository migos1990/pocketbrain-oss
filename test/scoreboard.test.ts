// SPDX-License-Identifier: AGPL-3.0-only
// The scoreboard (docs/scoreboard.md, scripts/scoreboard.ts, G999): every number on the page is a
// number a command of this repo printed, read by code from that command's own output, with the
// command, the commit and the day beside it. The page is the record rendered, never typed.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROWS, differences, inReadme, loadRecord, readmeBlock, parseAnswers, parseBurst, parseLongMemEval, parseSlice, render, rowById, type Board } from "../scripts/scoreboard";
import { countsText, type UAgent, type UScore } from "../src/usefulness";
import { LABEL, table } from "../scripts/longmemeval";

const ROOT = join(import.meta.dir, "..");
const HASH = "ab".repeat(32), COMMIT = "c0ffee".repeat(6) + "c0ff";

const SLICE_LINE = "300 memories, 3 doors, 0 leak(s), 0 missing (12345 owed facts read back); 1602 assistants and tokens, 2850 pages, 257650 answers read, 2101 s";
const BURST_LINE = "burst property: 60 brains, 254 tokens, 115644 reads in bursts (76894 held to the same call asked alone), 2972 writes between reads (2700 filed, 272 refused), 3600 calls turned away over budget, 0 brains with a finding";

const agent = (name: string, door: UAgent["door"], asked: number, answered: number, answerable: number, median: number): UAgent => ({
  agent: name, door, sets: { usefulness: { asked, answered } }, all: { asked, answered }, answerable: { asked: answerable, answered },
  why: { outside_cut: asked - answerable, not_returned: answerable - answered, pointer_only: 0, value_not_shown: 0, several: 0 }, pointers: 0, tokens: { median, perAnswer: median }, noise: 50,
});
const lmeText = (commit = COMMIT, extra = "") => [
  `# LongMemEval, ${LABEL}`, "",
  `- data: longmemeval_s_cleaned.json, sha256 ${HASH}`,
  `- commit: ${commit}${extra}`,
  "- slice: rest, 450 questions, held-out run 1",
  "- skipped as the benchmark skips them: abstention questions and questions with no evidence in a user turn",
  "", "## words", "",
  ...table([{ id: "a", type: "multi-session", r5any: true, r10any: true, r5all: false, r10all: true }, { id: "b", type: "multi-session", skipped: "abstention" }]),
  "", "## words + local model", "",
  ...table([{ id: "a", type: "multi-session", r5any: true, r10any: true, r5all: true, r10all: true }, { id: "b", type: "multi-session", skipped: "abstention" }]),
].join("\n");

describe("the scoreboard reads each command's own output", () => {
  test("the slice check's line, as scripts/slice-proof.ts prints it on a real run", () => {
    const r = Bun.spawnSync([process.execPath, join(ROOT, "scripts", "slice-proof.ts"), "--cases", "1"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const v = parseSlice(r.stdout.toString());
    expect(v).toMatchObject({ memories: 1, doors: 3, leaks: 0, missing: 0 });
    expect(v!.answers).toBeGreaterThan(0);
    expect(v!.owed).toBeGreaterThanOrEqual(0);
  }, 120_000);

  test("the slice check's counts, and a leak is read as a leak", () => {
    expect(parseSlice(SLICE_LINE)).toEqual({ memories: 300, doors: 3, leaks: 0, missing: 0, owed: 12345, readers: 1602, pages: 2850, answers: 257650, seconds: 2101 });
    expect(parseSlice(SLICE_LINE.replace("0 leak(s)", "2 leak(s)") + "; replay: CARVE_SEED=7042 bun test test/carve-property.test.ts")!.leaks).toBe(2);
    expect(parseSlice("slice check broke: no room on the disk")).toBeUndefined();
  });

  test("the answers table, from the real line src/usefulness.ts prints", () => {
    const score: UScore = { files: [], rows: [{} as never], agents: [agent("claude", "check", 34, 10, 34, 1548), agent("claude", "pack", 34, 30, 34, 1677), agent("gemini", "pack", 35, 19, 22, 1622), agent("gemini", "search", 35, 16, 22, 2718)] };
    expect(parseAnswers(countsText(score))).toEqual([
      { assistant: "claude", door: "memory_check, then read 3", asked: 34, answered: 10, answerable: 34, outside: 0, tokens: 1548 },
      { assistant: "claude", door: "context pack", asked: 34, answered: 30, answerable: 34, outside: 0, tokens: 1677 },
      { assistant: "gemini", door: "context pack", asked: 35, answered: 19, answerable: 22, outside: 13, tokens: 1622 },
      { assistant: "gemini", door: "search, then read 3", asked: 35, answered: 16, answerable: 22, outside: 13, tokens: 2718 },
    ]);
    expect(parseAnswers("Usefulness: no questions")).toBeUndefined();
    // The count beside "its slice can answer" is answered of answerable, never answered of all asked.
    expect(parseAnswers("  claude by context pack: 31/34 answered (usefulness 21/24); answered 30 of 33 answerable (1 outside its cut); 0 more only pointed to; median 1677 tokens, 1989 per answer, 77% noise")![0]).toMatchObject({ asked: 34, answered: 30, answerable: 33 });
  });

  test("the burst check's line", () => {
    expect(parseBurst(`bun test v1.4\n${BURST_LINE}\n 1 pass`)).toEqual({ brains: 60, tokens: 254, reads: 115644, same: 76894, writes: 2972, filed: 2700, refused: 272, turnedAway: 3600, findings: 0 });
    expect(parseBurst("0 pass\n1 fail")).toBeUndefined();
  });

  test("the LongMemEval tables, with the file's hash, and never a run on uncommitted code", () => {
    const v = parseLongMemEval(lmeText())!;
    expect(v).toMatchObject({ data: "longmemeval_s_cleaned.json", sha256: HASH, questions: 450, commit: COMMIT });
    expect(Object.keys(v.tables)).toEqual(["words", "words + local model"]);
    expect(v.tables["words + local model"].at(-1)).toBe("| all | 1 | 1 | 100% | 100% | 100% | 100% |");
    expect(v.tables.words.at(-1)).toBe("| all | 1 | 1 | 100% | 100% | 0% | 100% |");
    expect(parseLongMemEval(lmeText(COMMIT, " (DIRTY tree: dev numbers only, never quoted)"))).toBeUndefined();
    expect(parseLongMemEval(lmeText().replace("slice: rest, 450", "slice: dev, 50"))).toBeUndefined();
  });
});

describe("the page", () => {
  const board: Board = { rows: {
    slice: { command: rowById("slice").command, commit: COMMIT, day: "2026-11-19", values: parseSlice(SLICE_LINE)! },
    burst: { command: rowById("burst").command, commit: COMMIT, day: "2026-11-19", values: parseBurst(BURST_LINE)! },
    answers: { command: rowById("answers").command, commit: COMMIT, day: "2026-11-19", values: [{ assistant: "claude", door: "context pack", asked: 34, answered: 30, answerable: 34, outside: 0, tokens: 1677 }] },
    longmemeval: { command: rowById("longmemeval").command, commit: COMMIT, day: "2026-11-19", values: parseLongMemEval(lmeText())! },
  } };

  test("says each number with its command, commit and day, in the nightly line's own words", () => {
    const page = render(board);
    expect(page).toContain("> 300 memories, 3 doors, 0 leaks, 0 missing");
    expect(page).toContain("257,650 answers");
    expect(page).toContain("115,644 reads");
    expect(page).toContain("| claude | 34 | 34 | 30 | 0 | 1,677 |");
    expect(page).toContain("| all | 1 | 1 | 100% | 100% | 100% | 100% |");
    expect(page).toContain(LABEL);
    for (const r of ROWS) expect(page).toContain(r.command);
    expect(page.split(`commit \`${COMMIT.slice(0, 12)}\``).length - 1).toBe(4);
    expect(page).not.toMatch(/undefined|NaN|\[object/);
  });

  test("a row with no record yet is left off the page, never shown empty", () => {
    const page = render({ rows: { slice: board.rows.slice } });
    expect(page).toContain("0 leaks");
    expect(page).not.toContain("burst");
    expect(page).not.toContain("LongMemEval");
  });

  test("a leak is shown as a leak", () => {
    const page = render({ rows: { slice: { ...board.rows.slice!, values: { ...parseSlice(SLICE_LINE)!, leaks: 1 } } } });
    expect(page).toContain("> 300 memories, 3 doors, 1 leak, 0 missing");
  });

  test("a rerun is compared number by number; how long it took is not a number of the score", () => {
    const a = parseSlice(SLICE_LINE)!;
    expect(differences("slice", a, { ...a, seconds: 9 })).toEqual([]);
    expect(differences("slice", a, { ...a, answers: a.answers + 1 })).toEqual(["answers: recorded 257650, this run 257651"]);
    const l = parseLongMemEval(lmeText())!;
    expect(differences("longmemeval", l, { ...l, commit: "d".repeat(40) })).toEqual([]);
    expect(differences("longmemeval", l, { ...l, sha256: "0".repeat(64) }).length).toBe(1);
  });
});

describe("the committed scoreboard", () => {
  const rec = loadRecord(ROOT);

  test("docs/scoreboard.md is docs/scoreboard.json rendered, byte for byte", () => {
    expect(readFileSync(join(ROOT, "docs", "scoreboard.md"), "utf8")).toBe(render(rec));
  });

  test("every recorded row is a known row, under its own command, at a full commit, on a day", () => {
    expect(Object.keys(rec.rows).length).toBeGreaterThan(0);
    for (const [id, r] of Object.entries(rec.rows)) {
      expect(r!.command).toBe(rowById(id as never).command);
      expect(r!.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(r!.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("the slice row is the whole run the nightly line names, and its numbers hold together", () => {
    const s = rec.rows.slice!.values;
    expect(s.memories).toBe(300);
    expect(s.doors).toBe(3);
    expect(s.answers).toBeGreaterThan(s.memories);
    expect(s.owed).toBeGreaterThan(0);
  });

  test("the LongMemEval row is the held-out questions on committed code, and its bench ships with the page", () => {
    const l = rec.rows.longmemeval!;
    expect(l.values.questions).toBe(450);
    expect(l.values.commit).toBe(l.commit);
    const left = readFileSync(join(ROOT, "scripts", "public-exclude.txt"), "utf8");
    for (const f of ["docs/scoreboard.md", "docs/scoreboard.json", "scripts/scoreboard.ts", "docs/longmemeval.md", "scripts/longmemeval.ts", "test/longmemeval.test.ts"]) {
      expect(existsSync(join(ROOT, f))).toBe(true);
      expect(left).not.toContain(f);
    }
  });

  test("a row whose check is not in this repo has no record", () => {
    for (const r of ROWS) if (!r.present(ROOT)) expect(rec.rows[r.id]).toBeUndefined();
  });
});

describe("the answers rows", () => {
  const counts = "  claude by context pack: 30/34 answered (usefulness 20/24, use 10/10); answered 30 of 34 answerable (0 outside its cut); 2 more only pointed to; median 1677 tokens, 1989 per answer, 77% noise\n";
  test("each row takes only a run that says it searched its way", () => {
    const words = rowById("answers").parse, model = rowById("answers_model").parse;
    expect(words(counts + "search: words alone\n")).toBeTruthy();
    expect(words(counts + "search: words and the local model\n")).toBeUndefined();
    expect(words(counts)).toBeUndefined();
    expect(model(counts + "search: words and the local model\n")).toBeTruthy();
    expect(model(counts + "search: words alone\n")).toBeUndefined();
    expect(rowById("answers").command).toStartWith("PB_SEMANTIC=0 ");
  });

  test("scripts/usefulness.ts says which search it used", () => {
    expect(readFileSync(join(ROOT, "scripts", "usefulness.ts"), "utf8")).toContain('console.log(`search: ${semanticOn() ? "words and the local model" : "words alone"}`)');
  });

  test("the README's block is the record's summary", () => {
    expect(inReadme(readFileSync(join(ROOT, "README.md"), "utf8"))).toBe(readmeBlock(loadRecord(ROOT)));
  });
});
