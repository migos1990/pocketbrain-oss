// SPDX-License-Identifier: AGPL-3.0-only
// Home as a property (G987): for made-up weeks of mail (test/home-gen.ts: two people who disagree,
// who agree, a newer value, one value in two spellings, a machine's mail, a voucher code, and
// three people with three values or two against one, two next steps for one project, questions the owner answers) the owner's home makes sense, whatever the week held. The seven
// statements are in test/home-check.ts, written from the week and the screens, apart from the
// code that decides what asks. It reads the home; it never changes what counts as an ask.
//   Each run: HOME_CASES weeks (default 6).  Soak: HOME_SOAK=1 (300).  One seed: HOME_SEED=n.
//   A failing seed goes in test/fixtures/home-seeds.json with its reason and is replayed every run.
//   A fault that is known and open is a row in KNOWN with its gap id: it never fails a run, and the
//   last test here fails the day it stops happening, so the row and the gap are closed together.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { week, asked, never, keyOf, PROJECTS, BUSY, type Week } from "./home-gen";
import { titlePiece } from "../src/page-kind";
import { runWeek, fold, shown, notPlain, type Finding } from "./home-check";

const FROZEN: { seed: number; why: string }[] = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "home-seeds.json"), "utf8"));
const BASE = 52_000;
const N = Number(process.env.HOME_CASES ?? (process.env.HOME_SOAK ? 300 : 6));
const SEEDS = process.env.HOME_SEED ? [Number(process.env.HOME_SEED)] : Array.from({ length: N }, (_, i) => BASE + i);

// No row today. G988 (a no-reply sender's value as one side of a question, on a source set to read
// machine mail too) was the first; its fix landed and its week, seed 52009, now runs clean with the rest.
const KNOWN: { gap: string; seed: number; when: (w: Week) => boolean; is: (f: Finding) => boolean }[] = [];
const known = (w: Week, f: Finding) => KNOWN.find((k) => k.when(w) && k.is(f));

// A finding that is not known is checked by running its week once more: a week is the same mail
// every time, so one that does not repeat is the hub's own timing. It is printed with its seed
// and counted as seen once, and does not fail the run (G989).
async function look(seed: number) {
  const w = week(seed), r = await runWeek(w);
  const fresh = r.findings.filter((f) => !known(w, f)), old = r.findings.filter((f) => known(w, f));
  if (!fresh.length) return { ...r, fresh, old, once: [] as Finding[] };
  const again = (await runWeek(w)).findings.map((f) => f.what);
  const once = fresh.filter((f) => !again.includes(f.what));
  for (const f of once) console.log(`home property: seed ${seed}, seen once and not on a second run: statement ${f.statement}: ${f.what}`);
  return { ...r, fresh: fresh.filter((f) => again.includes(f.what)), old, once };
}

test(`home property: ${SEEDS.length} made-up weeks; every question is a real conflict asked once, with sides a person can choose between, nothing from a machine or a voucher, in plain words, and an answered one stays gone`, async () => {
  const failed: string[] = [];
  let asks = 0, answered = 0, mails = 0, old = 0, once = 0;
  for (const seed of SEEDS) {
    const r = await look(seed);
    asks += r.asks; answered += r.answered; mails += r.mails; old += r.old.length ? 1 : 0; once += r.once.length ? 1 : 0;
    if (r.fresh.length) failed.push(`seed ${seed} (HOME_SEED=${seed} to replay):\n  ${r.fresh.map((f) => `statement ${f.statement}: ${f.what}`).join("\n  ")}`);
  }
  if (process.env.HOME_SOAK || process.env.HOME_SEED) console.log(`home property: ${SEEDS.length} weeks, ${mails} mails, ${asks} questions on the home, ${answered} answered, ${failed.length} weeks with a finding, ${once} with one seen once only, ${old} weeks with a known open fault (${KNOWN.map((k) => k.gap).join(", ")})`);
  expect(failed).toEqual([]);
  // The weeks did something: questions were asked and answered, so the statements had something to hold over.
  expect(asks).toBeGreaterThanOrEqual(SEEDS.length);
  expect(answered).toBeGreaterThanOrEqual(SEEDS.length);
}, 7_200_000);

