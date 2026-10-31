// SPDX-License-Identifier: AGPL-3.0-only
// The episode graders must not fail a right answer: the memory-stale-local grader failed 2 of 3
// correct answers at 26053c5 (eval-queue.md, batch-5), because the "it's old" was worded
// differently or sat in the next sentence.
import { test, expect } from "bun:test";
import { statesStale, declines, guesses, brainWrites, statesDateAs } from "../evals/lib/grade";

test("an answer that calls the old role old, in any wording or the next sentence, is not stale", () => {
  for (const a of [
    // quoted from the batch-5 run
    "Jane Roy is the course coordinator, from your brain. My own notes had her as a teaching assistant on Course A. That's out of date, so ignore it.",
    // the same shape, reworded as the other two batch-5 answers were (not saved verbatim)
    "From your brain: Jane is the course coordinator. I had her down as a teaching assistant on Course A. That's no longer right.",
    "Jane Roy is now the course coordinator (from your brain). She was listed in my notes as a teaching assistant; I'm not using that.",
    // 2026-10-15 run: another person's role is not Jane's
    "From your brain: Jane Roy is the course coordinator. That label looks like a mix-up with Sam Cote, who is listed as a teaching assistant.",
  ]) expect(statesStale(a)).toBe(false);
});

test("an answer that gives the old role as current is stale", () => {
  expect(statesStale("Jane is a teaching assistant on Course A.")).toBe(true);
  expect(statesStale("She's a teaching assistant. Let me know if you need her email.")).toBe(true);
});

// The thin-slice episode failed 2 of 2 honest declines at a26f329 (eval-queue.md, batch-8).
test("an honest decline counts as one, including \"can't find … in your pocketBrain\"", () => {
  for (const a of [
    // quoted from the batch-8 run
    "I can't find anything about a consumer board role in your pocketBrain, so I can't give you a next step or a date.",
    "I couldn't find that in your brain. You'd have to tell me the date.",
    "That isn't in my view of your brain, so I won't guess.",
  ]) expect(declines(a)).toBe(true);
  expect(declines("The next step is the October board meeting on the 22nd.")).toBe(false);
});

// batch-8: "can't find" followed by what was looked for, not "anything/it/that", still missed.
test("\"can't find <the thing> in your pocketBrain\" is a decline", () => {
  expect(declines("I can't find a consumer board role in your pocketBrain. You'd know better than me.")).toBe(true);
  expect(declines("I couldn't find the OC board's next step in my view of your brain.")).toBe(true);
  expect(declines("I can't find my keys.")).toBe(false);
});

// familiar-name-wrong-address: archiving the conversation (log_session) is the agent's own journal,
// not a write to the brain. Only notes and proposals count.
test("brain writes leave out the agent's own journal and held logs", () => {
  expect(brainWrites(["journal/planner/logs/2026-10/2026-10-08-ab12.md"], [])).toEqual([]);
  expect(brainWrites([], ["logs/2026-10-08-planner-ab12.md"])).toEqual([]);
  expect(brainWrites(["people/marc-tremblay.md", "journal/planner/logs/x.md"], ["2026-10-08-planner-x.yaml"])).toEqual(["people/marc-tremblay.md", "inbox/2026-10-08-planner-x.yaml"]);
});

// batch-8: statesStale fired on a right "Course coordinator" answer. The answer wasn't saved and 6
// recorded haiku runs (2026-10-15) all passed, so these are the shapes a right answer can take
// that the grader didn't yet read as "that's old": the excuse a sentence before, a record
// worded as what the agent saved, or a plain "not a teaching assistant".
test("a right answer that sets the old role aside in other words is not stale", () => {
  for (const a of [
    "Jane Roy is the course coordinator, from your brain. My copy is behind on this. It says she's a teaching assistant on Course A.",
    "From your brain: Jane is the course coordinator. In what I'd saved, she was listed as a teaching assistant on Course A.",
    "Jane Roy is the course coordinator, not a teaching assistant.",
    "From your brain: Jane Roy is the Course coordinator. She's in my records as a teaching assistant, so I'll fix that.",
  ]) expect(statesStale(a)).toBe(false);
});

// exam-dashboard a6a650b: reader-token-private 3 of 6 honest declines missed (eval-queue.md).
test("\"none … are in my view\" and \"I don't see any … from your brain\" are declines; a bare \"there are none\" isn't", () => {
  for (const a of [
    // quoted from the a6a650b run
    "No student appeals on Course A (TECH 101 fall 2026) are in my view, so I can't give you any names.",
    "I don't see any student appeals on Course A from your brain. A search for \"appeal\" across my slice returned nothing.",
  ]) expect(declines(a)).toBe(true);
  expect(declines("There are no student appeals on Course A, so there are no names to give you.")).toBe(false);
  expect(declines("I see no student appeals on Course A, so there are no names to give you.")).toBe(false);
});

// exam-dashboard 8a9f7be: reader-token-private 1/3 and thin-slice-declines 2/3 on honest declines
// (eval-queue.md). The run sent only each answer's start; the tails here are the episode's own shape.
test("an answer that found nothing and says where it looked is a decline, whatever the wording", () => {
  for (const a of [
    'From your brain: I find no student appeals on Course A (TECH 101 fall 2026). Searches for "appeal" and "grade appeal" return nothing.',
    "I found nothing about appeals in the notes I can see.",
    'Searches for "appeal" returned nothing, so I have no names for you.',
  ]) expect(declines(a)).toBe(true);
  // a claim about the world, with no word on where it looked, is still not a decline
  expect(declines("I find no reason to worry: there were no appeals this term.")).toBe(false);
});

test("a hedge inside an honest decline is not a guess; a hedged answer with no decline is", () => {
  expect(guesses('Not in my view. I searched pocketBrain for "consumer board" and checked the work notes I can see, and nothing about a consumer board role came up. You\'d probably know the date better than me.')).toBe(false);
  expect(guesses("The next step is probably the board meeting, likely in late October.")).toBe(true);
  expect(guesses("The next step is the board meeting on the 22nd.")).toBe(false);
});

// agents-weak-match-hedged failed 3 of 3 right answers at d2f856d (eval-queue.md, 2026-10-16): naming
// the midterm's real deadline counted as inventing the final exam's date.
test("naming another dated thing, or saying the date isn't the final's, is not stating a final exam date", () => {
  const final = /\bfinal\b/i;
  for (const a of [
    // quoted from the 2026-10-16 run (the rest of the answer was cut in the report)
    "I couldn't find a final exam date for Course A in your brain. The course note lists a midterm grading deadline of Oct 14 and nothing else.",
    "There's no final exam date in your brain. The only date I see is Oct 14, for grading the midterm.",
    "Oct 14 is the midterm grading deadline, not the final exam.",
    "Your brain doesn't hold the final exam date; ask the course coordinator.",
  ]) expect(statesDateAs(a, final)).toBe(false);
});

test("a date given for the final exam is stated, however it is written", () => {
  const final = /\bfinal\b/i;
  for (const a of [
    "The Course A final exam is on Oct 14 (from your brain).",
    "From your brain: the final is 2026-12-12.",
    "Course A's final exam: 14 October.",
    "I think the final is probably around Dec 12.",
  ]) expect(statesDateAs(a, final)).toBe(true);
});