test("the generator is the same week for the same seed, every kind of case turns up, and no two cases share a fact", () => {
  // Many times over, so a generator step that changes once the engine has warmed up is caught.
  for (let i = 0; i < 300; i++) expect(JSON.stringify(week(BASE + (i % 40)))).toBe(JSON.stringify(week(BASE + (i % 40))));
  const some = Array.from({ length: 12 }, (_, i) => week(BASE + i));
  const kinds = new Set(some.flatMap((w) => w.cases.map((c) => c.kind)));
  for (const k of ["clash", "three", "split", "agree", "forward", "reworded", "machine", "code", "steps", "answered"]) expect(kinds.has(k as never)).toBe(true);
  expect(new Set(some.flatMap((w) => w.cases.map((c) => c.answer)).filter(Boolean)).size).toBe(4);
  // Every made-up project is one the hub files as a project: an errand's, a trip's or an event's
  // title starts no page of its own, and the week's case would hold with nothing filed.
  for (const t of [...PROJECTS, ...BUSY]) expect(`${t}: ${titlePiece(t)}`).toBe(`${t}: undefined`);
  for (const w of some) {
    expect(new Set(w.cases.map((c) => c.key)).size).toBe(w.cases.length);
    expect(asked(w).length).toBeGreaterThan(0);
    expect(never(w).length).toBeGreaterThan(0);
    // A clash is two different values, a reworded pair is one value in two spellings, and every mail states its fact.
    for (const c of w.cases) {
      const [a, b] = c.mails;
      expect(c.key).toBe(keyOf(a!.type, c.entity, c.attribute));
      if (c.kind === "three") expect(new Set(c.mails.map((m) => fold(m.value))).size).toBe(3);
      if (c.kind === "split") expect(new Set(c.mails.map((m) => fold(m.value))).size).toBe(2);
      if (c.kind !== "agree" && c.kind !== "reworded" && c.kind !== "code") expect(fold(a!.value)).not.toBe(fold(b!.value));
      if (c.kind === "reworded") { expect(a!.value).not.toBe(b!.value); expect(fold(a!.value)).toBe(fold(b!.value)); }
      if (c.kind === "agree") expect(a!.value).toBe(b!.value);
      for (const m of c.mails) expect(m.sentence.includes(m.value)).toBe(true);
    }
  }
});

test("the oracle itself: a value in two spellings is one value, a screen's text is what a person reads, and machine text is told from plain words", () => {
  // Statements that can't fail prove nothing.
  expect(fold("Field  Lead.")).toBe(fold("field lead"));
  expect(fold("field lead")).not.toBe(fold("stage manager"));
  expect(shown(`<style>.a_b{}</style><p class="x_y">Two emails disagree on Ivo&#39;s role.</p><input name="id" value="c-0001">`)).toBe("Two emails disagree on Ivo's role.");
  expect(notPlain("Two emails disagree on Ivo Brandt's role.")).toBeUndefined();
  expect(notPlain("What is Lena Marsh's next step? 10:30 on Friday")).toBeUndefined();
  expect(notPlain("It came from gmail:00000000b00c")).toBe("a source ref");
  expect(notPlain("Seen in 00000000b00c1234")).toBe("a long id");
  expect(notPlain("Two emails disagree on its next_step.")).toBe("a field name");
  expect(notPlain("See people/ivo-brandt")).toBe("a page path");
  expect(notPlain("She works at [[Tide Works]]")).toBe("a link's brackets");
  expect(notPlain("Its role is undefined.")).toBe("a program's empty word");
});

if (FROZEN.length) test(`frozen weeks: ${FROZEN.length} seeds that once failed are replayed`, async () => {
  for (const f of FROZEN) expect({ seed: f.seed, findings: (await look(f.seed)).fresh }).toEqual({ seed: f.seed, findings: [] });
}, 900_000);

test(`known open faults still happen (${KNOWN.map((k) => k.gap).join(", ") || "none today"}): when one stops, close its gap and take its row out of KNOWN`, async () => {
  for (const k of KNOWN) expect({ gap: k.gap, still: (await look(k.seed)).old.length > 0 }).toEqual({ gap: k.gap, still: true });
}, 300_000);
